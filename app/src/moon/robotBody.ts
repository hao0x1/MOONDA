// MOONDA's real outline for bumping into rocks (used by walk.ts's Driver).
//
// The robot is the same set of balls its shadow is drawn from (robotShape.ts, made from the model's own
// triangles), seen from above: one ball per 0.22 model-metre square of the plan, the lowest one there (its
// bottom decides which rocks it can pass over). Balls at a wheel (and its leg) belong to that wheel, so a rock
// low enough for the wheel to climb is climbed by it (see Driver.sampleWheels) instead of stopping it.
//
// A rock is a round-topped lump on its own ground: radius r at the ground, height h, its outline shrinking
// towards the top as r * (1 - (y/h)^3)^(1/3): steep sides like real blocks, a rounded top. Every ball is tested against
// every rock near the robot; the deepest touch per rock becomes one contact (where, which way out, how deep).

import { ROBOT_SHAPE } from './robotShape';

/** The cells: forward, right, bottom above the wheels' contact (model m), ball radius (model m), wheel 0..5 or -1. */
export interface BodyCell { f: number; r: number; y: number; rad: number; wheel: number }

const WHEEL_AT: readonly (readonly number[])[] = [[1.0624, 1.095], [1.1845, -0.09], [1.0624, -1.165], [-1.0624, 1.095], [-1.1845, -0.09], [-1.0624, -1.165]];

function build(): BodyCell[] {
  const cells = new Map<string, BodyCell>();
  for (const [x, y, z, r, part] of ROBOT_SHAPE) {
    if (part === 7) continue; // the solar panel sits inside the body's outline, above everything a rock can reach
    const key = `${Math.round(x / 0.11)},${Math.round(z / 0.11)}`;
    const bottom = y - r;
    const c = cells.get(key);
    if (c && c.y <= bottom) continue;
    const wheel = WHEEL_AT.findIndex(([wx, wz]) => Math.abs(x - wx) < 0.3 && Math.abs(z - wz) < 0.4 && bottom < 0.7);
    cells.set(key, { f: z, r: -x, y: Math.max(0, bottom), rad: r, wheel });
  }
  return [...cells.values()];
}

export const BODY_CELLS: readonly BodyCell[] = build();

/** The farthest any cell reaches from the middle (model m): rocks further than this plus their radius cannot touch. */
export const BODY_REACH = BODY_CELLS.reduce((a, c) => Math.max(a, Math.hypot(c.f, c.r) + c.rad), 0);

/** The rock's radius at height y over its ground (m). */
export function rockRadiusAt(r: number, h: number, y: number): number {
  if (y <= 0) return r;
  if (y >= h) return 0;
  const t = y / h;
  return r * Math.cbrt(1 - t * t * t);
}

/** The rock's top (m over its ground) at distance d from its middle (m). */
export function rockTopAt(r: number, h: number, d: number): number {
  if (d >= r) return 0;
  const t = d / r;
  return h * Math.cbrt(1 - t * t * t);
}
