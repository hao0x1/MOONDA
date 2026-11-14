// MOONDA's wheel tracks: two lines of pressed, darker soil behind the robot.
//
// One small ribbon per side of the robot, laid on the drawn ground as it drives (a new cross-section every
// STEP metres, kept in a ring buffer so the oldest part is reused: no new GPU memory while driving, only a few
// floats uploaded per section). Each ribbon holds the two wheel prints of its side (front/back wheels and the
// middle wheel, which runs 6 cm further out), with grouser marks and a low berm of pushed-up soil at the edges.
//
// How it is drawn: the ribbon MULTIPLIES the ground already on screen ("2x modulate" blending: result =
// ground x 2 x colour; colour 0.5 = no change). So a track inside a shadow stays as dark as the shadow, the
// headlight beam lights a track like the ground round it, and the ground shader is not touched at all. The
// relief (pressed middle, berm edges, grousers) is lit by the real Sun direction: the berm face that turns to
// the Sun gets a hint of brightness, the far wall of each print a little shade. It fades out over the far end
// of what is kept, with distance from the camera (no shimmering threads far away) and where the wheels of a
// side were in the air (no prints under a hop).

import * as CesiumAll from 'cesium';
import { BoundingSphere, Cartesian3, Matrix4, WebGLConstants, type Scene } from 'cesium';
import { createMesh, type GlBuffer, type GlContext, type GlDrawCommand, type GlShaderProgram, type Mesh } from './sky/gl';
import { ROBOT_SCALE, WHEELS, type Driver, type WalkEnv } from './walk';

/** The knobs: section spacing (m), how much track is kept (m) and over how much of its far end it fades (m). */
export const TRACKS = {
  step: 0.16, keep: 360, fade: 140,
  stepLight: 0.26, keepLight: 180, fadeLight: 80,
  /** lifted above the drawn ground (m), so it never sinks into a triangle of it */
  lift: 0.03,
  /** how strong it is: albedo of the pressed soil (1 = unchanged), relief strength */
  pressed: 0.82, relief: 0.85,
  /** fade with camera distance (m) */
  near: 22, far: 75,
};

const S = ROBOT_SCALE;
/** the sphere walk.ts measures ground heights from (m) */
const MOON_R_M = 1737400;
/** wheel width at this scale (m) and the print centres (m out from the robot's middle line) */
const WHEEL_W = 0.4 * S;
const C_OUT = Math.abs(WHEELS[1].x) * S, C_IN = Math.abs(WHEELS[0].x) * S; // middle wheel / front+back wheels
/** the ribbon spans these distances out from the middle line (prints plus a berm each side) */
const X0 = C_IN - WHEEL_W / 2 - 0.05, X1 = C_OUT + WHEEL_W / 2 + 0.05;

interface Private {
  ShaderProgram: { fromCache(o: object): GlShaderProgram };
  RenderState: { fromCache(o: object): object };
  DrawCommand: new (o: object) => GlDrawCommand & { boundingVolume: BoundingSphere };
  Pass: { OPAQUE: number };
}
const P = CesiumAll as unknown as Private;

const VS = /* glsl */ `
in vec3 a_pos;
in vec3 a_aux;     // x: 0 inner edge .. 1 outer edge, y: distance along the track (m), z: wheels on the ground (0..1)
in vec3 a_out;     // unit vector pointing away from the robot's middle line (world)
uniform mat4 u_mv;
out vec3 v_aux;
out vec3 v_out;
out vec3 v_pos;
void main() {
  v_aux = a_aux; v_out = a_out; v_pos = a_pos;
  gl_Position = czm_projection * (u_mv * vec4(a_pos, 1.0));
}`;

const FS = /* glsl */ `
uniform vec3 u_up;
uniform vec3 u_sun;
uniform vec3 u_eye;     // camera, relative to the ribbon origin
uniform vec4 u_k;       // x: newest distance along, y: kept length, z: fade length, w: overall strength
uniform vec4 u_look;    // x: pressed albedo, y: relief, z: near fade, w: far fade
in vec3 v_aux;
in vec3 v_out;
in vec3 v_pos;
const float X0 = ${X0.toFixed(4)}, X1 = ${X1.toFixed(4)}, CI = ${C_IN.toFixed(4)}, CO = ${C_OUT.toFixed(4)}, HW = ${(WHEEL_W / 2).toFixed(4)};

// one wheel print across x (m from its centre): pressed floor, soft walls, a low berm outside
float print1(float d) {
  float a = abs(d);
  float floorK = 1.0 - smoothstep(HW - 0.025, HW + 0.005, a);
  float berm = smoothstep(HW - 0.01, HW + 0.02, a) * (1.0 - smoothstep(HW + 0.02, HW + 0.06, a));
  return -floorK + 0.55 * berm;
}
// height of the soil across the ribbon (arbitrary units, about 1 cm per unit) and along it (grousers)
float soil(float x, float s, float fine) {
  float hi = print1(x - CI), ho = print1(x - CO);
  float h = min(hi, ho);
  if (hi > 0.0 && ho > 0.0) h = max(hi, ho);
  // grousers: chevrons every 5 cm inside the prints, faded out where they would be smaller than a pixel
  float inside = clamp(-min(hi, ho), 0.0, 1.0);
  float g = s / 0.052 + abs(x - (x < 0.5 * (CI + CO) ? CI : CO)) * 6.0;
  h += inside * 0.5 * fine * (abs(fract(g) - 0.5) * 2.0 - 0.5);
  // the soil is not pressed evenly: a slow wobble along the track
  h *= 0.8 + 0.2 * sin(s * 2.3 + sin(s * 0.7) * 2.0);
  return h;
}
void main() {
  float x = mix(X0, X1, v_aux.x), s = v_aux.y, w = v_aux.z;
  // fade: far end of the kept track, wheels in the air, distance from the camera
  float age = u_k.x - s;
  float k = w * (1.0 - smoothstep(u_k.y - u_k.z, u_k.y, age)) * u_k.w;
  float dist = length(v_pos - u_eye);
  k *= 1.0 - smoothstep(u_look.z, u_look.w, dist);
  if (k < 0.004) discard;
  // detail that would shimmer is faded out by its size on screen
  float px = max(fwidth(s), fwidth(x));
  float fine = 1.0 - smoothstep(0.012, 0.03, px);
  // relief -> slopes across and along -> tilted normal, lit by the Sun relative to flat ground
  float e = 0.004;
  float h0 = soil(x, s, fine);
  float dx = (soil(x + e, s, fine) - h0) / e, ds = (soil(x, s + e, fine) - h0) / e;
  vec3 up = normalize(u_up), outw = normalize(v_out - up * dot(v_out, up));
  vec3 along = cross(up, outw);
  // the walls of the prints are a few cm wide: once a pixel is wider than that they would draw as one hard
  // bright / dark line along the track, so their relief fades and the track reads as a soft darker stripe
  float wall = mix(0.2, 1.0, 1.0 - smoothstep(0.012, 0.05, px));
  vec3 n = normalize(up - 0.010 * u_look.y * wall * (dx * outw + ds * along));
  float mu0 = dot(up, u_sun);
  float lit = mu0 > 0.02 ? clamp(max(dot(n, u_sun), 0.0) / max(mu0, 0.06), 0.0, 1.45) : 1.0;
  // pressed soil is darker; its edge is never sharper than a pixel and a half
  float soft = max(0.03, 1.5 * fwidth(x));
  float mI = 1.0 - smoothstep(HW - soft, HW + 0.4 * soft, abs(x - CI));
  float mO = 1.0 - smoothstep(HW - soft, HW + 0.4 * soft, abs(x - CO));
  float pressed = mix(1.0, u_look.x, max(mI, mO));
  float f = mix(1.0, pressed * lit, k);
  out_FragColor = vec4(vec3(0.5 * f), 1.0);
}`;

const sA = new Cartesian3(), sB = new Cartesian3(), sC = new Cartesian3(), sD = new Cartesian3(), sE = new Cartesian3();

/**
 * The wheel tracks. `step()` every frame while the robot is out; `clear()` when you leave or stand somewhere
 * else. Added to the scene as a primitive (it hands Cesium its draw commands each frame).
 */
export class WheelTracks {
  private scene: Scene;
  private n: number;               // sections in the ring
  private stepM: number; private keepM: number; private fadeM: number;
  private pos: Float32Array; private aux: Float32Array; private out: Float32Array;
  private mesh: Mesh | null = null;
  private cmds: (GlDrawCommand & { boundingVolume: BoundingSphere })[] = [];
  private program: GlShaderProgram | null = null;
  private head = 0;                // next section to write
  private count = 0;               // sections written (<= n)
  private origin = new Cartesian3();
  private last = new Cartesian3();
  private along = 0;
  private dirty: number[] = [];
  private lo = new Cartesian3(); private hi = new Cartesian3();
  private bound = new BoundingSphere();
  private mv = new Matrix4(); private tr = new Matrix4();
  private eye = new Cartesian3(); private up = new Cartesian3(0, 0, 1); private sun = new Cartesian3(0, 0, 1);
  private k = new CesiumAll.Cartesian4(0, 1, 1, 1);
  private look = new CesiumAll.Cartesian4(TRACKS.pressed, TRACKS.relief, TRACKS.near, TRACKS.far);
  private destroyed = false;
  private reseatEnv: WalkEnv | null = null;
  private reseatLeft = 0;
  private reseatAt = 0;
  private reseatAgain = false;
  private warmRequested = false;
  private warmDone = false;
  private offWarm: (() => void) | null = null;
  show = true;

  constructor(scene: Scene, light: boolean) {
    this.scene = scene;
    this.stepM = light ? TRACKS.stepLight : TRACKS.step;
    this.keepM = light ? TRACKS.keepLight : TRACKS.keep;
    this.fadeM = light ? TRACKS.fadeLight : TRACKS.fade;
    this.n = Math.ceil(this.keepM / this.stepM) + 2;
    const verts = this.n * 4; // two sides x two edges
    this.pos = new Float32Array(verts * 3); this.aux = new Float32Array(verts * 3); this.out = new Float32Array(verts * 3);
    scene.primitives.add(this);
  }

  /** Compile the real draw path under the curtain, without writing a track or moving the rover. */
  warmGpu(at: Cartesian3, up: Cartesian3, sun: Cartesian3): void {
    if (this.warmDone || this.warmRequested || this.destroyed) return;
    this.warmRequested = true;
    if (!this.count) Cartesian3.clone(at, this.origin);
    Cartesian3.clone(up, this.up); Cartesian3.clone(sun, this.sun);
    this.scene.requestRender();
  }

  get gpuWarm(): boolean { return this.warmDone; }

  private finishWarmAfterDraw(): void {
    if (this.warmDone || this.offWarm) return;
    this.offWarm = this.scene.postRender.addEventListener(() => {
      this.offWarm?.(); this.offWarm = null;
      this.warmRequested = false; this.warmDone = true;
      for (const cmd of this.cmds) (cmd as typeof cmd & { cull: boolean }).cull = true;
    });
  }

  /** Forget every track (leaving, or standing somewhere else). */
  clear() {
    this.offWarm?.(); this.offWarm = null; this.warmRequested = false;
    for (const cmd of this.cmds) (cmd as typeof cmd & { cull: boolean }).cull = true;
    this.count = 0; this.head = 0; this.along = 0; this.dirty.length = 0;
    this.reseatEnv = null; this.reseatLeft = 0; this.reseatAgain = false;
  }

  /** A finer ground tile arrived: put the old prints on its triangles too. Work is spread over frames. */
  reseat(env: WalkEnv) {
    if (!this.count) return;
    if (this.reseatLeft) { this.reseatAgain = true; return; }
    this.reseatEnv = env; this.reseatLeft = this.count; this.reseatAt = (this.head - 1 + this.n) % this.n;
    this.scene.requestRender();
  }

  private seatOld(camera: Cartesian3) {
    const env = this.reseatEnv;
    if (!env || !this.reseatLeft) return;
    const until = performance.now() + 0.8;
    do {
      const i = this.reseatAt, base = i * 12;
      Cartesian3.fromElements(this.origin.x + this.pos[base], this.origin.y + this.pos[base + 1], this.origin.z + this.pos[base + 2], sA);
      // The rest of the kept trail is already invisible. Do not ray-pick hundreds of hidden metres.
      if (Cartesian3.distance(camera, sA) < TRACKS.far + 10) {
        for (let v = 0; v < 4; v++) {
          const at = base + v * 3;
          Cartesian3.fromElements(this.origin.x + this.pos[at], this.origin.y + this.pos[at + 1], this.origin.z + this.pos[at + 2], sA);
          const h = env.ground(sA) + TRACKS.lift;
          Cartesian3.multiplyByScalar(Cartesian3.normalize(sA, sA), MOON_R_M + h, sA);
          const rel = Cartesian3.subtract(sA, this.origin, sB);
          this.pos[at] = rel.x; this.pos[at + 1] = rel.y; this.pos[at + 2] = rel.z;
          Cartesian3.minimumByComponent(this.lo, rel, this.lo); Cartesian3.maximumByComponent(this.hi, rel, this.hi);
        }
        this.dirty.push(i);
      }
      this.reseatAt = (i - 1 + this.n) % this.n;
      this.reseatLeft--;
    } while (this.reseatLeft && performance.now() < until);
    if (this.reseatLeft) this.scene.requestRender();
    else if (this.reseatAgain) { this.reseatAgain = false; this.reseat(env); }
    else this.reseatEnv = null;
  }

  /** Lay track under the robot as it moves. `sun` is the direction to the Sun (world). */
  step(d: Driver, env: WalkEnv, sun: Cartesian3) {
    Cartesian3.clone(sun, this.sun);
    const p = d.feet;
    if (this.count) {
      const moved = Cartesian3.distance(p, this.last);
      if (moved > 6) this.clear();          // put somewhere else: start afresh
      else if (moved < this.stepM) return;
      else this.along += moved;
    }
    if (!this.count) { Cartesian3.clone(p, this.origin); Cartesian3.clone(Cartesian3.ZERO, this.lo); Cartesian3.clone(Cartesian3.ZERO, this.hi); }
    Cartesian3.clone(p, this.last);
    const up = Cartesian3.normalize(p, sA);
    Cartesian3.clone(up, this.up);
    // the robot's right, flat on the ground
    const right = Cartesian3.subtract(d.right, Cartesian3.multiplyByScalar(up, Cartesian3.dot(d.right, up), sB), sB);
    Cartesian3.normalize(right, right);
    const i = this.head, base = i * 4;
    for (let side = 0; side < 2; side++) {
      const sgn = side ? 1 : -1;  // 0: left (-right), 1: right
      const wi = side ? 3 : 0;
      const on = (d.wheelOn[wi] + d.wheelOn[wi + 1] + d.wheelOn[wi + 2]) / 3;
      for (let edge = 0; edge < 2; edge++) {
        const x = edge ? X1 : X0, v = base + side * 2 + edge;
        const q = Cartesian3.add(p, Cartesian3.multiplyByScalar(right, sgn * x, sC), sC);
        const h = env.ground(q) + TRACKS.lift;
        Cartesian3.multiplyByScalar(Cartesian3.normalize(q, q), MOON_R_M + h, q);
        const rel = Cartesian3.subtract(q, this.origin, sD);
        this.pos[v * 3] = rel.x; this.pos[v * 3 + 1] = rel.y; this.pos[v * 3 + 2] = rel.z;
        Cartesian3.minimumByComponent(this.lo, rel, this.lo); Cartesian3.maximumByComponent(this.hi, rel, this.hi);
        this.aux[v * 3] = edge; this.aux[v * 3 + 1] = this.along; this.aux[v * 3 + 2] = on;
        const o = Cartesian3.multiplyByScalar(right, sgn, sE);
        this.out[v * 3] = o.x; this.out[v * 3 + 1] = o.y; this.out[v * 3 + 2] = o.z;
      }
    }
    this.dirty.push(i);
    this.head = (this.head + 1) % this.n;
    this.count = Math.min(this.count + 1, this.n);
  }

  private build(context: GlContext) {
    const n = this.n;
    const idx = new Uint32Array(n * 12);
    // segment j joins section j and j+1 (mod n): per side two triangles
    for (let j = 0; j < n; j++) {
      const a = j * 4, b = ((j + 1) % n) * 4, o = j * 12;
      for (let side = 0; side < 2; side++) {
        const a0 = a + side * 2, a1 = a0 + 1, b0 = b + side * 2, b1 = b0 + 1, k = o + side * 6;
        idx[k] = a0; idx[k + 1] = b0; idx[k + 2] = a1; idx[k + 3] = a1; idx[k + 4] = b0; idx[k + 5] = b1;
      }
    }
    this.mesh = createMesh(context, [
      { name: 'a_pos', data: this.pos, size: 3, dynamic: true },
      { name: 'a_aux', data: this.aux, size: 3, dynamic: true },
      { name: 'a_out', data: this.out, size: 3, dynamic: true },
    ], idx);
    this.program = P.ShaderProgram.fromCache({ context, vertexShaderSource: VS, fragmentShaderSource: FS, attributeLocations: this.mesh.locations });
    const renderState = P.RenderState.fromCache({
      depthTest: { enabled: true }, depthMask: false, cull: { enabled: false },
      // 2x modulate: result = ground * colour * 2 (colour 0.5 leaves it as it is); the picture's alpha stays
      blending: { enabled: true, functionSourceRgb: WebGLConstants.DST_COLOR, functionDestinationRgb: WebGLConstants.SRC_COLOR, functionSourceAlpha: WebGLConstants.ZERO, functionDestinationAlpha: WebGLConstants.ONE },
    });
    const uniformMap = {
      u_mv: () => this.mv, u_up: () => this.up, u_sun: () => this.sun, u_eye: () => this.eye, u_k: () => this.k, u_look: () => this.look,
    };
    for (let c = 0; c < 2; c++) {
      this.cmds.push(new P.DrawCommand({
        vertexArray: this.mesh.vertexArray, shaderProgram: this.program, renderState, uniformMap,
        primitiveType: WebGLConstants.TRIANGLES, pass: P.Pass.OPAQUE, owner: this, cull: true, boundingVolume: this.bound,
      }));
    }
  }

  /** Called by Cesium every frame. */
  update(frameState: { context: GlContext; commandList: unknown[]; camera: { viewMatrix: Matrix4; positionWC: Cartesian3 }; passes: { render: boolean } }) {
    if (!this.show || (this.count < 2 && !this.warmRequested) || !frameState.passes.render) return;
    this.seatOld(frameState.camera.positionWC);
    if (!this.mesh) this.build(frameState.context);
    const mesh = this.mesh!;
    // upload the new sections (a few floats each)
    for (const i of this.dirty) {
      const from = i * 12, to = from + 12;
      (mesh.buffers[0] as GlBuffer).copyFromArrayView(this.pos.subarray(from, to), from * 4);
      (mesh.buffers[1] as GlBuffer).copyFromArrayView(this.aux.subarray(from, to), from * 4);
      (mesh.buffers[2] as GlBuffer).copyFromArrayView(this.out.subarray(from, to), from * 4);
    }
    this.dirty.length = 0;
    // centred on the origin in double precision (the Moon is 1,737 km across: floats alone would wobble)
    Matrix4.multiply(frameState.camera.viewMatrix, Matrix4.fromTranslation(this.origin, this.tr), this.mv);
    Cartesian3.subtract(frameState.camera.positionWC, this.origin, this.eye);
    this.k.x = this.along; this.k.y = this.keepM; this.k.z = this.fadeM;
    const c = Cartesian3.midpoint(this.lo, this.hi, sA);
    Cartesian3.add(this.origin, c, this.bound.center);
    this.bound.radius = Cartesian3.distance(this.lo, this.hi) / 2 + 1;
    if (this.count < 2) {
      // Slots 1 and 2 have never been written when the buffer is cold. Their identical zero
      // positions make a triangle with no area, so the renderer binds all shader variants but
      // paints no soil. No dummy sections enter the history or the rover's ground sampling.
      const cmd = this.cmds[0];
      cmd.offset = 12; cmd.count = 6;
      (cmd as typeof cmd & { cull: boolean }).cull = false;
      frameState.commandList.push(cmd);
      this.finishWarmAfterDraw();
      return;
    }
    // the segments to draw: all but the one that would join the newest section to the oldest
    const n = this.n, newest = (this.head - 1 + n) % n;
    const ranges: [number, number][] = this.count < n ? [[0, this.count - 1]] : [[0, newest], [newest + 1, n]];
    ranges.forEach(([a, b], ci) => {
      if (b <= a) return;
      const cmd = this.cmds[ci];
      cmd.offset = a * 12; cmd.count = (b - a) * 12;
      frameState.commandList.push(cmd);
    });
    this.finishWarmAfterDraw();
  }

  isDestroyed() { return this.destroyed; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.offWarm?.(); this.offWarm = null; this.warmRequested = false;
    this.mesh?.vertexArray.destroy();
    this.program?.destroy();
  }
  /** take it out of the scene and free it */
  remove() { this.scene.primitives.remove(this); }
}
