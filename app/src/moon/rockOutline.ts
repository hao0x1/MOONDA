// The rocks MOONDA can bump into, as the Driver sees them (walk.ts WalkObstacle: a base point, a radius, a height).
//
// A rock is drawn from one of seven scanned stones (lander.ts ROCK_MODELS), scaled, turned and seated on the
// ground. Many are long and flat (up to twice as long as wide) and their middle is not the model's origin, so one
// circle would either let the robot into the long ends or stop it well short of the narrow sides. Each rock is
// handed over as a short row of circles along its long side instead (1..4), each as wide as the stone is narrow,
// lower towards the ends, each standing on the ground the rock lies on (p = its middle at the ground, h = its height above it).

import { Cartesian3 } from 'cesium';
import type { WalkObstacle } from './walk';

/** Each scanned stone's outline from above (glTF model m: x min, x max, z min, z max), read from its rock.gltf. */
const OUTLINE: readonly (readonly number[])[] = [
  [-0.1051, 0.107, -0.0498, 0.0618], [-0.1247, 0.1218, -0.1251, 0.1262], [-0.0534, 0.0587, -0.045, 0.0411],
  [-0.0521, 0.0677, -0.087, 0.0868], [-0.037, 0.0347, -0.0405, 0.0406], [-0.0402, 0.0456, -0.0492, 0.0426],
  [-0.0541, 0.0427, -0.0378, 0.036],
];

export interface OutlineRock {
  spot: { yaw: number } | null; kind: number; scale: number; h: number; size: number; base: Cartesian3; model: { show: boolean }; ground: number;
}

const pool: Cartesian3[] = [];
const sX = new Cartesian3(), sY = new Cartesian3(), sD = new Cartesian3();

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
    const o = OUTLINE[rk.kind] ?? OUTLINE[0], s = rk.scale;
    const ax = 0.5 * (o[1] - o[0]) * s, az = 0.5 * (o[3] - o[2]) * s;
    const long = Math.max(ax, az), short = Math.min(ax, az);
    if (Cartesian3.distance(rk.base, at) > reach + long + 0.5) continue;
    // the rock's own across (model x) and along (model z: Cesium turns glTF's +z into the local -y)
    const cy = Math.cos(sp.yaw), sy = Math.sin(sp.yaw);
    const X = Cartesian3.fromElements(E.x * cy + N.x * sy, E.y * cy + N.y * sy, E.z * cy + N.z * sy, sX);
    const Y = Cartesian3.fromElements(-(N.x * cy - E.x * sy), -(N.y * cy - E.y * sy), -(N.z * cy - E.z * sy), sY); // = -(local y)
    const cx = 0.5 * (o[1] + o[0]) * s, cz = 0.5 * (o[3] + o[2]) * s;
    const along = ax >= az ? X : Y;
    const h = rk.h * (1 - bury);
    const span = long - short, n = Math.min(4, 1 + Math.ceil(span / Math.max(0.05, short * 0.7)));
    for (let k = 0; k < n; k++) {
      const u = n === 1 ? 0 : -span + 2 * span * k / (n - 1);
      const p = pool[used] ??= new Cartesian3();
      used++;
      Cartesian3.add(rk.base, Cartesian3.multiplyByScalar(X, cx, sD), p);
      Cartesian3.add(p, Cartesian3.multiplyByScalar(Y, cz, sD), p);
      Cartesian3.add(p, Cartesian3.multiplyByScalar(along, u, sD), p);
      // up out of the dust onto the ground it lies on (the Driver reads the rock's ground as |p| - R)
      Cartesian3.multiplyByScalar(Cartesian3.normalize(p, sD), Cartesian3.magnitude(p) + bury * rk.h, p);
      // a long stone is lower towards its ends (about an ellipsoid's shoulder)
      const e = long > 0 ? Math.abs(u) / long : 0;
      out.push({ p, r: short, h: h * Math.sqrt(Math.max(0.2, 1 - e * e)) });
    }
  }
  return out;
}
