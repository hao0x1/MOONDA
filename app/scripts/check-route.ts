// Run from app/: node scripts/check-route.ts. Reads the real local LOLA maps; no browser or server.
// Timings are on a shared machine, with other development sessions running.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { RouteOptions, RouteResult } from '../src/science/route.ts';
import type { Crater } from '../src/moon/craterField.ts';
import type { WalkEnv } from '../src/moon/walk.ts';

const appSrc = new URL('../src/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL?.startsWith(appSrc)) {
      return nextResolve(specifier + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    // SpotFrame is also used by the UI. Its dev-only window hook has no role in this Node check.
    if (url.endsWith('/moon/roverLink.ts') && result.source) {
      const source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
      return { ...result, source: source.replaceAll('import.meta.env.DEV', 'false') };
    }
    return result;
  },
});
const netFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (!String(input).startsWith('file:')) return netFetch(input, init);
  try { return new Response(await readFile(fileURLToPath(String(input)))); }
  catch { return new Response(null, { status: 404 }); }
}) as typeof fetch;

const { MoonHeights } = await import('../src/science/heights.ts');
const { planRoute, planFarRoute } = await import('../src/science/route.ts');
const { makeFineSurface } = await import('../src/science/routeFine.ts');
const { ROUTE_MAX_SLOPE_DEG, ROUTE_DRIVE, drivingSpeed } = await import('../src/science/routeSpeed.ts');
const { craterAtCell, craterRelief } = await import('../src/moon/craterField.ts');
const { SpotFrame } = await import('../src/moon/roverLink.ts');
const base = new URL('../public/data/', import.meta.url);
const heights = new MoonHeights(base.href);
await heights.ready;
// Node Buffers can be views into a larger allocation: copy only the file's bytes.
const bytes = async (file: string) => Uint8Array.from(await readFile(new URL(file, base))).buffer;
const data = {
  sunlight: new Uint16Array(await bytes('layers/sunlight.bin')),
  earth: new Uint16Array(await bytes('layers/earth.bin')),
  psr: new Uint16Array(await bytes('layers/ice.bin')),
  craters: new Float32Array(await bytes('features/craters.bin')),
};
const spot = { lat: -89.45, lon: -137.3 };
await heights.loadTilesAround(spot.lat, spot.lon, 6000);
const surface = makeFineSurface(spot, heights);
const point = (e: number, n: number) => {
  const ll = surface.frame.toLatLon(e, n);
  return { lat: ll[0], lon: ll[1] };
};
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
let failures = 0;
function check(ok: unknown, name: string) {
  if (!ok) { failures++; console.error('FAIL:', name); }
}
function sample(path: Float64Array, fn: (e: number, n: number, distance: number) => void, step = 0.2) {
  let distance = 0;
  for (let i = 2; i < path.length; i += 2) {
    const a = surface.frame.toEN(path[i - 2], path[i - 1]);
    const b = surface.frame.toEN(path[i], path[i + 1]);
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]), steps = Math.max(1, Math.ceil(d / step));
    for (let j = 0; j <= steps; j++) {
      const t = j / steps;
      fn(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, distance + d * t);
    }
    distance += d;
  }
  return distance;
}
function fineStats(result: RouteResult, all = false) {
  let total = 0;
  sample(result.path, (_e, _n, d) => { total = d; }, 2);
  let maxSlope = 0, minRelief = 0;
  sample(result.path, (e, n, d) => {
    if (!all && d > 600 && d < total - 150) return;
    maxSlope = Math.max(maxSlope, surface.slope(e, n));
    minRelief = Math.min(minRelief, craterRelief(e, n));
  });
  return { maxSlope, minRelief };
}
function row(name: string, result: RouteResult, extra = {}) {
  console.log(JSON.stringify({ name, ok: result.ok, reason: result.reason, points: result.path.length / 2,
    metres: +result.lengthM.toFixed(2), seconds: result.driveS === undefined ? null : +result.driveS.toFixed(2),
    slope: +result.maxSlopeDeg.toFixed(3), ms: +result.ms.toFixed(1), ...extra }));
}

// Keep the worker's small force model tied to Driver, including its less forceful downhill brake.
{
  const { Cartesian3 } = await import('cesium');
  const { Driver, DRIVE, WALK } = await import('../src/moon/walk.ts');
  for (const [key, value] of Object.entries(ROUTE_DRIVE)) {
    if (key !== 'g') check(DRIVE[key as keyof typeof DRIVE] === value, `speed model follows DRIVE.${key}`);
  }
  check(WALK.g === ROUTE_DRIVE.g, 'speed model follows lunar gravity');
  const rows: { degrees: number; model: number; driven: number }[] = [];
  for (const degrees of [0, 10, 20, -10, -20, 25]) {
    const tangent = Math.tan(degrees * Math.PI / 180), driver = new Driver();
    const env: WalkEnv = { ground: p => p.z * tangent, obstacles: () => [] };
    driver.reset(new Cartesian3(1737400, 0, 0), new Cartesian3(0, 0, 1), 0, env);
    for (let i = 0; i < 120 * 60; i++) driver.step(1 / 120, { fwd: 1, turn: 0, fast: false }, env);
    const model = drivingSpeed(tangent);
    check(Math.abs(driver.speed - model) < 0.015, `speed model matches Driver at ${degrees} degrees`);
    rows.push({ degrees, model: +model.toFixed(4), driven: +driver.speed.toFixed(4) });
  }
  console.log(JSON.stringify({ name: 'Driver speed model, W held for 60 s', rows, limit: ROUTE_MAX_SLOPE_DEG }));
}

// Five radii, including a sub-cell bowl: smooth lines must respect the surface between grid centres.
const bowlCells = [[1, 0, 0], [0, 1, 0], [0, 2, -2], [1, 0, -1], [1, 0, -2]] as const;
const bowls: Crater[] = [];
for (const [scale, e, n] of bowlCells) {
  const c = craterAtCell(scale, e, n);
  assert.ok(c, 'the deterministic check bowl exists'); bowls.push(c);
  let angle = 0, best = Infinity;
  for (let k = 0; k < 24; k++) {
    const a = k * Math.PI / 24, de = 20 * Math.cos(a), dn = 20 * Math.sin(a);
    const aSlope = surface.slope(c.e - de, c.n - dn), bSlope = surface.slope(c.e + de, c.n + dn);
    const aDepth = craterRelief(c.e - de, c.n - dn), bDepth = craterRelief(c.e + de, c.n + dn);
    const score = Math.max(aSlope, bSlope) + 1000 * Math.max(0, -0.02 - aDepth, -0.02 - bDepth);
    if (score < best) { angle = a; best = score; }
  }
  const de = 20 * Math.cos(angle), dn = 20 * Math.sin(angle);
  const result = await planRoute({ from: point(c.e - de, c.n - dn), to: point(c.e + de, c.n + dn), spot, prefer: 'fastest' }, heights, data, pause);
  check(result.ok, `bowl ${scale}/${e}/${n}: route exists`);
  if (!result.ok) { row(`bowl ${scale}/${e}/${n}`, result); continue; }
  let minRadius = Infinity;
  sample(result.path, (pe, pn) => { minRadius = Math.min(minRadius, Math.hypot(pe - c.e, pn - c.n) / c.radius); });
  const stats = fineStats(result, true);
  check(minRadius >= 0.8 - 1e-4, `bowl ${scale}/${e}/${n}: line stays outside 0.8 radius (${minRadius})`);
  check(stats.minRelief >= -0.2501, `bowl ${scale}/${e}/${n}: deepest relief ${stats.minRelief}`);
  check(stats.maxSlope <= ROUTE_MAX_SLOPE_DEG + 0.001, `bowl ${scale}/${e}/${n}: fine slope ${stats.maxSlope}`);
  let maxGap = 0;
  for (let i = 2; i < result.path.length; i += 2) {
    const a = surface.frame.toEN(result.path[i - 2], result.path[i - 1]);
    const b = surface.frame.toEN(result.path[i], result.path[i + 1]);
    maxGap = Math.max(maxGap, Math.hypot(a[0] - b[0], a[1] - b[1]));
  }
  check(maxGap <= 2.01, `bowl ${scale}/${e}/${n}: map line spacing ${maxGap}`);
  row(`bowl ${scale}/${e}/${n}`, result, { radius: +c.radius.toFixed(3), minRadius: +minRadius.toFixed(3), ...stats });
}

// Warm terrain is intentional: this measures calculation time separately from reading NASA files.
const goalE = 3000;
let goalN = 0, bestGoal = Infinity;
for (let n = -40; n <= 40; n += 2) {
  const score = surface.slope(3000, n) + 1000 * Math.max(0, -0.02 - craterRelief(3000, n));
  if (score < bestGoal) { bestGoal = score; goalN = n; }
}
const polar: RouteOptions = { from: point(0, 0), to: point(goalE, goalN), spot, prefer: 'fastest' };
const fastest = await planRoute(polar, heights, data, pause);
const gentle = await planRoute({ ...polar, prefer: 'gentle' }, heights, data, pause);
for (const [name, result] of [['polar fastest', fastest], ['polar gentle', gentle]] as const) {
  check(result.ok, `${name}: route exists`);
  check(Number.isFinite(result.driveS) && result.driveS! > result.lengthM / 7 && result.driveS! < result.lengthM / 0.1, `${name}: sensible driving time`);
  const stats = result.ok ? fineStats(result) : { maxSlope: 0, minRelief: 0 };
  check(stats.maxSlope <= ROUTE_MAX_SLOPE_DEG + 0.001, `${name}: fine slope ${stats.maxSlope}`);
  check(stats.minRelief >= -0.2501, `${name}: clear fine stretches, relief ${stats.minRelief}`);
  row(name, result, { ...stats, timing: 'shared machine, warm heights; target <400 ms' });
}
check(fastest.driveS! <= gentle.driveS! + 1e-3, `fastest ${fastest.driveS}s takes no more time than gentle ${gentle.driveS}s`);
check(gentle.maxSlopeDeg <= fastest.maxSlopeDeg + 0.01, `gentle slope ${gentle.maxSlopeDeg} <= fastest ${fastest.maxSlopeDeg}`);

for (const [name, lat, lon, east, north] of [
  ['Fermat, 3 km east', -21.158, 22.397, 3000, 0], ['Apollo 11, 2 km north', 0.674, 23.473, 0, 2000],
] as const) {
  const frame = new SpotFrame(lat, lon), ll = frame.toLatLon(east, north);
  const opts = { from: { lat, lon }, to: { lat: ll[0], lon: ll[1] }, prefer: 'fastest' as const };
  const result = await planRoute(opts, heights, data, pause);
  check(result.ok, `${name}: route exists`);
  let crossed = 0;
  for (let c = 0; c < data.craters.length; c += 3) {
    const r = data.craters[c + 2] * 500;
    if (r > 40000 || r < 500) continue;
    const ctr = frame.toEN(data.craters[c], data.craters[c + 1]);
    const t = (ctr[0] * east + ctr[1] * north) / (east * east + north * north);
    if (t <= 0 || t >= 1 || Math.hypot(ctr[0], ctr[1]) <= r || Math.hypot(ctr[0] - east, ctr[1] - north) <= r) continue;
    if (Math.hypot(ctr[0] - east * t, ctr[1] - north * t) > r * 0.95) continue;
    crossed++;
    let minRadius = Infinity;
    for (let i = 2; i < result.path.length; i += 2) {
      const a = frame.toEN(result.path[i - 2], result.path[i - 1]), b = frame.toEN(result.path[i], result.path[i + 1]);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const q = Math.max(0, Math.min(1, ((ctr[0] - a[0]) * dx + (ctr[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      minRadius = Math.min(minRadius, Math.hypot(a[0] + q * dx - ctr[0], a[1] + q * dy - ctr[1]) / r);
    }
    check(minRadius >= 0.98, `${name}: catalogue rim clearance ${minRadius}`);
  }
  row(name, result, { catalogueCrossings: crossed });
}

// A controlled 5 km catalogue bowl straddles a 3 km chord in coarse whole-Moon data.
// Unlike a penalty, its unresolved wall must force a route round the outside of its rim.
{
  const frame = new SpotFrame(-21.158, 22.397), ll = frame.toLatLon(3000, 0), c = frame.toLatLon(1500, 2250);
  const result = await planRoute({ from: { lat: frame.lat, lon: frame.lon }, to: { lat: ll[0], lon: ll[1] } }, heights,
    { ...data, craters: new Float32Array([c[0], c[1], 5]) }, pause);
  check(result.ok, 'coarse catalogue shape: route exists');
  let minRadius = Infinity;
  for (let i = 2; i < result.path.length; i += 2) {
    const a = frame.toEN(result.path[i - 2], result.path[i - 1]), b = frame.toEN(result.path[i], result.path[i + 1]);
    const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((1500 - a[0]) * dx + (2250 - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    minRadius = Math.min(minRadius, Math.hypot(a[0] + t * dx - 1500, a[1] + t * dy - 2250) / 2500);
  }
  check(minRadius >= 0.98, `coarse catalogue shape: outside rim (${minRadius})`);
  row('coarse catalogue shape', result, { minRadius });
}

// The known fresh bowl has an unsafe east wall (>25 degrees) and a safe north-west side.
// A target inside it opens that bowl only, and forces a gentler approach than the direct line.
{
  const c = bowls[0], opts = { from: point(c.e + 20, c.n), to: point(c.e, c.n), spot };
  const result = await planRoute({ ...opts, prefer: 'gentle' }, heights, data, pause);
  const quick = await planRoute({ ...opts, prefer: 'fastest' }, heights, data, pause);
  let directSlope = 0, bestRadialSlope = Infinity;
  for (let a = 0; a < 360; a += 10) {
    let peak = 0;
    for (let r = 0; r <= c.radius * 1.5; r += 0.05) {
      peak = Math.max(peak, surface.slope(c.e + r * Math.cos(a * Math.PI / 180), c.n + r * Math.sin(a * Math.PI / 180)));
    }
    if (a === 0) directSlope = peak;
    bestRadialSlope = Math.min(bestRadialSlope, peak);
  }
  check(directSlope > ROUTE_MAX_SLOPE_DEG, 'destination inside bowl: direct approach is too steep');
  check(result.ok, 'destination inside bowl: route exists');
  if (result.ok) {
    const stats = fineStats(result, true);
    check(stats.maxSlope <= ROUTE_MAX_SLOPE_DEG + 0.001, `destination inside bowl: safe ingress ${stats.maxSlope}`);
    check(stats.maxSlope < directSlope, 'destination inside bowl: enters by a gentler side than the straight approach');
    // Grid headings and curved ingress do not have exactly the same peak as a radial ray.
    check(stats.maxSlope <= bestRadialSlope + 0.5, 'destination inside bowl: approaches the gentlest radial side within half a degree');
    const last = surface.frame.toEN(result.path.at(-2)!, result.path.at(-1)!);
    check(Math.hypot(last[0] - c.e, last[1] - c.n) < 0.01, 'destination inside bowl: reaches its centre');
    row('destination inside bowl', result, { ...stats, directSlope, bestRadialSlope,
      fastestSlope: quick.ok ? fineStats(quick, true).maxSlope : null });
  }
}

// No spot means exactly the far level; balanced remains an alias for fastest.
{
  const opts = { ...polar, spot: undefined };
  const a = await planRoute(opts, heights, data, pause), b = await planFarRoute(opts, heights, data, pause);
  const withoutTiming = ({ ms: _ms, ...value }: RouteResult) => value;
  check(JSON.stringify(withoutTiming(a)) === JSON.stringify(withoutTiming(b)), 'no spot equals far level alone');
  const balanced = await planRoute({ ...opts, prefer: 'balanced' }, heights, data, pause);
  check(JSON.stringify(a.path) === JSON.stringify(balanced.path) && a.driveS === balanced.driveS, 'balanced equals fastest');
  row('no spot equals far; balanced equals fastest', a);
}
console.log(JSON.stringify({ check: 'route', result: failures ? 'FAIL' : 'OK', failures, timing: 'shared machine; no browser started' }));
assert.equal(failures, 0, `${failures} route checks failed`);
