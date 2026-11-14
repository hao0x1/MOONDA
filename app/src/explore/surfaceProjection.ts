// A local azimuthal map gradually becomes an orthographic view of the same hemisphere.
// The radial formula is shared by forward and inverse transforms, so changing scale cannot
// move a pin onto different ground. Orthographic reference: d3-geo/src/projection/orthographic.js (ISC).
import { MAP_R } from './mapImagery';

type V3 = [number, number, number];
type XY = [number, number];
const DEG = Math.PI / 180, HALF_PI = Math.PI / 2;
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normal = (v: V3): V3 => { const n = Math.hypot(...v); return [v[0] / n, v[1] / n, v[2] / n]; };
const unit = (lat: number, lon: number): V3 => { const p = lat * DEG, l = lon * DEG, c = Math.cos(p); return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)]; };
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

export class SurfaceProjection {
  lat = 0;
  lon = 0;
  blend = 0;
  revision = 0;
  private up: V3 = [1, 0, 0];
  private east: V3 = [0, 1, 0];
  private north: V3 = [0, 0, 1];

  constructor(lat: number, lon: number) { this.reset(lat, lon); }

  reset(lat: number, lon: number) {
    this.lat = lat; this.lon = lon; this.up = unit(lat, lon);
    const l = lon * DEG;
    this.east = [-Math.sin(l), Math.cos(l), 0];
    this.north = normal(cross(this.up, this.east));
    this.revision++;
  }

  /** Carry north across a pole rather than flipping the map when longitude changes by 180 degrees. */
  moveCentre(lat: number, lon: number) {
    if (!Number.isFinite(lat + lon)) return;
    const next = unit(lat, lon), axis = cross(this.up, next), sine = Math.hypot(...axis), cosine = clamp(dot(this.up, next), -1, 1);
    let east = this.east;
    if (sine > 1e-12) {
      const k: V3 = [axis[0] / sine, axis[1] / sine, axis[2] / sine], turn = cross(k, east), along = dot(k, east) * (1 - cosine);
      east = [east[0] * cosine + turn[0] * sine + k[0] * along, east[1] * cosine + turn[1] * sine + k[1] * along, east[2] * cosine + turn[2] * sine + k[2] * along];
    }
    const leak = dot(east, next);
    east = normal([east[0] - next[0] * leak, east[1] - next[1] * leak, east[2] - next[2] * leak]);
    const l = lon * DEG, trueEast: V3 = [-Math.sin(l), Math.cos(l), 0], trueNorth = normal(cross(next, trueEast));
    // True north stays up on ordinary maps; near either pole, transport it continuously through the pole.
    const polar = clamp((Math.abs(lat) - 80) / 6, 0, 1), hold = polar * polar * (3 - 2 * polar);
    const roll = Math.atan2(dot(east, trueNorth), dot(east, trueEast)) * hold;
    this.east = [trueEast[0] * Math.cos(roll) + trueNorth[0] * Math.sin(roll), trueEast[1] * Math.cos(roll) + trueNorth[1] * Math.sin(roll), trueEast[2] * Math.cos(roll) + trueNorth[2] * Math.sin(roll)];
    this.up = next; this.north = normal(cross(this.up, this.east));
    this.lat = lat; this.lon = lon; this.revision++;
  }

  setAcross(across: number, round: boolean) {
    // At 300 km it remains the local map. By 2,400 km only the front hemisphere remains.
    const x = round ? 0 : clamp((Math.log(across) - Math.log(500000)) / (Math.log(2400000) - Math.log(500000)), 0, 1);
    const blend = x * x * (3 - 2 * x);
    if (blend !== this.blend) { this.blend = blend; this.revision++; }
  }

  depth(lat: number, lon: number) { return dot(unit(lat, lon), this.up); }
  visible(lat: number, lon: number) { return this.depth(lat, lon) >= -1e-9; }

  project(lat: number, lon: number): XY {
    const p = unit(lat, lon), z = clamp(dot(p, this.up), -1, 1), e = dot(p, this.east), n = dot(p, this.north), sine = Math.hypot(e, n);
    if (sine < 1e-14) return z > 0 ? [0, 0] : [0, MAP_R * 4];
    const c = Math.atan2(sine, z), radius = this.radius(c), scale = radius / sine;
    return [e * scale, n * scale];
  }

  unproject(e: number, n: number): XY {
    const radius = Math.hypot(e, n), limit = this.limbRadius;
    if (!Number.isFinite(radius) || radius > limit * (1 + 1e-9)) return [NaN, NaN];
    if (radius < 1e-8) return [this.lat, this.lon];
    const r = Math.min(radius / MAP_R, limit / MAP_R), b = this.blend;
    let c: number;
    if (b === 1) c = Math.asin(clamp(r, 0, 1));
    else if (b === 0) c = 2 * Math.atan(r / 2);
    else {
      let low = 0, high = HALF_PI;
      c = Math.min(HALF_PI, r);
      for (let i = 0; i < 10; i++) {
        const halfCos = Math.cos(c / 2), f = (1 - b) * 2 * Math.tan(c / 2) + b * Math.sin(c) - r;
        if (Math.abs(f) < 1e-12) break;
        if (f > 0) high = c; else low = c;
        const next = c - f / ((1 - b) / (halfCos * halfCos) + b * Math.cos(c));
        c = next > low && next < high ? next : (low + high) / 2;
      }
    }
    const s = Math.sin(c) / radius, z = Math.cos(c), x = this.up[0] * z + (this.east[0] * e + this.north[0] * n) * s;
    const y = this.up[1] * z + (this.east[1] * e + this.north[1] * n) * s, zz = this.up[2] * z + (this.east[2] * e + this.north[2] * n) * s;
    return [Math.asin(clamp(zz, -1, 1)) / DEG, Math.atan2(y, x) / DEG];
  }

  get limbRadius() { return MAP_R * (2 - this.blend); }

  private radius(c: number) { return MAP_R * ((1 - this.blend) * 2 * Math.tan(c / 2) + this.blend * Math.sin(c)); }
}
