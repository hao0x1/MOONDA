// Imagery worker: downloads NASA map pictures, decodes them and re-projects them into the square
// tiles Cesium drapes over the 3D Moon. It all runs off the main thread so the view stays smooth
// while new detail streams in.
//
// Why re-project? We rotate the Moon inside Cesium so the south pole sits on Cesium's equator
// (see frame.ts). Cesium asks for lon/lat tiles of that rotated DISPLAY frame, but every NASA
// picture is drawn in the TRUE Moon frame. So for each pixel of a display tile we work out where
// it is on the real Moon and read the source picture there (bilinear, like a GPU would).
//
// Source pictures:
//   base    - the whole-Moon picture stored with the app, already drawn in the display frame:
//             tiles are simply cut out of it (instant, works with no internet)
//   trek    - NASA Moon Trek global tiles (true lon/lat grid, 256 px tiles, level 0 = 2x1 tiles)
//   photo   - close views: Kaguya TC, bounded NAC site mosaics, north-pole NAC; same layer
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
const MAX_TREK_LEVEL = 16; // NAC site mosaics need finer grids than the global WAC photo

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

// Sharper photos share the existing photo layer: no extra globe texture is needed.
export const PHOTO_TC = 'Kaguya_TCortho_Mosaic_Global_4096ppd';
// The catalogue says 7.4 m; the LIVE WMTS stops at z10 (20.8 m). z11/12 return 404.
export const PHOTO_TC_MAX_Z = 10;
export const PHOTO_FINE_TC_MAX_Z = 12; // 5.2 m delivery grid, native evening TC observations are 7.4 m
export const NORTH_PHOTO_LAT = 84;
export const NORTH_PHOTO_HALF_M = 931070; // QuickMap lunar-sterenp grid, from its live catalogue
export const NORTH_PHOTO_MAX_Z = 12; // 0.888 m grid; the controlled NAC mosaic itself is 1 m
export interface PhotoRegion { layer: string; maxZ: number; west: number; south: number; east: number; north: number; quickmap?: boolean; global?: boolean }
export const PHOTO_FINE_TC: PhotoRegion = { layer: 'kag_tc_e_7m', maxZ: PHOTO_FINE_TC_MAX_Z, west: -180, south: -90, east: 180, north: 90, quickmap: true, global: true };
const PHOTO_MORNING_TC: PhotoRegion = { ...PHOTO_FINE_TC, layer: 'kag_tc_m_7m' };
// Bounds from Moon Trek's live catalogue, checked 14 Nov 2026. Never fetch a whole globe of NAC tiles.
export const PHOTO_REGIONS: readonly PhotoRegion[] = [
  { layer: 'LRO_NAC_Apollo11_Mosaic_p', maxZ: 15, west: 23.4484977, south: 0.1464484, east: 23.5396839, north: 1.1149051 },
  { layer: 'LRO_NAC_Apollo12_Mosaic_p', maxZ: 16, west: -23.444516, south: -3.4716075, east: -23.3574736, north: -2.5021693 },
  { layer: 'LRO_NAC_Apollo14_Mosaic_p', maxZ: 15, west: -17.4900752, south: -4.1920876, east: -17.3907622, north: -3.2253601 },
  { layer: 'LRO_NAC_Apollo15_Mosaic_p', maxZ: 16, west: 3.5805462, south: 25.7964334, east: 3.6893852, north: 26.7634904 },
  { layer: 'LRO_NAC_Apollo16_Mosaic_p', maxZ: 14, west: 15.3788327, south: -9.6060973, east: 15.5545346, north: -8.6616783 },
  { layer: 'NAC_DTM_APOLLO17_MOSAIC_120CM', maxZ: 14, west: 29.9059014, south: 19.3905439, east: 31.6579562, north: 21.3035034 },
  { layer: 'LRO_NAC_Mosaic_43S349E_50cmp', maxZ: 14, west: -12.10517, south: -43.6431726, east: -10.3007028, north: -42.3234729 },
  { layer: 'LRO_NAC_Post_Landing_OrthoMosaic_1mpp_IM_1_LandingSite', maxZ: 13, west: 0.9386801, south: -80.2163532, east: 1.9391742, north: -80.0428121 },
  { layer: 'LRO_NAC_Mosaic_50cmpp_VonKarman_v2', maxZ: 15, west: 171.4493162, south: -48.9293994, east: 179.9242867, north: -42.0188174 },
  { layer: 'LRO_NAC_Mosaic_0_82mpp_Shioli', maxZ: 15, west: 25.0600958, south: -14.1732319, east: 25.8436614, north: -12.587345 },
  { layer: 'LRO_NAC_ortho_horseshoeV2', maxZ: 15, west: 61.3920203, south: 16.6078286, east: 62.2274717, north: 20.0912737 },
  { layer: 'wac_nac_nacroi', quickmap: true, maxZ: 15, west: -19.5516000, south: 44.0814000, east: -19.4716000, north: 44.1614000 },
  { layer: 'wac_nac_nacroi', quickmap: true, maxZ: 15, west: -51.9569000, south: 43.0180000, east: -51.8769000, north: 43.0980000 },
  { layer: 'wac_nac_nacroi', quickmap: true, maxZ: 15, west: -154.0250000, south: -41.6785000, east: -153.9450000, north: -41.5985000 },
  { layer: 'wac_nac_nacroi', quickmap: true, maxZ: 15, west: 32.2790000, south: -69.4130000, east: 32.3590000, north: -69.3330000 },
  { layer: 'wac_nac_nacroi', quickmap: true, maxZ: 15, west: 22.7440000, south: -70.9210000, east: 22.8240000, north: -70.8410000 },
  { layer: 'wac_nac_nacroi', quickmap: true, maxZ: 15, west: 19.3096000, south: 32.5556000, east: 19.3896000, north: 32.6356000 },
  { layer: 'wac_nac_nacroi', quickmap: true, maxZ: 15, west: 44.0550000, south: 47.5410000, east: 44.1350000, north: 47.6210000 },
  { layer: 'wac_nac_nacroi', quickmap: true, maxZ: 15, west: -4.6400000, south: 60.7690000, east: -4.5600000, north: 60.8490000 },
];

/** Conservative true-frame box; small display tiles only, with a margin for curved edges. */
export function photoRegionsFor(r: Rect): PhotoRegion[] {
  const lat = tileTrueLatRange(r);
  if (lat.maxDeg > 83 || lat.minDeg < -83) return [];
  let west = Infinity, east = -Infinity;
  for (const a of [r.south, (r.south + r.north) / 2, r.north]) {
    for (const b of [r.west, (r.west + r.east) / 2, r.east]) {
      const lon = Math.atan2(Math.sin(a), Math.cos(a) * Math.cos(b)) / DEG;
      west = Math.min(west, lon); east = Math.max(east, lon);
    }
  }
  const pad = 2 * (r.east - r.west) / DEG;
  return PHOTO_REGIONS.filter(p => lat.minDeg <= p.north + pad && lat.maxDeg >= p.south - pad && west <= p.east + pad && east >= p.west - pad);
}

/** A whole display tile lies safely inside the NAC feather: TC underneath would be wasted. */
export function photoRegionCovers(r: Rect, region: PhotoRegion): boolean {
  for (const a of [r.south, (r.south + r.north) / 2, r.north]) for (const b of [r.west, (r.west + r.east) / 2, r.east]) {
    const la = Math.asin(-Math.cos(a) * Math.sin(b)), lo = Math.atan2(Math.sin(a), Math.cos(a) * Math.cos(b));
    const edge = Math.min((lo / DEG - region.west) * Math.cos(la), (region.east - lo / DEG) * Math.cos(la), la / DEG - region.south, region.north - la / DEG);
    if (edge * DEG * MOON_R < 321) return false;
  }
  return true;
}

/** Deepest level with real new information; north polar tiles use a square polar grid. */
export function photoMaxLevel(r: Rect): number {
  const lat = tileTrueLatRange(r);
  if (lat.maxDeg > NORTH_PHOTO_LAT) return 15;
  return Math.max(PHOTO_FINE_TC_MAX_Z + 1, ...photoRegionsFor(r).map(p => p.maxZ + 1));
}

/** Add only the detail missing from a coarser photo. The low frequencies and brightness stay
 * anchored to WAC, at the same true-frame pixels across ALL tiles and zooms. Per-output-tile
 * mean matching would create a checkerboard, and change brightness when the camera moves. */
export function addPhotoDetail(base: Uint8ClampedArray, sharp: Uint8ClampedArray | null, low: Uint8ClampedArray | null, gain = 0.85): void {
  if (!sharp || !low) return;
  for (let o = 0; o < base.length; o += 4) {
    const w = Math.min(sharp[o + 3], low[o + 3]) / 255;
    if (w <= 0 || !base[o + 3]) continue;
    const d = gain * w * (sharp[o] - low[o]);
    base[o] += d; base[o + 1] += d; base[o + 2] += d;
  }
}

/** A continuous exposure match to the fixed WAC reference. Source alpha removes only the
 * detail-free black; textured shadows remain. The reference is identical across tiles/zooms. */
export function matchPhotoTone(base: Uint8ClampedArray, sharp: Uint8ClampedArray | null, low: Uint8ClampedArray | null, reference: Uint8ClampedArray): void {
  if (!sharp || !low) return;
  for (let o = 0; o < base.length; o += 4) {
    const w = Math.min(sharp[o + 3], low[o + 3]) / 255;
    if (!w || !base[o + 3]) continue;
    const gain = clamp(reference[o] / Math.max(8, low[o]), 0.25, 4);
    const value = sharp[o] * gain;
    base[o] = base[o + 1] = base[o + 2] = base[o] * (1 - w) + value * w;
  }
}

/** Geographic source footprint clipped to a real mosaic. Keep its outer 80 m out of the
 * blend (source resampling can leave a bright border), then feather over 240 metres. */
export function regionFootprint(fp: Footprint, r: Rect, displayLevel: number, maxZ: number, region?: PhotoRegion): boolean {
  if (!trekGeometry(fp, r, FIX_MIN_TRUE_LAT)) return false;
  let any = false;
  if (region && !region.global) for (let p = 0; p < N2; p++) {
    if (!fp.cov[p]) continue;
    const la = fp.a[p] / DEG, lo = fp.b[p] / DEG;
    const edge = Math.min((lo - region.west) * Math.cos(fp.a[p]), (region.east - lo) * Math.cos(fp.a[p]), la - region.south, region.north - la);
    fp.cov[p] *= smooth((edge * DEG * MOON_R - 80) / 240);
    any ||= fp.cov[p] > 0;
  }
  else any = true;
  if (any) trekCoords(fp, displayLevel, trekTop(displayLevel, maxZ));
  return any;
}

export function planPhotoRegion(fp: Footprint, r: Rect, displayLevel: number, maxZ: number, region?: PhotoRegion): Plan | null {
  if (!regionFootprint(fp, r, displayLevel, maxZ, region)) return null;
  const grids = Array.from({ length: trekTop(displayLevel, maxZ) + 1 }, (_, z) => region?.quickmap ? { tileW: 512, tileH: 512, tilesX: 2 ** z, width: 512 * 2 ** z, height: 256 * 2 ** z, global: true } : trekGrid(z));
  return { level: Math.min(displayLevel, maxZ), grids, keys: collectTiles(fp, grids, Infinity) ?? [] };
}

/** Controlled north-pole NAC, using QuickMap's cached polar tiles rather than slow WMS renders. */
export function northFootprint(fp: Footprint, r: Rect, k: number): boolean {
  if (!polarGeometry(fp, r, polarRho(-NORTH_PHOTO_LAT), 5000, NORTH_PHOTO_HALF_M, true)) return false;
  const s = PYRAMID_PX * 2 ** k / (2 * NORTH_PHOTO_HALF_M);
  polarCoords(fp, NORTH_PHOTO_HALF_M, s, s);
  return true;
}
export function planNorthPhoto(fp: Footprint, r: Rect, displayLevel: number): Plan | null {
  const k = clamp(Math.ceil(Math.log2(2 * NORTH_PHOTO_HALF_M / (PYRAMID_PX * pixelMetres(displayLevel)))), 0, NORTH_PHOTO_MAX_Z);
  if (!northFootprint(fp, r, k)) return null;
  const grids = [pyramidGrid(k)];
  return { level: k, grids, keys: collectTiles(fp, grids, MAX_PYRAMID_TILES) ?? [] };
}
export function northPhotoUrl(k: number, i: number, j: number): string {
  return `https://lroc-tiles.quickmap.io/tiles/lnpole_avg/lunar-sterenp/${k}/${i}/${j}.png?d_val=0,0.5&d_opt=wcolut0`;
}

function northFallbackUrl(k: number, i: number, j: number): string {
  const span = 2 * NORTH_PHOTO_HALF_M / 2 ** k, x = -NORTH_PHOTO_HALF_M + i * span, y = NORTH_PHOTO_HALF_M - j * span;
  return `https://wms.im-ldi.com/?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&STYLES=&LAYERS=luna_nac_np_mosaic&SRS=IAU2000:30118&BBOX=${x},${y - span},${x + span},${y}&WIDTH=512&HEIGHT=512&FORMAT=image/jpeg`;
}

// ---------------------------------------------------------------------------------------------
// Re-projection core.

/** Decoded picture: 1 = grey, 3 = RGB (both fully opaque), 4 = RGBA with straight alpha. */
export interface Src { w: number; h: number; ch: 1 | 3 | 4; data: Uint8Array; bits?: 2 }

/** Histograms of TC Evening at four sites have a spike at 0--2 DN, then textured shadow.
 * Feather six SOURCE pixels outside that spike, before projection. Black itself contributes
 * nothing; the opposite lighting or WAC supplies real ground underneath. Soft shadows stay.
 * The distance transform uses eighth-pixel steps rather than a blur of the photograph. */
export function featherPhotoBlack(src: Src, radius = 6): Src {
  const { w, h, ch, data } = src, count = w * h, cap = radius * 8;
  const dark = (p: number) => {
    const o = p * ch;
    return data[o] <= 2 && (ch === 1 || (data[o + 1] <= 2 && data[o + 2] <= 2));
  };
  let any = false;
  const distance = new Uint8Array(count); distance.fill(cap);
  for (let p = 0; p < count; p++) if (dark(p)) { distance[p] = 0; any = true; }
  if (!any) return src;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (x) distance[p] = Math.min(distance[p], distance[p - 1] + 8);
    if (y) {
      distance[p] = Math.min(distance[p], distance[p - w] + 8);
      if (x) distance[p] = Math.min(distance[p], distance[p - w - 1] + 11);
      if (x + 1 < w) distance[p] = Math.min(distance[p], distance[p - w + 1] + 11);
    }
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const p = y * w + x;
    if (x + 1 < w) distance[p] = Math.min(distance[p], distance[p + 1] + 8);
    if (y + 1 < h) {
      distance[p] = Math.min(distance[p], distance[p + w] + 8);
      if (x) distance[p] = Math.min(distance[p], distance[p + w - 1] + 11);
      if (x + 1 < w) distance[p] = Math.min(distance[p], distance[p + w + 1] + 11);
    }
  }
  const out = new Uint8Array(count * 4);
  for (let p = 0; p < count; p++) {
    const o = p * ch, q = p * 4;
    out[q] = data[o]; out[q + 1] = data[ch === 1 ? o : o + 1]; out[q + 2] = data[ch === 1 ? o : o + 2];
    out[q + 3] = (ch === 4 ? data[o + 3] : 255) * smooth(distance[p] / cap);
  }
  return { w, h, ch: 4, data: out };
}

/** TC's black strips are missing observations, not dark terrain. Its server PNGs do not
 * always mark them transparent. Preserve WAC there rather than drawing invented dark joins. */
export function tcNoData(src: Src): Src {
  const { data, ch, w, h } = src;
  let holes = false;
  for (let o = 0; o < data.length; o += ch) if (data[o] === 0 && (ch === 1 || (data[o + 1] === 0 && data[o + 2] === 0))) { holes = true; break; }
  if (!holes) return src;
  const out = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const o = p * ch, q = p * 4, r = data[o], g = ch === 1 ? r : data[o + 1], b = ch === 1 ? r : data[o + 2];
    out[q] = r; out[q + 1] = g; out[q + 2] = b; out[q + 3] = r === 0 && g === 0 && b === 0 ? 0 : ch === 4 ? data[o + 3] : 255;
  }
  return { w, h, ch: 4, data: out };
}

/** A polar raster with smaller copies (each half the size) so zoomed-out views don't sparkle. */
export interface Raster { levels: Src[] }

/** A stored science map. Palettes keep the sharp source at one byte per pixel. */
export interface ScienceRasterSource {
  url: string;
  projection: 'global' | 'polar';
  pole?: 'north' | 'south';
  extentM?: number;
  clipTrueLatDeg?: number;
  maximumTrueLatDeg?: number;
  palette?: string[];
  packed?: SciencePackedSource;
  preview?: SciencePackedSource;
  /** Sharper terrain replaces the coarse map, including ground the sharper map marks clear. */
  replace?: boolean;
}

/** Native deflate streams avoid a browser RGBA image while decoding byte or two-bit grids. */
export interface SciencePackedSource {
  url: string;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
  bits: 2 | 8;
  compression: 'deflate';
  predictor?: 'sub';
  tileSize?: number;
  offsets?: number[];
}

export interface ScienceMapMemory {
  url: string; compressedBytes: number; decodedBytes: number; previewBytes: number;
  active: boolean; lastUsed: number; decodeMs: number;
  available: boolean;
}
export interface ScienceMemoryStats {
  compressedBytes: number; decodedBytes: number; previewBytes: number;
  decodedBudgetBytes: number; previewBudgetBytes: number; idleMs: number;
  maps: ScienceMapMemory[];
  failedUrls: string[];
  failureReasons: Record<string, string>;
}

/** One byte bound shared by decoded blocks, with a separate small instance for previews. */
export class ScienceBlockCache {
  private readonly items = new Map<string, { src: Src; map: string; lastUsed: number }>();
  bytes = 0;
  readonly budgetBytes: number;
  constructor(budgetBytes: number) { this.budgetBytes = budgetBytes; }
  get(key: string, now: number): Src | undefined {
    const hit = this.items.get(key);
    if (!hit) return undefined;
    hit.lastUsed = now; this.items.delete(key); this.items.set(key, hit); return hit.src;
  }
  put(key: string, map: string, src: Src, now: number): void {
    this.drop(key); this.items.set(key, { src, map, lastUsed: now }); this.bytes += src.data.byteLength;
    while (this.bytes > this.budgetBytes && this.items.size) this.drop(this.items.keys().next().value!);
  }
  drop(key: string): void { const old = this.items.get(key); if (old) { this.bytes -= old.src.data.byteLength; this.items.delete(key); } }
  clear(): void { this.items.clear(); this.bytes = 0; }
  trim(now: number, active: Set<string>, idleMs = 120000): void {
    for (const [key, hit] of this.items) if (!active.has(hit.map) && now - hit.lastUsed >= idleMs) this.drop(key);
  }
  bytesFor(map: string): number { let bytes = 0; for (const item of this.items.values()) if (item.map === map) bytes += item.src.data.byteLength; return bytes; }
  get size(): number { return this.items.size; }
}

/** Four class codes share each byte. Do not expand the file just to read one value. */
export function scienceCodeAt(src: Src, index: number): number {
  return src.bits === 2 ? (src.data[index >> 2] >> (6 - (index & 3) * 2)) & 3 : src.data[index];
}

/** Reverse the per-row PNG-style Sub predictor in place, without another full-grid copy. */
export function unfilterScienceSub(data: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  for (let row = 0; row < height; row++) for (let x = channels; x < stride; x++) {
    const p = row * stride + x; data[p] = (data[p] + data[p - channels]) & 255;
  }
  return data;
}

/** Decode one independent block. Two-bit classes stay packed after inflation. */
export async function decodeScienceBlock(encoded: Uint8Array, layout: SciencePackedSource, index = 0): Promise<Src> {
  const size = layout.tileSize, across = size ? Math.ceil(layout.width / size) : 1;
  const w = size ? Math.min(size, layout.width - index % across * size) : layout.width;
  const h = size ? Math.min(size, layout.height - Math.floor(index / across) * size) : layout.height;
  const start = size && layout.offsets ? layout.offsets[index] : 0, end = size && layout.offsets ? layout.offsets[index + 1] : encoded.byteLength;
  if (w <= 0 || h <= 0 || start === undefined || end === undefined || start < 0 || end > encoded.byteLength || end < start) throw new Error('Invalid science block');
  const bytes = encoded.subarray(start, end);
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'));
  const data = new Uint8Array(await new Response(stream).arrayBuffer());
  if (data.byteLength !== Math.ceil(w * h * layout.channels * layout.bits / 8)) throw new Error('Wrong science block size');
  if (layout.predictor === 'sub') {
    if (layout.bits !== 8) throw new Error('Sub predictor needs byte values');
    unfilterScienceSub(data, w, h, layout.channels);
  }
  return { w, h, ch: layout.channels, data, ...(layout.bits === 2 ? { bits: 2 as const } : {}) };
}

/** Palette sampling reads only the small decoded source blocks touched by this display tile. */
export function sampleScienceChunks(fp: Footprint, width: number, height: number, tileSize: number, tiles: Map<number, Src>, palette: Uint8Array | undefined, global: boolean, flip: boolean, verticalSpan = 1): Uint8ClampedArray<ArrayBuffer> | null {
  const out = new Uint8ClampedArray(N2 * 4), tilesX = Math.ceil(width / tileSize);
  const verticalTaps = Math.min(4, Math.max(1, Math.ceil(verticalSpan))), verticalStep = verticalSpan / verticalTaps;
  let any = false, lastKey = -1, last: Src | undefined;
  for (let p = 0; p < N2; p++) {
    if (fp.cov[p] <= 0) continue;
    let R = 0, G = 0, B = 0, A = 0;
    const k = fp.taps[p], step = fp.step[p];
    for (let vy = 0; vy < verticalTaps; vy++) for (let t = 0; t < k; t++) {
      const v = fp.v[p] + (vy - (verticalTaps - 1) / 2) * verticalStep, y0 = Math.floor(v), ty = v - y0;
      const u = fp.u[p] + (t - (k - 1) / 2) * step, x0 = Math.floor(u), tx = u - x0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        let x = x0 + dx, y = y0 + dy;
        if (global) { x = ((x % width) + width) % width; y = clamp(y, 0, height - 1); }
        else if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const tileX = Math.floor(x / tileSize), tileY = Math.floor(y / tileSize), key = tileY * tilesX + tileX;
        if (key !== lastKey) { lastKey = key; last = tiles.get(key); }
        if (!last) continue;
        const q = (y - tileY * tileSize) * last.w + x - tileX * tileSize;
        const indexed = last.ch === 1 && !!palette, o = indexed ? scienceCodeAt(last, q) * 4 : q * last.ch, d = indexed ? palette! : last.data;
        const alpha = indexed || last.ch === 4 ? d[o + 3] : 255;
        const weight = alpha * (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
        R += d[o] * weight; G += d[indexed || last.ch > 1 ? o + 1 : o] * weight;
        B += d[indexed || last.ch > 1 ? o + 2 : o] * weight; A += weight;
      }
    }
    if (A <= 1e-6) continue;
    const row = Math.floor(p / TILE), o = ((flip ? row : TILE - 1 - row) * TILE + p % TILE) * 4;
    out[o] = R / A; out[o + 1] = G / A; out[o + 2] = B / A; out[o + 3] = fp.cov[p] * A / (k * verticalTaps); any = true;
  }
  return any ? out : null;
}

/** The requested resolution must outgrow the preview before fine blocks are worth decoding. */
export function scienceUsesPreview(pixelM: number, previewPixelM: number): boolean { return pixelM >= previewPixelM * 0.8; }

function scienceTileKeys(fp: Footprint, grid: Grid, verticalSpan: number): number[] {
  const keys = new Set(collectTiles(fp, [grid], Infinity) ?? []);
  if (verticalSpan <= 1) return [...keys];
  for (let p = 0; p < N2; p++) {
    if (fp.cov[p] <= 0) continue;
    const lo = Math.floor((fp.v[p] - verticalSpan / 2 - 1) / grid.tileH), hi = Math.floor((fp.v[p] + verticalSpan / 2 + 1) / grid.tileH);
    if (lo === hi) continue;
    const half = (fp.taps[p] - 1) / 2 * fp.step[p], left = Math.floor((fp.u[p] - half) / grid.tileW), right = Math.floor((fp.u[p] + half + 1) / grid.tileW);
    for (const ty0 of [lo, hi]) for (let tx = left; tx <= right; tx++) {
      const ty = grid.global ? clamp(ty0, 0, Math.ceil(grid.height / grid.tileH) - 1) : ty0;
      const x = grid.global ? ((tx % grid.tilesX) + grid.tilesX) % grid.tilesX : tx;
      if (ty >= 0 && ty * grid.tileH < grid.height && x >= 0 && x < grid.tilesX) keys.add(ty * grid.tilesX + x);
    }
  }
  return [...keys];
}

export function sciencePalette(colours: string[]): Uint8Array {
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < Math.min(256, colours.length); i++) {
    const s = colours[i]?.replace('#', '') ?? '';
    if (!/^[\da-f]{6}([\da-f]{2})?$/i.test(s)) continue;
    out[i * 4] = parseInt(s.slice(0, 2), 16); out[i * 4 + 1] = parseInt(s.slice(2, 4), 16);
    out[i * 4 + 2] = parseInt(s.slice(4, 6), 16); out[i * 4 + 3] = s.length === 8 ? parseInt(s.slice(6, 8), 16) : 255;
  }
  return out;
}

/** Science sources stay scalar or packed; only a small colour preview is ever made. */
export function buildScienceMips(full: Src, _palette?: Uint8Array): Raster { return { levels: [full] }; }

/** A bounded colour preview preserves coverage mixtures without retaining an RGBA source. */
export function buildSciencePreview(full: Src, palette?: Uint8Array, maxWidth = 512): Src {
  const w = Math.min(full.w, maxWidth), h = Math.max(1, Math.round(full.h * w / full.w)), data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * full.w / w), x1 = Math.max(x0 + 1, Math.floor((x + 1) * full.w / w));
    const y0 = Math.floor(y * full.h / h), y1 = Math.max(y0 + 1, Math.floor((y + 1) * full.h / h));
    let R = 0, G = 0, B = 0, A = 0, count = 0;
    for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
      const p = sy * full.w + sx, indexed = full.ch === 1 && !!palette;
      const q = indexed ? scienceCodeAt(full, p) * 4 : p * full.ch, src = indexed ? palette! : full.data;
      const alpha = indexed || full.ch === 4 ? src[q + 3] : 255;
      R += src[q] * alpha; G += src[indexed || full.ch > 1 ? q + 1 : q] * alpha;
      B += src[indexed || full.ch > 1 ? q + 2 : q] * alpha; A += alpha; count++;
    }
    const o = (y * w + x) * 4;
    if (A) { data[o] = Math.round(R / A); data[o + 1] = Math.round(G / A); data[o + 2] = Math.round(B / A); }
    data[o + 3] = Math.round(A / count);
  }
  return { w, h, ch: 4, data };
}

/** One source picture per mip level. The full source stays indexed; only smaller copies use RGBA. */
export function sampleScience(fp: Footprint, raster: Raster, palette: Uint8Array | undefined, global: boolean, flip: boolean): Uint8ClampedArray<ArrayBuffer> | null {
  if (!palette || raster.levels[0].ch !== 1) {
    const grids = raster.levels.map(s => ({ ...singleGrid(s), global }));
    return sampleTiles(fp, grids, raster.levels.map((_, i) => i * KEY_LEVEL), raster.levels, flip);
  }
  const out = new Uint8ClampedArray(N2 * 4);
  let any = false;
  for (let p = 0; p < N2; p++) {
    if (fp.cov[p] <= 0) continue;
    const s = raster.levels[fp.lvl[p]], indexed = s.ch === 1, k = fp.taps[p], step = fp.step[p];
    let R = 0, G = 0, B = 0, A = 0;
    for (let t = 0; t < k; t++) {
      const u = fp.u[p] + (t - (k - 1) / 2) * step, v = fp.v[p], c = Math.floor(u), r = Math.floor(v), tx = u - c, ty = v - r;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        let x = c + dx, y = r + dy;
        if (global) { x = ((x % s.w) + s.w) % s.w; y = clamp(y, 0, s.h - 1); }
        else if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
        const q = indexed ? scienceCodeAt(s, y * s.w + x) * 4 : (y * s.w + x) * 4, d = indexed ? palette : s.data;
        const a = d[q + 3] * (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
        R += d[q] * a; G += d[q + 1] * a; B += d[q + 2] * a; A += a;
      }
    }
    if (A <= 1e-6) continue;
    const row = Math.floor(p / TILE), o = ((flip ? row : TILE - 1 - row) * TILE + p % TILE) * 4;
    out[o] = R / A; out[o + 1] = G / A; out[o + 2] = B / A; out[o + 3] = fp.cov[p] * A / k;
    any = true;
  }
  return any ? out : null;
}

/** True lon/lat maps keep a level per pixel near the poles, where one pixel spans many longitudes. */
export function scienceGlobalFootprint(fp: Footprint, r: Rect, level: number, raster: Raster) {
  trekGeometry(fp, r, -90);
  const base = raster.levels[0], baseMip = Math.floor(Math.log2(base.w / (TILE * 2 ** (level + 1))));
  for (let p = 0; p < N2; p++) {
    const m = clamp(baseMip + fp.coarser[p], 0, raster.levels.length - 1), s = raster.levels[m];
    const width = Math.min(s.w, fp.w0[p] * s.w / (TILE * 2 ** (level + 1)));
    const taps = width > TAP_SPACING ? Math.min(MAX_TAPS, Math.ceil(width / TAP_SPACING)) : 1;
    fp.lvl[p] = m; fp.taps[p] = taps; fp.step[p] = taps > 1 ? width / taps : 0;
    fp.u[p] = (fp.b[p] + Math.PI) * s.w / (2 * Math.PI) - 0.5;
    fp.v[p] = (Math.PI / 2 - fp.a[p]) * s.h / Math.PI - 0.5;
  }
}

/** Sharper terrain may clear a coarse warning; evidence maps instead add their own colour. */
export function compositeSciencePixels(out: Uint8ClampedArray<ArrayBuffer>, px: Uint8ClampedArray<ArrayBuffer> | null, coverage: Float32Array, flip: boolean, replace = false) {
  for (let p = 0; p < N2; p++) {
    const row = Math.floor(p / TILE), o = ((flip ? row : TILE - 1 - row) * TILE + p % TILE) * 4;
    if (replace && coverage[p] > 0.99) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; }
    const a = (px?.[o + 3] ?? 0) / 255;
    if (!a || !px) continue;
    const b = out[o + 3] / 255, A = a + b * (1 - a);
    for (let c = 0; c < 3; c++) out[o + c] = (px[o + c] * a + out[o + c] * b * (1 - a)) / A;
    out[o + 3] = A * 255;
  }
}

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
export const KEY_LEVEL = 2 ** 35; // room for a complete level-16 grid, still exact in a JavaScript number

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
export function polarGeometry(fp: Footprint, r: Rect, rhoClip: number, featherM: number, halfM: number, north = false): boolean {
  columns(fp, r);
  fp.lvl.fill(0); fp.taps.fill(1); // one grid, one bilinear sample per pixel
  const dLat = (r.north - r.south) / TILE, pxM = dLat * MOON_R, soft = featherM > pxM;
  let any = false;
  for (let j = 0; j < TILE; j++) {
    const lat = r.north - (j + 0.5) * dLat, cl = Math.cos(lat), Z = Math.sin(lat);
    for (let i = 0; i < TILE; i++) {
      const p = j * TILE + i, X = cl * fp.cosLon[i], Y = cl * fp.sinLon[i];
      const den = north ? 1 - Y : 1 + Y;
      let c = 0, mx = 0, my = 0;
      if (den > 1e-9) {
        // same formula as polarMapFromDisplayUnit in frame.ts
        const f = (2 * MOON_R) / den;
        mx = f * Z; my = (north ? -1 : 1) * f * X;
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
  | { kind: 'photo'; rect: Rect; level: number; layer: string; minTrueLat: number; fix?: FixParams; northBase?: { cut: BaseCut; rect: Rect } }
  | { kind: 'trek'; rect: Rect; level: number; layer: string; ext: string; maxSourceLevel: number; minTrueLat: number }
  | { kind: 'raster'; rect: Rect; level: number; url: string; extentM: number; clipTrueLat: number; featherM: number }
  | { kind: 'science'; rect: Rect; level: number; sources: ScienceRasterSource[] }
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
export type ToWorker = { id: number; job: Job; flipRows: boolean } | { cancel: number } | { cacheBudgetBytes: number } | { photoView: { lon: number; lat: number; level: number } } | { forgetFailures: true } | { pyramidIndex: unknown; base: string } | { warmRasters: string[] } | { warmScience: ScienceRasterSource[]; warmId: number } | { scienceValue: { source: ScienceRasterSource; lat: number; lon: number }; valueId: number } | { scienceState: { activeUrls: string[] }; scienceRequestId?: number } | { scienceTrim: { dropAll?: boolean; dropCompressed?: boolean }; scienceRequestId?: number } | { scienceStats: { requestId: number } };
/**
 * A finished tile. gaps = it could not be drawn in full because a download failed for now (worth
 * asking for again later); recovered = a server that was failing answers again; parent = draw
 * nothing new here, keep showing the parent tile (the data has no finer detail, or it could not
 * be downloaded); net = this worker's download counts so far [local files, remote, failed].
 */
export interface FromWorker { id: number; bitmap: ImageBitmap | null; gaps: boolean; recovered: boolean; parent?: boolean; net?: [number, number, number]; traffic?: Record<string, { requests: number; bytes: number }>; cache?: DecodedCacheStats; warmed?: number; warmFrac?: number; warmOk?: boolean; valueId?: number; value?: number | null; science?: ScienceMemoryStats; scienceRequestId?: number; scienceReady?: string }

type DecodedKind = 'tile' | 'base' | 'raster' | 'mask';
export interface DecodedCacheStats {
  budgetBytes: number; retainedBytes: number; retainedCount: number;
  bytesByKind: Record<DecodedKind, number>; countByKind: Record<DecodedKind, number>;
  evictions: number; decodesActive: number; decodesQueued: number; canvasBytes: number;
}

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

// Every retained source image shares this worker's one budget, including whole-Moon pictures,
// polar rasters, downloaded squares and masks. The main thread assigns a larger share to the
// raster worker. Pictures still being sampled are temporary job memory, not retained cache.
let decodedBudgetBytes = 64 * 2 ** 20, decodedBytes = 0, decodedEvictions = 0;
let decodesActive = 0, decodesQueued = 0;
const decoded = new Map<string, { bytes: number; kind: DecodedKind; evict: () => void }>();

function trimDecoded() {
  while (decodedBytes > decodedBudgetBytes && decoded.size) {
    const [key, entry] = decoded.entries().next().value!;
    decoded.delete(key); decodedBytes -= entry.bytes; decodedEvictions++;
    entry.evict();
  }
}

/** Register AFTER storing an image. Its callback must remove the actual cached reference too. */
export function registerDecoded(key: string, bytes: number, evict: () => void, kind: DecodedKind = 'mask'): void {
  unregisterDecoded(key);
  const size = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  decoded.set(key, { bytes: size, kind, evict });
  decodedBytes += size;
  trimDecoded();
}

/** Mark a cached image as used; false means it has already been evicted. */
export function touchDecoded(key: string): boolean {
  const entry = decoded.get(key);
  if (!entry) return false;
  decoded.delete(key); decoded.set(key, entry);
  return true;
}

/** A caller removed an image itself, for example when replacing a processed mask. */
export function unregisterDecoded(key: string): void {
  const entry = decoded.get(key);
  if (entry) { decoded.delete(key); decodedBytes -= entry.bytes; }
}

function decodedCacheStats(): DecodedCacheStats {
  const bytesByKind = { tile: 0, base: 0, raster: 0, mask: 0 }, countByKind = { ...bytesByKind };
  for (const entry of decoded.values()) { bytesByKind[entry.kind] += entry.bytes; countByKind[entry.kind]++; }
  return { budgetBytes: decodedBudgetBytes, retainedBytes: decodedBytes, retainedCount: decoded.size,
    bytesByKind, countByKind, evictions: decodedEvictions, decodesActive, decodesQueued,
    canvasBytes: decodeCanvas ? decodeCanvas.width * decodeCanvas.height * 4 : 0 };
}

function rasterBytes(raster: Raster): number {
  const buffers = new Set<ArrayBufferLike>();
  let bytes = 0;
  for (const src of raster.levels) if (!buffers.has(src.data.buffer)) { buffers.add(src.data.buffer); bytes += src.data.buffer.byteLength; }
  return bytes;
}

type Got = Src | 'missing' | null; // 'missing' = the server says it has no such tile (404); null = failed for now
type Drawn = { px: Uint8ClampedArray<ArrayBuffer> | null; gaps: boolean; parent?: boolean };
const NOTHING: Drawn = { px: null, gaps: false };
/** A download failed: draw nothing new, keep showing the parent tile (it is sharper than a hole), and ask again later. */
const PARENT_FOR_NOW: Drawn = { px: null, gaps: true, parent: true };
/** Downloads so far: [files stored with the app, remote, failed]. Reported with every answer (for tests and the loading screen). */
const net: [number, number, number] = [0, 0, 0];
// Bytes are compressed response bodies (not HTTP headers); debug hook only, no extra requests.
const traffic: Record<string, { requests: number; bytes: number }> = {};

/** "https://host:port" of a URL: downloads are limited, and failures remembered, per server. */
const originOf = (url: string) => { const i = url.indexOf('/', url.indexOf('//') + 2); return i < 0 ? url : url.slice(0, i); };

let netActive = 0, localActive = 0;
const hostActive = new Map<string, number>();
const netWaiting: { host: string; go: () => void; priority?: () => number }[] = [];
const localWaiting: (() => void)[] = [];
// The eight Lunaserv names are one service. More connections do not make its
// expensive WMS maps faster, and can crowd out the south-polar pictures.
const queueHost = (host: string) => host.endsWith('.im-ldi.com') ? 'https://lunaserv.im-ldi.com' : host;
const hostLimit = (host: string) => host.endsWith('.im-ldi.com') || host.endsWith('quickmap.io') ? 4 : HOST_LIMIT;
/** Missing priorities keep the old FIFO order. A shared tile reads its best current user's score. */
function priorityScore(priority?: () => number): number {
  const score = priority?.() ?? 0;
  return Number.isFinite(score) ? score : Infinity;
}

/** Start the most useful waiting download that has a free server slot; ties stay oldest first. */
function pump() {
  while (netWaiting.length && netActive < NET_LIMIT) {
    let best = -1, score = Infinity;
    for (let q = 0; q < netWaiting.length; q++) {
      const entry = netWaiting[q];
      if ((hostActive.get(entry.host) ?? 0) >= hostLimit(entry.host)) continue;
      const next = priorityScore(entry.priority);
      if (best < 0 || next < score) { best = q; score = next; }
    }
    if (best < 0) break;
    const { host, go } = netWaiting.splice(best, 1)[0], busy = hostActive.get(host) ?? 0;
    netActive++;
    hostActive.set(host, busy + 1);
    go();
  }
  while (localWaiting.length && localActive < LOCAL_LIMIT) { localActive++; localWaiting.shift()!(); }
}
const netAcquire = (host: string, local: boolean, signal?: AbortSignal, priority?: () => number) => new Promise<boolean>(resolve => {
  if (signal?.aborted) { resolve(false); return; }
  const cleanup = () => signal?.removeEventListener('abort', cancel);
  const go = () => { cleanup(); resolve(true); };
  const entry = { host, go, priority };
  const cancel = () => {
    const q = local ? localWaiting.indexOf(go) : netWaiting.indexOf(entry);
    if (q < 0) return;
    if (local) localWaiting.splice(q, 1); else netWaiting.splice(q, 1);
    cleanup(); resolve(false);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (local) localWaiting.push(go); else netWaiting.push(entry);
  pump();
});
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
async function fetchBlob(url: string, local = OWN !== null && url.startsWith(OWN), signal?: AbortSignal, priority?: () => number): Promise<Blob | 'missing' | null> {
  signal?.throwIfAborted();
  const host = originOf(url), queue = queueHost(host);
  let br: Breaker | undefined, probed: ((ok: boolean) => void) | undefined;
  if (!local) {
    const site = siteOf(url);
    br = breakers.get(site);
    if (!br) breakers.set(site, (br = { fails: 0, probe: null }));
  }
  const down = () => br !== undefined && br.fails >= BREAKER_AFTER;
  for (;;) {
    while (down() && br!.probe) {
      const back = await br!.probe;
      signal?.throwIfAborted();
      if (!back) { net[2]++; return null; }
    } // the server is still down
    if (down()) br!.probe = new Promise<boolean>(res => { probed = res; }); // this download finds out whether it is back
    if (!(await netAcquire(queue, local, signal, priority))) {
      if (probed) { br!.probe = null; probed(true); }
      signal?.throwIfAborted();
    }
    if (probed || !down()) break;
    netRelease(queue, local); // the server went down while this download waited for its turn
  }
  const done = (ok: boolean) => { if (br) { br.fails = ok ? 0 : br.fails + 1; if (probed) { br.probe = null; probed(ok); } } };
  net[local ? 0 : 1]++;
  const tally = traffic[local ? 'local' : siteOf(url)] ??= { requests: 0, bytes: 0 };
  tally.requests++;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  const cancel = () => ctl.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) ctl.abort();
  try {
    const r = await fetch(url, { mode: 'cors', credentials: 'omit', signal: ctl.signal });
    if (r.status === 404) { answered(host); done(true); return 'missing'; }
    if (r.ok) { const blob = await r.blob(); tally.bytes += blob.size || 0; signal?.throwIfAborted(); answered(host); done(true); return blob; }
  } catch {
    // offline, timed out, or answered without the CORS header (cross-origin errors look the same)
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    netRelease(queue, local);
  }
  if (signal?.aborted) {
    // Moving the map says nothing about server health. A cancelled probe simply
    // lets another real request check the server, without changing its history.
    if (probed) { br!.probe = null; probed(true); }
    signal.throwIfAborted();
  }
  net[2]++;
  if (!local) failingHosts.add(host);
  done(false);
  return null; // the tile that needed it keeps showing its parent for now
}

let decodeCanvas: OffscreenCanvas | undefined, decodeContext: OffscreenCanvasRenderingContext2D | undefined;
function canvas2d(w: number, h: number): OffscreenCanvasRenderingContext2D {
  if (!decodeCanvas) {
    decodeCanvas = new OffscreenCanvas(w, h);
    const context = decodeCanvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('No 2D canvas in this worker');
    decodeContext = context;
  }
  if (decodeCanvas.width !== w) decodeCanvas.width = w;
  if (decodeCanvas.height !== h) decodeCanvas.height = h;
  return decodeContext!;
}

/** Decode a picture into the most compact form (grey/RGB/RGBA), reading big pictures in strips to keep memory low. */
async function decode(blob: Blob): Promise<Src> {
  decodesActive++;
  let bmp: ImageBitmap | undefined;
  try {
    bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
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
    bmp?.close();
    // The strip is only used synchronously above. Do not retain a different 4 MiB canvas
    // for every image width, or leave its backing store around between downloads.
    if (decodeCanvas) { decodeCanvas.width = 1; decodeCanvas.height = 1; }
    decodesActive--;
  }
}

let rasterDecodeTail: Promise<void> = Promise.resolve();
/** Only one large photo is decoded and mipmapped at a time; small source tiles keep streaming. */
async function decodeRaster(blob: Blob, mips = Infinity, poleAware = false): Promise<Raster> {
  const before = rasterDecodeTail;
  let release!: () => void;
  rasterDecodeTail = new Promise<void>(resolve => { release = resolve; });
  decodesQueued++;
  await before;
  decodesQueued--;
  try { return buildMips(await decode(blob), mips, poleAware); }
  finally { release(); }
}

/** Least-recently-used memory of decoded source tiles, with shared downloads. */
class TileCache {
  private readonly items = new Map<string, Src | 'missing'>();
  private readonly loading = new Map<string, { promise: Promise<Got>; controller: AbortController; users: Map<symbol, (() => number) | undefined> }>();
  private readonly failed = new Map<string, { at: number; url: string }>();
  private readonly budget: number;
  private bytes = 0;
  constructor(budget: number) { this.budget = budget; }

  private recent(key: string): Src | 'missing' | null | undefined {
    const t = this.items.get(key);
    if (t !== undefined) { this.items.delete(key); this.items.set(key, t); if (t !== 'missing') touchDecoded(`tile:${key}`); return t; } // mark as recently used
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
  get(key: string, url: string, localUrl?: string, signal?: AbortSignal, priority?: () => number): Promise<Got> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const t = this.recent(key);
    if (t !== undefined) return Promise.resolve(t);
    let e = this.loading.get(key);
    if (!e) {
      const controller = new AbortController();
      const entry = { promise: Promise.resolve(null) as Promise<Got>, controller, users: new Map<symbol, (() => number) | undefined>() };
      // A source square can serve several display tiles. Follow whichever still needs it most,
      // including when a camera move changes their scores or its nearest user is cancelled.
      const sharedPriority = () => {
        let best = Infinity;
        for (const userPriority of entry.users.values()) best = Math.min(best, priorityScore(userPriority));
        return best;
      };
      entry.promise = (async (): Promise<Got> => {
        try {
          let got: Got = localUrl ? await this.load(localUrl, true, controller.signal, sharedPriority) : null;
          if (!localUrl || got === null || got === 'missing') got = await this.load(url, false, controller.signal, sharedPriority);
          controller.signal.throwIfAborted();
          if (got === null) this.fail(key, url);
          else { this.failed.delete(key); this.put(key, got); }
          return got;
        } catch (error) {
          if (controller.signal.aborted) return null; // all users left; do not remember a failure
          throw error;
        } finally {
          if (this.loading.get(key) === entry) this.loading.delete(key);
        }
      })();
      this.loading.set(key, e = entry);
    }
    const entry = e, user = Symbol();
    entry.users.set(user, priority);
    return new Promise((resolve, reject) => {
      const leave = () => {
        signal?.removeEventListener('abort', cancel);
        entry.users.delete(user);
      };
      const cancel = () => {
        leave();
        if (!entry.users.size) {
          entry.controller.abort();
          if (this.loading.get(key) === entry) this.loading.delete(key);
        }
        reject(signal?.reason ?? new DOMException('Tile left the view', 'AbortError'));
      };
      signal?.addEventListener('abort', cancel, { once: true });
      entry.promise.then(got => { leave(); resolve(got); }, error => { leave(); reject(error); });
    });
  }

  private async load(url: string, local: boolean, signal?: AbortSignal, priority?: () => number): Promise<Got> {
    const blob = await fetchBlob(url, local, signal, priority);
    if (blob === 'missing' || blob === null) return blob;
    signal?.throwIfAborted();
    return decode(blob).then(s => url.includes(`/${PHOTO_TC}/`) ? tcNoData(s) : s).catch(() => null); // keep valid black shadows in the evening TC and NAC photos
  }

  private fail(key: string, url: string) {
    this.failed.set(key, { at: performance.now(), url });
    if (this.failed.size > 4096) for (const [k, f] of this.failed) if (!stillFailing(f.at, f.url)) this.failed.delete(k); // forget old failures
    while (this.failed.size > 4096) this.failed.delete(this.failed.keys().next().value!);
  }

  private put(key: string, t: Src | 'missing') {
    const previous = this.items.get(key);
    if (previous !== undefined) this.bytes -= previous === 'missing' ? 64 : previous.data.buffer.byteLength;
    this.items.set(key, t);
    this.bytes += t === 'missing' ? 64 : t.data.buffer.byteLength;
    if (t !== 'missing') registerDecoded(`tile:${key}`, t.data.buffer.byteLength, () => {
      if (this.items.get(key) === t) { this.items.delete(key); this.bytes -= t.data.buffer.byteLength; }
    }, 'tile');
    else unregisterDecoded(`tile:${key}`);
    for (const [k, old] of this.items) {
      if (this.bytes <= this.budget && this.items.size <= 2048) break;
      this.items.delete(k);
      this.bytes -= old === 'missing' ? 64 : old.data.buffer.byteLength;
      if (old !== 'missing') unregisterDecoded(`tile:${k}`);
    }
  }
}

interface RasterEntry { readonly promise: Promise<Raster | null>; pending: Promise<Raster | null> | null; raster: Raster | null; failedAt: number }
interface DepthEntry { depth: number | null; failedAt: number; pending: Promise<number | null> | null }
interface BaseEntry extends RasterEntry {}

function startWorker() {
  const fp = new Footprint();
  const tiles = new TileCache(TILE_CACHE_BYTES);
  const jobs = new Map<number, AbortController>();
  let photoView: { lon: number; lat: number; level: number } | undefined;
  function photoPriority(job: Extract<Job, { kind: 'photo' }>): number {
    if (!photoView) return 0;
    const r = job.rect, lon = (r.west + r.east) / 2, lat = (r.south + r.north) / 2;
    const dx = Math.atan2(Math.sin(lon - photoView.lon), Math.cos(lon - photoView.lon)) * Math.cos(photoView.lat);
    const scale = Math.PI / 2 ** Math.min(17, photoView.level);
    return (dx * dx + (lat - photoView.lat) ** 2) / (scale * scale) + Math.max(0, photoView.level - job.level) * 0.1;
  }
  const depths = new Map<string, DepthEntry>();
  const rasters = new Map<string, RasterEntry>();
  const sciencePalettes = new Map<string, Uint8Array>();
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

  /** Downloads are shared across photo and seam-fix jobs. Abort only after the last tile using
   * a source square has scrolled away. Low and high use the SAME grid and clip at every zoom. */
  const photoMasks = new Map<number, { key: string; src: Src }>();
  const photoMaskIds = new WeakMap<Src, number>();
  let maskId = 0;
  function maskedPhoto(src: Src): Src {
    const id = photoMaskIds.get(src), hit = id === undefined ? undefined : photoMasks.get(id);
    if (hit && touchDecoded(hit.key)) return hit.src;
    const softened = featherPhotoBlack(src);
    if (softened !== src) {
      const next = ++maskId, key = `mask/${next}`;
      photoMaskIds.set(src, next);
      photoMasks.set(next, { key, src: softened });
      registerDecoded(key, softened.data.byteLength, () => photoMasks.delete(next), 'mask');
    }
    return softened;
  }

  async function photoPixels(job: Extract<Job, { kind: 'photo' }>, layer: string, maxZ: number, flip: boolean, signal: AbortSignal, region?: PhotoRegion, soften = false) {
    const plan = planPhotoRegion(fp, job.rect, job.level, maxZ, region);
    if (!plan || !plan.keys.length) return { px: null, failed: false, needsFill: false };
    const got = await Promise.all(plan.keys.map(key => {
      const t = trekTileOf(key);
      let url = trekUrl(layer, 'png', t.z, t.x, t.y);
      if (region?.quickmap) {
        const z = Math.floor(key / KEY_LEVEL), q = key - z * KEY_LEVEL, n = 2 ** z;
        const suffix = region.global ? '.png?d_val=0,5000&d_opt=wcolut0' : '.jpg';
        url = `https://lroc-tiles.quickmap.io/tiles/${layer}/lunar-fulleqc/${z}/${q % n}/${Math.floor(q / n)}${suffix}`;
      }
      return tiles.get(`${layer}/${region?.quickmap ? 'qm/' : ''}${key}`, url, undefined, signal, () => photoPriority(job));
    }));
    signal.throwIfAborted();
    if (got.includes(null)) return { px: null, failed: true, needsFill: false };
    regionFootprint(fp, job.rect, job.level, maxZ, region);
    const px = sampleTiles(fp, plan.grids, plan.keys, got.map(t => !t || t === 'missing' ? null : soften ? maskedPhoto(t) : t), flip);
    let dark = 0;
    if (soften && px) for (let p = 0; p < N2; p++) {
      const row = Math.floor(p / TILE), col = p % TILE, o = ((flip ? row : TILE - 1 - row) * TILE + col) * 4 + 3;
      if (fp.cov[p] > 0.9 && px[o] < 128) dark++;
    }
    return { px, failed: false, needsFill: soften && (!px || dark > N2 * 0.005) };
  }

  async function runNorthPhoto(job: Extract<Job, { kind: 'photo' }>, flip: boolean, signal: AbortSignal): Promise<Drawn> {
    const northTile = async (k: number, q: number, n: number) => {
      const i = q % n, j = Math.floor(q / n), priority = () => photoPriority(job);
      const cached = await tiles.get(`north/${k}/${q}`, northPhotoUrl(k, i, j), undefined, signal, priority);
      if (cached && cached !== 'missing') return cached;
      // WMS is much slower and its uncontrolled mosaic begins at 85.5 N. Ask only after
      // the cached controlled tile fails; its empty outer pixels retain the broad photo.
      return tiles.get(`north-wms/${k}/${q}`, northFallbackUrl(k, i, j), undefined, signal, priority);
    };
    let base: Drawn | undefined;
    if (job.northBase) {
      const { cut, rect } = job.northBase, raster = await basePicture(cut).promise, src = raster?.levels[cut.mip];
      if (src) {
        fp.cov.fill(1); fp.lvl.fill(0); fp.taps.fill(1);
        for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) {
          const p = j * TILE + i;
          fp.u[p] = cut.px + TILE * (job.rect.west + (i + 0.5) * (job.rect.east - job.rect.west) / TILE - rect.west) / (rect.east - rect.west) - 0.5;
          fp.v[p] = cut.py + TILE * (rect.north - job.rect.north + (j + 0.5) * (job.rect.north - job.rect.south) / TILE) / (rect.north - rect.south) - 0.5;
        }
        base = { px: sampleTiles(fp, [singleGrid(src)], [0], [src], flip), gaps: false };
      }
    }
    base ??= job.fix ? await runSynth({ kind: 'synth', rect: job.rect, level: job.level, fix: job.fix }, flip)
      : await runTrek({ kind: 'trek', rect: job.rect, level: job.level, layer: job.layer, ext: 'jpg', maxSourceLevel: 8, minTrueLat: job.minTrueLat }, flip);
    signal.throwIfAborted();
    if (!base.px) return base;
    // Keep TC underneath the polar feather. The choice is per true latitude, so a display
    // tile crossing the cap edge has the same picture as its neighbour at every zoom.
    if (tileTrueLatRange(job.rect).minDeg < NORTH_PHOTO_LAT + 0.2) {
      const [sharp, low] = await Promise.all([
        photoPixels(job, PHOTO_FINE_TC.layer, PHOTO_FINE_TC_MAX_Z, flip, signal, PHOTO_FINE_TC, true), photoPixels(job, PHOTO_FINE_TC.layer, 8, flip, signal, PHOTO_FINE_TC),
      ]);
      if (sharp.failed || low.failed) return PARENT_FOR_NOW;
      trekGeometry(fp, job.rect, job.minTrueLat);
      if (sharp.px && low.px) for (let p = 0; p < N2; p++) {
        const row = Math.floor(p / TILE), col = p % TILE, o = ((flip ? row : TILE - 1 - row) * TILE + col) * 4 + 3;
        const weight = 1 - smooth((fp.a[p] / DEG - NORTH_PHOTO_LAT) / 0.2);
        sharp.px[o] *= weight; low.px[o] *= weight;
      }
      matchPhotoTone(base.px, sharp.px, low.px, base.px);
    }
    const plan = planNorthPhoto(fp, job.rect, job.level);
    if (!plan || !plan.keys.length) return base;
    const k = plan.level, n = plan.grids[0].tilesX;
    const got = await Promise.all(plan.keys.map(q => northTile(k, q, n)));
    signal.throwIfAborted();
    if (got.includes(null)) return PARENT_FOR_NOW;
    northFootprint(fp, job.rect, k);
    const px = sampleTiles(fp, plan.grids, plan.keys, got.map(t => !t || t === 'missing' ? null : maskedPhoto(t)), flip);
    const lowK = 4, lowN = 2 ** lowK;
    northFootprint(fp, job.rect, lowK);
    const grids = [pyramidGrid(lowK)], keys = collectTiles(fp, grids, Infinity) ?? [];
    const low = await Promise.all(keys.map(q => northTile(lowK, q, lowN)));
    signal.throwIfAborted();
    if (low.includes(null)) return PARENT_FOR_NOW;
    northFootprint(fp, job.rect, lowK);
    const blurred = sampleTiles(fp, grids, keys, low.map(t => t === 'missing' ? null : t), flip);
    addPhotoDetail(base.px, px, blurred, 0.9);
    return base;
  }

  async function runPhoto(job: Extract<Job, { kind: 'photo' }>, flip: boolean, signal: AbortSignal): Promise<Drawn> {
    if (tileTrueLatRange(job.rect).maxDeg > NORTH_PHOTO_LAT) return runNorthPhoto(job, flip, signal);
    const regions = photoRegionsFor(job.rect), primary = regions.find(r => photoRegionCovers(job.rect, r));
    // The reference and the final picture travel together. A full NAC tile needs no TC
    // downloads underneath it, and neither waits for the broad reference to start loading.
    const basePromise = job.fix ? runSynth({ kind: 'synth', rect: job.rect, level: job.level, fix: job.fix }, flip)
      : runTrek({ kind: 'trek', rect: job.rect, level: job.level, layer: job.layer, ext: 'jpg', maxSourceLevel: 8, minTrueLat: job.minTrueLat }, flip);
    const source = primary ?? PHOTO_FINE_TC;
    let [base, sharp, low] = await Promise.all([
      basePromise,
      photoPixels(job, source.layer, source.maxZ, flip, signal, source, true),
      photoPixels(job, source.layer, 8, flip, signal, source),
    ]);
    signal.throwIfAborted();
    if (!base.px) return base;
    const reference = base.px.slice();
    let upgradeGap = sharp.failed || low.failed;
    if (primary) {
      if (upgradeGap) return PARENT_FOR_NOW;
      matchPhotoTone(base.px, sharp.px, low.px, reference);
    } else {
      if (upgradeGap || !low.px) {
        [sharp, low] = await Promise.all([
          photoPixels(job, PHOTO_TC, PHOTO_TC_MAX_Z, flip, signal, undefined, true),
          photoPixels(job, PHOTO_TC, 8, flip, signal),
        ]);
        if (sharp.failed || low.failed) return PARENT_FOR_NOW;
        addPhotoDetail(base.px, sharp.px, low.px);
      } else {
        // Only an on-screen Evening tile with a sizeable black area asks for Morning.
        // Both may have shadows; where neither sees ground the original WAC stays visible.
        if (sharp.needsFill) {
          const [morning, morningLow] = await Promise.all([
            photoPixels(job, PHOTO_MORNING_TC.layer, PHOTO_FINE_TC_MAX_Z, flip, signal, PHOTO_MORNING_TC, true),
            photoPixels(job, PHOTO_MORNING_TC.layer, 8, flip, signal, PHOTO_MORNING_TC),
          ]);
          if (!morning.failed && !morningLow.failed) matchPhotoTone(base.px, morning.px, morningLow.px, reference);
        }
        matchPhotoTone(base.px, sharp.px, low.px, reference);
      }
    }
    for (const region of regions) {
      if (region === primary) continue;
      const [detail, blurred] = await Promise.all([
        photoPixels(job, region.layer, region.maxZ, flip, signal, region, true),
        photoPixels(job, region.layer, 8, flip, signal, region),
      ]);
      if (detail.failed || blurred.failed) return PARENT_FOR_NOW;
      matchPhotoTone(base.px, detail.px, blurred.px, reference);
    }
    return { px: base.px, gaps: upgradeGap };
  }

  /** Seam fix tile: Moon Trek hillshade tiles x the local brightness-matched albedo, see-through where the photo shows. */
  async function runSynth(job: Extract<Job, { kind: 'synth' }>, flip: boolean): Promise<Drawn> {
    const { fix } = job, shade = fixShadeFor(fix, job.rect);
    const plan = planSynth(fp, job.rect, job.level, shade.maxZ);
    if (!plan) return NOTHING;
    const keyOf = (k: number) => `${shade.layer}/${k}`;
    let got = tiles.peekAll(plan.keys.map(keyOf));
    if (!got) {
      got = await Promise.all(plan.keys.map(k => { const t = trekTileOf(k); return tiles.get(keyOf(k), trekUrl(shade.layer, 'png', t.z, t.x, t.y)); }));
      if (got.includes(null)) return PARENT_FOR_NOW;
    }
    if (got.includes(null)) return PARENT_FOR_NOW;
    // Do not hold a large local image while a remote hillshade request waits.
    const albedo = await rasterFor(fix.albedo.url);
    if (!albedo) return { px: null, gaps: true };
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

  /** A local picture uses the same bounded LRU as the remote squares and science maps. */
  function basePicture(c: BaseCut): BaseEntry {
    let e = basePictures.get(c.url);
    if (e && e.failedAt && !stillFailing(e.failedAt, c.url)) { basePictures.delete(c.url); e = undefined; }
    if (!e) {
      const entry: BaseEntry = { pending: null, raster: null, failedAt: 0,
        get promise() { return this.pending ?? Promise.resolve(this.raster); } };
      entry.pending = (async () => {
        const blob = await fetchBlob(c.url, true);
        const raster = blob && blob !== 'missing' ? await decodeRaster(blob, c.mips, !!c.poleAware).catch(() => null) : null;
        if (raster) {
          entry.raster = raster;
          registerDecoded(`base:${c.url}`, rasterBytes(raster), () => {
            entry.raster = null;
            if (basePictures.get(c.url) === entry) basePictures.delete(c.url);
          }, 'base');
        }
        else { entry.failedAt = performance.now(); console.warn('Local Moon picture not available:', c.url); }
        return raster;
      })().finally(() => { entry.pending = null; }); // a settled promise must not keep an evicted image alive
      basePictures.set(c.url, (e = entry));
    }
    if (e.raster) touchDecoded(`base:${c.url}`);
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
    let e = rasters.get(url);
    if (e && e.failedAt && !stillFailing(e.failedAt, url)) { rasters.delete(url); e = undefined; } // try a failed picture again
    if (!e) {
      const entry: RasterEntry = { pending: null, raster: null, failedAt: 0,
        get promise() { return this.pending ?? Promise.resolve(this.raster); } };
      entry.pending = (async () => {
        const blob = await fetchBlob(url);
        const raster = blob && blob !== 'missing' ? await decodeRaster(blob).catch(() => null) : null;
        if (!raster) { entry.failedAt = performance.now(); console.warn('Polar map not available:', url); return null; } // transparent, never a black globe
        entry.raster = raster;
        registerDecoded(`raster:${url}`, rasterBytes(raster), () => {
          entry.raster = null;
          if (rasters.get(url) === entry) rasters.delete(url);
        }, 'raster');
        return raster;
      })().finally(() => { entry.pending = null; });
      rasters.set(url, e = entry);
    }
    if (e.raster) touchDecoded(`raster:${url}`);
    return e.promise;
  }

  async function runRaster(job: Extract<Job, { kind: 'raster' }>, flip: boolean): Promise<Drawn> {
    const raster = await rasterFor(job.url);
    if (!raster) return { px: null, gaps: true };
    const plan = planRaster(fp, job.rect, raster, job.extentM, job.clipTrueLat, job.featherM);
    return { px: plan ? sampleTiles(fp, plan.grids, [0], [plan.src], flip) : null, gaps: false };
  }

  const SCIENCE_IDLE_MS = 120000;
  const scienceBlocks = new ScienceBlockCache(64 * 2 ** 20);
  const sciencePreviews = new ScienceBlockCache(12 * 2 ** 20);
  const scienceActive = new Set<string>();
  interface ScienceEntry { source: ScienceRasterSource; lastUsed: number; decodeMs: number; pending: Map<number, Promise<Src | null>>; previewPending?: Promise<Src | null> }
  interface EncodedScience { bytes: Uint8Array | null; pending: Promise<Uint8Array | null> | null }
  const scienceEntries = new Map<string, ScienceEntry>();
  const scienceEncoded = new Map<string, EncodedScience>();
  const scienceFailures = new Set<string>();
  const scienceFailureReasons = new Map<string, string>();
  let scienceDrawTail: Promise<void> = Promise.resolve();
  let scienceEpoch = 0;

  function scienceEntry(source: ScienceRasterSource): ScienceEntry {
    let entry = scienceEntries.get(source.url);
    if (!entry) { entry = { source, lastUsed: 0, decodeMs: 0, pending: new Map() }; scienceEntries.set(source.url, entry); }
    else entry.source = { ...entry.source, ...source, packed: source.packed ?? entry.source.packed, preview: source.preview ?? entry.source.preview, palette: source.palette ?? entry.source.palette };
    if (source.palette && !sciencePalettes.has(source.url)) sciencePalettes.set(source.url, sciencePalette(source.palette));
    return entry;
  }

  async function encodedScience(url: string): Promise<Uint8Array | null> {
    let entry = scienceEncoded.get(url);
    if (!entry) { entry = { bytes: null, pending: null }; scienceEncoded.set(url, entry); }
    if (entry.bytes) return entry.bytes;
    if (entry.pending) return entry.pending;
    const record = entry;
    record.pending = (async () => {
      let cache: Cache | null = null;
      try {
        if (typeof caches !== 'undefined') { cache = await caches.open('moonda-science-v1'); const hit = await cache.match(url); if (hit) return new Uint8Array(await hit.arrayBuffer()); }
      } catch { cache = null; }
      // These immutable local files include a 21 MB global grid. A cold page can still be
      // reading its photo and terrain, so use a separate, longer deadline than photo tiles.
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
      const tally = traffic.local ??= { requests: 0, bytes: 0 };
      tally.requests++; net[0]++;
      let bytes: Uint8Array;
      try {
        const response = await fetch(url, { cache: 'force-cache', credentials: 'omit', signal: controller.signal });
        if (!response.ok) throw new Error(`Science file returned ${response.status}`);
        bytes = new Uint8Array(await response.arrayBuffer()); tally.bytes += bytes.byteLength;
      } catch (error) { net[2]++; throw error; }
      finally { clearTimeout(timer); }
      if (cache) await cache.put(url, new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
      return bytes;
    })().then(bytes => {
      record.bytes = bytes;
      if (bytes) { scienceFailures.delete(url); scienceFailureReasons.delete(url); }
      else { scienceFailures.add(url); scienceFailureReasons.set(url, 'Science file was not available'); }
      return bytes;
    }).catch(error => { scienceFailures.add(url); scienceFailureReasons.set(url, String(error)); return null; }).finally(() => { record.pending = null; });
    return record.pending;
  }

  async function warmScienceSource(source: ScienceRasterSource): Promise<boolean> {
    const entry = scienceEntry(source), s = entry.source;
    const urls = [s.packed?.url ?? s.url, ...(s.preview ? [s.preview.url] : [])];
    return (await Promise.all(urls.map(encodedScience))).every(Boolean);
  }

  function sweepScience(dropAll = false, dropCompressed = false) {
    if (dropAll) { scienceEpoch++; scienceBlocks.clear(); sciencePreviews.clear(); }
    else { const now = performance.now(); scienceBlocks.trim(now, scienceActive, SCIENCE_IDLE_MS); sciencePreviews.trim(now, scienceActive, SCIENCE_IDLE_MS); }
    if (dropCompressed) scienceEncoded.clear();
  }
  const scienceSweep = setInterval(() => sweepScience(), 20000);
  (scienceSweep as unknown as { unref?: () => void }).unref?.();

  function scienceMemory(): ScienceMemoryStats {
    sweepScience();
    const maps = [...scienceEntries.values()].map(e => {
      const s = e.source, urls = new Set([s.packed?.url ?? s.url, ...(s.preview ? [s.preview.url] : [])]);
      return { url: s.url, compressedBytes: [...urls].reduce((n, u) => n + (scienceEncoded.get(u)?.bytes?.byteLength ?? 0), 0),
        decodedBytes: scienceBlocks.bytesFor(s.url), previewBytes: sciencePreviews.bytesFor(s.url), active: scienceActive.has(s.url), lastUsed: e.lastUsed, decodeMs: e.decodeMs,
        available: [...urls].every(url => !!scienceEncoded.get(url)?.bytes) };
    });
    return { compressedBytes: [...scienceEncoded.values()].reduce((n, e) => n + (e.bytes?.byteLength ?? 0), 0), decodedBytes: scienceBlocks.bytes,
      previewBytes: sciencePreviews.bytes, decodedBudgetBytes: scienceBlocks.budgetBytes, previewBudgetBytes: sciencePreviews.budgetBytes, idleMs: SCIENCE_IDLE_MS, maps,
      failedUrls: [...scienceFailures], failureReasons: Object.fromEntries(scienceFailureReasons) };
  }
  (self as unknown as { __moondaScienceWorkerStats: () => ScienceMemoryStats }).__moondaScienceWorkerStats = scienceMemory;

  function scienceWorkerCacheStats(): DecodedCacheStats {
    const base = decodedCacheStats();
    const bytes = scienceBlocks.bytes + sciencePreviews.bytes, count = scienceBlocks.size + sciencePreviews.size;
    return { ...base, budgetBytes: scienceBlocks.budgetBytes + sciencePreviews.budgetBytes, retainedBytes: base.retainedBytes + bytes,
      retainedCount: base.retainedCount + count, bytesByKind: { ...base.bytesByKind, raster: base.bytesByKind.raster + bytes }, countByKind: { ...base.countByKind, raster: base.countByKind.raster + count } };
  }

  async function sciencePlane(entry: ScienceEntry, tile: number): Promise<Src | null> {
    const s = entry.source, key = `${s.url}:${tile}`, now = performance.now(), cached = scienceBlocks.get(key, now);
    entry.lastUsed = now;
    if (cached) return cached;
    const pending = entry.pending.get(tile); if (pending) return pending;
    const epoch = scienceEpoch;
    const load = (async () => {
      const encoded = await encodedScience(s.packed?.url ?? s.url); if (!encoded) return null;
      const began = performance.now();
      let plane: Src;
      if (s.packed) plane = await decodeScienceBlock(encoded, s.packed, tile);
      else {
        const before = rasterDecodeTail; let release!: () => void;
        rasterDecodeTail = new Promise<void>(resolve => { release = resolve; });
        await before;
        try { plane = await decode(new Blob([encoded as Uint8Array<ArrayBuffer>])); } finally { release(); }
      }
      entry.decodeMs = performance.now() - began;
      if (epoch === scienceEpoch) scienceBlocks.put(key, s.url, plane, performance.now());
      return plane;
    })().catch(() => null).finally(() => entry.pending.delete(tile));
    entry.pending.set(tile, load); return load;
  }

  async function sciencePreview(entry: ScienceEntry): Promise<Src | null> {
    const s = entry.source, cached = sciencePreviews.get(s.url, performance.now());
    if (cached) return cached;
    if (entry.previewPending) return entry.previewPending;
    const epoch = scienceEpoch;
    entry.previewPending = (async () => {
      let preview: Src | null = null;
      if (s.preview) { const bytes = await encodedScience(s.preview.url); if (bytes) preview = await decodeScienceBlock(bytes, s.preview); }
      else { const full = await sciencePlane(entry, 0); if (full) preview = buildSciencePreview(full, sciencePalettes.get(s.url)); }
      if (preview && epoch === scienceEpoch) sciencePreviews.put(s.url, s.url, preview, performance.now());
      return preview;
    })().catch(() => null).finally(() => { entry.previewPending = undefined; });
    return entry.previewPending;
  }

  function scienceSourceTouches(source: ScienceRasterSource, range: { minDeg: number; maxDeg: number }, pixel = 0): boolean {
    if (source.projection === 'global') return true;
    const north = source.pole === 'north', clip = Math.abs(source.clipTrueLatDeg ?? 80), max = source.maximumTrueLatDeg ?? 90;
    return north ? range.maxDeg >= clip - pixel && range.minDeg <= max + pixel : range.minDeg <= -clip + pixel && range.maxDeg >= -max - pixel;
  }

  function scienceSourceCovers(source: ScienceRasterSource, range: { minDeg: number; maxDeg: number }): boolean {
    if (source.projection === 'global') return true;
    const north = source.pole === 'north', clip = Math.abs(source.clipTrueLatDeg ?? 80), max = source.maximumTrueLatDeg ?? 90;
    if (north ? range.minDeg < clip || range.maxDeg > max : range.maxDeg > -clip || range.minDeg < -max) return false;
    // The cap must fit inside the square too; this proves no uncovered corner can be erased.
    return (source.extentM ?? 304000) >= polarRho(-(north ? range.minDeg : -range.maxDeg));
  }

  function scienceFootprint(source: ScienceRasterSource, rect: Rect, level: number, width: number, height: number): boolean {
    if (source.projection === 'global') scienceGlobalFootprint(fp, rect, level, { levels: [{ w: width, h: height, ch: 1, data: new Uint8Array(0) }] });
    else {
      const north = source.pole === 'north', half = source.extentM ?? 304000, clip = Math.abs(source.clipTrueLatDeg ?? 80);
      if (!polarGeometry(fp, rect, polarRho(-clip), 0, half, north)) return false;
      polarCoords(fp, half, width / (2 * half), height / (2 * half));
      if (source.maximumTrueLatDeg !== undefined) for (let p = 0; p < N2; p++) {
        const absoluteLat = 90 - 2 * Math.atan(Math.hypot(fp.a[p], fp.b[p]) / (2 * MOON_R)) / DEG;
        if (absoluteLat > source.maximumTrueLatDeg) fp.cov[p] = 0;
      }
    }
    return true;
  }

  async function drawScience(job: Extract<Job, { kind: 'science' }>, flip: boolean, signal: AbortSignal): Promise<Drawn> {
    let out: Uint8ClampedArray<ArrayBuffer> | null = null, gaps = false;
    const range = tileTrueLatRange(job.rect), pixel = pixelDeg(job.level);
    for (let i = 0; i < job.sources.length; i++) {
      signal.throwIfAborted();
      const source = job.sources[i];
      if (!scienceSourceTouches(source, range, pixel)) continue;
      if (job.sources.slice(i + 1).some(s => s.replace && scienceSourceCovers(s, range))) continue;
      const entry = scienceEntry(source), s = entry.source;
      entry.lastUsed = performance.now();
      const preview = await sciencePreview(entry);
      if (!preview) { gaps = true; continue; }
      signal.throwIfAborted();
      const sourceWidth = s.packed?.width ?? preview.w, sourceHeight = s.packed?.height ?? preview.h;
      const sourcePixelM = s.projection === 'global' ? 2 * Math.PI * MOON_R / sourceWidth : 2 * (s.extentM ?? 304000) / sourceWidth;
      const previewPixelM = s.projection === 'global' ? 2 * Math.PI * MOON_R / preview.w : 2 * (s.extentM ?? 304000) / preview.w;
      // A small averaged preview is the correct source for a distant map. Do not inflate fine
      // blocks there: the whole Moon may need every map but only a few hundred display pixels.
      const usePreview = !s.packed || scienceUsesPreview(pixelMetres(job.level), previewPixelM);
      let px: Uint8ClampedArray<ArrayBuffer> | null;
      if (usePreview) {
        if (!scienceFootprint(s, job.rect, job.level, preview.w, preview.h)) continue;
        px = sampleScience(fp, { levels: [preview] }, undefined, s.projection === 'global', flip);
      } else {
        if (!scienceFootprint(s, job.rect, job.level, sourceWidth, sourceHeight)) continue;
        const size = s.packed?.tileSize ?? Math.max(sourceWidth, sourceHeight), grid: Grid = { tileW: size, tileH: size, tilesX: Math.ceil(sourceWidth / size), width: sourceWidth, height: sourceHeight, global: s.projection === 'global' };
        const span = Math.max(1, pixelMetres(job.level) / sourcePixelM), keys = scienceTileKeys(fp, grid, span), tiles = new Map<number, Src>();
        for (const key of keys) { signal.throwIfAborted(); const plane = await sciencePlane(entry, key); if (plane) tiles.set(key, plane); else gaps = true; }
        // Waiting for inflation let another value query use the scratch footprint.
        scienceFootprint(s, job.rect, job.level, sourceWidth, sourceHeight);
        px = sampleScienceChunks(fp, sourceWidth, sourceHeight, size, tiles, sciencePalettes.get(s.url), s.projection === 'global', flip, span);
      }
      if (!px && !s.replace) continue;
      out ??= new Uint8ClampedArray(N2 * 4); compositeSciencePixels(out, px, fp.cov, flip, s.replace);
    }
    if (out) fillClear(out);
    return { px: out, gaps };
  }

  async function runScience(job: Extract<Job, { kind: 'science' }>, flip: boolean, signal: AbortSignal): Promise<Drawn> {
    const before = scienceDrawTail; let release!: () => void;
    scienceDrawTail = new Promise<void>(resolve => { release = resolve; });
    await before;
    try { signal.throwIfAborted(); return await drawScience(job, flip, signal); } finally { release(); }
  }

  async function scienceValue(source: ScienceRasterSource, lat: number, lon: number): Promise<number | null> {
    if (!scienceSourceTouches(source, { minDeg: lat, maxDeg: lat })) return null;
    const entry = scienceEntry(source), s = entry.source;
    entry.lastUsed = performance.now();
    let width = s.packed?.width, height = s.packed?.height;
    let temporary: Src | null = null;
    if (!width || !height) {
      const encoded = await encodedScience(s.url); if (!encoded) return null;
      const before = rasterDecodeTail; let release!: () => void;
      rasterDecodeTail = new Promise<void>(resolve => { release = resolve; }); await before;
      try { temporary = await decode(new Blob([encoded as Uint8Array<ArrayBuffer>])); } finally { release(); }
      width = temporary.w; height = temporary.h;
    }
    let col: number, row: number;
    if (s.projection === 'global') { col = Math.floor((((lon + 180) % 360 + 360) % 360) / 360 * width); row = clamp(Math.floor((90 - lat) / 180 * height), 0, height - 1); }
    else {
      const north = s.pole === 'north', rho = 2 * MOON_R * Math.tan((90 - Math.abs(lat)) * DEG / 2), half = s.extentM ?? 304000;
      const x = rho * Math.sin(lon * DEG), y = (north ? -1 : 1) * rho * Math.cos(lon * DEG);
      col = Math.floor((x + half) / (2 * half) * width); row = Math.floor((half - y) / (2 * half) * height);
      if (col < 0 || row < 0 || col >= width || row >= height) return null;
    }
    if (temporary) { const value = temporary.ch === 1 ? scienceCodeAt(temporary, row * width + col) : 255; return value === 255 ? null : value; }
    const size = s.packed?.tileSize ?? Math.max(width, height), across = Math.ceil(width / size), tile = Math.floor(row / size) * across + Math.floor(col / size);
    const plane = await sciencePlane(entry, tile); if (!plane || plane.ch !== 1) return null;
    const value = scienceCodeAt(plane, row % size * plane.w + col % size);
    return value === 255 ? null : value;
  }


  async function handle({ id, job, flipRows }: Extract<ToWorker, { job: Job }>) {
    const controller = new AbortController();
    jobs.set(id, controller);
    let bitmap: ImageBitmap | null = null, gaps = true, parent = false;
    try {
      const d = job.kind === 'trek' ? await runTrek(job, flipRows) : job.kind === 'pyramid' ? await runPyramid(job, flipRows)
        : job.kind === 'base' ? await runBase(job, flipRows) : job.kind === 'synth' ? await runSynth(job, flipRows)
        : job.kind === 'photo' ? await runPhoto(job, flipRows, controller.signal) : job.kind === 'science' ? await runScience(job, flipRows, controller.signal) : await runRaster(job, flipRows);
      controller.signal.throwIfAborted();
      gaps = d.gaps; parent = !!d.parent;
      if (d.px) bitmap = await createImageBitmap(new ImageData(d.px, TILE, TILE), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    } catch (err) {
      if (!controller.signal.aborted) console.warn('Imagery tile failed:', err); // the main thread shows a transparent tile instead
    }
    jobs.delete(id);
    if (controller.signal.aborted) { bitmap?.close(); bitmap = null; gaps = false; parent = true; }
    const msg: FromWorker = { id, bitmap, gaps, recovered, parent, net: [net[0], net[1], net[2]], traffic, cache: job.kind === 'science' ? scienceWorkerCacheStats() : decodedCacheStats(), ...(job.kind === 'science' ? { science: scienceMemory() } : {}) };
    recovered = false;
    self.postMessage(msg, { transfer: bitmap ? [bitmap] : [] });
  }

  self.onmessage = (e: MessageEvent<ToWorker>) => {
    const m = e.data;
    if ('photoView' in m) { photoView = m.photoView; return; }
    if ('cacheBudgetBytes' in m) {
      if (Number.isFinite(m.cacheBudgetBytes) && m.cacheBudgetBytes >= 2 ** 20) { decodedBudgetBytes = m.cacheBudgetBytes; trimDecoded(); }
    }
    else if ('cancel' in m) jobs.get(m.cancel)?.abort();
    else if ('forgetFailures' in m) { forgetBefore = performance.now(); for (const b of breakers.values()) b.fails = 0; }
    else if ('pyramidIndex' in m) stored = { base: m.base, index: parsePyramidIndex(m.pyramidIndex) };
    // decode these maps now, one after the other, so that switching one on later shows it at once
    else if ('warmRasters' in m) void (async () => { for (const u of m.warmRasters) await rasterFor(u).catch(() => null); })();
    else if ('warmScience' in m) void (async () => {
      const missing: ScienceRasterSource[] = [];
      let done = 0;
      const report = (frac: number, ok: boolean) => self.postMessage({ id: 0, bitmap: null, gaps: false, recovered: false, warmed: m.warmId, warmFrac: frac, warmOk: ok, cache: scienceWorkerCacheStats(), science: scienceMemory() } satisfies FromWorker);
      for (const source of m.warmScience) {
        if (!await warmScienceSource(source).catch(() => false)) missing.push(source);
        report(++done / m.warmScience.length * 0.9, missing.length === 0);
      }
      // Retry a missing file once, after the other startup reads have finished. Cached files
      // are reused, and the final acknowledgement waits for this bounded second pass.
      let ok = true;
      for (let i = 0; i < missing.length; i++) {
        if (!await warmScienceSource(missing[i]).catch(() => false)) ok = false;
        report(0.9 + (i + 1) / missing.length * 0.09, ok);
      }
      report(1, ok);
    })();
    else if ('scienceValue' in m) void scienceValue(m.scienceValue.source, m.scienceValue.lat, m.scienceValue.lon).then(value => {
      self.postMessage({ id: 0, bitmap: null, gaps: false, recovered: false, valueId: m.valueId, value, science: scienceMemory(), cache: scienceWorkerCacheStats() } satisfies FromWorker);
    }).catch(() => self.postMessage({ id: 0, bitmap: null, gaps: false, recovered: false, valueId: m.valueId, value: null } satisfies FromWorker));
    else if ('scienceState' in m) {
      scienceActive.clear(); for (const url of m.scienceState.activeUrls) scienceActive.add(url);
      sweepScience();
      self.postMessage({ id: 0, bitmap: null, gaps: false, recovered: false, scienceRequestId: m.scienceRequestId, science: scienceMemory(), cache: scienceWorkerCacheStats() } satisfies FromWorker);
    }
    else if ('scienceTrim' in m) {
      sweepScience(!!m.scienceTrim.dropAll, !!m.scienceTrim.dropCompressed);
      self.postMessage({ id: 0, bitmap: null, gaps: false, recovered: false, scienceRequestId: m.scienceRequestId, science: scienceMemory(), cache: scienceWorkerCacheStats() } satisfies FromWorker);
    }
    else if ('scienceStats' in m) self.postMessage({ id: 0, bitmap: null, gaps: false, recovered: false, scienceRequestId: m.scienceStats.requestId, science: scienceMemory(), cache: scienceWorkerCacheStats() } satisfies FromWorker);
    else void handle(m);
  };
}

if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope === 'function') startWorker();
