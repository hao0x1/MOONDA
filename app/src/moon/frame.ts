// The "display frame": how we place the Moon inside CesiumJS.
//
// Cesium cuts the globe into longitude/latitude tiles. At the globe's poles those tiles squeeze
// into thin slivers, which causes streaks, slow loading and cracks. Our mission area IS the
// lunar south pole, so we quietly rotate the Moon inside Cesium by 90° about the X axis:
//
//   display = (x, -z, y)          true = (x, z, -y)
//
// - the true south pole lands on Cesium's equator (display lat 0°, lon 90°E): normal square tiles
// - the true north pole lands at display (0°, 90°W)
// - Cesium's own poles fall on two points of the lunar limb (true 0°N 90°E and 0°N 90°W)
//
// Everything scientific (ephemeris, skyline, place names, NASA maps) stays in the TRUE Moon
// frame (IAU body-fixed, LOLA/MOON_ME-compatible). Convert at the boundary with these helpers.
// Rotation preserves distances and angles, so physics is unchanged.

import { Cartesian3 } from 'cesium';

export const MOON_R = 1737400;
const DEG = Math.PI / 180;

export type V3 = [number, number, number];

export const trueToDisplayVec = (v: V3): V3 => [v[0], -v[2], v[1]];
export const displayToTrueVec = (v: V3): V3 => [v[0], v[2], -v[1]];

/** True north direction (true +Z) expressed in display coordinates. */
export const TRUE_NORTH_DISPLAY = new Cartesian3(0, -1, 0);

/** True lat/lon (deg) -> unit vector in the TRUE frame. */
export function trueUnit(latDeg: number, lonDeg: number): V3 {
  const φ = latDeg * DEG, λ = lonDeg * DEG, c = Math.cos(φ);
  return [c * Math.cos(λ), c * Math.sin(λ), Math.sin(φ)];
}

/** True lat/lon/height -> Cesium world position (display frame), metres. */
export function toCartesian(latDeg: number, lonDeg: number, heightM = 0, result = new Cartesian3()): Cartesian3 {
  const u = trueUnit(latDeg, lonDeg), r = MOON_R + heightM;
  result.x = r * u[0]; result.y = -r * u[2]; result.z = r * u[1];
  return result;
}

/** Cesium world position (display frame) -> true lat/lon (deg) and height (m). */
export function toTrueLatLon(p: { x: number; y: number; z: number }): { lat: number; lon: number; height: number } {
  const tx = p.x, ty = p.z, tz = -p.y; // display -> true
  const r = Math.hypot(tx, ty, tz);
  return { lat: Math.asin(tz / r) / DEG, lon: Math.atan2(ty, tx) / DEG, height: r - MOON_R };
}

/** Display lat/lon (radians, as Cesium tiles use) -> true lat/lon (degrees). */
export function displayToTrueLatLon(dLat: number, dLon: number): { lat: number; lon: number } {
  const c = Math.cos(dLat);
  const X = c * Math.cos(dLon), Y = c * Math.sin(dLon), Z = Math.sin(dLat); // display unit
  // true = (X, Z, -Y)
  return { lat: Math.asin(Math.max(-1, Math.min(1, -Y))) / DEG, lon: Math.atan2(Z, X) / DEG };
}

/** True lat/lon (deg) -> display lat/lon (radians). */
export function trueToDisplayLatLon(latDeg: number, lonDeg: number): { lat: number; lon: number } {
  const u = trueUnit(latDeg, lonDeg); // true
  const X = u[0], Y = -u[2], Z = u[1]; // display
  return { lat: Math.asin(Math.max(-1, Math.min(1, Z))), lon: Math.atan2(Y, X) };
}

/** Local east / north / up unit vectors (TRUE geographic sense) at a true lat/lon, in display coordinates. */
export function trueENU(latDeg: number, lonDeg: number): { east: Cartesian3; north: Cartesian3; up: Cartesian3 } {
  const φ = latDeg * DEG, λ = lonDeg * DEG;
  const east: V3 = [-Math.sin(λ), Math.cos(λ), 0];
  const north: V3 = [-Math.sin(φ) * Math.cos(λ), -Math.sin(φ) * Math.sin(λ), Math.cos(φ)];
  const up: V3 = [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];
  const c = (v: V3) => { const d = trueToDisplayVec(v); return new Cartesian3(d[0], d[1], d[2]); };
  return { east: c(east), north: c(north), up: c(up) };
}

/** Compass azimuth (deg, clockwise from TRUE north) of a display-frame direction seen from a true lat/lon. */
export function azimuthOf(dir: Cartesian3, latDeg: number, lonDeg: number): number {
  const { east, north } = trueENU(latDeg, lonDeg);
  const a = Math.atan2(Cartesian3.dot(dir, east), Cartesian3.dot(dir, north)) / DEG;
  return (a + 360) % 360;
}

/** Display-frame direction for a compass azimuth / elevation (deg) at a true lat/lon. */
export function directionFor(azDeg: number, elDeg: number, latDeg: number, lonDeg: number, result = new Cartesian3()): Cartesian3 {
  const { east, north, up } = trueENU(latDeg, lonDeg);
  const a = azDeg * DEG, e = elDeg * DEG, h = Math.cos(e);
  result.x = north.x * h * Math.cos(a) + east.x * h * Math.sin(a) + up.x * Math.sin(e);
  result.y = north.y * h * Math.cos(a) + east.y * h * Math.sin(a) + up.y * Math.sin(e);
  result.z = north.z * h * Math.cos(a) + east.z * h * Math.sin(a) + up.z * Math.sin(e);
  return Cartesian3.normalize(result, result);
}

/** South-polar stereographic map x/y (m) from a DISPLAY unit vector (fast path for polar imagery). */
export function polarMapFromDisplayUnit(X: number, Y: number, Z: number): [number, number] {
  // true = (X, Z, -Y); polar x = 2R*uy/(1-uz), y = 2R*ux/(1-uz)
  const f = (2 * MOON_R) / (1 + Y);
  return [f * Z, f * X];
}
