// Walking (no longer used) and driving the rover on the Moon in "Stand here" (see lander.ts, which owns the camera and the ground shader).
//
// The walker is a point on the DRAWN ground (the same triangles you see, read the way the rocks are
// seated), with the eyes 1.7 m above it. Every frame we move it along the ground in the direction you
// face, then put it back on the drawn ground, so it can never end up inside a hill or under the surface:
//   - slopes steeper than 35 degrees cannot be climbed (the uphill part of your step is taken away and you
//     slide gently back down), as on loose lunar soil;
//   - rocks taller than a boot step are solid (circle collision);
//   - you get going softly (about half a second to full speed) and glide a little before you stop (about
//     0.7 s), because in one-sixth gravity your boots grip the dust far less than on Earth;
//   - Space is a low-gravity hop (1.62 m/s^2: take-off 1.7 m/s, about 0.9 m high and 2.1 s in the air, like
//     the Apollo crews' bunny hops); you keep your forward speed in the air, the camera dips softly when you
//     land, and holding Space keeps hopping;
//   - the head bob is a slow lope (lower and longer than on Earth) with a touch of roll, and none in the air;
//   - the eye height is smoothed so the steps over the ground's triangles don't jitter, but it never sinks
//     below 1.2 m above the ground under you.
// Directions are measured in a frame that keeps the LANDER's north (projected onto the ground where you are),
// so compass readings, the Sun and Earth marks and the view all stay consistent while you walk.

import { Cartesian3 } from 'cesium';
import { BODY_CELLS, BODY_REACH, rockRadiusAt, rockTopAt } from './robotBody';

export const WALK = {
  /** eye height above the ground (m) */
  eye: 1.7,
  /** walking and running speed (m/s); the Apollo crews managed about 1 m/s walking, 2-3 m/s loping */
  speed: 1.3, run: 3,
  /** how quickly you reach speed and how long you glide before stopping (time constants, s) */
  accelS: 0.17, stopS: 0.24,
  /** length of one step (m) when walking and when loping */
  stepM: 0.8, runStepM: 1.5,
  /** steepest slope you can walk up (degrees) */
  maxSlopeDeg: 35,
  /** lunar gravity (m/s^2) and the hop's take-off speed (m/s: v^2 / 2g = 0.89 m high, 2v / g = 2.1 s in the air) */
  g: 1.62, hopV: 1.7,
  /** your body's radius for bumping into rocks, and the highest rock you just step over (m) */
  bodyR: 0.32, stepOver: 0.22,
  /** the eye never comes closer to the ground under it than this (m) */
  minEye: 1.2,
} as const;

const R = 1737400;
const MAX_TAN = Math.tan(WALK.maxSlopeDeg * Math.PI / 180);

export interface WalkInput {
  /** forward (+1) / back (-1) and right (+1) / left (-1) */
  fwd: number; side: number;
  run: boolean;
  /** true on the frame the hop key goes down */
  hop: boolean;
  /** the hop key is held: hop again as soon as you land */
  hopHeld?: boolean;
}

/** A rock (or one circle of a long rock's outline): p its middle on the ground it lies on, r its radius there, h its height (m). */
export interface WalkObstacle { p: Cartesian3; r: number; h: number; /** how rounded its top is (2 = a dome, 3 = a block; see robotBody.ts) */ pow?: number }

export interface WalkEnv {
  /** height of the ground (m above the 1,737.4 km sphere) under a world position, as drawn */
  ground(p: Cartesian3): number;
  /** rocks near you: centre of the base (world), horizontal radius and height (m) */
  obstacles(): readonly WalkObstacle[];
}

const s1 = new Cartesian3(), s2 = new Cartesian3(), s3 = new Cartesian3(), s4 = new Cartesian3();

export class Walker {
  /** ground point under you, your eye, and the local frame (east / north / up) there, all in world coordinates */
  readonly feet = new Cartesian3();
  readonly eye = new Cartesian3();
  readonly east = new Cartesian3();
  readonly north = new Cartesian3();
  readonly up = new Cartesian3();
  /** horizontal velocity (world, m/s) */
  readonly vel = new Cartesian3();
  /** height above the ground while hopping (m) and vertical speed (m/s) */
  air = 0;
  vz = 0;
  /** walk cycle (radians) and how much of it shows (0 standing .. 1 walking), for the head bob and the hands */
  bobPhase = 0;
  bobAmount = 0;
  /** how much of the walk is a run (0..1), for a longer, bouncier lope */
  runAmount = 0;
  /** the soft dip of the camera after landing (m, negative = down) and its speed */
  dip = 0;
  dipV = 0;
  /** a touch of head roll from the gait (radians, + = right side down) */
  roll = 0;
  /** blocked by a slope or a rock on the last step (for the HUD) */
  blocked: '' | 'slope' | 'rock' = '';
  private eyeH = 0;
  private groundH = 0;
  private north0 = new Cartesian3(0, 0, 1);
  private origin = new Cartesian3();

  /** Start walking with your feet on the ground at `feet` (world). `north0` is the lander's north. */
  reset(feet: Cartesian3, north0: Cartesian3, env: WalkEnv, eyeAbove: number = WALK.eye) {
    Cartesian3.clone(north0, this.north0);
    const g = env.ground(feet);
    this.place(feet, g);
    Cartesian3.clone(this.feet, this.origin);
    Cartesian3.clone(Cartesian3.ZERO, this.vel);
    this.air = 0; this.vz = 0; this.bobAmount = 0; this.runAmount = 0; this.dip = 0; this.dipV = 0; this.roll = 0;
    this.eyeH = g + eyeAbove;
    this.setEye(0);
  }

  /** Straight-line distance over the ground from where walking started (m). */
  distanceFromStart(): number {
    return Cartesian3.distance(this.feet, this.origin);
  }

  get onGround(): boolean { return this.air <= 0 && this.vz <= 0; }

  /**
   * Advance by dt seconds. `azDeg` is the direction the camera faces (degrees from north, in this frame).
   * Returns true while anything is still moving (walking, sliding, hopping or the eye settling).
   */
  step(dt: number, azDeg: number, input: WalkInput, env: WalkEnv): boolean {
    const U = this.up, E = this.east, N = this.north;
    // the ground under you may have changed since the last frame (finer map tiles arrive): stand on it now
    this.groundH = env.ground(this.feet);
    const a = azDeg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    // what you ask for: forward is the camera's heading, flattened onto the ground
    let fx = input.fwd * ca + input.side * -sa, fy = input.fwd * sa + input.side * ca; // (north, east) components
    const len = Math.hypot(fx, fy);
    const speed = input.run ? WALK.run : WALK.speed;
    if (len > 1e-6) { fx *= speed / len; fy *= speed / len; }
    const wish = Cartesian3.fromElements(N.x * fx + E.x * fy, N.y * fx + E.y * fy, N.z * fx + E.z * fy, s1);
    // on the ground: a soft start and a long glide to a stop; in the air you keep going (only a little steering)
    const slowing = Cartesian3.magnitude(wish) < Cartesian3.magnitude(this.vel) - 0.05;
    const k = 1 - Math.exp(-dt / (this.onGround ? (slowing ? WALK.stopS : WALK.accelS) : 3.0));
    Cartesian3.add(this.vel, Cartesian3.multiplyByScalar(Cartesian3.subtract(wish, this.vel, s2), k, s2), this.vel);

    // the slope under you (from the drawn ground half a metre either side)
    const probe = (de: number, dn: number) => env.ground(Cartesian3.add(this.feet, Cartesian3.add(Cartesian3.multiplyByScalar(E, de, s3), Cartesian3.multiplyByScalar(N, dn, s4), s4), s4));
    const gE = (probe(0.5, 0) - probe(-0.5, 0)), gN = (probe(0, 0.5) - probe(0, -0.5));
    const slope = Math.hypot(gE, gN);
    this.blocked = '';
    if (this.onGround && slope > MAX_TAN) {
      // too steep: no walking uphill, and you slowly slide down
      const ue = gE / slope, un = gN / slope;
      const upward = Cartesian3.dot(this.vel, E) * ue + Cartesian3.dot(this.vel, N) * un;
      const slide = WALK.g * Math.min(1, slope - MAX_TAN) * dt * 3;
      const remove = Math.max(0, upward) + slide;
      Cartesian3.subtract(this.vel, Cartesian3.fromElements(
        (E.x * ue + N.x * un) * remove, (E.y * ue + N.y * un) * remove, (E.z * ue + N.z * un) * remove, s2), this.vel);
      if (upward > 0.05) this.blocked = 'slope';
    }
    // keep the velocity flat on the ground plane
    Cartesian3.subtract(this.vel, Cartesian3.multiplyByScalar(U, Cartesian3.dot(this.vel, U), s2), this.vel);

    // the step, checked against what is ahead: a single step may not climb steeper than the limit either
    const next = Cartesian3.add(this.feet, Cartesian3.multiplyByScalar(this.vel, dt, s2), new Cartesian3());
    let gNext = env.ground(next);
    const stepLen = Cartesian3.magnitude(this.vel) * dt;
    // (a jump of more than a metre within one small step is the map getting finer there, not a cliff: allowed)
    const rise = gNext - this.groundH;
    if (this.onGround && stepLen > 1e-4 && rise > MAX_TAN * stepLen + 0.01 && rise < 1) {
      // too steep ahead: keep only the part of the step that runs along the slope (you slide along it, no dead stop)
      const gl = Math.hypot(gE, gN);
      if (gl > 1e-6) {
        const ue = gE / gl, un = gN / gl;
        const upward = Cartesian3.dot(this.vel, E) * ue + Cartesian3.dot(this.vel, N) * un;
        if (upward > 0) Cartesian3.subtract(this.vel, Cartesian3.fromElements((E.x * ue + N.x * un) * upward, (E.y * ue + N.y * un) * upward, (E.z * ue + N.z * un) * upward, s2), this.vel);
      }
      Cartesian3.add(this.feet, Cartesian3.multiplyByScalar(this.vel, dt, s2), next);
      gNext = env.ground(next);
      if (gNext - this.groundH > MAX_TAN * Cartesian3.magnitude(this.vel) * dt + 0.01 && gNext - this.groundH < 1) {
        Cartesian3.clone(this.feet, next);
        gNext = this.groundH;
        Cartesian3.multiplyByScalar(this.vel, 0.5, this.vel);
      }
      this.blocked = 'slope';
    }
    // rocks: solid if taller than a boot step
    for (const o of env.obstacles()) {
      if (o.h <= WALK.stepOver + this.air) continue;
      const d = Cartesian3.subtract(next, o.p, s3);
      Cartesian3.subtract(d, Cartesian3.multiplyByScalar(U, Cartesian3.dot(d, U), s4), d);
      const dist = Cartesian3.magnitude(d), min = o.r + WALK.bodyR;
      if (dist >= min) continue;
      const push = dist > 1e-4 ? Cartesian3.multiplyByScalar(d, (min - dist) / dist, s4) : Cartesian3.multiplyByScalar(E, min, s4);
      Cartesian3.add(next, push, next);
      // stop moving into the rock
      if (dist > 1e-4) {
        const nrm = Cartesian3.normalize(d, s3), into = Cartesian3.dot(this.vel, nrm);
        if (into < 0) Cartesian3.subtract(this.vel, Cartesian3.multiplyByScalar(nrm, into, s4), this.vel);
      }
      gNext = env.ground(next);
      this.blocked = 'rock';
    }

    // up and down: hop, fly, land
    if ((input.hop || input.hopHeld) && this.onGround && this.dip > -0.02) { this.vz = WALK.hopV; this.air = 1e-3; }
    if (this.air > 0 || this.vz > 0) {
      // exact for constant gravity, so the hop is the same height at any frame rate
      this.air += this.vz * dt - 0.5 * WALK.g * dt * dt;
      this.vz -= WALK.g * dt;
      if (this.air <= 0) {
        // touch-down: the knees take it (a soft, critically damped dip of a few centimetres)
        this.dipV = Math.min(this.dipV, -0.9 * Math.abs(this.vz));
        this.air = 0; this.vz = 0;
      }
    }
    // the landing dip settles like a spring with just enough damping not to bounce
    const W = 9;
    this.dipV += (-W * W * this.dip - 2 * W * this.dipV) * Math.min(dt, 0.05);
    this.dip += this.dipV * Math.min(dt, 0.05);
    if (Math.abs(this.dip) < 1e-4 && Math.abs(this.dipV) < 1e-3) this.dip = this.dipV = 0;
    this.place(next, gNext);

    // walk cycle: a slow lope, one step every 0.8 m walking and 1.5 m running; it pauses in the air
    const v = Cartesian3.magnitude(this.vel);
    this.runAmount += ((input.run && v > WALK.speed * 0.8 ? 1 : 0) - this.runAmount) * (1 - Math.exp(-dt / 0.4));
    const stepM = WALK.stepM + (WALK.runStepM - WALK.stepM) * this.runAmount;
    if (this.onGround) this.bobPhase = (this.bobPhase + (v * dt / stepM) * Math.PI) % (2 * Math.PI * 1000);
    const bobWant = this.onGround ? Math.min(1, v / WALK.speed) : 0;
    this.bobAmount += (bobWant - this.bobAmount) * (1 - Math.exp(-dt / 0.25));
    this.roll = 0.006 * this.bobAmount * (1 + this.runAmount) * Math.sin(this.bobPhase);
    const settling = this.setEye(dt);
    return v > 0.02 || this.air > 0 || this.vz !== 0 || settling || this.bobAmount > 0.01 || this.dip !== 0;
  }

  /** Put the feet on the ground at the direction of `p`, and update the local frame there. */
  private place(p: Cartesian3, groundH: number) {
    this.groundH = groundH;
    Cartesian3.normalize(p, this.up);
    Cartesian3.multiplyByScalar(this.up, R + groundH, this.feet);
    const U = this.up, n = this.north0;
    Cartesian3.normalize(Cartesian3.subtract(n, Cartesian3.multiplyByScalar(U, Cartesian3.dot(n, U), s3), s3), this.north);
    Cartesian3.cross(this.north, U, this.east);
  }

  /** Eyes 1.7 m above the ground (plus the hop), smoothed, never below 1.2 m above it. Returns true while settling. */
  private setEye(dt: number): boolean {
    const want = this.groundH + this.air + WALK.eye;
    // (in the air the hop itself is the motion: following it exactly keeps the landing crisp, the dip softens it)
    if (dt <= 0 || this.air > 0) this.eyeH = want;
    else this.eyeH += (want - this.eyeH) * (1 - Math.exp(-dt / (want > this.eyeH ? 0.06 : 0.12)));
    this.eyeH = Math.max(this.eyeH, this.groundH + WALK.minEye);
    // a slow head bob while walking: up and down once per step (smooth at the bottom), bigger when loping
    const bob = (0.028 + 0.03 * this.runAmount) * this.bobAmount * 0.5 * (1 - Math.cos(2 * this.bobPhase));
    Cartesian3.multiplyByScalar(this.up, R + this.eyeH + bob + this.dip, this.eye);
    return Math.abs(want - this.eyeH) > 0.005;
  }
}

// ---------------------------------------------------------------------------------------------
// Driving MOONDA, our rover (see lander.ts for the model and the cameras, robotFx.ts for wheels, dust, panel).
//
// A small rigid body on six sprung wheels, in one-sixth gravity (1.62 m/s^2). W / S drive, A / D steer (it can
// turn on the spot, like a skid-steer rover), Shift is fast:
//   - each wheel reads the DRAWN ground under it (plus the small rocks it rolls over) and pushes the body up
//     with its own spring and damper; the body's height, pitch and roll come out of those six pushes, so it
//     rocks, overshoots a little when it stops or lands, and every wheel moves up and down within its travel
//     so it sits on the ground: never in it (the body is lifted first), and floating only when the wheel is
//     at the end of its travel (off a ledge, or in the air);
//   - grip is a sixth of Earth's: the wheels can push, brake or turn the body only so hard (GRIP x 1.62 m/s^2),
//     so it takes longer to stop, slides wider in fast turns and gets light over crests, where it leaves the
//     ground for a long, slow hop and lands softly on its springs;
//   - gravity is real along the slope (1.62 m/s^2 x the sine of the slope under the six wheels): downhill it runs
//     faster than on the flat (the motors only brake gently), uphill it is slower, and with the keys released it
//     rolls on down anything steeper than about 9 degrees until you brake (S) or the ground levels out. Parked
//     (not driving) its geared wheels hold it. Slopes steeper than 25 degrees cannot be climbed (the wheels spin
//     in the dust and it slides back); on ground too steep for the tyres to hold it slides;
//   - rocks: its real outline (robotBody.ts: the six wheels, their legs and the body, from the model) meets each
//     rock's real outline (rockOutline.ts, measured from the scanned stones). A rock up to three quarters of a
//     wheel high is driven over: the wheel that meets it rides up and the body rocks. Only a bigger one stops the
//     part that touches it: that corner loses its speed into the rock (no bounce), the robot slides along the rock
//     with a little friction and turns a little about the touching point. A contact never adds speed, and the body
//     dips forward on its springs when it stops hard;
//   - the soil: the tyres sink 1-2 cm into the dust (more while they slip), the wheels slip a little pulling away
//     and climbing, the ground's bumps nudge the steering at speed.
// Directions are measured in a frame that keeps the LANDER's north (projected onto the ground where it is).

/**
 * How big MOONDA the robot is against NASA's Perseverance model (3 m long at 1): 0.5 makes a small robot about
 * 1.5 m long with its camera about 1 m up. Every size (model, shadow, wheels, camera, lights, parking) follows
 * this one number; lander.ts reads it as ROBOT_SCALE / ROVER.scale. Speeds stay in real metres per second.
 */
export const ROBOT_SCALE = 0.5;
const S = ROBOT_SCALE;
const G = 1.62;

/**
 * The six wheels in the model (model metres, from data-prep/rover/split-wheels.mjs): node name, left (+) / right
 * (model +X is the rover's LEFT), forward (+Z), the axle height and the wheel radius.
 */
export const WHEELS: readonly { name: string; x: number; z: number }[] = [
  { name: 'wheel_LF', x: 1.0624, z: 1.095 }, { name: 'wheel_LM', x: 1.1845, z: -0.09 }, { name: 'wheel_LB', x: 1.0624, z: -1.165 },
  { name: 'wheel_RF', x: -1.0624, z: 1.095 }, { name: 'wheel_RM', x: -1.1845, z: -0.09 }, { name: 'wheel_RB', x: -1.0624, z: -1.165 },
];
export const WHEEL_AXLE_Y = 0.2636, WHEEL_R = 0.2627;

export const DRIVE = {
  scale: S,
  /** cruising and fast speed (m/s) */
  speed: 2, fast: 5,
  /** how quickly the speed follows the keys when grip allows (s); strongest push of the motors (m/s^2) */
  accelS: 0.55, motor: 1.5,
  /** wheel grip on the dust as a share of the weight (on Earth tyres manage about 1; loose regolith is less): it holds to about 40 degrees */
  grip: 0.85,
  /** losses in the soil, always against the motion: a share of the weight (rolling resistance) plus this much per m/s */
  rollRes: 0.1, rollDragV: 0.2,
  /** keys released while driving: the geared motors hold back only this hard (m/s^2), so it rolls on down slopes
   *  steeper than about 9 degrees; going faster than asked (downhill) they brake this hard at most, this softly (s) */
  hold: 0.08, engineBrake: 0.45, overS: 2,
  /** it never goes faster than this, however long the slope (m/s) */
  vMax: 7,
  /** turning rate standing still / at full speed (degrees per second), and how quickly the turn starts and stops (s) */
  turnDeg: 55, turnDegFast: 30, turnS: 0.22,
  /** steepest slope it can climb (degrees); the top speed falls by this share at that slope */
  maxSlopeDeg: 25, climbLoss: 0.35,
  /** the body's springs: how far each wheel sinks the body at rest (sag), how far it can hang down and be pushed up (m); damping ratio */
  sag: 0.045, drop: 0.085, travelUp: 0.075, damp: 0.32,
  /** height of the body's centre of mass above the wheels' contact (m), and its turning inertia (radius of gyration, m) */
  cgH: 0.42 * S, gyrPitch: 0.95 * S, gyrRoll: 0.85 * S,
  /** the tallest rock it drives over (m): three quarters of a wheel's height, as a rocker-bogie rover manages;
   *  anything taller stops the part that touches it */
  climb: 1.5 * WHEEL_R * S,
  /** rock contact: friction along the rock, how much harder the robot is to turn than a free body (its wheels
   *  hold it) and the most one touch turns it (deg/s), the body's nose-down pitch per m/s lost (rad/s) and its largest kick (rad/s) */
  rockFriction: 0.3, rockTurnHold: 10, rockTurnMax: 25, rockPitch: 0.12, rockPitchMax: 0.35,
  /** soil: how deep the tyres sink at rest and how much deeper while slipping (m); the slip pulling away (share
   *  of the push), how much the ground's bumps steer it at speed (deg/s per m/s of bump rate) */
  sink: 0.012, sinkSlip: 0.012, takeoffSlip: 0.25, bumpSteer: 2.5,
} as const;

const MAX_DRIVE_SIN = Math.sin(DRIVE.maxSlopeDeg * Math.PI / 180);
const OMEGA2 = G / DRIVE.sag; // the springs' stiffness per unit mass (rad^2/s^2): about 0.95 Hz bounce

export interface DriveInput {
  /** forward (+1) / back (-1), and steering right (+1) / left (-1) */
  fwd: number; turn: number;
  fast: boolean;
  /** not being driven: the brakes are on, it stays where it is (up to what the tyres can hold) */
  parked?: boolean;
}

const d1 = new Cartesian3(), d2 = new Cartesian3(), d3 = new Cartesian3(), d4 = new Cartesian3();
/** where each wheel touches, in the body's flat frame (m): forward, right */
const WF = WHEELS.map(w => w.z * S), WR = WHEELS.map(w => -w.x * S);
const SUM_R2 = WR.reduce((a, r) => a + r * r, 0);
const MEAN_F = WF.reduce((a, f) => a + f, 0) / 6;
const SUM_F2C = WF.reduce((a, f) => a + (f - MEAN_F) ** 2, 0);

export class Driver {
  /** the ground point under the middle of the rover, and the flat local frame there (world) */
  readonly feet = new Cartesian3();
  readonly east = new Cartesian3();
  readonly north = new Cartesian3();
  readonly up = new Cartesian3();
  /** the body's own frame (world): forward, right and up, tilted with the ground under the wheels */
  readonly fwd = new Cartesian3();
  readonly right = new Cartesian3();
  readonly bodyUp = new Cartesian3();
  /** heading (degrees from north, in the flat frame), speed along it (m/s, negative = backwards), turning rate (deg/s) */
  heading = 0;
  speed = 0;
  yawRate = 0;
  /** sideways sliding speed (m/s, + = to the right) */
  slide = 0;
  /** how much the heading changed in the last step (degrees), so the cameras can turn with the rover */
  turned = 0;
  /** what stopped it on the last step (for the HUD) */
  blocked: '' | 'slope' | 'rock' = '';
  /** total distance driven (m, for the wheels and the sound) */
  odometer = 0;
  /** each wheel: its turn about its axle (rad, + = rolling forward), surface speed (m/s), how far it is pushed up
   *  from its rest place (m, negative = hanging down), whether it touches the ground, the ground height there */
  readonly wheelSpin = new Float64Array(6);
  readonly wheelSpeed = new Float64Array(6);
  readonly wheelLift = new Float64Array(6);
  readonly wheelOn = new Uint8Array(6);
  readonly wheelGround = new Float64Array(6);
  /** seconds in the air (0 on the ground); on the step it lands, the speed it came down at (m/s), else 0 */
  air = 0;
  landed = 0;
  /** how hard the wheels are slipping (m/s: spinning in the dust, sliding sideways, braking on the limit) */
  slip = 0;
  /** on the step it touched a rock: the speed it lost into it (m/s), else 0 (for the bump sound) */
  impact = 0;
  /** a rock is holding it back right now (the wheels turn on the spot in the dust) */
  pressing = false;
  /** the last rock touch: speed just before and just after it (m/s; for tests: after is never more) */
  contactBefore = 0;
  contactAfter = 0;
  /** ... and the angle between the way it moved and the rock's face there (deg: 90 = head-on, 0 = brushing along) */
  contactAngle = 0;
  /** how deep the tyres are pressed into the dust (m) */
  sink = DRIVE.sink;
  /** the body's vertical speed (m/s) and its pitch / roll (rad, nose up / right side up) */
  vUp = 0;
  pitch = 0;
  roll = 0;
  private bodyH = 0;
  private vp = 0;
  private vr = 0;
  /** the slope of the ground itself under the six wheels (tangents: + = rising ahead / to the right), no rocks, no springs */
  gTanF = 0;
  gTanS = 0;
  /** how long a rock has really been holding it (s): the HUD only says so after a moment */
  private rockHold = 0;
  private restless = false;
  private wheelTerrain = new Float64Array(6);
  private comp = new Float64Array(6);
  private prevGround = new Float64Array(6);
  private gRate = new Float64Array(6);
  private north0 = new Cartesian3(0, 0, 1);
  private origin = new Cartesian3();
  private F0 = new Cartesian3();
  private R0 = new Cartesian3();
  private nextP = new Cartesian3();

  /** Park the rover at `p` (world) facing `headingDeg`; `north0` is the lander's north. */
  reset(p: Cartesian3, north0: Cartesian3, headingDeg: number, env: WalkEnv, origin?: Cartesian3) {
    Cartesian3.clone(north0, this.north0);
    this.heading = headingDeg;
    this.speed = 0; this.yawRate = 0; this.turned = 0; this.blocked = ''; this.slide = 0;
    this.air = 0; this.landed = 0; this.slip = 0; this.vUp = 0; this.vp = 0; this.vr = 0;
    this.impact = 0; this.pressing = false; this.sink = DRIVE.sink; this.rockHold = 0;
    this.wheelSpeed.fill(0);
    this.place(p, env.ground(p));
    Cartesian3.clone(origin ?? this.feet, this.origin);
    this.sampleWheels(env, []);
    this.rest();
    this.orient();
  }

  /** Straight onto its wheels at rest: the plane through the six wheels' ground (least squares). */
  private rest() {
    const g = this.wheelGround;
    let m = 0, pf = 0, pr = 0;
    for (let i = 0; i < 6; i++) m += g[i] / 6;
    for (let i = 0; i < 6; i++) { pf += (g[i] - m) * (WF[i] - MEAN_F); pr += (g[i] - m) * WR[i]; }
    this.pitch = Math.atan(pf / SUM_F2C); this.roll = Math.atan(pr / SUM_R2);
    this.bodyH = m - Math.tan(this.pitch) * MEAN_F;
    this.vUp = 0; this.vp = 0; this.vr = 0; this.air = 0;
    this.contacts();
    this.prevGround.set(this.wheelGround);
  }

  /** Straight-line distance from the landing spot (m). */
  distanceFromStart(): number { return Cartesian3.distance(this.feet, this.origin); }

  /** The plane through the bare ground under the six wheels (least squares): what gravity and grip act on. */
  private groundPlane() {
    const g = this.wheelTerrain;
    let m = 0, pf = 0, pr = 0;
    for (let i = 0; i < 6; i++) m += g[i] / 6;
    for (let i = 0; i < 6; i++) { pf += (g[i] - m) * (WF[i] - MEAN_F); pr += (g[i] - m) * WR[i]; }
    this.gTanF = pf / SUM_F2C; this.gTanS = pr / SUM_R2;
  }

  /**
   * Advance by dt seconds. Returns true while anything still moves (driving, coasting, turning, bouncing).
   */
  step(dt: number, input: DriveInput, env: WalkEnv): boolean {
    dt = Math.min(dt, 0.1);
    this.landed = 0;
    this.place(this.feet, env.ground(this.feet)); // finer ground tiles may have arrived under it
    const obstacles = env.obstacles();
    const onShare = this.wheelOn.reduce((a, v) => a + v, 0) / 6;
    const grounded = onShare > 0;

    // steering (skid steer: needs the wheels on the ground)
    const sp = Math.min(1, Math.abs(this.speed) / DRIVE.fast);
    // fast, the turn is kept within what the grip can hold (a little more: it drifts a touch wide, never spins out)
    const gripTurn = 1.05 * DRIVE.grip * G * onShare / Math.max(0.5, Math.abs(this.speed)) * 180 / Math.PI;
    const rate = (grounded ? input.turn : 0) * Math.min(gripTurn, DRIVE.turnDeg + (DRIVE.turnDegFast - DRIVE.turnDeg) * sp);
    this.yawRate += (rate - this.yawRate) * (1 - Math.exp(-dt / (grounded ? DRIVE.turnS : 1.5)));
    if (Math.abs(this.yawRate) < 0.05 && !input.turn) this.yawRate = 0;
    this.turned = this.yawRate * dt;
    this.heading = ((this.heading + this.turned) % 360 + 360) % 360;
    // the velocity stays put in the world while the body turns under it
    const dpsi = this.turned * Math.PI / 180, c = Math.cos(dpsi), s = Math.sin(dpsi);
    let vF = this.speed * c + this.slide * s, vS = this.slide * c - this.speed * s;

    // the slope the forces use: the plane through the GROUND under the six wheels (no rocks, no spring bounce)
    this.groundPlane();
    const tF = this.gTanF, tS = this.gTanS;
    const cosF = 1 / Math.hypot(1, tF), cosS = 1 / Math.hypot(1, tS), sinF = tF * cosF, sinS = tS * cosS;
    const load = G / Math.sqrt(1 + tF * tF + tS * tS) * onShare;         // how hard the ground pushes back (per unit mass)
    const gF = grounded ? -G * sinF : 0, gS = grounded ? -G * sinS : 0;  // gravity along / across the ground (none in the air)
    const top = input.fast ? DRIVE.fast : DRIVE.speed;
    const climbing = input.fwd !== 0 && sinF * input.fwd > 0;
    const climbShare = climbing ? Math.min(1, Math.abs(sinF) / MAX_DRIVE_SIN) : 0;
    const want = input.fwd * top * (1 - DRIVE.climbLoss * climbShare);
    const limit = DRIVE.grip * load;
    // sideways the tyres resist; the grip goes first to holding the line, what is left drives, brakes or holds
    let aS = -vS / 0.12 - gS;
    let slip = 0;
    if (Math.abs(aS) > limit) { slip = (Math.abs(aS) - limit) * 0.35; aS = Math.sign(aS) * limit; }
    const leftF = Math.sqrt(Math.max(0, limit * limit - aS * aS));
    // losses in the soil (always against the motion) and what the wheels do
    const rr = DRIVE.rollRes * load, kv = DRIVE.rollDragV;
    let aF = 0, hold = 0;
    this.blocked = '';
    if (input.fwd !== 0) {
      const over = (vF - want) * input.fwd > 0;                          // faster than asked (downhill): the motors only brake gently
      aF = (want - vF) / (over ? DRIVE.overS : DRIVE.accelS) + input.fwd * (rr + kv * Math.abs(want));
      const push = Math.min(DRIVE.motor, leftF), brake = Math.min(DRIVE.engineBrake, leftF);
      aF = input.fwd > 0 ? Math.max(-brake, Math.min(push, aF)) : Math.max(-push, Math.min(brake, aF));
      // too steep to climb: the wheels dig in and spin, and it slides back
      if (climbing && Math.abs(sinF) > MAX_DRIVE_SIN) {
        aF = Math.sign(input.fwd) * Math.min(Math.abs(aF), G * MAX_DRIVE_SIN * 0.85);
        this.blocked = 'slope'; slip = Math.max(slip, 1.2);
      }
    } else hold = Math.min(input.parked ? 1e9 : DRIVE.hold, leftF);      // parked: the brakes; driving with the keys released: a gentle hold
    if (grounded && Math.hypot(gF, gS) > limit + rr) { this.blocked = 'slope'; slip = Math.max(slip, 0.8); } // too steep for the tyres: it slides
    // at rest it stays at rest until the push beats the losses (15 % harder to start than to keep going: no creeping on and off)
    const free = aF + gF, still = grounded ? (rr + hold) * 1.15 : 0, resist = grounded ? rr + hold + kv * Math.abs(vF) : 0;
    if (vF !== 0) {
      const v1 = vF + (free - Math.sign(vF) * resist) * dt;
      vF = v1 * vF <= 0 ? 0 : v1;                                         // the losses never push it backwards
    } else if (Math.abs(free) > still) vF = (free - Math.sign(free) * (rr + hold)) * dt;
    if (input.fwd === 0 && Math.abs(vF) < 0.012 && Math.abs(free) <= still) vF = 0;
    // standing still for this instant, but the slope pulls harder than the wheels hold: it is about to roll (not at rest)
    this.restless = grounded && Math.abs(free) > still;
    vF = Math.max(-DRIVE.vMax, Math.min(DRIVE.vMax, vF));
    vS += (aS + gS) * dt;
    if (Math.abs(vS) < 0.01 && Math.abs(gS) <= limit) vS = 0;
    // the soil: pulling away and climbing, the tyres churn a little faster than the ground goes by (m/s)
    let spin = 0;
    if (input.fwd && grounded) spin = DRIVE.takeoffSlip * Math.abs(aF) + 0.4 * climbShare;
    this.slip += (Math.max(slip + spin, Math.abs(vS) * 1.5) - this.slip) * Math.min(1, dt * 8);

    // move: world direction of forward and right on the flat ground
    const a = this.heading * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    const F = this.flatDir(ca, sa, this.F0), Rt = this.flatDir(-sa, ca, this.R0);
    // (speeds are along the ground; the step on the flat map is shorter on a slope)
    const next = Cartesian3.clone(this.feet, this.nextP);
    // rocks: the robot's outline against theirs (see collide), in pieces of about 6 cm so nothing is skipped at speed
    this.speed = vF; this.slide = vS;
    this.impact = 0; this.pressing = false;
    const pieces = obstacles.length ? Math.max(1, Math.min(8, Math.ceil(Math.hypot(vF, vS) * dt / 0.06))) : 1, hp = dt / pieces;
    for (let k = 0; k < pieces; k++) {
      Cartesian3.add(next, Cartesian3.add(Cartesian3.multiplyByScalar(F, this.speed * cosF * hp, d1), Cartesian3.multiplyByScalar(Rt, this.slide * cosS * hp, d2), d1), next);
      if (obstacles.length) this.collide(next, F, Rt, obstacles);
    }
    vF = this.speed; vS = this.slide;
    // the HUD says "a rock is in the way" only when one really holds it (not for a brush, and not flickering)
    this.rockHold = this.pressing && input.fwd !== 0 && Math.abs(vF) < 0.15 ? Math.min(1, this.rockHold + dt) : Math.max(0, this.rockHold - 2 * dt);
    if (this.rockHold > 0.3) this.blocked = 'rock';
    const moved = Cartesian3.distance(next, this.feet);
    this.odometer += moved * Math.sign(vF || 1);
    this.place(next, env.ground(next));

    // wheels: the ground (and small rocks) under each, then the body on its springs, in small steps
    this.sampleWheels(env, obstacles);
    // a sharper ground tile arrived under it (the ground jumped, not the robot): stand on the new ground at once
    let jump = 0;
    const gRate = this.gRate;
    for (let i = 0; i < 6; i++) { const dg = this.wheelGround[i] - this.prevGround[i]; jump = Math.max(jump, Math.abs(dg)); gRate[i] = dg / dt; }
    this.prevGround.set(this.wheelGround);
    if (!Number.isFinite(this.bodyH + this.pitch + this.roll) || jump > 0.35 + 0.6 * moved || Math.abs(this.pitch) > 1 || Math.abs(this.roll) > 1) { this.rest(); gRate.fill(0); }
    else if (grounded && Math.abs(vF) > 0.8) {
      // bumps under one side more than the other nudge the steering a little at speed
      const diff = (gRate[0] + gRate[1] + gRate[2] - gRate[3] - gRate[4] - gRate[5]) / 3;
      this.yawRate += DRIVE.bumpSteer * Math.max(-0.5, Math.min(0.5, diff)) * Math.min(1, Math.abs(vF) / 3);
    }
    const n = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / n;
    const w = Math.sqrt(OMEGA2), z = DRIVE.damp;
    for (let k = 0; k < n; k++) {
      this.contacts();
      let fz = 0, tp = 0, tr = 0;
      for (let i = 0; i < 6; i++) {
        if (!this.wheelOn[i]) continue;
        const cv = Math.max(-2.5, Math.min(2.5, gRate[i] - (this.vUp + WF[i] * this.vp + WR[i] * this.vr))); // how fast the spring is pushed in // how fast the spring is being pushed in
        const f = Math.min(5 * G, Math.max(0, (OMEGA2 * (this.comp[i] + DRIVE.sag) + 2 * z * w * cv) / 6));
        fz += f; tp += f * WF[i]; tr += f * WR[i];
      }
      // speeding up lifts the nose, turning leans it outwards (the centre of mass sits above the wheels)
      const aLat = vF * this.yawRate * Math.PI / 180;
      const ap = (tp + (grounded ? aF : 0) * DRIVE.cgH) / (DRIVE.gyrPitch ** 2) - this.vp;
      const ar = (tr + (grounded ? aLat : 0) * DRIVE.cgH) / (DRIVE.gyrRoll ** 2) - this.vr;
      this.vUp += (fz - G) * h;
      this.vp += ap * h; this.vr += ar * h;
      this.bodyH += this.vUp * h; this.pitch += this.vp * h; this.roll += this.vr * h;
      // no wheel is ever pushed further up than its travel: lift the body instead (it rides over it)
      this.contacts();
      let push = 0;
      for (let i = 0; i < 6; i++) push = Math.max(push, this.comp[i] - DRIVE.travelUp);
      if (push > 0) { this.bodyH += push; if (this.vUp < 0) this.vUp *= 0.2; this.contacts(); }
    }
    this.contacts();
    // in the air or on the ground
    const on = this.wheelOn.reduce((a2, v) => a2 + v, 0);
    if (on === 0) this.air += dt;
    else { if (this.air > 0.12) this.landed = Math.max(0.1, -this.vUp + 0.3); this.air = 0; }
    // the tyres press into the dust, deeper while they churn; off the ground they come out of it
    const sinkTo = on ? DRIVE.sink + DRIVE.sinkSlip * Math.min(1, this.slip / 0.8) : 0;
    this.sink += (sinkTo - this.sink) * Math.min(1, dt / 0.3);

    // the wheels turn with the ground under them: inner and outer sides differ in a turn, and spin
    // when they slip (climbing too steep, pulling away hard)
    const yr = this.yawRate * Math.PI / 180;
    for (let i = 0; i < 6; i++) {
      let v = vF - yr * WR[i];
      if (this.blocked === 'slope') v = input.fwd * top * 0.6;
      else if (this.pressing && input.fwd) v = input.fwd * Math.max(Math.abs(v), 0.35); // held by a rock: they turn in the dust
      else if (input.fwd) v += input.fwd * (slip * 0.8 + spin);
      if (!this.wheelOn[i]) v = this.wheelSpeed[i] * Math.exp(-dt / 1.2) + (input.fwd ? (input.fwd * top - this.wheelSpeed[i]) * Math.min(1, dt * 2) : 0);
      this.wheelSpeed[i] = v;
      this.wheelSpin[i] = (this.wheelSpin[i] + v * dt / (WHEEL_R * S)) % (2 * Math.PI);
    }
    this.orient();
    const bouncing = Math.abs(this.vUp) > 0.004 || Math.abs(this.vp) > 0.004 || Math.abs(this.vr) > 0.004;
    // (any speed at all keeps it awake: on a slope it passes through nought on its way to rolling back down, and
    // must not be put to sleep there; at rest the speeds are exactly nought, see the forces above)
    return this.speed !== 0 || this.slide !== 0 || this.restless || Math.abs(this.yawRate) > 0.05 || bouncing || this.air > 0;
  }

  /** Where the middle of the model's base is (world): under the body, at the wheels' rest height, the tyres pressed into the dust. */
  base(out: Cartesian3): Cartesian3 {
    return Cartesian3.multiplyByScalar(this.up, R + this.bodyH - this.sink, out);
  }

  /**
   * Keep every part of the robot out of the rocks. `next` is where it is about to be (moved out of the rocks here),
   * F / Rt its flat forward and right; this.speed / slide / yawRate are its motion (changed here).
   * Each rock touched gives one contact: the deepest ball of the robot's outline in it. The robot is moved straight
   * out by that depth (position only: no speed comes from it), then the touching point's speed into the rock is
   * taken away by an impulse there (a rigid body of mass 1, harder to turn than a free one because its wheels hold
   * it), with friction along the rock. A rock low enough to drive over (DRIVE.climb) is left to the wheels (see sampleWheels).
   */
  private collide(next: Cartesian3, F: Cartesian3, Rt: Cartesian3, obstacles: readonly WalkObstacle[]) {
    const tp = Math.tan(this.pitch), tr = Math.tan(this.roll);
    const I = DRIVE.rockTurnHold * 0.35; // the body's own turning inertia about its middle: 1.55 x 1.35 m box, k ~ 0.59 m
    const reach = BODY_REACH * S;
    const v0 = Math.hypot(this.speed, this.slide);
    const w0 = this.yawRate * Math.PI / 180;
    let w = w0, vF = this.speed, vS = this.slide;
    let pressing = false, hitAngle = 0;
    for (let iter = 0; iter < 3; iter++) {
      let any = false;
      for (const o of obstacles) {
        const dx = Cartesian3.subtract(o.p, next, d4);
        const rf = Cartesian3.dot(dx, F), rr = Cartesian3.dot(dx, Rt);
        if (Math.hypot(rf, rr) > o.r + reach) continue;
        if (o.h <= DRIVE.climb) continue; // low enough to drive over: the wheels ride up it (sampleWheels), nothing is stopped
        const rockGround = Cartesian3.magnitude(o.p) - R;
        let deep = 0, nf = 0, nr = 0, af = 0, ar = 0;
        for (const c of BODY_CELLS) {
          const cf = c.f * S, cr = c.r * S, rad = c.rad * S;
          // the ball's bottom over the rock's ground, with the body's tilt (and the wheel's own travel)
          const bottom = this.bodyH + cf * tp + cr * tr + c.y * S + (c.wheel >= 0 ? this.wheelLift[c.wheel] : 0) - rockGround;
          if (bottom >= o.h) continue;
          const df = cf - rf, dr = cr - rr, D = Math.hypot(df, dr);
          const pen = rockRadiusAt(o.r, o.h, bottom, o.pow) + rad - D;
          if (pen <= deep) continue;
          deep = pen;
          if (D > 1e-6) { nf = df / D; nr = dr / D; } else { nf = -Math.sign(rf) || 1; nr = 0; }
          af = cf - nf * rad; ar = cr - nr * rad;
        }
        // (a millimetre of touch is kept below, so a rock that holds the robot is felt on every step, not every other one)
        if (deep <= 0.0004) continue;
        any = true; pressing = true;
        // out of the rock (keeping a millimetre of touch so the contact holds without jitter)
        const out = Math.max(0, deep - 0.001);
        Cartesian3.add(next, Cartesian3.add(Cartesian3.multiplyByScalar(F, nf * out, d1), Cartesian3.multiplyByScalar(Rt, nr * out, d2), d1), next);
        // the touching point's speed: the body's plus its turn (a point ahead of the middle moves right when turning right)
        const pf = vF - w * ar, ps = vS + w * af;
        const vn = pf * nf + ps * nr;
        if (vn >= 0) continue;
        const arm = -ar * nf + af * nr; // how the push turns the body
        const j = -vn / (1 + arm * arm / I);
        // friction along the rock, at most rockFriction x the push
        const tf = -nr, ts = nf, armT = -ar * tf + af * ts;
        const vt = (pf + j * nf + (-ar) * (j * arm / I)) * tf + (ps + j * nr + af * (j * arm / I)) * ts;
        const jt = Math.max(-DRIVE.rockFriction * j, Math.min(DRIVE.rockFriction * j, -vt / (1 + armT * armT / I)));
        const dvF = j * nf + jt * tf, dvS = j * nr + jt * ts;
        vF += dvF; vS += dvS; w += (j * arm + jt * armT) / I;
        if (-vn > this.impact) { this.impact = -vn; hitAngle = Math.asin(Math.min(1, -vn / Math.max(1e-6, Math.hypot(pf, ps)))) * 180 / Math.PI; }
        // the touch is below the centre of mass: a hard stop dips the nose (the tail, backing into it), a side touch
        // leans the body towards the rock
        const k = DRIVE.rockPitchMax;
        this.vp += Math.max(-k, Math.min(k, dvF * DRIVE.rockPitch));
        this.vr += Math.max(-k, Math.min(k, dvS * DRIVE.rockPitch * 0.6));
      }
      if (!any) break;
    }
    // a touch never speeds it up
    const v1 = Math.hypot(vF, vS);
    if (v1 > v0 && v1 > 1e-6) { vF *= v0 / v1; vS *= v0 / v1; }
    this.speed = vF; this.slide = vS;
    // (the wheels' grip on the dust keeps the turn small: a touch swings it by a few degrees, it never spins it)
    const wMax = DRIVE.rockTurnMax * Math.PI / 180;
    this.yawRate = (w0 + Math.max(-wMax, Math.min(wMax, w - w0))) * 180 / Math.PI;
    if (pressing) { this.pressing = true; this.contactBefore = v0; this.contactAfter = Math.hypot(vF, vS); this.contactAngle = hitAngle; }
  }

  /** Where wheel i touches the ground (world). */
  wheelContact(i: number, out: Cartesian3): Cartesian3 {
    const f = WF[i], r = WR[i], F = this.F0, Rt = this.R0, h = R + this.wheelGround[i];
    Cartesian3.add(this.feet, Cartesian3.add(Cartesian3.multiplyByScalar(F, f, d3), Cartesian3.multiplyByScalar(Rt, r, d4), d3), out);
    return Cartesian3.multiplyByScalar(Cartesian3.normalize(out, out), h, out);
  }

  /** The ground under each wheel, with the small rocks it rolls over. */
  private sampleWheels(env: WalkEnv, obstacles: readonly WalkObstacle[]) {
    const a = this.heading * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    const F = this.flatDir(ca, sa, this.F0), Rt = this.flatDir(-sa, ca, this.R0);
    for (let i = 0; i < 6; i++) {
      const p = Cartesian3.add(this.feet, Cartesian3.add(Cartesian3.multiplyByScalar(F, WF[i], d3), Cartesian3.multiplyByScalar(Rt, WR[i], d4), d3), d3);
      const g0 = env.ground(p);
      let g = g0;
      // a rock low enough to climb lifts the wheel: the wheel's circle resting on the rock's rounded top, in the
      // upright slice through the wheel and the rock's middle (it starts rolling up before its centre gets there)
      const Rw = WHEEL_R * S;
      for (const o of obstacles) {
        if (o.h > DRIVE.climb) continue;
        const dv = Cartesian3.subtract(p, o.p, d4);
        const along = Cartesian3.dot(dv, this.up);
        const dist = Math.sqrt(Math.max(0, Cartesian3.magnitudeSquared(dv) - along * along));
        if (dist >= o.r + Rw) continue;
        let lift = 0;
        for (let k = -3; k <= 3; k++) {
          const x = Rw * k / 3.2;
          const l = rockTopAt(o.r, o.h, Math.abs(dist + x), o.pow) - (Rw - Math.sqrt(Rw * Rw - x * x));
          if (l > lift) lift = l;
        }
        if (lift > 0) g = Math.max(g, g0 + lift);
      }
      this.wheelGround[i] = g; this.wheelTerrain[i] = g0;
    }
  }

  /** How far each spring is pushed in (m) for the body's height and tilt now; which wheels touch; their lift. */
  private contacts() {
    const tp = Math.tan(this.pitch), tr = Math.tan(this.roll);
    for (let i = 0; i < 6; i++) {
      const rest = this.bodyH + WF[i] * tp + WR[i] * tr; // where the wheel's bottom would be with the spring at rest
      const c = this.wheelGround[i] - rest;
      this.comp[i] = c;
      this.wheelOn[i] = c > -DRIVE.drop ? 1 : 0;
      this.wheelLift[i] = Math.min(DRIVE.travelUp, Math.max(-DRIVE.drop, c));
    }
  }

  /** The body's frame from its pitch and roll over the flat ground. */
  private orient() {
    const U = this.up, F = this.F0, Rt = this.R0, tp = Math.tan(this.pitch), tr = Math.tan(this.roll);
    const a = this.heading * Math.PI / 180;
    this.flatDir(Math.cos(a), Math.sin(a), F); this.flatDir(-Math.sin(a), Math.cos(a), Rt);
    Cartesian3.fromElements(U.x - F.x * tp - Rt.x * tr, U.y - F.y * tp - Rt.y * tr, U.z - F.z * tp - Rt.z * tr, this.bodyUp);
    Cartesian3.normalize(this.bodyUp, this.bodyUp);
    Cartesian3.subtract(F, Cartesian3.multiplyByScalar(this.bodyUp, Cartesian3.dot(F, this.bodyUp), d2), this.fwd);
    Cartesian3.normalize(this.fwd, this.fwd);
    Cartesian3.cross(this.fwd, this.bodyUp, this.right);
  }

  /** north * cn + east * ce, on the flat ground (world). */
  private flatDir(cn: number, ce: number, out: Cartesian3): Cartesian3 {
    const N = this.north, E = this.east;
    return Cartesian3.fromElements(N.x * cn + E.x * ce, N.y * cn + E.y * ce, N.z * cn + E.z * ce, out);
  }

  private place(p: Cartesian3, groundH: number) {
    Cartesian3.normalize(p, this.up);
    Cartesian3.multiplyByScalar(this.up, R + groundH, this.feet);
    const U = this.up, n = this.north0;
    Cartesian3.normalize(Cartesian3.subtract(n, Cartesian3.multiplyByScalar(U, Cartesian3.dot(n, U), d3), d3), this.north);
    Cartesian3.cross(this.north, U, this.east);
  }
}
