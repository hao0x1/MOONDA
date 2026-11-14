// Checks for the imagery re-projection in src/moon/imageryWorker.ts (the code the workers run).
// Run: node scripts/check-imagery.ts            (math only, no network)
//      node scripts/check-imagery.ts --network        (also checks Moon Trek's real WMTS descriptions)
//      node scripts/check-imagery.ts --visual <dir>   (also renders real NASA tiles to PNGs in <dir>; needs network + macOS `sips`)
// The worker's message loop and the layers' reload logic are checked by scripts/check-imagery-runtime.ts.
//
// The worker re-implements the display->true formulas (it must not load Cesium), so most checks
// compare it against the independent helpers in frame.ts / heights.ts.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cartographic, Ellipsoid, GeographicTilingScheme } from 'cesium';
import { displayToTrueLatLon, polarMapFromDisplayUnit, trueToDisplayLatLon } from '../src/moon/frame.ts';
import { toMap } from '../src/science/heights.ts';
import {
  Footprint, KEY_LEVEL, PYRAMID_MAX_K, PYRAMID_NAC_LAT_DEG, PYRAMID_WAC_MAX_K, Packer, POLAR_FEATHER_M, POLAR_LIMIT_DEG, PYRAMID_PX, TILE,
  buildMips, cutTile, fillClear, parsePyramidIndex, parseTrekDepth, pixelDeg,
  planPyramid, planRaster, planTrek, polarGeometry, polarRho, pyramidHasLocal, pyramidLevelFor, pyramidLocalUrl, pyramidMaxKFor,
  pyramidParentIsEnough, pyramidSurelyLocal, pyramidUrl, sampleTiles, tileTrueLatRange,
  FIX_BAND_EAST, FIX_BAND_WEST, fixShadeFor, fixWeightDeg, halvePoleAware, planSynth, sampleLonLat, tileFixRange, type FixParams,
  trekCapabilitiesUrl, trekGeometry, trekTileOf, trekUrl,
  type Plan, type Raster, type Rect, type Src,
} from '../src/moon/imageryWorker.ts';

const DEG = Math.PI / 180, R = 1737400, E = 304000;
const ts = new GeographicTilingScheme({ ellipsoid: Ellipsoid.MOON });
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const rectOf = (x: number, y: number, level: number): Rect => { const r = ts.tileXYToRectangle(x, y, level); return { west: r.west, south: r.south, east: r.east, north: r.north }; };
/** The display tile (and fractional pixel inside it, pixel centres at k + 0.5) where a TRUE lat/lon lands. */
function displayTileAt(trueLat: number, trueLon: number, level: number) {
  const d = trueToDisplayLatLon(trueLat, trueLon);
  const t = ts.positionToTileXY(new Cartographic(d.lon, d.lat), level)!;
  const rect = rectOf(t.x, t.y, level);
  return { x: t.x, y: t.y, rect, i: ((d.lon - rect.west) / (rect.east - rect.west)) * TILE, j: ((rect.north - d.lat) / (rect.north - rect.south)) * TILE };
}
const pixelCentre = (r: Rect, i: number, j: number) => ({ lon: r.west + ((i + 0.5) / TILE) * (r.east - r.west), lat: r.north - ((j + 0.5) / TILE) * (r.north - r.south) });
const grey = (w: number, h: number, f: (c: number, r: number) => number): Src => {
  const data = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) data[r * w + c] = f(c, r);
  return { w, h, ch: 1, data };
};
/** Value-weighted centroid of an output tile, in display pixel units (row 0 = north). */
function centroid(px: Uint8ClampedArray, flipRows: boolean) {
  let s = 0, si = 0, sj = 0;
  for (let o = 0; o < TILE; o++) for (let i = 0; i < TILE; i++) {
    const v = px[(o * TILE + i) * 4] * px[(o * TILE + i) * 4 + 3] / 255;
    if (v <= 0) continue;
    const j = flipRows ? o : TILE - 1 - o;
    s += v; si += v * (i + 0.5); sj += v * (j + 0.5);
  }
  return { i: si / s, j: sj / s };
}
const fp = new Footprint();
/** One source tile per plan key, made by f(level, column, row). */
const trekSources = (plan: Plan, f: (z: number, tx: number, ty: number) => Src | null) => plan.keys.map(k => { const t = trekTileOf(k); return f(t.z, t.x, t.y); });
/** First and last source column read by display pixel p (all its samples along true east, with bilinear neighbours). */
const tapColumns = (p: number) => { const k = fp.taps[p], u0 = fp.u[p] - 0.5 * (k - 1) * fp.step[p]; return [Math.floor(u0), Math.floor(u0 + (k - 1) * fp.step[p]) + 1]; };

// 1. Fast "which true latitudes does this display tile touch" test vs dense sampling --------------
{
  let worstLoose = 0, worstTight = 0;
  for (let n = 0; n < 3000; n++) {
    const level = Math.floor(rnd() * 12), x = Math.floor(rnd() * 2 ** (level + 1)), y = Math.floor(rnd() * 2 ** level);
    const r = rectOf(x, y, level), a = tileTrueLatRange(r);
    let lo = Infinity, hi = -Infinity;
    for (let q = 0; q <= 40; q++) for (let p = 0; p <= 40; p++) {
      const t = displayToTrueLatLon(r.south + (q / 40) * (r.north - r.south), r.west + (p / 40) * (r.east - r.west));
      lo = Math.min(lo, t.lat); hi = Math.max(hi, t.lat);
    }
    worstLoose = Math.max(worstLoose, a.minDeg - lo, hi - a.maxDeg); // must never be inside the sampled range
    worstTight = Math.max(worstTight, (lo - a.minDeg) / pixelDeg(level), (a.maxDeg - hi) / pixelDeg(level));
  }
  check('tileTrueLatRange bounds every sampled point', worstLoose < 1e-9, `worst overshoot ${worstLoose.toExponential(1)}°`);
  check('tileTrueLatRange is tight', worstTight < 3, `worst slack ${worstTight.toFixed(2)} display pixels (sampling is 6.4 px apart)`);
}

// 2. Worker per-pixel geometry vs frame.ts ------------------------------------------------------
{
  let worstLL = 0, worstXY = 0, worstXY2 = 0;
  for (let n = 0; n < 60; n++) {
    const level = 2 + Math.floor(rnd() * 10);
    const polar = n % 2 === 0;
    const t = polar ? displayTileAt(-80 - rnd() * 10, rnd() * 360 - 180, level) : null;
    const r = t ? t.rect : rectOf(Math.floor(rnd() * 2 ** (level + 1)), Math.floor(rnd() * 2 ** level), level);
    if (polar) polarGeometry(fp, r, polarRho(-75), 0, 1e9); else trekGeometry(fp, r, -90);
    for (let s = 0; s < 200; s++) {
      const i = Math.floor(rnd() * TILE), j = Math.floor(rnd() * TILE), p = j * TILE + i, c = pixelCentre(r, i, j);
      const tr = displayToTrueLatLon(c.lat, c.lon);
      if (!polar) {
        const dLon = Math.abs(((fp.b[p] / DEG - tr.lon + 540) % 360) - 180) * Math.cos(tr.lat * DEG);
        worstLL = Math.max(worstLL, Math.abs(fp.a[p] / DEG - tr.lat), dLon);
      } else {
        const cl = Math.cos(c.lat), [mx, my] = polarMapFromDisplayUnit(cl * Math.cos(c.lon), cl * Math.sin(c.lon), Math.sin(c.lat));
        const [ex, ey] = toMap(tr.lat, tr.lon);
        worstXY = Math.max(worstXY, Math.hypot(fp.a[p] - mx, fp.b[p] - my));
        worstXY2 = Math.max(worstXY2, Math.hypot(fp.a[p] - ex, fp.b[p] - ey));
      }
    }
  }
  check('display pixel -> true lat/lon matches frame.displayToTrueLatLon', worstLL < 1e-9, `worst ${worstLL.toExponential(1)}°`);
  check('display pixel -> polar map x/y matches frame.polarMapFromDisplayUnit', worstXY < 1e-6, `worst ${worstXY.toExponential(1)} m`);
  check('display pixel -> polar map x/y matches heights.toMap(true lat/lon)', worstXY2 < 1e-3, `worst ${worstXY2.toExponential(1)} m`);
}

// 3. Tycho (true 43.3°S 11.2°W) through Moon Trek at level 6 ------------------------------------
{
  const lat = -43.3, lon = -11.2, z = 6;
  const U = ((lon + 180) / 360) * TILE * 2 ** (z + 1), V = ((90 - lat) / 180) * TILE * 2 ** z; // independent arithmetic
  const tx = Math.floor(U / TILE), ty = Math.floor(V / TILE), lc = Math.floor(U - tx * TILE), lr = Math.floor(V - ty * TILE);
  console.log(`      Tycho -> Moon Trek level 6 tile x=${tx} y=${ty}, pixel (${(U - tx * TILE).toFixed(2)}, ${(V - ty * TILE).toFixed(2)})`);
  check('Tycho Moon Trek tile is 6/47/60, pixel (4, 101)', tx === 60 && ty === 47 && lc === 4 && lr === 101);
  check('Moon Trek URL uses {z}/{y}/{x}', trekUrl('LRO_WAC_Mosaic_Global_303ppd_v02', 'jpg', 6, 60, 47) === 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/6/47/60.jpg');
  const d = displayTileAt(lat, lon, 6);
  const plan = planTrek(fp, d.rect, 6, 8, -81)!;
  check('display level 6 samples Moon Trek level 6 and needs tile 6/47/60', plan.level === 6 && plan.keys.includes(6 * KEY_LEVEL + ty * 128 + tx), `display tile ${d.x},${d.y} needs ${plan.keys.length} source tiles`);
  const p = Math.floor(d.j) * TILE + Math.floor(d.i);
  check('Tycho display pixel samples within 1 source pixel of Tycho', Math.hypot(fp.u[p] + 0.5 - U, fp.v[p] + 0.5 - V) < 1, `off by ${Math.hypot(fp.u[p] + 0.5 - U, fp.v[p] + 0.5 - V).toFixed(2)} px`);
  // A bright 3x3 marker on Tycho's source pixel must show up on Tycho's display pixel.
  const srcs = trekSources(plan, (_z, x, y) => grey(TILE, TILE, (c, r) => (x === tx && y === ty && Math.abs(c - lc) <= 1 && Math.abs(r - lr) <= 1 ? 255 : 0)));
  const mlon = ((tx * TILE + lc + 0.5) / (TILE * 2 ** (z + 1))) * 360 - 180, mlat = 90 - ((ty * TILE + lr + 0.5) / (TILE * 2 ** z)) * 180;
  const md = displayTileAt(mlat, mlon, 6);
  for (const flip of [false, true]) {
    const out = sampleTiles(fp, plan.grids, plan.keys, srcs, flip)!;
    const c = centroid(out, flip);
    check(`Tycho marker lands on its display pixel (flipRows=${flip})`, Math.hypot(c.i - md.i, c.j - md.j) < 0.5, `centroid (${c.i.toFixed(2)}, ${c.j.toFixed(2)}) expected (${md.i.toFixed(2)}, ${md.j.toFixed(2)})`);
  }
  const a = sampleTiles(fp, plan.grids, plan.keys, srcs, false)!, b = sampleTiles(fp, plan.grids, plan.keys, srcs, true)!;
  let mirrored = true;
  for (let o = 0; o < TILE && mirrored; o++) for (let q = 0; q < TILE * 4; q++) if (a[o * TILE * 4 + q] !== b[(TILE - 1 - o) * TILE * 4 + q]) { mirrored = false; break; }
  check('flipRows only mirrors the row order', mirrored);
  // A failed source tile leaves exactly its part transparent, never smeared.
  const holed = plan.keys.map(k => (k === 6 * KEY_LEVEL + ty * 128 + tx ? null : grey(TILE, TILE, () => 200)));
  const out = sampleTiles(fp, plan.grids, plan.keys, holed, false)!;
  let bad = 0;
  for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) {
    const q = j * TILE + i, o = ((TILE - 1 - j) * TILE + i) * 4;
    const [c0, c1] = tapColumns(q), rv = Math.floor(fp.v[q]);
    const cols = [...Array(c1 - c0 + 1).keys()].map(n => Math.floor((c0 + n) / TILE)), rows = [rv, rv + 1].map(r => Math.floor(r / TILE));
    const allIn = cols.every(c => c === tx) && rows.every(r => r === ty);
    const noneIn = !(cols.includes(tx) && rows.includes(ty));
    if (allIn && out[o + 3] !== 0) bad++;
    if (noneIn && (out[o + 3] !== 255 || out[o] !== 200)) bad++;
  }
  check('missing source tile -> transparent there, untouched elsewhere', bad === 0, `${bad} wrong pixels`);
}

// 4. Shackleton (true 89.67°S 129.78°E) on the 4096 px polar photo ------------------------------
{
  const [x, y] = toMap(-89.67, 129.78);
  const col = ((x + E) / (2 * E)) * 4096, row = ((E - y) / (2 * E)) * 4096;
  console.log(`      Shackleton -> polar map (${(x / 1000).toFixed(2)} km, ${(y / 1000).toFixed(2)} km) -> photo4096 pixel (${col.toFixed(1)}, ${row.toFixed(1)}), 2048 px maps (${(col / 2).toFixed(1)}, ${(row / 2).toFixed(1)})`);
  check('Shackleton is at photo4096 pixel (2099, 2091)', Math.floor(col) === 2099 && Math.floor(row) === 2091);
  const mc = Math.floor(col), mr = Math.floor(row);
  const raster: Raster = buildMips(grey(4096, 4096, (c, r) => (Math.abs(c - mc) <= 1 && Math.abs(r - mr) <= 1 ? 255 : 0)));
  // where the marker's centre is on the real Moon (inverse stereographic, independent of the worker)
  const mx = ((mc + 0.5) / 4096) * 2 * E - E, my = E - ((mr + 0.5) / 4096) * 2 * E, rho = Math.hypot(mx, my);
  const mlat = -(90 - 2 * Math.atan(rho / (2 * R)) / DEG), mlon = Math.atan2(mx, my) / DEG;
  for (const level of [9, 11]) {
    const d = displayTileAt(mlat, mlon, level);
    const plan = planRaster(fp, d.rect, raster, E, POLAR_LIMIT_DEG, POLAR_FEATHER_M)!;
    const out = sampleTiles(fp, plan.grids, [0], [plan.src], false)!;
    const c = centroid(out, false);
    check(`Shackleton marker lands on its display pixel (level ${level}, full-size raster)`, plan.src.w === 4096 && Math.hypot(c.i - d.i, c.j - d.j) < 0.5,
      `centroid (${c.i.toFixed(2)}, ${c.j.toFixed(2)}) expected (${d.i.toFixed(2)}, ${d.j.toFixed(2)})`);
  }
  const far = displayTileAt(-89, 0, 4);
  check('zoomed-out tiles read a smaller copy of the raster (no sparkle)', planRaster(fp, far.rect, raster, E, POLAR_LIMIT_DEG, POLAR_FEATHER_M)!.src.w < 4096);
}

// 5. Polar pyramid levels, URLs and squares ---------------------------------------------------
{
  check('pyramid level per display level (7->3, 8->4, 13->9, 14->10, 18->10)',
    [7, 8, 13, 14, 18].map(pyramidLevelFor).join() === '3,4,9,10,10', [7, 8, 13, 14, 18].map(pyramidLevelFor).join());
  const [x, y] = toMap(-89.67, 129.78);
  const k = 10, S = (2 * E) / 2 ** k, i = Math.floor((x + E) / S), j = Math.floor((E - y) / S);
  const bbox = /BBOX=([^&]+)/.exec(pyramidUrl('luna_wac_global,luna_nac_pole_control_south', k, i, j))![1].split(',').map(Number);
  check('pyramid k=10 square around Shackleton has Shackleton inside its BBOX', bbox[0] <= x && x <= bbox[2] && bbox[1] <= y && y <= bbox[3], `square ${i},${j} bbox ${bbox.map(v => v.toFixed(2)).join(',')}`);
  const lvl = 12, kk = pyramidLevelFor(lvl), d = displayTileAt(-89.67, 129.78, lvl);
  const plan = planPyramid(fp, d.rect, lvl, 4)!;
  const S2 = (2 * E) / 2 ** kk, gc = ((x + E) / S2) * PYRAMID_PX, gr = ((E - y) / S2) * PYRAMID_PX;
  const ti = Math.floor(gc / PYRAMID_PX), tj = Math.floor(gr / PYRAMID_PX), lc = Math.floor(gc - ti * PYRAMID_PX), lr = Math.floor(gr - tj * PYRAMID_PX);
  check(`display level ${lvl} uses pyramid k=${kk} and needs Shackleton's square`, plan.level === kk && plan.keys.includes(tj * 2 ** kk + ti), `${plan.keys.length} squares`);
  const srcs = plan.keys.map(q => grey(PYRAMID_PX, PYRAMID_PX, (c, r) => (q === tj * 2 ** kk + ti && Math.abs(c - lc) <= 2 && Math.abs(r - lr) <= 2 ? 255 : 0)));
  const mx = ((ti * PYRAMID_PX + lc + 0.5) / PYRAMID_PX) * S2 - E, my = E - ((tj * PYRAMID_PX + lr + 0.5) / PYRAMID_PX) * S2, rho = Math.hypot(mx, my);
  const md = displayTileAt(-(90 - 2 * Math.atan(rho / (2 * R)) / DEG), Math.atan2(mx, my) / DEG, lvl);
  const c = centroid(sampleTiles(fp, plan.grids, plan.keys, srcs, false)!, false);
  check('Shackleton pyramid marker lands on its display pixel', Math.hypot(c.i - md.i, c.j - md.j) < 0.5, `centroid (${c.i.toFixed(2)}, ${c.j.toFixed(2)}) expected (${md.i.toFixed(2)}, ${md.j.toFixed(2)})`);
  check('pyramid draws nothing below minK', planPyramid(fp, displayTileAt(-89.67, 129.78, 7).rect, 7, 4) === null);
}

// 6. No seams: neighbouring display tiles continue each other smoothly ---------------------------
{
  // A smooth test picture; a seam would show up as a jump much bigger than the picture's own curvature.
  const wave = (gx: number, gy: number) => 128 + 90 * Math.sin(gx / 6.1) * Math.cos(gy / 4.3);
  // the global test picture must itself wrap around in longitude, so use a whole number of waves around the Moon
  const trekSmooth = (plan: Plan) => trekSources(plan, (z, x, y) => {
    const W = TILE * 2 ** (z + 1), m = Math.round(W / (2 * Math.PI * 6.1));
    return grey(TILE, TILE, (c, r) => 128 + 90 * Math.sin((2 * Math.PI * m * (x * TILE + c)) / W) * Math.cos((y * TILE + r) / 4.3));
  });
  const renderTrek = (x: number, y: number, level: number) => { const plan = planTrek(fp, rectOf(x, y, level), level, 8, -90)!; return sampleTiles(fp, plan.grids, plan.keys, trekSmooth(plan), true)!; };
  const at = (px: Uint8ClampedArray, i: number, j: number) => px[(j * TILE + i) * 4];
  function seam(a: Uint8ClampedArray, b: Uint8ClampedArray, horizontal: boolean) {
    let interior = 0, edge = 0;
    for (let s = 0; s < TILE; s++) {
      const A = (k: number) => (horizontal ? at(a, k, s) : at(a, s, k)), B = (k: number) => (horizontal ? at(b, k, s) : at(b, s, k));
      for (let k = 1; k < TILE - 1; k++) interior = Math.max(interior, Math.abs(A(k + 1) - 2 * A(k) + A(k - 1)));
      edge = Math.max(edge, Math.abs(B(0) - 2 * A(TILE - 1) + A(TILE - 2)), Math.abs(B(1) - 2 * B(0) + A(TILE - 1)));
    }
    return { interior, edge };
  }
  const s1 = seam(renderTrek(70, 20, 6), renderTrek(71, 20, 6), true);
  check('Moon Trek: no seam between east-west neighbours', s1.edge <= s1.interior + 2, `edge curvature ${s1.edge} vs inside ${s1.interior}`);
  const s2 = seam(renderTrek(112, 31, 6), renderTrek(112, 32, 6), false); // display equator at 135°E = the true 180° meridian
  check('Moon Trek: no seam across the true 180° meridian', s2.edge <= s2.interior + 2, `edge curvature ${s2.edge} vs inside ${s2.interior}`);
  const raster = buildMips(grey(4096, 4096, (c, r) => wave(c, r)));
  const d = displayTileAt(-89.67, 129.78, 9);
  const renderRaster = (x: number, y: number) => { const plan = planRaster(fp, rectOf(x, y, 9), raster, E, POLAR_LIMIT_DEG, POLAR_FEATHER_M)!; return sampleTiles(fp, plan.grids, [0], [plan.src], true)!; };
  const s3 = seam(renderRaster(d.x, d.y), renderRaster(d.x + 1, d.y), true);
  const s4 = seam(renderRaster(d.x, d.y), renderRaster(d.x, d.y + 1), false);
  check('polar raster: no seams between neighbours', Math.max(s3.edge, s4.edge) <= Math.max(s3.interior, s4.interior) + 2, `edge ${Math.max(s3.edge, s4.edge)} vs inside ${Math.max(s3.interior, s4.interior)}`);
  // inside one display tile across pyramid square borders
  // a display tile at level 13 next to the pole, where pyramid squares meet (x = 0 and y = 0 are square borders)
  const lvl = 13, pd = displayTileAt(-(90 - (2 * Math.atan(1500 / (2 * R))) / DEG), 45, lvl), plan = planPyramid(fp, pd.rect, lvl, 4)!, n = 2 ** plan.level;
  const out = sampleTiles(fp, plan.grids, plan.keys, plan.keys.map(q => grey(PYRAMID_PX, PYRAMID_PX, (c, r) => wave((q % n) * PYRAMID_PX + c, Math.floor(q / n) * PYRAMID_PX + r))), true)!;
  let curv = 0;
  for (let j = 1; j < TILE - 1; j++) for (let i = 1; i < TILE - 1; i++) curv = Math.max(curv, Math.abs(at(out, i + 1, j) - 2 * at(out, i, j) + at(out, i - 1, j)), Math.abs(at(out, i, j + 1) - 2 * at(out, i, j) + at(out, i, j - 1)));
  check('pyramid: smooth across square borders inside a tile', plan.keys.length > 1 && curv < 30, `${plan.keys.length} squares, max curvature ${curv}`);
}

// 7. Edges: Moon Trek leaves the polar cap to the polar layers; polar layers fade / clip cleanly ----
{
  const d = displayTileAt(-81, 40, 6), plan = planTrek(fp, d.rect, 6, 8, -81)!;
  const out = sampleTiles(fp, plan.grids, plan.keys, plan.keys.map(() => grey(TILE, TILE, () => 255)), false)!;
  let bad = 0, partial = 0;
  for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) {
    const lat = fp.a[j * TILE + i] / DEG, a = out[((TILE - 1 - j) * TILE + i) * 4 + 3];
    if (lat < -81 - pixelDeg(6) && a !== 0) bad++;
    if (lat > -81 + pixelDeg(6) && a !== 255) bad++;
    if (a > 0 && a < 255) partial++;
  }
  check('Moon Trek is transparent south of minTrueLat (-81°), opaque north of it, soft over 1 px', bad === 0 && partial > 0, `${bad} wrong, ${partial} edge pixels`);
  check('Moon Trek skips tiles wholly inside the polar cap', planTrek(fp, displayTileAt(-89, 0, 6).rect, 6, 8, -81) === null);
  // the main thread's quick "nothing to draw" test must never throw away a tile that has something
  let wrongSkips = 0, skips = 0;
  for (let n = 0; n < 400; n++) {
    const level = 3 + Math.floor(rnd() * 8), t = displayTileAt(-76 - rnd() * 14, rnd() * 360 - 180, level), r = t.rect, rng = tileTrueLatRange(r);
    if (rng.maxDeg < -81 - pixelDeg(level)) { skips++; if (trekGeometry(fp, r, -81)) wrongSkips++; }
    if (rng.minDeg >= POLAR_LIMIT_DEG + pixelDeg(level)) { skips++; if (polarGeometry(fp, r, polarRho(POLAR_LIMIT_DEG), POLAR_FEATHER_M, E)) wrongSkips++; }
  }
  check('quick tile skips never drop visible pixels', wrongSkips === 0 && skips > 50, `${skips} skips, ${wrongSkips} wrong`);
  // polar photo edge: fades over POLAR_FEATHER_M inside the ±304 km square / POLAR_LIMIT_DEG circle, nothing outside
  const white = buildMips(grey(4096, 4096, () => 255));
  const e = displayTileAt(-80.0, 0, 8), pr = planRaster(fp, e.rect, white, E, POLAR_LIMIT_DEG, POLAR_FEATHER_M)!;
  const po = sampleTiles(fp, pr.grids, [0], [pr.src], false)!;
  let edgeBad = 0;
  for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) {
    const q = j * TILE + i, inside = Math.min(polarRho(POLAR_LIMIT_DEG) - Math.hypot(fp.a[q], fp.b[q]), E - Math.max(Math.abs(fp.a[q]), Math.abs(fp.b[q])));
    const a = po[((TILE - 1 - j) * TILE + i) * 4 + 3];
    if (inside < 0 && a !== 0) edgeBad++;
    if (inside > POLAR_FEATHER_M + 200 && a !== 255) edgeBad++;
  }
  check('polar photo fades out softly at its edge', edgeBad === 0, `${edgeBad} wrong pixels`);
  // science map clip at -80.02°: crisp (1 px soft) circle
  const s = displayTileAt(-80.02, 60, 8), sr = planRaster(fp, s.rect, white, E, -80.02, 0)!;
  const so = sampleTiles(fp, sr.grids, [0], [sr.src], false)!;
  let clipBad = 0;
  for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) {
    const q = j * TILE + i, inside = polarRho(-80.02) - Math.hypot(fp.a[q], fp.b[q]), a = so[((TILE - 1 - j) * TILE + i) * 4 + 3];
    const px = pixelDeg(8) * DEG * R;
    if (inside < -px && a !== 0) clipBad++;
    if (inside > px && a !== 255) clipBad++;
  }
  check('science map is clipped crisply at -80.02°', clipBad === 0, `${clipBad} wrong pixels`);
}

// 8. Alpha-aware sampling, compact pixel storage and smaller copies ------------------------------
{
  const rgba: Src = { w: 2, h: 1, ch: 4, data: new Uint8Array([200, 100, 50, 255, 0, 0, 0, 0]) };
  const g = { tileW: 2, tileH: 1, tilesX: 1, width: 2, height: 1, global: false };
  fp.cov.fill(0); fp.lvl.fill(0); fp.taps.fill(1); fp.cov[0] = 1; fp.u[0] = 0.5; fp.v[0] = 0; // halfway between the opaque and the "no data" pixel
  const o = sampleTiles(fp, [g], [0], [rgba], true)!;
  check('"no data" pixels never darken the colour next to them', o[0] === 200 && o[1] === 100 && o[2] === 50 && o[3] === 128, `got ${o[0]},${o[1]},${o[2]},${o[3]}`);
  const pk = (vals: number[][]) => { const p = new Packer(vals.length, 1); p.add(new Uint8ClampedArray(vals.flat()), 0); return p.result(); };
  const g1 = pk([[9, 9, 9, 255], [7, 7, 7, 255]]), g3 = pk([[9, 9, 9, 255], [1, 2, 3, 255]]), g4 = pk([[9, 9, 9, 255], [1, 2, 3, 255], [4, 5, 6, 7]]);
  check('pixel packing: grey -> 1 byte, colour -> RGB, see-through -> RGBA (earlier pixels kept)',
    g1.ch === 1 && g1.data.join() === '9,7' && g3.ch === 3 && g3.data.join() === '9,9,9,1,2,3' && g4.ch === 4 && g4.data.join() === '9,9,9,255,1,2,3,255,4,5,6,7');
  const dots = new Uint8Array(64 * 64 * 4); // red dots on every other pixel of every other row, the rest "no data"
  for (let y = 0; y < 64; y += 2) for (let x = 0; x < 64; x += 2) { dots[(y * 64 + x) * 4] = 255; dots[(y * 64 + x) * 4 + 3] = 255; }
  const mm = buildMips({ w: 64, h: 64, ch: 4, data: dots });
  const l1 = mm.levels[1].data;
  check('half-size copy of red dots on "no data" stays red, quarter alpha', mm.levels[1].w === 32 && l1[0] === 255 && l1[1] === 0 && l1[3] === 64, `got ${l1[0]},${l1[1]},${l1[2]},${l1[3]}`);
}

// 8b. Moon Trek near the true poles: no moiré, sensible tile counts, no seams ----------------------
{
  // East-west stripes 3.2 source pixels apart (the reviewer's case). Where one display pixel spans
  // more than ~1.6 source pixels east-west the stripes cannot be shown and must average out,
  // instead of turning into false patterns. Broad features (64 px) must survive.
  const stripes = (period: number) => (plan: Plan) => trekSources(plan, (_z, x) => grey(TILE, TILE, c => 128 + 64 * Math.sin((2 * Math.PI * (x * TILE + c)) / period)));
  const sd = (out: Uint8ClampedArray) => {
    let n = 0, s1 = 0, s2 = 0;
    for (let q = 0; q < out.length; q += 4) if (out[q + 3] === 255) { n++; s1 += out[q]; s2 += out[q] * out[q]; }
    return Math.sqrt(s2 / n - (s1 / n) ** 2);
  };
  const rows: string[] = [];
  const res: Record<number, { fine: number; broad: number; tiles: number }> = {};
  for (const lat of [0, -60, -75, -80.5]) {
    const d = displayTileAt(lat, 30, 8), plan = planTrek(fp, d.rect, 8, 8, -81)!;
    let ratio = 0, n = 0;
    for (let p = 0; p < TILE * TILE; p++) if (fp.cov[p] > 0) { ratio += fp.taps[p] > 1 ? fp.taps[p] * fp.step[p] : 1; n++; }
    const fine = sd(sampleTiles(fp, plan.grids, plan.keys, stripes(3.2)(plan), false)!);
    const broad = sd(sampleTiles(fp, plan.grids, plan.keys, stripes(64)(plan), false)!);
    res[lat] = { fine, broad, tiles: plan.keys.length };
    rows.push(`${lat}°: ~${(ratio / n).toFixed(1)} source px per display px, ${plan.keys.length} tiles, fine stripes sd ${fine.toFixed(1)}, broad sd ${broad.toFixed(1)}`);
  }
  console.log('      input sd 45.3 (fine stripes are 3.2 px apart, broad ones 64 px):\n      ' + rows.join('\n      '));
  check('equator keeps fine detail', res[0].fine > 30);
  check('fine east-west stripes average out near the pole instead of aliasing (75°S, 80.5°S)', res[-75].fine < 8 && res[-80.5].fine < 8, `sd ${res[-75].fine.toFixed(1)}, ${res[-80.5].fine.toFixed(1)} (was ~47 with one sample per pixel)`);
  check('broad features survive the averaging', [0, -60, -75, -80.5].every(l => res[l].broad > 40));
  check('all of the southern Moon Trek range is read at full level (no coarser level south of 81°S)',
    [-60, -75, -80.5, -80.99].every(l => { const pl = planTrek(fp, displayTileAt(l, 30, 8).rect, 8, 8, -81)!; return pl.keys.every(k => trekTileOf(k).z === 8); }));

  // Source tiles needed per display tile, over all levels, worst near the true north pole.
  let worst = 0, worstAt = '';
  const consider = (x: number, y: number, level: number) => {
    const pl = planTrek(fp, rectOf(x, y, level), level, 8, -90);
    if (pl && pl.keys.length > worst) { worst = pl.keys.length; worstAt = `level ${level} tile ${x},${y}`; }
  };
  for (let level = 0; level <= 12; level++) {
    if (level <= 3) { for (let x = 0; x < 2 ** (level + 1); x++) for (let y = 0; y < 2 ** level; y++) consider(x, y, level); continue; }
    for (const [lat, lon] of [[89.999, 0], [88, 30], [85, -120], [82, 60], [-80.9, 10], [-75, 100]]) {
      const t = displayTileAt(lat, lon, level);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) consider(t.x + dx, t.y + dy, level);
    }
  }
  check('no display tile needs more than 40 Moon Trek tiles (all levels, incl. the north pole)', worst <= 40, `worst ${worst} at ${worstAt}`);

  // The row of display tiles through true 89.99°N: neighbours must read the same source level
  // along their shared edge (a level step is only allowed where a ring of latitude crosses it).
  for (const level of [8, 9]) {
    const t = displayTileAt(89.99, 0, level), summary: string[] = [];
    const lv: Uint8Array[] = [];
    for (let dx = -3; dx <= 3; dx++) {
      const pl = planTrek(fp, rectOf(t.x + dx, t.y, level), level, 8, -90)!;
      lv.push(fp.lvl.slice());
      const used = [...new Set(pl.keys.map(k => trekTileOf(k).z))].sort((a, b) => a - b);
      summary.push(`z${used.join('/')}:${pl.keys.length}t`);
    }
    let jump = 0;
    for (let n = 0; n + 1 < lv.length; n++) for (let j = 0; j < TILE; j++) jump = Math.max(jump, Math.abs(lv[n][j * TILE + TILE - 1] - lv[n + 1][j * TILE]));
    check(`north-pole row at display level ${level}: source level never jumps by more than one across a tile edge`, jump <= 1, `levels used / tiles per tile: ${summary.join(' ')}`);
  }
  // ...and with a smooth picture drawn at every level, the tile edges there show no seam.
  const field = (z: number, x: number, y: number) => grey(TILE, TILE, (c, r) => {
    const lon = (((x * TILE + c + 0.5) / (TILE * 2 ** (z + 1))) * 2 - 1) * Math.PI, lat = Math.PI / 2 - ((y * TILE + r + 0.5) / (TILE * 2 ** z)) * Math.PI;
    const X = Math.cos(lat) * Math.cos(lon), Y = Math.cos(lat) * Math.sin(lon);
    return 128 + 90 * Math.sin(X * 260) * Math.cos(Y * 230);
  });
  const near = displayTileAt(89.9, 20, 9);
  const draw = (x: number, y: number) => { const pl = planTrek(fp, rectOf(x, y, 9), 9, 8, -90)!; return sampleTiles(fp, pl.grids, pl.keys, trekSources(pl, field), true)!; };
  const at = (px: Uint8ClampedArray, i: number, j: number) => px[(j * TILE + i) * 4];
  let edge = 0, interior = 0;
  for (const [A, B] of [[draw(near.x, near.y), draw(near.x + 1, near.y)]]) {
    for (let j = 0; j < TILE; j++) {
      for (let i = 1; i < TILE - 1; i++) interior = Math.max(interior, Math.abs(at(A, i + 1, j) - 2 * at(A, i, j) + at(A, i - 1, j)));
      edge = Math.max(edge, Math.abs(at(B, 0, j) - 2 * at(A, TILE - 1, j) + at(A, TILE - 2, j)), Math.abs(at(B, 1, j) - 2 * at(B, 0, j) + at(A, TILE - 1, j)));
    }
  }
  check('no seam between neighbouring tiles 10 km from the true north pole', edge <= interior + 2, `edge curvature ${edge} vs inside ${interior}`);
}

// 8c. See-through pixels carry the colour next to them (GPU mipmaps / filtering don't darken edges) --
{
  /** What the GPU's mipmaps do: plain 2x2 averages of straight RGBA, alpha ignored. Returns the blended colour (r·a) per level. */
  const gpuMips = (px: Uint8ClampedArray) => {
    let cur = Float32Array.from(px), size = TILE;
    const levels: Float32Array[] = [];
    while (size > 1) {
      const h = size >> 1, nxt = new Float32Array(h * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < h; x++) for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) s += cur[((2 * y + dy) * size + 2 * x + dx) * 4 + c];
        nxt[(y * h + x) * 4 + c] = s / 4;
      }
      levels.push(nxt); cur = nxt; size = h;
    }
    return levels;
  };
  // Moon Trek at its -81° cut, white picture: every texel the GPU blends must stay white.
  const d = displayTileAt(-81, 40, 6), plan = planTrek(fp, d.rect, 6, 8, -81)!;
  const out = sampleTiles(fp, plan.grids, plan.keys, plan.keys.map(() => grey(TILE, TILE, () => 255)), false)!;
  let clearDark = 0, clear = 0;
  for (let q = 0; q < out.length; q += 4) if (out[q + 3] === 0) { clear++; if (out[q] !== 255) clearDark++; }
  check('see-through pixels next to a white layer are white (not black)', clear > 0 && clearDark === 0, `${clear} clear pixels, ${clearDark} dark`);
  const darkest = (px: Uint8ClampedArray) => Math.min(...gpuMips(px).map(l => { let m = 255; for (let q = 0; q < l.length; q += 4) if (l[q + 3] > 1) m = Math.min(m, l[q]); return m; }));
  const blackened = out.slice();
  for (let q = 0; q < blackened.length; q += 4) if (blackened[q + 3] === 0) blackened[q] = blackened[q + 1] = blackened[q + 2] = 0;
  check('GPU mipmaps of the layer edge stay white', darkest(out) >= 254, `darkest edge texel ${darkest(out).toFixed(0)} (with black see-through pixels it would be ${darkest(blackened).toFixed(0)})`);
  // A sparse science map (red dots on "no data", like ice.png) seen zoomed out must not fade.
  const dots = new Uint8Array(2048 * 2048 * 4);
  for (let y = 0; y < 2048; y += 16) for (let x = 0; x < 2048; x += 16) { const o = (y * 2048 + x) * 4; dots[o] = 255; dots[o + 3] = 255; }
  const sparse = buildMips({ w: 2048, h: 2048, ch: 4, data: dots });
  const st = displayTileAt(-88, 30, 9), sp = planRaster(fp, st.rect, sparse, E, -80.02, 0)!;
  const so = sampleTiles(fp, sp.grids, [0], [sp.src], false)!;
  const l3 = gpuMips(so)[2]; // the GPU's 1/8-size copy
  let truth = 0, gpu = 0;
  for (let q = 0; q < l3.length; q += 4) gpu += l3[q] * l3[q + 3] / 255;
  for (let q = 0; q < so.length; q += 4) truth += so[q] * so[q + 3] / 255;
  truth /= 64; // 8x8 texels per mip texel
  check('sparse map keeps its brightness in GPU mipmaps', gpu / truth > 0.97, `${(100 * gpu / truth).toFixed(1)}% of the true brightness`);
  // fillClear on a single coloured pixel: everything else takes its colour, alpha untouched
  const one = new Uint8ClampedArray(TILE * TILE * 4);
  one.set([10, 200, 30, 255], (100 * TILE + 50) * 4);
  fillClear(one);
  check('fillClear spreads colour into see-through pixels and leaves alpha alone',
    one[0] === 10 && one[1] === 200 && one[2] === 30 && one[3] === 0 && one[(100 * TILE + 50) * 4 + 3] === 255);
}

// 8d. Moon Trek's real depth comes from its WMTS description (not from 404s, which CORS hides) -----
{
  const xml = `<Capabilities><Contents><TileMatrixSet><ows:Identifier>default028mm</ows:Identifier>
    <TileMatrix><ows:Identifier>0</ows:Identifier><MatrixWidth>2.0</MatrixWidth></TileMatrix>
<TileMatrix><ows:Identifier>5</ows:Identifier></TileMatrix>
<TileMatrix><ows:Identifier>6</ows:Identifier></TileMatrix>
    <!--<TileMatrix>
        <ows:Identifier>9</ows:Identifier>
    </TileMatrix>-->
    </TileMatrixSet></Contents></Capabilities>`;
  check('WMTS depth: deepest listed level, commented-out levels ignored', parseTrekDepth(xml) === 6 && parseTrekDepth('<Capabilities/>') === null);
  check('WMTS description URL', trekCapabilitiesUrl('LRO_LOLA_ClrShade_Global_256ppd_v06') === 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_LOLA_ClrShade_Global_256ppd_v06/1.0.0/WMTSCapabilities.xml');
}

// 9. Speed of the worker's per-tile work (same JS engine family as Chrome) -----------------------
{
  const d = displayTileAt(-30, 40, 7);
  const src = grey(TILE, TILE, (c, r) => (c * r) & 255);
  let t0 = performance.now();
  for (let n = 0; n < 40; n++) { const plan = planTrek(fp, d.rect, 7, 8, -81)!; sampleTiles(fp, plan.grids, plan.keys, plan.keys.map(() => src), false); }
  const trekMs = (performance.now() - t0) / 40;
  // the slowest Moon Trek tiles: just outside the polar cap, where each pixel averages up to 8 samples
  const hd = displayTileAt(-80.8, 45, 8);
  t0 = performance.now();
  for (let n = 0; n < 40; n++) { const plan = planTrek(fp, hd.rect, 8, 8, -81)!; sampleTiles(fp, plan.grids, plan.keys, plan.keys.map(() => src), false); }
  const trekHighMs = (performance.now() - t0) / 40;
  const raster = buildMips(grey(4096, 4096, (c, r) => (c ^ r) & 255)), pd = displayTileAt(-88, 30, 9);
  t0 = performance.now();
  for (let n = 0; n < 40; n++) { const plan = planRaster(fp, pd.rect, raster, E, POLAR_LIMIT_DEG, POLAR_FEATHER_M)!; sampleTiles(fp, plan.grids, [0], [plan.src], false); }
  const rasterMs = (performance.now() - t0) / 40;
  console.log(`      per display tile: Moon Trek ${trekMs.toFixed(1)} ms (at 80.8°S ${trekHighMs.toFixed(1)} ms), polar raster ${rasterMs.toFixed(1)} ms (plus decode / ImageBitmap in the browser)`);
  check('re-projection is fast enough for a worker (< 15 ms per tile)', trekMs < 15 && trekHighMs < 15 && rasterMs < 15);
}

// 9b. Optional (--network): Moon Trek's real WMTS descriptions and tiles --------------------------
if (process.argv.includes('--network')) {
  for (const [layer, ext, want] of [['LRO_LOLA_ClrShade_Global_256ppd_v06', 'png', 6], ['LRO_WAC_Mosaic_Global_303ppd_v02', 'jpg', 8]] as const) {
    const r = await fetch(trekCapabilitiesUrl(layer), { headers: { Origin: 'http://127.0.0.1:5190' } });
    const depth = parseTrekDepth(await r.text()), cors = r.headers.get('access-control-allow-origin');
    const deepest = await fetch(trekUrl(layer, ext, want, 2 ** want, 2 ** (want - 1)), { method: 'HEAD' });
    const beyond = await fetch(trekUrl(layer, ext, want + 1, 2 ** (want + 1), 2 ** want), { method: 'HEAD', headers: { Origin: 'http://127.0.0.1:5190' } });
    check(`${layer}: WMTS says depth ${want}, served with CORS; level ${want} exists, level ${want + 1} is a 404 without CORS`,
      depth === want && cors === '*' && deepest.status === 200 && beyond.status === 404 && !beyond.headers.get('access-control-allow-origin'),
      `depth ${depth}, ACAO ${cors}, level ${want}: ${deepest.status}, level ${want + 1}: ${beyond.status} ACAO ${beyond.headers.get('access-control-allow-origin')}`);
  }
}

// 10. Optional: render real NASA pictures to PNGs for a visual check -----------------------------
const vi = process.argv.indexOf('--visual');
if (vi > 0) {
  const dir = process.argv[vi + 1] ?? '.';
  mkdirSync(dir, { recursive: true });
  const readBmp = (path: string): Src => {
    const b = readFileSync(path), off = b.readUInt32LE(10), w = b.readInt32LE(18), hh = b.readInt32LE(22), h = Math.abs(hh), bpp = b.readUInt16LE(28) / 8;
    const stride = Math.ceil((w * bpp) / 4) * 4, p = new Packer(w, h), row = new Uint8ClampedArray(w * 4);
    for (let r = 0; r < h; r++) {
      const base = off + (hh < 0 ? r : h - 1 - r) * stride;
      for (let c = 0; c < w; c++) { const o = base + c * bpp; row[c * 4] = b[o + 2]; row[c * 4 + 1] = b[o + 1]; row[c * 4 + 2] = b[o]; row[c * 4 + 3] = bpp === 4 ? b[o + 3] : 255; }
      p.add(row, r * w);
    }
    return p.result();
  };
  const decodeFile = (path: string) => { const bmp = join(dir, 'tmp.bmp'); execFileSync('sips', ['-s', 'format', 'bmp', path, '--out', bmp], { stdio: 'ignore' }); return readBmp(bmp); };
  const fetchSrc = async (url: string): Promise<Src | null> => {
    const r = await fetch(url);
    if (!r.ok) return null;
    const f = join(dir, 'tmp.img');
    writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    return decodeFile(f);
  };
  /** Write tiles (rows north first) side by side as a PNG, composited over dark grey. */
  const writePng = (name: string, cols: number, tiles: (Uint8ClampedArray | null)[]) => {
    const rows = Math.ceil(tiles.length / cols), W = cols * TILE, H = rows * TILE, stride = W * 3;
    const b = Buffer.alloc(54 + stride * H);
    b.write('BM'); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14); b.writeInt32LE(W, 18); b.writeInt32LE(-H, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28);
    tiles.forEach((t, n) => {
      for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) {
        const o = 54 + ((Math.floor(n / cols) * TILE + j) * W + (n % cols) * TILE + i) * 3, q = (j * TILE + i) * 4, a = t ? t[q + 3] / 255 : 0;
        for (let ch = 0; ch < 3; ch++) b[o + 2 - ch] = Math.round((t ? t[q + ch] : 0) * a + 40 * (1 - a));
      }
    });
    const bmp = join(dir, `${name}.bmp`);
    writeFileSync(bmp, b);
    execFileSync('sips', ['-s', 'format', 'png', bmp, '--out', join(dir, `${name}.png`)], { stdio: 'ignore' });
    console.log(`      wrote ${join(dir, `${name}.png`)}`);
  };
  const trekCache = new Map<string, Promise<Src | null>>();
  const trekTile = (layer: string, ext: string, z: number, x: number, y: number) => {
    const u = trekUrl(layer, ext, z, x, y);
    if (!trekCache.has(u)) trekCache.set(u, fetchSrc(u));
    return trekCache.get(u)!;
  };
  const renderTrekReal = async (layer: string, ext: string, x: number, y: number, level: number, minLat: number) => {
    const rect = rectOf(x, y, level), plan = planTrek(fp, rect, level, 8, minLat);
    if (!plan) return null;
    const srcs: (Src | null)[] = [];
    for (const k of plan.keys) { const t = trekTileOf(k); srcs.push(await trekTile(layer, ext, t.z, t.x, t.y)); }
    planTrek(fp, rect, level, 8, minLat);
    return sampleTiles(fp, plan.grids, plan.keys, srcs, true);
  };
  const WAC = 'LRO_WAC_Mosaic_Global_303ppd_v02';
  // Tycho: 3x3 display tiles at level 6 around it (seams would show as lines)
  const ty = displayTileAt(-43.3, -11.2, 6), tTiles: (Uint8ClampedArray | null)[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) tTiles.push(await renderTrekReal(WAC, 'jpg', ty.x + dx, ty.y + dy, 6, -81));
  writePng('tycho-trek-l6', 3, tTiles);
  console.log(`      Tycho should be at pixel (${(256 + ty.i).toFixed(0)}, ${(256 + ty.j).toFixed(0)}) of that picture`);
  // Shackleton on the local polar photo: 3x3 display tiles at level 8
  const photo = buildMips(decodeFile(new URL('../public/data/polar/photo4096.jpg', import.meta.url).pathname));
  const sh = displayTileAt(-89.67, 129.78, 8), sTiles: (Uint8ClampedArray | null)[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const plan = planRaster(fp, rectOf(sh.x + dx, sh.y + dy, 8), photo, E, POLAR_LIMIT_DEG, POLAR_FEATHER_M);
    sTiles.push(plan ? sampleTiles(fp, plan.grids, [0], [plan.src], true) : null);
  }
  writePng('shackleton-polar-l8', 3, sTiles);
  console.log(`      Shackleton should be at pixel (${(256 + sh.i).toFixed(0)}, ${(256 + sh.j).toFixed(0)}) of that picture`);
  // The same spot from the Lunaserv pyramid at display level 10 (k=6), 2x2 tiles
  const pl = 10, pd = displayTileAt(-89.67, 129.78, pl), pTiles: (Uint8ClampedArray | null)[] = [];
  const x0 = pd.i < 128 ? pd.x - 1 : pd.x, y0 = pd.j < 128 ? pd.y - 1 : pd.y;
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const rect = rectOf(x0 + dx, y0 + dy, pl), plan = planPyramid(fp, rect, pl, 4);
    if (!plan) { pTiles.push(null); continue; }
    const n = 2 ** plan.level, srcs: (Src | null)[] = [];
    for (const q of plan.keys) srcs.push(await fetchSrc(pyramidUrl('luna_wac_global,luna_nac_pole_control_south', plan.level, q % n, Math.floor(q / n))));
    planPyramid(fp, rect, pl, 4);
    pTiles.push(sampleTiles(fp, plan.grids, plan.keys, srcs, true));
  }
  writePng('shackleton-pyramid-l10', 2, pTiles);
  console.log(`      Shackleton should be at pixel (${(256 * (pd.x - x0) + pd.i).toFixed(0)}, ${(256 * (pd.y - y0) + pd.j).toFixed(0)}) of that picture`);
  // Where the polar photo fades into Moon Trek (true 80°S, 0°E), 3x2 tiles at level 7, polar photo on top
  const bl = displayTileAt(-80, 0, 7), bTiles: (Uint8ClampedArray | null)[] = [];
  for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 1; dx++) {
    const below = await renderTrekReal(WAC, 'jpg', bl.x + dx, bl.y + dy, 7, -81);
    const plan = planRaster(fp, rectOf(bl.x + dx, bl.y + dy, 7), photo, E, POLAR_LIMIT_DEG, POLAR_FEATHER_M);
    const top = plan ? sampleTiles(fp, plan.grids, [0], [plan.src], true) : null;
    if (below && top) for (let q = 0; q < top.length; q += 4) {
      const a = top[q + 3] / 255, ab = below[q + 3] / 255, ao = a + ab * (1 - a);
      for (let c = 0; c < 3; c++) below[q + c] = ao > 0 ? (top[q + c] * a + below[q + c] * ab * (1 - a)) / ao : 0;
      below[q + 3] = ao * 255;
    }
    bTiles.push(below ?? top);
  }
  writePng('blend-80S-l7', 3, bTiles);
  // The whole south-polar cap at display level 4 (2x2 tiles around display 0°N 90°E): Moon Trek with the polar photo on top
  const capTiles: (Uint8ClampedArray | null)[] = [];
  for (const y of [7, 8]) for (const x of [23, 24]) {
    const below = await renderTrekReal(WAC, 'jpg', x, y, 4, -81);
    const plan = planRaster(fp, rectOf(x, y, 4), photo, E, POLAR_LIMIT_DEG, POLAR_FEATHER_M);
    const top = plan ? sampleTiles(fp, plan.grids, [0], [plan.src], true) : null;
    if (below && top) for (let q = 0; q < top.length; q += 4) {
      const a = top[q + 3] / 255, ab = below[q + 3] / 255, ao = a + ab * (1 - a);
      for (let c = 0; c < 3; c++) below[q + c] = ao > 0 ? (top[q + c] * a + below[q + c] * ab * (1 - a)) / ao : 0;
      below[q + 3] = ao * 255;
    }
    capTiles.push(below ?? top);
  }
  writePng('south-cap-l4', 2, capTiles);
}

// 11. Where the data ends, and the pictures stored with the app ----------------------------------
{
  // The sharp NAC mosaic stops at 84 deg S: outside it tiles stop at the level that shows all of the WAC mosaic.
  const out = (lvl: number) => displayTileAt(-82, 40, lvl).rect, inn = (lvl: number) => displayTileAt(-87, 40, lvl).rect;
  check('finest pyramid level: 4 outside the NAC mosaic, 10 inside and where a tile straddles its edge',
    pyramidMaxKFor(out(9)) === PYRAMID_WAC_MAX_K && pyramidMaxKFor(inn(9)) === PYRAMID_MAX_K && pyramidMaxKFor(displayTileAt(PYRAMID_NAC_LAT_DEG, 40, 6).rect) === PYRAMID_MAX_K);
  check('outside the NAC mosaic the last real tiles are display level 8; deeper ones keep their parent',
    !pyramidParentIsEnough(out(8), 8) && [9, 10, 12, 15].every(l => pyramidParentIsEnough(out(l), l)) && planPyramid(fp, out(8), 8, 4)!.level === 4 && planPyramid(fp, out(12), 12, 4)!.level === 4);
  check('inside the NAC mosaic every level down to 14 (1.2 m per pixel) is real, and nothing deeper', [8, 9, 12, 14].every(l => !pyramidParentIsEnough(inn(l), l)) && pyramidParentIsEnough(inn(15), 15) && planPyramid(fp, inn(14), 14, 4)!.level === 10);
  // "keep the parent" never throws detail away: the parent is drawn from the same pyramid level
  let lost = 0, kept = 0;
  for (let n = 0; n < 400; n++) {
    const lvl = 7 + Math.floor(rnd() * 9), lat = -80 - rnd() * 10, lon = rnd() * 360 - 180, d = displayTileAt(lat, lon, lvl);
    if (!pyramidParentIsEnough(d.rect, lvl)) continue;
    kept++;
    const parent = rectOf(d.x >> 1, d.y >> 1, lvl - 1), a = planPyramid(fp, d.rect, lvl, 4), b = planPyramid(fp, parent, lvl - 1, 4);
    if (a && (!b || b.level < a.level)) lost++;
  }
  check('tiles answered "keep the parent" would not have been sharper than the parent', lost === 0 && kept > 50, `${kept} tiles, ${lost} would lose detail`);

  // The list of stored squares must describe exactly what is on disk.
  const dir = new URL('../public/data/polar/t/', import.meta.url).pathname;
  if (!existsSync(join(dir, 'index.json'))) console.log('      (no public/data/polar/t/index.json here: stored-square checks skipped)');
  else {
    const raw = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { count: number; layers: string };
    const ix = parsePyramidIndex(raw)!;
    let files = 0, unlisted = 0, unusable = 0;
    const perLevel: string[] = [];
    for (const name of readdirSync(dir).filter(n => /^\d+$/.test(n)).sort((a, b) => +a - +b)) {
      const k = +name, list = readdirSync(join(dir, name)).filter(f => f.endsWith('.jpg'));
      perLevel.push(`k${k}:${list.length}`);
      for (const f of list) {
        const [i, j] = f.slice(0, -4).split('_').map(Number);
        files++;
        if (!pyramidHasLocal(ix, k, i, j)) unlisted++;
        if (!pyramidLocalUrl('x/', k, i, j).endsWith(`${name}/${f}`)) unusable++;
      }
    }
    check('index.json lists exactly the south-pole squares that are on disk', ix !== null && ix.count === files && raw.count === files && unlisted === 0 && unusable === 0,
      `${files} files, ${ix.count} listed, ${unlisted} not listed; ${perLevel.join(' ')}; layers ${raw.layers}`);
    const allLocal = (lat: number, lon: number, lvl: number) => {
      const d = displayTileAt(lat, lon, lvl), plan = planPyramid(fp, d.rect, lvl, 4)!, n = 2 ** plan.level;
      return plan.keys.every(q => pyramidHasLocal(ix, plan.level, q % n, Math.floor(q / n)));
    };
    check('stored squares cover: the whole polar cap at 74 m/px, the pole area to 4.6 m/px (Shackleton ridge from 10 km up)',
      allLocal(-80.5, 77, 8) && allLocal(-83, -120, 8) && allLocal(-89.45, -136.7, 12) && allLocal(-89.79, -154.3, 12) && allLocal(-88.9, 20, 12) && allLocal(-85.94, -0.94, 12));
    // The quick main-thread test must never call a tile local that needs a download.
    let sure = 0, wrong = 0;
    for (let n = 0; n < 1500; n++) {
      const lvl = 8 + Math.floor(rnd() * 6), lat = -80 - rnd() * 10, lon = rnd() * 360 - 180, d = displayTileAt(lat, lon, lvl);
      if (pyramidParentIsEnough(d.rect, lvl) || !pyramidSurelyLocal(ix, d.rect, lvl)) continue;
      sure++;
      const plan = planPyramid(fp, d.rect, lvl, 4);
      if (plan && !plan.keys.every(q => pyramidHasLocal(ix, plan.level, q % 2 ** plan.level, Math.floor(q / 2 ** plan.level)))) wrong++;
    }
    check('"surely local" is never wrong (and is true for most stored areas)', wrong === 0 && sure > 300 && pyramidSurelyLocal(ix, displayTileAt(-89.45, -136.7, 12).rect, 12) && !pyramidSurelyLocal(ix, displayTileAt(-89.45, -136.7, 14).rect, 14),
      `${sure} of 1500 random tiles surely local, ${wrong} wrong`);
  }
  check('a broken or foreign index is refused', parsePyramidIndex(null) === null && parsePyramidIndex({ layers: 'x', halfM: 1, tilePx: 512, levels: {} }) === null
    && parsePyramidIndex({ layers: 'x', halfM: 304000, tilePx: 512, levels: { 3: { runs: [[0, 1, 6], [9, 0, 1], [1, 5, 2], 'junk'] } } })!.count === 6);

  // Tiles of the local whole-Moon picture are plain cut-outs.
  const pic = grey(1024, 512, (c, r) => (c * 7 + r * 13) & 255), t = cutTile(pic, 512, 256, false)!, tf = cutTile(pic, 512, 256, true)!;
  let bad = 0;
  for (let j = 0; j < TILE; j += 5) for (let i = 0; i < TILE; i += 3) {
    const v = ((512 + i) * 7 + (256 + j) * 13) & 255, o = ((TILE - 1 - j) * TILE + i) * 4, of = (j * TILE + i) * 4;
    if (t[o] !== v || t[o + 1] !== v || t[o + 2] !== v || t[o + 3] !== 255 || tf[of] !== v) bad++;
  }
  check('local picture tiles: exact pixels, south row first unless flipped, nothing outside the picture', bad === 0 && cutTile(pic, 1024, 0, false) === null && cutTile(pic, 768, 256, false) !== null && cutTile(pic, 768, 257, false) === null);
  const baseDir = new URL('../public/data/base/', import.meta.url).pathname;
  if (existsSync(join(baseDir, 'base.json'))) {
    const meta = JSON.parse(readFileSync(join(baseDir, 'base.json'), 'utf8')) as { pictures: Record<string, { file: string; width: number; height: number; west: number; north: number; level: number }> };
    const onGrid = Object.values(meta.pictures).every(p => {
      const tdeg = 180 / 2 ** p.level;
      return existsSync(join(baseDir, p.file)) && [(p.west + 180) / tdeg, (90 - p.north) / tdeg, p.width / TILE, p.height / TILE].every(Number.isInteger);
    });
    check('base.json: every picture exists and sits exactly on the display tile grid', onGrid && meta.pictures.global?.level === 4, Object.entries(meta.pictures).map(([k, p]) => `${k} ${p.width}x${p.height} L${p.level}`).join(', '));
  } else console.log('      (no public/data/base/base.json here: local picture checks skipped)');
}

// 12. v5 seamless Moon: the seam fix, display-pole tiles and pole-aware halving ---------------------
console.log('\n12. Seamless Moon (v5)');
{
  // weight: 1 in the east-lit quadrant, 0 where the photo is right, smooth and continuous in between
  let maxJump = 0, prev = fixWeightDeg(-180);
  for (let l = -180; l <= 180; l += 0.01) { const w = fixWeightDeg(l); maxJump = Math.max(maxJump, Math.abs(w - prev)); prev = w; }
  check('fix weight: 1 at -180..-90 and 180, 0 at -80..165, continuous (no step anywhere)',
    fixWeightDeg(-135) === 1 && fixWeightDeg(-90) === 1 && fixWeightDeg(180) === 1 && fixWeightDeg(-180) === 1 && fixWeightDeg(-80) === 0 && fixWeightDeg(0) === 0
    && fixWeightDeg(165) === 0 && Math.abs(fixWeightDeg(-85) - 0.5) < 1e-9 && Math.abs(fixWeightDeg(172.5) - 0.5) < 1e-9 && maxJump < 0.003 && fixWeightDeg(540) === 1,
    `largest change per 0.01° ${maxJump.toFixed(4)}, bands ${FIX_BAND_WEST.join('..')} and ${FIX_BAND_EAST.join('..')}`);
  // a tile's range must never claim "fully covered" / "nothing to draw" when one of its pixels says otherwise
  const fp = new Footprint();
  let wrongFull = 0, wrongEmpty = 0, full = 0, empty = 0;
  for (let k = 0; k < 1500; k++) {
    const level = 5 + Math.floor(rnd() * 6), n = 2 ** (level + 1), x = Math.floor(rnd() * n), y = Math.floor(rnd() * n / 2), r = rectOf(x, y, level);
    const range = tileFixRange(r);
    if (!trekGeometry(fp, r, -90)) continue;
    let mn = 1, mx = 0;
    for (let p = 0; p < TILE * TILE; p += 7) { const w = fixWeightDeg(fp.b[p] / DEG); mn = Math.min(mn, w); mx = Math.max(mx, w); }
    if (range.min >= 1) { full++; if (mn < 1) wrongFull++; }
    if (range.max <= 0) { empty++; if (mx > 0) wrongEmpty++; }
  }
  check('tile fix range: never "fully covered" or "empty" when a pixel disagrees', wrongFull === 0 && wrongEmpty === 0 && full > 200 && empty > 500, `${full} full, ${empty} empty of 1500 random tiles; wrong ${wrongFull} / ${wrongEmpty}`);
  // synth footprint: coverage = weight, and the hillshade layer by latitude
  const fix: FixParams = { albedo: { url: 'x', west: 150, east: 290, north: 90, south: -90, scale: 1 }, C: 0.5, S0: 170, near: 'NEAR', far: 'FAR', nearMaxLat: 59.5 };
  const band = displayTileAt(10, -85, 7), plan = planSynth(fp, band.rect, 7, 8);
  let covOk = true;
  for (let p = 0; p < TILE * TILE; p += 11) if (fp.cov[p] > 0 && Math.abs(fp.cov[p] - fixWeightDeg(fp.b[p] / DEG)) > 1e-6) covOk = false;
  check('fix tile: alpha = the fix weight; SLDEM within ±59.5°, LOLA beyond; nothing planned where the photo is right',
    !!plan && covOk && fixShadeFor(fix, band.rect).layer === 'NEAR' && fixShadeFor(fix, displayTileAt(70, -120, 7).rect).layer === 'FAR' && planSynth(fp, displayTileAt(0, 20, 7).rect, 7, 8) === null);
  // albedo lookup wraps across 180 and is bilinear
  const alb = grey(140, 180, (c, rr) => (c + rr) & 255);
  const v1 = sampleLonLat(alb, 150, 290, 90, -90, 0.5 * DEG, -100.5 * DEG), v2 = sampleLonLat(alb, 150, 290, 90, -90, 0.5 * DEG, 259.5 * DEG);
  check('albedo lookup: true lon -100.5° and 259.5° read the same pixel (wraps across 180°)', Math.abs(v1 - v2) < 1e-9 && Math.abs(v1 - ((109 + 89) & 255)) < 1e-6, `${v1.toFixed(2)}`);
  // pole-aware halving: uniform stays uniform; equator rows = plain 2x2; near the pole each pixel averages a ring segment as wide as it is tall
  const W2 = 512, H2 = 256, stripes = grey(W2, H2, c => (c % 2) * 200), flat = grey(W2, H2, () => 77);
  const hs = halvePoleAware(stripes), hf = halvePoleAware(flat);
  const rowStd = (s: Src, r: number) => { let m = 0, q = 0; for (let c = 0; c < s.w; c++) { const v = s.data[r * s.w + c]; m += v; q += v * v; } m /= s.w; return Math.sqrt(Math.max(0, q / s.w - m * m)); };
  const spot = grey(W2, H2, (c, r) => (r < 4 && c === 100 ? 255 : 0)), hp = halvePoleAware(spot);
  let spread = 0; for (let c = 0; c < hp.w; c++) if (hp.data[c] > 0) spread++;
  check('pole-aware halving: flat stays flat, 1-px stripes average out on every row, near the pole a point spreads round the ring',
    hf.data.every(v => v === 77) && hs.data[64 * hs.w + 10] === 100 && rowStd(hs, 64) < 1 && rowStd(hs, 1) < 1 && spread > 20 && hs.w === 256 && hs.h === 128,
    `point at the top row spreads over ${spread} of ${hp.w} px`);
}
{
  const dir = new URL('../public/data/base/v5/', import.meta.url).pathname;
  if (existsSync(join(dir, 'base.json'))) {
    const meta = JSON.parse(readFileSync(join(dir, 'base.json'), 'utf8')) as { pictures: Record<string, { file: string; width: number; height: number; west: number; north: number; level: number }>; fix?: { albedo: { file: string; width: number; height: number; west: number; east: number } } };
    const onGrid = Object.values(meta.pictures).every(p => {
      const tdeg = 180 / 2 ** p.level;
      return existsSync(join(dir, p.file)) && [(p.west + 180) / tdeg, (90 - p.north) / tdeg, p.width / TILE, p.height / TILE].every(Number.isInteger);
    });
    const a = meta.fix?.albedo;
    check('v5 base.json: pictures on the tile grid (global, quick, south, north) and the fix albedo exists', onGrid && !!meta.pictures.north && !!meta.pictures.south && !!a && existsSync(join(dir, a.file)) && Math.abs(a.width / (a.east - a.west) - 8192 / 360) < 0.05,
      Object.entries(meta.pictures).map(([k, p]) => `${k} ${p.width}x${p.height} L${p.level}`).join(', '));
  } else console.log('      (no public/data/base/v5/base.json here: v5 picture checks skipped)');
}

console.log(failures === 0 ? '\nAll imagery checks passed.' : `\n${failures} imagery check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
