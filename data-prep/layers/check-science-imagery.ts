// Pure checks for science maps; no downloads, browser, server or build.
// Run: node data-prep/layers/check-science-imagery.ts
import { displayToTrueLatLon, trueToDisplayLatLon } from '../../app/src/moon/frame.ts';
import {
  Footprint, TILE, ScienceBlockCache, buildScienceMips, buildSciencePreview, compositeSciencePixels, polarGeometry, polarRho,
  pixelMetres, sampleScience, sampleScienceChunks, scienceCodeAt, scienceGlobalFootprint, sciencePalette, scienceUsesPreview, unfilterScienceSub, type Raster, type Rect,
} from '../../app/src/moon/imageryWorker.ts';

const DEG = Math.PI / 180, R = 1737400;
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};
const centre = (r: Rect, i: number, j: number) => ({
  lon: r.west + (i + 0.5) / TILE * (r.east - r.west),
  lat: r.north - (j + 0.5) / TILE * (r.north - r.south),
});

// North and south must use the same true longitude, with opposite map-y direction.
for (const north of [false, true]) {
  let worst = 0;
  for (const lon of [-170, -90, -35, 0, 45, 130, 179]) {
    const at = trueToDisplayLatLon(north ? 85 : -85, lon), fp = new Footprint();
    const r = { west: at.lon - 0.01, east: at.lon + 0.01, south: at.lat - 0.01, north: at.lat + 0.01 };
    polarGeometry(fp, r, polarRho(-65), 0, 770400, north);
    for (const [i, j] of [[0, 0], [128, 128], [255, 255]]) {
      const c = centre(r, i, j), real = displayToTrueLatLon(c.lat, c.lon), p = j * TILE + i;
      const rho = 2 * R * Math.tan((90 - Math.abs(real.lat)) * DEG / 2);
      const x = rho * Math.sin(real.lon * DEG), y = (north ? -1 : 1) * rho * Math.cos(real.lon * DEG);
      worst = Math.max(worst, Math.hypot(fp.a[p] - x, fp.b[p] - y));
    }
  }
  check(`${north ? 'North' : 'South'} science map coordinates match the independent Moon frame`, worst < 0.1, `${worst.toExponential(2)} m`);
}

const raster: Raster = { levels: [{ w: 8192, h: 4096, ch: 1, data: new Uint8Array(0) }] };
let worstPixel = 0;
for (const [lat, lon] of [[0.674, 23.473], [45, -179.9], [-75, 179.9], [82, 41], [-89, -137]]) {
  const at = trueToDisplayLatLon(lat, lon), fp = new Footprint();
  const r = { west: at.lon - 0.01, east: at.lon + 0.01, south: at.lat - 0.01, north: at.lat + 0.01 };
  scienceGlobalFootprint(fp, r, 4, raster);
  for (const [i, j] of [[0, 0], [128, 128], [255, 255]]) {
    const c = centre(r, i, j), real = displayToTrueLatLon(c.lat, c.lon), p = j * TILE + i;
    const u = (real.lon + 180) / 360 * 8192 - 0.5, v = (90 - real.lat) / 180 * 4096 - 0.5;
    worstPixel = Math.max(worstPixel, Math.abs(fp.u[p] - u), Math.abs(fp.v[p] - v));
  }
}
check('Whole-Moon science pixels align at Apollo 11, both poles and the date line', worstPixel < 0.002, `${worstPixel.toExponential(2)} px`);

const palette = sciencePalette(['#00000000', '#ffff00ff', '#ff0000ff']);
const mixed = buildScienceMips({ w: 2, h: 2, ch: 1, data: new Uint8Array([1, 1, 2, 0]) }, palette);
check('Sharp class source remains one byte per pixel', mixed.levels[0].data.byteLength === 4);
check('Science retains no RGBA mip chain', mixed.levels.length === 1);
const preview = buildSciencePreview(mixed.levels[0], palette, 1);
check('Class minification averages colours and coverage rather than inventing a class number',
  preview.data.join(',') === '255,170,0,191', preview.data.join(','));
const shadowPalette = sciencePalette(['#488cdc00', '#488cdcc8', '#00000000']);
const shadow = buildScienceMips({ w: 64, h: 64, ch: 1, data: Uint8Array.from({ length: 4096 }, (_, p) => p % 2) }, shadowPalette);
check('PSR keeps only its indexed source', shadow.levels.length === 1 && shadow.levels[0].ch === 1);
check('The south-pole view requests sharp blocks rather than its 1.2 km preview', !scienceUsesPreview(pixelMetres(6), 608000 / 512));
check('The whole-Moon view requests blocks once it outgrows the 21 km preview', !scienceUsesPreview(pixelMetres(3), 2 * Math.PI * R / 512));
check('The root view uses the small whole-Moon preview', scienceUsesPreview(pixelMetres(0), 2 * Math.PI * R / 512));
const packed = { w: 4, h: 1, ch: 1 as const, bits: 2 as const, data: new Uint8Array([0b00011011]) };
check('Two-bit maps read all four classes without expansion', [0, 1, 2, 3].every(i => scienceCodeAt(packed, i) === i));
const reconstructed = unfilterScienceSub(new Uint8Array([2, 10, 20, 3, 2, 5, 90, 80, 70, 2, 3, 4]), 2, 2, 3);
check('Sub reconstruction uses the same channel and resets each row', reconstructed.join(',') === '2,10,20,5,12,25,90,80,70,92,83,74');
const cache = new ScienceBlockCache(8);
cache.put('a', 'map-a', { w: 4, h: 1, ch: 1, data: new Uint8Array(4) }, 0);
cache.put('b', 'map-b', { w: 4, h: 1, ch: 1, data: new Uint8Array(4) }, 1);
cache.get('a', 2); cache.put('c', 'map-c', { w: 4, h: 1, ch: 1, data: new Uint8Array(4) }, 3);
check('Decoded blocks obey their hard byte bound and keep the recently used block', cache.bytes === 8 && !!cache.get('a', 3) && !cache.get('b', 3));
cache.trim(120004, new Set(['map-a']));
check('Idle expiry removes inactive blocks and keeps active ones', cache.bytes === 4 && cache.bytesFor('map-a') === 4);

const fp = new Footprint(); fp.lvl.fill(0); fp.taps.fill(1); fp.cov.fill(1); fp.u.fill(0); fp.v.fill(0);
const red = sampleScience(fp, { levels: [{ w: 1, h: 1, ch: 1, data: new Uint8Array([2]) }] }, palette, false, true);
check('An indexed class paints its palette colour', red?.[0] === 255 && red?.[1] === 0 && red?.[3] === 255);
fp.u.fill(2);
const packedRed = sampleScienceChunks(fp, 4, 1, 4, new Map([[0, packed]]), palette, false, true);
check('A packed source block paints its palette colour', packedRed?.[0] === 255 && packedRed?.[1] === 0 && packedRed?.[3] === 255);
fp.u.fill(0.5); fp.v.fill(0.5);
const splitTiles = new Map([1, 1, 2, 0].map((code, i) => [i, { w: 1, h: 1, ch: 1 as const, data: new Uint8Array([code]) }]));
const blended = sampleScienceChunks(fp, 2, 2, 1, splitTiles, palette, false, true);
check('Class mixtures across block edges average real colours and coverage', blended?.slice(0, 4).join(',') === '255,170,0,191');
const coarse = new Uint8ClampedArray(TILE * TILE * 4); coarse.fill(255);
const coverage = new Float32Array(TILE * TILE); coverage[0] = 1;
compositeSciencePixels(coarse, null, coverage, true, true);
check('Sharp known-clear terrain erases a coarse hazard inside its coverage', coarse[3] === 0);
check('Replacing a cap leaves the map outside that cap unchanged', coarse[7] === 255);
const evidence = new Uint8ClampedArray(TILE * TILE * 4); evidence[3] = 255;
compositeSciencePixels(evidence, null, coverage, true, false);
check('An empty prediction does not erase an orbital evidence map', evidence[3] === 255);
if (failures) process.exitCode = 1;
else console.log('All science imagery checks passed.');
