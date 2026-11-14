// Measured circular fits, drawn as small circles on the Moon, never as circles in a map tile.
// Source: Robbins (2019), https://astrogeology.usgs.gov/search/map/moon_crater_database_v1_robbins
// Small south-polar catalogue: Marco Figuera et al. (2022), CC BY 4.0,
// https://zenodo.org/records/5779260 (full attribution is retained in craters.json).
// The full catalogue is split by region and size in data-prep/features/scripts/build_crater_drawing.py.
// Keep craters.bin unchanged: the route planner also reads those Float32 triples.
//
// A screen vector layer avoids two raster problems: neighbouring tiles choosing different rings,
// and a line getting wider when Cesium magnifies its parent tile. One choice of at most 400 whole
// rims serves the entire view. Catalogue scans and path preparation yield every few milliseconds.
// The old canvas bitmaps also lacked the photo worker's row flip. WebGL ignores Cesium's upload
// flip for ImageBitmap, so each tile's rings were mirrored within that tile, shifting them on the
// ground. Drawing vectors skips that upload entirely. Specification:
// https://registry.khronos.org/webgl/specs/latest/1.0/#TEXIMAGE2D_HTML
import { Cartesian2, Matrix4, type Viewer } from 'cesium';
import { MOON_R, trueUnit, trueToDisplayVec, type V3 } from './frame.ts';
import type { FlatMap } from './flatMap.ts';

const DEG = Math.PI / 180;
const R_KM = MOON_R / 1000;
const MAX_RINGS = 400;
const MIN_PIXELS = 9;
const MEMORY_LIMIT = 40 * 1024 * 1024;
const CANVAS_LIMIT = 24 * 1024 * 1024;
const META_ALLOWANCE = 2 * 1024 * 1024;
const WORK_ALLOWANCE = 6 * 1024 * 1024;
const WARM_DOWNLOAD_LIMIT = 3 * 1024 * 1024;
const MAX_CANDIDATES = 4096;
const MAX_PATH_SEGMENTS = 32000;
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const clamp = (v: number) => Math.max(-1, Math.min(1, v));
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const wrap = (r: number) => ((r + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

export interface CraterCircle {
  centre: V3; east: V3; north: V3;
  radiusRad: number; cosRadius: number; sinRadius: number;
}

/** Positive-east, planetocentric source coordinates; diameter is an arc length in km. */
export function craterCircle(latDeg: number, lonDeg: number, diameterKm: number): CraterCircle {
  const p = latDeg * DEG, l = lonDeg * DEG;
  const radiusRad = diameterKm / (2 * R_KM);
  return {
    centre: trueToDisplayVec(trueUnit(latDeg, lonDeg)),
    east: trueToDisplayVec([-Math.sin(l), Math.cos(l), 0]),
    north: trueToDisplayVec([-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)]),
    radiusRad, cosRadius: Math.cos(radiusRad), sinRadius: Math.sin(radiusRad),
  };
}

/** A true spherical rim point, rotated exactly as the photo is (display = x, -z, y). */
export function pointOnCrater(c: CraterCircle, bearingRad: number): V3 {
  const e = Math.cos(bearingRad) * c.sinRadius, n = Math.sin(bearingRad) * c.sinRadius;
  return [c.centre[0] * c.cosRadius + c.east[0] * e + c.north[0] * n,
    c.centre[1] * c.cosRadius + c.east[1] * e + c.north[1] * n,
    c.centre[2] * c.cosRadius + c.east[2] * e + c.north[2] * n];
}

/** Reference projection for the shared-edge check. The live renderer has no tile boundaries. */
export function projectCraterPointToTile(p: V3, r: { west: number; east: number; south: number; north: number }, size = 256): { x: number; y: number } {
  const lon = wrap(Math.atan2(p[1], p[0]) - (r.west + r.east) / 2);
  return { x: (lon / (r.east - r.west) + 0.5) * size,
    y: (r.north - Math.asin(clamp(p[2]))) / (r.north - r.south) * size };
}

/** Screen positions use x, y and w only. Depth changes and sub-pixel noise are not camera moves. */
export function craterScreenKey(matrix: ArrayLike<number>): string {
  return [0, 1, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15].map(i => {
    const scale = i >= 12 ? 1e4 : 1e12;
    return Math.round(matrix[i] * scale) / scale;
  }).join(',');
}

/** A basin rim larger than the view reads as a stray line. Ease it away before the limit. */
export function craterSizeOpacity(diameterPx: number, longerSide: number): number {
  const t = Math.max(0, Math.min(1, (diameterPx / longerSide - 1) / 0.3));
  return Number.isFinite(t) ? 1 - t * t * (3 - 2 * t) : 0;
}

/** A reversed fade starts from its current alpha, so neither direction makes a jump. */
export function craterFade(from: number, to: number, startedAt: number, now: number, durationMs = 200): number {
  const t = Math.max(0, Math.min(1, (now - startedAt) / durationMs));
  return from + (to - from) * t;
}

interface Choice { id: string; km: number; diameterPx: number; nearView: boolean }
/** Leave a clear gap between entering and leaving; keep incumbents ahead of new arrivals. */
export function chooseStableCraters(candidates: readonly Choice[], previous: ReadonlySet<string>, limit = MAX_RINGS): string[] {
  return candidates.filter(c => c.nearView && c.diameterPx >= (previous.has(c.id) ? 7 : 11))
    .sort((a, b) => Number(previous.has(b.id)) - Number(previous.has(a.id)) || b.km - a.km || a.id.localeCompare(b.id))
    .slice(0, limit).map(c => c.id);
}

/** Exact screen extent of the spherical circle, before terrain's small height changes. */
export function craterScreenDiameter(c: CraterCircle, matrix: ArrayLike<number>, width: number, height: number, flatScale?: number): number {
  if (flatScale !== undefined) {
    const lat = Math.asin(clamp(-c.centre[1]));
    const latSpan = Math.min(Math.PI / 2, lat + c.radiusRad) - Math.max(-Math.PI / 2, lat - c.radiusRad);
    const lonSpan = Math.abs(lat) + c.radiusRad >= Math.PI / 2 ? 2 * Math.PI :
      2 * Math.asin(clamp(c.sinRadius / Math.cos(lat)));
    return Math.max(latSpan, lonSpan) / DEG * flatScale;
  }
  const coefficients = (row: number) => {
    const apply = (v: V3) => matrix[row] * v[0] + matrix[row + 4] * v[1] + matrix[row + 8] * v[2];
    return [MOON_R * c.cosRadius * apply(c.centre) + matrix[row + 12],
      MOON_R * c.sinRadius * apply(c.east), MOON_R * c.sinRadius * apply(c.north)];
  };
  const [d, e, f] = coefficients(3), A = d * d - e * e - f * f;
  if (d <= Math.hypot(e, f) || A <= 0) return Infinity;
  const span = (row: number) => {
    const [a, b, c1] = coefficients(row);
    const B = -2 * a * d + 2 * b * e + 2 * c1 * f, C = a * a - b * b - c1 * c1;
    return Math.sqrt(Math.max(0, B * B - 4 * A * C)) / A;
  };
  return Math.max(span(0) * width / 2, span(1) * height / 2);
}

interface Chunk {
  file: string; count: number; bytes: number; minKm: number; maxKm: number;
  centre: V3; radiusRad: number;
}
interface Index { count: number; chunks: Chunk[] }
interface Cached { data: Float32Array; used: number }
/** Drop the least recently used chunks even when a previous view needed them. */
export function trimCraterChunks(cache: Map<string, Cached>, limit: number): { bytes: number; evicted: number } {
  let bytes = [...cache.values()].reduce((n, c) => n + c.data.byteLength, 0), evicted = 0;
  for (const [file, c] of [...cache].sort((a, b) => a[1].used - b[1].used)) {
    if (bytes <= limit) break;
    cache.delete(file); bytes -= c.data.byteLength; evicted++;
  }
  return { bytes, evicted };
}
interface Cap { centre: V3; radius: number }
interface View extends Cap {
  flat: FlatMap | null; width: number; height: number; mpp: number;
  eye: V3; matrix: Matrix4; key: string;
}
interface Record { id: string; lat: number; lon: number; km: number; circle: CraterCircle }
interface Geometry { xyz: Float64Array; steps: number }
interface Prepared { record: Record; geometry: Geometry }
interface Resident extends Prepared {
  from: number; target: boolean; changedAt: number;
  painted: boolean; paintedAlpha: number; fadeAlpha: number; sizeAlpha: number;
  lastBounds?: Bounds; lastBoundsAt?: number;
}
interface Bounds { x0: number; x1: number; y0: number; y1: number; diameter: number }

/** Begin the real fade while an arc is still visible, rather than after it has crossed an edge. */
export function craterWillLeave(bounds: { x0: number; x1: number; y0: number; y1: number },
  previous: { x0: number; x1: number; y0: number; y1: number }, elapsedMs: number, width: number, height: number): boolean {
  if (elapsedMs <= 0 || elapsedMs > 120) return false;
  const ahead = 200 / elapsedMs;
  const predict = (key: 'x0' | 'x1' | 'y0' | 'y1') => bounds[key] + (bounds[key] - previous[key]) * ahead;
  return predict('x1') < -2 || predict('x0') > width + 2 || predict('y1') < -2 || predict('y0') > height + 2;
}

class Catalogue {
  index: Index | null = null;
  small = new Float32Array(0);
  cache = new Map<string, Cached>();
  pending = new Map<string, Promise<void>>();
  revision = 0;
  downloadedBytes = 0;
  indexBytes = 0;
  evictions = 0;
  private limit = MEMORY_LIMIT - CANVAS_LIMIT - META_ALLOWANCE - WORK_ALLOWANCE;
  private starting: Promise<void> | null = null;
  private root = new URL('./data/features/', document.baseURI);

  start() {
    this.starting ??= (async () => {
      const [index, small] = await Promise.allSettled([
        fetch(new URL('craters-draw/index.json', this.root)).then(async r => {
          if (!r.ok) throw Error(String(r.status));
          const text = await r.text(); this.indexBytes = new TextEncoder().encode(text).byteLength;
          this.downloadedBytes += this.indexBytes; return JSON.parse(text) as Index;
        }),
        fetch(new URL('craters-small-south.bin', this.root)).then(r => r.ok ? r.arrayBuffer() : new ArrayBuffer(0)),
      ]);
      if (index.status === 'fulfilled') this.index = index.value;
      else {
        // Older offline caches can still draw the retained planner catalogue.
        const r = await fetch(new URL('craters.bin', this.root));
        if (r.ok) this.cache.set('legacy', { data: new Float32Array(await r.arrayBuffer()), used: performance.now() });
      }
      if (small.status === 'fulfilled') this.small = new Float32Array(small.value);
      this.downloadedBytes += this.small.byteLength;
      this.revision++;
    })().catch(e => console.warn('Crater catalogue unavailable:', e));
    return this.starting;
  }

  setLimit(bytes: number) {
    const next = Math.max(0, bytes);
    if (next !== this.limit) { this.limit = next; this.trim(); }
  }
  get bytes() { return [...this.cache.values()].reduce((n, c) => n + c.data.byteLength, 0); }
  private trim() { this.evictions += trimCraterChunks(this.cache, this.limit).evicted; }

  forView(view: Cap, minKm: number, downloadLimit = Infinity): Float32Array[] {
    const arrays: Float32Array[] = [this.small];
    if (!this.index) { const legacy = this.cache.get('legacy'); if (legacy) arrays.push(legacy.data); return arrays; }
    let needed = this.index.chunks.filter(c => c.maxKm >= minKm &&
      (view.radius + c.radiusRad >= Math.PI || dot(view.centre, c.centre) >= Math.cos(view.radius + c.radiusRad)));
    if (Number.isFinite(downloadLimit)) {
      let bytes = this.indexBytes + this.small.byteLength;
      needed = needed.filter(c => { if (bytes + c.bytes > downloadLimit) return false; bytes += c.bytes; return true; });
    }
    for (const c of needed) {
      const hit = this.cache.get(c.file);
      if (hit) { hit.used = performance.now(); arrays.push(hit.data); }
      else if (this.pending.size < 4 && !this.pending.has(c.file)) {
        const task = fetch(new URL(c.file, this.root)).then(async r => {
          if (!r.ok) throw Error(String(r.status));
          const data = new Float32Array(await r.arrayBuffer());
          if (data.length !== c.count * 3) throw Error('Incomplete crater chunk');
          this.cache.set(c.file, { data, used: performance.now() });
          this.downloadedBytes += data.byteLength; this.trim();
        }).catch(e => console.warn('Crater chunk unavailable:', c.file, e)).finally(() => {
          this.pending.delete(c.file); this.revision++;
        });
        this.pending.set(c.file, task);
      }
    }
    this.trim();
    return arrays;
  }

  async warm(view: View) {
    await this.start();
    const until = performance.now() + 12000, minKm = Math.max(0.03, MIN_PIXELS * view.mpp / 1000);
    do {
      this.forView(view, minKm, WARM_DOWNLOAD_LIMIT);
      if (!this.pending.size) break;
      await Promise.all(this.pending.values()); await pause();
    } while (performance.now() < until);
  }
}

/** Cached world-space rims are painted in one pass with each photo frame. */
class CraterLayer {
  private shown = false;
  get show() { return this.shown; }
  set show(on: boolean) {
    if (on === this.shown) return;
    this.shown = on;
    this.canvas.style.visibility = on && this.pathKey === this.view().key ? 'visible' : 'hidden';
    clearTimeout(this.timer); cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
    if (on && !this.viewer.isDestroyed()) this.viewer.scene.requestRender();
  }
  private viewer: Viewer;
  private flat: () => FlatMap | null;
  private heightAt: (lat: number, lon: number) => number;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private catalogue = new Catalogue();
  private residents = new Map<string, Resident>();
  private ready = new Map<string, Prepared>();
  private chosen: Record[] = [];
  private raf = 0;
  private timer = 0;
  private token = 0;
  private choosing = false;
  private lastKey = '';
  private lastRevision = -1;
  private lastChoice = 0;
  private destroyed = false;
  private renderOff: () => void;
  private terrainOff: () => void;
  private dirt = true;
  private pathKey = '';
  private paintedAt = 0;
  private serial = 0;
  private drawnIds: string[] = [];
  private drawnSegments = 0;
  private warming = false;
  private warmReady = false;
  private warmBytes = 0;
  private hiddenOversized = 0;
  private maxDiameterRatio = 0;
  private flatHook: { flat: FlatMap; original: FlatMap['draw']; wrapped: FlatMap['draw'] } | null = null;

  constructor(viewer: Viewer, flat: () => FlatMap | null, heightAt: (lat: number, lon: number) => number) {
    this.viewer = viewer; this.flat = flat; this.heightAt = heightAt;
    this.canvas.className = 'moon-crater-rims';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;visibility:hidden;';
    viewer.container.appendChild(this.canvas); this.ctx = this.canvas.getContext('2d')!;
    this.terrainOff = viewer.scene.globe.tileLoadProgressEvent.addEventListener(() => { this.dirt = true; });
    // The globe photo and its rims must use the same camera, before the browser presents either.
    this.renderOff = viewer.scene.postRender.addEventListener(() => {
      if (this.shown && !this.warming && !this.flat()?.active && !this.flat()?.busy) this.present(this.view(), performance.now());
    });
    const hooks = this.canvas as HTMLCanvasElement & { __craterDiagnostics: () => unknown; __craterFrame: () => unknown };
    hooks.__craterDiagnostics = () => this.diagnostics(); hooks.__craterFrame = () => this.frame();
    this.attachFlat(); void this.warm(this.view()); this.raf = requestAnimationFrame(this.tick);
  }

  private geometryBytes() {
    return [...this.residents.values(), ...this.ready.values()].reduce((n, r) => n + r.geometry.xyz.byteLength, 0);
  }
  diagnostics() {
    const canvasBytes = this.canvas.width * this.canvas.height * 4, chunkBytes = this.catalogue.bytes, smallBytes = this.catalogue.small.byteLength;
    return { chunkBytes, chunks: this.catalogue.cache.size, smallBytes, indexBytes: this.catalogue.indexBytes,
      canvasBytes, metadataAllowance: META_ALLOWANCE, workAllowance: WORK_ALLOWANCE,
      geometryBytes: this.geometryBytes(), geometryLimitBytes: 2 * 1024 * 1024,
      managedReservedBytes: canvasBytes + chunkBytes + smallBytes + META_ALLOWANCE + WORK_ALLOWANCE,
      limitBytes: MEMORY_LIMIT, chunkLimitBytes: MEMORY_LIMIT - canvasBytes - smallBytes - META_ALLOWANCE - WORK_ALLOWANCE,
      evictions: this.catalogue.evictions, selectedRecords: this.chosen.length, rings: this.drawnIds.length,
      activePool: this.residents.size, queued: this.ready.size, pathSegments: this.drawnSegments, maxPathSegments: MAX_PATH_SEGMENTS,
      maxDiameterRatio: this.maxDiameterRatio,
      fadedRings: [...this.residents.values()].filter(r => r.painted && (r.fadeAlpha < .999 || r.sizeAlpha < .999)).length,
      hiddenOversized: this.hiddenOversized, warmReady: this.warmReady, warmBytes: this.warmBytes, warmLimitBytes: WARM_DOWNLOAD_LIMIT };
  }
  private frame() {
    const rings = [...this.residents.values()].map(r => ({ id: r.record.id, alpha: r.paintedAlpha,
      fadeAlpha: r.fadeAlpha, target: Number(r.target), fading: !r.target && r.fadeAlpha > 0,
      sizeFading: r.sizeAlpha < .999, visible: r.painted }));
    return { ids: [...this.drawnIds], rings: rings.filter(r => r.visible), activePool: rings,
      count: this.drawnIds.length, currentKey: this.view().key, paintedKey: this.pathKey,
      paintedAt: this.paintedAt, serial: this.serial, fadingCount: rings.filter(r => !r.target && r.fadeAlpha > 0).length };
  }
  private attachFlat() {
    const flat = this.flat(); if (!flat || this.flatHook?.flat === flat) return;
    if (this.flatHook && this.flatHook.flat.draw === this.flatHook.wrapped) this.flatHook.flat.draw = this.flatHook.original;
    const original = flat.draw;
    // FlatMap owns another render loop. Follow its public draw method after it paints,
    // so coasting and zooming never leave a previous-frame outline over its photo.
    const wrapped = () => {
      original.call(flat);
      if (!this.destroyed && this.shown && flat.active && !flat.busy && !this.warming) this.present(this.view(), performance.now());
    };
    flat.draw = wrapped; this.flatHook = { flat, original, wrapped };
  }
  private async warm(view: View) {
    this.warming = true;
    try {
      this.budgetCanvas(view); await this.catalogue.warm(view);
      if (this.destroyed || this.viewer.isDestroyed()) return;
      this.warmBytes = this.catalogue.downloadedBytes; await this.choose(view, ++this.token);
      // Nothing is visible yet: the opening picture may start fully painted.
      for (const [id, r] of this.ready) {
        if (this.residents.size === MAX_RINGS) break;
        this.residents.set(id, { ...r, from: 1, target: true, changedAt: performance.now(), painted: false, paintedAlpha: 0, fadeAlpha: 1, sizeAlpha: 1 });
      }
      this.ready.clear(); this.present(view, performance.now(), true);
      this.lastKey = view.key; this.lastRevision = this.catalogue.revision; this.dirt = false; this.warmReady = this.drawnIds.length > 0;
    } finally { this.warming = false; }
  }
  private budgetCanvas(view: View) {
    const dpr = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(CANVAS_LIMIT / (4 * view.width * view.height)));
    const w = Math.floor(view.width * dpr), h = Math.floor(view.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.catalogue.setLimit(MEMORY_LIMIT - w * h * 4 - this.catalogue.small.byteLength - META_ALLOWANCE - WORK_ALLOWANCE); return dpr;
  }
  destroy() {
    this.destroyed = true; this.token++; cancelAnimationFrame(this.raf); clearTimeout(this.timer);
    this.renderOff(); this.terrainOff(); this.canvas.remove();
    if (this.flatHook && this.flatHook.flat.draw === this.flatHook.wrapped) this.flatHook.flat.draw = this.flatHook.original;
    this.catalogue.cache.clear(); this.residents.clear(); this.ready.clear(); this.chosen = [];
  }

  private view(): View {
    const viewer = this.viewer, camera = viewer.camera;
    const width = viewer.canvas.clientWidth, height = viewer.canvas.clientHeight;
    const flat = this.flat();
    const matrix = Matrix4.multiply(camera.frustum.projectionMatrix, camera.viewMatrix, new Matrix4());
    const p = camera.positionWC, distance = Math.hypot(p.x, p.y, p.z);
    const eye: V3 = [p.x, p.y, p.z];
    let centre: V3 = [p.x / distance, p.y / distance, p.z / distance];
    let radius = Math.acos(Math.min(1, MOON_R / distance));
    const fovy = (camera.frustum as unknown as { fovy?: number }).fovy ?? 0.8;
    let mpp = 2 * Math.max(100, distance - MOON_R) * Math.tan(fovy / 2) / height;
    let key: string;
    if (flat?.active) {
      centre = trueToDisplayVec(trueUnit(flat.view.latC, flat.view.lonC));
      const fr = flat.free();
      const north = flat.toLatLon(fr.cx, 0).lat, south = flat.toLatLon(fr.cx, height).lat;
      const span = width / flat.view.s;
      const top = Math.min(90, north), bottom = Math.max(-90, south);
      const nearestEquator = bottom <= 0 && top >= 0 ? 0 : Math.min(Math.abs(top), Math.abs(bottom));
      // A meridian then a parallel bounds every point of this true-lat/lon rectangle,
      // even when its top reaches a pole or it wraps through the date line.
      radius = Math.min(Math.PI, Math.max(Math.abs(top - flat.view.latC), Math.abs(bottom - flat.view.latC)) * DEG +
        Math.min(180, span / 2) * DEG * Math.cos(nearestEquator * DEG) + 0.008);
      mpp = MOON_R * DEG / flat.view.s * Math.max(0.08, Math.cos(flat.view.latC * DEG));
      key = `flat:${flat.view.latC}:${flat.view.lonC}:${flat.view.s}:${fr.cx}:${fr.cy}`;
    } else {
      // Bound the footprint, including edge-only rims. If an edge sees space, keep the whole horizon cap.
      const hits: V3[] = [];
      let allHit = true;
      for (const x of [0, width / 2, width]) for (const y of [0, height / 2, height]) {
        const ray = camera.getPickRay(new Cartesian2(x, y));
        if (!ray) { allHit = false; continue; }
        const d = ray.direction, o = ray.origin;
        const b = o.x * d.x + o.y * d.y + o.z * d.z;
        const disc = b * b - (o.x * o.x + o.y * o.y + o.z * o.z - MOON_R * MOON_R);
        if (disc < 0) { allHit = false; continue; }
        const t = -b - Math.sqrt(disc);
        if (t < 0) { allHit = false; continue; }
        hits.push([(o.x + d.x * t) / MOON_R, (o.y + d.y * t) / MOON_R, (o.z + d.z * t) / MOON_R]);
      }
      if (allHit && hits.length === 9) {
        centre = hits[4]; radius = 0;
        for (const h of hits) radius = Math.max(radius, Math.acos(clamp(dot(centre, h))));
      }
      radius = Math.min(Math.PI, radius + 0.008); // cover terrain up to the highest lunar mountains
      // Cesium changes its near/far depth limits while tiles load. Only x, y and w
      // place a line on screen; a depth-only change must never clear the drawing.
      key = craterScreenKey(matrix);
    }
    return { flat: flat?.active ? flat : null, centre, radius, width, height, mpp, eye, matrix, key: `${width}:${height}:${key}` };
  }

  private tick = () => {
    if (this.destroyed) return;
    if (this.viewer.isDestroyed()) { this.destroy(); return; }
    this.attachFlat(); const flat = this.flat();
    const visible = this.shown && !flat?.busy && (!!flat?.active || this.viewer.scene.globe.show);
    this.canvas.style.visibility = visible ? 'visible' : 'hidden';
    if (!visible) { this.timer = window.setTimeout(() => { this.raf = requestAnimationFrame(this.tick); }, 150); return; }
    if (this.warming) { this.raf = requestAnimationFrame(this.tick); return; }
    const view = this.view(), now = performance.now();
    const changed = view.key !== this.lastKey || this.catalogue.revision !== this.lastRevision;
    if (changed && !this.choosing && now - this.lastChoice >= 100) {
      this.lastChoice = now; this.lastKey = view.key; this.lastRevision = this.catalogue.revision; this.choosing = true;
      void this.choose(view, ++this.token).finally(() => { this.choosing = false; });
    }
    const fading = [...this.residents.values()].some(r => !r.target || r.from < 1 && now - r.changedAt < 200);
    if (view.flat) { if (this.pathKey !== view.key || this.dirt || fading) view.flat.request(); }
    else if (this.pathKey !== view.key || this.dirt || fading) this.viewer.scene.requestRender();
    this.canvas.dataset.loading = String(this.catalogue.pending.size + Number(this.choosing));
    this.canvas.dataset.drawing = 'false'; this.canvas.dataset.chunks = String(this.catalogue.cache.size);
    this.raf = requestAnimationFrame(this.tick);
  };

  private bounds(record: Record, view: View): Bounds {
    const c = record.circle, diameter = craterScreenDiameter(c, view.matrix, view.width, view.height, view.flat?.view.s);
    if (view.flat) {
      const p = view.flat.toScreen(record.lat, record.lon);
      return { x0: p.x - diameter / 2, x1: p.x + diameter / 2, y0: p.y - diameter / 2, y1: p.y + diameter / 2, diameter };
    }
    const coefficients = (row: number) => {
      const apply = (v: V3) => view.matrix[row] * v[0] + view.matrix[row + 4] * v[1] + view.matrix[row + 8] * v[2];
      return [MOON_R * c.cosRadius * apply(c.centre) + view.matrix[row + 12], MOON_R * c.sinRadius * apply(c.east), MOON_R * c.sinRadius * apply(c.north)];
    };
    const [d, e, f] = coefficients(3), A = d * d - e * e - f * f;
    if (A <= 0 || !Number.isFinite(diameter)) return { x0: -Infinity, x1: Infinity, y0: -Infinity, y1: Infinity, diameter };
    const extent = (row: number) => {
      const [a, b, c1] = coefficients(row), B = -2 * a * d + 2 * b * e + 2 * c1 * f;
      const q = Math.sqrt(Math.max(0, B * B - 4 * A * (a * a - b * b - c1 * c1)));
      return [(-B - q) / (2 * A), (-B + q) / (2 * A)];
    };
    const x = extent(0), y = extent(1);
    return { x0: (1 + x[0]) * view.width / 2, x1: (1 + x[1]) * view.width / 2, y0: (1 - y[1]) * view.height / 2, y1: (1 - y[0]) * view.height / 2, diameter };
  }
  private near(bounds: Bounds, view: View, retained: boolean) {
    const margin = retained ? .2 * Math.max(view.width, view.height) : 2;
    return bounds.x1 >= -margin && bounds.x0 <= view.width + margin && bounds.y1 >= -margin && bounds.y0 <= view.height + margin &&
      craterSizeOpacity(bounds.diameter, Math.max(view.width, view.height)) > 0;
  }
  private steps(diameter: number, flat: boolean) {
    const needed = Math.PI * Math.sqrt(Math.max(1, diameter) / (flat ? .7 : 1.4));
    return Math.max(32, Math.min(256, 32 * 2 ** Math.ceil(Math.log2(Math.max(1, needed / 32)))));
  }
  private geometry(record: Record, steps: number): Geometry {
    const xyz = new Float64Array((steps + 1) * 3);
    for (let i = 0; i <= steps; i++) {
      const u = pointOnCrater(record.circle, i / steps * 2 * Math.PI);
      const lat = Math.asin(clamp(-u[1])) / DEG, lon = Math.atan2(u[2], u[0]) / DEG, r = MOON_R + this.heightAt(lat, lon);
      xyz[i * 3] = u[0] * r; xyz[i * 3 + 1] = u[1] * r; xyz[i * 3 + 2] = u[2] * r;
    }
    return { xyz, steps };
  }

  private async choose(view: View, token: number) {
    const minKm = Math.max(.03, 7 * view.mpp / 1000);
    // Fetch a wider, finer neighbourhood before motion brings it on screen.
    const arrays = this.catalogue.forView({ centre: view.centre, radius: Math.min(Math.PI, view.radius * 1.35 + .01) }, minKm * .8,
      this.warming ? WARM_DOWNLOAD_LIMIT : Infinity);
    const byId = new Map<string, Record>();
    for (const r of this.residents.values()) byId.set(r.record.id, r.record);
    let slice = performance.now();
    for (const a of arrays) for (let i = 0; i < a.length; i += 3) {
      if (i % 768 === 0 && performance.now() - slice > 4) {
        await pause(); if (token !== this.token || this.destroyed || this.viewer.isDestroyed()) return; slice = performance.now();
      }
      const km = a[i + 2]; if (km < minKm * .8) break;
      const lat = a[i], lon = a[i + 1], centre = trueToDisplayVec(trueUnit(lat, lon)), rho = km / (2 * R_KM);
      if (view.radius * 1.35 + .02 + rho < Math.PI && dot(centre, view.centre) < Math.cos(view.radius * 1.35 + .02 + rho)) continue;
      const id = `${lat},${lon},${km}`;
      if (!byId.has(id)) byId.set(id, { id, lat, lon, km, circle: craterCircle(lat, lon, km) });
    }
    if (token !== this.token || this.destroyed || this.viewer.isDestroyed()) return;
    const latest = this.warming ? view : this.view(), previous = new Set(this.residents.keys());
    let records = [...byId.values()].sort((a, b) => Number(previous.has(b.id)) - Number(previous.has(a.id)) || b.km - a.km);
    records = records.slice(0, MAX_CANDIDATES);
    const rows = records.map(record => {
      const b = this.bounds(record, latest);
      return { id: record.id, km: record.km, diameterPx: b.diameter,
        nearView: this.near(b, latest, previous.has(record.id)) && this.residents.get(record.id)?.target !== false };
    });
    const ids = chooseStableCraters(rows, previous), lookup = new Map(records.map(r => [r.id, r]));
    const prepared = new Map<string, Prepared>();
    for (const id of ids) {
      const record = lookup.get(id)!, resident = this.residents.get(id), existing = resident ?? this.ready.get(id);
      const diameter = rows.find(r => r.id === id)!.diameterPx;
      let steps = this.steps(diameter, !!latest.flat);
      if (existing && existing.geometry.steps >= steps) { if (!resident) prepared.set(id, existing); continue; }
      const held = this.geometryBytes() + [...prepared.values()].reduce((n, r) => n + r.geometry.xyz.byteLength, 0);
      while (steps > 32 && held + (steps + 1) * 24 > 2 * 1024 * 1024) steps /= 2;
      if (held + (steps + 1) * 24 > 2 * 1024 * 1024) continue;
      const geometry = this.geometry(record, steps);
      if (resident) resident.geometry = geometry; else prepared.set(id, { record, geometry });
      if (performance.now() - slice > 4) {
        await pause(); if (token !== this.token || this.destroyed || this.viewer.isDestroyed()) return; slice = performance.now();
      }
    }
    if (token !== this.token || this.destroyed || this.viewer.isDestroyed()) return;
    this.ready = prepared; this.chosen = records;
    this.dirt = true; if (!this.warming) this.viewer.scene.requestRender();
  }
  private retarget(r: Resident, target: boolean, now: number) {
    if (r.target === target) return;
    r.from = craterFade(r.from, Number(r.target), r.changedAt, now); r.target = target; r.changedAt = now;
  }
  private maintain(view: View, now: number) {
    let retiring = [...this.residents.values()].filter(r => !r.target).length;
    for (const [id, r] of this.residents) {
      const b = this.bounds(r.record, view);
      const leaving = !!r.lastBounds && craterWillLeave(b, r.lastBounds, now - (r.lastBoundsAt ?? now), view.width, view.height);
      r.lastBounds = b; r.lastBoundsAt = now;
      const keep = b.diameter >= 7 && this.near(b, view, true) && !leaving;
      if (keep) this.retarget(r, true, now);
      else if (r.target && (leaving || retiring < 40)) { this.retarget(r, false, now); retiring++; }
      if (!r.target && craterFade(r.from, 0, r.changedAt, now) <= .001) this.residents.delete(id);
    }
    for (const [id, p] of this.ready) {
      if (this.residents.size >= MAX_RINGS) break;
      if (this.residents.has(id)) { this.ready.delete(id); continue; }
      const b = this.bounds(p.record, view);
      if (b.diameter < 11 || !this.near(b, view, false)) continue;
      this.residents.set(id, { ...p, from: .01, target: true, changedAt: now, painted: false, paintedAlpha: 0, fadeAlpha: .01, sizeAlpha: 1 });
      this.residents.get(id)!.lastBounds = b; this.residents.get(id)!.lastBoundsAt = now;
      this.ready.delete(id);
    }
  }

  /** No await or data lookup: the canvas is replaced with a complete current-camera picture. */
  private present(view: View, now: number, warm = false) {
    if (this.destroyed || this.viewer.isDestroyed() || !warm && (!this.shown || this.flat()?.busy)) return;
    this.maintain(view, now); const dpr = this.budgetCanvas(view), g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, view.width, view.height);
    g.strokeStyle = 'rgba(235, 241, 247, 0.7)'; g.lineWidth = 1.25; g.lineCap = 'round'; g.lineJoin = 'round';
    this.drawnIds.length = 0; this.drawnSegments = 0; this.hiddenOversized = 0; this.maxDiameterRatio = 0;
    const m = view.matrix, longest = Math.max(view.width, view.height);
    const totalSteps = [...this.residents.values()].reduce((n, r) => n + r.geometry.steps, 0);
    const stride = 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(1, totalSteps / MAX_PATH_SEGMENTS))));
    for (const r of this.residents.values()) {
      r.painted = false; r.paintedAlpha = 0; r.fadeAlpha = craterFade(r.from, Number(r.target), r.changedAt, now);
      const diameter = craterScreenDiameter(r.record.circle, m, view.width, view.height, view.flat?.view.s);
      r.sizeAlpha = craterSizeOpacity(diameter, longest); const alpha = r.fadeAlpha * r.sizeAlpha;
      if (!r.sizeAlpha) { this.hiddenOversized++; continue; }
      if (alpha <= .001) continue;
      const xyz = r.geometry.xyz;
      let px = 0, py = 0, pv = false, have = false, inPath = false, segments = 0; g.beginPath();
      for (let i = 0; i <= r.geometry.steps; i += stride) {
        const k = i * 3, X = xyz[k], Y = xyz[k + 1], Z = xyz[k + 2];
        let x: number, y: number, visible: boolean;
        if (view.flat) {
          const ll = view.flat.toScreen(Math.asin(clamp(-Y / Math.hypot(X, Y, Z))) / DEG, Math.atan2(Z, X) / DEG);
          x = ll.x; y = ll.y; visible = true;
        } else {
          const w = m[3] * X + m[7] * Y + m[11] * Z + m[15];
          x = (1 + (m[0] * X + m[4] * Y + m[8] * Z + m[12]) / w) * view.width / 2;
          y = (1 - (m[1] * X + m[5] * Y + m[9] * Z + m[13]) / w) * view.height / 2;
          visible = w > 0 && (X * view.eye[0] + Y * view.eye[1] + Z * view.eye[2]) / Math.hypot(X, Y, Z) > MOON_R - 12000;
        }
        const joined = have && pv && visible && (!view.flat || Math.abs(x - px) <= 180 * view.flat.view.s);
        if (joined && Math.max(x, px) >= -2 && Math.min(x, px) <= view.width + 2 && Math.max(y, py) >= -2 && Math.min(y, py) <= view.height + 2) {
          if (!inPath) g.moveTo(px, py); g.lineTo(x, y); inPath = true; segments++;
        } else inPath = false;
        px = x; py = y; pv = visible; have = true;
      }
      if (segments) {
        g.globalAlpha = alpha; g.stroke(); r.painted = true; r.paintedAlpha = alpha;
        this.drawnIds.push(r.record.id); this.drawnSegments += segments; this.maxDiameterRatio = Math.max(this.maxDiameterRatio, diameter / longest);
      }
    }
    g.globalAlpha = 1; this.pathKey = view.key; this.paintedAt = now; this.serial++; this.dirt = false;
    this.canvas.dataset.rings = String(this.drawnIds.length);
    this.canvas.dataset.minKm = String(Math.min(...[...this.residents.values()].filter(r => r.painted).map(r => r.record.km)));
  }
}

const layers = new WeakMap<Viewer, CraterLayer>();
/** Creates once, then switches the same vector layer on both maps. No imagery texture slot is used. */
export function createCraterLayer(viewer: Viewer, flat: () => FlatMap | null, heightAt: (lat: number, lon: number) => number): CraterLayer {
  let layer = layers.get(viewer);
  if (!layer) { layer = new CraterLayer(viewer, flat, heightAt); layers.set(viewer, layer); }
  return layer;
}
