const MAP_R = 1737400;
// A local azimuthal map gradually becomes an orthographic view of the same hemisphere.
// The radial formula is shared by forward and inverse transforms, so changing scale cannot
// move a pin onto different ground. Orthographic reference: d3-geo/src/projection/orthographic.js (ISC).

type V3 = [number, number, number];
type XY = [number, number];
const DEG = Math.PI / 180, HALF_PI = Math.PI / 2;
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normal = (v: V3): V3 => { const n = Math.hypot(...v); return [v[0] / n, v[1] / n, v[2] / n]; };
const unit = (lat: number, lon: number): V3 => { const p = lat * DEG, l = lon * DEG, c = Math.cos(p); return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)]; };
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

class SurfaceProjection {
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

type FlatBasis = {up:[number,number,number];east:[number,number,number];north:[number,number,number]};
type FlatQuaternion=[number,number,number,number];
class FlatMapProjection {
  lat = 0;
  lon = 0;
  blend = 0;
  revision = 0;
  private readonly local: SurfaceProjection;
  private start: FlatQuaternion = [0, 0, 0, 1];
  private end: FlatQuaternion = [0, 0, 0, 1];
  private frame: FlatBasis = { up: [1, 0, 0], east: [0, 1, 0], north: [0, 0, 1] };
  private offset = 0;

  constructor(lat: number, lon: number) {
    this.local = new SurfaceProjection(lat, lon);
    this.reset(lat, lon);
  }

  reset(lat: number, lon: number) {
    if (!Number.isFinite(lat + lon)) return;
    this.lat = Math.max(-90, Math.min(90, lat)); this.lon = this.wrap(lon);
    this.local.reset(this.lat, this.lon); this.local.setAcross(60, true);
    this.refreshEnds(); this.refreshFrame(); this.revision++;
  }

  moveCentre(lat: number, lon: number) {
    if (!Number.isFinite(lat + lon)) return;
    this.lat = Math.max(-90, Math.min(90, lat)); this.lon = this.wrap(lon);
    this.local.moveCentre(this.lat, this.lon);
    this.refreshEnds(); this.refreshFrame(); this.revision++;
  }

  setAcross(across: number, round: boolean) {
    this.local.setAcross(across, true);
    const t = round ? 0 : Math.max(0, Math.min(1, Math.log(Math.max(1, across) / 500000) / Math.log(4500000 / 500000)));
    const next = t * t * (3 - 2 * t);
    if (next !== this.blend) { this.blend = next; this.refreshFrame(); this.revision++; }
  }

  /** These arrays can also be the photo shader's uniforms. */
  basis() { return this.frame; }
  /** Subtract this from R * asin(dot(unit, basis.north)) in the shader. */
  offsetN() { return this.offset; }

  // This projection has no hidden hemisphere. Far ground falls outside a close viewport.
  depth(_lat: number, _lon: number) { return 1; }
  visible(lat: number, lon: number) { return Number.isFinite(lat + lon) && Math.abs(lat) <= 90 + 1e-9; }

  project(lat: number, lon: number): XY {
    const p = this.unit(lat, lon), f = this.frame;
    return [MAP_R * Math.atan2(this.dot(p, f.east), this.dot(p, f.up)),
      MAP_R * Math.asin(Math.max(-1, Math.min(1, this.dot(p, f.north)))) - this.offset];
  }

  unproject(e: number, n: number): XY {
    // East and west the map repeats, so any distance that way is a real place; only north and south have an end.
    const longitude = e / MAP_R, latitude = (n + this.offset) / MAP_R;
    if (!Number.isFinite(longitude + latitude) || Math.abs(latitude) > Math.PI / 2 + 1e-10) return [NaN, NaN];
    const p = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, latitude)), cp = Math.cos(p), a = cp * Math.cos(longitude), b = cp * Math.sin(longitude), c = Math.sin(p), f = this.frame;
    const x = f.up[0] * a + f.east[0] * b + f.north[0] * c;
    const y = f.up[1] * a + f.east[1] * b + f.north[1] * c;
    const z = f.up[2] * a + f.east[2] * b + f.north[2] * c;
    return [Math.asin(Math.max(-1, Math.min(1, z))) / DEG, Math.atan2(y, x) / DEG];
  }

  get limbRadius() { return Infinity; }

  private refreshEnds() {
    this.start = this.toQuaternion(this.readLocalBasis());
    const l = this.lon * DEG;
    this.end = this.toQuaternion({ up: [Math.cos(l), Math.sin(l), 0], east: [-Math.sin(l), Math.cos(l), 0], north: [0, 0, 1] });
  }

  private refreshFrame() {
    const a = this.start, t = this.blend;
    let b = this.end, dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    if (dot < 0) { b = [-b[0], -b[1], -b[2], -b[3]]; dot = -dot; }
    let u = 1 - t, v = t;
    if (dot < .9995) {
      const angle = Math.acos(Math.max(-1, Math.min(1, dot))), denominator = Math.sin(angle);
      u = Math.sin((1 - t) * angle) / denominator; v = Math.sin(t * angle) / denominator;
    }
    const q = a.map((value, i) => value * u + b[i] * v), length = Math.hypot(...q);
    const x = q[0] / length, y = q[1] / length, z = q[2] / length, w = q[3] / length;
    this.frame = {
      up: [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
      east: [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
      north: [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
    };
    const latitude = Math.asin(Math.max(-1, Math.min(1, this.dot(this.unit(this.lat, this.lon), this.frame.north))));
    this.offset = MAP_R * latitude * (1 - this.blend);
  }

  private toQuaternion(f: FlatBasis): FlatQuaternion {
    const m00 = f.up[0], m01 = f.east[0], m02 = f.north[0];
    const m10 = f.up[1], m11 = f.east[1], m12 = f.north[1];
    const m20 = f.up[2], m21 = f.east[2], m22 = f.north[2], trace = m00 + m11 + m22;
    let q: FlatQuaternion;
    if (trace > 0) {
      const s = Math.sqrt(trace + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
    } else if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
    } else if (m11 > m22) {
      const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
    } else {
      const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
    }
    const length = Math.hypot(...q); return q.map(value => value / length) as FlatQuaternion;
  }

  private wrap(lon: number) { return ((lon + 540) % 360 + 360) % 360 - 180; }
  private dot(a: [number, number, number], b: [number, number, number]) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  private unit(lat: number, lon: number): [number, number, number] {
    const p = lat * DEG, l = lon * DEG, cp = Math.cos(p);
    return [cp * Math.cos(l), cp * Math.sin(l), Math.sin(p)];
  }

  private readLocalBasis(): FlatBasis {
    const p = this.lat * DEG, l = this.lon * DEG, cp = Math.cos(p), sp = Math.sin(p), cl = Math.cos(l), sl = Math.sin(l);
    const up: [number, number, number] = [cp * cl, cp * sl, sp];
    const east0: [number, number, number] = [-sl, cl, 0], north0: [number, number, number] = [-sp * cl, -sp * sl, cp];
    const sample = (direction: [number, number, number]) => {
      const angle = .00001, c = Math.cos(angle), s = Math.sin(angle), v = up.map((value, i) => value * c + direction[i] * s);
      return this.local.project(Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG, Math.atan2(v[1], v[0]) / DEG);
    };
    const a = sample(east0), b = sample(north0), distance = 2 * MAP_R * Math.tan(.00001 / 2);
    let east = east0.map((v, i) => (v * a[0] + north0[i] * b[0]) / distance) as [number, number, number];
    const leak = this.dot(east, up); east = east.map((v, i) => v - leak * up[i]) as [number, number, number];
    const length = Math.hypot(...east); east = east.map(v => v / length) as [number, number, number];
    const north: [number, number, number] = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];
    return { up, east, north };
  }
}
