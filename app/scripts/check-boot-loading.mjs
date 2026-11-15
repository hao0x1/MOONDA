// Fault-injection checks for the exact production bootstrap in index.html.
// Uses a fake clock and DOM: no network, browser profile, or real waiting.
// node scripts/check-boot-loading.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const begin = html.indexOf('window.__bootLoad = function');
const source = html.slice(begin, html.indexOf('\n    </script>', begin));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function fixture(fetchImpl, options = {}) {
  let now = 0, nextTimer = 0;
  const timers = new Map(), elements = new Map(), scripts = [], listeners = new Map();
  const state = { bootVisible: true, aborts: 0, reloads: 0, cancelledBodies: 0, requests: [] };
  const makeElement = tag => ({
    tag, children: [], attributes: {}, events: {}, textContent: '',
    classList: { remove() {} }, style: { setProperty() {} },
    setAttribute(key, value) { this.attributes[key] = value; },
    appendChild(child) { this.children.push(child); if (child.id) elements.set(child.id, child); },
    addEventListener(name, fn) { this.events[name] = fn; },
    remove() { this.removed = true; },
  });
  const col = makeElement('div');
  for (const id of ['boot-app-n', 'boot-app-line']) elements.set(id, makeElement('span'));
  const document = {
    readyState: options.loading ? 'loading' : 'complete',
    getElementById(id) { return elements.get(id) ?? null; },
    querySelector(selector) { assert.equal(selector, '.boot-col'); return state.bootVisible ? col : null; },
    createElement: makeElement,
    head: { appendChild(script) { scripts.push(script); } },
    addEventListener(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
  };
  const ctx = {
    window: { fetch: options.noFetch ? undefined : true, ReadableStream: true, AbortController: true },
    document, location: { reload() { state.reloads++; } },
    Date: { now: () => now },
    AbortController: class { signal = {}; abort() { state.aborts++; } },
    fetch(url, init) { state.requests.push({ url, init }); return fetchImpl(url, init, state); },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(source, ctx);
  ctx.window.__bootLoad('./assets/app.js', 1000);
  return {
    state, scripts, elements, timers, document,
    async advance(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = end; await flush();
    },
    ready() { document.readyState = 'complete'; for (const fn of listeners.get('DOMContentLoaded') ?? []) fn(); },
    recovery() { return elements.get('boot-recovery'); },
  };
}

let checks = 0;
{
  const response = deferred();
  const f = fixture(() => response.promise);
  await f.advance(19999);
  assert.equal(f.scripts.length, 0, 'waits for live transfer until the idle deadline');
  await f.advance(1);
  assert.equal(f.state.aborts, 1);
  assert.equal(f.scripts.length, 1, 'stalled headers fall back to a module request');
  response.resolve({ body: { cancel() { f.state.cancelledBodies++; return Promise.resolve(); } } });
  await flush();
  assert.equal(f.state.cancelledBodies, 1, 'late response is released');
  assert.equal(f.scripts.length, 1, 'late response does not start a second app');
  checks++;
}
{
  let reads = 0, cancels = 0;
  const f = fixture(() => Promise.resolve({ ok: true, body: { getReader() { return {
    read() { return ++reads === 1 ? Promise.resolve({ done: false, value: new Uint8Array(580) }) : new Promise(() => {}); },
    cancel() { cancels++; return Promise.resolve(); },
  }; } } }));
  await flush();
  assert.equal(f.elements.get('boot-app-n').textContent, '58%');
  await f.advance(20000);
  assert.equal(cancels, 1);
  assert.equal(f.scripts.length, 1, 'a body stalled at 58% cannot hold the app indefinitely');
  checks++;
}
{
  let read = deferred(), cancels = 0;
  const f = fixture(() => Promise.resolve({ ok: true, body: { getReader() { return {
    read() { return read.promise; }, cancel() { cancels++; return Promise.resolve(); },
  }; } } }));
  await flush();
  for (let i = 0; i < 8; i++) {
    await f.advance(10000);
    const current = read; read = deferred(); current.resolve({ done: false, value: new Uint8Array(10) }); await flush();
  }
  assert.equal(f.scripts.length, 0, 'active slow transfer stays alive before the total deadline');
  await f.advance(10000);
  assert.equal(f.scripts.length, 1, 'the total deadline bounds a transfer even when chunks keep arriving');
  assert.equal(cancels, 1);
  checks++;
}
{
  let reads = 0;
  const f = fixture(() => Promise.resolve({ ok: true, body: { getReader() { return {
    read() { return Promise.resolve(++reads === 1 ? { done: false, value: new Uint8Array(1000) } : { done: true }); },
  }; } } }));
  await flush();
  assert.equal(f.elements.get('boot-app-n').textContent, '100%');
  assert.equal(f.scripts.length, 1);
  assert.equal(f.scripts[0].src, './assets/app.js', 'successful prefetch retains the browser cache URL');
  f.state.bootVisible = false; f.scripts[0].onload();
  await f.advance(200000);
  assert.equal(f.recovery(), undefined);
  assert.equal(f.timers.size, 0, 'success clears every boot watchdog');
  checks++;
}
{
  const f = fixture(() => Promise.reject(Error('offline')));
  await flush();
  assert.equal(f.scripts.length, 1, 'rejected fetch still falls back immediately');
  f.scripts[0].onerror();
  assert.equal(f.scripts.length, 2);
  assert.match(f.scripts[1].src, /^\.\/assets\/app\.js\?boot-retry=/);
  f.scripts[1].onerror();
  assert.equal(f.scripts.length, 2, 'module errors have one bounded retry');
  assert.equal(f.recovery().attributes.role, 'alert');
  const button = f.recovery().children.find(x => x.tag === 'button');
  assert.equal(button.textContent, 'Reload MOONDA'); button.events.click();
  assert.equal(f.state.reloads, 1);
  assert.equal(f.timers.size, 0);
  checks++;
}
{
  const f = fixture(() => { throw Error('fetch must not be used'); }, { noFetch: true });
  assert.equal(f.scripts.length, 1);
  await f.advance(45000);
  assert.equal(f.recovery().attributes.role, 'alert', 'stalled module request exposes recovery');
  assert.equal(f.scripts.length, 1, 'timeout does not risk executing a second app');
  assert.equal(f.scripts[0].onload, null);
  checks++;
}
{
  const f = fixture(() => { throw Error('fetch must not be used'); }, { noFetch: true });
  f.scripts[0].onload();
  await f.advance(10000);
  assert.equal(f.recovery().attributes.role, 'alert', 'runtime failure before React mounts exposes recovery');
  checks++;
}
{
  const f = fixture(() => Promise.reject(Error('offline')), { loading: true });
  await flush(); f.scripts[0].onerror(); f.scripts[1].onerror();
  assert.equal(f.recovery(), undefined);
  f.ready();
  assert.equal(f.recovery().attributes.role, 'alert', 'early failures render after the body becomes available');
  checks++;
}
console.log(`Bootstrap fault-injection checks passed (${checks} scenarios).`);
