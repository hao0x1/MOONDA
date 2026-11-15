// Fault injection for the startup downloads; no browser, remote server, or graphics changes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { fetchBytesWithRetry, fetchJsonWithRetry } from '../src/app/fetch.ts';

const originalFetch = globalThis.fetch;
const fast = { tries: 2, idleTimeoutMs: 25, retryDelayMs: 1 };
const checks = [];
const bytes = (...values) => new Response(new Uint8Array(values));
const quickBytes = (url, options) => fetchBytesWithRetry(url, { ...options, ...fast, tries: options?.tries ?? fast.tries });
const quickJson = (url, options) => fetchJsonWithRetry(url, { ...options, ...fast, tries: options?.tries ?? fast.tries });

try {
  {
    let calls = 0;
    globalThis.fetch = async () => ++calls === 1 ? new Promise(() => {}) : bytes(2, 3);
    assert.deepEqual([...new Uint8Array(await fetchBytesWithRetry('/headers', fast))], [2, 3]);
    assert.equal(calls, 2);
    checks.push('stalled headers time out and retry');
  }
  {
    let calls = 0, cancelled = false;
    globalThis.fetch = async () => ++calls === 1 ? new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled = true; },
    })) : bytes(4, 5);
    assert.deepEqual([...new Uint8Array(await fetchBytesWithRetry('/body', fast))], [4, 5]);
    assert.equal(calls, 2);
    assert.equal(cancelled, true);
    checks.push('stalled bodies are cancelled; retry discards the partial body');
  }
  {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(new ReadableStream({
        start(controller) {
          let n = 0;
          const timer = setInterval(() => {
            controller.enqueue(new Uint8Array([++n]));
            if (n === 12) { clearInterval(timer); controller.close(); }
          }, 7);
        },
      }));
    };
    assert.equal((await fetchBytesWithRetry('/slow-healthy', fast)).byteLength, 12);
    assert.equal(calls, 1);
    checks.push('healthy streaming continues beyond the idle timeout without restarting');
  }
  {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Promise(() => {}); };
    const controller = new AbortController();
    const job = fetchBytesWithRetry('/cancel', { ...fast, signal: controller.signal });
    controller.abort(new Error('user cancelled'));
    await assert.rejects(job, /user cancelled/);
    assert.equal(calls, 1);
    checks.push('explicit cancellation stops retries');
  }
  {
    let calls = 0;
    globalThis.fetch = async () => new Response(++calls === 1 ? 'broken JSON' : '{"ok":true}');
    assert.deepEqual(await fetchJsonWithRetry('/json', fast), { ok: true });
    assert.equal(calls, 2);
    checks.push('malformed JSON retries the full request');
  }
  {
    const source = fs.readFileSync(new URL('../src/science/layerValues.ts', import.meta.url), 'utf8');
    const code = source.slice(source.indexOf('let manifest:'), source.indexOf('\ninterface ValueGrid')).replace('export function', 'function');
    const context = vm.createContext({ fetchJsonWithRetry: quickJson });
    vm.runInContext(stripTypeScriptTypes(code + '\nglobalThis.load=loadManifest;', { mode: 'transform' }), context);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('unavailable', { status: 503 }); };
    assert.equal((await context.load()).length, 0);
    assert.equal(calls, 2);
    globalThis.fetch = async () => { calls++; return new Response('[{"id":"recovered"}]'); };
    const pending = context.load();
    assert.equal(context.load(), pending, 'concurrent manifest callers should share one request');
    assert.equal((await pending)[0].id, 'recovered');
    assert.equal((await context.load())[0].id, 'recovered');
    assert.equal(calls, 3, 'successful manifest must stay cached');
    checks.push('manifest recovers after failure, shares requests, and caches success');
  }
  {
    const source = fs.readFileSync(new URL('../src/science/heights.ts', import.meta.url), 'utf8')
      .replace(/^import .*;\n/gm, '').replaceAll('export ', '');
    let now = 100000, calls = 0;
    const context = vm.createContext({ fetchBytesWithRetry: quickBytes, MOON_RADIUS_M: 1737400, TextDecoder, Int16Array, Date: { now: () => now } });
    vm.runInContext(stripTypeScriptTypes(source + '\nglobalThis.Heights=MoonHeights;', { mode: 'transform' }), context);
    const heights = new context.Heights('/', { meta: { tiles: { tileSize: 1, count: 1, res: 100, min: 0, max: 100 } }, global: new Int16Array(1), overview: new Int16Array(1) });
    globalThis.fetch = async () => { calls++; return new Response('unavailable', { status: 503 }); };
    await heights.loadTiles(0, 0, 1, 1);
    assert.equal(calls, 3); assert.equal(heights.pendingTiles.size, 0);
    await heights.loadTiles(0, 0, 1, 1);
    assert.equal(calls, 3, 'failed tiles should back off instead of hammering the server');
    now += 20001;
    globalThis.fetch = async () => { calls++; return bytes(9, 0); };
    await heights.loadTiles(0, 0, 1, 1);
    assert.equal(heights.tiles.get('0_0')[0], 9); assert.equal(heights.pendingTiles.size, 0);
    checks.push('failed height tiles recover after backoff and release pending entries');
  }
  {
    const source = fs.readFileSync(new URL('../src/science/layerValues.ts', import.meta.url), 'utf8');
    const code = source.slice(0, source.indexOf('export function useLayerValues'))
      .replace(/^import .*;\n/gm, '').replaceAll('export ', '').replace('import.meta.hot', '(undefined)');
    const context = vm.createContext({ fetchBytesWithRetry: quickBytes, fetchJsonWithRetry: quickJson,
      Uint8Array, Uint16Array, performance, setInterval: () => 0, clearInterval: () => {}, POLAR_EXTENT_M: 1, POLAR_SIZE: 1, toMap: () => [0, 0] });
    vm.runInContext(stripTypeScriptTypes(code + '\nglobalThis.grid=grid;globalThis.sourceValue=sourceValue;', { mode: 'transform' }), context);
    globalThis.fetch = async () => new Response('unavailable', { status: 503 });
    assert.equal(await context.grid('height'), null);
    const sourceSpec = { url: '/value.bin', projection: 'global', format: 'u8', width: 1, height: 1, scale: 2 };
    assert.equal(await context.sourceValue(sourceSpec, 0, 0), null);
    globalThis.fetch = async () => bytes(4, 0);
    assert.equal((await context.grid('height'))[0], 4);
    assert.equal(await context.sourceValue(sourceSpec, 0, 0), 8);
    checks.push('failed legacy and byte value grids can retry after network recovery');
  }
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
}
