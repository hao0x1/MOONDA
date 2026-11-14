// The first and last part of a drive use the same small craters as the wheels and the drawn ground.
// A 2 m search stays within 60 m of the orbital route. Every final straight piece is checked at 0.4 m,
// so smoothing cannot turn a safe detour back into a line through a small bowl or stone.
import { craterAtCell, craterRelief, CRATER_PHYSICAL_SCALES, CRATER_ROTATIONS, CRATER_SCALES, type Crater } from '../moon/craterField.ts';
import type { MoonHeights } from './heights.ts';
import type { RouteOptions } from './route.ts';
import { drivingSpeed, edgeSeconds, ROUTE_MAX_SLOPE_DEG } from './routeSpeed.ts';
import { makeRockField } from './routeRocks.ts';

const R = 1737400, DEG = Math.PI / 180;
export const FINE_CELL_M = 2, FINE_START_M = 600, FINE_END_M = 150, FINE_BAND_M = 60;
const SAMPLE_M = 0.4;
type XY = [number, number];

/** SpotFrame's east/north basis, in the true Moon frame (rotation into Cesium preserves dot products).
 * lander.ts fixes rockE/rockN and lvCraterEast/lvCraterNorth at the landing spot. Its rockOrigin is radial,
 * so subtracting it adds zero east/north. lolaTerrain.ts sampleRelief uses (R + LOLA + relief), rather
 * than SpotFrame's nominal R: retaining that radius avoids moving a bowl by metres on a long drive. */
export class LandingFrame {
  private east: [number, number, number];
  private north: [number, number, number];
  private up: [number, number, number];
  private heights: MoonHeights;
  constructor(spot: { lat: number; lon: number }, heights: MoonHeights) {
    const p = spot.lat * DEG, l = spot.lon * DEG, cp = Math.cos(p), sp = Math.sin(p), cl = Math.cos(l), sl = Math.sin(l);
    this.up = [cp * cl, cp * sl, sp]; this.east = [-sl, cl, 0]; this.north = [-sp * cl, -sp * sl, cp]; this.heights = heights;
  }
  unit(e: number, n: number, radius = R): [number, number, number] {
    const a = e / radius, b = n / radius, c = Math.sqrt(Math.max(0, 1 - a * a - b * b));
    return [a * this.east[0] + b * this.north[0] + c * this.up[0], a * this.east[1] + b * this.north[1] + c * this.up[1], a * this.east[2] + b * this.north[2] + c * this.up[2]];
  }
  toEN(lat: number, lon: number): XY {
    const p = lat * DEG, l = lon * DEG, cp = Math.cos(p), x = cp * Math.cos(l), y = cp * Math.sin(l), z = Math.sin(p);
    const de = x * this.east[0] + y * this.east[1] + z * this.east[2], dn = x * this.north[0] + y * this.north[1] + z * this.north[2];
    const rr = R + this.heights.heightAt(lat, lon, true), lift = craterRelief(rr * de, rr * dn);
    // The second sample is exactly lolaTerrain.ts sampleRelief's radial correction.
    const finalR = rr + craterRelief((rr + lift) * de, (rr + lift) * dn);
    return [finalR * de, finalR * dn];
  }
  toLatLon(e: number, n: number): XY {
    let u = this.unit(e, n);
    for (let i = 0; i < 2; i++) u = this.unit(e, n, R + this.heights.heightAtUnit(...u, true) + craterRelief(e, n));
    return [Math.asin(Math.max(-1, Math.min(1, u[2]))) / DEG, Math.atan2(u[1], u[0]) / DEG];
  }
  /** LOLA under the given final east/north position. */
  baseHeight(e: number, n: number): number {
    let u = this.unit(e, n);
    const h = this.heights.heightAtUnit(...u, true);
    u = this.unit(e, n, R + h + craterRelief(e, n));
    return this.heights.heightAtUnit(...u, true);
  }
}

export function makeFineSurface(spot: { lat: number; lon: number }, heights: MoonHeights) {
  const frame = new LandingFrame(spot, heights);
  const height = (e: number, n: number) => frame.baseHeight(e, n) + craterRelief(e, n);
  // 25 cm probes resolve the smallest 1.3 m bowls; an 80 m slope probe would erase them.
  const slope = (e: number, n: number) => {
    const d = 0.25, ge = (height(e + d, n) - height(e - d, n)) / (2 * d), gn = (height(e, n + d) - height(e, n - d)) / (2 * d);
    return Math.atan(Math.hypot(ge, gn)) / DEG;
  };
  return { frame, height, slope, at: (lat: number, lon: number) => { const [e, n] = frame.toEN(lat, lon); return { e, n, heightM: height(e, n), slopeDeg: slope(e, n) }; } };
}

class FineHeap {
  ids: number[] = []; costs: number[] = [];
  push(id: number, cost: number) {
    let k = this.ids.length; this.ids.push(id); this.costs.push(cost);
    while (k) { const p = (k - 1) >> 1; if (this.costs[p] <= cost) break; this.ids[k] = this.ids[p]; this.costs[k] = this.costs[p]; k = p; }
    this.ids[k] = id; this.costs[k] = cost;
  }
  pop(): number {
    const id = this.ids[0], last = this.ids.pop()!, c = this.costs.pop()!;
    if (this.ids.length) { let k = 0; while (2 * k + 1 < this.ids.length) { let j = 2 * k + 1; if (j + 1 < this.ids.length && this.costs[j + 1] < this.costs[j]) j++; if (this.costs[j] >= c) break; this.ids[k] = this.ids[j]; this.costs[k] = this.costs[j]; k = j; } this.ids[k] = last; this.costs[k] = c; }
    return id;
  }
}
const DIRS: XY[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

function clipPath(points: XY[], distances: number[], a: number, b: number): XY[] {
  const at = (d: number): XY => {
    let k = 1; while (k < distances.length - 1 && distances[k] < d) k++;
    const t = (d - distances[k - 1]) / Math.max(1e-9, distances[k] - distances[k - 1]);
    return [points[k - 1][0] + (points[k][0] - points[k - 1][0]) * t, points[k - 1][1] + (points[k][1] - points[k - 1][1]) * t];
  };
  const out = [at(a)];
  for (let k = 1; k < points.length - 1; k++) if (distances[k] > a && distances[k] < b) out.push(points[k]);
  out.push(at(b)); return out;
}

/** A mask of which returned points used the fine ground lets the route summary keep the orbital middle honest. */
export interface FineRoute { path: Float64Array; fine: Uint8Array }
export async function refineRouteDetailed(path: Float64Array, opt: RouteOptions, heights: MoonHeights, pause: () => Promise<void>, allowed?: (lat: number, lon: number) => boolean, envCost?: (lat: number, lon: number) => number): Promise<FineRoute | null> {
  if (!opt.spot || path.length < 4) return { path, fine: new Uint8Array(path.length / 2) };
  const surface = makeFineSurface(opt.spot, heights), frame = surface.frame, rocks = makeRockField(opt.spot);
  const points: XY[] = [], distances = [0];
  for (let k = 0; k < path.length; k += 2) { const p = frame.toEN(path[k], path[k + 1]); if (points.length) distances.push(distances[distances.length - 1] + Math.hypot(p[0] - points[points.length - 1][0], p[1] - points[points.length - 1][1])); points.push(p); }
  const total = distances[distances.length - 1];
  let slice = performance.now();
  const breathe = async () => { if (performance.now() - slice >= 20) { await pause(); slice = performance.now(); } };

  const solve = async (line: XY[]): Promise<XY[] | null> => {
    const a = line[0], b = line[line.length - 1], angle = Math.atan2(b[1] - a[1], b[0] - a[0]), ca = Math.cos(angle), sa = Math.sin(angle);
    const toGrid = (p: XY): XY => [(p[0] - a[0]) * ca + (p[1] - a[1]) * sa, -(p[0] - a[0]) * sa + (p[1] - a[1]) * ca];
    const toEN = (x: number, y: number): XY => [a[0] + x * ca - y * sa, a[1] + x * sa + y * ca];
    const guide = line.map(toGrid), gb = guide[guide.length - 1];
    const x0 = Math.floor((Math.min(...guide.map(p => p[0])) - FINE_BAND_M) / FINE_CELL_M) * FINE_CELL_M;
    const y0 = Math.floor((Math.min(...guide.map(p => p[1])) - FINE_BAND_M) / FINE_CELL_M) * FINE_CELL_M;
    const nx = Math.ceil((Math.max(...guide.map(p => p[0])) + FINE_BAND_M - x0) / FINE_CELL_M) + 1, ny = Math.ceil((Math.max(...guide.map(p => p[1])) + FINE_BAND_M - y0) / FINE_CELL_M) + 1, count = nx * ny;
    // Only the short ends are refined: even a folded guide must not allocate a Moon-sized array.
    if (count > 250000) return null;
    const cellOf = (p: XY) => Math.max(0, Math.min(ny - 1, Math.round((p[1] - y0) / FINE_CELL_M))) * nx + Math.max(0, Math.min(nx - 1, Math.round((p[0] - x0) / FINE_CELL_M)));
    const start = cellOf([0, 0]), goal = cellOf(gb);
    const gridXY = (k: number): XY => k === start ? [0, 0] : k === goal ? gb : [x0 + (k % nx) * FINE_CELL_M, y0 + ((k / nx) | 0) * FINE_CELL_M];
    const position = (k: number): XY => { const [x, y] = gridXY(k); return toEN(x, y); };
    const closed = new Uint8Array(count), known = new Uint8Array(count), z = new Float64Array(count), slopes = new Float32Array(count), environment = new Float32Array(count).fill(1);
    const circles: Crater[] = [], exempt: Crater[] = [];
    const bowlCells = Array.from({ length: CRATER_PHYSICAL_SCALES }, () => new Map<string, Crater>());
    // Enumerating cells catches even bowls narrower than one search cell. Their rim and a half-diagonal
    // clearance are closed, rather than hoping a grid centre happened to land in the hollow.
    const corners = [toEN(x0, y0), toEN(x0 + (nx - 1) * FINE_CELL_M, y0), toEN(x0, y0 + (ny - 1) * FINE_CELL_M), toEN(x0 + (nx - 1) * FINE_CELL_M, y0 + (ny - 1) * FINE_CELL_M)];
    for (let sc = 0; sc < CRATER_PHYSICAL_SCALES; sc++) {
      const S = CRATER_SCALES[sc], rot = CRATER_ROTATIONS[sc], rr = corners.map(p => [(rot[0] * p[0] - rot[1] * p[1]) / S, (rot[1] * p[0] + rot[0] * p[1]) / S]);
      const minE = Math.floor(Math.min(...rr.map(p => p[0]))) - 1, maxE = Math.ceil(Math.max(...rr.map(p => p[0]))) + 1, minN = Math.floor(Math.min(...rr.map(p => p[1]))) - 1, maxN = Math.ceil(Math.max(...rr.map(p => p[1]))) + 1;
      for (let ce = minE; ce <= maxE; ce++) {
        for (let cn = minN; cn <= maxN; cn++) {
          const c = craterAtCell(sc, ce, cn); if (!c) continue;
          if (Math.hypot(a[0] - c.e, a[1] - c.n) < c.radius || Math.hypot(b[0] - c.e, b[1] - c.n) < c.radius) { exempt.push(c); continue; }
          circles.push(c);
          bowlCells[sc].set(`${ce}:${cn}`, c);
          const q = toGrid([c.e, c.n]), rad = c.radius + Math.SQRT2 + 0.1;
          const i0 = Math.max(0, Math.floor((q[0] - rad - x0) / FINE_CELL_M)), i1 = Math.min(nx - 1, Math.ceil((q[0] + rad - x0) / FINE_CELL_M));
          const j0 = Math.max(0, Math.floor((q[1] - rad - y0) / FINE_CELL_M)), j1 = Math.min(ny - 1, Math.ceil((q[1] + rad - y0) / FINE_CELL_M));
          for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (Math.hypot(x0 + i * FINE_CELL_M - q[0], y0 + j * FINE_CELL_M - q[1]) < rad) closed[j * nx + i] = 1;
        }
        if ((ce & 7) === 0) await breathe();
      }
    }
    const inBand = (x: number, y: number) => {
      for (let k = 1; k < guide.length; k++) {
        const p = guide[k - 1], q = guide[k], dx = q[0] - p[0], dy = q[1] - p[1], t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / Math.max(1e-9, dx * dx + dy * dy)));
        if (Math.hypot(x - p[0] - t * dx, y - p[1] - t * dy) <= FINE_BAND_M) return true;
      }
      return false;
    };
    const open = (k: number): boolean => {
      if (closed[k]) return false; if (known[k]) return true;
      const p = position(k), q = gridXY(k);
      const rockMargin = k === start || k === goal ? 0.1 : Math.SQRT2 + 0.1;
      if (!inBand(...q) || rocks.blocked(...p, rockMargin)) { closed[k] = 1; return false; }
      if (allowed || envCost) { const ll = frame.toLatLon(...p); if (allowed && !allowed(...ll)) { closed[k] = 1; return false; } if (envCost) environment[k] = Math.max(1, envCost(...ll)); }
      z[k] = surface.height(...p); slopes[k] = surface.slope(...p);
      if (slopes[k] > ROUTE_MAX_SLOPE_DEG - 0.05) { closed[k] = 1; return false; }
      known[k] = 1; return true;
    };
    // A pin can sit just outside a bowl yet inside the grid's extra clearance. Keep exact pin safety,
    // then let its first short edge escape that clearance (the hollow itself remains closed).
    for (const k of [start, goal]) {
      const p = position(k); closed[k] = 0;
      if (circles.some(c => Math.hypot(p[0] - c.e, p[1] - c.n) < c.radius)) return null;
      if (!open(k)) return null;
    }
    const gentle = opt.prefer === 'gentle';
    const weight = (s: number) => gentle ? 1 + 7 * (s / 12) ** 2 : 1;
    const maxSpeed = drivingSpeed(-Math.tan(ROUTE_MAX_SLOPE_DEG * DEG), 0);
    const inspect = (p: XY): { h: number; slope: number; env: number } | null => {
      if (rocks.blocked(...p, 0.1)) return null;
      const c = toGrid(p); if (!inBand(...c)) return null;
      // A shallow bowl still deserves a visible detour. Checking the exact crater cell here
      // prevents a shortcut through its middle even when its depth happens to stay below 25 cm.
      for (let sc = 0; sc < CRATER_PHYSICAL_SCALES; sc++) {
        const S = CRATER_SCALES[sc], rot = CRATER_ROTATIONS[sc];
        const ce = Math.floor((rot[0] * p[0] - rot[1] * p[1]) / S), cn = Math.floor((rot[1] * p[0] + rot[0] * p[1]) / S);
        const bowl = bowlCells[sc].get(`${ce}:${cn}`);
        if (bowl && Math.hypot(p[0] - bowl.e, p[1] - bowl.n) < bowl.radius * 0.85) return null;
      }
      // Outside a target bowl, any negative relief deeper than 25 cm must be avoided, even if
      // two small profiles overlap. A target inside a bowl is allowed down its driveable side.
      if (craterRelief(...p) < -0.25 && !exempt.some(c => Math.hypot(p[0] - c.e, p[1] - c.n) <= c.radius)) return null;
      let env = 1;
      if (allowed || envCost) { const ll = frame.toLatLon(...p); if (allowed && !allowed(...ll)) return null; if (envCost) env = Math.max(1, envCost(...ll)); }
      const slope = surface.slope(...p); if (slope > ROUTE_MAX_SLOPE_DEG) return null;
      return { h: surface.height(...p), slope, env };
    };
    const segment = (a: XY, b: XY): number => {
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(d / SAMPLE_M));
      let prev = inspect(a), sum = 0; if (!prev) return Infinity;
      for (let s = 1; s <= n; s++) { const p: XY = [a[0] + (b[0] - a[0]) * s / n, a[1] + (b[1] - a[1]) * s / n], now = inspect(p); if (!now) return Infinity; sum += edgeSeconds(d / n, now.h - prev.h, Math.max(now.slope, prev.slope)) * weight((now.slope + prev.slope) / 2) * (now.env + prev.env) / 2; prev = now; }
      return sum;
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const g = new Float64Array(count).fill(Infinity), prev = new Int32Array(count).fill(-1), done = new Uint8Array(count), heap = new FineHeap();
      g[start] = 0; heap.push(start, 0); let pops = 0;
      while (heap.ids.length) {
        const k = heap.pop(); if (done[k]) continue; done[k] = 1; if (k === goal) break;
        const i = k % nx, j = (k / nx) | 0, p = position(k);
        for (const [di, dj] of DIRS) {
          const i2 = i + di, j2 = j + dj; if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny) continue;
          const k2 = j2 * nx + i2; if (done[k2] || !open(k2)) continue;
          if (di && dj && (!open(k + di) || !open(k + dj * nx))) continue;
          const q = position(k2), d = Math.hypot(q[0] - p[0], q[1] - p[1]);
          const cost = edgeSeconds(d, z[k2] - z[k], (slopes[k] + slopes[k2]) / 2) * weight((slopes[k] + slopes[k2]) / 2) * (environment[k] + environment[k2]) / 2;
          const ng = g[k] + cost;
          if (ng < g[k2]) { g[k2] = ng; prev[k2] = k; heap.push(k2, ng + Math.hypot(q[0] - b[0], q[1] - b[1]) / maxSpeed); }
        }
        if ((++pops & 127) === 0) await breathe();
      }
      if (!done[goal]) return null;
      const cells: number[] = []; for (let k = goal; k !== -1; k = prev[k]) cells.push(k); cells.reverse();
      const raw = cells.map(position), costs = [0]; let bad = false;
      for (let k = 1; k < raw.length; k++) {
        const c = segment(raw[k - 1], raw[k]);
        if (!Number.isFinite(c)) { if (cells[k] !== goal) closed[cells[k]] = 1; if (cells[k - 1] !== start) closed[cells[k - 1]] = 1; bad = true; }
        costs.push(costs[costs.length - 1] + c); if ((k & 31) === 0) await breathe();
      }
      if (bad) continue;
      const smooth = [raw[0]]; let k = 0;
      while (k < raw.length - 1) {
        let best = k + 1;
        // Shortcuts are accepted only when both safe and no dearer than the search line.
        for (let j = Math.min(raw.length - 1, k + 16); j > k + 1; j--) if (segment(raw[k], raw[j]) <= (costs[j] - costs[k]) * 1.001) { best = j; break; }
        smooth.push(raw[best]); k = best; await breathe();
      }
      const dense = [smooth[0]];
      for (let k = 1; k < smooth.length; k++) { const p = smooth[k - 1], q = smooth[k], n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / FINE_CELL_M)); for (let s = 1; s <= n; s++) dense.push([p[0] + (q[0] - p[0]) * s / n, p[1] + (q[1] - p[1]) * s / n] as XY); }
      return dense;
    }
    return null;
  };

  const all = total <= FINE_START_M + FINE_END_M;
  const firstEnd = all ? total : FINE_START_M, lastStart = Math.max(firstEnd, total - FINE_END_M);
  const first = await solve(clipPath(points, distances, 0, firstEnd)); if (!first) return null;
  const result: XY[] = [...first], mask: number[] = first.map(() => 1);
  if (!all) {
    const middle = clipPath(points, distances, firstEnd, lastStart);
    for (let k = 1; k < middle.length; k++) { result.push(middle[k]); mask.push(k === middle.length - 1 ? 1 : 0); }
    const last = await solve(clipPath(points, distances, lastStart, total)); if (!last) return null;
    for (let k = 1; k < last.length; k++) { result.push(last[k]); mask.push(1); }
  }
  const out = new Float64Array(result.length * 2);
  for (let k = 0; k < result.length; k++) { const ll = frame.toLatLon(...result[k]); out[k * 2] = ll[0]; out[k * 2 + 1] = ll[1]; if ((k & 63) === 0) await breathe(); }
  out[0] = path[0]; out[1] = path[1]; out[out.length - 2] = path[path.length - 2]; out[out.length - 1] = path[path.length - 1];
  return { path: out, fine: Uint8Array.from(mask) };
}

export async function refineRoute(path: Float64Array, opt: RouteOptions, heights: MoonHeights, pause: () => Promise<void>, allowed?: (lat: number, lon: number) => boolean, envCost?: (lat: number, lon: number) => number): Promise<Float64Array | null> {
  return (await refineRouteDetailed(path, opt, heights, pause, allowed, envCost))?.path ?? null;
}
