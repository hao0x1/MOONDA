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
  Math as CMath, OrientedBoundingBox, QuantizedMeshTerrainData, Rectangle, TerrainProvider, type TileAvailability,
} from 'cesium';
import { type MoonHeights, toMap } from '../science/heights';
import { MOON_ELLIPSOID } from './ellipsoid';

const DEG = Math.PI / 180;
const R = MOON_ELLIPSOID.maximumRadius; // 1,737,400 m sphere, the same reference the LOLA heights use

const N = 65; // vertices along each tile side
const S = N + 2; // samples along each side: the vertices plus one extra ring outside, for edge normals
const MAX_Q = 32767; // Cesium stores vertex positions inside a tile as whole numbers 0..32767
const MIDDLE = (N - 1) / 2 + 1; // sample index of the middle vertex row/column (where Cesium cuts a tile in four)

const GLOBAL_MAX_LEVEL = 7; // ~670 m between vertices: the ~1.9 km global map gains nothing from finer tiles
const MAX_LEVEL = 11; // ~42 m between vertices: finer than the 80 m polar map
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
const pos = new Float64Array(S * S * 3); // 3D display-frame position of every sample
const tLatA = new Float64Array(S * S), tLonA = new Float64Array(S * S); // true lat/lon (deg) of every sample
const verts = new Float64Array(N * N * 3); // positions of the 65 x 65 vertices only
const cosLat = new Float64Array(S), sinLat = new Float64Array(S), cosLon = new Float64Array(S), sinLon = new Float64Array(S);
const edgeH = new Float64Array(N), edgeCoarse = new Float64Array(N);
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
function heightAtDisplay(heights: MoonHeights, dLat: number, dLon: number, detail: boolean): number {
  return heights.heightAt(trueLatOf(dLat, dLon), trueLonOf(dLat, dLon), detail);
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

  constructor(heights: MoonHeights) {
    this.heights = heights;
    this.levelZeroError = TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
      MOON_ELLIPSOID, N, this.tilingScheme.getNumberOfXTilesAtLevel(0));
    // Tiles asked for before the height files arrived were told "not yet": draw again once they are here.
    heights.ready.then(() => downloadFinished.raiseEvent(), () => {});
  }

  getLevelMaximumGeometricError(level: number): number { return this.levelZeroError / (1 << level); }
  loadTileDataAvailability(): undefined { return undefined; }

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
    if (level > MAX_LEVEL) return false;
    const rect = this.tilingScheme.tileXYToRectangle(x, y, level, rectScratch);
    return reachesDetailMap(rect, rect.north - rect.south);
  }

  /**
   * Builds the tile now (about 1 ms, inside Cesium's per-frame time budget) and hands it over as an
   * already-finished promise. Returns undefined ("ask again on a later frame") while the height files,
   * or the 80 m map files this tile reads, are still downloading.
   */
  requestTileGeometry(x: number, y: number, level: number): Promise<QuantizedMeshTerrainData> | undefined {
    if (!this.heights.global || !this.heights.overview) return undefined;
    const rect = this.tilingScheme.tileXYToRectangle(x, y, level);
    const detail = level >= DETAIL_MIN_LEVEL && this.getTileDataAvailable(x, y, level);
    if (detail && !this.detailFilesReady(`${level}/${x}/${y}`, rect)) return undefined;
    return Promise.resolve(this.build(x, y, level, rect, detail));
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
        tLatA[k] = tLat; tLonA[k] = tLon; hs[k] = h;
        if (tLat < minTrueLat) minTrueLat = tLat;
        const rr = R + h;
        pos[3 * k] = rr * X; pos[3 * k + 1] = rr * Y; pos[3 * k + 2] = rr * Z;
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
      verts[3 * v] = pos[k3]; verts[3 * v + 1] = pos[k3 + 1]; verts[3 * v + 2] = pos[k3 + 2];

      // Normal = (west->east step) x (south->north step), straight from the 3D positions, so it is
      // already in the display frame Cesium lights in. Edge vertices use the outer ring.
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
    if (level < MAX_LEVEL) {
      if (this.getTileDataAvailable(2 * x, 2 * y + 1, level + 1)) childTileMask |= 1;
      if (this.getTileDataAvailable(2 * x + 1, 2 * y + 1, level + 1)) childTileMask |= 2;
      if (this.getTileDataAvailable(2 * x, 2 * y, level + 1)) childTileMask |= 4;
      if (this.getTileDataAvailable(2 * x + 1, 2 * y, level + 1)) childTileMask |= 8;
    }

    // 6. Skirts sized from the data (see skirtHeight). If only some children are available, Cesium
    // cuts this mesh along its middle lines for the others, and those pieces get half of our shortest
    // skirt along the cut, right next to a real child tile. So every skirt is at least twice the
    // largest step between our straight middle lines and the ground halfway between their vertices
    // (exactly what the real child draws there). Such tiles never reach the 80 m map (a sibling of a
    // tile that does is in its ring), so those middle lines lie on the global map at both levels.
    const split = childTileMask !== 0 && childTileMask !== 15 ? 2 * this.middleStep(rect, detail) : 0;
    const nearDetailMap = minTrueLat < DETAIL_LAT;
    return new QuantizedMeshTerrainData({
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
      westSkirtHeight: this.skirtHeight(0, level, rect, detail, nearDetailMap, range, split),
      southSkirtHeight: this.skirtHeight(1, level, rect, detail, nearDetailMap, range, split),
      eastSkirtHeight: this.skirtHeight(2, level, rect, detail, nearDetailMap, range, split),
      northSkirtHeight: this.skirtHeight(3, level, rect, detail, nearDetailMap, range, split),
      childTileMask,
    });
  }

  /** Largest step between the straight lines along the tile's two middle lines and the ground halfway between their vertices. */
  private middleStep(rect: Rectangle, detail: boolean): number {
    const heights = this.heights;
    const midLat = CMath.lerp(rect.south, rect.north, F[MIDDLE]), midLon = CMath.lerp(rect.west, rect.east, F[MIDDLE]);
    let worst = 0;
    for (let t = 0; t < N - 1; t++) {
      const lat = CMath.lerp(rect.south, rect.north, MID[t]), lon = CMath.lerp(rect.west, rect.east, MID[t]);
      const southNorth = Math.abs(heightAtDisplay(heights, lat, midLon, detail) - (hs[(t + 1) * S + MIDDLE] + hs[(t + 2) * S + MIDDLE]) / 2);
      const westEast = Math.abs(heightAtDisplay(heights, midLat, lon, detail) - (hs[MIDDLE * S + t + 1] + hs[MIDDLE * S + t + 2]) / 2);
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
    range: number, floor: number): number {
    const heights = this.heights;
    const vertical = edge === 0 || edge === 2; // west and east edges run south -> north
    const fixed = edge < 2 ? 1 : N; // sample column (west/east) or row (south/north) of the edge
    for (let t = 0; t < N; t++) {
      const k = vertical ? (t + 1) * S + fixed : fixed * S + (t + 1);
      edgeH[t] = hs[k];
      edgeCoarse[t] = detail ? heights.heightAt(tLatA[k], tLonA[k], false) : hs[k];
    }

    // distance between neighbouring vertices along this edge, for the chord sag
    const spacing = vertical
      ? (R * (rect.north - rect.south)) / (N - 1)
      : (R * Math.cos(edge === 1 ? rect.south : rect.north) * (rect.east - rect.west)) / (N - 1);
    let coarse = 0;
    for (let k = 1; k <= Math.min(level, 4); k++) {
      const step = 1 << k, sag = (step * spacing) ** 2 / (8 * R);
      let gap = chordGap(edgeH, edgeCoarse, step);
      if (detail) gap = Math.max(gap, chordGap(edgeH, edgeH, step)); // coarser neighbour may also be an 80 m tile
      coarse = Math.max(coarse, gap + sag);
    }

    let bump = 0, guess = 0;
    if (level < MAX_LEVEL) {
      const a0 = vertical ? rect.south : rect.west, a1 = vertical ? rect.north : rect.east;
      const across = edge === 0 ? rect.west : edge === 1 ? rect.south : edge === 2 ? rect.east : rect.north;
      for (let t = 0; t < N - 1; t++) {
        const a = CMath.lerp(a0, a1, MID[t]);
        const hm = vertical ? heightAtDisplay(heights, a, across, detail) : heightAtDisplay(heights, across, a, detail);
        const d = Math.abs(hm - (edgeH[t] + edgeH[t + 1]) / 2);
        if (d > bump) bump = d;
      }
      guess = Math.min(2.5 * bump + (!detail && nearDetailMap ? DATASET_STEP_M : 0),
        SKIRT_CAP_FACTOR * this.getLevelMaximumGeometricError(level));
    }

    return Math.max(coarse, bump, guess, floor) + range / MAX_Q + 1;
  }
}
