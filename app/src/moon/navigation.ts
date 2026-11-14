// Google-Earth-style navigation for the Moon. The behaviour follows NASA-AMMOS "GlobeControls"
// (the controls of the team's earlier app, which the team liked), rebuilt on Cesium's camera:
//
// - drag               grab the Moon: the spot under the cursor stays under the cursor; let go while moving and it keeps turning (fling)
// - scroll / pinch     smooth zoom towards the cursor
// - double-click       glide in ×2 on that spot (right double-click or Shift+double-click: out)
// - right-drag, middle-drag, Ctrl/⌘/Shift+drag    turn (left/right) and tilt (up/down) around the grabbed spot
// - arrows pan, +/- zoom, N north up, U straight down, Shift+arrows turn/tilt
// - the camera never goes into the ground, and never rolls (the horizon stays level)
//
// We set the camera ourselves every frame; Cesium's own mouse controller is switched off.
// The Moon sits rotated inside Cesium (see frame.ts); nothing here depends on that except "north".

import { Cartesian2, Cartesian3, Math as CMath, Matrix3, Quaternion, Ray, type Viewer } from 'cesium';
import type { MoonHeights } from '../science/heights';
import { azimuthOf, directionFor, MOON_R, toCartesian, toTrueLatLon, TRUE_NORTH_DISPLAY, trueENU } from './frame';

const MIN_HEIGHT_M = 100;          // closest the eye gets to the ground
const MAX_DIST_M = 25_000_000;     // farthest from the Moon's centre
const DRAG_DAMP_FAR = 0.4;         // zoomed out, a drag turns the Moon 60% as far as the hand moves
// The coast after a drag ("fling"), like Google Earth: let go while moving and the Moon keeps turning, slowing smoothly.
const FLING_WINDOW_MS = 100;       // the hand's speed is measured over its last 100 ms before letting go
const FLING_REST_MS = 90;          // the hand rested this long before letting go (no real movement): no coast at all
const FLING_REST_PX = 2;           // smaller wobbles than this (px) do not count as movement
const FLING_GRACE_MS = 25;         // a gap this short between the last move and the release is normal, not a pause
const FLING_GAIN = 0.8;            // the coast starts at 80% of the speed the Moon had under the hand (calmer than the hand)
const FLING_MIN_PX_S = 40;         // slower than this on screen at release: no coast
const FLING_TAU_FAR = 1.1;         // s — how slowly the coast dies at whole-Moon view (a quick flick visibly coasts ~3 s)
const FLING_TAU_NEAR = 0.6;        // s — close to the ground (same screen speed, shorter glide: you stay where you were looking)
const FLING_MAX_RAD_S = 0.9;       // rad/s — a wild flick never spins the whole Moon faster than this (about 52°/s)
const FLING_MAX_SCREENS_S = 0.8;   // screen heights per second — the fastest the ground may slide past closer in
const FLING_STOP_PX_S = 2;         // the coast ends when the view moves slower than this
const KEY_TAU = 0.19;              // s — the little glide after letting go of an arrow key
const TURN_TAU = 0.35;             // s — the short coast after a turn/tilt drag
const TURN_MAX_PX_S = 350;         // a turn/tilt coast starts no faster than a hand moving this fast
const TURN_STOP_PX_S = 4;          // ...and ends below this
const ZOOM_TAU_WHEEL = 0.18;       // s — easing of a mouse-wheel notch (a smooth glide, like Google Earth)
const ZOOM_TAU_TRACKPAD = 0.14;    // s — two-finger scroll / pinch on a trackpad
const ZOOM_TAU_DOUBLE = 0.17;      // s — double-click glide (about 0.6 s in all)
const TURN_RAD_PER_PX = 0.0045;    // right-drag turn / tilt speed
const CLICK_SLOP_PX = 4;
const DOUBLE_CLICK_MS = 240;

export interface CameraPose { destination: Cartesian3; direction: Cartesian3; up: Cartesian3 }

/** A camera looking at a true lat/lon from `rangeM` away, facing compass `headingDeg`, tilted `pitchDeg` (-90 = straight down). */
export function poseLookingAt(latDeg: number, lonDeg: number, groundM: number, rangeM: number, headingDeg = 0, pitchDeg = -90): CameraPose {
  const target = toCartesian(latDeg, lonDeg, groundM);
  const p = Math.max(-89.999, Math.min(-1, pitchDeg));
  const dir = directionFor(headingDeg, p, latDeg, lonDeg);
  const up = directionFor(headingDeg, p + 90, latDeg, lonDeg);
  const destination = Cartesian3.subtract(target, Cartesian3.multiplyByScalar(dir, rangeM, new Cartesian3()), new Cartesian3());
  return { destination, direction: dir, up };
}

/** Whole-Moon view: from above a true lat/lon at `altitudeM`, looking at the centre, true north up. */
export function poseGlobe(latDeg: number, lonDeg: number, altitudeM: number): CameraPose {
  const destination = toCartesian(latDeg, lonDeg, altitudeM);
  const direction = Cartesian3.normalize(Cartesian3.negate(destination, new Cartesian3()), new Cartesian3());
  const n = TRUE_NORTH_DISPLAY;
  const up = Cartesian3.normalize(Cartesian3.subtract(n, Cartesian3.multiplyByScalar(direction, Cartesian3.dot(n, direction), new Cartesian3()), new Cartesian3()), new Cartesian3());
  return { destination, direction, up };
}

/** Compass heading (true north = 0) and pitch of the current camera, for the compass and HUD. */
export function cameraHeadingPitch(viewer: Viewer): { heading: number; pitch: number; km: number } {
  const cam = viewer.camera;
  const pos = toTrueLatLon(cam.positionWC);
  const { up } = trueENU(pos.lat, pos.lon);
  const pitch = Math.asin(CMath.clamp(Cartesian3.dot(cam.directionWC, up), -1, 1)) * 180 / Math.PI;
  // Looking nearly straight down, the screen's "up" is what tells you which way you face.
  const forward = pitch < -75 ? cam.upWC : cam.directionWC;
  return { heading: azimuthOf(forward, pos.lat, pos.lon), pitch, km: pos.height / 1000 };
}

export interface NavOptions {
  /** Wheel while navigation is disabled (the lander view zooms its lens with it). */
  onFovWheel?(d: number): void;
  /** True when something clickable (a name, an icon, a pin) is at this canvas position: shows the pointing-hand cursor. */
  isClickableAt?(x: number, y: number): boolean;
  /** A true single click: no drag, and not the first half of a double-click. */
  onClick?(x: number, y: number): void;
  /** The pointer moved with no button down (at most once per frame). */
  onHoverMove?(x: number, y: number): void;
}

export interface Navigation {
  /** false = ignore all input (the lander view owns the camera). */
  enabled: boolean;
  /** Dragging, coasting, zooming or flying right now. */
  readonly interacting: boolean;
  /** Animated zoom; positive = closer. `anchor` is a canvas position to zoom towards (default: the centre). */
  zoomBy(logFactor: number, anchor?: { x: number; y: number }): void;
  /** Animated: true north up, keeping the point at the centre of the screen. */
  resetNorth(): void;
  /** Animated tilt about the point at the centre of the screen; -90 = straight down. */
  setTilt(pitchDeg: number): void;
  /** Smooth flight to a camera pose. Resolves false if the user interrupted it. */
  flyTo(pose: CameraPose, opts?: { duration?: number }): Promise<boolean>;
  /** Glide to a view where a far body (the Sun, Earth) shows just above the edge of the Moon.
   *  `dir`: direction from the Moon's centre to the body, in Cesium world (display) coordinates. */
  showBody(dir: Cartesian3): Promise<boolean>;
  /** Stop coasting, zooming and flying at once. */
  cancel(): void;
  destroy(): void;
}

interface Pose { p: Cartesian3; d: Cartesian3; u: Cartesian3 }
/** A camera described by what it looks at: where (q), from how far, and how tilted. Good for smooth flights. */
interface Orbit { q: Quaternion; logRange: number; pitch: number; radius: number }

const m3 = new Matrix3();
const tmpA = new Cartesian3(), tmpB = new Cartesian3(), tmpC = new Cartesian3();

const rotatePose = (q: Quaternion, pose: Pose) => {
  Matrix3.fromQuaternion(q, m3);
  Matrix3.multiplyByVector(m3, pose.p, pose.p);
  Matrix3.multiplyByVector(m3, pose.d, pose.d);
  Matrix3.multiplyByVector(m3, pose.u, pose.u);
};

/** The rotation that turns unit vector a into unit vector b the short way. */
const quatBetween = (a: Cartesian3, b: Cartesian3, out: Quaternion): Quaternion => {
  const c = Cartesian3.cross(a, b, tmpA);
  const s = Cartesian3.magnitude(c);
  if (s < 1e-14) return Quaternion.clone(Quaternion.IDENTITY, out);
  return Quaternion.fromAxisAngle(Cartesian3.divideByScalar(c, s, tmpA), Math.atan2(s, Cartesian3.dot(a, b)), out);
};

/** Nearest point where a ray meets a sphere of radius r around the Moon's centre, or null. */
const sphereHit = (o: Cartesian3, dir: Cartesian3, r: number, out: Cartesian3): Cartesian3 | null => {
  const b = Cartesian3.dot(o, dir), c = Cartesian3.dot(o, o) - r * r, disc = b * b - c;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  let t = -b - root;
  if (t < 0) t = -b + root;
  if (t < 0) return null;
  return Cartesian3.add(o, Cartesian3.multiplyByScalar(dir, t, out), out);
};

/** Off the edge of the Moon: the point on the visible rim in the cursor's direction (so a drag keeps following the cursor). */
const horizonPoint = (o: Cartesian3, dir: Cartesian3, r: number, out: Cartesian3): Cartesian3 => {
  const dist = Cartesian3.magnitude(o);
  const axis = Cartesian3.divideByScalar(o, dist, tmpA);
  const az = Cartesian3.subtract(dir, Cartesian3.multiplyByScalar(axis, Cartesian3.dot(axis, dir), tmpB), tmpB);
  Cartesian3.normalize(az, az);
  const hr = r * Math.sqrt(Math.max(1 - (r / dist) ** 2, 0));
  Cartesian3.multiplyByScalar(axis, (r * r) / dist, out);
  return Cartesian3.add(out, Cartesian3.multiplyByScalar(az, hr, tmpB), out);
};

const orbitOf = (pose: Pose): Orbit => {
  const T = new Cartesian3();
  if (!sphereHit(pose.p, pose.d, MOON_R, T)) {
    // looking past the Moon: use the point of the sight line nearest the centre
    const t = Math.max(1, -Cartesian3.dot(pose.p, pose.d));
    Cartesian3.add(pose.p, Cartesian3.multiplyByScalar(pose.d, t, T), T);
  }
  const radius = Cartesian3.magnitude(T);
  const That = Cartesian3.divideByScalar(T, radius, new Cartesian3());
  const sinPitch = CMath.clamp(Cartesian3.dot(pose.d, That), -1, 1);
  const h = Cartesian3.subtract(pose.d, Cartesian3.multiplyByScalar(That, sinPitch, tmpA), new Cartesian3());
  if (Cartesian3.magnitude(h) < 0.02) { // (nearly) straight down: the top of the screen tells the heading
    Cartesian3.subtract(pose.u, Cartesian3.multiplyByScalar(That, Cartesian3.dot(pose.u, That), tmpA), h);
  }
  Cartesian3.normalize(h, h);
  const side = Cartesian3.cross(That, h, new Cartesian3());
  const basis = new Matrix3(That.x, h.x, side.x, That.y, h.y, side.y, That.z, h.z, side.z);
  return { q: Quaternion.fromRotationMatrix(basis), logRange: Math.log(Math.max(1, Cartesian3.distance(pose.p, T))), pitch: Math.asin(sinPitch), radius };
};

const poseOf = (o: Orbit): Pose => {
  const m = Matrix3.fromQuaternion(o.q, new Matrix3());
  const That = Matrix3.getColumn(m, 0, new Cartesian3()), h = Matrix3.getColumn(m, 1, new Cartesian3());
  const c = Math.cos(o.pitch), s = Math.sin(o.pitch);
  const d = Cartesian3.add(Cartesian3.multiplyByScalar(h, c, new Cartesian3()), Cartesian3.multiplyByScalar(That, s, tmpA), new Cartesian3());
  const u = Cartesian3.add(Cartesian3.multiplyByScalar(h, -s, new Cartesian3()), Cartesian3.multiplyByScalar(That, c, tmpA), new Cartesian3());
  Cartesian3.normalize(d, d); Cartesian3.normalize(u, u);
  const p = Cartesian3.subtract(Cartesian3.multiplyByScalar(That, o.radius, new Cartesian3()), Cartesian3.multiplyByScalar(d, Math.exp(o.logRange), tmpA), new Cartesian3());
  return { p, d, u };
};

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth01 = (x: number) => { const t = CMath.clamp(x, 0, 1); return t * t * (3 - 2 * t); };

/** Least-squares slope (units per second) of each value column against time (ms). */
const fitSlope = (t: number[], vals: number[][]): number[] => {
  const n = t.length, tm = t.reduce((a, b) => a + b, 0) / n;
  let stt = 0;
  for (const ti of t) stt += (ti - tm) ** 2;
  return vals[0].map((_, k) => {
    const vm = vals.reduce((a, v) => a + v[k], 0) / n;
    let stv = 0;
    for (let i = 0; i < n; i++) stv += (t[i] - tm) * (vals[i][k] - vm);
    return stt > 0 ? (stv / stt) * 1000 : 0;
  });
};
/** Rotation vector (axis × angle, rad) of a quaternion. */
const rotVec = (q: Quaternion): number[] => {
  const sg = q.w < 0 ? -1 : 1, x = q.x * sg, y = q.y * sg, z = q.z * sg, s = Math.hypot(x, y, z);
  if (s < 1e-12) return [2 * x, 2 * y, 2 * z];
  const k = (2 * Math.atan2(s, q.w * sg)) / s;
  return [x * k, y * k, z * k];
};
interface Sample { t: number; x: number; y: number; q?: Quaternion }
/**
 * The hand's speed at release, from the samples of its last ~100 ms (pointer-event timestamps, coalesced events
 * included). Returns null when the hand had come to rest. `value` picks what is measured (pointer px, or rotation).
 */
const releaseSpeed = (samples: Sample[], tUp: number, value: (s: Sample) => number[]): number[] | null => {
  if (samples.length < 2) return null;
  const last = samples[samples.length - 1];
  // when did the hand last really move? (latest sample still away from where it let go)
  let moved = -Infinity;
  for (let i = samples.length - 1; i >= 0; i--) if (Math.hypot(samples[i].x - last.x, samples[i].y - last.y) >= FLING_REST_PX) { moved = samples[i].t; break; }
  if (tUp - moved > FLING_REST_MS) return null;
  let i0 = samples.length - 1;
  while (i0 > 0 && samples[i0 - 1].t >= tUp - FLING_WINDOW_MS) i0--;
  if (i0 > 0 && samples.length - i0 < 3) i0--; // too few events in the window (slow mouse): take one more
  const use = samples.slice(i0);
  const t = use.map(s => s.t), v = use.map(value);
  // a real pause between the last move and the release slows the estimate down, as it should
  if (tUp - last.t > FLING_GRACE_MS) { t.push(tUp); v.push(v[v.length - 1]); }
  if (t[t.length - 1] - t[0] < 8) return null;
  return fitSlope(t, v);
};
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function attachNavigation(viewer: Viewer, heights: MoonHeights, options: NavOptions | ((d: number) => void) = {}): Navigation {
  const opts: NavOptions = typeof options === 'function' ? { onFovWheel: options } : options;
  const scene = viewer.scene, camera = viewer.camera, canvas = scene.canvas;
  // Cesium's own mouse/touch controller is not used at all.
  scene.screenSpaceCameraController.enableInputs = false;
  camera.constrainedAxis = undefined;
  canvas.style.touchAction = 'none';

  let enabled = true;
  let destroyed = false;
  let raf = 0, lastTick = 0;

  // ---- camera access -------------------------------------------------------------------------
  const cur = (): Pose => ({ p: Cartesian3.clone(camera.positionWC), d: Cartesian3.clone(camera.directionWC), u: Cartesian3.clone(camera.upWC) });
  const frustum = () => {
    const f = camera.frustum as unknown as { fovy: number; aspectRatio: number };
    const tanY = Math.tan(f.fovy / 2);
    return { tanY, tanX: tanY * f.aspectRatio, W: canvas.clientWidth, H: canvas.clientHeight };
  };
  /** Sight-line direction through a canvas position for any pose (not only the current camera). */
  const rayDir = (pose: Pose, x: number, y: number, out: Cartesian3): Cartesian3 => {
    const f = frustum();
    const right = Cartesian3.cross(pose.d, pose.u, tmpC);
    const nx = (2 * x / f.W - 1) * f.tanX, ny = (1 - 2 * y / f.H) * f.tanY;
    out.x = pose.d.x + right.x * nx + pose.u.x * ny;
    out.y = pose.d.y + right.y * nx + pose.u.y * ny;
    out.z = pose.d.z + right.z * nx + pose.u.z * ny;
    return Cartesian3.normalize(out, out);
  };
  const groundRadius = (p: Cartesian3) => { const t = toTrueLatLon(p); return MOON_R + heights.heightAt(t.lat, t.lon, true); };
  /** Keep the eye above the ground and inside the allowed distance. */
  const clear = (p: Cartesian3) => {
    const r = Cartesian3.magnitude(p);
    const need = groundRadius(p) + MIN_HEIGHT_M;
    if (r < need) Cartesian3.multiplyByScalar(p, need / r, p);
    else if (r > MAX_DIST_M) Cartesian3.multiplyByScalar(p, MAX_DIST_M / r, p);
  };
  const apply = (pose: Pose) => {
    clear(pose.p);
    camera.setView({ destination: pose.p, orientation: { direction: pose.d, up: pose.u } });
    scene.requestRender();
  };

  const pickRay = new Ray(), pickPos = new Cartesian2();
  /** The ground point under a canvas position (real terrain when it is drawn, else the smooth Moon), or null in space. */
  const pickGround = (x: number, y: number): Cartesian3 | null => {
    const ray = camera.getPickRay(Cartesian2.fromElements(x, y, pickPos), pickRay);
    if (!ray) return null;
    const hit = scene.globe.pick(ray, scene);
    if (hit) return hit;
    const s = sphereHit(ray.origin, ray.direction, MOON_R, new Cartesian3());
    if (!s) return null;
    // one refinement with the real height there
    return sphereHit(ray.origin, ray.direction, groundRadius(s), new Cartesian3()) ?? s;
  };
  const centre = () => pickGround(canvas.clientWidth / 2, canvas.clientHeight / 2);

  // ---- state ---------------------------------------------------------------------------------
  const spin = new Cartesian3();        // coasting: rotation about the Moon's centre, rad/s (axis * rate)
  let spinTau = KEY_TAU;                // s — how slowly that coast dies away
  let turnCoast: { pivot: Cartesian3; vx: number; vy: number } | null = null; // coasting after a turn/tilt drag, px/s of hand
  let pendingZoom = 0;                  // log distance still to apply (positive = away)
  let zoomAnchor: Cartesian3 | null = null;
  let zoomX = 0, zoomY = 0, zoomPickedAt = 0;
  let zoomTau = ZOOM_TAU_WHEEL;
  let flight: { from: Orbit; to: Orbit; target: Pose; hop: number; t0: number; dur: number; done: (ok: boolean) => void } | null = null;
  const held = new Set<string>();

  type Drag =
    | { kind: 'grab'; id: number; x0: number; y0: number; t0: number; base: Pose; gHat: Cartesian3; rG: number; moved: boolean; samples: Sample[] }
    | { kind: 'turn'; id: number; x0: number; y0: number; t0: number; pivot: Cartesian3; lastX: number; lastY: number; moved: boolean; samples: Sample[] };
  let drag: Drag | null = null;
  const touches = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; angle: number } | null = null;
  let clickTimer = 0;
  let lastRightDown = { t: 0, x: 0, y: 0 };
  let hoverRaf = 0, hoverX = 0, hoverY = 0;
  let cursor = '-';

  const setCursor = (c: string) => { if (cursor !== c) { cursor = c; canvas.style.cursor = c; } };

  // ---- on-screen feedback, like Google Earth: a ring around the hand while dragging, a small circle where you double-click
  const host = (viewer.container as HTMLElement);
  const ring = document.createElement('div');
  ring.className = 'nav-ring';
  host.append(ring);
  let ringShown = false;
  const showRing = (x: number, y: number) => {
    ring.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    if (!ringShown) { ringShown = true; ring.classList.add('on'); }
  };
  const hideRing = () => { if (ringShown) { ringShown = false; ring.classList.remove('on'); } };
  const pulse = (x: number, y: number) => {
    const el = document.createElement('div');
    el.className = 'nav-dbl';
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    el.append(document.createElement('i'), document.createElement('b'));
    host.append(el);
    setTimeout(() => el.remove(), 1100);
  };
  const kick = () => { if (!raf && !destroyed) { lastTick = performance.now(); raf = requestAnimationFrame(tick); } };
  const endFlight = (ok: boolean) => { const f = flight; flight = null; f?.done(ok); };
  const stopCoast = () => { Cartesian3.clone(Cartesian3.ZERO, spin); turnCoast = null; };
  const stopMotion = () => { stopCoast(); pendingZoom = 0; endFlight(false); };
  /** Radians of Moon turn per screen pixel at the screen centre, for a pose. */
  const radPerPxAt = (p: Cartesian3) => { const f = frustum(); return (2 * f.tanY * Math.max(100, Cartesian3.magnitude(p) - MOON_R)) / f.H / MOON_R; };
  const local = (e: { clientX: number; clientY: number }) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  // ---- zoom ----------------------------------------------------------------------------------
  const qTmp = new Quaternion(), dirTmp = new Cartesian3(), hitTmp = new Cartesian3(), aHat = new Cartesian3(), hHat = new Cartesian3();
  /** One zoom step of `s` log units (positive = away), keeping the anchor under the cursor. */
  const zoomStep = (s: number) => {
    const pose = cur();
    const dA = zoomAnchor ? Cartesian3.distance(pose.p, zoomAnchor) : Math.max(1000, Cartesian3.magnitude(pose.p) - MOON_R);
    let move = (1 - Math.exp(s)) * dA; // forward (+) or back (-) along the view direction
    const next = new Cartesian3();
    for (let i = 0; i < 6; i++) {
      Cartesian3.add(pose.p, Cartesian3.multiplyByScalar(pose.d, move, next), next);
      const r = Cartesian3.magnitude(next);
      if (s < 0 && r < groundRadius(next) + MIN_HEIGHT_M) { move *= 0.5; pendingZoom = 0; continue; }
      if (s > 0 && r > MAX_DIST_M) { move *= 0.5; pendingZoom = 0; continue; }
      break;
    }
    Cartesian3.clone(next, pose.p);

    if (s > 0) { // far away, a zoom-out gently turns the view to the Moon's centre and north-up (as GlobeControls does)
      const far = smooth01((Cartesian3.magnitude(pose.p) / MOON_R - 1.6) / 2.4);
      if (far > 0) {
        const toCentre = Cartesian3.normalize(Cartesian3.negate(pose.p, tmpA), tmpA);
        const right = Cartesian3.normalize(Cartesian3.cross(pose.d, pose.u, new Cartesian3()), new Cartesian3());
        const a = Math.min(0.4, 1.6 * s * far);
        Cartesian3.normalize(Cartesian3.lerp(pose.d, toCentre, a, pose.d), pose.d);
        // keep the screen level: drop any sideways part, rebuild "up"
        Cartesian3.normalize(Cartesian3.subtract(pose.d, Cartesian3.multiplyByScalar(right, Cartesian3.dot(pose.d, right), tmpB), pose.d), pose.d);
        Cartesian3.cross(right, pose.d, pose.u);
        if (far > 0.5 && Cartesian3.dot(pose.d, toCentre) > 0.985) {
          const n = TRUE_NORTH_DISPLAY;
          const upN = Cartesian3.subtract(n, Cartesian3.multiplyByScalar(pose.d, Cartesian3.dot(n, pose.d), tmpB), tmpB);
          if (Cartesian3.magnitude(upN) > 0.05) {
            Cartesian3.normalize(upN, upN);
            Cartesian3.lerp(pose.u, upN, Math.min(0.2, 0.8 * s * far), pose.u);
            Cartesian3.normalize(Cartesian3.subtract(pose.u, Cartesian3.multiplyByScalar(pose.d, Cartesian3.dot(pose.u, pose.d), tmpB), pose.u), pose.u);
          }
        }
      }
    }

    if (zoomAnchor) { // turn the whole view around the Moon's centre so the anchor is under the cursor again
      const rA = Cartesian3.magnitude(zoomAnchor);
      const hit = sphereHit(pose.p, rayDir(pose, zoomX, zoomY, dirTmp), rA, hitTmp);
      if (hit) {
        Cartesian3.divideByScalar(hit, rA, hHat);
        Cartesian3.divideByScalar(zoomAnchor, rA, aHat);
        rotatePose(quatBetween(hHat, aHat, qTmp), pose);
      }
    }
    apply(pose);
  };
  const aimZoom = (x: number, y: number) => {
    const now = performance.now();
    if (!zoomAnchor || Math.hypot(x - zoomX, y - zoomY) > 3 || now - zoomPickedAt > 600) {
      zoomAnchor = pickGround(x, y) ?? centre();
      zoomX = zoomAnchor && pickGround(x, y) ? x : canvas.clientWidth / 2;
      zoomY = zoomAnchor && zoomX === x ? y : canvas.clientHeight / 2;
    }
    zoomPickedAt = now;
  };

  // ---- flights -------------------------------------------------------------------------------
  const startFlight = (target: Pose, duration?: number): Promise<boolean> => {
    stopMotion();
    const from = orbitOf(cur()), to = orbitOf(target);
    const mFrom = Matrix3.fromQuaternion(from.q, new Matrix3()), mTo = Matrix3.fromQuaternion(to.q, new Matrix3());
    const sep = Math.acos(CMath.clamp(Cartesian3.dot(Matrix3.getColumn(mFrom, 0, tmpA), Matrix3.getColumn(mTo, 0, tmpB)), -1, 1));
    // travelling far: rise high enough in the middle to see where we are going
    const hop = Math.max(0, Math.log(Math.max(1, sep * MOON_R * 0.8)) - (from.logRange + to.logRange) / 2);
    const dur = duration ?? CMath.clamp(0.55 + 1.0 * sep + 0.1 * Math.abs(to.logRange - from.logRange) + 0.25 * hop, 0.55, 2.6);
    return new Promise<boolean>(resolve => {
      flight = { from, to, target, hop, t0: performance.now(), dur: dur * 1000, done: resolve };
      kick();
    });
  };
  const flightStep = (now: number) => {
    const f = flight!;
    const t = Math.min(1, (now - f.t0) / f.dur);
    if (t >= 1) { apply({ p: Cartesian3.clone(f.target.p), d: Cartesian3.clone(f.target.d), u: Cartesian3.clone(f.target.u) }); endFlight(true); return; }
    const e = easeInOut(t);
    apply(poseOf({
      q: Quaternion.slerp(f.from.q, f.to.q, e, new Quaternion()),
      logRange: f.from.logRange + (f.to.logRange - f.from.logRange) * e + f.hop * Math.sin(Math.PI * e),
      pitch: f.from.pitch + (f.to.pitch - f.from.pitch) * e,
      radius: f.from.radius + (f.to.radius - f.from.radius) * e,
    }));
  };
  /** Same look-at point and distance, new heading and/or pitch (degrees). */
  const reorient = (headingDeg: number | null, pitchDeg: number | null) => {
    const pose = cur();
    const c = centre();
    if (!c) return;
    const t = toTrueLatLon(c);
    const hp = cameraHeadingPitch(viewer);
    const range = Cartesian3.distance(pose.p, c);
    const target = poseLookingAt(t.lat, t.lon, t.height, range, headingDeg ?? hp.heading, pitchDeg ?? Math.min(-1, hp.pitch));
    void startFlight({ p: target.destination, d: target.direction, u: target.up }, 0.55);
  };

  // ---- the frame loop ------------------------------------------------------------------------
  const keyAxis = new Cartesian3();
  const tick = (now: number) => {
    raf = 0;
    if (destroyed) return;
    const dt = Math.min(0.064, Math.max(0.001, (now - lastTick) / 1000));
    lastTick = now;
    let active = false;

    if (flight) { flightStep(now); active = !!flight; }
    else if (enabled) {
      // keyboard: holding an arrow key keeps the Moon turning; Shift+arrow turns/tilts the view
      if (held.size) {
        const pose = cur();
        const f = frustum();
        const h = Math.max(200, Cartesian3.magnitude(pose.p) - MOON_R);
        const rate = Math.min(1.1, (0.9 * 2 * f.tanY * h) / MOON_R); // rad/s: about one screen height per second
        const right = Cartesian3.cross(pose.d, pose.u, tmpC);
        Cartesian3.clone(Cartesian3.ZERO, keyAxis);
        if (held.has('ArrowLeft')) Cartesian3.subtract(keyAxis, pose.u, keyAxis);
        if (held.has('ArrowRight')) Cartesian3.add(keyAxis, pose.u, keyAxis);
        if (held.has('ArrowUp')) Cartesian3.subtract(keyAxis, right, keyAxis);
        if (held.has('ArrowDown')) Cartesian3.add(keyAxis, right, keyAxis);
        if (Cartesian3.magnitude(keyAxis) > 0) { Cartesian3.multiplyByScalar(Cartesian3.normalize(keyAxis, keyAxis), rate, spin); spinTau = KEY_TAU; }
        const turn = (held.has('TurnLeft') ? 1 : 0) - (held.has('TurnRight') ? 1 : 0);
        const tilt = (held.has('TiltUp') ? 1 : 0) - (held.has('TiltDown') ? 1 : 0);
        if (turn || tilt) { const c = centre(); if (c) turnAbout(c, turn * 1.2 * dt, tilt * 0.9 * dt); }
        active = true;
      }
      const w = Cartesian3.magnitude(spin);
      if (w > 0 && !drag) {
        // exact exponential slow-down, the same whatever the frame rate: angle(t) = w0·tau·(1 − e^(−t/tau))
        const decay = held.size ? 1 : Math.exp(-dt / spinTau);
        const angle = held.size ? w * dt : w * spinTau * (1 - decay);
        const pose = cur();
        rotatePose(Quaternion.fromAxisAngle(Cartesian3.divideByScalar(spin, w, tmpA), angle, qTmp), pose);
        apply(pose);
        Cartesian3.multiplyByScalar(spin, decay, spin);
        // stop when the view moves slower than a couple of pixels per second
        if (Cartesian3.magnitude(spin) < FLING_STOP_PX_S * radPerPxAt(pose.p)) Cartesian3.clone(Cartesian3.ZERO, spin); else active = true;
      }
      if (turnCoast && !drag) {
        const decay = Math.exp(-dt / TURN_TAU), k = TURN_TAU * (1 - decay);
        turnAbout(turnCoast.pivot, -turnCoast.vx * k * TURN_RAD_PER_PX, -turnCoast.vy * k * TURN_RAD_PER_PX);
        turnCoast.vx *= decay; turnCoast.vy *= decay;
        if (Math.hypot(turnCoast.vx, turnCoast.vy) < TURN_STOP_PX_S) turnCoast = null; else active = true;
      }
      if (Math.abs(pendingZoom) > 1e-4) {
        const step = pendingZoom * (1 - Math.exp(-dt / zoomTau));
        pendingZoom -= step;
        zoomStep(step);
        if (drag?.kind === 'grab') regrab(drag); // zooming while holding the Moon: the next move must not undo the zoom
        active = true;
      } else pendingZoom = 0;
    }
    if (active) raf = requestAnimationFrame(tick);
  };

  // ---- turn / tilt about a ground point ---------------------------------------------------------
  /** Turn the camera around the vertical line through `pivot` (dHeading, rad) and tilt it about its own sideways axis (dTilt, rad; + = lower, more horizon). */
  const turnAbout = (pivot: Cartesian3, dHeading: number, dTilt: number) => {
    const pose = cur();
    const gHat = Cartesian3.normalize(pivot, new Cartesian3());
    if (dHeading) rotatePose(Quaternion.fromAxisAngle(gHat, dHeading, qTmp), pose); // the axis passes through the Moon's centre: stays level
    if (dTilt) {
      const off = Cartesian3.subtract(pose.p, pivot, new Cartesian3());
      const dist = Cartesian3.magnitude(off);
      const el = Math.asin(CMath.clamp(Cartesian3.dot(off, gHat) / dist, -1, 1)); // how high the camera sits above the pivot's horizon
      const lo = 4 * CMath.RADIANS_PER_DEGREE, hi = 89.95 * CMath.RADIANS_PER_DEGREE;
      const want = CMath.clamp(el - dTilt, lo, hi);
      const a = el - want;
      if (Math.abs(a) > 1e-7) {
        const right = Cartesian3.normalize(Cartesian3.cross(pose.d, pose.u, new Cartesian3()), new Cartesian3());
        Matrix3.fromQuaternion(Quaternion.fromAxisAngle(right, a, qTmp), m3);
        Matrix3.multiplyByVector(m3, off, off);
        const p2 = Cartesian3.add(pivot, off, new Cartesian3());
        if (Cartesian3.magnitude(p2) >= groundRadius(p2) + MIN_HEIGHT_M) { // never tilt into a hill
          Cartesian3.clone(p2, pose.p);
          Matrix3.multiplyByVector(m3, pose.d, pose.d);
          Matrix3.multiplyByVector(m3, pose.u, pose.u);
        }
      }
    }
    apply(pose);
  };

  // ---- pointer input -------------------------------------------------------------------------
  const startGrab = (e: PointerEvent, x: number, y: number) => {
    const base = cur();
    const g = pickGround(x, y) ?? horizonPoint(base.p, rayDir(base, x, y, dirTmp), MOON_R, new Cartesian3());
    const rG = Cartesian3.magnitude(g);
    drag = { kind: 'grab', id: e.pointerId, x0: x, y0: y, t0: performance.now(), base, gHat: Cartesian3.divideByScalar(g, rG, new Cartesian3()), rG, moved: false, samples: [] };
  };
  /** Total rotation since the press for a cursor position, applied to the pose at the press (path-independent, like an arcball). */
  const grabRotation = (d: Extract<Drag, { kind: 'grab' }>, x: number, y: number): Quaternion => {
    const dir = rayDir(d.base, x, y, dirTmp);
    const hit = sphereHit(d.base.p, dir, d.rG, hitTmp) ?? horizonPoint(d.base.p, dir, d.rG, hitTmp);
    Cartesian3.normalize(hit, hHat);
    const q = quatBetween(hHat, d.gHat, new Quaternion());
    // Speed limit when zoomed out: the Moon turns slower than the hand (calmer, less dizzying, like Google Earth's
    // globe view). Up close the ground sticks to the cursor exactly.
    const far = smooth01((Cartesian3.magnitude(d.base.p) / MOON_R - 1.15) / 0.8);
    return far > 0 ? Quaternion.slerp(Quaternion.IDENTITY, q, 1 - DRAG_DAMP_FAR * far, new Quaternion()) : q;
  };
  /** Take hold again from the current view (after a zoom during the drag), at the same spot under the cursor. */
  const regrab = (d: Extract<Drag, { kind: 'grab' }>) => {
    const last = d.samples[d.samples.length - 1];
    const x = last?.x ?? d.x0, y = last?.y ?? d.y0;
    d.base = cur();
    const dir = rayDir(d.base, x, y, dirTmp);
    const hit = sphereHit(d.base.p, dir, d.rG, hitTmp) ?? horizonPoint(d.base.p, dir, d.rG, hitTmp);
    Cartesian3.normalize(hit, d.gHat);
    d.samples.length = 0;
  };
  /** Keep the last quarter second of hand positions (with their own event times) for the release speed. */
  const keepSample = (list: Sample[], s: Sample) => {
    list.push(s);
    while (list.length > 2 && s.t - list[0].t > 250) list.shift();
  };
  const grabMove = (d: Extract<Drag, { kind: 'grab' }>, pts: Sample[]) => {
    let q: Quaternion | undefined;
    for (const s of pts) { q = s.q = grabRotation(d, s.x, s.y); keepSample(d.samples, s); }
    if (!q) return;
    const pose: Pose = { p: Cartesian3.clone(d.base.p), d: Cartesian3.clone(d.base.d), u: Cartesian3.clone(d.base.u) };
    rotatePose(q, pose);
    apply(pose);
  };
  const grabRelease = (d: Extract<Drag, { kind: 'grab' }>, tUp: number) => {
    stopCoast();
    if (!d.moved || reducedMotion()) return;
    const ref = Quaternion.conjugate(d.samples[d.samples.length - 1]?.q ?? Quaternion.IDENTITY, new Quaternion());
    const rel = new Quaternion();
    const v = releaseSpeed(d.samples, tUp, s => rotVec(Quaternion.multiply(s.q!, ref, rel)));
    if (!v) return; // the hand had come to rest: no coasting
    const w = Math.hypot(v[0], v[1], v[2]);
    const p = cur().p, radPerPx = radPerPxAt(p);
    if (w < 1e-9 || w / radPerPx < FLING_MIN_PX_S) return;
    // the Moon carries on at (almost) the speed it had under the hand; fast flicks bend softly towards the cap
    // (so a quicker flick still goes a little further, but never spins the globe madly)
    const cap = Math.min(FLING_MAX_RAD_S, FLING_MAX_SCREENS_S * frustum().H * radPerPx);
    const rate = cap * Math.tanh((FLING_GAIN * w) / cap);
    Cartesian3.fromElements(v[0], v[1], v[2], spin);
    Cartesian3.multiplyByScalar(spin, rate / w, spin);
    spinTau = FLING_TAU_NEAR + (FLING_TAU_FAR - FLING_TAU_NEAR) * smooth01((Cartesian3.magnitude(p) / MOON_R - 1.05) / 0.9);
    kick();
  };
  const turnRelease = (d: Extract<Drag, { kind: 'turn' }>, tUp: number) => {
    stopCoast();
    if (!d.moved || reducedMotion()) return;
    const v = releaseSpeed(d.samples, tUp, s => [s.x, s.y]);
    if (!v) return;
    const sp = Math.hypot(v[0], v[1]);
    if (sp < FLING_MIN_PX_S) return;
    const k = Math.min(1, TURN_MAX_PX_S / sp) * FLING_GAIN;
    turnCoast = { pivot: d.pivot, vx: v[0] * k, vy: v[1] * k };
    kick();
  };
  /** The positions a pointer event carries: every coalesced in-between position (with its own time), else the event itself. */
  const eventPoints = (e: PointerEvent): Sample[] => {
    const r = canvas.getBoundingClientRect();
    const list = e.getCoalescedEvents?.() ?? [];
    return (list.length ? list : [e]).map(ev => ({ t: ev.timeStamp || performance.now(), x: ev.clientX - r.left, y: ev.clientY - r.top }));
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!enabled) return;
    const { x, y } = local(e);
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = 0; } // second press: this is a double-click, not a click
    stopMotion();
    canvas.setPointerCapture?.(e.pointerId);
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x, y });
      if (touches.size === 2) {
        drag = null;
        const [a, b] = [...touches.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), angle: Math.atan2(b.y - a.y, b.x - a.x) };
        return;
      }
    }
    const turning = e.button === 2 || e.button === 1 || (e.button === 0 && (e.ctrlKey || e.metaKey || e.shiftKey));
    if (e.button === 2) {
      const now = performance.now();
      if (now - lastRightDown.t < 380 && Math.hypot(x - lastRightDown.x, y - lastRightDown.y) < 8) { // right double-click: zoom out
        zoomAnchor = null; aimZoom(x, y); zoomTau = ZOOM_TAU_DOUBLE; pendingZoom += Math.log(3); pulse(x, y); kick();
        lastRightDown.t = 0; return;
      }
      lastRightDown = { t: now, x, y };
    }
    if (turning) {
      const pivot = pickGround(x, y) ?? centre();
      if (!pivot) return;
      drag = { kind: 'turn', id: e.pointerId, x0: x, y0: y, t0: performance.now(), pivot, lastX: x, lastY: y, moved: false, samples: [] };
      setCursor('grabbing');
    } else if (e.button === 0) {
      startGrab(e, x, y);
      setCursor('grabbing');
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!enabled) return;
    const { x, y } = local(e);
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x, y });
      if (touches.size === 2 && pinch) {
        const [a, b] = [...touches.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y), angle = Math.atan2(b.y - a.y, b.x - a.x);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        zoomAnchor = null; aimZoom(mx, my);
        if (dist > 0 && pinch.dist > 0) zoomStep(Math.log(pinch.dist / dist));
        let da = angle - pinch.angle; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
        const pivot = pickGround(mx, my);
        if (pivot && Math.abs(da) > 1e-4) turnAbout(pivot, da, 0);
        pinch = { dist, angle };
        return;
      }
    }
    if (drag && drag.id === e.pointerId) {
      if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) > CLICK_SLOP_PX) drag.moved = true;
      if (!drag.moved) return;
      const pts = eventPoints(e);
      if (drag.kind === 'grab') { grabMove(drag, pts); showRing(x, y); }
      else { for (const s of pts) keepSample(drag.samples, s); turnAbout(drag.pivot, -(x - drag.lastX) * TURN_RAD_PER_PX, -(y - drag.lastY) * TURN_RAD_PER_PX); drag.lastX = x; drag.lastY = y; showRing(drag.x0, drag.y0); }
      return;
    }
    if (e.buttons === 0 && e.pointerType !== 'touch') {
      hoverX = x; hoverY = y;
      if (!hoverRaf) hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        if (!enabled || drag) return;
        setCursor(opts.isClickableAt?.(hoverX, hoverY) ? 'pointer' : '');
        opts.onHoverMove?.(hoverX, hoverY);
      });
    }
  };
  const onPointerUp = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    if (!drag || drag.id !== e.pointerId) return;
    const d = drag; drag = null;
    canvas.releasePointerCapture?.(e.pointerId);
    if (!enabled) return;
    const { x, y } = local(e);
    hideRing();
    setCursor(opts.isClickableAt?.(x, y) ? 'pointer' : '');
    const tUp = e.timeStamp || performance.now();
    if (d.kind === 'turn') { if (e.type === 'pointerup') turnRelease(d, tUp); }
    else {
      if (d.moved) { if (e.type === 'pointerup') grabRelease(d, tUp); }
      else if (e.type === 'pointerup' && e.button === 0 && performance.now() - d.t0 < 600 && opts.onClick) {
        // wait a moment: if a second click follows it was a double-click (zoom), not a click
        clickTimer = window.setTimeout(() => { clickTimer = 0; if (enabled) opts.onClick!(d.x0, d.y0); }, DOUBLE_CLICK_MS);
      }
    }
  };
  const onDblClick = (e: MouseEvent) => {
    if (!enabled) return;
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = 0; }
    const { x, y } = local(e);
    stopMotion();
    zoomAnchor = null; aimZoom(x, y);
    zoomTau = ZOOM_TAU_DOUBLE;
    pendingZoom += e.shiftKey ? Math.log(3) : -Math.log(3);
    pulse(x, y);
    kick();
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    if (!enabled) { opts.onFovWheel?.(px); return; }
    endFlight(false);
    stopCoast();
    const { x, y } = local(e);
    aimZoom(x, y);
    // ctrlKey = trackpad pinch (Chrome/Safari). A mouse wheel sends big whole steps (about 100 px a notch);
    // a trackpad sends many small, often fractional steps, and keeps sending them for a while after the fingers lift.
    const notch = e.deltaMode !== 0 || (!e.ctrlKey && e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40);
    const k = e.ctrlKey ? 0.008 : notch ? 0.0028 : 0.0011; // a notch is about ×1.3, a gentle trackpad swipe about ×1.8
    zoomTau = notch ? ZOOM_TAU_WHEEL : ZOOM_TAU_TRACKPAD;
    pendingZoom = CMath.clamp(pendingZoom + px * k, -2.2, 2.2);
    kick();
  };
  const KEY_ACTION: Record<string, string> = { ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown' };
  const SHIFT_ACTION: Record<string, string> = { ArrowLeft: 'TurnLeft', ArrowRight: 'TurnRight', ArrowUp: 'TiltUp', ArrowDown: 'TiltDown' };
  const typing = () => { const a = document.activeElement as HTMLElement | null; return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable); };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!enabled || typing()) return;
    stopCoast(); // any key stops a coast at once
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const act = e.shiftKey ? SHIFT_ACTION[e.key] : KEY_ACTION[e.key];
    if (act) { e.preventDefault(); endFlight(false); held.add(act); kick(); return; }
    if (e.key === '+' || e.key === '=') { nav.zoomBy(0.6); e.preventDefault(); }
    else if (e.key === '-' || e.key === '_') { nav.zoomBy(-0.6); e.preventDefault(); }
    else if (e.key === 'n' || e.key === 'N') nav.resetNorth();
    else if (e.key === 'u' || e.key === 'U') nav.setTilt(-90);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (KEY_ACTION[e.key]) { held.delete(KEY_ACTION[e.key]); held.delete(SHIFT_ACTION[e.key]); }
    if (e.key === 'Shift') for (const k of Object.values(SHIFT_ACTION)) held.delete(k);
  };
  const onBlur = () => held.clear();
  const noMenu = (e: Event) => e.preventDefault();
  const stopGesture = (e: Event) => e.preventDefault(); // Safari page pinch-zoom over the map

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', noMenu);
  canvas.addEventListener('gesturestart', stopGesture);
  canvas.addEventListener('gesturechange', stopGesture);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  setCursor('');

  const nav: Navigation = {
    get enabled() { return enabled; },
    set enabled(v: boolean) {
      if (enabled === v) return;
      enabled = v;
      drag = null; held.clear(); touches.clear(); pinch = null;
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = 0; }
      stopCoast(); pendingZoom = 0;
      hideRing();
      if (v) { cursor = '-'; setCursor(''); } else { endFlight(false); cursor = '-'; }
    },
    get interacting() { return !!drag || !!flight || Cartesian3.magnitude(spin) > 0 || !!turnCoast || Math.abs(pendingZoom) > 1e-4 || held.size > 0; },
    zoomBy(logFactor, anchor) {
      endFlight(false);
      zoomAnchor = null;
      aimZoom(anchor?.x ?? canvas.clientWidth / 2, anchor?.y ?? canvas.clientHeight / 2);
      zoomTau = ZOOM_TAU_WHEEL;
      pendingZoom = CMath.clamp(pendingZoom - logFactor, -4, 4);
      kick();
    },
    resetNorth() { reorient(0, null); },
    setTilt(pitchDeg) { reorient(null, CMath.clamp(pitchDeg, -90, -5)); },
    flyTo(pose, o) { return startFlight({ p: Cartesian3.clone(pose.destination), d: Cartesian3.clone(pose.direction), u: Cartesian3.clone(pose.up) }, o?.duration); },
    showBody(dir) {
      const pose = cur();
      const dist = Math.max(Cartesian3.magnitude(pose.p), MOON_R + 2000);
      const b = Cartesian3.normalize(dir, new Cartesian3());
      const r0 = Cartesian3.normalize(pose.p, new Cartesian3());
      // a direction at right angles to the body, on the side where the camera already is (so the flight is short)
      const w = Cartesian3.subtract(r0, Cartesian3.multiplyByScalar(b, Cartesian3.dot(r0, b), new Cartesian3()), new Cartesian3());
      if (Cartesian3.magnitude(w) < 1e-6) Cartesian3.cross(b, Math.abs(b.y) < 0.9 ? Cartesian3.UNIT_Y : Cartesian3.UNIT_X, w);
      Cartesian3.normalize(w, w);
      const alpha = Math.asin(Math.min(1, MOON_R / dist));        // the Moon's radius as seen from here
      const theta = Math.min(Math.PI - 0.05, alpha + 9 * CMath.RADIANS_PER_DEGREE); // body this far from the Moon's centre
      // camera on the side away from the body, so the body peeks over the Moon's edge
      const c = Cartesian3.add(Cartesian3.multiplyByScalar(b, Math.cos(Math.PI - theta), new Cartesian3()), Cartesian3.multiplyByScalar(w, Math.sin(Math.PI - theta), new Cartesian3()), new Cartesian3());
      Cartesian3.normalize(c, c);
      const toCentre = Cartesian3.negate(c, new Cartesian3());
      const f = frustum();
      const halfV = Math.atan(f.tanY);
      const a = Math.min(0.45 * theta, 0.55 * halfV);            // the body sits this far above the middle of the screen
      const perp = Cartesian3.subtract(toCentre, Cartesian3.multiplyByScalar(b, Cartesian3.dot(toCentre, b), new Cartesian3()), new Cartesian3());
      Cartesian3.normalize(perp, perp);
      const d = Cartesian3.normalize(Cartesian3.add(Cartesian3.multiplyByScalar(b, Math.cos(a), new Cartesian3()), Cartesian3.multiplyByScalar(perp, Math.sin(a), new Cartesian3()), new Cartesian3()), new Cartesian3());
      // level horizon: "up" points away from the Moon
      const u = Cartesian3.subtract(c, Cartesian3.multiplyByScalar(d, Cartesian3.dot(c, d), new Cartesian3()), new Cartesian3());
      Cartesian3.normalize(u, u);
      return startFlight({ p: Cartesian3.multiplyByScalar(c, dist, new Cartesian3()), d, u }, undefined);
    },
    cancel() { stopMotion(); },
    destroy() {
      destroyed = true;
      stopMotion();
      ring.remove();
      if (raf) cancelAnimationFrame(raf);
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      if (clickTimer) clearTimeout(clickTimer);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', noMenu);
      canvas.removeEventListener('gesturestart', stopGesture);
      canvas.removeEventListener('gesturechange', stopGesture);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },
  };
  return nav;
}
