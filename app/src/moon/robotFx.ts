// MOONDA the robot's moving parts and effects (see walk.ts for how it drives, lander.ts for where it is drawn):
//   - RobotRig: turns the six wheels (split into their own nodes by data-prep/rover/split-wheels.mjs) about their
//     axles and moves each one up and down with its spring; turns the solar panel (data-prep/rover/add-solar.mjs)
//     towards the Sun and folds it flat when the Sun is gone; the two lamps on the camera head.
//   - Dust: the grains the wheels throw. The Moon has no air, so there are no clouds and nothing billows: each
//     grain flies on a clean arc and falls straight back down (the "rooster tails" of the Apollo rover films).
//     One point collection, a hard cap on grains, nothing at all when parked.
//   (The robot's shadow is the Sun shadow map in sunShadow.ts.)

import * as Cesium from 'cesium';
import { Cartesian3, Color, Matrix4, type Model, type Scene } from 'cesium';
import { DRIVE, WHEELS, WHEEL_AXLE_Y, type Driver } from './walk';

type ModelNode = { matrix: Matrix4; show: boolean };

const G = 1.62;
const s1 = new Cartesian3(), s2 = new Cartesian3(), s3 = new Cartesian3();
const q1 = new Cesium.Quaternion(), m3 = new Cesium.Matrix3();

/** The solar panel: how fast it turns and tilts (deg/s), its steepest tilt (deg), and the model's pivot (model m). */
export const PANEL = { yawRate: 28, tiltRate: 16, tiltMax: 55 };

export class RobotRig {
  private wheels: { node: ModelNode; rest: Matrix4 }[] = [];
  private yaw: { node: ModelNode; rest: Matrix4 } | null = null;
  private tilt: { node: ModelNode; rest: Matrix4 } | null = null;
  private m = new Matrix4();
  panelYaw = 0;
  panelTilt = 0;

  constructor(model: Model) {
    const get = (n: string) => {
      try { const node = model.getNode(n) as unknown as ModelNode | undefined; return node ? { node, rest: Matrix4.clone(node.matrix) } : null; } catch { return null; }
    };
    for (const w of WHEELS) { const g = get(w.name); if (g) this.wheels.push(g); }
    this.yaw = get('solar_yaw');
    this.tilt = get('solar_tilt');
  }

  get ok(): boolean { return this.wheels.length === 6; }

  /** how bright the headlights are now (0..1), for the lamp glow */
  lamps = 0;
  setLamps(k: number) { this.lamps = k; }

  /** Wheels from the driver: spin about the model's X axis, lift along its Y (model units = m / scale). */
  pose(d: Driver) {
    if (!this.ok) return;
    const S = DRIVE.scale;
    for (let i = 0; i < 6; i++) {
      const w = this.wheels[i];
      Cesium.Quaternion.fromAxisAngle(Cartesian3.UNIT_X, d.wheelSpin[i], q1);
      Cesium.Matrix3.fromQuaternion(q1, m3);
      Matrix4.fromRotationTranslation(m3, Cartesian3.fromElements(0, d.wheelLift[i] / S, 0, s1), this.m);
      w.node.matrix = Matrix4.multiply(w.rest, this.m, new Matrix4());
    }
  }

  /**
   * Turn the panel towards the Sun. `sun` is the direction to the Sun (world), `lit` whether the Sun is up and
   * shining here. The panel faces up (+Y) folded; it turns about +Y and tilts about +X. True while it moves.
   */
  stepPanel(dt: number, d: Driver, sun: Cartesian3, lit: boolean): boolean {
    if (!this.yaw || !this.tilt) return false;
    // the Sun in the model's frame: +X = the robot's left, +Y = up, +Z = forward
    const sx = -Cartesian3.dot(sun, d.right), sy = Cartesian3.dot(sun, d.bodyUp), sz = Cartesian3.dot(sun, d.fwd);
    let wantYaw = this.panelYaw, wantTilt = 0;
    if (lit && sy > -0.05) {
      wantYaw = Math.atan2(sx, sz) * 180 / Math.PI;
      wantTilt = Math.min(PANEL.tiltMax, Math.acos(Math.max(-1, Math.min(1, sy))) * 180 / Math.PI);
    }
    // folding flat: once nearly flat it may turn back to face forward
    if (!lit && this.panelTilt < 3) wantYaw = 0;
    let dy = ((wantYaw - this.panelYaw + 540) % 360) - 180;
    // the joint does not go round and round: past +-170 it turns the long way
    if (Math.abs(this.panelYaw + dy) > 170) dy = dy > 0 ? dy - 360 : dy + 360;
    const dTilt = wantTilt - this.panelTilt;
    const my = PANEL.yawRate * dt, mt = PANEL.tiltRate * dt;
    // tilt goes flat first when it has to turn far
    const turnFar = Math.abs(dy) > 25 && this.panelTilt > 8;
    this.panelYaw += turnFar ? 0 : Math.max(-my, Math.min(my, dy));
    this.panelTilt += turnFar ? -Math.min(mt, this.panelTilt) : Math.max(-mt, Math.min(mt, dTilt));
    const D = Math.PI / 180;
    Cesium.Quaternion.fromAxisAngle(Cartesian3.UNIT_Y, this.panelYaw * D, q1);
    this.yaw.node.matrix = Matrix4.multiply(this.yaw.rest, Matrix4.fromRotationTranslation(Cesium.Matrix3.fromQuaternion(q1, m3), Cartesian3.ZERO, this.m), new Matrix4());
    Cesium.Quaternion.fromAxisAngle(Cartesian3.UNIT_X, this.panelTilt * D, q1);
    this.tilt.node.matrix = Matrix4.multiply(this.tilt.rest, Matrix4.fromRotationTranslation(Cesium.Matrix3.fromQuaternion(q1, m3), Cartesian3.ZERO, this.m), new Matrix4());
    return Math.abs(dy) > 0.2 || Math.abs(dTilt) > 0.2;
  }
}

// ---------------------------------------------------------------------------------------------
// Dust

/** How much dust: the most grains in the air, grains per metre a wheel rolls at speed, sizes (px). */
export const DUST = { max: 700, maxLight: 300, perM: 26, size: [1.2, 2.6] as readonly number[] };

interface Grain { x: number; y: number; z: number; vx: number; vy: number; vz: number; ux: number; uy: number; uz: number; gx: number; gy: number; gz: number; t: number; life: number; size: number; tone: number; landed: number }

/** Light for the grains, set by the lander each frame. */
export interface DustLight {
  /** direction to the Sun (world) and how much of it reaches the robot (0..1) */
  sun: Cartesian3; vis: number;
  /** camera position (world), the screen exposure, the headlights (0..1) with where they sit and point (world) */
  eye: Cartesian3; exposure: number;
  lamp: number; lampPos: Cartesian3; lampDir: Cartesian3;
}

export class Dust {
  private pts: Cesium.PointPrimitiveCollection;
  private free: Cesium.PointPrimitive[] = [];
  private live: { g: Grain; p: Cesium.PointPrimitive }[] = [];
  private carry = new Float64Array(6);
  private rnd = 1234567;
  private cap: number;
  private c = new Color();
  private warmDone = false;
  private warmPoint: Cesium.PointPrimitive | null = null;
  private warmColour = new Color();
  private warmSize = 2;
  private warmAnchor = new Cartesian3();
  private offWarmPrepare: (() => void) | null = null;
  private offWarm: (() => void) | null = null;

  private scene: Scene;

  constructor(scene: Scene, light: boolean) {
    this.scene = scene;
    this.cap = light ? DUST.maxLight : DUST.max;
    this.pts = new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT });
    scene.primitives.add(this.pts);
    for (let i = 0; i < this.cap; i++) {
      const p = this.pts.add({ show: false, pixelSize: 2, color: Color.GRAY, scaleByDistance: new Cesium.NearFarScalar(1.5, 1.5, 25, 0.6) });
      this.free.push(p);
    }
  }

  get count(): number { return this.live.length; }

  /** Bind the dust shader once under the curtain; this is not an emitted grain. */
  warmGpu(at: Cartesian3): void {
    if (this.warmDone || this.warmPoint) return;
    this.ensureGlows();
    // Unused points start at the Moon's centre. Seating the pool here also avoids an enormous
    // bounding sphere stretching from the centre to the rover when its first grain appears.
    for (const point of this.free) point.position = at;
    for (const point of this.glows) if (!point.show) point.position = at;
    const point = this.free.pop();
    if (!point) return;
    this.warmPoint = point;
    Cartesian3.clone(at, this.warmAnchor);
    Color.clone(point.color, this.warmColour); this.warmSize = point.pixelSize;
    point.position = at; point.pixelSize = 1; point.color = new Color(1, 1, 1, 0.001); point.show = true;
    // Use the final camera for this frame. A point at the wheels could be outside its view and
    // get culled before its shader is ever bound. The curtain hides this one faint warm-up pixel.
    this.offWarmPrepare = this.scene.preRender.addEventListener(() => {
      const camera = this.scene.camera;
      point.position = Cartesian3.add(camera.positionWC, Cartesian3.multiplyByScalar(camera.directionWC, 2, s1), s1);
    });
    this.offWarm = this.scene.postRender.addEventListener(() => this.finishWarm(true));
    this.scene.requestRender();
  }

  get gpuWarm(): boolean { return this.warmDone; }

  private finishWarm(drawn: boolean): void {
    this.offWarm?.(); this.offWarm = null;
    this.offWarmPrepare?.(); this.offWarmPrepare = null;
    const point = this.warmPoint;
    if (!point) return;
    point.show = false; point.color = this.warmColour; point.pixelSize = this.warmSize; point.position = this.warmAnchor;
    this.free.push(point); this.warmPoint = null;
    if (drawn) this.warmDone = true;
  }

  /** The two lamps on the camera head: a small hot core and a soft halo each, brightness k (0..1). */
  private glows: Cesium.PointPrimitive[] = [];
  private ensureGlows() {
    if (!this.glows.length) for (let i = 0; i < 4; i++) this.glows.push(this.pts.add({ show: false, pixelSize: 4, color: Color.WHITE, scaleByDistance: new Cesium.NearFarScalar(1, 1.4, 30, 0.35) }));
  }
  glow(a: Cartesian3, b: Cartesian3, k: number) {
    this.ensureGlows();
    const on = k > 0.01;
    this.glows.forEach((p, i) => {
      if (p.show !== on) p.show = on;
      if (!on) return;
      p.position = i % 2 ? b : a;
      const core = i < 2;
      // (a near-white halo, small: a warm, wide one read as orange dots from far away)
      p.pixelSize = core ? 3 + 2 * k : 7 + 5 * k;
      p.color = core ? new Color(1, 0.98, 0.94, Math.min(1, k * 1.2)) : new Color(1, 0.97, 0.92, 0.14 * k);
    });
  }
  setCap(light: boolean) { this.cap = Math.min(light ? DUST.maxLight : DUST.max, this.live.length + this.free.length); }

  private r(): number { this.rnd = (this.rnd * 16807) % 2147483647; return this.rnd / 2147483647; }

  /**
   * Throw grains from the wheels of `d` (call every frame while it drives), more with speed, a burst on a hard
   * start, a slide or a landing. Then move every grain and light it. True while any grain is in the air.
   */
  step(dt: number, d: Driver | null, L: DustLight): boolean {
    if (d) this.emit(dt, d);
    if (!this.live.length) return false;
    const sunVis = L.vis;
    for (let k = this.live.length - 1; k >= 0; k--) {
      const { g, p } = this.live[k];
      g.t += dt;
      if (!g.landed) {
        g.vx -= g.ux * G * dt; g.vy -= g.uy * G * dt; g.vz -= g.uz * G * dt;
        g.x += g.vx * dt; g.y += g.vy * dt; g.z += g.vz * dt;
        // fell back to the ground (the plane it left from): it settles and fades
        if ((g.x - g.gx) * g.ux + (g.y - g.gy) * g.uy + (g.z - g.gz) * g.uz < 0) g.landed = g.t;
      }
      const fade = g.landed ? 1 - (g.t - g.landed) / 0.35 : Math.min(1, g.t / 0.05);
      if (fade <= 0 || g.t > g.life) { p.show = false; this.free.push(p); this.live[k] = this.live[this.live.length - 1]; this.live.pop(); continue; }
      // lit by the Sun: fine grains scatter forward, so they shine when the Sun is behind them (back-lit)
      Cartesian3.fromElements(g.x - L.eye.x, g.y - L.eye.y, g.z - L.eye.z, s1);
      const dist = Cartesian3.magnitude(s1);
      const back = Math.max(0, Cartesian3.dot(s1, L.sun) / Math.max(dist, 1e-3));
      // ...but not inside the robot's own shadow (a ball about the size of its body stands in for it): there a
      // grain is as dark as the ground under it, not a white speck
      let shade = 1;
      if (d) {
        const R = 1.5 * DRIVE.scale, hC = 1.0 * DRIVE.scale;
        const cx = d.feet.x + d.up.x * hC - g.x, cy = d.feet.y + d.up.y * hC - g.y, cz = d.feet.z + d.up.z * hC - g.z;
        const along = cx * L.sun.x + cy * L.sun.y + cz * L.sun.z;
        if (along > 0) {
          const off = Math.sqrt(Math.max(0, cx * cx + cy * cy + cz * cz - along * along));
          shade = 0.08 + 0.92 * Math.min(1, Math.max(0, (off - 0.7 * R) / (0.5 * R)));
        }
      }
      // (the same soil as the ground: about as bright as sunlit ground, brighter only when back-lit)
      let b = sunVis * shade * (0.8 + 3 * back ** 6) * 0.5;
      // the headlights
      if (L.lamp > 0) {
        Cartesian3.fromElements(g.x - L.lampPos.x, g.y - L.lampPos.y, g.z - L.lampPos.z, s2);
        const ld = Cartesian3.magnitude(s2), cosA = Cartesian3.dot(s2, L.lampDir) / Math.max(ld, 1e-3);
        if (cosA > 0.6) b += L.lamp * 1.4 * Math.min(1, (cosA - 0.6) / 0.25) / (1 + ld * ld * 0.15);
      }
      b = b * L.exposure * g.tone;
      const v = b / (1 + b); // soft roll-off like the screen's
      this.c.red = v * 0.98; this.c.green = v * 0.97; this.c.blue = v * 0.95;
      this.c.alpha = Math.max(0, Math.min(1, fade)) * (0.3 + 0.5 * Math.min(1, v * 3));
      p.color = this.c;
      p.position = Cartesian3.fromElements(g.x, g.y, g.z, s3);
    }
    return this.live.length > 0;
  }

  private emit(dt: number, d: Driver) {
    const S = DRIVE.scale;
    const burst = Math.min(3, d.slip * 0.8 + (d.landed ? d.landed * 3 : 0));
    for (let i = 0; i < 6; i++) {
      if (!d.wheelOn[i]) { this.carry[i] = 0; continue; }
      const v = d.wheelSpeed[i], av = Math.abs(v);
      if (av < 0.15 && burst < 0.05) continue;
      // grains this frame: with the distance the tread churns, more as it goes faster, plus bursts
      this.carry[i] += (DUST.perM * av * Math.min(1, av / 1.5) * (1 + burst) + burst * 60) * dt * (i % 3 === 1 ? 0.6 : 1);
      let n = Math.floor(this.carry[i]);
      this.carry[i] -= n;
      const c = d.wheelContact(i, s1);
      const U = d.up, F = d.fwd, R = d.right, back = v >= 0 ? -1 : 1;
      while (n-- > 0 && this.free.length && this.live.length < this.cap) {
        const p = this.free.pop()!;
        // thrown backwards off the top-rear of the tread, 15..55 degrees up, at a share of the wheel's speed
        const el = (15 + this.r() * 40) * Math.PI / 180, sp = Math.max(0.35, av * (0.25 + this.r() * 0.45) + burst * 0.4 * this.r());
        const side = (this.r() - 0.5) * 0.5 + (WHEEL_SIDE[i] * 0.15);
        const h = Math.cos(el) * sp, vu = Math.sin(el) * sp;
        const vx = F.x * back * h + R.x * side * sp + U.x * vu, vy = F.y * back * h + R.y * side * sp + U.y * vu, vz = F.z * back * h + R.z * side * sp + U.z * vu;
        // starting at the back of the wheel, a little above the ground
        const ox = F.x * back * 0.1 * S + U.x * 0.03, oy = F.y * back * 0.1 * S + U.y * 0.03, oz = F.z * back * 0.1 * S + U.z * 0.03;
        const g: Grain = {
          x: c.x + ox, y: c.y + oy, z: c.z + oz, vx: vx + F.x * d.speed * 0.3, vy: vy + F.y * d.speed * 0.3, vz: vz + F.z * d.speed * 0.3,
          ux: U.x, uy: U.y, uz: U.z, gx: c.x, gy: c.y, gz: c.z, t: 0, life: 4, landed: 0,
          size: DUST.size[0] + this.r() * (DUST.size[1] - DUST.size[0]), tone: 0.7 + this.r() * 0.6,
        };
        p.pixelSize = g.size;
        p.show = true;
        this.live.push({ g, p });
      }
    }
  }

  clear() { this.finishWarm(false); for (const { p } of this.live) { p.show = false; this.free.push(p); } this.live.length = 0; }
  destroy() { this.clear(); this.scene.primitives.remove(this.pts); }
}
/** + = the wheel is on the right side (grains fan outwards a little) */
const WHEEL_SIDE = WHEELS.map(w => (w.x < 0 ? 1 : -1));
void WHEEL_AXLE_Y;
