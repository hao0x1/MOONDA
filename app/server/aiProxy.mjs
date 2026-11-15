// Shared paid-model proxy. Only the server supplies credentials and billing options.
// Admission/rate limits live at the deployed entry points; this module also protects local dev.
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MAX_BODY = 96 * 1024; // UTF-8 bytes, including tool schemas and conversation history
const MAX_MESSAGES = 120;
const CONNECT_MS = 40_000;
const IDLE_MS = 60_000;
const TOTAL_MS = 180_000;
const MAX_OUTPUT_TOKENS = 8192;
const TOOL_NAMES = new Set(['get_mission_settings', 'list_candidate_sites', 'search_moon_names', 'analyse_spot', 'scan_area', 'show_on_map', 'add_to_compare']);
const encoder = new TextEncoder();
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const string = (value, max = 65536) => typeof value === 'string' && encoder.encode(value).length <= max;
const invalid = () => ({ status: 400, error: 'bad-request' });

/** Return null for the app's text/tool protocol, or a fixed error before any paid work. */
export function validateBody(body) {
  if (!only(body, ['messages', 'tools', 'quick']) || !Array.isArray(body.messages) || !body.messages.length) return invalid();
  if (body.quick !== undefined && typeof body.quick !== 'boolean') return invalid();
  if (body.messages.length > MAX_MESSAGES) return { status: 413, error: 'too-long' };
  let bytes;
  try { bytes = encoder.encode(JSON.stringify(body)).length; } catch { return invalid(); }
  if (bytes > MAX_BODY) return { status: 413, error: 'too-long' };
  for (let index = 0; index < body.messages.length; index++) {
    const message = body.messages[index];
    if (!only(message, ['role', 'content', 'reasoning_content', 'tool_calls', 'tool_call_id'])) return invalid();
    if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) return invalid();
    if (message.role === 'system' && index !== 0) return invalid();
    if (message.content !== null && !string(message.content)) return invalid();
    if (message.content === null && message.role !== 'assistant') return invalid();
    if (message.reasoning_content !== undefined && (message.role !== 'assistant' || !string(message.reasoning_content))) return invalid();
    if (message.tool_call_id !== undefined && (message.role !== 'tool' || !string(message.tool_call_id, 200))) return invalid();
    if (message.role === 'tool' && !message.tool_call_id) return invalid();
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length || message.tool_calls.length > 16) return invalid();
      for (const call of message.tool_calls) {
        if (!only(call, ['id', 'type', 'function']) || !string(call.id, 200) || !call.id || call.type !== 'function') return invalid();
        if (!only(call.function, ['name', 'arguments']) || !TOOL_NAMES.has(call.function.name) || !string(call.function.arguments, 8192)) return invalid();
      }
    }
    if (message.role === 'assistant' && message.content === null && !message.tool_calls?.length) return invalid();
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > TOOL_NAMES.size) return invalid();
    const names = new Set();
    for (const tool of body.tools) {
      if (!only(tool, ['type', 'function']) || tool.type !== 'function' || !only(tool.function, ['name', 'description', 'parameters'])) return invalid();
      const fn = tool.function;
      if (!TOOL_NAMES.has(fn.name) || names.has(fn.name) || !string(fn.description, 2000) || !object(fn.parameters) || JSON.stringify(fn.parameters).length > 6000) return invalid();
      names.add(fn.name);
    }
  }
  return null;
}

function codeFor(status) {
  if (status === 429 || status === 503 || status === 529) return 'busy';
  if (status === 401 || status === 403) return 'no-key';
  return 'service';
}

// Only numeric billing fields leave the provider stream through callbacks. No prompts or
// provider error text are logged. Keep a bounded tail, rather than JSON-parsing every token.
function usageFromTail(tail) {
  const lines = tail.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line.startsWith('data:') || !line.includes('"usage"')) continue;
    try {
      const usage = JSON.parse(line.slice(5).trim()).usage;
      if (!object(usage)) continue;
      const summary = {};
      for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']) {
        if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) summary[key] = usage[key];
      }
      if (Object.keys(summary).length) return summary;
    } catch { /* partial line at the bounded tail's start */ }
  }
  return null;
}

/**
 * @param {unknown} body
 * @param {{ key?: string, model?: string, baseUrl?: string, raw?: boolean, signal?: AbortSignal, onUsage?: Function, onFinish?: Function }} env
 */
export async function proxyChat(body, env) {
  const failure = validateBody(body);
  if (failure) return json(failure.status, { error: failure.error });
  if (!env.key) return json(501, { error: 'no-key' });
  const model = env.model || 'deepseek-v4-pro';
  const url = env.baseUrl ? `${env.baseUrl.replace(/\/$/, '')}/chat/completions` : DEEPSEEK_URL;
  const abort = new AbortController();
  const started = Date.now();
  let finished = false;
  let stopStream;
  let collectUsage;
  let usageReported = false;
  let abortReason = 'cancelled';
  let total, connect;
  const notify = (fn, value) => { try { Promise.resolve(fn?.(value)).catch(() => {}); } catch { /* observability cannot break a response */ } };
  const finish = reason => {
    if (finished) return;
    finished = true;
    clearTimeout(total);
    clearTimeout(connect);
    env.signal?.removeEventListener('abort', cancelled);
    // The app cancels its reader as soon as it sees [DONE], which may happen
    // before fetch reports EOF. The final billing event is already in the tail.
    const usage = !usageReported && collectUsage?.();
    if (usage) { usageReported = true; notify(env.onUsage, usage); }
    notify(env.onFinish, { reason, elapsedMs: Date.now() - started });
  };
  const stop = reason => {
    abortReason = reason;
    abort.abort();
    if (stopStream) stopStream(reason);
  };
  const cancelled = () => stop('cancelled');
  env.signal?.addEventListener('abort', cancelled, { once: true });
  if (env.signal?.aborted) {
    finish('cancelled');
    return json(499, { error: 'network' });
  }
  connect = setTimeout(() => stop('timeout'), CONNECT_MS);
  total = setTimeout(() => stop('timeout'), TOTAL_MS);
  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST', signal: abort.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.key}` },
      body: JSON.stringify({
        model, messages: body.messages,
        tools: body.tools?.length ? body.tools : undefined,
        thinking: { type: body.quick === true ? 'disabled' : 'enabled' },
        reasoning_effort: body.quick === true ? undefined : 'high',
        stream: true, stream_options: { include_usage: true }, max_tokens: MAX_OUTPUT_TOKENS,
      }),
    });
  } catch {
    const reason = abort.signal.aborted ? abortReason : 'network';
    finish(reason);
    console.error('[ai proxy]', JSON.stringify({ event: 'upstream-connect-failed', reason }));
    return json(reason === 'timeout' ? 504 : reason === 'cancelled' ? 499 : 502, { error: reason === 'timeout' ? 'timeout' : 'network' });
  }
  clearTimeout(connect);
  if (!upstream.ok || !upstream.body) {
    // Error bodies can echo user input or provider internals: never log or forward them.
    // Cancel instead of consuming an unbounded body. HTTP status is enough for classification.
    await upstream.body?.cancel().catch(() => {});
    abort.abort();
    finish('upstream-error');
    console.error('[ai proxy]', JSON.stringify({ event: 'upstream-rejected', status: upstream.status }));
    if (upstream.status === 413) return json(413, { error: 'too-long' });
    const code = codeFor(upstream.status);
    return json(code === 'busy' ? 503 : 502, { error: code, status: upstream.status });
  }
  if (abort.signal.aborted) {
    await upstream.body.cancel().catch(() => {});
    finish(abortReason);
    return json(abortReason === 'timeout' ? 504 : 499, { error: abortReason === 'timeout' ? 'timeout' : 'network' });
  }
  const reader = upstream.body.getReader();
  // A small byte ring avoids decoding/copying the complete SSE tail on every token
  // (the edge runtime has a strict CPU budget). Decode it only when the stream ends.
  const usageTail = typeof env.onUsage === 'function' ? new Uint8Array(16384) : null;
  let tailPosition = 0, tailSize = 0;
  const retain = chunk => {
    if (!usageTail) return;
    const bytes = chunk.length > usageTail.length ? chunk.subarray(chunk.length - usageTail.length) : chunk;
    const first = Math.min(bytes.length, usageTail.length - tailPosition);
    usageTail.set(bytes.subarray(0, first), tailPosition);
    usageTail.set(bytes.subarray(first), 0);
    tailPosition = (tailPosition + bytes.length) % usageTail.length;
    tailSize = Math.min(usageTail.length, tailSize + bytes.length);
  };
  const readUsage = () => {
    if (!usageTail) return null;
    const ordered = new Uint8Array(tailSize);
    const start = (tailPosition + usageTail.length - tailSize) % usageTail.length;
    const first = Math.min(tailSize, usageTail.length - start);
    ordered.set(usageTail.subarray(start, start + first));
    ordered.set(usageTail.subarray(0, tailSize - first), first);
    return usageFromTail(new TextDecoder().decode(ordered));
  };
  collectUsage = readUsage;
  let idle;
  let closed = false;
  const stream = new ReadableStream({
    start(ctrl) {
      stopStream = reason => {
        if (closed) return;
        closed = true;
        clearTimeout(idle);
        if (reason !== 'cancelled') {
          try { ctrl.enqueue(encoder.encode(`\ndata: {"moonda_error":"${reason === 'timeout' ? 'stall' : 'network'}"}\n\n`)); } catch { /* disconnected */ }
        }
        try { ctrl.close(); } catch { /* already closed */ }
        reader.cancel().catch(() => {});
        finish(reason);
      };
      idle = setTimeout(() => stop('timeout'), IDLE_MS);
    },
    async pull(ctrl) {
      try {
        const { value, done } = await reader.read();
        if (closed) return;
        clearTimeout(idle);
        if (done) {
          closed = true;
          ctrl.close();
          finish('complete');
          return;
        }
        // The last SSE event contains billing totals; only retain enough to read that event.
        retain(value);
        ctrl.enqueue(value);
        idle = setTimeout(() => stop('timeout'), IDLE_MS);
      } catch {
        if (!closed) stop('network');
      }
    },
    cancel() {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      abort.abort();
      reader.cancel().catch(() => {});
      finish('cancelled');
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
  });
}

/** Read a request body with a UTF-8 byte limit (Node http request). */
export function readNodeBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { reject(new Error('too-large')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
export { MAX_BODY };
