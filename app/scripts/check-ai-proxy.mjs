import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MAX_BODY, proxyChat, validateBody } from '../server/aiProxy.mjs';

// Exercise the actual app tool declarations: the proxy contract must keep lunar science working.
const source = await readFile(new URL('../src/ai/tools.ts', import.meta.url), 'utf8');
const toolLiteral = source.slice(source.indexOf('export const TOOLS: ToolSpec[] = ') + 'export const TOOLS: ToolSpec[] = '.length, source.indexOf('\n\nconst POLAR_LAYERS:'));
const tools = Function(`return (${toolLiteral.replace(/;\s*$/, '')})`)();
const question = () => ({ messages: [{ role: 'system', content: 'Help with Moon landing sites.' }, { role: 'user', content: 'Which spot has sunlight?' }], tools });
const originalFetch = globalThis.fetch;
const originalError = console.error;
let calls = 0;
const logs = [];
console.error = (...args) => logs.push(args.join(' '));
const env = { key: 'test-private-key' };
const streamResponse = text => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
try {
  assert.equal(validateBody(question()), null);
  assert.equal(validateBody({ messages: [{ role: 'user', content: 'ភាសាខ្មែរ'.repeat(100) }] }), null);
  const convo = question();
  convo.messages.push({ role: 'assistant', content: null, reasoning_content: 'Check mission.', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'get_mission_settings', arguments: '{}' } }] }, { role: 'tool', content: '{"mission_days":7}', tool_call_id: 'call1' });
  assert.equal(validateBody(convo), null);
  assert.deepEqual(validateBody({ messages: [{ role: 'user', content: 'ក'.repeat(Math.ceil(MAX_BODY / 3)) }] }), { status: 413, error: 'too-long' });
  for (const changed of [
    { ...question(), model: 'expensive' },
    { ...question(), max_tokens: 1000000 },
    { ...question(), web_search_options: {} },
    { ...question(), tools: [{ type: 'deepseek_web_search' }] },
    { ...question(), tools: [{ type: 'function', function: { name: 'unknown_tool', description: '', parameters: {} } }] },
    { ...question(), tools: [tools[0], tools[0]] },
    { ...question(), messages: [{ role: 'user', content: [{ type: 'file', file: { file_data: 'opaque' } }] }] },
    { ...question(), messages: [{ role: 'assistant', content: 'x', prefix: true }] },
    { ...question(), messages: [{ role: 'tool', content: '{}' }] },
    { ...question(), quick: 'yes' },
  ]) assert.equal(validateBody(changed)?.status, 400);

  globalThis.fetch = async (_url, options) => {
    calls++;
    const sent = JSON.parse(options.body);
    assert.equal(sent.model, 'deepseek-v4-pro');
    assert.equal(sent.max_tokens, 8192);
    assert.deepEqual(sent.thinking, { type: 'enabled' });
    assert.deepEqual(sent.stream_options, { include_usage: true });
    assert.equal(options.headers.authorization, 'Bearer test-private-key');
    return streamResponse('data: {"choices":[{"delta":{"content":"Sunny."}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":200,"completion_tokens":20,"total_tokens":220,"private":"ignored"}}\n\ndata: [DONE]\n\n');
  };
  let usage, finished;
  const response = await proxyChat(question(), { ...env, raw: true, onUsage: value => { usage = value; }, onFinish: value => { finished = value; } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Sunny\./);
  assert.deepEqual(usage, { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 });
  assert.equal(finished.reason, 'complete');
  const rejected = await proxyChat({ ...question(), tools: [{ type: 'deepseek_web_search' }] }, env);
  assert.equal(rejected.status, 400);
  assert.equal(calls, 1, 'invalid paid requests must never reach the provider');

  let cancelled = false;
  let upstreamSignal;
  let finishCount = 0;
  globalThis.fetch = async (_url, options) => {
    upstreamSignal = options.signal;
    return new Response(new ReadableStream({ start(ctrl) { ctrl.enqueue(new TextEncoder().encode('data: {}\n\n')); }, cancel() { cancelled = true; } }));
  };
  const client = new AbortController();
  const cancelledResponse = await proxyChat(question(), { ...env, signal: client.signal, onFinish: value => { finishCount++; assert.equal(value.reason, 'cancelled'); } });
  const reader = cancelledResponse.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(cancelled, true);
  assert.equal(upstreamSignal.aborted, true, 'disconnect must abort the provider request');
  assert.equal(finishCount, 1);

  // The browser's SSE reader returns at [DONE] and cancels in finally, without
  // waiting for HTTP EOF. Preserve billing that arrived in that final event.
  const completedEvents = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":300,"completion_tokens":30,"total_tokens":330}}\n\ndata: [DONE]\n\n';
  let usageCount = 0;
  const callbackOrder = [];
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(ctrl) { ctrl.enqueue(new TextEncoder().encode(completedEvents)); },
  }));
  const doneResponse = await proxyChat(question(), {
    ...env,
    onUsage: value => { usageCount++; callbackOrder.push('usage'); assert.equal(value.total_tokens, 330); },
    onFinish: value => { callbackOrder.push('finish'); assert.equal(value.reason, 'cancelled'); },
  });
  const doneReader = doneResponse.body.getReader();
  assert.match(new TextDecoder().decode((await doneReader.read()).value), /\[DONE\]/);
  await doneReader.cancel();
  assert.equal(usageCount, 1, 'billing must survive the normal SSE [DONE] cancellation');
  assert.deepEqual(callbackOrder, ['usage', 'finish']);

  let requestAborted = false;
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { requestAborted = true; reject(new Error('mock abort')); });
  });
  const waitingClient = new AbortController();
  const waiting = proxyChat(question(), { ...env, signal: waitingClient.signal });
  waitingClient.abort();
  assert.equal((await waiting).status, 499);
  assert.equal(requestAborted, true);

  globalThis.fetch = async () => new Response('test-private-key SECRET PROMPT', { status: 401 });
  assert.equal((await proxyChat(question(), env)).status, 502);
  assert.ok(logs.every(line => !line.includes('test-private-key') && !line.includes('SECRET PROMPT')), 'provider error bodies must never enter logs');
  console.log('AI proxy checks passed: real tool contract, UTF-8 bounds, paid feature rejection, usage totals, disconnect abort, safe errors.');
} finally {
  globalThis.fetch = originalFetch;
  console.error = originalError;
}
