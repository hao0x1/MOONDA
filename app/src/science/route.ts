// Two levels of route prediction, using the rover's driving time as the cost.
// The far grid reads NASA heights and unresolved catalogue crater shapes. The near grid uses
// the same small bowls as the terrain, in the landing frame, and checks between its 2 m cells.
// Orbital data and the invented small terrain remain a prediction, rather than a surveyed traverse.
// No React or Cesium: this runs in the science worker and in Node checks.

import { discFraction } from './analysis.ts';
import { angularRadiusDeg, azEl, EARTH_RADIUS_M, localFrame, MOON_RADIUS_M, SUN_RADIUS_M, type Vec3 } from './ephemeris.ts';
import { MoonHeights, toMap } from './heights.ts';
import { fromMap } from './terrain.ts';
import { edgeSeconds, ROUTE_MAX_SLOPE_DEG, ROUTE_MAX_SPEED_MPS } from './routeSpeed.ts';
import { buildCatalogueCraters, catalogueAt } from './routeCraters.ts';
import { makeFineSurface, refineRouteDetailed } from './routeFine.ts';

const R = MOON_RADIUS_M;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------
// One direction of the skyline, and a point's Sun / Earth / slope (cheap enough for mouse-hover)
// ---------------------------------------------------------------------------------------------

const tables = new Map<number, { d: Float64Array; c: Float64Array; s: Float64Array }>();
/** The distances the skyline is sampled at: exactly those of computeHorizon (terrain.ts), so both always agree. */
function marchTable(resolution: number, maxRangeM = 300000) {
  let t = tables.get(resolution);
  if (t) return t;
  const dists: number[] = [];
  const nearStep = Math.max(40, resolution / 2);
  for (let s = nearStep; s < 20000; s += nearStep) dists.push(s);
  for (let s = Math.max(20000, nearStep); s < maxRangeM; s += Math.max(160 + s * 0.004, resolution / 2)) dists.push(s);
  const n = dists.length;
  t = { d: Float64Array.from(dists), c: new Float64Array(n), s: new Float64Array(n) };
  for (let k = 0; k < n; k++) { t.c[k] = Math.cos(dists[k] / R); t.s[k] = Math.sin(dists[k] / R); }
  tables.set(resolution, t);
  return t;
}

/** How high the hills stand (degrees) in ONE compass direction from a spot: one ray of computeHorizon. About 0.05 ms. */
export function skylineToward(lat: number, lon: number, mastM: number, azDeg: number, heights: MoonHeights, groundM?: number): number {
  const ground = groundM ?? heights.heightAt(lat, lon, true);
  const h0 = R + ground + mastM;
  const p = lat * DEG, l = lon * DEG, cp = Math.cos(p), sp = Math.sin(p), cl = Math.cos(l), sl = Math.sin(l);
  const a = azDeg * DEG, ca = Math.cos(a), sa = Math.sin(a);
  // up, and the direction walked: north * cos(az) + east * sin(az)
  const ux0 = cp * cl, uy0 = cp * sl, uz0 = sp;
  const dx = ca * -sp * cl + sa * -sl, dy = ca * -sp * sl + sa * cl, dz = ca * cp;
  const t = marchTable(MoonHeights.resolutionAt(lat));
  let best = -90;
  for (let k = 0, n = t.d.length; k < n; k++) {
    const h = heights.heightAtUnit(ux0 * t.c[k] + dx * t.s[k], uy0 * t.c[k] + dy * t.s[k], uz0 * t.c[k] + dz * t.s[k], t.d[k] < 18000);
    const r = R + h;
    const el = Math.atan2(r * t.c[k] - h0, r * t.s[k]) / DEG;
    if (el > best) best = el;
  }
  return best;
}

/** How steep the ground is at a point (degrees), read `d` metres either side (80 near the pole, 1900 elsewhere by default). */
export function slopeAt(lat: number, lon: number, heights: MoonHeights, d = MoonHeights.resolutionAt(lat)): number {
  const p = lat * DEG, l = lon * DEG, cp = Math.cos(p), sp = Math.sin(p), cl = Math.cos(l), sl = Math.sin(l);
  const U = [cp * cl, cp * sl, sp], E = [-sl, cl, 0], N = [-sp * cl, -sp * sl, cp];
  const a = d / R, ca = Math.cos(a), sa = Math.sin(a);
  const at = (D: number[], s: number) => heights.heightAtUnit(U[0] * ca + s * D[0] * sa, U[1] * ca + s * D[1] * sa, U[2] * ca + s * D[2] * sa, true);
  const gE = (at(E, 1) - at(E, -1)) / (2 * d), gN = (at(N, 1) - at(N, -1)) / (2 * d);
  return Math.atan(Math.hypot(gE, gN)) / DEG;
}

export interface PointProbe {
  groundM: number;
  slopeDeg: number;
  /** share of the Sun's / Earth's disc above the hills (0 = hidden, 1 = all of it) */
  sunPart: number; earthPart: number;
  /** height above the flat horizon (degrees) */
  sunEl: number; earthEl: number;
}

/** Sun and Earth as seen from a point at one moment (`sun` / `earth`: metres from the Moon's centre, true frame), with the ground's height and slope. */
export function probePoint(lat: number, lon: number, mastM: number, sun: Vec3, earth: Vec3, heights: MoonHeights): PointProbe {
  const groundM = heights.heightAt(lat, lon, true);
  const fr = localFrame({ lat, lon, heightM: groundM + mastM });
  const s = azEl(fr, sun), e = azEl(fr, earth);
  // (well below the flat horizon nothing can show: no need to trace the hills)
  const sunPart = s.el < -3 ? 0 : discFraction(s.el, skylineToward(lat, lon, mastM, s.az, heights, groundM), angularRadiusDeg(SUN_RADIUS_M, s.dist));
  const earthPart = e.el < -3 ? 0 : discFraction(e.el, skylineToward(lat, lon, mastM, e.az, heights, groundM), angularRadiusDeg(EARTH_RADIUS_M, e.dist));
  return { groundM, slopeDeg: slopeAt(lat, lon, heights), sunPart, earthPart, sunEl: s.el, earthEl: e.el };
}

// ---------------------------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------------------------

/** 'fastest' is the default: the least driving time. ('balanced' is its older name, kept so saved choices still load.) */
export type RoutePrefer = 'fastest' | 'balanced' | 'sun' | 'earth' | 'gentle';

export interface RouteOptions {
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  mastM?: number;
  prefer?: RoutePrefer;
  /** The landing spot of the open surface view: the small craters and rocks the rover really meets are laid out in its frame. */
  spot?: { lat: number; lon: number };
  /** Sun and Earth at the time on the time bar (true frame, metres): the route also says where they can be seen right then. */
  sun?: Vec3; earth?: Vec3;
}

/** NASA's polar maps on the 2048 x 2048 grid (Uint16, value x 0.01 %; 65535 = no data), and the crater list (lat, lon, km across, biggest first). */
export interface RouteData { sunlight: Uint16Array | null; earth: Uint16Array | null; psr: Uint16Array | null; craters: Float32Array | null }

export interface RouteResult {
  ok: boolean;
  /** why there is no route: the pins are the same place, too far apart, or every way is too steep */
  reason?: 'same' | 'far' | 'blocked';
  /** lat, lon, lat, lon ... along the route (true degrees) */
  path: Float64Array;
  /** per point: ground height (m), slope (deg), NASA long-term sunlight and Earth-in-view (%; NaN where NASA has no map), permanent shadow (0 / 1) */
  heightM: Float32Array; slopeDeg: Float32Array; sunPct: Float32Array; earthPct: Float32Array; psr: Uint8Array;
  /** per point, at the time given: 1 = any of the Sun / Earth shows above the hills (empty when no time was given) */
  sunNow: Uint8Array; earthNow: Uint8Array;
  lengthM: number; straightM: number; climbM: number; descentM: number;
  /** driving time (s) at the rover's real speeds on these slopes, when the planner worked it out */
  driveS?: number;
  maxSlopeDeg: number; meanSlopeDeg: number;
  /** averages along the route: NASA long-term sunlight and Earth-in-view (%; NaN outside the polar maps), share in permanent shadow (0..1) */
  sunPct_: number; earthPct_: number; psrShare: number;
  /** share of the route with the Sun / Earth in view at the time given (0..1; NaN when no time was given) */
  sunNowShare: number; earthNowShare: number;
  /** size of a grid cell (m), the detail of the heights under it (80 or 1900 m), and true if it had to cross ground steeper than the usual limit */
  cellM: number; dataResM: number; steep: boolean;
  prefer: RoutePrefer;
  ms: number;
}

// These are extra seconds per second of travel, not a change to the reported driving time.
// Old "balanced" choices are exactly the same objective as "fastest".
const WEIGHTS: Record<RoutePrefer, { slope: number; sun: number; earth: number; psr: number }> = {
  fastest: { slope: 0, sun: 0, earth: 0, psr: 0 },
  balanced: { slope: 0, sun: 0, earth: 0, psr: 0 },
  gentle: { slope: 8, sun: 0, earth: 0, psr: 0 },
  sun: { slope: 0, sun: 3, earth: 0.3, psr: 2.5 },
  earth: { slope: 0, sun: 0.5, earth: 3, psr: 1 },
};
const BLOCK_DEG = ROUTE_MAX_SLOPE_DEG;
const POLAR_ROUTE_LAT = -80.3, POLAR_HALF = 303000;
const P_HALF = 304000, P_N = 2048, P_RES = 296.875;

function emptyResult(reason: RouteResult['reason'], prefer: RoutePrefer, t0: number): RouteResult {
  return {
    ok: false, reason, path: new Float64Array(0), heightM: new Float32Array(0), slopeDeg: new Float32Array(0), sunPct: new Float32Array(0), earthPct: new Float32Array(0),
    psr: new Uint8Array(0), sunNow: new Uint8Array(0), earthNow: new Uint8Array(0), lengthM: 0, straightM: 0, climbM: 0, descentM: 0, maxSlopeDeg: 0, meanSlopeDeg: 0,
    sunPct_: NaN, earthPct_: NaN, psrShare: 0, sunNowShare: NaN, earthNowShare: NaN, cellM: 0, dataResM: 0, steep: false, prefer, ms: performance.now() - t0,
  };
}

function greatCircleM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const p1 = a.lat * DEG, p2 = b.lat * DEG, dl = (b.lon - a.lon) * DEG;
  const s = Math.sin((p2 - p1) / 2), c = Math.sin(dl / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s * s + Math.cos(p1) * Math.cos(p2) * c * c)));
}

/** A value of one of NASA's polar maps at a place (nearest pixel), or NaN. */
function polarValue(map: Uint16Array | null, lat: number, lon: number): number {
  if (!map || lat > -79.9) return NaN;
  const [x, y] = toMap(lat, lon);
  const col = Math.floor((x + P_HALF) / P_RES), row = Math.floor((P_HALF - y) / P_RES);
  if (col < 0 || row < 0 || col >= P_N || row >= P_N) return NaN;
  const raw = map[row * P_N + col];
  return raw === 65535 ? NaN : raw;
}

/** The grid's flat frame: polar map metres near the pole, a flat frame round the midpoint elsewhere. */
interface Frame {
  polar: boolean;
  /** frame metres -> true lat / lon */
  toLatLon(u: number, v: number): [number, number];
  /** true lat / lon -> frame metres */
  toUV(lat: number, lon: number): [number, number];
  /** ground metres per frame metre at a frame point (the polar map stretches a little away from the pole) */
  scale(u: number, v: number): number;
}

function polarFrame(): Frame {
  return {
    polar: true,
    toLatLon: (u, v) => fromMap(u, v),
    toUV: (lat, lon) => toMap(lat, lon),
    scale: (u, v) => 1 / (1 + (u * u + v * v) / (4 * R * R)),
  };
}

function localFrameUV(lat0: number, lon0: number): Frame {
  const p = lat0 * DEG, l = lon0 * DEG, cp = Math.cos(p), sp = Math.sin(p), cl = Math.cos(l), sl = Math.sin(l);
  const U = [cp * cl, cp * sl, sp], E = [-sl, cl, 0], N = [-sp * cl, -sp * sl, cp];
  return {
    polar: false,
    toLatLon: (u, v) => {
      const a = u / R, b = v / R, c = Math.sqrt(Math.max(0, 1 - a * a - b * b));
      const x = a * E[0] + b * N[0] + c * U[0], y = a * E[1] + b * N[1] + c * U[1], z = a * E[2] + b * N[2] + c * U[2];
      return [Math.asin(Math.max(-1, Math.min(1, z))) / DEG, Math.atan2(y, x) / DEG];
    },
    toUV: (lat, lon) => {
      const q = lat * DEG, m = lon * DEG, cq = Math.cos(q), x = cq * Math.cos(m), y = cq * Math.sin(m), z = Math.sin(q);
      return [R * (x * E[0] + y * E[1] + z * E[2]), R * (x * N[0] + y * N[1] + z * N[2])];
    },
    scale: () => 1,
  };
}

/** A small binary heap of cell numbers ordered by a priority. */
class Heap {
  private ids: Int32Array; private pri: Float32Array; size = 0;
  constructor(cap: number) { this.ids = new Int32Array(cap); this.pri = new Float32Array(cap); }
  push(id: number, p: number) {
    if (this.size >= this.ids.length) {
      const ids = new Int32Array(this.ids.length * 2), pri = new Float32Array(this.pri.length * 2);
      ids.set(this.ids); pri.set(this.pri); this.ids = ids; this.pri = pri;
    }
    let i = this.size++;
    const ids = this.ids, pri = this.pri;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (pri[up] <= p) break;
      ids[i] = ids[up]; pri[i] = pri[up]; i = up;
    }
    ids[i] = id; pri[i] = p;
  }
  pop(): number {
    const ids = this.ids, pri = this.pri, top = ids[0];
    const n = --this.size;
    if (n > 0) {
      const id = ids[n], p = pri[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && pri[c + 1] < pri[c]) c++;
        if (pri[c] >= p) break;
        ids[i] = ids[c]; pri[i] = pri[c]; i = c;
      }
      ids[i] = id; pri[i] = p;
    }
    return top;
  }
}

// 16 directions: the 8 neighbours and the 8 "knight" moves between them (smoother headings than 8 alone)
const MOVES: readonly (readonly number[])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
  [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2],
];

/**
 * Find the route. `pause` is awaited every 25 ms or so of work, so the caller's thread can answer other
 * requests in between (the worker passes a 0 ms timer).
 */
export async function planFarRoute(opt: RouteOptions, heights: MoonHeights, data: RouteData, pause: () => Promise<void> = async () => {}, guard?: { allowed?: (lat: number, lon: number) => boolean }): Promise<RouteResult> {
  const t0 = performance.now();
  const prefer = opt.prefer ?? 'fastest', W = WEIGHTS[prefer], mastM = opt.mastM ?? 2;
  const straightM = greatCircleM(opt.from, opt.to);
  if (!(straightM > 5)) return emptyResult('same', prefer, t0);
  await heights.ready;
  const polar = opt.from.lat <= POLAR_ROUTE_LAT && opt.to.lat <= POLAR_ROUTE_LAT;
  if (straightM > (polar ? 450000 : 900000)) return emptyResult('far', prefer, t0);

  // ---- the grid ----
  const fr = polar ? polarFrame() : localFrameUV((opt.from.lat + opt.to.lat) / 2, midLon(opt.from.lon, opt.to.lon));
  const [ua, va] = fr.toUV(opt.from.lat, opt.from.lon), [ub, vb] = fr.toUV(opt.to.lat, opt.to.lon);
  const len = Math.hypot(ub - ua, vb - va);
  const minCell = polar ? 40 : 160;
  let cell = Math.max(minCell, len / 170);
  const margin = Math.max(polar ? 1200 : 4000, 0.3 * len);
  let u0 = Math.min(ua, ub) - margin, u1 = Math.max(ua, ub) + margin, v0 = Math.min(va, vb) - margin, v1 = Math.max(va, vb) + margin;
  if (polar) { u0 = Math.max(u0, -POLAR_HALF); u1 = Math.min(u1, POLAR_HALF); v0 = Math.max(v0, -POLAR_HALF); v1 = Math.min(v1, POLAR_HALF); }
  while (((u1 - u0) / cell + 2) * ((v1 - v0) / cell + 2) > 150000) cell *= 1.15;
  const nx = Math.max(3, Math.ceil((u1 - u0) / cell) + 1), ny = Math.max(3, Math.ceil((v1 - v0) / cell) + 1), n = nx * ny;
  // the sharp 80 m tiles only where the cells are fine enough to use them (a long route reads the 240 m map: no 50 MB download)
  if (polar && cell <= 320) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([heights.loadTiles(u0, v0, u1, v1, 64), new Promise(res => { timer = setTimeout(res, 20000); })]); }
    finally { clearTimeout(timer); }
  }
  const dataResM = polar ? (cell <= 320 ? 80 : 240) : 1900;

  let slice = performance.now();
  const breathe = async () => { if (performance.now() - slice > 20) { await pause(); slice = performance.now(); } };

  const z = new Float32Array(n), slope = new Float32Array(n), mult = new Float32Array(n), gscale = new Float32Array(n);
  const sunC = new Float32Array(n), earthC = new Float32Array(n);
  const psrC = new Uint8Array(n), craterClosed = new Uint8Array(n);
  const inferred = await buildCatalogueCraters(data.craters, fr, { u0, v0, u1, v1 }, cell, dataResM, [ua, va], [ub, vb], pause);
  // An outline has no surveyed ramp. For a pin already inside, its measured heights decide
  // the way in or out; a symmetric inferred wall must not invent an inescapable ring.
  const shapeGround = inferred.filter(c => !c.endpointInside);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const u = u0 + i * cell, v = v0 + j * cell, k = j * nx + i;
      const [lat, lon] = fr.toLatLon(u, v);
      const bowl = catalogueAt(shapeGround, u, v);
      z[k] = heights.heightAt(lat, lon, true) + bowl.heightM;
      craterClosed[k] = bowl.blocked ? 1 : 0;
      gscale[k] = fr.scale(u, v);
      if (polar) {
        const s = polarValue(data.sunlight, lat, lon), e = polarValue(data.earth, lat, lon), p = polarValue(data.psr, lat, lon);
        sunC[k] = Number.isNaN(s) ? NaN : s * 0.01 / 100; earthC[k] = Number.isNaN(e) ? NaN : e * 0.01 / 100;
        psrC[k] = p >= 1 ? 1 : 0;
      } else { sunC[k] = NaN; earthC[k] = NaN; }
    }
    if ((j & 7) === 0) await breathe();
  }
  // Slope from centred differences on the ground.
  for (let j = 0; j < ny; j++) { for (let i = 0; i < nx; i++) {
    const k = j * nx + i, g = cell * gscale[k];
    const il = i > 0 ? k - 1 : k, ir = i < nx - 1 ? k + 1 : k, jd = j > 0 ? k - nx : k, ju = j < ny - 1 ? k + nx : k;
    const gx = (z[ir] - z[il]) / ((ir - il) * g || g), gy = (z[ju] - z[jd]) / (((ju - jd) / nx) * g || g);
    slope[k] = Math.atan(Math.hypot(gx, gy)) / DEG;
  } if ((j & 7) === 0) await breathe(); }
  await breathe();
  // The inferred shape is used only below the detail of the height map. Its wall cannot
  // disappear between grid samples, and a route with both pins outside stays outside its rim.
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i, s = slope[k];
      const sun = Number.isNaN(sunC[k]) ? 0.5 : sunC[k], earth = Number.isNaN(earthC[k]) ? 0.5 : earthC[k];
      mult[k] = 1 + W.slope * (s / 12) ** 2 + W.sun * (1 - sun) + W.earth * (1 - earth) + W.psr * psrC[k];
    }
    if ((j & 7) === 0) await breathe();
  }

  const cellOf = (u: number, v: number) => {
    const i = Math.max(0, Math.min(nx - 1, Math.round((u - u0) / cell))), j = Math.max(0, Math.min(ny - 1, Math.round((v - v0) / cell)));
    return j * nx + i;
  };
  const start = cellOf(ua, va), goal = cellOf(ub, vb);
  const gi = goal % nx, gj = (goal / nx) | 0;

  // ---- A* ----
  const search = async (limitDeg: number): Promise<Int32Array | null> => {
    const g = new Float32Array(n).fill(Infinity), came = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    const open = (k: number) => (!craterClosed[k] && slope[k] <= limitDeg) || k === start || k === goal;
    const heap = new Heap(4096);
    g[start] = 0;
    heap.push(start, 0);
    let pops = 0;
    while (heap.size) {
      const k = heap.pop();
      if (done[k]) continue;
      done[k] = 1;
      if (k === goal) break;
      const i = k % nx, j = (k / nx) | 0, gk = g[k], zk = z[k], mk = mult[k], sk = gscale[k];
      for (let m = 0; m < 16; m++) {
        const di = MOVES[m][0], dj = MOVES[m][1], i2 = i + di, j2 = j + dj;
        if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny) continue;
        const k2 = j2 * nx + i2;
        if (done[k2] || !open(k2)) continue;
        // a diagonal or knight move also passes over the cells beside it: they must be open too
        if (m >= 4) {
          if (m < 8) { if (!open(k + di) || !open(k + dj * nx)) continue; }
          else {
            const ai = Math.abs(di) === 2 ? i + Math.sign(di) : i, aj = Math.abs(dj) === 2 ? j + Math.sign(dj) : j;
            const bi = Math.abs(di) === 2 ? i + Math.sign(di) : i + di, bj = Math.abs(dj) === 2 ? j + Math.sign(dj) : j + dj;
            if (!open(aj * nx + ai) || !open(bj * nx + bi)) continue;
          }
        }
        const flat = Math.hypot(di, dj) * cell * sk, dz = z[k2] - zk;
        const cost = edgeSeconds(flat, dz, Math.max(slope[k], slope[k2])) * 0.5 * (mk + mult[k2]);
        const ng = gk + cost;
        if (ng < g[k2]) {
          g[k2] = ng; came[k2] = k;
          heap.push(k2, ng + Math.hypot(i2 - gi, j2 - gj) * cell * 0.985 / ROUTE_MAX_SPEED_MPS); // the straight-line guess (never more than the true cost)
        }
      }
      if ((++pops & 255) === 0) await breathe();
    }
    if (!done[goal]) return null;
    const cells: number[] = [];
    for (let k = goal; k !== -1; k = came[k]) cells.push(k);
    return Int32Array.from(cells.reverse());
  };
  const steep = false;
  const cells = await search(BLOCK_DEG);
  if (!cells) return emptyResult('blocked', prefer, t0);
  const limit = BLOCK_DEG;

  // ---- straighten and round off (in grid units) ----
  let px: number[] = [], py: number[] = [];
  for (const k of cells) { px.push(k % nx); py.push((k / nx) | 0); }
  // the ends are the pins themselves, not the middles of their cells (two pins in one cell are still two points)
  px[0] = (ua - u0) / cell; py[0] = (va - v0) / cell;
  if (px.length === 1) { px.push((ub - u0) / cell); py.push((vb - v0) / cell); }
  else { px[px.length - 1] = (ub - u0) / cell; py[py.length - 1] = (vb - v0) / cell; }
  /** cost of driving straight from a to b (grid units), or Infinity if it crosses closed ground */
  const shut = (k: number) => (slope[k] > limit || craterClosed[k]) && k !== start && k !== goal;
  if (guard) guard.allowed = (lat, lon) => {
    const [u, v] = fr.toUV(lat, lon);
    if (u < u0 || u > u1 || v < v0 || v > v1 || catalogueAt(shapeGround, u, v).blocked) return false;
    return !shut(cellOf(u, v));
  };
  const segCost = (ax: number, ay: number, bx: number, by: number): number => {
    // sampled every fifth of a cell, and where the line steps diagonally into the next cell the two cells it
    // passes between are checked as well: no closed cell can be crossed, not even by a corner
    const d = Math.hypot(bx - ax, by - ay), steps = Math.max(1, Math.ceil(d * 5));
    let sum = 0, prevZ = 0, prevK = -1, pi = 0, pj = 0;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, i = Math.max(0, Math.min(nx - 1, Math.round(ax + (bx - ax) * t))), j = Math.max(0, Math.min(ny - 1, Math.round(ay + (by - ay) * t)));
      const k = j * nx + i;
      if (shut(k)) return Infinity;
      if (s > 0 && i !== pi && j !== pj && (shut(pj * nx + i) || shut(j * nx + pi))) return Infinity;
      pi = i; pj = j;
      const su = u0 + (ax + (bx - ax) * t) * cell, sv = v0 + (ay + (by - ay) * t) * cell;
      if (catalogueAt(inferred, su, sv).blocked) return Infinity;
      // Height along the line must be continuous: jumping between nearest cells invents steps.
      const fx = Math.max(0, Math.min(nx - 1.00001, ax + (bx - ax) * t)), fy = Math.max(0, Math.min(ny - 1.00001, ay + (by - ay) * t));
      const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy, q = iy * nx + ix;
      const h = (z[q] * (1 - tx) + z[q + 1] * tx) * (1 - ty) + (z[q + nx] * (1 - tx) + z[q + nx + 1] * tx) * ty;
      if (s > 0) sum += edgeSeconds(d / steps * cell * gscale[k], h - prevZ, Math.max(slope[k], slope[prevK])) * 0.5 * (mult[k] + mult[prevK]);
      prevZ = h;
      prevK = k;
    }
    return sum;
  };
  if (px.length > 2) {
    const leg: number[] = [0];
    for (let i = 1; i < px.length; i++) {
      const cost = segCost(px[i - 1], py[i - 1], px[i], py[i]);
      // Moving the end from its cell centre to the exact pin must not cross closed ground.
      if (!Number.isFinite(cost)) return emptyResult('blocked', prefer, t0);
      leg.push(leg[i - 1] + cost);
      if ((i & 31) === 0) await breathe();
    }
    const qx = [px[0]], qy = [py[0]];
    let i = 0;
    while (i < px.length - 1) {
      let best = i + 1;
      for (let j = Math.min(px.length - 1, i + 90); j > i + 1; j--) {
        const shortcut = segCost(px[i], py[i], px[j], py[j]);
        if (Number.isFinite(shortcut) && shortcut <= (leg[j] - leg[i]) * 1.001 + 1e-6) { best = j; break; }
      }
      qx.push(px[best]); qy.push(py[best]);
      i = best;
      await breathe();
    }
    px = qx; py = qy;
  }
  // corners cut twice (Chaikin), kept only if every piece of the rounded line stays on open ground
  // first: a point at least every 3 cells, so the rounding stays near the line that was costed
  const dense = (x: number[], y: number[], step: number) => {
    const ox = [x[0]], oy = [y[0]];
    for (let i = 1; i < x.length; i++) {
      const d = Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]), m = Math.max(1, Math.ceil(d / step));
      for (let s = 1; s <= m; s++) { ox.push(x[i - 1] + (x[i] - x[i - 1]) * s / m); oy.push(y[i - 1] + (y[i] - y[i - 1]) * s / m); }
    }
    return [ox, oy] as const;
  };
  [px, py] = dense(px, py, 3);
  for (let it = 0; it < 2 && px.length > 2; it++) {
    const cx = [px[0]], cy = [py[0]];
    for (let i = 0; i < px.length - 1; i++) {
      cx.push(0.75 * px[i] + 0.25 * px[i + 1], 0.25 * px[i] + 0.75 * px[i + 1]);
      cy.push(0.75 * py[i] + 0.25 * py[i + 1], 0.25 * py[i] + 0.75 * py[i + 1]);
    }
    cx.push(px[px.length - 1]); cy.push(py[py.length - 1]);
    let bad = false;
    for (let i = 1; i < cx.length && !bad; i++) bad = segCost(cx[i - 1], cy[i - 1], cx[i], cy[i]) === Infinity;
    if (bad) break;
    px = cx; py = cy;
  }
  // a point every half cell (15 m at least), at most 1500 of them
  let total = 0;
  for (let i = 1; i < px.length; i++) total += Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1]);
  const stepG = Math.max(0.5, 15 / cell, total / 1500);
  [px, py] = dense(px, py, stepG);
  // (dense() only splits long pieces: drop points that sit closer than a third of a step, keeping both ends)
  {
    const ox = [px[0]], oy = [py[0]];
    for (let i = 1; i < px.length - 1; i++) if (Math.hypot(px[i] - ox[ox.length - 1], py[i] - oy[oy.length - 1]) >= stepG * 0.34) { ox.push(px[i]); oy.push(py[i]); }
    ox.push(px[px.length - 1]); oy.push(py[py.length - 1]);
    // Removing a corner creates a new chord. Keep the dense safe version if that chord
    // would cut a closed cell; checking only before thinning would miss this last change.
    let safe = true;
    for (let i = 1; i < ox.length && safe; i++) {
      safe = Number.isFinite(segCost(ox[i - 1], oy[i - 1], ox[i], oy[i]));
      if ((i & 31) === 0) await breathe();
    }
    if (safe) { px = ox; py = oy; }
  }
  for (let i = 1; i < px.length; i++) {
    if (!Number.isFinite(segCost(px[i - 1], py[i - 1], px[i], py[i]))) return emptyResult('blocked', prefer, t0);
    if ((i & 31) === 0) await breathe();
  }
  await breathe();

  // ---- what the route is like ----
  const m = px.length;
  const path = new Float64Array(m * 2), heightM = new Float32Array(m), slopeDeg = new Float32Array(m), sunPct = new Float32Array(m), earthPct = new Float32Array(m), psr = new Uint8Array(m);
  let lengthM = 0, driveS = 0, climbM = 0, descentM = 0, maxSlope = 0, sumSlope = 0, sumSun = 0, nSun = 0, sumEarth = 0, nEarth = 0, nPsr = 0;
  let pz = 0;
  for (let i = 0; i < m; i++) {
    const u = u0 + px[i] * cell, v = v0 + py[i] * cell;
    const [lat, lon] = i === 0 ? [opt.from.lat, opt.from.lon] : i === m - 1 ? [opt.to.lat, opt.to.lon] : fr.toLatLon(u, v);
    path[i * 2] = lat; path[i * 2 + 1] = lon;
    const h = heights.heightAt(lat, lon, true) + catalogueAt(shapeGround, u, v).heightM;
    heightM[i] = h;
    const cg = catalogueAt(shapeGround, u, v);
    const s = Math.max(slopeAt(lat, lon, heights, polar ? 80 : 1900), Math.atan(Math.hypot(cg.gU, cg.gV)) / DEG);
    slopeDeg[i] = s; sumSlope += s; if (s > maxSlope) maxSlope = s;
    const sv = polarValue(data.sunlight, lat, lon), ev = polarValue(data.earth, lat, lon), pv2 = polarValue(data.psr, lat, lon);
    sunPct[i] = Number.isNaN(sv) ? NaN : sv * 0.01; earthPct[i] = Number.isNaN(ev) ? NaN : ev * 0.01;
    if (!Number.isNaN(sv)) { sumSun += sv * 0.01; nSun++; }
    if (!Number.isNaN(ev)) { sumEarth += ev * 0.01; nEarth++; }
    psr[i] = pv2 >= 1 ? 1 : 0; nPsr += psr[i];
    if (i > 0) {
      // (measured over the Moon's surface between the points themselves, so no map projection is in the number)
      const flat = greatCircleM({ lat: path[i * 2 - 2], lon: path[i * 2 - 1] }, { lat, lon }), dz = h - pz;
      lengthM += Math.hypot(flat, dz);
      driveS += edgeSeconds(flat, dz, Math.max(slopeDeg[i - 1], s));
      if (dz > 0) climbM += dz; else descentM -= dz;
    }
    pz = h;
    if ((i & 127) === 0) await breathe();
  }
  // the Sun and Earth at the time given, at up to 64 places along the way (each stands for the points round it)
  let sunNow = new Uint8Array(0), earthNow = new Uint8Array(0), sunNowShare = NaN, earthNowShare = NaN;
  if (opt.sun && opt.earth) {
    sunNow = new Uint8Array(m); earthNow = new Uint8Array(m);
    const samples = Math.min(m, 64);
    let ns = 0, ne = 0;
    for (let s = 0; s < samples; s++) {
      const i = samples === 1 ? 0 : Math.round(s * (m - 1) / (samples - 1));
      const pr = probePoint(path[i * 2], path[i * 2 + 1], mastM, opt.sun, opt.earth, heights);
      const i0 = samples === 1 ? 0 : Math.round((s - 0.5) * (m - 1) / (samples - 1)), i1 = samples === 1 ? m - 1 : Math.round((s + 0.5) * (m - 1) / (samples - 1));
      const sv = pr.sunPart > 0.001 ? 1 : 0, ev = pr.earthPart > 0.001 ? 1 : 0;
      for (let k = Math.max(0, i0); k <= Math.min(m - 1, i1); k++) { sunNow[k] = sv; earthNow[k] = ev; }
      ns += sv; ne += ev;
      if ((s & 7) === 0) await breathe();
    }
    sunNowShare = ns / samples; earthNowShare = ne / samples;
  }
  return {
    ok: true, path, heightM, slopeDeg, sunPct, earthPct, psr, sunNow, earthNow,
    lengthM, driveS, straightM, climbM, descentM, maxSlopeDeg: maxSlope, meanSlopeDeg: sumSlope / m,
    sunPct_: nSun ? sumSun / nSun : NaN, earthPct_: nEarth ? sumEarth / nEarth : NaN, psrShare: nPsr / m,
    sunNowShare, earthNowShare, cellM: cell, dataResM, steep, prefer, ms: performance.now() - t0,
  };
}

/** The longitude half-way between two (the short way round). */
function midLon(a: number, b: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return ((a + d / 2 + 540) % 360) - 180;
}


/** The public two-level planner; omitting spot is exactly the far planner, with no invented near field. */
export async function planRoute(opt: RouteOptions, heights: MoonHeights, data: RouteData, pause: () => Promise<void> = async () => {}): Promise<RouteResult> {
  const t0 = performance.now();
  const guard: { allowed?: (lat: number, lon: number) => boolean } = {};
  const far = await planFarRoute(opt, heights, data, pause, guard);
  if (!far.ok || !opt.spot) return far;
  const W = WEIGHTS[far.prefer];
  const environment = W.sun || W.earth || W.psr ? (lat: number, lon: number) => {
    const s = polarValue(data.sunlight, lat, lon), e = polarValue(data.earth, lat, lon);
    return 1 + W.sun * (1 - (Number.isNaN(s) ? 0.5 : s / 10000))
      + W.earth * (1 - (Number.isNaN(e) ? 0.5 : e / 10000)) + W.psr * (polarValue(data.psr, lat, lon) >= 1 ? 1 : 0);
  } : undefined;
  const refined = await refineRouteDetailed(far.path, opt, heights, pause, guard.allowed, environment);
  // Never quietly return a straight, unsafe line when the fine search cannot get through.
  if (!refined) return emptyResult('blocked', far.prefer, t0);
  const { path, fine } = refined, m = path.length / 2;
  const ground = makeFineSurface(opt.spot, heights);
  const heightM = new Float32Array(m), slopeDeg = new Float32Array(m), sunPct = new Float32Array(m), earthPct = new Float32Array(m), psr = new Uint8Array(m);
  const sunNow = far.sunNow.length ? new Uint8Array(m) : new Uint8Array(0), earthNow = far.earthNow.length ? new Uint8Array(m) : new Uint8Array(0);
  const fr = localFrameUV(opt.spot.lat, opt.spot.lon);
  const old = Array.from({ length: far.path.length / 2 }, (_, i) => fr.toUV(far.path[i * 2], far.path[i * 2 + 1]));
  let lengthM = 0, driveS = 0, climbM = 0, descentM = 0, maxSlopeDeg = 0, meanSlopeDeg = 0;
  let sunSum = 0, sunN = 0, earthSum = 0, earthN = 0, psrSum = 0, sunNowSum = 0, earthNowSum = 0;
  let slice = performance.now();
  for (let i = 0; i < m; i++) {
    const lat = path[i * 2], lon = path[i * 2 + 1], [u, v] = fr.toUV(lat, lon);
    let near = 0, best = Infinity;
    for (let j = 0; j < old.length; j++) { const d = (u - old[j][0]) ** 2 + (v - old[j][1]) ** 2; if (d < best) { best = d; near = j; } }
    if (fine[i]) { const at = ground.at(lat, lon); heightM[i] = at.heightM; slopeDeg[i] = at.slopeDeg; }
    else { heightM[i] = far.heightM[near]; slopeDeg[i] = far.slopeDeg[near]; }
    const sv = polarValue(data.sunlight, lat, lon), ev = polarValue(data.earth, lat, lon);
    sunPct[i] = Number.isNaN(sv) ? NaN : sv * 0.01; earthPct[i] = Number.isNaN(ev) ? NaN : ev * 0.01;
    psr[i] = polarValue(data.psr, lat, lon) >= 1 ? 1 : 0;
    if (Number.isFinite(sunPct[i])) { sunSum += sunPct[i]; sunN++; }
    if (Number.isFinite(earthPct[i])) { earthSum += earthPct[i]; earthN++; }
    psrSum += psr[i];
    if (sunNow.length) { sunNow[i] = far.sunNow[near]; sunNowSum += sunNow[i]; }
    if (earthNow.length) { earthNow[i] = far.earthNow[near]; earthNowSum += earthNow[i]; }
    maxSlopeDeg = Math.max(maxSlopeDeg, slopeDeg[i]); meanSlopeDeg += slopeDeg[i];
    if (i) {
      const flat = greatCircleM({ lat: path[i * 2 - 2], lon: path[i * 2 - 1] }, { lat, lon }), dz = heightM[i] - heightM[i - 1];
      if (fine[i] && fine[i - 1]) {
        // A peak between two displayed points still counts. Read the same sub-cell surface
        // used to accept the line, including the ups and downs hidden by a 2 m chord.
        const a = ground.frame.toEN(path[i * 2 - 2], path[i * 2 - 1]), b = ground.frame.toEN(lat, lon);
        const d = Math.hypot(b[0] - a[0], b[1] - a[1]), count = Math.max(1, Math.ceil(d / 0.4));
        let lastH = ground.height(...a), lastSlope = ground.slope(...a);
        for (let k = 1; k <= count; k++) {
          const e = a[0] + (b[0] - a[0]) * k / count, n = a[1] + (b[1] - a[1]) * k / count;
          const h = ground.height(e, n), slope = ground.slope(e, n), rise = h - lastH;
          lengthM += Math.hypot(d / count, rise); driveS += edgeSeconds(d / count, rise, Math.max(slope, lastSlope));
          if (rise > 0) climbM += rise; else descentM -= rise;
          maxSlopeDeg = Math.max(maxSlopeDeg, slope); lastH = h; lastSlope = slope;
        }
      } else {
        lengthM += Math.hypot(flat, dz); driveS += edgeSeconds(flat, dz, Math.max(slopeDeg[i], slopeDeg[i - 1]));
        if (dz > 0) climbM += dz; else descentM -= dz;
      }
    }
    if ((i & 31) === 0 && performance.now() - slice > 20) { await pause(); slice = performance.now(); }
  }
  return { ...far, path, heightM, slopeDeg, sunPct, earthPct, psr, sunNow, earthNow,
    lengthM, driveS, climbM, descentM, maxSlopeDeg, meanSlopeDeg: meanSlopeDeg / m,
    sunPct_: sunN ? sunSum / sunN : NaN, earthPct_: earthN ? earthSum / earthN : NaN, psrShare: psrSum / m,
    sunNowShare: sunNow.length ? sunNowSum / m : NaN, earthNowShare: earthNow.length ? earthNowSum / m : NaN,
    ms: performance.now() - t0 };
}
