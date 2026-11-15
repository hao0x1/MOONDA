// Exercise the actual client module against failed/silent workers and deterministic deadlines.
// No browser, network requests, generated bundles or project source rewrites are involved.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const sourceUrl = new URL('../src/science/client.ts', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8');
const spec = { lat: -89.45, lon: -136.7, mastM: 2, startMs: 0, days: 14 };

async function fixture() {
  let now = 0, nextTimer = 0;
  const timers = new Map();
  const state = { workers: [], constructorFails: false, postFails: false, pong: false };
  const clock = {
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next; timers.delete(id); now = timer.at; timer.fn();
      }
      now = end;
    },
  };
  class Worker {
    constructor() {
      if (state.constructorFails) throw Error('Worker unavailable');
      this.messages = []; state.workers.push(this);
    }
    postMessage(req) {
      if (state.postFails && req.type === 'analyse') { state.postFails = false; throw Error('postMessage failed'); }
      this.messages.push(req);
      if (req.type === 'ping' && state.pong) this.reply({ type: 'pong' });
    }
    terminate() { this.terminated = true; }
    reply(data) { this.onmessage?.({ data }); }
    crash(kind = 'error') { this[kind === 'messageerror' ? 'onmessageerror' : 'onerror']?.({ preventDefault() {} }); }
  }
  const globals = { Worker, document: { baseURI: 'https://moonda.test/' }, ...clock };
  globalThis.__scienceLoadingFixture = globals;
  const bindings = `const {Worker,document,setTimeout,clearTimeout}=globalThis.__scienceLoadingFixture;`;
  const hooks = 'const useEffect=work=>work(); const useSyncExternalStore=(_subscribe,snapshot)=>snapshot();';
  const body = source.replace("import { useEffect, useSyncExternalStore } from 'react';", hooks)
    .replaceAll('import.meta.url', JSON.stringify(sourceUrl.href));
  const inspect = '\nexport const inspect=()=>({cache:[...cache],jobs:[...jobs],routes:[...routes]});';
  const js = stripTypeScriptTypes(bindings + body + inspect);
  const client = await import('data:text/javascript;base64,' + Buffer.from(js + `\n// fixture ${Math.random()}`).toString('base64'));
  delete globalThis.__scienceLoadingFixture;
  return { client, state, clock, timers, entry: () => client.inspect().cache.find(([key]) => key === client.specKey(spec))?.[1] };
}

let checks = 0;
{
  const f = await fixture();
  assert.equal(f.state.workers.length, 0, 'a constructor failure cannot interrupt module import');
  f.state.constructorFails = true;
  assert.equal(f.client.useSpot(spec).status, 'error');
  assert.equal(f.client.inspect().jobs.length, 0);
  assert.equal(f.timers.size, 0);
  f.state.constructorFails = false;
  assert.equal(f.client.useSpot(spec).status, 'loading', 'an explicit request can retry after worker construction failed');
  const w = f.state.workers.at(-1), job = w.messages.find(m => m.type === 'analyse');
  w.reply({ type: 'result', id: job.id, horizon: {}, timeline: {} });
  assert.equal(f.entry().status, 'ready'); assert.equal(f.timers.size, 0);
  checks++;
}
{
  const f = await fixture();
  f.client.shareHeights({ meta: {}, global: new Int16Array(1), overview: new Int16Array(1) });
  assert.equal(f.state.workers[0].messages.filter(m => m.type === 'heights').length, 1, 'first worker receives one copy of shared heights');
  f.client.useSpot(spec);
  const first = f.state.workers[0], id = first.messages.find(m => m.type === 'analyse').id;
  first.crash();
  const replacement = f.state.workers[1];
  assert.equal(first.terminated, true);
  assert.deepEqual(replacement.messages.map(m => m.type), ['heights', 'analyse']);
  first.reply({ type: 'result', id, horizon: {}, timeline: {} });
  assert.equal(f.entry().status, 'loading', 'retired worker replies are ignored');
  replacement.crash('messageerror');
  assert.equal(f.entry().status, 'error', 'a repeated crash terminates the loading state');
  assert.equal(f.client.inspect().jobs.length, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.state.workers.length, 2, 'repeated crashes do not start an unbounded restart loop');
  f.client.useSpot(spec);
  const retry = f.state.workers.at(-1), retryId = retry.messages.find(m => m.type === 'analyse').id;
  retry.reply({ type: 'result', id: retryId, horizon: {}, timeline: {} });
  assert.equal(f.entry().status, 'ready'); assert.equal(f.timers.size, 0);
  checks++;
}
{
  const f = await fixture();
  f.client.useSpot(spec);
  f.clock.advance(60001);
  assert.equal(f.entry().status, 'error', 'React requests have their own deadline');
  assert.equal(f.client.inspect().jobs.length, 0);
  f.clock.advance(3000);
  assert.equal(f.state.workers[0].terminated, true, 'silent worker is retired after its ping deadline');
  assert.equal(f.timers.size, 0);
  f.client.useSpot(spec);
  assert.equal(f.state.workers.length, 2); assert.equal(f.entry().status, 'loading');
  checks++;
}
{
  const f = await fixture();
  f.state.postFails = true;
  f.client.useSpot(spec);
  assert.equal(f.state.workers.length, 2, 'postMessage failures follow the bounded worker recovery path');
  const w = f.state.workers[1], id = w.messages.find(m => m.type === 'analyse').id;
  w.reply({ type: 'result', id, horizon: {}, timeline: {} });
  assert.equal(f.entry().status, 'ready'); assert.equal(f.timers.size, 0);
  checks++;
}
{
  const f = await fixture();
  const result = f.client.analyseSpotAsync(spec, 25).then(() => null, e => e.message);
  f.state.pong = true;
  f.clock.advance(26);
  assert.match(await result, /too long/);
  assert.equal(f.client.inspect().jobs.length, 0);
  f.clock.advance(3000);
  assert.equal(f.state.workers[0].terminated, undefined, 'a synchronous pong prevents unnecessary restart');
  assert.equal(f.timers.size, 0);
  checks++;
}
{
  const f = await fixture();
  const result = f.client.planRouteAsync({ from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 1 }, mastM: 2, prefer: 'fastest' }).then(() => null, e => e.message);
  f.state.workers[0].crash(); f.state.workers[1].crash();
  assert.match(await result, /calculator stopped/);
  assert.equal(f.client.inspect().routes.length, 0); assert.equal(f.timers.size, 0);
  checks++;
}
{
  const f = await fixture();
  const controller = new AbortController();
  const result = f.client.planRouteAsync({ from: { lat: 0, lon: 0 }, to: { lat: 0, lon: 1 }, mastM: 2, prefer: 'fastest' }, controller.signal).then(() => null, e => e.name);
  controller.abort();
  assert.equal(await result, 'AbortError');
  assert.equal(f.client.inspect().routes.length, 0); assert.equal(f.timers.size, 0);
  checks++;
}
console.log(`${checks} science-worker recovery/deadline checks passed.`);
