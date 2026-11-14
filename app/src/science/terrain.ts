// The "skyline" (terrain horizon) around a spot: the highest angle hills reach in each
// compass direction. If the Sun is lower than the skyline in its direction, a hill blocks it.
//
// Method: for each compass direction (every 0.5°) we walk outward along the Moon's curved
// surface (a true great circle), read the ground height from NASA's LOLA maps, and keep the
// steepest upward angle. Lunar curvature is exact because every sample is placed in 3D.

import { MOON_RADIUS_M } from './ephemeris.ts';
import { MoonHeights } from './heights.ts';

export { toMap } from './heights.ts';

const R = MOON_RADIUS_M;
const DEG = Math.PI / 180;

/** Inside the detailed (80 m) polar height map. */
export const POLAR_LIMIT_LAT = -80.2;

export function fromMap(x: number, y: number): [number, number] {
  const rho = Math.hypot(x, y);
  const c = 2 * Math.atan(rho / (2 * R));
  return [c / DEG - 90, Math.atan2(x, y) / DEG];
}

export interface HorizonResult {
  lat: number;
  lon: number;
  groundM: number; // ground height above the 1737.4 km sphere
  mastM: number;
  stepDeg: number;
  elevations: Float32Array; // skyline angle (deg) for azimuth i*stepDeg, clockwise from north
  blockerKm: Float32Array; // distance to the hill that sets the skyline
  maxRangeKm: number;
  resolutionM: number; // height-map detail used near the spot
  ms: number;
}

export function computeHorizon(lat: number, lon: number, mastM: number, heights: MoonHeights, stepDeg = 0.5, maxRangeM = 300000): HorizonResult {
  const t0 = performance.now();
  const ground = heights.heightAt(lat, lon, true);
  const h0 = R + ground + mastM;
  const φ = lat * DEG, λ = lon * DEG;
  const up = [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];
  const east = [-Math.sin(λ), Math.cos(λ), 0];
  const north = [-Math.sin(φ) * Math.cos(λ), -Math.sin(φ) * Math.sin(λ), Math.cos(φ)];
  const resolution = MoonHeights.resolutionAt(lat);

  // Distances to sample: fine near the spot, coarser far away (never much finer than the data).
  const dists: number[] = [];
  const nearStep = Math.max(40, resolution / 2);
  for (let s = nearStep; s < 20000; s += nearStep) dists.push(s);
  for (let s = Math.max(20000, nearStep); s < maxRangeM; s += Math.max(160 + s * 0.004, resolution / 2)) dists.push(s);
  const n = dists.length;
  const cosT = new Float64Array(n), sinT = new Float64Array(n);
  for (let k = 0; k < n; k++) { cosT[k] = Math.cos(dists[k] / R); sinT[k] = Math.sin(dists[k] / R); }

  const count = Math.round(360 / stepDeg);
  const elevations = new Float32Array(count);
  const blockerKm = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = i * stepDeg * DEG;
    const ca = Math.cos(a), sa = Math.sin(a);
    const dx = ca * north[0] + sa * east[0], dy = ca * north[1] + sa * east[1], dz = ca * north[2] + sa * east[2];
    let best = -90, bestD = 0;
    for (let k = 0; k < n; k++) {
      const ux = up[0] * cosT[k] + dx * sinT[k];
      const uy = up[1] * cosT[k] + dy * sinT[k];
      const uz = up[2] * cosT[k] + dz * sinT[k];
      const h = heights.heightAtUnit(ux, uy, uz, dists[k] < 18000);
      const r = R + h;
      const el = Math.atan2(r * cosT[k] - h0, r * sinT[k]) / DEG;
      if (el > best) { best = el; bestD = dists[k]; }
    }
    elevations[i] = best;
    blockerKm[i] = bestD / 1000;
  }
  return { lat, lon, groundM: ground, mastM, stepDeg, elevations, blockerKm, maxRangeKm: maxRangeM / 1000, resolutionM: resolution, ms: performance.now() - t0 };
}

/** Skyline angle at any azimuth (linear interpolation). */
export function horizonAt(h: { elevations: Float32Array; stepDeg: number }, az: number): number {
  const n = h.elevations.length;
  const f = (((az % 360) + 360) % 360) / h.stepDeg;
  const i = Math.floor(f) % n, j = (i + 1) % n, t = f - Math.floor(f);
  return h.elevations[i] * (1 - t) + h.elevations[j] * t;
}
