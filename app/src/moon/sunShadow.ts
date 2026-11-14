// Real Sun shadows for "Stand here": one shadow map lit by the app's own (lunar) Sun.
//
// Cesium's ShadowMap renders every model that casts (the robot, the rocks) as seen from a light camera into a depth
// picture. We give it our OWN light camera, pointed along the real Sun direction (Cesium's default one follows an
// Earth Sun and fades it at that Sun's horizon: that was the "ground went black"). The light camera keeps a fixed
// basis for a given Sun and is moved only in whole texels, so shadow edges never crawl while you drive or look round.
//
// Receivers:
//   - the robot and the rocks: Cesium's own receive pass (soft 3x3 filter), normal shading off so their shaded sides
//     keep the fill light our shaders give them;
//   - the ground: NOT Cesium's pass (it multiplies the finished colour, earthshine included). The ground material
//     reads the depth picture itself (SUN_MAP_GLSL) and dims only the Sun term, with soft edges that widen with the
//     distance to the caster (the Sun is half a degree wide), and fades at the edge of the picture into the older
//     CPU rock-shadow picture, so rocks further out still have shadows.
//
// Plus a soft contact shadow under the wheels and the belly (CONTACT_GLSL): what stops the robot looking as if it floats.

import { Camera, Cartesian3, Cartesian4, Material, Matrix4, OrthographicOffCenterFrustum, ShadowMap, ShadowMode, type Model, type Viewer } from 'cesium';
import { ROBOT_SCALE, WHEELS, type Driver } from './walk';

export const SUN_SHADOW = {
  /** depth-picture size (texels per side) and half its width on the ground (m): Full detail / Smooth */
  full: { size: 4096, half: 34 }, light: { size: 2048, half: 26 },
  /** the picture is centred this share of its half-width ahead of the camera (so more of it is where you look) */
  ahead: 0.45,
  /** depth range along the sunbeam (m): casters up to half of it towards the Sun still count */
  depth: 400,
  /** shadow darkness on the robot and rocks (Cesium's receive pass multiplies the colour by this in full shadow) */
  darkness: 0.22,
  /** heights the picture allows round its centre (m), on top of the ground's own rise across it (share of half) */
  relief: 4, reliefK: 0.3,
  /** (testing) the ground reads the map */
  ground: true,
};
if (import.meta.env.DEV) (window as unknown as { __sunShadow: unknown }).__sunShadow = SUN_SHADOW; // for tuning from test scripts

/** Sun-map + contact-shadow GLSL for the ground material (uses uniforms lvShTex, lvShMat, lvShInfo, lvShScale, lvC*). */
export const SUN_MAP_GLSL = `
vec2 lvVogel(int i, float n, float rot) {
    float r = sqrt((float(i) + 0.5) / n);
    float t = float(i) * 2.39996323 + rot;
    return r * vec2(cos(t), sin(t));
}
// How much of the Sun reaches this point past the robot and the rocks (0..1), and (fw) how far inside the depth
// picture it is (1 inside, 0 at / past its edge). posEC: eye coordinates; N, L: normal and Sun direction (eye frame).
float lvSunMap(vec3 posEC, vec3 N, vec3 L, out float fw) {
    fw = 0.0;
    if (lvShInfo.x < 0.5) return 1.0;
    float nl = clamp(dot(N, L), 0.0, 1.0);
    // (normal offset: a texel and a half on faces that turn from the Sun; the ground does not cast, so no acne)
    vec4 s = lvShMat * vec4(posEC + N * (lvShInfo.w * 1.5 * (1.0 - nl)), 1.0);
    vec2 uv = s.xy;
    vec2 ed = min(uv, 1.0 - uv);
    fw = smoothstep(0.0, 0.06, min(ed.x, ed.y)) * step(s.z, 0.999);
    if (fw <= 0.0) return 1.0;
    float range = lvShInfo.y;
    float z = s.z - 0.015 / range;
    // a turn of the sample pattern fixed to the ground (per texel), so the soft edge never shimmers as you move
    vec2 tx = floor(uv * lvShScale.zw);
    float rot = 6.2831853 * fract(52.9829189 * fract(dot(tx, vec2(0.06711056, 0.00583715))));
    // 1. blockers within reach (the widest soft edge we draw): their mean distance from this point along the beam
    float sR = 0.28;
    float d0 = texture(lvShTex, uv).r;
    float bs = d0 < z ? d0 : 0.0, bn = d0 < z ? 1.0 : 0.0;
    for (int i = 0; i < 12; i++) {
        float d = texture(lvShTex, uv + lvVogel(i, 12.0, rot) * sR * lvShScale.xy).r;
        if (d < z) { bs += d; bn += 1.0; }
    }
    if (bn < 0.5) return 1.0;
    float gap = max(z - bs / bn, 0.0) * range; // m from the blocker to here, along the sunbeam
    // 2. soft edge as wide as the Sun's half-degree disc makes it at that distance (never under ~a texel)
    float pen = clamp(gap * 0.0093 * 0.5, lvShInfo.w * 1.25, sR);
    float lit = 0.0;
    for (int i = 0; i < 16; i++) lit += step(z, texture(lvShTex, uv + lvVogel(i, 16.0, rot) * pen * lvShScale.xy).r);
    return mix(1.0, lit / 16.0, lvShInfo.z);
}
// Soft darkening right under the robot: each wheel's footprint and the belly (en: m east / north, map frame).
float lvContact(vec2 en) {
    if (lvCInfo.x < 0.5) return 1.0;
    float ao = 1.0;
    vec2 w[6] = vec2[6](lvCw1.xy, lvCw1.zw, lvCw2.xy, lvCw2.zw, lvCw3.xy, lvCw3.zw);
    for (int i = 0; i < 6; i++) {
        float d = length(en - w[i]) / lvCInfo.y;
        ao *= mix(0.5, 1.0, smoothstep(0.25, 1.0, d));
    }
    vec2 q = en - lvCBody.xy;
    vec2 f = lvCBody.zw;
    vec2 loc = abs(vec2(dot(q, f), dot(q, vec2(f.y, -f.x)))) / lvCInfo.zw;
    float b = length(max(loc - 0.35, 0.0));
    ao *= mix(0.72, 1.0, smoothstep(0.0, 0.75, b));
    return mix(1.0, ao, lvCInfo.x);
}
`;

/** The uniforms SUN_MAP_GLSL needs, with their starting values (merged into the ground material's fabric). */
export function sunMapUniforms(): Record<string, unknown> {
  return {
    lvShTex: Material.DefaultImageId, lvShMat: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    // (lvShMat is an array: Material reads a mat4 from 16 numbers; a Matrix4 works later)
    lvShInfo: new Cartesian4(0, SUN_SHADOW.depth, 1, 0.02), lvShScale: new Cartesian4(1, 1, 1, 1),
    lvCInfo: new Cartesian4(0, 0.22, 0.75, 0.5), lvCw1: new Cartesian4(), lvCw2: new Cartesian4(), lvCw3: new Cartesian4(), lvCBody: new Cartesian4(0, 0, 0, 1),
  };
}

const sA = new Cartesian3(), sB = new Cartesian3(), sC = new Cartesian3(), sD = new Cartesian3();

export interface SunShadowFrame {
  /** shadows wanted now (standing, Sun up, ground material on) */
  on: boolean;
  /** unit vector towards the Sun, and the local up (world) */
  sun: Cartesian3; up: Cartesian3;
  /** a fixed point nearby (the landing spot): the texel grid is laid from it */
  origin: Cartesian3;
  /** ground point the picture is centred on, and the horizontal way the camera looks */
  centre: Cartesian3; look: Cartesian3;
  /** Sun height (deg) and how much of the Sun the centre sees past the hills (0..1) */
  sunEl: number; sunVis: number;
  light: boolean;
}

export class SunShadows {
  readonly map: ShadowMap;
  private readonly cam: Camera;
  private readonly frustum = new OrthographicOffCenterFrustum();
  private size = 0;
  private texSet: unknown = null;
  private prevShadowMap: ShadowMap | undefined;
  private installed = false;
  /** shadows were drawn on the last frame (the CPU robot shadow is then left out) */
  active = false;
  readonly casters = new Set<Model>();

  private readonly viewer: Viewer;
  private readonly material: Material;
  private globeShadows: ShadowMode | undefined;

  constructor(viewer: Viewer, material: Material) {
    this.viewer = viewer; this.material = material;
    const scene = viewer.scene;
    this.cam = new Camera(scene);
    (this.cam as unknown as { frustum: unknown }).frustum = this.frustum;
    this.frustum.left = -10; this.frustum.right = 10; this.frustum.bottom = -10; this.frustum.top = 10;
    this.frustum.near = 0.5; this.frustum.far = SUN_SHADOW.depth;
    const opts = {
      context: (scene as unknown as { context: unknown }).context, lightCamera: this.cam, enabled: false,
      isPointLight: false, cascadesEnabled: false, numberOfCascades: 1, maximumDistance: 400,
      size: SUN_SHADOW.full.size, softShadows: true, darkness: SUN_SHADOW.darkness, normalOffset: true, fadingEnabled: false, fromLightSource: false,
    };
    this.map = new (ShadowMap as unknown as new (o: object) => ShadowMap)(opts);
    // robot / rock receive pass: no "turned from the light = dark" (our own shaders light the sides), small biases
    // for a half-size robot (Cesium's defaults are made for buildings: 10 cm normal offset lets light under a wheel)
    const pb = (this.map as unknown as { _primitiveBias: Record<string, number | boolean> })._primitiveBias;
    pb.normalShading = false; pb.normalOffsetScale = 0.02; pb.depthBias = 0.00004;
  }

  /** Models that cast and receive while shadows are on. */
  setCasters(models: readonly Model[]) {
    for (const m of this.casters) if (!models.includes(m)) m.shadows = ShadowMode.DISABLED;
    this.casters.clear();
    for (const m of models) { this.casters.add(m); if (this.installed) m.shadows = ShadowMode.ENABLED; }
  }

  private install(on: boolean) {
    if (on === this.installed) return;
    const scene = this.viewer.scene;
    this.installed = on;
    if (on) {
      this.prevShadowMap = scene.shadowMap; scene.shadowMap = this.map;
      this.globeShadows = scene.globe.shadows; scene.globe.shadows = ShadowMode.DISABLED;
    } else {
      if (scene.shadowMap === this.map && this.prevShadowMap) scene.shadowMap = this.prevShadowMap;
      if (this.globeShadows !== undefined) scene.globe.shadows = this.globeShadows;
    }
    this.map.enabled = on;
    for (const m of this.casters) m.shadows = on ? ShadowMode.ENABLED : ShadowMode.DISABLED;
  }

  /** Every frame before rendering. */
  update(f: SunShadowFrame) {
    const u = this.material.uniforms as Record<string, unknown>;
    const info = u.lvShInfo as Cartesian4;
    const strength = Math.min(1, Math.max(0, (f.sunEl + 0.3) / 0.8));
    const on = f.on && strength > 0;
    this.install(on);
    this.active = on;
    if (!on) { info.x = 0; return; }
    const Q = f.light ? SUN_SHADOW.light : SUN_SHADOW.full;
    if (Q.size !== this.size) { this.size = Q.size; this.map.size = Q.size; }
    // the light camera: looks along the sunbeam; a basis fixed for a given Sun (its up = the local up, flattened)
    const d = Cartesian3.negate(f.sun, sA);
    let up = Cartesian3.subtract(f.up, Cartesian3.multiplyByScalar(d, Cartesian3.dot(f.up, d), sB), sB);
    if (Cartesian3.magnitude(up) < 1e-3) up = Cartesian3.cross(d, Cartesian3.UNIT_Z, sB);
    Cartesian3.normalize(up, up);
    const right = Cartesian3.normalize(Cartesian3.cross(d, up, sC), sC);
    // tight in the light's up axis when the Sun is low: the ground across the picture, plus room for heights
    const el = Math.max(f.sunEl, 0.5) * Math.PI / 180;
    const hx = Q.half;
    const reliefM = SUN_SHADOW.relief + SUN_SHADOW.reliefK * Q.half;
    let hy = Math.min(Q.half, Q.half * Math.sin(el) + reliefM * Math.cos(el));
    hy = Math.ceil(hy / (Q.half / 32)) * (Q.half / 32); // in steps, so the texel size only changes now and then
    const tx = (2 * hx) / Q.size, ty = (2 * hy) / Q.size;
    // centre: ahead of where you look, snapped to whole texels of a grid laid from the fixed origin
    const c = Cartesian3.add(f.centre, Cartesian3.multiplyByScalar(f.look, SUN_SHADOW.ahead * Q.half, sD), sD);
    const rel = Cartesian3.subtract(c, f.origin, sD);
    const cr = Math.round(Cartesian3.dot(rel, right) / tx) * tx, cu = Math.round(Cartesian3.dot(rel, up) / ty) * ty, cd = Cartesian3.dot(rel, d);
    const half = SUN_SHADOW.depth / 2;
    const pos = this.cam.position;
    pos.x = f.origin.x + right.x * cr + up.x * cu + d.x * (cd - half);
    pos.y = f.origin.y + right.y * cr + up.y * cu + d.y * (cd - half);
    pos.z = f.origin.z + right.z * cr + up.z * cu + d.z * (cd - half);
    Cartesian3.clone(d, this.cam.direction); Cartesian3.clone(up, this.cam.up); Cartesian3.clone(right, this.cam.right);
    const F = this.frustum;
    F.left = -hx; F.right = hx; F.bottom = -hy; F.top = hy; F.near = 0.5; F.far = SUN_SHADOW.depth;
    // full darkness only where the Sun reaches (in a hill's shadow the robot's own shadow cannot darken anything)
    const m = this.map as unknown as { _darkness: number; _shadowMapTexture?: unknown; _shadowMapMatrix: Matrix4 };
    const dk = SUN_SHADOW.darkness;
    m._darkness = 1 - (1 - dk) * strength * Math.min(1, Math.max(0, f.sunVis));
    // the ground reads the picture itself
    if (m._shadowMapTexture && m._shadowMapTexture !== this.texSet) {
      const mt = this.material as unknown as { _textures: Record<string, unknown>; _defaultTexture: unknown };
      // (Material destroys a texture it is handed a replacement for: this one belongs to the shadow map)
      if (this.texSet) mt._textures.lvShTex = mt._defaultTexture;
      this.texSet = m._shadowMapTexture;
      u.lvShTex = m._shadowMapTexture;
    }
    if (u.lvShMat !== m._shadowMapMatrix) u.lvShMat = m._shadowMapMatrix;
    info.x = this.texSet && SUN_SHADOW.ground ? 1 : 0; info.y = SUN_SHADOW.depth; info.z = strength; info.w = Math.max(tx, ty);
    const sc = u.lvShScale as Cartesian4;
    sc.x = 1 / (2 * hx); sc.y = 1 / (2 * hy); sc.z = Q.size; sc.w = Q.size;
  }

  /** Back to the map: shadows off. */
  off() {
    this.install(false);
    this.active = false;
    ((this.material.uniforms as Record<string, unknown>).lvShInfo as Cartesian4).x = 0;
  }

  destroy() {
    this.off();
    const mt = this.material as unknown as { _textures?: Record<string, unknown>; _defaultTexture: unknown };
    if (this.texSet && mt._textures) mt._textures.lvShTex = mt._defaultTexture;
    this.texSet = null;
    for (const m of this.casters) if (!m.isDestroyed()) m.shadows = ShadowMode.DISABLED;
    this.casters.clear();
    const sm = this.map as unknown as { isDestroyed(): boolean; destroy(): void };
    if (!sm.isDestroyed()) sm.destroy();
  }
}

/**
 * The contact shadow's place for this frame (uniforms lvC*): the six wheels' footprints and the belly, in metres
 * east / north (east, north: the ground material's map frame). `show` false: none (robot hidden or not parked).
 */
export function placeContact(material: Material, d: Driver | null, east: Cartesian3, north: Cartesian3, show: boolean) {
  const u = material.uniforms as Record<string, unknown>;
  const info = u.lvCInfo as Cartesian4;
  if (!d || !show) { info.x = 0; return; }
  const S = ROBOT_SCALE, fe = Cartesian3.dot(d.fwd, east), fn = Cartesian3.dot(d.fwd, north);
  const re = Cartesian3.dot(d.right, east), rn = Cartesian3.dot(d.right, north);
  const e0 = Cartesian3.dot(d.feet, east), n0 = Cartesian3.dot(d.feet, north);
  const ws = [u.lvCw1, u.lvCw2, u.lvCw3] as Cartesian4[];
  WHEELS.forEach((w, i) => {
    const f = w.z * S, r = -w.x * S;
    const e = e0 + fe * f + re * r, n = n0 + fn * f + rn * r;
    const v = ws[i >> 1];
    if (i & 1) { v.z = e; v.w = n; } else { v.x = e; v.y = n; }
  });
  const fl = Math.hypot(fe, fn) || 1;
  const b = u.lvCBody as Cartesian4;
  b.x = e0; b.y = n0; b.z = fe / fl; b.w = fn / fl;
  // fades when the robot is in the air (a hop off a rock)
  info.x = Math.max(0, 1 - d.air * 4); info.y = 0.24 * S / 0.5; info.z = 0.8 * S / 0.5; info.w = 0.52 * S / 0.5;
}
