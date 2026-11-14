// A link between MOONDA the rover (lander.ts) and everything that follows it on screen: the minimap, the
// waypoint markers and the trail (src/explore/). Like landerLink it is a plain object that is
// written in place many times a second, so nothing here goes through React.
//
//   pose        where the rover is now (true lat / lon, heading, speed ...), at most 30 times a second
//   trail       the breadcrumbs of this drive: one point every metre or so, with the ground height
//   waypoints   the pins to point at (the start, the destination, the Compare pins); lander.ts draws them over
//               the 3D view (through hills) and reports each one's compass bearing and distance back here
//   reset / teleport   put the rover somewhere else (handled by lander.ts while the view is open)
//
// Positions are TRUE Moon latitude / longitude in degrees. `e` / `n` are metres east / north of the landing spot
// in its own flat frame (the frame the HUD compass uses), handy for a north-up map round the spot.

const R = 1737400;
const DEG = Math.PI / 180;

export interface RoverPose {
  /** false until the rover stands on the ground of the open view */
  on: boolean;
  lat: number; lon: number;
  /** height of the ground under it (m above the 1,737.4 km sphere, NASA heights) */
  groundM: number;
  /** metres east / north of the landing spot */
  e: number; n: number;
  /** which way it faces: degrees clockwise from the landing spot's north (the HUD compass) */
  headingDeg: number;
  /** speed along the ground (m/s, negative backwards) */
  speed: number;
  /** nose up / right side up (degrees), and how steep the ground under the wheels is (degrees) */
  pitchDeg: number; rollDeg: number; slopeDeg: number;
  /** which way the camera faces (degrees, same frame as headingDeg) */
  camAz: number;
  view: 'spot' | 'third' | 'first';
  driving: boolean;
}

export type WaypointKind = 'start' | 'dest' | 'pin' | 'next' | 'site';
export interface Waypoint {
  id: string;
  kind: WaypointKind;
  lat: number; lon: number;
  /** a short name ("Start", "Destination", a place name) */
  label: string;
  /** ring colour and letter for a Compare pin */
  color?: string; letter?: string;
}
/** Where a waypoint is as seen from the rover right now (written by lander.ts every frame it is drawn). */
export interface WaypointSeen { az: number; distM: number }

export interface StartPose { lat: number; lon: number; headingDeg: number }

type Listener = () => void;
const poseListeners = new Set<Listener>();
const wayListeners = new Set<Listener>();
const trailListeners = new Set<Listener>();

/** Smallest step between two breadcrumbs (m), and the most we keep (older ones are thinned, never dropped at the ends). */
const TRAIL_STEP_M = 1, TRAIL_MAX = 6000;

export const roverLink = {
  pose: { on: false, lat: 0, lon: 0, groundM: 0, e: 0, n: 0, headingDeg: 0, speed: 0, pitchDeg: 0, rollDeg: 0, slopeDeg: 0, camAz: 0, view: 'spot', driving: false } as RoverPose,
  /** the landing spot the open view belongs to (true lat / lon), null outside the view */
  spot: null as { lat: number; lon: number } | null,
  /** where the rover first stood in this view (its parking place by the lander) */
  home: null as StartPose | null,
  subscribe(fn: Listener): () => void { poseListeners.add(fn); return () => { poseListeners.delete(fn); }; },
  /** (lander.ts) the pose changed */
  emitPose() { poseListeners.forEach(l => l()); },

  // ---- the trail of this drive -------------------------------------------------------------------
  /** flat list: lat, lon, groundM, lat, lon, groundM ... */
  trail: [] as number[],
  /** indices (in points, not numbers) where a new stretch starts after a jump (Reset rover) */
  breaks: [] as number[],
  /** metres driven, metres climbed and descended (sums of the ups and of the downs) */
  distM: 0, climbM: 0, descentM: 0,
  /** steepest ground met (degrees) and seconds spent moving */
  maxSlopeDeg: 0, movingS: 0,
  onTrail(fn: Listener): () => void { trailListeners.add(fn); return () => { trailListeners.delete(fn); }; },
  /** Start a fresh, temporary trail. Leaving the surface forgets it. */
  startTrail() {
    this.trail = [];
    this.breaks = [];
    this.distM = 0; this.climbM = 0; this.descentM = 0;
    this.maxSlopeDeg = 0; this.movingS = 0;
    jumpNext = false;
    trailListeners.forEach(l => l());
  },
  /** (lander.ts) the next point after this one is not joined to the last (the rover was moved by hand). */
  breakTrail() { jumpNext = true; },
  /** (lander.ts) the rover is here now; a breadcrumb is dropped once it has moved a metre. `dt` = seconds since the last call. */
  record(lat: number, lon: number, groundM: number, slopeDeg: number, moving: boolean, dt: number) {
    const t = this.trail, n = t.length;
    if (moving) this.movingS += dt;
    if (slopeDeg > this.maxSlopeDeg && moving) this.maxSlopeDeg = slopeDeg;
    if (n === 0) { t.push(lat, lon, groundM); jumpNext = false; trailListeners.forEach(l => l()); return; }
    const d = surfaceDistM(t[n - 3], t[n - 2], lat, lon);
    if (jumpNext) {
      // moved by hand (Reset rover): a new stretch, unless it stands where the last one ended
      jumpNext = false;
      if (d > 3) { this.breaks.push(n / 3); t.push(lat, lon, groundM); trailListeners.forEach(l => l()); return; }
    }
    if (d < TRAIL_STEP_M) return;
    const dh = groundM - t[n - 1];
    this.distM += Math.hypot(d, dh);
    if (dh > 0) this.climbM += dh; else this.descentM -= dh;
    t.push(lat, lon, groundM);
    if (t.length / 3 > TRAIL_MAX) thin(this);
    trailListeners.forEach(l => l());
  },

  // ---- waypoints ---------------------------------------------------------------------------------
  waypoints: [] as Waypoint[],
  /** bearing and distance of each waypoint from the rover (by id), refreshed while the view is drawn */
  seen: new Map<string, WaypointSeen>(),
  setWaypoints(list: Waypoint[]) { this.waypoints = list; wayListeners.forEach(l => l()); },
  onWaypoints(fn: Listener): () => void { wayListeners.add(fn); return () => { wayListeners.delete(fn); }; },

  // ---- moving the rover by hand (lander.ts sets the handlers while the view is open) ----------------
  /** Back to where it first stood (by the lander). */
  reset() { resetHandler?.(); },
  /** Put it down at a place (true lat / lon), facing `headingDeg` in the landing spot's compass frame (as pose.headingDeg). */
  teleport(lat: number, lon: number, headingDeg: number) { teleportHandler?.(lat, lon, headingDeg); },
  /** Small rocks near the rover, for the minimap: metres east / north of the landing spot and their size (m). */
  rocks(): { e: number; n: number; d: number }[] { return rocksHandler?.() ?? []; },
  setHandlers(h: { reset: (() => void) | null; teleport: ((lat: number, lon: number, headingDeg: number) => void) | null; rocks: (() => { e: number; n: number; d: number }[]) | null }) {
    resetHandler = h.reset; teleportHandler = h.teleport; rocksHandler = h.rocks;
  },
};
let jumpNext = false;
let resetHandler: (() => void) | null = null;
let teleportHandler: ((lat: number, lon: number, headingDeg: number) => void) | null = null;
let rocksHandler: (() => { e: number; n: number; d: number }[]) | null = null;

/** Too many breadcrumbs: keep every second one of the older half (stretch starts are kept), so a very long drive still fits. */
function thin(link: typeof roverLink) {
  const t = link.trail, n = t.length / 3, half = Math.floor(n / 2);
  const keep = new Set(link.breaks);
  const out: number[] = [], map: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i < half && i % 2 === 1 && !keep.has(i) && !keep.has(i + 1)) { map.push(-1); continue; }
    map.push(out.length / 3);
    out.push(t[i * 3], t[i * 3 + 1], t[i * 3 + 2]);
  }
  link.breaks = link.breaks.map(b => map[b]).filter(b => b >= 0);
  link.trail = out;
}

// ---- small sphere maths shared by the minimap, the trail and the waypoints (true lat / lon, degrees) ----------

/** Great-circle distance over the Moon's surface (m). */
export function surfaceDistM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lon2 - lon1) * DEG;
  const s = Math.sin((p2 - p1) / 2), c = Math.sin(dl / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s * s + Math.cos(p1) * Math.cos(p2) * c * c)));
}

/** Compass bearing from one place to another (degrees clockwise from true north at the first). */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

/**
 * A flat frame round a place: metres east / north of it (the place's own east and north, as on a small map with
 * that place in the middle). Exact enough for tens of kilometres; this is the frame the HUD compass turns in.
 */
export class SpotFrame {
  readonly lat: number; readonly lon: number;
  private e: [number, number, number]; private n: [number, number, number]; private u: [number, number, number];
  constructor(lat: number, lon: number) {
    this.lat = lat; this.lon = lon;
    const p = lat * DEG, l = lon * DEG, cp = Math.cos(p), sp = Math.sin(p), cl = Math.cos(l), sl = Math.sin(l);
    this.u = [cp * cl, cp * sl, sp];
    this.e = [-sl, cl, 0];
    this.n = [-sp * cl, -sp * sl, cp];
  }
  /** Metres east and north of the spot. */
  toEN(lat: number, lon: number, out: [number, number] = [0, 0]): [number, number] {
    const p = lat * DEG, l = lon * DEG, cp = Math.cos(p), x = cp * Math.cos(l), y = cp * Math.sin(l), z = Math.sin(p);
    out[0] = R * (x * this.e[0] + y * this.e[1] + z * this.e[2]);
    out[1] = R * (x * this.n[0] + y * this.n[1] + z * this.n[2]);
    return out;
  }
  /** True lat / lon of the point `e`, `n` metres east / north of the spot. */
  toLatLon(e: number, n: number, out: [number, number] = [0, 0]): [number, number] {
    const a = e / R, b = n / R, c = Math.sqrt(Math.max(0, 1 - a * a - b * b));
    const x = a * this.e[0] + b * this.n[0] + c * this.u[0], y = a * this.e[1] + b * this.n[1] + c * this.u[1], z = a * this.e[2] + b * this.n[2] + c * this.u[2];
    out[0] = Math.asin(Math.max(-1, Math.min(1, z))) / DEG;
    out[1] = Math.atan2(y, x) / DEG;
    return out;
  }
  /** True unit vector (Moon frame) of the point `e`, `n` (for the height map's heightAtUnit). */
  unit(e: number, n: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    const a = e / R, b = n / R, c = Math.sqrt(Math.max(0, 1 - a * a - b * b));
    out[0] = a * this.e[0] + b * this.n[0] + c * this.u[0];
    out[1] = a * this.e[1] + b * this.n[1] + c * this.u[1];
    out[2] = a * this.e[2] + b * this.n[2] + c * this.u[2];
    return out;
  }
}

if (import.meta.env.DEV) (window as unknown as { __roverLink: unknown }).__roverLink = roverLink; // for test scripts
