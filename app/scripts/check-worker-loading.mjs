// Exercise the real worker pool and metadata gates with failed workers and a controlled clock.
// No browser, network request or source mutation is needed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = readFileSync(new URL('../src/moon/imagery.ts', import.meta.url), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const compile = (ts, names, values, result) => new Function(...names, stripTypeScriptTypes(ts, { mode: 'strip' }) + `\nreturn ${result};`)(...values);
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function clock() {
  let now = 0, next = 1;
  const timers = new Map();
  return {
    get now() { return now; },
    timers,
    setTimeout(callback, ms) { const id = next++; timers.set(id, { at: now + ms, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
      }
      now = end; await flush();
    },
  };
}

function poolFixture(options = {}) {
  const time = clock(), instances = [], marker = {}, stats = { renders: 0 };
  let constructionFailures = options.constructionFailures ?? 0;
  class Worker {
    constructor() { if (constructionFailures-- > 0) throw Error('Cannot create worker'); this.messages = []; instances.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  }
  const klass = section('class ImageryWorkers {', '\nlet pool:').replaceAll('import.meta.url', JSON.stringify('https://moonda.us/assets/imagery.js'));
  const dependencies = {
    Worker, navigator: { hardwareConcurrency: 4 }, isPhoneGraphics: () => false,
    detectBitmapFlip: () => Promise.resolve(false), addEventListener() {},
    imageryReloaded: { raiseEvent() { stats.renders++; } },
    blankTile: () => ({ blank: true }), parentMarkBitmap: () => marker,
    setTimeout: time.setTimeout.bind(time), clearTimeout: time.clearTimeout.bind(time),
    performance: { now: () => time.now }, console: { warn() {} },
    RASTER_QUEUE: 48, TILED_QUEUE: 24, LOCAL_QUEUE: 64,
    invalidateScienceSource() {}, baseBroke() {}, RequestState: { CANCELLED: 4 },
  };
  const Pool = compile(klass, Object.keys(dependencies), Object.values(dependencies), 'ImageryWorkers');
  return { pool: new Pool(), time, instances, marker, stats };
}

const job = { kind: 'base', level: 0, rect: { west: 0, east: 1, south: 0, north: 1 } };
const owner = worker => ({ worker, gaps: 0, recovered: 0, noteGaps() { this.gaps++; }, networkBack() { this.recovered++; } });
let checks = 0;

{
  const { pool, time, marker } = poolFixture();
  const index = pool.scienceWorker, original = pool.workers[index], provider = owner(index);
  const config = { pyramidIndex: { valid: true }, base: 'https://moonda.us/data/polar/t/' };
  pool.tell(index, config); pool.scienceState(['https://moonda.us/data/layers/ice.png']);
  const pending = [pool.run(index, job, provider), pool.warmScience([]), pool.scienceValue({}, 0, 0), pool.scienceControl()];
  await flush(); original.onerror({ message: 'worker script failed' });
  assert.deepEqual(await Promise.all(pending), [marker, false, null, null]);
  assert.equal(pool.pending(), 0);
  assert.equal(pool.scienceWarm.size + pool.scienceValues.size + pool.scienceControls.size, 0);
  assert.equal(time.timers.size, 1, 'all request deadlines cleared; only recovery remains');
  await time.advance(500);
  const replacement = pool.workers[index];
  assert.notEqual(replacement, original);
  assert.equal(replacement.messages[0].cacheBudgetBytes, 64 * 2 ** 20, 'same science memory budget');
  assert.ok(replacement.messages.includes(config), 'source index restored');
  assert.deepEqual(replacement.messages.find(m => m.scienceState)?.scienceState.activeUrls, ['https://moonda.us/data/layers/ice.png']);
  assert.equal(provider.recovered, 1);
  let closed = 0;
  original.onmessage({ data: { bitmap: { close() { closed++; } } } });
  assert.equal(closed, 1, 'late stale-worker bitmap released');
  checks++;
}

{
  const { pool, time, marker } = poolFixture();
  const index = pool.route('pyramid'), provider = owner(index), indexConfig = { pyramidIndex: { valid: true }, base: '/stored/' };
  pool.tell(index, indexConfig);
  for (let crash = 0; crash < 3; crash++) {
    pool.workers[index].onmessageerror({ message: 'cannot deserialize response' });
    if (crash < 2) await time.advance(500 * 2 ** crash);
  }
  assert.equal(pool.route('pyramid'), index, 'routing survives recovery');
  assert.equal(pool.workers[index], null);
  assert.equal(time.timers.size, 0, 'persistent failures have bounded restarts');
  assert.equal(await pool.run(index, job, provider), marker, 'keep the existing parent picture');
  assert.equal(provider.gaps, 1);
  checks++;
}

{
  const { pool, time } = poolFixture();
  const outcomes = {};
  pool.warmScience([]).then(v => { outcomes.warm = v; });
  pool.scienceValue({}, 0, 0).then(v => { outcomes.value = v; });
  pool.scienceControl().then(v => { outcomes.control = v; });
  await time.advance(5000); assert.deepEqual(outcomes, { control: null });
  await time.advance(15000); assert.deepEqual(outcomes, { control: null, value: null });
  await time.advance(40000); assert.deepEqual(outcomes, { control: null, value: null, warm: false });
  assert.equal(pool.scienceWarm.size + pool.scienceValues.size + pool.scienceControls.size, 0);
  assert.equal(time.timers.size, 0);
  checks++;
}

{
  const { pool, time } = poolFixture({ constructionFailures: 1 });
  assert.equal(pool.workers[0], null, 'constructor failure does not stop pool/app setup');
  await time.advance(500); assert.ok(pool.workers[0]);
  const provider = owner(0), bitmap = {}, pending = pool.run(0, job, provider);
  await flush();
  const message = pool.workers[0].messages.find(m => m.job);
  pool.workers[0].onmessage({ data: { id: message.id, bitmap, gaps: false, recovered: false } });
  assert.equal(await pending, bitmap); assert.equal(pool.pending(), 0);
  checks++;
}

{
  const { pool, time } = poolFixture();
  pool.workers[pool.scienceWorker].onerror({ message: 'failure just before dispose' });
  pool.disposeScience(); await time.advance(2000);
  assert.equal(pool.workers[pool.scienceWorker], null, 'disposed worker is not resurrected');
  assert.equal(time.timers.size, 0);
  checks++;
}

function metadataFixture() {
  const requests = [], notices = { renders: 0, reloads: 0 }, messages = [];
  class Provider { constructor(options) { this.options = options; this.worker = options.worker; } reloadNow() { notices.reloads++; } }
  const dependencies = {
    URL, document: { baseURI: 'https://moonda.us/' }, TILE: 256,
    fetchJsonWithRetry(url, options) { const request = { url, options, ...deferred() }; requests.push(request); return request.promise; },
    isPhoneGraphics: () => false, Rectangle: { MAX_VALUE: {}, clone: value => value },
    ReprojectedImageryProvider: Provider, PreparedLayerProvider: Provider,
    workers: () => ({ route: () => 1, tell: (_worker, message) => messages.push(message) }),
    imageryReloaded: { raiseEvent() { notices.renders++; } }, console: { warn() {} },
    pyramidLevelFor: level => level, PYRAMID_MAX_K: 10, POLAR_LIMIT_DEG: -80,
    polarRectangle: () => ({}), pyramidSurelyLocal: () => false, pyramidParentIsEnough: () => false,
    tileTrueLatRange: () => ({ minDeg: -90, maxDeg: -80 }), pixelDeg: () => 1,
    parsePyramidIndex: json => json.valid ? { layers: 'photos' } : null,
  };
  const metadata = section('interface BasePicture {', '\n/** False once the seam-fix layer')
    + '\nlet seamFixOn = false;\n' + source.slice(source.indexOf('export function createPolarPyramidProvider('));
  const factories = compile(metadata.replaceAll('export ', ''), Object.keys(dependencies), Object.values(dependencies), '({createBaseMosaicProvider,createMoonTrekProvider,createPolarPyramidProvider})');
  return { ...factories, requests, notices, messages };
}

{
  const f = metadataFixture(), base = f.createBaseMosaicProvider({ credit: 'test' });
  const trek = f.createMoonTrekProvider({ layer: 'moon', ext: 'jpg', maxSourceLevel: 8, overBase: true, credit: 'test' });
  const rect = { west: 0, east: 1, south: 0, north: 1 };
  assert.equal(base.options.jobFor(rect, 0, 0, 0), 'wait');
  assert.equal(trek.options.jobFor(rect, 0, 0, 0), 'wait');
  assert.equal(f.requests[0].options.idleTimeoutMs, 8000);
  f.requests[0].reject(Error('bounded metadata timeout')); await flush();
  assert.equal(base.options.jobFor(rect, 0, 0, 0), null);
  assert.equal(trek.options.jobFor(rect, 0, 0, 0).kind, 'trek', 'remote fallback is released');
  assert.ok(f.notices.renders > 0 && f.notices.reloads > 0);
  checks++;
}

{
  const f = metadataFixture(), provider = f.createPolarPyramidProvider({ layers: 'photos', minK: 4, credit: 'test' });
  const rect = { west: 0, east: 1, south: 0, north: 1 };
  assert.equal(provider.options.jobFor(rect, 5), 'wait');
  f.requests[0].reject(Error('bounded index timeout')); await flush();
  const job = provider.options.jobFor(rect, 5);
  assert.equal(job.kind, 'pyramid'); assert.equal(job.local, null, 'failed index uses remote source');
  assert.equal(f.notices.renders, 1);
  checks++;
}

console.log(`${checks} imagery worker/metadata loading checks passed.`);
