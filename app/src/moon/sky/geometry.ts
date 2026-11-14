// Pure geometry for the sky (no drawing, no Cesium objects): where a far body appears from the
// camera, and how much of its disc the Moon's ground hides. Everything is in the DISPLAY frame
// (the rotated frame the 3D scene uses, see ../frame.ts), metres from the Moon's centre.
// Checked in node by scripts/check-sky.ts.

import { MOON_R, type V3 } from '../frame.ts';

export const SUN_RADIUS_M = 695_700_000;
export const EARTH_RADIUS_M = 6_371_000;

/** Ground height (metres above the 1,737.4 km sphere) under a DISPLAY-frame unit vector. `detail`: use the finest data. */
export type GroundFn = (ux: number, uy: number, uz: number, detail: boolean) => number;

/** Highest and lowest ground on the Moon, with a little room (metres from the centre). */
const TOP = MOON_R + 11_000, BOT = MOON_R - 9_500;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** out = unit direction from the camera to the body; returns the distance in metres. */
export function aimFrom(body: V3, cam: V3, out: V3): number {
  const x = body[0] - cam[0], y = body[1] - cam[1], z = body[2] - cam[2], d = Math.hypot(x, y, z);
  out[0] = x / d; out[1] = y / d; out[2] = z / d;
  return d;
}

/** Angle (radians) a ball of radius `r` covers from its centre to its edge, seen from `dist` away. */
export const angularRadius = (r: number, dist: number) => Math.asin(Math.min(1, r / dist));

/**
 * How high (radians above "level" at the camera; negative = below) the Moon's ground reaches in one
 * horizontal direction (hx, hy, hz: unit, at right angles to "up" at the camera). Works from a lander
 * mast and from thousands of km out. Without height data the Moon is a smooth ball.
 */
export function skylineElevation(cam: V3, hx: number, hy: number, hz: number, ground: GroundFn | null): number {
  const rc = Math.hypot(cam[0], cam[1], cam[2]);
  if (!ground) return rc > MOON_R ? -Math.acos(MOON_R / rc) : 0;
  const ux = cam[0] / rc, uy = cam[1] / rc, uz = cam[2] / rc;
  const eBot = rc > BOT ? -Math.acos(BOT / rc) : 0; // the skyline is never lower than the deepest ground allows
  let th = 60 / MOON_R, thTop = 0;
  if (rc > TOP) {
    // far camera: ground closer than where the lowest sight line enters the "mountain shell" cannot matter
    const s = Math.sin(eBot), c = Math.cos(eBot), b = rc * s;
    const t1 = -b - Math.sqrt(Math.max(0, b * b - rc * rc + TOP * TOP));
    th = Math.max(th, Math.atan2(t1 * c, rc + t1 * s) - 0.002);
    thTop = Math.acos(TOP / rc);
  }
  const thEnd = (rc > BOT ? Math.acos(BOT / rc) : 0) + Math.acos(BOT / TOP);
  let best = eBot;
  while (th < thEnd) {
    const ct = Math.cos(th), st = Math.sin(th);
    const d = Math.sqrt(rc * rc + MOON_R * MOON_R - 2 * rc * MOON_R * ct); // straight distance to that ground
    const rg = MOON_R + ground(ux * ct + hx * st, uy * ct + hy * st, uz * ct + hz * st, d < 60_000);
    const el = Math.atan2(rg * ct - rc, rg * st);
    if (el > best) best = el;
    // beyond the shell's own skyline even the highest possible mountain keeps sinking: stop when it cannot win
    if (th > thTop && Math.atan2(TOP * ct - rc, TOP * st) < best) break;
    th += clamp(0.02 * d, 60, 3000) / MOON_R;
  }
  return best;
}

/**
 * Part (0..1) of a far round disc (unit direction `dir`, angular radius `rho` radians) that is NOT hidden
 * by the Moon's ground, seen from `cam`. 1 = whole disc in the open sky, 0 = completely behind the Moon.
 */
export function discVisible(cam: V3, dir: V3, rho: number, ground: GroundFn | null): number {
  const rc = Math.hypot(cam[0], cam[1], cam[2]);
  const ux = cam[0] / rc, uy = cam[1] / rc, uz = cam[2] / rc;
  const se = clamp(dir[0] * ux + dir[1] * uy + dir[2] * uz, -1, 1), e = Math.asin(se);
  if (!ground) {
    const x = clamp((e - (rc > MOON_R ? -Math.acos(MOON_R / rc) : 0)) / rho, -1, 1);
    return 0.5 + (x * Math.sqrt(1 - x * x) + Math.asin(x)) / Math.PI; // disc cut by a straight skyline
  }
  if (e - rho > (rc > TOP ? -Math.acos(TOP / rc) : 0.8)) return 1; // above anything the ground can reach
  if (rc > BOT && e + rho < -Math.acos(BOT / rc)) return 0; // below the deepest ground
  let hx = dir[0] - se * ux, hy = dir[1] - se * uy, hz = dir[2] - se * uz;
  const hl = Math.hypot(hx, hy, hz);
  if (hl < 1e-6) return 1;
  hx /= hl; hy /= hl; hz /= hl;
  const sx = uy * hz - uz * hy, sy = uz * hx - ux * hz, sz = ux * hy - uy * hx; // sideways (level, at right angles to h)
  let vis = 0, sum = 0;
  for (let k = -2; k <= 2; k++) { // five upright strips across the disc
    const x = 0.4 * k, w = Math.sqrt(1 - x * x), half = rho * w;
    const da = (x * rho) / Math.max(0.05, hl), ca = Math.cos(da), sa = Math.sin(da);
    const eh = skylineElevation(cam, hx * ca + sx * sa, hy * ca + sy * sa, hz * ca + sz * sa, ground);
    vis += w * clamp((e + half - eh) / (2 * half), 0, 1);
    sum += w;
  }
  return vis / sum;
}

/** Is a far point (unit direction) hidden behind the smooth Moon ball, seen from `cam`? Cheap: for stars and name tags. */
export function behindBall(cam: V3, dx: number, dy: number, dz: number): boolean {
  const b = cam[0] * dx + cam[1] * dy + cam[2] * dz;
  if (b >= 0) return false;
  return cam[0] * cam[0] + cam[1] * cam[1] + cam[2] * cam[2] - b * b < MOON_R * MOON_R;
}
