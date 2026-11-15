// Regression checks for startup failure/cancellation. Run with the project's Node runtime:
//   node scripts/check-startup-loading.mjs
// Executes the current TypeScript loader with an accelerated clock and browser stubs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = stripTypeScriptTypes(readFileSync(new URL('../src/moon/preload.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, ''));

async function run(options = {}) {
  let now = 0, nextTimer = 0, settled = false, error, analyses = 0, surfaceCalls = 0, warmedViews = 0;
  let navigationEnabled = false, interfaceReady = false;
  const timers = new Map(), progress = [], poses = [], snapshots = [];
  const controller = new AbortController();
  if (options.alreadyAborted) controller.abort();
  const schedule = (fn, ms, interval = 0) => {
    const id = ++nextTimer;
    timers.set(id, { at: now + ms, fn, interval });
    return id;
  };
  const clear = id => timers.delete(id);
  const laterPromise = ms => new Promise(resolve => schedule(resolve, ms));
  const fetchOk = options.filesOk !== false;
  const context = {
    Promise, URL, Map, console,
    performance: { now: () => now },
    setTimeout: schedule, clearTimeout: clear,
    setInterval: (fn, ms) => schedule(fn, ms, ms), clearInterval: clear,
    requestAnimationFrame: fn => schedule(() => fn(now), 16),
    window: { __moonda: {} },
    settings: { get: () => ({ sound: false }), subscribe: () => () => {} },
    prefetchMusic: () => Promise.resolve(), t: value => value,
    loadManifest: () => Promise.resolve([]),
    analyseSpotAsync: () => { analyses++; return Promise.resolve(); },
    fetch: () => Promise.resolve({ ok: fetchOk, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }),
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${source};globalThis.run = runPreload;`, context);
  const viewer = {
    isDestroyed: () => !!options.destroyed,
    camera: { setView: p => poses.push({ at: now, destination: p.destination }) },
    scene: { requestRender() {}, globe: { tilesLoaded: options.tilesReady !== false } },
  };
  const heightsReady = options.rejectHeights ? Promise.reject(new Error('DEM unavailable')) : laterPromise(options.heightsAt ?? 0);
  const deps = {
    signal: controller.signal, heightsReady, namesReady: Promise.resolve(),
    skyReady: options.rejectSky ? Promise.reject(new Error('Sky unavailable')) : Promise.resolve(),
    startView: { destination: 'opening' },
    imageryPending: () => options.pending ? options.pending(now) : options.tilesReady === false ? 1 : 0,
    lander: { prewarm() { surfaceCalls++; return Promise.resolve(options.surfaceReady); } },
    warmLayers: () => options.stallLayers ? new Promise(() => {}) : Promise.resolve(true),
    warmViews: () => Array.from({ length: options.poleViews ?? 0 }, (_, i) => ({
      pose: { destination: `pole-${i}` }, label: `pole-${i}`, maxMs: 6000,
      warm: () => { warmedViews++; },
    })),
    onProgress(p) {
      // Match the ordering of MoonMap's completion callback: release navigation, then update App.
      if (p.done) navigationEnabled = true;
      if (p.done) { assert.equal(navigationEnabled, true); interfaceReady = true; }
      progress.push({ at: now, p });
    },
  };
  if (options.filesOk !== undefined) deps.layerFiles = async () => ['https://example.invalid/startup-test.bin'];
  context.run(viewer, deps).then(() => { settled = true; }, e => { settled = true; error = e; });
  if (options.abortAt !== undefined) schedule(() => {
    controller.abort();
    // A Skip/deadline must release the map synchronously, before its handler returns.
    assert.equal(navigationEnabled, true);
    assert.equal(interfaceReady, true);
  }, options.abortAt);
  for (const at of options.snapshots ?? []) schedule(() => snapshots.push({ at, p: progress.at(-1)?.p }), at);
  if (options.drainUntil) schedule(() => {}, options.drainUntil);
  await new Promise(setImmediate);
  for (let i = 0; i < 100_000; i++) {
    if (settled && now >= (options.drainUntil ?? 0)) break;
    let chosen, next;
    for (const [id, timer] of timers) if (!next || timer.at < next.at) { chosen = id; next = timer; }
    assert.ok(next, 'loader must either settle or have a bounded next timer');
    now = next.at;
    assert.ok(now <= 230_000, 'loader exceeded the test deadline');
    timers.delete(chosen);
    if (next.interval) timers.set(chosen, { ...next, at: now + next.interval });
    next.fn();
    await new Promise(setImmediate);
  }
  assert.ok(settled, 'loader did not settle');
  if (error) throw error;
  return { at: now, analyses, surfaceCalls, warmedViews, progress, poses, snapshots,
    final: progress.at(-1)?.p, done: progress.filter(x => x.p.done) };
}

const stage = (result, id) => result.final.stages.find(s => s.id === id);
let count = 0;
async function check(name, body) { await body(); count++; console.log(`PASS ${name}`); }

async function manifestEffect(load) {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const effect = app.match(/useEffect\(\(\) => \{\n    loadNames\(\)[\s\S]*?\n  \}, \[\]\);/);
  assert.ok(effect, 'initial-data effect must be available for lifecycle testing');
  let at = 0, next = 0, cleanup;
  const timers = new Map(), events = new Map(), calls = [], values = [];
  const context = {
    useEffect: fn => { cleanup = fn(); },
    loadNames: () => Promise.resolve([]), setNames() {}, setExploreNames() {},
    loadManifest: () => { calls.push(at); return Promise.resolve(load(calls.length)); },
    setManifest: entries => values.push({ at, entries }),
    setTimeout: (fn, ms) => { const id = ++next; timers.set(id, { at: at + ms, fn }); return id; },
    clearTimeout: id => timers.delete(id),
    window: { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) },
  };
  vm.createContext(context);
  vm.runInContext(stripTypeScriptTypes(effect[0]), context);
  await new Promise(setImmediate);
  const advance = async until => {
    for (;;) {
      let id, next;
      for (const [key, timer] of timers) if (timer.at <= until && (!next || timer.at < next.at)) { id = key; next = timer; }
      if (!next) break;
      at = next.at; timers.delete(id); next.fn(); await new Promise(setImmediate);
    }
    at = until;
  };
  return { calls, values, timers, events, advance, cleanup: () => cleanup() };
}

await check('successful startup reports every required stage ready', async () => {
  const r = await run({ filesOk: true });
  assert.equal(r.done.length, 1);
  assert.ok(r.final.stages.every(s => s.state === 'done' || s.state === 'off'));
});

await check('rejected DEM is deferred and never starts science preparation', async () => {
  const r = await run({ rejectHeights: true });
  assert.equal(stage(r, 'mountains').state, 'later');
  assert.equal(stage(r, 'science').state, 'later');
  assert.equal(r.analyses, 0);
});

await check('rejected sky and incomplete surface resources are deferred', async () => {
  const r = await run({ rejectSky: true, surfaceReady: false });
  assert.equal(stage(r, 'sky').state, 'later');
  assert.equal(stage(r, 'surface').state, 'later');
});

await check('supporting layer HTTP failure cannot report Map layers ready', async () => {
  const r = await run({ filesOk: false });
  assert.equal(stage(r, 'layers').state, 'later');
});

await check('stage rows update within one overall percent and progress never regresses', async () => {
  const r = await run({ tilesReady: false, pending: at => at < 1000 ? 100 : at < 1100 ? 42 : at < 1200 ? 40 : at < 1300 ? 70 : 20,
    snapshots: [1050, 1150, 1250, 1350] });
  const fractions = r.snapshots.map(s => Math.round(s.p.stages.find(x => x.id === 'photo').frac * 100));
  assert.deepEqual(fractions, [58, 60, 60, 80]);
  for (let i = 1; i < r.progress.length; i++) assert.ok(r.progress[i].p.pct >= r.progress[i - 1].p.pct);
});

await check('Skip during the terrain handover cannot move the camera after completion', async () => {
  const r = await run({ abortAt: 280, drainUntil: 1000 });
  assert.equal(r.done.length, 1);
  assert.equal(r.done[0].at, 280);
  assert.equal(r.poses.at(-1).at, 280);
  assert.equal(r.poses.at(-1).destination, 'opening');
  assert.equal(r.surfaceCalls, 0);
});

await check('Skip during a pole visit restores the opening view and prevents later visits', async () => {
  const r = await run({ poleViews: 3, abortAt: 650, drainUntil: 2000 });
  assert.equal(r.done.length, 1);
  assert.equal(r.done[0].at, 650);
  assert.ok(r.poses.some(p => p.destination === 'pole-0'));
  assert.equal(r.poses.at(-1).at, 650);
  assert.equal(r.poses.at(-1).destination, 'opening');
  assert.equal(r.warmedViews, 0);
});

await check('180-second deadline cancels real work before unlocking Enter/navigation', async () => {
  const r = await run({ heightsAt: 89_990, tilesReady: false, stallLayers: true, abortAt: 180_000 });
  assert.equal(r.done.length, 1);
  assert.equal(r.done[0].at, 180_000);
  assert.ok(r.at <= 180_100);
  assert.equal(r.poses.at(-1).at, 180_000);
  assert.equal(stage(r, 'layers').state, 'later');
});

await check('an already-aborted loader finishes once without starting heavy work', async () => {
  const r = await run({ alreadyAborted: true });
  assert.equal(r.done.length, 1);
  assert.equal(r.done[0].at, 0);
  assert.equal(r.surfaceCalls, 0);
  assert.equal(r.analyses, 0);
});

await check('a destroyed viewer never emits readiness', async () => {
  const r = await run({ destroyed: true });
  assert.equal(r.progress.length, 0);
});

await check('the layer list recovers from an initial failed manifest without reloading', async () => {
  const effect = await manifestEffect(call => call === 1 ? [] : [{ id: 'height' }]);
  await effect.advance(4999);
  assert.deepEqual(effect.calls, [0]);
  await effect.advance(5000);
  assert.deepEqual(effect.calls, [0, 5000]);
  assert.equal(effect.values.at(-1).entries[0].id, 'height');
  await effect.advance(60_000);
  assert.equal(effect.calls.length, 2);
  effect.cleanup();
  assert.equal(effect.events.size, 0);
});

await check('manifest retries back off, retry online immediately, and stop after cleanup', async () => {
  const effect = await manifestEffect(() => []);
  await effect.advance(66_000);
  assert.deepEqual(effect.calls, [0, 5000, 15_000, 35_000, 65_000]);
  effect.events.get('online')();
  await new Promise(setImmediate);
  assert.equal(effect.calls.at(-1), 66_000);
  effect.cleanup();
  const before = effect.calls.length;
  await effect.advance(200_000);
  assert.equal(effect.calls.length, before);
  assert.equal(effect.timers.size, 0);
  assert.equal(effect.events.size, 0);
});

await check('an unmounted manifest request cannot update the UI or schedule another retry', async () => {
  let resolve;
  const effect = await manifestEffect(() => new Promise(r => { resolve = r; }));
  effect.cleanup();
  resolve([]);
  await new Promise(setImmediate);
  assert.equal(effect.values.length, 0);
  assert.equal(effect.timers.size, 0);
});

console.log(`${count} startup regression checks passed.`);
