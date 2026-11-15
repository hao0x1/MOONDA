// Real 3D mountains for the Moon, built from the same NASA LOLA heights the science uses, so what
// you see is what we calculate.
//
// Cesium asks for square "tiles" of ground in the DISPLAY frame (see frame.ts: the Moon is turned so
// the true south pole sits on Cesium's equator). For each tile we lay a 65 x 65 grid of points over
// it, turn every point into its TRUE lunar latitude/longitude and read the LOLA height there. Then we
// hand Cesium a finished triangle mesh ("quantized mesh") that also carries:
//   - a lighting direction (normal) per point, so the Sun shades crater walls and mountains properly
//   - bounding volumes and a horizon point, so Cesium can skip tiles that are off screen or behind the Moon
//   - short "skirts" (little curtains hanging from the tile edges) that hide hairline cracks between
//     tiles drawn at different levels of detail
//
// Detail levels (each level halves the tile size; level 0 = two tiles of 180° x 180°):
//   - levels 0-7 everywhere, from the global ~1.9 km map (and the 240 m polar overview near the pole)
//   - levels 8-11 for every tile that reaches the 80 m south-polar map (true lat < -80°), plus one
//     ring of tiles around those (see getTileDataAvailable for why the ring matters)
// Levels 8-11 read MoonHeights.heightAt(..., detail = true), which uses the 80 m map where it exists
// and the 240 m / global map everywhere else, point by point. So tiles side by side at one level
// always describe the same ground and share their edges exactly.
//
// Main thread: Cesium asks for tiles inside a 5 ms time budget per frame and times every request. A
// tile build takes about 1 ms, so we build it right inside the request (Cesium then sees the real cost
// and stops asking once the budget is spent). If a tile needs 80 m map files that are not downloaded
// yet, we start the download and answer "not yet"; Cesium asks again on a later frame, and only if it
// still wants that tile.

import * as Cesium from 'cesium';
import {
  AttributeCompression, BoundingSphere, Cartesian2, Cartesian3, Credit, EllipsoidalOccluder, Event, GeographicTilingScheme,
  Math as CMath, OrientedBoundingBox, QuantizedMeshTerrainData, Rectangle, TerrainProvider, type Scene, type TileAvailability,
} from 'cesium';
import { type MoonHeights, toMap } from '../science/heights';
import { MOON_ELLIPSOID } from './ellipsoid';
import { trueToDisplayLatLon } from './frame';

const DEG = Math.PI / 180;
const R = MOON_ELLIPSOID.maximumRadius; // 1,737,400 m sphere, the same reference the LOLA heights use

const N = 65; // vertices along each tile side
const S = N + 2; // samples along each side: the vertices plus one extra ring outside, for edge normals
const MAX_Q = 32767; // Cesium stores vertex positions inside a tile as whole numbers 0..32767
const MIDDLE = (N - 1) / 2 + 1; // sample index of the middle vertex row/column (where Cesium cuts a tile in four)

const GLOBAL_MAX_LEVEL = 7; // ~670 m between vertices: the ~1.9 km global map gains nothing from finer tiles
const MAX_LEVEL = 11; // ~42 m between vertices: finer than the 80 m polar map
const RELIEF_MIN_LEVEL = 12, RELIEF_MAX_LEVEL = 18; // 21 m down to 0.33 m between points near the rover
// Keep the finest grids only by the wheels. With a 600 m starting radius these are
// 600, 300, 150, 75, 37.5, 18.75 and 9.375 m, plus the edge ring described below.
function reliefRadius(radius: number, level: number): number {
  return radius / 2 ** Math.max(0, level - RELIEF_MIN_LEVEL);
}


const DETAIL_MIN_LEVEL = 8;
// MoonHeights switches to the polar maps (80 m, or 240 m when detail is off) south of true -80°.
const DETAIL_LAT = -80;
const DETAIL_Y = Math.sin(-DETAIL_LAT * DEG); // true lat < -80° <=> display Y > sin(80°)
// Largest height difference we measured between the 80 m polar map and its 240 m overview
// (median 1.3 m, 99.9 % below 17 m, max 40 m). Level-7 tiles (drawn from the overview) next to
// 80 m tiles need skirts at least this long so no crack opens where the two data sets disagree.
const DATASET_STEP_M = 40;
// The part of a skirt that is a guess (for neighbours several levels finer) is never made longer than
// Cesium's usual choice, 5x the level's geometric error. Measured gaps are never cut short.
const SKIRT_CAP_FACTOR = 5;

// Cesium's own "a download finished" signal. Every Cesium scene listens for it and draws one more
// frame, which our scene (requestRenderMode: it only draws when asked) needs so that tiles waiting
// for 80 m map files get asked for again. Cesium exports RequestScheduler but leaves it out of its
// TypeScript definitions.
const downloadFinished = (Cesium as unknown as { RequestScheduler: { requestCompletedEvent: Event } })
  .RequestScheduler.requestCompletedEvent;

// ---- Tables shared by every tile -------------------------------------------------------------

// Quantized position of vertex i along a side (Cesium decodes it as lerp(west, east, Q[i] / 32767)).
const Q = new Uint16Array(N);
for (let i = 0; i < N; i++) Q[i] = Math.round((i / (N - 1)) * MAX_Q);

// Fraction across the tile for sample s (s = vertex index + 1). We sample heights exactly where
// Cesium will draw each vertex. The outer ring sits exactly on the neighbouring tile's second
// vertex, so two tiles side by side compute the same normal for the vertices they share.
const F = new Float64Array(S);
for (let i = 0; i < N; i++) F[i + 1] = Q[i] / MAX_Q;
F[0] = (Q[N - 2] - MAX_Q) / MAX_Q;
F[S - 1] = 1 + Q[1] / MAX_Q;

// Fraction of each point halfway between two neighbouring vertices (used to size skirts).
const MID = new Float64Array(N - 1);
for (let i = 0; i < N - 1; i++) MID[i] = (F[i + 1] + F[i + 2]) / 2;

// Triangles: vertex v = row * 65 + column, row 0 = south edge, column 0 = west edge.
// Two counter-clockwise triangles per grid square (seen from above).
const INDICES = new Uint16Array((N - 1) * (N - 1) * 6);
{
  let t = 0;
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const sw = j * N + i, se = sw + 1, nw = sw + N, ne = nw + 1;
    INDICES[t++] = sw; INDICES[t++] = se; INDICES[t++] = ne;
    INDICES[t++] = sw; INDICES[t++] = ne; INDICES[t++] = nw;
  }
}
// Edge vertex lists, already in the order Cesium wants (west/east by latitude, south/north by longitude).
const WEST: number[] = [], SOUTH: number[] = [], EAST: number[] = [], NORTH: number[] = [];
for (let t = 0; t < N; t++) { WEST.push(t * N); SOUTH.push(t); EAST.push(t * N + N - 1); NORTH.push((N - 1) * N + t); }

// Scratch space for a tile build (JavaScript runs one build at a time, start to finish).
const hs = new Float64Array(S * S); // height of every sample
const baseHs = new Float64Array(S * S); // unchanged LOLA heights: the analytical crater shader supplies their light
const pos = new Float64Array(S * S * 3); // 3D display-frame position of every sample
const tLatA = new Float64Array(S * S), tLonA = new Float64Array(S * S); // true lat/lon (deg) of every sample
const verts = new Float64Array(N * N * 3); // positions of the 65 x 65 vertices only
const cosLat = new Float64Array(S), sinLat = new Float64Array(S), cosLon = new Float64Array(S), sinLon = new Float64Array(S);
const edgeH = new Float64Array(N), edgeBase = new Float64Array(N), edgeCoarse = new Float64Array(N);
const normalScratch = new Cartesian3(), octScratch = new Cartesian2();
const occluder = new EllipsoidalOccluder(MOON_ELLIPSOID);
const rectScratch = new Rectangle();

/** True if a display rectangle, grown by `grow` radians on every side, reaches south of true -80°. */
function reachesDetailMap(rect: Rectangle, grow: number): boolean {
  // true latitude = asin(-Y) with display Y = cos(lat)·sin(lon), so the point of the rectangle
  // nearest the true pole has the display latitude nearest 0° and the display longitude nearest 90°E.
  const lat = Math.min(Math.max(0, rect.south - grow), rect.north + grow);
  const lon = Math.min(Math.max(Math.PI / 2, rect.west - grow), rect.east + grow);
  return Math.cos(lat) * Math.sin(lon) > DETAIL_Y;
}

/** Display lat/lon (radians) -> true lat/lon (deg): same maths as displayToTrueLatLon in frame.ts. */
function trueLatOf(dLat: number, dLon: number): number {
  return Math.asin(Math.max(-1, Math.min(1, -Math.cos(dLat) * Math.sin(dLon)))) / DEG;
}
function trueLonOf(dLat: number, dLon: number): number {
  return Math.atan2(Math.sin(dLat), Math.cos(dLat) * Math.cos(dLon)) / DEG;
}

/** Height at a DISPLAY lat/lon (radians). */
function heightAtDisplay(heights: MoonHeights, dLat: number, dLon: number, detail: boolean, relief: TerrainRelief | null = null): number {
  const h = heights.heightAt(trueLatOf(dLat, dLon), trueLonOf(dLat, dLon), detail);
  if (!relief) return h;
  const cl = Math.cos(dLat);
  return h + sampleRelief(relief, cl * Math.cos(dLon), cl * Math.sin(dLon), Math.sin(dLat), h);
}

/** Height at the vertex's final landing-frame coordinates; lighting positions stay unchanged. */
function sampleRelief(relief: TerrainRelief, X: number, Y: number, Z: number, h: number): number {
  const { east: E, north: Nn, origin: O } = relief.frame, rr = R + h;
  const dx = rr * X - O.x, dy = rr * Y - O.y, dz = rr * Z - O.z;
  const e = dx * E.x + dy * E.y + dz * E.z, n = dx * Nn.x + dy * Nn.y + dz * Nn.z;
  const de = X * E.x + Y * E.y + Z * E.z, dn = X * Nn.x + Y * Nn.y + Z * Nn.z;
  const lift = relief.heightAt(e, n);
  // A radial displacement also shifts east/north a little far from the spot.
  return relief.heightAt(e + lift * de, n + lift * dn);
}

/** Largest gap between edge heights `h` and a coarser tile's straight edge through every `step`-th point of `nodes`. */
function chordGap(h: Float64Array, nodes: Float64Array, step: number): number {
  let worst = 0;
  for (let a = 0; a < N - 1; a += step) {
    const ha = nodes[a], hb = nodes[a + step];
    for (let t = a; t <= a + step; t++) {
      const d = Math.abs(h[t] - (ha + ((hb - ha) * (t - a)) / step));
      if (d > worst) worst = d;
    }
  }
  return worst;
}

/** The field keeps its landing frame; only the area in which we make new fine tiles follows the rover. */
export interface TerrainRelief {
  centre: { lat: number; lon: number };
  ahead?: { lat: number; lon: number };
  radius: number;
  frame: { east: Cartesian3; north: Cartesian3; origin: Cartesian3 };
  heightAt(e: number, n: number): number;
  changed?: () => void;
}

// These are the small part of Cesium's private tile API needed to refresh terrain without throwing
// away the already-loaded Moon photos. Kept here so the rest of the app need not know its states.
interface SurfaceData {
  terrainState: number; terrainData?: QuantizedMeshTerrainData; mesh?: unknown; renderedMesh?: unknown; vertexArray?: unknown;
  boundingVolumeSourceTile?: unknown; boundingVolumeIsFromMesh: boolean;
  fill?: { destroy(): undefined };
  freeVertexArray(): void;
}
interface RefreshTile {
  x: number; y: number; level: number; state: number; renderable: boolean; upsampledFromParent: boolean;
  parent?: RefreshTile;
  clearPositionCache(): void;
  data?: SurfaceData;
}
interface RefreshSurface { forEachLoadedTile(visit: (tile: RefreshTile) => void): void; _tilesToRender?: RefreshTile[] }
interface PreparedData extends QuantizedMeshTerrainData {
  _mesh?: unknown;
  createMesh(options: Record<string, unknown>): Promise<unknown> | undefined;
}
interface PreparedTile {
  key: string; x: number; y: number; level: number; epoch: number; data?: PreparedData; mesh?: unknown;
  task?: Promise<unknown>; failed?: boolean; retryAt: number;
}
interface Upgrade { tile: RefreshTile; old: SurfaceData; oldData?: QuantizedMeshTerrainData; prepared: PreparedTile }
const PREPARED_LIMIT = 24, UPGRADE_LIMIT = 8, MESH_JOB_LIMIT = 2;

export class LolaTerrainProvider implements TerrainProvider {
  readonly tilingScheme = new GeographicTilingScheme({ ellipsoid: MOON_ELLIPSOID });
  readonly errorEvent: Event<TerrainProvider.ErrorEvent> = new Event();
  readonly credit = new Credit('NASA LRO LOLA heights');
  readonly hasWaterMask = false;
  readonly hasVertexNormals = true;
  readonly availability: TileAvailability | undefined = undefined;
  private heights: MoonHeights;
  private levelZeroError: number;
  // Tiles ("level/x/y") that were told "not yet" while their 80 m map files download. `settled`
  // means the download finished but some file is still missing (it failed): build anyway, with
  // heightAt falling back to the 240 m map there, rather than wait for ever.
  private waiting = new Map<string, { files: string[]; settled: boolean }>();
  private relief: TerrainRelief | null;
  private centreLat = NaN; private centreLon = NaN;
  private displayCentre = { lat: 0, lon: 0 };
  private pendingRefresh = new Set<RefreshTile>();
  private reliefSkirtData = new WeakSet<QuantizedMeshTerrainData>();
  private reliefOnlyData = new WeakSet<QuantizedMeshTerrainData>();
  private physicalData = new WeakSet<QuantizedMeshTerrainData>();
  private removeRefreshListener: (() => void) | undefined;
  private retireRefresh = new Set<RefreshTile>();
  private prepared = new Map<string, PreparedTile>();
  private upgrades = new Map<RefreshTile, Upgrade>();
  private epoch = 0;
  private meshJobs = 0;
  private removePrepareListener: (() => void) | undefined;
  private prepareRetry: ReturnType<typeof setTimeout> | undefined;

  constructor(heights: MoonHeights, relief: TerrainRelief | null = null) {
    this.heights = heights;
    this.relief = relief;
    this.levelZeroError = TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
      MOON_ELLIPSOID, N, this.tilingScheme.getNumberOfXTilesAtLevel(0));
    // Tiles asked for before the height files arrived were told "not yet": draw again once they are here.
    heights.ready.then(() => downloadFinished.raiseEvent(), () => {});
  }

  getLevelMaximumGeometricError(level: number): number { return this.levelZeroError / (1 << level); }
  loadTileDataAvailability(): undefined { return undefined; }

  /** Called under the black curtain. Existing coarse terrain and photos can stay in memory. */
  setRelief(relief: TerrainRelief | null): void {
    this.epoch++;
    this.prepared.clear(); this.upgrades.clear(); this.retireRefresh.clear();
    this.pendingRefresh.clear();
    this.removeRefreshListener?.(); this.removeRefreshListener = undefined;
    this.removePrepareListener?.(); this.removePrepareListener = undefined;
    if (this.prepareRetry !== undefined) clearTimeout(this.prepareRetry);
    this.prepareRetry = undefined;
    this.relief = relief;
    this.centreLat = this.centreLon = NaN;
  }

  /**
   * Cesium remembers an unavailable tile as an interpolated tile for ever. Refresh those tiles when
   * they first enter the rover's area, and all fine tiles when the landing frame changes. Waiting
   * meshes finish first: changing their state during a worker job would let an old result win later.
   * Only terrain is released; Cesium draws its ready parent while the replacement is being made.
   */
  refreshSceneTiles(scene: Scene, mode: 'changed' | 'moving' = 'moving'): number {
    const surface = (scene.globe as unknown as { _surface?: RefreshSurface })._surface;
    if (!surface) return 0;
    const protectedTiles = this.protectedTiles(surface);
    const refine: RefreshTile[] = [];
    const retired = new Set<RefreshTile>();
    if (mode === 'moving' && this.relief) surface.forEachLoadedTile(tile => {
      if (tile.data?.terrainData && this.physicalData.has(tile.data.terrainData)
        && !this.getTileDataAvailable(tile.x, tile.y, tile.level) && !protectedTiles.has(tile)) retired.add(tile);
    });
    surface.forEachLoadedTile(tile => {
      if (tile.level < DETAIL_MIN_LEVEL || !tile.data) return;
      // Old high-detail grids behind the rover otherwise stay real for ever, including the
      // cut-up children made from them. Reuse the photos, but return that distant branch to its
      // coarser mesh. Its crater field stays pinned to exactly the same landing coordinates.
      let oldBranch = retired.has(tile);
      for (let parent = tile.parent; !oldBranch && parent && parent.level >= RELIEF_MIN_LEVEL; parent = parent.parent) oldBranch = retired.has(parent);
      if (oldBranch) { this.pendingRefresh.add(tile); this.retireRefresh.add(tile); return; }
      // An upsample worker can still be running before Cesium sets upsampledFromParent. Its
      // parent's data mask has already chosen that old path, so include unfinished tiles too.
      // Cesium's tile flag also includes imagery: a new photo can make it false while the
      // terrain is still a cut-up parent. Ask the terrain data itself as well.
      const terrain = tile.data.terrainData;
      // A real source can be waiting for a mesh or its draw handle. Do not throw that new work
      // away just because it has not reached READY yet; only old cut-up or empty data need help.
      const interpolated = terrain ? terrain.wasCreatedByUpsampling()
        : tile.upsampledFromParent || tile.data.terrainState !== 6;
      const reliefEdge = tile.level === MAX_LEVEL && (this.reliefSkirtData.has(tile.data.terrainData!)
        || (this.relief && this.reachesRelief(this.tilingScheme.tileXYToRectangle(tile.x, tile.y, tile.level), true)));
      // Away from the polar map, relief also needs real L8–11 ancestors. Return those tiles to
      // their original cut-up meshes on exit; unfinished jobs are included before their data arrives.
      const reliefOnly = this.reliefOnlyData.has(tile.data.terrainData!);
      if (mode === 'changed' && (tile.level >= RELIEF_MIN_LEVEL || reliefEdge || reliefOnly || (interpolated
        && (tile.data.terrainState !== 6 || this.getTileDataAvailable(tile.x, tile.y, tile.level))))) {
        this.pendingRefresh.add(tile); this.retireRefresh.delete(tile);
      }
      else if (this.relief && tile.level <= RELIEF_MAX_LEVEL
        && this.getTileDataAvailable(tile.x, tile.y, tile.level)) {
        // Cesium may keep drawing an old cut-up descendant and stop advancing its real parent.
        // Finish that support parent from our prepared mesh instead of leaving it at RECEIVED
        // or TRANSFORMED for ever. Neither state has a worker that could overwrite the swap.
        const finishSource = terrain && !terrain.wasCreatedByUpsampling() && protectedTiles.has(tile)
          && (tile.data.terrainState === 3 || tile.data.terrainState === 5);
        if (finishSource || (interpolated && tile.data.terrainState === 6 && tile.data.renderedMesh)) refine.push(tile);
        else if (interpolated && !tile.data.renderedMesh && tile.data.terrainState !== 2 && tile.data.terrainState !== 4) this.pendingRefresh.add(tile);
      }
    });
    // Finish the wheel's own chain before spending slots on the surrounding ring. Its parents
    // still go first, because a cached cut-up parent can hide its real children from Cesium.
    refine.sort((a, b) => this.roverPriority(a) - this.roverPriority(b) || a.level - b.level);
    for (const tile of refine) this.queueUpgrade(tile);
    if (this.upgrades.size) this.ensurePrepare(scene);
    const refreshed = this.finishRefresh(scene);
    if (this.pendingRefresh.size && !this.removeRefreshListener) {
      this.removeRefreshListener = scene.postRender.addEventListener(() => {
        if (this.finishRefresh(scene)) scene.requestRender();
        if (!this.pendingRefresh.size) { this.removeRefreshListener?.(); this.removeRefreshListener = undefined; }
      });
    }
    if (refreshed) scene.requestRender();
    return refreshed;
  }

  private protectedTiles(surface: RefreshSurface): Set<RefreshTile> {
    const protectedTiles = new Set<RefreshTile>();
    for (const drawn of surface._tilesToRender ?? []) for (let tile: RefreshTile | undefined = drawn; tile; tile = tile.parent) protectedTiles.add(tile);
    return protectedTiles;
  }

  private finishRefresh(scene: Scene): number {
    let refreshed = 0;
    const surface = (scene.globe as unknown as { _surface?: RefreshSurface })._surface;
    const protectedTiles = surface ? this.protectedTiles(surface) : new Set<RefreshTile>();
    for (const tile of this.pendingRefresh) {
      const data = tile.data;
      if (!data) { this.pendingRefresh.delete(tile); this.retireRefresh.delete(tile); continue; }
      if (this.retireRefresh.has(tile) && protectedTiles.has(tile)) {
        this.pendingRefresh.delete(tile); this.retireRefresh.delete(tile); continue;
      }
      // 2 = receiving, 4 = mesh worker running. All other states have no asynchronous owner.
      if (data.terrainState === 2 || data.terrainState === 4) continue;
      data.freeVertexArray();
      data.fill = data.fill?.destroy();
      data.terrainData = undefined; data.mesh = undefined;
      data.boundingVolumeSourceTile = undefined; data.boundingVolumeIsFromMesh = false;
      // TerrainState: FAILED=0 (upsample), UNLOADED=1 (ask the provider). Tile state 1 is LOADING.
      data.terrainState = this.getTileDataAvailable(tile.x, tile.y, tile.level) ? 1 : 0;
      tile.state = 1; tile.renderable = false; tile.upsampledFromParent = false;
      for (let parent: RefreshTile | undefined = tile; parent; parent = parent.parent) parent.clearPositionCache();
      this.pendingRefresh.delete(tile); this.retireRefresh.delete(tile); refreshed++;
    }
    return refreshed;
  }

  /** Prepare a short path before the wheels reach it. Safe to call about four times a second. */
  prepareAhead(scene: Scene): void {
    if (!this.relief) return;
    this.refreshSceneTiles(scene, 'moving');
    const surface = (scene.globe as unknown as { _surface?: RefreshSurface })._surface;
    const ready = new Set<string>();
    surface?.forEachLoadedTile(tile => {
      if (tile.data?.terrainState === 6 && tile.data.mesh && tile.data.terrainData
        && !tile.data.terrainData.wasCreatedByUpsampling()) ready.add(`${tile.level}/${tile.x}/${tile.y}`);
    });
    const from = trueToDisplayLatLon(this.relief.centre.lat, this.relief.centre.lon);
    const end = this.relief.ahead ?? this.relief.centre, to = trueToDisplayLatLon(end.lat, end.lon);
    const turn = Math.atan2(Math.sin(to.lon - from.lon), Math.cos(to.lon - from.lon));
    for (const t of [0, 0.5, 1]) {
      const c = new Cesium.Cartographic(from.lon + turn * t, CMath.lerp(from.lat, to.lat, t));
      for (let level = DETAIL_MIN_LEVEL; level <= RELIEF_MAX_LEVEL; level++) {
        const xy = this.tilingScheme.positionToTileXY(c, level);
        if (!xy) continue;
        const reach = level === RELIEF_MAX_LEVEL ? 1 : 0;
        for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) {
          const x = xy.x + dx, y = xy.y + dy, key = `${level}/${x}/${y}`;
          if (!ready.has(key) && this.getTileDataAvailable(x, y, level)) this.preparedTile(x, y, level);
        }
      }
    }
    this.ensurePrepare(scene);
  }

  private preparedTile(x: number, y: number, level: number): PreparedTile | undefined {
    const key = `${level}/${x}/${y}`, existing = this.prepared.get(key);
    if (existing && !existing.failed) return existing;
    if (existing) this.prepared.delete(key);
    if (this.prepared.size >= PREPARED_LIMIT) {
      const used = new Set([...this.upgrades.values()].map(u => u.prepared));
      const stale = [...this.prepared.values()].filter(p => (!p.task || p.mesh || p.failed) && !used.has(p))
        .sort((a, b) => this.roverPriority(b) - this.roverPriority(a))[0];
      if (!stale) return undefined;
      this.prepared.delete(stale.key);
    }
    const entry: PreparedTile = { key, x, y, level, epoch: this.epoch, retryAt: 0 };
    this.prepared.set(key, entry);
    return entry;
  }

  private queueUpgrade(tile: RefreshTile): void {
    if (this.upgrades.has(tile) || this.upgrades.size >= UPGRADE_LIMIT || !tile.data) return;
    const prepared = this.preparedTile(tile.x, tile.y, tile.level);
    if (prepared) this.upgrades.set(tile, { tile, old: tile.data, oldData: tile.data.terrainData, prepared });
  }

  private ensurePrepare(scene: Scene): void {
    if (!this.removePrepareListener) this.removePrepareListener = scene.postRender.addEventListener(() => this.prepareWork(scene));
    scene.requestRender();
  }

  /** The current wheel patch comes before a prediction or the distant edge ring. */
  private roverPriority(tile: { x: number; y: number; level: number }): number {
    if (!this.relief) return 2;
    const c = trueToDisplayLatLon(this.relief.centre.lat, this.relief.centre.lon);
    const rect = this.tilingScheme.tileXYToRectangle(tile.x, tile.y, tile.level);
    const insideLon = [c.lon, c.lon - 2 * Math.PI, c.lon + 2 * Math.PI].some(lon => lon >= rect.west && lon <= rect.east);
    const latGap = Math.max(0, rect.south - c.lat, c.lat - rect.north);
    const lonGap = insideLon ? 0 : Math.min(Math.abs(Math.atan2(Math.sin(c.lon - rect.west), Math.cos(c.lon - rect.west))),
      Math.abs(Math.atan2(Math.sin(c.lon - rect.east), Math.cos(c.lon - rect.east))));
    if (latGap === 0 && lonGap === 0) return 0;
    return Math.hypot(latGap, lonGap * Math.cos(c.lat)) * R <= 2 ? 1 : 2;
  }

  private prepareWork(scene: Scene): void {
    if (!this.relief) return;
    const deadline = performance.now() + 2;
    let swapped = false;
    for (const [tile, upgrade] of this.upgrades) {
      const p = upgrade.prepared, data = tile.data;
      if (p.epoch !== this.epoch || p.failed || data !== upgrade.old || data?.terrainData !== upgrade.oldData) {
        this.upgrades.delete(tile); continue;
      }
      if (!this.getTileDataAvailable(tile.x, tile.y, tile.level)) {
        // A turn can make yesterday's prediction obsolete while its worker is still running.
        // Keep the old drawn mesh instead of installing extra detail outside the new path.
        this.upgrades.delete(tile); this.prepared.delete(p.key); continue;
      }
      if (!p.mesh || !p.data || ![3, 5, 6].includes(data.terrainState)) continue;
      const maker = Object.getPrototypeOf(data).constructor as {
        _createVertexArrayForMesh(context: unknown, mesh: unknown): unknown;
      };
      // The replacement exists before the old draw resource is released. Doing this after the
      // frame also keeps the mesh read by physics paired with the vertex array that was drawn.
      const vertexArray = maker._createVertexArrayForMesh((scene as unknown as { context: unknown }).context, p.mesh);
      data.freeVertexArray(); data.fill = data.fill?.destroy();
      data.vertexArray = vertexArray; data.mesh = p.mesh; data.terrainData = p.data;
      data.terrainState = 6;
      data.boundingVolumeSourceTile = undefined; data.boundingVolumeIsFromMesh = false;
      tile.renderable = true; tile.state = 1; tile.upsampledFromParent = false;
      this.resetOldCuts(scene, tile);
      for (let parent: RefreshTile | undefined = tile; parent; parent = parent.parent) parent.clearPositionCache();
      this.upgrades.delete(tile); this.prepared.delete(p.key);
      swapped = true;
      this.relief.changed?.(); scene.requestRender();
      if (performance.now() >= deadline) break;
    }
    // A parent swap exposes more old cuts. Pick those up now rather than add a 250 ms wait at
    // every level of the cold Apollo chain. Keep this outside the upgrades Map iteration.
    if (swapped) this.refreshSceneTiles(scene, 'moving');
    if (performance.now() >= deadline) { scene.requestRender(); return; }
    const urgent = new Set([...this.upgrades.values()].map(u => u.prepared));
    // Have the wheel patch ready before its source is first visited. Preparing the whole cold
    // L8–17 chain first made Apollo wait ten extra frame turns for its finest mesh. This changes
    // mesh dispatch only; the parent-first upgrade queue and the two-worker cap stay the same.
    const work = [...this.prepared.values()].filter(p => p.epoch === this.epoch && !p.failed && !p.mesh)
      .map(p => ({ p, priority: this.roverPriority(p) }))
      .sort((a, b) => Number(b.p.level === RELIEF_MAX_LEVEL && b.priority < 2) - Number(a.p.level === RELIEF_MAX_LEVEL && a.priority < 2)
        || a.priority - b.priority || Number(urgent.has(b.p)) - Number(urgent.has(a.p)) || a.p.level - b.p.level)
      .map(({ p }) => p);
    let starts = 0;
    for (const p of work) {
      if (p.task || p.retryAt > performance.now()) continue;
      // A quick first grid should not leave the second worker idle for a whole frame. Tile
      // builds cannot be interrupted, so check the slice before each additional start.
      if (starts >= MESH_JOB_LIMIT || this.meshJobs >= MESH_JOB_LIMIT || performance.now() >= deadline) break;
      starts++;
      if (!p.data) {
        const data = this.buildTileData(p.x, p.y, p.level);
        if (!data) { p.retryAt = performance.now() + 200; continue; }
        p.data = data as PreparedData;
        const original = p.data.createMesh.bind(p.data);
        // Cesium frees the raw arrays after createMesh. A warmed tile can be requested again by
        // its normal loader, so return the same ready mesh or task instead of building it twice.
        p.data.createMesh = options => {
          if (p.data?._mesh) return Promise.resolve(p.data._mesh);
          if (p.task) return p.task;
          if (this.meshJobs >= MESH_JOB_LIMIT) return undefined;
          const task = original({ ...options, throttle: false });
          if (!task) return undefined;
          this.meshJobs++;
          p.task = Promise.resolve(task).then(mesh => {
            if (p.epoch === this.epoch) p.mesh = mesh;
            return mesh;
          }, error => { p.failed = true; throw error; }).finally(() => {
            this.meshJobs--; if (p.epoch === this.epoch) scene.requestRender();
          });
          return p.task;
        };
      }
      if (this.meshJobs < MESH_JOB_LIMIT) {
        const task = p.data.createMesh({ tilingScheme: this.tilingScheme, x: p.x, y: p.y, level: p.level, throttle: false });
        void task?.catch(() => { /* keep the old mesh; a later pass can try again */ });
      }
      scene.requestRender();
    }
    if (work.length && !this.prepareRetry && work.some(p => !p.task && p.retryAt > performance.now())) {
      const epoch = this.epoch;
      this.prepareRetry = setTimeout(() => {
        this.prepareRetry = undefined;
        if (epoch === this.epoch && this.relief && !scene.isDestroyed()) scene.requestRender();
      }, 210);
    }
  }

  private resetOldCuts(scene: Scene, source: RefreshTile): void {
    const surface = (scene.globe as unknown as { _surface?: RefreshSurface })._surface;
    surface?.forEachLoadedTile(tile => {
      if (tile === source || !tile.data) return;
      const old = tile.data;
      if (old.terrainData && !old.terrainData.wasCreatedByUpsampling()) return;
      let ancestor = tile.parent;
      while (ancestor && ancestor !== source) {
        if (ancestor.data?.terrainData && !ancestor.data.terrainData.wasCreatedByUpsampling()) return;
        ancestor = ancestor.parent;
      }
      if (ancestor !== source) return;
      const Constructor = Object.getPrototypeOf(old).constructor as new () => SurfaceData;
      const fresh = new Constructor();
      const a = old as unknown as Record<string, unknown>, b = fresh as unknown as Record<string, unknown>;
      // The bounding region is NOT carried over. A new surface object starts with its horizon point
      // at (0, 0, 0), which Cesium reads as "behind the Moon", and only works the point out again
      // when it has to rebuild the region. With the old region copied in, a tile waiting to be cut
      // from its parent kept the zero point, was culled, and a culled tile is never loaded: a hole
      // in the far ground that showed the stars (Tycho's floor seen from its wall).
      for (const key of ['imagery', 'waterMaskTexture', 'waterMaskTranslationAndScale', 'vectorData', 'clippingPolygonData', 'isClipped', 'clippedByBoundaries']) b[key] = a[key];
      // Old worker promises close over `old`, not the new surface object. They can finish safely
      // without putting an obsolete cut-up mesh back under the wheels after this replacement.
      a.imagery = []; a.waterMaskTexture = a.vectorData = a.clippingPolygonData = undefined;
      old.freeVertexArray(); old.fill = old.fill?.destroy();
      fresh.terrainState = this.getTileDataAvailable(tile.x, tile.y, tile.level) ? 1 : 0;
      tile.data = fresh; tile.state = 1; tile.renderable = false; tile.upsampledFromParent = false;
      tile.clearPositionCache();
      this.pendingRefresh.delete(tile); this.retireRefresh.delete(tile); this.upgrades.delete(tile);
    });
  }

  /** Exact nearest distance from the moving centre to a display-frame spherical rectangle. */
  private reachesRelief(rect: Rectangle, ring = false, level = RELIEF_MIN_LEVEL): boolean {
    const relief = this.relief;
    if (!relief) return false;
    const { lat, lon } = relief.centre;
    if (lat !== this.centreLat || lon !== this.centreLon) {
      this.centreLat = lat; this.centreLon = lon;
      this.displayCentre = trueToDisplayLatLon(lat, lon);
    }
    const c = this.displayCentre;
    const growLat = ring ? rect.north - rect.south : 0, growLon = ring ? rect.east - rect.west : 0;
    const south = Math.max(-Math.PI / 2, rect.south - growLat), north = Math.min(Math.PI / 2, rect.north + growLat);
    const west = rect.west - growLon, east = rect.east + growLon;
    const wrapDistance = (a: number) => Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
    const closest = (sl: number, cl: number, lon: number) => {
      const inside = [lon, lon - 2 * Math.PI, lon + 2 * Math.PI].some(v => v >= west && v <= east);
      const dLon = inside ? 0 : Math.min(wrapDistance(lon - west), wrapDistance(lon - east)), cd = Math.cos(dLon);
      const nearestLat = Math.max(south, Math.min(north, Math.atan2(sl, cl * cd)));
      return sl * Math.sin(nearestLat) + cl * Math.cos(nearestLat) * cd;
    };
    const sl = Math.sin(c.lat), cl = Math.cos(c.lat), radius = reliefRadius(relief.radius, level);
    const atStart = closest(sl, cl, c.lon);
    if (atStart >= Math.cos(radius / R)) return true;
    if (!relief.ahead) return false;
    const a = trueToDisplayLatLon(relief.ahead.lat, relief.ahead.lon), ac = Math.cos(a.lat);
    const x0 = cl * Math.cos(c.lon), y0 = cl * Math.sin(c.lon), z0 = sl;
    const x1 = ac * Math.cos(a.lon), y1 = ac * Math.sin(a.lon), z1 = Math.sin(a.lat);
    const lead = 2 * R * Math.asin(Math.min(1, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2));
    // A teleport is not a prediction. Keep lookahead bounded even if a caller hands us an old pose.
    if (lead < 0.05 || lead > 40 || atStart < Math.cos((radius + lead + 0.1) / R)) return false;
    const along = (t: number) => {
      const x = CMath.lerp(x0, x1, t), y = CMath.lerp(y0, y1, t), z = CMath.lerp(z0, z1, t), inv = 1 / Math.hypot(x, y, z);
      return closest(z * inv, Math.hypot(x, y) * inv, Math.atan2(y, x));
    };
    if (along(1) >= Math.cos(radius / R)) return true;
    // Distance to this short spherical segment is unimodal. Its 5 cm allowance covers the
    // search's final interval; no extra ground is added when the rover is standing still.
    let lo = 0, hi = 1;
    for (let i = 0; i < 16; i++) {
      const p = (2 * lo + hi) / 3, q = (lo + 2 * hi) / 3;
      if (along(p) > along(q)) hi = q; else lo = p;
    }
    return along((lo + hi) / 2) >= Math.cos((radius + 0.05) / R);
  }

  /**
   * Levels 0-7 everywhere. Levels 8-11 for tiles that reach the 80 m map (true lat < -80°) AND for
   * the ring of same-size tiles around them (the test grows the tile by its own size on every side).
   *
   * Why the ring: where a tile is not available, Cesium cuts its parent's mesh into pieces instead,
   * and gives each new piece's inner edges half the parent's shortest skirt (halving again every
   * level). If such a piece sat right next to a real 80 m tile, the two would show different data
   * (80 m vs 240 m) with a skirt far too short to hide the crack between them. With the ring, a real
   * tile only ever meets a cut-up tile a whole tile away from the 80 m map, where both show the same
   * smooth global map, and that cut-up tile is always a direct child of a real tile (an available
   * tile's parent is always available too), so its skirts can be sized by that parent (see build()).
   */
  getTileDataAvailable(x: number, y: number, level: number): boolean {
    if (level <= GLOBAL_MAX_LEVEL) return true;
    if (level > RELIEF_MAX_LEVEL) return false;
    const rect = this.tilingScheme.tileXYToRectangle(x, y, level, rectScratch);
    // One tile of overlap gives an unavailable neighbour an available direct parent. Without it,
    // its cut-up inner skirt could have halved many times and leave a hole beside a real bowl.
    if (this.reachesRelief(rect, true, level)) return true;
    return level <= MAX_LEVEL && reachesDetailMap(rect, rect.north - rect.south);
  }

  /**
   * Builds the tile now (about 1 ms, inside Cesium's per-frame time budget) and hands it over as an
   * already-finished promise. Returns undefined ("ask again on a later frame") while the height files,
   * or the 80 m map files this tile reads, are still downloading.
   */
  requestTileGeometry(x: number, y: number, level: number): Promise<QuantizedMeshTerrainData> | undefined {
    const key = `${level}/${x}/${y}`, prepared = this.prepared.get(key);
    if (prepared?.data && prepared.epoch === this.epoch && !prepared.failed) {
      this.prepared.delete(key);
      return Promise.resolve(prepared.data);
    }
    const data = this.buildTileData(x, y, level);
    return data ? Promise.resolve(data) : undefined;
  }

  private buildTileData(x: number, y: number, level: number): QuantizedMeshTerrainData | undefined {
    if (!this.heights.global || !this.heights.overview) return undefined;
    const rect = this.tilingScheme.tileXYToRectangle(x, y, level);
    // A queued tile may be built after the rover has moved away. Its data must still agree with
    // its neighbours, so an active surface provider always uses the same LOLA source at this level.
    const detail = level >= DETAIL_MIN_LEVEL && (!!this.relief || this.getTileDataAvailable(x, y, level));
    if (detail && !this.detailFilesReady(`${level}/${x}/${y}`, rect)) return undefined;
    return this.build(x, y, level, rect, detail);
  }

  /** True when every 80 m map file the tile reads is in memory; otherwise starts the download (once). */
  private detailFilesReady(id: string, rect: Rectangle): boolean {
    const heights = this.heights;
    const asked = this.waiting.get(id);
    if (asked) {
      if (!asked.settled && !asked.files.every(f => heights.tiles.has(f))) return false;
      this.waiting.delete(id);
      return true;
    }
    const need = this.detailFiles(rect);
    if (!need || need.files.every(f => heights.tiles.has(f))) return true;
    const entry = { files: need.files, settled: false };
    this.waiting.set(id, entry);
    const done = () => {
      // Normally every file is here now; forget the tile (if Cesium still wants it, it asks again).
      if (entry.files.every(f => heights.tiles.has(f))) this.waiting.delete(id);
      else entry.settled = true;
      downloadFinished.raiseEvent();
    };
    const [x0, y0, x1, y1] = need.box;
    heights.loadTiles(x0, y0, x1, y1, need.files.length).then(done, done);
    return false;
  }

  /**
   * The 80 m map files ("column_row", as MoonHeights.loadTiles names them) under a tile and its outer
   * ring of samples, and their box in polar-map metres (padded by two 80 m pixels for the bilinear
   * neighbours). Null if no sample lies south of true -80°: heightAt never reads the 80 m map there.
   */
  private detailFiles(rect: Rectangle): { files: string[]; box: [number, number, number, number] } | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, inside = false;
    const add = (fLat: number, fLon: number) => {
      const dLat = CMath.lerp(rect.south, rect.north, fLat), dLon = CMath.lerp(rect.west, rect.east, fLon);
      const lat = trueLatOf(dLat, dLon);
      if (lat < DETAIL_LAT) inside = true;
      const [mx, my] = toMap(lat, trueLonOf(dLat, dLon));
      x0 = Math.min(x0, mx); x1 = Math.max(x1, mx); y0 = Math.min(y0, my); y1 = Math.max(y1, my);
    };
    // The tile is small and the 80 m area a big disc, so if any sample is inside it, an edge one is.
    for (let s = 0; s < S; s++) { add(F[0], F[s]); add(F[S - 1], F[s]); add(F[s], F[0]); add(F[s], F[S - 1]); }
    if (!inside) return null;
    x0 -= 160; y0 -= 160; x1 += 160; y1 += 160;
    // Same file grid as MoonHeights.loadTiles.
    const t = this.heights.meta!.tiles, span = t.tileSize * t.res;
    const c0 = Math.max(0, Math.floor((x0 - t.min) / span)), c1 = Math.min(t.count - 1, Math.floor((x1 - t.min) / span));
    const r0 = Math.max(0, Math.floor((t.max - y1) / span)), r1 = Math.min(t.count - 1, Math.floor((t.max - y0) / span));
    const files: string[] = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) files.push(`${c}_${r}`);
    return { files, box: [x0, y0, x1, y1] };
  }

  /** Builds one tile's mesh. Fully synchronous, so the shared scratch arrays are safe to use. */
  private build(x: number, y: number, level: number, rect: Rectangle, detail: boolean): QuantizedMeshTerrainData {
    const heights = this.heights;
    const { west, east, south, north } = rect;
    const relief = level >= RELIEF_MIN_LEVEL ? this.relief : null;

    // 1. Heights and 3D positions of all 67 x 67 samples (vertices + outer ring).
    for (let s = 0; s < S; s++) {
      const lat = CMath.lerp(south, north, F[s]), lon = CMath.lerp(west, east, F[s]);
      cosLat[s] = Math.cos(lat); sinLat[s] = Math.sin(lat); cosLon[s] = Math.cos(lon); sinLon[s] = Math.sin(lon);
    }
    let minTrueLat = 90;
    for (let r = 0; r < S; r++) {
      const cl = cosLat[r], Z = sinLat[r];
      for (let c = 0; c < S; c++) {
        // display unit vector -> true lat/lon (identical maths to displayToTrueLatLon in frame.ts)
        const X = cl * cosLon[c], Y = cl * sinLon[c];
        const k = r * S + c;
        const tLat = Math.asin(Math.max(-1, Math.min(1, -Y))) / DEG, tLon = Math.atan2(Z, X) / DEG;
        const h = heights.heightAt(tLat, tLon, detail);
        tLatA[k] = tLat; tLonA[k] = tLon; baseHs[k] = hs[k] = h;
        if (tLat < minTrueLat) minTrueLat = tLat;
        const rr = R + h;
        pos[3 * k] = rr * X; pos[3 * k + 1] = rr * Y; pos[3 * k + 2] = rr * Z;
        if (relief) hs[k] += sampleRelief(relief, X, Y, Z, h);
      }
    }

    // 2. Height range of the real vertices (not the ring).
    let minH = Infinity, maxH = -Infinity;
    for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++) {
      const h = hs[j * S + i];
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
    const range = maxH - minH;

    // 3. Quantized vertices, normals and the plain vertex list for bounding volumes.
    const nv = N * N;
    const qv = new Uint16Array(nv * 3);
    const normals = new Uint8Array(nv * 2);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const v = j * N + i, k = (j + 1) * S + (i + 1), k3 = 3 * k;
      qv[v] = Q[i];
      qv[nv + v] = Q[j];
      qv[2 * nv + v] = range > 0 ? Math.round(((hs[k] - minH) / range) * MAX_Q) : 0;
      const lift = relief ? (R + hs[k]) / (R + baseHs[k]) : 1;
      verts[3 * v] = pos[k3] * lift; verts[3 * v + 1] = pos[k3 + 1] * lift; verts[3 * v + 2] = pos[k3 + 2] * lift;

      // Normal = (west->east step) x (south->north step), straight from the 3D positions, so it is
      // already in the display frame Cesium lights in. Edge vertices use the outer ring. The
      // positions here keep the LOLA heights: the ground shader already supplies crater slopes,
      // and including them here as well would shade each bowl twice.
      const e = k3 + 3, w = k3 - 3, n = k3 + 3 * S, s = k3 - 3 * S;
      const ax = pos[e] - pos[w], ay = pos[e + 1] - pos[w + 1], az = pos[e + 2] - pos[w + 2];
      const bx = pos[n] - pos[s], by = pos[n + 1] - pos[s + 1], bz = pos[n + 2] - pos[s + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      let len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(ax * ax + ay * ay + az * az > 1e-6 * (bx * bx + by * by + bz * bz)) || !(len > 0)) {
        // At Cesium's own poles (two points on the lunar limb) a whole row of vertices is one point
        // and has no west->east direction: use straight up there.
        nx = pos[k3]; ny = pos[k3 + 1]; nz = pos[k3 + 2];
        len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      }
      normalScratch.x = nx / len; normalScratch.y = ny / len; normalScratch.z = nz / len;
      AttributeCompression.octEncode(normalScratch, octScratch);
      normals[2 * v] = octScratch.x; normals[2 * v + 1] = octScratch.y;
    }

    // 4. Bounding volumes and the horizon point (if that point is hidden behind the Moon, so is the tile).
    const boundingSphere = BoundingSphere.fromVertices(verts, Cartesian3.ZERO, 3);
    const orientedBoundingBox = OrientedBoundingBox.fromRectangle(rect, minH, maxH, MOON_ELLIPSOID);
    // Only the two level-0 tiles (each half the Moon) have no such point. Cesium then simply never
    // horizon-culls a tile; a point made of NaN gives exactly that (every "is it hidden?" test on it
    // is false) while still being the object QuantizedMeshTerrainData insists on.
    const horizonOcclusionPoint = (occluder.computeHorizonCullingPointFromVerticesPossiblyUnderEllipsoid(
      boundingSphere.center, verts, 3, Cartesian3.ZERO, minH, new Cartesian3()) as Cartesian3 | undefined) ?? new Cartesian3(NaN, NaN, NaN);

    // 5. Which of the four children have their own data (bits: 1 SW, 2 SE, 4 NW, 8 NE).
    let childTileMask = 0;
    if (level < (this.relief ? RELIEF_MAX_LEVEL : MAX_LEVEL)) {
      if (this.getTileDataAvailable(2 * x, 2 * y + 1, level + 1)) childTileMask |= 1;
      if (this.getTileDataAvailable(2 * x + 1, 2 * y + 1, level + 1)) childTileMask |= 2;
      if (this.getTileDataAvailable(2 * x, 2 * y, level + 1)) childTileMask |= 4;
      if (this.getTileDataAvailable(2 * x + 1, 2 * y, level + 1)) childTileMask |= 8;
    }

    // 6. Skirts sized from the data (see skirtHeight). Cesium's cut children get half of our
    // shortest skirt along their middle edges. A cached cut can remain next to a genuine child
    // even when all children are now available, or when a moving ring changed an old mask of 0.
    // While the surface is open, measure these inner gaps for every local source parent rather
    // than trust its child mask. The plain map keeps its established partial-mask rule.
    // Even if all our own children are cut up, a neighbouring parent's child can have real data.
    // Our outer skirts must therefore sample that finer field too.
    const finerRelief = level + 1 >= RELIEF_MIN_LEVEL && level < RELIEF_MAX_LEVEL
      && (level >= RELIEF_MIN_LEVEL || this.reachesRelief(rect, true)) ? this.relief : null;
    const canKeepCuts = !!this.relief && level >= DETAIL_MIN_LEVEL && level < RELIEF_MAX_LEVEL;
    const split = canKeepCuts || (childTileMask !== 0 && childTileMask !== 15)
      ? 2 * this.middleStep(rect, detail, finerRelief) : 0;
    const nearDetailMap = minTrueLat < DETAIL_LAT;
    // The ring guarantees a cut-up neighbour has a real direct parent. Its middle samples above
    // therefore measure that gap exactly: a full-depth curtain on every fine tile is unnecessary
    // and would fill much of the screen with hidden ground at grazing angles.
    const result = new QuantizedMeshTerrainData({
      quantizedVertices: qv,
      encodedNormals: normals,
      indices: INDICES,
      minimumHeight: minH,
      maximumHeight: maxH,
      boundingSphere,
      orientedBoundingBox,
      horizonOcclusionPoint,
      westIndices: WEST,
      southIndices: SOUTH,
      eastIndices: EAST,
      northIndices: NORTH,
      westSkirtHeight: this.skirtHeight(0, level, rect, detail, nearDetailMap, range, split, finerRelief),
      southSkirtHeight: this.skirtHeight(1, level, rect, detail, nearDetailMap, range, split, finerRelief),
      eastSkirtHeight: this.skirtHeight(2, level, rect, detail, nearDetailMap, range, split, finerRelief),
      northSkirtHeight: this.skirtHeight(3, level, rect, detail, nearDetailMap, range, split, finerRelief),
      childTileMask,
    });
    if (level === MAX_LEVEL && finerRelief) this.reliefSkirtData.add(result);
    if (this.relief && level >= DETAIL_MIN_LEVEL && level <= MAX_LEVEL
      && !reachesDetailMap(rect, rect.north - rect.south)) this.reliefOnlyData.add(result);
    if (relief) this.physicalData.add(result);
    return result;
  }

  /** Largest step between the straight lines along the tile's two middle lines and the ground halfway between their vertices. */
  private middleStep(rect: Rectangle, detail: boolean, relief: TerrainRelief | null): number {
    const heights = this.heights;
    const midLat = CMath.lerp(rect.south, rect.north, F[MIDDLE]), midLon = CMath.lerp(rect.west, rect.east, F[MIDDLE]);
    let worst = 0;
    for (let t = 0; t < N - 1; t++) {
      const lat = CMath.lerp(rect.south, rect.north, MID[t]), lon = CMath.lerp(rect.west, rect.east, MID[t]);
      const southNorth = Math.abs(heightAtDisplay(heights, lat, midLon, detail, relief) - (hs[(t + 1) * S + MIDDLE] + hs[(t + 2) * S + MIDDLE]) / 2);
      const westEast = Math.abs(heightAtDisplay(heights, midLat, lon, detail, relief) - (hs[MIDDLE * S + t + 1] + hs[MIDDLE * S + t + 2]) / 2);
      worst = Math.max(worst, southNorth, westEast);
    }
    return worst;
  }

  /**
   * Skirt length (m) for one edge (0 west, 1 south, 2 east, 3 north), just long enough to cover the
   * gap to a neighbouring tile drawn at another level of detail:
   * - a coarser neighbour (up to 4 levels) draws this edge as straight lines through every
   *   2nd/4th/8th/16th vertex (from the overview data if it is outside the 80 m levels), and those
   *   straight lines also sag below the curved surface by chord²/8R: that gap is MEASURED exactly;
   * - a neighbour one level finer adds bumps between our vertices: MEASURED exactly too (this also
   *   covers Cesium's cut-up children of this tile, which keep this skirt on their outer edges);
   * - for neighbours further down we GUESS 2.5x those bumps (plus the 80 m / 240 m data difference
   *   near the 80 m map); only this guess is capped at 5x the geometric error;
   * - at least `floor` (see build(), step 6);
   * - plus the 16-bit height rounding and 1 m.
   * Reads the scratch arrays just filled by build().
   */
  private skirtHeight(edge: 0 | 1 | 2 | 3, level: number, rect: Rectangle, detail: boolean, nearDetailMap: boolean,
    range: number, floor: number, finerRelief: TerrainRelief | null): number {
    const heights = this.heights;
    const vertical = edge === 0 || edge === 2; // west and east edges run south -> north
    const fixed = edge < 2 ? 1 : N; // sample column (west/east) or row (south/north) of the edge
    for (let t = 0; t < N; t++) {
      const k = vertical ? (t + 1) * S + fixed : fixed * S + (t + 1);
      edgeH[t] = hs[k];
      edgeBase[t] = baseHs[k];
      edgeCoarse[t] = detail ? heights.heightAt(tLatA[k], tLonA[k], false) : hs[k];
    }

    // distance between neighbouring vertices along this edge, for the chord sag
    const spacing = vertical
      ? (R * (rect.north - rect.south)) / (N - 1)
      : (R * Math.cos(edge === 1 ? rect.south : rect.north) * (rect.east - rect.west)) / (N - 1);
    let coarse = 0;
    for (let k = 1; k <= Math.min(level, 4); k++) {
      const step = 1 << k, sag = (step * spacing) ** 2 / (8 * R);
      // Fine neighbours use the same field; comparing them to bare LOLA would incorrectly make
      // every skirt as deep as the bowl even when both edges follow that bowl together.
      const sourceLevel = level - k;
      const nodes = this.relief && sourceLevel >= RELIEF_MIN_LEVEL ? edgeH
        : this.relief && sourceLevel >= DETAIL_MIN_LEVEL ? edgeBase : edgeCoarse;
      let gap = chordGap(edgeH, nodes, step);
      if (detail && (!this.relief || sourceLevel < DETAIL_MIN_LEVEL)) gap = Math.max(gap, chordGap(edgeH, edgeH, step));
      coarse = Math.max(coarse, gap + sag);
    }

    let bump = 0, guess = 0;
    if (level < MAX_LEVEL || finerRelief) {
      const a0 = vertical ? rect.south : rect.west, a1 = vertical ? rect.north : rect.east;
      const across = edge === 0 ? rect.west : edge === 1 ? rect.south : edge === 2 ? rect.east : rect.north;
      if (finerRelief) {
        // A one-metre bowl can lie wholly between a coarse tile's midpoint samples. Read every
        // vertex a neighbour up to four levels finer can add, rather than guess its depth from
        // the half-step alone. Fine tiles need fewer samples; L18 needs none because it is final.
        const parts = 1 << Math.min(4, RELIEF_MAX_LEVEL - level);
        for (let t = 0; t < N - 1; t++) for (let part = 1; part < parts; part++) {
          const f = part / parts, fraction = CMath.lerp(F[t + 1], F[t + 2], f);
          const a = CMath.lerp(a0, a1, fraction);
          const hm = vertical ? heightAtDisplay(heights, a, across, detail, finerRelief) : heightAtDisplay(heights, across, a, detail, finerRelief);
          const d = Math.abs(hm - CMath.lerp(edgeH[t], edgeH[t + 1], f));
          if (part * 2 === parts) bump = Math.max(bump, d);
          guess = Math.max(guess, d);
        }
      } else {
        for (let t = 0; t < N - 1; t++) {
          const a = CMath.lerp(a0, a1, MID[t]);
          const hm = vertical ? heightAtDisplay(heights, a, across, detail) : heightAtDisplay(heights, across, a, detail);
          bump = Math.max(bump, Math.abs(hm - (edgeH[t] + edgeH[t + 1]) / 2));
        }
        guess = Math.min(2.5 * bump + (!detail && nearDetailMap ? DATASET_STEP_M : 0),
          SKIRT_CAP_FACTOR * this.getLevelMaximumGeometricError(level));
      }
    }

    // Centimetres suffice on sub-metre meshes; keep the established 1 m pad on the NASA levels.
    const pad = this.relief && level >= RELIEF_MIN_LEVEL ? 0.02 + 0.008 * spacing : 1;
    return Math.max(coarse, bump, guess, floor) + range / MAX_Q + pad;
  }
}

/** The small part of a selected Cesium surface needed by the exact source-grid pick. */
export interface RegularSourceSurface {
  mesh?: unknown; renderedMesh?: unknown;
  terrainData?: { wasCreatedByUpsampling?(): boolean };
}
interface RegularSourceMesh {
  vertices: Float32Array; indices: ArrayLike<number>;
  vertexCountWithoutSkirts: number; indexCountWithoutSkirts: number;
  encoding: { getExaggeratedPosition(vertices: Float32Array, index: number, result: Cartesian3): Cartesian3 };
}
const gridPickChecked = new WeakMap<object, boolean>();
const gridPickVertices = Array.from({ length: 16 }, () => new Cartesian3());
const gridPickRadial = new Cartesian3(), gridPickCross = new Cartesian3();
const gridRayTriangle = (Cesium.IntersectionTests as unknown as {
  rayTriangleParametric(ray: Cesium.Ray, a: Cartesian3, b: Cartesian3, c: Cartesian3, cull: boolean): number | undefined;
}).rayTriangleParametric;

/**
 * Exact top-down triangle pick for this provider's genuine 65 x 65 grids. Cuts, fill, tile edges
 * and polar cells use Cesium's normal picker instead. Undefined always means "use that picker".
 * Cesium's decoder already returns world positions, including exaggeration: never add mesh.center.
 */
export function pickRegularSourceGrid(surface: RegularSourceSurface, rectangle: Rectangle, level: number,
  place: Cesium.Cartographic, ray: Cesium.Ray, result: Cartesian3): Cartesian3 | undefined {
  const raw = surface.mesh;
  if (!raw || typeof raw !== 'object' || raw !== surface.renderedMesh || level < DETAIL_MIN_LEVEL
    || Math.abs(place.latitude) >= 80 * DEG || rectangle.east <= rectangle.west
    || typeof surface.terrainData?.wasCreatedByUpsampling !== 'function' || surface.terrainData.wasCreatedByUpsampling()) return undefined;
  const mesh = raw as RegularSourceMesh;
  if (mesh.vertexCountWithoutSkirts !== N * N || mesh.indexCountWithoutSkirts !== INDICES.length
    || !mesh.vertices || !mesh.indices || mesh.indices.length < INDICES.length
    || typeof mesh.encoding?.getExaggeratedPosition !== 'function') return undefined;
  // The worker keeps our grid order. Check it once so another provider's coincidentally equal
  // vertex count cannot turn this into a guess about which triangles it draws.
  let regular = gridPickChecked.get(raw);
  if (regular === undefined) {
    regular = true;
    for (let i = 0; i < INDICES.length; i++) if (mesh.indices[i] !== INDICES[i]) { regular = false; break; }
    gridPickChecked.set(raw, regular);
  }
  if (!regular) return undefined;
  const u = (place.longitude - rectangle.west) / (rectangle.east - rectangle.west);
  const v = (place.latitude - rectangle.south) / (rectangle.north - rectangle.south);
  if (!(u > 0 && u < 1 && v > 0 && v < 1)) return undefined;
  let col = Math.floor(u * (N - 1)), row = Math.floor(v * (N - 1));
  while (col > 0 && u < Q[col] / MAX_Q) col--;
  while (col < N - 2 && u >= Q[col + 1] / MAX_Q) col++;
  while (row > 0 && v < Q[row] / MAX_Q) row--;
  while (row < N - 2 && v >= Q[row + 1] / MAX_Q) row++;
  if (col < 1 || col > N - 3 || row < 1 || row > N - 3) return undefined;
  // This helper is for the radial rays used to seat the rover and rocks, never camera rays.
  const cl = Math.cos(place.latitude);
  Cartesian3.fromElements(cl * Math.cos(place.longitude), cl * Math.sin(place.longitude), Math.sin(place.latitude), gridPickRadial);
  const directionLength = Cartesian3.magnitude(ray.direction);
  if (!(directionLength > 0) || Cartesian3.dot(ray.direction, gridPickRadial) >= 0
    || Cartesian3.magnitude(Cartesian3.cross(ray.direction, gridPickRadial, gridPickCross)) > directionLength * 1e-12
    || Cartesian3.magnitude(Cartesian3.cross(ray.origin, gridPickRadial, gridPickCross)) > 1e-5) return undefined;
  // Position compression and spherical chords can cross a UV cell boundary. Its eight neighbours
  // keep the candidate set conservative; the intersections themselves use the exact drawn vertices.
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    mesh.encoding.getExaggeratedPosition(mesh.vertices, (row - 1 + y) * N + col - 1 + x, gridPickVertices[y * 4 + x]);
  }
  let closest = Infinity;
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
    const sw = y * 4 + x, se = sw + 1, nw = sw + 4, ne = nw + 1;
    const a = gridRayTriangle(ray, gridPickVertices[sw], gridPickVertices[se], gridPickVertices[ne], false);
    const b = gridRayTriangle(ray, gridPickVertices[sw], gridPickVertices[ne], gridPickVertices[nw], false);
    if (a !== undefined && a >= 0) closest = Math.min(closest, a);
    if (b !== undefined && b >= 0) closest = Math.min(closest, b);
  }
  return Number.isFinite(closest) ? Cesium.Ray.getPoint(ray, closest, result) : undefined;
}

interface BinnedPickMesh extends RegularSourceMesh {
  encoding: RegularSourceMesh['encoding'] & {
    stride: number; exaggeration?: number; exaggerationRelativeHeight?: number;
  };
}
interface BinnedPickCache {
  positions: Float64Array; offsets: Uint32Array; triangles: Uint32Array; seen: Uint32Array; stamp: number;
}
interface BinnedPickEntry {
  vertices: Float32Array; indices: ArrayLike<number>; encoding: BinnedPickMesh['encoding'];
  stride: number; exaggeration: number | undefined; relativeHeight: number | undefined;
  west: number; south: number; east: number; north: number; cache?: BinnedPickCache;
}
const BIN_SIDE = 16, BIN_COUNT = BIN_SIDE * BIN_SIDE, BIN_PAD = 1e-12;
const binnedPicks = new WeakMap<object, BinnedPickEntry>();
const binPickPosition = new Cartesian3(), binPickRadial = new Cartesian3(), binPickCross = new Cartesian3();
const binPickA = new Cartesian3(), binPickB = new Cartesian3(), binPickC = new Cartesian3();
function pickBin(fraction: number): number { return Math.max(0, Math.min(BIN_SIDE - 1, Math.floor(fraction * BIN_SIDE))); }

/** Actual latitude extremum along a straight world-space triangle edge, when it lies inside it. */
function edgeLatitude(positions: Float64Array, i: number, j: number): number | undefined {
  // One common scale preserves the straight edge even when its endpoint heights differ.
  const ax = positions[i] / R, ay = positions[i + 1] / R, az = positions[i + 2] / R;
  const dx = (positions[j] - positions[i]) / R, dy = (positions[j + 1] - positions[i + 1]) / R;
  const dz = (positions[j + 2] - positions[i + 2]) / R;
  const aa = ax * ax + ay * ay + az * az, ad = ax * dx + ay * dy + az * dz;
  const dd = dx * dx + dy * dy + dz * dz, denominator = dz * ad - az * dd;
  if (denominator === 0) return undefined;
  const t = (az * ad - dz * aa) / denominator;
  if (!(t > 0 && t < 1)) return undefined;
  return Math.atan2(az + t * dz, Math.hypot(ax + t * dx, ay + t * dy));
}

function makeBinnedPick(mesh: BinnedPickMesh, rectangle: Rectangle): BinnedPickCache | undefined {
  const { vertices, indices, encoding } = mesh;
  const stride = encoding.stride, count = vertices.length / stride, triangleCount = indices.length / 3;
  // Keep a first pick bounded. Larger or unfamiliar meshes retain Cesium's picker.
  if (!Number.isInteger(stride) || stride < 3 || stride > 32 || !Number.isInteger(count) || count < 3 || count > 10_000
    || !Number.isInteger(triangleCount) || triangleCount < 1 || triangleCount > 20_000
    || !Number.isInteger(mesh.vertexCountWithoutSkirts) || mesh.vertexCountWithoutSkirts < 3 || mesh.vertexCountWithoutSkirts > count
    || !Number.isInteger(mesh.indexCountWithoutSkirts) || mesh.indexCountWithoutSkirts < 3
    || mesh.indexCountWithoutSkirts > indices.length || mesh.indexCountWithoutSkirts % 3 !== 0) return undefined;
  const positions = new Float64Array(count * 3), longitudes = new Float64Array(count), latitudes = new Float64Array(count);
  const width = rectangle.east - rectangle.west, height = rectangle.north - rectangle.south;
  const middle = (rectangle.west + rectangle.east) / 2, turn = Math.PI * 2;
  for (let i = 0; i < count; i++) {
    encoding.getExaggeratedPosition(vertices, i, binPickPosition);
    const { x, y, z } = binPickPosition, radius = Math.hypot(x, y, z);
    let longitude = Math.atan2(y, x);
    longitude += turn * Math.round((middle - longitude) / turn);
    const latitude = Math.atan2(z, Math.hypot(x, y));
    // This small non-polar cone excludes the poles and the origin. A triangle's radial image
    // therefore has longitude extrema at vertices and latitude extrema on its three edges.
    if (!Number.isFinite(radius) || radius < R / 2 || radius > R * 2
      || Math.abs(longitude - middle) > 0.03 || Math.abs(latitude) >= 81 * DEG) return undefined;
    positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
    longitudes[i] = longitude; latitudes[i] = latitude;
  }
  const counts = new Uint32Array(BIN_COUNT), ranges = new Uint8Array(triangleCount * 4);
  let references = 0;
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const at = triangle * 3, a = indices[at], b = indices[at + 1], c = indices[at + 2];
    if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c)
      || a < 0 || b < 0 || c < 0 || a >= count || b >= count || c >= count) return undefined;
    const minLon = Math.min(longitudes[a], longitudes[b], longitudes[c]) - BIN_PAD;
    const maxLon = Math.max(longitudes[a], longitudes[b], longitudes[c]) + BIN_PAD;
    let minLat = Math.min(latitudes[a], latitudes[b], latitudes[c]);
    let maxLat = Math.max(latitudes[a], latitudes[b], latitudes[c]);
    const ab = edgeLatitude(positions, a * 3, b * 3), bc = edgeLatitude(positions, b * 3, c * 3);
    const ca = edgeLatitude(positions, c * 3, a * 3);
    if (ab !== undefined) { minLat = Math.min(minLat, ab); maxLat = Math.max(maxLat, ab); }
    if (bc !== undefined) { minLat = Math.min(minLat, bc); maxLat = Math.max(maxLat, bc); }
    if (ca !== undefined) { minLat = Math.min(minLat, ca); maxLat = Math.max(maxLat, ca); }
    const x0 = pickBin((minLon - rectangle.west) / width), x1 = pickBin((maxLon - rectangle.west) / width);
    const y0 = pickBin((minLat - BIN_PAD - rectangle.south) / height), y1 = pickBin((maxLat + BIN_PAD - rectangle.south) / height);
    const offset = triangle * 4;
    ranges[offset] = x0; ranges[offset + 1] = x1; ranges[offset + 2] = y0; ranges[offset + 3] = y1;
    references += (x1 - x0 + 1) * (y1 - y0 + 1);
    if (references > 200_000) return undefined;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) counts[y * BIN_SIDE + x]++;
  }
  const offsets = new Uint32Array(BIN_COUNT + 1), triangles = new Uint32Array(references);
  for (let i = 0; i < BIN_COUNT; i++) offsets[i + 1] = offsets[i] + counts[i];
  counts.set(offsets.subarray(0, BIN_COUNT));
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const offset = triangle * 4;
    for (let y = ranges[offset + 2]; y <= ranges[offset + 3]; y++) for (let x = ranges[offset]; x <= ranges[offset + 1]; x++) {
      triangles[counts[y * BIN_SIDE + x]++] = triangle;
    }
  }
  return { positions, offsets, triangles, seen: new Uint32Array(triangleCount), stamp: 0 };
}

/**
 * Exact radial pick for source or cut terrain, including skirts. Bounds come from the decoded
 * world triangles, rather than their texture coordinates: compression and spherical chords cannot
 * move a hit outside its bin. The cache is weak and is rebuilt when Cesium replaces its buffers or
 * changes exaggeration. Fill, oblique rays and unsupported geometry keep Cesium's normal picker.
 */
export function pickBinnedTerrain(surface: RegularSourceSurface, rectangle: Rectangle, level: number,
  place: Cesium.Cartographic, ray: Cesium.Ray, result: Cartesian3): Cartesian3 | undefined {
  const raw = surface.mesh, width = rectangle.east - rectangle.west, height = rectangle.north - rectangle.south;
  if (!raw || typeof raw !== 'object' || raw !== surface.renderedMesh || !Number.isInteger(level) || level < GLOBAL_MAX_LEVEL || level > 24
    || !(width > 0 && width < 0.025 && height > 0 && height < 0.025) || Math.abs(place.latitude) >= 80 * DEG
    || typeof surface.terrainData?.wasCreatedByUpsampling !== 'function') return undefined;
  const mesh = raw as BinnedPickMesh;
  if (!(mesh.vertices instanceof Float32Array) || !mesh.indices || typeof mesh.encoding?.getExaggeratedPosition !== 'function') return undefined;
  const u = (place.longitude - rectangle.west) / width, v = (place.latitude - rectangle.south) / height;
  // The small outer band also admits the real outward skirts; more distant queries use Cesium.
  if (!(u >= -0.01 && u <= 1.01 && v >= -0.01 && v <= 1.01)) return undefined;
  const cl = Math.cos(place.latitude);
  Cartesian3.fromElements(cl * Math.cos(place.longitude), cl * Math.sin(place.longitude), Math.sin(place.latitude), binPickRadial);
  const directionLength = Cartesian3.magnitude(ray.direction);
  if (!(directionLength > 0) || Cartesian3.dot(ray.direction, binPickRadial) >= 0
    || Cartesian3.magnitude(Cartesian3.cross(ray.direction, binPickRadial, binPickCross)) > directionLength * 1e-12
    || Cartesian3.magnitude(Cartesian3.cross(ray.origin, binPickRadial, binPickCross)) > 1e-5) return undefined;
  let entry = binnedPicks.get(raw);
  if (!entry || entry.vertices !== mesh.vertices || entry.indices !== mesh.indices || entry.encoding !== mesh.encoding
    || entry.stride !== mesh.encoding.stride
    || entry.exaggeration !== mesh.encoding.exaggeration || entry.relativeHeight !== mesh.encoding.exaggerationRelativeHeight
    || entry.west !== rectangle.west || entry.south !== rectangle.south || entry.east !== rectangle.east || entry.north !== rectangle.north) {
    entry = { vertices: mesh.vertices, indices: mesh.indices, encoding: mesh.encoding, stride: mesh.encoding.stride,
      exaggeration: mesh.encoding.exaggeration, relativeHeight: mesh.encoding.exaggerationRelativeHeight,
      west: rectangle.west, south: rectangle.south, east: rectangle.east, north: rectangle.north,
      cache: makeBinnedPick(mesh, rectangle) };
    binnedPicks.set(raw, entry);
  }
  const cache = entry.cache;
  if (!cache) return undefined;
  const { positions, offsets, triangles, seen } = cache, x = pickBin(u), y = pickBin(v);
  if (++cache.stamp === 0x1_0000_0000) { seen.fill(0); cache.stamp = 1; }
  let closest = Infinity;
  // Neighbour bins absorb roundoff at a bound; every test still uses Cesium's actual world
  // triangle intersection and the nearest non-negative result, exactly like its full scan.
  for (let by = Math.max(0, y - 1); by <= Math.min(BIN_SIDE - 1, y + 1); by++) {
    for (let bx = Math.max(0, x - 1); bx <= Math.min(BIN_SIDE - 1, x + 1); bx++) {
      const bin = by * BIN_SIDE + bx;
      for (let j = offsets[bin]; j < offsets[bin + 1]; j++) {
        const triangle = triangles[j];
        if (seen[triangle] === cache.stamp) continue;
        seen[triangle] = cache.stamp;
        const at = triangle * 3, a = mesh.indices[at] * 3, b = mesh.indices[at + 1] * 3, c = mesh.indices[at + 2] * 3;
        Cartesian3.fromElements(positions[a], positions[a + 1], positions[a + 2], binPickA);
        Cartesian3.fromElements(positions[b], positions[b + 1], positions[b + 2], binPickB);
        Cartesian3.fromElements(positions[c], positions[c + 1], positions[c + 2], binPickC);
        const hit = gridRayTriangle(ray, binPickA, binPickB, binPickC, false);
        if (hit !== undefined && hit >= 0) closest = Math.min(closest, hit);
      }
    }
  }
  return Number.isFinite(closest) ? Cesium.Ray.getPoint(ray, closest, result) : undefined;
}
