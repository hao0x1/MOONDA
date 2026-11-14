// The rocks MOONDA can bump into, as the Driver sees them (walk.ts WalkObstacle: a base point, a radius, a height).
//
// A rock is drawn from one of seven scanned stones (lander.ts ROCK_MODELS), scaled, turned and seated on the
// ground. Many are long and flat (up to twice as long as wide) and their middle is not the model's origin, so one
// circle would either let the robot into the long ends or stop it well short of the narrow sides. Each rock is
// handed over as a short row of circles along its long side instead (1..4), each as wide as the stone is narrow,
// lower towards the ends, each standing on the ground the rock lies on (p = its middle at the ground, h = its height above it).
// Sizes come from the stones' real meshes (ROCK_SHAPE), not from their boxes.

import { Cartesian3 } from 'cesium';
import type { WalkObstacle } from './walk';

/**
 * Each scanned stone's true shape above the ground line (glTF model m), measured from its rock.gltf + .bin with the
 * base buried by ROCK_BURY (20 % of the box height), by fitting the mesh: w = the longest side of its box (a rock's
 * size d is this side), top = how high it really stands above the ground, (cx, cz) the middle of its footprint,
 * a >= b the half-axes of the ellipse with the same area as the footprint, ang the long axis (degrees from model +x
 * towards +z), p how rounded it is (radius at height y = r (1 - (y/top)^p)^(1/p): 1.2 a low mound, 2 a dome).
 * The boxes overstate every stone: a footprint 1.1 to 1.7 times too big and a top up to a third too high, which is
 * what used to stop the robot at stones it could plainly drive over.
 */
export const ROCK_SHAPE: readonly { w: number; top: number; cx: number; cz: number; a: number; b: number; ang: number; p: number }[] = [
  { w: 0.2121, top: 0.0575, cx: 0.0073, cz: 0.0028, a: 0.1103, b: 0.0519, ang: 7, p: 1.65 },
  { w: 0.2513, top: 0.1555, cx: 0.0042, cz: -0.004, a: 0.1248, b: 0.1131, ang: -30, p: 2 },
  { w: 0.112, top: 0.0449, cx: 0.0047, cz: -0.0035, a: 0.0585, b: 0.0359, ang: -27, p: 1.5 },
  { w: 0.1738, top: 0.039, cx: 0.0096, cz: -0.0067, a: 0.0883, b: 0.0589, ang: -77, p: 1.25 },
  { w: 0.0811, top: 0.0571, cx: 0.003, cz: 0.0055, a: 0.0391, b: 0.0318, ang: -87, p: 1.45 },
  { w: 0.0918, top: 0.0434, cx: 0.0004, cz: -0.0062, a: 0.052, b: 0.0311, ang: -53, p: 1.35 },
  { w: 0.0968, top: 0.0364, cx: 0.0007, cz: -0.0025, a: 0.0443, b: 0.0241, ang: -14, p: 1.2 },
];

/** How high a stone of this kind and size (d = its longest side, m) really stands above the ground (m). */
export function rockTop(kind: number, d: number): number {
  const sh = ROCK_SHAPE[kind] ?? ROCK_SHAPE[0];
  return sh.top * d / sh.w;
}

export interface OutlineRock {
  spot: { yaw: number } | null; kind: number; scale: number; h: number; size: number; base: Cartesian3; model: { show: boolean }; ground: number;
}

const pool: Cartesian3[] = [];
const sX = new Cartesian3(), sY = new Cartesian3(), sD = new Cartesian3(), sA = new Cartesian3();

/**
 * Fill `out` with the circles of every drawn rock whose outline comes within `reach` m of `at` (world).
 * `E` / `N` are the rocks' east and north (the frame their yaw is measured in), `bury` the share of a rock's
 * height that sits under the ground (lander.ts ROCK_BURY).
 */
export function rockOutlines(out: WalkObstacle[], rocks: readonly OutlineRock[], at: Cartesian3, E: Cartesian3, N: Cartesian3, bury: number, reach: number) {
  out.length = 0;
  let used = 0;
  for (const rk of rocks) {
    const sp = rk.spot;
    if (!sp || !rk.model.show || Number.isNaN(rk.ground) || rk.size <= 0.02) continue;
    const sh = ROCK_SHAPE[rk.kind] ?? ROCK_SHAPE[0], s = rk.scale;
    const long = sh.a * s, short = sh.b * s, top = sh.top * s;
    if (Cartesian3.distance(rk.base, at) > reach + long + 0.5) continue;
    // the rock's own across (model x) and along (model z: Cesium turns glTF's +z into the local -y)
    const cy = Math.cos(sp.yaw), sy = Math.sin(sp.yaw);
    const X = Cartesian3.fromElements(E.x * cy + N.x * sy, E.y * cy + N.y * sy, E.z * cy + N.z * sy, sX);
    const Y = Cartesian3.fromElements(-(N.x * cy - E.x * sy), -(N.y * cy - E.y * sy), -(N.z * cy - E.z * sy), sY); // = -(local y)
    // its long side: the footprint's own long axis (not the box's)
    const ca = Math.cos(sh.ang * Math.PI / 180), sa = Math.sin(sh.ang * Math.PI / 180);
    const along = Cartesian3.fromElements(X.x * ca + Y.x * sa, X.y * ca + Y.y * sa, X.z * ca + Y.z * sa, sA);
    const span = long - short, n = Math.min(4, 1 + Math.ceil(span / Math.max(0.05, short * 0.7)));
    for (let k = 0; k < n; k++) {
      const u = n === 1 ? 0 : -span + 2 * span * k / (n - 1);
      const p = pool[used] ??= new Cartesian3();
      used++;
      Cartesian3.add(rk.base, Cartesian3.multiplyByScalar(X, sh.cx * s, sD), p);
      Cartesian3.add(p, Cartesian3.multiplyByScalar(Y, sh.cz * s, sD), p);
      Cartesian3.add(p, Cartesian3.multiplyByScalar(along, u, sD), p);
      // up out of the dust onto the ground it lies on (the Driver reads the rock's ground as |p| - R)
      Cartesian3.multiplyByScalar(Cartesian3.normalize(p, sD), Cartesian3.magnitude(p) + bury * rk.h, p);
      // a long stone is lower towards its ends (about an ellipsoid's shoulder)
      const e = long > 0 ? Math.abs(u) / long : 0;
      out.push({ p, r: short, h: top * Math.sqrt(Math.max(0.2, 1 - e * e)), pow: sh.p });
    }
  }
  return out;
}
