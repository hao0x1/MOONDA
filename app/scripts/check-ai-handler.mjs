import assert from 'node:assert/strict';
import { createHandler } from '../server/aiHandler.mjs';

let reserved = 0, paid = 0, released = 0;
let deny = null;
const handler = createHandler({
  reserve: async args => {
    reserved++;
    assert.equal(args.ip, '192.0.2.10');
    assert.ok(args.inputBytes > 0);
    return deny || { ok: true, clientId: 'test-client', tokenUnits: 13000, release: async () => released++ };
  },
  proxy: async (_body, env) => {
    paid++;
    await env.onFinish({ reason: 'complete' });
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  },
});
const env = name => name === 'DEEPSEEK_API_KEY' ? 'offline-test-key-000000000000' : undefined;
const context = { ip: '192.0.2.10', requestId: 'offline-handler-test', deploy: { context: 'production' } };
const valid = JSON.stringify({ messages: [{ role: 'user', content: 'Hello moon' }] });
function request({ url = 'https://moonda.us/api/ai', origin = 'https://moonda.us', body = valid, headers = {}, method = 'POST' } = {}) {
  return new Request(url, { method, ...(method === 'POST' ? { body } : {}), headers: { origin, 'content-type': 'application/json', ...headers } });
}
assert.equal((await handler(request({ method: 'GET' }), context, env)).status, 405);
assert.equal((await handler(request({ origin: 'https://evil.example' }), context, env)).status, 403);
assert.equal((await handler(request({ origin: '' }), context, env)).status, 403);
assert.equal((await handler(request({ url: 'https://old--moonda-lunar-navigator.netlify.app/api/ai', origin: 'https://old--moonda-lunar-navigator.netlify.app' }), context, env)).status, 403);
assert.equal((await handler(request(), { ...context, deploy: { context: 'deploy-preview' } }, env)).status, 403);
assert.equal((await handler(request({ headers: { 'content-type': 'text/plain' } }), context, env)).status, 415);
assert.equal((await handler(request({ body: '{' }), context, env)).status, 400);
assert.equal((await handler(request({ body: valid, headers: { 'content-length': '999999' } }), context, env)).status, 413);
assert.equal((await handler(request({ body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(100000) }] }) }), context, env)).status, 413);
assert.equal((await handler(request({ body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }], tools: [{ type: 'web_search' }] }) }), context, env)).status, 400);
assert.equal(reserved, 0);
assert.equal(paid, 0);
deny = { ok: false, status: 429, error: 'budget-limit', reason: 'daily-budget', retryAfter: 100 };
const blocked = await handler(request(), context, env);
assert.equal(blocked.status, 429);
assert.equal(blocked.headers.get('retry-after'), '100');
assert.equal(paid, 0);
deny = null;
const response = await handler(request(), context, env);
assert.equal(response.status, 200);
assert.equal(response.headers.get('x-moonda-ai-guard'), '2026-11-16');
assert.equal(paid, 1);
assert.equal(released, 1);
console.log('AI handler checks passed: denied requests never reserve or contact provider; budgets block paid work; admitted stream releases.');
