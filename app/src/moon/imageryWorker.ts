// Imagery worker: downloads NASA map pictures, decodes them and re-projects them into the square
// tiles Cesium drapes over the 3D Moon. It all runs off the main thread so the view stays smooth
// while new detail streams in.
//
// Why re-project? We rotate the Moon inside Cesium so the south pole sits on Cesium's equator
// (see frame.ts). Cesium asks for lon/lat tiles of that rotated DISPLAY frame, but every NASA
// picture is drawn in the TRUE Moon frame. So for each pixel of a display tile we work out where
// it is on the real Moon and read the source picture there (bilinear, like a GPU would).
//
// Four kinds of source picture:
//   base    - the whole-Moon picture stored with the app, already drawn in the display frame:
//             tiles are simply cut out of it (instant, works with no internet)
//   trek    - NASA Moon Trek global tiles (true lon/lat grid, 256 px tiles, level 0 = 2x1 tiles)
//   raster  - one local south-polar picture (photo or science map), held in memory once
//   pyramid - sharp south-polar photo squares: read from the copies stored with the app
//             (public/data/polar/t, listed in its index.json) and only where there is no local
//             copy from ASU Lunaserv; fetched once and reused
//
// Nothing is ever asked for beyond the detail the data has: such tiles are answered "keep showing
// the parent tile" (see `parent` in FromWorker), and so are tiles whose downloads failed, so a
// slow or missing server never leaves holes or endless loading.
//
// The top half is plain math with no browser APIs and no imports, so Node can run it for the
// checks in scripts/check-imagery.ts (which compares it against frame.ts). The worker itself
// (downloads, caches, message loop) is at the bottom and only starts inside a Web Worker.

export const TILE = 256; // display tiles are 256 x 256 pixels
const N2 = TILE * TILE;
const MOON_R = 1737400; // same sphere as frame.ts and MOON_ELLIPSOID
const DEG = Math.PI / 180;

/**
 * Polar layers are drawn only south of this true latitude, unless a layer sets its own clip.
 * 80 deg S is the circle that just fits inside the 608 km square of the polar pictures (304 km
 * from the pole), so the polar photos end in a round edge with no straight sides.
 */
export const POLAR_LIMIT_DEG = -80;
/**
 * Width of the soft edge where the polar photos fade into the global Moon Trek photo below. Wide
 * on purpose: the two are different NASA mosaics that are lit differently in places (near true
 * longitude +-90 deg), and a narrow edge showed there as a straight step in brightness.
 */
export const POLAR_FEATHER_M = 40000;
/** At most this many pyramid squares per display tile before we step to a coarser pyramid level. */
const MAX_PYRAMID_TILES = 12;

// Moon Trek near the true poles. Its pictures are lon/lat grids, so towards a pole one display
// pixel covers more and more Moon Trek pixels east-west (about 1/cos(latitude) of them). One
// sample per display pixel would turn that fine detail into false stripes (moiré), so we average
// several samples along true east instead. Closer to the true north pole than ~82° we also read
// coarser Moon Trek levels, or a single display tile would need hundreds of source tiles. That
// choice depends only on the latitude of each pixel, so neighbouring tiles always agree (no seams).
const TAP_SPACING = 1.25; // at most this many source pixels between two samples along true east
const MAX_TAPS = 8; // only reached at level 0 right at the north pole; elsewhere at most 6
const SQUEEZE_FULL = 7; // full detail while 1/cos(lat) <= 7: up to true latitude 81.8° (all of the south we draw)
const SQUEEZE_POLE = 5.6; // beyond that, one level coarser per doubling, so a pixel spans at most 5.6 source pixels east-west
const MAX_TREK_LEVEL = 12; // tile keys (below) have room for Moon Trek levels up to 12

/** A display-frame tile rectangle, radians (what Cesium's tiling scheme gives us). */
export interface Rect { west: number; south: number; east: number; north: number }

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Size of one display-tile pixel at a tile level, in degrees of arc and in metres on the surface. */
export const pixelDeg = (level: number) => 180 / (TILE * 2 ** level);

export const pixelMetres = (level: number) => pixelDeg(level) * DEG * MOON_R;

/** Lowest and highest TRUE latitude (degrees) anywhere inside a display-frame tile. */
export function tileTrueLatRange(r: Rect): { minDeg: number; maxDeg: number } {
  // True latitude = asin(-Y), where Y = cos(lat)·sin(lon) is the display unit vector's y.
  // cos(lat) >= 0, so the extremes of the product sit at the extremes of each factor.
  const sw = Math.sin(r.west), se = Math.sin(r.east);
  let sMin = Math.min(sw, se), sMax = Math.max(sw, se);
  if (r.west <= Math.PI / 2 && r.east >= Math.PI / 2) sMax = 1;
  if (r.west <= -Math.PI / 2 && r.east >= -Math.PI / 2) sMin = -1;
  const cs = Math.cos(r.south), cn = Math.cos(r.north);
  const cMin = Math.min(cs, cn), cMax = r.south <= 0 && r.north >= 0 ? 1 : Math.max(cs, cn);
  const yMin = sMin >= 0 ? cMin * sMin : cMax * sMin;
  const yMax = sMax >= 0 ? cMax * sMax : cMin * sMax;
  return { minDeg: Math.asin(clamp(-yMax, -1, 1)) / DEG, maxDeg: Math.asin(clamp(-yMin, -1, 1)) / DEG };
}

// ---------------------------------------------------------------------------------------------
// The seam fix (v5). NASA's WAC global mosaic is lit from the west everywhere except true lon
// -180..-90, which is lit from the east: two straight lighting flips at -90 and 180 (both on display
// tile edges, so they show as crisp lines). There the app draws albedo x hillshade instead (lit from
// the west like the rest), cross-faded into the photo over -90..-80 and 165..180. The local base
// pictures have it baked in (data-prep/base_mosaic.py, same formula); deeper tiles get it from the
// 'synth' job below.

export const FIX_BAND_WEST: readonly [number, number] = [-90, -80]; // synthetic at -90 -> photo at -80 (degrees)
export const FIX_BAND_EAST: readonly [number, number] = [165, 180]; // photo at 165 -> synthetic at 180

/** How much of the fixed picture (1) vs the photo (0) shows at a true longitude (degrees). Same as fix_weight in base_mosaic.py. */
export function fixWeightDeg(lonDeg: number): number {
  const lon = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
  if (lon <= FIX_BAND_WEST[0]) return 1;
  if (lon < FIX_BAND_WEST[1]) return 1 - smooth((lon - FIX_BAND_WEST[0]) / (FIX_BAND_WEST[1] - FIX_BAND_WEST[0]));
  if (lon >= FIX_BAND_EAST[0]) return lon >= 180 - 1e-9 ? 1 : smooth((lon - FIX_BAND_EAST[0]) / (FIX_BAND_EAST[1] - FIX_BAND_EAST[0]));
  return 0;
}

/**
 * Smallest and largest fix weight over a display tile, measured on a 9 x 9 grid with a safety margin of a
 * quarter tile in true longitude (min 1 = the photo is fully covered, max 0 = the fix draws nothing).
 * Tiles reaching within 6° of a true pole (where true longitude spans everything) answer {0, 1}.
 */
export function tileFixRange(r: Rect): { min: number; max: number } {
  const lat = tileTrueLatRange(r);
  if (lat.maxDeg > 84 || lat.minDeg < -84) return { min: 0, max: 1 };
  const margin = Math.max(0.05, ((r.east - r.west) / DEG) * 0.25 / Math.max(0.1, Math.cos(Math.max(Math.abs(lat.minDeg), Math.abs(lat.maxDeg)) * DEG)));
  let min = 1, max = 0;
  for (let j = 0; j <= 8; j++) {
    const la = r.south + ((r.north - r.south) * j) / 8, cl = Math.cos(la), Z = Math.sin(la);
    for (let i = 0; i <= 8; i++) {
      const lo = r.west + ((r.east - r.west) * i) / 8;
      const tLon = Math.atan2(Z, cl * Math.cos(lo)) / DEG; // display (X, Y, Z) -> true lon = atan2(Z, X)
      for (const d of [-margin, 0, margin]) { const w = fixWeightDeg(tLon + d); if (w < min) min = w; if (w > max) max = w; }
    }
  }
  return { min, max };
}

/** What the 'synth' job needs (from base.json "fix"): the brightness-matched albedo and the shading rule. */
export interface FixParams {
  albedo: { url: string; west: number; east: number; north: number; south: number; scale: number };
  C: number; S0: number;
  /** Moon Trek hillshades: `near` (SLDEM2015, 59 m) within ±nearMaxLat, `far` (LOLA, 118 m) elsewhere. */
  near: string; far: string; nearMaxLat: number;
}
export const FIX_NEAR_MAX_Z = 8; // LRO_LrocKaguya_Shade_60N60S_512ppd has levels 0-9; 8 (84 m) matches the WAC photo and needs 4x fewer downloads
export const FIX_FAR_MAX_Z = 6; // LRO_LOLA_Shade_Global_256ppd_v06 has levels 0-6 (its capabilities list more)

/** The hillshade layer and deepest level a fix tile reads. */
export function fixShadeFor(fix: FixParams, r: Rect): { layer: string; maxZ: number } {
  const lat = tileTrueLatRange(r);
  return lat.minDeg > -fix.nearMaxLat && lat.maxDeg < fix.nearMaxLat ? { layer: fix.near, maxZ: FIX_NEAR_MAX_Z } : { layer: fix.far, maxZ: FIX_FAR_MAX_Z };
}

/** Bilinear sample of a true lon/lat picture (lon wraps from `west`, `east - west` wide) at true lat/lon (radians). */
export function sampleLonLat(s: Src, west: number, east: number, north: number, south: number, latRad: number, lonRad: number): number {
  const lonD = lonRad / DEG, latD = latRad / DEG;
  const u = ((((lonD - west) % 360) + 360) % 360) * (s.w / (east - west)) - 0.5, v = (north - latD) * (s.h / (north - south)) - 0.5;
  const c0 = clamp(Math.floor(u), 0, s.w - 2), r0 = clamp(Math.floor(v), 0, s.h - 2), tx = clamp01(u - c0), ty = clamp01(v - r0);
  const d = s.data, ch = s.ch, a = (r0 * s.w + c0) * ch, b = a + ch, c = a + s.w * ch, e = c + ch;
  return (d[a] * (1 - tx) + d[b] * tx) * (1 - ty) + (d[c] * (1 - tx) + d[e] * tx) * ty;
}

/** Distance from the south pole on the south-polar-stereographic map (m) at a true latitude. */
export const polarRho = (trueLatDeg: number) => 2 * MOON_R * Math.tan(Math.PI / 4 + (trueLatDeg * DEG) / 2);

/** NASA Moon Trek WMTS tile (true lon/lat): row 0 at 90°N, column 0 at 180°W. */
export const trekUrl = (layer: string, ext: string, z: number, x: number, y: number) =>
  `https://trek.nasa.gov/tiles/Moon/EQ/${layer}/1.0.0/default/default028mm/${z}/${y}/${x}.${ext}`;

/** The layer's WMTS description, which lists the levels the server really has. */
export const trekCapabilitiesUrl = (layer: string) => `https://trek.nasa.gov/tiles/Moon/EQ/${layer}/1.0.0/WMTSCapabilities.xml`;

/**
 * Deepest Moon Trek level listed in a WMTSCapabilities.xml (the file also holds commented-out
 * levels, which do not count), or null if it lists none. We cannot simply try a level and look
 * for "404 Not Found": Moon Trek sends its 404s without the CORS header, so in a browser a
 * missing tile looks exactly like a network failure.
 */
export function parseTrekDepth(xml: string): number | null {
  const live = xml.replace(/<!--[\s\S]*?-->/g, '');
  let depth = -1;
  for (const m of live.matchAll(/<TileMatrix>\s*<ows:Identifier>\s*(\d+)\s*<\/ows:Identifier>/g)) depth = Math.max(depth, Number(m[1]));
  return depth >= 0 ? depth : null;
}

// Polar pyramid: the 608 km square around the south pole split into 2^k x 2^k squares of 512 px
// (1187/2^k metres per pixel), each fetched once from ASU Lunaserv in the polar projection.
export const PYRAMID_HALF_M = 304000;
const PYRAMID_SPAN_M = 2 * PYRAMID_HALF_M;
export const PYRAMID_PX = 512;
export const PYRAMID_MAX_K = 10; // ~1.2 m per pixel, about the NAC mosaic's own detail
const PYRAMID_HOSTS = ['wms', 'wms1', 'wms2', 'wms3', 'wms4', 'wms5', 'wms6', 'wms7'];

/**
 * The sharp NAC mosaic only exists south of this true latitude (measured: Lunaserv's
 * luna_nac_pole_control_south layer is empty beyond 182 km from the pole). Further out the server
 * only has the 100 m/pixel WAC mosaic.
 */
export const PYRAMID_NAC_LAT_DEG = -84;
/** Finest pyramid level worth drawing where only the WAC mosaic exists: 74 m/pixel shows all of its detail. */
export const PYRAMID_WAC_MAX_K = 4;

/** Pyramid level whose pixels are at least as fine as a display tile's pixels at this level. */
export function pyramidLevelFor(displayLevel: number): number {
  const k = Math.ceil(Math.log2(PYRAMID_SPAN_M / (PYRAMID_PX * pixelMetres(displayLevel))));
  return clamp(k, 0, PYRAMID_MAX_K);
}

/** WMS request for pyramid square (i = column from the left, j = row from the top) at level k. */
export function pyramidUrl(layers: string, k: number, i: number, j: number): string {
  const S = PYRAMID_SPAN_M / 2 ** k;
  const x0 = -PYRAMID_HALF_M + i * S, y1 = PYRAMID_HALF_M - j * S;
  return `https://${PYRAMID_HOSTS[(i + j * 3 + k) % PYRAMID_HOSTS.length]}.im-ldi.com/?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&STYLES=&LAYERS=${layers}`
    + `&SRS=IAU2000:30120&BBOX=${x0},${y1 - S},${x0 + S},${y1}&WIDTH=${PYRAMID_PX}&HEIGHT=${PYRAMID_PX}&FORMAT=image/jpeg`;
}

/** Finest pyramid level that holds real detail somewhere inside a display tile. */
export function pyramidMaxKFor(r: Rect): number {
  return tileTrueLatRange(r).minDeg >= PYRAMID_NAC_LAT_DEG ? PYRAMID_WAC_MAX_K : PYRAMID_MAX_K;
}

/**
 * True when a display tile could only repeat what its parent tile already shows, because the
 * photos have no finer detail there. Cesium is then told to keep drawing the parent: no download,
 * no work, no extra memory.
 */
export function pyramidParentIsEnough(r: Rect, displayLevel: number): boolean {
  return displayLevel > 0 && pyramidLevelFor(displayLevel - 1) >= pyramidMaxKFor(r);
}

/** Which pyramid squares are stored with the app: per level, per row, [firstColumn, lastColumn, ...] runs. */
export interface PyramidIndex { layers: string; count: number; rows: Map<number, Map<number, number[]>> }

/** Read public/data/polar/t/index.json (written by data-prep/polar_tiles.py). Null if it does not describe this pyramid. */
export function parsePyramidIndex(json: unknown): PyramidIndex | null {
  const j = json as { layers?: unknown; halfM?: unknown; tilePx?: unknown; levels?: Record<string, { runs?: unknown }> } | null;
  if (!j || typeof j.layers !== 'string' || j.halfM !== PYRAMID_HALF_M || j.tilePx !== PYRAMID_PX || !j.levels || typeof j.levels !== 'object') return null;
  const rows = new Map<number, Map<number, number[]>>();
  let count = 0;
  for (const [name, lv] of Object.entries(j.levels)) {
    const k = Number(name);
    if (!Number.isInteger(k) || k < 0 || k > PYRAMID_MAX_K || !Array.isArray(lv?.runs)) continue;
    const byRow = new Map<number, number[]>();
    for (const run of lv.runs as unknown[]) {
      if (!Array.isArray(run) || run.length !== 3 || !run.every(Number.isInteger)) continue;
      const [row, first, last] = run as number[];
      if (row < 0 || first < 0 || last < first || last >= 2 ** k || row >= 2 ** k) continue;
      let list = byRow.get(row);
      if (!list) byRow.set(row, (list = []));
      list.push(first, last);
      count += last - first + 1;
    }
    rows.set(k, byRow);
  }
  return { layers: j.layers, count, rows };
}

/** Is pyramid square (column i, row j) of level k stored with the app? */
export function pyramidHasLocal(ix: PyramidIndex | null, k: number, i: number, j: number): boolean {
  const runs = ix?.rows.get(k)?.get(j);
  if (!runs) return false;
  for (let q = 0; q < runs.length; q += 2) if (i >= runs[q] && i <= runs[q + 1]) return true;
  return false;
}

/** Where a stored pyramid square lives (`base` = the folder of index.json, ending in "/"). */
export const pyramidLocalUrl = (base: string, k: number, i: number, j: number) => `${base}${k}/${i}_${j}.jpg`;

/**
 * Quick test on the main thread: can a display tile surely be drawn from stored squares alone?
 * (Its outline is mapped onto the polar grid and every square under that box must be stored.)
 * Such tiles never wait for the network, so they are not held back behind slow downloads.
 */
export function pyramidSurelyLocal(ix: PyramidIndex | null, r: Rect, displayLevel: number): boolean {
  if (!ix) return false;
  const k = Math.min(pyramidLevelFor(displayLevel), pyramidMaxKFor(r)), n = 2 ** k, S = PYRAMID_SPAN_M / n;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let a = 0; a <= 2; a++) {
    for (let b = 0; b <= 2; b++) {
      const lon = r.west + (a / 2) * (r.east - r.west), lat = r.south + (b / 2) * (r.north - r.south), cl = Math.cos(lat);
      const den = 1 + cl * Math.sin(lon);
      if (den < 1e-6) return false;
      const f = (2 * MOON_R) / den, mx = f * Math.sin(lat), my = f * cl * Math.cos(lon); // as in polarGeometry
      x0 = Math.min(x0, mx); x1 = Math.max(x1, mx); y0 = Math.min(y0, my); y1 = Math.max(y1, my);
    }
  }
  const pad = S / PYRAMID_PX + 0.02 * (x1 - x0 + y1 - y0); // bilinear neighbours, and tile edges are slightly curved on the polar map
  const i0 = Math.max(0, Math.floor((x0 - pad + PYRAMID_HALF_M) / S)), i1 = Math.min(n - 1, Math.floor((x1 + pad + PYRAMID_HALF_M) / S));
  const j0 = Math.max(0, Math.floor((PYRAMID_HALF_M - y1 - pad) / S)), j1 = Math.min(n - 1, Math.floor((PYRAMID_HALF_M - y0 + pad) / S));
  if ((i1 - i0 + 1) * (j1 - j0 + 1) > 64) return false;
  const rhoClip = polarRho(POLAR_LIMIT_DEG);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (pyramidHasLocal(ix, k, i, j)) continue;
      // a square wholly outside the circle the layer draws is never read
      const sx0 = -PYRAMID_HALF_M + i * S, sy1 = PYRAMID_HALF_M - j * S;
      const nx = sx0 <= 0 && sx0 + S >= 0 ? 0 : Math.min(Math.abs(sx0), Math.abs(sx0 + S)), ny = sy1 >= 0 && sy1 - S <= 0 ? 0 : Math.min(Math.abs(sy1), Math.abs(sy1 - S));
      if (Math.hypot(nx, ny) < rhoClip) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Re-projection core.

/** Decoded picture: 1 = grey, 3 = RGB (both fully opaque), 4 = RGBA with straight alpha. */
export interface Src { w: number; h: number; ch: 1 | 3 | 4; data: Uint8Array }

/** A polar raster with smaller copies (each half the size) so zoomed-out views don't sparkle. */
export interface Raster { levels: Src[] }

/** How source tiles are laid out: tile size, tiles across, whole size, and whether it wraps in longitude. */
export interface Grid { tileW: number; tileH: number; tilesX: number; width: number; height: number; global: boolean }

export const trekGrid = (z: number): Grid =>
  ({ tileW: TILE, tileH: TILE, tilesX: 2 ** (z + 1), width: TILE * 2 ** (z + 1), height: TILE * 2 ** z, global: true });
export const pyramidGrid = (k: number): Grid =>
  ({ tileW: PYRAMID_PX, tileH: PYRAMID_PX, tilesX: 2 ** k, width: PYRAMID_PX * 2 ** k, height: PYRAMID_PX * 2 ** k, global: false });
const singleGrid = (s: Src): Grid => ({ tileW: s.w, tileH: s.h, tilesX: 1, width: s.w, height: s.h, global: false });

/**
 * A source tile is named by one number: grid * KEY_LEVEL + row * tilesX + column, where grid is
 * the index into the plan's `grids` (for Moon Trek that is the Moon Trek level itself).
 */
export const KEY_LEVEL = 2 ** 26;

/** Moon Trek level, column and row of a tile key. */
export function trekTileOf(key: number): { z: number; x: number; y: number } {
  const z = Math.floor(key / KEY_LEVEL), local = key - z * KEY_LEVEL, n = 2 ** (z + 1);
  return { z, x: local % n, y: Math.floor(local / n) };
}

/** What we need to fetch for one display tile: the deepest source level used, the grid per level and the tile keys. */
export interface Plan { level: number; grids: Grid[]; keys: number[] }

/**
 * Scratch space for one display tile: where each of its 256x256 pixels lands.
 * a/b = true lat/lon (radians, Moon Trek) or polar map x/y (metres, polar layers);
 * u/v = fractional source pixel (shifted by half a pixel, ready for bilinear);
 * cov = how much of the pixel lies inside the layer's area (0..1, soft at the edges);
 * lvl = which of the plan's grids the pixel reads; taps / step = how many samples it averages
 * along true east and how far apart they are (source pixels).
 * Rows run north to south, as Cesium's tile rectangle does.
 */
export class Footprint {
  readonly a = new Float64Array(N2);
  readonly b = new Float64Array(N2);
  readonly u = new Float64Array(N2);
  readonly v = new Float64Array(N2);
  readonly cov = new Float32Array(N2);
  readonly lvl = new Uint8Array(N2);
  readonly taps = new Uint8Array(N2);
  readonly step = new Float32Array(N2);
  /** Moon Trek: east-west size of the pixel in source pixels at the display level, and how many levels coarser to read. */
  readonly w0 = new Float32Array(N2);
  readonly coarser = new Uint8Array(N2);
  readonly cosLon = new Float64Array(TILE);
  readonly sinLon = new Float64Array(TILE);
}

function columns(fp: Footprint, r: Rect) {
  const dLon = (r.east - r.west) / TILE;
  for (let i = 0; i < TILE; i++) { const lon = r.west + (i + 0.5) * dLon; fp.cosLon[i] = Math.cos(lon); fp.sinLon[i] = Math.sin(lon); }
}

/**
 * How many Moon Trek levels coarser than the display level to read where the map is squeezed
 * east-west by s = 1/cos(true latitude). Zero for all latitudes below 81.8°; above that one
 * level more each time s doubles (84.9°, 87.4°, 88.7°, ...), so neighbouring rings of latitude
 * differ by exactly one level.
 */
export function trekCoarsen(s: number): number {
  return s <= SQUEEZE_FULL ? 0 : Math.min(30, Math.ceil(Math.log2(s / SQUEEZE_POLE)));
}

/** Display pixel centres -> true lat/lon. Pixels south of `minTrueLatDeg` are left out (soft over one pixel). Returns false if nothing is covered. */
export function trekGeometry(fp: Footprint, r: Rect, minTrueLatDeg: number): boolean {
  columns(fp, r);
  const dLat = (r.north - r.south) / TILE, minLat = minTrueLatDeg * DEG, clip = minTrueLatDeg > -90;
  let any = false;
  for (let j = 0; j < TILE; j++) {
    const lat = r.north - (j + 0.5) * dLat, cl = Math.cos(lat), Z = Math.sin(lat);
    for (let i = 0; i < TILE; i++) {
      const p = j * TILE + i, X = cl * fp.cosLon[i], Y = cl * fp.sinLon[i];
      // display (X, Y, Z) -> true (X, Z, -Y), as in frame.ts
      const tLat = Math.asin(clamp(-Y, -1, 1));
      fp.a[p] = tLat;
      fp.b[p] = Math.atan2(Z, X);
      const c = clip ? clamp01((tLat - minLat) / dLat + 0.5) : 1;
      fp.cov[p] = c;
      if (c <= 0) continue;
      any = true;
      // True longitude = atan2(Z, X). One step of display lon moves it by sin·cos(lat)·sin(lon)
      // / cos²(true lat) source pixels (at the display level), one step of display lat by
      // cos(lon) / cos²(true lat). The larger of the two is how many source pixels along true
      // east one display pixel spans: more than ~1 and single samples would alias.
      const cos2 = Math.max(X * X + Z * Z, 1e-24); // cos²(true latitude)
      fp.w0[p] = Math.min(Math.max(Math.abs(Z * cl * fp.sinLon[i]), Math.abs(fp.cosLon[i])) / cos2, 1e30);
      fp.coarser[p] = trekCoarsen(1 / Math.sqrt(cos2));
    }
  }
  return any;
}

/**
 * True lat/lon -> Moon Trek pixel for every covered pixel: the source level (display level,
 * capped at `top`, coarser near the true north pole), its global pixel position and its samples
 * along true east.
 */
export function trekCoords(fp: Footprint, displayLevel: number, top: number) {
  const kx: number[] = [], ky: number[] = [], scale: number[] = [], width: number[] = [];
  for (let z = 0; z <= top; z++) {
    width.push(TILE * 2 ** (z + 1));
    kx.push((TILE * 2 ** (z + 1)) / (2 * Math.PI));
    ky.push((TILE * 2 ** z) / Math.PI);
    scale.push(2 ** (z - displayLevel));
  }
  const { a, b, u, v, cov, w0, coarser, lvl, taps, step } = fp;
  for (let p = 0; p < N2; p++) {
    if (cov[p] <= 0) continue;
    const z = clamp(displayLevel - coarser[p], 0, top);
    const w = Math.min(w0[p] * scale[z], width[z]); // east-west footprint in source pixels (at most once around the Moon)
    const k = w > TAP_SPACING ? Math.min(MAX_TAPS, Math.ceil(w / TAP_SPACING)) : 1;
    lvl[p] = z; taps[p] = k; step[p] = k > 1 ? w / k : 0;
    u[p] = (b[p] + Math.PI) * kx[z] - 0.5;
    v[p] = (Math.PI / 2 - a[p]) * ky[z] - 0.5;
  }
}

/** Moon Trek footprint of a display tile with source levels capped at `maxZ`. Returns false if nothing is covered. */
export function trekFootprint(fp: Footprint, r: Rect, displayLevel: number, maxZ: number, minTrueLatDeg: number): boolean {
  if (!trekGeometry(fp, r, minTrueLatDeg)) return false;
  trekCoords(fp, displayLevel, trekTop(displayLevel, maxZ));
  return true;
}

const trekTop = (displayLevel: number, maxZ: number) => clamp(Math.min(displayLevel, maxZ), 0, MAX_TREK_LEVEL);

/**
 * Display pixel centres -> south-polar map x/y (m). Inside = closer to the pole than `rhoClip`
 * and inside the ±halfM square. With a feather wider than a pixel the edge fades over `featherM`
 * metres (photo blending into the photo below); otherwise it is a crisp, anti-aliased line
 * (science maps). Returns false if nothing is covered.
 */
export function polarGeometry(fp: Footprint, r: Rect, rhoClip: number, featherM: number, halfM: number): boolean {
  columns(fp, r);
  fp.lvl.fill(0); fp.taps.fill(1); // one grid, one bilinear sample per pixel
  const dLat = (r.north - r.south) / TILE, pxM = dLat * MOON_R, soft = featherM > pxM;
  let any = false;
  for (let j = 0; j < TILE; j++) {
    const lat = r.north - (j + 0.5) * dLat, cl = Math.cos(lat), Z = Math.sin(lat);
    for (let i = 0; i < TILE; i++) {
      const p = j * TILE + i, X = cl * fp.cosLon[i], Y = cl * fp.sinLon[i];
      const den = 1 + Y; // zero only at the true north pole, far outside every polar layer
      let c = 0, mx = 0, my = 0;
      if (den > 1e-9) {
        // same formula as polarMapFromDisplayUnit in frame.ts
        const f = (2 * MOON_R) / den;
        mx = f * Z; my = f * X;
        const inside = rhoClip - Math.sqrt(mx * mx + my * my);
        c = soft ? smooth(Math.min(inside, halfM - Math.max(Math.abs(mx), Math.abs(my))) / featherM) : clamp01(inside / pxM + 0.5);
      }
      fp.a[p] = mx; fp.b[p] = my; fp.cov[p] = c;
      if (c > 0) any = true;
    }
  }
  return any;
}

/** Polar map x/y -> source pixel of a picture spanning ±halfM (row 0 = +y), sx/sy pixels per metre. */
export function polarCoords(fp: Footprint, halfM: number, sx: number, sy: number) {
  for (let p = 0; p < N2; p++) {
    fp.u[p] = (fp.a[p] + halfM) * sx - 0.5;
    fp.v[p] = (halfM - fp.b[p]) * sy - 0.5;
  }
}

const pyramidCoords = (fp: Footprint, k: number) => {
  const s = (PYRAMID_PX * 2 ** k) / PYRAMID_SPAN_M;
  polarCoords(fp, PYRAMID_HALF_M, s, s);
};

/** Source tiles touched by the covered pixels (every sample and its bilinear neighbours), or null if more than `max`. */
export function collectTiles(fp: Footprint, grids: Grid[], max: number): number[] | null {
  const keys: number[] = [], seen = new Set<number>();
  const { u, v, cov, lvl, taps, step } = fp;
  let last = -1;
  const add = (key: number) => {
    if (key === last) return true;
    last = key;
    if (seen.has(key)) return true;
    if (keys.length >= max) return false;
    seen.add(key);
    keys.push(key);
    return true;
  };
  for (let p = 0; p < N2; p++) {
    if (cov[p] <= 0) continue;
    const g = grids[lvl[p]], base = lvl[p] * KEY_LEVEL, k = taps[p], s = step[p];
    const { tileW, tileH, tilesX, width, height, global } = g;
    const u0 = u[p] - 0.5 * (k - 1) * s, c0 = Math.floor(u0), c1 = Math.floor(u0 + (k - 1) * s) + 1, r0 = Math.floor(v[p]);
    if (c0 >= 0 && r0 >= 0 && c1 < width && r0 + 1 < height) { // fast path: every sample's 2x2 neighbourhood inside one tile
      const ti = (c0 / tileW) | 0, tj = (r0 / tileH) | 0;
      if (((c1 / tileW) | 0) === ti && (((r0 + 1) / tileH) | 0) === tj) { if (!add(base + tj * tilesX + ti)) return null; continue; }
    }
    for (let t = 0; t < k; t++) {
      const ct = Math.floor(u0 + t * s);
      for (let dy = 0; dy < 2; dy++) {
        let r = r0 + dy;
        if (global) r = r < 0 ? 0 : r >= height ? height - 1 : r;
        else if (r < 0 || r >= height) continue;
        const tj = (r / tileH) | 0;
        for (let dx = 0; dx < 2; dx++) {
          let c = ct + dx;
          if (global) { c %= width; if (c < 0) c += width; } else if (c < 0 || c >= width) continue;
          if (!add(base + tj * tilesX + ((c / tileW) | 0))) return null;
        }
      }
    }
  }
  return keys;
}

// Running sums for one output pixel (module-level so the hot loop allocates nothing).
let sumR = 0, sumG = 0, sumB = 0, sumW = 0;

function addCorner(s: Src, lc: number, lr: number, w: number) {
  const d = s.data;
  if (s.ch === 1) {
    const g = d[lr * s.w + lc] * w;
    sumR += g; sumG += g; sumB += g; sumW += w;
  } else if (s.ch === 3) {
    const o = (lr * s.w + lc) * 3;
    sumR += d[o] * w; sumG += d[o + 1] * w; sumB += d[o + 2] * w; sumW += w;
  } else {
    const o = (lr * s.w + lc) * 4, wa = (w * d[o + 3]) / 255; // alpha-weighted: "no data" never bleeds colour
    sumR += d[o] * wa; sumG += d[o + 1] * wa; sumB += d[o + 2] * wa; sumW += wa;
  }
}

/**
 * Sample the source tiles (`srcs[q]` belongs to `keys[q]`; null = no data) into a 256x256 RGBA
 * tile: bilinear, averaging each pixel's samples along true east. Every pixel samples the same
 * continuous surface, so neighbouring display tiles meet without seams; longitude wraps for
 * global maps. `flipRows` false writes the south row first, which is the row order WebGL uploads
 * an ImageBitmap in (Cesium's own bitmaps are pre-flipped the same way). Returns null when the
 * tile came out fully transparent. `post` (grey sources only) turns each sampled value into the grey
 * drawn for pixel p (used by the seam fix: hillshade -> albedo x shading).
 */
export function sampleTiles(fp: Footprint, grids: Grid[], keys: number[], srcs: (Src | null)[], flipRows: boolean, post?: (p: number, value: number) => number): Uint8ClampedArray<ArrayBuffer> | null {
  const out = new Uint8ClampedArray(N2 * 4);
  const { u, v, cov, lvl, taps, step } = fp;
  const byKey = new Map<number, Src | null>();
  keys.forEach((k, q) => byKey.set(k, srcs[q]));
  let lastKey = -1, last: Src | null = null, any = false, clear = false;
  const tileAt = (key: number) => {
    if (key !== lastKey) { lastKey = key; last = byKey.get(key) ?? null; }
    return last;
  };
  let g = grids[0], base = 0; // the grid the current pixel reads
  // General case (2x2 neighbourhood crosses a tile edge, the 180° meridian or the picture's edge).
  const corner = (c: number, r: number, w: number) => {
    if (w <= 0) return;
    if (g.global) { c %= g.width; if (c < 0) c += g.width; r = r < 0 ? 0 : r >= g.height ? g.height - 1 : r; }
    else if (c < 0 || r < 0 || c >= g.width || r >= g.height) return;
    const tx = (c / g.tileW) | 0, ty = (r / g.tileH) | 0, s = tileAt(base + ty * g.tilesX + tx);
    if (s) addCorner(s, c - tx * g.tileW, r - ty * g.tileH, w);
  };
  // One bilinear sample at source pixel (fu, fv), added to the running sums (weight 1 if all of it has data).
  const tap = (fu: number, fv: number) => {
    const c0 = Math.floor(fu), r0 = Math.floor(fv), tx = fu - c0, ty = fv - r0;
    // Quick case: this sample's four neighbours inside one opaque source tile.
    if (c0 >= 0 && r0 >= 0 && c0 + 1 < g.width && r0 + 1 < g.height) {
      const ti = (c0 / g.tileW) | 0, tj = (r0 / g.tileH) | 0, lc = c0 - ti * g.tileW, lr = r0 - tj * g.tileH;
      if (lc < g.tileW - 1 && lr < g.tileH - 1) {
        const s = tileAt(base + tj * g.tilesX + ti);
        if (!s) return;
        if (s.ch !== 4) {
          const d = s.data, ch = s.ch, a = (lr * s.w + lc) * ch, b = a + ch, c = a + s.w * ch, e = c + ch;
          const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
          const R = d[a] * w00 + d[b] * w10 + d[c] * w01 + d[e] * w11;
          if (ch === 1) { sumR += R; sumG += R; sumB += R; }
          else {
            sumR += R;
            sumG += d[a + 1] * w00 + d[b + 1] * w10 + d[c + 1] * w01 + d[e + 1] * w11;
            sumB += d[a + 2] * w00 + d[b + 2] * w10 + d[c + 2] * w01 + d[e + 2] * w11;
          }
          sumW += 1;
          return;
        }
      }
    }
    corner(c0, r0, (1 - tx) * (1 - ty));
    corner(c0 + 1, r0, tx * (1 - ty));
    corner(c0, r0 + 1, (1 - tx) * ty);
    corner(c0 + 1, r0 + 1, tx * ty);
  };
  for (let j = 0; j < TILE; j++) {
    const row = (flipRows ? j : TILE - 1 - j) * TILE;
    for (let i = 0; i < TILE; i++) {
      const p = j * TILE + i, cv = cov[p];
      if (cv <= 0) { clear = true; continue; }
      g = grids[lvl[p]]; base = lvl[p] * KEY_LEVEL;
      sumR = sumG = sumB = sumW = 0;
      const k = taps[p], fv = v[p], s = k > 1 ? step[p] : 0, u0 = u[p] - 0.5 * (k - 1) * s;
      const c0 = Math.floor(u0), c1 = Math.floor(u0 + (k - 1) * s) + 1, r0 = Math.floor(fv);
      const ti = (c0 / g.tileW) | 0, tj = (r0 / g.tileH) | 0;
      const src = c0 >= 0 && r0 >= 0 && c1 < g.width && r0 + 1 < g.height && ((c1 / g.tileW) | 0) === ti && (((r0 + 1) / g.tileH) | 0) === tj
        ? tileAt(base + tj * g.tilesX + ti) : undefined;
      if (src === null) { clear = true; continue; } // every sample lands in one tile that has no data
      if (src && src.ch !== 4) {
        // Fast path (almost every pixel): all samples inside one opaque tile, on the same two source rows.
        const d = src.data, ch = src.ch, ty = fv - r0, ra = ((r0 - tj * g.tileH) * src.w - ti * g.tileW) * ch, rb = ra + src.w * ch;
        for (let t = 0; t < k; t++) {
          const fu = u0 + t * s, c = Math.floor(fu), tx = fu - c, a = ra + c * ch, b = rb + c * ch; // same positions collectTiles used
          const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
          const R = d[a] * w00 + d[a + ch] * w10 + d[b] * w01 + d[b + ch] * w11;
          if (ch === 1) { sumR += R; sumG += R; sumB += R; }
          else {
            sumR += R;
            sumG += d[a + 1] * w00 + d[a + 4] * w10 + d[b + 1] * w01 + d[b + 4] * w11;
            sumB += d[a + 2] * w00 + d[a + 5] * w10 + d[b + 2] * w01 + d[b + 5] * w11;
          }
        }
        sumW = k;
      } else {
        for (let t = 0; t < k; t++) tap(u0 + t * s, fv);
      }
      if (sumW <= 1e-6) { clear = true; continue; }
      const o = (row + i) * 4, alpha = (255 * cv * sumW) / k;
      if (post) { const g = post(p, sumR / sumW); out[o] = g; out[o + 1] = g; out[o + 2] = g; }
      else { out[o] = sumR / sumW; out[o + 1] = sumG / sumW; out[o + 2] = sumB / sumW; }
      out[o + 3] = alpha;
      if (alpha < 0.5) clear = true;
      any = true;
    }
  }
  if (!any) return null;
  if (clear) fillClear(out);
  return out;
}

// Scratch for fillClear: alpha-weighted colour sums of the tile at 128x128, 64x64, ... 1x1.
const fillLevels: Float32Array[] = [];
for (let s = TILE >> 1; s >= 1; s >>= 1) fillLevels.push(new Float32Array(s * s * 4));

/**
 * Give every fully transparent pixel the colour of the data around it (it stays transparent).
 * Cesium uploads tiles with straight alpha and builds mipmaps from them, and the GPU's filters
 * average colours without looking at alpha: black see-through pixels would darken the edges of
 * a layer (and thin out sparse maps when zoomed out). Each clear pixel takes the average colour
 * of the smallest square around it (2x2, 4x4, ...) that holds some data.
 */
export function fillClear(px: Uint8ClampedArray) {
  let prev: Float32Array | null = null, size = TILE;
  for (const d of fillLevels) {
    const h = size >> 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < h; x++) {
        let r = 0, gg = 0, b = 0, w = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            if (prev) {
              const o = ((2 * y + dy) * size + 2 * x + dx) * 4;
              r += prev[o]; gg += prev[o + 1]; b += prev[o + 2]; w += prev[o + 3];
            } else {
              const o = ((2 * y + dy) * TILE + 2 * x + dx) * 4, a = px[o + 3];
              r += px[o] * a; gg += px[o + 1] * a; b += px[o + 2] * a; w += a;
            }
          }
        }
        const q = (y * h + x) * 4;
        d[q] = r; d[q + 1] = gg; d[q + 2] = b; d[q + 3] = w;
      }
    }
    prev = d; size = h;
  }
  for (let j = 0; j < TILE; j++) {
    for (let i = 0; i < TILE; i++) {
      const o = (j * TILE + i) * 4;
      if (px[o + 3] !== 0) continue;
      for (let l = 0; l < fillLevels.length; l++) {
        const sh = l + 1, q = ((j >> sh) * (TILE >> sh) + (i >> sh)) * 4, d = fillLevels[l], w = d[q + 3];
        if (w > 0) { px[o] = d[q] / w; px[o + 1] = d[q + 1] / w; px[o + 2] = d[q + 2] / w; break; }
      }
    }
  }
}

/** Moon Trek: the source level of every pixel (display level, capped at maxZ, coarser near the true north pole) and the tiles to fetch. */
export function planTrek(fp: Footprint, r: Rect, displayLevel: number, maxZ: number, minTrueLatDeg: number): Plan | null {
  if (!trekFootprint(fp, r, displayLevel, maxZ, minTrueLatDeg)) return null;
  const grids: Grid[] = [];
  for (let z = 0; z <= trekTop(displayLevel, maxZ); z++) grids.push(trekGrid(z));
  const keys = collectTiles(fp, grids, Infinity) ?? [];
  let level = 0;
  for (const k of keys) level = Math.max(level, Math.floor(k / KEY_LEVEL));
  return { level, grids, keys };
}

/** South of this the polar photo layers cover everything (as for the Moon Trek photo's minTrueLat): the fix stops there. */
export const FIX_MIN_TRUE_LAT = -81.5;

/** Seam fix footprint: Moon Trek geometry with the fix weight as coverage (alpha). False if the fix draws nothing here. */
export function synthFootprint(fp: Footprint, r: Rect, displayLevel: number, maxZ: number): boolean {
  if (!trekGeometry(fp, r, FIX_MIN_TRUE_LAT)) return false;
  let any = false;
  for (let p = 0; p < N2; p++) {
    if (fp.cov[p] <= 0) continue;
    const w = fixWeightDeg(fp.b[p] / DEG);
    fp.cov[p] *= w;
    if (w > 0) any = true;
  }
  if (!any) return false;
  trekCoords(fp, displayLevel, trekTop(displayLevel, maxZ));
  // NASA's hillshade tiles are dark along 180° (computed without wrapping; measured: 1 px at levels <= 7,
  // 2 at 8, 4-5 at 9): read from just inside that edge, so no line shows along the 180° meridian.
  const { u, cov, lvl, taps, step } = fp;
  for (let p = 0; p < N2; p++) {
    if (cov[p] <= 0) continue;
    const z = lvl[p], width = TILE * 2 ** (z + 1), half = 0.5 * (taps[p] - 1) * step[p], m = z >= 9 ? 5 : z >= 8 ? 3 : 2;
    if (u[p] - half < m) u[p] = Math.min(m + half, width / 2);
    else if (u[p] + half > width - 1 - m) u[p] = Math.max(width - 1 - m - half, width / 2);
  }
  return true;
}

/** Seam fix: the hillshade tiles a tile needs. */
export function planSynth(fp: Footprint, r: Rect, displayLevel: number, maxZ: number): Plan | null {
  if (!synthFootprint(fp, r, displayLevel, maxZ)) return null;
  const grids: Grid[] = [];
  for (let z = 0; z <= trekTop(displayLevel, maxZ); z++) grids.push(trekGrid(z));
  const keys = collectTiles(fp, grids, Infinity) ?? [];
  let level = 0;
  for (const k of keys) level = Math.max(level, Math.floor(k / KEY_LEVEL));
  return { level, grids, keys };
}

/**
 * Polar pyramid: pyramid level for this display level (never finer than the photos really are
 * there; null below `minK`) and the squares to fetch.
 */
export function planPyramid(fp: Footprint, r: Rect, displayLevel: number, minK: number): Plan | null {
  const k0 = Math.min(pyramidLevelFor(displayLevel), pyramidMaxKFor(r));
  if (k0 < minK) return null;
  if (!polarGeometry(fp, r, polarRho(POLAR_LIMIT_DEG), POLAR_FEATHER_M, PYRAMID_HALF_M)) return null;
  for (let k = k0; ; k--) {
    pyramidCoords(fp, k);
    const grids = [pyramidGrid(k)], keys = collectTiles(fp, grids, k > minK ? MAX_PYRAMID_TILES : Infinity);
    if (keys) return { level: k, grids, keys };
  }
}

/** Recompute a pyramid footprint (after waiting for downloads, when other tiles used the scratch). */
export function pyramidFootprint(fp: Footprint, r: Rect, k: number) {
  polarGeometry(fp, r, polarRho(POLAR_LIMIT_DEG), POLAR_FEATHER_M, PYRAMID_HALF_M);
  pyramidCoords(fp, k);
}

/** Polar raster: pick the copy whose pixels best match the display pixels and map every pixel onto it. */
export function planRaster(fp: Footprint, r: Rect, raster: Raster, halfM: number, clipTrueLatDeg: number, featherM: number): { grids: Grid[]; src: Src } | null {
  if (!polarGeometry(fp, r, polarRho(clipTrueLatDeg), featherM, halfM)) return null;
  const pxM = ((r.north - r.south) / TILE) * MOON_R, base = raster.levels[0];
  const m = clamp(Math.floor(Math.log2(pxM / ((2 * halfM) / base.w))), 0, raster.levels.length - 1);
  const src = raster.levels[m];
  polarCoords(fp, halfM, src.w / (2 * halfM), src.h / (2 * halfM));
  return { grids: [singleGrid(src)], src };
}

/** Half-size copies down to ~32 px, or `count` of them (box filter; colour weighted by alpha so empty areas don't darken edges). */
export function buildMips(full: Src, count = Infinity, poleAware = false): Raster {
  const levels = [full];
  for (let s = full; Math.min(s.w, s.h) > 32 && levels.length <= count; ) { s = poleAware && s.ch === 1 ? halvePoleAware(s) : halve(s); levels.push(s); }
  return { levels };
}

/**
 * Halve a grey whole-Moon display lon/lat picture so every pixel averages a square patch on the sphere.
 * Near the display poles (true 0°N 90°E / 90°W) one row is a tiny circle: a plain 2x2 average there blurs
 * along the radius only, and the zoomed-out Moon shows radial streaks. Here each output row averages
 * 2/cos(lat) source pixels east-west (wrapping round the Moon). Same rule as halve_pole_aware in base_mosaic.py.
 */
export function halvePoleAware(s: Src): Src {
  const w = s.w >> 1, h = s.h >> 1, W = s.w, d = s.data, out = new Uint8Array(w * h);
  const sum = new Float64Array(3 * W + 1); // prefix sums of the row pair, the row repeated 3 times (wrapping)
  for (let y = 0; y < h; y++) {
    const ra = 2 * y * W, rb = Math.min(2 * y + 1, s.h - 1) * W;
    for (let t = 0, acc = 0; t < 3 * W; t++) { const x = t % W; acc += (d[ra + x] + d[rb + x]) * 0.5; sum[t + 1] = acc; }
    const lat = (90 - ((y + 0.5) * 180) / h) * DEG, k = Math.min(W, 2 / Math.max(Math.cos(lat), 1e-9));
    const at = (x: number) => { const i = Math.floor(x); return sum[i] + (x - i) * (sum[Math.min(i + 1, 3 * W)] - sum[i]); };
    for (let x = 0; x < w; x++) {
      const c = W + 2 * x + 1;
      out[y * w + x] = Math.round((at(c + k / 2) - at(c - k / 2)) / k);
    }
  }
  return { w, h, ch: 1, data: out };
}

/**
 * Cut one display tile straight out of a picture that is already drawn in the display frame
 * (the local whole-Moon picture): the 256x256 pixels whose top-left corner is (px, py). No
 * re-projection, so this costs almost nothing. Null if the tile is not inside the picture.
 */
export function cutTile(src: Src, px: number, py: number, flipRows: boolean): Uint8ClampedArray<ArrayBuffer> | null {
  if (px < 0 || py < 0 || px + TILE > src.w || py + TILE > src.h || src.ch === 4) return null;
  const out = new Uint8ClampedArray(N2 * 4), d = src.data, ch = src.ch;
  for (let j = 0; j < TILE; j++) {
    let o = (flipRows ? j : TILE - 1 - j) * TILE * 4, q = ((py + j) * src.w + px) * ch;
    for (let i = 0; i < TILE; i++, o += 4, q += ch) {
      out[o] = d[q]; out[o + 1] = ch === 1 ? d[q] : d[q + 1]; out[o + 2] = ch === 1 ? d[q] : d[q + 2]; out[o + 3] = 255;
    }
  }
  return out;
}

function halve(s: Src): Src {
  const w = Math.max(1, s.w >> 1), h = Math.max(1, s.h >> 1), ch = s.ch, d = s.data, sw = s.w;
  const out = new Uint8Array(w * h * ch);
  for (let y = 0; y < h; y++) {
    const ra = Math.min(2 * y, s.h - 1) * sw, rb = Math.min(2 * y + 1, s.h - 1) * sw;
    for (let x = 0; x < w; x++) {
      const ca = Math.min(2 * x, sw - 1), cb = Math.min(2 * x + 1, sw - 1);
      const p0 = (ra + ca) * ch, p1 = (ra + cb) * ch, p2 = (rb + ca) * ch, p3 = (rb + cb) * ch, o = (y * w + x) * ch;
      if (ch === 4) {
        const a0 = d[p0 + 3], a1 = d[p1 + 3], a2 = d[p2 + 3], a3 = d[p3 + 3], A = a0 + a1 + a2 + a3;
        for (let q = 0; q < 3; q++) out[o + q] = A > 0 ? Math.round((d[p0 + q] * a0 + d[p1 + q] * a1 + d[p2 + q] * a2 + d[p3 + q] * a3) / A) : 0;
        out[o + 3] = (A + 2) >> 2;
      } else {
        for (let q = 0; q < ch; q++) out[o + q] = (d[p0 + q] + d[p1 + q] + d[p2 + q] + d[p3 + q] + 2) >> 2;
      }
    }
  }
  return { w, h, ch, data: out };
}

/**
 * Stores RGBA pixels (arriving strip by strip) as compactly as they allow: grey if every pixel is
 * grey and opaque (the photos: 1 byte per pixel), RGB if opaque, else RGBA.
 */
export class Packer {
  ch: 1 | 3 | 4 = 1;
  data: Uint8Array;
  private readonly w: number;
  private readonly h: number;
  constructor(w: number, h: number) { this.w = w; this.h = h; this.data = new Uint8Array(w * h); }

  /** Add RGBA pixels `px` that start at pixel index `at`. */
  add(px: Uint8ClampedArray, at: number) {
    for (let q = 0; q < px.length; q += 4, at++) {
      const R = px[q], G = px[q + 1], B = px[q + 2], A = px[q + 3];
      if (this.ch === 1) {
        if (A === 255 && R === G && G === B) { this.data[at] = R; continue; }
        this.widen(A === 255 ? 3 : 4, at);
      }
      if (this.ch === 3) {
        if (A === 255) { const o = at * 3; this.data[o] = R; this.data[o + 1] = G; this.data[o + 2] = B; continue; }
        this.widen(4, at);
      }
      const o = at * 4, d = this.data;
      d[o] = R; d[o + 1] = G; d[o + 2] = B; d[o + 3] = A;
    }
  }

  /** The first colour or see-through pixel: re-store the `filled` pixels so far with more channels. */
  private widen(to: 3 | 4, filled: number) {
    const from = this.ch, old = this.data, nd = new Uint8Array(this.w * this.h * to);
    for (let q = 0; q < filled; q++) {
      const s = q * from, o = q * to;
      nd[o] = old[s]; nd[o + 1] = old[from === 1 ? s : s + 1]; nd[o + 2] = old[from === 1 ? s : s + 2];
      if (to === 4) nd[o + 3] = from === 4 ? old[s + 3] : 255;
    }
    this.data = nd;
    this.ch = to;
  }

  result(): Src { return { w: this.w, h: this.h, ch: this.ch, data: this.data }; }
}

// ---------------------------------------------------------------------------------------------
// Messages between the main thread (imagery.ts) and the worker.

/** One picture of the local whole-Moon set: cut the tile at pixel (px, py) out of its copy `mip` times halved. */
export interface BaseCut { url: string; mip: number; px: number; py: number; mips: number; poleAware?: boolean }

export type Job =
  | { kind: 'trek'; rect: Rect; level: number; layer: string; ext: string; maxSourceLevel: number; minTrueLat: number }
  | { kind: 'raster'; rect: Rect; level: number; url: string; extentM: number; clipTrueLat: number; featherM: number }
  /** local = folder of the stored squares (with its index.json), or null/undefined to always ask the remote server. */
  | { kind: 'pyramid'; rect: Rect; level: number; layers: string; minK: number; local?: string | null }
  /** quick = a small picture that can stand in while the big one is still being decoded (same pixels at this level). */
  | { kind: 'base'; rect: Rect; level: number; cut: BaseCut; quick?: BaseCut }
  /** The seam fix: albedo x hillshade where the WAC mosaic is lit from the east (see fixWeightDeg). */
  | { kind: 'synth'; rect: Rect; level: number; fix: FixParams };

/**
 * A tile to draw; or (when the browser is back online) "try every failed download again"; or
 * the list of pyramid squares stored with the app (sent once, before the first pyramid job).
 */
export type ToWorker = { id: number; job: Job; flipRows: boolean } | { forgetFailures: true } | { pyramidIndex: unknown; base: string };
/**
 * A finished tile. gaps = it could not be drawn in full because a download failed for now (worth
 * asking for again later); recovered = a server that was failing answers again; parent = draw
 * nothing new here, keep showing the parent tile (the data has no finer detail, or it could not
 * be downloaded); net = this worker's download counts so far [local files, remote, failed].
 */
export interface FromWorker { id: number; bitmap: ImageBitmap | null; gaps: boolean; recovered: boolean; parent?: boolean; net?: [number, number, number] }

/** After a failed download, wait this long before asking that server for the same picture again (unless it recovers sooner). */
export const RETRY_MS = 20_000;

// ---------------------------------------------------------------------------------------------
// The worker: downloads, decoding, caches and the message loop. Only runs inside a Web Worker.

const NET_LIMIT = 8; // downloads at once per worker
// Browsers open at most 6 connections per server over HTTP/1.1 (which Moon Trek uses); more
// requests would only queue inside the browser while our timeout ticks. All Moon Trek layers
// live on one worker (imagery.ts), so this limit covers all of trek.nasa.gov.
const HOST_LIMIT = 6;
const LOCAL_LIMIT = 16; // files stored with the app: fast, and never held back behind remote downloads
const FETCH_TIMEOUT_MS = 20_000;
// A server that failed this many times in a row is treated as down: one download at a time then
// checks whether it is back and the others wait for its answer instead of each running into its
// own 20 s timeout. So a dead server costs one timeout per round of tiles, not one per picture.
const BREAKER_AFTER = 4;
const TILE_CACHE_BYTES = 48 * 2 ** 20; // decoded source tiles kept per worker (two such workers)
const RASTER_BUDGET_BYTES = 150 * 2 ** 20; // decoded polar rasters kept: the photo and six science maps (21.3 MiB each with smaller copies)
const RASTER_IN_USE_MS = 8_000; // a raster asked for this recently is never dropped to make room (no reload churn)

type Got = Src | 'missing' | null; // 'missing' = the server says it has no such tile (404); null = failed for now
type Drawn = { px: Uint8ClampedArray<ArrayBuffer> | null; gaps: boolean; parent?: boolean };
const NOTHING: Drawn = { px: null, gaps: false };
/** A download failed: draw nothing new, keep showing the parent tile (it is sharper than a hole), and ask again later. */
const PARENT_FOR_NOW: Drawn = { px: null, gaps: true, parent: true };
/** Downloads so far: [files stored with the app, remote, failed]. Reported with every answer (for tests and the loading screen). */
const net: [number, number, number] = [0, 0, 0];

/** "https://host:port" of a URL: downloads are limited, and failures remembered, per server. */
const originOf = (url: string) => { const i = url.indexOf('/', url.indexOf('//') + 2); return i < 0 ? url : url.slice(0, i); };

let netActive = 0, localActive = 0;
const hostActive = new Map<string, number>();
const netWaiting: { host: string; go: () => void }[] = [];
const localWaiting: (() => void)[] = [];
/** Start waiting downloads, oldest first, while there are free slots (overall and for that server). */
function pump() {
  for (let q = 0; q < netWaiting.length && netActive < NET_LIMIT; ) {
    const { host, go } = netWaiting[q], busy = hostActive.get(host) ?? 0;
    if (busy >= HOST_LIMIT) { q++; continue; }
    netWaiting.splice(q, 1);
    netActive++;
    hostActive.set(host, busy + 1);
    go();
  }
  while (localWaiting.length && localActive < LOCAL_LIMIT) { localActive++; localWaiting.shift()!(); }
}
const netAcquire = (host: string, local: boolean) => new Promise<void>(go => { if (local) localWaiting.push(go); else netWaiting.push({ host, go }); pump(); });
function netRelease(host: string, local: boolean) {
  if (local) localActive--; else { netActive--; hostActive.set(host, (hostActive.get(host) ?? 1) - 1); }
  pump();
}

/** "nasa.gov" of "https://trek.nasa.gov": Lunaserv spreads its tiles over eight host names of one server. */
const siteOf = (url: string) => { const m = /([^./]+\.[^./:]+)(:\d+)?$/.exec(originOf(url)); return m ? m[1] : url; };
interface Breaker { fails: number; probe: Promise<boolean> | null }
const breakers = new Map<string, Breaker>();

// Network health. A failed download is not tried again for RETRY_MS, unless its server has
// answered since (it recovered) or the main thread says the browser is back online.
const failingHosts = new Set<string>();
const hostBackAt = new Map<string, number>();
let forgetBefore = 0;
let recovered = false;

/** True while a download that failed at time `at` should not be tried again yet. */
function stillFailing(at: number, url: string): boolean {
  return performance.now() - at < RETRY_MS && at > Math.max(forgetBefore, hostBackAt.get(originOf(url)) ?? 0);
}

function answered(host: string) {
  if (failingHosts.delete(host)) { hostBackAt.set(host, performance.now()); recovered = true; }
}

/** The app's own address: files from there are stored with the app (fast, there with no internet). */
const OWN = typeof location !== 'undefined' && location.origin ? `${location.origin}/` : null;

/** Download a picture. `local` = a file stored with the app (its own queue, no server-health bookkeeping). */
async function fetchBlob(url: string, local = OWN !== null && url.startsWith(OWN)): Promise<Blob | 'missing' | null> {
  const host = originOf(url);
  let br: Breaker | undefined, probed: ((ok: boolean) => void) | undefined;
  if (!local) {
    const site = siteOf(url);
    br = breakers.get(site);
    if (!br) breakers.set(site, (br = { fails: 0, probe: null }));
  }
  const down = () => br !== undefined && br.fails >= BREAKER_AFTER;
  for (;;) {
    while (down() && br!.probe) if (!(await br!.probe)) { net[2]++; return null; } // the server is still down
    if (down()) br!.probe = new Promise<boolean>(res => { probed = res; }); // this download finds out whether it is back
    await netAcquire(host, local);
    if (probed || !down()) break;
    netRelease(host, local); // the server went down while this download waited for its turn
  }
  const done = (ok: boolean) => { if (br) { br.fails = ok ? 0 : br.fails + 1; if (probed) { br.probe = null; probed(ok); } } };
  net[local ? 0 : 1]++;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { mode: 'cors', credentials: 'omit', signal: ctl.signal });
    if (r.status === 404) { answered(host); done(true); return 'missing'; }
    if (r.ok) { const blob = await r.blob(); answered(host); done(true); return blob; }
  } catch {
    // offline, timed out, or answered without the CORS header (cross-origin errors look the same)
  } finally {
    clearTimeout(timer);
    netRelease(host, local);
  }
  net[2]++;
  if (!local) failingHosts.add(host);
  done(false);
  return null; // the tile that needed it keeps showing its parent for now
}

const canvases = new Map<string, OffscreenCanvasRenderingContext2D>();
function canvas2d(w: number, h: number): OffscreenCanvasRenderingContext2D {
  const key = `${w}x${h}`;
  let ctx = canvases.get(key);
  if (!ctx) {
    const c = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
    if (!c) throw new Error('No 2D canvas in this worker');
    canvases.set(key, ctx = c);
  }
  return ctx;
}

/** Decode a picture into the most compact form (grey/RGB/RGBA), reading big pictures in strips to keep memory low. */
async function decode(blob: Blob): Promise<Src> {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    const w = bmp.width, h = bmp.height, stripH = clamp(Math.floor(2 ** 20 / w), 1, h), ctx = canvas2d(w, stripH);
    const pack = new Packer(w, h);
    for (let y = 0; y < h; y += stripH) {
      const sh = Math.min(stripH, h - y);
      ctx.clearRect(0, 0, w, sh);
      ctx.drawImage(bmp, 0, y, w, sh, 0, 0, w, sh);
      pack.add(ctx.getImageData(0, 0, w, sh).data, y * w);
    }
    return pack.result();
  } finally {
    bmp.close();
  }
}

/** Least-recently-used memory of decoded source tiles, with shared downloads. */
class TileCache {
  private readonly items = new Map<string, Src | 'missing'>();
  private readonly loading = new Map<string, Promise<Got>>();
  private readonly failed = new Map<string, { at: number; url: string }>();
  private readonly budget: number;
  private bytes = 0;
  constructor(budget: number) { this.budget = budget; }

  private recent(key: string): Src | 'missing' | null | undefined {
    const t = this.items.get(key);
    if (t !== undefined) { this.items.delete(key); this.items.set(key, t); return t; } // mark as recently used
    const f = this.failed.get(key);
    if (f && stillFailing(f.at, f.url)) return null;
    return undefined;
  }

  /** All tiles if they are already known (no waiting), else null. */
  peekAll(keys: string[]): Got[] | null {
    const out: Got[] = [];
    for (const k of keys) { const t = this.recent(k); if (t === undefined) return null; out.push(t); }
    return out;
  }

  /**
   * The tile, from memory or downloaded once. With `localUrl` the copy stored with the app is read
   * first and `url` (the remote server) is only asked if that copy is missing or unreadable.
   */
  get(key: string, url: string, localUrl?: string): Promise<Got> {
    const t = this.recent(key);
    if (t !== undefined) return Promise.resolve(t);
    let p = this.loading.get(key);
    if (!p) {
      p = (async (): Promise<Got> => {
        let got: Got = localUrl ? await this.load(localUrl, true) : null;
        if (!localUrl || got === null || got === 'missing') got = await this.load(url, false);
        this.loading.delete(key);
        if (got === null) this.fail(key, url);
        else { this.failed.delete(key); this.put(key, got); }
        return got;
      })();
      this.loading.set(key, p);
    }
    return p;
  }

  private async load(url: string, local: boolean): Promise<Got> {
    const blob = await fetchBlob(url, local);
    if (blob === 'missing' || blob === null) return blob;
    return decode(blob).catch(() => null); // e.g. an error page instead of a picture
  }

  private fail(key: string, url: string) {
    this.failed.set(key, { at: performance.now(), url });
    if (this.failed.size > 4096) for (const [k, f] of this.failed) if (!stillFailing(f.at, f.url)) this.failed.delete(k); // forget old failures
  }

  private put(key: string, t: Src | 'missing') {
    this.items.set(key, t);
    this.bytes += t === 'missing' ? 64 : t.data.length;
    for (const [k, old] of this.items) {
      if (this.bytes <= this.budget) break;
      this.items.delete(k);
      this.bytes -= old === 'missing' ? 64 : old.data.length;
    }
  }
}

interface RasterEntry { promise: Promise<Raster | null>; bytes: number; used: number; failedAt: number }
interface DepthEntry { depth: number | null; failedAt: number; pending: Promise<number | null> | null }
interface BaseEntry { promise: Promise<Raster | null>; raster: Raster | null; failedAt: number }

function startWorker() {
  const fp = new Footprint();
  const tiles = new TileCache(TILE_CACHE_BYTES);
  const depths = new Map<string, DepthEntry>();
  const rasters = new Map<string, RasterEntry>();
  const basePictures = new Map<string, BaseEntry>();
  /** The pyramid squares stored with the app (told once by the main thread), and their folder. */
  let stored: { base: string; index: PyramidIndex | null } | null = null;

  /**
   * Deepest level the Moon Trek server really has for a layer (read once from its WMTS
   * description), Infinity if it has no description, or null while that is not known (offline).
   */
  function trekDepth(layer: string): Promise<number | null> {
    let e = depths.get(layer);
    if (!e) depths.set(layer, (e = { depth: null, failedAt: 0, pending: null }));
    const url = trekCapabilitiesUrl(layer);
    if (e.depth !== null || e.pending || (e.failedAt && stillFailing(e.failedAt, url))) return e.pending ?? Promise.resolve(e.depth);
    const entry = e;
    entry.pending = (async () => {
      const blob = await fetchBlob(url);
      const xml = blob && blob !== 'missing' ? await blob.text().catch(() => null) : null;
      const depth = blob === 'missing' ? Infinity : xml === null ? null : parseTrekDepth(xml) ?? Infinity;
      entry.pending = null;
      if (depth === null) entry.failedAt = performance.now(); else entry.depth = depth;
      return depth;
    })();
    return entry.pending;
  }

  async function runTrek(job: Extract<Job, { kind: 'trek' }>, flip: boolean): Promise<Drawn> {
    // Never ask for levels the server does not have (e.g. the LOLA colour map stops at level 6):
    // in a browser those would fail like a network error and leave the layer transparent.
    const depth = await trekDepth(job.layer);
    const maxZ = Math.min(job.maxSourceLevel, depth ?? Infinity);
    const plan = planTrek(fp, job.rect, job.level, maxZ, job.minTrueLat);
    if (!plan) return NOTHING;
    const keyOf = (k: number) => `${job.layer}/${k}`;
    let got = tiles.peekAll(plan.keys.map(keyOf));
    if (!got) {
      got = await Promise.all(plan.keys.map(k => { const t = trekTileOf(k); return tiles.get(keyOf(k), trekUrl(job.layer, job.ext, t.z, t.x, t.y)); }));
      if (got.includes(null)) return PARENT_FOR_NOW;
      trekFootprint(fp, job.rect, job.level, maxZ, job.minTrueLat); // other tiles used the scratch meanwhile
    }
    if (got.includes(null)) return PARENT_FOR_NOW;
    return { px: sampleTiles(fp, plan.grids, plan.keys, got.map(t => (t === 'missing' ? null : t)), flip), gaps: false };
  }

  /** Seam fix tile: Moon Trek hillshade tiles x the local brightness-matched albedo, see-through where the photo shows. */
  async function runSynth(job: Extract<Job, { kind: 'synth' }>, flip: boolean): Promise<Drawn> {
    const { fix } = job, shade = fixShadeFor(fix, job.rect);
    const plan = planSynth(fp, job.rect, job.level, shade.maxZ);
    if (!plan) return NOTHING;
    const albedo = await rasterFor(fix.albedo.url);
    if (!albedo) return { px: null, gaps: true };
    const keyOf = (k: number) => `${shade.layer}/${k}`;
    let got = tiles.peekAll(plan.keys.map(keyOf));
    if (!got) {
      got = await Promise.all(plan.keys.map(k => { const t = trekTileOf(k); return tiles.get(keyOf(k), trekUrl(shade.layer, 'png', t.z, t.x, t.y)); }));
      if (got.includes(null)) return PARENT_FOR_NOW;
    }
    if (got.includes(null)) return PARENT_FOR_NOW;
    synthFootprint(fp, job.rect, job.level, shade.maxZ); // other tiles used the scratch meanwhile
    const a = albedo.levels[0], { west, east, north, south, scale } = fix.albedo, { C, S0 } = fix;
    const post = (p: number, s: number) => sampleLonLat(a, west, east, north, south, fp.a[p], fp.b[p]) * scale * Math.exp(C * (s / S0 - 1));
    return { px: sampleTiles(fp, plan.grids, plan.keys, got.map(t => (t === 'missing' ? null : t)), flip, post), gaps: false };
  }

  async function runPyramid(job: Extract<Job, { kind: 'pyramid' }>, flip: boolean): Promise<Drawn> {
    const plan = planPyramid(fp, job.rect, job.level, job.minK);
    if (!plan) return NOTHING;
    const k = plan.level, n = plan.grids[0].tilesX;
    const keyOf = (q: number) => `${job.layers}/${k}/${q}`;
    let got = tiles.peekAll(plan.keys.map(keyOf));
    if (!got) {
      // Local first: squares stored with the app are read from disk; the remote server is only asked for the rest.
      const base = job.local, index = base && stored && stored.base === base && stored.index?.layers === job.layers ? stored.index : null;
      got = await Promise.all(plan.keys.map(q => {
        const i = q % n, j = Math.floor(q / n);
        return tiles.get(keyOf(q), pyramidUrl(job.layers, k, i, j), base && pyramidHasLocal(index, k, i, j) ? pyramidLocalUrl(base, k, i, j) : undefined);
      }));
      if (got.includes(null)) return PARENT_FOR_NOW;
      pyramidFootprint(fp, job.rect, k);
    }
    if (got.includes(null)) return PARENT_FOR_NOW;
    return { px: sampleTiles(fp, plan.grids, plan.keys, got.map(t => (t === 'missing' ? null : t)), flip), gaps: false };
  }

  /** A picture of the local whole-Moon set, decoded once and kept (with as many half-size copies as its tiles need). */
  function basePicture(c: BaseCut): BaseEntry {
    let e = basePictures.get(c.url);
    if (e && e.failedAt && !stillFailing(e.failedAt, c.url)) { basePictures.delete(c.url); e = undefined; }
    if (!e) {
      const entry: BaseEntry = { promise: Promise.resolve(null), raster: null, failedAt: 0 };
      entry.promise = (async () => {
        const blob = await fetchBlob(c.url, true);
        const raster = blob && blob !== 'missing' ? await decode(blob).then(s => buildMips(s, c.mips, !!c.poleAware), () => null) : null;
        if (raster) entry.raster = raster;
        else { entry.failedAt = performance.now(); console.warn('Local Moon picture not available:', c.url); }
        return raster;
      })();
      basePictures.set(c.url, (e = entry));
    }
    return e;
  }

  async function runBase(job: Extract<Job, { kind: 'base' }>, flip: boolean): Promise<Drawn> {
    const big = basePicture(job.cut);
    let cut = job.cut, raster = big.raster;
    if (!raster && job.quick) { // the big picture is still being decoded: the small one has the same pixels at this level
      const small = await basePicture(job.quick).promise;
      if (small && !big.raster) { cut = job.quick; raster = small; }
    }
    raster ??= await big.promise;
    const src = raster?.levels[cut.mip];
    if (!src) return { px: null, gaps: true };
    return { px: cutTile(src, cut.px, cut.py, flip), gaps: false };
  }

  function rasterFor(url: string): Promise<Raster | null> {
    const now = performance.now();
    let e = rasters.get(url);
    if (e && e.failedAt && !stillFailing(e.failedAt, url)) { rasters.delete(url); e = undefined; } // try a failed picture again
    if (!e) {
      const entry: RasterEntry = { promise: Promise.resolve(null), bytes: 0, used: now, failedAt: 0 };
      entry.promise = (async () => {
        const blob = await fetchBlob(url);
        const raster = blob && blob !== 'missing' ? await decode(blob).then(buildMips, () => null) : null;
        if (!raster) { entry.failedAt = performance.now(); console.warn('Polar map not available:', url); return null; } // transparent, never a black globe
        entry.bytes = raster.levels.reduce((s, l) => s + l.data.length, 0);
        trimRasters(entry);
        return raster;
      })();
      rasters.set(url, e = entry);
    }
    e.used = now;
    return e.promise;
  }

  /**
   * Keep the decoded polar maps under budget by forgetting the one used longest ago (it reloads
   * if needed). Maps asked for in the last few seconds are on screen: if only those are left we
   * go over budget instead, rather than dropping and re-decoding a map that is in use.
   */
  function trimRasters(keep: RasterEntry) {
    const now = performance.now();
    let total = 0;
    for (const e of rasters.values()) total += e.bytes;
    while (total > RASTER_BUDGET_BYTES) {
      let oldest: [string, RasterEntry] | undefined;
      for (const kv of rasters) {
        const e = kv[1];
        if (e !== keep && e.bytes > 0 && now - e.used > RASTER_IN_USE_MS && (!oldest || e.used < oldest[1].used)) oldest = kv;
      }
      if (!oldest) break;
      rasters.delete(oldest[0]);
      total -= oldest[1].bytes;
    }
  }

  async function runRaster(job: Extract<Job, { kind: 'raster' }>, flip: boolean): Promise<Drawn> {
    const raster = await rasterFor(job.url);
    if (!raster) return { px: null, gaps: true };
    const plan = planRaster(fp, job.rect, raster, job.extentM, job.clipTrueLat, job.featherM);
    return { px: plan ? sampleTiles(fp, plan.grids, [0], [plan.src], flip) : null, gaps: false };
  }

  async function handle({ id, job, flipRows }: Extract<ToWorker, { job: Job }>) {
    let bitmap: ImageBitmap | null = null, gaps = true, parent = false;
    try {
      const d = job.kind === 'trek' ? await runTrek(job, flipRows) : job.kind === 'pyramid' ? await runPyramid(job, flipRows)
        : job.kind === 'base' ? await runBase(job, flipRows) : job.kind === 'synth' ? await runSynth(job, flipRows) : await runRaster(job, flipRows);
      gaps = d.gaps; parent = !!d.parent;
      if (d.px) bitmap = await createImageBitmap(new ImageData(d.px, TILE, TILE), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    } catch (err) {
      console.warn('Imagery tile failed:', err); // the main thread shows a transparent tile instead
    }
    const msg: FromWorker = { id, bitmap, gaps, recovered, parent, net: [net[0], net[1], net[2]] };
    recovered = false;
    self.postMessage(msg, { transfer: bitmap ? [bitmap] : [] });
  }

  self.onmessage = (e: MessageEvent<ToWorker>) => {
    const m = e.data;
    if ('forgetFailures' in m) { forgetBefore = performance.now(); for (const b of breakers.values()) b.fails = 0; }
    else if ('pyramidIndex' in m) stored = { base: m.base, index: parsePyramidIndex(m.pyramidIndex) };
    else void handle(m);
  };
}

if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope === 'function') startWorker();
