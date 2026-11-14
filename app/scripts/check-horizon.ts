// Sanity-check the skyline + sunlight maths on well-known places.
// Needs the dev server running (npm run dev). Run: node scripts/check-horizon.ts
import { analyseSpot, statsFor } from '../src/science/analysis.ts';
import { stateSeries } from '../src/science/ephemeris.ts';
import { MoonHeights } from '../src/science/heights.ts';
import { computeHorizon } from '../src/science/terrain.ts';

const heights = new MoonHeights(process.argv[2] ?? 'http://127.0.0.1:5190/data/');
await heights.ready;
const start = Date.UTC(2026, 0, 1), days = 365, step = 120;
const states = stateSeries(start, start + days * 864e5, step * 60000);
for (const [name, lat, lon] of [
  ['Shackleton floor', -89.67, 129.78],
  ['Connecting ridge (Shackleton-de Gerlache)', -89.45, -137.3],
  ['Mons Malapert summit', -85.98, -1.67],
  ['Haworth floor', -87.45, -5.17],
  ['Faustini floor', -87.18, 84.31],
  ['Tycho floor (mid-latitude, 1.9 km data)', -43.3, -11.2],
  ['Apollo 11 (near side)', 0.67, 23.47],
  ["Chang'e-4 (far side)", -45.44, 177.59],
] as const) {
  if (lat < -79.5) await heights.loadTilesAround(lat, lon, 20000);
  const h = computeHorizon(lat, lon, 2, heights);
  const s = statsFor(analyseSpot(h, states, step * 60000));
  console.log(`${name.padEnd(42)} ground ${h.groundM.toFixed(0).padStart(6)} m  ${h.ms.toFixed(0).padStart(3)} ms  sun ${s.sunPct.toFixed(1).padStart(5)}%  earth ${s.earthPct.toFixed(1).padStart(5)}%  longest dark ${(s.longestDarkH / 24).toFixed(1)} d`);
}
