// Imagery for the 3D Moon: NASA photos and map layers, re-projected into the rotated display frame.
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

import { Credit, Event, GeographicTilingScheme, Rectangle } from 'cesium';
import { MOON_ELLIPSOID } from './ellipsoid';
import {
  FIX_MIN_TRUE_LAT, FIX_NEAR_MAX_Z, POLAR_FEATHER_M, POLAR_LIMIT_DEG, PYRAMID_MAX_K, RETRY_MS, TILE, parsePyramidIndex, pixelDeg, pyramidLevelFor, pyramidParentIsEnough,
  pyramidSurelyLocal, tileFixRange, tileTrueLatRange,
  type BaseCut, type FixParams, type FromWorker, type Job, type PyramidIndex, type Rect, type ToWorker,
} from './imageryWorker';

// ---------------------------------------------------------------------------------------------
// Worker pool. Worker 0 does every polar-raster job, so each big raster is decoded and held
// once. Tiled sources are pinned to one of the other workers, so every source tile is downloaded
// and cached exactly once: all Moon Trek layers share one worker (so its download limit covers
// the whole trek.nasa.gov server), the polar pyramid has its own.

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
  private readonly jobs = new Map<number, { worker: number; owner: ReprojectedImageryProvider; done: (b: ImageBitmap) => void; at: number; kind: string; local: boolean }>();
  /**
   * Counters for the loading screen and for tests. parents = tiles answered "keep the parent";
   * deepest = finest tile level asked of the workers per kind of layer; files/remote/failed =
   * downloads by the workers (files stored with the app / remote servers / failed).
   */
  readonly stats = { asked: 0, answered: 0, refused: 0, parents: 0, slowestMs: 0, lastMs: 0, totalMs: 0, files: 0, remote: 0, failed: 0, deepest: {} as Record<string, number> };
  private readonly net: [number, number, number][] = [];
  private readonly flip = detectBitmapFlip();
  private readonly routes = new Map<string, number>();
  /** Layers that drew tiles with holes and are waiting to reload them. */
  private readonly gapped = new Set<ReprojectedImageryProvider>();
  private nextId = 1;
  readonly tiledCount: number;

  constructor() {
    const cores = navigator.hardwareConcurrency || 4;
    this.tiledCount = cores >= 4 ? 2 : 1; // Moon Trek and the pyramid, plus the raster worker
    for (let i = 0; i <= this.tiledCount; i++) {
      const w = new Worker(new URL('./imageryWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<FromWorker>) => this.finish(e.data, i);
      w.onerror = e => this.fail(i, e);
      this.workers.push(w);
      this.busy.push(0);
      this.local.push(0);
      this.net.push([0, 0, 0]);
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
  run(worker: number, job: Job, owner: ReprojectedImageryProvider, local = false): Promise<ImageBitmap> | undefined {
    const w = this.workers[worker];
    if (!w) return Promise.resolve(blankTile());
    const count = local ? this.local : this.busy;
    if (count[worker] >= (local ? LOCAL_QUEUE : worker === 0 ? RASTER_QUEUE : TILED_QUEUE)) { this.stats.refused++; return undefined; }
    count[worker]++;
    this.stats.asked++;
    this.stats.deepest[job.kind] = Math.max(this.stats.deepest[job.kind] ?? 0, job.level);
    const id = this.nextId++;
    return new Promise(done => {
      this.jobs.set(id, { worker, owner, done, at: performance.now(), kind: job.kind, local });
      void this.flip.then(flipRows => { const msg: ToWorker = { id, job, flipRows }; w.postMessage(msg); });
    });
  }

  /** Tell one worker something that is not a tile job (e.g. which pyramid squares are stored with the app). */
  tell(worker: number, msg: ToWorker) { this.workers[worker]?.postMessage(msg); }

  private finish({ id, bitmap, gaps, recovered, parent, net }: FromWorker, worker: number) {
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
    if (gaps) { this.gapped.add(j.owner); j.owner.noteGaps(); if (j.kind === 'base') baseBroke(); }
    if (parent) this.stats.parents++;
    j.done(parent ? parentMarkBitmap() : bitmap ?? blankTile());
  }

  /** Jobs handed to the workers and not answered yet. */
  pending(): number { return this.jobs.size; }

  /** For tests: what is waiting, per kind of job, and for how long (ms). */
  waiting(): { kind: string; worker: number; ms: number }[] {
    const now = performance.now();
    return [...this.jobs.values()].map(j => ({ kind: j.kind, worker: j.worker, ms: Math.round(now - j.at) }));
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

/** Map pictures asked for and not finished yet, across all layers (0 = nothing is loading). For the loading screen. */
export function imageryPending(): number { return pool ? pool.pending() : 0; }

// Small test/debug hook (scripts/drive.mjs): what the imagery workers are doing right now.
(globalThis as { __moondaImagery?: unknown }).__moondaImagery = {
  pending: imageryPending,
  stats: () => (pool ? { ...pool.stats, deepest: { ...pool.stats.deepest } } : null),
  waiting: () => (pool ? pool.waiting() : []),
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

  requestImage(x: number, y: number, level: number): Promise<ImageBitmap> | undefined {
    const r = this.tilingScheme.tileXYToRectangle(x, y, level);
    const job = this.jobFor({ west: r.west, south: r.south, east: r.east, north: r.north }, level, x, y);
    if (job === 'wait') return undefined;
    if (job === 'parent') { workers().stats.parents++; return Promise.resolve(parentMarkBitmap()); }
    return job ? workers().run(this.worker, job, this, this.isLocal?.(job) ?? false) : Promise.resolve(blankTile());
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
export function createMoonTrekProvider(o: { layer: string; ext: string; maxSourceLevel: number; minTrueLat?: number; credit: string; overBase?: boolean }): ReprojectedImageryProvider {
  const minTrueLat = o.minTrueLat ?? -90;
  const p = new ReprojectedImageryProvider({
    rectangle: Rectangle.clone(Rectangle.MAX_VALUE),
    maximumLevel: o.maxSourceLevel + 1,
    credit: o.credit,
    worker: workers().route('trek'),
    jobFor: (rect, level, x, y) => {
      if (o.overBase && baseSet) {
        if (baseSet.state === 'loading') return 'wait';
        if (baseSet.state === 'ready' && baseCutFor(baseSet, x, y, level)) return null; // the local picture underneath shows exactly this
        if (baseSet.state === 'ready' && baseSet.fix && seamFixOn && tileFixRange(rect).min >= 1) return null; // the seam fix covers this tile completely
      }
      return minTrueLat > -90 && tileTrueLatRange(rect).maxDeg < minTrueLat - pixelDeg(level)
        ? null // tile lies wholly inside the polar cap
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
    maximumLevel: FIX_NEAR_MAX_Z + 1,
    credit: o.credit,
    worker: workers().route('trek'),
    jobFor: (rect, level, x, y) => {
      const b = baseSet;
      if (!b || b.state === 'loading') return 'wait';
      if (b.state === 'failed' || !b.fix) return null;
      if (baseCutFor(b, x, y, level)) return null; // the local pictures already show it
      if (tileTrueLatRange(rect).maxDeg < FIX_MIN_TRUE_LAT - pixelDeg(level)) return null; // inside the south-polar photos
      if (tileFixRange(rect).max <= 0) return null; // the photo is right here
      return { kind: 'synth', rect, level, fix: b.fix };
    },
  });
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
