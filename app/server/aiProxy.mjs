// Server-side proxy for the AI landing-site helper. The browser never sees the API key:
// it posts the conversation here, we add the key and stream the model's answer straight back.
// Used by the Netlify Function (online) and by the Vite dev/preview servers (on this Mac).
//
// The key comes from the environment: DEEPSEEK_API_KEY (Netlify: Project configuration >
// Environment variables; on this Mac: app/.env.local). Optional: DEEPSEEK_MODEL.
//
// The page only ever gets fixed, short error codes from us ({ error: 'busy' } etc.), never the
// provider's own error text: that goes to the server console. A stream that stalls or breaks is
// ended cleanly with one last event, `data: {"moonda_error":"stall"|"network"}`, so neither this
// server nor the page can hang or crash on it.

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
// DEEPSEEK_BASE_URL can point at a stand-in server for offline tests.
const MAX_BODY = 600_000;      // bytes of conversation we accept from the page
const MAX_MESSAGES = 120;
const CONNECT_MS = 40_000;     // the model must start answering within this
const IDLE_MS = 60_000;        // ... and never go silent for longer than this mid-answer

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const log = (...a) => console.error('[ai proxy]', ...a);

/** The provider's HTTP status -> one of our fixed error codes. */
function codeFor(status) {
  if (status === 429 || status === 503 || status === 529) return 'busy';
  if (status === 401 || status === 403) return 'no-key';
  return 'service';
}

/** Pass the upstream stream through, but end it cleanly (never throw) when it stalls or breaks. */
function guarded(upstream) {
  const reader = upstream.getReader();
  const enc = new TextEncoder();
  let timer = null;
  let closed = false;
  return new ReadableStream({
    async pull(ctrl) {
      const finish = (why) => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        if (why) { try { ctrl.enqueue(enc.encode(`\ndata: {"moonda_error":"${why}"}\n\n`)); } catch { /* gone */ } }
        try { ctrl.close(); } catch { /* already closed */ }
        reader.cancel().catch(() => {});
      };
      clearTimeout(timer);
      timer = setTimeout(() => { log('upstream went silent for', IDLE_MS / 1000, 's'); finish('stall'); }, IDLE_MS);
      try {
        const { value, done } = await reader.read();
        if (closed) return;
        if (done) { finish(null); return; }
        ctrl.enqueue(value);
      } catch (err) {
        log('upstream stream broke:', err?.cause?.code ?? err?.message ?? err);
        finish(closed ? null : 'network');
      }
    },
    cancel() { closed = true; clearTimeout(timer); reader.cancel().catch(() => {}); },
  });
}

/**
 * @param {{ messages: unknown[], tools?: unknown[], quick?: boolean }} body  what the page sent
 * @param {{ key?: string, model?: string, baseUrl?: string, raw?: boolean }} env
 * @returns {Promise<Response>} a streaming Response (server-sent events) or a JSON error { error: code }
 */
export async function proxyChat(body, env) {
  if (!env.key) return json(501, { error: 'no-key' });
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) return json(400, { error: 'bad-request' });
  if (body.messages.length > MAX_MESSAGES) return json(413, { error: 'too-long' });

  const model = env.model || 'deepseek-v4-pro';
  const url = env.baseUrl ? `${env.baseUrl.replace(/\/$/, '')}/chat/completions` : DEEPSEEK_URL;
  const abort = new AbortController();
  const connect = setTimeout(() => abort.abort(), CONNECT_MS);
  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST', signal: abort.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.key}` },
      body: JSON.stringify({
        model,
        messages: body.messages,
        tools: Array.isArray(body.tools) && body.tools.length ? body.tools : undefined,
        // body.quick: the page asks again after an answer was cut by the hosting's time limit, and wants this
        // one without the long thinking so that it fits
        thinking: { type: body.quick === true ? 'disabled' : 'enabled' },
        reasoning_effort: body.quick === true ? undefined : 'high',
        stream: true,
        max_tokens: 8192,
      }),
    });
  } catch (err) {
    clearTimeout(connect);
    const timedOut = abort.signal.aborted;
    log(timedOut ? `no answer within ${CONNECT_MS / 1000} s` : 'could not reach the model:', timedOut ? '' : (err?.cause?.code ?? err?.message ?? err));
    return json(timedOut ? 504 : 502, { error: timedOut ? 'timeout' : 'network' });
  }
  clearTimeout(connect);

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    log(`model answered ${upstream.status}:`, text.slice(0, 800));
    // a conversation that has outgrown the model is its own, plain message on the page
    if (upstream.status === 400 && /context length|maximum context|too many tokens|too long/i.test(text)) return json(413, { error: 'too-long' });
    const code = codeFor(upstream.status);
    return json(code === 'busy' ? 503 : 502, { error: code, status: upstream.status });
  }
  // env.raw (the edge route): hand the model's stream on untouched, so no script runs per chunk there;
  // the page itself notices a stream that stalls or ends early.
  return new Response(env.raw ? upstream.body : guarded(upstream.body), {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
  });
}

/** Read a request body with a size limit (Node http request). */
export function readNodeBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('too-large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export { MAX_BODY };
