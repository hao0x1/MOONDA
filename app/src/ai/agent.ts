// The AI landing-site helper's "harness": a small agent loop around a thinking chat model.
//
//   user question -> model thinks (streamed) -> asks for tools -> we run them here, in the page,
//   with the app's own science (skyline, Sun/Earth over the mission, NASA polar maps) -> results go
//   back -> model thinks again ... -> final answer (streamed).
//
// Every step is reported through onEvent so the panel can show the thinking, each tool call with
// its result, and the answer as it is written. The API key never touches the page: we call our own
// /api/ai endpoint (a Netlify Function online, the Vite server on this Mac).
//
// It can never hang: Stop aborts the stream and any tool in flight, 45 s without a byte from the
// model ends the answer, every tool has its own time limit, and a whole answer is capped at 6 minutes.

import { getLang, t } from '../i18n';

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ToolSpec { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }

/** Why a run ended badly, as a fixed code (the panel shows a short sentence for each). */
export type ErrCode = 'no-key' | 'busy' | 'network' | 'stall' | 'too-long' | 'service' | 'chat-too-long' | 'steps';

export type AgentEvent =
  | { type: 'round'; round: number }
  | { type: 'thinking'; delta: string }
  | { type: 'answer'; delta: string }
  | { type: 'tool-start'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool-progress'; id: string; text: string }
  | { type: 'tool-end'; id: string; name: string; ok: boolean; summary: string; ms: number; result?: unknown }
  | { type: 'error'; code: ErrCode; message: string; retry: boolean }
  | { type: 'done'; stopped: boolean };

export interface ToolRunner {
  run(name: string, args: Record<string, unknown>, progress?: (text: string) => void, signal?: AbortSignal): Promise<{ result: unknown; summary: string }>;
}

const MAX_ROUNDS = 10;
const SILENCE_MS = 45_000;      // no bytes from the model for this long: give up on this answer
const RUN_CAP_MS = 6 * 60_000;  // the whole answer, all steps together

/** The most time one tool call may take. A scan gets a few seconds per spot (the first spot
 *  also waits for the height maps). */
export function toolLimitMs(name: string, args: Record<string, unknown>) {
  if (name === 'scan_area') return 30_000 + 8_000 * Math.min(16, Math.max(4, Number(args.points) || 10)) + 10_000;
  if (name === 'analyse_spot') return 75_000;
  return 15_000;
}

const MESSAGES: Record<ErrCode, () => string> = {
  'no-key': () => t('ai.err.noKey'),
  busy: () => t('ai.err.busy'),
  network: () => t('ai.err.network'),
  stall: () => t('ai.err.stall'),
  'too-long': () => t('ai.err.tooLong'),
  service: () => t('ai.err.service'),
  'chat-too-long': () => t('ai.err.chatTooLong'),
  steps: () => t('ai.err.steps'),
};
/** Our server's fixed error codes -> ours. */
function codeFromServer(code: unknown): ErrCode {
  switch (code) {
    case 'no-key': return 'no-key';
    case 'busy': return 'busy';
    case 'network': return 'network';
    case 'timeout': return 'stall';
    case 'too-long': return 'chat-too-long';
    default: return 'service';
  }
}
class RunError extends Error { code: ErrCode; constructor(code: ErrCode) { super(code); this.code = code; } }

/** Read a server-sent-events stream (OpenAI-style chunks). `alive` is called whenever bytes arrive. */
async function* sse(body: ReadableStream<Uint8Array>, signal: AbortSignal, alive: () => void): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      alive();
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        let chunk: Record<string, unknown>;
        try { chunk = JSON.parse(data) as Record<string, unknown>; } catch { continue; } // keep-alive or partial line
        if (typeof chunk.moonda_error === 'string') throw new RunError(chunk.moonda_error === 'stall' ? 'stall' : 'network'); // our server ended a broken stream
        yield chunk;
      }
    }
  } finally { reader.cancel().catch(() => {}); }
}

/** Run one tool with its own time limit; Stop (the run's signal) also ends it. */
async function runTool(runner: ToolRunner, name: string, args: Record<string, unknown>, progress: (text: string) => void, run: AbortSignal) {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  run.addEventListener('abort', stop);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_r, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new Error(t('ai.err.toolSlow'))); }, toolLimitMs(name, args)); });
  const stopped = new Promise<never>((_r, reject) => { ctl.signal.addEventListener('abort', () => reject(new Error('Stopped.'))); });
  try { return await Promise.race([runner.run(name, args, progress, ctl.signal), limit, stopped]); }
  finally { clearTimeout(timer); run.removeEventListener('abort', stop); }
}

/** One conversation with the helper. Keeps the history (including the model's thinking, which
 *  the API requires to be sent back when tools are used). */
export class Agent {
  messages: ChatMessage[];
  private system: string;
  private tools: ToolSpec[];
  private runner: ToolRunner;
  private abort: AbortController | null = null;
  private why: 'user' | ErrCode | null = null;

  constructor(system: string, tools: ToolSpec[], runner: ToolRunner) {
    this.system = system;
    this.messages = [{ role: 'system', content: system }];
    this.tools = tools;
    this.runner = runner;
  }

  get busy() { return !!this.abort; }
  /** A stopped run can leave tool calls without results, which the API refuses: drop that last step. */
  private repair() {
    let i = this.messages.length - 1;
    while (i > 0 && this.messages[i].role !== 'assistant') i--;
    const m = this.messages[i];
    if (i <= 0 || !m.tool_calls?.length) return;
    const answered = new Set(this.messages.slice(i + 1).map(x => x.tool_call_id));
    if (m.tool_calls.some(c => !answered.has(c.id))) this.messages.splice(i);
  }
  /** Continue a saved conversation (the system prompt is always the current one). */
  load(saved: ChatMessage[]) { this.messages = [this.messages[0], ...saved.filter(m => m.role !== 'system')]; }
  /** End the run now: the model stream and any tool in flight are aborted. */
  stop() { this.end('user'); }
  private end(why: 'user' | ErrCode) { if (this.abort && !this.abort.signal.aborted) { this.why = why; this.abort.abort(); } }

  async ask(question: string, onEvent: (e: AgentEvent) => void, context?: string) {
    if (this.abort) return;
    const abort = new AbortController();
    this.abort = abort;
    this.why = null;
    const cap = setTimeout(() => this.end('too-long'), RUN_CAP_MS);
    // the system prompt is the current one, in the current language
    this.messages[0] = { role: 'system', content: getLang() === 'km' ? `${this.system}\n\nAnswer in Khmer (ភាសាខ្មែរ). Keep place names, numbers and units as they are.` : this.system };
    this.repair();
    const start = this.messages.length;
    this.messages.push({ role: 'user', content: context ? `${question}\n\n[What the user is looking at right now: ${context}]` : question });
    let silence: ReturnType<typeof setTimeout> | undefined;
    const alive = () => { clearTimeout(silence); silence = setTimeout(() => this.end('stall'), SILENCE_MS); };
    const fail = (code: ErrCode) => onEvent({ type: 'error', code, message: MESSAGES[code](), retry: code !== 'no-key' && code !== 'chat-too-long' });
    try {
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        onEvent({ type: 'round', round });
        alive();
        const res = await fetch('./api/ai', {
          method: 'POST', signal: abort.signal, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: this.messages, tools: this.tools }),
        });
        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({})) as { error?: string };
          if (round === 1) this.messages.splice(start); // nothing happened: forget the question
          throw new RunError(res.status === 404 ? 'no-key' : codeFromServer(err.error));
        }
        let thinking = '', answer = '';
        const calls = new Map<number, ToolCall>();
        for await (const chunk of sse(res.body, abort.signal, alive)) {
          const choice = (chunk.choices as { delta?: Record<string, unknown>; finish_reason?: string }[] | undefined)?.[0];
          if (!choice) continue;
          const d = choice.delta ?? {};
          if (typeof d.reasoning_content === 'string' && d.reasoning_content) { thinking += d.reasoning_content; onEvent({ type: 'thinking', delta: d.reasoning_content }); }
          if (typeof d.content === 'string' && d.content) { answer += d.content; onEvent({ type: 'answer', delta: d.content }); }
          for (const tc of (d.tool_calls as { index: number; id?: string; function?: { name?: string; arguments?: string } }[] | undefined) ?? []) {
            const cur = calls.get(tc.index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.function.name += tc.function.name;
            if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
            calls.set(tc.index, cur);
          }
        }
        clearTimeout(silence);
        if (abort.signal.aborted) break;
        const toolCalls = [...calls.values()].filter(c => c.function.name);
        this.messages.push({ role: 'assistant', content: answer || null, reasoning_content: thinking, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
        if (!toolCalls.length) { onEvent({ type: 'done', stopped: false }); return; } // finished: no more tools wanted
        // run the tools the model asked for (one after another, so the panel shows them in order)
        for (const call of toolCalls) {
          let args: Record<string, unknown> = {};
          try { args = call.function.arguments ? JSON.parse(call.function.arguments) as Record<string, unknown> : {}; } catch { /* bad JSON from the model */ }
          onEvent({ type: 'tool-start', id: call.id, name: call.function.name, args });
          const t0 = performance.now();
          let content: string, ok = true, summary: string, result: unknown;
          try {
            const out = await runTool(this.runner, call.function.name, args, text => onEvent({ type: 'tool-progress', id: call.id, text }), abort.signal);
            content = JSON.stringify(out.result);
            summary = out.summary;
            result = out.result;
          } catch (e) {
            ok = false;
            summary = e instanceof Error ? e.message : String(e);
            content = JSON.stringify({ error: summary });
          }
          if (abort.signal.aborted) break;
          onEvent({ type: 'tool-end', id: call.id, name: call.function.name, ok, summary, ms: performance.now() - t0, result });
          this.messages.push({ role: 'tool', tool_call_id: call.id, content });
        }
        if (abort.signal.aborted) break;
        if (round === MAX_ROUNDS) throw new RunError('steps');
      }
    } catch (e) {
      if (e instanceof RunError) fail(e.code);
      else if (!abort.signal.aborted) fail('network'); // fetch failed or the stream broke
    } finally {
      clearTimeout(silence);
      clearTimeout(cap);
      if (this.abort === abort) this.abort = null;
      if (abort.signal.aborted) {
        if (this.why && this.why !== 'user') fail(this.why);
        onEvent({ type: 'done', stopped: this.why === 'user' });
      }
    }
  }
}
