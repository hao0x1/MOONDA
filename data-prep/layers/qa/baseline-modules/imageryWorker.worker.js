import "/node_modules/vite/dist/client/env.mjs"
;
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
export const TILE = 256;
const N2 = TILE * TILE;
const MOON_R = 1737400;
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
export const POLAR_FEATHER_M = 4e4;
/** At most this many pyramid squares per display tile before we step to a coarser pyramid level. */
const MAX_PYRAMID_TILES = 12;
// Moon Trek near the true poles. Its pictures are lon/lat grids, so towards a pole one display
// pixel covers more and more Moon Trek pixels east-west (about 1/cos(latitude) of them). One
// sample per display pixel would turn that fine detail into false stripes (moiré), so we average
// several samples along true east instead. Closer to the true north pole than ~82° we also read
// coarser Moon Trek levels, or a single display tile would need hundreds of source tiles. That
// choice depends only on the latitude of each pixel, so neighbouring tiles always agree (no seams).
const TAP_SPACING = 1.25;
const MAX_TAPS = 8;
const SQUEEZE_FULL = 7;
const SQUEEZE_POLE = 5.6;
const MAX_TREK_LEVEL = 16;
const clamp = (x, lo, hi) => x < lo ? lo : x > hi ? hi : x;
const clamp01 = (x) => x <= 0 ? 0 : x >= 1 ? 1 : x;
const smooth = (t) => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
/** Size of one display-tile pixel at a tile level, in degrees of arc and in metres on the surface. */
export const pixelDeg = (level) => 180 / (TILE * 2 ** level);
export const pixelMetres = (level) => pixelDeg(level) * DEG * MOON_R;
/** Lowest and highest TRUE latitude (degrees) anywhere inside a display-frame tile. */
export function tileTrueLatRange(r) {
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
	return {
		minDeg: Math.asin(clamp(-yMax, -1, 1)) / DEG,
		maxDeg: Math.asin(clamp(-yMin, -1, 1)) / DEG
	};
}
// ---------------------------------------------------------------------------------------------
// The seam fix (v5). NASA's WAC global mosaic is lit from the west everywhere except true lon
// -180..-90, which is lit from the east: two straight lighting flips at -90 and 180 (both on display
// tile edges, so they show as crisp lines). There the app draws albedo x hillshade instead (lit from
// the west like the rest), cross-faded into the photo over -90..-80 and 165..180. The local base
// pictures have it baked in (data-prep/base_mosaic.py, same formula); deeper tiles get it from the
// 'synth' job below.
export const FIX_BAND_WEST = [-90, -80];
export const FIX_BAND_EAST = [165, 180];
/** How much of the fixed picture (1) vs the photo (0) shows at a true longitude (degrees). Same as fix_weight in base_mosaic.py. */
export function fixWeightDeg(lonDeg) {
	const lon = ((lonDeg + 180) % 360 + 360) % 360 - 180;
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
export function tileFixRange(r) {
	const lat = tileTrueLatRange(r);
	if (lat.maxDeg > 84 || lat.minDeg < -84) return {
		min: 0,
		max: 1
	};
	const margin = Math.max(.05, (r.east - r.west) / DEG * .25 / Math.max(.1, Math.cos(Math.max(Math.abs(lat.minDeg), Math.abs(lat.maxDeg)) * DEG)));
	let min = 1, max = 0;
	for (let j = 0; j <= 8; j++) {
		const la = r.south + (r.north - r.south) * j / 8, cl = Math.cos(la), Z = Math.sin(la);
		for (let i = 0; i <= 8; i++) {
			const lo = r.west + (r.east - r.west) * i / 8;
			const tLon = Math.atan2(Z, cl * Math.cos(lo)) / DEG;
			for (const d of [
				-margin,
				0,
				margin
			]) {
				const w = fixWeightDeg(tLon + d);
				if (w < min) min = w;
				if (w > max) max = w;
			}
		}
	}
	return {
		min,
		max
	};
}
export const FIX_NEAR_MAX_Z = 8;
export const FIX_FAR_MAX_Z = 6;
/** The hillshade layer and deepest level a fix tile reads. */
export function fixShadeFor(fix, r) {
	const lat = tileTrueLatRange(r);
	return lat.minDeg > -fix.nearMaxLat && lat.maxDeg < fix.nearMaxLat ? {
		layer: fix.near,
		maxZ: FIX_NEAR_MAX_Z
	} : {
		layer: fix.far,
		maxZ: FIX_FAR_MAX_Z
	};
}
/** Bilinear sample of a true lon/lat picture (lon wraps from `west`, `east - west` wide) at true lat/lon (radians). */
export function sampleLonLat(s, west, east, north, south, latRad, lonRad) {
	const lonD = lonRad / DEG, latD = latRad / DEG;
	const u = ((lonD - west) % 360 + 360) % 360 * (s.w / (east - west)) - .5, v = (north - latD) * (s.h / (north - south)) - .5;
	const c0 = clamp(Math.floor(u), 0, s.w - 2), r0 = clamp(Math.floor(v), 0, s.h - 2), tx = clamp01(u - c0), ty = clamp01(v - r0);
	const d = s.data, ch = s.ch, a = (r0 * s.w + c0) * ch, b = a + ch, c = a + s.w * ch, e = c + ch;
	return (d[a] * (1 - tx) + d[b] * tx) * (1 - ty) + (d[c] * (1 - tx) + d[e] * tx) * ty;
}
/** Distance from the south pole on the south-polar-stereographic map (m) at a true latitude. */
export const polarRho = (trueLatDeg) => 2 * MOON_R * Math.tan(Math.PI / 4 + trueLatDeg * DEG / 2);
/** NASA Moon Trek WMTS tile (true lon/lat): row 0 at 90°N, column 0 at 180°W. */
export const trekUrl = (layer, ext, z, x, y) => `https://trek.nasa.gov/tiles/Moon/EQ/${layer}/1.0.0/default/default028mm/${z}/${y}/${x}.${ext}`;
/** The layer's WMTS description, which lists the levels the server really has. */
export const trekCapabilitiesUrl = (layer) => `https://trek.nasa.gov/tiles/Moon/EQ/${layer}/1.0.0/WMTSCapabilities.xml`;
/**
* Deepest Moon Trek level listed in a WMTSCapabilities.xml (the file also holds commented-out
* levels, which do not count), or null if it lists none. We cannot simply try a level and look
* for "404 Not Found": Moon Trek sends its 404s without the CORS header, so in a browser a
* missing tile looks exactly like a network failure.
*/
export function parseTrekDepth(xml) {
	const live = xml.replace(/<!--[\s\S]*?-->/g, "");
	let depth = -1;
	for (const m of live.matchAll(/<TileMatrix>\s*<ows:Identifier>\s*(\d+)\s*<\/ows:Identifier>/g)) depth = Math.max(depth, Number(m[1]));
	return depth >= 0 ? depth : null;
}
// Polar pyramid: the 608 km square around the south pole split into 2^k x 2^k squares of 512 px
// (1187/2^k metres per pixel), each fetched once from ASU Lunaserv in the polar projection.
export const PYRAMID_HALF_M = 304e3;
const PYRAMID_SPAN_M = 2 * PYRAMID_HALF_M;
export const PYRAMID_PX = 512;
export const PYRAMID_MAX_K = 10;
const PYRAMID_HOSTS = [
	"wms",
	"wms1",
	"wms2",
	"wms3",
	"wms4",
	"wms5",
	"wms6",
	"wms7"
];
/**
* The sharp NAC mosaic only exists south of this true latitude (measured: Lunaserv's
* luna_nac_pole_control_south layer is empty beyond 182 km from the pole). Further out the server
* only has the 100 m/pixel WAC mosaic.
*/
export const PYRAMID_NAC_LAT_DEG = -84;
/** Finest pyramid level worth drawing where only the WAC mosaic exists: 74 m/pixel shows all of its detail. */
export const PYRAMID_WAC_MAX_K = 4;
/** Pyramid level whose pixels are at least as fine as a display tile's pixels at this level. */
export function pyramidLevelFor(displayLevel) {
	const k = Math.ceil(Math.log2(PYRAMID_SPAN_M / (PYRAMID_PX * pixelMetres(displayLevel))));
	return clamp(k, 0, PYRAMID_MAX_K);
}
/** WMS request for pyramid square (i = column from the left, j = row from the top) at level k. */
export function pyramidUrl(layers, k, i, j) {
	const S = PYRAMID_SPAN_M / 2 ** k;
	const x0 = -PYRAMID_HALF_M + i * S, y1 = PYRAMID_HALF_M - j * S;
	return `https://${PYRAMID_HOSTS[(i + j * 3 + k) % PYRAMID_HOSTS.length]}.im-ldi.com/?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&STYLES=&LAYERS=${layers}` + `&SRS=IAU2000:30120&BBOX=${x0},${y1 - S},${x0 + S},${y1}&WIDTH=${PYRAMID_PX}&HEIGHT=${PYRAMID_PX}&FORMAT=image/jpeg`;
}
/** Finest pyramid level that holds real detail somewhere inside a display tile. */
export function pyramidMaxKFor(r) {
	return tileTrueLatRange(r).minDeg >= PYRAMID_NAC_LAT_DEG ? PYRAMID_WAC_MAX_K : PYRAMID_MAX_K;
}
/**
* True when a display tile could only repeat what its parent tile already shows, because the
* photos have no finer detail there. Cesium is then told to keep drawing the parent: no download,
* no work, no extra memory.
*/
export function pyramidParentIsEnough(r, displayLevel) {
	return displayLevel > 0 && pyramidLevelFor(displayLevel - 1) >= pyramidMaxKFor(r);
}
/** Read public/data/polar/t/index.json (written by data-prep/polar_tiles.py). Null if it does not describe this pyramid. */
export function parsePyramidIndex(json) {
	const j = json;
	if (!j || typeof j.layers !== "string" || j.halfM !== PYRAMID_HALF_M || j.tilePx !== PYRAMID_PX || !j.levels || typeof j.levels !== "object") return null;
	const rows = new Map();
	let count = 0;
	for (const [name, lv] of Object.entries(j.levels)) {
		const k = Number(name);
		if (!Number.isInteger(k) || k < 0 || k > PYRAMID_MAX_K || !Array.isArray(lv?.runs)) continue;
		const byRow = new Map();
		for (const run of lv.runs) {
			if (!Array.isArray(run) || run.length !== 3 || !run.every(Number.isInteger)) continue;
			const [row, first, last] = run;
			if (row < 0 || first < 0 || last < first || last >= 2 ** k || row >= 2 ** k) continue;
			let list = byRow.get(row);
			if (!list) byRow.set(row, list = []);
			list.push(first, last);
			count += last - first + 1;
		}
		rows.set(k, byRow);
	}
	return {
		layers: j.layers,
		count,
		rows
	};
}
/** Is pyramid square (column i, row j) of level k stored with the app? */
export function pyramidHasLocal(ix, k, i, j) {
	const runs = ix?.rows.get(k)?.get(j);
	if (!runs) return false;
	for (let q = 0; q < runs.length; q += 2) if (i >= runs[q] && i <= runs[q + 1]) return true;
	return false;
}
/** Where a stored pyramid square lives (`base` = the folder of index.json, ending in "/"). */
export const pyramidLocalUrl = (base, k, i, j) => `${base}${k}/${i}_${j}.jpg`;
/**
* Quick test on the main thread: can a display tile surely be drawn from stored squares alone?
* (Its outline is mapped onto the polar grid and every square under that box must be stored.)
* Such tiles never wait for the network, so they are not held back behind slow downloads.
*/
export function pyramidSurelyLocal(ix, r, displayLevel) {
	if (!ix) return false;
	const k = Math.min(pyramidLevelFor(displayLevel), pyramidMaxKFor(r)), n = 2 ** k, S = PYRAMID_SPAN_M / n;
	let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
	for (let a = 0; a <= 2; a++) {
		for (let b = 0; b <= 2; b++) {
			const lon = r.west + a / 2 * (r.east - r.west), lat = r.south + b / 2 * (r.north - r.south), cl = Math.cos(lat);
			const den = 1 + cl * Math.sin(lon);
			if (den < 1e-6) return false;
			const f = 2 * MOON_R / den, mx = f * Math.sin(lat), my = f * cl * Math.cos(lon);
			x0 = Math.min(x0, mx);
			x1 = Math.max(x1, mx);
			y0 = Math.min(y0, my);
			y1 = Math.max(y1, my);
		}
	}
	const pad = S / PYRAMID_PX + .02 * (x1 - x0 + y1 - y0);
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
export const PHOTO_TC = "Kaguya_TCortho_Mosaic_Global_4096ppd";
// The catalogue says 7.4 m; the LIVE WMTS stops at z10 (20.8 m). z11/12 return 404.
export const PHOTO_TC_MAX_Z = 10;
export const PHOTO_FINE_TC_MAX_Z = 12;
export const NORTH_PHOTO_LAT = 84;
export const NORTH_PHOTO_HALF_M = 931070;
export const NORTH_PHOTO_MAX_Z = 12;
export const PHOTO_FINE_TC = {
	layer: "kag_tc_e_7m",
	maxZ: PHOTO_FINE_TC_MAX_Z,
	west: -180,
	south: -90,
	east: 180,
	north: 90,
	quickmap: true,
	global: true
};
const PHOTO_MORNING_TC = {
	...PHOTO_FINE_TC,
	layer: "kag_tc_m_7m"
};
// Bounds from Moon Trek's live catalogue, checked 14 Nov 2026. Never fetch a whole globe of NAC tiles.
export const PHOTO_REGIONS = [
	{
		layer: "LRO_NAC_Apollo11_Mosaic_p",
		maxZ: 15,
		west: 23.4484977,
		south: .1464484,
		east: 23.5396839,
		north: 1.1149051
	},
	{
		layer: "LRO_NAC_Apollo12_Mosaic_p",
		maxZ: 16,
		west: -23.444516,
		south: -3.4716075,
		east: -23.3574736,
		north: -2.5021693
	},
	{
		layer: "LRO_NAC_Apollo14_Mosaic_p",
		maxZ: 15,
		west: -17.4900752,
		south: -4.1920876,
		east: -17.3907622,
		north: -3.2253601
	},
	{
		layer: "LRO_NAC_Apollo15_Mosaic_p",
		maxZ: 16,
		west: 3.5805462,
		south: 25.7964334,
		east: 3.6893852,
		north: 26.7634904
	},
	{
		layer: "LRO_NAC_Apollo16_Mosaic_p",
		maxZ: 14,
		west: 15.3788327,
		south: -9.6060973,
		east: 15.5545346,
		north: -8.6616783
	},
	{
		layer: "NAC_DTM_APOLLO17_MOSAIC_120CM",
		maxZ: 14,
		west: 29.9059014,
		south: 19.3905439,
		east: 31.6579562,
		north: 21.3035034
	},
	{
		layer: "LRO_NAC_Mosaic_43S349E_50cmp",
		maxZ: 14,
		west: -12.10517,
		south: -43.6431726,
		east: -10.3007028,
		north: -42.3234729
	},
	{
		layer: "LRO_NAC_Post_Landing_OrthoMosaic_1mpp_IM_1_LandingSite",
		maxZ: 13,
		west: .9386801,
		south: -80.2163532,
		east: 1.9391742,
		north: -80.0428121
	},
	{
		layer: "LRO_NAC_Mosaic_50cmpp_VonKarman_v2",
		maxZ: 15,
		west: 171.4493162,
		south: -48.9293994,
		east: 179.9242867,
		north: -42.0188174
	},
	{
		layer: "LRO_NAC_Mosaic_0_82mpp_Shioli",
		maxZ: 15,
		west: 25.0600958,
		south: -14.1732319,
		east: 25.8436614,
		north: -12.587345
	},
	{
		layer: "LRO_NAC_ortho_horseshoeV2",
		maxZ: 15,
		west: 61.3920203,
		south: 16.6078286,
		east: 62.2274717,
		north: 20.0912737
	},
	{
		layer: "wac_nac_nacroi",
		quickmap: true,
		maxZ: 15,
		west: -19.5516,
		south: 44.0814,
		east: -19.4716,
		north: 44.1614
	},
	{
		layer: "wac_nac_nacroi",
		quickmap: true,
		maxZ: 15,
		west: -51.9569,
		south: 43.018,
		east: -51.8769,
		north: 43.098
	},
	{
		layer: "wac_nac_nacroi",
		quickmap: true,
		maxZ: 15,
		west: -154.025,
		south: -41.6785,
		east: -153.945,
		north: -41.5985
	},
	{
		layer: "wac_nac_nacroi",
		quickmap: true,
		maxZ: 15,
		west: 32.279,
		south: -69.413,
		east: 32.359,
		north: -69.333
	},
	{
		layer: "wac_nac_nacroi",
		quickmap: true,
		maxZ: 15,
		west: 22.744,
		south: -70.921,
		east: 22.824,
		north: -70.841
	},
	{
		layer: "wac_nac_nacroi",
		quickmap: true,
		maxZ: 15,
		west: 19.3096,
		south: 32.5556,
		east: 19.3896,
		north: 32.6356
	},
	{
		layer: "wac_nac_nacroi",
		quickmap: true,
		maxZ: 15,
		west: 44.055,
		south: 47.541,
		east: 44.135,
		north: 47.621
	},
	{
		layer: "wac_nac_nacroi",
		quickmap: true,
		maxZ: 15,
		west: -4.64,
		south: 60.769,
		east: -4.56,
		north: 60.849
	}
];
/** Conservative true-frame box; small display tiles only, with a margin for curved edges. */
export function photoRegionsFor(r) {
	const lat = tileTrueLatRange(r);
	if (lat.maxDeg > 83 || lat.minDeg < -83) return [];
	let west = Infinity, east = -Infinity;
	for (const a of [
		r.south,
		(r.south + r.north) / 2,
		r.north
	]) {
		for (const b of [
			r.west,
			(r.west + r.east) / 2,
			r.east
		]) {
			const lon = Math.atan2(Math.sin(a), Math.cos(a) * Math.cos(b)) / DEG;
			west = Math.min(west, lon);
			east = Math.max(east, lon);
		}
	}
	const pad = 2 * (r.east - r.west) / DEG;
	return PHOTO_REGIONS.filter((p) => lat.minDeg <= p.north + pad && lat.maxDeg >= p.south - pad && west <= p.east + pad && east >= p.west - pad);
}
/** A whole display tile lies safely inside the NAC feather: TC underneath would be wasted. */
export function photoRegionCovers(r, region) {
	for (const a of [
		r.south,
		(r.south + r.north) / 2,
		r.north
	]) for (const b of [
		r.west,
		(r.west + r.east) / 2,
		r.east
	]) {
		const la = Math.asin(-Math.cos(a) * Math.sin(b)), lo = Math.atan2(Math.sin(a), Math.cos(a) * Math.cos(b));
		const edge = Math.min((lo / DEG - region.west) * Math.cos(la), (region.east - lo / DEG) * Math.cos(la), la / DEG - region.south, region.north - la / DEG);
		if (edge * DEG * MOON_R < 321) return false;
	}
	return true;
}
/** Deepest level with real new information; north polar tiles use a square polar grid. */
export function photoMaxLevel(r) {
	const lat = tileTrueLatRange(r);
	if (lat.maxDeg > NORTH_PHOTO_LAT) return 15;
	return Math.max(PHOTO_FINE_TC_MAX_Z + 1, ...photoRegionsFor(r).map((p) => p.maxZ + 1));
}
/** Add only the detail missing from a coarser photo. The low frequencies and brightness stay
* anchored to WAC, at the same true-frame pixels across ALL tiles and zooms. Per-output-tile
* mean matching would create a checkerboard, and change brightness when the camera moves. */
export function addPhotoDetail(base, sharp, low, gain = .85) {
	if (!sharp || !low) return;
	for (let o = 0; o < base.length; o += 4) {
		const w = Math.min(sharp[o + 3], low[o + 3]) / 255;
		if (w <= 0 || !base[o + 3]) continue;
		const d = gain * w * (sharp[o] - low[o]);
		base[o] += d;
		base[o + 1] += d;
		base[o + 2] += d;
	}
}
/** A continuous exposure match to the fixed WAC reference. Source alpha removes only the
* detail-free black; textured shadows remain. The reference is identical across tiles/zooms. */
export function matchPhotoTone(base, sharp, low, reference) {
	if (!sharp || !low) return;
	for (let o = 0; o < base.length; o += 4) {
		const w = Math.min(sharp[o + 3], low[o + 3]) / 255;
		if (!w || !base[o + 3]) continue;
		const gain = clamp(reference[o] / Math.max(8, low[o]), .25, 4);
		const value = sharp[o] * gain;
		base[o] = base[o + 1] = base[o + 2] = base[o] * (1 - w) + value * w;
	}
}
/** Geographic source footprint clipped to a real mosaic. Keep its outer 80 m out of the
* blend (source resampling can leave a bright border), then feather over 240 metres. */
export function regionFootprint(fp, r, displayLevel, maxZ, region) {
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
export function planPhotoRegion(fp, r, displayLevel, maxZ, region) {
	if (!regionFootprint(fp, r, displayLevel, maxZ, region)) return null;
	const grids = Array.from({ length: trekTop(displayLevel, maxZ) + 1 }, (_, z) => region?.quickmap ? {
		tileW: 512,
		tileH: 512,
		tilesX: 2 ** z,
		width: 512 * 2 ** z,
		height: 256 * 2 ** z,
		global: true
	} : trekGrid(z));
	return {
		level: Math.min(displayLevel, maxZ),
		grids,
		keys: collectTiles(fp, grids, Infinity) ?? []
	};
}
/** Controlled north-pole NAC, using QuickMap's cached polar tiles rather than slow WMS renders. */
export function northFootprint(fp, r, k) {
	if (!polarGeometry(fp, r, polarRho(-NORTH_PHOTO_LAT), 5e3, NORTH_PHOTO_HALF_M, true)) return false;
	const s = PYRAMID_PX * 2 ** k / (2 * NORTH_PHOTO_HALF_M);
	polarCoords(fp, NORTH_PHOTO_HALF_M, s, s);
	return true;
}
export function planNorthPhoto(fp, r, displayLevel) {
	const k = clamp(Math.ceil(Math.log2(2 * NORTH_PHOTO_HALF_M / (PYRAMID_PX * pixelMetres(displayLevel)))), 0, NORTH_PHOTO_MAX_Z);
	if (!northFootprint(fp, r, k)) return null;
	const grids = [pyramidGrid(k)];
	return {
		level: k,
		grids,
		keys: collectTiles(fp, grids, MAX_PYRAMID_TILES) ?? []
	};
}
export function northPhotoUrl(k, i, j) {
	return `https://lroc-tiles.quickmap.io/tiles/lnpole_avg/lunar-sterenp/${k}/${i}/${j}.png?d_val=0,0.5&d_opt=wcolut0`;
}
function northFallbackUrl(k, i, j) {
	const span = 2 * NORTH_PHOTO_HALF_M / 2 ** k, x = -NORTH_PHOTO_HALF_M + i * span, y = NORTH_PHOTO_HALF_M - j * span;
	return `https://wms.im-ldi.com/?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&STYLES=&LAYERS=luna_nac_np_mosaic&SRS=IAU2000:30118&BBOX=${x},${y - span},${x + span},${y}&WIDTH=512&HEIGHT=512&FORMAT=image/jpeg`;
}
/** Histograms of TC Evening at four sites have a spike at 0--2 DN, then textured shadow.
* Feather six SOURCE pixels outside that spike, before projection. Black itself contributes
* nothing; the opposite lighting or WAC supplies real ground underneath. Soft shadows stay.
* The distance transform uses eighth-pixel steps rather than a blur of the photograph. */
export function featherPhotoBlack(src, radius = 6) {
	const { w, h, ch, data } = src, count = w * h, cap = radius * 8;
	const dark = (p) => {
		const o = p * ch;
		return data[o] <= 2 && (ch === 1 || data[o + 1] <= 2 && data[o + 2] <= 2);
	};
	let any = false;
	const distance = new Uint8Array(count);
	distance.fill(cap);
	for (let p = 0; p < count; p++) if (dark(p)) {
		distance[p] = 0;
		any = true;
	}
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
		out[q] = data[o];
		out[q + 1] = data[ch === 1 ? o : o + 1];
		out[q + 2] = data[ch === 1 ? o : o + 2];
		out[q + 3] = (ch === 4 ? data[o + 3] : 255) * smooth(distance[p] / cap);
	}
	return {
		w,
		h,
		ch: 4,
		data: out
	};
}
/** TC's black strips are missing observations, not dark terrain. Its server PNGs do not
* always mark them transparent. Preserve WAC there rather than drawing invented dark joins. */
export function tcNoData(src) {
	const { data, ch, w, h } = src;
	let holes = false;
	for (let o = 0; o < data.length; o += ch) if (data[o] === 0 && (ch === 1 || data[o + 1] === 0 && data[o + 2] === 0)) {
		holes = true;
		break;
	}
	if (!holes) return src;
	const out = new Uint8Array(w * h * 4);
	for (let p = 0; p < w * h; p++) {
		const o = p * ch, q = p * 4, r = data[o], g = ch === 1 ? r : data[o + 1], b = ch === 1 ? r : data[o + 2];
		out[q] = r;
		out[q + 1] = g;
		out[q + 2] = b;
		out[q + 3] = r === 0 && g === 0 && b === 0 ? 0 : ch === 4 ? data[o + 3] : 255;
	}
	return {
		w,
		h,
		ch: 4,
		data: out
	};
}
export function sciencePalette(colours) {
	const out = new Uint8Array(256 * 4);
	for (let i = 0; i < Math.min(256, colours.length); i++) {
		const s = colours[i]?.replace("#", "") ?? "";
		if (!/^[\da-f]{6}([\da-f]{2})?$/i.test(s)) continue;
		out[i * 4] = parseInt(s.slice(0, 2), 16);
		out[i * 4 + 1] = parseInt(s.slice(2, 4), 16);
		out[i * 4 + 2] = parseInt(s.slice(4, 6), 16);
		out[i * 4 + 3] = s.length === 8 ? parseInt(s.slice(6, 8), 16) : 255;
	}
	return out;
}
/** Average colours, never class numbers: class 1 mixed with class 3 must not invent class 2. */
export function buildScienceMips(full, palette) {
	if (!palette || full.ch !== 1) return buildMips(full);
	const colours = new Set();
	for (let i = 0; i < 256; i++) if (palette[i * 4 + 3]) colours.add(`${palette[i * 4]},${palette[i * 4 + 1]},${palette[i * 4 + 2]}`);
	if (colours.size <= 1) {
		// A shadow map varies only in coverage: its small copies can stay one byte too.
		const nearest = new Uint8Array(256);
		for (let a = 0; a < 256; a++) {
			let best = Infinity;
			for (let c = 0; c < 256; c++) {
				const d = Math.abs(a - palette[c * 4 + 3]);
				if (d < best) {
					best = d;
					nearest[a] = c;
				}
			}
		}
		const levels = [full];
		for (let s = full; Math.min(s.w, s.h) > 32;) {
			const w = Math.max(1, s.w >> 1), h = Math.max(1, s.h >> 1), data = new Uint8Array(w * h);
			for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
				let alpha = 0;
				for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) alpha += palette[s.data[Math.min(s.h - 1, y * 2 + dy) * s.w + Math.min(s.w - 1, x * 2 + dx)] * 4 + 3];
				data[y * w + x] = nearest[Math.round(alpha / 4)];
			}
			s = {
				w,
				h,
				ch: 1,
				data
			};
			levels.push(s);
		}
		return { levels };
	}
	const w = Math.max(1, full.w >> 1), h = Math.max(1, full.h >> 1), out = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		let R = 0, G = 0, B = 0, A = 0;
		for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
			const k = full.data[Math.min(full.h - 1, y * 2 + dy) * full.w + Math.min(full.w - 1, x * 2 + dx)] * 4, a = palette[k + 3];
			R += palette[k] * a;
			G += palette[k + 1] * a;
			B += palette[k + 2] * a;
			A += a;
		}
		const o = (y * w + x) * 4;
		if (A) {
			out[o] = Math.round(R / A);
			out[o + 1] = Math.round(G / A);
			out[o + 2] = Math.round(B / A);
		}
		out[o + 3] = Math.round(A / 4);
	}
	return { levels: [full, ...buildMips({
		w,
		h,
		ch: 4,
		data: out
	}).levels] };
}
/** One source picture per mip level. The full source stays indexed; only smaller copies use RGBA. */
export function sampleScience(fp, raster, palette, global, flip) {
	if (!palette || raster.levels[0].ch !== 1) {
		const grids = raster.levels.map((s) => ({
			...singleGrid(s),
			global
		}));
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
				if (global) {
					x = (x % s.w + s.w) % s.w;
					y = clamp(y, 0, s.h - 1);
				} else if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
				const q = indexed ? s.data[y * s.w + x] * 4 : (y * s.w + x) * 4, d = indexed ? palette : s.data;
				const a = d[q + 3] * (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
				R += d[q] * a;
				G += d[q + 1] * a;
				B += d[q + 2] * a;
				A += a;
			}
		}
		if (A <= 1e-6) continue;
		const row = Math.floor(p / TILE), o = ((flip ? row : TILE - 1 - row) * TILE + p % TILE) * 4;
		out[o] = R / A;
		out[o + 1] = G / A;
		out[o + 2] = B / A;
		out[o + 3] = fp.cov[p] * A / k;
		any = true;
	}
	return any ? out : null;
}
/** True lon/lat maps keep a level per pixel near the poles, where one pixel spans many longitudes. */
export function scienceGlobalFootprint(fp, r, level, raster) {
	trekGeometry(fp, r, -90);
	const base = raster.levels[0], baseMip = Math.floor(Math.log2(base.w / (TILE * 2 ** (level + 1))));
	for (let p = 0; p < N2; p++) {
		const m = clamp(baseMip + fp.coarser[p], 0, raster.levels.length - 1), s = raster.levels[m];
		const width = Math.min(s.w, fp.w0[p] * s.w / (TILE * 2 ** (level + 1)));
		const taps = width > TAP_SPACING ? Math.min(MAX_TAPS, Math.ceil(width / TAP_SPACING)) : 1;
		fp.lvl[p] = m;
		fp.taps[p] = taps;
		fp.step[p] = taps > 1 ? width / taps : 0;
		fp.u[p] = (fp.b[p] + Math.PI) * s.w / (2 * Math.PI) - .5;
		fp.v[p] = (Math.PI / 2 - fp.a[p]) * s.h / Math.PI - .5;
	}
}
/** Sharper terrain may clear a coarse warning; evidence maps instead add their own colour. */
export function compositeSciencePixels(out, px, coverage, flip, replace = false) {
	for (let p = 0; p < N2; p++) {
		const row = Math.floor(p / TILE), o = ((flip ? row : TILE - 1 - row) * TILE + p % TILE) * 4;
		if (replace && coverage[p] > .99) {
			out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
		}
		const a = (px?.[o + 3] ?? 0) / 255;
		if (!a || !px) continue;
		const b = out[o + 3] / 255, A = a + b * (1 - a);
		for (let c = 0; c < 3; c++) out[o + c] = (px[o + c] * a + out[o + c] * b * (1 - a)) / A;
		out[o + 3] = A * 255;
	}
}
export const trekGrid = (z) => ({
	tileW: TILE,
	tileH: TILE,
	tilesX: 2 ** (z + 1),
	width: TILE * 2 ** (z + 1),
	height: TILE * 2 ** z,
	global: true
});
export const pyramidGrid = (k) => ({
	tileW: PYRAMID_PX,
	tileH: PYRAMID_PX,
	tilesX: 2 ** k,
	width: PYRAMID_PX * 2 ** k,
	height: PYRAMID_PX * 2 ** k,
	global: false
});
const singleGrid = (s) => ({
	tileW: s.w,
	tileH: s.h,
	tilesX: 1,
	width: s.w,
	height: s.h,
	global: false
});
/**
* A source tile is named by one number: grid * KEY_LEVEL + row * tilesX + column, where grid is
* the index into the plan's `grids` (for Moon Trek that is the Moon Trek level itself).
*/
export const KEY_LEVEL = 2 ** 35;
/** Moon Trek level, column and row of a tile key. */
export function trekTileOf(key) {
	const z = Math.floor(key / KEY_LEVEL), local = key - z * KEY_LEVEL, n = 2 ** (z + 1);
	return {
		z,
		x: local % n,
		y: Math.floor(local / n)
	};
}
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
	a = new Float64Array(N2);
	b = new Float64Array(N2);
	u = new Float64Array(N2);
	v = new Float64Array(N2);
	cov = new Float32Array(N2);
	lvl = new Uint8Array(N2);
	taps = new Uint8Array(N2);
	step = new Float32Array(N2);
	/** Moon Trek: east-west size of the pixel in source pixels at the display level, and how many levels coarser to read. */
	w0 = new Float32Array(N2);
	coarser = new Uint8Array(N2);
	cosLon = new Float64Array(TILE);
	sinLon = new Float64Array(TILE);
}
function columns(fp, r) {
	const dLon = (r.east - r.west) / TILE;
	for (let i = 0; i < TILE; i++) {
		const lon = r.west + (i + .5) * dLon;
		fp.cosLon[i] = Math.cos(lon);
		fp.sinLon[i] = Math.sin(lon);
	}
}
/**
* How many Moon Trek levels coarser than the display level to read where the map is squeezed
* east-west by s = 1/cos(true latitude). Zero for all latitudes below 81.8°; above that one
* level more each time s doubles (84.9°, 87.4°, 88.7°, ...), so neighbouring rings of latitude
* differ by exactly one level.
*/
export function trekCoarsen(s) {
	return s <= SQUEEZE_FULL ? 0 : Math.min(30, Math.ceil(Math.log2(s / SQUEEZE_POLE)));
}
/** Display pixel centres -> true lat/lon. Pixels south of `minTrueLatDeg` are left out (soft over one pixel). Returns false if nothing is covered. */
export function trekGeometry(fp, r, minTrueLatDeg) {
	columns(fp, r);
	const dLat = (r.north - r.south) / TILE, minLat = minTrueLatDeg * DEG, clip = minTrueLatDeg > -90;
	let any = false;
	for (let j = 0; j < TILE; j++) {
		const lat = r.north - (j + .5) * dLat, cl = Math.cos(lat), Z = Math.sin(lat);
		for (let i = 0; i < TILE; i++) {
			const p = j * TILE + i, X = cl * fp.cosLon[i], Y = cl * fp.sinLon[i];
			// display (X, Y, Z) -> true (X, Z, -Y), as in frame.ts
			const tLat = Math.asin(clamp(-Y, -1, 1));
			fp.a[p] = tLat;
			fp.b[p] = Math.atan2(Z, X);
			const c = clip ? clamp01((tLat - minLat) / dLat + .5) : 1;
			fp.cov[p] = c;
			if (c <= 0) continue;
			any = true;
			// True longitude = atan2(Z, X). One step of display lon moves it by sin·cos(lat)·sin(lon)
			// / cos²(true lat) source pixels (at the display level), one step of display lat by
			// cos(lon) / cos²(true lat). The larger of the two is how many source pixels along true
			// east one display pixel spans: more than ~1 and single samples would alias.
			const cos2 = Math.max(X * X + Z * Z, 1e-24);
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
export function trekCoords(fp, displayLevel, top) {
	const kx = [], ky = [], scale = [], width = [];
	for (let z = 0; z <= top; z++) {
		width.push(TILE * 2 ** (z + 1));
		kx.push(TILE * 2 ** (z + 1) / (2 * Math.PI));
		ky.push(TILE * 2 ** z / Math.PI);
		scale.push(2 ** (z - displayLevel));
	}
	const { a, b, u, v, cov, w0, coarser, lvl, taps, step } = fp;
	for (let p = 0; p < N2; p++) {
		if (cov[p] <= 0) continue;
		const z = clamp(displayLevel - coarser[p], 0, top);
		const w = Math.min(w0[p] * scale[z], width[z]);
		const k = w > TAP_SPACING ? Math.min(MAX_TAPS, Math.ceil(w / TAP_SPACING)) : 1;
		lvl[p] = z;
		taps[p] = k;
		step[p] = k > 1 ? w / k : 0;
		u[p] = (b[p] + Math.PI) * kx[z] - .5;
		v[p] = (Math.PI / 2 - a[p]) * ky[z] - .5;
	}
}
/** Moon Trek footprint of a display tile with source levels capped at `maxZ`. Returns false if nothing is covered. */
export function trekFootprint(fp, r, displayLevel, maxZ, minTrueLatDeg) {
	if (!trekGeometry(fp, r, minTrueLatDeg)) return false;
	trekCoords(fp, displayLevel, trekTop(displayLevel, maxZ));
	return true;
}
const trekTop = (displayLevel, maxZ) => clamp(Math.min(displayLevel, maxZ), 0, MAX_TREK_LEVEL);
/**
* Display pixel centres -> south-polar map x/y (m). Inside = closer to the pole than `rhoClip`
* and inside the ±halfM square. With a feather wider than a pixel the edge fades over `featherM`
* metres (photo blending into the photo below); otherwise it is a crisp, anti-aliased line
* (science maps). Returns false if nothing is covered.
*/
export function polarGeometry(fp, r, rhoClip, featherM, halfM, north = false) {
	columns(fp, r);
	fp.lvl.fill(0);
	fp.taps.fill(1);
	const dLat = (r.north - r.south) / TILE, pxM = dLat * MOON_R, soft = featherM > pxM;
	let any = false;
	for (let j = 0; j < TILE; j++) {
		const lat = r.north - (j + .5) * dLat, cl = Math.cos(lat), Z = Math.sin(lat);
		for (let i = 0; i < TILE; i++) {
			const p = j * TILE + i, X = cl * fp.cosLon[i], Y = cl * fp.sinLon[i];
			const den = north ? 1 - Y : 1 + Y;
			let c = 0, mx = 0, my = 0;
			if (den > 1e-9) {
				// same formula as polarMapFromDisplayUnit in frame.ts
				const f = 2 * MOON_R / den;
				mx = f * Z;
				my = (north ? -1 : 1) * f * X;
				const inside = rhoClip - Math.sqrt(mx * mx + my * my);
				c = soft ? smooth(Math.min(inside, halfM - Math.max(Math.abs(mx), Math.abs(my))) / featherM) : clamp01(inside / pxM + .5);
			}
			fp.a[p] = mx;
			fp.b[p] = my;
			fp.cov[p] = c;
			if (c > 0) any = true;
		}
	}
	return any;
}
/** Polar map x/y -> source pixel of a picture spanning ±halfM (row 0 = +y), sx/sy pixels per metre. */
export function polarCoords(fp, halfM, sx, sy) {
	for (let p = 0; p < N2; p++) {
		fp.u[p] = (fp.a[p] + halfM) * sx - .5;
		fp.v[p] = (halfM - fp.b[p]) * sy - .5;
	}
}
const pyramidCoords = (fp, k) => {
	const s = PYRAMID_PX * 2 ** k / PYRAMID_SPAN_M;
	polarCoords(fp, PYRAMID_HALF_M, s, s);
};
/** Source tiles touched by the covered pixels (every sample and its bilinear neighbours), or null if more than `max`. */
export function collectTiles(fp, grids, max) {
	const keys = [], seen = new Set();
	const { u, v, cov, lvl, taps, step } = fp;
	let last = -1;
	const add = (key) => {
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
		const u0 = u[p] - .5 * (k - 1) * s, c0 = Math.floor(u0), c1 = Math.floor(u0 + (k - 1) * s) + 1, r0 = Math.floor(v[p]);
		if (c0 >= 0 && r0 >= 0 && c1 < width && r0 + 1 < height) {
			const ti = c0 / tileW | 0, tj = r0 / tileH | 0;
			if ((c1 / tileW | 0) === ti && ((r0 + 1) / tileH | 0) === tj) {
				if (!add(base + tj * tilesX + ti)) return null;
				continue;
			}
		}
		for (let t = 0; t < k; t++) {
			const ct = Math.floor(u0 + t * s);
			for (let dy = 0; dy < 2; dy++) {
				let r = r0 + dy;
				if (global) r = r < 0 ? 0 : r >= height ? height - 1 : r;
				else if (r < 0 || r >= height) continue;
				const tj = r / tileH | 0;
				for (let dx = 0; dx < 2; dx++) {
					let c = ct + dx;
					if (global) {
						c %= width;
						if (c < 0) c += width;
					} else if (c < 0 || c >= width) continue;
					if (!add(base + tj * tilesX + (c / tileW | 0))) return null;
				}
			}
		}
	}
	return keys;
}
// Running sums for one output pixel (module-level so the hot loop allocates nothing).
let sumR = 0, sumG = 0, sumB = 0, sumW = 0;
function addCorner(s, lc, lr, w) {
	const d = s.data;
	if (s.ch === 1) {
		const g = d[lr * s.w + lc] * w;
		sumR += g;
		sumG += g;
		sumB += g;
		sumW += w;
	} else if (s.ch === 3) {
		const o = (lr * s.w + lc) * 3;
		sumR += d[o] * w;
		sumG += d[o + 1] * w;
		sumB += d[o + 2] * w;
		sumW += w;
	} else {
		const o = (lr * s.w + lc) * 4, wa = w * d[o + 3] / 255;
		sumR += d[o] * wa;
		sumG += d[o + 1] * wa;
		sumB += d[o + 2] * wa;
		sumW += wa;
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
export function sampleTiles(fp, grids, keys, srcs, flipRows, post) {
	const out = new Uint8ClampedArray(N2 * 4);
	const { u, v, cov, lvl, taps, step } = fp;
	const byKey = new Map();
	keys.forEach((k, q) => byKey.set(k, srcs[q]));
	let lastKey = -1, last = null, any = false, clear = false;
	const tileAt = (key) => {
		if (key !== lastKey) {
			lastKey = key;
			last = byKey.get(key) ?? null;
		}
		return last;
	};
	let g = grids[0], base = 0;
	// General case (2x2 neighbourhood crosses a tile edge, the 180° meridian or the picture's edge).
	const corner = (c, r, w) => {
		if (w <= 0) return;
		if (g.global) {
			c %= g.width;
			if (c < 0) c += g.width;
			r = r < 0 ? 0 : r >= g.height ? g.height - 1 : r;
		} else if (c < 0 || r < 0 || c >= g.width || r >= g.height) return;
		const tx = c / g.tileW | 0, ty = r / g.tileH | 0, s = tileAt(base + ty * g.tilesX + tx);
		if (s) addCorner(s, c - tx * g.tileW, r - ty * g.tileH, w);
	};
	// One bilinear sample at source pixel (fu, fv), added to the running sums (weight 1 if all of it has data).
	const tap = (fu, fv) => {
		const c0 = Math.floor(fu), r0 = Math.floor(fv), tx = fu - c0, ty = fv - r0;
		// Quick case: this sample's four neighbours inside one opaque source tile.
		if (c0 >= 0 && r0 >= 0 && c0 + 1 < g.width && r0 + 1 < g.height) {
			const ti = c0 / g.tileW | 0, tj = r0 / g.tileH | 0, lc = c0 - ti * g.tileW, lr = r0 - tj * g.tileH;
			if (lc < g.tileW - 1 && lr < g.tileH - 1) {
				const s = tileAt(base + tj * g.tilesX + ti);
				if (!s) return;
				if (s.ch !== 4) {
					const d = s.data, ch = s.ch, a = (lr * s.w + lc) * ch, b = a + ch, c = a + s.w * ch, e = c + ch;
					const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
					const R = d[a] * w00 + d[b] * w10 + d[c] * w01 + d[e] * w11;
					if (ch === 1) {
						sumR += R;
						sumG += R;
						sumB += R;
					} else {
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
			if (cv <= 0) {
				clear = true;
				continue;
			}
			g = grids[lvl[p]];
			base = lvl[p] * KEY_LEVEL;
			sumR = sumG = sumB = sumW = 0;
			const k = taps[p], fv = v[p], s = k > 1 ? step[p] : 0, u0 = u[p] - .5 * (k - 1) * s;
			const c0 = Math.floor(u0), c1 = Math.floor(u0 + (k - 1) * s) + 1, r0 = Math.floor(fv);
			const ti = c0 / g.tileW | 0, tj = r0 / g.tileH | 0;
			const src = c0 >= 0 && r0 >= 0 && c1 < g.width && r0 + 1 < g.height && (c1 / g.tileW | 0) === ti && ((r0 + 1) / g.tileH | 0) === tj ? tileAt(base + tj * g.tilesX + ti) : undefined;
			if (src === null) {
				clear = true;
				continue;
			}
			if (src && src.ch !== 4) {
				// Fast path (almost every pixel): all samples inside one opaque tile, on the same two source rows.
				const d = src.data, ch = src.ch, ty = fv - r0, ra = ((r0 - tj * g.tileH) * src.w - ti * g.tileW) * ch, rb = ra + src.w * ch;
				for (let t = 0; t < k; t++) {
					const fu = u0 + t * s, c = Math.floor(fu), tx = fu - c, a = ra + c * ch, b = rb + c * ch;
					const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
					const R = d[a] * w00 + d[a + ch] * w10 + d[b] * w01 + d[b + ch] * w11;
					if (ch === 1) {
						sumR += R;
						sumG += R;
						sumB += R;
					} else {
						sumR += R;
						sumG += d[a + 1] * w00 + d[a + 4] * w10 + d[b + 1] * w01 + d[b + 4] * w11;
						sumB += d[a + 2] * w00 + d[a + 5] * w10 + d[b + 2] * w01 + d[b + 5] * w11;
					}
				}
				sumW = k;
			} else {
				for (let t = 0; t < k; t++) tap(u0 + t * s, fv);
			}
			if (sumW <= 1e-6) {
				clear = true;
				continue;
			}
			const o = (row + i) * 4, alpha = 255 * cv * sumW / k;
			if (post) {
				const g = post(p, sumR / sumW);
				out[o] = g;
				out[o + 1] = g;
				out[o + 2] = g;
			} else {
				out[o] = sumR / sumW;
				out[o + 1] = sumG / sumW;
				out[o + 2] = sumB / sumW;
			}
			out[o + 3] = alpha;
			if (alpha < .5) clear = true;
			any = true;
		}
	}
	if (!any) return null;
	if (clear) fillClear(out);
	return out;
}
// Scratch for fillClear: alpha-weighted colour sums of the tile at 128x128, 64x64, ... 1x1.
const fillLevels = [];
for (let s = TILE >> 1; s >= 1; s >>= 1) fillLevels.push(new Float32Array(s * s * 4));
/**
* Give every fully transparent pixel the colour of the data around it (it stays transparent).
* Cesium uploads tiles with straight alpha and builds mipmaps from them, and the GPU's filters
* average colours without looking at alpha: black see-through pixels would darken the edges of
* a layer (and thin out sparse maps when zoomed out). Each clear pixel takes the average colour
* of the smallest square around it (2x2, 4x4, ...) that holds some data.
*/
export function fillClear(px) {
	let prev = null, size = TILE;
	for (const d of fillLevels) {
		const h = size >> 1;
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < h; x++) {
				let r = 0, gg = 0, b = 0, w = 0;
				for (let dy = 0; dy < 2; dy++) {
					for (let dx = 0; dx < 2; dx++) {
						if (prev) {
							const o = ((2 * y + dy) * size + 2 * x + dx) * 4;
							r += prev[o];
							gg += prev[o + 1];
							b += prev[o + 2];
							w += prev[o + 3];
						} else {
							const o = ((2 * y + dy) * TILE + 2 * x + dx) * 4, a = px[o + 3];
							r += px[o] * a;
							gg += px[o + 1] * a;
							b += px[o + 2] * a;
							w += a;
						}
					}
				}
				const q = (y * h + x) * 4;
				d[q] = r;
				d[q + 1] = gg;
				d[q + 2] = b;
				d[q + 3] = w;
			}
		}
		prev = d;
		size = h;
	}
	for (let j = 0; j < TILE; j++) {
		for (let i = 0; i < TILE; i++) {
			const o = (j * TILE + i) * 4;
			if (px[o + 3] !== 0) continue;
			for (let l = 0; l < fillLevels.length; l++) {
				const sh = l + 1, q = ((j >> sh) * (TILE >> sh) + (i >> sh)) * 4, d = fillLevels[l], w = d[q + 3];
				if (w > 0) {
					px[o] = d[q] / w;
					px[o + 1] = d[q + 1] / w;
					px[o + 2] = d[q + 2] / w;
					break;
				}
			}
		}
	}
}
/** Moon Trek: the source level of every pixel (display level, capped at maxZ, coarser near the true north pole) and the tiles to fetch. */
export function planTrek(fp, r, displayLevel, maxZ, minTrueLatDeg) {
	if (!trekFootprint(fp, r, displayLevel, maxZ, minTrueLatDeg)) return null;
	const grids = [];
	for (let z = 0; z <= trekTop(displayLevel, maxZ); z++) grids.push(trekGrid(z));
	const keys = collectTiles(fp, grids, Infinity) ?? [];
	let level = 0;
	for (const k of keys) level = Math.max(level, Math.floor(k / KEY_LEVEL));
	return {
		level,
		grids,
		keys
	};
}
/** South of this the polar photo layers cover everything (as for the Moon Trek photo's minTrueLat): the fix stops there. */
export const FIX_MIN_TRUE_LAT = -81.5;
/** Seam fix footprint: Moon Trek geometry with the fix weight as coverage (alpha). False if the fix draws nothing here. */
export function synthFootprint(fp, r, displayLevel, maxZ) {
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
		const z = lvl[p], width = TILE * 2 ** (z + 1), half = .5 * (taps[p] - 1) * step[p], m = z >= 9 ? 5 : z >= 8 ? 3 : 2;
		if (u[p] - half < m) u[p] = Math.min(m + half, width / 2);
		else if (u[p] + half > width - 1 - m) u[p] = Math.max(width - 1 - m - half, width / 2);
	}
	return true;
}
/** Seam fix: the hillshade tiles a tile needs. */
export function planSynth(fp, r, displayLevel, maxZ) {
	if (!synthFootprint(fp, r, displayLevel, maxZ)) return null;
	const grids = [];
	for (let z = 0; z <= trekTop(displayLevel, maxZ); z++) grids.push(trekGrid(z));
	const keys = collectTiles(fp, grids, Infinity) ?? [];
	let level = 0;
	for (const k of keys) level = Math.max(level, Math.floor(k / KEY_LEVEL));
	return {
		level,
		grids,
		keys
	};
}
/**
* Polar pyramid: pyramid level for this display level (never finer than the photos really are
* there; null below `minK`) and the squares to fetch.
*/
export function planPyramid(fp, r, displayLevel, minK) {
	const k0 = Math.min(pyramidLevelFor(displayLevel), pyramidMaxKFor(r));
	if (k0 < minK) return null;
	if (!polarGeometry(fp, r, polarRho(POLAR_LIMIT_DEG), POLAR_FEATHER_M, PYRAMID_HALF_M)) return null;
	for (let k = k0;; k--) {
		pyramidCoords(fp, k);
		const grids = [pyramidGrid(k)], keys = collectTiles(fp, grids, k > minK ? MAX_PYRAMID_TILES : Infinity);
		if (keys) return {
			level: k,
			grids,
			keys
		};
	}
}
/** Recompute a pyramid footprint (after waiting for downloads, when other tiles used the scratch). */
export function pyramidFootprint(fp, r, k) {
	polarGeometry(fp, r, polarRho(POLAR_LIMIT_DEG), POLAR_FEATHER_M, PYRAMID_HALF_M);
	pyramidCoords(fp, k);
}
/** Polar raster: pick the copy whose pixels best match the display pixels and map every pixel onto it. */
export function planRaster(fp, r, raster, halfM, clipTrueLatDeg, featherM) {
	if (!polarGeometry(fp, r, polarRho(clipTrueLatDeg), featherM, halfM)) return null;
	const pxM = (r.north - r.south) / TILE * MOON_R, base = raster.levels[0];
	const m = clamp(Math.floor(Math.log2(pxM / (2 * halfM / base.w))), 0, raster.levels.length - 1);
	const src = raster.levels[m];
	polarCoords(fp, halfM, src.w / (2 * halfM), src.h / (2 * halfM));
	return {
		grids: [singleGrid(src)],
		src
	};
}
/** Half-size copies down to ~32 px, or `count` of them (box filter; colour weighted by alpha so empty areas don't darken edges). */
export function buildMips(full, count = Infinity, poleAware = false) {
	const levels = [full];
	for (let s = full; Math.min(s.w, s.h) > 32 && levels.length <= count;) {
		s = poleAware && s.ch === 1 ? halvePoleAware(s) : halve(s);
		levels.push(s);
	}
	return { levels };
}
/**
* Halve a grey whole-Moon display lon/lat picture so every pixel averages a square patch on the sphere.
* Near the display poles (true 0°N 90°E / 90°W) one row is a tiny circle: a plain 2x2 average there blurs
* along the radius only, and the zoomed-out Moon shows radial streaks. Here each output row averages
* 2/cos(lat) source pixels east-west (wrapping round the Moon). Same rule as halve_pole_aware in base_mosaic.py.
*/
export function halvePoleAware(s) {
	const w = s.w >> 1, h = s.h >> 1, W = s.w, d = s.data, out = new Uint8Array(w * h);
	const sum = new Float64Array(3 * W + 1);
	for (let y = 0; y < h; y++) {
		const ra = 2 * y * W, rb = Math.min(2 * y + 1, s.h - 1) * W;
		for (let t = 0, acc = 0; t < 3 * W; t++) {
			const x = t % W;
			acc += (d[ra + x] + d[rb + x]) * .5;
			sum[t + 1] = acc;
		}
		const lat = (90 - (y + .5) * 180 / h) * DEG, k = Math.min(W, 2 / Math.max(Math.cos(lat), 1e-9));
		const at = (x) => {
			const i = Math.floor(x);
			return sum[i] + (x - i) * (sum[Math.min(i + 1, 3 * W)] - sum[i]);
		};
		for (let x = 0; x < w; x++) {
			const c = W + 2 * x + 1;
			out[y * w + x] = Math.round((at(c + k / 2) - at(c - k / 2)) / k);
		}
	}
	return {
		w,
		h,
		ch: 1,
		data: out
	};
}
/**
* Cut one display tile straight out of a picture that is already drawn in the display frame
* (the local whole-Moon picture): the 256x256 pixels whose top-left corner is (px, py). No
* re-projection, so this costs almost nothing. Null if the tile is not inside the picture.
*/
export function cutTile(src, px, py, flipRows) {
	if (px < 0 || py < 0 || px + TILE > src.w || py + TILE > src.h || src.ch === 4) return null;
	const out = new Uint8ClampedArray(N2 * 4), d = src.data, ch = src.ch;
	for (let j = 0; j < TILE; j++) {
		let o = (flipRows ? j : TILE - 1 - j) * TILE * 4, q = ((py + j) * src.w + px) * ch;
		for (let i = 0; i < TILE; i++, o += 4, q += ch) {
			out[o] = d[q];
			out[o + 1] = ch === 1 ? d[q] : d[q + 1];
			out[o + 2] = ch === 1 ? d[q] : d[q + 2];
			out[o + 3] = 255;
		}
	}
	return out;
}
function halve(s) {
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
				out[o + 3] = A + 2 >> 2;
			} else {
				for (let q = 0; q < ch; q++) out[o + q] = d[p0 + q] + d[p1 + q] + d[p2 + q] + d[p3 + q] + 2 >> 2;
			}
		}
	}
	return {
		w,
		h,
		ch,
		data: out
	};
}
/**
* Stores RGBA pixels (arriving strip by strip) as compactly as they allow: grey if every pixel is
* grey and opaque (the photos: 1 byte per pixel), RGB if opaque, else RGBA.
*/
export class Packer {
	ch = 1;
	data;
	w;
	h;
	constructor(w, h) {
		this.w = w;
		this.h = h;
		this.data = new Uint8Array(w * h);
	}
	/** Add RGBA pixels `px` that start at pixel index `at`. */
	add(px, at) {
		for (let q = 0; q < px.length; q += 4, at++) {
			const R = px[q], G = px[q + 1], B = px[q + 2], A = px[q + 3];
			if (this.ch === 1) {
				if (A === 255 && R === G && G === B) {
					this.data[at] = R;
					continue;
				}
				this.widen(A === 255 ? 3 : 4, at);
			}
			if (this.ch === 3) {
				if (A === 255) {
					const o = at * 3;
					this.data[o] = R;
					this.data[o + 1] = G;
					this.data[o + 2] = B;
					continue;
				}
				this.widen(4, at);
			}
			const o = at * 4, d = this.data;
			d[o] = R;
			d[o + 1] = G;
			d[o + 2] = B;
			d[o + 3] = A;
		}
	}
	/** The first colour or see-through pixel: re-store the `filled` pixels so far with more channels. */
	widen(to, filled) {
		const from = this.ch, old = this.data, nd = new Uint8Array(this.w * this.h * to);
		for (let q = 0; q < filled; q++) {
			const s = q * from, o = q * to;
			nd[o] = old[s];
			nd[o + 1] = old[from === 1 ? s : s + 1];
			nd[o + 2] = old[from === 1 ? s : s + 2];
			if (to === 4) nd[o + 3] = from === 4 ? old[s + 3] : 255;
		}
		this.data = nd;
		this.ch = to;
	}
	result() {
		return {
			w: this.w,
			h: this.h,
			ch: this.ch,
			data: this.data
		};
	}
}
/** After a failed download, wait this long before asking that server for the same picture again (unless it recovers sooner). */
export const RETRY_MS = 2e4;
// ---------------------------------------------------------------------------------------------
// The worker: downloads, decoding, caches and the message loop. Only runs inside a Web Worker.
const NET_LIMIT = 8;
// Browsers open at most 6 connections per server over HTTP/1.1 (which Moon Trek uses); more
// requests would only queue inside the browser while our timeout ticks. All Moon Trek layers
// live on one worker (imagery.ts), so this limit covers all of trek.nasa.gov.
const HOST_LIMIT = 6;
const LOCAL_LIMIT = 16;
const FETCH_TIMEOUT_MS = 2e4;
// A server that failed this many times in a row is treated as down: one download at a time then
// checks whether it is back and the others wait for its answer instead of each running into its
// own 20 s timeout. So a dead server costs one timeout per round of tiles, not one per picture.
const BREAKER_AFTER = 4;
const TILE_CACHE_BYTES = 48 * 2 ** 20;
// Every retained source image shares this worker's one budget, including whole-Moon pictures,
// polar rasters, downloaded squares and masks. The main thread assigns a larger share to the
// raster worker. Pictures still being sampled are temporary job memory, not retained cache.
let decodedBudgetBytes = 64 * 2 ** 20, decodedBytes = 0, decodedEvictions = 0;
let decodesActive = 0, decodesQueued = 0;
const decoded = new Map();
function trimDecoded() {
	while (decodedBytes > decodedBudgetBytes && decoded.size) {
		const [key, entry] = decoded.entries().next().value;
		decoded.delete(key);
		decodedBytes -= entry.bytes;
		decodedEvictions++;
		entry.evict();
	}
}
/** Register AFTER storing an image. Its callback must remove the actual cached reference too. */
export function registerDecoded(key, bytes, evict, kind = "mask") {
	unregisterDecoded(key);
	const size = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
	decoded.set(key, {
		bytes: size,
		kind,
		evict
	});
	decodedBytes += size;
	trimDecoded();
}
/** Mark a cached image as used; false means it has already been evicted. */
export function touchDecoded(key) {
	const entry = decoded.get(key);
	if (!entry) return false;
	decoded.delete(key);
	decoded.set(key, entry);
	return true;
}
/** A caller removed an image itself, for example when replacing a processed mask. */
export function unregisterDecoded(key) {
	const entry = decoded.get(key);
	if (entry) {
		decoded.delete(key);
		decodedBytes -= entry.bytes;
	}
}
function decodedCacheStats() {
	const bytesByKind = {
		tile: 0,
		base: 0,
		raster: 0,
		mask: 0
	}, countByKind = { ...bytesByKind };
	for (const entry of decoded.values()) {
		bytesByKind[entry.kind] += entry.bytes;
		countByKind[entry.kind]++;
	}
	return {
		budgetBytes: decodedBudgetBytes,
		retainedBytes: decodedBytes,
		retainedCount: decoded.size,
		bytesByKind,
		countByKind,
		evictions: decodedEvictions,
		decodesActive,
		decodesQueued,
		canvasBytes: decodeCanvas ? decodeCanvas.width * decodeCanvas.height * 4 : 0
	};
}
function rasterBytes(raster) {
	const buffers = new Set();
	let bytes = 0;
	for (const src of raster.levels) if (!buffers.has(src.data.buffer)) {
		buffers.add(src.data.buffer);
		bytes += src.data.buffer.byteLength;
	}
	return bytes;
}
const NOTHING = {
	px: null,
	gaps: false
};
/** A download failed: draw nothing new, keep showing the parent tile (it is sharper than a hole), and ask again later. */
const PARENT_FOR_NOW = {
	px: null,
	gaps: true,
	parent: true
};
/** Downloads so far: [files stored with the app, remote, failed]. Reported with every answer (for tests and the loading screen). */
const net = [
	0,
	0,
	0
];
// Bytes are compressed response bodies (not HTTP headers); debug hook only, no extra requests.
const traffic = {};
/** "https://host:port" of a URL: downloads are limited, and failures remembered, per server. */
const originOf = (url) => {
	const i = url.indexOf("/", url.indexOf("//") + 2);
	return i < 0 ? url : url.slice(0, i);
};
let netActive = 0, localActive = 0;
const hostActive = new Map();
const netWaiting = [];
const localWaiting = [];
// The eight Lunaserv names are one service. More connections do not make its
// expensive WMS maps faster, and can crowd out the south-polar pictures.
const queueHost = (host) => host.endsWith(".im-ldi.com") ? "https://lunaserv.im-ldi.com" : host;
const hostLimit = (host) => host.endsWith(".im-ldi.com") || host.endsWith("quickmap.io") ? 4 : HOST_LIMIT;
/** Missing priorities keep the old FIFO order. A shared tile reads its best current user's score. */
function priorityScore(priority) {
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
			if (best < 0 || next < score) {
				best = q;
				score = next;
			}
		}
		if (best < 0) break;
		const { host, go } = netWaiting.splice(best, 1)[0], busy = hostActive.get(host) ?? 0;
		netActive++;
		hostActive.set(host, busy + 1);
		go();
	}
	while (localWaiting.length && localActive < LOCAL_LIMIT) {
		localActive++;
		localWaiting.shift()();
	}
}
const netAcquire = (host, local, signal, priority) => new Promise((resolve) => {
	if (signal?.aborted) {
		resolve(false);
		return;
	}
	const cleanup = () => signal?.removeEventListener("abort", cancel);
	const go = () => {
		cleanup();
		resolve(true);
	};
	const entry = {
		host,
		go,
		priority
	};
	const cancel = () => {
		const q = local ? localWaiting.indexOf(go) : netWaiting.indexOf(entry);
		if (q < 0) return;
		if (local) localWaiting.splice(q, 1);
		else netWaiting.splice(q, 1);
		cleanup();
		resolve(false);
	};
	signal?.addEventListener("abort", cancel, { once: true });
	if (local) localWaiting.push(go);
	else netWaiting.push(entry);
	pump();
});
function netRelease(host, local) {
	if (local) localActive--;
	else {
		netActive--;
		hostActive.set(host, (hostActive.get(host) ?? 1) - 1);
	}
	pump();
}
/** "nasa.gov" of "https://trek.nasa.gov": Lunaserv spreads its tiles over eight host names of one server. */
const siteOf = (url) => {
	const m = /([^./]+\.[^./:]+)(:\d+)?$/.exec(originOf(url));
	return m ? m[1] : url;
};
const breakers = new Map();
// Network health. A failed download is not tried again for RETRY_MS, unless its server has
// answered since (it recovered) or the main thread says the browser is back online.
const failingHosts = new Set();
const hostBackAt = new Map();
let forgetBefore = 0;
let recovered = false;
/** True while a download that failed at time `at` should not be tried again yet. */
function stillFailing(at, url) {
	return performance.now() - at < RETRY_MS && at > Math.max(forgetBefore, hostBackAt.get(originOf(url)) ?? 0);
}
function answered(host) {
	if (failingHosts.delete(host)) {
		hostBackAt.set(host, performance.now());
		recovered = true;
	}
}
/** The app's own address: files from there are stored with the app (fast, there with no internet). */
const OWN = typeof location !== "undefined" && location.origin ? `${location.origin}/` : null;
/** Download a picture. `local` = a file stored with the app (its own queue, no server-health bookkeeping). */
async function fetchBlob(url, local = OWN !== null && url.startsWith(OWN), signal, priority) {
	signal?.throwIfAborted();
	const host = originOf(url), queue = queueHost(host);
	let br, probed;
	if (!local) {
		const site = siteOf(url);
		br = breakers.get(site);
		if (!br) breakers.set(site, br = {
			fails: 0,
			probe: null
		});
	}
	const down = () => br !== undefined && br.fails >= BREAKER_AFTER;
	for (;;) {
		while (down() && br.probe) {
			const back = await br.probe;
			signal?.throwIfAborted();
			if (!back) {
				net[2]++;
				return null;
			}
		}
		if (down()) br.probe = new Promise((res) => {
			probed = res;
		});
		if (!await netAcquire(queue, local, signal, priority)) {
			if (probed) {
				br.probe = null;
				probed(true);
			}
			signal?.throwIfAborted();
		}
		if (probed || !down()) break;
		netRelease(queue, local);
	}
	const done = (ok) => {
		if (br) {
			br.fails = ok ? 0 : br.fails + 1;
			if (probed) {
				br.probe = null;
				probed(ok);
			}
		}
	};
	net[local ? 0 : 1]++;
	const tally = traffic[local ? "local" : siteOf(url)] ??= {
		requests: 0,
		bytes: 0
	};
	tally.requests++;
	const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
	const cancel = () => ctl.abort();
	signal?.addEventListener("abort", cancel, { once: true });
	if (signal?.aborted) ctl.abort();
	try {
		const r = await fetch(url, {
			mode: "cors",
			credentials: "omit",
			signal: ctl.signal
		});
		if (r.status === 404) {
			answered(host);
			done(true);
			return "missing";
		}
		if (r.ok) {
			const blob = await r.blob();
			tally.bytes += blob.size || 0;
			signal?.throwIfAborted();
			answered(host);
			done(true);
			return blob;
		}
	} catch {} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
		netRelease(queue, local);
	}
	if (signal?.aborted) {
		// Moving the map says nothing about server health. A cancelled probe simply
		// lets another real request check the server, without changing its history.
		if (probed) {
			br.probe = null;
			probed(true);
		}
		signal.throwIfAborted();
	}
	net[2]++;
	if (!local) failingHosts.add(host);
	done(false);
	return null;
}
let decodeCanvas, decodeContext;
function canvas2d(w, h) {
	if (!decodeCanvas) {
		decodeCanvas = new OffscreenCanvas(w, h);
		const context = decodeCanvas.getContext("2d", { willReadFrequently: true });
		if (!context) throw new Error("No 2D canvas in this worker");
		decodeContext = context;
	}
	if (decodeCanvas.width !== w) decodeCanvas.width = w;
	if (decodeCanvas.height !== h) decodeCanvas.height = h;
	return decodeContext;
}
/** Decode a picture into the most compact form (grey/RGB/RGBA), reading big pictures in strips to keep memory low. */
async function decode(blob) {
	decodesActive++;
	let bmp;
	try {
		bmp = await createImageBitmap(blob, {
			premultiplyAlpha: "none",
			colorSpaceConversion: "none"
		});
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
		if (decodeCanvas) {
			decodeCanvas.width = 1;
			decodeCanvas.height = 1;
		}
		decodesActive--;
	}
}
let rasterDecodeTail = Promise.resolve();
/** Only one large photo is decoded and mipmapped at a time; small source tiles keep streaming. */
async function decodeRaster(blob, mips = Infinity, poleAware = false) {
	const before = rasterDecodeTail;
	let release;
	rasterDecodeTail = new Promise((resolve) => {
		release = resolve;
	});
	decodesQueued++;
	await before;
	decodesQueued--;
	try {
		return buildMips(await decode(blob), mips, poleAware);
	} finally {
		release();
	}
}
/** Least-recently-used memory of decoded source tiles, with shared downloads. */
class TileCache {
	items = new Map();
	loading = new Map();
	failed = new Map();
	budget;
	bytes = 0;
	constructor(budget) {
		this.budget = budget;
	}
	recent(key) {
		const t = this.items.get(key);
		if (t !== undefined) {
			this.items.delete(key);
			this.items.set(key, t);
			if (t !== "missing") touchDecoded(`tile:${key}`);
			return t;
		}
		const f = this.failed.get(key);
		if (f && stillFailing(f.at, f.url)) return null;
		return undefined;
	}
	/** All tiles if they are already known (no waiting), else null. */
	peekAll(keys) {
		const out = [];
		for (const k of keys) {
			const t = this.recent(k);
			if (t === undefined) return null;
			out.push(t);
		}
		return out;
	}
	/**
	* The tile, from memory or downloaded once. With `localUrl` the copy stored with the app is read
	* first and `url` (the remote server) is only asked if that copy is missing or unreadable.
	*/
	get(key, url, localUrl, signal, priority) {
		if (signal?.aborted) return Promise.reject(signal.reason);
		const t = this.recent(key);
		if (t !== undefined) return Promise.resolve(t);
		let e = this.loading.get(key);
		if (!e) {
			const controller = new AbortController();
			const entry = {
				promise: Promise.resolve(null),
				controller,
				users: new Map()
			};
			// A source square can serve several display tiles. Follow whichever still needs it most,
			// including when a camera move changes their scores or its nearest user is cancelled.
			const sharedPriority = () => {
				let best = Infinity;
				for (const userPriority of entry.users.values()) best = Math.min(best, priorityScore(userPriority));
				return best;
			};
			entry.promise = (async () => {
				try {
					let got = localUrl ? await this.load(localUrl, true, controller.signal, sharedPriority) : null;
					if (!localUrl || got === null || got === "missing") got = await this.load(url, false, controller.signal, sharedPriority);
					controller.signal.throwIfAborted();
					if (got === null) this.fail(key, url);
					else {
						this.failed.delete(key);
						this.put(key, got);
					}
					return got;
				} catch (error) {
					if (controller.signal.aborted) return null;
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
				signal?.removeEventListener("abort", cancel);
				entry.users.delete(user);
			};
			const cancel = () => {
				leave();
				if (!entry.users.size) {
					entry.controller.abort();
					if (this.loading.get(key) === entry) this.loading.delete(key);
				}
				reject(signal?.reason ?? new DOMException("Tile left the view", "AbortError"));
			};
			signal?.addEventListener("abort", cancel, { once: true });
			entry.promise.then((got) => {
				leave();
				resolve(got);
			}, (error) => {
				leave();
				reject(error);
			});
		});
	}
	async load(url, local, signal, priority) {
		const blob = await fetchBlob(url, local, signal, priority);
		if (blob === "missing" || blob === null) return blob;
		signal?.throwIfAborted();
		return decode(blob).then((s) => url.includes(`/${PHOTO_TC}/`) ? tcNoData(s) : s).catch(() => null);
	}
	fail(key, url) {
		this.failed.set(key, {
			at: performance.now(),
			url
		});
		if (this.failed.size > 4096) {
			for (const [k, f] of this.failed) if (!stillFailing(f.at, f.url)) this.failed.delete(k);
		}
		while (this.failed.size > 4096) this.failed.delete(this.failed.keys().next().value);
	}
	put(key, t) {
		const previous = this.items.get(key);
		if (previous !== undefined) this.bytes -= previous === "missing" ? 64 : previous.data.buffer.byteLength;
		this.items.set(key, t);
		this.bytes += t === "missing" ? 64 : t.data.buffer.byteLength;
		if (t !== "missing") registerDecoded(`tile:${key}`, t.data.buffer.byteLength, () => {
			if (this.items.get(key) === t) {
				this.items.delete(key);
				this.bytes -= t.data.buffer.byteLength;
			}
		}, "tile");
		else unregisterDecoded(`tile:${key}`);
		for (const [k, old] of this.items) {
			if (this.bytes <= this.budget && this.items.size <= 2048) break;
			this.items.delete(k);
			this.bytes -= old === "missing" ? 64 : old.data.buffer.byteLength;
			if (old !== "missing") unregisterDecoded(`tile:${k}`);
		}
	}
}
function startWorker() {
	const fp = new Footprint();
	const tiles = new TileCache(TILE_CACHE_BYTES);
	const jobs = new Map();
	let photoView;
	function photoPriority(job) {
		if (!photoView) return 0;
		const r = job.rect, lon = (r.west + r.east) / 2, lat = (r.south + r.north) / 2;
		const dx = Math.atan2(Math.sin(lon - photoView.lon), Math.cos(lon - photoView.lon)) * Math.cos(photoView.lat);
		const scale = Math.PI / 2 ** Math.min(17, photoView.level);
		return (dx * dx + (lat - photoView.lat) ** 2) / (scale * scale) + Math.max(0, photoView.level - job.level) * .1;
	}
	const depths = new Map();
	const rasters = new Map();
	const scienceRasters = new Map();
 self.__baselineScienceStats = () => [...scienceRasters.entries()].map(([url,e])=>({url,bytes:e.raster?.levels.reduce((n,s)=>n+s.data.byteLength,0)??0,failed:!!e.failedAt}));
	const sciencePalettes = new Map();
	const basePictures = new Map();
	/** The pyramid squares stored with the app (told once by the main thread), and their folder. */
	let stored = null;
	/**
	* Deepest level the Moon Trek server really has for a layer (read once from its WMTS
	* description), Infinity if it has no description, or null while that is not known (offline).
	*/
	function trekDepth(layer) {
		let e = depths.get(layer);
		if (!e) depths.set(layer, e = {
			depth: null,
			failedAt: 0,
			pending: null
		});
		const url = trekCapabilitiesUrl(layer);
		if (e.depth !== null || e.pending || e.failedAt && stillFailing(e.failedAt, url)) return e.pending ?? Promise.resolve(e.depth);
		const entry = e;
		entry.pending = (async () => {
			const blob = await fetchBlob(url);
			const xml = blob && blob !== "missing" ? await blob.text().catch(() => null) : null;
			const depth = blob === "missing" ? Infinity : xml === null ? null : parseTrekDepth(xml) ?? Infinity;
			entry.pending = null;
			if (depth === null) entry.failedAt = performance.now();
			else entry.depth = depth;
			return depth;
		})();
		return entry.pending;
	}
	async function runTrek(job, flip) {
		// Never ask for levels the server does not have (e.g. the LOLA colour map stops at level 6):
		// in a browser those would fail like a network error and leave the layer transparent.
		const depth = await trekDepth(job.layer);
		const maxZ = Math.min(job.maxSourceLevel, depth ?? Infinity);
		const plan = planTrek(fp, job.rect, job.level, maxZ, job.minTrueLat);
		if (!plan) return NOTHING;
		const keyOf = (k) => `${job.layer}/${k}`;
		let got = tiles.peekAll(plan.keys.map(keyOf));
		if (!got) {
			got = await Promise.all(plan.keys.map((k) => {
				const t = trekTileOf(k);
				return tiles.get(keyOf(k), trekUrl(job.layer, job.ext, t.z, t.x, t.y));
			}));
			if (got.includes(null)) return PARENT_FOR_NOW;
			trekFootprint(fp, job.rect, job.level, maxZ, job.minTrueLat);
		}
		if (got.includes(null)) return PARENT_FOR_NOW;
		return {
			px: sampleTiles(fp, plan.grids, plan.keys, got.map((t) => t === "missing" ? null : t), flip),
			gaps: false
		};
	}
	/** Downloads are shared across photo and seam-fix jobs. Abort only after the last tile using
	* a source square has scrolled away. Low and high use the SAME grid and clip at every zoom. */
	const photoMasks = new Map();
	const photoMaskIds = new WeakMap();
	let maskId = 0;
	function maskedPhoto(src) {
		const id = photoMaskIds.get(src), hit = id === undefined ? undefined : photoMasks.get(id);
		if (hit && touchDecoded(hit.key)) return hit.src;
		const softened = featherPhotoBlack(src);
		if (softened !== src) {
			const next = ++maskId, key = `mask/${next}`;
			photoMaskIds.set(src, next);
			photoMasks.set(next, {
				key,
				src: softened
			});
			registerDecoded(key, softened.data.byteLength, () => photoMasks.delete(next), "mask");
		}
		return softened;
	}
	async function photoPixels(job, layer, maxZ, flip, signal, region, soften = false) {
		const plan = planPhotoRegion(fp, job.rect, job.level, maxZ, region);
		if (!plan || !plan.keys.length) return {
			px: null,
			failed: false,
			needsFill: false
		};
		const got = await Promise.all(plan.keys.map((key) => {
			const t = trekTileOf(key);
			let url = trekUrl(layer, "png", t.z, t.x, t.y);
			if (region?.quickmap) {
				const z = Math.floor(key / KEY_LEVEL), q = key - z * KEY_LEVEL, n = 2 ** z;
				const suffix = region.global ? ".png?d_val=0,5000&d_opt=wcolut0" : ".jpg";
				url = `https://lroc-tiles.quickmap.io/tiles/${layer}/lunar-fulleqc/${z}/${q % n}/${Math.floor(q / n)}${suffix}`;
			}
			return tiles.get(`${layer}/${region?.quickmap ? "qm/" : ""}${key}`, url, undefined, signal, () => photoPriority(job));
		}));
		signal.throwIfAborted();
		if (got.includes(null)) return {
			px: null,
			failed: true,
			needsFill: false
		};
		regionFootprint(fp, job.rect, job.level, maxZ, region);
		const px = sampleTiles(fp, plan.grids, plan.keys, got.map((t) => !t || t === "missing" ? null : soften ? maskedPhoto(t) : t), flip);
		let dark = 0;
		if (soften && px) for (let p = 0; p < N2; p++) {
			const row = Math.floor(p / TILE), col = p % TILE, o = ((flip ? row : TILE - 1 - row) * TILE + col) * 4 + 3;
			if (fp.cov[p] > .9 && px[o] < 128) dark++;
		}
		return {
			px,
			failed: false,
			needsFill: soften && (!px || dark > N2 * .005)
		};
	}
	async function runNorthPhoto(job, flip, signal) {
		const northTile = async (k, q, n) => {
			const i = q % n, j = Math.floor(q / n), priority = () => photoPriority(job);
			const cached = await tiles.get(`north/${k}/${q}`, northPhotoUrl(k, i, j), undefined, signal, priority);
			if (cached && cached !== "missing") return cached;
			// WMS is much slower and its uncontrolled mosaic begins at 85.5 N. Ask only after
			// the cached controlled tile fails; its empty outer pixels retain the broad photo.
			return tiles.get(`north-wms/${k}/${q}`, northFallbackUrl(k, i, j), undefined, signal, priority);
		};
		let base;
		if (job.northBase) {
			const { cut, rect } = job.northBase, raster = await basePicture(cut).promise, src = raster?.levels[cut.mip];
			if (src) {
				fp.cov.fill(1);
				fp.lvl.fill(0);
				fp.taps.fill(1);
				for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) {
					const p = j * TILE + i;
					fp.u[p] = cut.px + TILE * (job.rect.west + (i + .5) * (job.rect.east - job.rect.west) / TILE - rect.west) / (rect.east - rect.west) - .5;
					fp.v[p] = cut.py + TILE * (rect.north - job.rect.north + (j + .5) * (job.rect.north - job.rect.south) / TILE) / (rect.north - rect.south) - .5;
				}
				base = {
					px: sampleTiles(fp, [singleGrid(src)], [0], [src], flip),
					gaps: false
				};
			}
		}
		base ??= job.fix ? await runSynth({
			kind: "synth",
			rect: job.rect,
			level: job.level,
			fix: job.fix
		}, flip) : await runTrek({
			kind: "trek",
			rect: job.rect,
			level: job.level,
			layer: job.layer,
			ext: "jpg",
			maxSourceLevel: 8,
			minTrueLat: job.minTrueLat
		}, flip);
		signal.throwIfAborted();
		if (!base.px) return base;
		// Keep TC underneath the polar feather. The choice is per true latitude, so a display
		// tile crossing the cap edge has the same picture as its neighbour at every zoom.
		if (tileTrueLatRange(job.rect).minDeg < NORTH_PHOTO_LAT + .2) {
			const [sharp, low] = await Promise.all([photoPixels(job, PHOTO_FINE_TC.layer, PHOTO_FINE_TC_MAX_Z, flip, signal, PHOTO_FINE_TC, true), photoPixels(job, PHOTO_FINE_TC.layer, 8, flip, signal, PHOTO_FINE_TC)]);
			if (sharp.failed || low.failed) return PARENT_FOR_NOW;
			trekGeometry(fp, job.rect, job.minTrueLat);
			if (sharp.px && low.px) for (let p = 0; p < N2; p++) {
				const row = Math.floor(p / TILE), col = p % TILE, o = ((flip ? row : TILE - 1 - row) * TILE + col) * 4 + 3;
				const weight = 1 - smooth((fp.a[p] / DEG - NORTH_PHOTO_LAT) / .2);
				sharp.px[o] *= weight;
				low.px[o] *= weight;
			}
			matchPhotoTone(base.px, sharp.px, low.px, base.px);
		}
		const plan = planNorthPhoto(fp, job.rect, job.level);
		if (!plan || !plan.keys.length) return base;
		const k = plan.level, n = plan.grids[0].tilesX;
		const got = await Promise.all(plan.keys.map((q) => northTile(k, q, n)));
		signal.throwIfAborted();
		if (got.includes(null)) return PARENT_FOR_NOW;
		northFootprint(fp, job.rect, k);
		const px = sampleTiles(fp, plan.grids, plan.keys, got.map((t) => !t || t === "missing" ? null : maskedPhoto(t)), flip);
		const lowK = 4, lowN = 2 ** lowK;
		northFootprint(fp, job.rect, lowK);
		const grids = [pyramidGrid(lowK)], keys = collectTiles(fp, grids, Infinity) ?? [];
		const low = await Promise.all(keys.map((q) => northTile(lowK, q, lowN)));
		signal.throwIfAborted();
		if (low.includes(null)) return PARENT_FOR_NOW;
		northFootprint(fp, job.rect, lowK);
		const blurred = sampleTiles(fp, grids, keys, low.map((t) => t === "missing" ? null : t), flip);
		addPhotoDetail(base.px, px, blurred, .9);
		return base;
	}
	async function runPhoto(job, flip, signal) {
		if (tileTrueLatRange(job.rect).maxDeg > NORTH_PHOTO_LAT) return runNorthPhoto(job, flip, signal);
		const regions = photoRegionsFor(job.rect), primary = regions.find((r) => photoRegionCovers(job.rect, r));
		// The reference and the final picture travel together. A full NAC tile needs no TC
		// downloads underneath it, and neither waits for the broad reference to start loading.
		const basePromise = job.fix ? runSynth({
			kind: "synth",
			rect: job.rect,
			level: job.level,
			fix: job.fix
		}, flip) : runTrek({
			kind: "trek",
			rect: job.rect,
			level: job.level,
			layer: job.layer,
			ext: "jpg",
			maxSourceLevel: 8,
			minTrueLat: job.minTrueLat
		}, flip);
		const source = primary ?? PHOTO_FINE_TC;
		let [base, sharp, low] = await Promise.all([
			basePromise,
			photoPixels(job, source.layer, source.maxZ, flip, signal, source, true),
			photoPixels(job, source.layer, 8, flip, signal, source)
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
				[sharp, low] = await Promise.all([photoPixels(job, PHOTO_TC, PHOTO_TC_MAX_Z, flip, signal, undefined, true), photoPixels(job, PHOTO_TC, 8, flip, signal)]);
				if (sharp.failed || low.failed) return PARENT_FOR_NOW;
				addPhotoDetail(base.px, sharp.px, low.px);
			} else {
				// Only an on-screen Evening tile with a sizeable black area asks for Morning.
				// Both may have shadows; where neither sees ground the original WAC stays visible.
				if (sharp.needsFill) {
					const [morning, morningLow] = await Promise.all([photoPixels(job, PHOTO_MORNING_TC.layer, PHOTO_FINE_TC_MAX_Z, flip, signal, PHOTO_MORNING_TC, true), photoPixels(job, PHOTO_MORNING_TC.layer, 8, flip, signal, PHOTO_MORNING_TC)]);
					if (!morning.failed && !morningLow.failed) matchPhotoTone(base.px, morning.px, morningLow.px, reference);
				}
				matchPhotoTone(base.px, sharp.px, low.px, reference);
			}
		}
		for (const region of regions) {
			if (region === primary) continue;
			const [detail, blurred] = await Promise.all([photoPixels(job, region.layer, region.maxZ, flip, signal, region, true), photoPixels(job, region.layer, 8, flip, signal, region)]);
			if (detail.failed || blurred.failed) return PARENT_FOR_NOW;
			matchPhotoTone(base.px, detail.px, blurred.px, reference);
		}
		return {
			px: base.px,
			gaps: upgradeGap
		};
	}
	/** Seam fix tile: Moon Trek hillshade tiles x the local brightness-matched albedo, see-through where the photo shows. */
	async function runSynth(job, flip) {
		const { fix } = job, shade = fixShadeFor(fix, job.rect);
		const plan = planSynth(fp, job.rect, job.level, shade.maxZ);
		if (!plan) return NOTHING;
		const keyOf = (k) => `${shade.layer}/${k}`;
		let got = tiles.peekAll(plan.keys.map(keyOf));
		if (!got) {
			got = await Promise.all(plan.keys.map((k) => {
				const t = trekTileOf(k);
				return tiles.get(keyOf(k), trekUrl(shade.layer, "png", t.z, t.x, t.y));
			}));
			if (got.includes(null)) return PARENT_FOR_NOW;
		}
		if (got.includes(null)) return PARENT_FOR_NOW;
		// Do not hold a large local image while a remote hillshade request waits.
		const albedo = await rasterFor(fix.albedo.url);
		if (!albedo) return {
			px: null,
			gaps: true
		};
		synthFootprint(fp, job.rect, job.level, shade.maxZ);
		const a = albedo.levels[0], { west, east, north, south, scale } = fix.albedo, { C, S0 } = fix;
		const post = (p, s) => sampleLonLat(a, west, east, north, south, fp.a[p], fp.b[p]) * scale * Math.exp(C * (s / S0 - 1));
		return {
			px: sampleTiles(fp, plan.grids, plan.keys, got.map((t) => t === "missing" ? null : t), flip, post),
			gaps: false
		};
	}
	async function runPyramid(job, flip) {
		const plan = planPyramid(fp, job.rect, job.level, job.minK);
		if (!plan) return NOTHING;
		const k = plan.level, n = plan.grids[0].tilesX;
		const keyOf = (q) => `${job.layers}/${k}/${q}`;
		let got = tiles.peekAll(plan.keys.map(keyOf));
		if (!got) {
			// Local first: squares stored with the app are read from disk; the remote server is only asked for the rest.
			const base = job.local, index = base && stored && stored.base === base && stored.index?.layers === job.layers ? stored.index : null;
			got = await Promise.all(plan.keys.map((q) => {
				const i = q % n, j = Math.floor(q / n);
				return tiles.get(keyOf(q), pyramidUrl(job.layers, k, i, j), base && pyramidHasLocal(index, k, i, j) ? pyramidLocalUrl(base, k, i, j) : undefined);
			}));
			if (got.includes(null)) return PARENT_FOR_NOW;
			pyramidFootprint(fp, job.rect, k);
		}
		if (got.includes(null)) return PARENT_FOR_NOW;
		return {
			px: sampleTiles(fp, plan.grids, plan.keys, got.map((t) => t === "missing" ? null : t), flip),
			gaps: false
		};
	}
	/** A local picture uses the same bounded LRU as the remote squares and science maps. */
	function basePicture(c) {
		let e = basePictures.get(c.url);
		if (e && e.failedAt && !stillFailing(e.failedAt, c.url)) {
			basePictures.delete(c.url);
			e = undefined;
		}
		if (!e) {
			const entry = {
				pending: null,
				raster: null,
				failedAt: 0,
				get promise() {
					return this.pending ?? Promise.resolve(this.raster);
				}
			};
			entry.pending = (async () => {
				const blob = await fetchBlob(c.url, true);
				const raster = blob && blob !== "missing" ? await decodeRaster(blob, c.mips, !!c.poleAware).catch(() => null) : null;
				if (raster) {
					entry.raster = raster;
					registerDecoded(`base:${c.url}`, rasterBytes(raster), () => {
						entry.raster = null;
						if (basePictures.get(c.url) === entry) basePictures.delete(c.url);
					}, "base");
				} else {
					entry.failedAt = performance.now();
					console.warn("Local Moon picture not available:", c.url);
				}
				return raster;
			})().finally(() => {
				entry.pending = null;
			});
			basePictures.set(c.url, e = entry);
		}
		if (e.raster) touchDecoded(`base:${c.url}`);
		return e;
	}
	async function runBase(job, flip) {
		const big = basePicture(job.cut);
		let cut = job.cut, raster = big.raster;
		if (!raster && job.quick) {
			const small = await basePicture(job.quick).promise;
			if (small && !big.raster) {
				cut = job.quick;
				raster = small;
			}
		}
		raster ??= await big.promise;
		const src = raster?.levels[cut.mip];
		if (!src) return {
			px: null,
			gaps: true
		};
		return {
			px: cutTile(src, cut.px, cut.py, flip),
			gaps: false
		};
	}
	function rasterFor(url) {
		let e = rasters.get(url);
		if (e && e.failedAt && !stillFailing(e.failedAt, url)) {
			rasters.delete(url);
			e = undefined;
		}
		if (!e) {
			const entry = {
				pending: null,
				raster: null,
				failedAt: 0,
				get promise() {
					return this.pending ?? Promise.resolve(this.raster);
				}
			};
			entry.pending = (async () => {
				const blob = await fetchBlob(url);
				const raster = blob && blob !== "missing" ? await decodeRaster(blob).catch(() => null) : null;
				if (!raster) {
					entry.failedAt = performance.now();
					console.warn("Polar map not available:", url);
					return null;
				}
				entry.raster = raster;
				registerDecoded(`raster:${url}`, rasterBytes(raster), () => {
					entry.raster = null;
					if (rasters.get(url) === entry) rasters.delete(url);
				}, "raster");
				return raster;
			})().finally(() => {
				entry.pending = null;
			});
			rasters.set(url, e = entry);
		}
		if (e.raster) touchDecoded(`raster:${url}`);
		return e.promise;
	}
	async function runRaster(job, flip) {
		const raster = await rasterFor(job.url);
		if (!raster) return {
			px: null,
			gaps: true
		};
		const plan = planRaster(fp, job.rect, raster, job.extentM, job.clipTrueLat, job.featherM);
		return {
			px: plan ? sampleTiles(fp, plan.grids, [0], [plan.src], flip) : null,
			gaps: false
		};
	}
	function scienceRasterFor(source) {
		const url = source.url;
		let e = scienceRasters.get(url);
		if (source.palette && !sciencePalettes.has(url)) {
			sciencePalettes.set(url, sciencePalette(source.palette));
			// A panel value may ask for this byte grid before the start screen prepares its colours.
			// Reuse that same sharp grid when upgrading it to a rendered map.
			if (e?.raster) {
				unregisterDecoded(`science:${url}`);
				scienceRasters.delete(url);
				e = undefined;
			}
		}
		if (e && e.failedAt && !stillFailing(e.failedAt, url)) {
			scienceRasters.delete(url);
			e = undefined;
		}
		if (!e) {
			const entry = {
				pending: null,
				raster: null,
				failedAt: 0,
				get promise() {
					return this.pending ?? Promise.resolve(this.raster);
				}
			};
			entry.pending = (async () => {
				const blob = await fetchBlob(url);
				if (!blob || blob === "missing") {
					entry.failedAt = performance.now();
					return null;
				}
				// Large maps decode one at a time, beside the photo workers rather than on the UI thread.
				const before = rasterDecodeTail;
				let release;
				rasterDecodeTail = new Promise((resolve) => {
					release = resolve;
				});
				decodesQueued++;
				await before;
				decodesQueued--;
				let raster = null;
				try {
					const full = await decode(blob), palette = sciencePalettes.get(url);
					raster = palette ? buildScienceMips(full, palette) : { levels: [full] };
					// Ordinary coloured legacy south-pole pictures still need colour mips.
					if (!palette && full.ch !== 1) raster = buildMips(full);
				} catch {
					entry.failedAt = performance.now();
				} finally {
					release();
				}
				if (!raster) return null;
				entry.raster = raster;
				registerDecoded(`science:${url}`, rasterBytes(raster), () => {
					entry.raster = null;
					if (scienceRasters.get(url) === entry) scienceRasters.delete(url);
				}, "raster");
				return raster;
			})().finally(() => {
				entry.pending = null;
			});
			scienceRasters.set(url, e = entry);
		}
		if (e.raster) touchDecoded(`science:${url}`);
		return e.promise;
	}
	async function runScience(job, flip) {
		let out = null, gaps = false;
		for (const source of job.sources) {
			const range = tileTrueLatRange(job.rect), north = source.pole === "north", clip = source.clipTrueLatDeg ?? (north ? 80 : -80);
			if (source.projection === "polar" && (north ? range.maxDeg <= clip - pixelDeg(job.level) : range.minDeg >= clip + pixelDeg(job.level))) continue;
			const raster = await scienceRasterFor(source);
			if (!raster) {
				gaps = true;
				continue;
			}
			if (source.projection === "global") scienceGlobalFootprint(fp, job.rect, job.level, raster);
			else {
				const halfM = source.extentM ?? 304e3;
				if (!polarGeometry(fp, job.rect, polarRho(-Math.abs(clip)), 0, halfM, north)) continue;
				const base = raster.levels[0], pxM = (job.rect.north - job.rect.south) / TILE * MOON_R;
				const m = clamp(Math.floor(Math.log2(pxM / (2 * halfM / base.w))), 0, raster.levels.length - 1), s = raster.levels[m];
				fp.lvl.fill(m);
				polarCoords(fp, halfM, s.w / (2 * halfM), s.h / (2 * halfM));
			}
			if (source.maximumTrueLatDeg !== undefined) {
				// Wide polar products can stop where a sharper inner cap takes over.
				const den = 2 * MOON_R, limit = source.maximumTrueLatDeg;
				if (source.projection === "polar") for (let p = 0; p < N2; p++) {
					const absoluteLat = 90 - 2 * Math.atan(Math.hypot(fp.a[p], fp.b[p]) / den) / DEG;
					if (absoluteLat > limit) fp.cov[p] = 0;
				}
			}
			const px = sampleScience(fp, raster, sciencePalettes.get(source.url), source.projection === "global", flip);
			if (!px && !source.replace) continue;
			out ??= new Uint8ClampedArray(N2 * 4);
			compositeSciencePixels(out, px, fp.cov, flip, source.replace);
		}
		if (out) fillClear(out);
		return {
			px: out,
			gaps
		};
	}
	async function scienceValue(source, lat, lon) {
		const s = (await scienceRasterFor(source))?.levels[0];
		if (!s || s.ch !== 1) return null;
		let col, row;
		if (source.projection === "global") {
			col = Math.floor(((lon + 180) % 360 + 360) % 360 / 360 * s.w);
			row = clamp(Math.floor((90 - lat) / 180 * s.h), 0, s.h - 1);
		} else {
			const north = source.pole === "north", clip = source.clipTrueLatDeg ?? (north ? 80 : -80);
			if (north ? lat < clip : lat > clip) return null;
			if (source.maximumTrueLatDeg !== undefined && Math.abs(lat) > source.maximumTrueLatDeg) return null;
			const rho = 2 * MOON_R * Math.tan((90 - Math.abs(lat)) * DEG / 2), half = source.extentM ?? 304e3;
			const x = rho * Math.sin(lon * DEG), y = (north ? -1 : 1) * rho * Math.cos(lon * DEG);
			col = Math.floor((x + half) / (2 * half) * s.w);
			row = Math.floor((half - y) / (2 * half) * s.h);
			if (col < 0 || row < 0 || col >= s.w || row >= s.h) return null;
		}
		const value = s.data[row * s.w + col];
		return value === 255 ? null : value;
	}
	async function handle({ id, job, flipRows }) {
		const controller = new AbortController();
		jobs.set(id, controller);
		let bitmap = null, gaps = true, parent = false;
		try {
			const d = job.kind === "trek" ? await runTrek(job, flipRows) : job.kind === "pyramid" ? await runPyramid(job, flipRows) : job.kind === "base" ? await runBase(job, flipRows) : job.kind === "synth" ? await runSynth(job, flipRows) : job.kind === "photo" ? await runPhoto(job, flipRows, controller.signal) : job.kind === "science" ? await runScience(job, flipRows) : await runRaster(job, flipRows);
			controller.signal.throwIfAborted();
			gaps = d.gaps;
			parent = !!d.parent;
			if (d.px) bitmap = await createImageBitmap(new ImageData(d.px, TILE, TILE), {
				premultiplyAlpha: "none",
				colorSpaceConversion: "none"
			});
		} catch (err) {
			if (!controller.signal.aborted) console.warn("Imagery tile failed:", err);
		}
		jobs.delete(id);
		if (controller.signal.aborted) {
			bitmap?.close();
			bitmap = null;
			gaps = false;
			parent = true;
		}
		const msg = {
			id,
			bitmap,
			gaps,
			recovered,
			parent,
			net: [
				net[0],
				net[1],
				net[2]
			],
			traffic,
			cache: decodedCacheStats()
		};
		recovered = false;
		self.postMessage(msg, { transfer: bitmap ? [bitmap] : [] });
	}
	self.onmessage = (e) => {
		const m = e.data;
		if ("photoView" in m) {
			photoView = m.photoView;
			return;
		}
		if ("cacheBudgetBytes" in m) {
			if (Number.isFinite(m.cacheBudgetBytes) && m.cacheBudgetBytes >= 2 ** 20) {
				decodedBudgetBytes = m.cacheBudgetBytes;
				trimDecoded();
			}
		} else if ("cancel" in m) jobs.get(m.cancel)?.abort();
		else if ("forgetFailures" in m) {
			forgetBefore = performance.now();
			for (const b of breakers.values()) b.fails = 0;
		} else if ("pyramidIndex" in m) stored = {
			base: m.base,
			index: parsePyramidIndex(m.pyramidIndex)
		};
		else if ("warmRasters" in m) void (async () => {
			for (const u of m.warmRasters) await rasterFor(u).catch(() => null);
		})();
		else if ("warmScience" in m) void (async () => {
			let ok = true, done = 0;
			for (const source of m.warmScience) {
				ok = !!await scienceRasterFor(source).catch(() => null) && ok;
				self.postMessage({
					id: 0,
					bitmap: null,
					gaps: false,
					recovered: false,
					warmed: m.warmId,
					warmFrac: ++done / m.warmScience.length,
					warmOk: ok,
					cache: decodedCacheStats()
				});
			}
			if (!m.warmScience.length) self.postMessage({
				id: 0,
				bitmap: null,
				gaps: false,
				recovered: false,
				warmed: m.warmId,
				warmFrac: 1,
				warmOk: true
			});
		})();
		else if ("scienceValue" in m) void scienceValue(m.scienceValue.source, m.scienceValue.lat, m.scienceValue.lon).then((value) => {
			self.postMessage({
				id: 0,
				bitmap: null,
				gaps: false,
				recovered: false,
				valueId: m.valueId,
				value
			});
		}).catch(() => self.postMessage({
			id: 0,
			bitmap: null,
			gaps: false,
			recovered: false,
			valueId: m.valueId,
			value: null
		}));
		else void handle(m);
	};
}
if (typeof globalThis.WorkerGlobalScope === "function") startWorker();

//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQTJCQSxPQUFPLE1BQU0sT0FBTztBQUNwQixNQUFNLEtBQUssT0FBTztBQUNsQixNQUFNLFNBQVM7QUFDZixNQUFNLE1BQU0sS0FBSyxLQUFLOzs7Ozs7QUFPdEIsT0FBTyxNQUFNLGtCQUFrQixDQUFDOzs7Ozs7QUFNaEMsT0FBTyxNQUFNLGtCQUFrQjs7QUFFL0IsTUFBTSxvQkFBb0I7Ozs7Ozs7QUFRMUIsTUFBTSxjQUFjO0FBQ3BCLE1BQU0sV0FBVztBQUNqQixNQUFNLGVBQWU7QUFDckIsTUFBTSxlQUFlO0FBQ3JCLE1BQU0saUJBQWlCO0FBS3ZCLE1BQU0sU0FBUyxHQUFXLElBQVksT0FBZ0IsSUFBSSxLQUFLLEtBQUssSUFBSSxLQUFLLEtBQUs7QUFDbEYsTUFBTSxXQUFXLE1BQWUsS0FBSyxJQUFJLElBQUksS0FBSyxJQUFJLElBQUk7QUFDMUQsTUFBTSxVQUFVLE1BQWUsS0FBSyxJQUFJLElBQUksS0FBSyxJQUFJLElBQUksSUFBSSxLQUFLLElBQUksSUFBSTs7QUFHMUUsT0FBTyxNQUFNLFlBQVksVUFBa0IsT0FBTyxPQUFPLEtBQUs7QUFFOUQsT0FBTyxNQUFNLGVBQWUsVUFBa0IsU0FBUyxLQUFLLElBQUksTUFBTTs7QUFHdEUsT0FBTyxTQUFTLGlCQUFpQixHQUE2Qzs7O0NBRzVFLE1BQU0sS0FBSyxLQUFLLElBQUksRUFBRSxJQUFJLEdBQUcsS0FBSyxLQUFLLElBQUksRUFBRSxJQUFJO0NBQ2pELElBQUksT0FBTyxLQUFLLElBQUksSUFBSSxFQUFFLEdBQUcsT0FBTyxLQUFLLElBQUksSUFBSSxFQUFFO0NBQ25ELElBQUksRUFBRSxRQUFRLEtBQUssS0FBSyxLQUFLLEVBQUUsUUFBUSxLQUFLLEtBQUssR0FBRyxPQUFPO0NBQzNELElBQUksRUFBRSxRQUFRLENBQUMsS0FBSyxLQUFLLEtBQUssRUFBRSxRQUFRLENBQUMsS0FBSyxLQUFLLEdBQUcsT0FBTyxDQUFDO0NBQzlELE1BQU0sS0FBSyxLQUFLLElBQUksRUFBRSxLQUFLLEdBQUcsS0FBSyxLQUFLLElBQUksRUFBRSxLQUFLO0NBQ25ELE1BQU0sT0FBTyxLQUFLLElBQUksSUFBSSxFQUFFLEdBQUcsT0FBTyxFQUFFLFNBQVMsS0FBSyxFQUFFLFNBQVMsSUFBSSxJQUFJLEtBQUssSUFBSSxJQUFJLEVBQUU7Q0FDeEYsTUFBTSxPQUFPLFFBQVEsSUFBSSxPQUFPLE9BQU8sT0FBTztDQUM5QyxNQUFNLE9BQU8sUUFBUSxJQUFJLE9BQU8sT0FBTyxPQUFPO0NBQzlDLE9BQU87RUFBRSxRQUFRLEtBQUssS0FBSyxNQUFNLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUk7RUFBSyxRQUFRLEtBQUssS0FBSyxNQUFNLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUk7Q0FBSTtBQUN0Rzs7Ozs7Ozs7QUFVQSxPQUFPLE1BQU0sZ0JBQTJDLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRTtBQUNqRSxPQUFPLE1BQU0sZ0JBQTJDLENBQUMsS0FBSyxHQUFHOztBQUdqRSxPQUFPLFNBQVMsYUFBYSxRQUF3QjtDQUNuRCxNQUFNLFFBQVUsU0FBUyxPQUFPLE1BQU8sT0FBTyxNQUFPO0NBQ3JELElBQUksT0FBTyxjQUFjLElBQUksT0FBTztDQUNwQyxJQUFJLE1BQU0sY0FBYyxJQUFJLE9BQU8sSUFBSSxRQUFRLE1BQU0sY0FBYyxPQUFPLGNBQWMsS0FBSyxjQUFjLEdBQUc7Q0FDOUcsSUFBSSxPQUFPLGNBQWMsSUFBSSxPQUFPLE9BQU8sTUFBTSxPQUFPLElBQUksUUFBUSxNQUFNLGNBQWMsT0FBTyxjQUFjLEtBQUssY0FBYyxHQUFHO0NBQ25JLE9BQU87QUFDVDs7Ozs7O0FBT0EsT0FBTyxTQUFTLGFBQWEsR0FBdUM7Q0FDbEUsTUFBTSxNQUFNLGlCQUFpQixDQUFDO0NBQzlCLElBQUksSUFBSSxTQUFTLE1BQU0sSUFBSSxTQUFTLENBQUMsSUFBSSxPQUFPO0VBQUUsS0FBSztFQUFHLEtBQUs7Q0FBRTtDQUNqRSxNQUFNLFNBQVMsS0FBSyxJQUFJLE1BQVEsRUFBRSxPQUFPLEVBQUUsUUFBUSxNQUFPLE1BQU8sS0FBSyxJQUFJLElBQUssS0FBSyxJQUFJLEtBQUssSUFBSSxLQUFLLElBQUksSUFBSSxNQUFNLEdBQUcsS0FBSyxJQUFJLElBQUksTUFBTSxDQUFDLElBQUksR0FBRyxDQUFDLENBQUM7Q0FDcEosSUFBSSxNQUFNLEdBQUcsTUFBTTtDQUNuQixLQUFLLElBQUksSUFBSSxHQUFHLEtBQUssR0FBRyxLQUFLO0VBQzNCLE1BQU0sS0FBSyxFQUFFLFNBQVUsRUFBRSxRQUFRLEVBQUUsU0FBUyxJQUFLLEdBQUcsS0FBSyxLQUFLLElBQUksRUFBRSxHQUFHLElBQUksS0FBSyxJQUFJLEVBQUU7RUFDdEYsS0FBSyxJQUFJLElBQUksR0FBRyxLQUFLLEdBQUcsS0FBSztHQUMzQixNQUFNLEtBQUssRUFBRSxRQUFTLEVBQUUsT0FBTyxFQUFFLFFBQVEsSUFBSztHQUM5QyxNQUFNLE9BQU8sS0FBSyxNQUFNLEdBQUcsS0FBSyxLQUFLLElBQUksRUFBRSxDQUFDLElBQUk7R0FDaEQsS0FBSyxNQUFNLEtBQUs7SUFBQyxDQUFDO0lBQVE7SUFBRztHQUFNLEdBQUc7SUFBRSxNQUFNLElBQUksYUFBYSxPQUFPLENBQUM7SUFBRyxJQUFJLElBQUksS0FBSyxNQUFNO0lBQUcsSUFBSSxJQUFJLEtBQUssTUFBTTtHQUFHO0VBQ3hIO0NBQ0Y7Q0FDQSxPQUFPO0VBQUU7RUFBSztDQUFJO0FBQ3BCO0FBU0EsT0FBTyxNQUFNLGlCQUFpQjtBQUM5QixPQUFPLE1BQU0sZ0JBQWdCOztBQUc3QixPQUFPLFNBQVMsWUFBWSxLQUFnQixHQUEwQztDQUNwRixNQUFNLE1BQU0saUJBQWlCLENBQUM7Q0FDOUIsT0FBTyxJQUFJLFNBQVMsQ0FBQyxJQUFJLGNBQWMsSUFBSSxTQUFTLElBQUksYUFBYTtFQUFFLE9BQU8sSUFBSTtFQUFNLE1BQU07Q0FBZSxJQUFJO0VBQUUsT0FBTyxJQUFJO0VBQUssTUFBTTtDQUFjO0FBQ3pKOztBQUdBLE9BQU8sU0FBUyxhQUFhLEdBQVEsTUFBYyxNQUFjLE9BQWUsT0FBZSxRQUFnQixRQUF3QjtDQUNySSxNQUFNLE9BQU8sU0FBUyxLQUFLLE9BQU8sU0FBUztDQUMzQyxNQUFNLE1BQVEsT0FBTyxRQUFRLE1BQU8sT0FBTyxPQUFRLEVBQUUsS0FBSyxPQUFPLFNBQVMsSUFBSyxLQUFLLFFBQVEsU0FBUyxFQUFFLEtBQUssUUFBUSxVQUFVO0NBQzlILE1BQU0sS0FBSyxNQUFNLEtBQUssTUFBTSxDQUFDLEdBQUcsR0FBRyxFQUFFLElBQUksQ0FBQyxHQUFHLEtBQUssTUFBTSxLQUFLLE1BQU0sQ0FBQyxHQUFHLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRyxLQUFLLFFBQVEsSUFBSSxFQUFFLEdBQUcsS0FBSyxRQUFRLElBQUksRUFBRTtDQUM3SCxNQUFNLElBQUksRUFBRSxNQUFNLEtBQUssRUFBRSxJQUFJLEtBQUssS0FBSyxFQUFFLElBQUksTUFBTSxJQUFJLElBQUksSUFBSSxJQUFJLElBQUksSUFBSSxFQUFFLElBQUksSUFBSSxJQUFJLElBQUk7Q0FDN0YsUUFBUSxFQUFFLE1BQU0sSUFBSSxNQUFNLEVBQUUsS0FBSyxPQUFPLElBQUksT0FBTyxFQUFFLE1BQU0sSUFBSSxNQUFNLEVBQUUsS0FBSyxNQUFNO0FBQ3BGOztBQUdBLE9BQU8sTUFBTSxZQUFZLGVBQXVCLElBQUksU0FBUyxLQUFLLElBQUksS0FBSyxLQUFLLElBQUssYUFBYSxNQUFPLENBQUM7O0FBRzFHLE9BQU8sTUFBTSxXQUFXLE9BQWUsS0FBYSxHQUFXLEdBQVcsTUFDeEUsdUNBQXVDLE1BQU0sOEJBQThCLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHOztBQUc1RixPQUFPLE1BQU0sdUJBQXVCLFVBQWtCLHVDQUF1QyxNQUFNOzs7Ozs7O0FBUW5HLE9BQU8sU0FBUyxlQUFlLEtBQTRCO0NBQ3pELE1BQU0sT0FBTyxJQUFJLFFBQVEsb0JBQW9CLEVBQUU7Q0FDL0MsSUFBSSxRQUFRLENBQUM7Q0FDYixLQUFLLE1BQU0sS0FBSyxLQUFLLFNBQVMsK0RBQStELEdBQUcsUUFBUSxLQUFLLElBQUksT0FBTyxPQUFPLEVBQUUsRUFBRSxDQUFDO0NBQ3BJLE9BQU8sU0FBUyxJQUFJLFFBQVE7QUFDOUI7OztBQUlBLE9BQU8sTUFBTSxpQkFBaUI7QUFDOUIsTUFBTSxpQkFBaUIsSUFBSTtBQUMzQixPQUFPLE1BQU0sYUFBYTtBQUMxQixPQUFPLE1BQU0sZ0JBQWdCO0FBQzdCLE1BQU0sZ0JBQWdCO0NBQUM7Q0FBTztDQUFRO0NBQVE7Q0FBUTtDQUFRO0NBQVE7Q0FBUTtBQUFNOzs7Ozs7QUFPcEYsT0FBTyxNQUFNLHNCQUFzQixDQUFDOztBQUVwQyxPQUFPLE1BQU0sb0JBQW9COztBQUdqQyxPQUFPLFNBQVMsZ0JBQWdCLGNBQThCO0NBQzVELE1BQU0sSUFBSSxLQUFLLEtBQUssS0FBSyxLQUFLLGtCQUFrQixhQUFhLFlBQVksWUFBWSxFQUFFLENBQUM7Q0FDeEYsT0FBTyxNQUFNLEdBQUcsR0FBRyxhQUFhO0FBQ2xDOztBQUdBLE9BQU8sU0FBUyxXQUFXLFFBQWdCLEdBQVcsR0FBVyxHQUFtQjtDQUNsRixNQUFNLElBQUksaUJBQWlCLEtBQUs7Q0FDaEMsTUFBTSxLQUFLLENBQUMsaUJBQWlCLElBQUksR0FBRyxLQUFLLGlCQUFpQixJQUFJO0NBQzlELE9BQU8sV0FBVyxlQUFlLElBQUksSUFBSSxJQUFJLEtBQUssY0FBYyxRQUFRLHVFQUF1RSxXQUMzSSwyQkFBMkIsR0FBRyxHQUFHLEtBQUssRUFBRSxHQUFHLEtBQUssRUFBRSxHQUFHLEdBQUcsU0FBUyxXQUFXLFVBQVUsV0FBVztBQUN2Rzs7QUFHQSxPQUFPLFNBQVMsZUFBZSxHQUFpQjtDQUM5QyxPQUFPLGlCQUFpQixDQUFDLENBQUMsQ0FBQyxVQUFVLHNCQUFzQixvQkFBb0I7QUFDakY7Ozs7OztBQU9BLE9BQU8sU0FBUyxzQkFBc0IsR0FBUyxjQUErQjtDQUM1RSxPQUFPLGVBQWUsS0FBSyxnQkFBZ0IsZUFBZSxDQUFDLEtBQUssZUFBZSxDQUFDO0FBQ2xGOztBQU1BLE9BQU8sU0FBUyxrQkFBa0IsTUFBb0M7Q0FDcEUsTUFBTSxJQUFJO0NBQ1YsSUFBSSxDQUFDLEtBQUssT0FBTyxFQUFFLFdBQVcsWUFBWSxFQUFFLFVBQVUsa0JBQWtCLEVBQUUsV0FBVyxjQUFjLENBQUMsRUFBRSxVQUFVLE9BQU8sRUFBRSxXQUFXLFVBQVUsT0FBTztDQUNySixNQUFNLE9BQU8sSUFBSSxJQUFtQztDQUNwRCxJQUFJLFFBQVE7Q0FDWixLQUFLLE1BQU0sQ0FBQyxNQUFNLE9BQU8sT0FBTyxRQUFRLEVBQUUsTUFBTSxHQUFHO0VBQ2pELE1BQU0sSUFBSSxPQUFPLElBQUk7RUFDckIsSUFBSSxDQUFDLE9BQU8sVUFBVSxDQUFDLEtBQUssSUFBSSxLQUFLLElBQUksaUJBQWlCLENBQUMsTUFBTSxRQUFRLElBQUksSUFBSSxHQUFHO0VBQ3BGLE1BQU0sUUFBUSxJQUFJLElBQXNCO0VBQ3hDLEtBQUssTUFBTSxPQUFPLEdBQUcsTUFBbUI7R0FDdEMsSUFBSSxDQUFDLE1BQU0sUUFBUSxHQUFHLEtBQUssSUFBSSxXQUFXLEtBQUssQ0FBQyxJQUFJLE1BQU0sT0FBTyxTQUFTLEdBQUc7R0FDN0UsTUFBTSxDQUFDLEtBQUssT0FBTyxRQUFRO0dBQzNCLElBQUksTUFBTSxLQUFLLFFBQVEsS0FBSyxPQUFPLFNBQVMsUUFBUSxLQUFLLEtBQUssT0FBTyxLQUFLLEdBQUc7R0FDN0UsSUFBSSxPQUFPLE1BQU0sSUFBSSxHQUFHO0dBQ3hCLElBQUksQ0FBQyxNQUFNLE1BQU0sSUFBSSxLQUFNLE9BQU8sQ0FBQyxDQUFFO0dBQ3JDLEtBQUssS0FBSyxPQUFPLElBQUk7R0FDckIsU0FBUyxPQUFPLFFBQVE7RUFDMUI7RUFDQSxLQUFLLElBQUksR0FBRyxLQUFLO0NBQ25CO0NBQ0EsT0FBTztFQUFFLFFBQVEsRUFBRTtFQUFRO0VBQU87Q0FBSztBQUN6Qzs7QUFHQSxPQUFPLFNBQVMsZ0JBQWdCLElBQXlCLEdBQVcsR0FBVyxHQUFvQjtDQUNqRyxNQUFNLE9BQU8sSUFBSSxLQUFLLElBQUksQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDO0NBQ25DLElBQUksQ0FBQyxNQUFNLE9BQU87Q0FDbEIsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLEtBQUssUUFBUSxLQUFLLEdBQUcsSUFBSSxLQUFLLEtBQUssTUFBTSxLQUFLLEtBQUssSUFBSSxJQUFJLE9BQU87Q0FDdEYsT0FBTztBQUNUOztBQUdBLE9BQU8sTUFBTSxtQkFBbUIsTUFBYyxHQUFXLEdBQVcsTUFBYyxHQUFHLE9BQU8sRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFOzs7Ozs7QUFPeEcsT0FBTyxTQUFTLG1CQUFtQixJQUF5QixHQUFTLGNBQStCO0NBQ2xHLElBQUksQ0FBQyxJQUFJLE9BQU87Q0FDaEIsTUFBTSxJQUFJLEtBQUssSUFBSSxnQkFBZ0IsWUFBWSxHQUFHLGVBQWUsQ0FBQyxDQUFDLEdBQUcsSUFBSSxLQUFLLEdBQUcsSUFBSSxpQkFBaUI7Q0FDdkcsSUFBSSxLQUFLLFVBQVUsS0FBSyxDQUFDLFVBQVUsS0FBSyxVQUFVLEtBQUssQ0FBQztDQUN4RCxLQUFLLElBQUksSUFBSSxHQUFHLEtBQUssR0FBRyxLQUFLO0VBQzNCLEtBQUssSUFBSSxJQUFJLEdBQUcsS0FBSyxHQUFHLEtBQUs7R0FDM0IsTUFBTSxNQUFNLEVBQUUsT0FBUSxJQUFJLEtBQU0sRUFBRSxPQUFPLEVBQUUsT0FBTyxNQUFNLEVBQUUsUUFBUyxJQUFJLEtBQU0sRUFBRSxRQUFRLEVBQUUsUUFBUSxLQUFLLEtBQUssSUFBSSxHQUFHO0dBQ2xILE1BQU0sTUFBTSxJQUFJLEtBQUssS0FBSyxJQUFJLEdBQUc7R0FDakMsSUFBSSxNQUFNLE1BQU0sT0FBTztHQUN2QixNQUFNLElBQUssSUFBSSxTQUFVLEtBQUssS0FBSyxJQUFJLEtBQUssSUFBSSxHQUFHLEdBQUcsS0FBSyxJQUFJLEtBQUssS0FBSyxJQUFJLEdBQUc7R0FDaEYsS0FBSyxLQUFLLElBQUksSUFBSSxFQUFFO0dBQUcsS0FBSyxLQUFLLElBQUksSUFBSSxFQUFFO0dBQUcsS0FBSyxLQUFLLElBQUksSUFBSSxFQUFFO0dBQUcsS0FBSyxLQUFLLElBQUksSUFBSSxFQUFFO0VBQzNGO0NBQ0Y7Q0FDQSxNQUFNLE1BQU0sSUFBSSxhQUFhLE9BQVEsS0FBSyxLQUFLLEtBQUs7Q0FDcEQsTUFBTSxLQUFLLEtBQUssSUFBSSxHQUFHLEtBQUssT0FBTyxLQUFLLE1BQU0sa0JBQWtCLENBQUMsQ0FBQyxHQUFHLEtBQUssS0FBSyxJQUFJLElBQUksR0FBRyxLQUFLLE9BQU8sS0FBSyxNQUFNLGtCQUFrQixDQUFDLENBQUM7Q0FDckksTUFBTSxLQUFLLEtBQUssSUFBSSxHQUFHLEtBQUssT0FBTyxpQkFBaUIsS0FBSyxPQUFPLENBQUMsQ0FBQyxHQUFHLEtBQUssS0FBSyxJQUFJLElBQUksR0FBRyxLQUFLLE9BQU8saUJBQWlCLEtBQUssT0FBTyxDQUFDLENBQUM7Q0FDckksS0FBSyxLQUFLLEtBQUssTUFBTSxLQUFLLEtBQUssS0FBSyxJQUFJLE9BQU87Q0FDL0MsTUFBTSxVQUFVLFNBQVMsZUFBZTtDQUN4QyxLQUFLLElBQUksSUFBSSxJQUFJLEtBQUssSUFBSSxLQUFLO0VBQzdCLEtBQUssSUFBSSxJQUFJLElBQUksS0FBSyxJQUFJLEtBQUs7R0FDN0IsSUFBSSxnQkFBZ0IsSUFBSSxHQUFHLEdBQUcsQ0FBQyxHQUFHOztHQUVsQyxNQUFNLE1BQU0sQ0FBQyxpQkFBaUIsSUFBSSxHQUFHLE1BQU0saUJBQWlCLElBQUk7R0FDaEUsTUFBTSxLQUFLLE9BQU8sS0FBSyxNQUFNLEtBQUssSUFBSSxJQUFJLEtBQUssSUFBSSxLQUFLLElBQUksR0FBRyxHQUFHLEtBQUssSUFBSSxNQUFNLENBQUMsQ0FBQyxHQUFHLEtBQUssT0FBTyxLQUFLLE1BQU0sS0FBSyxJQUFJLElBQUksS0FBSyxJQUFJLEtBQUssSUFBSSxHQUFHLEdBQUcsS0FBSyxJQUFJLE1BQU0sQ0FBQyxDQUFDO0dBQ25LLElBQUksS0FBSyxNQUFNLElBQUksRUFBRSxJQUFJLFNBQVMsT0FBTztFQUMzQztDQUNGO0NBQ0EsT0FBTztBQUNUOztBQUdBLE9BQU8sTUFBTSxXQUFXOztBQUV4QixPQUFPLE1BQU0saUJBQWlCO0FBQzlCLE9BQU8sTUFBTSxzQkFBc0I7QUFDbkMsT0FBTyxNQUFNLGtCQUFrQjtBQUMvQixPQUFPLE1BQU0scUJBQXFCO0FBQ2xDLE9BQU8sTUFBTSxvQkFBb0I7QUFFakMsT0FBTyxNQUFNLGdCQUE2QjtDQUFFLE9BQU87Q0FBZSxNQUFNO0NBQXFCLE1BQU0sQ0FBQztDQUFLLE9BQU8sQ0FBQztDQUFJLE1BQU07Q0FBSyxPQUFPO0NBQUksVUFBVTtDQUFNLFFBQVE7QUFBSztBQUN4SyxNQUFNLG1CQUFnQztDQUFFLEdBQUc7Q0FBZSxPQUFPO0FBQWM7O0FBRS9FLE9BQU8sTUFBTSxnQkFBd0M7Q0FDbkQ7RUFBRSxPQUFPO0VBQTZCLE1BQU07RUFBSSxNQUFNO0VBQVksT0FBTztFQUFXLE1BQU07RUFBWSxPQUFPO0NBQVU7Q0FDdkg7RUFBRSxPQUFPO0VBQTZCLE1BQU07RUFBSSxNQUFNLENBQUM7RUFBVyxPQUFPLENBQUM7RUFBVyxNQUFNLENBQUM7RUFBWSxPQUFPLENBQUM7Q0FBVTtDQUMxSDtFQUFFLE9BQU87RUFBNkIsTUFBTTtFQUFJLE1BQU0sQ0FBQztFQUFZLE9BQU8sQ0FBQztFQUFXLE1BQU0sQ0FBQztFQUFZLE9BQU8sQ0FBQztDQUFVO0NBQzNIO0VBQUUsT0FBTztFQUE2QixNQUFNO0VBQUksTUFBTTtFQUFXLE9BQU87RUFBWSxNQUFNO0VBQVcsT0FBTztDQUFXO0NBQ3ZIO0VBQUUsT0FBTztFQUE2QixNQUFNO0VBQUksTUFBTTtFQUFZLE9BQU8sQ0FBQztFQUFXLE1BQU07RUFBWSxPQUFPLENBQUM7Q0FBVTtDQUN6SDtFQUFFLE9BQU87RUFBaUMsTUFBTTtFQUFJLE1BQU07RUFBWSxPQUFPO0VBQVksTUFBTTtFQUFZLE9BQU87Q0FBVztDQUM3SDtFQUFFLE9BQU87RUFBZ0MsTUFBTTtFQUFJLE1BQU0sQ0FBQztFQUFVLE9BQU8sQ0FBQztFQUFZLE1BQU0sQ0FBQztFQUFZLE9BQU8sQ0FBQztDQUFXO0NBQzlIO0VBQUUsT0FBTztFQUEwRCxNQUFNO0VBQUksTUFBTTtFQUFXLE9BQU8sQ0FBQztFQUFZLE1BQU07RUFBVyxPQUFPLENBQUM7Q0FBVztDQUN0SjtFQUFFLE9BQU87RUFBc0MsTUFBTTtFQUFJLE1BQU07RUFBYSxPQUFPLENBQUM7RUFBWSxNQUFNO0VBQWEsT0FBTyxDQUFDO0NBQVc7Q0FDdEk7RUFBRSxPQUFPO0VBQWlDLE1BQU07RUFBSSxNQUFNO0VBQVksT0FBTyxDQUFDO0VBQVksTUFBTTtFQUFZLE9BQU8sQ0FBQztDQUFVO0NBQzlIO0VBQUUsT0FBTztFQUE2QixNQUFNO0VBQUksTUFBTTtFQUFZLE9BQU87RUFBWSxNQUFNO0VBQVksT0FBTztDQUFXO0NBQ3pIO0VBQUUsT0FBTztFQUFrQixVQUFVO0VBQU0sTUFBTTtFQUFJLE1BQU0sQ0FBQztFQUFZLE9BQU87RUFBWSxNQUFNLENBQUM7RUFBWSxPQUFPO0NBQVc7Q0FDaEk7RUFBRSxPQUFPO0VBQWtCLFVBQVU7RUFBTSxNQUFNO0VBQUksTUFBTSxDQUFDO0VBQVksT0FBTztFQUFZLE1BQU0sQ0FBQztFQUFZLE9BQU87Q0FBVztDQUNoSTtFQUFFLE9BQU87RUFBa0IsVUFBVTtFQUFNLE1BQU07RUFBSSxNQUFNLENBQUM7RUFBYSxPQUFPLENBQUM7RUFBWSxNQUFNLENBQUM7RUFBYSxPQUFPLENBQUM7Q0FBVztDQUNwSTtFQUFFLE9BQU87RUFBa0IsVUFBVTtFQUFNLE1BQU07RUFBSSxNQUFNO0VBQVksT0FBTyxDQUFDO0VBQVksTUFBTTtFQUFZLE9BQU8sQ0FBQztDQUFXO0NBQ2hJO0VBQUUsT0FBTztFQUFrQixVQUFVO0VBQU0sTUFBTTtFQUFJLE1BQU07RUFBWSxPQUFPLENBQUM7RUFBWSxNQUFNO0VBQVksT0FBTyxDQUFDO0NBQVc7Q0FDaEk7RUFBRSxPQUFPO0VBQWtCLFVBQVU7RUFBTSxNQUFNO0VBQUksTUFBTTtFQUFZLE9BQU87RUFBWSxNQUFNO0VBQVksT0FBTztDQUFXO0NBQzlIO0VBQUUsT0FBTztFQUFrQixVQUFVO0VBQU0sTUFBTTtFQUFJLE1BQU07RUFBWSxPQUFPO0VBQVksTUFBTTtFQUFZLE9BQU87Q0FBVztDQUM5SDtFQUFFLE9BQU87RUFBa0IsVUFBVTtFQUFNLE1BQU07RUFBSSxNQUFNLENBQUM7RUFBVyxPQUFPO0VBQVksTUFBTSxDQUFDO0VBQVcsT0FBTztDQUFXO0FBQ2hJOztBQUdBLE9BQU8sU0FBUyxnQkFBZ0IsR0FBd0I7Q0FDdEQsTUFBTSxNQUFNLGlCQUFpQixDQUFDO0NBQzlCLElBQUksSUFBSSxTQUFTLE1BQU0sSUFBSSxTQUFTLENBQUMsSUFBSSxPQUFPLENBQUM7Q0FDakQsSUFBSSxPQUFPLFVBQVUsT0FBTyxDQUFDO0NBQzdCLEtBQUssTUFBTSxLQUFLO0VBQUMsRUFBRTtHQUFRLEVBQUUsUUFBUSxFQUFFLFNBQVM7RUFBRyxFQUFFO0NBQUssR0FBRztFQUMzRCxLQUFLLE1BQU0sS0FBSztHQUFDLEVBQUU7SUFBTyxFQUFFLE9BQU8sRUFBRSxRQUFRO0dBQUcsRUFBRTtFQUFJLEdBQUc7R0FDdkQsTUFBTSxNQUFNLEtBQUssTUFBTSxLQUFLLElBQUksQ0FBQyxHQUFHLEtBQUssSUFBSSxDQUFDLElBQUksS0FBSyxJQUFJLENBQUMsQ0FBQyxJQUFJO0dBQ2pFLE9BQU8sS0FBSyxJQUFJLE1BQU0sR0FBRztHQUFHLE9BQU8sS0FBSyxJQUFJLE1BQU0sR0FBRztFQUN2RDtDQUNGO0NBQ0EsTUFBTSxNQUFNLEtBQUssRUFBRSxPQUFPLEVBQUUsUUFBUTtDQUNwQyxPQUFPLGNBQWMsUUFBTyxNQUFLLElBQUksVUFBVSxFQUFFLFFBQVEsT0FBTyxJQUFJLFVBQVUsRUFBRSxRQUFRLE9BQU8sUUFBUSxFQUFFLE9BQU8sT0FBTyxRQUFRLEVBQUUsT0FBTyxHQUFHO0FBQzdJOztBQUdBLE9BQU8sU0FBUyxrQkFBa0IsR0FBUyxRQUE4QjtDQUN2RSxLQUFLLE1BQU0sS0FBSztFQUFDLEVBQUU7R0FBUSxFQUFFLFFBQVEsRUFBRSxTQUFTO0VBQUcsRUFBRTtDQUFLLEdBQUcsS0FBSyxNQUFNLEtBQUs7RUFBQyxFQUFFO0dBQU8sRUFBRSxPQUFPLEVBQUUsUUFBUTtFQUFHLEVBQUU7Q0FBSSxHQUFHO0VBQ3BILE1BQU0sS0FBSyxLQUFLLEtBQUssQ0FBQyxLQUFLLElBQUksQ0FBQyxJQUFJLEtBQUssSUFBSSxDQUFDLENBQUMsR0FBRyxLQUFLLEtBQUssTUFBTSxLQUFLLElBQUksQ0FBQyxHQUFHLEtBQUssSUFBSSxDQUFDLElBQUksS0FBSyxJQUFJLENBQUMsQ0FBQztFQUN4RyxNQUFNLE9BQU8sS0FBSyxLQUFLLEtBQUssTUFBTSxPQUFPLFFBQVEsS0FBSyxJQUFJLEVBQUUsSUFBSSxPQUFPLE9BQU8sS0FBSyxPQUFPLEtBQUssSUFBSSxFQUFFLEdBQUcsS0FBSyxNQUFNLE9BQU8sT0FBTyxPQUFPLFFBQVEsS0FBSyxHQUFHO0VBQ3hKLElBQUksT0FBTyxNQUFNLFNBQVMsS0FBSyxPQUFPO0NBQ3hDO0NBQ0EsT0FBTztBQUNUOztBQUdBLE9BQU8sU0FBUyxjQUFjLEdBQWlCO0NBQzdDLE1BQU0sTUFBTSxpQkFBaUIsQ0FBQztDQUM5QixJQUFJLElBQUksU0FBUyxpQkFBaUIsT0FBTztDQUN6QyxPQUFPLEtBQUssSUFBSSxzQkFBc0IsR0FBRyxHQUFHLGdCQUFnQixDQUFDLENBQUMsQ0FBQyxLQUFJLE1BQUssRUFBRSxPQUFPLENBQUMsQ0FBQztBQUNyRjs7OztBQUtBLE9BQU8sU0FBUyxlQUFlLE1BQXlCLE9BQWlDLEtBQStCLE9BQU8sS0FBWTtDQUN6SSxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUs7Q0FDcEIsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLEtBQUssUUFBUSxLQUFLLEdBQUc7RUFDdkMsTUFBTSxJQUFJLEtBQUssSUFBSSxNQUFNLElBQUksSUFBSSxJQUFJLElBQUksRUFBRSxJQUFJO0VBQy9DLElBQUksS0FBSyxLQUFLLENBQUMsS0FBSyxJQUFJLElBQUk7RUFDNUIsTUFBTSxJQUFJLE9BQU8sS0FBSyxNQUFNLEtBQUssSUFBSTtFQUNyQyxLQUFLLE1BQU07RUFBRyxLQUFLLElBQUksTUFBTTtFQUFHLEtBQUssSUFBSSxNQUFNO0NBQ2pEO0FBQ0Y7OztBQUlBLE9BQU8sU0FBUyxlQUFlLE1BQXlCLE9BQWlDLEtBQStCLFdBQW9DO0NBQzFKLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSztDQUNwQixLQUFLLElBQUksSUFBSSxHQUFHLElBQUksS0FBSyxRQUFRLEtBQUssR0FBRztFQUN2QyxNQUFNLElBQUksS0FBSyxJQUFJLE1BQU0sSUFBSSxJQUFJLElBQUksSUFBSSxFQUFFLElBQUk7RUFDL0MsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLElBQUksSUFBSTtFQUN4QixNQUFNLE9BQU8sTUFBTSxVQUFVLEtBQUssS0FBSyxJQUFJLEdBQUcsSUFBSSxFQUFFLEdBQUcsS0FBTSxDQUFDO0VBQzlELE1BQU0sUUFBUSxNQUFNLEtBQUs7RUFDekIsS0FBSyxLQUFLLEtBQUssSUFBSSxLQUFLLEtBQUssSUFBSSxLQUFLLEtBQUssTUFBTSxJQUFJLEtBQUssUUFBUTtDQUNwRTtBQUNGOzs7QUFJQSxPQUFPLFNBQVMsZ0JBQWdCLElBQWUsR0FBUyxjQUFzQixNQUFjLFFBQStCO0NBQ3pILElBQUksQ0FBQyxhQUFhLElBQUksR0FBRyxnQkFBZ0IsR0FBRyxPQUFPO0NBQ25ELElBQUksTUFBTTtDQUNWLElBQUksVUFBVSxDQUFDLE9BQU8sUUFBUSxLQUFLLElBQUksSUFBSSxHQUFHLElBQUksSUFBSSxLQUFLO0VBQ3pELElBQUksQ0FBQyxHQUFHLElBQUksSUFBSTtFQUNoQixNQUFNLEtBQUssR0FBRyxFQUFFLEtBQUssS0FBSyxLQUFLLEdBQUcsRUFBRSxLQUFLO0VBQ3pDLE1BQU0sT0FBTyxLQUFLLEtBQUssS0FBSyxPQUFPLFFBQVEsS0FBSyxJQUFJLEdBQUcsRUFBRSxFQUFFLElBQUksT0FBTyxPQUFPLE1BQU0sS0FBSyxJQUFJLEdBQUcsRUFBRSxFQUFFLEdBQUcsS0FBSyxPQUFPLE9BQU8sT0FBTyxRQUFRLEVBQUU7RUFDMUksR0FBRyxJQUFJLE1BQU0sUUFBUSxPQUFPLE1BQU0sU0FBUyxNQUFNLEdBQUc7RUFDcEQsUUFBUSxHQUFHLElBQUksS0FBSztDQUN0QjtNQUNLLE1BQU07Q0FDWCxJQUFJLEtBQUssV0FBVyxJQUFJLGNBQWMsUUFBUSxjQUFjLElBQUksQ0FBQztDQUNqRSxPQUFPO0FBQ1Q7QUFFQSxPQUFPLFNBQVMsZ0JBQWdCLElBQWUsR0FBUyxjQUFzQixNQUFjLFFBQW1DO0NBQzdILElBQUksQ0FBQyxnQkFBZ0IsSUFBSSxHQUFHLGNBQWMsTUFBTSxNQUFNLEdBQUcsT0FBTztDQUNoRSxNQUFNLFFBQVEsTUFBTSxLQUFLLEVBQUUsUUFBUSxRQUFRLGNBQWMsSUFBSSxJQUFJLEVBQUUsSUFBSSxHQUFHLE1BQU0sUUFBUSxXQUFXO0VBQUUsT0FBTztFQUFLLE9BQU87RUFBSyxRQUFRLEtBQUs7RUFBRyxPQUFPLE1BQU0sS0FBSztFQUFHLFFBQVEsTUFBTSxLQUFLO0VBQUcsUUFBUTtDQUFLLElBQUksU0FBUyxDQUFDLENBQUM7Q0FDcE4sT0FBTztFQUFFLE9BQU8sS0FBSyxJQUFJLGNBQWMsSUFBSTtFQUFHO0VBQU8sTUFBTSxhQUFhLElBQUksT0FBTyxRQUFRLEtBQUssQ0FBQztDQUFFO0FBQ3JHOztBQUdBLE9BQU8sU0FBUyxlQUFlLElBQWUsR0FBUyxHQUFvQjtDQUN6RSxJQUFJLENBQUMsY0FBYyxJQUFJLEdBQUcsU0FBUyxDQUFDLGVBQWUsR0FBRyxLQUFNLG9CQUFvQixJQUFJLEdBQUcsT0FBTztDQUM5RixNQUFNLElBQUksYUFBYSxLQUFLLEtBQUssSUFBSTtDQUNyQyxZQUFZLElBQUksb0JBQW9CLEdBQUcsQ0FBQztDQUN4QyxPQUFPO0FBQ1Q7QUFDQSxPQUFPLFNBQVMsZUFBZSxJQUFlLEdBQVMsY0FBbUM7Q0FDeEYsTUFBTSxJQUFJLE1BQU0sS0FBSyxLQUFLLEtBQUssS0FBSyxJQUFJLHNCQUFzQixhQUFhLFlBQVksWUFBWSxFQUFFLENBQUMsR0FBRyxHQUFHLGlCQUFpQjtDQUM3SCxJQUFJLENBQUMsZUFBZSxJQUFJLEdBQUcsQ0FBQyxHQUFHLE9BQU87Q0FDdEMsTUFBTSxRQUFRLENBQUMsWUFBWSxDQUFDLENBQUM7Q0FDN0IsT0FBTztFQUFFLE9BQU87RUFBRztFQUFPLE1BQU0sYUFBYSxJQUFJLE9BQU8saUJBQWlCLEtBQUssQ0FBQztDQUFFO0FBQ25GO0FBQ0EsT0FBTyxTQUFTLGNBQWMsR0FBVyxHQUFXLEdBQW1CO0NBQ3JFLE9BQU8saUVBQWlFLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRTtBQUN0RjtBQUVBLFNBQVMsaUJBQWlCLEdBQVcsR0FBVyxHQUFtQjtDQUNqRSxNQUFNLE9BQU8sSUFBSSxxQkFBcUIsS0FBSyxHQUFHLElBQUksQ0FBQyxxQkFBcUIsSUFBSSxNQUFNLElBQUkscUJBQXFCLElBQUk7Q0FDL0csT0FBTyw2SEFBNkgsRUFBRSxHQUFHLElBQUksS0FBSyxHQUFHLElBQUksS0FBSyxHQUFHLEVBQUU7QUFDcks7Ozs7O0FBWUEsT0FBTyxTQUFTLGtCQUFrQixLQUFVLFNBQVMsR0FBUTtDQUMzRCxNQUFNLEVBQUUsR0FBRyxHQUFHLElBQUksU0FBUyxLQUFLLFFBQVEsSUFBSSxHQUFHLE1BQU0sU0FBUztDQUM5RCxNQUFNLFFBQVEsTUFBYztFQUMxQixNQUFNLElBQUksSUFBSTtFQUNkLE9BQU8sS0FBSyxNQUFNLE1BQU0sT0FBTyxLQUFNLEtBQUssSUFBSSxNQUFNLEtBQUssS0FBSyxJQUFJLE1BQU07Q0FDMUU7Q0FDQSxJQUFJLE1BQU07Q0FDVixNQUFNLFdBQVcsSUFBSSxXQUFXLEtBQUs7Q0FBRyxTQUFTLEtBQUssR0FBRztDQUN6RCxLQUFLLElBQUksSUFBSSxHQUFHLElBQUksT0FBTyxLQUFLLElBQUksS0FBSyxDQUFDLEdBQUc7RUFBRSxTQUFTLEtBQUs7RUFBRyxNQUFNO0NBQU07Q0FDNUUsSUFBSSxDQUFDLEtBQUssT0FBTztDQUNqQixLQUFLLElBQUksSUFBSSxHQUFHLElBQUksR0FBRyxLQUFLLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxHQUFHLEtBQUs7RUFDdEQsTUFBTSxJQUFJLElBQUksSUFBSTtFQUNsQixJQUFJLEdBQUcsU0FBUyxLQUFLLEtBQUssSUFBSSxTQUFTLElBQUksU0FBUyxJQUFJLEtBQUssQ0FBQztFQUM5RCxJQUFJLEdBQUc7R0FDTCxTQUFTLEtBQUssS0FBSyxJQUFJLFNBQVMsSUFBSSxTQUFTLElBQUksS0FBSyxDQUFDO0dBQ3ZELElBQUksR0FBRyxTQUFTLEtBQUssS0FBSyxJQUFJLFNBQVMsSUFBSSxTQUFTLElBQUksSUFBSSxLQUFLLEVBQUU7R0FDbkUsSUFBSSxJQUFJLElBQUksR0FBRyxTQUFTLEtBQUssS0FBSyxJQUFJLFNBQVMsSUFBSSxTQUFTLElBQUksSUFBSSxLQUFLLEVBQUU7RUFDN0U7Q0FDRjtDQUNBLEtBQUssSUFBSSxJQUFJLElBQUksR0FBRyxLQUFLLEdBQUcsS0FBSyxLQUFLLElBQUksSUFBSSxJQUFJLEdBQUcsS0FBSyxHQUFHLEtBQUs7RUFDaEUsTUFBTSxJQUFJLElBQUksSUFBSTtFQUNsQixJQUFJLElBQUksSUFBSSxHQUFHLFNBQVMsS0FBSyxLQUFLLElBQUksU0FBUyxJQUFJLFNBQVMsSUFBSSxLQUFLLENBQUM7RUFDdEUsSUFBSSxJQUFJLElBQUksR0FBRztHQUNiLFNBQVMsS0FBSyxLQUFLLElBQUksU0FBUyxJQUFJLFNBQVMsSUFBSSxLQUFLLENBQUM7R0FDdkQsSUFBSSxHQUFHLFNBQVMsS0FBSyxLQUFLLElBQUksU0FBUyxJQUFJLFNBQVMsSUFBSSxJQUFJLEtBQUssRUFBRTtHQUNuRSxJQUFJLElBQUksSUFBSSxHQUFHLFNBQVMsS0FBSyxLQUFLLElBQUksU0FBUyxJQUFJLFNBQVMsSUFBSSxJQUFJLEtBQUssRUFBRTtFQUM3RTtDQUNGO0NBQ0EsTUFBTSxNQUFNLElBQUksV0FBVyxRQUFRLENBQUM7Q0FDcEMsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLE9BQU8sS0FBSztFQUM5QixNQUFNLElBQUksSUFBSSxJQUFJLElBQUksSUFBSTtFQUMxQixJQUFJLEtBQUssS0FBSztFQUFJLElBQUksSUFBSSxLQUFLLEtBQUssT0FBTyxJQUFJLElBQUksSUFBSTtFQUFJLElBQUksSUFBSSxLQUFLLEtBQUssT0FBTyxJQUFJLElBQUksSUFBSTtFQUNoRyxJQUFJLElBQUksTUFBTSxPQUFPLElBQUksS0FBSyxJQUFJLEtBQUssT0FBTyxPQUFPLFNBQVMsS0FBSyxHQUFHO0NBQ3hFO0NBQ0EsT0FBTztFQUFFO0VBQUc7RUFBRyxJQUFJO0VBQUcsTUFBTTtDQUFJO0FBQ2xDOzs7QUFJQSxPQUFPLFNBQVMsU0FBUyxLQUFlO0NBQ3RDLE1BQU0sRUFBRSxNQUFNLElBQUksR0FBRyxNQUFNO0NBQzNCLElBQUksUUFBUTtDQUNaLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxLQUFLLFFBQVEsS0FBSyxJQUFJLElBQUksS0FBSyxPQUFPLE1BQU0sT0FBTyxLQUFNLEtBQUssSUFBSSxPQUFPLEtBQUssS0FBSyxJQUFJLE9BQU8sSUFBSztFQUFFLFFBQVE7RUFBTTtDQUFPO0NBQzlJLElBQUksQ0FBQyxPQUFPLE9BQU87Q0FDbkIsTUFBTSxNQUFNLElBQUksV0FBVyxJQUFJLElBQUksQ0FBQztDQUNwQyxLQUFLLElBQUksSUFBSSxHQUFHLElBQUksSUFBSSxHQUFHLEtBQUs7RUFDOUIsTUFBTSxJQUFJLElBQUksSUFBSSxJQUFJLElBQUksR0FBRyxJQUFJLEtBQUssSUFBSSxJQUFJLE9BQU8sSUFBSSxJQUFJLEtBQUssSUFBSSxJQUFJLElBQUksT0FBTyxJQUFJLElBQUksS0FBSyxJQUFJO0VBQ3RHLElBQUksS0FBSztFQUFHLElBQUksSUFBSSxLQUFLO0VBQUcsSUFBSSxJQUFJLEtBQUs7RUFBRyxJQUFJLElBQUksS0FBSyxNQUFNLEtBQUssTUFBTSxLQUFLLE1BQU0sSUFBSSxJQUFJLE9BQU8sSUFBSSxLQUFLLElBQUksS0FBSztDQUN4SDtDQUNBLE9BQU87RUFBRTtFQUFHO0VBQUcsSUFBSTtFQUFHLE1BQU07Q0FBSTtBQUNsQztBQWtCQSxPQUFPLFNBQVMsZUFBZSxTQUErQjtDQUM1RCxNQUFNLE1BQU0sSUFBSSxXQUFXLE1BQU0sQ0FBQztDQUNsQyxLQUFLLElBQUksSUFBSSxHQUFHLElBQUksS0FBSyxJQUFJLEtBQUssUUFBUSxNQUFNLEdBQUcsS0FBSztFQUN0RCxNQUFNLElBQUksUUFBUSxFQUFFLEVBQUUsUUFBUSxLQUFLLEVBQUUsS0FBSztFQUMxQyxJQUFJLENBQUMsNkJBQTZCLEtBQUssQ0FBQyxHQUFHO0VBQzNDLElBQUksSUFBSSxLQUFLLFNBQVMsRUFBRSxNQUFNLEdBQUcsQ0FBQyxHQUFHLEVBQUU7RUFBRyxJQUFJLElBQUksSUFBSSxLQUFLLFNBQVMsRUFBRSxNQUFNLEdBQUcsQ0FBQyxHQUFHLEVBQUU7RUFDckYsSUFBSSxJQUFJLElBQUksS0FBSyxTQUFTLEVBQUUsTUFBTSxHQUFHLENBQUMsR0FBRyxFQUFFO0VBQUcsSUFBSSxJQUFJLElBQUksS0FBSyxFQUFFLFdBQVcsSUFBSSxTQUFTLEVBQUUsTUFBTSxHQUFHLENBQUMsR0FBRyxFQUFFLElBQUk7Q0FDaEg7Q0FDQSxPQUFPO0FBQ1Q7O0FBR0EsT0FBTyxTQUFTLGlCQUFpQixNQUFXLFNBQThCO0NBQ3hFLElBQUksQ0FBQyxXQUFXLEtBQUssT0FBTyxHQUFHLE9BQU8sVUFBVSxJQUFJO0NBQ3BELE1BQU0sVUFBVSxJQUFJLElBQVk7Q0FDaEMsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLEtBQUssS0FBSyxJQUFJLFFBQVEsSUFBSSxJQUFJLElBQUksUUFBUSxJQUFJLEdBQUcsUUFBUSxJQUFJLEdBQUcsR0FBRyxRQUFRLElBQUksSUFBSSxHQUFHLEdBQUcsUUFBUSxJQUFJLElBQUksSUFBSTtDQUNqSSxJQUFJLFFBQVEsUUFBUSxHQUFHOztFQUVyQixNQUFNLFVBQVUsSUFBSSxXQUFXLEdBQUc7RUFDbEMsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLEtBQUssS0FBSztHQUM1QixJQUFJLE9BQU87R0FDWCxLQUFLLElBQUksSUFBSSxHQUFHLElBQUksS0FBSyxLQUFLO0lBQUUsTUFBTSxJQUFJLEtBQUssSUFBSSxJQUFJLFFBQVEsSUFBSSxJQUFJLEVBQUU7SUFBRyxJQUFJLElBQUksTUFBTTtLQUFFLE9BQU87S0FBRyxRQUFRLEtBQUs7SUFBRztHQUFFO0VBQzFIO0VBQ0EsTUFBTSxTQUFTLENBQUMsSUFBSTtFQUNwQixLQUFLLElBQUksSUFBSSxNQUFNLEtBQUssSUFBSSxFQUFFLEdBQUcsRUFBRSxDQUFDLElBQUksS0FBTTtHQUM1QyxNQUFNLElBQUksS0FBSyxJQUFJLEdBQUcsRUFBRSxLQUFLLENBQUMsR0FBRyxJQUFJLEtBQUssSUFBSSxHQUFHLEVBQUUsS0FBSyxDQUFDLEdBQUcsT0FBTyxJQUFJLFdBQVcsSUFBSSxDQUFDO0dBQ3ZGLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxHQUFHLEtBQUssS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLEdBQUcsS0FBSztJQUN0RCxJQUFJLFFBQVE7SUFDWixLQUFLLElBQUksS0FBSyxHQUFHLEtBQUssR0FBRyxNQUFNLEtBQUssSUFBSSxLQUFLLEdBQUcsS0FBSyxHQUFHLE1BQU0sU0FBUyxRQUFRLEVBQUUsS0FBSyxLQUFLLElBQUksRUFBRSxJQUFJLEdBQUcsSUFBSSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksS0FBSyxJQUFJLEVBQUUsSUFBSSxHQUFHLElBQUksSUFBSSxFQUFFLEtBQUssSUFBSTtJQUNqSyxLQUFLLElBQUksSUFBSSxLQUFLLFFBQVEsS0FBSyxNQUFNLFFBQVEsQ0FBQztHQUNoRDtHQUNBLElBQUk7SUFBRTtJQUFHO0lBQUcsSUFBSTtJQUFHO0dBQUs7R0FBRyxPQUFPLEtBQUssQ0FBQztFQUMxQztFQUNBLE9BQU8sRUFBRSxPQUFPO0NBQ2xCO0NBQ0EsTUFBTSxJQUFJLEtBQUssSUFBSSxHQUFHLEtBQUssS0FBSyxDQUFDLEdBQUcsSUFBSSxLQUFLLElBQUksR0FBRyxLQUFLLEtBQUssQ0FBQyxHQUFHLE1BQU0sSUFBSSxXQUFXLElBQUksSUFBSSxDQUFDO0NBQ2hHLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxHQUFHLEtBQUssS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLEdBQUcsS0FBSztFQUN0RCxJQUFJLElBQUksR0FBRyxJQUFJLEdBQUcsSUFBSSxHQUFHLElBQUk7RUFDN0IsS0FBSyxJQUFJLEtBQUssR0FBRyxLQUFLLEdBQUcsTUFBTSxLQUFLLElBQUksS0FBSyxHQUFHLEtBQUssR0FBRyxNQUFNO0dBQzVELE1BQU0sSUFBSSxLQUFLLEtBQUssS0FBSyxJQUFJLEtBQUssSUFBSSxHQUFHLElBQUksSUFBSSxFQUFFLElBQUksS0FBSyxJQUFJLEtBQUssSUFBSSxLQUFLLElBQUksR0FBRyxJQUFJLElBQUksRUFBRSxLQUFLLEdBQUcsSUFBSSxRQUFRLElBQUk7R0FDdkgsS0FBSyxRQUFRLEtBQUs7R0FBRyxLQUFLLFFBQVEsSUFBSSxLQUFLO0dBQUcsS0FBSyxRQUFRLElBQUksS0FBSztHQUFHLEtBQUs7RUFDOUU7RUFDQSxNQUFNLEtBQUssSUFBSSxJQUFJLEtBQUs7RUFDeEIsSUFBSSxHQUFHO0dBQUUsSUFBSSxLQUFLLEtBQUssTUFBTSxJQUFJLENBQUM7R0FBRyxJQUFJLElBQUksS0FBSyxLQUFLLE1BQU0sSUFBSSxDQUFDO0dBQUcsSUFBSSxJQUFJLEtBQUssS0FBSyxNQUFNLElBQUksQ0FBQztFQUFHO0VBQ3JHLElBQUksSUFBSSxLQUFLLEtBQUssTUFBTSxJQUFJLENBQUM7Q0FDL0I7Q0FDQSxPQUFPLEVBQUUsUUFBUSxDQUFDLE1BQU0sR0FBRyxVQUFVO0VBQUU7RUFBRztFQUFHLElBQUk7RUFBRyxNQUFNO0NBQUksQ0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFO0FBQzNFOztBQUdBLE9BQU8sU0FBUyxjQUFjLElBQWUsUUFBZ0IsU0FBaUMsUUFBaUIsTUFBc0Q7Q0FDbkssSUFBSSxDQUFDLFdBQVcsT0FBTyxPQUFPLEVBQUUsQ0FBQyxPQUFPLEdBQUc7RUFDekMsTUFBTSxRQUFRLE9BQU8sT0FBTyxLQUFJLE9BQU07R0FBRSxHQUFHLFdBQVcsQ0FBQztHQUFHO0VBQU8sRUFBRTtFQUNuRSxPQUFPLFlBQVksSUFBSSxPQUFPLE9BQU8sT0FBTyxLQUFLLEdBQUcsTUFBTSxJQUFJLFNBQVMsR0FBRyxPQUFPLFFBQVEsSUFBSTtDQUMvRjtDQUNBLE1BQU0sTUFBTSxJQUFJLGtCQUFrQixLQUFLLENBQUM7Q0FDeEMsSUFBSSxNQUFNO0NBQ1YsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLElBQUksS0FBSztFQUMzQixJQUFJLEdBQUcsSUFBSSxNQUFNLEdBQUc7RUFDcEIsTUFBTSxJQUFJLE9BQU8sT0FBTyxHQUFHLElBQUksS0FBSyxVQUFVLEVBQUUsT0FBTyxHQUFHLElBQUksR0FBRyxLQUFLLElBQUksT0FBTyxHQUFHLEtBQUs7RUFDekYsSUFBSSxJQUFJLEdBQUcsSUFBSSxHQUFHLElBQUksR0FBRyxJQUFJO0VBQzdCLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxHQUFHLEtBQUs7R0FDMUIsTUFBTSxJQUFJLEdBQUcsRUFBRSxNQUFNLEtBQUssSUFBSSxLQUFLLEtBQUssTUFBTSxJQUFJLEdBQUcsRUFBRSxJQUFJLElBQUksS0FBSyxNQUFNLENBQUMsR0FBRyxJQUFJLEtBQUssTUFBTSxDQUFDLEdBQUcsS0FBSyxJQUFJLEdBQUcsS0FBSyxJQUFJO0dBQ3RILEtBQUssSUFBSSxLQUFLLEdBQUcsS0FBSyxHQUFHLE1BQU0sS0FBSyxJQUFJLEtBQUssR0FBRyxLQUFLLEdBQUcsTUFBTTtJQUM1RCxJQUFJLElBQUksSUFBSSxJQUFJLElBQUksSUFBSTtJQUN4QixJQUFJLFFBQVE7S0FBRSxLQUFNLElBQUksRUFBRSxJQUFLLEVBQUUsS0FBSyxFQUFFO0tBQUcsSUFBSSxNQUFNLEdBQUcsR0FBRyxFQUFFLElBQUksQ0FBQztJQUFHLE9BQ2hFLElBQUksSUFBSSxLQUFLLElBQUksS0FBSyxLQUFLLEVBQUUsS0FBSyxLQUFLLEVBQUUsR0FBRztJQUNqRCxNQUFNLElBQUksVUFBVSxFQUFFLEtBQUssSUFBSSxFQUFFLElBQUksS0FBSyxLQUFLLElBQUksRUFBRSxJQUFJLEtBQUssR0FBRyxJQUFJLFVBQVUsVUFBVSxFQUFFO0lBQzNGLE1BQU0sSUFBSSxFQUFFLElBQUksTUFBTSxLQUFLLEtBQUssSUFBSSxPQUFPLEtBQUssS0FBSyxJQUFJO0lBQ3pELEtBQUssRUFBRSxLQUFLO0lBQUcsS0FBSyxFQUFFLElBQUksS0FBSztJQUFHLEtBQUssRUFBRSxJQUFJLEtBQUs7SUFBRyxLQUFLO0dBQzVEO0VBQ0Y7RUFDQSxJQUFJLEtBQUssTUFBTTtFQUNmLE1BQU0sTUFBTSxLQUFLLE1BQU0sSUFBSSxJQUFJLEdBQUcsTUFBTSxPQUFPLE1BQU0sT0FBTyxJQUFJLE9BQU8sT0FBTyxJQUFJLFFBQVE7RUFDMUYsSUFBSSxLQUFLLElBQUk7RUFBRyxJQUFJLElBQUksS0FBSyxJQUFJO0VBQUcsSUFBSSxJQUFJLEtBQUssSUFBSTtFQUFHLElBQUksSUFBSSxLQUFLLEdBQUcsSUFBSSxLQUFLLElBQUk7RUFDckYsTUFBTTtDQUNSO0NBQ0EsT0FBTyxNQUFNLE1BQU07QUFDckI7O0FBR0EsT0FBTyxTQUFTLHVCQUF1QixJQUFlLEdBQVMsT0FBZSxRQUFnQjtDQUM1RixhQUFhLElBQUksR0FBRyxDQUFDLEVBQUU7Q0FDdkIsTUFBTSxPQUFPLE9BQU8sT0FBTyxJQUFJLFVBQVUsS0FBSyxNQUFNLEtBQUssS0FBSyxLQUFLLEtBQUssT0FBTyxNQUFNLFFBQVEsR0FBRyxDQUFDO0NBQ2pHLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxJQUFJLEtBQUs7RUFDM0IsTUFBTSxJQUFJLE1BQU0sVUFBVSxHQUFHLFFBQVEsSUFBSSxHQUFHLE9BQU8sT0FBTyxTQUFTLENBQUMsR0FBRyxJQUFJLE9BQU8sT0FBTztFQUN6RixNQUFNLFFBQVEsS0FBSyxJQUFJLEVBQUUsR0FBRyxHQUFHLEdBQUcsS0FBSyxFQUFFLEtBQUssT0FBTyxNQUFNLFFBQVEsR0FBRztFQUN0RSxNQUFNLE9BQU8sUUFBUSxjQUFjLEtBQUssSUFBSSxVQUFVLEtBQUssS0FBSyxRQUFRLFdBQVcsQ0FBQyxJQUFJO0VBQ3hGLEdBQUcsSUFBSSxLQUFLO0VBQUcsR0FBRyxLQUFLLEtBQUs7RUFBTSxHQUFHLEtBQUssS0FBSyxPQUFPLElBQUksUUFBUSxPQUFPO0VBQ3pFLEdBQUcsRUFBRSxNQUFNLEdBQUcsRUFBRSxLQUFLLEtBQUssTUFBTSxFQUFFLEtBQUssSUFBSSxLQUFLLE1BQU07RUFDdEQsR0FBRyxFQUFFLE1BQU0sS0FBSyxLQUFLLElBQUksR0FBRyxFQUFFLE1BQU0sRUFBRSxJQUFJLEtBQUssS0FBSztDQUN0RDtBQUNGOztBQUdBLE9BQU8sU0FBUyx1QkFBdUIsS0FBcUMsSUFBMkMsVUFBd0IsTUFBZSxVQUFVLE9BQU87Q0FDN0ssS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLElBQUksS0FBSztFQUMzQixNQUFNLE1BQU0sS0FBSyxNQUFNLElBQUksSUFBSSxHQUFHLE1BQU0sT0FBTyxNQUFNLE9BQU8sSUFBSSxPQUFPLE9BQU8sSUFBSSxRQUFRO0VBQzFGLElBQUksV0FBVyxTQUFTLEtBQUssS0FBTTtHQUFFLElBQUksS0FBSyxJQUFJLElBQUksS0FBSyxJQUFJLElBQUksS0FBSyxJQUFJLElBQUksS0FBSztFQUFHO0VBQ3hGLE1BQU0sS0FBSyxLQUFLLElBQUksTUFBTSxLQUFLO0VBQy9CLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSTtFQUNmLE1BQU0sSUFBSSxJQUFJLElBQUksS0FBSyxLQUFLLElBQUksSUFBSSxLQUFLLElBQUk7RUFDN0MsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLEdBQUcsS0FBSyxJQUFJLElBQUksTUFBTSxHQUFHLElBQUksS0FBSyxJQUFJLElBQUksSUFBSSxLQUFLLEtBQUssSUFBSSxNQUFNO0VBQ3RGLElBQUksSUFBSSxLQUFLLElBQUk7Q0FDbkI7QUFDRjtBQUtBLE9BQU8sTUFBTSxZQUFZLE9BQ3RCO0NBQUUsT0FBTztDQUFNLE9BQU87Q0FBTSxRQUFRLE1BQU0sSUFBSTtDQUFJLE9BQU8sT0FBTyxNQUFNLElBQUk7Q0FBSSxRQUFRLE9BQU8sS0FBSztDQUFHLFFBQVE7QUFBSztBQUNySCxPQUFPLE1BQU0sZUFBZSxPQUN6QjtDQUFFLE9BQU87Q0FBWSxPQUFPO0NBQVksUUFBUSxLQUFLO0NBQUcsT0FBTyxhQUFhLEtBQUs7Q0FBRyxRQUFRLGFBQWEsS0FBSztDQUFHLFFBQVE7QUFBTTtBQUNsSSxNQUFNLGNBQWMsT0FBa0I7Q0FBRSxPQUFPLEVBQUU7Q0FBRyxPQUFPLEVBQUU7Q0FBRyxRQUFRO0NBQUcsT0FBTyxFQUFFO0NBQUcsUUFBUSxFQUFFO0NBQUcsUUFBUTtBQUFNOzs7OztBQU1sSCxPQUFPLE1BQU0sWUFBWSxLQUFLOztBQUc5QixPQUFPLFNBQVMsV0FBVyxLQUFrRDtDQUMzRSxNQUFNLElBQUksS0FBSyxNQUFNLE1BQU0sU0FBUyxHQUFHLFFBQVEsTUFBTSxJQUFJLFdBQVcsSUFBSSxNQUFNLElBQUk7Q0FDbEYsT0FBTztFQUFFO0VBQUcsR0FBRyxRQUFRO0VBQUcsR0FBRyxLQUFLLE1BQU0sUUFBUSxDQUFDO0NBQUU7QUFDckQ7Ozs7Ozs7Ozs7QUFjQSxPQUFPLE1BQU0sVUFBVTtDQUNyQixDQUFTLEdBQUksSUFBSSxhQUFhLEVBQUU7Q0FDaEMsQ0FBUyxHQUFJLElBQUksYUFBYSxFQUFFO0NBQ2hDLENBQVMsR0FBSSxJQUFJLGFBQWEsRUFBRTtDQUNoQyxDQUFTLEdBQUksSUFBSSxhQUFhLEVBQUU7Q0FDaEMsR0FBUyxHQUFNLElBQUksYUFBYSxFQUFFO0NBQ2xDLEdBQVMsR0FBTSxJQUFJLFdBQVcsRUFBRTtDQUNoQyxJQUFTLEdBQU8sSUFBSSxXQUFXLEVBQUU7Q0FDakMsSUFBUyxHQUFPLElBQUksYUFBYSxFQUFFOztDQUVuQyxFQUFTLEdBQUssSUFBSSxhQUFhLEVBQUU7Q0FDakMsT0FBUyxHQUFVLElBQUksV0FBVyxFQUFFO0NBQ3BDLE1BQVMsR0FBUyxJQUFJLGFBQWEsSUFBSTtDQUN2QyxNQUFTLEdBQVMsSUFBSSxhQUFhLElBQUk7QUFDekM7QUFFQSxTQUFTLFFBQVEsSUFBZSxHQUFTO0NBQ3ZDLE1BQU0sUUFBUSxFQUFFLE9BQU8sRUFBRSxRQUFRO0NBQ2pDLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxNQUFNLEtBQUs7RUFBRSxNQUFNLE1BQU0sRUFBRSxRQUFRLElBQUksTUFBTztFQUFNLEdBQUcsT0FBTyxLQUFLLEtBQUssSUFBSSxHQUFHO0VBQUcsR0FBRyxPQUFPLEtBQUssS0FBSyxJQUFJLEdBQUc7Q0FBRztBQUN0STs7Ozs7OztBQVFBLE9BQU8sU0FBUyxZQUFZLEdBQW1CO0NBQzdDLE9BQU8sS0FBSyxlQUFlLElBQUksS0FBSyxJQUFJLElBQUksS0FBSyxLQUFLLEtBQUssS0FBSyxJQUFJLFlBQVksQ0FBQyxDQUFDO0FBQ3BGOztBQUdBLE9BQU8sU0FBUyxhQUFhLElBQWUsR0FBUyxlQUFnQztDQUNuRixRQUFRLElBQUksQ0FBQztDQUNiLE1BQU0sUUFBUSxFQUFFLFFBQVEsRUFBRSxTQUFTLE1BQU0sU0FBUyxnQkFBZ0IsS0FBSyxPQUFPLGdCQUFnQixDQUFDO0NBQy9GLElBQUksTUFBTTtDQUNWLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxNQUFNLEtBQUs7RUFDN0IsTUFBTSxNQUFNLEVBQUUsU0FBUyxJQUFJLE1BQU8sTUFBTSxLQUFLLEtBQUssSUFBSSxHQUFHLEdBQUcsSUFBSSxLQUFLLElBQUksR0FBRztFQUM1RSxLQUFLLElBQUksSUFBSSxHQUFHLElBQUksTUFBTSxLQUFLO0dBQzdCLE1BQU0sSUFBSSxJQUFJLE9BQU8sR0FBRyxJQUFJLEtBQUssR0FBRyxPQUFPLElBQUksSUFBSSxLQUFLLEdBQUcsT0FBTzs7R0FFbEUsTUFBTSxPQUFPLEtBQUssS0FBSyxNQUFNLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0dBQ3ZDLEdBQUcsRUFBRSxLQUFLO0dBQ1YsR0FBRyxFQUFFLEtBQUssS0FBSyxNQUFNLEdBQUcsQ0FBQztHQUN6QixNQUFNLElBQUksT0FBTyxTQUFTLE9BQU8sVUFBVSxPQUFPLEVBQUcsSUFBSTtHQUN6RCxHQUFHLElBQUksS0FBSztHQUNaLElBQUksS0FBSyxHQUFHO0dBQ1osTUFBTTs7Ozs7R0FLTixNQUFNLE9BQU8sS0FBSyxJQUFJLElBQUksSUFBSSxJQUFJLEdBQUcsS0FBSztHQUMxQyxHQUFHLEdBQUcsS0FBSyxLQUFLLElBQUksS0FBSyxJQUFJLEtBQUssSUFBSSxJQUFJLEtBQUssR0FBRyxPQUFPLEVBQUUsR0FBRyxLQUFLLElBQUksR0FBRyxPQUFPLEVBQUUsQ0FBQyxJQUFJLE1BQU0sSUFBSTtHQUNsRyxHQUFHLFFBQVEsS0FBSyxZQUFZLElBQUksS0FBSyxLQUFLLElBQUksQ0FBQztFQUNqRDtDQUNGO0NBQ0EsT0FBTztBQUNUOzs7Ozs7QUFPQSxPQUFPLFNBQVMsV0FBVyxJQUFlLGNBQXNCLEtBQWE7Q0FDM0UsTUFBTSxLQUFlLENBQUMsR0FBRyxLQUFlLENBQUMsR0FBRyxRQUFrQixDQUFDLEdBQUcsUUFBa0IsQ0FBQztDQUNyRixLQUFLLElBQUksSUFBSSxHQUFHLEtBQUssS0FBSyxLQUFLO0VBQzdCLE1BQU0sS0FBSyxPQUFPLE1BQU0sSUFBSSxFQUFFO0VBQzlCLEdBQUcsS0FBTSxPQUFPLE1BQU0sSUFBSSxNQUFPLElBQUksS0FBSyxHQUFHO0VBQzdDLEdBQUcsS0FBTSxPQUFPLEtBQUssSUFBSyxLQUFLLEVBQUU7RUFDakMsTUFBTSxLQUFLLE1BQU0sSUFBSSxhQUFhO0NBQ3BDO0NBQ0EsTUFBTSxFQUFFLEdBQUcsR0FBRyxHQUFHLEdBQUcsS0FBSyxJQUFJLFNBQVMsS0FBSyxNQUFNLFNBQVM7Q0FDMUQsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLElBQUksS0FBSztFQUMzQixJQUFJLElBQUksTUFBTSxHQUFHO0VBQ2pCLE1BQU0sSUFBSSxNQUFNLGVBQWUsUUFBUSxJQUFJLEdBQUcsR0FBRztFQUNqRCxNQUFNLElBQUksS0FBSyxJQUFJLEdBQUcsS0FBSyxNQUFNLElBQUksTUFBTSxFQUFFO0VBQzdDLE1BQU0sSUFBSSxJQUFJLGNBQWMsS0FBSyxJQUFJLFVBQVUsS0FBSyxLQUFLLElBQUksV0FBVyxDQUFDLElBQUk7RUFDN0UsSUFBSSxLQUFLO0VBQUcsS0FBSyxLQUFLO0VBQUcsS0FBSyxLQUFLLElBQUksSUFBSSxJQUFJLElBQUk7RUFDbkQsRUFBRSxNQUFNLEVBQUUsS0FBSyxLQUFLLE1BQU0sR0FBRyxLQUFLO0VBQ2xDLEVBQUUsTUFBTSxLQUFLLEtBQUssSUFBSSxFQUFFLE1BQU0sR0FBRyxLQUFLO0NBQ3hDO0FBQ0Y7O0FBR0EsT0FBTyxTQUFTLGNBQWMsSUFBZSxHQUFTLGNBQXNCLE1BQWMsZUFBZ0M7Q0FDeEgsSUFBSSxDQUFDLGFBQWEsSUFBSSxHQUFHLGFBQWEsR0FBRyxPQUFPO0NBQ2hELFdBQVcsSUFBSSxjQUFjLFFBQVEsY0FBYyxJQUFJLENBQUM7Q0FDeEQsT0FBTztBQUNUO0FBRUEsTUFBTSxXQUFXLGNBQXNCLFNBQWlCLE1BQU0sS0FBSyxJQUFJLGNBQWMsSUFBSSxHQUFHLEdBQUcsY0FBYzs7Ozs7OztBQVE3RyxPQUFPLFNBQVMsY0FBYyxJQUFlLEdBQVMsU0FBaUIsVUFBa0IsT0FBZSxRQUFRLE9BQWdCO0NBQzlILFFBQVEsSUFBSSxDQUFDO0NBQ2IsR0FBRyxJQUFJLEtBQUssQ0FBQztDQUFHLEdBQUcsS0FBSyxLQUFLLENBQUM7Q0FDOUIsTUFBTSxRQUFRLEVBQUUsUUFBUSxFQUFFLFNBQVMsTUFBTSxNQUFNLE9BQU8sUUFBUSxPQUFPLFdBQVc7Q0FDaEYsSUFBSSxNQUFNO0NBQ1YsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLE1BQU0sS0FBSztFQUM3QixNQUFNLE1BQU0sRUFBRSxTQUFTLElBQUksTUFBTyxNQUFNLEtBQUssS0FBSyxJQUFJLEdBQUcsR0FBRyxJQUFJLEtBQUssSUFBSSxHQUFHO0VBQzVFLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxNQUFNLEtBQUs7R0FDN0IsTUFBTSxJQUFJLElBQUksT0FBTyxHQUFHLElBQUksS0FBSyxHQUFHLE9BQU8sSUFBSSxJQUFJLEtBQUssR0FBRyxPQUFPO0dBQ2xFLE1BQU0sTUFBTSxRQUFRLElBQUksSUFBSSxJQUFJO0dBQ2hDLElBQUksSUFBSSxHQUFHLEtBQUssR0FBRyxLQUFLO0dBQ3hCLElBQUksTUFBTSxNQUFNOztJQUVkLE1BQU0sSUFBSyxJQUFJLFNBQVU7SUFDekIsS0FBSyxJQUFJO0lBQUcsTUFBTSxRQUFRLENBQUMsSUFBSSxLQUFLLElBQUk7SUFDeEMsTUFBTSxTQUFTLFVBQVUsS0FBSyxLQUFLLEtBQUssS0FBSyxLQUFLLEVBQUU7SUFDcEQsSUFBSSxPQUFPLE9BQU8sS0FBSyxJQUFJLFFBQVEsUUFBUSxLQUFLLElBQUksS0FBSyxJQUFJLEVBQUUsR0FBRyxLQUFLLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxRQUFRLElBQUksUUFBUSxTQUFTLE1BQU0sRUFBRztHQUMzSDtHQUNBLEdBQUcsRUFBRSxLQUFLO0dBQUksR0FBRyxFQUFFLEtBQUs7R0FBSSxHQUFHLElBQUksS0FBSztHQUN4QyxJQUFJLElBQUksR0FBRyxNQUFNO0VBQ25CO0NBQ0Y7Q0FDQSxPQUFPO0FBQ1Q7O0FBR0EsT0FBTyxTQUFTLFlBQVksSUFBZSxPQUFlLElBQVksSUFBWTtDQUNoRixLQUFLLElBQUksSUFBSSxHQUFHLElBQUksSUFBSSxLQUFLO0VBQzNCLEdBQUcsRUFBRSxNQUFNLEdBQUcsRUFBRSxLQUFLLFNBQVMsS0FBSztFQUNuQyxHQUFHLEVBQUUsTUFBTSxRQUFRLEdBQUcsRUFBRSxNQUFNLEtBQUs7Q0FDckM7QUFDRjtBQUVBLE1BQU0saUJBQWlCLElBQWUsTUFBYztDQUNsRCxNQUFNLElBQUssYUFBYSxLQUFLLElBQUs7Q0FDbEMsWUFBWSxJQUFJLGdCQUFnQixHQUFHLENBQUM7QUFDdEM7O0FBR0EsT0FBTyxTQUFTLGFBQWEsSUFBZSxPQUFlLEtBQThCO0NBQ3ZGLE1BQU0sT0FBaUIsQ0FBQyxHQUFHLE9BQU8sSUFBSSxJQUFZO0NBQ2xELE1BQU0sRUFBRSxHQUFHLEdBQUcsS0FBSyxLQUFLLE1BQU0sU0FBUztDQUN2QyxJQUFJLE9BQU8sQ0FBQztDQUNaLE1BQU0sT0FBTyxRQUFnQjtFQUMzQixJQUFJLFFBQVEsTUFBTSxPQUFPO0VBQ3pCLE9BQU87RUFDUCxJQUFJLEtBQUssSUFBSSxHQUFHLEdBQUcsT0FBTztFQUMxQixJQUFJLEtBQUssVUFBVSxLQUFLLE9BQU87RUFDL0IsS0FBSyxJQUFJLEdBQUc7RUFDWixLQUFLLEtBQUssR0FBRztFQUNiLE9BQU87Q0FDVDtDQUNBLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxJQUFJLEtBQUs7RUFDM0IsSUFBSSxJQUFJLE1BQU0sR0FBRztFQUNqQixNQUFNLElBQUksTUFBTSxJQUFJLEtBQUssT0FBTyxJQUFJLEtBQUssV0FBVyxJQUFJLEtBQUssSUFBSSxJQUFJLEtBQUs7RUFDMUUsTUFBTSxFQUFFLE9BQU8sT0FBTyxRQUFRLE9BQU8sUUFBUSxXQUFXO0VBQ3hELE1BQU0sS0FBSyxFQUFFLEtBQUssTUFBTyxJQUFJLEtBQUssR0FBRyxLQUFLLEtBQUssTUFBTSxFQUFFLEdBQUcsS0FBSyxLQUFLLE1BQU0sTUFBTSxJQUFJLEtBQUssQ0FBQyxJQUFJLEdBQUcsS0FBSyxLQUFLLE1BQU0sRUFBRSxFQUFFO0VBQ3JILElBQUksTUFBTSxLQUFLLE1BQU0sS0FBSyxLQUFLLFNBQVMsS0FBSyxJQUFJLFFBQVE7R0FDdkQsTUFBTSxLQUFNLEtBQUssUUFBUyxHQUFHLEtBQU0sS0FBSyxRQUFTO0dBQ2pELEtBQU0sS0FBSyxRQUFTLE9BQU8sUUFBUyxLQUFLLEtBQUssUUFBUyxPQUFPLElBQUk7SUFBRSxJQUFJLENBQUMsSUFBSSxPQUFPLEtBQUssU0FBUyxFQUFFLEdBQUcsT0FBTztJQUFNO0dBQVU7RUFDaEk7RUFDQSxLQUFLLElBQUksSUFBSSxHQUFHLElBQUksR0FBRyxLQUFLO0dBQzFCLE1BQU0sS0FBSyxLQUFLLE1BQU0sS0FBSyxJQUFJLENBQUM7R0FDaEMsS0FBSyxJQUFJLEtBQUssR0FBRyxLQUFLLEdBQUcsTUFBTTtJQUM3QixJQUFJLElBQUksS0FBSztJQUNiLElBQUksUUFBUSxJQUFJLElBQUksSUFBSSxJQUFJLEtBQUssU0FBUyxTQUFTLElBQUk7U0FDbEQsSUFBSSxJQUFJLEtBQUssS0FBSyxRQUFRO0lBQy9CLE1BQU0sS0FBTSxJQUFJLFFBQVM7SUFDekIsS0FBSyxJQUFJLEtBQUssR0FBRyxLQUFLLEdBQUcsTUFBTTtLQUM3QixJQUFJLElBQUksS0FBSztLQUNiLElBQUksUUFBUTtNQUFFLEtBQUs7TUFBTyxJQUFJLElBQUksR0FBRyxLQUFLO0tBQU8sT0FBTyxJQUFJLElBQUksS0FBSyxLQUFLLE9BQU87S0FDakYsSUFBSSxDQUFDLElBQUksT0FBTyxLQUFLLFVBQVcsSUFBSSxRQUFTLEVBQUUsR0FBRyxPQUFPO0lBQzNEO0dBQ0Y7RUFDRjtDQUNGO0NBQ0EsT0FBTztBQUNUOztBQUdBLElBQUksT0FBTyxHQUFHLE9BQU8sR0FBRyxPQUFPLEdBQUcsT0FBTztBQUV6QyxTQUFTLFVBQVUsR0FBUSxJQUFZLElBQVksR0FBVztDQUM1RCxNQUFNLElBQUksRUFBRTtDQUNaLElBQUksRUFBRSxPQUFPLEdBQUc7RUFDZCxNQUFNLElBQUksRUFBRSxLQUFLLEVBQUUsSUFBSSxNQUFNO0VBQzdCLFFBQVE7RUFBRyxRQUFRO0VBQUcsUUFBUTtFQUFHLFFBQVE7Q0FDM0MsT0FBTyxJQUFJLEVBQUUsT0FBTyxHQUFHO0VBQ3JCLE1BQU0sS0FBSyxLQUFLLEVBQUUsSUFBSSxNQUFNO0VBQzVCLFFBQVEsRUFBRSxLQUFLO0VBQUcsUUFBUSxFQUFFLElBQUksS0FBSztFQUFHLFFBQVEsRUFBRSxJQUFJLEtBQUs7RUFBRyxRQUFRO0NBQ3hFLE9BQU87RUFDTCxNQUFNLEtBQUssS0FBSyxFQUFFLElBQUksTUFBTSxHQUFHLEtBQU0sSUFBSSxFQUFFLElBQUksS0FBTTtFQUNyRCxRQUFRLEVBQUUsS0FBSztFQUFJLFFBQVEsRUFBRSxJQUFJLEtBQUs7RUFBSSxRQUFRLEVBQUUsSUFBSSxLQUFLO0VBQUksUUFBUTtDQUMzRTtBQUNGOzs7Ozs7Ozs7O0FBV0EsT0FBTyxTQUFTLFlBQVksSUFBZSxPQUFlLE1BQWdCLE1BQXNCLFVBQW1CLE1BQW9GO0NBQ3JNLE1BQU0sTUFBTSxJQUFJLGtCQUFrQixLQUFLLENBQUM7Q0FDeEMsTUFBTSxFQUFFLEdBQUcsR0FBRyxLQUFLLEtBQUssTUFBTSxTQUFTO0NBQ3ZDLE1BQU0sUUFBUSxJQUFJLElBQXdCO0NBQzFDLEtBQUssU0FBUyxHQUFHLE1BQU0sTUFBTSxJQUFJLEdBQUcsS0FBSyxFQUFFLENBQUM7Q0FDNUMsSUFBSSxVQUFVLENBQUMsR0FBRyxPQUFtQixNQUFNLE1BQU0sT0FBTyxRQUFRO0NBQ2hFLE1BQU0sVUFBVSxRQUFnQjtFQUM5QixJQUFJLFFBQVEsU0FBUztHQUFFLFVBQVU7R0FBSyxPQUFPLE1BQU0sSUFBSSxHQUFHLEtBQUs7RUFBTTtFQUNyRSxPQUFPO0NBQ1Q7Q0FDQSxJQUFJLElBQUksTUFBTSxJQUFJLE9BQU87O0NBRXpCLE1BQU0sVUFBVSxHQUFXLEdBQVcsTUFBYztFQUNsRCxJQUFJLEtBQUssR0FBRztFQUNaLElBQUksRUFBRSxRQUFRO0dBQUUsS0FBSyxFQUFFO0dBQU8sSUFBSSxJQUFJLEdBQUcsS0FBSyxFQUFFO0dBQU8sSUFBSSxJQUFJLElBQUksSUFBSSxLQUFLLEVBQUUsU0FBUyxFQUFFLFNBQVMsSUFBSTtFQUFHLE9BQ3BHLElBQUksSUFBSSxLQUFLLElBQUksS0FBSyxLQUFLLEVBQUUsU0FBUyxLQUFLLEVBQUUsUUFBUTtFQUMxRCxNQUFNLEtBQU0sSUFBSSxFQUFFLFFBQVMsR0FBRyxLQUFNLElBQUksRUFBRSxRQUFTLEdBQUcsSUFBSSxPQUFPLE9BQU8sS0FBSyxFQUFFLFNBQVMsRUFBRTtFQUMxRixJQUFJLEdBQUcsVUFBVSxHQUFHLElBQUksS0FBSyxFQUFFLE9BQU8sSUFBSSxLQUFLLEVBQUUsT0FBTyxDQUFDO0NBQzNEOztDQUVBLE1BQU0sT0FBTyxJQUFZLE9BQWU7RUFDdEMsTUFBTSxLQUFLLEtBQUssTUFBTSxFQUFFLEdBQUcsS0FBSyxLQUFLLE1BQU0sRUFBRSxHQUFHLEtBQUssS0FBSyxJQUFJLEtBQUssS0FBSzs7RUFFeEUsSUFBSSxNQUFNLEtBQUssTUFBTSxLQUFLLEtBQUssSUFBSSxFQUFFLFNBQVMsS0FBSyxJQUFJLEVBQUUsUUFBUTtHQUMvRCxNQUFNLEtBQU0sS0FBSyxFQUFFLFFBQVMsR0FBRyxLQUFNLEtBQUssRUFBRSxRQUFTLEdBQUcsS0FBSyxLQUFLLEtBQUssRUFBRSxPQUFPLEtBQUssS0FBSyxLQUFLLEVBQUU7R0FDakcsSUFBSSxLQUFLLEVBQUUsUUFBUSxLQUFLLEtBQUssRUFBRSxRQUFRLEdBQUc7SUFDeEMsTUFBTSxJQUFJLE9BQU8sT0FBTyxLQUFLLEVBQUUsU0FBUyxFQUFFO0lBQzFDLElBQUksQ0FBQyxHQUFHO0lBQ1IsSUFBSSxFQUFFLE9BQU8sR0FBRztLQUNkLE1BQU0sSUFBSSxFQUFFLE1BQU0sS0FBSyxFQUFFLElBQUksS0FBSyxLQUFLLEVBQUUsSUFBSSxNQUFNLElBQUksSUFBSSxJQUFJLElBQUksSUFBSSxJQUFJLEVBQUUsSUFBSSxJQUFJLElBQUksSUFBSTtLQUM3RixNQUFNLE9BQU8sSUFBSSxPQUFPLElBQUksS0FBSyxNQUFNLE1BQU0sSUFBSSxLQUFLLE9BQU8sSUFBSSxNQUFNLElBQUksTUFBTSxLQUFLO0tBQ3RGLE1BQU0sSUFBSSxFQUFFLEtBQUssTUFBTSxFQUFFLEtBQUssTUFBTSxFQUFFLEtBQUssTUFBTSxFQUFFLEtBQUs7S0FDeEQsSUFBSSxPQUFPLEdBQUc7TUFBRSxRQUFRO01BQUcsUUFBUTtNQUFHLFFBQVE7S0FBRyxPQUM1QztNQUNILFFBQVE7TUFDUixRQUFRLEVBQUUsSUFBSSxLQUFLLE1BQU0sRUFBRSxJQUFJLEtBQUssTUFBTSxFQUFFLElBQUksS0FBSyxNQUFNLEVBQUUsSUFBSSxLQUFLO01BQ3RFLFFBQVEsRUFBRSxJQUFJLEtBQUssTUFBTSxFQUFFLElBQUksS0FBSyxNQUFNLEVBQUUsSUFBSSxLQUFLLE1BQU0sRUFBRSxJQUFJLEtBQUs7S0FDeEU7S0FDQSxRQUFRO0tBQ1I7SUFDRjtHQUNGO0VBQ0Y7RUFDQSxPQUFPLElBQUksS0FBSyxJQUFJLE9BQU8sSUFBSSxHQUFHO0VBQ2xDLE9BQU8sS0FBSyxHQUFHLElBQUksTUFBTSxJQUFJLEdBQUc7RUFDaEMsT0FBTyxJQUFJLEtBQUssSUFBSSxJQUFJLE1BQU0sRUFBRTtFQUNoQyxPQUFPLEtBQUssR0FBRyxLQUFLLEdBQUcsS0FBSyxFQUFFO0NBQ2hDO0NBQ0EsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLE1BQU0sS0FBSztFQUM3QixNQUFNLE9BQU8sV0FBVyxJQUFJLE9BQU8sSUFBSSxLQUFLO0VBQzVDLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxNQUFNLEtBQUs7R0FDN0IsTUFBTSxJQUFJLElBQUksT0FBTyxHQUFHLEtBQUssSUFBSTtHQUNqQyxJQUFJLE1BQU0sR0FBRztJQUFFLFFBQVE7SUFBTTtHQUFVO0dBQ3ZDLElBQUksTUFBTSxJQUFJO0dBQUssT0FBTyxJQUFJLEtBQUs7R0FDbkMsT0FBTyxPQUFPLE9BQU8sT0FBTztHQUM1QixNQUFNLElBQUksS0FBSyxJQUFJLEtBQUssRUFBRSxJQUFJLElBQUksSUFBSSxJQUFJLEtBQUssS0FBSyxHQUFHLEtBQUssRUFBRSxLQUFLLE1BQU8sSUFBSSxLQUFLO0dBQ25GLE1BQU0sS0FBSyxLQUFLLE1BQU0sRUFBRSxHQUFHLEtBQUssS0FBSyxNQUFNLE1BQU0sSUFBSSxLQUFLLENBQUMsSUFBSSxHQUFHLEtBQUssS0FBSyxNQUFNLEVBQUU7R0FDcEYsTUFBTSxLQUFNLEtBQUssRUFBRSxRQUFTLEdBQUcsS0FBTSxLQUFLLEVBQUUsUUFBUztHQUNyRCxNQUFNLE1BQU0sTUFBTSxLQUFLLE1BQU0sS0FBSyxLQUFLLEVBQUUsU0FBUyxLQUFLLElBQUksRUFBRSxXQUFZLEtBQUssRUFBRSxRQUFTLE9BQU8sUUFBUyxLQUFLLEtBQUssRUFBRSxRQUFTLE9BQU8sS0FDakksT0FBTyxPQUFPLEtBQUssRUFBRSxTQUFTLEVBQUUsSUFBSTtHQUN4QyxJQUFJLFFBQVEsTUFBTTtJQUFFLFFBQVE7SUFBTTtHQUFVO0dBQzVDLElBQUksT0FBTyxJQUFJLE9BQU8sR0FBRzs7SUFFdkIsTUFBTSxJQUFJLElBQUksTUFBTSxLQUFLLElBQUksSUFBSSxLQUFLLEtBQUssSUFBSSxPQUFPLEtBQUssS0FBSyxFQUFFLFNBQVMsSUFBSSxJQUFJLEtBQUssRUFBRSxTQUFTLElBQUksS0FBSyxLQUFLLElBQUksSUFBSTtJQUN6SCxLQUFLLElBQUksSUFBSSxHQUFHLElBQUksR0FBRyxLQUFLO0tBQzFCLE1BQU0sS0FBSyxLQUFLLElBQUksR0FBRyxJQUFJLEtBQUssTUFBTSxFQUFFLEdBQUcsS0FBSyxLQUFLLEdBQUcsSUFBSSxLQUFLLElBQUksSUFBSSxJQUFJLEtBQUssSUFBSTtLQUN0RixNQUFNLE9BQU8sSUFBSSxPQUFPLElBQUksS0FBSyxNQUFNLE1BQU0sSUFBSSxLQUFLLE9BQU8sSUFBSSxNQUFNLElBQUksTUFBTSxLQUFLO0tBQ3RGLE1BQU0sSUFBSSxFQUFFLEtBQUssTUFBTSxFQUFFLElBQUksTUFBTSxNQUFNLEVBQUUsS0FBSyxNQUFNLEVBQUUsSUFBSSxNQUFNO0tBQ2xFLElBQUksT0FBTyxHQUFHO01BQUUsUUFBUTtNQUFHLFFBQVE7TUFBRyxRQUFRO0tBQUcsT0FDNUM7TUFDSCxRQUFRO01BQ1IsUUFBUSxFQUFFLElBQUksS0FBSyxNQUFNLEVBQUUsSUFBSSxLQUFLLE1BQU0sRUFBRSxJQUFJLEtBQUssTUFBTSxFQUFFLElBQUksS0FBSztNQUN0RSxRQUFRLEVBQUUsSUFBSSxLQUFLLE1BQU0sRUFBRSxJQUFJLEtBQUssTUFBTSxFQUFFLElBQUksS0FBSyxNQUFNLEVBQUUsSUFBSSxLQUFLO0tBQ3hFO0lBQ0Y7SUFDQSxPQUFPO0dBQ1QsT0FBTztJQUNMLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxHQUFHLEtBQUssSUFBSSxLQUFLLElBQUksR0FBRyxFQUFFO0dBQ2hEO0dBQ0EsSUFBSSxRQUFRLE1BQU07SUFBRSxRQUFRO0lBQU07R0FBVTtHQUM1QyxNQUFNLEtBQUssTUFBTSxLQUFLLEdBQUcsUUFBUyxNQUFNLEtBQUssT0FBUTtHQUNyRCxJQUFJLE1BQU07SUFBRSxNQUFNLElBQUksS0FBSyxHQUFHLE9BQU8sSUFBSTtJQUFHLElBQUksS0FBSztJQUFHLElBQUksSUFBSSxLQUFLO0lBQUcsSUFBSSxJQUFJLEtBQUs7R0FBRyxPQUNuRjtJQUFFLElBQUksS0FBSyxPQUFPO0lBQU0sSUFBSSxJQUFJLEtBQUssT0FBTztJQUFNLElBQUksSUFBSSxLQUFLLE9BQU87R0FBTTtHQUNqRixJQUFJLElBQUksS0FBSztHQUNiLElBQUksUUFBUSxJQUFLLFFBQVE7R0FDekIsTUFBTTtFQUNSO0NBQ0Y7Q0FDQSxJQUFJLENBQUMsS0FBSyxPQUFPO0NBQ2pCLElBQUksT0FBTyxVQUFVLEdBQUc7Q0FDeEIsT0FBTztBQUNUOztBQUdBLE1BQU0sYUFBNkIsQ0FBQztBQUNwQyxLQUFLLElBQUksSUFBSSxRQUFRLEdBQUcsS0FBSyxHQUFHLE1BQU0sR0FBRyxXQUFXLEtBQUssSUFBSSxhQUFhLElBQUksSUFBSSxDQUFDLENBQUM7Ozs7Ozs7O0FBU3BGLE9BQU8sU0FBUyxVQUFVLElBQXVCO0NBQy9DLElBQUksT0FBNEIsTUFBTSxPQUFPO0NBQzdDLEtBQUssTUFBTSxLQUFLLFlBQVk7RUFDMUIsTUFBTSxJQUFJLFFBQVE7RUFDbEIsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLEdBQUcsS0FBSztHQUMxQixLQUFLLElBQUksSUFBSSxHQUFHLElBQUksR0FBRyxLQUFLO0lBQzFCLElBQUksSUFBSSxHQUFHLEtBQUssR0FBRyxJQUFJLEdBQUcsSUFBSTtJQUM5QixLQUFLLElBQUksS0FBSyxHQUFHLEtBQUssR0FBRyxNQUFNO0tBQzdCLEtBQUssSUFBSSxLQUFLLEdBQUcsS0FBSyxHQUFHLE1BQU07TUFDN0IsSUFBSSxNQUFNO09BQ1IsTUFBTSxNQUFNLElBQUksSUFBSSxNQUFNLE9BQU8sSUFBSSxJQUFJLE1BQU07T0FDL0MsS0FBSyxLQUFLO09BQUksTUFBTSxLQUFLLElBQUk7T0FBSSxLQUFLLEtBQUssSUFBSTtPQUFJLEtBQUssS0FBSyxJQUFJO01BQ25FLE9BQU87T0FDTCxNQUFNLE1BQU0sSUFBSSxJQUFJLE1BQU0sT0FBTyxJQUFJLElBQUksTUFBTSxHQUFHLElBQUksR0FBRyxJQUFJO09BQzdELEtBQUssR0FBRyxLQUFLO09BQUcsTUFBTSxHQUFHLElBQUksS0FBSztPQUFHLEtBQUssR0FBRyxJQUFJLEtBQUs7T0FBRyxLQUFLO01BQ2hFO0tBQ0Y7SUFDRjtJQUNBLE1BQU0sS0FBSyxJQUFJLElBQUksS0FBSztJQUN4QixFQUFFLEtBQUs7SUFBRyxFQUFFLElBQUksS0FBSztJQUFJLEVBQUUsSUFBSSxLQUFLO0lBQUcsRUFBRSxJQUFJLEtBQUs7R0FDcEQ7RUFDRjtFQUNBLE9BQU87RUFBRyxPQUFPO0NBQ25CO0NBQ0EsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLE1BQU0sS0FBSztFQUM3QixLQUFLLElBQUksSUFBSSxHQUFHLElBQUksTUFBTSxLQUFLO0dBQzdCLE1BQU0sS0FBSyxJQUFJLE9BQU8sS0FBSztHQUMzQixJQUFJLEdBQUcsSUFBSSxPQUFPLEdBQUc7R0FDckIsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLFdBQVcsUUFBUSxLQUFLO0lBQzFDLE1BQU0sS0FBSyxJQUFJLEdBQUcsTUFBTSxLQUFLLE9BQU8sUUFBUSxPQUFPLEtBQUssT0FBTyxHQUFHLElBQUksV0FBVyxJQUFJLElBQUksRUFBRSxJQUFJO0lBQy9GLElBQUksSUFBSSxHQUFHO0tBQUUsR0FBRyxLQUFLLEVBQUUsS0FBSztLQUFHLEdBQUcsSUFBSSxLQUFLLEVBQUUsSUFBSSxLQUFLO0tBQUcsR0FBRyxJQUFJLEtBQUssRUFBRSxJQUFJLEtBQUs7S0FBRztJQUFPO0dBQzVGO0VBQ0Y7Q0FDRjtBQUNGOztBQUdBLE9BQU8sU0FBUyxTQUFTLElBQWUsR0FBUyxjQUFzQixNQUFjLGVBQW9DO0NBQ3ZILElBQUksQ0FBQyxjQUFjLElBQUksR0FBRyxjQUFjLE1BQU0sYUFBYSxHQUFHLE9BQU87Q0FDckUsTUFBTSxRQUFnQixDQUFDO0NBQ3ZCLEtBQUssSUFBSSxJQUFJLEdBQUcsS0FBSyxRQUFRLGNBQWMsSUFBSSxHQUFHLEtBQUssTUFBTSxLQUFLLFNBQVMsQ0FBQyxDQUFDO0NBQzdFLE1BQU0sT0FBTyxhQUFhLElBQUksT0FBTyxRQUFRLEtBQUssQ0FBQztDQUNuRCxJQUFJLFFBQVE7Q0FDWixLQUFLLE1BQU0sS0FBSyxNQUFNLFFBQVEsS0FBSyxJQUFJLE9BQU8sS0FBSyxNQUFNLElBQUksU0FBUyxDQUFDO0NBQ3ZFLE9BQU87RUFBRTtFQUFPO0VBQU87Q0FBSztBQUM5Qjs7QUFHQSxPQUFPLE1BQU0sbUJBQW1CLENBQUM7O0FBR2pDLE9BQU8sU0FBUyxlQUFlLElBQWUsR0FBUyxjQUFzQixNQUF1QjtDQUNsRyxJQUFJLENBQUMsYUFBYSxJQUFJLEdBQUcsZ0JBQWdCLEdBQUcsT0FBTztDQUNuRCxJQUFJLE1BQU07Q0FDVixLQUFLLElBQUksSUFBSSxHQUFHLElBQUksSUFBSSxLQUFLO0VBQzNCLElBQUksR0FBRyxJQUFJLE1BQU0sR0FBRztFQUNwQixNQUFNLElBQUksYUFBYSxHQUFHLEVBQUUsS0FBSyxHQUFHO0VBQ3BDLEdBQUcsSUFBSSxNQUFNO0VBQ2IsSUFBSSxJQUFJLEdBQUcsTUFBTTtDQUNuQjtDQUNBLElBQUksQ0FBQyxLQUFLLE9BQU87Q0FDakIsV0FBVyxJQUFJLGNBQWMsUUFBUSxjQUFjLElBQUksQ0FBQzs7O0NBR3hELE1BQU0sRUFBRSxHQUFHLEtBQUssS0FBSyxNQUFNLFNBQVM7Q0FDcEMsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLElBQUksS0FBSztFQUMzQixJQUFJLElBQUksTUFBTSxHQUFHO0VBQ2pCLE1BQU0sSUFBSSxJQUFJLElBQUksUUFBUSxPQUFPLE1BQU0sSUFBSSxJQUFJLE9BQU8sTUFBTyxLQUFLLEtBQUssS0FBSyxLQUFLLElBQUksSUFBSSxLQUFLLElBQUksSUFBSSxLQUFLLElBQUksSUFBSTtFQUNuSCxJQUFJLEVBQUUsS0FBSyxPQUFPLEdBQUcsRUFBRSxLQUFLLEtBQUssSUFBSSxJQUFJLE1BQU0sUUFBUSxDQUFDO09BQ25ELElBQUksRUFBRSxLQUFLLE9BQU8sUUFBUSxJQUFJLEdBQUcsRUFBRSxLQUFLLEtBQUssSUFBSSxRQUFRLElBQUksSUFBSSxNQUFNLFFBQVEsQ0FBQztDQUN2RjtDQUNBLE9BQU87QUFDVDs7QUFHQSxPQUFPLFNBQVMsVUFBVSxJQUFlLEdBQVMsY0FBc0IsTUFBMkI7Q0FDakcsSUFBSSxDQUFDLGVBQWUsSUFBSSxHQUFHLGNBQWMsSUFBSSxHQUFHLE9BQU87Q0FDdkQsTUFBTSxRQUFnQixDQUFDO0NBQ3ZCLEtBQUssSUFBSSxJQUFJLEdBQUcsS0FBSyxRQUFRLGNBQWMsSUFBSSxHQUFHLEtBQUssTUFBTSxLQUFLLFNBQVMsQ0FBQyxDQUFDO0NBQzdFLE1BQU0sT0FBTyxhQUFhLElBQUksT0FBTyxRQUFRLEtBQUssQ0FBQztDQUNuRCxJQUFJLFFBQVE7Q0FDWixLQUFLLE1BQU0sS0FBSyxNQUFNLFFBQVEsS0FBSyxJQUFJLE9BQU8sS0FBSyxNQUFNLElBQUksU0FBUyxDQUFDO0NBQ3ZFLE9BQU87RUFBRTtFQUFPO0VBQU87Q0FBSztBQUM5Qjs7Ozs7QUFNQSxPQUFPLFNBQVMsWUFBWSxJQUFlLEdBQVMsY0FBc0IsTUFBMkI7Q0FDbkcsTUFBTSxLQUFLLEtBQUssSUFBSSxnQkFBZ0IsWUFBWSxHQUFHLGVBQWUsQ0FBQyxDQUFDO0NBQ3BFLElBQUksS0FBSyxNQUFNLE9BQU87Q0FDdEIsSUFBSSxDQUFDLGNBQWMsSUFBSSxHQUFHLFNBQVMsZUFBZSxHQUFHLGlCQUFpQixjQUFjLEdBQUcsT0FBTztDQUM5RixLQUFLLElBQUksSUFBSSxLQUFNLEtBQUs7RUFDdEIsY0FBYyxJQUFJLENBQUM7RUFDbkIsTUFBTSxRQUFRLENBQUMsWUFBWSxDQUFDLENBQUMsR0FBRyxPQUFPLGFBQWEsSUFBSSxPQUFPLElBQUksT0FBTyxvQkFBb0IsUUFBUTtFQUN0RyxJQUFJLE1BQU0sT0FBTztHQUFFLE9BQU87R0FBRztHQUFPO0VBQUs7Q0FDM0M7QUFDRjs7QUFHQSxPQUFPLFNBQVMsaUJBQWlCLElBQWUsR0FBUyxHQUFXO0NBQ2xFLGNBQWMsSUFBSSxHQUFHLFNBQVMsZUFBZSxHQUFHLGlCQUFpQixjQUFjO0NBQy9FLGNBQWMsSUFBSSxDQUFDO0FBQ3JCOztBQUdBLE9BQU8sU0FBUyxXQUFXLElBQWUsR0FBUyxRQUFnQixPQUFlLGdCQUF3QixVQUFzRDtDQUM5SixJQUFJLENBQUMsY0FBYyxJQUFJLEdBQUcsU0FBUyxjQUFjLEdBQUcsVUFBVSxLQUFLLEdBQUcsT0FBTztDQUM3RSxNQUFNLE9BQVEsRUFBRSxRQUFRLEVBQUUsU0FBUyxPQUFRLFFBQVEsT0FBTyxPQUFPLE9BQU87Q0FDeEUsTUFBTSxJQUFJLE1BQU0sS0FBSyxNQUFNLEtBQUssS0FBSyxPQUFRLElBQUksUUFBUyxLQUFLLEVBQUUsQ0FBQyxHQUFHLEdBQUcsT0FBTyxPQUFPLFNBQVMsQ0FBQztDQUNoRyxNQUFNLE1BQU0sT0FBTyxPQUFPO0NBQzFCLFlBQVksSUFBSSxPQUFPLElBQUksS0FBSyxJQUFJLFFBQVEsSUFBSSxLQUFLLElBQUksTUFBTTtDQUMvRCxPQUFPO0VBQUUsT0FBTyxDQUFDLFdBQVcsR0FBRyxDQUFDO0VBQUc7Q0FBSTtBQUN6Qzs7QUFHQSxPQUFPLFNBQVMsVUFBVSxNQUFXLFFBQVEsVUFBVSxZQUFZLE9BQWU7Q0FDaEYsTUFBTSxTQUFTLENBQUMsSUFBSTtDQUNwQixLQUFLLElBQUksSUFBSSxNQUFNLEtBQUssSUFBSSxFQUFFLEdBQUcsRUFBRSxDQUFDLElBQUksTUFBTSxPQUFPLFVBQVUsUUFBUztFQUFFLElBQUksYUFBYSxFQUFFLE9BQU8sSUFBSSxlQUFlLENBQUMsSUFBSSxNQUFNLENBQUM7RUFBRyxPQUFPLEtBQUssQ0FBQztDQUFHO0NBQ3RKLE9BQU8sRUFBRSxPQUFPO0FBQ2xCOzs7Ozs7O0FBUUEsT0FBTyxTQUFTLGVBQWUsR0FBYTtDQUMxQyxNQUFNLElBQUksRUFBRSxLQUFLLEdBQUcsSUFBSSxFQUFFLEtBQUssR0FBRyxJQUFJLEVBQUUsR0FBRyxJQUFJLEVBQUUsTUFBTSxNQUFNLElBQUksV0FBVyxJQUFJLENBQUM7Q0FDakYsTUFBTSxNQUFNLElBQUksYUFBYSxJQUFJLElBQUksQ0FBQztDQUN0QyxLQUFLLElBQUksSUFBSSxHQUFHLElBQUksR0FBRyxLQUFLO0VBQzFCLE1BQU0sS0FBSyxJQUFJLElBQUksR0FBRyxLQUFLLEtBQUssSUFBSSxJQUFJLElBQUksR0FBRyxFQUFFLElBQUksQ0FBQyxJQUFJO0VBQzFELEtBQUssSUFBSSxJQUFJLEdBQUcsTUFBTSxHQUFHLElBQUksSUFBSSxHQUFHLEtBQUs7R0FBRSxNQUFNLElBQUksSUFBSTtHQUFHLFFBQVEsRUFBRSxLQUFLLEtBQUssRUFBRSxLQUFLLE1BQU07R0FBSyxJQUFJLElBQUksS0FBSztFQUFLO0VBQ3BILE1BQU0sT0FBTyxNQUFPLElBQUksTUFBTyxNQUFPLEtBQUssS0FBSyxJQUFJLEtBQUssSUFBSSxHQUFHLElBQUksS0FBSyxJQUFJLEtBQUssSUFBSSxHQUFHLEdBQUcsSUFBSSxDQUFDO0VBQ2pHLE1BQU0sTUFBTSxNQUFjO0dBQUUsTUFBTSxJQUFJLEtBQUssTUFBTSxDQUFDO0dBQUcsT0FBTyxJQUFJLE1BQU0sSUFBSSxNQUFNLElBQUksS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLENBQUMsS0FBSyxJQUFJO0VBQUs7RUFDdkgsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLEdBQUcsS0FBSztHQUMxQixNQUFNLElBQUksSUFBSSxJQUFJLElBQUk7R0FDdEIsSUFBSSxJQUFJLElBQUksS0FBSyxLQUFLLE9BQU8sR0FBRyxJQUFJLElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSSxJQUFJLENBQUMsS0FBSyxDQUFDO0VBQ2pFO0NBQ0Y7Q0FDQSxPQUFPO0VBQUU7RUFBRztFQUFHLElBQUk7RUFBRyxNQUFNO0NBQUk7QUFDbEM7Ozs7OztBQU9BLE9BQU8sU0FBUyxRQUFRLEtBQVUsSUFBWSxJQUFZLFVBQTBEO0NBQ2xILElBQUksS0FBSyxLQUFLLEtBQUssS0FBSyxLQUFLLE9BQU8sSUFBSSxLQUFLLEtBQUssT0FBTyxJQUFJLEtBQUssSUFBSSxPQUFPLEdBQUcsT0FBTztDQUN2RixNQUFNLE1BQU0sSUFBSSxrQkFBa0IsS0FBSyxDQUFDLEdBQUcsSUFBSSxJQUFJLE1BQU0sS0FBSyxJQUFJO0NBQ2xFLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxNQUFNLEtBQUs7RUFDN0IsSUFBSSxLQUFLLFdBQVcsSUFBSSxPQUFPLElBQUksS0FBSyxPQUFPLEdBQUcsTUFBTSxLQUFLLEtBQUssSUFBSSxJQUFJLE1BQU07RUFDaEYsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLE1BQU0sS0FBSyxLQUFLLEdBQUcsS0FBSyxJQUFJO0dBQzlDLElBQUksS0FBSyxFQUFFO0dBQUksSUFBSSxJQUFJLEtBQUssT0FBTyxJQUFJLEVBQUUsS0FBSyxFQUFFLElBQUk7R0FBSSxJQUFJLElBQUksS0FBSyxPQUFPLElBQUksRUFBRSxLQUFLLEVBQUUsSUFBSTtHQUFJLElBQUksSUFBSSxLQUFLO0VBQ2hIO0NBQ0Y7Q0FDQSxPQUFPO0FBQ1Q7QUFFQSxTQUFTLE1BQU0sR0FBYTtDQUMxQixNQUFNLElBQUksS0FBSyxJQUFJLEdBQUcsRUFBRSxLQUFLLENBQUMsR0FBRyxJQUFJLEtBQUssSUFBSSxHQUFHLEVBQUUsS0FBSyxDQUFDLEdBQUcsS0FBSyxFQUFFLElBQUksSUFBSSxFQUFFLE1BQU0sS0FBSyxFQUFFO0NBQzFGLE1BQU0sTUFBTSxJQUFJLFdBQVcsSUFBSSxJQUFJLEVBQUU7Q0FDckMsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLEdBQUcsS0FBSztFQUMxQixNQUFNLEtBQUssS0FBSyxJQUFJLElBQUksR0FBRyxFQUFFLElBQUksQ0FBQyxJQUFJLElBQUksS0FBSyxLQUFLLElBQUksSUFBSSxJQUFJLEdBQUcsRUFBRSxJQUFJLENBQUMsSUFBSTtFQUM5RSxLQUFLLElBQUksSUFBSSxHQUFHLElBQUksR0FBRyxLQUFLO0dBQzFCLE1BQU0sS0FBSyxLQUFLLElBQUksSUFBSSxHQUFHLEtBQUssQ0FBQyxHQUFHLEtBQUssS0FBSyxJQUFJLElBQUksSUFBSSxHQUFHLEtBQUssQ0FBQztHQUNuRSxNQUFNLE1BQU0sS0FBSyxNQUFNLElBQUksTUFBTSxLQUFLLE1BQU0sSUFBSSxNQUFNLEtBQUssTUFBTSxJQUFJLE1BQU0sS0FBSyxNQUFNLElBQUksS0FBSyxJQUFJLElBQUksS0FBSztHQUM1RyxJQUFJLE9BQU8sR0FBRztJQUNaLE1BQU0sS0FBSyxFQUFFLEtBQUssSUFBSSxLQUFLLEVBQUUsS0FBSyxJQUFJLEtBQUssRUFBRSxLQUFLLElBQUksS0FBSyxFQUFFLEtBQUssSUFBSSxJQUFJLEtBQUssS0FBSyxLQUFLO0lBQ3pGLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxHQUFHLEtBQUssSUFBSSxJQUFJLEtBQUssSUFBSSxJQUFJLEtBQUssT0FBTyxFQUFFLEtBQUssS0FBSyxLQUFLLEVBQUUsS0FBSyxLQUFLLEtBQUssRUFBRSxLQUFLLEtBQUssS0FBSyxFQUFFLEtBQUssS0FBSyxNQUFNLENBQUMsSUFBSTtJQUN2SSxJQUFJLElBQUksS0FBTSxJQUFJLEtBQU07R0FDMUIsT0FBTztJQUNMLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxJQUFJLEtBQUssSUFBSSxJQUFJLEtBQU0sRUFBRSxLQUFLLEtBQUssRUFBRSxLQUFLLEtBQUssRUFBRSxLQUFLLEtBQUssRUFBRSxLQUFLLEtBQUssS0FBTTtHQUNuRztFQUNGO0NBQ0Y7Q0FDQSxPQUFPO0VBQUU7RUFBRztFQUFHO0VBQUksTUFBTTtDQUFJO0FBQy9COzs7OztBQU1BLE9BQU8sTUFBTSxPQUFPO0NBQ2xCLEtBQWdCO0NBQ2hCO0NBQ0EsQ0FBaUI7Q0FDakIsQ0FBaUI7Q0FDakIsWUFBWSxHQUFXLEdBQVc7RUFBRSxLQUFLLElBQUk7RUFBRyxLQUFLLElBQUk7RUFBRyxLQUFLLE9BQU8sSUFBSSxXQUFXLElBQUksQ0FBQztDQUFHOztDQUcvRixJQUFJLElBQXVCLElBQVk7RUFDckMsS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLEdBQUcsUUFBUSxLQUFLLEdBQUcsTUFBTTtHQUMzQyxNQUFNLElBQUksR0FBRyxJQUFJLElBQUksR0FBRyxJQUFJLElBQUksSUFBSSxHQUFHLElBQUksSUFBSSxJQUFJLEdBQUcsSUFBSTtHQUMxRCxJQUFJLEtBQUssT0FBTyxHQUFHO0lBQ2pCLElBQUksTUFBTSxPQUFPLE1BQU0sS0FBSyxNQUFNLEdBQUc7S0FBRSxLQUFLLEtBQUssTUFBTTtLQUFHO0lBQVU7SUFDcEUsS0FBSyxNQUFNLE1BQU0sTUFBTSxJQUFJLEdBQUcsRUFBRTtHQUNsQztHQUNBLElBQUksS0FBSyxPQUFPLEdBQUc7SUFDakIsSUFBSSxNQUFNLEtBQUs7S0FBRSxNQUFNLElBQUksS0FBSztLQUFHLEtBQUssS0FBSyxLQUFLO0tBQUcsS0FBSyxLQUFLLElBQUksS0FBSztLQUFHLEtBQUssS0FBSyxJQUFJLEtBQUs7S0FBRztJQUFVO0lBQzNHLEtBQUssTUFBTSxHQUFHLEVBQUU7R0FDbEI7R0FDQSxNQUFNLElBQUksS0FBSyxHQUFHLElBQUksS0FBSztHQUMzQixFQUFFLEtBQUs7R0FBRyxFQUFFLElBQUksS0FBSztHQUFHLEVBQUUsSUFBSSxLQUFLO0dBQUcsRUFBRSxJQUFJLEtBQUs7RUFDbkQ7Q0FDRjs7Q0FHQSxLQUFRLENBQU0sSUFBVyxRQUFnQjtFQUN2QyxNQUFNLE9BQU8sS0FBSyxJQUFJLE1BQU0sS0FBSyxNQUFNLEtBQUssSUFBSSxXQUFXLEtBQUssSUFBSSxLQUFLLElBQUksRUFBRTtFQUMvRSxLQUFLLElBQUksSUFBSSxHQUFHLElBQUksUUFBUSxLQUFLO0dBQy9CLE1BQU0sSUFBSSxJQUFJLE1BQU0sSUFBSSxJQUFJO0dBQzVCLEdBQUcsS0FBSyxJQUFJO0dBQUksR0FBRyxJQUFJLEtBQUssSUFBSSxTQUFTLElBQUksSUFBSSxJQUFJO0dBQUksR0FBRyxJQUFJLEtBQUssSUFBSSxTQUFTLElBQUksSUFBSSxJQUFJO0dBQzlGLElBQUksT0FBTyxHQUFHLEdBQUcsSUFBSSxLQUFLLFNBQVMsSUFBSSxJQUFJLElBQUksS0FBSztFQUN0RDtFQUNBLEtBQUssT0FBTztFQUNaLEtBQUssS0FBSztDQUNaO0NBRUEsU0FBYztFQUFFLE9BQU87R0FBRSxHQUFHLEtBQUs7R0FBRyxHQUFHLEtBQUs7R0FBRyxJQUFJLEtBQUs7R0FBSSxNQUFNLEtBQUs7RUFBSztDQUFHO0FBQ2pGOztBQXlDQSxPQUFPLE1BQU0sV0FBVzs7O0FBS3hCLE1BQU0sWUFBWTs7OztBQUlsQixNQUFNLGFBQWE7QUFDbkIsTUFBTSxjQUFjO0FBQ3BCLE1BQU0sbUJBQW1COzs7O0FBSXpCLE1BQU0sZ0JBQWdCO0FBQ3RCLE1BQU0sbUJBQW1CLEtBQUssS0FBSzs7OztBQUtuQyxJQUFJLHFCQUFxQixLQUFLLEtBQUssSUFBSSxlQUFlLEdBQUcsbUJBQW1CO0FBQzVFLElBQUksZ0JBQWdCLEdBQUcsZ0JBQWdCO0FBQ3ZDLE1BQU0sVUFBVSxJQUFJLElBQXFFO0FBRXpGLFNBQVMsY0FBYztDQUNyQixPQUFPLGVBQWUsc0JBQXNCLFFBQVEsTUFBTTtFQUN4RCxNQUFNLENBQUMsS0FBSyxTQUFTLFFBQVEsUUFBUSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUM7RUFDOUMsUUFBUSxPQUFPLEdBQUc7RUFBRyxnQkFBZ0IsTUFBTTtFQUFPO0VBQ2xELE1BQU0sTUFBTTtDQUNkO0FBQ0Y7O0FBR0EsT0FBTyxTQUFTLGdCQUFnQixLQUFhLE9BQWUsT0FBbUIsT0FBb0IsUUFBYztDQUMvRyxrQkFBa0IsR0FBRztDQUNyQixNQUFNLE9BQU8sT0FBTyxTQUFTLEtBQUssSUFBSSxLQUFLLElBQUksR0FBRyxLQUFLLElBQUk7Q0FDM0QsUUFBUSxJQUFJLEtBQUs7RUFBRSxPQUFPO0VBQU07RUFBTTtDQUFNLENBQUM7Q0FDN0MsZ0JBQWdCO0NBQ2hCLFlBQVk7QUFDZDs7QUFHQSxPQUFPLFNBQVMsYUFBYSxLQUFzQjtDQUNqRCxNQUFNLFFBQVEsUUFBUSxJQUFJLEdBQUc7Q0FDN0IsSUFBSSxDQUFDLE9BQU8sT0FBTztDQUNuQixRQUFRLE9BQU8sR0FBRztDQUFHLFFBQVEsSUFBSSxLQUFLLEtBQUs7Q0FDM0MsT0FBTztBQUNUOztBQUdBLE9BQU8sU0FBUyxrQkFBa0IsS0FBbUI7Q0FDbkQsTUFBTSxRQUFRLFFBQVEsSUFBSSxHQUFHO0NBQzdCLElBQUksT0FBTztFQUFFLFFBQVEsT0FBTyxHQUFHO0VBQUcsZ0JBQWdCLE1BQU07Q0FBTztBQUNqRTtBQUVBLFNBQVMsb0JBQXVDO0NBQzlDLE1BQU0sY0FBYztFQUFFLE1BQU07RUFBRyxNQUFNO0VBQUcsUUFBUTtFQUFHLE1BQU07Q0FBRSxHQUFHLGNBQWMsRUFBRSxHQUFHLFlBQVk7Q0FDN0YsS0FBSyxNQUFNLFNBQVMsUUFBUSxPQUFPLEdBQUc7RUFBRSxZQUFZLE1BQU0sU0FBUyxNQUFNO0VBQU8sWUFBWSxNQUFNLEtBQUs7Q0FBSTtDQUMzRyxPQUFPO0VBQUUsYUFBYTtFQUFvQixlQUFlO0VBQWMsZUFBZSxRQUFRO0VBQzVGO0VBQWE7RUFBYSxXQUFXO0VBQWtCO0VBQWU7RUFDdEUsYUFBYSxlQUFlLGFBQWEsUUFBUSxhQUFhLFNBQVMsSUFBSTtDQUFFO0FBQ2pGO0FBRUEsU0FBUyxZQUFZLFFBQXdCO0NBQzNDLE1BQU0sVUFBVSxJQUFJLElBQXFCO0NBQ3pDLElBQUksUUFBUTtDQUNaLEtBQUssTUFBTSxPQUFPLE9BQU8sUUFBUSxJQUFJLENBQUMsUUFBUSxJQUFJLElBQUksS0FBSyxNQUFNLEdBQUc7RUFBRSxRQUFRLElBQUksSUFBSSxLQUFLLE1BQU07RUFBRyxTQUFTLElBQUksS0FBSyxPQUFPO0NBQVk7Q0FDekksT0FBTztBQUNUO0FBSUEsTUFBTSxVQUFpQjtDQUFFLElBQUk7Q0FBTSxNQUFNO0FBQU07O0FBRS9DLE1BQU0saUJBQXdCO0NBQUUsSUFBSTtDQUFNLE1BQU07Q0FBTSxRQUFRO0FBQUs7O0FBRW5FLE1BQU0sTUFBZ0M7Q0FBQztDQUFHO0NBQUc7QUFBQzs7QUFFOUMsTUFBTSxVQUErRCxDQUFDOztBQUd0RSxNQUFNLFlBQVksUUFBZ0I7Q0FBRSxNQUFNLElBQUksSUFBSSxRQUFRLEtBQUssSUFBSSxRQUFRLElBQUksSUFBSSxDQUFDO0NBQUcsT0FBTyxJQUFJLElBQUksTUFBTSxJQUFJLE1BQU0sR0FBRyxDQUFDO0FBQUc7QUFFN0gsSUFBSSxZQUFZLEdBQUcsY0FBYztBQUNqQyxNQUFNLGFBQWEsSUFBSSxJQUFvQjtBQUMzQyxNQUFNLGFBQTBFLENBQUM7QUFDakYsTUFBTSxlQUErQixDQUFDOzs7QUFHdEMsTUFBTSxhQUFhLFNBQWlCLEtBQUssU0FBUyxhQUFhLElBQUksZ0NBQWdDO0FBQ25HLE1BQU0sYUFBYSxTQUFpQixLQUFLLFNBQVMsYUFBYSxLQUFLLEtBQUssU0FBUyxhQUFhLElBQUksSUFBSTs7QUFFdkcsU0FBUyxjQUFjLFVBQWlDO0NBQ3RELE1BQU0sUUFBUSxXQUFXLEtBQUs7Q0FDOUIsT0FBTyxPQUFPLFNBQVMsS0FBSyxJQUFJLFFBQVE7QUFDMUM7O0FBR0EsU0FBUyxPQUFPO0NBQ2QsT0FBTyxXQUFXLFVBQVUsWUFBWSxXQUFXO0VBQ2pELElBQUksT0FBTyxDQUFDLEdBQUcsUUFBUTtFQUN2QixLQUFLLElBQUksSUFBSSxHQUFHLElBQUksV0FBVyxRQUFRLEtBQUs7R0FDMUMsTUFBTSxRQUFRLFdBQVc7R0FDekIsS0FBSyxXQUFXLElBQUksTUFBTSxJQUFJLEtBQUssTUFBTSxVQUFVLE1BQU0sSUFBSSxHQUFHO0dBQ2hFLE1BQU0sT0FBTyxjQUFjLE1BQU0sUUFBUTtHQUN6QyxJQUFJLE9BQU8sS0FBSyxPQUFPLE9BQU87SUFBRSxPQUFPO0lBQUcsUUFBUTtHQUFNO0VBQzFEO0VBQ0EsSUFBSSxPQUFPLEdBQUc7RUFDZCxNQUFNLEVBQUUsTUFBTSxPQUFPLFdBQVcsT0FBTyxNQUFNLENBQUMsQ0FBQyxDQUFDLElBQUksT0FBTyxXQUFXLElBQUksSUFBSSxLQUFLO0VBQ25GO0VBQ0EsV0FBVyxJQUFJLE1BQU0sT0FBTyxDQUFDO0VBQzdCLEdBQUc7Q0FDTDtDQUNBLE9BQU8sYUFBYSxVQUFVLGNBQWMsYUFBYTtFQUFFO0VBQWUsYUFBYSxNQUFNLENBQUMsQ0FBRTtDQUFHO0FBQ3JHO0FBQ0EsTUFBTSxjQUFjLE1BQWMsT0FBZ0IsUUFBc0IsYUFBNEIsSUFBSSxTQUFpQixZQUFXO0NBQ2xJLElBQUksUUFBUSxTQUFTO0VBQUUsUUFBUSxLQUFLO0VBQUc7Q0FBUTtDQUMvQyxNQUFNLGdCQUFnQixRQUFRLG9CQUFvQixTQUFTLE1BQU07Q0FDakUsTUFBTSxXQUFXO0VBQUUsUUFBUTtFQUFHLFFBQVEsSUFBSTtDQUFHO0NBQzdDLE1BQU0sUUFBUTtFQUFFO0VBQU07RUFBSTtDQUFTO0NBQ25DLE1BQU0sZUFBZTtFQUNuQixNQUFNLElBQUksUUFBUSxhQUFhLFFBQVEsRUFBRSxJQUFJLFdBQVcsUUFBUSxLQUFLO0VBQ3JFLElBQUksSUFBSSxHQUFHO0VBQ1gsSUFBSSxPQUFPLGFBQWEsT0FBTyxHQUFHLENBQUM7T0FBUSxXQUFXLE9BQU8sR0FBRyxDQUFDO0VBQ2pFLFFBQVE7RUFBRyxRQUFRLEtBQUs7Q0FDMUI7Q0FDQSxRQUFRLGlCQUFpQixTQUFTLFFBQVEsRUFBRSxNQUFNLEtBQUssQ0FBQztDQUN4RCxJQUFJLE9BQU8sYUFBYSxLQUFLLEVBQUU7TUFBUSxXQUFXLEtBQUssS0FBSztDQUM1RCxLQUFLO0FBQ1AsQ0FBQztBQUNELFNBQVMsV0FBVyxNQUFjLE9BQWdCO0NBQ2hELElBQUksT0FBTztNQUFvQjtFQUFFO0VBQWEsV0FBVyxJQUFJLE9BQU8sV0FBVyxJQUFJLElBQUksS0FBSyxLQUFLLENBQUM7Q0FBRztDQUNyRyxLQUFLO0FBQ1A7O0FBR0EsTUFBTSxVQUFVLFFBQWdCO0NBQUUsTUFBTSxJQUFJLDRCQUE0QixLQUFLLFNBQVMsR0FBRyxDQUFDO0NBQUcsT0FBTyxJQUFJLEVBQUUsS0FBSztBQUFLO0FBRXBILE1BQU0sV0FBVyxJQUFJLElBQXFCOzs7QUFJMUMsTUFBTSxlQUFlLElBQUksSUFBWTtBQUNyQyxNQUFNLGFBQWEsSUFBSSxJQUFvQjtBQUMzQyxJQUFJLGVBQWU7QUFDbkIsSUFBSSxZQUFZOztBQUdoQixTQUFTLGFBQWEsSUFBWSxLQUFzQjtDQUN0RCxPQUFPLFlBQVksSUFBSSxJQUFJLEtBQUssWUFBWSxLQUFLLEtBQUssSUFBSSxjQUFjLFdBQVcsSUFBSSxTQUFTLEdBQUcsQ0FBQyxLQUFLLENBQUM7QUFDNUc7QUFFQSxTQUFTLFNBQVMsTUFBYztDQUM5QixJQUFJLGFBQWEsT0FBTyxJQUFJLEdBQUc7RUFBRSxXQUFXLElBQUksTUFBTSxZQUFZLElBQUksQ0FBQztFQUFHLFlBQVk7Q0FBTTtBQUM5Rjs7QUFHQSxNQUFNLE1BQU0sT0FBTyxhQUFhLGVBQWUsU0FBUyxTQUFTLEdBQUcsU0FBUyxPQUFPLEtBQUs7O0FBR3pGLGVBQWUsVUFBVSxLQUFhLFFBQVEsUUFBUSxRQUFRLElBQUksV0FBVyxHQUFHLEdBQUcsUUFBc0IsVUFBMkQ7Q0FDbEssUUFBUSxlQUFlO0NBQ3ZCLE1BQU0sT0FBTyxTQUFTLEdBQUcsR0FBRyxRQUFRLFVBQVUsSUFBSTtDQUNsRCxJQUFJLElBQXlCO0NBQzdCLElBQUksQ0FBQyxPQUFPO0VBQ1YsTUFBTSxPQUFPLE9BQU8sR0FBRztFQUN2QixLQUFLLFNBQVMsSUFBSSxJQUFJO0VBQ3RCLElBQUksQ0FBQyxJQUFJLFNBQVMsSUFBSSxNQUFPLEtBQUs7R0FBRSxPQUFPO0dBQUcsT0FBTztFQUFLLENBQUU7Q0FDOUQ7Q0FDQSxNQUFNLGFBQWEsT0FBTyxhQUFhLEdBQUcsU0FBUztDQUNuRCxTQUFTO0VBQ1AsT0FBTyxLQUFLLEtBQUssR0FBSSxPQUFPO0dBQzFCLE1BQU0sT0FBTyxNQUFNLEdBQUk7R0FDdkIsUUFBUSxlQUFlO0dBQ3ZCLElBQUksQ0FBQyxNQUFNO0lBQUUsSUFBSSxFQUFFO0lBQUksT0FBTztHQUFNO0VBQ3RDO0VBQ0EsSUFBSSxLQUFLLEdBQUcsR0FBSSxRQUFRLElBQUksU0FBaUIsUUFBTztHQUFFLFNBQVM7RUFBSyxDQUFDO0VBQ3JFLElBQUksQ0FBRSxNQUFNLFdBQVcsT0FBTyxPQUFPLFFBQVEsUUFBUSxHQUFJO0dBQ3ZELElBQUksUUFBUTtJQUFFLEdBQUksUUFBUTtJQUFNLE9BQU8sSUFBSTtHQUFHO0dBQzlDLFFBQVEsZUFBZTtFQUN6QjtFQUNBLElBQUksVUFBVSxDQUFDLEtBQUssR0FBRztFQUN2QixXQUFXLE9BQU8sS0FBSztDQUN6QjtDQUNBLE1BQU0sUUFBUSxPQUFnQjtFQUFFLElBQUksSUFBSTtHQUFFLEdBQUcsUUFBUSxLQUFLLElBQUksR0FBRyxRQUFRO0dBQUcsSUFBSSxRQUFRO0lBQUUsR0FBRyxRQUFRO0lBQU0sT0FBTyxFQUFFO0dBQUc7RUFBRTtDQUFFO0NBQzNILElBQUksUUFBUSxJQUFJLEVBQUU7Q0FDbEIsTUFBTSxRQUFRLFFBQVEsUUFBUSxVQUFVLE9BQU8sR0FBRyxPQUFPO0VBQUUsVUFBVTtFQUFHLE9BQU87Q0FBRTtDQUNqRixNQUFNO0NBQ04sTUFBTSxNQUFNLElBQUksZ0JBQWdCLEdBQUcsUUFBUSxpQkFBaUIsSUFBSSxNQUFNLEdBQUcsZ0JBQWdCO0NBQ3pGLE1BQU0sZUFBZSxJQUFJLE1BQU07Q0FDL0IsUUFBUSxpQkFBaUIsU0FBUyxRQUFRLEVBQUUsTUFBTSxLQUFLLENBQUM7Q0FDeEQsSUFBSSxRQUFRLFNBQVMsSUFBSSxNQUFNO0NBQy9CLElBQUk7RUFDRixNQUFNLElBQUksTUFBTSxNQUFNLEtBQUs7R0FBRSxNQUFNO0dBQVEsYUFBYTtHQUFRLFFBQVEsSUFBSTtFQUFPLENBQUM7RUFDcEYsSUFBSSxFQUFFLFdBQVcsS0FBSztHQUFFLFNBQVMsSUFBSTtHQUFHLEtBQUssSUFBSTtHQUFHLE9BQU87RUFBVztFQUN0RSxJQUFJLEVBQUUsSUFBSTtHQUFFLE1BQU0sT0FBTyxNQUFNLEVBQUUsS0FBSztHQUFHLE1BQU0sU0FBUyxLQUFLLFFBQVE7R0FBRyxRQUFRLGVBQWU7R0FBRyxTQUFTLElBQUk7R0FBRyxLQUFLLElBQUk7R0FBRyxPQUFPO0VBQU07Q0FDN0ksUUFBUSxDQUVSLFVBQVU7RUFDUixhQUFhLEtBQUs7RUFDbEIsUUFBUSxvQkFBb0IsU0FBUyxNQUFNO0VBQzNDLFdBQVcsT0FBTyxLQUFLO0NBQ3pCO0NBQ0EsSUFBSSxRQUFRLFNBQVM7OztFQUduQixJQUFJLFFBQVE7R0FBRSxHQUFJLFFBQVE7R0FBTSxPQUFPLElBQUk7RUFBRztFQUM5QyxPQUFPLGVBQWU7Q0FDeEI7Q0FDQSxJQUFJLEVBQUU7Q0FDTixJQUFJLENBQUMsT0FBTyxhQUFhLElBQUksSUFBSTtDQUNqQyxLQUFLLEtBQUs7Q0FDVixPQUFPO0FBQ1Q7QUFFQSxJQUFJLGNBQTJDO0FBQy9DLFNBQVMsU0FBUyxHQUFXLEdBQThDO0NBQ3pFLElBQUksQ0FBQyxjQUFjO0VBQ2pCLGVBQWUsSUFBSSxnQkFBZ0IsR0FBRyxDQUFDO0VBQ3ZDLE1BQU0sVUFBVSxhQUFhLFdBQVcsTUFBTSxFQUFFLG9CQUFvQixLQUFLLENBQUM7RUFDMUUsSUFBSSxDQUFDLFNBQVMsTUFBTSxJQUFJLE1BQU0sNkJBQTZCO0VBQzNELGdCQUFnQjtDQUNsQjtDQUNBLElBQUksYUFBYSxVQUFVLEdBQUcsYUFBYSxRQUFRO0NBQ25ELElBQUksYUFBYSxXQUFXLEdBQUcsYUFBYSxTQUFTO0NBQ3JELE9BQU87QUFDVDs7QUFHQSxlQUFlLE9BQU8sTUFBMEI7Q0FDOUM7Q0FDQSxJQUFJO0NBQ0osSUFBSTtFQUNGLE1BQU0sTUFBTSxrQkFBa0IsTUFBTTtHQUFFLGtCQUFrQjtHQUFRLHNCQUFzQjtFQUFPLENBQUM7RUFDOUYsTUFBTSxJQUFJLElBQUksT0FBTyxJQUFJLElBQUksUUFBUSxTQUFTLE1BQU0sS0FBSyxNQUFNLEtBQUssS0FBSyxDQUFDLEdBQUcsR0FBRyxDQUFDLEdBQUcsTUFBTSxTQUFTLEdBQUcsTUFBTTtFQUM1RyxNQUFNLE9BQU8sSUFBSSxPQUFPLEdBQUcsQ0FBQztFQUM1QixLQUFLLElBQUksSUFBSSxHQUFHLElBQUksR0FBRyxLQUFLLFFBQVE7R0FDbEMsTUFBTSxLQUFLLEtBQUssSUFBSSxRQUFRLElBQUksQ0FBQztHQUNqQyxJQUFJLFVBQVUsR0FBRyxHQUFHLEdBQUcsRUFBRTtHQUN6QixJQUFJLFVBQVUsS0FBSyxHQUFHLEdBQUcsR0FBRyxJQUFJLEdBQUcsR0FBRyxHQUFHLEVBQUU7R0FDM0MsS0FBSyxJQUFJLElBQUksYUFBYSxHQUFHLEdBQUcsR0FBRyxFQUFFLENBQUMsQ0FBQyxNQUFNLElBQUksQ0FBQztFQUNwRDtFQUNBLE9BQU8sS0FBSyxPQUFPO0NBQ3JCLFVBQVU7RUFDUixLQUFLLE1BQU07OztFQUdYLElBQUksY0FBYztHQUFFLGFBQWEsUUFBUTtHQUFHLGFBQWEsU0FBUztFQUFHO0VBQ3JFO0NBQ0Y7QUFDRjtBQUVBLElBQUksbUJBQWtDLFFBQVEsUUFBUTs7QUFFdEQsZUFBZSxhQUFhLE1BQVksT0FBTyxVQUFVLFlBQVksT0FBd0I7Q0FDM0YsTUFBTSxTQUFTO0NBQ2YsSUFBSTtDQUNKLG1CQUFtQixJQUFJLFNBQWMsWUFBVztFQUFFLFVBQVU7Q0FBUyxDQUFDO0NBQ3RFO0NBQ0EsTUFBTTtDQUNOO0NBQ0EsSUFBSTtFQUFFLE9BQU8sVUFBVSxNQUFNLE9BQU8sSUFBSSxHQUFHLE1BQU0sU0FBUztDQUFHLFVBQ3JEO0VBQUUsUUFBUTtDQUFHO0FBQ3ZCOztBQUdBLE1BQU0sVUFBVTtDQUNkLEtBQWlCLEdBQVEsSUFBSSxJQUE2QjtDQUMxRCxPQUFpQixHQUFVLElBQUksSUFBb0g7Q0FDbkosTUFBaUIsR0FBUyxJQUFJLElBQXlDO0NBQ3ZFLE1BQWlCO0NBQ2pCLEtBQVEsR0FBUTtDQUNoQixZQUFZLFFBQWdCO0VBQUUsS0FBSyxTQUFTO0NBQVE7Q0FFcEQsTUFBUSxDQUFPLEtBQWlEO0VBQzlELE1BQU0sSUFBSSxLQUFLLE1BQU0sSUFBSSxHQUFHO0VBQzVCLElBQUksTUFBTSxXQUFXO0dBQUUsS0FBSyxNQUFNLE9BQU8sR0FBRztHQUFHLEtBQUssTUFBTSxJQUFJLEtBQUssQ0FBQztHQUFHLElBQUksTUFBTSxXQUFXLGFBQWEsUUFBUSxLQUFLO0dBQUcsT0FBTztFQUFHO0VBQ25JLE1BQU0sSUFBSSxLQUFLLE9BQU8sSUFBSSxHQUFHO0VBQzdCLElBQUksS0FBSyxhQUFhLEVBQUUsSUFBSSxFQUFFLEdBQUcsR0FBRyxPQUFPO0VBQzNDLE9BQU87Q0FDVDs7Q0FHQSxRQUFRLE1BQThCO0VBQ3BDLE1BQU0sTUFBYSxDQUFDO0VBQ3BCLEtBQUssTUFBTSxLQUFLLE1BQU07R0FBRSxNQUFNLElBQUksS0FBSyxPQUFPLENBQUM7R0FBRyxJQUFJLE1BQU0sV0FBVyxPQUFPO0dBQU0sSUFBSSxLQUFLLENBQUM7RUFBRztFQUNqRyxPQUFPO0NBQ1Q7Ozs7O0NBTUEsSUFBSSxLQUFhLEtBQWEsVUFBbUIsUUFBc0IsVUFBdUM7RUFDNUcsSUFBSSxRQUFRLFNBQVMsT0FBTyxRQUFRLE9BQU8sT0FBTyxNQUFNO0VBQ3hELE1BQU0sSUFBSSxLQUFLLE9BQU8sR0FBRztFQUN6QixJQUFJLE1BQU0sV0FBVyxPQUFPLFFBQVEsUUFBUSxDQUFDO0VBQzdDLElBQUksSUFBSSxLQUFLLFFBQVEsSUFBSSxHQUFHO0VBQzVCLElBQUksQ0FBQyxHQUFHO0dBQ04sTUFBTSxhQUFhLElBQUksZ0JBQWdCO0dBQ3ZDLE1BQU0sUUFBUTtJQUFFLFNBQVMsUUFBUSxRQUFRLElBQUk7SUFBbUI7SUFBWSxPQUFPLElBQUksSUFBd0M7R0FBRTs7O0dBR2pJLE1BQU0sdUJBQXVCO0lBQzNCLElBQUksT0FBTztJQUNYLEtBQUssTUFBTSxnQkFBZ0IsTUFBTSxNQUFNLE9BQU8sR0FBRyxPQUFPLEtBQUssSUFBSSxNQUFNLGNBQWMsWUFBWSxDQUFDO0lBQ2xHLE9BQU87R0FDVDtHQUNBLE1BQU0sV0FBVyxZQUEwQjtJQUN6QyxJQUFJO0tBQ0YsSUFBSSxNQUFXLFdBQVcsTUFBTSxLQUFLLEtBQUssVUFBVSxNQUFNLFdBQVcsUUFBUSxjQUFjLElBQUk7S0FDL0YsSUFBSSxDQUFDLFlBQVksUUFBUSxRQUFRLFFBQVEsV0FBVyxNQUFNLE1BQU0sS0FBSyxLQUFLLEtBQUssT0FBTyxXQUFXLFFBQVEsY0FBYztLQUN2SCxXQUFXLE9BQU8sZUFBZTtLQUNqQyxJQUFJLFFBQVEsTUFBTSxLQUFLLEtBQUssS0FBSyxHQUFHO1VBQy9CO01BQUUsS0FBSyxPQUFPLE9BQU8sR0FBRztNQUFHLEtBQUssSUFBSSxLQUFLLEdBQUc7S0FBRztLQUNwRCxPQUFPO0lBQ1QsU0FBUyxPQUFPO0tBQ2QsSUFBSSxXQUFXLE9BQU8sU0FBUyxPQUFPO0tBQ3RDLE1BQU07SUFDUixVQUFVO0tBQ1IsSUFBSSxLQUFLLFFBQVEsSUFBSSxHQUFHLE1BQU0sT0FBTyxLQUFLLFFBQVEsT0FBTyxHQUFHO0lBQzlEO0dBQ0YsRUFBQyxDQUFFO0dBQ0gsS0FBSyxRQUFRLElBQUksS0FBSyxJQUFJLEtBQUs7RUFDakM7RUFDQSxNQUFNLFFBQVEsR0FBRyxPQUFPLE9BQU87RUFDL0IsTUFBTSxNQUFNLElBQUksTUFBTSxRQUFRO0VBQzlCLE9BQU8sSUFBSSxTQUFTLFNBQVMsV0FBVztHQUN0QyxNQUFNLGNBQWM7SUFDbEIsUUFBUSxvQkFBb0IsU0FBUyxNQUFNO0lBQzNDLE1BQU0sTUFBTSxPQUFPLElBQUk7R0FDekI7R0FDQSxNQUFNLGVBQWU7SUFDbkIsTUFBTTtJQUNOLElBQUksQ0FBQyxNQUFNLE1BQU0sTUFBTTtLQUNyQixNQUFNLFdBQVcsTUFBTTtLQUN2QixJQUFJLEtBQUssUUFBUSxJQUFJLEdBQUcsTUFBTSxPQUFPLEtBQUssUUFBUSxPQUFPLEdBQUc7SUFDOUQ7SUFDQSxPQUFPLFFBQVEsVUFBVSxJQUFJLGFBQWEsc0JBQXNCLFlBQVksQ0FBQztHQUMvRTtHQUNBLFFBQVEsaUJBQWlCLFNBQVMsUUFBUSxFQUFFLE1BQU0sS0FBSyxDQUFDO0dBQ3hELE1BQU0sUUFBUSxNQUFLLFFBQU87SUFBRSxNQUFNO0lBQUcsUUFBUSxHQUFHO0dBQUcsSUFBRyxVQUFTO0lBQUUsTUFBTTtJQUFHLE9BQU8sS0FBSztHQUFHLENBQUM7RUFDNUYsQ0FBQztDQUNIO0NBRUEsTUFBYyxLQUFLLEtBQWEsT0FBZ0IsUUFBc0IsVUFBdUM7RUFDM0csTUFBTSxPQUFPLE1BQU0sVUFBVSxLQUFLLE9BQU8sUUFBUSxRQUFRO0VBQ3pELElBQUksU0FBUyxhQUFhLFNBQVMsTUFBTSxPQUFPO0VBQ2hELFFBQVEsZUFBZTtFQUN2QixPQUFPLE9BQU8sSUFBSSxDQUFDLENBQUMsTUFBSyxNQUFLLElBQUksU0FBUyxJQUFJLFNBQVMsRUFBRSxJQUFJLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFlBQVksSUFBSTtDQUNqRztDQUVBLElBQVEsQ0FBSyxLQUFhLEtBQWE7RUFDckMsS0FBSyxPQUFPLElBQUksS0FBSztHQUFFLElBQUksWUFBWSxJQUFJO0dBQUc7RUFBSSxDQUFDO0VBQ25ELElBQUksS0FBSyxPQUFPLE9BQU8sTUFBTTtRQUFLLE1BQU0sQ0FBQyxHQUFHLE1BQU0sS0FBSyxRQUFRLElBQUksQ0FBQyxhQUFhLEVBQUUsSUFBSSxFQUFFLEdBQUcsR0FBRyxLQUFLLE9BQU8sT0FBTyxDQUFDO0VBQUM7RUFDcEgsT0FBTyxLQUFLLE9BQU8sT0FBTyxNQUFNLEtBQUssT0FBTyxPQUFPLEtBQUssT0FBTyxLQUFLLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxLQUFNO0NBQ3JGO0NBRUEsR0FBUSxDQUFJLEtBQWEsR0FBb0I7RUFDM0MsTUFBTSxXQUFXLEtBQUssTUFBTSxJQUFJLEdBQUc7RUFDbkMsSUFBSSxhQUFhLFdBQVcsS0FBSyxTQUFTLGFBQWEsWUFBWSxLQUFLLFNBQVMsS0FBSyxPQUFPO0VBQzdGLEtBQUssTUFBTSxJQUFJLEtBQUssQ0FBQztFQUNyQixLQUFLLFNBQVMsTUFBTSxZQUFZLEtBQUssRUFBRSxLQUFLLE9BQU87RUFDbkQsSUFBSSxNQUFNLFdBQVcsZ0JBQWdCLFFBQVEsT0FBTyxFQUFFLEtBQUssT0FBTyxrQkFBa0I7R0FDbEYsSUFBSSxLQUFLLE1BQU0sSUFBSSxHQUFHLE1BQU0sR0FBRztJQUFFLEtBQUssTUFBTSxPQUFPLEdBQUc7SUFBRyxLQUFLLFNBQVMsRUFBRSxLQUFLLE9BQU87R0FBWTtFQUNuRyxHQUFHLE1BQU07T0FDSixrQkFBa0IsUUFBUSxLQUFLO0VBQ3BDLEtBQUssTUFBTSxDQUFDLEdBQUcsUUFBUSxLQUFLLE9BQU87R0FDakMsSUFBSSxLQUFLLFNBQVMsS0FBSyxVQUFVLEtBQUssTUFBTSxRQUFRLE1BQU07R0FDMUQsS0FBSyxNQUFNLE9BQU8sQ0FBQztHQUNuQixLQUFLLFNBQVMsUUFBUSxZQUFZLEtBQUssSUFBSSxLQUFLLE9BQU87R0FDdkQsSUFBSSxRQUFRLFdBQVcsa0JBQWtCLFFBQVEsR0FBRztFQUN0RDtDQUNGO0FBQ0Y7QUFNQSxTQUFTLGNBQWM7Q0FDckIsTUFBTSxLQUFLLElBQUksVUFBVTtDQUN6QixNQUFNLFFBQVEsSUFBSSxVQUFVLGdCQUFnQjtDQUM1QyxNQUFNLE9BQU8sSUFBSSxJQUE2QjtDQUM5QyxJQUFJO0NBQ0osU0FBUyxjQUFjLEtBQThDO0VBQ25FLElBQUksQ0FBQyxXQUFXLE9BQU87RUFDdkIsTUFBTSxJQUFJLElBQUksTUFBTSxPQUFPLEVBQUUsT0FBTyxFQUFFLFFBQVEsR0FBRyxPQUFPLEVBQUUsUUFBUSxFQUFFLFNBQVM7RUFDN0UsTUFBTSxLQUFLLEtBQUssTUFBTSxLQUFLLElBQUksTUFBTSxVQUFVLEdBQUcsR0FBRyxLQUFLLElBQUksTUFBTSxVQUFVLEdBQUcsQ0FBQyxJQUFJLEtBQUssSUFBSSxVQUFVLEdBQUc7RUFDNUcsTUFBTSxRQUFRLEtBQUssS0FBSyxLQUFLLEtBQUssSUFBSSxJQUFJLFVBQVUsS0FBSztFQUN6RCxRQUFRLEtBQUssTUFBTSxNQUFNLFVBQVUsUUFBUSxNQUFNLFFBQVEsU0FBUyxLQUFLLElBQUksR0FBRyxVQUFVLFFBQVEsSUFBSSxLQUFLLElBQUk7Q0FDL0c7Q0FDQSxNQUFNLFNBQVMsSUFBSSxJQUF3QjtDQUMzQyxNQUFNLFVBQVUsSUFBSSxJQUF5QjtDQUM3QyxNQUFNLGlCQUFpQixJQUFJLElBQXlCO0NBQ3BELE1BQU0sa0JBQWtCLElBQUksSUFBd0I7Q0FDcEQsTUFBTSxlQUFlLElBQUksSUFBdUI7O0NBRWhELElBQUksU0FBOEQ7Ozs7O0NBTWxFLFNBQVMsVUFBVSxPQUF1QztFQUN4RCxJQUFJLElBQUksT0FBTyxJQUFJLEtBQUs7RUFDeEIsSUFBSSxDQUFDLEdBQUcsT0FBTyxJQUFJLE9BQVEsSUFBSTtHQUFFLE9BQU87R0FBTSxVQUFVO0dBQUcsU0FBUztFQUFLLENBQUU7RUFDM0UsTUFBTSxNQUFNLG9CQUFvQixLQUFLO0VBQ3JDLElBQUksRUFBRSxVQUFVLFFBQVEsRUFBRSxXQUFZLEVBQUUsWUFBWSxhQUFhLEVBQUUsVUFBVSxHQUFHLEdBQUksT0FBTyxFQUFFLFdBQVcsUUFBUSxRQUFRLEVBQUUsS0FBSztFQUMvSCxNQUFNLFFBQVE7RUFDZCxNQUFNLFdBQVcsWUFBWTtHQUMzQixNQUFNLE9BQU8sTUFBTSxVQUFVLEdBQUc7R0FDaEMsTUFBTSxNQUFNLFFBQVEsU0FBUyxZQUFZLE1BQU0sS0FBSyxLQUFLLENBQUMsQ0FBQyxZQUFZLElBQUksSUFBSTtHQUMvRSxNQUFNLFFBQVEsU0FBUyxZQUFZLFdBQVcsUUFBUSxPQUFPLE9BQU8sZUFBZSxHQUFHLEtBQUs7R0FDM0YsTUFBTSxVQUFVO0dBQ2hCLElBQUksVUFBVSxNQUFNLE1BQU0sV0FBVyxZQUFZLElBQUk7UUFBUSxNQUFNLFFBQVE7R0FDM0UsT0FBTztFQUNULEVBQUMsQ0FBRTtFQUNILE9BQU8sTUFBTTtDQUNmO0NBRUEsZUFBZSxRQUFRLEtBQXFDLE1BQStCOzs7RUFHekYsTUFBTSxRQUFRLE1BQU0sVUFBVSxJQUFJLEtBQUs7RUFDdkMsTUFBTSxPQUFPLEtBQUssSUFBSSxJQUFJLGdCQUFnQixTQUFTLFFBQVE7RUFDM0QsTUFBTSxPQUFPLFNBQVMsSUFBSSxJQUFJLE1BQU0sSUFBSSxPQUFPLE1BQU0sSUFBSSxVQUFVO0VBQ25FLElBQUksQ0FBQyxNQUFNLE9BQU87RUFDbEIsTUFBTSxTQUFTLE1BQWMsR0FBRyxJQUFJLE1BQU0sR0FBRztFQUM3QyxJQUFJLE1BQU0sTUFBTSxRQUFRLEtBQUssS0FBSyxJQUFJLEtBQUssQ0FBQztFQUM1QyxJQUFJLENBQUMsS0FBSztHQUNSLE1BQU0sTUFBTSxRQUFRLElBQUksS0FBSyxLQUFLLEtBQUksTUFBSztJQUFFLE1BQU0sSUFBSSxXQUFXLENBQUM7SUFBRyxPQUFPLE1BQU0sSUFBSSxNQUFNLENBQUMsR0FBRyxRQUFRLElBQUksT0FBTyxJQUFJLEtBQUssRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLENBQUMsQ0FBQztHQUFHLENBQUMsQ0FBQztHQUNoSixJQUFJLElBQUksU0FBUyxJQUFJLEdBQUcsT0FBTztHQUMvQixjQUFjLElBQUksSUFBSSxNQUFNLElBQUksT0FBTyxNQUFNLElBQUksVUFBVTtFQUM3RDtFQUNBLElBQUksSUFBSSxTQUFTLElBQUksR0FBRyxPQUFPO0VBQy9CLE9BQU87R0FBRSxJQUFJLFlBQVksSUFBSSxLQUFLLE9BQU8sS0FBSyxNQUFNLElBQUksS0FBSSxNQUFNLE1BQU0sWUFBWSxPQUFPLENBQUUsR0FBRyxJQUFJO0dBQUcsTUFBTTtFQUFNO0NBQ3JIOzs7Q0FJQSxNQUFNLGFBQWEsSUFBSSxJQUF1QztDQUM5RCxNQUFNLGVBQWUsSUFBSSxRQUFxQjtDQUM5QyxJQUFJLFNBQVM7Q0FDYixTQUFTLFlBQVksS0FBZTtFQUNsQyxNQUFNLEtBQUssYUFBYSxJQUFJLEdBQUcsR0FBRyxNQUFNLE9BQU8sWUFBWSxZQUFZLFdBQVcsSUFBSSxFQUFFO0VBQ3hGLElBQUksT0FBTyxhQUFhLElBQUksR0FBRyxHQUFHLE9BQU8sSUFBSTtFQUM3QyxNQUFNLFdBQVcsa0JBQWtCLEdBQUc7RUFDdEMsSUFBSSxhQUFhLEtBQUs7R0FDcEIsTUFBTSxPQUFPLEVBQUUsUUFBUSxNQUFNLFFBQVE7R0FDckMsYUFBYSxJQUFJLEtBQUssSUFBSTtHQUMxQixXQUFXLElBQUksTUFBTTtJQUFFO0lBQUssS0FBSztHQUFTLENBQUM7R0FDM0MsZ0JBQWdCLEtBQUssU0FBUyxLQUFLLGtCQUFrQixXQUFXLE9BQU8sSUFBSSxHQUFHLE1BQU07RUFDdEY7RUFDQSxPQUFPO0NBQ1Q7Q0FFQSxlQUFlLFlBQVksS0FBc0MsT0FBZSxNQUFjLE1BQWUsUUFBcUIsUUFBc0IsU0FBUyxPQUFPO0VBQ3RLLE1BQU0sT0FBTyxnQkFBZ0IsSUFBSSxJQUFJLE1BQU0sSUFBSSxPQUFPLE1BQU0sTUFBTTtFQUNsRSxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssS0FBSyxRQUFRLE9BQU87R0FBRSxJQUFJO0dBQU0sUUFBUTtHQUFPLFdBQVc7RUFBTTtFQUNuRixNQUFNLE1BQU0sTUFBTSxRQUFRLElBQUksS0FBSyxLQUFLLEtBQUksUUFBTztHQUNqRCxNQUFNLElBQUksV0FBVyxHQUFHO0dBQ3hCLElBQUksTUFBTSxRQUFRLE9BQU8sT0FBTyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsQ0FBQztHQUM3QyxJQUFJLFFBQVEsVUFBVTtJQUNwQixNQUFNLElBQUksS0FBSyxNQUFNLE1BQU0sU0FBUyxHQUFHLElBQUksTUFBTSxJQUFJLFdBQVcsSUFBSSxLQUFLO0lBQ3pFLE1BQU0sU0FBUyxPQUFPLFNBQVMsb0NBQW9DO0lBQ25FLE1BQU0sd0NBQXdDLE1BQU0saUJBQWlCLEVBQUUsR0FBRyxJQUFJLEVBQUUsR0FBRyxLQUFLLE1BQU0sSUFBSSxDQUFDLElBQUk7R0FDekc7R0FDQSxPQUFPLE1BQU0sSUFBSSxHQUFHLE1BQU0sR0FBRyxRQUFRLFdBQVcsUUFBUSxLQUFLLE9BQU8sS0FBSyxXQUFXLGNBQWMsY0FBYyxHQUFHLENBQUM7RUFDdEgsQ0FBQyxDQUFDO0VBQ0YsT0FBTyxlQUFlO0VBQ3RCLElBQUksSUFBSSxTQUFTLElBQUksR0FBRyxPQUFPO0dBQUUsSUFBSTtHQUFNLFFBQVE7R0FBTSxXQUFXO0VBQU07RUFDMUUsZ0JBQWdCLElBQUksSUFBSSxNQUFNLElBQUksT0FBTyxNQUFNLE1BQU07RUFDckQsTUFBTSxLQUFLLFlBQVksSUFBSSxLQUFLLE9BQU8sS0FBSyxNQUFNLElBQUksS0FBSSxNQUFLLENBQUMsS0FBSyxNQUFNLFlBQVksT0FBTyxTQUFTLFlBQVksQ0FBQyxJQUFJLENBQUMsR0FBRyxJQUFJO0VBQ2hJLElBQUksT0FBTztFQUNYLElBQUksVUFBVSxJQUFJLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxJQUFJLEtBQUs7R0FDN0MsTUFBTSxNQUFNLEtBQUssTUFBTSxJQUFJLElBQUksR0FBRyxNQUFNLElBQUksTUFBTSxNQUFNLE9BQU8sTUFBTSxPQUFPLElBQUksT0FBTyxPQUFPLE9BQU8sSUFBSTtHQUN6RyxJQUFJLEdBQUcsSUFBSSxLQUFLLE1BQU8sR0FBRyxLQUFLLEtBQUs7RUFDdEM7RUFDQSxPQUFPO0dBQUU7R0FBSSxRQUFRO0dBQU8sV0FBVyxXQUFXLENBQUMsTUFBTSxPQUFPLEtBQUs7RUFBTztDQUM5RTtDQUVBLGVBQWUsY0FBYyxLQUFzQyxNQUFlLFFBQXFDO0VBQ3JILE1BQU0sWUFBWSxPQUFPLEdBQVcsR0FBVyxNQUFjO0dBQzNELE1BQU0sSUFBSSxJQUFJLEdBQUcsSUFBSSxLQUFLLE1BQU0sSUFBSSxDQUFDLEdBQUcsaUJBQWlCLGNBQWMsR0FBRztHQUMxRSxNQUFNLFNBQVMsTUFBTSxNQUFNLElBQUksU0FBUyxFQUFFLEdBQUcsS0FBSyxjQUFjLEdBQUcsR0FBRyxDQUFDLEdBQUcsV0FBVyxRQUFRLFFBQVE7R0FDckcsSUFBSSxVQUFVLFdBQVcsV0FBVyxPQUFPOzs7R0FHM0MsT0FBTyxNQUFNLElBQUksYUFBYSxFQUFFLEdBQUcsS0FBSyxpQkFBaUIsR0FBRyxHQUFHLENBQUMsR0FBRyxXQUFXLFFBQVEsUUFBUTtFQUNoRztFQUNBLElBQUk7RUFDSixJQUFJLElBQUksV0FBVztHQUNqQixNQUFNLEVBQUUsS0FBSyxTQUFTLElBQUksV0FBVyxTQUFTLE1BQU0sWUFBWSxHQUFHLENBQUMsQ0FBQyxTQUFTLE1BQU0sUUFBUSxPQUFPLElBQUk7R0FDdkcsSUFBSSxLQUFLO0lBQ1AsR0FBRyxJQUFJLEtBQUssQ0FBQztJQUFHLEdBQUcsSUFBSSxLQUFLLENBQUM7SUFBRyxHQUFHLEtBQUssS0FBSyxDQUFDO0lBQzlDLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxNQUFNLEtBQUssS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLE1BQU0sS0FBSztLQUM1RCxNQUFNLElBQUksSUFBSSxPQUFPO0tBQ3JCLEdBQUcsRUFBRSxLQUFLLElBQUksS0FBSyxRQUFRLElBQUksS0FBSyxRQUFRLElBQUksT0FBUSxJQUFJLEtBQUssT0FBTyxJQUFJLEtBQUssUUFBUSxPQUFPLEtBQUssU0FBUyxLQUFLLE9BQU8sS0FBSyxRQUFRO0tBQ3ZJLEdBQUcsRUFBRSxLQUFLLElBQUksS0FBSyxRQUFRLEtBQUssUUFBUSxJQUFJLEtBQUssU0FBUyxJQUFJLE9BQVEsSUFBSSxLQUFLLFFBQVEsSUFBSSxLQUFLLFNBQVMsU0FBUyxLQUFLLFFBQVEsS0FBSyxTQUFTO0lBQy9JO0lBQ0EsT0FBTztLQUFFLElBQUksWUFBWSxJQUFJLENBQUMsV0FBVyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLEdBQUcsR0FBRyxJQUFJO0tBQUcsTUFBTTtJQUFNO0dBQ2pGO0VBQ0Y7RUFDQSxTQUFTLElBQUksTUFBTSxNQUFNLFNBQVM7R0FBRSxNQUFNO0dBQVMsTUFBTSxJQUFJO0dBQU0sT0FBTyxJQUFJO0dBQU8sS0FBSyxJQUFJO0VBQUksR0FBRyxJQUFJLElBQ3JHLE1BQU0sUUFBUTtHQUFFLE1BQU07R0FBUSxNQUFNLElBQUk7R0FBTSxPQUFPLElBQUk7R0FBTyxPQUFPLElBQUk7R0FBTyxLQUFLO0dBQU8sZ0JBQWdCO0dBQUcsWUFBWSxJQUFJO0VBQVcsR0FBRyxJQUFJO0VBQ3ZKLE9BQU8sZUFBZTtFQUN0QixJQUFJLENBQUMsS0FBSyxJQUFJLE9BQU87OztFQUdyQixJQUFJLGlCQUFpQixJQUFJLElBQUksQ0FBQyxDQUFDLFNBQVMsa0JBQWtCLElBQUs7R0FDN0QsTUFBTSxDQUFDLE9BQU8sT0FBTyxNQUFNLFFBQVEsSUFBSSxDQUNyQyxZQUFZLEtBQUssY0FBYyxPQUFPLHFCQUFxQixNQUFNLFFBQVEsZUFBZSxJQUFJLEdBQUcsWUFBWSxLQUFLLGNBQWMsT0FBTyxHQUFHLE1BQU0sUUFBUSxhQUFhLENBQ3JLLENBQUM7R0FDRCxJQUFJLE1BQU0sVUFBVSxJQUFJLFFBQVEsT0FBTztHQUN2QyxhQUFhLElBQUksSUFBSSxNQUFNLElBQUksVUFBVTtHQUN6QyxJQUFJLE1BQU0sTUFBTSxJQUFJLElBQUksS0FBSyxJQUFJLElBQUksR0FBRyxJQUFJLElBQUksS0FBSztJQUNuRCxNQUFNLE1BQU0sS0FBSyxNQUFNLElBQUksSUFBSSxHQUFHLE1BQU0sSUFBSSxNQUFNLE1BQU0sT0FBTyxNQUFNLE9BQU8sSUFBSSxPQUFPLE9BQU8sT0FBTyxJQUFJO0lBQ3pHLE1BQU0sU0FBUyxJQUFJLFFBQVEsR0FBRyxFQUFFLEtBQUssTUFBTSxtQkFBbUIsRUFBRztJQUNqRSxNQUFNLEdBQUcsTUFBTTtJQUFRLElBQUksR0FBRyxNQUFNO0dBQ3RDO0dBQ0EsZUFBZSxLQUFLLElBQUksTUFBTSxJQUFJLElBQUksSUFBSSxLQUFLLEVBQUU7RUFDbkQ7RUFDQSxNQUFNLE9BQU8sZUFBZSxJQUFJLElBQUksTUFBTSxJQUFJLEtBQUs7RUFDbkQsSUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLEtBQUssUUFBUSxPQUFPO0VBQ3ZDLE1BQU0sSUFBSSxLQUFLLE9BQU8sSUFBSSxLQUFLLE1BQU0sRUFBRSxDQUFDO0VBQ3hDLE1BQU0sTUFBTSxNQUFNLFFBQVEsSUFBSSxLQUFLLEtBQUssS0FBSSxNQUFLLFVBQVUsR0FBRyxHQUFHLENBQUMsQ0FBQyxDQUFDO0VBQ3BFLE9BQU8sZUFBZTtFQUN0QixJQUFJLElBQUksU0FBUyxJQUFJLEdBQUcsT0FBTztFQUMvQixlQUFlLElBQUksSUFBSSxNQUFNLENBQUM7RUFDOUIsTUFBTSxLQUFLLFlBQVksSUFBSSxLQUFLLE9BQU8sS0FBSyxNQUFNLElBQUksS0FBSSxNQUFLLENBQUMsS0FBSyxNQUFNLFlBQVksT0FBTyxZQUFZLENBQUMsQ0FBQyxHQUFHLElBQUk7RUFDbkgsTUFBTSxPQUFPLEdBQUcsT0FBTyxLQUFLO0VBQzVCLGVBQWUsSUFBSSxJQUFJLE1BQU0sSUFBSTtFQUNqQyxNQUFNLFFBQVEsQ0FBQyxZQUFZLElBQUksQ0FBQyxHQUFHLE9BQU8sYUFBYSxJQUFJLE9BQU8sUUFBUSxLQUFLLENBQUM7RUFDaEYsTUFBTSxNQUFNLE1BQU0sUUFBUSxJQUFJLEtBQUssS0FBSSxNQUFLLFVBQVUsTUFBTSxHQUFHLElBQUksQ0FBQyxDQUFDO0VBQ3JFLE9BQU8sZUFBZTtFQUN0QixJQUFJLElBQUksU0FBUyxJQUFJLEdBQUcsT0FBTztFQUMvQixlQUFlLElBQUksSUFBSSxNQUFNLElBQUk7RUFDakMsTUFBTSxVQUFVLFlBQVksSUFBSSxPQUFPLE1BQU0sSUFBSSxLQUFJLE1BQUssTUFBTSxZQUFZLE9BQU8sQ0FBQyxHQUFHLElBQUk7RUFDM0YsZUFBZSxLQUFLLElBQUksSUFBSSxTQUFTLEVBQUc7RUFDeEMsT0FBTztDQUNUO0NBRUEsZUFBZSxTQUFTLEtBQXNDLE1BQWUsUUFBcUM7RUFDaEgsSUFBSSxpQkFBaUIsSUFBSSxJQUFJLENBQUMsQ0FBQyxTQUFTLGlCQUFpQixPQUFPLGNBQWMsS0FBSyxNQUFNLE1BQU07RUFDL0YsTUFBTSxVQUFVLGdCQUFnQixJQUFJLElBQUksR0FBRyxVQUFVLFFBQVEsTUFBSyxNQUFLLGtCQUFrQixJQUFJLE1BQU0sQ0FBQyxDQUFDOzs7RUFHckcsTUFBTSxjQUFjLElBQUksTUFBTSxTQUFTO0dBQUUsTUFBTTtHQUFTLE1BQU0sSUFBSTtHQUFNLE9BQU8sSUFBSTtHQUFPLEtBQUssSUFBSTtFQUFJLEdBQUcsSUFBSSxJQUMxRyxRQUFRO0dBQUUsTUFBTTtHQUFRLE1BQU0sSUFBSTtHQUFNLE9BQU8sSUFBSTtHQUFPLE9BQU8sSUFBSTtHQUFPLEtBQUs7R0FBTyxnQkFBZ0I7R0FBRyxZQUFZLElBQUk7RUFBVyxHQUFHLElBQUk7RUFDakosTUFBTSxTQUFTLFdBQVc7RUFDMUIsSUFBSSxDQUFDLE1BQU0sT0FBTyxPQUFPLE1BQU0sUUFBUSxJQUFJO0dBQ3pDO0dBQ0EsWUFBWSxLQUFLLE9BQU8sT0FBTyxPQUFPLE1BQU0sTUFBTSxRQUFRLFFBQVEsSUFBSTtHQUN0RSxZQUFZLEtBQUssT0FBTyxPQUFPLEdBQUcsTUFBTSxRQUFRLE1BQU07RUFDeEQsQ0FBQztFQUNELE9BQU8sZUFBZTtFQUN0QixJQUFJLENBQUMsS0FBSyxJQUFJLE9BQU87RUFDckIsTUFBTSxZQUFZLEtBQUssR0FBRyxNQUFNO0VBQ2hDLElBQUksYUFBYSxNQUFNLFVBQVUsSUFBSTtFQUNyQyxJQUFJLFNBQVM7R0FDWCxJQUFJLFlBQVksT0FBTztHQUN2QixlQUFlLEtBQUssSUFBSSxNQUFNLElBQUksSUFBSSxJQUFJLFNBQVM7RUFDckQsT0FBTztHQUNMLElBQUksY0FBYyxDQUFDLElBQUksSUFBSTtJQUN6QixDQUFDLE9BQU8sT0FBTyxNQUFNLFFBQVEsSUFBSSxDQUMvQixZQUFZLEtBQUssVUFBVSxnQkFBZ0IsTUFBTSxRQUFRLFdBQVcsSUFBSSxHQUN4RSxZQUFZLEtBQUssVUFBVSxHQUFHLE1BQU0sTUFBTSxDQUM1QyxDQUFDO0lBQ0QsSUFBSSxNQUFNLFVBQVUsSUFBSSxRQUFRLE9BQU87SUFDdkMsZUFBZSxLQUFLLElBQUksTUFBTSxJQUFJLElBQUksRUFBRTtHQUMxQyxPQUFPOzs7SUFHTCxJQUFJLE1BQU0sV0FBVztLQUNuQixNQUFNLENBQUMsU0FBUyxjQUFjLE1BQU0sUUFBUSxJQUFJLENBQzlDLFlBQVksS0FBSyxpQkFBaUIsT0FBTyxxQkFBcUIsTUFBTSxRQUFRLGtCQUFrQixJQUFJLEdBQ2xHLFlBQVksS0FBSyxpQkFBaUIsT0FBTyxHQUFHLE1BQU0sUUFBUSxnQkFBZ0IsQ0FDNUUsQ0FBQztLQUNELElBQUksQ0FBQyxRQUFRLFVBQVUsQ0FBQyxXQUFXLFFBQVEsZUFBZSxLQUFLLElBQUksUUFBUSxJQUFJLFdBQVcsSUFBSSxTQUFTO0lBQ3pHO0lBQ0EsZUFBZSxLQUFLLElBQUksTUFBTSxJQUFJLElBQUksSUFBSSxTQUFTO0dBQ3JEO0VBQ0Y7RUFDQSxLQUFLLE1BQU0sVUFBVSxTQUFTO0dBQzVCLElBQUksV0FBVyxTQUFTO0dBQ3hCLE1BQU0sQ0FBQyxRQUFRLFdBQVcsTUFBTSxRQUFRLElBQUksQ0FDMUMsWUFBWSxLQUFLLE9BQU8sT0FBTyxPQUFPLE1BQU0sTUFBTSxRQUFRLFFBQVEsSUFBSSxHQUN0RSxZQUFZLEtBQUssT0FBTyxPQUFPLEdBQUcsTUFBTSxRQUFRLE1BQU0sQ0FDeEQsQ0FBQztHQUNELElBQUksT0FBTyxVQUFVLFFBQVEsUUFBUSxPQUFPO0dBQzVDLGVBQWUsS0FBSyxJQUFJLE9BQU8sSUFBSSxRQUFRLElBQUksU0FBUztFQUMxRDtFQUNBLE9BQU87R0FBRSxJQUFJLEtBQUs7R0FBSSxNQUFNO0VBQVc7Q0FDekM7O0NBR0EsZUFBZSxTQUFTLEtBQXNDLE1BQStCO0VBQzNGLE1BQU0sRUFBRSxRQUFRLEtBQUssUUFBUSxZQUFZLEtBQUssSUFBSSxJQUFJO0VBQ3RELE1BQU0sT0FBTyxVQUFVLElBQUksSUFBSSxNQUFNLElBQUksT0FBTyxNQUFNLElBQUk7RUFDMUQsSUFBSSxDQUFDLE1BQU0sT0FBTztFQUNsQixNQUFNLFNBQVMsTUFBYyxHQUFHLE1BQU0sTUFBTSxHQUFHO0VBQy9DLElBQUksTUFBTSxNQUFNLFFBQVEsS0FBSyxLQUFLLElBQUksS0FBSyxDQUFDO0VBQzVDLElBQUksQ0FBQyxLQUFLO0dBQ1IsTUFBTSxNQUFNLFFBQVEsSUFBSSxLQUFLLEtBQUssS0FBSSxNQUFLO0lBQUUsTUFBTSxJQUFJLFdBQVcsQ0FBQztJQUFHLE9BQU8sTUFBTSxJQUFJLE1BQU0sQ0FBQyxHQUFHLFFBQVEsTUFBTSxPQUFPLE9BQU8sRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLENBQUMsQ0FBQztHQUFHLENBQUMsQ0FBQztHQUNoSixJQUFJLElBQUksU0FBUyxJQUFJLEdBQUcsT0FBTztFQUNqQztFQUNBLElBQUksSUFBSSxTQUFTLElBQUksR0FBRyxPQUFPOztFQUUvQixNQUFNLFNBQVMsTUFBTSxVQUFVLElBQUksT0FBTyxHQUFHO0VBQzdDLElBQUksQ0FBQyxRQUFRLE9BQU87R0FBRSxJQUFJO0dBQU0sTUFBTTtFQUFLO0VBQzNDLGVBQWUsSUFBSSxJQUFJLE1BQU0sSUFBSSxPQUFPLE1BQU0sSUFBSTtFQUNsRCxNQUFNLElBQUksT0FBTyxPQUFPLElBQUksRUFBRSxNQUFNLE1BQU0sT0FBTyxPQUFPLFVBQVUsSUFBSSxRQUFRLEVBQUUsR0FBRyxPQUFPO0VBQzFGLE1BQU0sUUFBUSxHQUFXLE1BQWMsYUFBYSxHQUFHLE1BQU0sTUFBTSxPQUFPLE9BQU8sR0FBRyxFQUFFLElBQUksR0FBRyxFQUFFLEVBQUUsSUFBSSxRQUFRLEtBQUssSUFBSSxLQUFLLElBQUksS0FBSyxFQUFFO0VBQ3RJLE9BQU87R0FBRSxJQUFJLFlBQVksSUFBSSxLQUFLLE9BQU8sS0FBSyxNQUFNLElBQUksS0FBSSxNQUFNLE1BQU0sWUFBWSxPQUFPLENBQUUsR0FBRyxNQUFNLElBQUk7R0FBRyxNQUFNO0VBQU07Q0FDM0g7Q0FFQSxlQUFlLFdBQVcsS0FBd0MsTUFBK0I7RUFDL0YsTUFBTSxPQUFPLFlBQVksSUFBSSxJQUFJLE1BQU0sSUFBSSxPQUFPLElBQUksSUFBSTtFQUMxRCxJQUFJLENBQUMsTUFBTSxPQUFPO0VBQ2xCLE1BQU0sSUFBSSxLQUFLLE9BQU8sSUFBSSxLQUFLLE1BQU0sRUFBRSxDQUFDO0VBQ3hDLE1BQU0sU0FBUyxNQUFjLEdBQUcsSUFBSSxPQUFPLEdBQUcsRUFBRSxHQUFHO0VBQ25ELElBQUksTUFBTSxNQUFNLFFBQVEsS0FBSyxLQUFLLElBQUksS0FBSyxDQUFDO0VBQzVDLElBQUksQ0FBQyxLQUFLOztHQUVSLE1BQU0sT0FBTyxJQUFJLE9BQU8sUUFBUSxRQUFRLFVBQVUsT0FBTyxTQUFTLFFBQVEsT0FBTyxPQUFPLFdBQVcsSUFBSSxTQUFTLE9BQU8sUUFBUTtHQUMvSCxNQUFNLE1BQU0sUUFBUSxJQUFJLEtBQUssS0FBSyxLQUFJLE1BQUs7SUFDekMsTUFBTSxJQUFJLElBQUksR0FBRyxJQUFJLEtBQUssTUFBTSxJQUFJLENBQUM7SUFDckMsT0FBTyxNQUFNLElBQUksTUFBTSxDQUFDLEdBQUcsV0FBVyxJQUFJLFFBQVEsR0FBRyxHQUFHLENBQUMsR0FBRyxRQUFRLGdCQUFnQixPQUFPLEdBQUcsR0FBRyxDQUFDLElBQUksZ0JBQWdCLE1BQU0sR0FBRyxHQUFHLENBQUMsSUFBSSxTQUFTO0dBQ2xKLENBQUMsQ0FBQztHQUNGLElBQUksSUFBSSxTQUFTLElBQUksR0FBRyxPQUFPO0dBQy9CLGlCQUFpQixJQUFJLElBQUksTUFBTSxDQUFDO0VBQ2xDO0VBQ0EsSUFBSSxJQUFJLFNBQVMsSUFBSSxHQUFHLE9BQU87RUFDL0IsT0FBTztHQUFFLElBQUksWUFBWSxJQUFJLEtBQUssT0FBTyxLQUFLLE1BQU0sSUFBSSxLQUFJLE1BQU0sTUFBTSxZQUFZLE9BQU8sQ0FBRSxHQUFHLElBQUk7R0FBRyxNQUFNO0VBQU07Q0FDckg7O0NBR0EsU0FBUyxZQUFZLEdBQXVCO0VBQzFDLElBQUksSUFBSSxhQUFhLElBQUksRUFBRSxHQUFHO0VBQzlCLElBQUksS0FBSyxFQUFFLFlBQVksQ0FBQyxhQUFhLEVBQUUsVUFBVSxFQUFFLEdBQUcsR0FBRztHQUFFLGFBQWEsT0FBTyxFQUFFLEdBQUc7R0FBRyxJQUFJO0VBQVc7RUFDdEcsSUFBSSxDQUFDLEdBQUc7R0FDTixNQUFNLFFBQW1CO0lBQUUsU0FBUztJQUFNLFFBQVE7SUFBTSxVQUFVO0lBQ2hFLElBQUksVUFBVTtLQUFFLE9BQU8sS0FBSyxXQUFXLFFBQVEsUUFBUSxLQUFLLE1BQU07SUFBRztHQUFFO0dBQ3pFLE1BQU0sV0FBVyxZQUFZO0lBQzNCLE1BQU0sT0FBTyxNQUFNLFVBQVUsRUFBRSxLQUFLLElBQUk7SUFDeEMsTUFBTSxTQUFTLFFBQVEsU0FBUyxZQUFZLE1BQU0sYUFBYSxNQUFNLEVBQUUsTUFBTSxDQUFDLENBQUMsRUFBRSxTQUFTLENBQUMsQ0FBQyxZQUFZLElBQUksSUFBSTtJQUNoSCxJQUFJLFFBQVE7S0FDVixNQUFNLFNBQVM7S0FDZixnQkFBZ0IsUUFBUSxFQUFFLE9BQU8sWUFBWSxNQUFNLFNBQVM7TUFDMUQsTUFBTSxTQUFTO01BQ2YsSUFBSSxhQUFhLElBQUksRUFBRSxHQUFHLE1BQU0sT0FBTyxhQUFhLE9BQU8sRUFBRSxHQUFHO0tBQ2xFLEdBQUcsTUFBTTtJQUNYLE9BQ0s7S0FBRSxNQUFNLFdBQVcsWUFBWSxJQUFJO0tBQUcsUUFBUSxLQUFLLHFDQUFxQyxFQUFFLEdBQUc7SUFBRztJQUNyRyxPQUFPO0dBQ1QsRUFBQyxDQUFFLENBQUMsQ0FBQyxjQUFjO0lBQUUsTUFBTSxVQUFVO0dBQU0sQ0FBQztHQUM1QyxhQUFhLElBQUksRUFBRSxLQUFNLElBQUksS0FBTTtFQUNyQztFQUNBLElBQUksRUFBRSxRQUFRLGFBQWEsUUFBUSxFQUFFLEtBQUs7RUFDMUMsT0FBTztDQUNUO0NBRUEsZUFBZSxRQUFRLEtBQXFDLE1BQStCO0VBQ3pGLE1BQU0sTUFBTSxZQUFZLElBQUksR0FBRztFQUMvQixJQUFJLE1BQU0sSUFBSSxLQUFLLFNBQVMsSUFBSTtFQUNoQyxJQUFJLENBQUMsVUFBVSxJQUFJLE9BQU87R0FDeEIsTUFBTSxRQUFRLE1BQU0sWUFBWSxJQUFJLEtBQUssQ0FBQyxDQUFDO0dBQzNDLElBQUksU0FBUyxDQUFDLElBQUksUUFBUTtJQUFFLE1BQU0sSUFBSTtJQUFPLFNBQVM7R0FBTztFQUMvRDtFQUNBLFdBQVcsTUFBTSxJQUFJO0VBQ3JCLE1BQU0sTUFBTSxRQUFRLE9BQU8sSUFBSTtFQUMvQixJQUFJLENBQUMsS0FBSyxPQUFPO0dBQUUsSUFBSTtHQUFNLE1BQU07RUFBSztFQUN4QyxPQUFPO0dBQUUsSUFBSSxRQUFRLEtBQUssSUFBSSxJQUFJLElBQUksSUFBSSxJQUFJO0dBQUcsTUFBTTtFQUFNO0NBQy9EO0NBRUEsU0FBUyxVQUFVLEtBQXFDO0VBQ3RELElBQUksSUFBSSxRQUFRLElBQUksR0FBRztFQUN2QixJQUFJLEtBQUssRUFBRSxZQUFZLENBQUMsYUFBYSxFQUFFLFVBQVUsR0FBRyxHQUFHO0dBQUUsUUFBUSxPQUFPLEdBQUc7R0FBRyxJQUFJO0VBQVc7RUFDN0YsSUFBSSxDQUFDLEdBQUc7R0FDTixNQUFNLFFBQXFCO0lBQUUsU0FBUztJQUFNLFFBQVE7SUFBTSxVQUFVO0lBQ2xFLElBQUksVUFBVTtLQUFFLE9BQU8sS0FBSyxXQUFXLFFBQVEsUUFBUSxLQUFLLE1BQU07SUFBRztHQUFFO0dBQ3pFLE1BQU0sV0FBVyxZQUFZO0lBQzNCLE1BQU0sT0FBTyxNQUFNLFVBQVUsR0FBRztJQUNoQyxNQUFNLFNBQVMsUUFBUSxTQUFTLFlBQVksTUFBTSxhQUFhLElBQUksQ0FBQyxDQUFDLFlBQVksSUFBSSxJQUFJO0lBQ3pGLElBQUksQ0FBQyxRQUFRO0tBQUUsTUFBTSxXQUFXLFlBQVksSUFBSTtLQUFHLFFBQVEsS0FBSyw0QkFBNEIsR0FBRztLQUFHLE9BQU87SUFBTTtJQUMvRyxNQUFNLFNBQVM7SUFDZixnQkFBZ0IsVUFBVSxPQUFPLFlBQVksTUFBTSxTQUFTO0tBQzFELE1BQU0sU0FBUztLQUNmLElBQUksUUFBUSxJQUFJLEdBQUcsTUFBTSxPQUFPLFFBQVEsT0FBTyxHQUFHO0lBQ3BELEdBQUcsUUFBUTtJQUNYLE9BQU87R0FDVCxFQUFDLENBQUUsQ0FBQyxDQUFDLGNBQWM7SUFBRSxNQUFNLFVBQVU7R0FBTSxDQUFDO0dBQzVDLFFBQVEsSUFBSSxLQUFLLElBQUksS0FBSztFQUM1QjtFQUNBLElBQUksRUFBRSxRQUFRLGFBQWEsVUFBVSxLQUFLO0VBQzFDLE9BQU8sRUFBRTtDQUNYO0NBRUEsZUFBZSxVQUFVLEtBQXVDLE1BQStCO0VBQzdGLE1BQU0sU0FBUyxNQUFNLFVBQVUsSUFBSSxHQUFHO0VBQ3RDLElBQUksQ0FBQyxRQUFRLE9BQU87R0FBRSxJQUFJO0dBQU0sTUFBTTtFQUFLO0VBQzNDLE1BQU0sT0FBTyxXQUFXLElBQUksSUFBSSxNQUFNLFFBQVEsSUFBSSxTQUFTLElBQUksYUFBYSxJQUFJLFFBQVE7RUFDeEYsT0FBTztHQUFFLElBQUksT0FBTyxZQUFZLElBQUksS0FBSyxPQUFPLENBQUMsQ0FBQyxHQUFHLENBQUMsS0FBSyxHQUFHLEdBQUcsSUFBSSxJQUFJO0dBQU0sTUFBTTtFQUFNO0NBQzdGO0NBRUEsU0FBUyxpQkFBaUIsUUFBcUQ7RUFDN0UsTUFBTSxNQUFNLE9BQU87RUFDbkIsSUFBSSxJQUFJLGVBQWUsSUFBSSxHQUFHO0VBQzlCLElBQUksT0FBTyxXQUFXLENBQUMsZ0JBQWdCLElBQUksR0FBRyxHQUFHO0dBQy9DLGdCQUFnQixJQUFJLEtBQUssZUFBZSxPQUFPLE9BQU8sQ0FBQzs7O0dBR3ZELElBQUksR0FBRyxRQUFRO0lBQUUsa0JBQWtCLFdBQVcsS0FBSztJQUFHLGVBQWUsT0FBTyxHQUFHO0lBQUcsSUFBSTtHQUFXO0VBQ25HO0VBQ0EsSUFBSSxLQUFLLEVBQUUsWUFBWSxDQUFDLGFBQWEsRUFBRSxVQUFVLEdBQUcsR0FBRztHQUFFLGVBQWUsT0FBTyxHQUFHO0dBQUcsSUFBSTtFQUFXO0VBQ3BHLElBQUksQ0FBQyxHQUFHO0dBQ04sTUFBTSxRQUFxQjtJQUFFLFNBQVM7SUFBTSxRQUFRO0lBQU0sVUFBVTtJQUNsRSxJQUFJLFVBQVU7S0FBRSxPQUFPLEtBQUssV0FBVyxRQUFRLFFBQVEsS0FBSyxNQUFNO0lBQUc7R0FBRTtHQUN6RSxNQUFNLFdBQVcsWUFBWTtJQUMzQixNQUFNLE9BQU8sTUFBTSxVQUFVLEdBQUc7SUFDaEMsSUFBSSxDQUFDLFFBQVEsU0FBUyxXQUFXO0tBQUUsTUFBTSxXQUFXLFlBQVksSUFBSTtLQUFHLE9BQU87SUFBTTs7SUFFcEYsTUFBTSxTQUFTO0lBQ2YsSUFBSTtJQUNKLG1CQUFtQixJQUFJLFNBQWMsWUFBVztLQUFFLFVBQVU7SUFBUyxDQUFDO0lBQ3RFO0lBQWlCLE1BQU07SUFBUTtJQUMvQixJQUFJLFNBQXdCO0lBQzVCLElBQUk7S0FDRixNQUFNLE9BQU8sTUFBTSxPQUFPLElBQUksR0FBRyxVQUFVLGdCQUFnQixJQUFJLEdBQUc7S0FDbEUsU0FBUyxVQUFVLGlCQUFpQixNQUFNLE9BQU8sSUFBSSxFQUFFLFFBQVEsQ0FBQyxJQUFJLEVBQUU7O0tBRXRFLElBQUksQ0FBQyxXQUFXLEtBQUssT0FBTyxHQUFHLFNBQVMsVUFBVSxJQUFJO0lBQ3hELFFBQ007S0FBRSxNQUFNLFdBQVcsWUFBWSxJQUFJO0lBQUcsVUFDcEM7S0FBRSxRQUFRO0lBQUc7SUFDckIsSUFBSSxDQUFDLFFBQVEsT0FBTztJQUNwQixNQUFNLFNBQVM7SUFDZixnQkFBZ0IsV0FBVyxPQUFPLFlBQVksTUFBTSxTQUFTO0tBQzNELE1BQU0sU0FBUztLQUNmLElBQUksZUFBZSxJQUFJLEdBQUcsTUFBTSxPQUFPLGVBQWUsT0FBTyxHQUFHO0lBQ2xFLEdBQUcsUUFBUTtJQUNYLE9BQU87R0FDVCxFQUFDLENBQUUsQ0FBQyxDQUFDLGNBQWM7SUFBRSxNQUFNLFVBQVU7R0FBTSxDQUFDO0dBQzVDLGVBQWUsSUFBSSxLQUFLLElBQUksS0FBSztFQUNuQztFQUNBLElBQUksRUFBRSxRQUFRLGFBQWEsV0FBVyxLQUFLO0VBQzNDLE9BQU8sRUFBRTtDQUNYO0NBRUEsZUFBZSxXQUFXLEtBQXdDLE1BQStCO0VBQy9GLElBQUksTUFBNkMsTUFBTSxPQUFPO0VBQzlELEtBQUssTUFBTSxVQUFVLElBQUksU0FBUztHQUNoQyxNQUFNLFFBQVEsaUJBQWlCLElBQUksSUFBSSxHQUFHLFFBQVEsT0FBTyxTQUFTLFNBQVMsT0FBTyxPQUFPLG1CQUFtQixRQUFRLEtBQUssQ0FBQztHQUMxSCxJQUFJLE9BQU8sZUFBZSxZQUFZLFFBQVEsTUFBTSxVQUFVLE9BQU8sU0FBUyxJQUFJLEtBQUssSUFBSSxNQUFNLFVBQVUsT0FBTyxTQUFTLElBQUksS0FBSyxJQUFJO0dBQ3hJLE1BQU0sU0FBUyxNQUFNLGlCQUFpQixNQUFNO0dBQzVDLElBQUksQ0FBQyxRQUFRO0lBQUUsT0FBTztJQUFNO0dBQVU7R0FDdEMsSUFBSSxPQUFPLGVBQWUsVUFBVSx1QkFBdUIsSUFBSSxJQUFJLE1BQU0sSUFBSSxPQUFPLE1BQU07UUFDckY7SUFDSCxNQUFNLFFBQVEsT0FBTyxXQUFXO0lBQ2hDLElBQUksQ0FBQyxjQUFjLElBQUksSUFBSSxNQUFNLFNBQVMsQ0FBQyxLQUFLLElBQUksSUFBSSxDQUFDLEdBQUcsR0FBRyxPQUFPLEtBQUssR0FBRztJQUM5RSxNQUFNLE9BQU8sT0FBTyxPQUFPLElBQUksT0FBUSxJQUFJLEtBQUssUUFBUSxJQUFJLEtBQUssU0FBUyxPQUFRO0lBQ2xGLE1BQU0sSUFBSSxNQUFNLEtBQUssTUFBTSxLQUFLLEtBQUssT0FBUSxJQUFJLFFBQVMsS0FBSyxFQUFFLENBQUMsR0FBRyxHQUFHLE9BQU8sT0FBTyxTQUFTLENBQUMsR0FBRyxJQUFJLE9BQU8sT0FBTztJQUNySCxHQUFHLElBQUksS0FBSyxDQUFDO0lBQUcsWUFBWSxJQUFJLE9BQU8sRUFBRSxLQUFLLElBQUksUUFBUSxFQUFFLEtBQUssSUFBSSxNQUFNO0dBQzdFO0dBQ0EsSUFBSSxPQUFPLHNCQUFzQixXQUFXOztJQUUxQyxNQUFNLE1BQU0sSUFBSSxRQUFRLFFBQVEsT0FBTztJQUN2QyxJQUFJLE9BQU8sZUFBZSxTQUFTLEtBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxJQUFJLEtBQUs7S0FDOUQsTUFBTSxjQUFjLEtBQUssSUFBSSxLQUFLLEtBQUssS0FBSyxNQUFNLEdBQUcsRUFBRSxJQUFJLEdBQUcsRUFBRSxFQUFFLElBQUksR0FBRyxJQUFJO0tBQzdFLElBQUksY0FBYyxPQUFPLEdBQUcsSUFBSSxLQUFLO0lBQ3ZDO0dBQ0Y7R0FDQSxNQUFNLEtBQUssY0FBYyxJQUFJLFFBQVEsZ0JBQWdCLElBQUksT0FBTyxHQUFHLEdBQUcsT0FBTyxlQUFlLFVBQVUsSUFBSTtHQUMxRyxJQUFJLENBQUMsTUFBTSxDQUFDLE9BQU8sU0FBUztHQUM1QixRQUFRLElBQUksa0JBQWtCLEtBQUssQ0FBQztHQUNwQyx1QkFBdUIsS0FBSyxJQUFJLEdBQUcsS0FBSyxNQUFNLE9BQU8sT0FBTztFQUM5RDtFQUNBLElBQUksS0FBSyxVQUFVLEdBQUc7RUFDdEIsT0FBTztHQUFFLElBQUk7R0FBSztFQUFLO0NBQ3pCO0NBRUEsZUFBZSxhQUFhLFFBQTZCLEtBQWEsS0FBcUM7RUFDekcsTUFBTSxLQUFLLE1BQU0saUJBQWlCLE1BQU0sRUFBQyxFQUFHLE9BQU87RUFDbkQsSUFBSSxDQUFDLEtBQUssRUFBRSxPQUFPLEdBQUcsT0FBTztFQUM3QixJQUFJLEtBQWE7RUFDakIsSUFBSSxPQUFPLGVBQWUsVUFBVTtHQUNsQyxNQUFNLEtBQUssUUFBUyxNQUFNLE9BQU8sTUFBTSxPQUFPLE1BQU8sTUFBTSxFQUFFLENBQUM7R0FDOUQsTUFBTSxNQUFNLEtBQUssT0FBTyxLQUFLLE9BQU8sTUFBTSxFQUFFLENBQUMsR0FBRyxHQUFHLEVBQUUsSUFBSSxDQUFDO0VBQzVELE9BQU87R0FDTCxNQUFNLFFBQVEsT0FBTyxTQUFTLFNBQVMsT0FBTyxPQUFPLG1CQUFtQixRQUFRLEtBQUssQ0FBQztHQUN0RixJQUFJLFFBQVEsTUFBTSxPQUFPLE1BQU0sTUFBTSxPQUFPO0dBQzVDLElBQUksT0FBTyxzQkFBc0IsYUFBYSxLQUFLLElBQUksR0FBRyxJQUFJLE9BQU8sbUJBQW1CLE9BQU87R0FDL0YsTUFBTSxNQUFNLElBQUksU0FBUyxLQUFLLEtBQUssS0FBSyxLQUFLLElBQUksR0FBRyxLQUFLLE1BQU0sQ0FBQyxHQUFHLE9BQU8sT0FBTyxXQUFXO0dBQzVGLE1BQU0sSUFBSSxNQUFNLEtBQUssSUFBSSxNQUFNLEdBQUcsR0FBRyxLQUFLLFFBQVEsQ0FBQyxJQUFJLEtBQUssTUFBTSxLQUFLLElBQUksTUFBTSxHQUFHO0dBQ3BGLE1BQU0sS0FBSyxPQUFPLElBQUksU0FBUyxJQUFJLFFBQVEsRUFBRSxDQUFDO0dBQUcsTUFBTSxLQUFLLE9BQU8sT0FBTyxNQUFNLElBQUksUUFBUSxFQUFFLENBQUM7R0FDL0YsSUFBSSxNQUFNLEtBQUssTUFBTSxLQUFLLE9BQU8sRUFBRSxLQUFLLE9BQU8sRUFBRSxHQUFHLE9BQU87RUFDN0Q7RUFDQSxNQUFNLFFBQVEsRUFBRSxLQUFLLE1BQU0sRUFBRSxJQUFJO0VBQ2pDLE9BQU8sVUFBVSxNQUFNLE9BQU87Q0FDaEM7Q0FFQSxlQUFlLE9BQU8sRUFBRSxJQUFJLEtBQUssWUFBNkM7RUFDNUUsTUFBTSxhQUFhLElBQUksZ0JBQWdCO0VBQ3ZDLEtBQUssSUFBSSxJQUFJLFVBQVU7RUFDdkIsSUFBSSxTQUE2QixNQUFNLE9BQU8sTUFBTSxTQUFTO0VBQzdELElBQUk7R0FDRixNQUFNLElBQUksSUFBSSxTQUFTLFNBQVMsTUFBTSxRQUFRLEtBQUssUUFBUSxJQUFJLElBQUksU0FBUyxZQUFZLE1BQU0sV0FBVyxLQUFLLFFBQVEsSUFDbEgsSUFBSSxTQUFTLFNBQVMsTUFBTSxRQUFRLEtBQUssUUFBUSxJQUFJLElBQUksU0FBUyxVQUFVLE1BQU0sU0FBUyxLQUFLLFFBQVEsSUFDeEcsSUFBSSxTQUFTLFVBQVUsTUFBTSxTQUFTLEtBQUssVUFBVSxXQUFXLE1BQU0sSUFBSSxJQUFJLFNBQVMsWUFBWSxNQUFNLFdBQVcsS0FBSyxRQUFRLElBQUksTUFBTSxVQUFVLEtBQUssUUFBUTtHQUN0SyxXQUFXLE9BQU8sZUFBZTtHQUNqQyxPQUFPLEVBQUU7R0FBTSxTQUFTLENBQUMsQ0FBQyxFQUFFO0dBQzVCLElBQUksRUFBRSxJQUFJLFNBQVMsTUFBTSxrQkFBa0IsSUFBSSxVQUFVLEVBQUUsSUFBSSxNQUFNLElBQUksR0FBRztJQUFFLGtCQUFrQjtJQUFRLHNCQUFzQjtHQUFPLENBQUM7RUFDeEksU0FBUyxLQUFLO0dBQ1osSUFBSSxDQUFDLFdBQVcsT0FBTyxTQUFTLFFBQVEsS0FBSyx3QkFBd0IsR0FBRztFQUMxRTtFQUNBLEtBQUssT0FBTyxFQUFFO0VBQ2QsSUFBSSxXQUFXLE9BQU8sU0FBUztHQUFFLFFBQVEsTUFBTTtHQUFHLFNBQVM7R0FBTSxPQUFPO0dBQU8sU0FBUztFQUFNO0VBQzlGLE1BQU0sTUFBa0I7R0FBRTtHQUFJO0dBQVE7R0FBTTtHQUFXO0dBQVEsS0FBSztJQUFDLElBQUk7SUFBSSxJQUFJO0lBQUksSUFBSTtHQUFFO0dBQUc7R0FBUyxPQUFPLGtCQUFrQjtFQUFFO0VBQ2xJLFlBQVk7RUFDWixLQUFLLFlBQVksS0FBSyxFQUFFLFVBQVUsU0FBUyxDQUFDLE1BQU0sSUFBSSxDQUFDLEVBQUUsQ0FBQztDQUM1RDtDQUVBLEtBQUssYUFBYSxNQUE4QjtFQUM5QyxNQUFNLElBQUksRUFBRTtFQUNaLElBQUksZUFBZSxHQUFHO0dBQUUsWUFBWSxFQUFFO0dBQVc7RUFBUTtFQUN6RCxJQUFJLHNCQUFzQixHQUFHO0dBQzNCLElBQUksT0FBTyxTQUFTLEVBQUUsZ0JBQWdCLEtBQUssRUFBRSxvQkFBb0IsS0FBSyxJQUFJO0lBQUUscUJBQXFCLEVBQUU7SUFBa0IsWUFBWTtHQUFHO0VBQ3RJLE9BQ0ssSUFBSSxZQUFZLEdBQUcsS0FBSyxJQUFJLEVBQUUsTUFBTSxDQUFDLEVBQUUsTUFBTTtPQUM3QyxJQUFJLG9CQUFvQixHQUFHO0dBQUUsZUFBZSxZQUFZLElBQUk7R0FBRyxLQUFLLE1BQU0sS0FBSyxTQUFTLE9BQU8sR0FBRyxFQUFFLFFBQVE7RUFBRyxPQUMvRyxJQUFJLGtCQUFrQixHQUFHLFNBQVM7R0FBRSxNQUFNLEVBQUU7R0FBTSxPQUFPLGtCQUFrQixFQUFFLFlBQVk7RUFBRTtPQUUzRixJQUFJLGlCQUFpQixHQUFHLE1BQU0sWUFBWTtHQUFFLEtBQUssTUFBTSxLQUFLLEVBQUUsYUFBYSxNQUFNLFVBQVUsQ0FBQyxDQUFDLENBQUMsWUFBWSxJQUFJO0VBQUcsRUFBQyxDQUFFO09BQ3BILElBQUksaUJBQWlCLEdBQUcsTUFBTSxZQUFZO0dBQzdDLElBQUksS0FBSyxNQUFNLE9BQU87R0FDdEIsS0FBSyxNQUFNLFVBQVUsRUFBRSxhQUFhO0lBQ2xDLEtBQUssQ0FBQyxDQUFFLE1BQU0saUJBQWlCLE1BQU0sQ0FBQyxDQUFDLFlBQVksSUFBSSxLQUFNO0lBQzdELEtBQUssWUFBWTtLQUFFLElBQUk7S0FBRyxRQUFRO0tBQU0sTUFBTTtLQUFPLFdBQVc7S0FBTyxRQUFRLEVBQUU7S0FBUSxVQUFVLEVBQUUsT0FBTyxFQUFFLFlBQVk7S0FBUSxRQUFRO0tBQUksT0FBTyxrQkFBa0I7SUFBRSxDQUFzQjtHQUNqTTtHQUNBLElBQUksQ0FBQyxFQUFFLFlBQVksUUFBUSxLQUFLLFlBQVk7SUFBRSxJQUFJO0lBQUcsUUFBUTtJQUFNLE1BQU07SUFBTyxXQUFXO0lBQU8sUUFBUSxFQUFFO0lBQVEsVUFBVTtJQUFHLFFBQVE7R0FBSyxDQUFzQjtFQUN0SyxFQUFDLENBQUU7T0FDRSxJQUFJLGtCQUFrQixHQUFHLEtBQUssYUFBYSxFQUFFLGFBQWEsUUFBUSxFQUFFLGFBQWEsS0FBSyxFQUFFLGFBQWEsR0FBRyxDQUFDLENBQUMsTUFBSyxVQUFTO0dBQzNILEtBQUssWUFBWTtJQUFFLElBQUk7SUFBRyxRQUFRO0lBQU0sTUFBTTtJQUFPLFdBQVc7SUFBTyxTQUFTLEVBQUU7SUFBUztHQUFNLENBQXNCO0VBQ3pILENBQUMsQ0FBQyxDQUFDLFlBQVksS0FBSyxZQUFZO0dBQUUsSUFBSTtHQUFHLFFBQVE7R0FBTSxNQUFNO0dBQU8sV0FBVztHQUFPLFNBQVMsRUFBRTtHQUFTLE9BQU87RUFBSyxDQUFzQixDQUFDO09BQ3hJLEtBQUssT0FBTyxDQUFDO0NBQ3BCO0FBQ0Y7QUFFQSxJQUFJLE9BQVEsV0FBK0Msc0JBQXNCLFlBQVksWUFBWSIsIm5hbWVzIjpbXSwiaWdub3JlTGlzdCI6W10sInNvdXJjZXMiOlsiaW1hZ2VyeVdvcmtlci50cz93b3JrZXJfZmlsZSZ0eXBlPW1vZHVsZSJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBJbWFnZXJ5IHdvcmtlcjogZG93bmxvYWRzIE5BU0EgbWFwIHBpY3R1cmVzLCBkZWNvZGVzIHRoZW0gYW5kIHJlLXByb2plY3RzIHRoZW0gaW50byB0aGUgc3F1YXJlXG4vLyB0aWxlcyBDZXNpdW0gZHJhcGVzIG92ZXIgdGhlIDNEIE1vb24uIEl0IGFsbCBydW5zIG9mZiB0aGUgbWFpbiB0aHJlYWQgc28gdGhlIHZpZXcgc3RheXMgc21vb3RoXG4vLyB3aGlsZSBuZXcgZGV0YWlsIHN0cmVhbXMgaW4uXG4vL1xuLy8gV2h5IHJlLXByb2plY3Q/IFdlIHJvdGF0ZSB0aGUgTW9vbiBpbnNpZGUgQ2VzaXVtIHNvIHRoZSBzb3V0aCBwb2xlIHNpdHMgb24gQ2VzaXVtJ3MgZXF1YXRvclxuLy8gKHNlZSBmcmFtZS50cykuIENlc2l1bSBhc2tzIGZvciBsb24vbGF0IHRpbGVzIG9mIHRoYXQgcm90YXRlZCBESVNQTEFZIGZyYW1lLCBidXQgZXZlcnkgTkFTQVxuLy8gcGljdHVyZSBpcyBkcmF3biBpbiB0aGUgVFJVRSBNb29uIGZyYW1lLiBTbyBmb3IgZWFjaCBwaXhlbCBvZiBhIGRpc3BsYXkgdGlsZSB3ZSB3b3JrIG91dCB3aGVyZVxuLy8gaXQgaXMgb24gdGhlIHJlYWwgTW9vbiBhbmQgcmVhZCB0aGUgc291cmNlIHBpY3R1cmUgdGhlcmUgKGJpbGluZWFyLCBsaWtlIGEgR1BVIHdvdWxkKS5cbi8vXG4vLyBTb3VyY2UgcGljdHVyZXM6XG4vLyAgIGJhc2UgICAgLSB0aGUgd2hvbGUtTW9vbiBwaWN0dXJlIHN0b3JlZCB3aXRoIHRoZSBhcHAsIGFscmVhZHkgZHJhd24gaW4gdGhlIGRpc3BsYXkgZnJhbWU6XG4vLyAgICAgICAgICAgICB0aWxlcyBhcmUgc2ltcGx5IGN1dCBvdXQgb2YgaXQgKGluc3RhbnQsIHdvcmtzIHdpdGggbm8gaW50ZXJuZXQpXG4vLyAgIHRyZWsgICAgLSBOQVNBIE1vb24gVHJlayBnbG9iYWwgdGlsZXMgKHRydWUgbG9uL2xhdCBncmlkLCAyNTYgcHggdGlsZXMsIGxldmVsIDAgPSAyeDEgdGlsZXMpXG4vLyAgIHBob3RvICAgLSBjbG9zZSB2aWV3czogS2FndXlhIFRDLCBib3VuZGVkIE5BQyBzaXRlIG1vc2FpY3MsIG5vcnRoLXBvbGUgTkFDOyBzYW1lIGxheWVyXG4vLyAgIHJhc3RlciAgLSBvbmUgbG9jYWwgc291dGgtcG9sYXIgcGljdHVyZSAocGhvdG8gb3Igc2NpZW5jZSBtYXApLCBoZWxkIGluIG1lbW9yeSBvbmNlXG4vLyAgIHB5cmFtaWQgLSBzaGFycCBzb3V0aC1wb2xhciBwaG90byBzcXVhcmVzOiByZWFkIGZyb20gdGhlIGNvcGllcyBzdG9yZWQgd2l0aCB0aGUgYXBwXG4vLyAgICAgICAgICAgICAocHVibGljL2RhdGEvcG9sYXIvdCwgbGlzdGVkIGluIGl0cyBpbmRleC5qc29uKSBhbmQgb25seSB3aGVyZSB0aGVyZSBpcyBubyBsb2NhbFxuLy8gICAgICAgICAgICAgY29weSBmcm9tIEFTVSBMdW5hc2VydjsgZmV0Y2hlZCBvbmNlIGFuZCByZXVzZWRcbi8vXG4vLyBOb3RoaW5nIGlzIGV2ZXIgYXNrZWQgZm9yIGJleW9uZCB0aGUgZGV0YWlsIHRoZSBkYXRhIGhhczogc3VjaCB0aWxlcyBhcmUgYW5zd2VyZWQgXCJrZWVwIHNob3dpbmdcbi8vIHRoZSBwYXJlbnQgdGlsZVwiIChzZWUgYHBhcmVudGAgaW4gRnJvbVdvcmtlciksIGFuZCBzbyBhcmUgdGlsZXMgd2hvc2UgZG93bmxvYWRzIGZhaWxlZCwgc28gYVxuLy8gc2xvdyBvciBtaXNzaW5nIHNlcnZlciBuZXZlciBsZWF2ZXMgaG9sZXMgb3IgZW5kbGVzcyBsb2FkaW5nLlxuLy9cbi8vIFRoZSB0b3AgaGFsZiBpcyBwbGFpbiBtYXRoIHdpdGggbm8gYnJvd3NlciBBUElzIGFuZCBubyBpbXBvcnRzLCBzbyBOb2RlIGNhbiBydW4gaXQgZm9yIHRoZVxuLy8gY2hlY2tzIGluIHNjcmlwdHMvY2hlY2staW1hZ2VyeS50cyAod2hpY2ggY29tcGFyZXMgaXQgYWdhaW5zdCBmcmFtZS50cykuIFRoZSB3b3JrZXIgaXRzZWxmXG4vLyAoZG93bmxvYWRzLCBjYWNoZXMsIG1lc3NhZ2UgbG9vcCkgaXMgYXQgdGhlIGJvdHRvbSBhbmQgb25seSBzdGFydHMgaW5zaWRlIGEgV2ViIFdvcmtlci5cblxuZXhwb3J0IGNvbnN0IFRJTEUgPSAyNTY7IC8vIGRpc3BsYXkgdGlsZXMgYXJlIDI1NiB4IDI1NiBwaXhlbHNcbmNvbnN0IE4yID0gVElMRSAqIFRJTEU7XG5jb25zdCBNT09OX1IgPSAxNzM3NDAwOyAvLyBzYW1lIHNwaGVyZSBhcyBmcmFtZS50cyBhbmQgTU9PTl9FTExJUFNPSURcbmNvbnN0IERFRyA9IE1hdGguUEkgLyAxODA7XG5cbi8qKlxuICogUG9sYXIgbGF5ZXJzIGFyZSBkcmF3biBvbmx5IHNvdXRoIG9mIHRoaXMgdHJ1ZSBsYXRpdHVkZSwgdW5sZXNzIGEgbGF5ZXIgc2V0cyBpdHMgb3duIGNsaXAuXG4gKiA4MCBkZWcgUyBpcyB0aGUgY2lyY2xlIHRoYXQganVzdCBmaXRzIGluc2lkZSB0aGUgNjA4IGttIHNxdWFyZSBvZiB0aGUgcG9sYXIgcGljdHVyZXMgKDMwNCBrbVxuICogZnJvbSB0aGUgcG9sZSksIHNvIHRoZSBwb2xhciBwaG90b3MgZW5kIGluIGEgcm91bmQgZWRnZSB3aXRoIG5vIHN0cmFpZ2h0IHNpZGVzLlxuICovXG5leHBvcnQgY29uc3QgUE9MQVJfTElNSVRfREVHID0gLTgwO1xuLyoqXG4gKiBXaWR0aCBvZiB0aGUgc29mdCBlZGdlIHdoZXJlIHRoZSBwb2xhciBwaG90b3MgZmFkZSBpbnRvIHRoZSBnbG9iYWwgTW9vbiBUcmVrIHBob3RvIGJlbG93LiBXaWRlXG4gKiBvbiBwdXJwb3NlOiB0aGUgdHdvIGFyZSBkaWZmZXJlbnQgTkFTQSBtb3NhaWNzIHRoYXQgYXJlIGxpdCBkaWZmZXJlbnRseSBpbiBwbGFjZXMgKG5lYXIgdHJ1ZVxuICogbG9uZ2l0dWRlICstOTAgZGVnKSwgYW5kIGEgbmFycm93IGVkZ2Ugc2hvd2VkIHRoZXJlIGFzIGEgc3RyYWlnaHQgc3RlcCBpbiBicmlnaHRuZXNzLlxuICovXG5leHBvcnQgY29uc3QgUE9MQVJfRkVBVEhFUl9NID0gNDAwMDA7XG4vKiogQXQgbW9zdCB0aGlzIG1hbnkgcHlyYW1pZCBzcXVhcmVzIHBlciBkaXNwbGF5IHRpbGUgYmVmb3JlIHdlIHN0ZXAgdG8gYSBjb2Fyc2VyIHB5cmFtaWQgbGV2ZWwuICovXG5jb25zdCBNQVhfUFlSQU1JRF9USUxFUyA9IDEyO1xuXG4vLyBNb29uIFRyZWsgbmVhciB0aGUgdHJ1ZSBwb2xlcy4gSXRzIHBpY3R1cmVzIGFyZSBsb24vbGF0IGdyaWRzLCBzbyB0b3dhcmRzIGEgcG9sZSBvbmUgZGlzcGxheVxuLy8gcGl4ZWwgY292ZXJzIG1vcmUgYW5kIG1vcmUgTW9vbiBUcmVrIHBpeGVscyBlYXN0LXdlc3QgKGFib3V0IDEvY29zKGxhdGl0dWRlKSBvZiB0aGVtKS4gT25lXG4vLyBzYW1wbGUgcGVyIGRpc3BsYXkgcGl4ZWwgd291bGQgdHVybiB0aGF0IGZpbmUgZGV0YWlsIGludG8gZmFsc2Ugc3RyaXBlcyAobW9pcsOpKSwgc28gd2UgYXZlcmFnZVxuLy8gc2V2ZXJhbCBzYW1wbGVzIGFsb25nIHRydWUgZWFzdCBpbnN0ZWFkLiBDbG9zZXIgdG8gdGhlIHRydWUgbm9ydGggcG9sZSB0aGFuIH44MsKwIHdlIGFsc28gcmVhZFxuLy8gY29hcnNlciBNb29uIFRyZWsgbGV2ZWxzLCBvciBhIHNpbmdsZSBkaXNwbGF5IHRpbGUgd291bGQgbmVlZCBodW5kcmVkcyBvZiBzb3VyY2UgdGlsZXMuIFRoYXRcbi8vIGNob2ljZSBkZXBlbmRzIG9ubHkgb24gdGhlIGxhdGl0dWRlIG9mIGVhY2ggcGl4ZWwsIHNvIG5laWdoYm91cmluZyB0aWxlcyBhbHdheXMgYWdyZWUgKG5vIHNlYW1zKS5cbmNvbnN0IFRBUF9TUEFDSU5HID0gMS4yNTsgLy8gYXQgbW9zdCB0aGlzIG1hbnkgc291cmNlIHBpeGVscyBiZXR3ZWVuIHR3byBzYW1wbGVzIGFsb25nIHRydWUgZWFzdFxuY29uc3QgTUFYX1RBUFMgPSA4OyAvLyBvbmx5IHJlYWNoZWQgYXQgbGV2ZWwgMCByaWdodCBhdCB0aGUgbm9ydGggcG9sZTsgZWxzZXdoZXJlIGF0IG1vc3QgNlxuY29uc3QgU1FVRUVaRV9GVUxMID0gNzsgLy8gZnVsbCBkZXRhaWwgd2hpbGUgMS9jb3MobGF0KSA8PSA3OiB1cCB0byB0cnVlIGxhdGl0dWRlIDgxLjjCsCAoYWxsIG9mIHRoZSBzb3V0aCB3ZSBkcmF3KVxuY29uc3QgU1FVRUVaRV9QT0xFID0gNS42OyAvLyBiZXlvbmQgdGhhdCwgb25lIGxldmVsIGNvYXJzZXIgcGVyIGRvdWJsaW5nLCBzbyBhIHBpeGVsIHNwYW5zIGF0IG1vc3QgNS42IHNvdXJjZSBwaXhlbHMgZWFzdC13ZXN0XG5jb25zdCBNQVhfVFJFS19MRVZFTCA9IDE2OyAvLyBOQUMgc2l0ZSBtb3NhaWNzIG5lZWQgZmluZXIgZ3JpZHMgdGhhbiB0aGUgZ2xvYmFsIFdBQyBwaG90b1xuXG4vKiogQSBkaXNwbGF5LWZyYW1lIHRpbGUgcmVjdGFuZ2xlLCByYWRpYW5zICh3aGF0IENlc2l1bSdzIHRpbGluZyBzY2hlbWUgZ2l2ZXMgdXMpLiAqL1xuZXhwb3J0IGludGVyZmFjZSBSZWN0IHsgd2VzdDogbnVtYmVyOyBzb3V0aDogbnVtYmVyOyBlYXN0OiBudW1iZXI7IG5vcnRoOiBudW1iZXIgfVxuXG5jb25zdCBjbGFtcCA9ICh4OiBudW1iZXIsIGxvOiBudW1iZXIsIGhpOiBudW1iZXIpID0+ICh4IDwgbG8gPyBsbyA6IHggPiBoaSA/IGhpIDogeCk7XG5jb25zdCBjbGFtcDAxID0gKHg6IG51bWJlcikgPT4gKHggPD0gMCA/IDAgOiB4ID49IDEgPyAxIDogeCk7XG5jb25zdCBzbW9vdGggPSAodDogbnVtYmVyKSA9PiAodCA8PSAwID8gMCA6IHQgPj0gMSA/IDEgOiB0ICogdCAqICgzIC0gMiAqIHQpKTtcblxuLyoqIFNpemUgb2Ygb25lIGRpc3BsYXktdGlsZSBwaXhlbCBhdCBhIHRpbGUgbGV2ZWwsIGluIGRlZ3JlZXMgb2YgYXJjIGFuZCBpbiBtZXRyZXMgb24gdGhlIHN1cmZhY2UuICovXG5leHBvcnQgY29uc3QgcGl4ZWxEZWcgPSAobGV2ZWw6IG51bWJlcikgPT4gMTgwIC8gKFRJTEUgKiAyICoqIGxldmVsKTtcblxuZXhwb3J0IGNvbnN0IHBpeGVsTWV0cmVzID0gKGxldmVsOiBudW1iZXIpID0+IHBpeGVsRGVnKGxldmVsKSAqIERFRyAqIE1PT05fUjtcblxuLyoqIExvd2VzdCBhbmQgaGlnaGVzdCBUUlVFIGxhdGl0dWRlIChkZWdyZWVzKSBhbnl3aGVyZSBpbnNpZGUgYSBkaXNwbGF5LWZyYW1lIHRpbGUuICovXG5leHBvcnQgZnVuY3Rpb24gdGlsZVRydWVMYXRSYW5nZShyOiBSZWN0KTogeyBtaW5EZWc6IG51bWJlcjsgbWF4RGVnOiBudW1iZXIgfSB7XG4gIC8vIFRydWUgbGF0aXR1ZGUgPSBhc2luKC1ZKSwgd2hlcmUgWSA9IGNvcyhsYXQpwrdzaW4obG9uKSBpcyB0aGUgZGlzcGxheSB1bml0IHZlY3RvcidzIHkuXG4gIC8vIGNvcyhsYXQpID49IDAsIHNvIHRoZSBleHRyZW1lcyBvZiB0aGUgcHJvZHVjdCBzaXQgYXQgdGhlIGV4dHJlbWVzIG9mIGVhY2ggZmFjdG9yLlxuICBjb25zdCBzdyA9IE1hdGguc2luKHIud2VzdCksIHNlID0gTWF0aC5zaW4oci5lYXN0KTtcbiAgbGV0IHNNaW4gPSBNYXRoLm1pbihzdywgc2UpLCBzTWF4ID0gTWF0aC5tYXgoc3csIHNlKTtcbiAgaWYgKHIud2VzdCA8PSBNYXRoLlBJIC8gMiAmJiByLmVhc3QgPj0gTWF0aC5QSSAvIDIpIHNNYXggPSAxO1xuICBpZiAoci53ZXN0IDw9IC1NYXRoLlBJIC8gMiAmJiByLmVhc3QgPj0gLU1hdGguUEkgLyAyKSBzTWluID0gLTE7XG4gIGNvbnN0IGNzID0gTWF0aC5jb3Moci5zb3V0aCksIGNuID0gTWF0aC5jb3Moci5ub3J0aCk7XG4gIGNvbnN0IGNNaW4gPSBNYXRoLm1pbihjcywgY24pLCBjTWF4ID0gci5zb3V0aCA8PSAwICYmIHIubm9ydGggPj0gMCA/IDEgOiBNYXRoLm1heChjcywgY24pO1xuICBjb25zdCB5TWluID0gc01pbiA+PSAwID8gY01pbiAqIHNNaW4gOiBjTWF4ICogc01pbjtcbiAgY29uc3QgeU1heCA9IHNNYXggPj0gMCA/IGNNYXggKiBzTWF4IDogY01pbiAqIHNNYXg7XG4gIHJldHVybiB7IG1pbkRlZzogTWF0aC5hc2luKGNsYW1wKC15TWF4LCAtMSwgMSkpIC8gREVHLCBtYXhEZWc6IE1hdGguYXNpbihjbGFtcCgteU1pbiwgLTEsIDEpKSAvIERFRyB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFRoZSBzZWFtIGZpeCAodjUpLiBOQVNBJ3MgV0FDIGdsb2JhbCBtb3NhaWMgaXMgbGl0IGZyb20gdGhlIHdlc3QgZXZlcnl3aGVyZSBleGNlcHQgdHJ1ZSBsb25cbi8vIC0xODAuLi05MCwgd2hpY2ggaXMgbGl0IGZyb20gdGhlIGVhc3Q6IHR3byBzdHJhaWdodCBsaWdodGluZyBmbGlwcyBhdCAtOTAgYW5kIDE4MCAoYm90aCBvbiBkaXNwbGF5XG4vLyB0aWxlIGVkZ2VzLCBzbyB0aGV5IHNob3cgYXMgY3Jpc3AgbGluZXMpLiBUaGVyZSB0aGUgYXBwIGRyYXdzIGFsYmVkbyB4IGhpbGxzaGFkZSBpbnN0ZWFkIChsaXQgZnJvbVxuLy8gdGhlIHdlc3QgbGlrZSB0aGUgcmVzdCksIGNyb3NzLWZhZGVkIGludG8gdGhlIHBob3RvIG92ZXIgLTkwLi4tODAgYW5kIDE2NS4uMTgwLiBUaGUgbG9jYWwgYmFzZVxuLy8gcGljdHVyZXMgaGF2ZSBpdCBiYWtlZCBpbiAoZGF0YS1wcmVwL2Jhc2VfbW9zYWljLnB5LCBzYW1lIGZvcm11bGEpOyBkZWVwZXIgdGlsZXMgZ2V0IGl0IGZyb20gdGhlXG4vLyAnc3ludGgnIGpvYiBiZWxvdy5cblxuZXhwb3J0IGNvbnN0IEZJWF9CQU5EX1dFU1Q6IHJlYWRvbmx5IFtudW1iZXIsIG51bWJlcl0gPSBbLTkwLCAtODBdOyAvLyBzeW50aGV0aWMgYXQgLTkwIC0+IHBob3RvIGF0IC04MCAoZGVncmVlcylcbmV4cG9ydCBjb25zdCBGSVhfQkFORF9FQVNUOiByZWFkb25seSBbbnVtYmVyLCBudW1iZXJdID0gWzE2NSwgMTgwXTsgLy8gcGhvdG8gYXQgMTY1IC0+IHN5bnRoZXRpYyBhdCAxODBcblxuLyoqIEhvdyBtdWNoIG9mIHRoZSBmaXhlZCBwaWN0dXJlICgxKSB2cyB0aGUgcGhvdG8gKDApIHNob3dzIGF0IGEgdHJ1ZSBsb25naXR1ZGUgKGRlZ3JlZXMpLiBTYW1lIGFzIGZpeF93ZWlnaHQgaW4gYmFzZV9tb3NhaWMucHkuICovXG5leHBvcnQgZnVuY3Rpb24gZml4V2VpZ2h0RGVnKGxvbkRlZzogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbG9uID0gKCgoKGxvbkRlZyArIDE4MCkgJSAzNjApICsgMzYwKSAlIDM2MCkgLSAxODA7XG4gIGlmIChsb24gPD0gRklYX0JBTkRfV0VTVFswXSkgcmV0dXJuIDE7XG4gIGlmIChsb24gPCBGSVhfQkFORF9XRVNUWzFdKSByZXR1cm4gMSAtIHNtb290aCgobG9uIC0gRklYX0JBTkRfV0VTVFswXSkgLyAoRklYX0JBTkRfV0VTVFsxXSAtIEZJWF9CQU5EX1dFU1RbMF0pKTtcbiAgaWYgKGxvbiA+PSBGSVhfQkFORF9FQVNUWzBdKSByZXR1cm4gbG9uID49IDE4MCAtIDFlLTkgPyAxIDogc21vb3RoKChsb24gLSBGSVhfQkFORF9FQVNUWzBdKSAvIChGSVhfQkFORF9FQVNUWzFdIC0gRklYX0JBTkRfRUFTVFswXSkpO1xuICByZXR1cm4gMDtcbn1cblxuLyoqXG4gKiBTbWFsbGVzdCBhbmQgbGFyZ2VzdCBmaXggd2VpZ2h0IG92ZXIgYSBkaXNwbGF5IHRpbGUsIG1lYXN1cmVkIG9uIGEgOSB4IDkgZ3JpZCB3aXRoIGEgc2FmZXR5IG1hcmdpbiBvZiBhXG4gKiBxdWFydGVyIHRpbGUgaW4gdHJ1ZSBsb25naXR1ZGUgKG1pbiAxID0gdGhlIHBob3RvIGlzIGZ1bGx5IGNvdmVyZWQsIG1heCAwID0gdGhlIGZpeCBkcmF3cyBub3RoaW5nKS5cbiAqIFRpbGVzIHJlYWNoaW5nIHdpdGhpbiA2wrAgb2YgYSB0cnVlIHBvbGUgKHdoZXJlIHRydWUgbG9uZ2l0dWRlIHNwYW5zIGV2ZXJ5dGhpbmcpIGFuc3dlciB7MCwgMX0uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0aWxlRml4UmFuZ2UocjogUmVjdCk6IHsgbWluOiBudW1iZXI7IG1heDogbnVtYmVyIH0ge1xuICBjb25zdCBsYXQgPSB0aWxlVHJ1ZUxhdFJhbmdlKHIpO1xuICBpZiAobGF0Lm1heERlZyA+IDg0IHx8IGxhdC5taW5EZWcgPCAtODQpIHJldHVybiB7IG1pbjogMCwgbWF4OiAxIH07XG4gIGNvbnN0IG1hcmdpbiA9IE1hdGgubWF4KDAuMDUsICgoci5lYXN0IC0gci53ZXN0KSAvIERFRykgKiAwLjI1IC8gTWF0aC5tYXgoMC4xLCBNYXRoLmNvcyhNYXRoLm1heChNYXRoLmFicyhsYXQubWluRGVnKSwgTWF0aC5hYnMobGF0Lm1heERlZykpICogREVHKSkpO1xuICBsZXQgbWluID0gMSwgbWF4ID0gMDtcbiAgZm9yIChsZXQgaiA9IDA7IGogPD0gODsgaisrKSB7XG4gICAgY29uc3QgbGEgPSByLnNvdXRoICsgKChyLm5vcnRoIC0gci5zb3V0aCkgKiBqKSAvIDgsIGNsID0gTWF0aC5jb3MobGEpLCBaID0gTWF0aC5zaW4obGEpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDw9IDg7IGkrKykge1xuICAgICAgY29uc3QgbG8gPSByLndlc3QgKyAoKHIuZWFzdCAtIHIud2VzdCkgKiBpKSAvIDg7XG4gICAgICBjb25zdCB0TG9uID0gTWF0aC5hdGFuMihaLCBjbCAqIE1hdGguY29zKGxvKSkgLyBERUc7IC8vIGRpc3BsYXkgKFgsIFksIFopIC0+IHRydWUgbG9uID0gYXRhbjIoWiwgWClcbiAgICAgIGZvciAoY29uc3QgZCBvZiBbLW1hcmdpbiwgMCwgbWFyZ2luXSkgeyBjb25zdCB3ID0gZml4V2VpZ2h0RGVnKHRMb24gKyBkKTsgaWYgKHcgPCBtaW4pIG1pbiA9IHc7IGlmICh3ID4gbWF4KSBtYXggPSB3OyB9XG4gICAgfVxuICB9XG4gIHJldHVybiB7IG1pbiwgbWF4IH07XG59XG5cbi8qKiBXaGF0IHRoZSAnc3ludGgnIGpvYiBuZWVkcyAoZnJvbSBiYXNlLmpzb24gXCJmaXhcIik6IHRoZSBicmlnaHRuZXNzLW1hdGNoZWQgYWxiZWRvIGFuZCB0aGUgc2hhZGluZyBydWxlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBGaXhQYXJhbXMge1xuICBhbGJlZG86IHsgdXJsOiBzdHJpbmc7IHdlc3Q6IG51bWJlcjsgZWFzdDogbnVtYmVyOyBub3J0aDogbnVtYmVyOyBzb3V0aDogbnVtYmVyOyBzY2FsZTogbnVtYmVyIH07XG4gIEM6IG51bWJlcjsgUzA6IG51bWJlcjtcbiAgLyoqIE1vb24gVHJlayBoaWxsc2hhZGVzOiBgbmVhcmAgKFNMREVNMjAxNSwgNTkgbSkgd2l0aGluIMKxbmVhck1heExhdCwgYGZhcmAgKExPTEEsIDExOCBtKSBlbHNld2hlcmUuICovXG4gIG5lYXI6IHN0cmluZzsgZmFyOiBzdHJpbmc7IG5lYXJNYXhMYXQ6IG51bWJlcjtcbn1cbmV4cG9ydCBjb25zdCBGSVhfTkVBUl9NQVhfWiA9IDg7IC8vIExST19Mcm9jS2FndXlhX1NoYWRlXzYwTjYwU181MTJwcGQgaGFzIGxldmVscyAwLTk7IDggKDg0IG0pIG1hdGNoZXMgdGhlIFdBQyBwaG90byBhbmQgbmVlZHMgNHggZmV3ZXIgZG93bmxvYWRzXG5leHBvcnQgY29uc3QgRklYX0ZBUl9NQVhfWiA9IDY7IC8vIExST19MT0xBX1NoYWRlX0dsb2JhbF8yNTZwcGRfdjA2IGhhcyBsZXZlbHMgMC02IChpdHMgY2FwYWJpbGl0aWVzIGxpc3QgbW9yZSlcblxuLyoqIFRoZSBoaWxsc2hhZGUgbGF5ZXIgYW5kIGRlZXBlc3QgbGV2ZWwgYSBmaXggdGlsZSByZWFkcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaXhTaGFkZUZvcihmaXg6IEZpeFBhcmFtcywgcjogUmVjdCk6IHsgbGF5ZXI6IHN0cmluZzsgbWF4WjogbnVtYmVyIH0ge1xuICBjb25zdCBsYXQgPSB0aWxlVHJ1ZUxhdFJhbmdlKHIpO1xuICByZXR1cm4gbGF0Lm1pbkRlZyA+IC1maXgubmVhck1heExhdCAmJiBsYXQubWF4RGVnIDwgZml4Lm5lYXJNYXhMYXQgPyB7IGxheWVyOiBmaXgubmVhciwgbWF4WjogRklYX05FQVJfTUFYX1ogfSA6IHsgbGF5ZXI6IGZpeC5mYXIsIG1heFo6IEZJWF9GQVJfTUFYX1ogfTtcbn1cblxuLyoqIEJpbGluZWFyIHNhbXBsZSBvZiBhIHRydWUgbG9uL2xhdCBwaWN0dXJlIChsb24gd3JhcHMgZnJvbSBgd2VzdGAsIGBlYXN0IC0gd2VzdGAgd2lkZSkgYXQgdHJ1ZSBsYXQvbG9uIChyYWRpYW5zKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzYW1wbGVMb25MYXQoczogU3JjLCB3ZXN0OiBudW1iZXIsIGVhc3Q6IG51bWJlciwgbm9ydGg6IG51bWJlciwgc291dGg6IG51bWJlciwgbGF0UmFkOiBudW1iZXIsIGxvblJhZDogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbG9uRCA9IGxvblJhZCAvIERFRywgbGF0RCA9IGxhdFJhZCAvIERFRztcbiAgY29uc3QgdSA9ICgoKChsb25EIC0gd2VzdCkgJSAzNjApICsgMzYwKSAlIDM2MCkgKiAocy53IC8gKGVhc3QgLSB3ZXN0KSkgLSAwLjUsIHYgPSAobm9ydGggLSBsYXREKSAqIChzLmggLyAobm9ydGggLSBzb3V0aCkpIC0gMC41O1xuICBjb25zdCBjMCA9IGNsYW1wKE1hdGguZmxvb3IodSksIDAsIHMudyAtIDIpLCByMCA9IGNsYW1wKE1hdGguZmxvb3IodiksIDAsIHMuaCAtIDIpLCB0eCA9IGNsYW1wMDEodSAtIGMwKSwgdHkgPSBjbGFtcDAxKHYgLSByMCk7XG4gIGNvbnN0IGQgPSBzLmRhdGEsIGNoID0gcy5jaCwgYSA9IChyMCAqIHMudyArIGMwKSAqIGNoLCBiID0gYSArIGNoLCBjID0gYSArIHMudyAqIGNoLCBlID0gYyArIGNoO1xuICByZXR1cm4gKGRbYV0gKiAoMSAtIHR4KSArIGRbYl0gKiB0eCkgKiAoMSAtIHR5KSArIChkW2NdICogKDEgLSB0eCkgKyBkW2VdICogdHgpICogdHk7XG59XG5cbi8qKiBEaXN0YW5jZSBmcm9tIHRoZSBzb3V0aCBwb2xlIG9uIHRoZSBzb3V0aC1wb2xhci1zdGVyZW9ncmFwaGljIG1hcCAobSkgYXQgYSB0cnVlIGxhdGl0dWRlLiAqL1xuZXhwb3J0IGNvbnN0IHBvbGFyUmhvID0gKHRydWVMYXREZWc6IG51bWJlcikgPT4gMiAqIE1PT05fUiAqIE1hdGgudGFuKE1hdGguUEkgLyA0ICsgKHRydWVMYXREZWcgKiBERUcpIC8gMik7XG5cbi8qKiBOQVNBIE1vb24gVHJlayBXTVRTIHRpbGUgKHRydWUgbG9uL2xhdCk6IHJvdyAwIGF0IDkwwrBOLCBjb2x1bW4gMCBhdCAxODDCsFcuICovXG5leHBvcnQgY29uc3QgdHJla1VybCA9IChsYXllcjogc3RyaW5nLCBleHQ6IHN0cmluZywgejogbnVtYmVyLCB4OiBudW1iZXIsIHk6IG51bWJlcikgPT5cbiAgYGh0dHBzOi8vdHJlay5uYXNhLmdvdi90aWxlcy9Nb29uL0VRLyR7bGF5ZXJ9LzEuMC4wL2RlZmF1bHQvZGVmYXVsdDAyOG1tLyR7en0vJHt5fS8ke3h9LiR7ZXh0fWA7XG5cbi8qKiBUaGUgbGF5ZXIncyBXTVRTIGRlc2NyaXB0aW9uLCB3aGljaCBsaXN0cyB0aGUgbGV2ZWxzIHRoZSBzZXJ2ZXIgcmVhbGx5IGhhcy4gKi9cbmV4cG9ydCBjb25zdCB0cmVrQ2FwYWJpbGl0aWVzVXJsID0gKGxheWVyOiBzdHJpbmcpID0+IGBodHRwczovL3RyZWsubmFzYS5nb3YvdGlsZXMvTW9vbi9FUS8ke2xheWVyfS8xLjAuMC9XTVRTQ2FwYWJpbGl0aWVzLnhtbGA7XG5cbi8qKlxuICogRGVlcGVzdCBNb29uIFRyZWsgbGV2ZWwgbGlzdGVkIGluIGEgV01UU0NhcGFiaWxpdGllcy54bWwgKHRoZSBmaWxlIGFsc28gaG9sZHMgY29tbWVudGVkLW91dFxuICogbGV2ZWxzLCB3aGljaCBkbyBub3QgY291bnQpLCBvciBudWxsIGlmIGl0IGxpc3RzIG5vbmUuIFdlIGNhbm5vdCBzaW1wbHkgdHJ5IGEgbGV2ZWwgYW5kIGxvb2tcbiAqIGZvciBcIjQwNCBOb3QgRm91bmRcIjogTW9vbiBUcmVrIHNlbmRzIGl0cyA0MDRzIHdpdGhvdXQgdGhlIENPUlMgaGVhZGVyLCBzbyBpbiBhIGJyb3dzZXIgYVxuICogbWlzc2luZyB0aWxlIGxvb2tzIGV4YWN0bHkgbGlrZSBhIG5ldHdvcmsgZmFpbHVyZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlVHJla0RlcHRoKHhtbDogc3RyaW5nKTogbnVtYmVyIHwgbnVsbCB7XG4gIGNvbnN0IGxpdmUgPSB4bWwucmVwbGFjZSgvPCEtLVtcXHNcXFNdKj8tLT4vZywgJycpO1xuICBsZXQgZGVwdGggPSAtMTtcbiAgZm9yIChjb25zdCBtIG9mIGxpdmUubWF0Y2hBbGwoLzxUaWxlTWF0cml4Plxccyo8b3dzOklkZW50aWZpZXI+XFxzKihcXGQrKVxccyo8XFwvb3dzOklkZW50aWZpZXI+L2cpKSBkZXB0aCA9IE1hdGgubWF4KGRlcHRoLCBOdW1iZXIobVsxXSkpO1xuICByZXR1cm4gZGVwdGggPj0gMCA/IGRlcHRoIDogbnVsbDtcbn1cblxuLy8gUG9sYXIgcHlyYW1pZDogdGhlIDYwOCBrbSBzcXVhcmUgYXJvdW5kIHRoZSBzb3V0aCBwb2xlIHNwbGl0IGludG8gMl5rIHggMl5rIHNxdWFyZXMgb2YgNTEyIHB4XG4vLyAoMTE4Ny8yXmsgbWV0cmVzIHBlciBwaXhlbCksIGVhY2ggZmV0Y2hlZCBvbmNlIGZyb20gQVNVIEx1bmFzZXJ2IGluIHRoZSBwb2xhciBwcm9qZWN0aW9uLlxuZXhwb3J0IGNvbnN0IFBZUkFNSURfSEFMRl9NID0gMzA0MDAwO1xuY29uc3QgUFlSQU1JRF9TUEFOX00gPSAyICogUFlSQU1JRF9IQUxGX007XG5leHBvcnQgY29uc3QgUFlSQU1JRF9QWCA9IDUxMjtcbmV4cG9ydCBjb25zdCBQWVJBTUlEX01BWF9LID0gMTA7IC8vIH4xLjIgbSBwZXIgcGl4ZWwsIGFib3V0IHRoZSBOQUMgbW9zYWljJ3Mgb3duIGRldGFpbFxuY29uc3QgUFlSQU1JRF9IT1NUUyA9IFsnd21zJywgJ3dtczEnLCAnd21zMicsICd3bXMzJywgJ3dtczQnLCAnd21zNScsICd3bXM2JywgJ3dtczcnXTtcblxuLyoqXG4gKiBUaGUgc2hhcnAgTkFDIG1vc2FpYyBvbmx5IGV4aXN0cyBzb3V0aCBvZiB0aGlzIHRydWUgbGF0aXR1ZGUgKG1lYXN1cmVkOiBMdW5hc2VydidzXG4gKiBsdW5hX25hY19wb2xlX2NvbnRyb2xfc291dGggbGF5ZXIgaXMgZW1wdHkgYmV5b25kIDE4MiBrbSBmcm9tIHRoZSBwb2xlKS4gRnVydGhlciBvdXQgdGhlIHNlcnZlclxuICogb25seSBoYXMgdGhlIDEwMCBtL3BpeGVsIFdBQyBtb3NhaWMuXG4gKi9cbmV4cG9ydCBjb25zdCBQWVJBTUlEX05BQ19MQVRfREVHID0gLTg0O1xuLyoqIEZpbmVzdCBweXJhbWlkIGxldmVsIHdvcnRoIGRyYXdpbmcgd2hlcmUgb25seSB0aGUgV0FDIG1vc2FpYyBleGlzdHM6IDc0IG0vcGl4ZWwgc2hvd3MgYWxsIG9mIGl0cyBkZXRhaWwuICovXG5leHBvcnQgY29uc3QgUFlSQU1JRF9XQUNfTUFYX0sgPSA0O1xuXG4vKiogUHlyYW1pZCBsZXZlbCB3aG9zZSBwaXhlbHMgYXJlIGF0IGxlYXN0IGFzIGZpbmUgYXMgYSBkaXNwbGF5IHRpbGUncyBwaXhlbHMgYXQgdGhpcyBsZXZlbC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBweXJhbWlkTGV2ZWxGb3IoZGlzcGxheUxldmVsOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBrID0gTWF0aC5jZWlsKE1hdGgubG9nMihQWVJBTUlEX1NQQU5fTSAvIChQWVJBTUlEX1BYICogcGl4ZWxNZXRyZXMoZGlzcGxheUxldmVsKSkpKTtcbiAgcmV0dXJuIGNsYW1wKGssIDAsIFBZUkFNSURfTUFYX0spO1xufVxuXG4vKiogV01TIHJlcXVlc3QgZm9yIHB5cmFtaWQgc3F1YXJlIChpID0gY29sdW1uIGZyb20gdGhlIGxlZnQsIGogPSByb3cgZnJvbSB0aGUgdG9wKSBhdCBsZXZlbCBrLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHB5cmFtaWRVcmwobGF5ZXJzOiBzdHJpbmcsIGs6IG51bWJlciwgaTogbnVtYmVyLCBqOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBTID0gUFlSQU1JRF9TUEFOX00gLyAyICoqIGs7XG4gIGNvbnN0IHgwID0gLVBZUkFNSURfSEFMRl9NICsgaSAqIFMsIHkxID0gUFlSQU1JRF9IQUxGX00gLSBqICogUztcbiAgcmV0dXJuIGBodHRwczovLyR7UFlSQU1JRF9IT1NUU1soaSArIGogKiAzICsgaykgJSBQWVJBTUlEX0hPU1RTLmxlbmd0aF19LmltLWxkaS5jb20vP1NFUlZJQ0U9V01TJlZFUlNJT049MS4xLjEmUkVRVUVTVD1HZXRNYXAmU1RZTEVTPSZMQVlFUlM9JHtsYXllcnN9YFxuICAgICsgYCZTUlM9SUFVMjAwMDozMDEyMCZCQk9YPSR7eDB9LCR7eTEgLSBTfSwke3gwICsgU30sJHt5MX0mV0lEVEg9JHtQWVJBTUlEX1BYfSZIRUlHSFQ9JHtQWVJBTUlEX1BYfSZGT1JNQVQ9aW1hZ2UvanBlZ2A7XG59XG5cbi8qKiBGaW5lc3QgcHlyYW1pZCBsZXZlbCB0aGF0IGhvbGRzIHJlYWwgZGV0YWlsIHNvbWV3aGVyZSBpbnNpZGUgYSBkaXNwbGF5IHRpbGUuICovXG5leHBvcnQgZnVuY3Rpb24gcHlyYW1pZE1heEtGb3IocjogUmVjdCk6IG51bWJlciB7XG4gIHJldHVybiB0aWxlVHJ1ZUxhdFJhbmdlKHIpLm1pbkRlZyA+PSBQWVJBTUlEX05BQ19MQVRfREVHID8gUFlSQU1JRF9XQUNfTUFYX0sgOiBQWVJBTUlEX01BWF9LO1xufVxuXG4vKipcbiAqIFRydWUgd2hlbiBhIGRpc3BsYXkgdGlsZSBjb3VsZCBvbmx5IHJlcGVhdCB3aGF0IGl0cyBwYXJlbnQgdGlsZSBhbHJlYWR5IHNob3dzLCBiZWNhdXNlIHRoZVxuICogcGhvdG9zIGhhdmUgbm8gZmluZXIgZGV0YWlsIHRoZXJlLiBDZXNpdW0gaXMgdGhlbiB0b2xkIHRvIGtlZXAgZHJhd2luZyB0aGUgcGFyZW50OiBubyBkb3dubG9hZCxcbiAqIG5vIHdvcmssIG5vIGV4dHJhIG1lbW9yeS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHB5cmFtaWRQYXJlbnRJc0Vub3VnaChyOiBSZWN0LCBkaXNwbGF5TGV2ZWw6IG51bWJlcik6IGJvb2xlYW4ge1xuICByZXR1cm4gZGlzcGxheUxldmVsID4gMCAmJiBweXJhbWlkTGV2ZWxGb3IoZGlzcGxheUxldmVsIC0gMSkgPj0gcHlyYW1pZE1heEtGb3Iocik7XG59XG5cbi8qKiBXaGljaCBweXJhbWlkIHNxdWFyZXMgYXJlIHN0b3JlZCB3aXRoIHRoZSBhcHA6IHBlciBsZXZlbCwgcGVyIHJvdywgW2ZpcnN0Q29sdW1uLCBsYXN0Q29sdW1uLCAuLi5dIHJ1bnMuICovXG5leHBvcnQgaW50ZXJmYWNlIFB5cmFtaWRJbmRleCB7IGxheWVyczogc3RyaW5nOyBjb3VudDogbnVtYmVyOyByb3dzOiBNYXA8bnVtYmVyLCBNYXA8bnVtYmVyLCBudW1iZXJbXT4+IH1cblxuLyoqIFJlYWQgcHVibGljL2RhdGEvcG9sYXIvdC9pbmRleC5qc29uICh3cml0dGVuIGJ5IGRhdGEtcHJlcC9wb2xhcl90aWxlcy5weSkuIE51bGwgaWYgaXQgZG9lcyBub3QgZGVzY3JpYmUgdGhpcyBweXJhbWlkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUHlyYW1pZEluZGV4KGpzb246IHVua25vd24pOiBQeXJhbWlkSW5kZXggfCBudWxsIHtcbiAgY29uc3QgaiA9IGpzb24gYXMgeyBsYXllcnM/OiB1bmtub3duOyBoYWxmTT86IHVua25vd247IHRpbGVQeD86IHVua25vd247IGxldmVscz86IFJlY29yZDxzdHJpbmcsIHsgcnVucz86IHVua25vd24gfT4gfSB8IG51bGw7XG4gIGlmICghaiB8fCB0eXBlb2Ygai5sYXllcnMgIT09ICdzdHJpbmcnIHx8IGouaGFsZk0gIT09IFBZUkFNSURfSEFMRl9NIHx8IGoudGlsZVB4ICE9PSBQWVJBTUlEX1BYIHx8ICFqLmxldmVscyB8fCB0eXBlb2Ygai5sZXZlbHMgIT09ICdvYmplY3QnKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgcm93cyA9IG5ldyBNYXA8bnVtYmVyLCBNYXA8bnVtYmVyLCBudW1iZXJbXT4+KCk7XG4gIGxldCBjb3VudCA9IDA7XG4gIGZvciAoY29uc3QgW25hbWUsIGx2XSBvZiBPYmplY3QuZW50cmllcyhqLmxldmVscykpIHtcbiAgICBjb25zdCBrID0gTnVtYmVyKG5hbWUpO1xuICAgIGlmICghTnVtYmVyLmlzSW50ZWdlcihrKSB8fCBrIDwgMCB8fCBrID4gUFlSQU1JRF9NQVhfSyB8fCAhQXJyYXkuaXNBcnJheShsdj8ucnVucykpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGJ5Um93ID0gbmV3IE1hcDxudW1iZXIsIG51bWJlcltdPigpO1xuICAgIGZvciAoY29uc3QgcnVuIG9mIGx2LnJ1bnMgYXMgdW5rbm93bltdKSB7XG4gICAgICBpZiAoIUFycmF5LmlzQXJyYXkocnVuKSB8fCBydW4ubGVuZ3RoICE9PSAzIHx8ICFydW4uZXZlcnkoTnVtYmVyLmlzSW50ZWdlcikpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgW3JvdywgZmlyc3QsIGxhc3RdID0gcnVuIGFzIG51bWJlcltdO1xuICAgICAgaWYgKHJvdyA8IDAgfHwgZmlyc3QgPCAwIHx8IGxhc3QgPCBmaXJzdCB8fCBsYXN0ID49IDIgKiogayB8fCByb3cgPj0gMiAqKiBrKSBjb250aW51ZTtcbiAgICAgIGxldCBsaXN0ID0gYnlSb3cuZ2V0KHJvdyk7XG4gICAgICBpZiAoIWxpc3QpIGJ5Um93LnNldChyb3csIChsaXN0ID0gW10pKTtcbiAgICAgIGxpc3QucHVzaChmaXJzdCwgbGFzdCk7XG4gICAgICBjb3VudCArPSBsYXN0IC0gZmlyc3QgKyAxO1xuICAgIH1cbiAgICByb3dzLnNldChrLCBieVJvdyk7XG4gIH1cbiAgcmV0dXJuIHsgbGF5ZXJzOiBqLmxheWVycywgY291bnQsIHJvd3MgfTtcbn1cblxuLyoqIElzIHB5cmFtaWQgc3F1YXJlIChjb2x1bW4gaSwgcm93IGopIG9mIGxldmVsIGsgc3RvcmVkIHdpdGggdGhlIGFwcD8gKi9cbmV4cG9ydCBmdW5jdGlvbiBweXJhbWlkSGFzTG9jYWwoaXg6IFB5cmFtaWRJbmRleCB8IG51bGwsIGs6IG51bWJlciwgaTogbnVtYmVyLCBqOiBudW1iZXIpOiBib29sZWFuIHtcbiAgY29uc3QgcnVucyA9IGl4Py5yb3dzLmdldChrKT8uZ2V0KGopO1xuICBpZiAoIXJ1bnMpIHJldHVybiBmYWxzZTtcbiAgZm9yIChsZXQgcSA9IDA7IHEgPCBydW5zLmxlbmd0aDsgcSArPSAyKSBpZiAoaSA+PSBydW5zW3FdICYmIGkgPD0gcnVuc1txICsgMV0pIHJldHVybiB0cnVlO1xuICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKiBXaGVyZSBhIHN0b3JlZCBweXJhbWlkIHNxdWFyZSBsaXZlcyAoYGJhc2VgID0gdGhlIGZvbGRlciBvZiBpbmRleC5qc29uLCBlbmRpbmcgaW4gXCIvXCIpLiAqL1xuZXhwb3J0IGNvbnN0IHB5cmFtaWRMb2NhbFVybCA9IChiYXNlOiBzdHJpbmcsIGs6IG51bWJlciwgaTogbnVtYmVyLCBqOiBudW1iZXIpID0+IGAke2Jhc2V9JHtrfS8ke2l9XyR7an0uanBnYDtcblxuLyoqXG4gKiBRdWljayB0ZXN0IG9uIHRoZSBtYWluIHRocmVhZDogY2FuIGEgZGlzcGxheSB0aWxlIHN1cmVseSBiZSBkcmF3biBmcm9tIHN0b3JlZCBzcXVhcmVzIGFsb25lP1xuICogKEl0cyBvdXRsaW5lIGlzIG1hcHBlZCBvbnRvIHRoZSBwb2xhciBncmlkIGFuZCBldmVyeSBzcXVhcmUgdW5kZXIgdGhhdCBib3ggbXVzdCBiZSBzdG9yZWQuKVxuICogU3VjaCB0aWxlcyBuZXZlciB3YWl0IGZvciB0aGUgbmV0d29yaywgc28gdGhleSBhcmUgbm90IGhlbGQgYmFjayBiZWhpbmQgc2xvdyBkb3dubG9hZHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBweXJhbWlkU3VyZWx5TG9jYWwoaXg6IFB5cmFtaWRJbmRleCB8IG51bGwsIHI6IFJlY3QsIGRpc3BsYXlMZXZlbDogbnVtYmVyKTogYm9vbGVhbiB7XG4gIGlmICghaXgpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgayA9IE1hdGgubWluKHB5cmFtaWRMZXZlbEZvcihkaXNwbGF5TGV2ZWwpLCBweXJhbWlkTWF4S0ZvcihyKSksIG4gPSAyICoqIGssIFMgPSBQWVJBTUlEX1NQQU5fTSAvIG47XG4gIGxldCB4MCA9IEluZmluaXR5LCB4MSA9IC1JbmZpbml0eSwgeTAgPSBJbmZpbml0eSwgeTEgPSAtSW5maW5pdHk7XG4gIGZvciAobGV0IGEgPSAwOyBhIDw9IDI7IGErKykge1xuICAgIGZvciAobGV0IGIgPSAwOyBiIDw9IDI7IGIrKykge1xuICAgICAgY29uc3QgbG9uID0gci53ZXN0ICsgKGEgLyAyKSAqIChyLmVhc3QgLSByLndlc3QpLCBsYXQgPSByLnNvdXRoICsgKGIgLyAyKSAqIChyLm5vcnRoIC0gci5zb3V0aCksIGNsID0gTWF0aC5jb3MobGF0KTtcbiAgICAgIGNvbnN0IGRlbiA9IDEgKyBjbCAqIE1hdGguc2luKGxvbik7XG4gICAgICBpZiAoZGVuIDwgMWUtNikgcmV0dXJuIGZhbHNlO1xuICAgICAgY29uc3QgZiA9ICgyICogTU9PTl9SKSAvIGRlbiwgbXggPSBmICogTWF0aC5zaW4obGF0KSwgbXkgPSBmICogY2wgKiBNYXRoLmNvcyhsb24pOyAvLyBhcyBpbiBwb2xhckdlb21ldHJ5XG4gICAgICB4MCA9IE1hdGgubWluKHgwLCBteCk7IHgxID0gTWF0aC5tYXgoeDEsIG14KTsgeTAgPSBNYXRoLm1pbih5MCwgbXkpOyB5MSA9IE1hdGgubWF4KHkxLCBteSk7XG4gICAgfVxuICB9XG4gIGNvbnN0IHBhZCA9IFMgLyBQWVJBTUlEX1BYICsgMC4wMiAqICh4MSAtIHgwICsgeTEgLSB5MCk7IC8vIGJpbGluZWFyIG5laWdoYm91cnMsIGFuZCB0aWxlIGVkZ2VzIGFyZSBzbGlnaHRseSBjdXJ2ZWQgb24gdGhlIHBvbGFyIG1hcFxuICBjb25zdCBpMCA9IE1hdGgubWF4KDAsIE1hdGguZmxvb3IoKHgwIC0gcGFkICsgUFlSQU1JRF9IQUxGX00pIC8gUykpLCBpMSA9IE1hdGgubWluKG4gLSAxLCBNYXRoLmZsb29yKCh4MSArIHBhZCArIFBZUkFNSURfSEFMRl9NKSAvIFMpKTtcbiAgY29uc3QgajAgPSBNYXRoLm1heCgwLCBNYXRoLmZsb29yKChQWVJBTUlEX0hBTEZfTSAtIHkxIC0gcGFkKSAvIFMpKSwgajEgPSBNYXRoLm1pbihuIC0gMSwgTWF0aC5mbG9vcigoUFlSQU1JRF9IQUxGX00gLSB5MCArIHBhZCkgLyBTKSk7XG4gIGlmICgoaTEgLSBpMCArIDEpICogKGoxIC0gajAgKyAxKSA+IDY0KSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHJob0NsaXAgPSBwb2xhclJobyhQT0xBUl9MSU1JVF9ERUcpO1xuICBmb3IgKGxldCBqID0gajA7IGogPD0gajE7IGorKykge1xuICAgIGZvciAobGV0IGkgPSBpMDsgaSA8PSBpMTsgaSsrKSB7XG4gICAgICBpZiAocHlyYW1pZEhhc0xvY2FsKGl4LCBrLCBpLCBqKSkgY29udGludWU7XG4gICAgICAvLyBhIHNxdWFyZSB3aG9sbHkgb3V0c2lkZSB0aGUgY2lyY2xlIHRoZSBsYXllciBkcmF3cyBpcyBuZXZlciByZWFkXG4gICAgICBjb25zdCBzeDAgPSAtUFlSQU1JRF9IQUxGX00gKyBpICogUywgc3kxID0gUFlSQU1JRF9IQUxGX00gLSBqICogUztcbiAgICAgIGNvbnN0IG54ID0gc3gwIDw9IDAgJiYgc3gwICsgUyA+PSAwID8gMCA6IE1hdGgubWluKE1hdGguYWJzKHN4MCksIE1hdGguYWJzKHN4MCArIFMpKSwgbnkgPSBzeTEgPj0gMCAmJiBzeTEgLSBTIDw9IDAgPyAwIDogTWF0aC5taW4oTWF0aC5hYnMoc3kxKSwgTWF0aC5hYnMoc3kxIC0gUykpO1xuICAgICAgaWYgKE1hdGguaHlwb3QobngsIG55KSA8IHJob0NsaXApIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIFNoYXJwZXIgcGhvdG9zIHNoYXJlIHRoZSBleGlzdGluZyBwaG90byBsYXllcjogbm8gZXh0cmEgZ2xvYmUgdGV4dHVyZSBpcyBuZWVkZWQuXG5leHBvcnQgY29uc3QgUEhPVE9fVEMgPSAnS2FndXlhX1RDb3J0aG9fTW9zYWljX0dsb2JhbF80MDk2cHBkJztcbi8vIFRoZSBjYXRhbG9ndWUgc2F5cyA3LjQgbTsgdGhlIExJVkUgV01UUyBzdG9wcyBhdCB6MTAgKDIwLjggbSkuIHoxMS8xMiByZXR1cm4gNDA0LlxuZXhwb3J0IGNvbnN0IFBIT1RPX1RDX01BWF9aID0gMTA7XG5leHBvcnQgY29uc3QgUEhPVE9fRklORV9UQ19NQVhfWiA9IDEyOyAvLyA1LjIgbSBkZWxpdmVyeSBncmlkLCBuYXRpdmUgZXZlbmluZyBUQyBvYnNlcnZhdGlvbnMgYXJlIDcuNCBtXG5leHBvcnQgY29uc3QgTk9SVEhfUEhPVE9fTEFUID0gODQ7XG5leHBvcnQgY29uc3QgTk9SVEhfUEhPVE9fSEFMRl9NID0gOTMxMDcwOyAvLyBRdWlja01hcCBsdW5hci1zdGVyZW5wIGdyaWQsIGZyb20gaXRzIGxpdmUgY2F0YWxvZ3VlXG5leHBvcnQgY29uc3QgTk9SVEhfUEhPVE9fTUFYX1ogPSAxMjsgLy8gMC44ODggbSBncmlkOyB0aGUgY29udHJvbGxlZCBOQUMgbW9zYWljIGl0c2VsZiBpcyAxIG1cbmV4cG9ydCBpbnRlcmZhY2UgUGhvdG9SZWdpb24geyBsYXllcjogc3RyaW5nOyBtYXhaOiBudW1iZXI7IHdlc3Q6IG51bWJlcjsgc291dGg6IG51bWJlcjsgZWFzdDogbnVtYmVyOyBub3J0aDogbnVtYmVyOyBxdWlja21hcD86IGJvb2xlYW47IGdsb2JhbD86IGJvb2xlYW4gfVxuZXhwb3J0IGNvbnN0IFBIT1RPX0ZJTkVfVEM6IFBob3RvUmVnaW9uID0geyBsYXllcjogJ2thZ190Y19lXzdtJywgbWF4WjogUEhPVE9fRklORV9UQ19NQVhfWiwgd2VzdDogLTE4MCwgc291dGg6IC05MCwgZWFzdDogMTgwLCBub3J0aDogOTAsIHF1aWNrbWFwOiB0cnVlLCBnbG9iYWw6IHRydWUgfTtcbmNvbnN0IFBIT1RPX01PUk5JTkdfVEM6IFBob3RvUmVnaW9uID0geyAuLi5QSE9UT19GSU5FX1RDLCBsYXllcjogJ2thZ190Y19tXzdtJyB9O1xuLy8gQm91bmRzIGZyb20gTW9vbiBUcmVrJ3MgbGl2ZSBjYXRhbG9ndWUsIGNoZWNrZWQgMTQgTm92IDIwMjYuIE5ldmVyIGZldGNoIGEgd2hvbGUgZ2xvYmUgb2YgTkFDIHRpbGVzLlxuZXhwb3J0IGNvbnN0IFBIT1RPX1JFR0lPTlM6IHJlYWRvbmx5IFBob3RvUmVnaW9uW10gPSBbXG4gIHsgbGF5ZXI6ICdMUk9fTkFDX0Fwb2xsbzExX01vc2FpY19wJywgbWF4WjogMTUsIHdlc3Q6IDIzLjQ0ODQ5NzcsIHNvdXRoOiAwLjE0NjQ0ODQsIGVhc3Q6IDIzLjUzOTY4MzksIG5vcnRoOiAxLjExNDkwNTEgfSxcbiAgeyBsYXllcjogJ0xST19OQUNfQXBvbGxvMTJfTW9zYWljX3AnLCBtYXhaOiAxNiwgd2VzdDogLTIzLjQ0NDUxNiwgc291dGg6IC0zLjQ3MTYwNzUsIGVhc3Q6IC0yMy4zNTc0NzM2LCBub3J0aDogLTIuNTAyMTY5MyB9LFxuICB7IGxheWVyOiAnTFJPX05BQ19BcG9sbG8xNF9Nb3NhaWNfcCcsIG1heFo6IDE1LCB3ZXN0OiAtMTcuNDkwMDc1Miwgc291dGg6IC00LjE5MjA4NzYsIGVhc3Q6IC0xNy4zOTA3NjIyLCBub3J0aDogLTMuMjI1MzYwMSB9LFxuICB7IGxheWVyOiAnTFJPX05BQ19BcG9sbG8xNV9Nb3NhaWNfcCcsIG1heFo6IDE2LCB3ZXN0OiAzLjU4MDU0NjIsIHNvdXRoOiAyNS43OTY0MzM0LCBlYXN0OiAzLjY4OTM4NTIsIG5vcnRoOiAyNi43NjM0OTA0IH0sXG4gIHsgbGF5ZXI6ICdMUk9fTkFDX0Fwb2xsbzE2X01vc2FpY19wJywgbWF4WjogMTQsIHdlc3Q6IDE1LjM3ODgzMjcsIHNvdXRoOiAtOS42MDYwOTczLCBlYXN0OiAxNS41NTQ1MzQ2LCBub3J0aDogLTguNjYxNjc4MyB9LFxuICB7IGxheWVyOiAnTkFDX0RUTV9BUE9MTE8xN19NT1NBSUNfMTIwQ00nLCBtYXhaOiAxNCwgd2VzdDogMjkuOTA1OTAxNCwgc291dGg6IDE5LjM5MDU0MzksIGVhc3Q6IDMxLjY1Nzk1NjIsIG5vcnRoOiAyMS4zMDM1MDM0IH0sXG4gIHsgbGF5ZXI6ICdMUk9fTkFDX01vc2FpY180M1MzNDlFXzUwY21wJywgbWF4WjogMTQsIHdlc3Q6IC0xMi4xMDUxNywgc291dGg6IC00My42NDMxNzI2LCBlYXN0OiAtMTAuMzAwNzAyOCwgbm9ydGg6IC00Mi4zMjM0NzI5IH0sXG4gIHsgbGF5ZXI6ICdMUk9fTkFDX1Bvc3RfTGFuZGluZ19PcnRob01vc2FpY18xbXBwX0lNXzFfTGFuZGluZ1NpdGUnLCBtYXhaOiAxMywgd2VzdDogMC45Mzg2ODAxLCBzb3V0aDogLTgwLjIxNjM1MzIsIGVhc3Q6IDEuOTM5MTc0Miwgbm9ydGg6IC04MC4wNDI4MTIxIH0sXG4gIHsgbGF5ZXI6ICdMUk9fTkFDX01vc2FpY181MGNtcHBfVm9uS2FybWFuX3YyJywgbWF4WjogMTUsIHdlc3Q6IDE3MS40NDkzMTYyLCBzb3V0aDogLTQ4LjkyOTM5OTQsIGVhc3Q6IDE3OS45MjQyODY3LCBub3J0aDogLTQyLjAxODgxNzQgfSxcbiAgeyBsYXllcjogJ0xST19OQUNfTW9zYWljXzBfODJtcHBfU2hpb2xpJywgbWF4WjogMTUsIHdlc3Q6IDI1LjA2MDA5NTgsIHNvdXRoOiAtMTQuMTczMjMxOSwgZWFzdDogMjUuODQzNjYxNCwgbm9ydGg6IC0xMi41ODczNDUgfSxcbiAgeyBsYXllcjogJ0xST19OQUNfb3J0aG9faG9yc2VzaG9lVjInLCBtYXhaOiAxNSwgd2VzdDogNjEuMzkyMDIwMywgc291dGg6IDE2LjYwNzgyODYsIGVhc3Q6IDYyLjIyNzQ3MTcsIG5vcnRoOiAyMC4wOTEyNzM3IH0sXG4gIHsgbGF5ZXI6ICd3YWNfbmFjX25hY3JvaScsIHF1aWNrbWFwOiB0cnVlLCBtYXhaOiAxNSwgd2VzdDogLTE5LjU1MTYwMDAsIHNvdXRoOiA0NC4wODE0MDAwLCBlYXN0OiAtMTkuNDcxNjAwMCwgbm9ydGg6IDQ0LjE2MTQwMDAgfSxcbiAgeyBsYXllcjogJ3dhY19uYWNfbmFjcm9pJywgcXVpY2ttYXA6IHRydWUsIG1heFo6IDE1LCB3ZXN0OiAtNTEuOTU2OTAwMCwgc291dGg6IDQzLjAxODAwMDAsIGVhc3Q6IC01MS44NzY5MDAwLCBub3J0aDogNDMuMDk4MDAwMCB9LFxuICB7IGxheWVyOiAnd2FjX25hY19uYWNyb2knLCBxdWlja21hcDogdHJ1ZSwgbWF4WjogMTUsIHdlc3Q6IC0xNTQuMDI1MDAwMCwgc291dGg6IC00MS42Nzg1MDAwLCBlYXN0OiAtMTUzLjk0NTAwMDAsIG5vcnRoOiAtNDEuNTk4NTAwMCB9LFxuICB7IGxheWVyOiAnd2FjX25hY19uYWNyb2knLCBxdWlja21hcDogdHJ1ZSwgbWF4WjogMTUsIHdlc3Q6IDMyLjI3OTAwMDAsIHNvdXRoOiAtNjkuNDEzMDAwMCwgZWFzdDogMzIuMzU5MDAwMCwgbm9ydGg6IC02OS4zMzMwMDAwIH0sXG4gIHsgbGF5ZXI6ICd3YWNfbmFjX25hY3JvaScsIHF1aWNrbWFwOiB0cnVlLCBtYXhaOiAxNSwgd2VzdDogMjIuNzQ0MDAwMCwgc291dGg6IC03MC45MjEwMDAwLCBlYXN0OiAyMi44MjQwMDAwLCBub3J0aDogLTcwLjg0MTAwMDAgfSxcbiAgeyBsYXllcjogJ3dhY19uYWNfbmFjcm9pJywgcXVpY2ttYXA6IHRydWUsIG1heFo6IDE1LCB3ZXN0OiAxOS4zMDk2MDAwLCBzb3V0aDogMzIuNTU1NjAwMCwgZWFzdDogMTkuMzg5NjAwMCwgbm9ydGg6IDMyLjYzNTYwMDAgfSxcbiAgeyBsYXllcjogJ3dhY19uYWNfbmFjcm9pJywgcXVpY2ttYXA6IHRydWUsIG1heFo6IDE1LCB3ZXN0OiA0NC4wNTUwMDAwLCBzb3V0aDogNDcuNTQxMDAwMCwgZWFzdDogNDQuMTM1MDAwMCwgbm9ydGg6IDQ3LjYyMTAwMDAgfSxcbiAgeyBsYXllcjogJ3dhY19uYWNfbmFjcm9pJywgcXVpY2ttYXA6IHRydWUsIG1heFo6IDE1LCB3ZXN0OiAtNC42NDAwMDAwLCBzb3V0aDogNjAuNzY5MDAwMCwgZWFzdDogLTQuNTYwMDAwMCwgbm9ydGg6IDYwLjg0OTAwMDAgfSxcbl07XG5cbi8qKiBDb25zZXJ2YXRpdmUgdHJ1ZS1mcmFtZSBib3g7IHNtYWxsIGRpc3BsYXkgdGlsZXMgb25seSwgd2l0aCBhIG1hcmdpbiBmb3IgY3VydmVkIGVkZ2VzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBob3RvUmVnaW9uc0ZvcihyOiBSZWN0KTogUGhvdG9SZWdpb25bXSB7XG4gIGNvbnN0IGxhdCA9IHRpbGVUcnVlTGF0UmFuZ2Uocik7XG4gIGlmIChsYXQubWF4RGVnID4gODMgfHwgbGF0Lm1pbkRlZyA8IC04MykgcmV0dXJuIFtdO1xuICBsZXQgd2VzdCA9IEluZmluaXR5LCBlYXN0ID0gLUluZmluaXR5O1xuICBmb3IgKGNvbnN0IGEgb2YgW3Iuc291dGgsIChyLnNvdXRoICsgci5ub3J0aCkgLyAyLCByLm5vcnRoXSkge1xuICAgIGZvciAoY29uc3QgYiBvZiBbci53ZXN0LCAoci53ZXN0ICsgci5lYXN0KSAvIDIsIHIuZWFzdF0pIHtcbiAgICAgIGNvbnN0IGxvbiA9IE1hdGguYXRhbjIoTWF0aC5zaW4oYSksIE1hdGguY29zKGEpICogTWF0aC5jb3MoYikpIC8gREVHO1xuICAgICAgd2VzdCA9IE1hdGgubWluKHdlc3QsIGxvbik7IGVhc3QgPSBNYXRoLm1heChlYXN0LCBsb24pO1xuICAgIH1cbiAgfVxuICBjb25zdCBwYWQgPSAyICogKHIuZWFzdCAtIHIud2VzdCkgLyBERUc7XG4gIHJldHVybiBQSE9UT19SRUdJT05TLmZpbHRlcihwID0+IGxhdC5taW5EZWcgPD0gcC5ub3J0aCArIHBhZCAmJiBsYXQubWF4RGVnID49IHAuc291dGggLSBwYWQgJiYgd2VzdCA8PSBwLmVhc3QgKyBwYWQgJiYgZWFzdCA+PSBwLndlc3QgLSBwYWQpO1xufVxuXG4vKiogQSB3aG9sZSBkaXNwbGF5IHRpbGUgbGllcyBzYWZlbHkgaW5zaWRlIHRoZSBOQUMgZmVhdGhlcjogVEMgdW5kZXJuZWF0aCB3b3VsZCBiZSB3YXN0ZWQuICovXG5leHBvcnQgZnVuY3Rpb24gcGhvdG9SZWdpb25Db3ZlcnMocjogUmVjdCwgcmVnaW9uOiBQaG90b1JlZ2lvbik6IGJvb2xlYW4ge1xuICBmb3IgKGNvbnN0IGEgb2YgW3Iuc291dGgsIChyLnNvdXRoICsgci5ub3J0aCkgLyAyLCByLm5vcnRoXSkgZm9yIChjb25zdCBiIG9mIFtyLndlc3QsIChyLndlc3QgKyByLmVhc3QpIC8gMiwgci5lYXN0XSkge1xuICAgIGNvbnN0IGxhID0gTWF0aC5hc2luKC1NYXRoLmNvcyhhKSAqIE1hdGguc2luKGIpKSwgbG8gPSBNYXRoLmF0YW4yKE1hdGguc2luKGEpLCBNYXRoLmNvcyhhKSAqIE1hdGguY29zKGIpKTtcbiAgICBjb25zdCBlZGdlID0gTWF0aC5taW4oKGxvIC8gREVHIC0gcmVnaW9uLndlc3QpICogTWF0aC5jb3MobGEpLCAocmVnaW9uLmVhc3QgLSBsbyAvIERFRykgKiBNYXRoLmNvcyhsYSksIGxhIC8gREVHIC0gcmVnaW9uLnNvdXRoLCByZWdpb24ubm9ydGggLSBsYSAvIERFRyk7XG4gICAgaWYgKGVkZ2UgKiBERUcgKiBNT09OX1IgPCAzMjEpIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqIERlZXBlc3QgbGV2ZWwgd2l0aCByZWFsIG5ldyBpbmZvcm1hdGlvbjsgbm9ydGggcG9sYXIgdGlsZXMgdXNlIGEgc3F1YXJlIHBvbGFyIGdyaWQuICovXG5leHBvcnQgZnVuY3Rpb24gcGhvdG9NYXhMZXZlbChyOiBSZWN0KTogbnVtYmVyIHtcbiAgY29uc3QgbGF0ID0gdGlsZVRydWVMYXRSYW5nZShyKTtcbiAgaWYgKGxhdC5tYXhEZWcgPiBOT1JUSF9QSE9UT19MQVQpIHJldHVybiAxNTtcbiAgcmV0dXJuIE1hdGgubWF4KFBIT1RPX0ZJTkVfVENfTUFYX1ogKyAxLCAuLi5waG90b1JlZ2lvbnNGb3IocikubWFwKHAgPT4gcC5tYXhaICsgMSkpO1xufVxuXG4vKiogQWRkIG9ubHkgdGhlIGRldGFpbCBtaXNzaW5nIGZyb20gYSBjb2Fyc2VyIHBob3RvLiBUaGUgbG93IGZyZXF1ZW5jaWVzIGFuZCBicmlnaHRuZXNzIHN0YXlcbiAqIGFuY2hvcmVkIHRvIFdBQywgYXQgdGhlIHNhbWUgdHJ1ZS1mcmFtZSBwaXhlbHMgYWNyb3NzIEFMTCB0aWxlcyBhbmQgem9vbXMuIFBlci1vdXRwdXQtdGlsZVxuICogbWVhbiBtYXRjaGluZyB3b3VsZCBjcmVhdGUgYSBjaGVja2VyYm9hcmQsIGFuZCBjaGFuZ2UgYnJpZ2h0bmVzcyB3aGVuIHRoZSBjYW1lcmEgbW92ZXMuICovXG5leHBvcnQgZnVuY3Rpb24gYWRkUGhvdG9EZXRhaWwoYmFzZTogVWludDhDbGFtcGVkQXJyYXksIHNoYXJwOiBVaW50OENsYW1wZWRBcnJheSB8IG51bGwsIGxvdzogVWludDhDbGFtcGVkQXJyYXkgfCBudWxsLCBnYWluID0gMC44NSk6IHZvaWQge1xuICBpZiAoIXNoYXJwIHx8ICFsb3cpIHJldHVybjtcbiAgZm9yIChsZXQgbyA9IDA7IG8gPCBiYXNlLmxlbmd0aDsgbyArPSA0KSB7XG4gICAgY29uc3QgdyA9IE1hdGgubWluKHNoYXJwW28gKyAzXSwgbG93W28gKyAzXSkgLyAyNTU7XG4gICAgaWYgKHcgPD0gMCB8fCAhYmFzZVtvICsgM10pIGNvbnRpbnVlO1xuICAgIGNvbnN0IGQgPSBnYWluICogdyAqIChzaGFycFtvXSAtIGxvd1tvXSk7XG4gICAgYmFzZVtvXSArPSBkOyBiYXNlW28gKyAxXSArPSBkOyBiYXNlW28gKyAyXSArPSBkO1xuICB9XG59XG5cbi8qKiBBIGNvbnRpbnVvdXMgZXhwb3N1cmUgbWF0Y2ggdG8gdGhlIGZpeGVkIFdBQyByZWZlcmVuY2UuIFNvdXJjZSBhbHBoYSByZW1vdmVzIG9ubHkgdGhlXG4gKiBkZXRhaWwtZnJlZSBibGFjazsgdGV4dHVyZWQgc2hhZG93cyByZW1haW4uIFRoZSByZWZlcmVuY2UgaXMgaWRlbnRpY2FsIGFjcm9zcyB0aWxlcy96b29tcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYXRjaFBob3RvVG9uZShiYXNlOiBVaW50OENsYW1wZWRBcnJheSwgc2hhcnA6IFVpbnQ4Q2xhbXBlZEFycmF5IHwgbnVsbCwgbG93OiBVaW50OENsYW1wZWRBcnJheSB8IG51bGwsIHJlZmVyZW5jZTogVWludDhDbGFtcGVkQXJyYXkpOiB2b2lkIHtcbiAgaWYgKCFzaGFycCB8fCAhbG93KSByZXR1cm47XG4gIGZvciAobGV0IG8gPSAwOyBvIDwgYmFzZS5sZW5ndGg7IG8gKz0gNCkge1xuICAgIGNvbnN0IHcgPSBNYXRoLm1pbihzaGFycFtvICsgM10sIGxvd1tvICsgM10pIC8gMjU1O1xuICAgIGlmICghdyB8fCAhYmFzZVtvICsgM10pIGNvbnRpbnVlO1xuICAgIGNvbnN0IGdhaW4gPSBjbGFtcChyZWZlcmVuY2Vbb10gLyBNYXRoLm1heCg4LCBsb3dbb10pLCAwLjI1LCA0KTtcbiAgICBjb25zdCB2YWx1ZSA9IHNoYXJwW29dICogZ2FpbjtcbiAgICBiYXNlW29dID0gYmFzZVtvICsgMV0gPSBiYXNlW28gKyAyXSA9IGJhc2Vbb10gKiAoMSAtIHcpICsgdmFsdWUgKiB3O1xuICB9XG59XG5cbi8qKiBHZW9ncmFwaGljIHNvdXJjZSBmb290cHJpbnQgY2xpcHBlZCB0byBhIHJlYWwgbW9zYWljLiBLZWVwIGl0cyBvdXRlciA4MCBtIG91dCBvZiB0aGVcbiAqIGJsZW5kIChzb3VyY2UgcmVzYW1wbGluZyBjYW4gbGVhdmUgYSBicmlnaHQgYm9yZGVyKSwgdGhlbiBmZWF0aGVyIG92ZXIgMjQwIG1ldHJlcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWdpb25Gb290cHJpbnQoZnA6IEZvb3RwcmludCwgcjogUmVjdCwgZGlzcGxheUxldmVsOiBudW1iZXIsIG1heFo6IG51bWJlciwgcmVnaW9uPzogUGhvdG9SZWdpb24pOiBib29sZWFuIHtcbiAgaWYgKCF0cmVrR2VvbWV0cnkoZnAsIHIsIEZJWF9NSU5fVFJVRV9MQVQpKSByZXR1cm4gZmFsc2U7XG4gIGxldCBhbnkgPSBmYWxzZTtcbiAgaWYgKHJlZ2lvbiAmJiAhcmVnaW9uLmdsb2JhbCkgZm9yIChsZXQgcCA9IDA7IHAgPCBOMjsgcCsrKSB7XG4gICAgaWYgKCFmcC5jb3ZbcF0pIGNvbnRpbnVlO1xuICAgIGNvbnN0IGxhID0gZnAuYVtwXSAvIERFRywgbG8gPSBmcC5iW3BdIC8gREVHO1xuICAgIGNvbnN0IGVkZ2UgPSBNYXRoLm1pbigobG8gLSByZWdpb24ud2VzdCkgKiBNYXRoLmNvcyhmcC5hW3BdKSwgKHJlZ2lvbi5lYXN0IC0gbG8pICogTWF0aC5jb3MoZnAuYVtwXSksIGxhIC0gcmVnaW9uLnNvdXRoLCByZWdpb24ubm9ydGggLSBsYSk7XG4gICAgZnAuY292W3BdICo9IHNtb290aCgoZWRnZSAqIERFRyAqIE1PT05fUiAtIDgwKSAvIDI0MCk7XG4gICAgYW55IHx8PSBmcC5jb3ZbcF0gPiAwO1xuICB9XG4gIGVsc2UgYW55ID0gdHJ1ZTtcbiAgaWYgKGFueSkgdHJla0Nvb3JkcyhmcCwgZGlzcGxheUxldmVsLCB0cmVrVG9wKGRpc3BsYXlMZXZlbCwgbWF4WikpO1xuICByZXR1cm4gYW55O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcGxhblBob3RvUmVnaW9uKGZwOiBGb290cHJpbnQsIHI6IFJlY3QsIGRpc3BsYXlMZXZlbDogbnVtYmVyLCBtYXhaOiBudW1iZXIsIHJlZ2lvbj86IFBob3RvUmVnaW9uKTogUGxhbiB8IG51bGwge1xuICBpZiAoIXJlZ2lvbkZvb3RwcmludChmcCwgciwgZGlzcGxheUxldmVsLCBtYXhaLCByZWdpb24pKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZ3JpZHMgPSBBcnJheS5mcm9tKHsgbGVuZ3RoOiB0cmVrVG9wKGRpc3BsYXlMZXZlbCwgbWF4WikgKyAxIH0sIChfLCB6KSA9PiByZWdpb24/LnF1aWNrbWFwID8geyB0aWxlVzogNTEyLCB0aWxlSDogNTEyLCB0aWxlc1g6IDIgKiogeiwgd2lkdGg6IDUxMiAqIDIgKiogeiwgaGVpZ2h0OiAyNTYgKiAyICoqIHosIGdsb2JhbDogdHJ1ZSB9IDogdHJla0dyaWQoeikpO1xuICByZXR1cm4geyBsZXZlbDogTWF0aC5taW4oZGlzcGxheUxldmVsLCBtYXhaKSwgZ3JpZHMsIGtleXM6IGNvbGxlY3RUaWxlcyhmcCwgZ3JpZHMsIEluZmluaXR5KSA/PyBbXSB9O1xufVxuXG4vKiogQ29udHJvbGxlZCBub3J0aC1wb2xlIE5BQywgdXNpbmcgUXVpY2tNYXAncyBjYWNoZWQgcG9sYXIgdGlsZXMgcmF0aGVyIHRoYW4gc2xvdyBXTVMgcmVuZGVycy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub3J0aEZvb3RwcmludChmcDogRm9vdHByaW50LCByOiBSZWN0LCBrOiBudW1iZXIpOiBib29sZWFuIHtcbiAgaWYgKCFwb2xhckdlb21ldHJ5KGZwLCByLCBwb2xhclJobygtTk9SVEhfUEhPVE9fTEFUKSwgNTAwMCwgTk9SVEhfUEhPVE9fSEFMRl9NLCB0cnVlKSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBzID0gUFlSQU1JRF9QWCAqIDIgKiogayAvICgyICogTk9SVEhfUEhPVE9fSEFMRl9NKTtcbiAgcG9sYXJDb29yZHMoZnAsIE5PUlRIX1BIT1RPX0hBTEZfTSwgcywgcyk7XG4gIHJldHVybiB0cnVlO1xufVxuZXhwb3J0IGZ1bmN0aW9uIHBsYW5Ob3J0aFBob3RvKGZwOiBGb290cHJpbnQsIHI6IFJlY3QsIGRpc3BsYXlMZXZlbDogbnVtYmVyKTogUGxhbiB8IG51bGwge1xuICBjb25zdCBrID0gY2xhbXAoTWF0aC5jZWlsKE1hdGgubG9nMigyICogTk9SVEhfUEhPVE9fSEFMRl9NIC8gKFBZUkFNSURfUFggKiBwaXhlbE1ldHJlcyhkaXNwbGF5TGV2ZWwpKSkpLCAwLCBOT1JUSF9QSE9UT19NQVhfWik7XG4gIGlmICghbm9ydGhGb290cHJpbnQoZnAsIHIsIGspKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZ3JpZHMgPSBbcHlyYW1pZEdyaWQoayldO1xuICByZXR1cm4geyBsZXZlbDogaywgZ3JpZHMsIGtleXM6IGNvbGxlY3RUaWxlcyhmcCwgZ3JpZHMsIE1BWF9QWVJBTUlEX1RJTEVTKSA/PyBbXSB9O1xufVxuZXhwb3J0IGZ1bmN0aW9uIG5vcnRoUGhvdG9VcmwoazogbnVtYmVyLCBpOiBudW1iZXIsIGo6IG51bWJlcik6IHN0cmluZyB7XG4gIHJldHVybiBgaHR0cHM6Ly9scm9jLXRpbGVzLnF1aWNrbWFwLmlvL3RpbGVzL2xucG9sZV9hdmcvbHVuYXItc3RlcmVucC8ke2t9LyR7aX0vJHtqfS5wbmc/ZF92YWw9MCwwLjUmZF9vcHQ9d2NvbHV0MGA7XG59XG5cbmZ1bmN0aW9uIG5vcnRoRmFsbGJhY2tVcmwoazogbnVtYmVyLCBpOiBudW1iZXIsIGo6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IHNwYW4gPSAyICogTk9SVEhfUEhPVE9fSEFMRl9NIC8gMiAqKiBrLCB4ID0gLU5PUlRIX1BIT1RPX0hBTEZfTSArIGkgKiBzcGFuLCB5ID0gTk9SVEhfUEhPVE9fSEFMRl9NIC0gaiAqIHNwYW47XG4gIHJldHVybiBgaHR0cHM6Ly93bXMuaW0tbGRpLmNvbS8/U0VSVklDRT1XTVMmVkVSU0lPTj0xLjEuMSZSRVFVRVNUPUdldE1hcCZTVFlMRVM9JkxBWUVSUz1sdW5hX25hY19ucF9tb3NhaWMmU1JTPUlBVTIwMDA6MzAxMTgmQkJPWD0ke3h9LCR7eSAtIHNwYW59LCR7eCArIHNwYW59LCR7eX0mV0lEVEg9NTEyJkhFSUdIVD01MTImRk9STUFUPWltYWdlL2pwZWdgO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFJlLXByb2plY3Rpb24gY29yZS5cblxuLyoqIERlY29kZWQgcGljdHVyZTogMSA9IGdyZXksIDMgPSBSR0IgKGJvdGggZnVsbHkgb3BhcXVlKSwgNCA9IFJHQkEgd2l0aCBzdHJhaWdodCBhbHBoYS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU3JjIHsgdzogbnVtYmVyOyBoOiBudW1iZXI7IGNoOiAxIHwgMyB8IDQ7IGRhdGE6IFVpbnQ4QXJyYXkgfVxuXG4vKiogSGlzdG9ncmFtcyBvZiBUQyBFdmVuaW5nIGF0IGZvdXIgc2l0ZXMgaGF2ZSBhIHNwaWtlIGF0IDAtLTIgRE4sIHRoZW4gdGV4dHVyZWQgc2hhZG93LlxuICogRmVhdGhlciBzaXggU09VUkNFIHBpeGVscyBvdXRzaWRlIHRoYXQgc3Bpa2UsIGJlZm9yZSBwcm9qZWN0aW9uLiBCbGFjayBpdHNlbGYgY29udHJpYnV0ZXNcbiAqIG5vdGhpbmc7IHRoZSBvcHBvc2l0ZSBsaWdodGluZyBvciBXQUMgc3VwcGxpZXMgcmVhbCBncm91bmQgdW5kZXJuZWF0aC4gU29mdCBzaGFkb3dzIHN0YXkuXG4gKiBUaGUgZGlzdGFuY2UgdHJhbnNmb3JtIHVzZXMgZWlnaHRoLXBpeGVsIHN0ZXBzIHJhdGhlciB0aGFuIGEgYmx1ciBvZiB0aGUgcGhvdG9ncmFwaC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmZWF0aGVyUGhvdG9CbGFjayhzcmM6IFNyYywgcmFkaXVzID0gNik6IFNyYyB7XG4gIGNvbnN0IHsgdywgaCwgY2gsIGRhdGEgfSA9IHNyYywgY291bnQgPSB3ICogaCwgY2FwID0gcmFkaXVzICogODtcbiAgY29uc3QgZGFyayA9IChwOiBudW1iZXIpID0+IHtcbiAgICBjb25zdCBvID0gcCAqIGNoO1xuICAgIHJldHVybiBkYXRhW29dIDw9IDIgJiYgKGNoID09PSAxIHx8IChkYXRhW28gKyAxXSA8PSAyICYmIGRhdGFbbyArIDJdIDw9IDIpKTtcbiAgfTtcbiAgbGV0IGFueSA9IGZhbHNlO1xuICBjb25zdCBkaXN0YW5jZSA9IG5ldyBVaW50OEFycmF5KGNvdW50KTsgZGlzdGFuY2UuZmlsbChjYXApO1xuICBmb3IgKGxldCBwID0gMDsgcCA8IGNvdW50OyBwKyspIGlmIChkYXJrKHApKSB7IGRpc3RhbmNlW3BdID0gMDsgYW55ID0gdHJ1ZTsgfVxuICBpZiAoIWFueSkgcmV0dXJuIHNyYztcbiAgZm9yIChsZXQgeSA9IDA7IHkgPCBoOyB5KyspIGZvciAobGV0IHggPSAwOyB4IDwgdzsgeCsrKSB7XG4gICAgY29uc3QgcCA9IHkgKiB3ICsgeDtcbiAgICBpZiAoeCkgZGlzdGFuY2VbcF0gPSBNYXRoLm1pbihkaXN0YW5jZVtwXSwgZGlzdGFuY2VbcCAtIDFdICsgOCk7XG4gICAgaWYgKHkpIHtcbiAgICAgIGRpc3RhbmNlW3BdID0gTWF0aC5taW4oZGlzdGFuY2VbcF0sIGRpc3RhbmNlW3AgLSB3XSArIDgpO1xuICAgICAgaWYgKHgpIGRpc3RhbmNlW3BdID0gTWF0aC5taW4oZGlzdGFuY2VbcF0sIGRpc3RhbmNlW3AgLSB3IC0gMV0gKyAxMSk7XG4gICAgICBpZiAoeCArIDEgPCB3KSBkaXN0YW5jZVtwXSA9IE1hdGgubWluKGRpc3RhbmNlW3BdLCBkaXN0YW5jZVtwIC0gdyArIDFdICsgMTEpO1xuICAgIH1cbiAgfVxuICBmb3IgKGxldCB5ID0gaCAtIDE7IHkgPj0gMDsgeS0tKSBmb3IgKGxldCB4ID0gdyAtIDE7IHggPj0gMDsgeC0tKSB7XG4gICAgY29uc3QgcCA9IHkgKiB3ICsgeDtcbiAgICBpZiAoeCArIDEgPCB3KSBkaXN0YW5jZVtwXSA9IE1hdGgubWluKGRpc3RhbmNlW3BdLCBkaXN0YW5jZVtwICsgMV0gKyA4KTtcbiAgICBpZiAoeSArIDEgPCBoKSB7XG4gICAgICBkaXN0YW5jZVtwXSA9IE1hdGgubWluKGRpc3RhbmNlW3BdLCBkaXN0YW5jZVtwICsgd10gKyA4KTtcbiAgICAgIGlmICh4KSBkaXN0YW5jZVtwXSA9IE1hdGgubWluKGRpc3RhbmNlW3BdLCBkaXN0YW5jZVtwICsgdyAtIDFdICsgMTEpO1xuICAgICAgaWYgKHggKyAxIDwgdykgZGlzdGFuY2VbcF0gPSBNYXRoLm1pbihkaXN0YW5jZVtwXSwgZGlzdGFuY2VbcCArIHcgKyAxXSArIDExKTtcbiAgICB9XG4gIH1cbiAgY29uc3Qgb3V0ID0gbmV3IFVpbnQ4QXJyYXkoY291bnQgKiA0KTtcbiAgZm9yIChsZXQgcCA9IDA7IHAgPCBjb3VudDsgcCsrKSB7XG4gICAgY29uc3QgbyA9IHAgKiBjaCwgcSA9IHAgKiA0O1xuICAgIG91dFtxXSA9IGRhdGFbb107IG91dFtxICsgMV0gPSBkYXRhW2NoID09PSAxID8gbyA6IG8gKyAxXTsgb3V0W3EgKyAyXSA9IGRhdGFbY2ggPT09IDEgPyBvIDogbyArIDJdO1xuICAgIG91dFtxICsgM10gPSAoY2ggPT09IDQgPyBkYXRhW28gKyAzXSA6IDI1NSkgKiBzbW9vdGgoZGlzdGFuY2VbcF0gLyBjYXApO1xuICB9XG4gIHJldHVybiB7IHcsIGgsIGNoOiA0LCBkYXRhOiBvdXQgfTtcbn1cblxuLyoqIFRDJ3MgYmxhY2sgc3RyaXBzIGFyZSBtaXNzaW5nIG9ic2VydmF0aW9ucywgbm90IGRhcmsgdGVycmFpbi4gSXRzIHNlcnZlciBQTkdzIGRvIG5vdFxuICogYWx3YXlzIG1hcmsgdGhlbSB0cmFuc3BhcmVudC4gUHJlc2VydmUgV0FDIHRoZXJlIHJhdGhlciB0aGFuIGRyYXdpbmcgaW52ZW50ZWQgZGFyayBqb2lucy4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0Y05vRGF0YShzcmM6IFNyYyk6IFNyYyB7XG4gIGNvbnN0IHsgZGF0YSwgY2gsIHcsIGggfSA9IHNyYztcbiAgbGV0IGhvbGVzID0gZmFsc2U7XG4gIGZvciAobGV0IG8gPSAwOyBvIDwgZGF0YS5sZW5ndGg7IG8gKz0gY2gpIGlmIChkYXRhW29dID09PSAwICYmIChjaCA9PT0gMSB8fCAoZGF0YVtvICsgMV0gPT09IDAgJiYgZGF0YVtvICsgMl0gPT09IDApKSkgeyBob2xlcyA9IHRydWU7IGJyZWFrOyB9XG4gIGlmICghaG9sZXMpIHJldHVybiBzcmM7XG4gIGNvbnN0IG91dCA9IG5ldyBVaW50OEFycmF5KHcgKiBoICogNCk7XG4gIGZvciAobGV0IHAgPSAwOyBwIDwgdyAqIGg7IHArKykge1xuICAgIGNvbnN0IG8gPSBwICogY2gsIHEgPSBwICogNCwgciA9IGRhdGFbb10sIGcgPSBjaCA9PT0gMSA/IHIgOiBkYXRhW28gKyAxXSwgYiA9IGNoID09PSAxID8gciA6IGRhdGFbbyArIDJdO1xuICAgIG91dFtxXSA9IHI7IG91dFtxICsgMV0gPSBnOyBvdXRbcSArIDJdID0gYjsgb3V0W3EgKyAzXSA9IHIgPT09IDAgJiYgZyA9PT0gMCAmJiBiID09PSAwID8gMCA6IGNoID09PSA0ID8gZGF0YVtvICsgM10gOiAyNTU7XG4gIH1cbiAgcmV0dXJuIHsgdywgaCwgY2g6IDQsIGRhdGE6IG91dCB9O1xufVxuXG4vKiogQSBwb2xhciByYXN0ZXIgd2l0aCBzbWFsbGVyIGNvcGllcyAoZWFjaCBoYWxmIHRoZSBzaXplKSBzbyB6b29tZWQtb3V0IHZpZXdzIGRvbid0IHNwYXJrbGUuICovXG5leHBvcnQgaW50ZXJmYWNlIFJhc3RlciB7IGxldmVsczogU3JjW10gfVxuXG4vKiogQSBzdG9yZWQgc2NpZW5jZSBtYXAuIFBhbGV0dGVzIGtlZXAgdGhlIHNoYXJwIHNvdXJjZSBhdCBvbmUgYnl0ZSBwZXIgcGl4ZWwuICovXG5leHBvcnQgaW50ZXJmYWNlIFNjaWVuY2VSYXN0ZXJTb3VyY2Uge1xuICB1cmw6IHN0cmluZztcbiAgcHJvamVjdGlvbjogJ2dsb2JhbCcgfCAncG9sYXInO1xuICBwb2xlPzogJ25vcnRoJyB8ICdzb3V0aCc7XG4gIGV4dGVudE0/OiBudW1iZXI7XG4gIGNsaXBUcnVlTGF0RGVnPzogbnVtYmVyO1xuICBtYXhpbXVtVHJ1ZUxhdERlZz86IG51bWJlcjtcbiAgcGFsZXR0ZT86IHN0cmluZ1tdO1xuICAvKiogU2hhcnBlciB0ZXJyYWluIHJlcGxhY2VzIHRoZSBjb2Fyc2UgbWFwLCBpbmNsdWRpbmcgZ3JvdW5kIHRoZSBzaGFycGVyIG1hcCBtYXJrcyBjbGVhci4gKi9cbiAgcmVwbGFjZT86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzY2llbmNlUGFsZXR0ZShjb2xvdXJzOiBzdHJpbmdbXSk6IFVpbnQ4QXJyYXkge1xuICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheSgyNTYgKiA0KTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBNYXRoLm1pbigyNTYsIGNvbG91cnMubGVuZ3RoKTsgaSsrKSB7XG4gICAgY29uc3QgcyA9IGNvbG91cnNbaV0/LnJlcGxhY2UoJyMnLCAnJykgPz8gJyc7XG4gICAgaWYgKCEvXltcXGRhLWZdezZ9KFtcXGRhLWZdezJ9KT8kL2kudGVzdChzKSkgY29udGludWU7XG4gICAgb3V0W2kgKiA0XSA9IHBhcnNlSW50KHMuc2xpY2UoMCwgMiksIDE2KTsgb3V0W2kgKiA0ICsgMV0gPSBwYXJzZUludChzLnNsaWNlKDIsIDQpLCAxNik7XG4gICAgb3V0W2kgKiA0ICsgMl0gPSBwYXJzZUludChzLnNsaWNlKDQsIDYpLCAxNik7IG91dFtpICogNCArIDNdID0gcy5sZW5ndGggPT09IDggPyBwYXJzZUludChzLnNsaWNlKDYsIDgpLCAxNikgOiAyNTU7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIEF2ZXJhZ2UgY29sb3VycywgbmV2ZXIgY2xhc3MgbnVtYmVyczogY2xhc3MgMSBtaXhlZCB3aXRoIGNsYXNzIDMgbXVzdCBub3QgaW52ZW50IGNsYXNzIDIuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRTY2llbmNlTWlwcyhmdWxsOiBTcmMsIHBhbGV0dGU/OiBVaW50OEFycmF5KTogUmFzdGVyIHtcbiAgaWYgKCFwYWxldHRlIHx8IGZ1bGwuY2ggIT09IDEpIHJldHVybiBidWlsZE1pcHMoZnVsbCk7XG4gIGNvbnN0IGNvbG91cnMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCAyNTY7IGkrKykgaWYgKHBhbGV0dGVbaSAqIDQgKyAzXSkgY29sb3Vycy5hZGQoYCR7cGFsZXR0ZVtpICogNF19LCR7cGFsZXR0ZVtpICogNCArIDFdfSwke3BhbGV0dGVbaSAqIDQgKyAyXX1gKTtcbiAgaWYgKGNvbG91cnMuc2l6ZSA8PSAxKSB7XG4gICAgLy8gQSBzaGFkb3cgbWFwIHZhcmllcyBvbmx5IGluIGNvdmVyYWdlOiBpdHMgc21hbGwgY29waWVzIGNhbiBzdGF5IG9uZSBieXRlIHRvby5cbiAgICBjb25zdCBuZWFyZXN0ID0gbmV3IFVpbnQ4QXJyYXkoMjU2KTtcbiAgICBmb3IgKGxldCBhID0gMDsgYSA8IDI1NjsgYSsrKSB7XG4gICAgICBsZXQgYmVzdCA9IEluZmluaXR5O1xuICAgICAgZm9yIChsZXQgYyA9IDA7IGMgPCAyNTY7IGMrKykgeyBjb25zdCBkID0gTWF0aC5hYnMoYSAtIHBhbGV0dGVbYyAqIDQgKyAzXSk7IGlmIChkIDwgYmVzdCkgeyBiZXN0ID0gZDsgbmVhcmVzdFthXSA9IGM7IH0gfVxuICAgIH1cbiAgICBjb25zdCBsZXZlbHMgPSBbZnVsbF07XG4gICAgZm9yIChsZXQgcyA9IGZ1bGw7IE1hdGgubWluKHMudywgcy5oKSA+IDMyOyApIHtcbiAgICAgIGNvbnN0IHcgPSBNYXRoLm1heCgxLCBzLncgPj4gMSksIGggPSBNYXRoLm1heCgxLCBzLmggPj4gMSksIGRhdGEgPSBuZXcgVWludDhBcnJheSh3ICogaCk7XG4gICAgICBmb3IgKGxldCB5ID0gMDsgeSA8IGg7IHkrKykgZm9yIChsZXQgeCA9IDA7IHggPCB3OyB4KyspIHtcbiAgICAgICAgbGV0IGFscGhhID0gMDtcbiAgICAgICAgZm9yIChsZXQgZHkgPSAwOyBkeSA8IDI7IGR5KyspIGZvciAobGV0IGR4ID0gMDsgZHggPCAyOyBkeCsrKSBhbHBoYSArPSBwYWxldHRlW3MuZGF0YVtNYXRoLm1pbihzLmggLSAxLCB5ICogMiArIGR5KSAqIHMudyArIE1hdGgubWluKHMudyAtIDEsIHggKiAyICsgZHgpXSAqIDQgKyAzXTtcbiAgICAgICAgZGF0YVt5ICogdyArIHhdID0gbmVhcmVzdFtNYXRoLnJvdW5kKGFscGhhIC8gNCldO1xuICAgICAgfVxuICAgICAgcyA9IHsgdywgaCwgY2g6IDEsIGRhdGEgfTsgbGV2ZWxzLnB1c2gocyk7XG4gICAgfVxuICAgIHJldHVybiB7IGxldmVscyB9O1xuICB9XG4gIGNvbnN0IHcgPSBNYXRoLm1heCgxLCBmdWxsLncgPj4gMSksIGggPSBNYXRoLm1heCgxLCBmdWxsLmggPj4gMSksIG91dCA9IG5ldyBVaW50OEFycmF5KHcgKiBoICogNCk7XG4gIGZvciAobGV0IHkgPSAwOyB5IDwgaDsgeSsrKSBmb3IgKGxldCB4ID0gMDsgeCA8IHc7IHgrKykge1xuICAgIGxldCBSID0gMCwgRyA9IDAsIEIgPSAwLCBBID0gMDtcbiAgICBmb3IgKGxldCBkeSA9IDA7IGR5IDwgMjsgZHkrKykgZm9yIChsZXQgZHggPSAwOyBkeCA8IDI7IGR4KyspIHtcbiAgICAgIGNvbnN0IGsgPSBmdWxsLmRhdGFbTWF0aC5taW4oZnVsbC5oIC0gMSwgeSAqIDIgKyBkeSkgKiBmdWxsLncgKyBNYXRoLm1pbihmdWxsLncgLSAxLCB4ICogMiArIGR4KV0gKiA0LCBhID0gcGFsZXR0ZVtrICsgM107XG4gICAgICBSICs9IHBhbGV0dGVba10gKiBhOyBHICs9IHBhbGV0dGVbayArIDFdICogYTsgQiArPSBwYWxldHRlW2sgKyAyXSAqIGE7IEEgKz0gYTtcbiAgICB9XG4gICAgY29uc3QgbyA9ICh5ICogdyArIHgpICogNDtcbiAgICBpZiAoQSkgeyBvdXRbb10gPSBNYXRoLnJvdW5kKFIgLyBBKTsgb3V0W28gKyAxXSA9IE1hdGgucm91bmQoRyAvIEEpOyBvdXRbbyArIDJdID0gTWF0aC5yb3VuZChCIC8gQSk7IH1cbiAgICBvdXRbbyArIDNdID0gTWF0aC5yb3VuZChBIC8gNCk7XG4gIH1cbiAgcmV0dXJuIHsgbGV2ZWxzOiBbZnVsbCwgLi4uYnVpbGRNaXBzKHsgdywgaCwgY2g6IDQsIGRhdGE6IG91dCB9KS5sZXZlbHNdIH07XG59XG5cbi8qKiBPbmUgc291cmNlIHBpY3R1cmUgcGVyIG1pcCBsZXZlbC4gVGhlIGZ1bGwgc291cmNlIHN0YXlzIGluZGV4ZWQ7IG9ubHkgc21hbGxlciBjb3BpZXMgdXNlIFJHQkEuICovXG5leHBvcnQgZnVuY3Rpb24gc2FtcGxlU2NpZW5jZShmcDogRm9vdHByaW50LCByYXN0ZXI6IFJhc3RlciwgcGFsZXR0ZTogVWludDhBcnJheSB8IHVuZGVmaW5lZCwgZ2xvYmFsOiBib29sZWFuLCBmbGlwOiBib29sZWFuKTogVWludDhDbGFtcGVkQXJyYXk8QXJyYXlCdWZmZXI+IHwgbnVsbCB7XG4gIGlmICghcGFsZXR0ZSB8fCByYXN0ZXIubGV2ZWxzWzBdLmNoICE9PSAxKSB7XG4gICAgY29uc3QgZ3JpZHMgPSByYXN0ZXIubGV2ZWxzLm1hcChzID0+ICh7IC4uLnNpbmdsZUdyaWQocyksIGdsb2JhbCB9KSk7XG4gICAgcmV0dXJuIHNhbXBsZVRpbGVzKGZwLCBncmlkcywgcmFzdGVyLmxldmVscy5tYXAoKF8sIGkpID0+IGkgKiBLRVlfTEVWRUwpLCByYXN0ZXIubGV2ZWxzLCBmbGlwKTtcbiAgfVxuICBjb25zdCBvdXQgPSBuZXcgVWludDhDbGFtcGVkQXJyYXkoTjIgKiA0KTtcbiAgbGV0IGFueSA9IGZhbHNlO1xuICBmb3IgKGxldCBwID0gMDsgcCA8IE4yOyBwKyspIHtcbiAgICBpZiAoZnAuY292W3BdIDw9IDApIGNvbnRpbnVlO1xuICAgIGNvbnN0IHMgPSByYXN0ZXIubGV2ZWxzW2ZwLmx2bFtwXV0sIGluZGV4ZWQgPSBzLmNoID09PSAxLCBrID0gZnAudGFwc1twXSwgc3RlcCA9IGZwLnN0ZXBbcF07XG4gICAgbGV0IFIgPSAwLCBHID0gMCwgQiA9IDAsIEEgPSAwO1xuICAgIGZvciAobGV0IHQgPSAwOyB0IDwgazsgdCsrKSB7XG4gICAgICBjb25zdCB1ID0gZnAudVtwXSArICh0IC0gKGsgLSAxKSAvIDIpICogc3RlcCwgdiA9IGZwLnZbcF0sIGMgPSBNYXRoLmZsb29yKHUpLCByID0gTWF0aC5mbG9vcih2KSwgdHggPSB1IC0gYywgdHkgPSB2IC0gcjtcbiAgICAgIGZvciAobGV0IGR5ID0gMDsgZHkgPCAyOyBkeSsrKSBmb3IgKGxldCBkeCA9IDA7IGR4IDwgMjsgZHgrKykge1xuICAgICAgICBsZXQgeCA9IGMgKyBkeCwgeSA9IHIgKyBkeTtcbiAgICAgICAgaWYgKGdsb2JhbCkgeyB4ID0gKCh4ICUgcy53KSArIHMudykgJSBzLnc7IHkgPSBjbGFtcCh5LCAwLCBzLmggLSAxKTsgfVxuICAgICAgICBlbHNlIGlmICh4IDwgMCB8fCB5IDwgMCB8fCB4ID49IHMudyB8fCB5ID49IHMuaCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IHEgPSBpbmRleGVkID8gcy5kYXRhW3kgKiBzLncgKyB4XSAqIDQgOiAoeSAqIHMudyArIHgpICogNCwgZCA9IGluZGV4ZWQgPyBwYWxldHRlIDogcy5kYXRhO1xuICAgICAgICBjb25zdCBhID0gZFtxICsgM10gKiAoZHggPyB0eCA6IDEgLSB0eCkgKiAoZHkgPyB0eSA6IDEgLSB0eSk7XG4gICAgICAgIFIgKz0gZFtxXSAqIGE7IEcgKz0gZFtxICsgMV0gKiBhOyBCICs9IGRbcSArIDJdICogYTsgQSArPSBhO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoQSA8PSAxZS02KSBjb250aW51ZTtcbiAgICBjb25zdCByb3cgPSBNYXRoLmZsb29yKHAgLyBUSUxFKSwgbyA9ICgoZmxpcCA/IHJvdyA6IFRJTEUgLSAxIC0gcm93KSAqIFRJTEUgKyBwICUgVElMRSkgKiA0O1xuICAgIG91dFtvXSA9IFIgLyBBOyBvdXRbbyArIDFdID0gRyAvIEE7IG91dFtvICsgMl0gPSBCIC8gQTsgb3V0W28gKyAzXSA9IGZwLmNvdltwXSAqIEEgLyBrO1xuICAgIGFueSA9IHRydWU7XG4gIH1cbiAgcmV0dXJuIGFueSA/IG91dCA6IG51bGw7XG59XG5cbi8qKiBUcnVlIGxvbi9sYXQgbWFwcyBrZWVwIGEgbGV2ZWwgcGVyIHBpeGVsIG5lYXIgdGhlIHBvbGVzLCB3aGVyZSBvbmUgcGl4ZWwgc3BhbnMgbWFueSBsb25naXR1ZGVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjaWVuY2VHbG9iYWxGb290cHJpbnQoZnA6IEZvb3RwcmludCwgcjogUmVjdCwgbGV2ZWw6IG51bWJlciwgcmFzdGVyOiBSYXN0ZXIpIHtcbiAgdHJla0dlb21ldHJ5KGZwLCByLCAtOTApO1xuICBjb25zdCBiYXNlID0gcmFzdGVyLmxldmVsc1swXSwgYmFzZU1pcCA9IE1hdGguZmxvb3IoTWF0aC5sb2cyKGJhc2UudyAvIChUSUxFICogMiAqKiAobGV2ZWwgKyAxKSkpKTtcbiAgZm9yIChsZXQgcCA9IDA7IHAgPCBOMjsgcCsrKSB7XG4gICAgY29uc3QgbSA9IGNsYW1wKGJhc2VNaXAgKyBmcC5jb2Fyc2VyW3BdLCAwLCByYXN0ZXIubGV2ZWxzLmxlbmd0aCAtIDEpLCBzID0gcmFzdGVyLmxldmVsc1ttXTtcbiAgICBjb25zdCB3aWR0aCA9IE1hdGgubWluKHMudywgZnAudzBbcF0gKiBzLncgLyAoVElMRSAqIDIgKiogKGxldmVsICsgMSkpKTtcbiAgICBjb25zdCB0YXBzID0gd2lkdGggPiBUQVBfU1BBQ0lORyA/IE1hdGgubWluKE1BWF9UQVBTLCBNYXRoLmNlaWwod2lkdGggLyBUQVBfU1BBQ0lORykpIDogMTtcbiAgICBmcC5sdmxbcF0gPSBtOyBmcC50YXBzW3BdID0gdGFwczsgZnAuc3RlcFtwXSA9IHRhcHMgPiAxID8gd2lkdGggLyB0YXBzIDogMDtcbiAgICBmcC51W3BdID0gKGZwLmJbcF0gKyBNYXRoLlBJKSAqIHMudyAvICgyICogTWF0aC5QSSkgLSAwLjU7XG4gICAgZnAudltwXSA9IChNYXRoLlBJIC8gMiAtIGZwLmFbcF0pICogcy5oIC8gTWF0aC5QSSAtIDAuNTtcbiAgfVxufVxuXG4vKiogU2hhcnBlciB0ZXJyYWluIG1heSBjbGVhciBhIGNvYXJzZSB3YXJuaW5nOyBldmlkZW5jZSBtYXBzIGluc3RlYWQgYWRkIHRoZWlyIG93biBjb2xvdXIuICovXG5leHBvcnQgZnVuY3Rpb24gY29tcG9zaXRlU2NpZW5jZVBpeGVscyhvdXQ6IFVpbnQ4Q2xhbXBlZEFycmF5PEFycmF5QnVmZmVyPiwgcHg6IFVpbnQ4Q2xhbXBlZEFycmF5PEFycmF5QnVmZmVyPiB8IG51bGwsIGNvdmVyYWdlOiBGbG9hdDMyQXJyYXksIGZsaXA6IGJvb2xlYW4sIHJlcGxhY2UgPSBmYWxzZSkge1xuICBmb3IgKGxldCBwID0gMDsgcCA8IE4yOyBwKyspIHtcbiAgICBjb25zdCByb3cgPSBNYXRoLmZsb29yKHAgLyBUSUxFKSwgbyA9ICgoZmxpcCA/IHJvdyA6IFRJTEUgLSAxIC0gcm93KSAqIFRJTEUgKyBwICUgVElMRSkgKiA0O1xuICAgIGlmIChyZXBsYWNlICYmIGNvdmVyYWdlW3BdID4gMC45OSkgeyBvdXRbb10gPSBvdXRbbyArIDFdID0gb3V0W28gKyAyXSA9IG91dFtvICsgM10gPSAwOyB9XG4gICAgY29uc3QgYSA9IChweD8uW28gKyAzXSA/PyAwKSAvIDI1NTtcbiAgICBpZiAoIWEgfHwgIXB4KSBjb250aW51ZTtcbiAgICBjb25zdCBiID0gb3V0W28gKyAzXSAvIDI1NSwgQSA9IGEgKyBiICogKDEgLSBhKTtcbiAgICBmb3IgKGxldCBjID0gMDsgYyA8IDM7IGMrKykgb3V0W28gKyBjXSA9IChweFtvICsgY10gKiBhICsgb3V0W28gKyBjXSAqIGIgKiAoMSAtIGEpKSAvIEE7XG4gICAgb3V0W28gKyAzXSA9IEEgKiAyNTU7XG4gIH1cbn1cblxuLyoqIEhvdyBzb3VyY2UgdGlsZXMgYXJlIGxhaWQgb3V0OiB0aWxlIHNpemUsIHRpbGVzIGFjcm9zcywgd2hvbGUgc2l6ZSwgYW5kIHdoZXRoZXIgaXQgd3JhcHMgaW4gbG9uZ2l0dWRlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBHcmlkIHsgdGlsZVc6IG51bWJlcjsgdGlsZUg6IG51bWJlcjsgdGlsZXNYOiBudW1iZXI7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyOyBnbG9iYWw6IGJvb2xlYW4gfVxuXG5leHBvcnQgY29uc3QgdHJla0dyaWQgPSAoejogbnVtYmVyKTogR3JpZCA9PlxuICAoeyB0aWxlVzogVElMRSwgdGlsZUg6IFRJTEUsIHRpbGVzWDogMiAqKiAoeiArIDEpLCB3aWR0aDogVElMRSAqIDIgKiogKHogKyAxKSwgaGVpZ2h0OiBUSUxFICogMiAqKiB6LCBnbG9iYWw6IHRydWUgfSk7XG5leHBvcnQgY29uc3QgcHlyYW1pZEdyaWQgPSAoazogbnVtYmVyKTogR3JpZCA9PlxuICAoeyB0aWxlVzogUFlSQU1JRF9QWCwgdGlsZUg6IFBZUkFNSURfUFgsIHRpbGVzWDogMiAqKiBrLCB3aWR0aDogUFlSQU1JRF9QWCAqIDIgKiogaywgaGVpZ2h0OiBQWVJBTUlEX1BYICogMiAqKiBrLCBnbG9iYWw6IGZhbHNlIH0pO1xuY29uc3Qgc2luZ2xlR3JpZCA9IChzOiBTcmMpOiBHcmlkID0+ICh7IHRpbGVXOiBzLncsIHRpbGVIOiBzLmgsIHRpbGVzWDogMSwgd2lkdGg6IHMudywgaGVpZ2h0OiBzLmgsIGdsb2JhbDogZmFsc2UgfSk7XG5cbi8qKlxuICogQSBzb3VyY2UgdGlsZSBpcyBuYW1lZCBieSBvbmUgbnVtYmVyOiBncmlkICogS0VZX0xFVkVMICsgcm93ICogdGlsZXNYICsgY29sdW1uLCB3aGVyZSBncmlkIGlzXG4gKiB0aGUgaW5kZXggaW50byB0aGUgcGxhbidzIGBncmlkc2AgKGZvciBNb29uIFRyZWsgdGhhdCBpcyB0aGUgTW9vbiBUcmVrIGxldmVsIGl0c2VsZikuXG4gKi9cbmV4cG9ydCBjb25zdCBLRVlfTEVWRUwgPSAyICoqIDM1OyAvLyByb29tIGZvciBhIGNvbXBsZXRlIGxldmVsLTE2IGdyaWQsIHN0aWxsIGV4YWN0IGluIGEgSmF2YVNjcmlwdCBudW1iZXJcblxuLyoqIE1vb24gVHJlayBsZXZlbCwgY29sdW1uIGFuZCByb3cgb2YgYSB0aWxlIGtleS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0cmVrVGlsZU9mKGtleTogbnVtYmVyKTogeyB6OiBudW1iZXI7IHg6IG51bWJlcjsgeTogbnVtYmVyIH0ge1xuICBjb25zdCB6ID0gTWF0aC5mbG9vcihrZXkgLyBLRVlfTEVWRUwpLCBsb2NhbCA9IGtleSAtIHogKiBLRVlfTEVWRUwsIG4gPSAyICoqICh6ICsgMSk7XG4gIHJldHVybiB7IHosIHg6IGxvY2FsICUgbiwgeTogTWF0aC5mbG9vcihsb2NhbCAvIG4pIH07XG59XG5cbi8qKiBXaGF0IHdlIG5lZWQgdG8gZmV0Y2ggZm9yIG9uZSBkaXNwbGF5IHRpbGU6IHRoZSBkZWVwZXN0IHNvdXJjZSBsZXZlbCB1c2VkLCB0aGUgZ3JpZCBwZXIgbGV2ZWwgYW5kIHRoZSB0aWxlIGtleXMuICovXG5leHBvcnQgaW50ZXJmYWNlIFBsYW4geyBsZXZlbDogbnVtYmVyOyBncmlkczogR3JpZFtdOyBrZXlzOiBudW1iZXJbXSB9XG5cbi8qKlxuICogU2NyYXRjaCBzcGFjZSBmb3Igb25lIGRpc3BsYXkgdGlsZTogd2hlcmUgZWFjaCBvZiBpdHMgMjU2eDI1NiBwaXhlbHMgbGFuZHMuXG4gKiBhL2IgPSB0cnVlIGxhdC9sb24gKHJhZGlhbnMsIE1vb24gVHJlaykgb3IgcG9sYXIgbWFwIHgveSAobWV0cmVzLCBwb2xhciBsYXllcnMpO1xuICogdS92ID0gZnJhY3Rpb25hbCBzb3VyY2UgcGl4ZWwgKHNoaWZ0ZWQgYnkgaGFsZiBhIHBpeGVsLCByZWFkeSBmb3IgYmlsaW5lYXIpO1xuICogY292ID0gaG93IG11Y2ggb2YgdGhlIHBpeGVsIGxpZXMgaW5zaWRlIHRoZSBsYXllcidzIGFyZWEgKDAuLjEsIHNvZnQgYXQgdGhlIGVkZ2VzKTtcbiAqIGx2bCA9IHdoaWNoIG9mIHRoZSBwbGFuJ3MgZ3JpZHMgdGhlIHBpeGVsIHJlYWRzOyB0YXBzIC8gc3RlcCA9IGhvdyBtYW55IHNhbXBsZXMgaXQgYXZlcmFnZXNcbiAqIGFsb25nIHRydWUgZWFzdCBhbmQgaG93IGZhciBhcGFydCB0aGV5IGFyZSAoc291cmNlIHBpeGVscykuXG4gKiBSb3dzIHJ1biBub3J0aCB0byBzb3V0aCwgYXMgQ2VzaXVtJ3MgdGlsZSByZWN0YW5nbGUgZG9lcy5cbiAqL1xuZXhwb3J0IGNsYXNzIEZvb3RwcmludCB7XG4gIHJlYWRvbmx5IGEgPSBuZXcgRmxvYXQ2NEFycmF5KE4yKTtcbiAgcmVhZG9ubHkgYiA9IG5ldyBGbG9hdDY0QXJyYXkoTjIpO1xuICByZWFkb25seSB1ID0gbmV3IEZsb2F0NjRBcnJheShOMik7XG4gIHJlYWRvbmx5IHYgPSBuZXcgRmxvYXQ2NEFycmF5KE4yKTtcbiAgcmVhZG9ubHkgY292ID0gbmV3IEZsb2F0MzJBcnJheShOMik7XG4gIHJlYWRvbmx5IGx2bCA9IG5ldyBVaW50OEFycmF5KE4yKTtcbiAgcmVhZG9ubHkgdGFwcyA9IG5ldyBVaW50OEFycmF5KE4yKTtcbiAgcmVhZG9ubHkgc3RlcCA9IG5ldyBGbG9hdDMyQXJyYXkoTjIpO1xuICAvKiogTW9vbiBUcmVrOiBlYXN0LXdlc3Qgc2l6ZSBvZiB0aGUgcGl4ZWwgaW4gc291cmNlIHBpeGVscyBhdCB0aGUgZGlzcGxheSBsZXZlbCwgYW5kIGhvdyBtYW55IGxldmVscyBjb2Fyc2VyIHRvIHJlYWQuICovXG4gIHJlYWRvbmx5IHcwID0gbmV3IEZsb2F0MzJBcnJheShOMik7XG4gIHJlYWRvbmx5IGNvYXJzZXIgPSBuZXcgVWludDhBcnJheShOMik7XG4gIHJlYWRvbmx5IGNvc0xvbiA9IG5ldyBGbG9hdDY0QXJyYXkoVElMRSk7XG4gIHJlYWRvbmx5IHNpbkxvbiA9IG5ldyBGbG9hdDY0QXJyYXkoVElMRSk7XG59XG5cbmZ1bmN0aW9uIGNvbHVtbnMoZnA6IEZvb3RwcmludCwgcjogUmVjdCkge1xuICBjb25zdCBkTG9uID0gKHIuZWFzdCAtIHIud2VzdCkgLyBUSUxFO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IFRJTEU7IGkrKykgeyBjb25zdCBsb24gPSByLndlc3QgKyAoaSArIDAuNSkgKiBkTG9uOyBmcC5jb3NMb25baV0gPSBNYXRoLmNvcyhsb24pOyBmcC5zaW5Mb25baV0gPSBNYXRoLnNpbihsb24pOyB9XG59XG5cbi8qKlxuICogSG93IG1hbnkgTW9vbiBUcmVrIGxldmVscyBjb2Fyc2VyIHRoYW4gdGhlIGRpc3BsYXkgbGV2ZWwgdG8gcmVhZCB3aGVyZSB0aGUgbWFwIGlzIHNxdWVlemVkXG4gKiBlYXN0LXdlc3QgYnkgcyA9IDEvY29zKHRydWUgbGF0aXR1ZGUpLiBaZXJvIGZvciBhbGwgbGF0aXR1ZGVzIGJlbG93IDgxLjjCsDsgYWJvdmUgdGhhdCBvbmVcbiAqIGxldmVsIG1vcmUgZWFjaCB0aW1lIHMgZG91YmxlcyAoODQuOcKwLCA4Ny40wrAsIDg4LjfCsCwgLi4uKSwgc28gbmVpZ2hib3VyaW5nIHJpbmdzIG9mIGxhdGl0dWRlXG4gKiBkaWZmZXIgYnkgZXhhY3RseSBvbmUgbGV2ZWwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0cmVrQ29hcnNlbihzOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gcyA8PSBTUVVFRVpFX0ZVTEwgPyAwIDogTWF0aC5taW4oMzAsIE1hdGguY2VpbChNYXRoLmxvZzIocyAvIFNRVUVFWkVfUE9MRSkpKTtcbn1cblxuLyoqIERpc3BsYXkgcGl4ZWwgY2VudHJlcyAtPiB0cnVlIGxhdC9sb24uIFBpeGVscyBzb3V0aCBvZiBgbWluVHJ1ZUxhdERlZ2AgYXJlIGxlZnQgb3V0IChzb2Z0IG92ZXIgb25lIHBpeGVsKS4gUmV0dXJucyBmYWxzZSBpZiBub3RoaW5nIGlzIGNvdmVyZWQuICovXG5leHBvcnQgZnVuY3Rpb24gdHJla0dlb21ldHJ5KGZwOiBGb290cHJpbnQsIHI6IFJlY3QsIG1pblRydWVMYXREZWc6IG51bWJlcik6IGJvb2xlYW4ge1xuICBjb2x1bW5zKGZwLCByKTtcbiAgY29uc3QgZExhdCA9IChyLm5vcnRoIC0gci5zb3V0aCkgLyBUSUxFLCBtaW5MYXQgPSBtaW5UcnVlTGF0RGVnICogREVHLCBjbGlwID0gbWluVHJ1ZUxhdERlZyA+IC05MDtcbiAgbGV0IGFueSA9IGZhbHNlO1xuICBmb3IgKGxldCBqID0gMDsgaiA8IFRJTEU7IGorKykge1xuICAgIGNvbnN0IGxhdCA9IHIubm9ydGggLSAoaiArIDAuNSkgKiBkTGF0LCBjbCA9IE1hdGguY29zKGxhdCksIFogPSBNYXRoLnNpbihsYXQpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgVElMRTsgaSsrKSB7XG4gICAgICBjb25zdCBwID0gaiAqIFRJTEUgKyBpLCBYID0gY2wgKiBmcC5jb3NMb25baV0sIFkgPSBjbCAqIGZwLnNpbkxvbltpXTtcbiAgICAgIC8vIGRpc3BsYXkgKFgsIFksIFopIC0+IHRydWUgKFgsIFosIC1ZKSwgYXMgaW4gZnJhbWUudHNcbiAgICAgIGNvbnN0IHRMYXQgPSBNYXRoLmFzaW4oY2xhbXAoLVksIC0xLCAxKSk7XG4gICAgICBmcC5hW3BdID0gdExhdDtcbiAgICAgIGZwLmJbcF0gPSBNYXRoLmF0YW4yKFosIFgpO1xuICAgICAgY29uc3QgYyA9IGNsaXAgPyBjbGFtcDAxKCh0TGF0IC0gbWluTGF0KSAvIGRMYXQgKyAwLjUpIDogMTtcbiAgICAgIGZwLmNvdltwXSA9IGM7XG4gICAgICBpZiAoYyA8PSAwKSBjb250aW51ZTtcbiAgICAgIGFueSA9IHRydWU7XG4gICAgICAvLyBUcnVlIGxvbmdpdHVkZSA9IGF0YW4yKFosIFgpLiBPbmUgc3RlcCBvZiBkaXNwbGF5IGxvbiBtb3ZlcyBpdCBieSBzaW7Ct2NvcyhsYXQpwrdzaW4obG9uKVxuICAgICAgLy8gLyBjb3PCsih0cnVlIGxhdCkgc291cmNlIHBpeGVscyAoYXQgdGhlIGRpc3BsYXkgbGV2ZWwpLCBvbmUgc3RlcCBvZiBkaXNwbGF5IGxhdCBieVxuICAgICAgLy8gY29zKGxvbikgLyBjb3PCsih0cnVlIGxhdCkuIFRoZSBsYXJnZXIgb2YgdGhlIHR3byBpcyBob3cgbWFueSBzb3VyY2UgcGl4ZWxzIGFsb25nIHRydWVcbiAgICAgIC8vIGVhc3Qgb25lIGRpc3BsYXkgcGl4ZWwgc3BhbnM6IG1vcmUgdGhhbiB+MSBhbmQgc2luZ2xlIHNhbXBsZXMgd291bGQgYWxpYXMuXG4gICAgICBjb25zdCBjb3MyID0gTWF0aC5tYXgoWCAqIFggKyBaICogWiwgMWUtMjQpOyAvLyBjb3PCsih0cnVlIGxhdGl0dWRlKVxuICAgICAgZnAudzBbcF0gPSBNYXRoLm1pbihNYXRoLm1heChNYXRoLmFicyhaICogY2wgKiBmcC5zaW5Mb25baV0pLCBNYXRoLmFicyhmcC5jb3NMb25baV0pKSAvIGNvczIsIDFlMzApO1xuICAgICAgZnAuY29hcnNlcltwXSA9IHRyZWtDb2Fyc2VuKDEgLyBNYXRoLnNxcnQoY29zMikpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gYW55O1xufVxuXG4vKipcbiAqIFRydWUgbGF0L2xvbiAtPiBNb29uIFRyZWsgcGl4ZWwgZm9yIGV2ZXJ5IGNvdmVyZWQgcGl4ZWw6IHRoZSBzb3VyY2UgbGV2ZWwgKGRpc3BsYXkgbGV2ZWwsXG4gKiBjYXBwZWQgYXQgYHRvcGAsIGNvYXJzZXIgbmVhciB0aGUgdHJ1ZSBub3J0aCBwb2xlKSwgaXRzIGdsb2JhbCBwaXhlbCBwb3NpdGlvbiBhbmQgaXRzIHNhbXBsZXNcbiAqIGFsb25nIHRydWUgZWFzdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRyZWtDb29yZHMoZnA6IEZvb3RwcmludCwgZGlzcGxheUxldmVsOiBudW1iZXIsIHRvcDogbnVtYmVyKSB7XG4gIGNvbnN0IGt4OiBudW1iZXJbXSA9IFtdLCBreTogbnVtYmVyW10gPSBbXSwgc2NhbGU6IG51bWJlcltdID0gW10sIHdpZHRoOiBudW1iZXJbXSA9IFtdO1xuICBmb3IgKGxldCB6ID0gMDsgeiA8PSB0b3A7IHorKykge1xuICAgIHdpZHRoLnB1c2goVElMRSAqIDIgKiogKHogKyAxKSk7XG4gICAga3gucHVzaCgoVElMRSAqIDIgKiogKHogKyAxKSkgLyAoMiAqIE1hdGguUEkpKTtcbiAgICBreS5wdXNoKChUSUxFICogMiAqKiB6KSAvIE1hdGguUEkpO1xuICAgIHNjYWxlLnB1c2goMiAqKiAoeiAtIGRpc3BsYXlMZXZlbCkpO1xuICB9XG4gIGNvbnN0IHsgYSwgYiwgdSwgdiwgY292LCB3MCwgY29hcnNlciwgbHZsLCB0YXBzLCBzdGVwIH0gPSBmcDtcbiAgZm9yIChsZXQgcCA9IDA7IHAgPCBOMjsgcCsrKSB7XG4gICAgaWYgKGNvdltwXSA8PSAwKSBjb250aW51ZTtcbiAgICBjb25zdCB6ID0gY2xhbXAoZGlzcGxheUxldmVsIC0gY29hcnNlcltwXSwgMCwgdG9wKTtcbiAgICBjb25zdCB3ID0gTWF0aC5taW4odzBbcF0gKiBzY2FsZVt6XSwgd2lkdGhbel0pOyAvLyBlYXN0LXdlc3QgZm9vdHByaW50IGluIHNvdXJjZSBwaXhlbHMgKGF0IG1vc3Qgb25jZSBhcm91bmQgdGhlIE1vb24pXG4gICAgY29uc3QgayA9IHcgPiBUQVBfU1BBQ0lORyA/IE1hdGgubWluKE1BWF9UQVBTLCBNYXRoLmNlaWwodyAvIFRBUF9TUEFDSU5HKSkgOiAxO1xuICAgIGx2bFtwXSA9IHo7IHRhcHNbcF0gPSBrOyBzdGVwW3BdID0gayA+IDEgPyB3IC8gayA6IDA7XG4gICAgdVtwXSA9IChiW3BdICsgTWF0aC5QSSkgKiBreFt6XSAtIDAuNTtcbiAgICB2W3BdID0gKE1hdGguUEkgLyAyIC0gYVtwXSkgKiBreVt6XSAtIDAuNTtcbiAgfVxufVxuXG4vKiogTW9vbiBUcmVrIGZvb3RwcmludCBvZiBhIGRpc3BsYXkgdGlsZSB3aXRoIHNvdXJjZSBsZXZlbHMgY2FwcGVkIGF0IGBtYXhaYC4gUmV0dXJucyBmYWxzZSBpZiBub3RoaW5nIGlzIGNvdmVyZWQuICovXG5leHBvcnQgZnVuY3Rpb24gdHJla0Zvb3RwcmludChmcDogRm9vdHByaW50LCByOiBSZWN0LCBkaXNwbGF5TGV2ZWw6IG51bWJlciwgbWF4WjogbnVtYmVyLCBtaW5UcnVlTGF0RGVnOiBudW1iZXIpOiBib29sZWFuIHtcbiAgaWYgKCF0cmVrR2VvbWV0cnkoZnAsIHIsIG1pblRydWVMYXREZWcpKSByZXR1cm4gZmFsc2U7XG4gIHRyZWtDb29yZHMoZnAsIGRpc3BsYXlMZXZlbCwgdHJla1RvcChkaXNwbGF5TGV2ZWwsIG1heFopKTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmNvbnN0IHRyZWtUb3AgPSAoZGlzcGxheUxldmVsOiBudW1iZXIsIG1heFo6IG51bWJlcikgPT4gY2xhbXAoTWF0aC5taW4oZGlzcGxheUxldmVsLCBtYXhaKSwgMCwgTUFYX1RSRUtfTEVWRUwpO1xuXG4vKipcbiAqIERpc3BsYXkgcGl4ZWwgY2VudHJlcyAtPiBzb3V0aC1wb2xhciBtYXAgeC95IChtKS4gSW5zaWRlID0gY2xvc2VyIHRvIHRoZSBwb2xlIHRoYW4gYHJob0NsaXBgXG4gKiBhbmQgaW5zaWRlIHRoZSDCsWhhbGZNIHNxdWFyZS4gV2l0aCBhIGZlYXRoZXIgd2lkZXIgdGhhbiBhIHBpeGVsIHRoZSBlZGdlIGZhZGVzIG92ZXIgYGZlYXRoZXJNYFxuICogbWV0cmVzIChwaG90byBibGVuZGluZyBpbnRvIHRoZSBwaG90byBiZWxvdyk7IG90aGVyd2lzZSBpdCBpcyBhIGNyaXNwLCBhbnRpLWFsaWFzZWQgbGluZVxuICogKHNjaWVuY2UgbWFwcykuIFJldHVybnMgZmFsc2UgaWYgbm90aGluZyBpcyBjb3ZlcmVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcG9sYXJHZW9tZXRyeShmcDogRm9vdHByaW50LCByOiBSZWN0LCByaG9DbGlwOiBudW1iZXIsIGZlYXRoZXJNOiBudW1iZXIsIGhhbGZNOiBudW1iZXIsIG5vcnRoID0gZmFsc2UpOiBib29sZWFuIHtcbiAgY29sdW1ucyhmcCwgcik7XG4gIGZwLmx2bC5maWxsKDApOyBmcC50YXBzLmZpbGwoMSk7IC8vIG9uZSBncmlkLCBvbmUgYmlsaW5lYXIgc2FtcGxlIHBlciBwaXhlbFxuICBjb25zdCBkTGF0ID0gKHIubm9ydGggLSByLnNvdXRoKSAvIFRJTEUsIHB4TSA9IGRMYXQgKiBNT09OX1IsIHNvZnQgPSBmZWF0aGVyTSA+IHB4TTtcbiAgbGV0IGFueSA9IGZhbHNlO1xuICBmb3IgKGxldCBqID0gMDsgaiA8IFRJTEU7IGorKykge1xuICAgIGNvbnN0IGxhdCA9IHIubm9ydGggLSAoaiArIDAuNSkgKiBkTGF0LCBjbCA9IE1hdGguY29zKGxhdCksIFogPSBNYXRoLnNpbihsYXQpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgVElMRTsgaSsrKSB7XG4gICAgICBjb25zdCBwID0gaiAqIFRJTEUgKyBpLCBYID0gY2wgKiBmcC5jb3NMb25baV0sIFkgPSBjbCAqIGZwLnNpbkxvbltpXTtcbiAgICAgIGNvbnN0IGRlbiA9IG5vcnRoID8gMSAtIFkgOiAxICsgWTtcbiAgICAgIGxldCBjID0gMCwgbXggPSAwLCBteSA9IDA7XG4gICAgICBpZiAoZGVuID4gMWUtOSkge1xuICAgICAgICAvLyBzYW1lIGZvcm11bGEgYXMgcG9sYXJNYXBGcm9tRGlzcGxheVVuaXQgaW4gZnJhbWUudHNcbiAgICAgICAgY29uc3QgZiA9ICgyICogTU9PTl9SKSAvIGRlbjtcbiAgICAgICAgbXggPSBmICogWjsgbXkgPSAobm9ydGggPyAtMSA6IDEpICogZiAqIFg7XG4gICAgICAgIGNvbnN0IGluc2lkZSA9IHJob0NsaXAgLSBNYXRoLnNxcnQobXggKiBteCArIG15ICogbXkpO1xuICAgICAgICBjID0gc29mdCA/IHNtb290aChNYXRoLm1pbihpbnNpZGUsIGhhbGZNIC0gTWF0aC5tYXgoTWF0aC5hYnMobXgpLCBNYXRoLmFicyhteSkpKSAvIGZlYXRoZXJNKSA6IGNsYW1wMDEoaW5zaWRlIC8gcHhNICsgMC41KTtcbiAgICAgIH1cbiAgICAgIGZwLmFbcF0gPSBteDsgZnAuYltwXSA9IG15OyBmcC5jb3ZbcF0gPSBjO1xuICAgICAgaWYgKGMgPiAwKSBhbnkgPSB0cnVlO1xuICAgIH1cbiAgfVxuICByZXR1cm4gYW55O1xufVxuXG4vKiogUG9sYXIgbWFwIHgveSAtPiBzb3VyY2UgcGl4ZWwgb2YgYSBwaWN0dXJlIHNwYW5uaW5nIMKxaGFsZk0gKHJvdyAwID0gK3kpLCBzeC9zeSBwaXhlbHMgcGVyIG1ldHJlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBvbGFyQ29vcmRzKGZwOiBGb290cHJpbnQsIGhhbGZNOiBudW1iZXIsIHN4OiBudW1iZXIsIHN5OiBudW1iZXIpIHtcbiAgZm9yIChsZXQgcCA9IDA7IHAgPCBOMjsgcCsrKSB7XG4gICAgZnAudVtwXSA9IChmcC5hW3BdICsgaGFsZk0pICogc3ggLSAwLjU7XG4gICAgZnAudltwXSA9IChoYWxmTSAtIGZwLmJbcF0pICogc3kgLSAwLjU7XG4gIH1cbn1cblxuY29uc3QgcHlyYW1pZENvb3JkcyA9IChmcDogRm9vdHByaW50LCBrOiBudW1iZXIpID0+IHtcbiAgY29uc3QgcyA9IChQWVJBTUlEX1BYICogMiAqKiBrKSAvIFBZUkFNSURfU1BBTl9NO1xuICBwb2xhckNvb3JkcyhmcCwgUFlSQU1JRF9IQUxGX00sIHMsIHMpO1xufTtcblxuLyoqIFNvdXJjZSB0aWxlcyB0b3VjaGVkIGJ5IHRoZSBjb3ZlcmVkIHBpeGVscyAoZXZlcnkgc2FtcGxlIGFuZCBpdHMgYmlsaW5lYXIgbmVpZ2hib3VycyksIG9yIG51bGwgaWYgbW9yZSB0aGFuIGBtYXhgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbGxlY3RUaWxlcyhmcDogRm9vdHByaW50LCBncmlkczogR3JpZFtdLCBtYXg6IG51bWJlcik6IG51bWJlcltdIHwgbnVsbCB7XG4gIGNvbnN0IGtleXM6IG51bWJlcltdID0gW10sIHNlZW4gPSBuZXcgU2V0PG51bWJlcj4oKTtcbiAgY29uc3QgeyB1LCB2LCBjb3YsIGx2bCwgdGFwcywgc3RlcCB9ID0gZnA7XG4gIGxldCBsYXN0ID0gLTE7XG4gIGNvbnN0IGFkZCA9IChrZXk6IG51bWJlcikgPT4ge1xuICAgIGlmIChrZXkgPT09IGxhc3QpIHJldHVybiB0cnVlO1xuICAgIGxhc3QgPSBrZXk7XG4gICAgaWYgKHNlZW4uaGFzKGtleSkpIHJldHVybiB0cnVlO1xuICAgIGlmIChrZXlzLmxlbmd0aCA+PSBtYXgpIHJldHVybiBmYWxzZTtcbiAgICBzZWVuLmFkZChrZXkpO1xuICAgIGtleXMucHVzaChrZXkpO1xuICAgIHJldHVybiB0cnVlO1xuICB9O1xuICBmb3IgKGxldCBwID0gMDsgcCA8IE4yOyBwKyspIHtcbiAgICBpZiAoY292W3BdIDw9IDApIGNvbnRpbnVlO1xuICAgIGNvbnN0IGcgPSBncmlkc1tsdmxbcF1dLCBiYXNlID0gbHZsW3BdICogS0VZX0xFVkVMLCBrID0gdGFwc1twXSwgcyA9IHN0ZXBbcF07XG4gICAgY29uc3QgeyB0aWxlVywgdGlsZUgsIHRpbGVzWCwgd2lkdGgsIGhlaWdodCwgZ2xvYmFsIH0gPSBnO1xuICAgIGNvbnN0IHUwID0gdVtwXSAtIDAuNSAqIChrIC0gMSkgKiBzLCBjMCA9IE1hdGguZmxvb3IodTApLCBjMSA9IE1hdGguZmxvb3IodTAgKyAoayAtIDEpICogcykgKyAxLCByMCA9IE1hdGguZmxvb3IodltwXSk7XG4gICAgaWYgKGMwID49IDAgJiYgcjAgPj0gMCAmJiBjMSA8IHdpZHRoICYmIHIwICsgMSA8IGhlaWdodCkgeyAvLyBmYXN0IHBhdGg6IGV2ZXJ5IHNhbXBsZSdzIDJ4MiBuZWlnaGJvdXJob29kIGluc2lkZSBvbmUgdGlsZVxuICAgICAgY29uc3QgdGkgPSAoYzAgLyB0aWxlVykgfCAwLCB0aiA9IChyMCAvIHRpbGVIKSB8IDA7XG4gICAgICBpZiAoKChjMSAvIHRpbGVXKSB8IDApID09PSB0aSAmJiAoKChyMCArIDEpIC8gdGlsZUgpIHwgMCkgPT09IHRqKSB7IGlmICghYWRkKGJhc2UgKyB0aiAqIHRpbGVzWCArIHRpKSkgcmV0dXJuIG51bGw7IGNvbnRpbnVlOyB9XG4gICAgfVxuICAgIGZvciAobGV0IHQgPSAwOyB0IDwgazsgdCsrKSB7XG4gICAgICBjb25zdCBjdCA9IE1hdGguZmxvb3IodTAgKyB0ICogcyk7XG4gICAgICBmb3IgKGxldCBkeSA9IDA7IGR5IDwgMjsgZHkrKykge1xuICAgICAgICBsZXQgciA9IHIwICsgZHk7XG4gICAgICAgIGlmIChnbG9iYWwpIHIgPSByIDwgMCA/IDAgOiByID49IGhlaWdodCA/IGhlaWdodCAtIDEgOiByO1xuICAgICAgICBlbHNlIGlmIChyIDwgMCB8fCByID49IGhlaWdodCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IHRqID0gKHIgLyB0aWxlSCkgfCAwO1xuICAgICAgICBmb3IgKGxldCBkeCA9IDA7IGR4IDwgMjsgZHgrKykge1xuICAgICAgICAgIGxldCBjID0gY3QgKyBkeDtcbiAgICAgICAgICBpZiAoZ2xvYmFsKSB7IGMgJT0gd2lkdGg7IGlmIChjIDwgMCkgYyArPSB3aWR0aDsgfSBlbHNlIGlmIChjIDwgMCB8fCBjID49IHdpZHRoKSBjb250aW51ZTtcbiAgICAgICAgICBpZiAoIWFkZChiYXNlICsgdGogKiB0aWxlc1ggKyAoKGMgLyB0aWxlVykgfCAwKSkpIHJldHVybiBudWxsO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG4gIHJldHVybiBrZXlzO1xufVxuXG4vLyBSdW5uaW5nIHN1bXMgZm9yIG9uZSBvdXRwdXQgcGl4ZWwgKG1vZHVsZS1sZXZlbCBzbyB0aGUgaG90IGxvb3AgYWxsb2NhdGVzIG5vdGhpbmcpLlxubGV0IHN1bVIgPSAwLCBzdW1HID0gMCwgc3VtQiA9IDAsIHN1bVcgPSAwO1xuXG5mdW5jdGlvbiBhZGRDb3JuZXIoczogU3JjLCBsYzogbnVtYmVyLCBscjogbnVtYmVyLCB3OiBudW1iZXIpIHtcbiAgY29uc3QgZCA9IHMuZGF0YTtcbiAgaWYgKHMuY2ggPT09IDEpIHtcbiAgICBjb25zdCBnID0gZFtsciAqIHMudyArIGxjXSAqIHc7XG4gICAgc3VtUiArPSBnOyBzdW1HICs9IGc7IHN1bUIgKz0gZzsgc3VtVyArPSB3O1xuICB9IGVsc2UgaWYgKHMuY2ggPT09IDMpIHtcbiAgICBjb25zdCBvID0gKGxyICogcy53ICsgbGMpICogMztcbiAgICBzdW1SICs9IGRbb10gKiB3OyBzdW1HICs9IGRbbyArIDFdICogdzsgc3VtQiArPSBkW28gKyAyXSAqIHc7IHN1bVcgKz0gdztcbiAgfSBlbHNlIHtcbiAgICBjb25zdCBvID0gKGxyICogcy53ICsgbGMpICogNCwgd2EgPSAodyAqIGRbbyArIDNdKSAvIDI1NTsgLy8gYWxwaGEtd2VpZ2h0ZWQ6IFwibm8gZGF0YVwiIG5ldmVyIGJsZWVkcyBjb2xvdXJcbiAgICBzdW1SICs9IGRbb10gKiB3YTsgc3VtRyArPSBkW28gKyAxXSAqIHdhOyBzdW1CICs9IGRbbyArIDJdICogd2E7IHN1bVcgKz0gd2E7XG4gIH1cbn1cblxuLyoqXG4gKiBTYW1wbGUgdGhlIHNvdXJjZSB0aWxlcyAoYHNyY3NbcV1gIGJlbG9uZ3MgdG8gYGtleXNbcV1gOyBudWxsID0gbm8gZGF0YSkgaW50byBhIDI1NngyNTYgUkdCQVxuICogdGlsZTogYmlsaW5lYXIsIGF2ZXJhZ2luZyBlYWNoIHBpeGVsJ3Mgc2FtcGxlcyBhbG9uZyB0cnVlIGVhc3QuIEV2ZXJ5IHBpeGVsIHNhbXBsZXMgdGhlIHNhbWVcbiAqIGNvbnRpbnVvdXMgc3VyZmFjZSwgc28gbmVpZ2hib3VyaW5nIGRpc3BsYXkgdGlsZXMgbWVldCB3aXRob3V0IHNlYW1zOyBsb25naXR1ZGUgd3JhcHMgZm9yXG4gKiBnbG9iYWwgbWFwcy4gYGZsaXBSb3dzYCBmYWxzZSB3cml0ZXMgdGhlIHNvdXRoIHJvdyBmaXJzdCwgd2hpY2ggaXMgdGhlIHJvdyBvcmRlciBXZWJHTCB1cGxvYWRzXG4gKiBhbiBJbWFnZUJpdG1hcCBpbiAoQ2VzaXVtJ3Mgb3duIGJpdG1hcHMgYXJlIHByZS1mbGlwcGVkIHRoZSBzYW1lIHdheSkuIFJldHVybnMgbnVsbCB3aGVuIHRoZVxuICogdGlsZSBjYW1lIG91dCBmdWxseSB0cmFuc3BhcmVudC4gYHBvc3RgIChncmV5IHNvdXJjZXMgb25seSkgdHVybnMgZWFjaCBzYW1wbGVkIHZhbHVlIGludG8gdGhlIGdyZXlcbiAqIGRyYXduIGZvciBwaXhlbCBwICh1c2VkIGJ5IHRoZSBzZWFtIGZpeDogaGlsbHNoYWRlIC0+IGFsYmVkbyB4IHNoYWRpbmcpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2FtcGxlVGlsZXMoZnA6IEZvb3RwcmludCwgZ3JpZHM6IEdyaWRbXSwga2V5czogbnVtYmVyW10sIHNyY3M6IChTcmMgfCBudWxsKVtdLCBmbGlwUm93czogYm9vbGVhbiwgcG9zdD86IChwOiBudW1iZXIsIHZhbHVlOiBudW1iZXIpID0+IG51bWJlcik6IFVpbnQ4Q2xhbXBlZEFycmF5PEFycmF5QnVmZmVyPiB8IG51bGwge1xuICBjb25zdCBvdXQgPSBuZXcgVWludDhDbGFtcGVkQXJyYXkoTjIgKiA0KTtcbiAgY29uc3QgeyB1LCB2LCBjb3YsIGx2bCwgdGFwcywgc3RlcCB9ID0gZnA7XG4gIGNvbnN0IGJ5S2V5ID0gbmV3IE1hcDxudW1iZXIsIFNyYyB8IG51bGw+KCk7XG4gIGtleXMuZm9yRWFjaCgoaywgcSkgPT4gYnlLZXkuc2V0KGssIHNyY3NbcV0pKTtcbiAgbGV0IGxhc3RLZXkgPSAtMSwgbGFzdDogU3JjIHwgbnVsbCA9IG51bGwsIGFueSA9IGZhbHNlLCBjbGVhciA9IGZhbHNlO1xuICBjb25zdCB0aWxlQXQgPSAoa2V5OiBudW1iZXIpID0+IHtcbiAgICBpZiAoa2V5ICE9PSBsYXN0S2V5KSB7IGxhc3RLZXkgPSBrZXk7IGxhc3QgPSBieUtleS5nZXQoa2V5KSA/PyBudWxsOyB9XG4gICAgcmV0dXJuIGxhc3Q7XG4gIH07XG4gIGxldCBnID0gZ3JpZHNbMF0sIGJhc2UgPSAwOyAvLyB0aGUgZ3JpZCB0aGUgY3VycmVudCBwaXhlbCByZWFkc1xuICAvLyBHZW5lcmFsIGNhc2UgKDJ4MiBuZWlnaGJvdXJob29kIGNyb3NzZXMgYSB0aWxlIGVkZ2UsIHRoZSAxODDCsCBtZXJpZGlhbiBvciB0aGUgcGljdHVyZSdzIGVkZ2UpLlxuICBjb25zdCBjb3JuZXIgPSAoYzogbnVtYmVyLCByOiBudW1iZXIsIHc6IG51bWJlcikgPT4ge1xuICAgIGlmICh3IDw9IDApIHJldHVybjtcbiAgICBpZiAoZy5nbG9iYWwpIHsgYyAlPSBnLndpZHRoOyBpZiAoYyA8IDApIGMgKz0gZy53aWR0aDsgciA9IHIgPCAwID8gMCA6IHIgPj0gZy5oZWlnaHQgPyBnLmhlaWdodCAtIDEgOiByOyB9XG4gICAgZWxzZSBpZiAoYyA8IDAgfHwgciA8IDAgfHwgYyA+PSBnLndpZHRoIHx8IHIgPj0gZy5oZWlnaHQpIHJldHVybjtcbiAgICBjb25zdCB0eCA9IChjIC8gZy50aWxlVykgfCAwLCB0eSA9IChyIC8gZy50aWxlSCkgfCAwLCBzID0gdGlsZUF0KGJhc2UgKyB0eSAqIGcudGlsZXNYICsgdHgpO1xuICAgIGlmIChzKSBhZGRDb3JuZXIocywgYyAtIHR4ICogZy50aWxlVywgciAtIHR5ICogZy50aWxlSCwgdyk7XG4gIH07XG4gIC8vIE9uZSBiaWxpbmVhciBzYW1wbGUgYXQgc291cmNlIHBpeGVsIChmdSwgZnYpLCBhZGRlZCB0byB0aGUgcnVubmluZyBzdW1zICh3ZWlnaHQgMSBpZiBhbGwgb2YgaXQgaGFzIGRhdGEpLlxuICBjb25zdCB0YXAgPSAoZnU6IG51bWJlciwgZnY6IG51bWJlcikgPT4ge1xuICAgIGNvbnN0IGMwID0gTWF0aC5mbG9vcihmdSksIHIwID0gTWF0aC5mbG9vcihmdiksIHR4ID0gZnUgLSBjMCwgdHkgPSBmdiAtIHIwO1xuICAgIC8vIFF1aWNrIGNhc2U6IHRoaXMgc2FtcGxlJ3MgZm91ciBuZWlnaGJvdXJzIGluc2lkZSBvbmUgb3BhcXVlIHNvdXJjZSB0aWxlLlxuICAgIGlmIChjMCA+PSAwICYmIHIwID49IDAgJiYgYzAgKyAxIDwgZy53aWR0aCAmJiByMCArIDEgPCBnLmhlaWdodCkge1xuICAgICAgY29uc3QgdGkgPSAoYzAgLyBnLnRpbGVXKSB8IDAsIHRqID0gKHIwIC8gZy50aWxlSCkgfCAwLCBsYyA9IGMwIC0gdGkgKiBnLnRpbGVXLCBsciA9IHIwIC0gdGogKiBnLnRpbGVIO1xuICAgICAgaWYgKGxjIDwgZy50aWxlVyAtIDEgJiYgbHIgPCBnLnRpbGVIIC0gMSkge1xuICAgICAgICBjb25zdCBzID0gdGlsZUF0KGJhc2UgKyB0aiAqIGcudGlsZXNYICsgdGkpO1xuICAgICAgICBpZiAoIXMpIHJldHVybjtcbiAgICAgICAgaWYgKHMuY2ggIT09IDQpIHtcbiAgICAgICAgICBjb25zdCBkID0gcy5kYXRhLCBjaCA9IHMuY2gsIGEgPSAobHIgKiBzLncgKyBsYykgKiBjaCwgYiA9IGEgKyBjaCwgYyA9IGEgKyBzLncgKiBjaCwgZSA9IGMgKyBjaDtcbiAgICAgICAgICBjb25zdCB3MDAgPSAoMSAtIHR4KSAqICgxIC0gdHkpLCB3MTAgPSB0eCAqICgxIC0gdHkpLCB3MDEgPSAoMSAtIHR4KSAqIHR5LCB3MTEgPSB0eCAqIHR5O1xuICAgICAgICAgIGNvbnN0IFIgPSBkW2FdICogdzAwICsgZFtiXSAqIHcxMCArIGRbY10gKiB3MDEgKyBkW2VdICogdzExO1xuICAgICAgICAgIGlmIChjaCA9PT0gMSkgeyBzdW1SICs9IFI7IHN1bUcgKz0gUjsgc3VtQiArPSBSOyB9XG4gICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICBzdW1SICs9IFI7XG4gICAgICAgICAgICBzdW1HICs9IGRbYSArIDFdICogdzAwICsgZFtiICsgMV0gKiB3MTAgKyBkW2MgKyAxXSAqIHcwMSArIGRbZSArIDFdICogdzExO1xuICAgICAgICAgICAgc3VtQiArPSBkW2EgKyAyXSAqIHcwMCArIGRbYiArIDJdICogdzEwICsgZFtjICsgMl0gKiB3MDEgKyBkW2UgKyAyXSAqIHcxMTtcbiAgICAgICAgICB9XG4gICAgICAgICAgc3VtVyArPSAxO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICBjb3JuZXIoYzAsIHIwLCAoMSAtIHR4KSAqICgxIC0gdHkpKTtcbiAgICBjb3JuZXIoYzAgKyAxLCByMCwgdHggKiAoMSAtIHR5KSk7XG4gICAgY29ybmVyKGMwLCByMCArIDEsICgxIC0gdHgpICogdHkpO1xuICAgIGNvcm5lcihjMCArIDEsIHIwICsgMSwgdHggKiB0eSk7XG4gIH07XG4gIGZvciAobGV0IGogPSAwOyBqIDwgVElMRTsgaisrKSB7XG4gICAgY29uc3Qgcm93ID0gKGZsaXBSb3dzID8gaiA6IFRJTEUgLSAxIC0gaikgKiBUSUxFO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgVElMRTsgaSsrKSB7XG4gICAgICBjb25zdCBwID0gaiAqIFRJTEUgKyBpLCBjdiA9IGNvdltwXTtcbiAgICAgIGlmIChjdiA8PSAwKSB7IGNsZWFyID0gdHJ1ZTsgY29udGludWU7IH1cbiAgICAgIGcgPSBncmlkc1tsdmxbcF1dOyBiYXNlID0gbHZsW3BdICogS0VZX0xFVkVMO1xuICAgICAgc3VtUiA9IHN1bUcgPSBzdW1CID0gc3VtVyA9IDA7XG4gICAgICBjb25zdCBrID0gdGFwc1twXSwgZnYgPSB2W3BdLCBzID0gayA+IDEgPyBzdGVwW3BdIDogMCwgdTAgPSB1W3BdIC0gMC41ICogKGsgLSAxKSAqIHM7XG4gICAgICBjb25zdCBjMCA9IE1hdGguZmxvb3IodTApLCBjMSA9IE1hdGguZmxvb3IodTAgKyAoayAtIDEpICogcykgKyAxLCByMCA9IE1hdGguZmxvb3IoZnYpO1xuICAgICAgY29uc3QgdGkgPSAoYzAgLyBnLnRpbGVXKSB8IDAsIHRqID0gKHIwIC8gZy50aWxlSCkgfCAwO1xuICAgICAgY29uc3Qgc3JjID0gYzAgPj0gMCAmJiByMCA+PSAwICYmIGMxIDwgZy53aWR0aCAmJiByMCArIDEgPCBnLmhlaWdodCAmJiAoKGMxIC8gZy50aWxlVykgfCAwKSA9PT0gdGkgJiYgKCgocjAgKyAxKSAvIGcudGlsZUgpIHwgMCkgPT09IHRqXG4gICAgICAgID8gdGlsZUF0KGJhc2UgKyB0aiAqIGcudGlsZXNYICsgdGkpIDogdW5kZWZpbmVkO1xuICAgICAgaWYgKHNyYyA9PT0gbnVsbCkgeyBjbGVhciA9IHRydWU7IGNvbnRpbnVlOyB9IC8vIGV2ZXJ5IHNhbXBsZSBsYW5kcyBpbiBvbmUgdGlsZSB0aGF0IGhhcyBubyBkYXRhXG4gICAgICBpZiAoc3JjICYmIHNyYy5jaCAhPT0gNCkge1xuICAgICAgICAvLyBGYXN0IHBhdGggKGFsbW9zdCBldmVyeSBwaXhlbCk6IGFsbCBzYW1wbGVzIGluc2lkZSBvbmUgb3BhcXVlIHRpbGUsIG9uIHRoZSBzYW1lIHR3byBzb3VyY2Ugcm93cy5cbiAgICAgICAgY29uc3QgZCA9IHNyYy5kYXRhLCBjaCA9IHNyYy5jaCwgdHkgPSBmdiAtIHIwLCByYSA9ICgocjAgLSB0aiAqIGcudGlsZUgpICogc3JjLncgLSB0aSAqIGcudGlsZVcpICogY2gsIHJiID0gcmEgKyBzcmMudyAqIGNoO1xuICAgICAgICBmb3IgKGxldCB0ID0gMDsgdCA8IGs7IHQrKykge1xuICAgICAgICAgIGNvbnN0IGZ1ID0gdTAgKyB0ICogcywgYyA9IE1hdGguZmxvb3IoZnUpLCB0eCA9IGZ1IC0gYywgYSA9IHJhICsgYyAqIGNoLCBiID0gcmIgKyBjICogY2g7IC8vIHNhbWUgcG9zaXRpb25zIGNvbGxlY3RUaWxlcyB1c2VkXG4gICAgICAgICAgY29uc3QgdzAwID0gKDEgLSB0eCkgKiAoMSAtIHR5KSwgdzEwID0gdHggKiAoMSAtIHR5KSwgdzAxID0gKDEgLSB0eCkgKiB0eSwgdzExID0gdHggKiB0eTtcbiAgICAgICAgICBjb25zdCBSID0gZFthXSAqIHcwMCArIGRbYSArIGNoXSAqIHcxMCArIGRbYl0gKiB3MDEgKyBkW2IgKyBjaF0gKiB3MTE7XG4gICAgICAgICAgaWYgKGNoID09PSAxKSB7IHN1bVIgKz0gUjsgc3VtRyArPSBSOyBzdW1CICs9IFI7IH1cbiAgICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgIHN1bVIgKz0gUjtcbiAgICAgICAgICAgIHN1bUcgKz0gZFthICsgMV0gKiB3MDAgKyBkW2EgKyA0XSAqIHcxMCArIGRbYiArIDFdICogdzAxICsgZFtiICsgNF0gKiB3MTE7XG4gICAgICAgICAgICBzdW1CICs9IGRbYSArIDJdICogdzAwICsgZFthICsgNV0gKiB3MTAgKyBkW2IgKyAyXSAqIHcwMSArIGRbYiArIDVdICogdzExO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBzdW1XID0gaztcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGZvciAobGV0IHQgPSAwOyB0IDwgazsgdCsrKSB0YXAodTAgKyB0ICogcywgZnYpO1xuICAgICAgfVxuICAgICAgaWYgKHN1bVcgPD0gMWUtNikgeyBjbGVhciA9IHRydWU7IGNvbnRpbnVlOyB9XG4gICAgICBjb25zdCBvID0gKHJvdyArIGkpICogNCwgYWxwaGEgPSAoMjU1ICogY3YgKiBzdW1XKSAvIGs7XG4gICAgICBpZiAocG9zdCkgeyBjb25zdCBnID0gcG9zdChwLCBzdW1SIC8gc3VtVyk7IG91dFtvXSA9IGc7IG91dFtvICsgMV0gPSBnOyBvdXRbbyArIDJdID0gZzsgfVxuICAgICAgZWxzZSB7IG91dFtvXSA9IHN1bVIgLyBzdW1XOyBvdXRbbyArIDFdID0gc3VtRyAvIHN1bVc7IG91dFtvICsgMl0gPSBzdW1CIC8gc3VtVzsgfVxuICAgICAgb3V0W28gKyAzXSA9IGFscGhhO1xuICAgICAgaWYgKGFscGhhIDwgMC41KSBjbGVhciA9IHRydWU7XG4gICAgICBhbnkgPSB0cnVlO1xuICAgIH1cbiAgfVxuICBpZiAoIWFueSkgcmV0dXJuIG51bGw7XG4gIGlmIChjbGVhcikgZmlsbENsZWFyKG91dCk7XG4gIHJldHVybiBvdXQ7XG59XG5cbi8vIFNjcmF0Y2ggZm9yIGZpbGxDbGVhcjogYWxwaGEtd2VpZ2h0ZWQgY29sb3VyIHN1bXMgb2YgdGhlIHRpbGUgYXQgMTI4eDEyOCwgNjR4NjQsIC4uLiAxeDEuXG5jb25zdCBmaWxsTGV2ZWxzOiBGbG9hdDMyQXJyYXlbXSA9IFtdO1xuZm9yIChsZXQgcyA9IFRJTEUgPj4gMTsgcyA+PSAxOyBzID4+PSAxKSBmaWxsTGV2ZWxzLnB1c2gobmV3IEZsb2F0MzJBcnJheShzICogcyAqIDQpKTtcblxuLyoqXG4gKiBHaXZlIGV2ZXJ5IGZ1bGx5IHRyYW5zcGFyZW50IHBpeGVsIHRoZSBjb2xvdXIgb2YgdGhlIGRhdGEgYXJvdW5kIGl0IChpdCBzdGF5cyB0cmFuc3BhcmVudCkuXG4gKiBDZXNpdW0gdXBsb2FkcyB0aWxlcyB3aXRoIHN0cmFpZ2h0IGFscGhhIGFuZCBidWlsZHMgbWlwbWFwcyBmcm9tIHRoZW0sIGFuZCB0aGUgR1BVJ3MgZmlsdGVyc1xuICogYXZlcmFnZSBjb2xvdXJzIHdpdGhvdXQgbG9va2luZyBhdCBhbHBoYTogYmxhY2sgc2VlLXRocm91Z2ggcGl4ZWxzIHdvdWxkIGRhcmtlbiB0aGUgZWRnZXMgb2ZcbiAqIGEgbGF5ZXIgKGFuZCB0aGluIG91dCBzcGFyc2UgbWFwcyB3aGVuIHpvb21lZCBvdXQpLiBFYWNoIGNsZWFyIHBpeGVsIHRha2VzIHRoZSBhdmVyYWdlIGNvbG91clxuICogb2YgdGhlIHNtYWxsZXN0IHNxdWFyZSBhcm91bmQgaXQgKDJ4MiwgNHg0LCAuLi4pIHRoYXQgaG9sZHMgc29tZSBkYXRhLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZmlsbENsZWFyKHB4OiBVaW50OENsYW1wZWRBcnJheSkge1xuICBsZXQgcHJldjogRmxvYXQzMkFycmF5IHwgbnVsbCA9IG51bGwsIHNpemUgPSBUSUxFO1xuICBmb3IgKGNvbnN0IGQgb2YgZmlsbExldmVscykge1xuICAgIGNvbnN0IGggPSBzaXplID4+IDE7XG4gICAgZm9yIChsZXQgeSA9IDA7IHkgPCBoOyB5KyspIHtcbiAgICAgIGZvciAobGV0IHggPSAwOyB4IDwgaDsgeCsrKSB7XG4gICAgICAgIGxldCByID0gMCwgZ2cgPSAwLCBiID0gMCwgdyA9IDA7XG4gICAgICAgIGZvciAobGV0IGR5ID0gMDsgZHkgPCAyOyBkeSsrKSB7XG4gICAgICAgICAgZm9yIChsZXQgZHggPSAwOyBkeCA8IDI7IGR4KyspIHtcbiAgICAgICAgICAgIGlmIChwcmV2KSB7XG4gICAgICAgICAgICAgIGNvbnN0IG8gPSAoKDIgKiB5ICsgZHkpICogc2l6ZSArIDIgKiB4ICsgZHgpICogNDtcbiAgICAgICAgICAgICAgciArPSBwcmV2W29dOyBnZyArPSBwcmV2W28gKyAxXTsgYiArPSBwcmV2W28gKyAyXTsgdyArPSBwcmV2W28gKyAzXTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIGNvbnN0IG8gPSAoKDIgKiB5ICsgZHkpICogVElMRSArIDIgKiB4ICsgZHgpICogNCwgYSA9IHB4W28gKyAzXTtcbiAgICAgICAgICAgICAgciArPSBweFtvXSAqIGE7IGdnICs9IHB4W28gKyAxXSAqIGE7IGIgKz0gcHhbbyArIDJdICogYTsgdyArPSBhO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBjb25zdCBxID0gKHkgKiBoICsgeCkgKiA0O1xuICAgICAgICBkW3FdID0gcjsgZFtxICsgMV0gPSBnZzsgZFtxICsgMl0gPSBiOyBkW3EgKyAzXSA9IHc7XG4gICAgICB9XG4gICAgfVxuICAgIHByZXYgPSBkOyBzaXplID0gaDtcbiAgfVxuICBmb3IgKGxldCBqID0gMDsgaiA8IFRJTEU7IGorKykge1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgVElMRTsgaSsrKSB7XG4gICAgICBjb25zdCBvID0gKGogKiBUSUxFICsgaSkgKiA0O1xuICAgICAgaWYgKHB4W28gKyAzXSAhPT0gMCkgY29udGludWU7XG4gICAgICBmb3IgKGxldCBsID0gMDsgbCA8IGZpbGxMZXZlbHMubGVuZ3RoOyBsKyspIHtcbiAgICAgICAgY29uc3Qgc2ggPSBsICsgMSwgcSA9ICgoaiA+PiBzaCkgKiAoVElMRSA+PiBzaCkgKyAoaSA+PiBzaCkpICogNCwgZCA9IGZpbGxMZXZlbHNbbF0sIHcgPSBkW3EgKyAzXTtcbiAgICAgICAgaWYgKHcgPiAwKSB7IHB4W29dID0gZFtxXSAvIHc7IHB4W28gKyAxXSA9IGRbcSArIDFdIC8gdzsgcHhbbyArIDJdID0gZFtxICsgMl0gLyB3OyBicmVhazsgfVxuICAgICAgfVxuICAgIH1cbiAgfVxufVxuXG4vKiogTW9vbiBUcmVrOiB0aGUgc291cmNlIGxldmVsIG9mIGV2ZXJ5IHBpeGVsIChkaXNwbGF5IGxldmVsLCBjYXBwZWQgYXQgbWF4WiwgY29hcnNlciBuZWFyIHRoZSB0cnVlIG5vcnRoIHBvbGUpIGFuZCB0aGUgdGlsZXMgdG8gZmV0Y2guICovXG5leHBvcnQgZnVuY3Rpb24gcGxhblRyZWsoZnA6IEZvb3RwcmludCwgcjogUmVjdCwgZGlzcGxheUxldmVsOiBudW1iZXIsIG1heFo6IG51bWJlciwgbWluVHJ1ZUxhdERlZzogbnVtYmVyKTogUGxhbiB8IG51bGwge1xuICBpZiAoIXRyZWtGb290cHJpbnQoZnAsIHIsIGRpc3BsYXlMZXZlbCwgbWF4WiwgbWluVHJ1ZUxhdERlZykpIHJldHVybiBudWxsO1xuICBjb25zdCBncmlkczogR3JpZFtdID0gW107XG4gIGZvciAobGV0IHogPSAwOyB6IDw9IHRyZWtUb3AoZGlzcGxheUxldmVsLCBtYXhaKTsgeisrKSBncmlkcy5wdXNoKHRyZWtHcmlkKHopKTtcbiAgY29uc3Qga2V5cyA9IGNvbGxlY3RUaWxlcyhmcCwgZ3JpZHMsIEluZmluaXR5KSA/PyBbXTtcbiAgbGV0IGxldmVsID0gMDtcbiAgZm9yIChjb25zdCBrIG9mIGtleXMpIGxldmVsID0gTWF0aC5tYXgobGV2ZWwsIE1hdGguZmxvb3IoayAvIEtFWV9MRVZFTCkpO1xuICByZXR1cm4geyBsZXZlbCwgZ3JpZHMsIGtleXMgfTtcbn1cblxuLyoqIFNvdXRoIG9mIHRoaXMgdGhlIHBvbGFyIHBob3RvIGxheWVycyBjb3ZlciBldmVyeXRoaW5nIChhcyBmb3IgdGhlIE1vb24gVHJlayBwaG90bydzIG1pblRydWVMYXQpOiB0aGUgZml4IHN0b3BzIHRoZXJlLiAqL1xuZXhwb3J0IGNvbnN0IEZJWF9NSU5fVFJVRV9MQVQgPSAtODEuNTtcblxuLyoqIFNlYW0gZml4IGZvb3RwcmludDogTW9vbiBUcmVrIGdlb21ldHJ5IHdpdGggdGhlIGZpeCB3ZWlnaHQgYXMgY292ZXJhZ2UgKGFscGhhKS4gRmFsc2UgaWYgdGhlIGZpeCBkcmF3cyBub3RoaW5nIGhlcmUuICovXG5leHBvcnQgZnVuY3Rpb24gc3ludGhGb290cHJpbnQoZnA6IEZvb3RwcmludCwgcjogUmVjdCwgZGlzcGxheUxldmVsOiBudW1iZXIsIG1heFo6IG51bWJlcik6IGJvb2xlYW4ge1xuICBpZiAoIXRyZWtHZW9tZXRyeShmcCwgciwgRklYX01JTl9UUlVFX0xBVCkpIHJldHVybiBmYWxzZTtcbiAgbGV0IGFueSA9IGZhbHNlO1xuICBmb3IgKGxldCBwID0gMDsgcCA8IE4yOyBwKyspIHtcbiAgICBpZiAoZnAuY292W3BdIDw9IDApIGNvbnRpbnVlO1xuICAgIGNvbnN0IHcgPSBmaXhXZWlnaHREZWcoZnAuYltwXSAvIERFRyk7XG4gICAgZnAuY292W3BdICo9IHc7XG4gICAgaWYgKHcgPiAwKSBhbnkgPSB0cnVlO1xuICB9XG4gIGlmICghYW55KSByZXR1cm4gZmFsc2U7XG4gIHRyZWtDb29yZHMoZnAsIGRpc3BsYXlMZXZlbCwgdHJla1RvcChkaXNwbGF5TGV2ZWwsIG1heFopKTtcbiAgLy8gTkFTQSdzIGhpbGxzaGFkZSB0aWxlcyBhcmUgZGFyayBhbG9uZyAxODDCsCAoY29tcHV0ZWQgd2l0aG91dCB3cmFwcGluZzsgbWVhc3VyZWQ6IDEgcHggYXQgbGV2ZWxzIDw9IDcsXG4gIC8vIDIgYXQgOCwgNC01IGF0IDkpOiByZWFkIGZyb20ganVzdCBpbnNpZGUgdGhhdCBlZGdlLCBzbyBubyBsaW5lIHNob3dzIGFsb25nIHRoZSAxODDCsCBtZXJpZGlhbi5cbiAgY29uc3QgeyB1LCBjb3YsIGx2bCwgdGFwcywgc3RlcCB9ID0gZnA7XG4gIGZvciAobGV0IHAgPSAwOyBwIDwgTjI7IHArKykge1xuICAgIGlmIChjb3ZbcF0gPD0gMCkgY29udGludWU7XG4gICAgY29uc3QgeiA9IGx2bFtwXSwgd2lkdGggPSBUSUxFICogMiAqKiAoeiArIDEpLCBoYWxmID0gMC41ICogKHRhcHNbcF0gLSAxKSAqIHN0ZXBbcF0sIG0gPSB6ID49IDkgPyA1IDogeiA+PSA4ID8gMyA6IDI7XG4gICAgaWYgKHVbcF0gLSBoYWxmIDwgbSkgdVtwXSA9IE1hdGgubWluKG0gKyBoYWxmLCB3aWR0aCAvIDIpO1xuICAgIGVsc2UgaWYgKHVbcF0gKyBoYWxmID4gd2lkdGggLSAxIC0gbSkgdVtwXSA9IE1hdGgubWF4KHdpZHRoIC0gMSAtIG0gLSBoYWxmLCB3aWR0aCAvIDIpO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG4vKiogU2VhbSBmaXg6IHRoZSBoaWxsc2hhZGUgdGlsZXMgYSB0aWxlIG5lZWRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBsYW5TeW50aChmcDogRm9vdHByaW50LCByOiBSZWN0LCBkaXNwbGF5TGV2ZWw6IG51bWJlciwgbWF4WjogbnVtYmVyKTogUGxhbiB8IG51bGwge1xuICBpZiAoIXN5bnRoRm9vdHByaW50KGZwLCByLCBkaXNwbGF5TGV2ZWwsIG1heFopKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZ3JpZHM6IEdyaWRbXSA9IFtdO1xuICBmb3IgKGxldCB6ID0gMDsgeiA8PSB0cmVrVG9wKGRpc3BsYXlMZXZlbCwgbWF4Wik7IHorKykgZ3JpZHMucHVzaCh0cmVrR3JpZCh6KSk7XG4gIGNvbnN0IGtleXMgPSBjb2xsZWN0VGlsZXMoZnAsIGdyaWRzLCBJbmZpbml0eSkgPz8gW107XG4gIGxldCBsZXZlbCA9IDA7XG4gIGZvciAoY29uc3QgayBvZiBrZXlzKSBsZXZlbCA9IE1hdGgubWF4KGxldmVsLCBNYXRoLmZsb29yKGsgLyBLRVlfTEVWRUwpKTtcbiAgcmV0dXJuIHsgbGV2ZWwsIGdyaWRzLCBrZXlzIH07XG59XG5cbi8qKlxuICogUG9sYXIgcHlyYW1pZDogcHlyYW1pZCBsZXZlbCBmb3IgdGhpcyBkaXNwbGF5IGxldmVsIChuZXZlciBmaW5lciB0aGFuIHRoZSBwaG90b3MgcmVhbGx5IGFyZVxuICogdGhlcmU7IG51bGwgYmVsb3cgYG1pbktgKSBhbmQgdGhlIHNxdWFyZXMgdG8gZmV0Y2guXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwbGFuUHlyYW1pZChmcDogRm9vdHByaW50LCByOiBSZWN0LCBkaXNwbGF5TGV2ZWw6IG51bWJlciwgbWluSzogbnVtYmVyKTogUGxhbiB8IG51bGwge1xuICBjb25zdCBrMCA9IE1hdGgubWluKHB5cmFtaWRMZXZlbEZvcihkaXNwbGF5TGV2ZWwpLCBweXJhbWlkTWF4S0ZvcihyKSk7XG4gIGlmIChrMCA8IG1pbkspIHJldHVybiBudWxsO1xuICBpZiAoIXBvbGFyR2VvbWV0cnkoZnAsIHIsIHBvbGFyUmhvKFBPTEFSX0xJTUlUX0RFRyksIFBPTEFSX0ZFQVRIRVJfTSwgUFlSQU1JRF9IQUxGX00pKSByZXR1cm4gbnVsbDtcbiAgZm9yIChsZXQgayA9IGswOyA7IGstLSkge1xuICAgIHB5cmFtaWRDb29yZHMoZnAsIGspO1xuICAgIGNvbnN0IGdyaWRzID0gW3B5cmFtaWRHcmlkKGspXSwga2V5cyA9IGNvbGxlY3RUaWxlcyhmcCwgZ3JpZHMsIGsgPiBtaW5LID8gTUFYX1BZUkFNSURfVElMRVMgOiBJbmZpbml0eSk7XG4gICAgaWYgKGtleXMpIHJldHVybiB7IGxldmVsOiBrLCBncmlkcywga2V5cyB9O1xuICB9XG59XG5cbi8qKiBSZWNvbXB1dGUgYSBweXJhbWlkIGZvb3RwcmludCAoYWZ0ZXIgd2FpdGluZyBmb3IgZG93bmxvYWRzLCB3aGVuIG90aGVyIHRpbGVzIHVzZWQgdGhlIHNjcmF0Y2gpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHB5cmFtaWRGb290cHJpbnQoZnA6IEZvb3RwcmludCwgcjogUmVjdCwgazogbnVtYmVyKSB7XG4gIHBvbGFyR2VvbWV0cnkoZnAsIHIsIHBvbGFyUmhvKFBPTEFSX0xJTUlUX0RFRyksIFBPTEFSX0ZFQVRIRVJfTSwgUFlSQU1JRF9IQUxGX00pO1xuICBweXJhbWlkQ29vcmRzKGZwLCBrKTtcbn1cblxuLyoqIFBvbGFyIHJhc3RlcjogcGljayB0aGUgY29weSB3aG9zZSBwaXhlbHMgYmVzdCBtYXRjaCB0aGUgZGlzcGxheSBwaXhlbHMgYW5kIG1hcCBldmVyeSBwaXhlbCBvbnRvIGl0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBsYW5SYXN0ZXIoZnA6IEZvb3RwcmludCwgcjogUmVjdCwgcmFzdGVyOiBSYXN0ZXIsIGhhbGZNOiBudW1iZXIsIGNsaXBUcnVlTGF0RGVnOiBudW1iZXIsIGZlYXRoZXJNOiBudW1iZXIpOiB7IGdyaWRzOiBHcmlkW107IHNyYzogU3JjIH0gfCBudWxsIHtcbiAgaWYgKCFwb2xhckdlb21ldHJ5KGZwLCByLCBwb2xhclJobyhjbGlwVHJ1ZUxhdERlZyksIGZlYXRoZXJNLCBoYWxmTSkpIHJldHVybiBudWxsO1xuICBjb25zdCBweE0gPSAoKHIubm9ydGggLSByLnNvdXRoKSAvIFRJTEUpICogTU9PTl9SLCBiYXNlID0gcmFzdGVyLmxldmVsc1swXTtcbiAgY29uc3QgbSA9IGNsYW1wKE1hdGguZmxvb3IoTWF0aC5sb2cyKHB4TSAvICgoMiAqIGhhbGZNKSAvIGJhc2UudykpKSwgMCwgcmFzdGVyLmxldmVscy5sZW5ndGggLSAxKTtcbiAgY29uc3Qgc3JjID0gcmFzdGVyLmxldmVsc1ttXTtcbiAgcG9sYXJDb29yZHMoZnAsIGhhbGZNLCBzcmMudyAvICgyICogaGFsZk0pLCBzcmMuaCAvICgyICogaGFsZk0pKTtcbiAgcmV0dXJuIHsgZ3JpZHM6IFtzaW5nbGVHcmlkKHNyYyldLCBzcmMgfTtcbn1cblxuLyoqIEhhbGYtc2l6ZSBjb3BpZXMgZG93biB0byB+MzIgcHgsIG9yIGBjb3VudGAgb2YgdGhlbSAoYm94IGZpbHRlcjsgY29sb3VyIHdlaWdodGVkIGJ5IGFscGhhIHNvIGVtcHR5IGFyZWFzIGRvbid0IGRhcmtlbiBlZGdlcykuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRNaXBzKGZ1bGw6IFNyYywgY291bnQgPSBJbmZpbml0eSwgcG9sZUF3YXJlID0gZmFsc2UpOiBSYXN0ZXIge1xuICBjb25zdCBsZXZlbHMgPSBbZnVsbF07XG4gIGZvciAobGV0IHMgPSBmdWxsOyBNYXRoLm1pbihzLncsIHMuaCkgPiAzMiAmJiBsZXZlbHMubGVuZ3RoIDw9IGNvdW50OyApIHsgcyA9IHBvbGVBd2FyZSAmJiBzLmNoID09PSAxID8gaGFsdmVQb2xlQXdhcmUocykgOiBoYWx2ZShzKTsgbGV2ZWxzLnB1c2gocyk7IH1cbiAgcmV0dXJuIHsgbGV2ZWxzIH07XG59XG5cbi8qKlxuICogSGFsdmUgYSBncmV5IHdob2xlLU1vb24gZGlzcGxheSBsb24vbGF0IHBpY3R1cmUgc28gZXZlcnkgcGl4ZWwgYXZlcmFnZXMgYSBzcXVhcmUgcGF0Y2ggb24gdGhlIHNwaGVyZS5cbiAqIE5lYXIgdGhlIGRpc3BsYXkgcG9sZXMgKHRydWUgMMKwTiA5MMKwRSAvIDkwwrBXKSBvbmUgcm93IGlzIGEgdGlueSBjaXJjbGU6IGEgcGxhaW4gMngyIGF2ZXJhZ2UgdGhlcmUgYmx1cnNcbiAqIGFsb25nIHRoZSByYWRpdXMgb25seSwgYW5kIHRoZSB6b29tZWQtb3V0IE1vb24gc2hvd3MgcmFkaWFsIHN0cmVha3MuIEhlcmUgZWFjaCBvdXRwdXQgcm93IGF2ZXJhZ2VzXG4gKiAyL2NvcyhsYXQpIHNvdXJjZSBwaXhlbHMgZWFzdC13ZXN0ICh3cmFwcGluZyByb3VuZCB0aGUgTW9vbikuIFNhbWUgcnVsZSBhcyBoYWx2ZV9wb2xlX2F3YXJlIGluIGJhc2VfbW9zYWljLnB5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGFsdmVQb2xlQXdhcmUoczogU3JjKTogU3JjIHtcbiAgY29uc3QgdyA9IHMudyA+PiAxLCBoID0gcy5oID4+IDEsIFcgPSBzLncsIGQgPSBzLmRhdGEsIG91dCA9IG5ldyBVaW50OEFycmF5KHcgKiBoKTtcbiAgY29uc3Qgc3VtID0gbmV3IEZsb2F0NjRBcnJheSgzICogVyArIDEpOyAvLyBwcmVmaXggc3VtcyBvZiB0aGUgcm93IHBhaXIsIHRoZSByb3cgcmVwZWF0ZWQgMyB0aW1lcyAod3JhcHBpbmcpXG4gIGZvciAobGV0IHkgPSAwOyB5IDwgaDsgeSsrKSB7XG4gICAgY29uc3QgcmEgPSAyICogeSAqIFcsIHJiID0gTWF0aC5taW4oMiAqIHkgKyAxLCBzLmggLSAxKSAqIFc7XG4gICAgZm9yIChsZXQgdCA9IDAsIGFjYyA9IDA7IHQgPCAzICogVzsgdCsrKSB7IGNvbnN0IHggPSB0ICUgVzsgYWNjICs9IChkW3JhICsgeF0gKyBkW3JiICsgeF0pICogMC41OyBzdW1bdCArIDFdID0gYWNjOyB9XG4gICAgY29uc3QgbGF0ID0gKDkwIC0gKCh5ICsgMC41KSAqIDE4MCkgLyBoKSAqIERFRywgayA9IE1hdGgubWluKFcsIDIgLyBNYXRoLm1heChNYXRoLmNvcyhsYXQpLCAxZS05KSk7XG4gICAgY29uc3QgYXQgPSAoeDogbnVtYmVyKSA9PiB7IGNvbnN0IGkgPSBNYXRoLmZsb29yKHgpOyByZXR1cm4gc3VtW2ldICsgKHggLSBpKSAqIChzdW1bTWF0aC5taW4oaSArIDEsIDMgKiBXKV0gLSBzdW1baV0pOyB9O1xuICAgIGZvciAobGV0IHggPSAwOyB4IDwgdzsgeCsrKSB7XG4gICAgICBjb25zdCBjID0gVyArIDIgKiB4ICsgMTtcbiAgICAgIG91dFt5ICogdyArIHhdID0gTWF0aC5yb3VuZCgoYXQoYyArIGsgLyAyKSAtIGF0KGMgLSBrIC8gMikpIC8gayk7XG4gICAgfVxuICB9XG4gIHJldHVybiB7IHcsIGgsIGNoOiAxLCBkYXRhOiBvdXQgfTtcbn1cblxuLyoqXG4gKiBDdXQgb25lIGRpc3BsYXkgdGlsZSBzdHJhaWdodCBvdXQgb2YgYSBwaWN0dXJlIHRoYXQgaXMgYWxyZWFkeSBkcmF3biBpbiB0aGUgZGlzcGxheSBmcmFtZVxuICogKHRoZSBsb2NhbCB3aG9sZS1Nb29uIHBpY3R1cmUpOiB0aGUgMjU2eDI1NiBwaXhlbHMgd2hvc2UgdG9wLWxlZnQgY29ybmVyIGlzIChweCwgcHkpLiBOb1xuICogcmUtcHJvamVjdGlvbiwgc28gdGhpcyBjb3N0cyBhbG1vc3Qgbm90aGluZy4gTnVsbCBpZiB0aGUgdGlsZSBpcyBub3QgaW5zaWRlIHRoZSBwaWN0dXJlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY3V0VGlsZShzcmM6IFNyYywgcHg6IG51bWJlciwgcHk6IG51bWJlciwgZmxpcFJvd3M6IGJvb2xlYW4pOiBVaW50OENsYW1wZWRBcnJheTxBcnJheUJ1ZmZlcj4gfCBudWxsIHtcbiAgaWYgKHB4IDwgMCB8fCBweSA8IDAgfHwgcHggKyBUSUxFID4gc3JjLncgfHwgcHkgKyBUSUxFID4gc3JjLmggfHwgc3JjLmNoID09PSA0KSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgb3V0ID0gbmV3IFVpbnQ4Q2xhbXBlZEFycmF5KE4yICogNCksIGQgPSBzcmMuZGF0YSwgY2ggPSBzcmMuY2g7XG4gIGZvciAobGV0IGogPSAwOyBqIDwgVElMRTsgaisrKSB7XG4gICAgbGV0IG8gPSAoZmxpcFJvd3MgPyBqIDogVElMRSAtIDEgLSBqKSAqIFRJTEUgKiA0LCBxID0gKChweSArIGopICogc3JjLncgKyBweCkgKiBjaDtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IFRJTEU7IGkrKywgbyArPSA0LCBxICs9IGNoKSB7XG4gICAgICBvdXRbb10gPSBkW3FdOyBvdXRbbyArIDFdID0gY2ggPT09IDEgPyBkW3FdIDogZFtxICsgMV07IG91dFtvICsgMl0gPSBjaCA9PT0gMSA/IGRbcV0gOiBkW3EgKyAyXTsgb3V0W28gKyAzXSA9IDI1NTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZnVuY3Rpb24gaGFsdmUoczogU3JjKTogU3JjIHtcbiAgY29uc3QgdyA9IE1hdGgubWF4KDEsIHMudyA+PiAxKSwgaCA9IE1hdGgubWF4KDEsIHMuaCA+PiAxKSwgY2ggPSBzLmNoLCBkID0gcy5kYXRhLCBzdyA9IHMudztcbiAgY29uc3Qgb3V0ID0gbmV3IFVpbnQ4QXJyYXkodyAqIGggKiBjaCk7XG4gIGZvciAobGV0IHkgPSAwOyB5IDwgaDsgeSsrKSB7XG4gICAgY29uc3QgcmEgPSBNYXRoLm1pbigyICogeSwgcy5oIC0gMSkgKiBzdywgcmIgPSBNYXRoLm1pbigyICogeSArIDEsIHMuaCAtIDEpICogc3c7XG4gICAgZm9yIChsZXQgeCA9IDA7IHggPCB3OyB4KyspIHtcbiAgICAgIGNvbnN0IGNhID0gTWF0aC5taW4oMiAqIHgsIHN3IC0gMSksIGNiID0gTWF0aC5taW4oMiAqIHggKyAxLCBzdyAtIDEpO1xuICAgICAgY29uc3QgcDAgPSAocmEgKyBjYSkgKiBjaCwgcDEgPSAocmEgKyBjYikgKiBjaCwgcDIgPSAocmIgKyBjYSkgKiBjaCwgcDMgPSAocmIgKyBjYikgKiBjaCwgbyA9ICh5ICogdyArIHgpICogY2g7XG4gICAgICBpZiAoY2ggPT09IDQpIHtcbiAgICAgICAgY29uc3QgYTAgPSBkW3AwICsgM10sIGExID0gZFtwMSArIDNdLCBhMiA9IGRbcDIgKyAzXSwgYTMgPSBkW3AzICsgM10sIEEgPSBhMCArIGExICsgYTIgKyBhMztcbiAgICAgICAgZm9yIChsZXQgcSA9IDA7IHEgPCAzOyBxKyspIG91dFtvICsgcV0gPSBBID4gMCA/IE1hdGgucm91bmQoKGRbcDAgKyBxXSAqIGEwICsgZFtwMSArIHFdICogYTEgKyBkW3AyICsgcV0gKiBhMiArIGRbcDMgKyBxXSAqIGEzKSAvIEEpIDogMDtcbiAgICAgICAgb3V0W28gKyAzXSA9IChBICsgMikgPj4gMjtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGZvciAobGV0IHEgPSAwOyBxIDwgY2g7IHErKykgb3V0W28gKyBxXSA9IChkW3AwICsgcV0gKyBkW3AxICsgcV0gKyBkW3AyICsgcV0gKyBkW3AzICsgcV0gKyAyKSA+PiAyO1xuICAgICAgfVxuICAgIH1cbiAgfVxuICByZXR1cm4geyB3LCBoLCBjaCwgZGF0YTogb3V0IH07XG59XG5cbi8qKlxuICogU3RvcmVzIFJHQkEgcGl4ZWxzIChhcnJpdmluZyBzdHJpcCBieSBzdHJpcCkgYXMgY29tcGFjdGx5IGFzIHRoZXkgYWxsb3c6IGdyZXkgaWYgZXZlcnkgcGl4ZWwgaXNcbiAqIGdyZXkgYW5kIG9wYXF1ZSAodGhlIHBob3RvczogMSBieXRlIHBlciBwaXhlbCksIFJHQiBpZiBvcGFxdWUsIGVsc2UgUkdCQS5cbiAqL1xuZXhwb3J0IGNsYXNzIFBhY2tlciB7XG4gIGNoOiAxIHwgMyB8IDQgPSAxO1xuICBkYXRhOiBVaW50OEFycmF5O1xuICBwcml2YXRlIHJlYWRvbmx5IHc6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBoOiBudW1iZXI7XG4gIGNvbnN0cnVjdG9yKHc6IG51bWJlciwgaDogbnVtYmVyKSB7IHRoaXMudyA9IHc7IHRoaXMuaCA9IGg7IHRoaXMuZGF0YSA9IG5ldyBVaW50OEFycmF5KHcgKiBoKTsgfVxuXG4gIC8qKiBBZGQgUkdCQSBwaXhlbHMgYHB4YCB0aGF0IHN0YXJ0IGF0IHBpeGVsIGluZGV4IGBhdGAuICovXG4gIGFkZChweDogVWludDhDbGFtcGVkQXJyYXksIGF0OiBudW1iZXIpIHtcbiAgICBmb3IgKGxldCBxID0gMDsgcSA8IHB4Lmxlbmd0aDsgcSArPSA0LCBhdCsrKSB7XG4gICAgICBjb25zdCBSID0gcHhbcV0sIEcgPSBweFtxICsgMV0sIEIgPSBweFtxICsgMl0sIEEgPSBweFtxICsgM107XG4gICAgICBpZiAodGhpcy5jaCA9PT0gMSkge1xuICAgICAgICBpZiAoQSA9PT0gMjU1ICYmIFIgPT09IEcgJiYgRyA9PT0gQikgeyB0aGlzLmRhdGFbYXRdID0gUjsgY29udGludWU7IH1cbiAgICAgICAgdGhpcy53aWRlbihBID09PSAyNTUgPyAzIDogNCwgYXQpO1xuICAgICAgfVxuICAgICAgaWYgKHRoaXMuY2ggPT09IDMpIHtcbiAgICAgICAgaWYgKEEgPT09IDI1NSkgeyBjb25zdCBvID0gYXQgKiAzOyB0aGlzLmRhdGFbb10gPSBSOyB0aGlzLmRhdGFbbyArIDFdID0gRzsgdGhpcy5kYXRhW28gKyAyXSA9IEI7IGNvbnRpbnVlOyB9XG4gICAgICAgIHRoaXMud2lkZW4oNCwgYXQpO1xuICAgICAgfVxuICAgICAgY29uc3QgbyA9IGF0ICogNCwgZCA9IHRoaXMuZGF0YTtcbiAgICAgIGRbb10gPSBSOyBkW28gKyAxXSA9IEc7IGRbbyArIDJdID0gQjsgZFtvICsgM10gPSBBO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBUaGUgZmlyc3QgY29sb3VyIG9yIHNlZS10aHJvdWdoIHBpeGVsOiByZS1zdG9yZSB0aGUgYGZpbGxlZGAgcGl4ZWxzIHNvIGZhciB3aXRoIG1vcmUgY2hhbm5lbHMuICovXG4gIHByaXZhdGUgd2lkZW4odG86IDMgfCA0LCBmaWxsZWQ6IG51bWJlcikge1xuICAgIGNvbnN0IGZyb20gPSB0aGlzLmNoLCBvbGQgPSB0aGlzLmRhdGEsIG5kID0gbmV3IFVpbnQ4QXJyYXkodGhpcy53ICogdGhpcy5oICogdG8pO1xuICAgIGZvciAobGV0IHEgPSAwOyBxIDwgZmlsbGVkOyBxKyspIHtcbiAgICAgIGNvbnN0IHMgPSBxICogZnJvbSwgbyA9IHEgKiB0bztcbiAgICAgIG5kW29dID0gb2xkW3NdOyBuZFtvICsgMV0gPSBvbGRbZnJvbSA9PT0gMSA/IHMgOiBzICsgMV07IG5kW28gKyAyXSA9IG9sZFtmcm9tID09PSAxID8gcyA6IHMgKyAyXTtcbiAgICAgIGlmICh0byA9PT0gNCkgbmRbbyArIDNdID0gZnJvbSA9PT0gNCA/IG9sZFtzICsgM10gOiAyNTU7XG4gICAgfVxuICAgIHRoaXMuZGF0YSA9IG5kO1xuICAgIHRoaXMuY2ggPSB0bztcbiAgfVxuXG4gIHJlc3VsdCgpOiBTcmMgeyByZXR1cm4geyB3OiB0aGlzLncsIGg6IHRoaXMuaCwgY2g6IHRoaXMuY2gsIGRhdGE6IHRoaXMuZGF0YSB9OyB9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gTWVzc2FnZXMgYmV0d2VlbiB0aGUgbWFpbiB0aHJlYWQgKGltYWdlcnkudHMpIGFuZCB0aGUgd29ya2VyLlxuXG4vKiogT25lIHBpY3R1cmUgb2YgdGhlIGxvY2FsIHdob2xlLU1vb24gc2V0OiBjdXQgdGhlIHRpbGUgYXQgcGl4ZWwgKHB4LCBweSkgb3V0IG9mIGl0cyBjb3B5IGBtaXBgIHRpbWVzIGhhbHZlZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQmFzZUN1dCB7IHVybDogc3RyaW5nOyBtaXA6IG51bWJlcjsgcHg6IG51bWJlcjsgcHk6IG51bWJlcjsgbWlwczogbnVtYmVyOyBwb2xlQXdhcmU/OiBib29sZWFuIH1cblxuZXhwb3J0IHR5cGUgSm9iID1cbiAgfCB7IGtpbmQ6ICdwaG90byc7IHJlY3Q6IFJlY3Q7IGxldmVsOiBudW1iZXI7IGxheWVyOiBzdHJpbmc7IG1pblRydWVMYXQ6IG51bWJlcjsgZml4PzogRml4UGFyYW1zOyBub3J0aEJhc2U/OiB7IGN1dDogQmFzZUN1dDsgcmVjdDogUmVjdCB9IH1cbiAgfCB7IGtpbmQ6ICd0cmVrJzsgcmVjdDogUmVjdDsgbGV2ZWw6IG51bWJlcjsgbGF5ZXI6IHN0cmluZzsgZXh0OiBzdHJpbmc7IG1heFNvdXJjZUxldmVsOiBudW1iZXI7IG1pblRydWVMYXQ6IG51bWJlciB9XG4gIHwgeyBraW5kOiAncmFzdGVyJzsgcmVjdDogUmVjdDsgbGV2ZWw6IG51bWJlcjsgdXJsOiBzdHJpbmc7IGV4dGVudE06IG51bWJlcjsgY2xpcFRydWVMYXQ6IG51bWJlcjsgZmVhdGhlck06IG51bWJlciB9XG4gIHwgeyBraW5kOiAnc2NpZW5jZSc7IHJlY3Q6IFJlY3Q7IGxldmVsOiBudW1iZXI7IHNvdXJjZXM6IFNjaWVuY2VSYXN0ZXJTb3VyY2VbXSB9XG4gIC8qKiBsb2NhbCA9IGZvbGRlciBvZiB0aGUgc3RvcmVkIHNxdWFyZXMgKHdpdGggaXRzIGluZGV4Lmpzb24pLCBvciBudWxsL3VuZGVmaW5lZCB0byBhbHdheXMgYXNrIHRoZSByZW1vdGUgc2VydmVyLiAqL1xuICB8IHsga2luZDogJ3B5cmFtaWQnOyByZWN0OiBSZWN0OyBsZXZlbDogbnVtYmVyOyBsYXllcnM6IHN0cmluZzsgbWluSzogbnVtYmVyOyBsb2NhbD86IHN0cmluZyB8IG51bGwgfVxuICAvKiogcXVpY2sgPSBhIHNtYWxsIHBpY3R1cmUgdGhhdCBjYW4gc3RhbmQgaW4gd2hpbGUgdGhlIGJpZyBvbmUgaXMgc3RpbGwgYmVpbmcgZGVjb2RlZCAoc2FtZSBwaXhlbHMgYXQgdGhpcyBsZXZlbCkuICovXG4gIHwgeyBraW5kOiAnYmFzZSc7IHJlY3Q6IFJlY3Q7IGxldmVsOiBudW1iZXI7IGN1dDogQmFzZUN1dDsgcXVpY2s/OiBCYXNlQ3V0IH1cbiAgLyoqIFRoZSBzZWFtIGZpeDogYWxiZWRvIHggaGlsbHNoYWRlIHdoZXJlIHRoZSBXQUMgbW9zYWljIGlzIGxpdCBmcm9tIHRoZSBlYXN0IChzZWUgZml4V2VpZ2h0RGVnKS4gKi9cbiAgfCB7IGtpbmQ6ICdzeW50aCc7IHJlY3Q6IFJlY3Q7IGxldmVsOiBudW1iZXI7IGZpeDogRml4UGFyYW1zIH07XG5cbi8qKlxuICogQSB0aWxlIHRvIGRyYXc7IG9yICh3aGVuIHRoZSBicm93c2VyIGlzIGJhY2sgb25saW5lKSBcInRyeSBldmVyeSBmYWlsZWQgZG93bmxvYWQgYWdhaW5cIjsgb3JcbiAqIHRoZSBsaXN0IG9mIHB5cmFtaWQgc3F1YXJlcyBzdG9yZWQgd2l0aCB0aGUgYXBwIChzZW50IG9uY2UsIGJlZm9yZSB0aGUgZmlyc3QgcHlyYW1pZCBqb2IpLlxuICovXG5leHBvcnQgdHlwZSBUb1dvcmtlciA9IHsgaWQ6IG51bWJlcjsgam9iOiBKb2I7IGZsaXBSb3dzOiBib29sZWFuIH0gfCB7IGNhbmNlbDogbnVtYmVyIH0gfCB7IGNhY2hlQnVkZ2V0Qnl0ZXM6IG51bWJlciB9IHwgeyBwaG90b1ZpZXc6IHsgbG9uOiBudW1iZXI7IGxhdDogbnVtYmVyOyBsZXZlbDogbnVtYmVyIH0gfSB8IHsgZm9yZ2V0RmFpbHVyZXM6IHRydWUgfSB8IHsgcHlyYW1pZEluZGV4OiB1bmtub3duOyBiYXNlOiBzdHJpbmcgfSB8IHsgd2FybVJhc3RlcnM6IHN0cmluZ1tdIH0gfCB7IHdhcm1TY2llbmNlOiBTY2llbmNlUmFzdGVyU291cmNlW107IHdhcm1JZDogbnVtYmVyIH0gfCB7IHNjaWVuY2VWYWx1ZTogeyBzb3VyY2U6IFNjaWVuY2VSYXN0ZXJTb3VyY2U7IGxhdDogbnVtYmVyOyBsb246IG51bWJlciB9OyB2YWx1ZUlkOiBudW1iZXIgfTtcbi8qKlxuICogQSBmaW5pc2hlZCB0aWxlLiBnYXBzID0gaXQgY291bGQgbm90IGJlIGRyYXduIGluIGZ1bGwgYmVjYXVzZSBhIGRvd25sb2FkIGZhaWxlZCBmb3Igbm93ICh3b3J0aFxuICogYXNraW5nIGZvciBhZ2FpbiBsYXRlcik7IHJlY292ZXJlZCA9IGEgc2VydmVyIHRoYXQgd2FzIGZhaWxpbmcgYW5zd2VycyBhZ2FpbjsgcGFyZW50ID0gZHJhd1xuICogbm90aGluZyBuZXcgaGVyZSwga2VlcCBzaG93aW5nIHRoZSBwYXJlbnQgdGlsZSAodGhlIGRhdGEgaGFzIG5vIGZpbmVyIGRldGFpbCwgb3IgaXQgY291bGQgbm90XG4gKiBiZSBkb3dubG9hZGVkKTsgbmV0ID0gdGhpcyB3b3JrZXIncyBkb3dubG9hZCBjb3VudHMgc28gZmFyIFtsb2NhbCBmaWxlcywgcmVtb3RlLCBmYWlsZWRdLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEZyb21Xb3JrZXIgeyBpZDogbnVtYmVyOyBiaXRtYXA6IEltYWdlQml0bWFwIHwgbnVsbDsgZ2FwczogYm9vbGVhbjsgcmVjb3ZlcmVkOiBib29sZWFuOyBwYXJlbnQ/OiBib29sZWFuOyBuZXQ/OiBbbnVtYmVyLCBudW1iZXIsIG51bWJlcl07IHRyYWZmaWM/OiBSZWNvcmQ8c3RyaW5nLCB7IHJlcXVlc3RzOiBudW1iZXI7IGJ5dGVzOiBudW1iZXIgfT47IGNhY2hlPzogRGVjb2RlZENhY2hlU3RhdHM7IHdhcm1lZD86IG51bWJlcjsgd2FybUZyYWM/OiBudW1iZXI7IHdhcm1Paz86IGJvb2xlYW47IHZhbHVlSWQ/OiBudW1iZXI7IHZhbHVlPzogbnVtYmVyIHwgbnVsbCB9XG5cbnR5cGUgRGVjb2RlZEtpbmQgPSAndGlsZScgfCAnYmFzZScgfCAncmFzdGVyJyB8ICdtYXNrJztcbmV4cG9ydCBpbnRlcmZhY2UgRGVjb2RlZENhY2hlU3RhdHMge1xuICBidWRnZXRCeXRlczogbnVtYmVyOyByZXRhaW5lZEJ5dGVzOiBudW1iZXI7IHJldGFpbmVkQ291bnQ6IG51bWJlcjtcbiAgYnl0ZXNCeUtpbmQ6IFJlY29yZDxEZWNvZGVkS2luZCwgbnVtYmVyPjsgY291bnRCeUtpbmQ6IFJlY29yZDxEZWNvZGVkS2luZCwgbnVtYmVyPjtcbiAgZXZpY3Rpb25zOiBudW1iZXI7IGRlY29kZXNBY3RpdmU6IG51bWJlcjsgZGVjb2Rlc1F1ZXVlZDogbnVtYmVyOyBjYW52YXNCeXRlczogbnVtYmVyO1xufVxuXG4vKiogQWZ0ZXIgYSBmYWlsZWQgZG93bmxvYWQsIHdhaXQgdGhpcyBsb25nIGJlZm9yZSBhc2tpbmcgdGhhdCBzZXJ2ZXIgZm9yIHRoZSBzYW1lIHBpY3R1cmUgYWdhaW4gKHVubGVzcyBpdCByZWNvdmVycyBzb29uZXIpLiAqL1xuZXhwb3J0IGNvbnN0IFJFVFJZX01TID0gMjBfMDAwO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFRoZSB3b3JrZXI6IGRvd25sb2FkcywgZGVjb2RpbmcsIGNhY2hlcyBhbmQgdGhlIG1lc3NhZ2UgbG9vcC4gT25seSBydW5zIGluc2lkZSBhIFdlYiBXb3JrZXIuXG5cbmNvbnN0IE5FVF9MSU1JVCA9IDg7IC8vIGRvd25sb2FkcyBhdCBvbmNlIHBlciB3b3JrZXJcbi8vIEJyb3dzZXJzIG9wZW4gYXQgbW9zdCA2IGNvbm5lY3Rpb25zIHBlciBzZXJ2ZXIgb3ZlciBIVFRQLzEuMSAod2hpY2ggTW9vbiBUcmVrIHVzZXMpOyBtb3JlXG4vLyByZXF1ZXN0cyB3b3VsZCBvbmx5IHF1ZXVlIGluc2lkZSB0aGUgYnJvd3NlciB3aGlsZSBvdXIgdGltZW91dCB0aWNrcy4gQWxsIE1vb24gVHJlayBsYXllcnNcbi8vIGxpdmUgb24gb25lIHdvcmtlciAoaW1hZ2VyeS50cyksIHNvIHRoaXMgbGltaXQgY292ZXJzIGFsbCBvZiB0cmVrLm5hc2EuZ292LlxuY29uc3QgSE9TVF9MSU1JVCA9IDY7XG5jb25zdCBMT0NBTF9MSU1JVCA9IDE2OyAvLyBmaWxlcyBzdG9yZWQgd2l0aCB0aGUgYXBwOiBmYXN0LCBhbmQgbmV2ZXIgaGVsZCBiYWNrIGJlaGluZCByZW1vdGUgZG93bmxvYWRzXG5jb25zdCBGRVRDSF9USU1FT1VUX01TID0gMjBfMDAwO1xuLy8gQSBzZXJ2ZXIgdGhhdCBmYWlsZWQgdGhpcyBtYW55IHRpbWVzIGluIGEgcm93IGlzIHRyZWF0ZWQgYXMgZG93bjogb25lIGRvd25sb2FkIGF0IGEgdGltZSB0aGVuXG4vLyBjaGVja3Mgd2hldGhlciBpdCBpcyBiYWNrIGFuZCB0aGUgb3RoZXJzIHdhaXQgZm9yIGl0cyBhbnN3ZXIgaW5zdGVhZCBvZiBlYWNoIHJ1bm5pbmcgaW50byBpdHNcbi8vIG93biAyMCBzIHRpbWVvdXQuIFNvIGEgZGVhZCBzZXJ2ZXIgY29zdHMgb25lIHRpbWVvdXQgcGVyIHJvdW5kIG9mIHRpbGVzLCBub3Qgb25lIHBlciBwaWN0dXJlLlxuY29uc3QgQlJFQUtFUl9BRlRFUiA9IDQ7XG5jb25zdCBUSUxFX0NBQ0hFX0JZVEVTID0gNDggKiAyICoqIDIwOyAvLyBkZWNvZGVkIHNvdXJjZSB0aWxlcyBrZXB0IHBlciB3b3JrZXIgKHR3byBzdWNoIHdvcmtlcnMpXG5cbi8vIEV2ZXJ5IHJldGFpbmVkIHNvdXJjZSBpbWFnZSBzaGFyZXMgdGhpcyB3b3JrZXIncyBvbmUgYnVkZ2V0LCBpbmNsdWRpbmcgd2hvbGUtTW9vbiBwaWN0dXJlcyxcbi8vIHBvbGFyIHJhc3RlcnMsIGRvd25sb2FkZWQgc3F1YXJlcyBhbmQgbWFza3MuIFRoZSBtYWluIHRocmVhZCBhc3NpZ25zIGEgbGFyZ2VyIHNoYXJlIHRvIHRoZVxuLy8gcmFzdGVyIHdvcmtlci4gUGljdHVyZXMgc3RpbGwgYmVpbmcgc2FtcGxlZCBhcmUgdGVtcG9yYXJ5IGpvYiBtZW1vcnksIG5vdCByZXRhaW5lZCBjYWNoZS5cbmxldCBkZWNvZGVkQnVkZ2V0Qnl0ZXMgPSA2NCAqIDIgKiogMjAsIGRlY29kZWRCeXRlcyA9IDAsIGRlY29kZWRFdmljdGlvbnMgPSAwO1xubGV0IGRlY29kZXNBY3RpdmUgPSAwLCBkZWNvZGVzUXVldWVkID0gMDtcbmNvbnN0IGRlY29kZWQgPSBuZXcgTWFwPHN0cmluZywgeyBieXRlczogbnVtYmVyOyBraW5kOiBEZWNvZGVkS2luZDsgZXZpY3Q6ICgpID0+IHZvaWQgfT4oKTtcblxuZnVuY3Rpb24gdHJpbURlY29kZWQoKSB7XG4gIHdoaWxlIChkZWNvZGVkQnl0ZXMgPiBkZWNvZGVkQnVkZ2V0Qnl0ZXMgJiYgZGVjb2RlZC5zaXplKSB7XG4gICAgY29uc3QgW2tleSwgZW50cnldID0gZGVjb2RlZC5lbnRyaWVzKCkubmV4dCgpLnZhbHVlITtcbiAgICBkZWNvZGVkLmRlbGV0ZShrZXkpOyBkZWNvZGVkQnl0ZXMgLT0gZW50cnkuYnl0ZXM7IGRlY29kZWRFdmljdGlvbnMrKztcbiAgICBlbnRyeS5ldmljdCgpO1xuICB9XG59XG5cbi8qKiBSZWdpc3RlciBBRlRFUiBzdG9yaW5nIGFuIGltYWdlLiBJdHMgY2FsbGJhY2sgbXVzdCByZW1vdmUgdGhlIGFjdHVhbCBjYWNoZWQgcmVmZXJlbmNlIHRvby4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlckRlY29kZWQoa2V5OiBzdHJpbmcsIGJ5dGVzOiBudW1iZXIsIGV2aWN0OiAoKSA9PiB2b2lkLCBraW5kOiBEZWNvZGVkS2luZCA9ICdtYXNrJyk6IHZvaWQge1xuICB1bnJlZ2lzdGVyRGVjb2RlZChrZXkpO1xuICBjb25zdCBzaXplID0gTnVtYmVyLmlzRmluaXRlKGJ5dGVzKSA/IE1hdGgubWF4KDAsIGJ5dGVzKSA6IDA7XG4gIGRlY29kZWQuc2V0KGtleSwgeyBieXRlczogc2l6ZSwga2luZCwgZXZpY3QgfSk7XG4gIGRlY29kZWRCeXRlcyArPSBzaXplO1xuICB0cmltRGVjb2RlZCgpO1xufVxuXG4vKiogTWFyayBhIGNhY2hlZCBpbWFnZSBhcyB1c2VkOyBmYWxzZSBtZWFucyBpdCBoYXMgYWxyZWFkeSBiZWVuIGV2aWN0ZWQuICovXG5leHBvcnQgZnVuY3Rpb24gdG91Y2hEZWNvZGVkKGtleTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGVudHJ5ID0gZGVjb2RlZC5nZXQoa2V5KTtcbiAgaWYgKCFlbnRyeSkgcmV0dXJuIGZhbHNlO1xuICBkZWNvZGVkLmRlbGV0ZShrZXkpOyBkZWNvZGVkLnNldChrZXksIGVudHJ5KTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8qKiBBIGNhbGxlciByZW1vdmVkIGFuIGltYWdlIGl0c2VsZiwgZm9yIGV4YW1wbGUgd2hlbiByZXBsYWNpbmcgYSBwcm9jZXNzZWQgbWFzay4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1bnJlZ2lzdGVyRGVjb2RlZChrZXk6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBlbnRyeSA9IGRlY29kZWQuZ2V0KGtleSk7XG4gIGlmIChlbnRyeSkgeyBkZWNvZGVkLmRlbGV0ZShrZXkpOyBkZWNvZGVkQnl0ZXMgLT0gZW50cnkuYnl0ZXM7IH1cbn1cblxuZnVuY3Rpb24gZGVjb2RlZENhY2hlU3RhdHMoKTogRGVjb2RlZENhY2hlU3RhdHMge1xuICBjb25zdCBieXRlc0J5S2luZCA9IHsgdGlsZTogMCwgYmFzZTogMCwgcmFzdGVyOiAwLCBtYXNrOiAwIH0sIGNvdW50QnlLaW5kID0geyAuLi5ieXRlc0J5S2luZCB9O1xuICBmb3IgKGNvbnN0IGVudHJ5IG9mIGRlY29kZWQudmFsdWVzKCkpIHsgYnl0ZXNCeUtpbmRbZW50cnkua2luZF0gKz0gZW50cnkuYnl0ZXM7IGNvdW50QnlLaW5kW2VudHJ5LmtpbmRdKys7IH1cbiAgcmV0dXJuIHsgYnVkZ2V0Qnl0ZXM6IGRlY29kZWRCdWRnZXRCeXRlcywgcmV0YWluZWRCeXRlczogZGVjb2RlZEJ5dGVzLCByZXRhaW5lZENvdW50OiBkZWNvZGVkLnNpemUsXG4gICAgYnl0ZXNCeUtpbmQsIGNvdW50QnlLaW5kLCBldmljdGlvbnM6IGRlY29kZWRFdmljdGlvbnMsIGRlY29kZXNBY3RpdmUsIGRlY29kZXNRdWV1ZWQsXG4gICAgY2FudmFzQnl0ZXM6IGRlY29kZUNhbnZhcyA/IGRlY29kZUNhbnZhcy53aWR0aCAqIGRlY29kZUNhbnZhcy5oZWlnaHQgKiA0IDogMCB9O1xufVxuXG5mdW5jdGlvbiByYXN0ZXJCeXRlcyhyYXN0ZXI6IFJhc3Rlcik6IG51bWJlciB7XG4gIGNvbnN0IGJ1ZmZlcnMgPSBuZXcgU2V0PEFycmF5QnVmZmVyTGlrZT4oKTtcbiAgbGV0IGJ5dGVzID0gMDtcbiAgZm9yIChjb25zdCBzcmMgb2YgcmFzdGVyLmxldmVscykgaWYgKCFidWZmZXJzLmhhcyhzcmMuZGF0YS5idWZmZXIpKSB7IGJ1ZmZlcnMuYWRkKHNyYy5kYXRhLmJ1ZmZlcik7IGJ5dGVzICs9IHNyYy5kYXRhLmJ1ZmZlci5ieXRlTGVuZ3RoOyB9XG4gIHJldHVybiBieXRlcztcbn1cblxudHlwZSBHb3QgPSBTcmMgfCAnbWlzc2luZycgfCBudWxsOyAvLyAnbWlzc2luZycgPSB0aGUgc2VydmVyIHNheXMgaXQgaGFzIG5vIHN1Y2ggdGlsZSAoNDA0KTsgbnVsbCA9IGZhaWxlZCBmb3Igbm93XG50eXBlIERyYXduID0geyBweDogVWludDhDbGFtcGVkQXJyYXk8QXJyYXlCdWZmZXI+IHwgbnVsbDsgZ2FwczogYm9vbGVhbjsgcGFyZW50PzogYm9vbGVhbiB9O1xuY29uc3QgTk9USElORzogRHJhd24gPSB7IHB4OiBudWxsLCBnYXBzOiBmYWxzZSB9O1xuLyoqIEEgZG93bmxvYWQgZmFpbGVkOiBkcmF3IG5vdGhpbmcgbmV3LCBrZWVwIHNob3dpbmcgdGhlIHBhcmVudCB0aWxlIChpdCBpcyBzaGFycGVyIHRoYW4gYSBob2xlKSwgYW5kIGFzayBhZ2FpbiBsYXRlci4gKi9cbmNvbnN0IFBBUkVOVF9GT1JfTk9XOiBEcmF3biA9IHsgcHg6IG51bGwsIGdhcHM6IHRydWUsIHBhcmVudDogdHJ1ZSB9O1xuLyoqIERvd25sb2FkcyBzbyBmYXI6IFtmaWxlcyBzdG9yZWQgd2l0aCB0aGUgYXBwLCByZW1vdGUsIGZhaWxlZF0uIFJlcG9ydGVkIHdpdGggZXZlcnkgYW5zd2VyIChmb3IgdGVzdHMgYW5kIHRoZSBsb2FkaW5nIHNjcmVlbikuICovXG5jb25zdCBuZXQ6IFtudW1iZXIsIG51bWJlciwgbnVtYmVyXSA9IFswLCAwLCAwXTtcbi8vIEJ5dGVzIGFyZSBjb21wcmVzc2VkIHJlc3BvbnNlIGJvZGllcyAobm90IEhUVFAgaGVhZGVycyk7IGRlYnVnIGhvb2sgb25seSwgbm8gZXh0cmEgcmVxdWVzdHMuXG5jb25zdCB0cmFmZmljOiBSZWNvcmQ8c3RyaW5nLCB7IHJlcXVlc3RzOiBudW1iZXI7IGJ5dGVzOiBudW1iZXIgfT4gPSB7fTtcblxuLyoqIFwiaHR0cHM6Ly9ob3N0OnBvcnRcIiBvZiBhIFVSTDogZG93bmxvYWRzIGFyZSBsaW1pdGVkLCBhbmQgZmFpbHVyZXMgcmVtZW1iZXJlZCwgcGVyIHNlcnZlci4gKi9cbmNvbnN0IG9yaWdpbk9mID0gKHVybDogc3RyaW5nKSA9PiB7IGNvbnN0IGkgPSB1cmwuaW5kZXhPZignLycsIHVybC5pbmRleE9mKCcvLycpICsgMik7IHJldHVybiBpIDwgMCA/IHVybCA6IHVybC5zbGljZSgwLCBpKTsgfTtcblxubGV0IG5ldEFjdGl2ZSA9IDAsIGxvY2FsQWN0aXZlID0gMDtcbmNvbnN0IGhvc3RBY3RpdmUgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuY29uc3QgbmV0V2FpdGluZzogeyBob3N0OiBzdHJpbmc7IGdvOiAoKSA9PiB2b2lkOyBwcmlvcml0eT86ICgpID0+IG51bWJlciB9W10gPSBbXTtcbmNvbnN0IGxvY2FsV2FpdGluZzogKCgpID0+IHZvaWQpW10gPSBbXTtcbi8vIFRoZSBlaWdodCBMdW5hc2VydiBuYW1lcyBhcmUgb25lIHNlcnZpY2UuIE1vcmUgY29ubmVjdGlvbnMgZG8gbm90IG1ha2UgaXRzXG4vLyBleHBlbnNpdmUgV01TIG1hcHMgZmFzdGVyLCBhbmQgY2FuIGNyb3dkIG91dCB0aGUgc291dGgtcG9sYXIgcGljdHVyZXMuXG5jb25zdCBxdWV1ZUhvc3QgPSAoaG9zdDogc3RyaW5nKSA9PiBob3N0LmVuZHNXaXRoKCcuaW0tbGRpLmNvbScpID8gJ2h0dHBzOi8vbHVuYXNlcnYuaW0tbGRpLmNvbScgOiBob3N0O1xuY29uc3QgaG9zdExpbWl0ID0gKGhvc3Q6IHN0cmluZykgPT4gaG9zdC5lbmRzV2l0aCgnLmltLWxkaS5jb20nKSB8fCBob3N0LmVuZHNXaXRoKCdxdWlja21hcC5pbycpID8gNCA6IEhPU1RfTElNSVQ7XG4vKiogTWlzc2luZyBwcmlvcml0aWVzIGtlZXAgdGhlIG9sZCBGSUZPIG9yZGVyLiBBIHNoYXJlZCB0aWxlIHJlYWRzIGl0cyBiZXN0IGN1cnJlbnQgdXNlcidzIHNjb3JlLiAqL1xuZnVuY3Rpb24gcHJpb3JpdHlTY29yZShwcmlvcml0eT86ICgpID0+IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IHNjb3JlID0gcHJpb3JpdHk/LigpID8/IDA7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUoc2NvcmUpID8gc2NvcmUgOiBJbmZpbml0eTtcbn1cblxuLyoqIFN0YXJ0IHRoZSBtb3N0IHVzZWZ1bCB3YWl0aW5nIGRvd25sb2FkIHRoYXQgaGFzIGEgZnJlZSBzZXJ2ZXIgc2xvdDsgdGllcyBzdGF5IG9sZGVzdCBmaXJzdC4gKi9cbmZ1bmN0aW9uIHB1bXAoKSB7XG4gIHdoaWxlIChuZXRXYWl0aW5nLmxlbmd0aCAmJiBuZXRBY3RpdmUgPCBORVRfTElNSVQpIHtcbiAgICBsZXQgYmVzdCA9IC0xLCBzY29yZSA9IEluZmluaXR5O1xuICAgIGZvciAobGV0IHEgPSAwOyBxIDwgbmV0V2FpdGluZy5sZW5ndGg7IHErKykge1xuICAgICAgY29uc3QgZW50cnkgPSBuZXRXYWl0aW5nW3FdO1xuICAgICAgaWYgKChob3N0QWN0aXZlLmdldChlbnRyeS5ob3N0KSA/PyAwKSA+PSBob3N0TGltaXQoZW50cnkuaG9zdCkpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgbmV4dCA9IHByaW9yaXR5U2NvcmUoZW50cnkucHJpb3JpdHkpO1xuICAgICAgaWYgKGJlc3QgPCAwIHx8IG5leHQgPCBzY29yZSkgeyBiZXN0ID0gcTsgc2NvcmUgPSBuZXh0OyB9XG4gICAgfVxuICAgIGlmIChiZXN0IDwgMCkgYnJlYWs7XG4gICAgY29uc3QgeyBob3N0LCBnbyB9ID0gbmV0V2FpdGluZy5zcGxpY2UoYmVzdCwgMSlbMF0sIGJ1c3kgPSBob3N0QWN0aXZlLmdldChob3N0KSA/PyAwO1xuICAgIG5ldEFjdGl2ZSsrO1xuICAgIGhvc3RBY3RpdmUuc2V0KGhvc3QsIGJ1c3kgKyAxKTtcbiAgICBnbygpO1xuICB9XG4gIHdoaWxlIChsb2NhbFdhaXRpbmcubGVuZ3RoICYmIGxvY2FsQWN0aXZlIDwgTE9DQUxfTElNSVQpIHsgbG9jYWxBY3RpdmUrKzsgbG9jYWxXYWl0aW5nLnNoaWZ0KCkhKCk7IH1cbn1cbmNvbnN0IG5ldEFjcXVpcmUgPSAoaG9zdDogc3RyaW5nLCBsb2NhbDogYm9vbGVhbiwgc2lnbmFsPzogQWJvcnRTaWduYWwsIHByaW9yaXR5PzogKCkgPT4gbnVtYmVyKSA9PiBuZXcgUHJvbWlzZTxib29sZWFuPihyZXNvbHZlID0+IHtcbiAgaWYgKHNpZ25hbD8uYWJvcnRlZCkgeyByZXNvbHZlKGZhbHNlKTsgcmV0dXJuOyB9XG4gIGNvbnN0IGNsZWFudXAgPSAoKSA9PiBzaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgY2FuY2VsKTtcbiAgY29uc3QgZ28gPSAoKSA9PiB7IGNsZWFudXAoKTsgcmVzb2x2ZSh0cnVlKTsgfTtcbiAgY29uc3QgZW50cnkgPSB7IGhvc3QsIGdvLCBwcmlvcml0eSB9O1xuICBjb25zdCBjYW5jZWwgPSAoKSA9PiB7XG4gICAgY29uc3QgcSA9IGxvY2FsID8gbG9jYWxXYWl0aW5nLmluZGV4T2YoZ28pIDogbmV0V2FpdGluZy5pbmRleE9mKGVudHJ5KTtcbiAgICBpZiAocSA8IDApIHJldHVybjtcbiAgICBpZiAobG9jYWwpIGxvY2FsV2FpdGluZy5zcGxpY2UocSwgMSk7IGVsc2UgbmV0V2FpdGluZy5zcGxpY2UocSwgMSk7XG4gICAgY2xlYW51cCgpOyByZXNvbHZlKGZhbHNlKTtcbiAgfTtcbiAgc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKCdhYm9ydCcsIGNhbmNlbCwgeyBvbmNlOiB0cnVlIH0pO1xuICBpZiAobG9jYWwpIGxvY2FsV2FpdGluZy5wdXNoKGdvKTsgZWxzZSBuZXRXYWl0aW5nLnB1c2goZW50cnkpO1xuICBwdW1wKCk7XG59KTtcbmZ1bmN0aW9uIG5ldFJlbGVhc2UoaG9zdDogc3RyaW5nLCBsb2NhbDogYm9vbGVhbikge1xuICBpZiAobG9jYWwpIGxvY2FsQWN0aXZlLS07IGVsc2UgeyBuZXRBY3RpdmUtLTsgaG9zdEFjdGl2ZS5zZXQoaG9zdCwgKGhvc3RBY3RpdmUuZ2V0KGhvc3QpID8/IDEpIC0gMSk7IH1cbiAgcHVtcCgpO1xufVxuXG4vKiogXCJuYXNhLmdvdlwiIG9mIFwiaHR0cHM6Ly90cmVrLm5hc2EuZ292XCI6IEx1bmFzZXJ2IHNwcmVhZHMgaXRzIHRpbGVzIG92ZXIgZWlnaHQgaG9zdCBuYW1lcyBvZiBvbmUgc2VydmVyLiAqL1xuY29uc3Qgc2l0ZU9mID0gKHVybDogc3RyaW5nKSA9PiB7IGNvbnN0IG0gPSAvKFteLi9dK1xcLlteLi86XSspKDpcXGQrKT8kLy5leGVjKG9yaWdpbk9mKHVybCkpOyByZXR1cm4gbSA/IG1bMV0gOiB1cmw7IH07XG5pbnRlcmZhY2UgQnJlYWtlciB7IGZhaWxzOiBudW1iZXI7IHByb2JlOiBQcm9taXNlPGJvb2xlYW4+IHwgbnVsbCB9XG5jb25zdCBicmVha2VycyA9IG5ldyBNYXA8c3RyaW5nLCBCcmVha2VyPigpO1xuXG4vLyBOZXR3b3JrIGhlYWx0aC4gQSBmYWlsZWQgZG93bmxvYWQgaXMgbm90IHRyaWVkIGFnYWluIGZvciBSRVRSWV9NUywgdW5sZXNzIGl0cyBzZXJ2ZXIgaGFzXG4vLyBhbnN3ZXJlZCBzaW5jZSAoaXQgcmVjb3ZlcmVkKSBvciB0aGUgbWFpbiB0aHJlYWQgc2F5cyB0aGUgYnJvd3NlciBpcyBiYWNrIG9ubGluZS5cbmNvbnN0IGZhaWxpbmdIb3N0cyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuY29uc3QgaG9zdEJhY2tBdCA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG5sZXQgZm9yZ2V0QmVmb3JlID0gMDtcbmxldCByZWNvdmVyZWQgPSBmYWxzZTtcblxuLyoqIFRydWUgd2hpbGUgYSBkb3dubG9hZCB0aGF0IGZhaWxlZCBhdCB0aW1lIGBhdGAgc2hvdWxkIG5vdCBiZSB0cmllZCBhZ2FpbiB5ZXQuICovXG5mdW5jdGlvbiBzdGlsbEZhaWxpbmcoYXQ6IG51bWJlciwgdXJsOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIHBlcmZvcm1hbmNlLm5vdygpIC0gYXQgPCBSRVRSWV9NUyAmJiBhdCA+IE1hdGgubWF4KGZvcmdldEJlZm9yZSwgaG9zdEJhY2tBdC5nZXQob3JpZ2luT2YodXJsKSkgPz8gMCk7XG59XG5cbmZ1bmN0aW9uIGFuc3dlcmVkKGhvc3Q6IHN0cmluZykge1xuICBpZiAoZmFpbGluZ0hvc3RzLmRlbGV0ZShob3N0KSkgeyBob3N0QmFja0F0LnNldChob3N0LCBwZXJmb3JtYW5jZS5ub3coKSk7IHJlY292ZXJlZCA9IHRydWU7IH1cbn1cblxuLyoqIFRoZSBhcHAncyBvd24gYWRkcmVzczogZmlsZXMgZnJvbSB0aGVyZSBhcmUgc3RvcmVkIHdpdGggdGhlIGFwcCAoZmFzdCwgdGhlcmUgd2l0aCBubyBpbnRlcm5ldCkuICovXG5jb25zdCBPV04gPSB0eXBlb2YgbG9jYXRpb24gIT09ICd1bmRlZmluZWQnICYmIGxvY2F0aW9uLm9yaWdpbiA/IGAke2xvY2F0aW9uLm9yaWdpbn0vYCA6IG51bGw7XG5cbi8qKiBEb3dubG9hZCBhIHBpY3R1cmUuIGBsb2NhbGAgPSBhIGZpbGUgc3RvcmVkIHdpdGggdGhlIGFwcCAoaXRzIG93biBxdWV1ZSwgbm8gc2VydmVyLWhlYWx0aCBib29ra2VlcGluZykuICovXG5hc3luYyBmdW5jdGlvbiBmZXRjaEJsb2IodXJsOiBzdHJpbmcsIGxvY2FsID0gT1dOICE9PSBudWxsICYmIHVybC5zdGFydHNXaXRoKE9XTiksIHNpZ25hbD86IEFib3J0U2lnbmFsLCBwcmlvcml0eT86ICgpID0+IG51bWJlcik6IFByb21pc2U8QmxvYiB8ICdtaXNzaW5nJyB8IG51bGw+IHtcbiAgc2lnbmFsPy50aHJvd0lmQWJvcnRlZCgpO1xuICBjb25zdCBob3N0ID0gb3JpZ2luT2YodXJsKSwgcXVldWUgPSBxdWV1ZUhvc3QoaG9zdCk7XG4gIGxldCBicjogQnJlYWtlciB8IHVuZGVmaW5lZCwgcHJvYmVkOiAoKG9rOiBib29sZWFuKSA9PiB2b2lkKSB8IHVuZGVmaW5lZDtcbiAgaWYgKCFsb2NhbCkge1xuICAgIGNvbnN0IHNpdGUgPSBzaXRlT2YodXJsKTtcbiAgICBiciA9IGJyZWFrZXJzLmdldChzaXRlKTtcbiAgICBpZiAoIWJyKSBicmVha2Vycy5zZXQoc2l0ZSwgKGJyID0geyBmYWlsczogMCwgcHJvYmU6IG51bGwgfSkpO1xuICB9XG4gIGNvbnN0IGRvd24gPSAoKSA9PiBiciAhPT0gdW5kZWZpbmVkICYmIGJyLmZhaWxzID49IEJSRUFLRVJfQUZURVI7XG4gIGZvciAoOzspIHtcbiAgICB3aGlsZSAoZG93bigpICYmIGJyIS5wcm9iZSkge1xuICAgICAgY29uc3QgYmFjayA9IGF3YWl0IGJyIS5wcm9iZTtcbiAgICAgIHNpZ25hbD8udGhyb3dJZkFib3J0ZWQoKTtcbiAgICAgIGlmICghYmFjaykgeyBuZXRbMl0rKzsgcmV0dXJuIG51bGw7IH1cbiAgICB9IC8vIHRoZSBzZXJ2ZXIgaXMgc3RpbGwgZG93blxuICAgIGlmIChkb3duKCkpIGJyIS5wcm9iZSA9IG5ldyBQcm9taXNlPGJvb2xlYW4+KHJlcyA9PiB7IHByb2JlZCA9IHJlczsgfSk7IC8vIHRoaXMgZG93bmxvYWQgZmluZHMgb3V0IHdoZXRoZXIgaXQgaXMgYmFja1xuICAgIGlmICghKGF3YWl0IG5ldEFjcXVpcmUocXVldWUsIGxvY2FsLCBzaWduYWwsIHByaW9yaXR5KSkpIHtcbiAgICAgIGlmIChwcm9iZWQpIHsgYnIhLnByb2JlID0gbnVsbDsgcHJvYmVkKHRydWUpOyB9XG4gICAgICBzaWduYWw/LnRocm93SWZBYm9ydGVkKCk7XG4gICAgfVxuICAgIGlmIChwcm9iZWQgfHwgIWRvd24oKSkgYnJlYWs7XG4gICAgbmV0UmVsZWFzZShxdWV1ZSwgbG9jYWwpOyAvLyB0aGUgc2VydmVyIHdlbnQgZG93biB3aGlsZSB0aGlzIGRvd25sb2FkIHdhaXRlZCBmb3IgaXRzIHR1cm5cbiAgfVxuICBjb25zdCBkb25lID0gKG9rOiBib29sZWFuKSA9PiB7IGlmIChicikgeyBici5mYWlscyA9IG9rID8gMCA6IGJyLmZhaWxzICsgMTsgaWYgKHByb2JlZCkgeyBici5wcm9iZSA9IG51bGw7IHByb2JlZChvayk7IH0gfSB9O1xuICBuZXRbbG9jYWwgPyAwIDogMV0rKztcbiAgY29uc3QgdGFsbHkgPSB0cmFmZmljW2xvY2FsID8gJ2xvY2FsJyA6IHNpdGVPZih1cmwpXSA/Pz0geyByZXF1ZXN0czogMCwgYnl0ZXM6IDAgfTtcbiAgdGFsbHkucmVxdWVzdHMrKztcbiAgY29uc3QgY3RsID0gbmV3IEFib3J0Q29udHJvbGxlcigpLCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gY3RsLmFib3J0KCksIEZFVENIX1RJTUVPVVRfTVMpO1xuICBjb25zdCBjYW5jZWwgPSAoKSA9PiBjdGwuYWJvcnQoKTtcbiAgc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKCdhYm9ydCcsIGNhbmNlbCwgeyBvbmNlOiB0cnVlIH0pO1xuICBpZiAoc2lnbmFsPy5hYm9ydGVkKSBjdGwuYWJvcnQoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByID0gYXdhaXQgZmV0Y2godXJsLCB7IG1vZGU6ICdjb3JzJywgY3JlZGVudGlhbHM6ICdvbWl0Jywgc2lnbmFsOiBjdGwuc2lnbmFsIH0pO1xuICAgIGlmIChyLnN0YXR1cyA9PT0gNDA0KSB7IGFuc3dlcmVkKGhvc3QpOyBkb25lKHRydWUpOyByZXR1cm4gJ21pc3NpbmcnOyB9XG4gICAgaWYgKHIub2spIHsgY29uc3QgYmxvYiA9IGF3YWl0IHIuYmxvYigpOyB0YWxseS5ieXRlcyArPSBibG9iLnNpemUgfHwgMDsgc2lnbmFsPy50aHJvd0lmQWJvcnRlZCgpOyBhbnN3ZXJlZChob3N0KTsgZG9uZSh0cnVlKTsgcmV0dXJuIGJsb2I7IH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gb2ZmbGluZSwgdGltZWQgb3V0LCBvciBhbnN3ZXJlZCB3aXRob3V0IHRoZSBDT1JTIGhlYWRlciAoY3Jvc3Mtb3JpZ2luIGVycm9ycyBsb29rIHRoZSBzYW1lKVxuICB9IGZpbmFsbHkge1xuICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKCdhYm9ydCcsIGNhbmNlbCk7XG4gICAgbmV0UmVsZWFzZShxdWV1ZSwgbG9jYWwpO1xuICB9XG4gIGlmIChzaWduYWw/LmFib3J0ZWQpIHtcbiAgICAvLyBNb3ZpbmcgdGhlIG1hcCBzYXlzIG5vdGhpbmcgYWJvdXQgc2VydmVyIGhlYWx0aC4gQSBjYW5jZWxsZWQgcHJvYmUgc2ltcGx5XG4gICAgLy8gbGV0cyBhbm90aGVyIHJlYWwgcmVxdWVzdCBjaGVjayB0aGUgc2VydmVyLCB3aXRob3V0IGNoYW5naW5nIGl0cyBoaXN0b3J5LlxuICAgIGlmIChwcm9iZWQpIHsgYnIhLnByb2JlID0gbnVsbDsgcHJvYmVkKHRydWUpOyB9XG4gICAgc2lnbmFsLnRocm93SWZBYm9ydGVkKCk7XG4gIH1cbiAgbmV0WzJdKys7XG4gIGlmICghbG9jYWwpIGZhaWxpbmdIb3N0cy5hZGQoaG9zdCk7XG4gIGRvbmUoZmFsc2UpO1xuICByZXR1cm4gbnVsbDsgLy8gdGhlIHRpbGUgdGhhdCBuZWVkZWQgaXQga2VlcHMgc2hvd2luZyBpdHMgcGFyZW50IGZvciBub3dcbn1cblxubGV0IGRlY29kZUNhbnZhczogT2Zmc2NyZWVuQ2FudmFzIHwgdW5kZWZpbmVkLCBkZWNvZGVDb250ZXh0OiBPZmZzY3JlZW5DYW52YXNSZW5kZXJpbmdDb250ZXh0MkQgfCB1bmRlZmluZWQ7XG5mdW5jdGlvbiBjYW52YXMyZCh3OiBudW1iZXIsIGg6IG51bWJlcik6IE9mZnNjcmVlbkNhbnZhc1JlbmRlcmluZ0NvbnRleHQyRCB7XG4gIGlmICghZGVjb2RlQ2FudmFzKSB7XG4gICAgZGVjb2RlQ2FudmFzID0gbmV3IE9mZnNjcmVlbkNhbnZhcyh3LCBoKTtcbiAgICBjb25zdCBjb250ZXh0ID0gZGVjb2RlQ2FudmFzLmdldENvbnRleHQoJzJkJywgeyB3aWxsUmVhZEZyZXF1ZW50bHk6IHRydWUgfSk7XG4gICAgaWYgKCFjb250ZXh0KSB0aHJvdyBuZXcgRXJyb3IoJ05vIDJEIGNhbnZhcyBpbiB0aGlzIHdvcmtlcicpO1xuICAgIGRlY29kZUNvbnRleHQgPSBjb250ZXh0O1xuICB9XG4gIGlmIChkZWNvZGVDYW52YXMud2lkdGggIT09IHcpIGRlY29kZUNhbnZhcy53aWR0aCA9IHc7XG4gIGlmIChkZWNvZGVDYW52YXMuaGVpZ2h0ICE9PSBoKSBkZWNvZGVDYW52YXMuaGVpZ2h0ID0gaDtcbiAgcmV0dXJuIGRlY29kZUNvbnRleHQhO1xufVxuXG4vKiogRGVjb2RlIGEgcGljdHVyZSBpbnRvIHRoZSBtb3N0IGNvbXBhY3QgZm9ybSAoZ3JleS9SR0IvUkdCQSksIHJlYWRpbmcgYmlnIHBpY3R1cmVzIGluIHN0cmlwcyB0byBrZWVwIG1lbW9yeSBsb3cuICovXG5hc3luYyBmdW5jdGlvbiBkZWNvZGUoYmxvYjogQmxvYik6IFByb21pc2U8U3JjPiB7XG4gIGRlY29kZXNBY3RpdmUrKztcbiAgbGV0IGJtcDogSW1hZ2VCaXRtYXAgfCB1bmRlZmluZWQ7XG4gIHRyeSB7XG4gICAgYm1wID0gYXdhaXQgY3JlYXRlSW1hZ2VCaXRtYXAoYmxvYiwgeyBwcmVtdWx0aXBseUFscGhhOiAnbm9uZScsIGNvbG9yU3BhY2VDb252ZXJzaW9uOiAnbm9uZScgfSk7XG4gICAgY29uc3QgdyA9IGJtcC53aWR0aCwgaCA9IGJtcC5oZWlnaHQsIHN0cmlwSCA9IGNsYW1wKE1hdGguZmxvb3IoMiAqKiAyMCAvIHcpLCAxLCBoKSwgY3R4ID0gY2FudmFzMmQodywgc3RyaXBIKTtcbiAgICBjb25zdCBwYWNrID0gbmV3IFBhY2tlcih3LCBoKTtcbiAgICBmb3IgKGxldCB5ID0gMDsgeSA8IGg7IHkgKz0gc3RyaXBIKSB7XG4gICAgICBjb25zdCBzaCA9IE1hdGgubWluKHN0cmlwSCwgaCAtIHkpO1xuICAgICAgY3R4LmNsZWFyUmVjdCgwLCAwLCB3LCBzaCk7XG4gICAgICBjdHguZHJhd0ltYWdlKGJtcCwgMCwgeSwgdywgc2gsIDAsIDAsIHcsIHNoKTtcbiAgICAgIHBhY2suYWRkKGN0eC5nZXRJbWFnZURhdGEoMCwgMCwgdywgc2gpLmRhdGEsIHkgKiB3KTtcbiAgICB9XG4gICAgcmV0dXJuIHBhY2sucmVzdWx0KCk7XG4gIH0gZmluYWxseSB7XG4gICAgYm1wPy5jbG9zZSgpO1xuICAgIC8vIFRoZSBzdHJpcCBpcyBvbmx5IHVzZWQgc3luY2hyb25vdXNseSBhYm92ZS4gRG8gbm90IHJldGFpbiBhIGRpZmZlcmVudCA0IE1pQiBjYW52YXNcbiAgICAvLyBmb3IgZXZlcnkgaW1hZ2Ugd2lkdGgsIG9yIGxlYXZlIGl0cyBiYWNraW5nIHN0b3JlIGFyb3VuZCBiZXR3ZWVuIGRvd25sb2Fkcy5cbiAgICBpZiAoZGVjb2RlQ2FudmFzKSB7IGRlY29kZUNhbnZhcy53aWR0aCA9IDE7IGRlY29kZUNhbnZhcy5oZWlnaHQgPSAxOyB9XG4gICAgZGVjb2Rlc0FjdGl2ZS0tO1xuICB9XG59XG5cbmxldCByYXN0ZXJEZWNvZGVUYWlsOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XG4vKiogT25seSBvbmUgbGFyZ2UgcGhvdG8gaXMgZGVjb2RlZCBhbmQgbWlwbWFwcGVkIGF0IGEgdGltZTsgc21hbGwgc291cmNlIHRpbGVzIGtlZXAgc3RyZWFtaW5nLiAqL1xuYXN5bmMgZnVuY3Rpb24gZGVjb2RlUmFzdGVyKGJsb2I6IEJsb2IsIG1pcHMgPSBJbmZpbml0eSwgcG9sZUF3YXJlID0gZmFsc2UpOiBQcm9taXNlPFJhc3Rlcj4ge1xuICBjb25zdCBiZWZvcmUgPSByYXN0ZXJEZWNvZGVUYWlsO1xuICBsZXQgcmVsZWFzZSE6ICgpID0+IHZvaWQ7XG4gIHJhc3RlckRlY29kZVRhaWwgPSBuZXcgUHJvbWlzZTx2b2lkPihyZXNvbHZlID0+IHsgcmVsZWFzZSA9IHJlc29sdmU7IH0pO1xuICBkZWNvZGVzUXVldWVkKys7XG4gIGF3YWl0IGJlZm9yZTtcbiAgZGVjb2Rlc1F1ZXVlZC0tO1xuICB0cnkgeyByZXR1cm4gYnVpbGRNaXBzKGF3YWl0IGRlY29kZShibG9iKSwgbWlwcywgcG9sZUF3YXJlKTsgfVxuICBmaW5hbGx5IHsgcmVsZWFzZSgpOyB9XG59XG5cbi8qKiBMZWFzdC1yZWNlbnRseS11c2VkIG1lbW9yeSBvZiBkZWNvZGVkIHNvdXJjZSB0aWxlcywgd2l0aCBzaGFyZWQgZG93bmxvYWRzLiAqL1xuY2xhc3MgVGlsZUNhY2hlIHtcbiAgcHJpdmF0ZSByZWFkb25seSBpdGVtcyA9IG5ldyBNYXA8c3RyaW5nLCBTcmMgfCAnbWlzc2luZyc+KCk7XG4gIHByaXZhdGUgcmVhZG9ubHkgbG9hZGluZyA9IG5ldyBNYXA8c3RyaW5nLCB7IHByb21pc2U6IFByb21pc2U8R290PjsgY29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyOyB1c2VyczogTWFwPHN5bWJvbCwgKCgpID0+IG51bWJlcikgfCB1bmRlZmluZWQ+IH0+KCk7XG4gIHByaXZhdGUgcmVhZG9ubHkgZmFpbGVkID0gbmV3IE1hcDxzdHJpbmcsIHsgYXQ6IG51bWJlcjsgdXJsOiBzdHJpbmcgfT4oKTtcbiAgcHJpdmF0ZSByZWFkb25seSBidWRnZXQ6IG51bWJlcjtcbiAgcHJpdmF0ZSBieXRlcyA9IDA7XG4gIGNvbnN0cnVjdG9yKGJ1ZGdldDogbnVtYmVyKSB7IHRoaXMuYnVkZ2V0ID0gYnVkZ2V0OyB9XG5cbiAgcHJpdmF0ZSByZWNlbnQoa2V5OiBzdHJpbmcpOiBTcmMgfCAnbWlzc2luZycgfCBudWxsIHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCB0ID0gdGhpcy5pdGVtcy5nZXQoa2V5KTtcbiAgICBpZiAodCAhPT0gdW5kZWZpbmVkKSB7IHRoaXMuaXRlbXMuZGVsZXRlKGtleSk7IHRoaXMuaXRlbXMuc2V0KGtleSwgdCk7IGlmICh0ICE9PSAnbWlzc2luZycpIHRvdWNoRGVjb2RlZChgdGlsZToke2tleX1gKTsgcmV0dXJuIHQ7IH0gLy8gbWFyayBhcyByZWNlbnRseSB1c2VkXG4gICAgY29uc3QgZiA9IHRoaXMuZmFpbGVkLmdldChrZXkpO1xuICAgIGlmIChmICYmIHN0aWxsRmFpbGluZyhmLmF0LCBmLnVybCkpIHJldHVybiBudWxsO1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cblxuICAvKiogQWxsIHRpbGVzIGlmIHRoZXkgYXJlIGFscmVhZHkga25vd24gKG5vIHdhaXRpbmcpLCBlbHNlIG51bGwuICovXG4gIHBlZWtBbGwoa2V5czogc3RyaW5nW10pOiBHb3RbXSB8IG51bGwge1xuICAgIGNvbnN0IG91dDogR290W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGsgb2Yga2V5cykgeyBjb25zdCB0ID0gdGhpcy5yZWNlbnQoayk7IGlmICh0ID09PSB1bmRlZmluZWQpIHJldHVybiBudWxsOyBvdXQucHVzaCh0KTsgfVxuICAgIHJldHVybiBvdXQ7XG4gIH1cblxuICAvKipcbiAgICogVGhlIHRpbGUsIGZyb20gbWVtb3J5IG9yIGRvd25sb2FkZWQgb25jZS4gV2l0aCBgbG9jYWxVcmxgIHRoZSBjb3B5IHN0b3JlZCB3aXRoIHRoZSBhcHAgaXMgcmVhZFxuICAgKiBmaXJzdCBhbmQgYHVybGAgKHRoZSByZW1vdGUgc2VydmVyKSBpcyBvbmx5IGFza2VkIGlmIHRoYXQgY29weSBpcyBtaXNzaW5nIG9yIHVucmVhZGFibGUuXG4gICAqL1xuICBnZXQoa2V5OiBzdHJpbmcsIHVybDogc3RyaW5nLCBsb2NhbFVybD86IHN0cmluZywgc2lnbmFsPzogQWJvcnRTaWduYWwsIHByaW9yaXR5PzogKCkgPT4gbnVtYmVyKTogUHJvbWlzZTxHb3Q+IHtcbiAgICBpZiAoc2lnbmFsPy5hYm9ydGVkKSByZXR1cm4gUHJvbWlzZS5yZWplY3Qoc2lnbmFsLnJlYXNvbik7XG4gICAgY29uc3QgdCA9IHRoaXMucmVjZW50KGtleSk7XG4gICAgaWYgKHQgIT09IHVuZGVmaW5lZCkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh0KTtcbiAgICBsZXQgZSA9IHRoaXMubG9hZGluZy5nZXQoa2V5KTtcbiAgICBpZiAoIWUpIHtcbiAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICBjb25zdCBlbnRyeSA9IHsgcHJvbWlzZTogUHJvbWlzZS5yZXNvbHZlKG51bGwpIGFzIFByb21pc2U8R290PiwgY29udHJvbGxlciwgdXNlcnM6IG5ldyBNYXA8c3ltYm9sLCAoKCkgPT4gbnVtYmVyKSB8IHVuZGVmaW5lZD4oKSB9O1xuICAgICAgLy8gQSBzb3VyY2Ugc3F1YXJlIGNhbiBzZXJ2ZSBzZXZlcmFsIGRpc3BsYXkgdGlsZXMuIEZvbGxvdyB3aGljaGV2ZXIgc3RpbGwgbmVlZHMgaXQgbW9zdCxcbiAgICAgIC8vIGluY2x1ZGluZyB3aGVuIGEgY2FtZXJhIG1vdmUgY2hhbmdlcyB0aGVpciBzY29yZXMgb3IgaXRzIG5lYXJlc3QgdXNlciBpcyBjYW5jZWxsZWQuXG4gICAgICBjb25zdCBzaGFyZWRQcmlvcml0eSA9ICgpID0+IHtcbiAgICAgICAgbGV0IGJlc3QgPSBJbmZpbml0eTtcbiAgICAgICAgZm9yIChjb25zdCB1c2VyUHJpb3JpdHkgb2YgZW50cnkudXNlcnMudmFsdWVzKCkpIGJlc3QgPSBNYXRoLm1pbihiZXN0LCBwcmlvcml0eVNjb3JlKHVzZXJQcmlvcml0eSkpO1xuICAgICAgICByZXR1cm4gYmVzdDtcbiAgICAgIH07XG4gICAgICBlbnRyeS5wcm9taXNlID0gKGFzeW5jICgpOiBQcm9taXNlPEdvdD4gPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGxldCBnb3Q6IEdvdCA9IGxvY2FsVXJsID8gYXdhaXQgdGhpcy5sb2FkKGxvY2FsVXJsLCB0cnVlLCBjb250cm9sbGVyLnNpZ25hbCwgc2hhcmVkUHJpb3JpdHkpIDogbnVsbDtcbiAgICAgICAgICBpZiAoIWxvY2FsVXJsIHx8IGdvdCA9PT0gbnVsbCB8fCBnb3QgPT09ICdtaXNzaW5nJykgZ290ID0gYXdhaXQgdGhpcy5sb2FkKHVybCwgZmFsc2UsIGNvbnRyb2xsZXIuc2lnbmFsLCBzaGFyZWRQcmlvcml0eSk7XG4gICAgICAgICAgY29udHJvbGxlci5zaWduYWwudGhyb3dJZkFib3J0ZWQoKTtcbiAgICAgICAgICBpZiAoZ290ID09PSBudWxsKSB0aGlzLmZhaWwoa2V5LCB1cmwpO1xuICAgICAgICAgIGVsc2UgeyB0aGlzLmZhaWxlZC5kZWxldGUoa2V5KTsgdGhpcy5wdXQoa2V5LCBnb3QpOyB9XG4gICAgICAgICAgcmV0dXJuIGdvdDtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBpZiAoY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgcmV0dXJuIG51bGw7IC8vIGFsbCB1c2VycyBsZWZ0OyBkbyBub3QgcmVtZW1iZXIgYSBmYWlsdXJlXG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgaWYgKHRoaXMubG9hZGluZy5nZXQoa2V5KSA9PT0gZW50cnkpIHRoaXMubG9hZGluZy5kZWxldGUoa2V5KTtcbiAgICAgICAgfVxuICAgICAgfSkoKTtcbiAgICAgIHRoaXMubG9hZGluZy5zZXQoa2V5LCBlID0gZW50cnkpO1xuICAgIH1cbiAgICBjb25zdCBlbnRyeSA9IGUsIHVzZXIgPSBTeW1ib2woKTtcbiAgICBlbnRyeS51c2Vycy5zZXQodXNlciwgcHJpb3JpdHkpO1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCBsZWF2ZSA9ICgpID0+IHtcbiAgICAgICAgc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKCdhYm9ydCcsIGNhbmNlbCk7XG4gICAgICAgIGVudHJ5LnVzZXJzLmRlbGV0ZSh1c2VyKTtcbiAgICAgIH07XG4gICAgICBjb25zdCBjYW5jZWwgPSAoKSA9PiB7XG4gICAgICAgIGxlYXZlKCk7XG4gICAgICAgIGlmICghZW50cnkudXNlcnMuc2l6ZSkge1xuICAgICAgICAgIGVudHJ5LmNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgICAgICAgICBpZiAodGhpcy5sb2FkaW5nLmdldChrZXkpID09PSBlbnRyeSkgdGhpcy5sb2FkaW5nLmRlbGV0ZShrZXkpO1xuICAgICAgICB9XG4gICAgICAgIHJlamVjdChzaWduYWw/LnJlYXNvbiA/PyBuZXcgRE9NRXhjZXB0aW9uKCdUaWxlIGxlZnQgdGhlIHZpZXcnLCAnQWJvcnRFcnJvcicpKTtcbiAgICAgIH07XG4gICAgICBzaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgY2FuY2VsLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgICBlbnRyeS5wcm9taXNlLnRoZW4oZ290ID0+IHsgbGVhdmUoKTsgcmVzb2x2ZShnb3QpOyB9LCBlcnJvciA9PiB7IGxlYXZlKCk7IHJlamVjdChlcnJvcik7IH0pO1xuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBsb2FkKHVybDogc3RyaW5nLCBsb2NhbDogYm9vbGVhbiwgc2lnbmFsPzogQWJvcnRTaWduYWwsIHByaW9yaXR5PzogKCkgPT4gbnVtYmVyKTogUHJvbWlzZTxHb3Q+IHtcbiAgICBjb25zdCBibG9iID0gYXdhaXQgZmV0Y2hCbG9iKHVybCwgbG9jYWwsIHNpZ25hbCwgcHJpb3JpdHkpO1xuICAgIGlmIChibG9iID09PSAnbWlzc2luZycgfHwgYmxvYiA9PT0gbnVsbCkgcmV0dXJuIGJsb2I7XG4gICAgc2lnbmFsPy50aHJvd0lmQWJvcnRlZCgpO1xuICAgIHJldHVybiBkZWNvZGUoYmxvYikudGhlbihzID0+IHVybC5pbmNsdWRlcyhgLyR7UEhPVE9fVEN9L2ApID8gdGNOb0RhdGEocykgOiBzKS5jYXRjaCgoKSA9PiBudWxsKTsgLy8ga2VlcCB2YWxpZCBibGFjayBzaGFkb3dzIGluIHRoZSBldmVuaW5nIFRDIGFuZCBOQUMgcGhvdG9zXG4gIH1cblxuICBwcml2YXRlIGZhaWwoa2V5OiBzdHJpbmcsIHVybDogc3RyaW5nKSB7XG4gICAgdGhpcy5mYWlsZWQuc2V0KGtleSwgeyBhdDogcGVyZm9ybWFuY2Uubm93KCksIHVybCB9KTtcbiAgICBpZiAodGhpcy5mYWlsZWQuc2l6ZSA+IDQwOTYpIGZvciAoY29uc3QgW2ssIGZdIG9mIHRoaXMuZmFpbGVkKSBpZiAoIXN0aWxsRmFpbGluZyhmLmF0LCBmLnVybCkpIHRoaXMuZmFpbGVkLmRlbGV0ZShrKTsgLy8gZm9yZ2V0IG9sZCBmYWlsdXJlc1xuICAgIHdoaWxlICh0aGlzLmZhaWxlZC5zaXplID4gNDA5NikgdGhpcy5mYWlsZWQuZGVsZXRlKHRoaXMuZmFpbGVkLmtleXMoKS5uZXh0KCkudmFsdWUhKTtcbiAgfVxuXG4gIHByaXZhdGUgcHV0KGtleTogc3RyaW5nLCB0OiBTcmMgfCAnbWlzc2luZycpIHtcbiAgICBjb25zdCBwcmV2aW91cyA9IHRoaXMuaXRlbXMuZ2V0KGtleSk7XG4gICAgaWYgKHByZXZpb3VzICE9PSB1bmRlZmluZWQpIHRoaXMuYnl0ZXMgLT0gcHJldmlvdXMgPT09ICdtaXNzaW5nJyA/IDY0IDogcHJldmlvdXMuZGF0YS5idWZmZXIuYnl0ZUxlbmd0aDtcbiAgICB0aGlzLml0ZW1zLnNldChrZXksIHQpO1xuICAgIHRoaXMuYnl0ZXMgKz0gdCA9PT0gJ21pc3NpbmcnID8gNjQgOiB0LmRhdGEuYnVmZmVyLmJ5dGVMZW5ndGg7XG4gICAgaWYgKHQgIT09ICdtaXNzaW5nJykgcmVnaXN0ZXJEZWNvZGVkKGB0aWxlOiR7a2V5fWAsIHQuZGF0YS5idWZmZXIuYnl0ZUxlbmd0aCwgKCkgPT4ge1xuICAgICAgaWYgKHRoaXMuaXRlbXMuZ2V0KGtleSkgPT09IHQpIHsgdGhpcy5pdGVtcy5kZWxldGUoa2V5KTsgdGhpcy5ieXRlcyAtPSB0LmRhdGEuYnVmZmVyLmJ5dGVMZW5ndGg7IH1cbiAgICB9LCAndGlsZScpO1xuICAgIGVsc2UgdW5yZWdpc3RlckRlY29kZWQoYHRpbGU6JHtrZXl9YCk7XG4gICAgZm9yIChjb25zdCBbaywgb2xkXSBvZiB0aGlzLml0ZW1zKSB7XG4gICAgICBpZiAodGhpcy5ieXRlcyA8PSB0aGlzLmJ1ZGdldCAmJiB0aGlzLml0ZW1zLnNpemUgPD0gMjA0OCkgYnJlYWs7XG4gICAgICB0aGlzLml0ZW1zLmRlbGV0ZShrKTtcbiAgICAgIHRoaXMuYnl0ZXMgLT0gb2xkID09PSAnbWlzc2luZycgPyA2NCA6IG9sZC5kYXRhLmJ1ZmZlci5ieXRlTGVuZ3RoO1xuICAgICAgaWYgKG9sZCAhPT0gJ21pc3NpbmcnKSB1bnJlZ2lzdGVyRGVjb2RlZChgdGlsZToke2t9YCk7XG4gICAgfVxuICB9XG59XG5cbmludGVyZmFjZSBSYXN0ZXJFbnRyeSB7IHJlYWRvbmx5IHByb21pc2U6IFByb21pc2U8UmFzdGVyIHwgbnVsbD47IHBlbmRpbmc6IFByb21pc2U8UmFzdGVyIHwgbnVsbD4gfCBudWxsOyByYXN0ZXI6IFJhc3RlciB8IG51bGw7IGZhaWxlZEF0OiBudW1iZXIgfVxuaW50ZXJmYWNlIERlcHRoRW50cnkgeyBkZXB0aDogbnVtYmVyIHwgbnVsbDsgZmFpbGVkQXQ6IG51bWJlcjsgcGVuZGluZzogUHJvbWlzZTxudW1iZXIgfCBudWxsPiB8IG51bGwgfVxuaW50ZXJmYWNlIEJhc2VFbnRyeSBleHRlbmRzIFJhc3RlckVudHJ5IHt9XG5cbmZ1bmN0aW9uIHN0YXJ0V29ya2VyKCkge1xuICBjb25zdCBmcCA9IG5ldyBGb290cHJpbnQoKTtcbiAgY29uc3QgdGlsZXMgPSBuZXcgVGlsZUNhY2hlKFRJTEVfQ0FDSEVfQllURVMpO1xuICBjb25zdCBqb2JzID0gbmV3IE1hcDxudW1iZXIsIEFib3J0Q29udHJvbGxlcj4oKTtcbiAgbGV0IHBob3RvVmlldzogeyBsb246IG51bWJlcjsgbGF0OiBudW1iZXI7IGxldmVsOiBudW1iZXIgfSB8IHVuZGVmaW5lZDtcbiAgZnVuY3Rpb24gcGhvdG9Qcmlvcml0eShqb2I6IEV4dHJhY3Q8Sm9iLCB7IGtpbmQ6ICdwaG90bycgfT4pOiBudW1iZXIge1xuICAgIGlmICghcGhvdG9WaWV3KSByZXR1cm4gMDtcbiAgICBjb25zdCByID0gam9iLnJlY3QsIGxvbiA9IChyLndlc3QgKyByLmVhc3QpIC8gMiwgbGF0ID0gKHIuc291dGggKyByLm5vcnRoKSAvIDI7XG4gICAgY29uc3QgZHggPSBNYXRoLmF0YW4yKE1hdGguc2luKGxvbiAtIHBob3RvVmlldy5sb24pLCBNYXRoLmNvcyhsb24gLSBwaG90b1ZpZXcubG9uKSkgKiBNYXRoLmNvcyhwaG90b1ZpZXcubGF0KTtcbiAgICBjb25zdCBzY2FsZSA9IE1hdGguUEkgLyAyICoqIE1hdGgubWluKDE3LCBwaG90b1ZpZXcubGV2ZWwpO1xuICAgIHJldHVybiAoZHggKiBkeCArIChsYXQgLSBwaG90b1ZpZXcubGF0KSAqKiAyKSAvIChzY2FsZSAqIHNjYWxlKSArIE1hdGgubWF4KDAsIHBob3RvVmlldy5sZXZlbCAtIGpvYi5sZXZlbCkgKiAwLjE7XG4gIH1cbiAgY29uc3QgZGVwdGhzID0gbmV3IE1hcDxzdHJpbmcsIERlcHRoRW50cnk+KCk7XG4gIGNvbnN0IHJhc3RlcnMgPSBuZXcgTWFwPHN0cmluZywgUmFzdGVyRW50cnk+KCk7XG4gIGNvbnN0IHNjaWVuY2VSYXN0ZXJzID0gbmV3IE1hcDxzdHJpbmcsIFJhc3RlckVudHJ5PigpO1xuICBjb25zdCBzY2llbmNlUGFsZXR0ZXMgPSBuZXcgTWFwPHN0cmluZywgVWludDhBcnJheT4oKTtcbiAgY29uc3QgYmFzZVBpY3R1cmVzID0gbmV3IE1hcDxzdHJpbmcsIEJhc2VFbnRyeT4oKTtcbiAgLyoqIFRoZSBweXJhbWlkIHNxdWFyZXMgc3RvcmVkIHdpdGggdGhlIGFwcCAodG9sZCBvbmNlIGJ5IHRoZSBtYWluIHRocmVhZCksIGFuZCB0aGVpciBmb2xkZXIuICovXG4gIGxldCBzdG9yZWQ6IHsgYmFzZTogc3RyaW5nOyBpbmRleDogUHlyYW1pZEluZGV4IHwgbnVsbCB9IHwgbnVsbCA9IG51bGw7XG5cbiAgLyoqXG4gICAqIERlZXBlc3QgbGV2ZWwgdGhlIE1vb24gVHJlayBzZXJ2ZXIgcmVhbGx5IGhhcyBmb3IgYSBsYXllciAocmVhZCBvbmNlIGZyb20gaXRzIFdNVFNcbiAgICogZGVzY3JpcHRpb24pLCBJbmZpbml0eSBpZiBpdCBoYXMgbm8gZGVzY3JpcHRpb24sIG9yIG51bGwgd2hpbGUgdGhhdCBpcyBub3Qga25vd24gKG9mZmxpbmUpLlxuICAgKi9cbiAgZnVuY3Rpb24gdHJla0RlcHRoKGxheWVyOiBzdHJpbmcpOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgICBsZXQgZSA9IGRlcHRocy5nZXQobGF5ZXIpO1xuICAgIGlmICghZSkgZGVwdGhzLnNldChsYXllciwgKGUgPSB7IGRlcHRoOiBudWxsLCBmYWlsZWRBdDogMCwgcGVuZGluZzogbnVsbCB9KSk7XG4gICAgY29uc3QgdXJsID0gdHJla0NhcGFiaWxpdGllc1VybChsYXllcik7XG4gICAgaWYgKGUuZGVwdGggIT09IG51bGwgfHwgZS5wZW5kaW5nIHx8IChlLmZhaWxlZEF0ICYmIHN0aWxsRmFpbGluZyhlLmZhaWxlZEF0LCB1cmwpKSkgcmV0dXJuIGUucGVuZGluZyA/PyBQcm9taXNlLnJlc29sdmUoZS5kZXB0aCk7XG4gICAgY29uc3QgZW50cnkgPSBlO1xuICAgIGVudHJ5LnBlbmRpbmcgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmxvYiA9IGF3YWl0IGZldGNoQmxvYih1cmwpO1xuICAgICAgY29uc3QgeG1sID0gYmxvYiAmJiBibG9iICE9PSAnbWlzc2luZycgPyBhd2FpdCBibG9iLnRleHQoKS5jYXRjaCgoKSA9PiBudWxsKSA6IG51bGw7XG4gICAgICBjb25zdCBkZXB0aCA9IGJsb2IgPT09ICdtaXNzaW5nJyA/IEluZmluaXR5IDogeG1sID09PSBudWxsID8gbnVsbCA6IHBhcnNlVHJla0RlcHRoKHhtbCkgPz8gSW5maW5pdHk7XG4gICAgICBlbnRyeS5wZW5kaW5nID0gbnVsbDtcbiAgICAgIGlmIChkZXB0aCA9PT0gbnVsbCkgZW50cnkuZmFpbGVkQXQgPSBwZXJmb3JtYW5jZS5ub3coKTsgZWxzZSBlbnRyeS5kZXB0aCA9IGRlcHRoO1xuICAgICAgcmV0dXJuIGRlcHRoO1xuICAgIH0pKCk7XG4gICAgcmV0dXJuIGVudHJ5LnBlbmRpbmc7XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBydW5UcmVrKGpvYjogRXh0cmFjdDxKb2IsIHsga2luZDogJ3RyZWsnIH0+LCBmbGlwOiBib29sZWFuKTogUHJvbWlzZTxEcmF3bj4ge1xuICAgIC8vIE5ldmVyIGFzayBmb3IgbGV2ZWxzIHRoZSBzZXJ2ZXIgZG9lcyBub3QgaGF2ZSAoZS5nLiB0aGUgTE9MQSBjb2xvdXIgbWFwIHN0b3BzIGF0IGxldmVsIDYpOlxuICAgIC8vIGluIGEgYnJvd3NlciB0aG9zZSB3b3VsZCBmYWlsIGxpa2UgYSBuZXR3b3JrIGVycm9yIGFuZCBsZWF2ZSB0aGUgbGF5ZXIgdHJhbnNwYXJlbnQuXG4gICAgY29uc3QgZGVwdGggPSBhd2FpdCB0cmVrRGVwdGgoam9iLmxheWVyKTtcbiAgICBjb25zdCBtYXhaID0gTWF0aC5taW4oam9iLm1heFNvdXJjZUxldmVsLCBkZXB0aCA/PyBJbmZpbml0eSk7XG4gICAgY29uc3QgcGxhbiA9IHBsYW5UcmVrKGZwLCBqb2IucmVjdCwgam9iLmxldmVsLCBtYXhaLCBqb2IubWluVHJ1ZUxhdCk7XG4gICAgaWYgKCFwbGFuKSByZXR1cm4gTk9USElORztcbiAgICBjb25zdCBrZXlPZiA9IChrOiBudW1iZXIpID0+IGAke2pvYi5sYXllcn0vJHtrfWA7XG4gICAgbGV0IGdvdCA9IHRpbGVzLnBlZWtBbGwocGxhbi5rZXlzLm1hcChrZXlPZikpO1xuICAgIGlmICghZ290KSB7XG4gICAgICBnb3QgPSBhd2FpdCBQcm9taXNlLmFsbChwbGFuLmtleXMubWFwKGsgPT4geyBjb25zdCB0ID0gdHJla1RpbGVPZihrKTsgcmV0dXJuIHRpbGVzLmdldChrZXlPZihrKSwgdHJla1VybChqb2IubGF5ZXIsIGpvYi5leHQsIHQueiwgdC54LCB0LnkpKTsgfSkpO1xuICAgICAgaWYgKGdvdC5pbmNsdWRlcyhudWxsKSkgcmV0dXJuIFBBUkVOVF9GT1JfTk9XO1xuICAgICAgdHJla0Zvb3RwcmludChmcCwgam9iLnJlY3QsIGpvYi5sZXZlbCwgbWF4Wiwgam9iLm1pblRydWVMYXQpOyAvLyBvdGhlciB0aWxlcyB1c2VkIHRoZSBzY3JhdGNoIG1lYW53aGlsZVxuICAgIH1cbiAgICBpZiAoZ290LmluY2x1ZGVzKG51bGwpKSByZXR1cm4gUEFSRU5UX0ZPUl9OT1c7XG4gICAgcmV0dXJuIHsgcHg6IHNhbXBsZVRpbGVzKGZwLCBwbGFuLmdyaWRzLCBwbGFuLmtleXMsIGdvdC5tYXAodCA9PiAodCA9PT0gJ21pc3NpbmcnID8gbnVsbCA6IHQpKSwgZmxpcCksIGdhcHM6IGZhbHNlIH07XG4gIH1cblxuICAvKiogRG93bmxvYWRzIGFyZSBzaGFyZWQgYWNyb3NzIHBob3RvIGFuZCBzZWFtLWZpeCBqb2JzLiBBYm9ydCBvbmx5IGFmdGVyIHRoZSBsYXN0IHRpbGUgdXNpbmdcbiAgICogYSBzb3VyY2Ugc3F1YXJlIGhhcyBzY3JvbGxlZCBhd2F5LiBMb3cgYW5kIGhpZ2ggdXNlIHRoZSBTQU1FIGdyaWQgYW5kIGNsaXAgYXQgZXZlcnkgem9vbS4gKi9cbiAgY29uc3QgcGhvdG9NYXNrcyA9IG5ldyBNYXA8bnVtYmVyLCB7IGtleTogc3RyaW5nOyBzcmM6IFNyYyB9PigpO1xuICBjb25zdCBwaG90b01hc2tJZHMgPSBuZXcgV2Vha01hcDxTcmMsIG51bWJlcj4oKTtcbiAgbGV0IG1hc2tJZCA9IDA7XG4gIGZ1bmN0aW9uIG1hc2tlZFBob3RvKHNyYzogU3JjKTogU3JjIHtcbiAgICBjb25zdCBpZCA9IHBob3RvTWFza0lkcy5nZXQoc3JjKSwgaGl0ID0gaWQgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IHBob3RvTWFza3MuZ2V0KGlkKTtcbiAgICBpZiAoaGl0ICYmIHRvdWNoRGVjb2RlZChoaXQua2V5KSkgcmV0dXJuIGhpdC5zcmM7XG4gICAgY29uc3Qgc29mdGVuZWQgPSBmZWF0aGVyUGhvdG9CbGFjayhzcmMpO1xuICAgIGlmIChzb2Z0ZW5lZCAhPT0gc3JjKSB7XG4gICAgICBjb25zdCBuZXh0ID0gKyttYXNrSWQsIGtleSA9IGBtYXNrLyR7bmV4dH1gO1xuICAgICAgcGhvdG9NYXNrSWRzLnNldChzcmMsIG5leHQpO1xuICAgICAgcGhvdG9NYXNrcy5zZXQobmV4dCwgeyBrZXksIHNyYzogc29mdGVuZWQgfSk7XG4gICAgICByZWdpc3RlckRlY29kZWQoa2V5LCBzb2Z0ZW5lZC5kYXRhLmJ5dGVMZW5ndGgsICgpID0+IHBob3RvTWFza3MuZGVsZXRlKG5leHQpLCAnbWFzaycpO1xuICAgIH1cbiAgICByZXR1cm4gc29mdGVuZWQ7XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBwaG90b1BpeGVscyhqb2I6IEV4dHJhY3Q8Sm9iLCB7IGtpbmQ6ICdwaG90bycgfT4sIGxheWVyOiBzdHJpbmcsIG1heFo6IG51bWJlciwgZmxpcDogYm9vbGVhbiwgc2lnbmFsOiBBYm9ydFNpZ25hbCwgcmVnaW9uPzogUGhvdG9SZWdpb24sIHNvZnRlbiA9IGZhbHNlKSB7XG4gICAgY29uc3QgcGxhbiA9IHBsYW5QaG90b1JlZ2lvbihmcCwgam9iLnJlY3QsIGpvYi5sZXZlbCwgbWF4WiwgcmVnaW9uKTtcbiAgICBpZiAoIXBsYW4gfHwgIXBsYW4ua2V5cy5sZW5ndGgpIHJldHVybiB7IHB4OiBudWxsLCBmYWlsZWQ6IGZhbHNlLCBuZWVkc0ZpbGw6IGZhbHNlIH07XG4gICAgY29uc3QgZ290ID0gYXdhaXQgUHJvbWlzZS5hbGwocGxhbi5rZXlzLm1hcChrZXkgPT4ge1xuICAgICAgY29uc3QgdCA9IHRyZWtUaWxlT2Yoa2V5KTtcbiAgICAgIGxldCB1cmwgPSB0cmVrVXJsKGxheWVyLCAncG5nJywgdC56LCB0LngsIHQueSk7XG4gICAgICBpZiAocmVnaW9uPy5xdWlja21hcCkge1xuICAgICAgICBjb25zdCB6ID0gTWF0aC5mbG9vcihrZXkgLyBLRVlfTEVWRUwpLCBxID0ga2V5IC0geiAqIEtFWV9MRVZFTCwgbiA9IDIgKiogejtcbiAgICAgICAgY29uc3Qgc3VmZml4ID0gcmVnaW9uLmdsb2JhbCA/ICcucG5nP2RfdmFsPTAsNTAwMCZkX29wdD13Y29sdXQwJyA6ICcuanBnJztcbiAgICAgICAgdXJsID0gYGh0dHBzOi8vbHJvYy10aWxlcy5xdWlja21hcC5pby90aWxlcy8ke2xheWVyfS9sdW5hci1mdWxsZXFjLyR7en0vJHtxICUgbn0vJHtNYXRoLmZsb29yKHEgLyBuKX0ke3N1ZmZpeH1gO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHRpbGVzLmdldChgJHtsYXllcn0vJHtyZWdpb24/LnF1aWNrbWFwID8gJ3FtLycgOiAnJ30ke2tleX1gLCB1cmwsIHVuZGVmaW5lZCwgc2lnbmFsLCAoKSA9PiBwaG90b1ByaW9yaXR5KGpvYikpO1xuICAgIH0pKTtcbiAgICBzaWduYWwudGhyb3dJZkFib3J0ZWQoKTtcbiAgICBpZiAoZ290LmluY2x1ZGVzKG51bGwpKSByZXR1cm4geyBweDogbnVsbCwgZmFpbGVkOiB0cnVlLCBuZWVkc0ZpbGw6IGZhbHNlIH07XG4gICAgcmVnaW9uRm9vdHByaW50KGZwLCBqb2IucmVjdCwgam9iLmxldmVsLCBtYXhaLCByZWdpb24pO1xuICAgIGNvbnN0IHB4ID0gc2FtcGxlVGlsZXMoZnAsIHBsYW4uZ3JpZHMsIHBsYW4ua2V5cywgZ290Lm1hcCh0ID0+ICF0IHx8IHQgPT09ICdtaXNzaW5nJyA/IG51bGwgOiBzb2Z0ZW4gPyBtYXNrZWRQaG90byh0KSA6IHQpLCBmbGlwKTtcbiAgICBsZXQgZGFyayA9IDA7XG4gICAgaWYgKHNvZnRlbiAmJiBweCkgZm9yIChsZXQgcCA9IDA7IHAgPCBOMjsgcCsrKSB7XG4gICAgICBjb25zdCByb3cgPSBNYXRoLmZsb29yKHAgLyBUSUxFKSwgY29sID0gcCAlIFRJTEUsIG8gPSAoKGZsaXAgPyByb3cgOiBUSUxFIC0gMSAtIHJvdykgKiBUSUxFICsgY29sKSAqIDQgKyAzO1xuICAgICAgaWYgKGZwLmNvdltwXSA+IDAuOSAmJiBweFtvXSA8IDEyOCkgZGFyaysrO1xuICAgIH1cbiAgICByZXR1cm4geyBweCwgZmFpbGVkOiBmYWxzZSwgbmVlZHNGaWxsOiBzb2Z0ZW4gJiYgKCFweCB8fCBkYXJrID4gTjIgKiAwLjAwNSkgfTtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIHJ1bk5vcnRoUGhvdG8oam9iOiBFeHRyYWN0PEpvYiwgeyBraW5kOiAncGhvdG8nIH0+LCBmbGlwOiBib29sZWFuLCBzaWduYWw6IEFib3J0U2lnbmFsKTogUHJvbWlzZTxEcmF3bj4ge1xuICAgIGNvbnN0IG5vcnRoVGlsZSA9IGFzeW5jIChrOiBudW1iZXIsIHE6IG51bWJlciwgbjogbnVtYmVyKSA9PiB7XG4gICAgICBjb25zdCBpID0gcSAlIG4sIGogPSBNYXRoLmZsb29yKHEgLyBuKSwgcHJpb3JpdHkgPSAoKSA9PiBwaG90b1ByaW9yaXR5KGpvYik7XG4gICAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCB0aWxlcy5nZXQoYG5vcnRoLyR7a30vJHtxfWAsIG5vcnRoUGhvdG9VcmwoaywgaSwgaiksIHVuZGVmaW5lZCwgc2lnbmFsLCBwcmlvcml0eSk7XG4gICAgICBpZiAoY2FjaGVkICYmIGNhY2hlZCAhPT0gJ21pc3NpbmcnKSByZXR1cm4gY2FjaGVkO1xuICAgICAgLy8gV01TIGlzIG11Y2ggc2xvd2VyIGFuZCBpdHMgdW5jb250cm9sbGVkIG1vc2FpYyBiZWdpbnMgYXQgODUuNSBOLiBBc2sgb25seSBhZnRlclxuICAgICAgLy8gdGhlIGNhY2hlZCBjb250cm9sbGVkIHRpbGUgZmFpbHM7IGl0cyBlbXB0eSBvdXRlciBwaXhlbHMgcmV0YWluIHRoZSBicm9hZCBwaG90by5cbiAgICAgIHJldHVybiB0aWxlcy5nZXQoYG5vcnRoLXdtcy8ke2t9LyR7cX1gLCBub3J0aEZhbGxiYWNrVXJsKGssIGksIGopLCB1bmRlZmluZWQsIHNpZ25hbCwgcHJpb3JpdHkpO1xuICAgIH07XG4gICAgbGV0IGJhc2U6IERyYXduIHwgdW5kZWZpbmVkO1xuICAgIGlmIChqb2Iubm9ydGhCYXNlKSB7XG4gICAgICBjb25zdCB7IGN1dCwgcmVjdCB9ID0gam9iLm5vcnRoQmFzZSwgcmFzdGVyID0gYXdhaXQgYmFzZVBpY3R1cmUoY3V0KS5wcm9taXNlLCBzcmMgPSByYXN0ZXI/LmxldmVsc1tjdXQubWlwXTtcbiAgICAgIGlmIChzcmMpIHtcbiAgICAgICAgZnAuY292LmZpbGwoMSk7IGZwLmx2bC5maWxsKDApOyBmcC50YXBzLmZpbGwoMSk7XG4gICAgICAgIGZvciAobGV0IGogPSAwOyBqIDwgVElMRTsgaisrKSBmb3IgKGxldCBpID0gMDsgaSA8IFRJTEU7IGkrKykge1xuICAgICAgICAgIGNvbnN0IHAgPSBqICogVElMRSArIGk7XG4gICAgICAgICAgZnAudVtwXSA9IGN1dC5weCArIFRJTEUgKiAoam9iLnJlY3Qud2VzdCArIChpICsgMC41KSAqIChqb2IucmVjdC5lYXN0IC0gam9iLnJlY3Qud2VzdCkgLyBUSUxFIC0gcmVjdC53ZXN0KSAvIChyZWN0LmVhc3QgLSByZWN0Lndlc3QpIC0gMC41O1xuICAgICAgICAgIGZwLnZbcF0gPSBjdXQucHkgKyBUSUxFICogKHJlY3Qubm9ydGggLSBqb2IucmVjdC5ub3J0aCArIChqICsgMC41KSAqIChqb2IucmVjdC5ub3J0aCAtIGpvYi5yZWN0LnNvdXRoKSAvIFRJTEUpIC8gKHJlY3Qubm9ydGggLSByZWN0LnNvdXRoKSAtIDAuNTtcbiAgICAgICAgfVxuICAgICAgICBiYXNlID0geyBweDogc2FtcGxlVGlsZXMoZnAsIFtzaW5nbGVHcmlkKHNyYyldLCBbMF0sIFtzcmNdLCBmbGlwKSwgZ2FwczogZmFsc2UgfTtcbiAgICAgIH1cbiAgICB9XG4gICAgYmFzZSA/Pz0gam9iLmZpeCA/IGF3YWl0IHJ1blN5bnRoKHsga2luZDogJ3N5bnRoJywgcmVjdDogam9iLnJlY3QsIGxldmVsOiBqb2IubGV2ZWwsIGZpeDogam9iLmZpeCB9LCBmbGlwKVxuICAgICAgOiBhd2FpdCBydW5UcmVrKHsga2luZDogJ3RyZWsnLCByZWN0OiBqb2IucmVjdCwgbGV2ZWw6IGpvYi5sZXZlbCwgbGF5ZXI6IGpvYi5sYXllciwgZXh0OiAnanBnJywgbWF4U291cmNlTGV2ZWw6IDgsIG1pblRydWVMYXQ6IGpvYi5taW5UcnVlTGF0IH0sIGZsaXApO1xuICAgIHNpZ25hbC50aHJvd0lmQWJvcnRlZCgpO1xuICAgIGlmICghYmFzZS5weCkgcmV0dXJuIGJhc2U7XG4gICAgLy8gS2VlcCBUQyB1bmRlcm5lYXRoIHRoZSBwb2xhciBmZWF0aGVyLiBUaGUgY2hvaWNlIGlzIHBlciB0cnVlIGxhdGl0dWRlLCBzbyBhIGRpc3BsYXlcbiAgICAvLyB0aWxlIGNyb3NzaW5nIHRoZSBjYXAgZWRnZSBoYXMgdGhlIHNhbWUgcGljdHVyZSBhcyBpdHMgbmVpZ2hib3VyIGF0IGV2ZXJ5IHpvb20uXG4gICAgaWYgKHRpbGVUcnVlTGF0UmFuZ2Uoam9iLnJlY3QpLm1pbkRlZyA8IE5PUlRIX1BIT1RPX0xBVCArIDAuMikge1xuICAgICAgY29uc3QgW3NoYXJwLCBsb3ddID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICBwaG90b1BpeGVscyhqb2IsIFBIT1RPX0ZJTkVfVEMubGF5ZXIsIFBIT1RPX0ZJTkVfVENfTUFYX1osIGZsaXAsIHNpZ25hbCwgUEhPVE9fRklORV9UQywgdHJ1ZSksIHBob3RvUGl4ZWxzKGpvYiwgUEhPVE9fRklORV9UQy5sYXllciwgOCwgZmxpcCwgc2lnbmFsLCBQSE9UT19GSU5FX1RDKSxcbiAgICAgIF0pO1xuICAgICAgaWYgKHNoYXJwLmZhaWxlZCB8fCBsb3cuZmFpbGVkKSByZXR1cm4gUEFSRU5UX0ZPUl9OT1c7XG4gICAgICB0cmVrR2VvbWV0cnkoZnAsIGpvYi5yZWN0LCBqb2IubWluVHJ1ZUxhdCk7XG4gICAgICBpZiAoc2hhcnAucHggJiYgbG93LnB4KSBmb3IgKGxldCBwID0gMDsgcCA8IE4yOyBwKyspIHtcbiAgICAgICAgY29uc3Qgcm93ID0gTWF0aC5mbG9vcihwIC8gVElMRSksIGNvbCA9IHAgJSBUSUxFLCBvID0gKChmbGlwID8gcm93IDogVElMRSAtIDEgLSByb3cpICogVElMRSArIGNvbCkgKiA0ICsgMztcbiAgICAgICAgY29uc3Qgd2VpZ2h0ID0gMSAtIHNtb290aCgoZnAuYVtwXSAvIERFRyAtIE5PUlRIX1BIT1RPX0xBVCkgLyAwLjIpO1xuICAgICAgICBzaGFycC5weFtvXSAqPSB3ZWlnaHQ7IGxvdy5weFtvXSAqPSB3ZWlnaHQ7XG4gICAgICB9XG4gICAgICBtYXRjaFBob3RvVG9uZShiYXNlLnB4LCBzaGFycC5weCwgbG93LnB4LCBiYXNlLnB4KTtcbiAgICB9XG4gICAgY29uc3QgcGxhbiA9IHBsYW5Ob3J0aFBob3RvKGZwLCBqb2IucmVjdCwgam9iLmxldmVsKTtcbiAgICBpZiAoIXBsYW4gfHwgIXBsYW4ua2V5cy5sZW5ndGgpIHJldHVybiBiYXNlO1xuICAgIGNvbnN0IGsgPSBwbGFuLmxldmVsLCBuID0gcGxhbi5ncmlkc1swXS50aWxlc1g7XG4gICAgY29uc3QgZ290ID0gYXdhaXQgUHJvbWlzZS5hbGwocGxhbi5rZXlzLm1hcChxID0+IG5vcnRoVGlsZShrLCBxLCBuKSkpO1xuICAgIHNpZ25hbC50aHJvd0lmQWJvcnRlZCgpO1xuICAgIGlmIChnb3QuaW5jbHVkZXMobnVsbCkpIHJldHVybiBQQVJFTlRfRk9SX05PVztcbiAgICBub3J0aEZvb3RwcmludChmcCwgam9iLnJlY3QsIGspO1xuICAgIGNvbnN0IHB4ID0gc2FtcGxlVGlsZXMoZnAsIHBsYW4uZ3JpZHMsIHBsYW4ua2V5cywgZ290Lm1hcCh0ID0+ICF0IHx8IHQgPT09ICdtaXNzaW5nJyA/IG51bGwgOiBtYXNrZWRQaG90byh0KSksIGZsaXApO1xuICAgIGNvbnN0IGxvd0sgPSA0LCBsb3dOID0gMiAqKiBsb3dLO1xuICAgIG5vcnRoRm9vdHByaW50KGZwLCBqb2IucmVjdCwgbG93Syk7XG4gICAgY29uc3QgZ3JpZHMgPSBbcHlyYW1pZEdyaWQobG93SyldLCBrZXlzID0gY29sbGVjdFRpbGVzKGZwLCBncmlkcywgSW5maW5pdHkpID8/IFtdO1xuICAgIGNvbnN0IGxvdyA9IGF3YWl0IFByb21pc2UuYWxsKGtleXMubWFwKHEgPT4gbm9ydGhUaWxlKGxvd0ssIHEsIGxvd04pKSk7XG4gICAgc2lnbmFsLnRocm93SWZBYm9ydGVkKCk7XG4gICAgaWYgKGxvdy5pbmNsdWRlcyhudWxsKSkgcmV0dXJuIFBBUkVOVF9GT1JfTk9XO1xuICAgIG5vcnRoRm9vdHByaW50KGZwLCBqb2IucmVjdCwgbG93Syk7XG4gICAgY29uc3QgYmx1cnJlZCA9IHNhbXBsZVRpbGVzKGZwLCBncmlkcywga2V5cywgbG93Lm1hcCh0ID0+IHQgPT09ICdtaXNzaW5nJyA/IG51bGwgOiB0KSwgZmxpcCk7XG4gICAgYWRkUGhvdG9EZXRhaWwoYmFzZS5weCwgcHgsIGJsdXJyZWQsIDAuOSk7XG4gICAgcmV0dXJuIGJhc2U7XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBydW5QaG90byhqb2I6IEV4dHJhY3Q8Sm9iLCB7IGtpbmQ6ICdwaG90bycgfT4sIGZsaXA6IGJvb2xlYW4sIHNpZ25hbDogQWJvcnRTaWduYWwpOiBQcm9taXNlPERyYXduPiB7XG4gICAgaWYgKHRpbGVUcnVlTGF0UmFuZ2Uoam9iLnJlY3QpLm1heERlZyA+IE5PUlRIX1BIT1RPX0xBVCkgcmV0dXJuIHJ1bk5vcnRoUGhvdG8oam9iLCBmbGlwLCBzaWduYWwpO1xuICAgIGNvbnN0IHJlZ2lvbnMgPSBwaG90b1JlZ2lvbnNGb3Ioam9iLnJlY3QpLCBwcmltYXJ5ID0gcmVnaW9ucy5maW5kKHIgPT4gcGhvdG9SZWdpb25Db3ZlcnMoam9iLnJlY3QsIHIpKTtcbiAgICAvLyBUaGUgcmVmZXJlbmNlIGFuZCB0aGUgZmluYWwgcGljdHVyZSB0cmF2ZWwgdG9nZXRoZXIuIEEgZnVsbCBOQUMgdGlsZSBuZWVkcyBubyBUQ1xuICAgIC8vIGRvd25sb2FkcyB1bmRlcm5lYXRoIGl0LCBhbmQgbmVpdGhlciB3YWl0cyBmb3IgdGhlIGJyb2FkIHJlZmVyZW5jZSB0byBzdGFydCBsb2FkaW5nLlxuICAgIGNvbnN0IGJhc2VQcm9taXNlID0gam9iLmZpeCA/IHJ1blN5bnRoKHsga2luZDogJ3N5bnRoJywgcmVjdDogam9iLnJlY3QsIGxldmVsOiBqb2IubGV2ZWwsIGZpeDogam9iLmZpeCB9LCBmbGlwKVxuICAgICAgOiBydW5UcmVrKHsga2luZDogJ3RyZWsnLCByZWN0OiBqb2IucmVjdCwgbGV2ZWw6IGpvYi5sZXZlbCwgbGF5ZXI6IGpvYi5sYXllciwgZXh0OiAnanBnJywgbWF4U291cmNlTGV2ZWw6IDgsIG1pblRydWVMYXQ6IGpvYi5taW5UcnVlTGF0IH0sIGZsaXApO1xuICAgIGNvbnN0IHNvdXJjZSA9IHByaW1hcnkgPz8gUEhPVE9fRklORV9UQztcbiAgICBsZXQgW2Jhc2UsIHNoYXJwLCBsb3ddID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgYmFzZVByb21pc2UsXG4gICAgICBwaG90b1BpeGVscyhqb2IsIHNvdXJjZS5sYXllciwgc291cmNlLm1heFosIGZsaXAsIHNpZ25hbCwgc291cmNlLCB0cnVlKSxcbiAgICAgIHBob3RvUGl4ZWxzKGpvYiwgc291cmNlLmxheWVyLCA4LCBmbGlwLCBzaWduYWwsIHNvdXJjZSksXG4gICAgXSk7XG4gICAgc2lnbmFsLnRocm93SWZBYm9ydGVkKCk7XG4gICAgaWYgKCFiYXNlLnB4KSByZXR1cm4gYmFzZTtcbiAgICBjb25zdCByZWZlcmVuY2UgPSBiYXNlLnB4LnNsaWNlKCk7XG4gICAgbGV0IHVwZ3JhZGVHYXAgPSBzaGFycC5mYWlsZWQgfHwgbG93LmZhaWxlZDtcbiAgICBpZiAocHJpbWFyeSkge1xuICAgICAgaWYgKHVwZ3JhZGVHYXApIHJldHVybiBQQVJFTlRfRk9SX05PVztcbiAgICAgIG1hdGNoUGhvdG9Ub25lKGJhc2UucHgsIHNoYXJwLnB4LCBsb3cucHgsIHJlZmVyZW5jZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGlmICh1cGdyYWRlR2FwIHx8ICFsb3cucHgpIHtcbiAgICAgICAgW3NoYXJwLCBsb3ddID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICAgIHBob3RvUGl4ZWxzKGpvYiwgUEhPVE9fVEMsIFBIT1RPX1RDX01BWF9aLCBmbGlwLCBzaWduYWwsIHVuZGVmaW5lZCwgdHJ1ZSksXG4gICAgICAgICAgcGhvdG9QaXhlbHMoam9iLCBQSE9UT19UQywgOCwgZmxpcCwgc2lnbmFsKSxcbiAgICAgICAgXSk7XG4gICAgICAgIGlmIChzaGFycC5mYWlsZWQgfHwgbG93LmZhaWxlZCkgcmV0dXJuIFBBUkVOVF9GT1JfTk9XO1xuICAgICAgICBhZGRQaG90b0RldGFpbChiYXNlLnB4LCBzaGFycC5weCwgbG93LnB4KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIE9ubHkgYW4gb24tc2NyZWVuIEV2ZW5pbmcgdGlsZSB3aXRoIGEgc2l6ZWFibGUgYmxhY2sgYXJlYSBhc2tzIGZvciBNb3JuaW5nLlxuICAgICAgICAvLyBCb3RoIG1heSBoYXZlIHNoYWRvd3M7IHdoZXJlIG5laXRoZXIgc2VlcyBncm91bmQgdGhlIG9yaWdpbmFsIFdBQyBzdGF5cyB2aXNpYmxlLlxuICAgICAgICBpZiAoc2hhcnAubmVlZHNGaWxsKSB7XG4gICAgICAgICAgY29uc3QgW21vcm5pbmcsIG1vcm5pbmdMb3ddID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICAgICAgcGhvdG9QaXhlbHMoam9iLCBQSE9UT19NT1JOSU5HX1RDLmxheWVyLCBQSE9UT19GSU5FX1RDX01BWF9aLCBmbGlwLCBzaWduYWwsIFBIT1RPX01PUk5JTkdfVEMsIHRydWUpLFxuICAgICAgICAgICAgcGhvdG9QaXhlbHMoam9iLCBQSE9UT19NT1JOSU5HX1RDLmxheWVyLCA4LCBmbGlwLCBzaWduYWwsIFBIT1RPX01PUk5JTkdfVEMpLFxuICAgICAgICAgIF0pO1xuICAgICAgICAgIGlmICghbW9ybmluZy5mYWlsZWQgJiYgIW1vcm5pbmdMb3cuZmFpbGVkKSBtYXRjaFBob3RvVG9uZShiYXNlLnB4LCBtb3JuaW5nLnB4LCBtb3JuaW5nTG93LnB4LCByZWZlcmVuY2UpO1xuICAgICAgICB9XG4gICAgICAgIG1hdGNoUGhvdG9Ub25lKGJhc2UucHgsIHNoYXJwLnB4LCBsb3cucHgsIHJlZmVyZW5jZSk7XG4gICAgICB9XG4gICAgfVxuICAgIGZvciAoY29uc3QgcmVnaW9uIG9mIHJlZ2lvbnMpIHtcbiAgICAgIGlmIChyZWdpb24gPT09IHByaW1hcnkpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgW2RldGFpbCwgYmx1cnJlZF0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICAgIHBob3RvUGl4ZWxzKGpvYiwgcmVnaW9uLmxheWVyLCByZWdpb24ubWF4WiwgZmxpcCwgc2lnbmFsLCByZWdpb24sIHRydWUpLFxuICAgICAgICBwaG90b1BpeGVscyhqb2IsIHJlZ2lvbi5sYXllciwgOCwgZmxpcCwgc2lnbmFsLCByZWdpb24pLFxuICAgICAgXSk7XG4gICAgICBpZiAoZGV0YWlsLmZhaWxlZCB8fCBibHVycmVkLmZhaWxlZCkgcmV0dXJuIFBBUkVOVF9GT1JfTk9XO1xuICAgICAgbWF0Y2hQaG90b1RvbmUoYmFzZS5weCwgZGV0YWlsLnB4LCBibHVycmVkLnB4LCByZWZlcmVuY2UpO1xuICAgIH1cbiAgICByZXR1cm4geyBweDogYmFzZS5weCwgZ2FwczogdXBncmFkZUdhcCB9O1xuICB9XG5cbiAgLyoqIFNlYW0gZml4IHRpbGU6IE1vb24gVHJlayBoaWxsc2hhZGUgdGlsZXMgeCB0aGUgbG9jYWwgYnJpZ2h0bmVzcy1tYXRjaGVkIGFsYmVkbywgc2VlLXRocm91Z2ggd2hlcmUgdGhlIHBob3RvIHNob3dzLiAqL1xuICBhc3luYyBmdW5jdGlvbiBydW5TeW50aChqb2I6IEV4dHJhY3Q8Sm9iLCB7IGtpbmQ6ICdzeW50aCcgfT4sIGZsaXA6IGJvb2xlYW4pOiBQcm9taXNlPERyYXduPiB7XG4gICAgY29uc3QgeyBmaXggfSA9IGpvYiwgc2hhZGUgPSBmaXhTaGFkZUZvcihmaXgsIGpvYi5yZWN0KTtcbiAgICBjb25zdCBwbGFuID0gcGxhblN5bnRoKGZwLCBqb2IucmVjdCwgam9iLmxldmVsLCBzaGFkZS5tYXhaKTtcbiAgICBpZiAoIXBsYW4pIHJldHVybiBOT1RISU5HO1xuICAgIGNvbnN0IGtleU9mID0gKGs6IG51bWJlcikgPT4gYCR7c2hhZGUubGF5ZXJ9LyR7a31gO1xuICAgIGxldCBnb3QgPSB0aWxlcy5wZWVrQWxsKHBsYW4ua2V5cy5tYXAoa2V5T2YpKTtcbiAgICBpZiAoIWdvdCkge1xuICAgICAgZ290ID0gYXdhaXQgUHJvbWlzZS5hbGwocGxhbi5rZXlzLm1hcChrID0+IHsgY29uc3QgdCA9IHRyZWtUaWxlT2Yoayk7IHJldHVybiB0aWxlcy5nZXQoa2V5T2YoayksIHRyZWtVcmwoc2hhZGUubGF5ZXIsICdwbmcnLCB0LnosIHQueCwgdC55KSk7IH0pKTtcbiAgICAgIGlmIChnb3QuaW5jbHVkZXMobnVsbCkpIHJldHVybiBQQVJFTlRfRk9SX05PVztcbiAgICB9XG4gICAgaWYgKGdvdC5pbmNsdWRlcyhudWxsKSkgcmV0dXJuIFBBUkVOVF9GT1JfTk9XO1xuICAgIC8vIERvIG5vdCBob2xkIGEgbGFyZ2UgbG9jYWwgaW1hZ2Ugd2hpbGUgYSByZW1vdGUgaGlsbHNoYWRlIHJlcXVlc3Qgd2FpdHMuXG4gICAgY29uc3QgYWxiZWRvID0gYXdhaXQgcmFzdGVyRm9yKGZpeC5hbGJlZG8udXJsKTtcbiAgICBpZiAoIWFsYmVkbykgcmV0dXJuIHsgcHg6IG51bGwsIGdhcHM6IHRydWUgfTtcbiAgICBzeW50aEZvb3RwcmludChmcCwgam9iLnJlY3QsIGpvYi5sZXZlbCwgc2hhZGUubWF4Wik7IC8vIG90aGVyIHRpbGVzIHVzZWQgdGhlIHNjcmF0Y2ggbWVhbndoaWxlXG4gICAgY29uc3QgYSA9IGFsYmVkby5sZXZlbHNbMF0sIHsgd2VzdCwgZWFzdCwgbm9ydGgsIHNvdXRoLCBzY2FsZSB9ID0gZml4LmFsYmVkbywgeyBDLCBTMCB9ID0gZml4O1xuICAgIGNvbnN0IHBvc3QgPSAocDogbnVtYmVyLCBzOiBudW1iZXIpID0+IHNhbXBsZUxvbkxhdChhLCB3ZXN0LCBlYXN0LCBub3J0aCwgc291dGgsIGZwLmFbcF0sIGZwLmJbcF0pICogc2NhbGUgKiBNYXRoLmV4cChDICogKHMgLyBTMCAtIDEpKTtcbiAgICByZXR1cm4geyBweDogc2FtcGxlVGlsZXMoZnAsIHBsYW4uZ3JpZHMsIHBsYW4ua2V5cywgZ290Lm1hcCh0ID0+ICh0ID09PSAnbWlzc2luZycgPyBudWxsIDogdCkpLCBmbGlwLCBwb3N0KSwgZ2FwczogZmFsc2UgfTtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIHJ1blB5cmFtaWQoam9iOiBFeHRyYWN0PEpvYiwgeyBraW5kOiAncHlyYW1pZCcgfT4sIGZsaXA6IGJvb2xlYW4pOiBQcm9taXNlPERyYXduPiB7XG4gICAgY29uc3QgcGxhbiA9IHBsYW5QeXJhbWlkKGZwLCBqb2IucmVjdCwgam9iLmxldmVsLCBqb2IubWluSyk7XG4gICAgaWYgKCFwbGFuKSByZXR1cm4gTk9USElORztcbiAgICBjb25zdCBrID0gcGxhbi5sZXZlbCwgbiA9IHBsYW4uZ3JpZHNbMF0udGlsZXNYO1xuICAgIGNvbnN0IGtleU9mID0gKHE6IG51bWJlcikgPT4gYCR7am9iLmxheWVyc30vJHtrfS8ke3F9YDtcbiAgICBsZXQgZ290ID0gdGlsZXMucGVla0FsbChwbGFuLmtleXMubWFwKGtleU9mKSk7XG4gICAgaWYgKCFnb3QpIHtcbiAgICAgIC8vIExvY2FsIGZpcnN0OiBzcXVhcmVzIHN0b3JlZCB3aXRoIHRoZSBhcHAgYXJlIHJlYWQgZnJvbSBkaXNrOyB0aGUgcmVtb3RlIHNlcnZlciBpcyBvbmx5IGFza2VkIGZvciB0aGUgcmVzdC5cbiAgICAgIGNvbnN0IGJhc2UgPSBqb2IubG9jYWwsIGluZGV4ID0gYmFzZSAmJiBzdG9yZWQgJiYgc3RvcmVkLmJhc2UgPT09IGJhc2UgJiYgc3RvcmVkLmluZGV4Py5sYXllcnMgPT09IGpvYi5sYXllcnMgPyBzdG9yZWQuaW5kZXggOiBudWxsO1xuICAgICAgZ290ID0gYXdhaXQgUHJvbWlzZS5hbGwocGxhbi5rZXlzLm1hcChxID0+IHtcbiAgICAgICAgY29uc3QgaSA9IHEgJSBuLCBqID0gTWF0aC5mbG9vcihxIC8gbik7XG4gICAgICAgIHJldHVybiB0aWxlcy5nZXQoa2V5T2YocSksIHB5cmFtaWRVcmwoam9iLmxheWVycywgaywgaSwgaiksIGJhc2UgJiYgcHlyYW1pZEhhc0xvY2FsKGluZGV4LCBrLCBpLCBqKSA/IHB5cmFtaWRMb2NhbFVybChiYXNlLCBrLCBpLCBqKSA6IHVuZGVmaW5lZCk7XG4gICAgICB9KSk7XG4gICAgICBpZiAoZ290LmluY2x1ZGVzKG51bGwpKSByZXR1cm4gUEFSRU5UX0ZPUl9OT1c7XG4gICAgICBweXJhbWlkRm9vdHByaW50KGZwLCBqb2IucmVjdCwgayk7XG4gICAgfVxuICAgIGlmIChnb3QuaW5jbHVkZXMobnVsbCkpIHJldHVybiBQQVJFTlRfRk9SX05PVztcbiAgICByZXR1cm4geyBweDogc2FtcGxlVGlsZXMoZnAsIHBsYW4uZ3JpZHMsIHBsYW4ua2V5cywgZ290Lm1hcCh0ID0+ICh0ID09PSAnbWlzc2luZycgPyBudWxsIDogdCkpLCBmbGlwKSwgZ2FwczogZmFsc2UgfTtcbiAgfVxuXG4gIC8qKiBBIGxvY2FsIHBpY3R1cmUgdXNlcyB0aGUgc2FtZSBib3VuZGVkIExSVSBhcyB0aGUgcmVtb3RlIHNxdWFyZXMgYW5kIHNjaWVuY2UgbWFwcy4gKi9cbiAgZnVuY3Rpb24gYmFzZVBpY3R1cmUoYzogQmFzZUN1dCk6IEJhc2VFbnRyeSB7XG4gICAgbGV0IGUgPSBiYXNlUGljdHVyZXMuZ2V0KGMudXJsKTtcbiAgICBpZiAoZSAmJiBlLmZhaWxlZEF0ICYmICFzdGlsbEZhaWxpbmcoZS5mYWlsZWRBdCwgYy51cmwpKSB7IGJhc2VQaWN0dXJlcy5kZWxldGUoYy51cmwpOyBlID0gdW5kZWZpbmVkOyB9XG4gICAgaWYgKCFlKSB7XG4gICAgICBjb25zdCBlbnRyeTogQmFzZUVudHJ5ID0geyBwZW5kaW5nOiBudWxsLCByYXN0ZXI6IG51bGwsIGZhaWxlZEF0OiAwLFxuICAgICAgICBnZXQgcHJvbWlzZSgpIHsgcmV0dXJuIHRoaXMucGVuZGluZyA/PyBQcm9taXNlLnJlc29sdmUodGhpcy5yYXN0ZXIpOyB9IH07XG4gICAgICBlbnRyeS5wZW5kaW5nID0gKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgYmxvYiA9IGF3YWl0IGZldGNoQmxvYihjLnVybCwgdHJ1ZSk7XG4gICAgICAgIGNvbnN0IHJhc3RlciA9IGJsb2IgJiYgYmxvYiAhPT0gJ21pc3NpbmcnID8gYXdhaXQgZGVjb2RlUmFzdGVyKGJsb2IsIGMubWlwcywgISFjLnBvbGVBd2FyZSkuY2F0Y2goKCkgPT4gbnVsbCkgOiBudWxsO1xuICAgICAgICBpZiAocmFzdGVyKSB7XG4gICAgICAgICAgZW50cnkucmFzdGVyID0gcmFzdGVyO1xuICAgICAgICAgIHJlZ2lzdGVyRGVjb2RlZChgYmFzZToke2MudXJsfWAsIHJhc3RlckJ5dGVzKHJhc3RlciksICgpID0+IHtcbiAgICAgICAgICAgIGVudHJ5LnJhc3RlciA9IG51bGw7XG4gICAgICAgICAgICBpZiAoYmFzZVBpY3R1cmVzLmdldChjLnVybCkgPT09IGVudHJ5KSBiYXNlUGljdHVyZXMuZGVsZXRlKGMudXJsKTtcbiAgICAgICAgICB9LCAnYmFzZScpO1xuICAgICAgICB9XG4gICAgICAgIGVsc2UgeyBlbnRyeS5mYWlsZWRBdCA9IHBlcmZvcm1hbmNlLm5vdygpOyBjb25zb2xlLndhcm4oJ0xvY2FsIE1vb24gcGljdHVyZSBub3QgYXZhaWxhYmxlOicsIGMudXJsKTsgfVxuICAgICAgICByZXR1cm4gcmFzdGVyO1xuICAgICAgfSkoKS5maW5hbGx5KCgpID0+IHsgZW50cnkucGVuZGluZyA9IG51bGw7IH0pOyAvLyBhIHNldHRsZWQgcHJvbWlzZSBtdXN0IG5vdCBrZWVwIGFuIGV2aWN0ZWQgaW1hZ2UgYWxpdmVcbiAgICAgIGJhc2VQaWN0dXJlcy5zZXQoYy51cmwsIChlID0gZW50cnkpKTtcbiAgICB9XG4gICAgaWYgKGUucmFzdGVyKSB0b3VjaERlY29kZWQoYGJhc2U6JHtjLnVybH1gKTtcbiAgICByZXR1cm4gZTtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIHJ1bkJhc2Uoam9iOiBFeHRyYWN0PEpvYiwgeyBraW5kOiAnYmFzZScgfT4sIGZsaXA6IGJvb2xlYW4pOiBQcm9taXNlPERyYXduPiB7XG4gICAgY29uc3QgYmlnID0gYmFzZVBpY3R1cmUoam9iLmN1dCk7XG4gICAgbGV0IGN1dCA9IGpvYi5jdXQsIHJhc3RlciA9IGJpZy5yYXN0ZXI7XG4gICAgaWYgKCFyYXN0ZXIgJiYgam9iLnF1aWNrKSB7IC8vIHRoZSBiaWcgcGljdHVyZSBpcyBzdGlsbCBiZWluZyBkZWNvZGVkOiB0aGUgc21hbGwgb25lIGhhcyB0aGUgc2FtZSBwaXhlbHMgYXQgdGhpcyBsZXZlbFxuICAgICAgY29uc3Qgc21hbGwgPSBhd2FpdCBiYXNlUGljdHVyZShqb2IucXVpY2spLnByb21pc2U7XG4gICAgICBpZiAoc21hbGwgJiYgIWJpZy5yYXN0ZXIpIHsgY3V0ID0gam9iLnF1aWNrOyByYXN0ZXIgPSBzbWFsbDsgfVxuICAgIH1cbiAgICByYXN0ZXIgPz89IGF3YWl0IGJpZy5wcm9taXNlO1xuICAgIGNvbnN0IHNyYyA9IHJhc3Rlcj8ubGV2ZWxzW2N1dC5taXBdO1xuICAgIGlmICghc3JjKSByZXR1cm4geyBweDogbnVsbCwgZ2FwczogdHJ1ZSB9O1xuICAgIHJldHVybiB7IHB4OiBjdXRUaWxlKHNyYywgY3V0LnB4LCBjdXQucHksIGZsaXApLCBnYXBzOiBmYWxzZSB9O1xuICB9XG5cbiAgZnVuY3Rpb24gcmFzdGVyRm9yKHVybDogc3RyaW5nKTogUHJvbWlzZTxSYXN0ZXIgfCBudWxsPiB7XG4gICAgbGV0IGUgPSByYXN0ZXJzLmdldCh1cmwpO1xuICAgIGlmIChlICYmIGUuZmFpbGVkQXQgJiYgIXN0aWxsRmFpbGluZyhlLmZhaWxlZEF0LCB1cmwpKSB7IHJhc3RlcnMuZGVsZXRlKHVybCk7IGUgPSB1bmRlZmluZWQ7IH0gLy8gdHJ5IGEgZmFpbGVkIHBpY3R1cmUgYWdhaW5cbiAgICBpZiAoIWUpIHtcbiAgICAgIGNvbnN0IGVudHJ5OiBSYXN0ZXJFbnRyeSA9IHsgcGVuZGluZzogbnVsbCwgcmFzdGVyOiBudWxsLCBmYWlsZWRBdDogMCxcbiAgICAgICAgZ2V0IHByb21pc2UoKSB7IHJldHVybiB0aGlzLnBlbmRpbmcgPz8gUHJvbWlzZS5yZXNvbHZlKHRoaXMucmFzdGVyKTsgfSB9O1xuICAgICAgZW50cnkucGVuZGluZyA9IChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJsb2IgPSBhd2FpdCBmZXRjaEJsb2IodXJsKTtcbiAgICAgICAgY29uc3QgcmFzdGVyID0gYmxvYiAmJiBibG9iICE9PSAnbWlzc2luZycgPyBhd2FpdCBkZWNvZGVSYXN0ZXIoYmxvYikuY2F0Y2goKCkgPT4gbnVsbCkgOiBudWxsO1xuICAgICAgICBpZiAoIXJhc3RlcikgeyBlbnRyeS5mYWlsZWRBdCA9IHBlcmZvcm1hbmNlLm5vdygpOyBjb25zb2xlLndhcm4oJ1BvbGFyIG1hcCBub3QgYXZhaWxhYmxlOicsIHVybCk7IHJldHVybiBudWxsOyB9IC8vIHRyYW5zcGFyZW50LCBuZXZlciBhIGJsYWNrIGdsb2JlXG4gICAgICAgIGVudHJ5LnJhc3RlciA9IHJhc3RlcjtcbiAgICAgICAgcmVnaXN0ZXJEZWNvZGVkKGByYXN0ZXI6JHt1cmx9YCwgcmFzdGVyQnl0ZXMocmFzdGVyKSwgKCkgPT4ge1xuICAgICAgICAgIGVudHJ5LnJhc3RlciA9IG51bGw7XG4gICAgICAgICAgaWYgKHJhc3RlcnMuZ2V0KHVybCkgPT09IGVudHJ5KSByYXN0ZXJzLmRlbGV0ZSh1cmwpO1xuICAgICAgICB9LCAncmFzdGVyJyk7XG4gICAgICAgIHJldHVybiByYXN0ZXI7XG4gICAgICB9KSgpLmZpbmFsbHkoKCkgPT4geyBlbnRyeS5wZW5kaW5nID0gbnVsbDsgfSk7XG4gICAgICByYXN0ZXJzLnNldCh1cmwsIGUgPSBlbnRyeSk7XG4gICAgfVxuICAgIGlmIChlLnJhc3RlcikgdG91Y2hEZWNvZGVkKGByYXN0ZXI6JHt1cmx9YCk7XG4gICAgcmV0dXJuIGUucHJvbWlzZTtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIHJ1blJhc3Rlcihqb2I6IEV4dHJhY3Q8Sm9iLCB7IGtpbmQ6ICdyYXN0ZXInIH0+LCBmbGlwOiBib29sZWFuKTogUHJvbWlzZTxEcmF3bj4ge1xuICAgIGNvbnN0IHJhc3RlciA9IGF3YWl0IHJhc3RlckZvcihqb2IudXJsKTtcbiAgICBpZiAoIXJhc3RlcikgcmV0dXJuIHsgcHg6IG51bGwsIGdhcHM6IHRydWUgfTtcbiAgICBjb25zdCBwbGFuID0gcGxhblJhc3RlcihmcCwgam9iLnJlY3QsIHJhc3Rlciwgam9iLmV4dGVudE0sIGpvYi5jbGlwVHJ1ZUxhdCwgam9iLmZlYXRoZXJNKTtcbiAgICByZXR1cm4geyBweDogcGxhbiA/IHNhbXBsZVRpbGVzKGZwLCBwbGFuLmdyaWRzLCBbMF0sIFtwbGFuLnNyY10sIGZsaXApIDogbnVsbCwgZ2FwczogZmFsc2UgfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHNjaWVuY2VSYXN0ZXJGb3Ioc291cmNlOiBTY2llbmNlUmFzdGVyU291cmNlKTogUHJvbWlzZTxSYXN0ZXIgfCBudWxsPiB7XG4gICAgY29uc3QgdXJsID0gc291cmNlLnVybDtcbiAgICBsZXQgZSA9IHNjaWVuY2VSYXN0ZXJzLmdldCh1cmwpO1xuICAgIGlmIChzb3VyY2UucGFsZXR0ZSAmJiAhc2NpZW5jZVBhbGV0dGVzLmhhcyh1cmwpKSB7XG4gICAgICBzY2llbmNlUGFsZXR0ZXMuc2V0KHVybCwgc2NpZW5jZVBhbGV0dGUoc291cmNlLnBhbGV0dGUpKTtcbiAgICAgIC8vIEEgcGFuZWwgdmFsdWUgbWF5IGFzayBmb3IgdGhpcyBieXRlIGdyaWQgYmVmb3JlIHRoZSBzdGFydCBzY3JlZW4gcHJlcGFyZXMgaXRzIGNvbG91cnMuXG4gICAgICAvLyBSZXVzZSB0aGF0IHNhbWUgc2hhcnAgZ3JpZCB3aGVuIHVwZ3JhZGluZyBpdCB0byBhIHJlbmRlcmVkIG1hcC5cbiAgICAgIGlmIChlPy5yYXN0ZXIpIHsgdW5yZWdpc3RlckRlY29kZWQoYHNjaWVuY2U6JHt1cmx9YCk7IHNjaWVuY2VSYXN0ZXJzLmRlbGV0ZSh1cmwpOyBlID0gdW5kZWZpbmVkOyB9XG4gICAgfVxuICAgIGlmIChlICYmIGUuZmFpbGVkQXQgJiYgIXN0aWxsRmFpbGluZyhlLmZhaWxlZEF0LCB1cmwpKSB7IHNjaWVuY2VSYXN0ZXJzLmRlbGV0ZSh1cmwpOyBlID0gdW5kZWZpbmVkOyB9XG4gICAgaWYgKCFlKSB7XG4gICAgICBjb25zdCBlbnRyeTogUmFzdGVyRW50cnkgPSB7IHBlbmRpbmc6IG51bGwsIHJhc3RlcjogbnVsbCwgZmFpbGVkQXQ6IDAsXG4gICAgICAgIGdldCBwcm9taXNlKCkgeyByZXR1cm4gdGhpcy5wZW5kaW5nID8/IFByb21pc2UucmVzb2x2ZSh0aGlzLnJhc3Rlcik7IH0gfTtcbiAgICAgIGVudHJ5LnBlbmRpbmcgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBibG9iID0gYXdhaXQgZmV0Y2hCbG9iKHVybCk7XG4gICAgICAgIGlmICghYmxvYiB8fCBibG9iID09PSAnbWlzc2luZycpIHsgZW50cnkuZmFpbGVkQXQgPSBwZXJmb3JtYW5jZS5ub3coKTsgcmV0dXJuIG51bGw7IH1cbiAgICAgICAgLy8gTGFyZ2UgbWFwcyBkZWNvZGUgb25lIGF0IGEgdGltZSwgYmVzaWRlIHRoZSBwaG90byB3b3JrZXJzIHJhdGhlciB0aGFuIG9uIHRoZSBVSSB0aHJlYWQuXG4gICAgICAgIGNvbnN0IGJlZm9yZSA9IHJhc3RlckRlY29kZVRhaWw7XG4gICAgICAgIGxldCByZWxlYXNlITogKCkgPT4gdm9pZDtcbiAgICAgICAgcmFzdGVyRGVjb2RlVGFpbCA9IG5ldyBQcm9taXNlPHZvaWQ+KHJlc29sdmUgPT4geyByZWxlYXNlID0gcmVzb2x2ZTsgfSk7XG4gICAgICAgIGRlY29kZXNRdWV1ZWQrKzsgYXdhaXQgYmVmb3JlOyBkZWNvZGVzUXVldWVkLS07XG4gICAgICAgIGxldCByYXN0ZXI6IFJhc3RlciB8IG51bGwgPSBudWxsO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IGZ1bGwgPSBhd2FpdCBkZWNvZGUoYmxvYiksIHBhbGV0dGUgPSBzY2llbmNlUGFsZXR0ZXMuZ2V0KHVybCk7XG4gICAgICAgICAgcmFzdGVyID0gcGFsZXR0ZSA/IGJ1aWxkU2NpZW5jZU1pcHMoZnVsbCwgcGFsZXR0ZSkgOiB7IGxldmVsczogW2Z1bGxdIH07XG4gICAgICAgICAgLy8gT3JkaW5hcnkgY29sb3VyZWQgbGVnYWN5IHNvdXRoLXBvbGUgcGljdHVyZXMgc3RpbGwgbmVlZCBjb2xvdXIgbWlwcy5cbiAgICAgICAgICBpZiAoIXBhbGV0dGUgJiYgZnVsbC5jaCAhPT0gMSkgcmFzdGVyID0gYnVpbGRNaXBzKGZ1bGwpO1xuICAgICAgICB9XG4gICAgICAgIGNhdGNoIHsgZW50cnkuZmFpbGVkQXQgPSBwZXJmb3JtYW5jZS5ub3coKTsgfVxuICAgICAgICBmaW5hbGx5IHsgcmVsZWFzZSgpOyB9XG4gICAgICAgIGlmICghcmFzdGVyKSByZXR1cm4gbnVsbDtcbiAgICAgICAgZW50cnkucmFzdGVyID0gcmFzdGVyO1xuICAgICAgICByZWdpc3RlckRlY29kZWQoYHNjaWVuY2U6JHt1cmx9YCwgcmFzdGVyQnl0ZXMocmFzdGVyKSwgKCkgPT4ge1xuICAgICAgICAgIGVudHJ5LnJhc3RlciA9IG51bGw7XG4gICAgICAgICAgaWYgKHNjaWVuY2VSYXN0ZXJzLmdldCh1cmwpID09PSBlbnRyeSkgc2NpZW5jZVJhc3RlcnMuZGVsZXRlKHVybCk7XG4gICAgICAgIH0sICdyYXN0ZXInKTtcbiAgICAgICAgcmV0dXJuIHJhc3RlcjtcbiAgICAgIH0pKCkuZmluYWxseSgoKSA9PiB7IGVudHJ5LnBlbmRpbmcgPSBudWxsOyB9KTtcbiAgICAgIHNjaWVuY2VSYXN0ZXJzLnNldCh1cmwsIGUgPSBlbnRyeSk7XG4gICAgfVxuICAgIGlmIChlLnJhc3RlcikgdG91Y2hEZWNvZGVkKGBzY2llbmNlOiR7dXJsfWApO1xuICAgIHJldHVybiBlLnByb21pc2U7XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBydW5TY2llbmNlKGpvYjogRXh0cmFjdDxKb2IsIHsga2luZDogJ3NjaWVuY2UnIH0+LCBmbGlwOiBib29sZWFuKTogUHJvbWlzZTxEcmF3bj4ge1xuICAgIGxldCBvdXQ6IFVpbnQ4Q2xhbXBlZEFycmF5PEFycmF5QnVmZmVyPiB8IG51bGwgPSBudWxsLCBnYXBzID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCBzb3VyY2Ugb2Ygam9iLnNvdXJjZXMpIHtcbiAgICAgIGNvbnN0IHJhbmdlID0gdGlsZVRydWVMYXRSYW5nZShqb2IucmVjdCksIG5vcnRoID0gc291cmNlLnBvbGUgPT09ICdub3J0aCcsIGNsaXAgPSBzb3VyY2UuY2xpcFRydWVMYXREZWcgPz8gKG5vcnRoID8gODAgOiAtODApO1xuICAgICAgaWYgKHNvdXJjZS5wcm9qZWN0aW9uID09PSAncG9sYXInICYmIChub3J0aCA/IHJhbmdlLm1heERlZyA8PSBjbGlwIC0gcGl4ZWxEZWcoam9iLmxldmVsKSA6IHJhbmdlLm1pbkRlZyA+PSBjbGlwICsgcGl4ZWxEZWcoam9iLmxldmVsKSkpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgcmFzdGVyID0gYXdhaXQgc2NpZW5jZVJhc3RlckZvcihzb3VyY2UpO1xuICAgICAgaWYgKCFyYXN0ZXIpIHsgZ2FwcyA9IHRydWU7IGNvbnRpbnVlOyB9XG4gICAgICBpZiAoc291cmNlLnByb2plY3Rpb24gPT09ICdnbG9iYWwnKSBzY2llbmNlR2xvYmFsRm9vdHByaW50KGZwLCBqb2IucmVjdCwgam9iLmxldmVsLCByYXN0ZXIpO1xuICAgICAgZWxzZSB7XG4gICAgICAgIGNvbnN0IGhhbGZNID0gc291cmNlLmV4dGVudE0gPz8gMzA0MDAwO1xuICAgICAgICBpZiAoIXBvbGFyR2VvbWV0cnkoZnAsIGpvYi5yZWN0LCBwb2xhclJobygtTWF0aC5hYnMoY2xpcCkpLCAwLCBoYWxmTSwgbm9ydGgpKSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgYmFzZSA9IHJhc3Rlci5sZXZlbHNbMF0sIHB4TSA9ICgoam9iLnJlY3Qubm9ydGggLSBqb2IucmVjdC5zb3V0aCkgLyBUSUxFKSAqIE1PT05fUjtcbiAgICAgICAgY29uc3QgbSA9IGNsYW1wKE1hdGguZmxvb3IoTWF0aC5sb2cyKHB4TSAvICgoMiAqIGhhbGZNKSAvIGJhc2UudykpKSwgMCwgcmFzdGVyLmxldmVscy5sZW5ndGggLSAxKSwgcyA9IHJhc3Rlci5sZXZlbHNbbV07XG4gICAgICAgIGZwLmx2bC5maWxsKG0pOyBwb2xhckNvb3JkcyhmcCwgaGFsZk0sIHMudyAvICgyICogaGFsZk0pLCBzLmggLyAoMiAqIGhhbGZNKSk7XG4gICAgICB9XG4gICAgICBpZiAoc291cmNlLm1heGltdW1UcnVlTGF0RGVnICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgLy8gV2lkZSBwb2xhciBwcm9kdWN0cyBjYW4gc3RvcCB3aGVyZSBhIHNoYXJwZXIgaW5uZXIgY2FwIHRha2VzIG92ZXIuXG4gICAgICAgIGNvbnN0IGRlbiA9IDIgKiBNT09OX1IsIGxpbWl0ID0gc291cmNlLm1heGltdW1UcnVlTGF0RGVnO1xuICAgICAgICBpZiAoc291cmNlLnByb2plY3Rpb24gPT09ICdwb2xhcicpIGZvciAobGV0IHAgPSAwOyBwIDwgTjI7IHArKykge1xuICAgICAgICAgIGNvbnN0IGFic29sdXRlTGF0ID0gOTAgLSAyICogTWF0aC5hdGFuKE1hdGguaHlwb3QoZnAuYVtwXSwgZnAuYltwXSkgLyBkZW4pIC8gREVHO1xuICAgICAgICAgIGlmIChhYnNvbHV0ZUxhdCA+IGxpbWl0KSBmcC5jb3ZbcF0gPSAwO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBjb25zdCBweCA9IHNhbXBsZVNjaWVuY2UoZnAsIHJhc3Rlciwgc2NpZW5jZVBhbGV0dGVzLmdldChzb3VyY2UudXJsKSwgc291cmNlLnByb2plY3Rpb24gPT09ICdnbG9iYWwnLCBmbGlwKTtcbiAgICAgIGlmICghcHggJiYgIXNvdXJjZS5yZXBsYWNlKSBjb250aW51ZTtcbiAgICAgIG91dCA/Pz0gbmV3IFVpbnQ4Q2xhbXBlZEFycmF5KE4yICogNCk7XG4gICAgICBjb21wb3NpdGVTY2llbmNlUGl4ZWxzKG91dCwgcHgsIGZwLmNvdiwgZmxpcCwgc291cmNlLnJlcGxhY2UpO1xuICAgIH1cbiAgICBpZiAob3V0KSBmaWxsQ2xlYXIob3V0KTtcbiAgICByZXR1cm4geyBweDogb3V0LCBnYXBzIH07XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBzY2llbmNlVmFsdWUoc291cmNlOiBTY2llbmNlUmFzdGVyU291cmNlLCBsYXQ6IG51bWJlciwgbG9uOiBudW1iZXIpOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgICBjb25zdCBzID0gKGF3YWl0IHNjaWVuY2VSYXN0ZXJGb3Ioc291cmNlKSk/LmxldmVsc1swXTtcbiAgICBpZiAoIXMgfHwgcy5jaCAhPT0gMSkgcmV0dXJuIG51bGw7XG4gICAgbGV0IGNvbDogbnVtYmVyLCByb3c6IG51bWJlcjtcbiAgICBpZiAoc291cmNlLnByb2plY3Rpb24gPT09ICdnbG9iYWwnKSB7XG4gICAgICBjb2wgPSBNYXRoLmZsb29yKCgoKGxvbiArIDE4MCkgJSAzNjAgKyAzNjApICUgMzYwKSAvIDM2MCAqIHMudyk7XG4gICAgICByb3cgPSBjbGFtcChNYXRoLmZsb29yKCg5MCAtIGxhdCkgLyAxODAgKiBzLmgpLCAwLCBzLmggLSAxKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3Qgbm9ydGggPSBzb3VyY2UucG9sZSA9PT0gJ25vcnRoJywgY2xpcCA9IHNvdXJjZS5jbGlwVHJ1ZUxhdERlZyA/PyAobm9ydGggPyA4MCA6IC04MCk7XG4gICAgICBpZiAobm9ydGggPyBsYXQgPCBjbGlwIDogbGF0ID4gY2xpcCkgcmV0dXJuIG51bGw7XG4gICAgICBpZiAoc291cmNlLm1heGltdW1UcnVlTGF0RGVnICE9PSB1bmRlZmluZWQgJiYgTWF0aC5hYnMobGF0KSA+IHNvdXJjZS5tYXhpbXVtVHJ1ZUxhdERlZykgcmV0dXJuIG51bGw7XG4gICAgICBjb25zdCByaG8gPSAyICogTU9PTl9SICogTWF0aC50YW4oKDkwIC0gTWF0aC5hYnMobGF0KSkgKiBERUcgLyAyKSwgaGFsZiA9IHNvdXJjZS5leHRlbnRNID8/IDMwNDAwMDtcbiAgICAgIGNvbnN0IHggPSByaG8gKiBNYXRoLnNpbihsb24gKiBERUcpLCB5ID0gKG5vcnRoID8gLTEgOiAxKSAqIHJobyAqIE1hdGguY29zKGxvbiAqIERFRyk7XG4gICAgICBjb2wgPSBNYXRoLmZsb29yKCh4ICsgaGFsZikgLyAoMiAqIGhhbGYpICogcy53KTsgcm93ID0gTWF0aC5mbG9vcigoaGFsZiAtIHkpIC8gKDIgKiBoYWxmKSAqIHMuaCk7XG4gICAgICBpZiAoY29sIDwgMCB8fCByb3cgPCAwIHx8IGNvbCA+PSBzLncgfHwgcm93ID49IHMuaCkgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIGNvbnN0IHZhbHVlID0gcy5kYXRhW3JvdyAqIHMudyArIGNvbF07XG4gICAgcmV0dXJuIHZhbHVlID09PSAyNTUgPyBudWxsIDogdmFsdWU7XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBoYW5kbGUoeyBpZCwgam9iLCBmbGlwUm93cyB9OiBFeHRyYWN0PFRvV29ya2VyLCB7IGpvYjogSm9iIH0+KSB7XG4gICAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICBqb2JzLnNldChpZCwgY29udHJvbGxlcik7XG4gICAgbGV0IGJpdG1hcDogSW1hZ2VCaXRtYXAgfCBudWxsID0gbnVsbCwgZ2FwcyA9IHRydWUsIHBhcmVudCA9IGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBkID0gam9iLmtpbmQgPT09ICd0cmVrJyA/IGF3YWl0IHJ1blRyZWsoam9iLCBmbGlwUm93cykgOiBqb2Iua2luZCA9PT0gJ3B5cmFtaWQnID8gYXdhaXQgcnVuUHlyYW1pZChqb2IsIGZsaXBSb3dzKVxuICAgICAgICA6IGpvYi5raW5kID09PSAnYmFzZScgPyBhd2FpdCBydW5CYXNlKGpvYiwgZmxpcFJvd3MpIDogam9iLmtpbmQgPT09ICdzeW50aCcgPyBhd2FpdCBydW5TeW50aChqb2IsIGZsaXBSb3dzKVxuICAgICAgICA6IGpvYi5raW5kID09PSAncGhvdG8nID8gYXdhaXQgcnVuUGhvdG8oam9iLCBmbGlwUm93cywgY29udHJvbGxlci5zaWduYWwpIDogam9iLmtpbmQgPT09ICdzY2llbmNlJyA/IGF3YWl0IHJ1blNjaWVuY2Uoam9iLCBmbGlwUm93cykgOiBhd2FpdCBydW5SYXN0ZXIoam9iLCBmbGlwUm93cyk7XG4gICAgICBjb250cm9sbGVyLnNpZ25hbC50aHJvd0lmQWJvcnRlZCgpO1xuICAgICAgZ2FwcyA9IGQuZ2FwczsgcGFyZW50ID0gISFkLnBhcmVudDtcbiAgICAgIGlmIChkLnB4KSBiaXRtYXAgPSBhd2FpdCBjcmVhdGVJbWFnZUJpdG1hcChuZXcgSW1hZ2VEYXRhKGQucHgsIFRJTEUsIFRJTEUpLCB7IHByZW11bHRpcGx5QWxwaGE6ICdub25lJywgY29sb3JTcGFjZUNvbnZlcnNpb246ICdub25lJyB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGlmICghY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkgY29uc29sZS53YXJuKCdJbWFnZXJ5IHRpbGUgZmFpbGVkOicsIGVycik7IC8vIHRoZSBtYWluIHRocmVhZCBzaG93cyBhIHRyYW5zcGFyZW50IHRpbGUgaW5zdGVhZFxuICAgIH1cbiAgICBqb2JzLmRlbGV0ZShpZCk7XG4gICAgaWYgKGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHsgYml0bWFwPy5jbG9zZSgpOyBiaXRtYXAgPSBudWxsOyBnYXBzID0gZmFsc2U7IHBhcmVudCA9IHRydWU7IH1cbiAgICBjb25zdCBtc2c6IEZyb21Xb3JrZXIgPSB7IGlkLCBiaXRtYXAsIGdhcHMsIHJlY292ZXJlZCwgcGFyZW50LCBuZXQ6IFtuZXRbMF0sIG5ldFsxXSwgbmV0WzJdXSwgdHJhZmZpYywgY2FjaGU6IGRlY29kZWRDYWNoZVN0YXRzKCkgfTtcbiAgICByZWNvdmVyZWQgPSBmYWxzZTtcbiAgICBzZWxmLnBvc3RNZXNzYWdlKG1zZywgeyB0cmFuc2ZlcjogYml0bWFwID8gW2JpdG1hcF0gOiBbXSB9KTtcbiAgfVxuXG4gIHNlbGYub25tZXNzYWdlID0gKGU6IE1lc3NhZ2VFdmVudDxUb1dvcmtlcj4pID0+IHtcbiAgICBjb25zdCBtID0gZS5kYXRhO1xuICAgIGlmICgncGhvdG9WaWV3JyBpbiBtKSB7IHBob3RvVmlldyA9IG0ucGhvdG9WaWV3OyByZXR1cm47IH1cbiAgICBpZiAoJ2NhY2hlQnVkZ2V0Qnl0ZXMnIGluIG0pIHtcbiAgICAgIGlmIChOdW1iZXIuaXNGaW5pdGUobS5jYWNoZUJ1ZGdldEJ5dGVzKSAmJiBtLmNhY2hlQnVkZ2V0Qnl0ZXMgPj0gMiAqKiAyMCkgeyBkZWNvZGVkQnVkZ2V0Qnl0ZXMgPSBtLmNhY2hlQnVkZ2V0Qnl0ZXM7IHRyaW1EZWNvZGVkKCk7IH1cbiAgICB9XG4gICAgZWxzZSBpZiAoJ2NhbmNlbCcgaW4gbSkgam9icy5nZXQobS5jYW5jZWwpPy5hYm9ydCgpO1xuICAgIGVsc2UgaWYgKCdmb3JnZXRGYWlsdXJlcycgaW4gbSkgeyBmb3JnZXRCZWZvcmUgPSBwZXJmb3JtYW5jZS5ub3coKTsgZm9yIChjb25zdCBiIG9mIGJyZWFrZXJzLnZhbHVlcygpKSBiLmZhaWxzID0gMDsgfVxuICAgIGVsc2UgaWYgKCdweXJhbWlkSW5kZXgnIGluIG0pIHN0b3JlZCA9IHsgYmFzZTogbS5iYXNlLCBpbmRleDogcGFyc2VQeXJhbWlkSW5kZXgobS5weXJhbWlkSW5kZXgpIH07XG4gICAgLy8gZGVjb2RlIHRoZXNlIG1hcHMgbm93LCBvbmUgYWZ0ZXIgdGhlIG90aGVyLCBzbyB0aGF0IHN3aXRjaGluZyBvbmUgb24gbGF0ZXIgc2hvd3MgaXQgYXQgb25jZVxuICAgIGVsc2UgaWYgKCd3YXJtUmFzdGVycycgaW4gbSkgdm9pZCAoYXN5bmMgKCkgPT4geyBmb3IgKGNvbnN0IHUgb2YgbS53YXJtUmFzdGVycykgYXdhaXQgcmFzdGVyRm9yKHUpLmNhdGNoKCgpID0+IG51bGwpOyB9KSgpO1xuICAgIGVsc2UgaWYgKCd3YXJtU2NpZW5jZScgaW4gbSkgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgbGV0IG9rID0gdHJ1ZSwgZG9uZSA9IDA7XG4gICAgICBmb3IgKGNvbnN0IHNvdXJjZSBvZiBtLndhcm1TY2llbmNlKSB7XG4gICAgICAgIG9rID0gISEoYXdhaXQgc2NpZW5jZVJhc3RlckZvcihzb3VyY2UpLmNhdGNoKCgpID0+IG51bGwpKSAmJiBvaztcbiAgICAgICAgc2VsZi5wb3N0TWVzc2FnZSh7IGlkOiAwLCBiaXRtYXA6IG51bGwsIGdhcHM6IGZhbHNlLCByZWNvdmVyZWQ6IGZhbHNlLCB3YXJtZWQ6IG0ud2FybUlkLCB3YXJtRnJhYzogKytkb25lIC8gbS53YXJtU2NpZW5jZS5sZW5ndGgsIHdhcm1Pazogb2ssIGNhY2hlOiBkZWNvZGVkQ2FjaGVTdGF0cygpIH0gc2F0aXNmaWVzIEZyb21Xb3JrZXIpO1xuICAgICAgfVxuICAgICAgaWYgKCFtLndhcm1TY2llbmNlLmxlbmd0aCkgc2VsZi5wb3N0TWVzc2FnZSh7IGlkOiAwLCBiaXRtYXA6IG51bGwsIGdhcHM6IGZhbHNlLCByZWNvdmVyZWQ6IGZhbHNlLCB3YXJtZWQ6IG0ud2FybUlkLCB3YXJtRnJhYzogMSwgd2FybU9rOiB0cnVlIH0gc2F0aXNmaWVzIEZyb21Xb3JrZXIpO1xuICAgIH0pKCk7XG4gICAgZWxzZSBpZiAoJ3NjaWVuY2VWYWx1ZScgaW4gbSkgdm9pZCBzY2llbmNlVmFsdWUobS5zY2llbmNlVmFsdWUuc291cmNlLCBtLnNjaWVuY2VWYWx1ZS5sYXQsIG0uc2NpZW5jZVZhbHVlLmxvbikudGhlbih2YWx1ZSA9PiB7XG4gICAgICBzZWxmLnBvc3RNZXNzYWdlKHsgaWQ6IDAsIGJpdG1hcDogbnVsbCwgZ2FwczogZmFsc2UsIHJlY292ZXJlZDogZmFsc2UsIHZhbHVlSWQ6IG0udmFsdWVJZCwgdmFsdWUgfSBzYXRpc2ZpZXMgRnJvbVdvcmtlcik7XG4gICAgfSkuY2F0Y2goKCkgPT4gc2VsZi5wb3N0TWVzc2FnZSh7IGlkOiAwLCBiaXRtYXA6IG51bGwsIGdhcHM6IGZhbHNlLCByZWNvdmVyZWQ6IGZhbHNlLCB2YWx1ZUlkOiBtLnZhbHVlSWQsIHZhbHVlOiBudWxsIH0gc2F0aXNmaWVzIEZyb21Xb3JrZXIpKTtcbiAgICBlbHNlIHZvaWQgaGFuZGxlKG0pO1xuICB9O1xufVxuXG5pZiAodHlwZW9mIChnbG9iYWxUaGlzIGFzIHsgV29ya2VyR2xvYmFsU2NvcGU/OiB1bmtub3duIH0pLldvcmtlckdsb2JhbFNjb3BlID09PSAnZnVuY3Rpb24nKSBzdGFydFdvcmtlcigpO1xuIl0sImZpbGUiOiIvVm9sdW1lcy9Db2RleFdvcmsvUHJvamVjdHMvTU9PTkRBL2FwcC9zcmMvbW9vbi9pbWFnZXJ5V29ya2VyLnRzIn0=