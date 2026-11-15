// Run: node scripts/check-rock-clearance.ts. Real tyre/body sizes, synthetic flat ground and rocks:
// a stone may pass between the wheels, but not through a tyre or a low part of the chassis.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Cartesian3 } from 'cesium';
import type { DriveInput, WalkEnv, WalkObstacle } from '../src/moon/walk.ts';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && context.parentURL && !/\.[a-z]+$/i.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
  }
  return nextResolve(specifier, context);
} });
const { Driver, DRIVE, ROBOT_SCALE, WHEELS, WHEEL_WIDTH, WHEEL_AXLE_Y, WHEEL_R } = await import('../src/moon/walk.ts');
const { BODY_ZONES } = await import('../src/moon/robotBody.ts');

const R = 1737400, DT = 1 / 120, DEG = 180 / Math.PI;
const point = (n: number, e = 0) => new Cartesian3(Math.sqrt(R * R - n * n - e * e), e, n);
const north = new Cartesian3(0, 0, 1);
const forward: DriveInput = { fwd: 1, turn: 0, fast: false, parked: false };
const reverse: DriveInput = { ...forward, fwd: -1 };
const parked: DriveInput = { ...forward, fwd: 0, parked: true };
const summary = (d: InstanceType<typeof Driver>) => ({ n: d.feet.z, e: d.feet.y, speed: d.speed, heading: d.heading, pressing: d.pressing, blocked: d.blocked });

function setup(height: number, width: number, east = 0) {
  const obstacle: WalkObstacle = { p: point(0, east), r: width / 2, h: height, pow: 2 };
  const env: WalkEnv = { ground: () => 0, obstacles: () => [obstacle] };
  const driver = new Driver(); driver.reset(point(-3), north, 0, env);
  return { driver, env };
}
function drive(d: InstanceType<typeof Driver>, env: WalkEnv, input: DriveInput, seconds: number) {
  let touches = 0, blocked = 0, maxPitch = 0, maxWheelLift = 0, maxContactAngle = 0, maxStep = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const before = Cartesian3.clone(d.feet);
    d.step(DT, input, env);
    if (d.pressing) {
      touches++; maxContactAngle = Math.max(maxContactAngle, d.contactAngle);
      assert.ok(d.contactAfter <= d.contactBefore + 1e-9, 'a contact must not add speed');
    }
    if (d.blocked === 'rock') blocked++;
    maxPitch = Math.max(maxPitch, Math.abs(d.pitch) * DEG);
    maxWheelLift = Math.max(maxWheelLift, ...d.wheelGround);
    maxStep = Math.max(maxStep, Cartesian3.distance(before, d.feet));
    assert.ok(Number.isFinite(d.pitch + d.roll + d.speed + d.slide), 'contact state stays finite');
  }
  return { ...summary(d), touches, blockedFrames: blocked, maxPitch, maxWheelLift, maxContactAngle, maxStep };
}
function freesInReverse(d: InstanceType<typeof Driver>, env: WalkEnv) {
  const start = Cartesian3.clone(d.feet);
  let freedAt: number | null = null;
  for (let i = 0; i < 120; i++) {
    d.step(DT, reverse, env);
    if (freedAt === null && !d.pressing && d.speed < -0.05) freedAt = i * DT;
  }
  assert.ok(freedAt !== null && freedAt < 1, 'reverse frees a blocked rover within a second');
  assert.ok(Cartesian3.distance(start, d.feet) > 0.2, 'reverse makes useful room to steer');
  return { freedAt, distanceM: Cartesian3.distance(start, d.feet), ...summary(d) };
}

assert.ok(Math.abs(DRIVE.climb - 0.197025) < 1e-9, 'the established wheel climb limit stays unchanged');
assert.ok(Math.abs(WHEEL_WIDTH * ROBOT_SCALE - 0.167803) < 1e-9, 'contacts use the measured tyre width');
assert.ok(Math.min(...BODY_ZONES.filter(z => z.r0 < 0 && z.r1 > 0 && z.f0 < 0 && z.f1 > 0).map(z => z.y * ROBOT_SCALE)) > 0.33,
  'the central belly is measured from the body, not expanded shadow voxels');
const sunkBellyClearanceM = BODY_ZONES[0].y * ROBOT_SCALE - DRIVE.sink;
assert.ok(Math.abs(sunkBellyClearanceM - 0.325233) < 1e-6, 'body clearance includes the same dust sink as the rendered model');

const centre = setup(0.25, 0.30), centreResult = drive(centre.driver, centre.env, forward, 8);
assert.ok(centreResult.n > 4 && centreResult.touches === 0, 'a centred 25cm-high, 30cm-wide stone passes beneath the body');
const narrow = setup(0.30, 0.25), narrowResult = drive(narrow.driver, narrow.env, forward, 8);
assert.ok(narrowResult.n > 4 && narrowResult.touches === 0, 'a narrow 30cm-high stone also fits under the measured belly');

const wheelEast = -WHEELS[0].x * ROBOT_SCALE;
const wheel = setup(0.25, 0.30, wheelEast), wheelResult = drive(wheel.driver, wheel.env, forward, 8);
assert.ok(wheelResult.n < -0.2 && wheelResult.blockedFrames > 30, 'the same stone in a tyre path really blocks it');
const wheelReverse = freesInReverse(wheel.driver, wheel.env);
const climb = setup(DRIVE.climb, 0.30, wheelEast), climbResult = drive(climb.driver, climb.env, forward, 8);
assert.ok(climbResult.n > 4 && climbResult.blockedFrames === 0 && climbResult.maxWheelLift > 0.1, 'a tyre climbs the existing maximum step');

const steering = setup(0.25, 0.30, wheelEast);
drive(steering.driver, steering.env, forward, 8);
const steeringResult = drive(steering.driver, steering.env, { ...forward, turn: 1 }, 3);
assert.ok(!steeringResult.pressing && steeringResult.speed > 0.5 && steeringResult.e > 0.5, 'steering away from a blocked tyre works');

const belly = setup(0.45, 0.30), bellyResult = drive(belly.driver, belly.env, forward, 8);
assert.ok(bellyResult.n < -0.2 && bellyResult.blockedFrames > 30, 'a 45cm-high central stone meets the real belly');
const bellyReverse = freesInReverse(belly.driver, belly.env);

// This path meets the rounded front tyre at about 20 degrees to the face, rather than head-on.
const graze = setup(0.50, 0.50, 0.84), grazeResult = drive(graze.driver, graze.env, forward, 8);
assert.ok(grazeResult.touches > 0 && grazeResult.maxContactAngle >= 15 && grazeResult.maxContactAngle <= 30, 'the grazing check actually touches at about 20 degrees');
assert.ok(grazeResult.n > 4 && grazeResult.blockedFrames === 0 && grazeResult.speed > 1.5, 'a grazing half-metre boulder slides along the rover');

// Same-frame tile selection changes the support, not the rover's travel or its spring integration.
let ground = 0;
const changing: WalkEnv = { ground: () => ground, obstacles: () => [] };
const synced = new Driver(); synced.reset(point(0), north, 23, changing);
synced.speed = 0.7; synced.slide = 0.1; synced.yawRate = 3; synced.odometer = 4;
synced.wheelSpin.set([1, 2, 3, 4, 5, 6]);
const preserved = { speed: synced.speed, slide: synced.slide, heading: synced.heading, yawRate: synced.yawRate, odometer: synced.odometer, spin: [...synced.wheelSpin] };
ground = 0.4;
assert.equal(synced.syncGround(changing), true, 'a changed selected mesh is reseated in the same frame');
assert.deepEqual({ speed: synced.speed, slide: synced.slide, heading: synced.heading, yawRate: synced.yawRate, odometer: synced.odometer, spin: [...synced.wheelSpin] }, preserved, 'support sync does not move or integrate the rover');
assert.ok(Math.abs(Cartesian3.magnitude(synced.feet) - R - ground) < 1e-8 && synced.vUp === 0 && synced.air === 0, 'support sync does not launch it');
assert.equal(synced.syncGround(changing), false, 'unchanged terrain does not keep the loop awake');
ground += 0.004; assert.equal(synced.syncGround(changing), false, 'tiny mesh changes do not flatten springs');
ground += 0.004; assert.equal(synced.syncGround(changing), false, 'a second tiny mesh change can wait');
ground += 0.004; assert.equal(synced.syncGround(changing), true, 'small unintegrated tile changes add up rather than leaving a parked rover behind');
synced.speed = synced.slide = synced.yawRate = 0;
let awake = false;
for (let i = 0; i < 120 * 12; i++) awake = synced.step(DT, parked, changing);
assert.equal(awake, false, 'the reseated parked rover settles to sleep');

let facetArrived = false;
const facet: WalkEnv = { ground: p => facetArrived && Math.abs(p.z - 0.5475) < 0.15 && Math.abs(p.y + 0.5312) < 0.15 ? 0.3 : 0, obstacles: () => [] };
const corner = new Driver(); corner.reset(point(0), north, 0, facet); facetArrived = true;
assert.equal(corner.syncGround(facet), true, 'a new uneven facet is reseated before drawing');
const base = corner.base(new Cartesian3());
const facetPenetration = WHEELS.map((wheel, i) => {
  const p = Cartesian3.clone(base);
  Cartesian3.add(p, Cartesian3.multiplyByScalar(corner.fwd, wheel.z * ROBOT_SCALE, new Cartesian3()), p);
  Cartesian3.add(p, Cartesian3.multiplyByScalar(corner.right, -wheel.x * ROBOT_SCALE, new Cartesian3()), p);
  Cartesian3.add(p, Cartesian3.multiplyByScalar(corner.bodyUp, corner.wheelLift[i] + (WHEEL_AXLE_Y - WHEEL_R) * ROBOT_SCALE, new Cartesian3()), p);
  return facet.ground(p) - (Cartesian3.magnitude(p) - R);
});
assert.ok(Math.max(...facetPenetration) < 0.03, 'no drawn tyre stays more than 3cm inside an uneven selected facet');
assert.ok(corner.vUp === 0 && corner.air === 0, 'an uneven selected facet does not launch the rover');

console.log(JSON.stringify({ result: 'OK', climbLimitM: DRIVE.climb, sunkBellyClearanceM, centre: centreResult, narrow: narrowResult,
  wheel: wheelResult, wheelReverse, climb: climbResult, steering: steeringResult, belly: bellyResult, bellyReverse, graze: grazeResult,
  syncGround: 'preserved speed, heading, spin and distance; reseated and slept', facetPenetrationM: facetPenetration }, null, 2));
