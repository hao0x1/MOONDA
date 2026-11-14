// The same fixed stones as lander.ts rockCell, without Cesium or any drawing state.
//
// The view fades stones in and out, clears the rover's parking patch, and seats them on drawn
// triangles. A route cannot know which models will have loaded when it reaches a place. Keep
// each potentially blocking stone at its full size instead: this is a safe outer envelope,
// rather than claiming that the view's changing pool of 96 models is a fixed obstacle map.

import { ROBOT_SHAPE } from '../moon/robotShape.ts';

/** DRIVE.climb = 1.5 * WHEEL_R (0.2627) * ROBOT_SCALE (0.5), in walk.ts. */
export const ROUTE_ROCK_CLIMB_M = 1.5 * 0.2627 * 0.5;
/** An outer circle of robotBody.ts BODY_CELLS, at ROBOT_SCALE. It also allows any heading. */
export const ROUTE_BODY_REACH_M = ROBOT_SHAPE.reduce((reach, p) => p[4] === 7 ? reach
  : Math.max(reach, Math.hypot(p[0], p[2]) + Math.min(p[3], 0.11)), 0) * 0.5;

// ROCK_MODELS widths and the measured full-size ROCK_SHAPE tops / longest half-axes /
// footprint offsets (rockOutline.ts). A rockRadiusAt slice only gets narrower above
// the ground, so the ground footprint plus the robot's reach encloses every contact.
const SHAPES = [
  [0.2121, 0.0575, 0.1103, 0.0073, 0.0028],
  [0.2465, 0.1555, 0.1248, 0.0042, -0.004],
  [0.1121, 0.0449, 0.0585, 0.0047, -0.0035],
  [0.1738, 0.0390, 0.0883, 0.0096, -0.0067],
  [0.0811, 0.0571, 0.0391, 0.0030, 0.0055],
  [0.0918, 0.0434, 0.0520, 0.0004, -0.0062],
  [0.0968, 0.0364, 0.0443, 0.0007, -0.0025],
] as const;

export interface RouteRock { e: number; n: number; radiusM: number; heightM: number }
export interface RouteRockField {
  /** Metres east / north in the LANDING spot's frame. extra is a grid sampling margin. */
  blocked(e: number, n: number, extra?: number): boolean;
  /** Potentially blocking full-size stones, including one neighbouring cell on each side. */
  near(e: number, n: number): readonly RouteRock[];
}

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reproduce lander.ts rockCell's random stream exactly, including unused yaw / lean draws. */
export function makeRockField(spot: { lat: number; lon: number }): RouteRockField {
  const seed = (Math.round((spot.lat + 90) * 1e5) * 92821 ^ Math.round((spot.lon + 360) * 1e5)) >>> 0;
  const cells = new Map<string, readonly RouteRock[]>(), groups = new Map<string, readonly RouteRock[]>();
  const cell = (big: boolean, ix: number, iy: number): readonly RouteRock[] => {
    const key = `${big ? 'B' : 's'}:${ix}:${iy}`, old = cells.get(key);
    if (old) return old;
    const size = big ? 80 : 16;
    const rnd = seeded((seed ^ Math.imul(ix + 7919, 73856093) ^ Math.imul(iy - 104729, 19349663) ^ (big ? 0x5bd1e995 : 0)) >>> 0);
    const count = big ? (rnd() < 0.6 ? 1 : 0) : 19;
    const d0 = big ? 0.6 : 0.05, d1 = big ? 1.8 : 0.7;
    const out: RouteRock[] = [];
    for (let i = 0; i < count; i++) {
      const e = (ix + rnd()) * size, n = (iy + rnd()) * size;
      const d = d0 / Math.sqrt(1 - rnd() * (1 - (d0 / d1) ** 2));
      const kind = Math.floor(rnd() * 7);
      rnd(); rnd(); rnd(); // yaw, tilt, tiltAz: keep the next stone's random stream in step
      if (Math.hypot(e, n) <= 2.2) continue;
      const [width, top, half, cx, cz] = SHAPES[kind], scale = d / width;
      const heightM = top * scale;
      if (heightM <= ROUTE_ROCK_CLIMB_M) continue; // Driver.collide leaves these to the wheels
      out.push({ e, n, heightM, radiusM: (half + Math.hypot(cx, cz)) * scale + ROUTE_BODY_REACH_M });
    }
    cells.set(key, out);
    return out;
  };
  const near = (e: number, n: number): readonly RouteRock[] => {
    const ix = Math.floor(e / 16), iy = Math.floor(n / 16), key = `${ix}:${iy}`;
    const old = groups.get(key);
    if (old) return old;
    const out: RouteRock[] = [];
    for (let y = iy - 1; y <= iy + 1; y++) for (let x = ix - 1; x <= ix + 1; x++) out.push(...cell(false, x, y));
    // A 16 m cell can cross an 80 m cell boundary. One large neighbour each side
    // covers the full rock envelope and up to a 13 m caller sampling margin.
    const bx = Math.floor(e / 80), by = Math.floor(n / 80);
    for (let y = by - 1; y <= by + 1; y++) for (let x = bx - 1; x <= bx + 1; x++) out.push(...cell(true, x, y));
    groups.set(key, out);
    return out;
  };
  return {
    near,
    blocked(e: number, n: number, extra = 0): boolean {
      for (const r of near(e, n)) {
        const radius = r.radiusM + Math.max(0, extra), de = e - r.e, dn = n - r.n;
        if (de * de + dn * dn < radius * radius) return true;
      }
      return false;
    },
  };
}
