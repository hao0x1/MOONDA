// A small, worker-safe version of Driver's steady driving forces (moon/walk.ts).
// Keep these values with DRIVE there. Importing walk.ts itself would load Cesium in the
// science worker and in Node checks; this file only needs the motor and tyre numbers.
export const ROUTE_DRIVE = {
  g: 1.62,
  speed: 2,
  accelS: 0.55,
  motor: 1.5,
  grip: 0.85,
  rollRes: 0.1,
  rollDragV: 0.2,
  engineBrake: 0.45,
  overS: 2,
  vMax: 7,
  maxSlopeDeg: 25,
  climbLoss: 0.35,
  climb: 1.5 * 0.2627 * 0.5,
} as const;

const DEG = Math.PI / 180;
const MAX_SIN = Math.sin(ROUTE_DRIVE.maxSlopeDeg * DEG);

// Driver stops climbing at DRIVE.maxSlopeDeg. Its tyres hold while lateral gravity
// fits inside DRIVE.grip * normal load. On a slope pointing between the two axes,
// Driver calculates each gravity component separately; solve the worst (45 degree)
// direction as well, so this limit remains safe for every heading. Rolling resistance
// can help hold the rover along its wheels, but we do not rely on it holding sideways.
const grip2 = ROUTE_DRIVE.grip ** 2;
const holdTan2 = (-(1 - grip2 / 2) + Math.sqrt((1 - grip2 / 2) ** 2 + 4 * grip2)) / 2;
export const ROUTE_HOLD_SLOPE_DEG = Math.atan(Math.sqrt(holdTan2)) / DEG;
export const ROUTE_MAX_SLOPE_DEG = Math.min(ROUTE_DRIVE.maxSlopeDeg, ROUTE_HOLD_SLOPE_DEG);
/** Fastest W-only speed on allowed ground (25 degrees downhill): about 2.978 m/s.
 * DRIVE.vMax is 7 m/s, but W without Shift cannot reach that on an allowed plane.
 * This tighter upper bound keeps A*'s straight-line guess useful and admissible. */
export const ROUTE_MAX_SPEED_MPS = drivingSpeed(-Math.tan(ROUTE_MAX_SLOPE_DEG * DEG));

/**
 * W held, Shift released: metres per second along the ground, on a steady plane.
 * alongTan rises ahead; crossTan rises across the route. These are height / flat metres.
 *
 * This solves Driver.step's forward force balance exactly, including the weaker
 * downhill engine brake, motor / grip caps, rolling resistance and velocity drag.
 * On a cross slope we also reserve the share of tyre grip spent holding the line:
 * leftF / limit. Driver can cruise faster on a perfectly uniform side slope; this
 * conservative allowance leaves that grip available for steering round a bowl.
 * Flat: 2.00 m/s; 10 / 20 degrees uphill: 1.57 / 1.16; downhill: 2.40 / 2.79.
 * Acceleration, turns, spring bounce and individual wheel contacts are not simulated.
 */
export function drivingSpeed(alongTan: number, crossTan = 0): number {
  const D = ROUTE_DRIVE;
  if (!Number.isFinite(alongTan) || !Number.isFinite(crossTan)) return 0;
  const slopeTan = Math.hypot(alongTan, crossTan);
  // The fine planner closes a slope the rover could only descend: a route should
  // still be climbable and holdable if the driver stops or has to turn round.
  if (slopeTan > Math.tan(ROUTE_MAX_SLOPE_DEG * DEG) + 1e-8) return 0;
  const sinF = alongTan / Math.hypot(1, alongTan);
  const sinS = crossTan / Math.hypot(1, crossTan);
  const load = D.g / Math.sqrt(1 + alongTan * alongTan + crossTan * crossTan);
  const limit = D.grip * load;
  const sideHold = Math.abs(D.g * sinS);
  if (sideHold >= limit) return 0;
  const leftF = Math.sqrt(Math.max(0, limit * limit - sideHold * sideHold));
  const rr = D.rollRes * load, gravityF = -D.g * sinF;
  const want = D.speed * (1 - D.climbLoss * Math.max(0, sinF) / MAX_SIN);
  const push = Math.min(D.motor, leftF), brake = Math.min(D.engineBrake, leftF);
  const atRest = Math.min(push, want / D.accelS + rr + D.rollDragV * want) + gravityF;
  if (atRest <= rr * 1.15) return 0;
  // Unsaturated solution, then either saturated branch if it asks for more than
  // the motors / remaining tyre grip allow. All terms are the ones in Driver.step.
  const tau = gravityF > 0 ? D.overS : D.accelS;
  let speed = want + gravityF / (1 / tau + D.rollDragV);
  const effort = (want - speed) / tau + rr + D.rollDragV * want;
  if (effort > push) speed = (push + gravityF - rr) / D.rollDragV;
  else if (effort < -brake) speed = (-brake + gravityF - rr) / D.rollDragV;
  return Math.max(0, Math.min(D.vMax, speed)) * (leftF / limit);
}

/** Driving seconds for a short segment; slopeDeg is the whole surface slope. */
export function edgeSeconds(flatM: number, dzM: number, slopeDeg: number): number {
  if (!(flatM > 0)) return dzM === 0 ? 0 : Infinity;
  const along = dzM / flatM;
  // A finite-difference slope can be gentler than the rise between two samples.
  // Always include the segment's own rise; never make its inferred cross slope NaN.
  const whole = Math.max(Math.abs(along), Math.tan(Math.max(0, slopeDeg) * DEG));
  const cross = Math.sqrt(Math.max(0, whole * whole - along * along));
  const speed = drivingSpeed(along, cross);
  return speed > 0 ? Math.hypot(flatM, dzM) / speed : Infinity;
}
