// The rocks further out (past the near rocks the robot can bump into): one batch of small faceted stones drawn in a
// single call, so the ground keeps its scattered rocks to the horizon instead of ending in a circle round you.
//
// Same rock cells as the near rocks (lander.ts rockCell), so a rock stays where it is when it changes from a far
// stone into a near model: they cross-fade (screen-door, no sorting) between FAR_ROCKS.near and near + fadeM from the
// eye. Each stone is a low ellipsoid (7 x 5 facets, flat-shaded) turned at random, a little more than half above the
// dust, lit like the near rocks (Sun, hill shadow per stone, Earth and fill, same exposure), and it casts into the Sun
// shadow map (sunShadow.ts) like everything else.

import {
  Appearance, Cartesian3, ComponentDatatype, GeometryInstanceAttribute, Cartographic, ColorGeometryInstanceAttribute, EllipsoidGeometry, GeometryInstance, Material, Matrix3, Matrix4,
  Primitive, Quaternion, ShadowMode, VertexFormat, type BoundingSphere, type Viewer,
} from 'cesium';

export const FAR_ROCKS = {
  /** grown from nothing at this far from the eye to full size fadeM further (m; the near models shrink over the same
   *  band: lander.ts ROCK_FIELD.reach 26, faded over its last 30 %), out to far (m) */
  near: 18.2, fadeM: 7.8, far: 170,
  /** rebuilt round you when you have moved this far from where the batch was made (m) */
  rebuildM: 35,
  /** smallest stone kept far out (m across) */
  minD: 0.15,
  /** share of a stone's height under the dust */
  bury: 0.42,
};

/** the brightest stone tone (see update: per-stone tones are stored as a fraction of it) */
const TONE_MAX = 1.15;

export interface FarSpot { e: number; n: number; d: number; yaw: number; tilt: number; tiltAz: number; kind: number }

const VS = `
in vec3 position3DHigh;
in vec3 position3DLow;
in float batchId;
in vec4 color;
out vec3 v_positionEC;
out vec4 v_color;
void main() {
    vec4 p = czm_computePosition();
    // New fine ground tiles can arrive after this batch was made. Move the whole stone with its seat,
    // without rebuilding thousands of little meshes on the main thread.
    vec3 rise = UP * czm_batchTable_rise(batchId);
    p.xyz += rise;
    // grow out of the dust as the near rock model of the same rock shrinks into it (lander.ts rockSpots), and shrink
    // away at the far end: the whole stone at once, so there is no edge and no dither pattern
    vec3 c = czm_batchTable_centre(batchId) + rise - EYE; // (a per-stone value: Primitive's batch table)
    float dist = length(c);
    vec4 R = RANGE;
    float k = smoothstep(R.x, R.x + R.y, dist) * (1.0 - smoothstep(R.z * 0.8, R.z, dist));
    p.xyz = c + (p.xyz - c) * k;
    v_positionEC = (czm_modelViewRelativeToEye * p).xyz;
    v_color = color;
    gl_Position = czm_modelViewProjectionRelativeToEye * p;
}
`;

const FS = `
in vec3 v_positionEC;
in vec4 v_color;
void main() {
    float dist = length(v_positionEC);
    vec3 N = normalize(cross(dFdx(v_positionEC), dFdy(v_positionEC)));
    vec3 V = -v_positionEC / max(dist, 0.01);
    if (dot(N, V) < 0.0) N = -N;
    vec3 L = normalize(czm_viewRotation * rkSun());
    vec3 Ue = normalize(czm_viewRotation * rkUp());
    vec3 Le = normalize(czm_viewRotation * rkEarth());
    vec4 look = rkLook();
    float mu0 = max(dot(N, L), 0.0), mu = max(dot(N, V), 0.05);
    float a = degrees(acos(clamp(dot(L, V), -1.0, 1.0)));
    float limb = clamp(1.0 + a * (-0.019 + a * (2.42e-4 - 1.46e-6 * a)), 0.0, 1.0);
    float phase = look.x + (1.0 - look.x) * exp(-a / look.y) + look.z * exp(-a / 4.0);
    float sun = phase * (2.0 * limb * mu0 / (mu0 + mu) + (1.0 - limb) * mu0) * v_color.r;
    vec3 fill = rkEarthLight() * (0.25 + 0.75 * max(dot(N, Le), 0.0)) + rkAmbient() * (0.65 + 0.35 * dot(N, Ue));
    // A boulder seen against the Sun is not a flat black dot (Apollo photos): its shaded faces get the light of the
    // sunlit ground round it (strongest on faces turned down / sideways, more the higher the Sun), and its outline
    // catches a thin bright rim where the Sun grazes it from behind.
    float sinE = max(dot(L, Ue), 0.0);
    float bounce = 0.32 * sinE * (0.6 - 0.4 * dot(N, Ue)) * v_color.r;
    float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0) * smoothstep(95.0, 150.0, a) * smoothstep(-0.25, 0.25, dot(N, L)) * 0.9 * v_color.r;
    vec3 x = max((rkSunColor() * (sun + bounce + rim) + fill) * rkExposure(), vec3(0.0));
    vec3 disp = x * (1.0 + x * look.w) / (1.0 + x);
    out_FragColor = vec4(clamp(disp * (0.75 * TONE_MAX) * v_color.g, 0.0, 1.0), 1.0);
}
`;

// (the material only carries the uniforms: Material renames its uniforms, so these little readers hand them over)
const MAT_SRC = `
vec3 rkSun() { return u_sun; }
vec3 rkUp() { return u_up; }
vec3 rkEarth() { return u_earth; }
vec3 rkSunColor() { return u_sunColor; }
vec3 rkAmbient() { return u_ambient; }
vec3 rkEarthLight() { return u_earthLight; }
vec4 rkLook() { return u_look; }
float rkExposure() { return u_exposure; }
vec4 rkRange() { return u_range; }
vec3 rkEye() { return u_eye; }
czm_material czm_getMaterial(czm_materialInput materialInput) { return czm_getDefaultMaterial(materialInput); }
`;

/** The name Material gave one of its uniforms in the shader (it adds a number). */
function uName(m: Material, id: string): string {
  const keys = Object.keys((m as unknown as { _uniforms: Record<string, unknown> })._uniforms ?? {});
  return keys.find(k => new RegExp(`^${id}_\\d+$`).test(k)) ?? id;
}

const sA = new Cartesian3(), sB = new Cartesian3(), sC = new Cartesian3();
const sQ = new Quaternion(), sM3 = new Matrix3(), sCarto = new Cartographic();

export interface FarRocksEnv {
  /** where (m east / north of the landing spot) each stone lies: every stone in [r0, r1) m from (we, wn) */
  spots(we: number, wn: number, r0: number, r1: number): FarSpot[];
  /** the landing spot and its east / north / up (world) */
  origin: Cartesian3; east: Cartesian3; north: Cartesian3; up: Cartesian3;
  /** drawn ground height (m) under a place, or undefined */
  height(c: Cartographic): number | undefined;
  /** how much of the Sun a place sees past the hills (0..1) */
  vis(e: number, n: number): number;
  toCartographic(p: Cartesian3, out: Cartographic): Cartographic;
  fromHeight(c: Cartographic, h: number, out: Cartesian3): Cartesian3;
  /** a new batch is in (its stones' shadows can be drawn) */
  changed?: () => void;
}

export class FarRocks {
  private prim: Primitive | null = null;
  private next: Primitive | null = null;
  private at: [number, number] | null = null;
  private spotsNow: FarSpot[] = [];
  private groundNow: number[] = [];
  private reseatAt = 0;
  private reseatLeft = 0;
  private reseatAgain = false;
  private readonly offReseat: () => void;
  private readonly material: Material;
  private readonly appearance: Appearance;
  private readonly builtOrigin = new Cartesian3();
  private visSunAz = NaN;
  private visSunEl = NaN;
  /** stones in the batch now */
  count = 0;
  private readonly viewer: Viewer;
  private readonly env: FarRocksEnv;

  constructor(viewer: Viewer, env: FarRocksEnv) {
    this.viewer = viewer; this.env = env;
    this.material = new Material({
      fabric: {
        type: 'MoondaFarRocks',
        uniforms: {
          u_sun: new Cartesian3(1, 0, 0), u_up: new Cartesian3(1, 0, 0), u_earth: new Cartesian3(1, 0, 0),
          u_sunColor: new Cartesian3(1, 1, 1), u_ambient: new Cartesian3(0.03, 0.03, 0.035), u_earthLight: new Cartesian3(0.001, 0, 0),
          u_look: { x: 0, y: 1, z: 0, w: 0 }, u_exposure: 1, u_range: { x: FAR_ROCKS.near, y: FAR_ROCKS.fadeM, z: FAR_ROCKS.far, w: 0 },
          u_eye: new Cartesian3(0, 0, 0),
        },
        source: MAT_SRC,
      },
    });
    this.appearance = new Appearance({
      // (the vertex shader reads two of the material's uniforms by the names Material gave them)
      material: this.material, vertexShaderSource: VS.replace('EYE', uName(this.material, 'u_eye')).replace('RANGE', uName(this.material, 'u_range'))
        .replace('UP', uName(this.material, 'u_up'))
        .replace('in vec4 color;', `in vec4 color;\nuniform vec3 ${uName(this.material, 'u_eye')};\nuniform vec3 ${uName(this.material, 'u_up')};\nuniform vec4 ${uName(this.material, 'u_range')};`), fragmentShaderSource: FS.replace(/TONE_MAX/g, TONE_MAX.toFixed(3)), translucent: false, closed: true,
      renderState: { depthTest: { enabled: true }, cull: { enabled: true } },
    } as ConstructorParameters<typeof Appearance>[0]);
    this.offReseat = viewer.scene.postRender.addEventListener(() => this.seatOld());
  }

  /** The material's uniforms (Sun, light, exposure: copied from the near rocks each time they are lit). */
  get uniforms(): Record<string, unknown> { return this.material.uniforms as Record<string, unknown>; }

  /** You are at (we, wn): make a new batch round you when you have gone far enough (built off the main thread). */
  update(we: number, wn: number, force = false) {
    // (the landing spot's frame moved, see lander.ts RECENTRE_M: the stones' places are relative to it)
    if (!Cartesian3.equals(this.builtOrigin, this.env.origin)) force = true;
    if (!force && this.at && Math.hypot(we - this.at[0], wn - this.at[1]) < FAR_ROCKS.rebuildM) return;
    if (this.next) return; // one at a time
    const E = this.env;
    const spots = E.spots(we, wn, FAR_ROCKS.near - FAR_ROCKS.rebuildM, FAR_ROCKS.far + FAR_ROCKS.rebuildM).filter(s => s.d >= FAR_ROCKS.minD);
    const instances: GeometryInstance[] = [];
    const geom = new EllipsoidGeometry({ radii: new Cartesian3(1, 1, 1), slicePartitions: 7, stackPartitions: 5, vertexFormat: VertexFormat.POSITION_ONLY });
    const kept: FarSpot[] = [];
    const grounds: number[] = [];
    for (const s of spots) {
      const W = Cartesian3.add(E.origin, Cartesian3.add(Cartesian3.multiplyByScalar(E.east, s.e, sA), Cartesian3.multiplyByScalar(E.north, s.n, sB), sB), sC);
      const c = E.toCartographic(W, sCarto);
      const g = E.height(c);
      if (g === undefined) continue;
      // a stone: a bit longer than wide, low (height ~45 % of its width), turned and leaning at random
      const rx = 0.5 * s.d * (0.85 + 0.3 * ((s.kind * 0.37) % 1)), ry = 0.5 * s.d * (0.7 + 0.25 * ((s.kind * 0.61) % 1)), rz = 0.5 * s.d * 0.45;
      const base = E.fromHeight(c, g + rz * (1 - 2 * FAR_ROCKS.bury), new Cartesian3());
      const up = E.up, east = E.east, north = E.north;
      // local frame (east, north, up) turned by yaw, then a small lean
      const cy = Math.cos(s.yaw), sy = Math.sin(s.yaw);
      const X = new Cartesian3(east.x * cy + north.x * sy, east.y * cy + north.y * sy, east.z * cy + north.z * sy);
      const Y = Cartesian3.cross(up, X, new Cartesian3());
      Quaternion.fromAxisAngle(Cartesian3.normalize(Cartesian3.add(Cartesian3.multiplyByScalar(X, Math.cos(s.tiltAz), sA), Cartesian3.multiplyByScalar(Y, Math.sin(s.tiltAz), sB), sA), sA), s.tilt, sQ);
      const lean = Matrix3.fromQuaternion(sQ, sM3);
      const cols = [X, Y, up].map((v, i) => Cartesian3.multiplyByScalar(Matrix3.multiplyByVector(lean, v, new Cartesian3()), [rx, ry, rz][i], new Cartesian3()));
      const m = new Matrix4(
        cols[0].x, cols[1].x, cols[2].x, base.x,
        cols[0].y, cols[1].y, cols[2].y, base.y,
        cols[0].z, cols[1].z, cols[2].z, base.z,
        0, 0, 0, 1);
      // (stored in a byte, 0..1: over 1 it wrapped round to near 0 and drew ~40 % of the stones black, the
      // "dark dots"; the shader multiplies by TONE_MAX)
      const tone = (0.82 + 0.3 * ((s.kind * 0.173 + s.yaw * 0.21) % 1)) / TONE_MAX;
      instances.push(new GeometryInstance({
        geometry: geom, modelMatrix: m, id: kept.length,
        attributes: {
          color: new ColorGeometryInstanceAttribute(this.env.vis(s.e, s.n), tone, 0, 1),
          centre: new GeometryInstanceAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, value: [base.x - E.origin.x, base.y - E.origin.y, base.z - E.origin.z] }),
          rise: new GeometryInstanceAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 1, value: [0] }),
        },
      }));
      kept.push(s);
      grounds.push(g);
    }
    this.at = [we, wn];
    Cartesian3.clone(E.origin, this.builtOrigin);
    if (!instances.length) return;
    const p = new Primitive({
      geometryInstances: instances, appearance: this.appearance, asynchronous: true, shadows: ShadowMode.ENABLED,
      allowPicking: false, compressVertices: false, releaseGeometryInstances: true, interleave: true, cull: true,
    });
    this.next = p;
    this.viewer.scene.primitives.add(p);
    p.show = false;
    const off = this.viewer.scene.postRender.addEventListener(() => {
      if (p.isDestroyed() || this.next !== p) { off(); return; }
      if (p.ready) { off(); this.swapIn(p, kept, grounds); } else this.viewer.scene.requestRender();
    });
    this.viewer.scene.requestRender();
  }

  private swapIn(p: Primitive, kept: FarSpot[], grounds: number[]) {
    if (this.next !== p || p.isDestroyed()) return;
    if (this.prim) this.viewer.scene.primitives.remove(this.prim);
    this.prim = p; this.next = null; this.spotsNow = kept; this.groundNow = grounds; this.count = kept.length;
    this.reseatLeft = 0; this.reseatAgain = false;
    // Primitive's worker has finished: its aggregate bounds are now in world metres. The custom
    // shader can lift seats by a few metres, which Cesium cannot infer. Pad the source and cached
    // bounds once before showing the batch. These private names are checked against Cesium 1.147's
    // Primitive._updateBoundingVolumes; changing its model matrix later still keeps the padding.
    const bounded = p as unknown as { _boundingSpheres?: BoundingSphere[]; _boundingSphereWC?: BoundingSphere[]; _boundingSphereCV?: BoundingSphere[]; _boundingSphere2D?: BoundingSphere[]; _boundingSphereMorph?: BoundingSphere[] };
    const bounds = new Set([...(bounded._boundingSpheres ?? []), ...(bounded._boundingSphereWC ?? []), ...(bounded._boundingSphereCV ?? []), ...(bounded._boundingSphere2D ?? []), ...(bounded._boundingSphereMorph ?? [])]);
    for (const sphere of bounds) sphere.radius += 32;
    p.show = true;
    this.visSunAz = NaN; // the hill shadows were worked out when the batch was made: check them again
    this.env.changed?.();
    this.reseat();
    this.viewer.scene.requestRender();
  }

  /** The drawn ground changed: re-seat existing stones in short chunks, then stop asking for frames. */
  reseat() {
    if (!this.prim?.ready) return;
    if (this.reseatLeft) { this.reseatAgain = true; return; }
    this.reseatAt = 0; this.reseatLeft = this.spotsNow.length;
    if (this.reseatLeft) this.viewer.scene.requestRender();
  }

  private seatOld() {
    const p = this.prim, E = this.env;
    if (!p?.show || !p.ready || !this.reseatLeft) return;
    const until = performance.now() + 0.8;
    do {
      const i = this.reseatAt++, s = this.spotsNow[i];
      const W = Cartesian3.add(E.origin, Cartesian3.add(Cartesian3.multiplyByScalar(E.east, s.e, sA), Cartesian3.multiplyByScalar(E.north, s.n, sB), sB), sC);
      const g = E.height(E.toCartographic(W, sCarto));
      if (g !== undefined) {
        const a = p.getGeometryInstanceAttributes(i) as { rise: Float32Array } | undefined;
        if (a) {
          const rise = a.rise, delta = g - this.groundNow[i];
          if (Math.abs(rise[0] - delta) > 0.002) { rise[0] = delta; a.rise = rise; }
        }
      }
      this.reseatLeft--;
    } while (this.reseatLeft && performance.now() < until);
    if (this.reseatLeft) this.viewer.scene.requestRender();
    else if (this.reseatAgain) { this.reseatAgain = false; this.reseat(); }
  }

  /** The stones in the batch now (m east / north of the landing spot, size): their short shadows are drawn into the
   *  ground's rock-shadow picture (lander.ts rasterRocks), so they still have one past the Sun shadow map's reach. */
  get casters(): readonly FarSpot[] { return this.spotsNow; }

  /** The Sun moved: work out again which stones a hill shades (only when it moved enough to matter). */
  relight(sunAzDeg: number, sunElDeg: number) {
    const p = this.prim;
    if (!p || !p.ready) return;
    if (Math.abs(sunAzDeg - this.visSunAz) < 0.3 && Math.abs(sunElDeg - this.visSunEl) < 0.1) return;
    this.visSunAz = sunAzDeg; this.visSunEl = sunElDeg;
    this.spotsNow.forEach((s, i) => {
      const a = p.getGeometryInstanceAttributes(i) as { color: Uint8Array } | undefined;
      if (!a) return;
      const c = a.color;
      const v = Math.round(this.env.vis(s.e, s.n) * 255);
      if (c[0] !== v) { c[0] = v; a.color = c; }
    });
  }

  /** Each frame: where the camera is (the stones grow and shrink with their distance from it). */
  frame(camera: Cartesian3) {
    Cartesian3.subtract(camera, this.env.origin, this.uniforms.u_eye as Cartesian3);
  }

  show(on: boolean) {
    if (this.prim) this.prim.show = on;
    if (!on) { this.at = null; this.reseatLeft = 0; this.reseatAgain = false; }
  }

  destroy() {
    this.offReseat();
    const P = this.viewer.scene.primitives;
    if (this.prim) P.remove(this.prim);
    if (this.next) P.remove(this.next);
    this.prim = this.next = null;
    this.material.destroy();
  }
}
