// Imagery for the 3D Moon: NASA photos and map layers, re-projected into the rotated display frame.
//
// Live sources checked 14 Nov 2026 (curl: real images, 200, Access-Control-Allow-Origin: *):
// - lroc-tiles.quickmap.io/tiles/kag_tc_e_7m/lunar-fulleqc/{z}/{x}/{y}.png?d_val=0,5000&d_opt=wcolut0:
//   global Kaguya evening TC, native 7.4 m; z12 delivery grid 5.2 m (no claim of 5 m real
//   detail). A fixed display range keeps the stretch consistent; WAC anchors broad tone.
//   ISAS/JAXA observation data, credited reuse and display changes allowed; via Lunar QuickMap.
// - trek.nasa.gov/tiles/Moon/EQ/{layer}/1.0.0/default/default028mm/{z}/{y}/{x}.png:
//   Kaguya_TCortho_Mosaic_Global_4096ppd is native 7.4 m but the LIVE service stops at z10,
//   about 20.8 m/pixel. z11/12 are 404: this is the fallback, not the primary global photo.
//   NAC mosaics for all six Apollo sites, Tycho, Chang'e-4, SLIM, IM-1 and Blue Ghost's region
//   reach about 0.3–2.6 m grid spacing; the source itself can be coarser. NASA/GSFC/ASU.
// - lroc-tiles.quickmap.io/tiles/wac_nac_nacroi/lunar-fulleqc/{z}/{x}/{y}.jpg:
//   QuickMap's WAC + NAC strips + ROI basemap. Requested only around recent landers, at close
//   zoom; about 0.5–2 m real NAC detail, not a new global sub-metre survey. Lunar QuickMap
//   (NASA, Intuitive Machines, ACT); live catalogue describes these data as public domain.
// - lroc-tiles.quickmap.io/tiles/lnpole_avg/lunar-sterenp/{z}/{x}/{y}.png?d_val=0,0.5&d_opt=wcolut0:
//   controlled north-pole NAC, 84–90°N, native 1 m, z12 grid 0.888 m. NASA/GSFC/ASU.
//   The public WMS also has a 1 m uncontrolled north mosaic, but its measured 21 s cold renders
//   lose to these cached polar tiles (3.2 s). WMS is tried only after a cached square fails.
//   Existing south stays local first.
// LROC permits credited educational use; do not call all non-PDS products public domain.
// Full layer names, measured responses, terms and modification notice: CREDITS-imagery.md.
//
// Round 2: QuickMap's kag_tc_m_7m Morning product (same URL/grid/range as Evening) is also
// live, public and CORS-enabled; JAXA's sln-l-tc-5-morning-map-v4.0 archive confirms the product.
// Four paired histograms put detail-free shadows in the 0--2 DN spike. Those pixels have a
// six-source-pixel feather BEFORE projection; Morning is requested only where an on-screen
// Evening tile has >0.5% black. WAC fills where both lack ground. This mixes Sun directions;
// it is a readable terrain composite, not a photograph of one moment (see imagery credits).
// Tycho's two brightness boxes were reproduced directly in NASA's raw NAC z12--14 tiles:
// they are joins inside that mosaic. We keep a fixed geographic exposure reference rather
// than inventing per-request corrections that would move the joins as tiles load.
// Sharp photos match exposure against a FIXED coarser source and WAC reference.
// The same true-frame reference at every zoom avoids per-tile mean jumps.
// The west-lit seam fix supplies the reference there. Polar and fallback photos add fine detail
// to the existing broad picture. An NAC mosaic replaces TC inside its feathered footprint.
// These choices happen INSIDE photo / photoFix, with no new ImageryLayer or UI switch. Sharp
// requests only start beyond WAC's z8 and never run in start-up's existing south-pole views.
// Close views keep WAC then request the visible target level, deferring intermediate levels
// without discarding them (a later zoom-out can still use them). Requests nearer the screen
// centre get the next server slot; cancelled consumers also leave that priority queue.
// Retained decoded sources, including masks/local rasters, share an LRU budget per worker:
// 128 + 64 + 32 MiB at most. This is a cache limit, not a bound on the whole browser/GPU.
//
// Cesium asks each imagery provider for 256x256 lon/lat tiles of the DISPLAY frame (see frame.ts:
// the true south pole sits on Cesium's equator, so polar tiles are normal squares, not slivers).
// The pictures themselves are in the TRUE Moon frame, so every tile is re-projected pixel by pixel.
// That work (download, decode, re-project) happens in a small pool of Web Workers
// (imageryWorker.ts); the main thread only does cheap checks and hands finished ImageBitmaps to
// Cesium.
//
// - createBaseMosaicProvider:   the whole-Moon photo stored with the app (public/data/base): the
//                               bottom layer, there at once and with no internet
// - createMoonTrekProvider:     NASA Moon Trek global tiles (photo, LOLA colour heights)
// - createPolarRasterProvider:  one local south-polar picture (polar photo, science maps)
// - createPolarPyramidProvider: sharp south-polar photo squares, down to ~1 m/pixel: read from the
//                               copies stored with the app (public/data/polar/t) where they exist,
//                               from ASU Lunaserv elsewhere
//
// Each provider only covers the part of the Moon it has pictures for (its `rectangle`), and tiles
// that turn out to be empty are answered at once with one shared transparent pixel, so the layers
// underneath show through and nothing smeared is ever left on screen.
//
// Where the data ends, loading ends: a tile that could only repeat its parent (the photos have no
// finer detail there), or whose download failed, is answered "keep showing the parent tile"
// (Cesium's tile-discard mechanism), so nothing is requested for it and no hole appears. After a
// failed download the layer asks Cesium to reload its tiles once the network works again (Cesium
// itself never asks twice for a tile it has received).

import { Cartesian2, Cartesian3, Cartographic, Credit, Event, GeographicTilingScheme, Rectangle, RequestState, type Viewer } from 'cesium';
import { MOON_ELLIPSOID } from './ellipsoid';
import {
  FIX_MIN_TRUE_LAT, NORTH_PHOTO_LAT, POLAR_FEATHER_M, POLAR_LIMIT_DEG, PYRAMID_MAX_K, RETRY_MS, TILE, parsePyramidIndex, pixelDeg, pyramidLevelFor, pyramidParentIsEnough,
  pyramidSurelyLocal, tileFixRange, tileTrueLatRange, photoMaxLevel, pixelMetres,
  type BaseCut, type FixParams, type FromWorker, type Job, type PyramidIndex, type Rect, type ToWorker, type ScienceRasterSource,
} from './imageryWorker';
export type { ScienceRasterSource } from './imageryWorker';

// ---------------------------------------------------------------------------------------------
// Worker pool. Worker 0 does every polar-raster job, so each big raster is decoded and held
// once. Tiled sources are pinned to one of the other workers, so every source tile is downloaded
// and cached exactly once: all Moon Trek layers share one worker (so its download limit covers
// the whole trek.nasa.gov server), the polar pyramid has its own.
// The science maps use one further worker and a separate memory budget, so preparing them
// never makes the local Moon photo lose its decoded source.

const RASTER_QUEUE = 48; // jobs waiting per worker before we tell Cesium "busy, ask again" (CPU only, fast)
const TILED_QUEUE = 24; // tiled workers wait on the network, so keep their queues short and fresh
const LOCAL_QUEUE = 64; // tiles drawn from files stored with the app: fast, never held back behind slow downloads

// Reloading tiles that were drawn with holes.
const RELOAD_AFTER_GAPS_MS = RETRY_MS + 5_000; // by then the worker really tries the failed downloads again
const RELOAD_AFTER_RECOVERY_MS = 1_500; // a failing server answers again, or the browser is back online
const RELOAD_MIN_SPACING_MS = 30_000; // at most one reload per layer this often...
const RELOAD_MAX_SPACING_MS = 10 * 60_000; // ...doubling up to this while downloads keep failing

/**
 * Raised after a layer asked the globe to reload tiles that had holes. With requestRenderMode
 * the scene only starts loading them on its next frame, so the map view can listen and call
 * scene.requestRender().
 */
export const imageryReloaded = new Event();

function onePixel(): ImageBitmap {
  const c = new OffscreenCanvas(1, 1);
  c.getContext('2d');
  return c.transferToImageBitmap();
}

/** One fully transparent pixel, shared by every empty tile. */
let blank: ImageBitmap | undefined;
const blankTile = () => (blank ??= onePixel());

/**
 * The answer "nothing new here: keep showing the parent tile". Cesium asks every provider's
 * tileDiscardPolicy about each picture it receives; ours recognises this one, so the tile is
 * marked as not available and its parent's picture stays on screen (stretched by the GPU).
 */
let parentMark: ImageBitmap | undefined;
const parentMarkBitmap = () => (parentMark ??= onePixel());
const discardPolicy = { isReady: () => true, shouldDiscardImage: (image: unknown) => image !== undefined && image === parentMark };

/**
 * WebGL is meant to ignore UNPACK_FLIP_Y for ImageBitmaps; Cesium relies on that (its own tile
 * bitmaps are created pre-flipped) and so do we. Check once in this browser by uploading a 1x2
 * bitmap, so tiles can never come out upside down. Resolves true if the browser DOES flip.
 */
async function detectBitmapFlip(): Promise<boolean> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const gl = canvas.getContext('webgl', { antialias: false, depth: false, stencil: false });
    if (!gl) return false;
    const bmp = await createImageBitmap(new ImageData(new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]), 1, 2), { premultiplyAlpha: 'none' });
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer());
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // texture row 0
    bmp.close();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return px[2] > px[0]; // row 0 is the bitmap's bottom (blue) row: this browser flipped it
  } catch {
    return false; // assume the standard behaviour
  }
}

class ImageryWorkers {
  private readonly workers: (Worker | null)[] = [];
  private readonly busy: number[] = [];
  private readonly local: number[] = []; // jobs in flight that need no download from a remote server
  private readonly jobs = new Map<number, { worker: number; owner: ReprojectedImageryProvider; done: (b: ImageBitmap) => void; reject: (reason: Error) => void; request?: ImageryRequest; at: number; kind: string; local: boolean; rect: Rect }>();
  /**
   * Counters for the loading screen and for tests. parents = tiles answered "keep the parent";
   * deepest = finest tile level asked of the workers per kind of layer; files/remote/failed =
   * downloads by the workers (files stored with the app / remote servers / failed).
   */
  readonly stats = { asked: 0, answered: 0, refused: 0, deferred: 0, cancelled: 0, parents: 0, slowestMs: 0, lastMs: 0, totalMs: 0, files: 0, remote: 0, failed: 0, decodedBytes: 0, decodedImages: 0, science: null as unknown, caches: [] as NonNullable<FromWorker['cache']>[], deepest: {} as Record<string, number>, traffic: {} as NonNullable<FromWorker['traffic']> };
  private readonly net: [number, number, number][] = [];
  private readonly traffic: NonNullable<FromWorker['traffic']>[] = [];
  private readonly flip = detectBitmapFlip();
  private readonly routes = new Map<string, number>();
  /** Layers that drew tiles with holes and are waiting to reload them. */
  private readonly gapped = new Set<ReprojectedImageryProvider>();
  private nextId = 1;
  private readonly scienceWarm = new Map<number, { resolve: (ok: boolean) => void; progress?: (frac: number) => void }>();
  private readonly scienceValues = new Map<number, (value: number | null) => void>();
  private readonly scienceControls = new Map<number, (value: unknown) => void>();
  readonly tiledCount: number;
  readonly scienceWorker: number;

  constructor() {
    const cores = navigator.hardwareConcurrency || 4;
    this.tiledCount = cores >= 4 ? 2 : 1; // Moon Trek and the pyramid, plus the raster worker
    this.scienceWorker = this.tiledCount + 1;
    for (let i = 0; i <= this.scienceWorker; i++) {
      const w = new Worker(new URL('./imageryWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<FromWorker>) => this.finish(e.data, i);
      w.onerror = e => this.fail(i, e);
      this.workers.push(w);
      this.busy.push(0);
      this.local.push(0);
      this.net.push([0, 0, 0]);
      // Science maps have their own worker so keeping them ready cannot evict the Moon photo.
      w.postMessage({ cacheBudgetBytes: (i === this.scienceWorker ? 64 : i === 0 ? 128 : i === 1 ? 64 : 32) * 2 ** 20 } satisfies ToWorker);
    }
    addEventListener('online', () => {
      const msg: ToWorker = { forgetFailures: true };
      for (const w of this.workers) w?.postMessage(msg);
      for (const p of this.gapped) p.networkBack();
    });
  }

  /** Worker for a tiled source: the same source always goes to the same worker (so its cache is shared). */
  route(source: string): number {
    let w = this.routes.get(source);
    if (w === undefined) this.routes.set(source, w = 1 + (this.routes.size % this.tiledCount));
    return w;
  }

  /**
   * Run a job, or return undefined when that worker already has a full queue (Cesium retries next
   * frame). `local` = the job needs no remote download: those have their own, longer queue so
   * they are never stuck behind tiles that wait for a slow server.
   */
  run(worker: number, job: Job, owner: ReprojectedImageryProvider, local = false, request?: ImageryRequest): Promise<ImageBitmap> | undefined {
    const w = this.workers[worker];
    if (!w) return Promise.resolve(blankTile());
    const count = local ? this.local : this.busy;
    if (count[worker] >= (local ? LOCAL_QUEUE : worker === 0 ? RASTER_QUEUE : TILED_QUEUE)) { this.stats.refused++; return undefined; }
    count[worker]++;
    this.stats.asked++;
    this.stats.deepest[job.kind] = Math.max(this.stats.deepest[job.kind] ?? 0, job.level);
    const id = this.nextId++;
    return new Promise((done, reject) => {
      this.jobs.set(id, { worker, owner, done, reject, request, at: performance.now(), kind: job.kind, local, rect: job.rect });
      if (request) {
        const previous = request.cancelFunction;
        request.cancelFunction = () => { previous?.(); this.cancel(id); };
        // A custom provider does not enter Cesium's URL scheduler, which normally calls
        // cancelFunction. Honour an explicit cancel immediately here too.
        const cancel = request.cancel;
        if (cancel) request.cancel = () => { cancel.call(request); this.cancel(id); };
        if (request.cancelled) this.cancel(id);
      }
      void this.flip.then(flipRows => { if (this.jobs.has(id)) { const msg: ToWorker = { id, job, flipRows }; w.postMessage(msg); } });
    });
  }

  private cancel(id: number) {
    const j = this.jobs.get(id);
    if (!j) return;
    this.jobs.delete(id);
    (j.local ? this.local : this.busy)[j.worker]--;
    this.stats.cancelled++;
    this.workers[j.worker]?.postMessage({ cancel: id } satisfies ToWorker);
    if (j.request) {
      // Cesium then returns this tile to UNLOADED, ready to try when it is seen again.
      j.request.state = RequestState.CANCELLED;
      j.reject(new DOMException('Tile left the view', 'AbortError'));
    } else j.done(parentMarkBitmap());
  }

  cancelOutside(rectangles: readonly Rect[]) {
    const now = performance.now();
    for (const [id, j] of this.jobs) {
      if (j.kind !== 'photo' || now - j.at < 350) continue;
      if (!rectangles.some(r => rectanglesOverlap(j.rect, r))) this.cancel(id);
    }
  }

  /** Tell one worker something that is not a tile job (e.g. which pyramid squares are stored with the app). */
  tell(worker: number, msg: ToWorker) { this.workers[worker]?.postMessage(msg); }

  warmScience(sources: ScienceRasterSource[], progress?: (frac: number) => void): Promise<boolean> {
    if (!this.workers[this.scienceWorker]) return Promise.resolve(false);
    const warmId = this.nextId++;
    return new Promise(resolve => {
      this.scienceWarm.set(warmId, { resolve, progress });
      this.tell(this.scienceWorker, { warmScience: sources, warmId });
    });
  }

  scienceValue(source: ScienceRasterSource, lat: number, lon: number): Promise<number | null> {
    if (!this.workers[this.scienceWorker]) return Promise.resolve(null);
    const valueId = this.nextId++;
    return new Promise(resolve => {
      this.scienceValues.set(valueId, resolve);
      this.tell(this.scienceWorker, { scienceValue: { source, lat, lon }, valueId });
    });
  }

  scienceState(activeUrls: string[]) { this.tell(this.scienceWorker, { scienceState: { activeUrls } }); }

  disposeScience() {
    this.workers[this.scienceWorker]?.terminate(); this.workers[this.scienceWorker] = null;
    for (const [id, job] of this.jobs) if (job.worker === this.scienceWorker) { this.jobs.delete(id); job.done(parentMarkBitmap()); }
    this.busy[this.scienceWorker] = this.local[this.scienceWorker] = 0;
    for (const job of this.scienceWarm.values()) job.resolve(false);
    for (const resolve of this.scienceValues.values()) resolve(null);
    for (const resolve of this.scienceControls.values()) resolve(null);
    this.scienceWarm.clear(); this.scienceValues.clear(); this.scienceControls.clear(); this.stats.science = null;
  }

  scienceControl(trim?: { dropAll?: boolean; dropCompressed?: boolean }): Promise<unknown> {
    if (!this.workers[this.scienceWorker]) return Promise.resolve(null);
    const requestId = this.nextId++;
    return new Promise(resolve => {
      this.scienceControls.set(requestId, resolve);
      this.tell(this.scienceWorker, trim ? { scienceTrim: trim, scienceRequestId: requestId } : { scienceStats: { requestId } });
    });
  }

  private finish({ id, bitmap, gaps, recovered, parent, net, traffic, cache, warmed, warmFrac, warmOk, valueId, value, science, scienceRequestId, scienceReady }: FromWorker, worker: number) {
    if (science) this.stats.science = science;
    if (scienceReady) invalidateScienceSource(scienceReady);
    if (scienceRequestId !== undefined) {
      this.scienceControls.get(scienceRequestId)?.(science ?? null);
      this.scienceControls.delete(scienceRequestId);
    }
    if (cache) {
      this.stats.caches[worker] = cache;
      this.stats.decodedBytes = this.stats.caches.reduce((n, c) => n + (c?.retainedBytes ?? 0), 0);
      this.stats.decodedImages = this.stats.caches.reduce((n, c) => n + (c?.retainedCount ?? 0), 0);
    }
    if (warmed !== undefined) {
      const job = this.scienceWarm.get(warmed);
      job?.progress?.(warmFrac ?? 0);
      if (warmFrac === 1) { this.scienceWarm.delete(warmed); job?.resolve(warmOk !== false); }
      return;
    }
    if (valueId !== undefined) { this.scienceValues.get(valueId)?.(value ?? null); this.scienceValues.delete(valueId); return; }
    if (traffic) {
      this.traffic[worker] = traffic;
      const totals: NonNullable<FromWorker['traffic']> = {};
      for (const record of this.traffic) if (record) for (const [site, t] of Object.entries(record)) {
        const s = totals[site] ??= { requests: 0, bytes: 0 }; s.requests += t.requests; s.bytes += t.bytes;
      }
      this.stats.traffic = totals;
    }
    if (recovered) for (const p of this.gapped) if (p.worker === worker) p.networkBack();
    if (net) {
      this.net[worker] = net;
      this.stats.files = this.stats.remote = this.stats.failed = 0;
      for (const n of this.net) { this.stats.files += n[0]; this.stats.remote += n[1]; this.stats.failed += n[2]; }
    }
    const j = this.jobs.get(id);
    if (!j) { bitmap?.close(); return; }
    this.jobs.delete(id);
    (j.local ? this.local : this.busy)[j.worker]--;
    const ms = performance.now() - j.at;
    this.stats.answered++; this.stats.lastMs = ms; this.stats.totalMs += ms; this.stats.slowestMs = Math.max(this.stats.slowestMs, ms);
    if (gaps) {
      this.gapped.add(j.owner); j.owner.noteGaps();
      if (j.kind === 'base') baseBroke();
      // Failed final tiles walk down their ancestor chain. Let that walk finish, too:
      // deferring an intermediate ancestor offline would keep tilesLoaded false forever.
      if (j.kind === 'photo') photoGateBackoffUntil = performance.now() + RETRY_MS;
    }
    if (parent) this.stats.parents++;
    j.done(parent ? parentMarkBitmap() : bitmap ?? blankTile());
  }

  /** Jobs handed to the workers and not answered yet. */
  pending(includeBackground = true): number {
    if (includeBackground) return this.jobs.size;
    let count = 0;
    for (const job of this.jobs.values()) if (!job.request?.background) count++;
    return count;
  }

  pendingPhotos(): number { let n = 0; for (const j of this.jobs.values()) if (j.kind === 'photo') n++; return n; }

  /** For tests: what is waiting, per kind of job, and for how long (ms). */
  waiting(): { kind: string; worker: number; ms: number; background: boolean }[] {
    const now = performance.now();
    return [...this.jobs.values()].map(j => ({ kind: j.kind, worker: j.worker, ms: Math.round(now - j.at), background: !!j.request?.background }));
  }

  /** A layer has reloaded its tiles. */
  settled(p: ReprojectedImageryProvider) { this.gapped.delete(p); }

  /** A worker that crashed or could not start: its tiles (and later ones) come back transparent. */
  private fail(worker: number, e: ErrorEvent) {
    console.error('Imagery worker stopped:', e.message);
    this.workers[worker]?.terminate();
    this.workers[worker] = null;
    for (const [id, j] of this.jobs) if (j.worker === worker) { this.jobs.delete(id); j.done(blankTile()); }
    this.busy[worker] = this.local[worker] = 0;
  }
}

let pool: ImageryWorkers | undefined;
const workers = () => (pool ??= new ImageryWorkers());

/** Rectangles here are ordinary display-grid tiles; none crosses the date line. */
const rectanglesOverlap = (a: Rect, b: Rect) => a.west < b.east && a.east > b.west && a.south < b.north && a.north > b.south;

interface PhotoView {
  lon: number; lat: number; level: number;
  cameraLon: number; cameraLat: number; groundHeight: number;
  camera: Cartesian3; metresPerDistance: number; changedAt: number;
}
let photoView: PhotoView | undefined;
let savedPreloads: { viewer: Viewer; ancestors: boolean; siblings: boolean } | undefined;
let photoGateBackoffUntil = 0;
const deferredPhotos = new Map<string, { rect: Rect; level: number; at: number }>();
const admittedPhotos = new Set<string>();
const viewTiling = new GeographicTilingScheme({ ellipsoid: MOON_ELLIPSOID });
const viewPixel = new Cartesian2(), viewHit = new Cartesian3(), viewCartographic = new Cartographic(), distancePoint = new Cartesian3();
const photoKey = (r: Rect, level: number) => `${level}/${r.west}/${r.south}`;
const clampValue = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const levelAtSpacing = (metres: number) => clampValue(Math.round(Math.log2(pixelMetres(0) / Math.max(0.001, metres))), 8, 17);

/** Estimate the photo pixels actually needed by this camera, rather than visiting every
 * intermediate resolution on the way down. All coordinates here use Cesium's display frame. */
function updatePhotoView(viewer: Viewer) {
  const { scene, camera } = viewer, globe = scene.globe;
  const frustum = camera.frustum as { fovy?: number; fov?: number };
  const fovy = frustum.fovy ?? frustum.fov;
  if (!fovy || !scene.drawingBufferHeight) return;
  viewPixel.x = scene.canvas.clientWidth / 2; viewPixel.y = scene.canvas.clientHeight / 2;
  const ray = camera.getPickRay(viewPixel), hit = ray && globe.pick(ray, scene, viewHit);
  const cameraLL = camera.positionCartographic;
  let lon = cameraLL.longitude, lat = cameraLL.latitude;
  let groundHeight = globe.getHeight(cameraLL) ?? 0;
  let distance = Math.max(1, Math.abs(cameraLL.height - groundHeight));
  if (hit) {
    const at = MOON_ELLIPSOID.cartesianToCartographic(hit, viewCartographic);
    if (at) { lon = at.longitude; lat = at.latitude; groundHeight = at.height; }
    distance = Math.max(1, Cartesian3.distance(camera.positionWC, hit));
  }
  const metresPerDistance = 2 * Math.tan(fovy / 2) * globe.maximumScreenSpaceError / scene.drawingBufferHeight;
  let level = levelAtSpacing(distance * metresPerDistance);
  const xy = viewTiling.positionToTileXY(new Cartographic(lon, lat), level);
  if (xy) level = Math.min(level, photoMaxLevel(viewTiling.tileXYToRectangle(xy.x, xy.y, level)));
  const old = photoView, now = performance.now();
  const changed = !old || old.level !== level || Cartesian3.distanceSquared(old.camera, camera.positionWC) > Math.max(1, distance * distance * 0.000001)
    || Math.abs(Math.atan2(Math.sin(lon - old.lon), Math.cos(lon - old.lon))) > pixelDeg(level) * Math.PI / 180
    || Math.abs(lat - old.lat) > pixelDeg(level) * Math.PI / 180;
  photoView = { lon, lat, level, cameraLon: cameraLL.longitude, cameraLat: cameraLL.latitude, groundHeight,
    camera: Cartesian3.clone(camera.positionWC), metresPerDistance, changedAt: changed ? now : old.changedAt };
  if (changed) { deferredPhotos.clear(); admittedPhotos.clear(); }
  pool?.tell(pool.route('trek'), { photoView: { lon, lat, level } });
  if (level > 10) {
    if (!savedPreloads || savedPreloads.viewer !== viewer) savedPreloads = { viewer, ancestors: globe.preloadAncestors, siblings: globe.preloadSiblings };
    // applyQuality can update these while this view is open: remember its new choice.
    else if (globe.preloadAncestors || globe.preloadSiblings) { savedPreloads.ancestors = globe.preloadAncestors; savedPreloads.siblings = globe.preloadSiblings; }
    globe.preloadAncestors = false; globe.preloadSiblings = false;
  } else if (savedPreloads?.viewer === viewer) {
    globe.preloadAncestors = savedPreloads.ancestors; globe.preloadSiblings = savedPreloads.siblings;
    savedPreloads = undefined; deferredPhotos.clear(); admittedPhotos.clear();
  }
}

/** Camera-dependent waits stay UNLOADED in Cesium, so a later zoom-out can request them.
 * A discard marker would make the same useful tile INVALID until it left the cache. */
function deferPhoto(rect: Rect, level: number): boolean {
  const view = photoView;
  if (!view || view.level <= 10 || level <= 8 || performance.now() < photoGateBackoffUntil) return false;
  const key = photoKey(rect, level);
  if (admittedPhotos.has(key)) return false;
  const middle = (rect.west + rect.east) / 2;
  const cameraLon = middle + Math.atan2(Math.sin(view.cameraLon - middle), Math.cos(view.cameraLon - middle));
  const lon = clampValue(cameraLon, rect.west, rect.east), lat = clampValue(view.cameraLat, rect.south, rect.north);
  Cartesian3.fromRadians(lon, lat, view.groundHeight, MOON_ELLIPSOID, distancePoint);
  const distance = Math.max(1, Cartesian3.distance(view.camera, distancePoint));
  const target = Math.min(view.level, photoMaxLevel(rect), levelAtSpacing(distance * view.metresPerDistance));
  if (level >= target) return false;
  if (!deferredPhotos.has(key)) deferredPhotos.set(key, { rect, level, at: performance.now() });
  if (pool) pool.stats.deferred++;
  return true;
}

/**
 * Call after a frame while the camera moves. Cesium keeps old terrain tiles in memory,
 * but only these tiles are on screen: sharp downloads outside them can stop. The short
 * grace period lets the first terrain frame catch up after a camera jump.
 */
export function cancelOffscreenImagery(viewer: Viewer, cull = true) {
  if (!pool || viewer.isDestroyed()) return;
  updatePhotoView(viewer);
  const surface = (viewer.scene.globe as unknown as { _surface?: { _tilesToRender?: { rectangle: Rect; data?: { imagery?: { loadingImagery?: { rectangle: Rect; level: number } }[] } }[] } })._surface;
  const tiles = surface?._tilesToRender;
  if (tiles?.length) {
    if (cull) pool.cancelOutside(tiles.map(tile => tile.rectangle));
    // Perspective views can genuinely need a coarser tile far from the rover. Once finer
    // work is quiet, admit any such tile STILL being rendered. Ancestors alone stay skipped,
    // so their queues cannot keep tilesLoaded false forever. No cache state is invalidated.
    const now = performance.now();
    if (photoView && now - photoView.changedAt > 400 && pool.pendingPhotos() === 0) {
      for (const tile of tiles) for (const link of tile.data?.imagery ?? []) {
        const loading = link.loadingImagery;
        if (!loading?.rectangle) continue;
        const key = photoKey(loading.rectangle, loading.level), deferred = deferredPhotos.get(key);
        if (deferred && now - deferred.at > 400) { admittedPhotos.add(key); deferredPhotos.delete(key); viewer.scene.requestRender(); }
      }
    }
  }
}

/** Include hidden layer preparation for diagnostics, but let preload wait for its visible view alone. */
export function imageryPending(includeBackground = true): number { return pool ? pool.pending(includeBackground) : 0; }

// Small test/debug hook (scripts/drive.mjs): what the imagery workers are doing right now.
(globalThis as { __moondaImagery?: unknown }).__moondaImagery = {
  pending: imageryPending,
  stats: () => (pool ? { ...pool.stats, deepest: { ...pool.stats.deepest } } : null),
  waiting: () => (pool ? pool.waiting() : []),
  view: () => (photoView ? { lon: photoView.lon, lat: photoView.lat, level: photoView.level, deferred: deferredPhotos.size, admitted: admittedPhotos.size } : null),
};

// ---------------------------------------------------------------------------------------------
// The provider object Cesium talks to (the fields of Cesium's ImageryProvider interface).

interface ProviderOptions {
  rectangle: Rectangle;
  maximumLevel: number;
  credit: string;
  worker: number;
  /**
   * The worker job for a display tile; null when this layer has nothing to draw there; 'parent'
   * when the tile could only repeat its parent (the data ends at a coarser level); 'wait' while
   * the layer is not ready to say (Cesium asks again next frame).
   */
  jobFor: (rect: Rect, level: number, x: number, y: number) => Job | null | 'parent' | 'wait';
  /** True for a job that surely needs no remote download (it then never waits behind slow downloads). */
  isLocal?: (job: Job) => boolean;
}

interface ImageryRequest { state?: number; cancelled?: boolean; cancelFunction?: () => void; cancel?: () => void; background?: boolean }

export class ReprojectedImageryProvider {
  readonly tilingScheme = new GeographicTilingScheme({ ellipsoid: MOON_ELLIPSOID }); // DISPLAY lon/lat
  readonly rectangle: Rectangle;
  readonly tileWidth = TILE;
  readonly tileHeight = TILE;
  readonly minimumLevel = 0; // a higher minimum makes the globe wait for thousands of tiles
  readonly maximumLevel: number;
  /** Lets a tile say "keep showing my parent" (see parentMarkBitmap above). */
  readonly tileDiscardPolicy = discardPolicy;
  readonly errorEvent = new Event();
  readonly credit: Credit;
  readonly proxy = undefined;
  readonly hasAlphaChannel = true;
  /** Set by Cesium's globe while the layer is shown: drops the layer's tiles and asks for them again. */
  _reload: (() => void) | undefined = undefined;
  readonly worker: number;
  private readonly jobFor: ProviderOptions['jobFor'];
  private readonly isLocal: ProviderOptions['isLocal'];
  private gaps = false; // some tiles were drawn with holes since the last reload
  private reloadAt = Infinity;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private lastReload = -Infinity;
  private spacing = RELOAD_MIN_SPACING_MS;

  constructor(o: ProviderOptions) {
    this.rectangle = o.rectangle;
    this.maximumLevel = o.maximumLevel;
    this.credit = new Credit(o.credit);
    this.worker = o.worker;
    this.jobFor = o.jobFor;
    this.isLocal = o.isLocal;
  }

  getTileCredits(): Credit[] { return []; }

  requestImage(x: number, y: number, level: number, request?: ImageryRequest): Promise<ImageBitmap> | undefined {
    const r = this.tilingScheme.tileXYToRectangle(x, y, level);
    const job = this.jobFor({ west: r.west, south: r.south, east: r.east, north: r.north }, level, x, y);
    if (job === 'wait') return undefined;
    if (job === 'parent') { workers().stats.parents++; return Promise.resolve(parentMarkBitmap()); }
    if (job?.kind === 'photo' && deferPhoto(job.rect, level)) return undefined;
    return job ? workers().run(this.worker, job, this, this.isLocal?.(job) ?? false, request) : Promise.resolve(blankTile());
  }

  /** Drop this layer's tiles and ask for them again now (used when what the layer should draw has changed). */
  reloadNow() {
    if (!this._reload) return;
    this._reload();
    imageryReloaded.raiseEvent();
  }

  pickFeatures(): undefined { return undefined; }

  /** A tile came back with holes (a download failed): reload once the worker will really try again. */
  noteGaps() {
    this.gaps = true;
    this.scheduleReload(RELOAD_AFTER_GAPS_MS);
  }

  /** The network works again: reload soon if this layer has holes. */
  networkBack() {
    if (this.gaps) this.scheduleReload(RELOAD_AFTER_RECOVERY_MS);
  }

  private scheduleReload(delay: number) {
    const now = performance.now(), at = Math.max(now + delay, this.lastReload + this.spacing);
    if (at >= this.reloadAt) return; // an earlier reload is already planned
    clearTimeout(this.reloadTimer);
    this.reloadAt = at;
    this.reloadTimer = setTimeout(() => this.reload(), at - now);
  }

  private reload() {
    const now = performance.now();
    this.reloadTimer = undefined;
    this.reloadAt = Infinity;
    // Calm since the last reload: start again from the shortest spacing. Holes again soon after
    // (the network is still bad): wait twice as long before the next try.
    this.spacing = now - this.lastReload > 4 * this.spacing ? RELOAD_MIN_SPACING_MS : Math.min(2 * this.spacing, RELOAD_MAX_SPACING_MS);
    this.lastReload = now;
    this.gaps = false;
    workers().settled(this);
    if (!this._reload) return; // hidden: the layer asks for fresh tiles anyway when it is shown again
    this._reload(); // Cesium keeps showing the old tiles until the new ones are ready
    imageryReloaded.raiseEvent();
  }
}

/**
 * Display-frame box around the true south-polar cap south of `clipDeg`. The cap is centred on
 * display 0°N 90°E, so a cap of angular radius r spans ±r in display lat and 90°±r in display lon.
 * A little extra (0.2°) keeps the soft edge pixels inside. For the default clip this is true lat < -79.8°.
 */
function polarRectangle(clipDeg: number): Rectangle {
  const r = Math.min(90, 90 + clipDeg + 0.2);
  return Rectangle.fromDegrees(90 - r, -r, 90 + r, r);
}

// ---------------------------------------------------------------------------------------------
// The whole-Moon photo stored with the app (made by data-prep/base_mosaic.py from the same Moon
// Trek WAC mosaic the 'photo' layer streams). Its pictures are already drawn in the display frame,
// so a tile is simply cut out of them.

/** One picture of base.json, in units of its own tiles: where it starts on the tile grid of its level and how many tiles it holds. */
interface BasePicture { url: string; level: number; ox: number; oy: number; cols: number; rows: number; mips: number; poleAware: boolean }
interface BaseSet { state: 'loading' | 'ready' | 'failed'; global?: BasePicture; quick?: BasePicture; south?: BasePicture; north?: BasePicture; fix?: FixParams }
let baseSet: BaseSet | undefined;
/** Moon Trek layers that leave the levels the local picture already shows to it. */
const overBase = new Set<ReprojectedImageryProvider>();

/** The local picture cannot be used after all (file missing or unreadable): the Moon Trek photo takes over its levels. */
function baseBroke() {
  if (!baseSet || baseSet.state === 'failed') return;
  baseSet.state = 'failed';
  for (const p of overBase) p.reloadNow();
}

function basePictureOf(folder: string, m: unknown, mips: (level: number) => number): BasePicture | undefined {
  const p = m as { file?: unknown; width?: unknown; height?: unknown; west?: unknown; north?: unknown; level?: unknown; poleAware?: unknown } | undefined;
  if (!p || typeof p.file !== 'string' || typeof p.width !== 'number' || typeof p.height !== 'number' || typeof p.west !== 'number' || typeof p.north !== 'number' || typeof p.level !== 'number') return undefined;
  const t = 180 / 2 ** p.level, pic = { url: new URL(p.file, folder).href, level: p.level, ox: (p.west + 180) / t, oy: (90 - p.north) / t, cols: p.width / TILE, rows: p.height / TILE, mips: Math.max(0, mips(p.level)), poleAware: p.poleAware === true };
  return [pic.ox, pic.oy, pic.cols, pic.rows, pic.level].every(Number.isInteger) ? pic : undefined; // must sit exactly on the tile grid
}

/** Where display tile x, y of `level` sits inside a local picture, or null if the picture does not hold it. */
function baseCut(p: BasePicture | undefined, x: number, y: number, level: number): BaseCut | null {
  if (!p || level > p.level) return null;
  const mip = p.level - level, f = 2 ** mip;
  if (p.ox % f || p.oy % f) return null;
  const tx = x - p.ox / f, ty = y - p.oy / f;
  if (tx < 0 || ty < 0 || (tx + 1) * f > p.cols || (ty + 1) * f > p.rows) return null;
  return { url: p.url, mip, px: tx * TILE, py: ty * TILE, mips: p.mips, poleAware: p.poleAware };
}

/** The picture of the local set that draws this tile: the whole-Moon one up to its level, the sharper polar ones beyond. */
const baseCutFor = (b: BaseSet, x: number, y: number, level: number) =>
  b.global && level <= b.global.level ? baseCut(b.global, x, y, level) : baseCut(b.south, x, y, level) ?? baseCut(b.north, x, y, level);

/** The seam-fix settings of base.json (v5), with the albedo picture's URL resolved, or undefined. */
function fixOf(folder: string, m: unknown): FixParams | undefined {
  const f = m as { albedo?: Record<string, unknown>; C?: unknown; S0?: unknown; hillshade?: Record<string, unknown> } | undefined;
  const a = f?.albedo, h = f?.hillshade;
  if (!a || !h || typeof a.file !== 'string' || typeof f.C !== 'number' || typeof f.S0 !== 'number') return undefined;
  const num = (v: unknown) => (typeof v === 'number' ? v : NaN);
  const fix: FixParams = {
    albedo: { url: new URL(a.file, folder).href, west: num(a.west), east: num(a.east), north: num(a.north), south: num(a.south), scale: num(a.scale) },
    C: f.C, S0: f.S0, near: String(h.near), far: String(h.far), nearMaxLat: num(h.nearMaxLat),
  };
  return Object.values(fix.albedo).every(v => typeof v === 'string' || Number.isFinite(v)) && Number.isFinite(fix.nearMaxLat) ? fix : undefined;
}

/**
 * The whole-Moon photo stored with the app, as the bottom layer: on screen at once, sharp for the
 * opening view and the "South Pole" view, and still there with no internet. `url` is the folder
 * that holds base.json (default ./data/base/), written by data-prep/base_mosaic.py:
 *   moon8k.jpg  whole Moon, display tile levels 0-4 (1.3 km per pixel)
 *   moon2k.jpg  the same, small: drawn first while the big one is decoded
 *   south6.jpg  within 33.75 degrees of the south pole at level 6 (333 m per pixel), if present
 * Deeper tiles are answered "keep the parent", so the layer never asks for more than it has.
 * Give the layer the same show/alpha as the Moon Trek 'photo' layer above it.
 */
export function createBaseMosaicProvider(o: { url?: string; credit: string }): ReprojectedImageryProvider {
  const folder = new URL(o.url ?? './data/base/', document.baseURI).href.replace(/\/?$/, '/');
  const set: BaseSet = (baseSet = { state: 'loading' });
  void fetch(`${folder}base.json`).then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then((m: { pictures?: Record<string, unknown>; fix?: unknown }) => {
    set.global = basePictureOf(folder, m.pictures?.global, level => level);
    set.quick = basePictureOf(folder, m.pictures?.quick, level => level);
    // the south picture only draws the levels the whole-Moon picture does not reach
    set.south = set.global && basePictureOf(folder, m.pictures?.south, level => level - set.global!.level - 1);
    set.north = set.global && basePictureOf(folder, m.pictures?.north, level => level - set.global!.level - 1);
    set.fix = fixOf(folder, (m as { fix?: unknown }).fix);
    set.state = set.global ? 'ready' : 'failed';
  }).catch((e: unknown) => { console.warn('Local Moon picture not available:', e); set.state = 'failed'; });
  return new ReprojectedImageryProvider({
    rectangle: Rectangle.clone(Rectangle.MAX_VALUE),
    maximumLevel: 6,
    credit: o.credit,
    worker: 0,
    isLocal: () => true,
    jobFor: (rect, level, x, y) => {
      if (set.state === 'loading') return 'wait';
      if (set.state === 'failed') return null;
      const cut = baseCutFor(set, x, y, level);
      if (!cut) return 'parent'; // deeper than the picture: the parent tile already shows all there is
      return { kind: 'base', rect, level, cut, quick: (cut.url === set.global?.url && baseCut(set.quick, x, y, level)) || undefined };
    },
  });
}

/**
 * NASA Moon Trek global tiles (true lon/lat WMTS), re-projected into display tiles. Pixels south
 * of `minTrueLat` stay transparent so the polar layers show there instead. Display levels go one
 * past `maxSourceLevel` so the deepest tiles are drawn straight from the source at 2x, not
 * re-sampled twice.
 *
 * `overBase` (for the photo that the local whole-Moon picture is made from): the levels that
 * picture already shows are left to it (transparent here), so the opening view and the "South
 * Pole" view need nothing from the internet. Needs a createBaseMosaicProvider layer underneath;
 * without one, or if its files are missing, every level is streamed as before.
 */
export function createMoonTrekProvider(o: { layer: string; ext: string; maxSourceLevel: number; minTrueLat?: number; credit: string; overBase?: boolean; sharpPhoto?: boolean; cachePrepared?: boolean }): ReprojectedImageryProvider {
  const minTrueLat = o.minTrueLat ?? -90;
  const Provider = o.cachePrepared ? PreparedLayerProvider : ReprojectedImageryProvider;
  const p: ReprojectedImageryProvider = new Provider({
    rectangle: Rectangle.clone(Rectangle.MAX_VALUE),
    maximumLevel: o.sharpPhoto ? 17 : o.maxSourceLevel + 1,
    credit: o.credit,
    worker: workers().route('trek'),
    jobFor: (rect, level, x, y) => {
      let northBase: Extract<Job, { kind: 'photo' }>['northBase'];
      if (o.overBase && baseSet) {
        if (baseSet.state === 'loading') return 'wait';
        if (baseSet.state === 'ready' && baseCutFor(baseSet, x, y, level)) return null; // the local picture underneath shows exactly this
        if (baseSet.state === 'ready' && baseSet.fix && seamFixOn && tileFixRange(rect).min >= 1
          && !(o.sharpPhoto && level > 8 && tileTrueLatRange(rect).minDeg > NORTH_PHOTO_LAT)) return null; // the north worker's local reference already includes the fix
        if (o.sharpPhoto && level > 8 && tileTrueLatRange(rect).minDeg > NORTH_PHOTO_LAT) {
          const scale = 2 ** Math.max(0, level - 6), px = Math.floor(x / scale), py = Math.floor(y / scale);
          const cut = baseCutFor(baseSet, px, py, 6);
          if (cut) {
            const r = p.tilingScheme.tileXYToRectangle(px, py, 6);
            northBase = { cut, rect: { west: r.west, east: r.east, south: r.south, north: r.north } };
          }
        }
      }
      return minTrueLat > -90 && tileTrueLatRange(rect).maxDeg < minTrueLat - pixelDeg(level)
        ? null // tile lies wholly inside the polar cap
        : o.sharpPhoto && level > photoMaxLevel(rect) ? 'parent'
        : o.sharpPhoto && level > 8 ? { kind: 'photo', rect, level, layer: o.layer, minTrueLat, northBase }
        : { kind: 'trek', rect, level, layer: o.layer, ext: o.ext, maxSourceLevel: o.maxSourceLevel, minTrueLat };
    },
  });
  if (o.overBase) overBase.add(p);
  return p;
}

/** False once the seam-fix layer is known to be missing (then the photo must draw everywhere). */
let seamFixOn = false;

/**
 * The seam fix above the Moon Trek photo (v5). NASA's WAC global mosaic is lit from the east in true
 * lon -180..-90 and from the west everywhere else, so it shows two straight lighting flips (at -90 and
 * 180). This layer draws albedo x hillshade there (lit from the west like the rest), see-through where
 * the photo is right and cross-fading over -90..-80 and 165..180. The settings come from base.json
 * (data-prep/base_mosaic.py bakes the same picture into the local whole-Moon set, so this layer only
 * draws levels deeper than that set). Needs a createBaseMosaicProvider layer (v5 folder) underneath and
 * the photo layer below it; give it the same show/alpha as the photo.
 */
export function createSeamFixProvider(o: { credit: string }): ReprojectedImageryProvider {
  seamFixOn = true;
  return new ReprojectedImageryProvider({
    rectangle: Rectangle.clone(Rectangle.MAX_VALUE),
    maximumLevel: 17,
    credit: o.credit,
    worker: workers().route('trek'),
    jobFor: (rect, level, x, y) => {
      const b = baseSet;
      if (!b || b.state === 'loading') return 'wait';
      if (b.state === 'failed' || !b.fix) return null;
      if (baseCutFor(b, x, y, level)) return null; // the local pictures already show it
      if (tileTrueLatRange(rect).maxDeg < FIX_MIN_TRUE_LAT - pixelDeg(level)) return null; // inside the south-polar photos
      if (tileFixRange(rect).max <= 0) return null; // the photo is right here
      // The local north-pole picture already includes the seam fix. The photo worker uses
      // that as its brightness reference, avoiding a ring of remote EQ tiles at the pole.
      if (level > 8 && tileTrueLatRange(rect).minDeg > NORTH_PHOTO_LAT) return null;
      if (level > photoMaxLevel(rect)) return 'parent';
      if (level > 8) return { kind: 'photo', rect, level, layer: 'LRO_WAC_Mosaic_Global_303ppd_v02', minTrueLat: FIX_MIN_TRUE_LAT, fix: b.fix };
      return { kind: 'synth', rect, level, fix: b.fix };
    },
  });
}

/**
 * Get south-polar pictures ready before they are shown: the worker downloads (from the browser's cache, start-up put
 * them there) and decodes them now, so the first time a layer is switched on its tiles appear at once.
 */
export function warmPolarRasters(urls: string[]) {
  if (!urls.length) return;
  workers().tell(0, { warmRasters: urls.map(u => new URL(u, document.baseURI).href) });
}

const absoluteScienceSource = (source: ScienceRasterSource): ScienceRasterSource => ({
  ...source, url: new URL(source.url, document.baseURI).href,
  packed: source.packed ? { ...source.packed, url: new URL(source.packed.url, document.baseURI).href } : undefined,
  preview: source.preview ? { ...source.preview, url: new URL(source.preview.url, document.baseURI).href } : undefined,
});

/** Prepare compact bytes and small previews; full-resolution blocks stay on demand. */
export function warmScienceRasters(sources: ScienceRasterSource[], onProgress?: (frac: number) => void): Promise<boolean> {
  const unique = [...new Map(sources.map(s => [new URL(s.url, document.baseURI).href, absoluteScienceSource(s)])).values()];
  return workers().warmScience(unique, onProgress);
}

/** Raw byte under a spot; the left panel applies the product's published scale and offset. */
export function scienceRasterValueAt(source: ScienceRasterSource, lat: number, lon: number): Promise<number | null> {
  return workers().scienceValue(absoluteScienceSource(source), lat, lon);
}

const SCIENCE_TILE_BYTES = TILE * TILE * 4;
const SCIENCE_TILE_BUDGET = 96 * 2 ** 20;
const SCIENCE_IDLE_MS = 5 * 60_000;
interface PreparedScienceTile {
  owner: PreparedLayerProvider; key: string; promise: Promise<ImageBitmap>;
  borrowers: number; removed: boolean; lastUsed: number;
}
const scienceProviders = new Set<PreparedLayerProvider>();
const scienceTiles = new Map<PreparedScienceTile, true>();
const scienceTileStats = { hits: 0, misses: 0, evictions: 0, expired: 0 };
function removeScienceTile(tile: PreparedScienceTile, reason?: 'budget' | 'idle') {
  if (tile.removed) return;
  if (reason === 'budget') scienceTileStats.evictions++;
  if (reason === 'idle') scienceTileStats.expired++;
  tile.removed = true; scienceTiles.delete(tile); tile.owner.forget(tile.key, tile);
  void tile.promise.then(b => { if (!tile.borrowers && b !== blank && b !== parentMark) b.close(); }).catch(() => {});
}
function trimScienceTiles() {
  const now = performance.now();
  for (const tile of scienceTiles.keys()) if (!tile.owner.active && now - tile.lastUsed > SCIENCE_IDLE_MS) removeScienceTile(tile, 'idle');
  while (scienceTiles.size * SCIENCE_TILE_BYTES > SCIENCE_TILE_BUDGET) removeScienceTile(scienceTiles.keys().next().value!, 'budget');
}
const scienceReadyTimers = new Map<string, ReturnType<typeof setTimeout>>();
function invalidateScienceSource(url: string) {
  if (scienceReadyTimers.has(url)) return;
  scienceReadyTimers.set(url, setTimeout(() => {
    scienceReadyTimers.delete(url);
    for (const p of scienceProviders) if (p.active && p.sourceUrls.has(url)) p.reloadNow();
  }, 100));
}

/** Share a bounded cache across maps so a quick off/on keeps the same projected pixels. */
class PreparedLayerProvider extends ReprojectedImageryProvider {
  private readonly prepared = new Map<string, PreparedScienceTile>();
  readonly sourceUrls: Set<string>;
  active = false;

  constructor(o: ProviderOptions, sources: ScienceRasterSource[] = []) {
    super(o); this.sourceUrls = new Set(sources.map(s => s.url)); scienceProviders.add(this);
  }

  forget(key: string, tile: PreparedScienceTile) { if (this.prepared.get(key) === tile) this.prepared.delete(key); }
  clearPrepared() { for (const tile of [...this.prepared.values()]) removeScienceTile(tile); }

  override requestImage(x: number, y: number, level: number, request?: ImageryRequest): Promise<ImageBitmap> | undefined {
    const key = `${level}/${x}/${y}`;
    let tile = this.prepared.get(key);
    if (!tile) {
      scienceTileStats.misses++;
      const got = super.requestImage(x, y, level, request);
      if (!got) return undefined;
      tile = { owner: this, key, promise: got, borrowers: 0, removed: false, lastUsed: performance.now() };
      this.prepared.set(key, tile); scienceTiles.set(tile, true);
      const fresh = tile;
      // Empty coverage is already answered for free. Keep the budget for real layer pixels.
      void got.then(bitmap => { if (bitmap === blank || bitmap === parentMark) removeScienceTile(fresh); }, () => removeScienceTile(fresh));
    } else { scienceTileStats.hits++; tile.lastUsed = performance.now(); scienceTiles.delete(tile); scienceTiles.set(tile, true); }
    const borrowed = tile; borrowed.borrowers++;
    trimScienceTiles();
    return borrowed.promise.then(b => b === parentMark ? b : createImageBitmap(b)).finally(() => {
      borrowed.borrowers--;
      if (borrowed.removed && !borrowed.borrowers) void borrowed.promise.then(b => { if (b !== blank && b !== parentMark) b.close(); }).catch(() => {});
    });
  }

  override noteGaps() { this.clearPrepared(); super.noteGaps(); }
  override reloadNow() { this.clearPrepared(); super.reloadNow(); }
}

/** Prepare real projected tiles without exposing a hidden layer or changing its switches. */
export async function warmScienceProviderTiles(provider: ReprojectedImageryProvider, tiles: readonly { x: number; y: number; level: number }[], maxMs = 1500): Promise<boolean> {
  if (!(provider instanceof PreparedLayerProvider)) return false;
  const deadline = performance.now() + maxMs, seen = new Set<string>();
  for (const tile of tiles) {
    const key = `${tile.level}/${tile.x}/${tile.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let pending: Promise<ImageBitmap> | undefined;
    while (performance.now() < deadline && !(pending = provider.requestImage(tile.x, tile.y, tile.level, { background: true }))) await new Promise<void>(resolve => setTimeout(resolve, 16));
    if (!pending) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const complete = await Promise.race([
      pending.then(bitmap => { if (bitmap !== blank && bitmap !== parentMark) bitmap.close(); return true; }, () => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - performance.now())); }),
    ]);
    clearTimeout(timer);
    if (!complete) return false;
  }
  return true;
}

export interface LayerWarmView { rectangle: Rectangle; spacing: number }
/** The preload camera moves while files arrive. Keep the opening view's actual tile needs. */
export function captureVisibleLayerTiles(viewer: Viewer): LayerWarmView[] {
  if (viewer.isDestroyed()) return [];
  const visible = (viewer.scene.globe as unknown as { _surface?: { _tilesToRender?: { rectangle: Rectangle; level: number }[] } })._surface?._tilesToRender ?? [];
  return visible.map(tile => ({ rectangle: Rectangle.clone(tile.rectangle), spacing: viewer.terrainProvider.getLevelMaximumGeometricError(tile.level) }));
}

/** Warm the imagery levels Cesium will ask for at this view, including their first parents.
 * The same geometric-error rule is used by Cesium's Geographic imagery providers. */
export async function warmVisibleLayerTiles(viewer: Viewer, providers: readonly ReprojectedImageryProvider[], maxMs = 1500, visible = captureVisibleLayerTiles(viewer)): Promise<boolean> {
  if (viewer.isDestroyed()) return false;
  const cached = providers.filter(p => p instanceof PreparedLayerProvider);
  if (!cached.length) return true;
  if (!visible.length) return false;
  const perProvider = Math.max(2, Math.floor(SCIENCE_TILE_BUDGET / SCIENCE_TILE_BYTES / cached.length));
  let capped = false;
  const lists = cached.map(provider => {
    const tiles = new Map<string, { x: number; y: number; level: number }>(), targets = new Set<string>();
    for (const terrain of visible) {
      const rect = Rectangle.intersection(terrain.rectangle, provider.rectangle);
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      const spacing = terrain.spacing;
      const zeroSpacing = MOON_ELLIPSOID.maximumRadius * provider.tilingScheme.rectangle.width / (provider.tileWidth * provider.tilingScheme.getNumberOfXTilesAtLevel(0));
      const level = Math.max(0, Math.min(provider.maximumLevel, Math.round(Math.log2(zeroSpacing / spacing))));
      // Insetting avoids warming a neighbour that only touches the terrain tile's edge.
      const dx = rect.width / 512, dy = rect.height / 512;
      const nw = provider.tilingScheme.positionToTileXY(new Cartographic(rect.west + dx, rect.north - dy), level);
      const se = provider.tilingScheme.positionToTileXY(new Cartographic(rect.east - dx, rect.south + dy), level);
      if (!nw || !se) continue;
      for (let y = nw.y; y <= se.y && tiles.size < SCIENCE_TILE_BUDGET / SCIENCE_TILE_BYTES; y++) for (let x = nw.x; x <= se.x && tiles.size < SCIENCE_TILE_BUDGET / SCIENCE_TILE_BYTES; x++) {
        targets.add(`${level}/${x}/${y}`);
        for (let parent = 0; parent <= level; parent++) {
          const scale = 2 ** (level - parent), px = Math.floor(x / scale), py = Math.floor(y / scale);
          tiles.set(`${parent}/${px}/${py}`, { x: px, y: py, level: parent });
        }
      }
    }
    const rank = (tile: { x: number; y: number; level: number }) => tile.level < 2 ? 0 : targets.has(`${tile.level}/${tile.x}/${tile.y}`) ? 1 : 2;
    const ordered = [...tiles.values()].sort((a, b) => rank(a) - rank(b) || a.level - b.level);
    if (ordered.length > perProvider || tiles.size >= SCIENCE_TILE_BUDGET / SCIENCE_TILE_BYTES) capped = true;
    // Share the budget fairly; a close view must not evict every other switch's roots.
    return ordered.slice(0, perProvider);
  });
  const warmed = await Promise.all(cached.map((provider, i) => warmScienceProviderTiles(provider, lists[i], maxMs)));
  return !capped && warmed.every(Boolean);
}

/** Only visible or recently used science blocks need decoded memory. */
export function setScienceLayersActive(sources: ScienceRasterSource[]) {
  const urls = new Set(sources.map(s => new URL(s.url, document.baseURI).href));
  for (const p of scienceProviders) p.active = [...p.sourceUrls].some(url => urls.has(url));
  workers().scienceState([...urls]); trimScienceTiles();
}

export function releaseScienceLayers() {
  for (const p of scienceProviders) p.clearPrepared();
  scienceProviders.clear(); pool?.scienceState([]);
}

const scienceTileSweep = setInterval(trimScienceTiles, 20_000);
import.meta.hot?.dispose(() => {
  clearInterval(scienceTileSweep);
  for (const timer of scienceReadyTimers.values()) clearTimeout(timer);
  scienceReadyTimers.clear(); releaseScienceLayers(); pool?.disposeScience();
});
const scienceMemory = () => ({ worker: pool?.stats.science ?? null, preparedBitmapBytes: scienceTiles.size * SCIENCE_TILE_BYTES, preparedBitmapBudget: SCIENCE_TILE_BUDGET, preparedCache: { ...scienceTileStats }, preparedIdleMs: SCIENCE_IDLE_MS });
(globalThis as unknown as { __moondaScienceMemory: unknown }).__moondaScienceMemory = scienceMemory;
(globalThis as unknown as { __moondaScienceSnapshot: unknown }).__moondaScienceSnapshot = async () => { await workers().scienceControl(); return scienceMemory(); };
(globalThis as unknown as { __moondaScienceDropDecoded: unknown }).__moondaScienceDropDecoded = async (dropCompressed = false) => {
  for (const p of scienceProviders) p.reloadNow();
  await workers().scienceControl({ dropAll: true, dropCompressed }); return scienceMemory();
};

/** One switch can combine a global map and sharper maps near either pole. Later sources lie on top. */
export function createScienceRasterProvider(o: { sources: ScienceRasterSource[]; credit: string; maximumLevel?: number }): ReprojectedImageryProvider {
  const sources = o.sources.map(absoluteScienceSource);
  return new PreparedLayerProvider({
    rectangle: Rectangle.MAX_VALUE,
    maximumLevel: o.maximumLevel ?? 10,
    credit: o.credit,
    worker: workers().scienceWorker,
    isLocal: () => true,
    jobFor: (rect, level) => {
      const range = tileTrueLatRange(rect);
      const touches = sources.some(s => s.projection === 'global' || (s.pole === 'north'
        ? range.maxDeg >= (s.clipTrueLatDeg ?? 80) - pixelDeg(level)
        : range.minDeg <= (s.clipTrueLatDeg ?? -80) + pixelDeg(level)));
      return touches ? { kind: 'science', rect, level, sources } : null;
    },
  }, sources);
}

/**
 * One local south-polar-stereographic picture (x = rho·sin(lon), y = rho·cos(lon), ±extentM,
 * row 0 = +y). Without `clipTrueLatDeg` (the polar photo) it fades out softly (over 40 km, ending at 80°S) into the
 * Moon Trek photo below; with it (science maps) the edge is a crisp line at that latitude.
 */
export function createPolarRasterProvider(o: { url: string; extentM: number; credit: string; maximumLevel?: number; clipTrueLatDeg?: number }): ReprojectedImageryProvider {
  const clip = o.clipTrueLatDeg ?? POLAR_LIMIT_DEG;
  const featherM = o.clipTrueLatDeg === undefined ? POLAR_FEATHER_M : 0;
  const url = new URL(o.url, document.baseURI).href; // the worker resolves relative URLs against its own script
  return new ReprojectedImageryProvider({
    rectangle: polarRectangle(clip),
    maximumLevel: o.maximumLevel ?? 9,
    credit: o.credit,
    worker: 0,
    jobFor: (rect, level) =>
      tileTrueLatRange(rect).minDeg >= clip + pixelDeg(level) ? null : { kind: 'raster', rect, level, url, extentM: o.extentM, clipTrueLat: clip, featherM },
  });
}

/**
 * Sharp south-polar photos (the LROC mosaics served by ASU Lunaserv, the server behind QuickMap):
 * square polar tiles, level k = the 608 km square split 2^k x 2^k, k up to 10 (~1.2 m per pixel).
 * Only tiles that need k >= minK are drawn; coarser views use the local polar photo underneath.
 *
 * Local first: the squares stored with the app (folder `local`, default ./data/polar/t/, listed
 * in its index.json by data-prep/polar_tiles.py) are read from disk; Lunaserv is only asked for
 * squares that are not stored. Pass `local: null` to always use the remote server. Where the
 * photos have no finer detail (outside 84 deg S only the 100 m WAC mosaic exists) tiles stop at
 * the level that shows it all and deeper ones keep their parent.
 */
export function createPolarPyramidProvider(o: { layers: string; minK: number; credit: string; local?: string | null }): ReprojectedImageryProvider {
  let maximumLevel = 0;
  while (pyramidLevelFor(maximumLevel) < PYRAMID_MAX_K) maximumLevel++;
  const worker = workers().route('pyramid');
  // Which squares are stored with the app? Read the list once and hand it to the worker before the first job.
  let local: string | null = null, index: PyramidIndex | null = null, listed = true;
  if (o.local !== null && typeof document !== 'undefined') {
    const folder = (local = new URL(o.local ?? './data/polar/t/', document.baseURI).href.replace(/\/?$/, '/'));
    listed = false;
    const read = (triesLeft: number): Promise<void> =>
      fetch(`${folder}index.json`).then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then((json: unknown) => {
        const ix = parsePyramidIndex(json);
        if (ix && ix.layers === o.layers) { index = ix; workers().tell(worker, { pyramidIndex: json, base: folder }); }
        else console.warn(`Stored south-pole photos not used: they are for "${ix?.layers ?? 'an unknown layer set'}", this layer asks for "${o.layers}".`);
      }).catch((e: unknown) => (triesLeft > 0 ? new Promise<void>(res => setTimeout(res, 1500)).then(() => read(triesLeft - 1)) : console.warn('No list of stored south-pole photos, using the remote server only:', e)));
    void read(1).finally(() => { listed = true; });
  }
  return new ReprojectedImageryProvider({
    rectangle: polarRectangle(POLAR_LIMIT_DEG),
    maximumLevel,
    credit: o.credit,
    worker,
    isLocal: job => pyramidSurelyLocal(index, job.rect, job.level),
    jobFor: (rect, level) => {
      if (pyramidLevelFor(level) < o.minK || tileTrueLatRange(rect).minDeg >= POLAR_LIMIT_DEG + pixelDeg(level)) return null;
      if (pyramidParentIsEnough(rect, level)) return 'parent'; // the photos are no sharper than the parent tile shows
      if (!listed) return 'wait';
      return { kind: 'pyramid', rect, level, layers: o.layers, minK: o.minK, local };
    },
  });
}
