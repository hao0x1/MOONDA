// Checks for the imagery RUNTIME: the real worker message loop (src/moon/imageryWorker.ts) and the
// layers' reload logic (src/moon/imagery.ts), run in Node with small stand-ins for the browser
// APIs they use (fetch, OffscreenCanvas, createImageBitmap, Worker, timers). No network needed.
// Run: node scripts/check-imagery-runtime.ts
//
// What a browser does that these stand-ins copy: a cross-origin 404 from Moon Trek arrives
// WITHOUT the CORS header, so fetch() rejects with a TypeError exactly like a network failure.
import { registerHooks } from 'node:module';
import { Cartographic, Ellipsoid, GeographicTilingScheme } from 'cesium';
import { trueToDisplayLatLon } from '../src/moon/frame.ts';
import type { FromWorker, Rect, ToWorker } from '../src/moon/imageryWorker.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const g = globalThis as Record<string, unknown>;
const realSetTimeout = setTimeout;
const sleep = (ms: number) => new Promise(r => realSetTimeout(r, ms));
let clock = 1_000_000; // our own clock for performance.now(), so "20 s later" takes no time
performance.now = () => clock;

// ---------------------------------------------------------------------------------------------
// Browser stand-ins for the worker.

/** A downloaded picture: the stand-in decoder just hands its RGBA pixels back. */
class FakeBlob {
  readonly pixels: Uint8ClampedArray | null;
  readonly w: number;
  readonly h: number;
  readonly body: string;
  constructor(pixels: Uint8ClampedArray | null, w: number, h: number, body = '') { this.pixels = pixels; this.w = w; this.h = h; this.body = body; }
  async text() { return this.body; }
}
g.createImageBitmap = async (src: FakeBlob | { data: Uint8ClampedArray }) =>
  src instanceof FakeBlob ? { width: src.w, height: src.h, pixels: src.pixels, close() {} } : { width: 256, height: 256, data: src.data, close() {} };
g.ImageData = class { data: Uint8ClampedArray; width: number; height: number; constructor(d: Uint8ClampedArray, w: number, h: number) { this.data = d; this.width = w; this.height = h; } };
g.OffscreenCanvas = class {
  readonly w: number;
  constructor(w: number) { this.w = w; }
  getContext() {
    let bmp: { pixels: Uint8ClampedArray } | null = null, sy = 0, sh = 0;
    const w = this.w;
    return {
      clearRect() {},
      drawImage(b: { pixels: Uint8ClampedArray }, _sx: number, y: number, _sw: number, h: number) { bmp = b; sy = y; sh = h; },
      getImageData() { return { data: bmp!.pixels.slice(sy * w * 4, (sy + sh) * w * 4) }; },
    };
  }
};

// A pretend internet: Moon Trek (with its real level limits and CORS behaviour), Lunaserv, local files.
const LOLA = 'LRO_LOLA_ClrShade_Global_256ppd_v06', WAC = 'LRO_WAC_Mosaic_Global_303ppd_v02';
const depthOf: Record<string, number> = { [LOLA]: 6, [WAC]: 8 };
const capabilities = (depth: number) => `<Capabilities><Contents><TileMatrixSet>${[...Array(depth + 1).keys()].map(z => `<TileMatrix><ows:Identifier>${z}</ows:Identifier></TileMatrix>`).join('\n')}
  <!--<TileMatrix><ows:Identifier>${depth + 3}</ows:Identifier></TileMatrix>--></TileMatrixSet></Contents></Capabilities>`;
/** Pixels of Moon Trek tile z/y/x of a layer (some pattern that differs per tile and level). */
function trekPixels(layer: string, z: number, x: number, y: number) {
  const px = new Uint8ClampedArray(256 * 256 * 4);
  for (let r = 0; r < 256; r++) for (let c = 0; c < 256; c++) {
    const o = (r * 256 + c) * 4, v = (x * 37 + y * 11 + c + r * 3 + z * 50) & 255;
    px[o] = v; px[o + 1] = layer === LOLA ? 255 - v : v; px[o + 2] = layer === LOLA ? z * 30 : v; px[o + 3] = 255;
  }
  return px;
}
const RASTER_PX = 2048;
const rasterPixels = new Uint8ClampedArray(RASTER_PX * RASTER_PX * 4).map((_, q) => (q % 4 === 3 ? (q < 8 ? 0 : 255) : (q * 7) & 255)); // RGBA (one see-through pixel)
let offline = false;
let remoteDown = false; // trek.nasa.gov and Lunaserv fail, the app's own files still load
const LOCAL = 'http://127.0.0.1:5190/';
const missingLocal = new Set<string>(); // files listed in an index that are not on disk (404)
const localJson: Record<string, unknown> = {}; // url -> content of a .json file
/** Pictures of the local whole-Moon set: every 2x2 block has one value, so half-size copies are exact. */
const BASE_BIG = `${LOCAL}data/base/slow-moon.jpg`, BASE_QUICK = `${LOCAL}data/base/quick.jpg`;
const basePixels = (w: number, h: number, f: (c: number, r: number) => number) => {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) { const o = (r * w + c) * 4; px[o] = px[o + 1] = px[o + 2] = f(c, r); px[o + 3] = 255; }
  return px;
};
const bigValue = (c: number, r: number) => ((c >> 1) * 3 + (r >> 1) * 5) & 255, quickValue = (c: number, r: number) => (c + r * 2) & 255;
const fetched: string[] = [];
const active = new Map<string, number>();
let maxPerHost = 0, maxTotal = 0, total = 0;
g.fetch = async (url: string) => {
  const host = new URL(url).host;
  fetched.push(url);
  total++; active.set(host, (active.get(host) ?? 0) + 1);
  maxPerHost = Math.max(maxPerHost, active.get(host)!); maxTotal = Math.max(maxTotal, total);
  try {
    await sleep(2);
    if (offline || (remoteDown && !url.startsWith(LOCAL))) throw new TypeError('Failed to fetch');
    const ok = (blob: FakeBlob) => ({ status: 200, ok: true, blob: async () => blob });
    if (url in localJson) return { status: 200, ok: true, json: async () => localJson[url], blob: async () => new FakeBlob(null, 0, 0) };
    if (url.startsWith(`${LOCAL}data/polar/t/`)) return missingLocal.has(url) ? { status: 404, ok: false, blob: async () => new FakeBlob(null, 0, 0) } : ok(new FakeBlob(new Uint8ClampedArray(512 * 512 * 4).fill(90), 512, 512));
    if (url === BASE_BIG) { await sleep(40); return ok(new FakeBlob(basePixels(1024, 512, bigValue), 1024, 512)); } // a big picture takes a while
    if (url === BASE_QUICK) return ok(new FakeBlob(basePixels(512, 256, quickValue), 512, 256));
    const cap = /EQ\/([^/]+)\/1\.0\.0\/WMTSCapabilities\.xml$/.exec(url);
    if (cap) return ok(new FakeBlob(null, 0, 0, capabilities(depthOf[cap[1]])));
    const t = /EQ\/([^/]+)\/1\.0\.0\/default\/default028mm\/(\d+)\/(\d+)\/(\d+)\./.exec(url);
    if (t) {
      const [layer, z, y, x] = [t[1], +t[2], +t[3], +t[4]];
      if (z > depthOf[layer]) throw new TypeError('Failed to fetch'); // a 404 without CORS header, as the browser reports it
      return ok(new FakeBlob(trekPixels(layer, z, x, y), 256, 256));
    }
    if (host.endsWith('im-ldi.com')) return ok(new FakeBlob(new Uint8ClampedArray(512 * 512 * 4).fill(180), 512, 512));
    if (url.includes('/data/')) return ok(new FakeBlob(rasterPixels, RASTER_PX, RASTER_PX));
    return { status: 404, ok: false, blob: async () => new FakeBlob(null, 0, 0) };
  } finally {
    total--; active.set(host, active.get(host)! - 1);
  }
};

// Start the real worker in this process.
const outbox: FromWorker[] = [];
g.WorkerGlobalScope = function WorkerGlobalScope() {};
g.self = globalThis;
g.postMessage = (m: FromWorker) => { outbox.push(m); };
const W = await import('../src/moon/imageryWorker.ts');
const send = (m: ToWorker) => (g.onmessage as (e: { data: ToWorker }) => void)({ data: m });
let nextId = 1;
/** Post jobs to the worker and wait for all their answers. */
async function run(jobs: ToWorker[]): Promise<FromWorker[]> {
  for (const j of jobs) send(j);
  const ids = new Set(jobs.map(j => ('id' in j ? j.id : -1)));
  for (let n = 0; n < 4000; n++) {
    if ([...ids].every(id => outbox.some(m => m.id === id))) break;
    await sleep(1);
  }
  return [...ids].map(id => outbox.find(m => m.id === id)!);
}

const ts = new GeographicTilingScheme({ ellipsoid: Ellipsoid.MOON });
const rectAt = (lat: number, lon: number, level: number, dx = 0): Rect => {
  const d = trueToDisplayLatLon(lat, lon), t = ts.positionToTileXY(new Cartographic(d.lon, d.lat), level)!;
  const r = ts.tileXYToRectangle(t.x + dx, t.y, level);
  return { west: r.west, south: r.south, east: r.east, north: r.north };
};
const trekJob = (layer: string, ext: string, rect: Rect, level: number, maxSourceLevel: number): ToWorker =>
  ({ id: nextId++, flipRows: false, job: { kind: 'trek', rect, level, layer, ext, maxSourceLevel, minTrueLat: -79.6 } });
const pixelsOf = (m: FromWorker) => (m.bitmap as unknown as { data: Uint8ClampedArray } | null)?.data ?? null;

// 1. Moon Trek layers that stop before maxSourceLevel (MoonMap asks LOLA for level 7, the server has 6) --
{
  const fp = new W.Footprint(), lolaZ7 = () => fetched.filter(u => u.includes(`${LOLA}/1.0.0/default/default028mm/7/`)).length;
  const rects = [0, 1, 2].map(dx => rectAt(-43.3, -11.2, 8, dx));
  const answers = await run(rects.map(r => trekJob(LOLA, 'png', r, 8, 7)));
  let same = 0;
  answers.forEach((m, n) => {
    const plan = W.planTrek(fp, rects[n], 8, 6, -79.6)!;
    const ref = W.sampleTiles(fp, plan.grids, plan.keys, plan.keys.map(k => { const t = W.trekTileOf(k); return { w: 256, h: 256, ch: 3 as const, data: rgb(trekPixels(LOLA, t.z, t.x, t.y)) }; }), false)!;
    const got = pixelsOf(m);
    if (got && got.length === ref.length && got.every((v, q) => v === ref[q])) same++;
  });
  check('LOLA at display level 8 with maxSourceLevel 7: every tile drawn from level 6 (not transparent)', same === 3 && answers.every(m => !m.gaps), `${same}/3 match the level-6 picture`);
  check('the worker never asks Moon Trek for a level it does not have', lolaZ7() === 0, `${lolaZ7()} requests for LOLA level 7`);
  await run([trekJob(LOLA, 'png', rectAt(-20, 40, 7), 7, 7)]);
  check('the WMTS description is read once per layer', fetched.filter(u => u.includes(`${LOLA}/1.0.0/WMTSCapabilities.xml`)).length === 1);
}
function rgb(px: Uint8ClampedArray) { const d = new Uint8Array((px.length / 4) * 3); for (let q = 0, o = 0; q < px.length; q += 4, o += 3) { d[o] = px[q]; d[o + 1] = px[q + 1]; d[o + 2] = px[q + 2]; } return d; }

// 2. Downloads at once: never more than 6 per server (the browser's HTTP/1.1 limit) or 8 in all --
{
  maxPerHost = maxTotal = 0;
  const jobs: ToWorker[] = [];
  for (let dx = 0; dx < 12; dx++) jobs.push(trekJob(WAC, 'jpg', rectAt(-75, 20, 8, dx), 8, 8)); // ~12 source tiles each
  await run(jobs);
  check('at most 6 downloads at once from trek.nasa.gov, 8 in all', maxPerHost <= 6 && maxTotal <= 8 && maxPerHost === 6, `max ${maxPerHost} per server, ${maxTotal} in all`);
}

// 3. Network failures: holes are reported, and forgotten as soon as the server answers again -----
{
  offline = true;
  const a = rectAt(10, 100, 7), b = rectAt(-30, -100, 7);
  const [down] = await run([trekJob(WAC, 'jpg', a, 7, 8)]);
  check('offline: the tile comes back transparent and marked as having gaps', down.gaps && down.bitmap === null);
  offline = false;
  const before = fetched.length;
  const [again] = await run([trekJob(WAC, 'jpg', a, 7, 8)]);
  check('right after a failure the same downloads are not tried again (no hammering)', again.gaps && fetched.length === before);
  const [other] = await run([trekJob(WAC, 'jpg', b, 7, 8)]);
  check('the next successful download says the server recovered', other.recovered && !other.gaps);
  const [back] = await run([trekJob(WAC, 'jpg', a, 7, 8)]);
  check('...and the failed tile is downloaded again at once (not 20 s later)', !back.gaps && back.bitmap !== null && !back.recovered);
  // The pyramid server: failures are forgotten when the main thread says the browser is online again.
  offline = true;
  const pj = (): ToWorker => ({ id: nextId++, flipRows: false, job: { kind: 'pyramid', rect: rectAt(-89.6, 120, 12), level: 12, layers: 'luna_wac_global', minK: 4 } });
  const [p1] = await run([pj()]);
  offline = false;
  const n0 = fetched.length;
  const [p2] = await run([pj()]);
  send({ forgetFailures: true });
  const [p3] = await run([pj()]);
  check('"online" message: failed downloads are tried again', p1.gaps && p2.gaps && fetched.length - n0 > 0 && !p3.gaps && p3.bitmap !== null, `${fetched.length - n0} downloads after the message`);
  clock += 25_000;
}

// 3b. South-pole squares stored with the app: local first, the remote server only where none is stored --
{
  const base = `${LOCAL}data/polar/t/`, fp = new W.Footprint();
  const job = (rect: Rect, level = 12): ToWorker => ({ id: nextId++, flipRows: false, job: { kind: 'pyramid', rect, level, layers: 'L', minK: 4, local: base } });
  const squaresOf = (rect: Rect, level = 12) => { const plan = W.planPyramid(fp, rect, level, 4)!, n = 2 ** plan.level; return plan.keys.map(q => ({ k: plan.level, i: q % n, j: Math.floor(q / n) })); };
  const stored = rectAt(-89.3, 30, 12), stored2 = rectAt(-89.1, -70, 12), holed = rectAt(-88.6, 150, 12), remote = rectAt(-88.0, -100, 12);
  const listed = [stored, stored2, holed].flatMap(r => squaresOf(r));
  send({ pyramidIndex: { layers: 'L', halfM: 304000, tilePx: 512, levels: { 8: { runs: listed.map(q => [q.j, q.i, q.i]) } } }, base });
  const lunaserv = (from: number) => fetched.slice(from).filter(u => u.includes('im-ldi.com')).length, files = (from: number) => fetched.slice(from).filter(u => u.startsWith(base)).length;
  const greyOf = (m: FromWorker) => { const px = pixelsOf(m)!; for (let q = 0; q < px.length; q += 4) if (px[q + 3] > 0) return px[q]; return -1; };

  let n0 = fetched.length;
  const [a] = await run([job(stored)]);
  check('stored squares are read from the app\'s own files; the remote server is not asked', a.bitmap !== null && !a.gaps && !a.parent && lunaserv(n0) === 0 && files(n0) === squaresOf(stored).length && greyOf(a) === 90,
    `${files(n0)} files, ${lunaserv(n0)} remote requests`);
  n0 = fetched.length;
  const [b] = await run([job(remote)]);
  check('squares that are not stored come from the remote server', b.bitmap !== null && !b.gaps && files(n0) === 0 && lunaserv(n0) === squaresOf(remote).length && greyOf(b) === 180);
  const lost = squaresOf(holed)[0];
  missingLocal.add(W.pyramidLocalUrl(base, lost.k, lost.i, lost.j));
  n0 = fetched.length;
  const [c] = await run([job(holed)]);
  check('a listed square that is missing on disk is fetched from the remote server instead (no hole)', c.bitmap !== null && !c.gaps && !c.parent && lunaserv(n0) === 1 && files(n0) === squaresOf(holed).length);
  check('a job that names no local folder, or another layer set, never reads local files', await (async () => {
    n0 = fetched.length;
    const r1 = rectAt(-89.3, 30, 13), r2 = rectAt(-89.3, 31, 13);
    await run([{ id: nextId++, flipRows: false, job: { kind: 'pyramid', rect: r1, level: 13, layers: 'L', minK: 4, local: null } }, { id: nextId++, flipRows: false, job: { kind: 'pyramid', rect: r2, level: 13, layers: 'other', minK: 4, local: base } }]);
    return files(n0) === 0 && lunaserv(n0) > 0;
  })());

  // The remote server is down: stored tiles still draw, the others keep their parent, and the dead server is not hammered.
  remoteDown = true;
  const far = [...Array(24).keys()].map(dx => rectAt(-87.5, 60, 12, dx)), wanted = new Set(far.flatMap(r => squaresOf(r)).map(q => `${q.i}_${q.j}`)).size;
  n0 = fetched.length;
  const down = await run(far.map(r => job(r)));
  const tries = lunaserv(n0);
  check('server down: tiles that need it answer "keep the parent" and are marked for a later retry', down.every(m => m.bitmap === null && m.parent === true && m.gaps));
  check('server down: a few downloads find that out (at most 8 already on their way + 4), the rest do not even try', tries <= 12 && wanted >= 2 * tries, `${tries} tries for ${wanted} squares`);
  const [d] = await run([job(stored2)]);
  check('server down: tiles made of stored squares still draw', d.bitmap !== null && !d.gaps && !d.parent && greyOf(d) === 90);
  clock += 25_000;
  n0 = fetched.length;
  const again = await run([...Array(6).keys()].map(dx => job(rectAt(-87.0, -30, 12, dx))));
  check('server still down 25 s later: one download checks, everything else waits for its answer', again.every(m => m.parent === true) && lunaserv(n0) === 1, `${lunaserv(n0)} tries`);
  clock += 25_000;
  remoteDown = false;
  const up = await run(far.map(r => job(r)));
  check('server back: the same tiles are drawn at once, and the layers are told it recovered', up.every(m => m.bitmap !== null && !m.gaps && !m.parent) && up.some(m => m.recovered));
  const net = up.at(-1)!.net!;
  check('every answer carries the worker\'s download counts [stored files, remote, failed]', net[0] >= files(0) && net[1] > 0 && net[2] >= tries, net.join(', '));
  // Moon Trek tiles that cannot be downloaded keep their parent too (a hole would show the blurrier layer underneath).
  remoteDown = true;
  const [t] = await run([trekJob(WAC, 'jpg', rectAt(33, -140, 7), 7, 8)]);
  remoteDown = false;
  send({ forgetFailures: true });
  check('Moon Trek down: the tile keeps its parent', t.bitmap === null && t.parent === true && t.gaps);
}

// 3c. The local whole-Moon picture: tiles are cut straight out of it -----------------------------
{
  const cut = (mip: number, px: number, py: number) => ({ url: BASE_BIG, mip, px, py, mips: 1 });
  const rect = rectAt(0, 0, 3), n0 = fetched.length;
  // While the big picture is still being decoded, the small quick-look picture (same pixels at this level) stands in.
  const [q] = await run([{ id: nextId++, flipRows: false, job: { kind: 'base', rect, level: 3, cut: cut(1, 256, 0), quick: { url: BASE_QUICK, mip: 0, px: 256, py: 0, mips: 0 } } }]);
  const qp = pixelsOf(q)!;
  let quickOk = !!qp;
  for (let j = 0; quickOk && j < 256; j += 7) for (let i = 0; i < 256; i += 5) if (qp[((255 - j) * 256 + i) * 4] !== quickValue(256 + i, j)) quickOk = false;
  await sleep(80);
  const [m1, m0] = await run([{ id: nextId++, flipRows: false, job: { kind: 'base', rect, level: 3, cut: cut(1, 256, 0) } }, { id: nextId++, flipRows: true, job: { kind: 'base', rect, level: 4, cut: cut(0, 512, 256) } }]);
  const p1 = pixelsOf(m1)!, p0 = pixelsOf(m0)!;
  let bigOk = !!p1 && !!p0;
  for (let j = 0; bigOk && j < 256; j += 7) for (let i = 0; i < 256; i += 5) {
    if (p1[((255 - j) * 256 + i) * 4] !== ((256 + i) * 3 + j * 5 & 255) || p1[((255 - j) * 256 + i) * 4 + 3] !== 255) bigOk = false; // the half-size copy, south row first
    if (p0[(j * 256 + i) * 4] !== bigValue(512 + i, 256 + j)) bigOk = false; // full size, rows flipped
  }
  check('local Moon picture: the quick-look picture is used until the big one is decoded', quickOk && !q.gaps);
  check('local Moon picture: tiles are exact cut-outs of the picture and of its half-size copy', bigOk && !m1.gaps && !m0.gaps);
  check('local Moon picture: each file is read once', fetched.slice(n0).filter(u => u === BASE_BIG).length === 1 && fetched.slice(n0).filter(u => u === BASE_QUICK).length === 1);
  const [gone] = await run([{ id: nextId++, flipRows: false, job: { kind: 'base', rect, level: 3, cut: { url: `${LOCAL}no-such-folder/moon.jpg`, mip: 0, px: 0, py: 0, mips: 0 } } }]);
  check('local Moon picture missing: the tile is transparent and reported (the Moon Trek photo then takes over)', gone.bitmap === null && gone.gaps && !gone.parent);
}

// 4. Polar rasters: all 7 science maps + the photo on screen at once are decoded once, not over and over --
{
  const urls = [...Array(8).keys()].map(n => `http://127.0.0.1:5190/data/layers/map${n}.png`);
  const rj = (url: string, dx: number): ToWorker => ({ id: nextId++, flipRows: false, job: { kind: 'raster', rect: rectAt(-88, 30, 7, dx), level: 7, url, extentM: 304000, clipTrueLat: -80.02, featherM: 0 } });
  for (let round = 0; round < 4; round++) for (const [n, u] of urls.entries()) { await run([rj(u, round)]); clock += 200 + n; }
  const loads = urls.map(u => fetched.filter(f => f === u).length);
  check('8 polar maps in use (170 MiB, over the 150 MiB budget): each decoded once, none dropped while in use', loads.every(n => n === 1), `downloads per map: ${loads.join(',')}`);
  // Later only map 0 stays in use; a ninth map makes room by dropping maps nobody looked at for a while.
  clock += 30_000;
  await run([rj(urls[0], 0)]);
  const ninth = 'http://127.0.0.1:5190/data/layers/map8.png';
  await run([rj(ninth, 0)]);
  await run([rj(urls[0], 1)]);
  await run([rj(urls[1], 1)]);
  check('...maps no longer in use are dropped when room is needed, the one in use is kept',
    fetched.filter(f => f === urls[0]).length === 1 && fetched.filter(f => f === urls[1]).length === 2);
}

// 5. Main thread: layers reload their holes once the network works again ------------------------
{
  // Stand-ins for the page: a fake Worker class, window events and timers on our clock.
  const workers: { sent: ToWorker[]; onmessage: ((e: { data: FromWorker }) => void) | null }[] = [];
  g.Worker = class { sent: ToWorker[] = []; onmessage = null; onerror = null; constructor() { workers.push(this as never); } postMessage(m: ToWorker) { this.sent.push(m); } terminate() {} };
  const listeners: Record<string, () => void> = {};
  g.addEventListener = (type: string, fn: () => void) => { listeners[type] = fn; };
  (g.OffscreenCanvas as { prototype: { transferToImageBitmap?: () => unknown } }).prototype.transferToImageBitmap = () => ({ blank: true });
  const timers = new Map<number, { at: number; fn: () => void }>();
  let timerId = 1;
  g.setTimeout = (fn: () => void, ms = 0) => { timers.set(timerId, { at: clock + ms, fn }); return timerId++; };
  g.clearTimeout = (id: number) => { timers.delete(id); };
  const advance = async (ms: number) => {
    const end = clock + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const e of timers) if (e[1].at <= end && (!due || e[1].at < due[1].at)) due = e;
      if (!due) break;
      timers.delete(due[0]); clock = due[1].at; due[1].fn();
      await sleep(5); // let whatever the timer started (a reload asking for tiles) finish
    }
    clock = end;
  };
  // imagery.ts imports without file extensions (Vite style): let Node find the .ts files.
  registerHooks({
    resolve(spec, ctx, next) {
      try { return next(spec, ctx); } catch (e) { if (spec.startsWith('.') && !spec.endsWith('.ts')) return next(`${spec}.ts`, ctx); throw e; }
    },
  });
  const I = await import('../src/moon/imagery.ts');
  const photo = I.createMoonTrekProvider({ layer: WAC, ext: 'jpg', maxSourceLevel: 8, minTrueLat: -81, credit: 'x' });
  const height = I.createMoonTrekProvider({ layer: LOLA, ext: 'png', maxSourceLevel: 7, minTrueLat: -79.6, credit: 'x' });
  const pyramid = I.createPolarPyramidProvider({ layers: 'luna_wac_global', minK: 4, credit: 'x' });
  check('both Moon Trek layers share one worker (one download limit for trek.nasa.gov); the pyramid has its own',
    photo.worker === height.worker && pyramid.worker !== photo.worker && photo.worker > 0, `workers ${photo.worker}, ${height.worker}, ${pyramid.worker}`);
  let reloads = 0, events = 0;
  photo._reload = () => { reloads++; };
  I.imageryReloaded.addEventListener(() => { events++; });
  const worker = workers[photo.worker];
  /** Cesium asks the photo layer for a tile; the worker answers with these flags. */
  const tile = async (gaps: boolean, recovered = false) => {
    const pending = photo.requestImage(300, 100, 8);
    await sleep(0); await sleep(0);
    const msg = worker.sent.at(-1) as Extract<ToWorker, { id: number }>;
    worker.onmessage!({ data: { id: msg.id, bitmap: null, gaps, recovered } });
    await pending;
  };
  await tile(true);
  await advance(24_000);
  const early = reloads;
  await advance(1_500);
  check('tiles with holes: the layer reloads ~25 s later (once the worker will really retry)', early === 0 && reloads === 1 && events === 1, `reloads ${early} at 24 s, ${reloads} at 25.5 s`);
  await tile(false);
  await advance(120_000);
  check('no holes, no reload', reloads === 1);
  // Downloads keep failing: reloads back off (30 s, 60 s, 120 s ...), never a storm.
  const times: number[] = [];
  photo._reload = () => { times.push(clock); void tile(true); };
  const t0 = clock;
  await tile(true);
  await advance(400_000);
  const gaps = times.map((t, n) => Math.round((t - (n ? times[n - 1] : t0)) / 1000));
  check('while downloads keep failing, reloads wait longer and longer', gaps.length >= 3 && gaps.slice(2).every((d, n) => d >= gaps[n + 1]) && gaps.at(-1)! >= 120, `seconds between reloads: ${gaps.join(', ')}`);
  // Network back: a "recovered" answer from the worker reloads the holes within ~2 s.
  photo._reload = () => { reloads++; };
  await advance(3_600_000); // a calm hour: the spacing starts over
  reloads = 0;
  await tile(true);
  await advance(2_000);
  await tile(false, true);
  const before = reloads;
  await advance(2_000);
  check('when the server answers again, holes are reloaded within ~2 s', before === 0 && reloads === 1);
  // The browser comes back online: workers are told to retry, the holes reload soon after.
  await advance(60_000);
  await tile(true);
  const sentBefore = workers.map(w => w.sent.length);
  listeners.online();
  await advance(2_000);
  check('"online": every worker is told to retry failed downloads, the layer reloads at once',
    workers.every((w, n) => w.sent.length === sentBefore[n] + 1 && 'forgetFailures' in w.sent.at(-1)!) && reloads === 2);
  // A hidden layer (Cesium removed its reload hook) just forgets its holes: it reloads anyway when shown.
  photo._reload = undefined;
  await advance(60_000);
  const eventsBefore = events;
  await tile(true);
  await advance(60_000);
  check('hidden layer: no reload call, no event', reloads === 2 && events === eventsBefore);

  // 6. Main thread: "keep the parent", the pictures stored with the app, and the Moon Trek photo above them --
  g.document = { baseURI: LOCAL };
  type Provider = ReturnType<typeof I.createMoonTrekProvider>;
  type Sent = Extract<ToWorker, { id: number }>;
  const isParentMark = (b: unknown) => photo.tileDiscardPolicy.shouldDiscardImage(b);
  const xy = (lat: number, lon: number, level: number) => { const d = trueToDisplayLatLon(lat, lon); return ts.positionToTileXY(new Cartographic(d.lon, d.lat), level)!; };
  /** Cesium asks a layer for a tile. Returns what was sent to the worker (if anything) and, when the worker's reply is given or no job was needed, the picture Cesium receives. */
  const ask = async (p: Provider, x: number, y: number, level: number, reply?: Partial<FromWorker>) => {
    const w = workers[p.worker], before = w.sent.length, pending = p.requestImage(x, y, level);
    if (pending === undefined) return { waiting: true, sent: null, image: undefined };
    await sleep(0); await sleep(0);
    const sent = w.sent.length > before ? (w.sent.at(-1) as Sent) : null;
    if (sent && reply) w.onmessage!({ data: { id: sent.id, bitmap: null, gaps: false, recovered: false, ...reply } });
    return { waiting: false, sent, image: sent && !reply ? undefined : await pending };
  };
  const failed = await ask(photo, 301, 100, 8, { parent: true, gaps: true }), fine = await ask(photo, 302, 100, 8, {});
  check('a worker answer "keep the parent" reaches Cesium as the picture its discard policy throws away', isParentMark(failed.image) && fine.image !== undefined && !isParentMark(fine.image) && photo.tileDiscardPolicy.isReady());
  const wac = xy(-82, 40, 10), nac = xy(-87, 40, 10);
  const deep = await ask(pyramid, wac.x, wac.y, 10), real = await ask(pyramid, nac.x, nac.y, 10);
  check('pyramid: deeper than the photos are sharp (outside 84 deg S) -> "keep the parent" at once, nothing sent to the worker; inside -> a job',
    isParentMark(deep.image) && deep.sent === null && real.sent !== null && real.sent.job.kind === 'pyramid' && real.sent.job.local === null);

  // The squares stored with the app: the list is read once and handed to the worker before the first job.
  const tdir = `${LOCAL}data/polar/t/`, ridge = xy(-89.45, -136.7, 12);
  const fpx = new W.Footprint(), rr = ts.tileXYToRectangle(ridge.x, ridge.y, 12), plan = W.planPyramid(fpx, { west: rr.west, south: rr.south, east: rr.east, north: rr.north }, 12, 4)!;
  localJson[`${tdir}index.json`] = { layers: 'L2', halfM: 304000, tilePx: 512, levels: { 8: { runs: plan.keys.map(q => [Math.floor(q / 256), q % 256, q % 256]) } } };
  const pyramid2 = I.createPolarPyramidProvider({ layers: 'L2', minK: 4, credit: 'x' });
  const tooEarly = await ask(pyramid2, ridge.x, ridge.y, 12);
  await sleep(20);
  const told = workers[pyramid2.worker].sent.find(m => 'pyramidIndex' in m) as Extract<ToWorker, { pyramidIndex: unknown }> | undefined;
  const local1 = await ask(pyramid2, ridge.x, ridge.y, 12);
  check('pyramid: waits for the list of stored squares, tells the worker, then names the local folder in every job',
    tooEarly.waiting && told?.base === tdir && local1.sent?.job.kind === 'pyramid' && local1.sent.job.local === tdir);
  // Tiles drawn from stored squares have their own queue: they are not refused while slow downloads fill the other one.
  const slowTile = xy(-88, -100, 13);
  let slowAccepted = 0, localAccepted = 0;
  for (let n = 0; n < 40; n++) if (pyramid2.requestImage(slowTile.x + n, slowTile.y, 13) !== undefined) slowAccepted++;
  for (let n = 0; n < 30; n++) if (pyramid2.requestImage(ridge.x, ridge.y, 12) !== undefined) localAccepted++;
  await sleep(0); await sleep(0);
  check('tiles that need downloads queue up to 24 per worker; tiles made of stored squares are still accepted behind them', slowAccepted === 24 - 1 && localAccepted === 30, `${slowAccepted} slow accepted, then ${localAccepted}/30 local`);

  // The local whole-Moon picture and the Moon Trek photo that leaves its levels to it.
  const bdir = `${LOCAL}data/base/`;
  localJson[`${bdir}base.json`] = { pictures: {
    global: { file: 'moon8k.jpg', width: 8192, height: 4096, west: -180, north: 90, level: 4 },
    quick: { file: 'moon2k.jpg', width: 2048, height: 1024, west: -180, north: 90, level: 2 },
    south: { file: 'south6.jpg', width: 6144, height: 6144, west: 56.25, north: 33.75, level: 6 } } };
  const base = I.createBaseMosaicProvider({ url: './data/base/', credit: 'x' });
  const photo2 = I.createMoonTrekProvider({ layer: WAC, ext: 'jpg', maxSourceLevel: 8, minTrueLat: -81, credit: 'x', overBase: true });
  let photo2Reloads = 0;
  photo2._reload = () => { photo2Reloads++; };
  check('before base.json is read both layers say "ask again" (no remote request slips out)', base.requestImage(0, 0, 0) === undefined && photo2.requestImage(0, 0, 0) === undefined);
  await sleep(20);
  const cutOf = (m: Sent | null) => (m && m.job.kind === 'base' ? m.job : null);
  const b3 = cutOf((await ask(base, 5, 2, 3)).sent), b1 = cutOf((await ask(base, 1, 0, 1)).sent), s6 = cutOf((await ask(base, 96, 32, 6)).sent), s5 = cutOf((await ask(base, 48, 16, 5)).sent);
  check('base: tiles up to level 4 are cut from the whole-Moon picture (small quick-look picture first for levels 0-2)',
    b3?.cut.url === `${bdir}moon8k.jpg` && b3.cut.mip === 1 && b3.cut.px === 5 * 256 && b3.cut.py === 2 * 256 && b3.cut.mips === 4 && b3.quick === undefined
    && b1?.cut.mip === 3 && b1.cut.px === 256 && b1.cut.py === 0 && b1.quick?.url === `${bdir}moon2k.jpg` && b1.quick.mip === 1 && b1.quick.px === 256);
  check('base: levels 5-6 near the south pole are cut from the south picture', s6?.cut.url === `${bdir}south6.jpg` && s6.cut.mip === 0 && s6.cut.px === 3072 && s6.cut.py === 3072 && s6.cut.mips === 1
    && s5?.cut.url === `${bdir}south6.jpg` && s5.cut.mip === 1 && s5.cut.px === 1536 && s5.cut.py === 1536);
  const o5 = await ask(base, 0, 0, 5), o6 = await ask(base, 10, 20, 6);
  check('base: deeper than its pictures -> "keep the parent", nothing sent to the worker', isParentMark(o5.image) && o5.sent === null && isParentMark(o6.image) && o6.sent === null);
  const t3 = await ask(photo2, 5, 2, 3), t6s = await ask(photo2, 96, 32, 6), t6 = await ask(photo2, 10, 20, 6), t7 = await ask(photo2, 170, 64, 7);
  check('Moon Trek photo over the base: nothing is asked of the internet for levels the local picture has',
    t3.sent === null && t3.image !== undefined && !isParentMark(t3.image) && t6s.sent === null && t6.sent?.job.kind === 'trek' && t7.sent?.job.kind === 'trek');
  check('...a Moon Trek layer without overBase still streams every level', (await ask(photo, 5, 2, 3)).sent?.job.kind === 'trek');
  // The local picture turns out to be missing: the Moon Trek photo takes its levels over.
  await ask(base, 6, 2, 3, { gaps: true });
  const after = await ask(photo2, 5, 2, 3);
  check('local picture unreadable: the Moon Trek photo is reloaded and streams the low levels itself', photo2Reloads === 1 && after.sent?.job.kind === 'trek');

  // v5: the seam fix layer (east-lit quadrant of the WAC mosaic), the north picture and pole-aware copies.
  const vdir = `${LOCAL}data/base/v5/`;
  localJson[`${vdir}base.json`] = { pictures: {
    global: { file: 'moon8k.jpg', width: 8192, height: 4096, west: -180, north: 90, level: 4, poleAware: true },
    quick: { file: 'moon2k.jpg', width: 2048, height: 1024, west: -180, north: 90, level: 2, poleAware: true },
    south: { file: 'south6.jpg', width: 6144, height: 6144, west: 56.25, north: 33.75, level: 6 },
    north: { file: 'north6.jpg', width: 6144, height: 6144, west: -123.75, north: 33.75, level: 6 } },
  fix: { albedo: { file: 'albedo.jpg', width: 3185, height: 4096, west: 150, east: 290, north: 90, south: -90, scale: 1.2 }, hillshade: { near: 'NEAR', far: 'FAR', nearMaxLat: 59.5 }, C: 0.5, S0: 170 } };
  const base5 = I.createBaseMosaicProvider({ url: './data/base/v5/', credit: 'x' });
  const photo5 = I.createMoonTrekProvider({ layer: WAC, ext: 'jpg', maxSourceLevel: 8, minTrueLat: -81.5, credit: 'x', overBase: true });
  const fix5 = I.createSeamFixProvider({ credit: 'x' });
  check('seam fix: asks again until base.json is read', fix5.requestImage(0, 0, 0) === undefined);
  await sleep(20);
  const quad = xy(0, -135, 7), band = xy(0, -85, 7), right = xy(0, 20, 7), low = xy(0, -135, 3), nth = xy(70, -135, 6), inPolar = xy(-86, -135, 8);
  const fq = await ask(fix5, quad.x, quad.y, 7), fb = await ask(fix5, band.x, band.y, 7), fr = await ask(fix5, right.x, right.y, 7);
  const fl = await ask(fix5, low.x, low.y, 3), fn = await ask(fix5, nth.x, nth.y, 6), fpol = await ask(fix5, inPolar.x, inPolar.y, 8);
  check('seam fix: a job in the east-lit quadrant and the cross-fade bands; nothing where the photo is right, the local pictures draw, or the south-polar photos lie',
    fq.sent?.job.kind === 'synth' && fb.sent?.job.kind === 'synth' && fr.sent === null && fl.sent === null && fn.sent === null && fpol.sent === null
    && fq.sent.job.kind === 'synth' && fq.sent.job.fix.albedo.url === `${vdir}albedo.jpg` && fq.sent.job.fix.near === 'NEAR');
  const pq = await ask(photo5, quad.x, quad.y, 7), pb = await ask(photo5, band.x, band.y, 7), pr = await ask(photo5, right.x, right.y, 7);
  check('photo: skips tiles the seam fix covers completely, still draws under the cross-fade bands and elsewhere', pq.sent === null && pb.sent?.job.kind === 'trek' && pr.sent?.job.kind === 'trek');
  const g3 = cutOf((await ask(base5, 5, 2, 3)).sent), n6 = cutOf((await ask(base5, nth.x, nth.y, 6)).sent);
  check('v5 base: the whole-Moon pictures are halved pole-aware; levels 5-6 near the north pole come from the north picture',
    g3?.cut.poleAware === true && n6?.cut.url === `${vdir}north6.jpg` && n6.cut.poleAware === false);
}

console.log(failures === 0 ? '\nAll imagery runtime checks passed.' : `\n${failures} imagery runtime check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
