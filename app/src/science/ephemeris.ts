// Where are the Sun and Earth in the sky of a spot on the Moon?
//
// 1. Astronomy Engine gives the Sun and Moon positions as seen from Earth's centre
//    (J2000 equatorial frame, astronomical units).
// 2. We turn them into "from the Moon's centre" vectors.
// 3. We rotate them into the Moon's own body-fixed frame (latitude/longitude grid that
//    turns with the Moon), using the IAU rotation model for the Moon.
// 4. For a spot on the surface we subtract the spot's position (this matters for Earth:
//    the Moon's radius shifts Earth's direction by about a quarter of a degree) and
//    convert to azimuth (compass direction) and elevation (height above a flat horizon).
//
// Checked against NASA/JPL Horizons, see scripts/check-ephemeris.ts.

import { Body, GeoMoon, GeoVector, RotationAxis } from 'astronomy-engine';

export const MOON_RADIUS_M = 1737400;
const AU_M = 149597870700;
const DEG = Math.PI / 180;

export type Vec3 = [number, number, number];

/** Sun and Earth position vectors from the Moon's centre, in the Moon body-fixed frame (metres). */
export interface BodyFixedState {
  time: number; // ms since epoch (UTC)
  sun: Vec3;
  earth: Vec3;
}

function rotZ(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2]];
}
function rotX(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0], c * v[1] + s * v[2], -s * v[1] + c * v[2]];
}

/** Sun and Earth vectors in the Moon body-fixed frame at a UTC time. */
export function bodyFixedState(timeMs: number): BodyFixedState {
  const date = new Date(timeMs);
  const moon = GeoMoon(date); // Earth -> Moon, EQJ, AU
  const sun = GeoVector(Body.Sun, date, true); // Earth -> Sun (apparent), EQJ, AU
  const axis = RotationAxis(Body.Moon, date);
  const ra = axis.ra * 15 * DEG;
  const dec = axis.dec * DEG;
  const w = axis.spin * DEG;
  const toFixed = (v: Vec3): Vec3 => rotZ(rotX(rotZ(v, Math.PI / 2 + ra), Math.PI / 2 - dec), w);
  const moonToSun: Vec3 = [(sun.x - moon.x) * AU_M, (sun.y - moon.y) * AU_M, (sun.z - moon.z) * AU_M];
  const moonToEarth: Vec3 = [-moon.x * AU_M, -moon.y * AU_M, -moon.z * AU_M];
  return { time: timeMs, sun: toFixed(moonToSun), earth: toFixed(moonToEarth) };
}

export interface Site {
  lat: number; // degrees, north positive
  lon: number; // degrees, east positive
  heightM: number; // metres above the 1737.4 km reference sphere (ground + mast)
}

export interface LocalFrame {
  pos: Vec3;
  east: Vec3;
  north: Vec3;
  up: Vec3;
}

export function localFrame(site: Site): LocalFrame {
  const φ = site.lat * DEG, λ = site.lon * DEG;
  const cφ = Math.cos(φ), sφ = Math.sin(φ), cλ = Math.cos(λ), sλ = Math.sin(λ);
  const r = MOON_RADIUS_M + site.heightM;
  return {
    pos: [r * cφ * cλ, r * cφ * sλ, r * sφ],
    east: [-sλ, cλ, 0],
    north: [-sφ * cλ, -sφ * sλ, cφ],
    up: [cφ * cλ, cφ * sλ, sφ],
  };
}

export interface AzEl {
  az: number; // degrees clockwise from north, 0..360
  el: number; // degrees above the flat (mathematical) horizon
  dist: number; // metres
}

export function azEl(frame: LocalFrame, target: Vec3): AzEl {
  const d: Vec3 = [target[0] - frame.pos[0], target[1] - frame.pos[1], target[2] - frame.pos[2]];
  const e = d[0] * frame.east[0] + d[1] * frame.east[1] + d[2] * frame.east[2];
  const n = d[0] * frame.north[0] + d[1] * frame.north[1] + d[2] * frame.north[2];
  const u = d[0] * frame.up[0] + d[1] * frame.up[1] + d[2] * frame.up[2];
  const dist = Math.hypot(e, n, u);
  let az = Math.atan2(e, n) / DEG;
  if (az < 0) az += 360;
  return { az, el: Math.asin(u / dist) / DEG, dist };
}

/** Angular radius (degrees) of the Sun and Earth as seen from the Moon. */
export const SUN_RADIUS_M = 695700e3;
export const EARTH_RADIUS_M = 6371e3;
export function angularRadiusDeg(radiusM: number, distM: number): number {
  return Math.asin(radiusM / distM) / DEG;
}

/** Precompute body-fixed states on a regular time grid. */
export function stateSeries(startMs: number, endMs: number, stepMs: number): BodyFixedState[] {
  const out: BodyFixedState[] = [];
  for (let t = startMs; t <= endMs + 1; t += stepMs) out.push(bodyFixedState(t));
  return out;
}
