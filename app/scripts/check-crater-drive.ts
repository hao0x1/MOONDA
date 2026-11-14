// Run: node scripts/check-crater-drive.ts. These checks give Driver a real bowl to drive across,
// without a camera or loading tiles, so spring and gravity failures cannot hide behind the picture.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Cartesian3 } from 'cesium';
import type { DriveInput, WalkEnv } from '../src/moon/walk.ts';

// Browser modules omit .ts. Keep their imports unchanged and teach only this Node check that rule.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && context.parentURL && !/\.[a-z]+$/i.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
  }
  return nextResolve(specifier, context);
} });
const { Driver, DRIVE } = await import('../src/moon/walk.ts');

const R = 1737400, DT = 1 / 120, DEG = 180 / Math.PI;
const north = new Cartesian3(0, 0, 1);
const parked: DriveInput = { fwd: 0, turn: 0, fast: false, parked: true };
const free: DriveInput = { ...parked, parked: false };
const forward: DriveInput = { ...free, fwd: 1 };
function point(n: number, e = 0): Cartesian3 { return new Cartesian3(Math.sqrt(R * R - n * n - e * e), e, n); }
function terrain(h: (n: number, e: number) => number): WalkEnv { return { ground: p => h(p.z, p.y), obstacles: () => [] }; }
function start(n: number, env: WalkEnv) { const d = new Driver(); d.reset(point(n), north, 0, env); return d; }
function run(d: InstanceType<typeof Driver>, env: WalkEnv, input: DriveInput, seconds: number) {
  let awake = false;
  for (let i = 0; i < Math.round(seconds / DT); i++) awake = d.step(DT, input, env);
  return awake;
}

const radius = 5, depth = 0.9;
const bowlHeight = (n: number) => Math.abs(n) < radius ? -depth * (1 - (n / radius) ** 2) ** 2 : 0;
const bowl = terrain(bowlHeight);
const d = start(-9, bowl);
const rows: { t: number; n: number; pitch: number; speed: number; height: number }[] = [];
let lastN = d.feet.z, maxStep = 0;
for (let frame = 0; frame < 120 * 20 && d.feet.z < 8; frame++) {
  d.step(DT, forward, bowl);
  maxStep = Math.max(maxStep, Math.abs(d.feet.z - lastN)); lastN = d.feet.z;
  assert.ok(Number.isFinite(d.pitch + d.roll + d.vUp + d.speed), 'bowl drive stayed finite');
  assert.ok(Math.abs(Cartesian3.magnitude(d.feet) - R - bowl.ground(d.feet)) < 1e-6, 'ground point never tunnels');
  if (frame % 30 === 0) rows.push({ t: +(frame * DT).toFixed(2), n: +d.feet.z.toFixed(3), pitch: +(d.pitch * DEG).toFixed(2), speed: +d.speed.toFixed(3), height: +bowl.ground(d.feet).toFixed(3) });
}
assert.ok(d.feet.z > 7, 'crossed the whole bowl');
const entry = rows.filter(r => r.n > -4.5 && r.n < -1.8);
const exit = rows.filter(r => r.n > 1.8 && r.n < 4.5);
assert.ok(entry.some(r => r.pitch < -5), 'nose points down on the entering wall');
assert.ok(exit.some(r => r.pitch > 5), 'nose points up on the leaving wall');
assert.ok(Math.min(...rows.map(r => r.height)) < -0.85, 'height reaches the bowl floor');
assert.ok(Math.max(...entry.map(r => r.speed)) > Math.min(...exit.map(r => r.speed)) + 0.1, 'downhill runs faster than uphill');
assert.ok(maxStep < DRIVE.vMax * DT + 0.001, 'small movement steps cross the bowl without skipping it');

const bowlBrake = start(-3, bowl), bowlBefore = Cartesian3.clone(bowlBrake.feet);
const bowlParkedAwake = run(bowlBrake, bowl, parked, 16);
assert.ok(Cartesian3.distance(bowlBefore, bowlBrake.feet) < 1e-4, 'parked brakes hold the curved bowl wall');
assert.equal(bowlParkedAwake, false, 'parked springs on a curved bowl wall settle to sleep');

const wall = terrain(n => n * Math.tan(12 / DEG));
const brake = start(0, wall), before = Cartesian3.clone(brake.feet);
const parkedAwake = run(brake, wall, parked, 12);
assert.ok(Cartesian3.distance(before, brake.feet) < 1e-4, 'parked brakes hold a 12 degree wall');
assert.equal(parkedAwake, false, 'parked springs settle and let the render loop sleep');
const rolling = start(0, wall);
run(rolling, wall, free, 4);
assert.ok(rolling.speed < -0.1 && rolling.feet.z < -0.1, 'released driving rolls down a wall steeper than 9 degrees');
const gentle = start(0, terrain(n => n * Math.tan(8 / DEG)));
const gentleEnv = terrain(n => n * Math.tan(8 / DEG));
assert.equal(run(gentle, gentleEnv, free, 10), false, 'released driving holds an 8 degree wall and sleeps');

// A sharper tile arrives under parked wheels: a metre of new height must reseat them, not launch them.
let tileRise = 0;
const changing = terrain(() => tileRise), arrived = start(0, changing);
run(arrived, changing, parked, 3); tileRise = 1;
arrived.step(DT, parked, changing);
assert.ok(Math.abs(arrived.vUp) < 0.02 && arrived.air === 0, 'new finer tile reseats without launching');
assert.equal(run(arrived, changing, parked, 12), false, 'new finer tile settles back to sleep');

console.log(JSON.stringify({ check: 'crater drive', rows, maxStep, wallRollSpeed: rolling.speed, parkedAwake, result: 'OK' }, null, 2));
