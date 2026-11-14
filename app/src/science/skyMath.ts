// Sky maths: where the stars, the planets and the face of the Earth are, as seen from the Moon.
//
// Star catalogues and the Milky Way picture use the J2000 equatorial frame (right ascension /
// declination: the sky's own "longitude / latitude"). The map of the Moon lives in the Moon
// body-fixed TRUE frame (the grid that turns with the Moon). This file gives the rotation between
// the two for any time, with exactly the same IAU model `bodyFixedState` in ephemeris.ts uses,
// so the stars stay glued to the Sun and Earth directions the rest of the app already trusts.
//
// No drawing code here and no Cesium: everything can be checked in node (scripts/check-sky.ts).

import { Body, GeoMoon, GeoVector, Illumination, Rotation_EQJ_EQD, RotationAxis, SiderealTime } from 'astronomy-engine';
import type { Vec3 } from './ephemeris.ts';

const DEG = Math.PI / 180;
export const AU_M = 149597870700;

/** 3x3 rotation, row-major: out[i] = m[3i]*x + m[3i+1]*y + m[3i+2]*z. */
export type Mat3 = number[];

export const mat3Identity = (): Mat3 => [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mat3MulVec(m: Mat3, v: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const x = v[0], y = v[1], z = v[2];
  out[0] = m[0] * x + m[1] * y + m[2] * z;
  out[1] = m[3] * x + m[4] * y + m[5] * z;
  out[2] = m[6] * x + m[7] * y + m[8] * z;
  return out;
}

/** out = a · b (apply b first, then a). `out` may not be `a` or `b`. */
export function mat3Mul(a: Mat3, b: Mat3, out: Mat3 = mat3Identity()): Mat3 {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    out[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j];
  }
  return out;
}

/** The opposite rotation. `out` may not be `m`. */
export function mat3Transpose(m: Mat3, out: Mat3 = mat3Identity()): Mat3 {
  out[0] = m[0]; out[1] = m[3]; out[2] = m[6];
  out[3] = m[1]; out[4] = m[4]; out[5] = m[7];
  out[6] = m[2]; out[7] = m[5]; out[8] = m[8];
  return out;
}

/** Unit vector in the J2000 equatorial frame for a right ascension / declination in DEGREES. */
export function raDecToUnit(raDeg: number, decDeg: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const a = raDeg * DEG, d = decDeg * DEG, c = Math.cos(d);
  out[0] = c * Math.cos(a); out[1] = c * Math.sin(a); out[2] = Math.sin(d);
  return out;
}

/** Angle between two vectors, degrees. */
export function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0];
  return Math.atan2(Math.hypot(cx, cy, cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / DEG;
}

/**
 * Rotation J2000 equatorial -> Moon body-fixed TRUE frame at a UTC time.
 * The same three turns as `bodyFixedState`: about Z by (90° + pole RA), about X by (90° - pole Dec),
 * about Z by the spin angle W (IAU model of the Moon's rotation, from Astronomy Engine).
 */
export function moonFromJ2000(timeMs: number, out: Mat3 = mat3Identity()): Mat3 {
  const axis = RotationAxis(Body.Moon, new Date(timeMs));
  const a = Math.PI / 2 + axis.ra * 15 * DEG, b = Math.PI / 2 - axis.dec * DEG, w = axis.spin * DEG;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cw = Math.cos(w), sw = Math.sin(w);
  // Rz(w) · Rx(b) · Rz(a), each a "turn the axes" rotation: Rz(t) = [c s 0; -s c 0; 0 0 1], Rx(t) = [1 0 0; 0 c s; 0 -s c]
  out[0] = cw * ca - sw * cb * sa; out[1] = cw * sa + sw * cb * ca; out[2] = sw * sb;
  out[3] = -sw * ca - cw * cb * sa; out[4] = -sw * sa + cw * cb * ca; out[5] = cw * sb;
  out[6] = sb * sa; out[7] = -sb * ca; out[8] = cb;
  return out;
}

/**
 * Rotation J2000 equatorial -> Earth-fixed frame at a UTC time (x through the equator at Greenwich,
 * z through the north pole). Precession and nutation from Astronomy Engine, then the daily spin
 * (Greenwich apparent sidereal time). Polar wobble (< 0.0002°) is ignored.
 */
export function earthFromJ2000(timeMs: number, out: Mat3 = mat3Identity()): Mat3 {
  const date = new Date(timeMs);
  const r = Rotation_EQJ_EQD(date).rot; // of-date vector i = sum_j r[j][i] * j2000 vector j
  const g = SiderealTime(date) * 15 * DEG, c = Math.cos(g), s = Math.sin(g);
  for (let j = 0; j < 3; j++) {
    const x = r[j][0], y = r[j][1];
    out[j] = c * x + s * y;
    out[3 + j] = -s * x + c * y;
    out[6 + j] = r[j][2];
  }
  return out;
}

/** Rotation Earth-fixed -> Moon body-fixed TRUE frame: which way the Earth's axis and Greenwich point, seen from the Moon map. */
export function earthToMoonFixed(timeMs: number, out: Mat3 = mat3Identity()): Mat3 {
  return mat3Mul(moonFromJ2000(timeMs, scratchA), mat3Transpose(earthFromJ2000(timeMs, scratchB), scratchC), out);
}
const scratchA = mat3Identity(), scratchB = mat3Identity(), scratchC = mat3Identity();

export type PlanetName = 'Mercury' | 'Venus' | 'Mars' | 'Jupiter' | 'Saturn';
export const PLANETS: { name: PlanetName; body: Body }[] = [
  { name: 'Mercury', body: Body.Mercury }, { name: 'Venus', body: Body.Venus }, { name: 'Mars', body: Body.Mars },
  { name: 'Jupiter', body: Body.Jupiter }, { name: 'Saturn', body: Body.Saturn },
];

export interface PlanetSky {
  name: PlanetName;
  /** Unit vector from the Moon's centre towards the planet, J2000 equatorial frame. */
  j2000: Vec3;
  /** Distance from the Moon, metres. */
  distM: number;
  /** Brightness as astronomers count it (smaller = brighter; Venus about -4, the faintest stars you can see about 6). */
  mag: number;
}

/** The five bright planets as seen from the Moon's centre (light-travel time and aberration included, like the Sun). */
export function planetSky(timeMs: number): PlanetSky[] {
  const date = new Date(timeMs);
  const moon = GeoMoon(date);
  return PLANETS.map(p => {
    const g = GeoVector(p.body, date, true);
    const x = g.x - moon.x, y = g.y - moon.y, z = g.z - moon.z, d = Math.hypot(x, y, z);
    return { name: p.name, j2000: [x / d, y / d, z / d], distM: d * AU_M, mag: Illumination(p.body, date).mag };
  });
}

/**
 * Star colour from its B-V colour index (blue-white < 0 … Sun 0.65 … red 1.8), as [r, g, b] 0..1 with the
 * brightest channel at 1. B-V -> temperature (Ballesteros 2012) -> black-body colour (fit by T. Helland).
 */
export function bvToRgb(bv: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const b = Math.max(-0.4, Math.min(2.0, bv));
  const t = 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62)) / 100;
  let r: number, g: number, bl: number;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
  else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); }
  if (t >= 66) bl = 255; else if (t <= 19) bl = 0; else bl = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v: number) => Math.max(0, Math.min(255, v)) / 255;
  const R = c(r), G = c(g), B = c(bl), m = Math.max(R, G, B, 1e-6);
  out[0] = R / m; out[1] = G / m; out[2] = B / m;
  return out;
}

/** Sub-point: the latitude / longitude (degrees) on a body's own map that a direction (in that body's fixed frame) points out of. */
export function latLonOf(v: Vec3): { lat: number; lon: number } {
  const r = Math.hypot(v[0], v[1], v[2]);
  return { lat: Math.asin(v[2] / r) / DEG, lon: Math.atan2(v[1], v[0]) / DEG };
}
