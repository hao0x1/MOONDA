// The flat Moon map (2D), drawn by our own small WebGL program over the Cesium globe.
//
// Why not Cesium's own morphTo2D: the Moon is rotated inside Cesium (frame.ts: the true south pole sits on
// Cesium's equator), so Cesium's flat map would be a map of the rotated frame, with the south pole in the
// middle. Our map is a plain true lon/lat map (north up, 180° W .. 180° E), the way NASA prints it.
//
// One mesh of true lon/lat points does everything: drawn as a sphere it matches the Cesium globe exactly
// (same camera), and the same mesh unrolls into the flat map:
//   stage A  the sphere swells into an upright cylinder (lat becomes straight rows)
//   stage B  the cylinder opens at the back and unrolls, its curvature easing to zero, into the map
// Lighting comes from the true Sun on the sphere's normals, so the day / night edge stays painted on through
// the whole move and the time bar moves it across the flat map.
//
// The picture is the app's own whole-Moon mosaic (public/data/base/v5/moon8k.jpg, Cesium's DISPLAY frame),
// re-projected once on the GPU into a true lon/lat texture with mipmaps (prepare(), on the start screen).
// Names, icons, pins and the Sun / Earth points are drawn on a 2D canvas above, with the same rules as on
// the globe (labels.ts): importance, no overlaps, soft fades.

import type { FlatLabel, PlaceIcon } from './labels';
import { MAX_LABELS, MIN_PX } from './labels';
import type { Place } from '../data/places';
import { MOON_R, type V3 } from './frame';
import { DETAIL_COLORS } from './dataDetail';
import { SUN_URL, EARTH_URL } from '../ui/glyphs';

const DEG = Math.PI / 180;
const M_PER_DEG = MOON_R * DEG; // 30.3 km
// The closest zoom (km across the free part of the screen), where the picture still looks good: the whole-Moon
// picture is 1.3 km per pixel, about 6 screen pixels per picture pixel at 250 km (sharpened, see samplePic);
// closer, it only gets more blurred (tried 160 km and 20 km: soft mush). The LOLA height map stored with the app
// (dem/global16.bin, 1.9 km per pixel) is coarser than the photo, so hill shading from it adds no detail.
// Round the poles the sharper polar pictures (333 m per pixel, south6.jpg / north6.jpg, the files the globe uses)
// are drawn between about 56 and 76 degrees; closer to a pole the flat map's own sideways stretch is the limit
// (a degree of longitude there is only a few km), so the closest zoom stays the same everywhere.
const MIN_VIEW_KM = 250;
/** the polar pictures: display-frame boxes (degrees) around the true south / north pole, as in base.json */
const POLAR_PICS = [
  { file: 'south6.jpg', west: 56.25, north: 33.75, span: 67.5 },
  { file: 'north6.jpg', west: -123.75, north: 33.75, span: 67.5 },
] as const;
const BACKDROP: V3 = [10 / 255, 11 / 255, 15 / 255];
const NX = 192, NY = 96;
const HAIR = ' ';

export interface FlatView { lonC: number; latC: number; s: number } // centre (true degrees) and pixels per degree
export interface FlatPin { lat: number; lon: number; image: string }
export interface Insets { top: number; bottom: number; left: number; right: number }
export interface FlatHooks {
  /** names and places the switches allow */
  labels(): FlatLabel[];
  icon(kind: Place['kind']): PlaceIcon | undefined;
  pins(): FlatPin[];
  /** screen boxes of the page's own panels and buttons (canvas CSS px) */
  panelBoxes(): { x0: number; y0: number; x1: number; y1: number }[];
  insets(): Insets;
  onClickTag(id: unknown): void;
  onClickGround(lat: number, lon: number): void;
  onHover(pos: { lat: number; lon: number } | null): void;
  /** the view changed (flat map only); `km`: the eye height that would show as much */
  onView?(km: number): void;
  /** words for the note shown when someone zooms in at the closest zoom, and what its button does */
  limitText?(): { msg: string; go: string };
  onCloser?(lat: number, lon: number): void;
}

type Box = { x0: number; y0: number; x1: number; y1: number };
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2); // ease in-out cubic
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const VS = `#version 300 es
precision highp float;
in vec2 aP; // (lon - centre lon, lat) in radians
uniform float uC, uA, uB, uS, uD;
uniform vec2 uO;
uniform mat4 uProj;
out vec2 vLL;
void main() {
  float a = aP.x, lat = aP.y;
  vec3 sph = vec3(cos(lat) * sin(a), sin(lat), cos(lat) * cos(a));
  // the cylinder that unrolls: curvature k from 1 (radius 1, the sphere's size) to 0, width from 1 to uS per radian
  float L = mix(1.0, uS, uB), k = 1.0 - uB, s = a * L;
  float x = k < 1e-4 ? s : sin(s * k) / k;
  float z = k < 1e-4 ? 1.0 - 0.5 * s * s * k : 1.0 - (1.0 - cos(s * k)) / k;
  vec3 cyl = vec3(x, lat * mix(1.0, uS, uB) * mix(0.64, 1.0, uB), z) + vec3(uO * uB, 0.0);
  // the middle of the globe leads, its far side follows a little later
  float eA = clamp(uA * 1.35 - 0.35 * abs(a) / 3.14159265, 0.0, 1.0);
  eA = eA * eA * (3.0 - 2.0 * eA);
  vec3 p = mix(sph, cyl, eA);
  vLL = aP;
  gl_Position = uProj * vec4(p - vec3(0.0, 0.0, uD), 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vLL;
uniform sampler2D uTex;
uniform float uC, uSunOn, uDetail, uGrid;
uniform vec3 uSun;
uniform vec3 uTint0, uTint1, uTint2;
uniform sampler2D uPolS, uPolN;
uniform vec2 uPolOn;   // the south / north polar pictures are loaded
uniform float uSharp;  // 1: sharp (Catmull-Rom) filtering when magnified, 0: plain
out vec4 o;
const float PI = 3.14159265;
// Catmull-Rom from 9 bilinear taps (Jimenez): crisper than bilinear when a picture pixel covers many screen pixels
float sampleCR(sampler2D t, vec2 uv) {
  vec2 size = vec2(textureSize(t, 0));
  vec2 sp = uv * size, p1 = floor(sp - 0.5) + 0.5, f = sp - p1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2, p12 = (p1 + w2 / w12) / size, p0 = (p1 - 1.0) / size, p3 = (p1 + 2.0) / size;
  float r = 0.0;
  r += textureLod(t, vec2(p0.x, p0.y), 0.0).r * w0.x * w0.y;
  r += textureLod(t, vec2(p12.x, p0.y), 0.0).r * w12.x * w0.y;
  r += textureLod(t, vec2(p3.x, p0.y), 0.0).r * w3.x * w0.y;
  r += textureLod(t, vec2(p0.x, p12.y), 0.0).r * w0.x * w12.y;
  r += textureLod(t, vec2(p12.x, p12.y), 0.0).r * w12.x * w12.y;
  r += textureLod(t, vec2(p3.x, p12.y), 0.0).r * w3.x * w12.y;
  r += textureLod(t, vec2(p0.x, p3.y), 0.0).r * w0.x * w3.y;
  r += textureLod(t, vec2(p12.x, p3.y), 0.0).r * w12.x * w3.y;
  r += textureLod(t, vec2(p3.x, p3.y), 0.0).r * w3.x * w3.y;
  return clamp(r, 0.0, 1.0);
}
// mip-mapped as usual when the picture is shrunk, Catmull-Rom when it is magnified (and a touch of local contrast)
float samplePic(sampler2D t, vec2 uv, vec2 dx, vec2 dy) {
  vec2 size = vec2(textureSize(t, 0));
  float texPerPx = max(length(dx * size), length(dy * size));
  float plain = textureGrad(t, uv, dx, dy).r;
  if (uSharp < 0.5 || texPerPx > 0.9) return plain;
  float cr = sampleCR(t, uv);
  float mag = clamp(1.0 / max(texPerPx, 1e-4), 1.0, 16.0);
  // unsharp mask against a wider blur, stronger the more the picture is magnified
  float blur = textureLod(t, uv, 1.6).r;
  float k = 0.35 * smoothstep(1.5, 8.0, mag);
  return mix(plain, clamp(cr + (cr - blur) * k, 0.0, 1.0), smoothstep(0.9, 0.6, texPerPx));
}
void main() {
  float lon = uC + vLL.x, lat = vLL.y;
  vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  float g = samplePic(uTex, uv, dx, dy);
  // round the poles: the sharper polar pictures (display frame = (x, -z, y) of the true frame, as the globe draws them)
  if (uPolOn.x + uPolOn.y > 0.0 && abs(lat) > 0.7) {
    vec3 nt = vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat));
    float dLat = degrees(asin(clamp(nt.y, -1.0, 1.0))), dLon = degrees(atan(-nt.z, nt.x));
    bool south = lat < 0.0;
    if (south ? uPolOn.x > 0.0 : uPolOn.y > 0.0) {
      vec2 pv = vec2((dLon - (south ? 56.25 : -123.75)) / 67.5, (33.75 - dLat) / 67.5);
      // feather the last 3% of the picture into the whole-Moon one
      vec2 e = min(pv, 1.0 - pv);
      float w = smoothstep(0.0, 0.03, min(e.x, e.y));
      if (w > 0.0) {
        vec2 pdx = dFdx(pv), pdy = dFdy(pv);
        float gp = south ? samplePic(uPolS, pv, pdx, pdy) : samplePic(uPolN, pv, pdx, pdy);
        g = mix(g, gp, w);
      }
    }
  }
  vec3 n = vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat));
  float d = dot(n, uSun);
  float day = smoothstep(-0.035, 0.12, d);
  float lit = mix(1.0, mix(0.2, 0.9 + 0.32 * clamp(d, 0.0, 1.0), day), uSunOn);
  vec3 c = vec3(g) * lit;
  if (uDetail > 0.0) {
    float latD = lat / PI * 180.0;
    float l = mod(lon / PI * 180.0 + 540.0, 360.0) - 180.0;
    vec3 t = latD < -80.0 ? uTint0 : (l < -90.0 ? uTint2 : uTint1);
    c = mix(c, t * (0.35 + 0.65 * lit), 0.4 * uDetail);
  }
  if (uGrid > 0.0) {
    vec2 dg = vec2(lon, lat) / PI * 180.0 / 30.0;
    vec2 w = fwidth(dg);
    vec2 f = abs(fract(dg + 0.5) - 0.5) / max(w, vec2(1e-6));
    float line = 1.0 - clamp(min(f.x, f.y) - 0.25, 0.0, 1.0);
    c = mix(c, vec3(0.85, 0.9, 1.0), 0.16 * line * uGrid);
  }
  o = vec4(c, 1.0);
}`;

const RS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSize;
out vec4 o;
const float PI = 3.14159265;
void main() {
  vec2 t = gl_FragCoord.xy / uSize;
  float lon = (t.x - 0.5) * 2.0 * PI, lat = (0.5 - t.y) * PI;
  vec3 n = vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat));
  // display frame = (x, -z, y) of the true frame (frame.ts)
  float dLat = asin(clamp(n.y, -1.0, 1.0)), dLon = atan(-n.z, n.x);
  o = vec4(texture(uSrc, vec2(dLon / (2.0 * PI) + 0.5, 0.5 - dLat / PI)).r, 0.0, 0.0, 1.0);
}`;
const RVS = `#version 300 es
in vec2 aP;
void main() { gl_Position = vec4(aP, 0.0, 1.0); }`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
    gl.attachShader(p, sh);
  }
  gl.bindAttribLocation(p, 0, 'aP');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
  return p;
}

const images = new Map<string, HTMLImageElement>();
function img(url: string, onLoad: () => void): HTMLImageElement {
  let im = images.get(url);
  if (!im) { im = new Image(); im.decoding = 'async'; im.onload = onLoad; im.src = url; images.set(url, im); }
  return im;
}

export class FlatMap {
  readonly el: HTMLDivElement;
  private gl: WebGL2RenderingContext;
  private glCanvas: HTMLCanvasElement;
  private ui: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private prog: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private nIdx = 0;
  private tex: WebGLTexture | null = null;
  /** the sharper polar pictures (south, north): loaded the first time you look closely at a pole (not in Smooth graphics) */
  private pol: (WebGLTexture | null)[] = [null, null];
  private polState: ('none' | 'loading' | 'ready' | 'failed')[] = ['none', 'none'];
  private light = false;
  /** width of the whole-Moon picture in use (8192, or 2048 in Smooth graphics) */
  private texW = 8192;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private preparing: Promise<void> | null = null;
  private hooks: FlatHooks;
  private raf = 0;
  private dpr = 1;
  // what is drawn
  view: FlatView = { lonC: 0, latC: 0, s: 4 };
  morphA = 1; morphB = 1;
  /** sphere camera: distance from the centre (Moon radii) and vertical field of view (radians), as Cesium's */
  camD = 4; fovy = 0.6;
  backdrop = 1;
  overlayAlpha = 1;
  detail = 0;
  grid = 1;
  sun: V3 = [1, 0, 0];
  earth: V3 | null = null;
  sunOn = true;
  /** the flat map owns the screen (input, keys) */
  active = false;
  /** a transition is running: input is ignored */
  busy = false;
  /** frame times (ms) of the last transition, for measurements */
  frameLog: number[] = [];
  private lastFrame = 0;
  // overlay state
  private fades = new Map<unknown, { a: number; t: number; ia: number; it: number }>();
  private hits: (Box & { id: unknown })[] = [];
  private hovered: unknown = null;
  private entries: FlatLabel[] | null = null;
  // motion
  private flight: { from: FlatView; to: FlatView; t0: number; dur: number; done: () => void } | null = null;
  private zoomTarget: { s: number; x: number; y: number; lat: number; lon: number } | null = null;
  private fling: { vx: number; vy: number } | null = null;
  private drag: { x0: number; y0: number; lat: number; lon: number; moved: boolean; hist: { x: number; y: number; t: number }[] } | null = null;
  private clickTimer = 0;
  // the note at the closest zoom ("go closer on the globe")
  private pill: HTMLButtonElement;
  private pillAt: { lat: number; lon: number } | null = null;
  private pillTimer = 0;
  private keysHeld = new Set<string>();
  private lastTick = 0;

  constructor(parent: HTMLElement, hooks: FlatHooks) {
    this.hooks = hooks;
    this.el = document.createElement('div');
    this.el.className = 'flat-map';
    this.el.style.cssText = 'position:absolute;inset:0;z-index:1;opacity:0;pointer-events:none;visibility:hidden;touch-action:none;';
    this.glCanvas = document.createElement('canvas');
    this.ui = document.createElement('canvas');
    for (const c of [this.glCanvas, this.ui]) { c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;'; this.el.appendChild(c); }
    this.pill = document.createElement('button');
    this.pill.type = 'button'; this.pill.className = 'flat-limit';
    this.pill.addEventListener('click', () => { const at = this.pillAt; this.hidePill(); if (at) this.hooks.onCloser?.(at.lat, at.lon); });
    this.el.appendChild(this.pill);
    parent.appendChild(this.el);
    const gl = this.glCanvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true, depth: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.ctx = this.ui.getContext('2d')!;
    this.ui.addEventListener('pointerdown', this.onDown);
    this.ui.addEventListener('pointermove', this.onMove);
    this.ui.addEventListener('pointerup', this.onUp);
    this.ui.addEventListener('pointercancel', this.onUp);
    this.ui.addEventListener('pointerleave', () => { if (!this.drag) { this.setHover(null); this.hooks.onHover(null); } });
    this.ui.addEventListener('dblclick', this.onDbl);
    this.ui.addEventListener('wheel', this.onWheel, { passive: false });
    this.ui.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
  }

  get ready() { return !!this.tex; }

  /** Load and re-project the whole-Moon picture, build the mesh, compile the shaders, draw once. Call early (start screen). */
  prepare(light: boolean): Promise<void> {
    if (this.preparing) return this.preparing;
    this.light = light;
    this.preparing = (async () => {
      const gl = this.gl;
      const res = await fetch(new URL(light ? './data/base/v5/moon2k.jpg' : './data/base/v5/moon8k.jpg', document.baseURI).href);
      const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      this.prog = compile(gl, VS, FS);
      for (const n of ['uC', 'uA', 'uB', 'uS', 'uD', 'uO', 'uProj', 'uTex', 'uSunOn', 'uDetail', 'uGrid', 'uSun', 'uTint0', 'uTint1', 'uTint2', 'uPolS', 'uPolN', 'uPolOn', 'uSharp']) this.u[n] = gl.getUniformLocation(this.prog, n);
      // mesh
      const v = new Float32Array((NX + 1) * (NY + 1) * 2);
      let k = 0;
      for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) { v[k++] = -Math.PI + (2 * Math.PI * i) / NX; v[k++] = Math.PI / 2 - (Math.PI * j) / NY; }
      const idx = new Uint16Array(NX * NY * 6);
      k = 0;
      for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
        const a = j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
      this.nIdx = idx.length;
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      // source (display frame) -> true lon/lat texture
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const src = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, bmp);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const W = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, bmp.width), H = W / 2;
      this.texW = W;
      bmp.close();
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(W)) + 1, gl.R8, W, H);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const rp = compile(gl, RVS, RS);
      gl.useProgram(rp);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src);
      gl.uniform1i(gl.getUniformLocation(rp, 'uSrc'), 0);
      gl.uniform2f(gl.getUniformLocation(rp, 'uSize'), W, H);
      const tri = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, tri); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const tvao = gl.createVertexArray(); gl.bindVertexArray(tvao);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.viewport(0, 0, W, H);
      gl.disable(gl.DEPTH_TEST);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb); gl.deleteTexture(src); gl.deleteProgram(rp); gl.deleteBuffer(tri); gl.deleteVertexArray(tvao);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const ext = gl.getExtension('EXT_texture_filter_anisotropic');
      if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, 8);
      this.tex = tex;
      for (const u of [SUN_URL, EARTH_URL]) img(u, () => this.request());
      this.resize();
      this.draw(); // warm the shaders while nobody is looking
    })();
    return this.preparing;
  }

  /** Load one polar picture (0 south, 1 north) into a mip-mapped texture, then redraw. */
  private loadPolar(i: number) {
    this.polState[i] = 'loading';
    void (async () => {
      try {
        const res = await fetch(new URL(`./data/base/v5/${POLAR_PICS[i].file}`, document.baseURI).href);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        const gl = this.gl, tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(bmp.width, bmp.height))) + 1, gl.R8, bmp.width, bmp.height);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RED, gl.UNSIGNED_BYTE, bmp);
        bmp.close();
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const ext = gl.getExtension('EXT_texture_filter_anisotropic');
        if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, 8);
        this.pol[i] = tex;
        this.polState[i] = 'ready';
        this.request();
      } catch (e) {
        this.polState[i] = 'failed';
        console.warn('Flat map: polar picture not available', e);
      }
    })();
  }

  // ---- geometry ----------------------------------------------------------------------------
  private size() { return { W: this.ui.clientWidth || 1, H: this.ui.clientHeight || 1 }; }
  /** The free part of the screen (between the bars and panels), canvas CSS px. */
  free() {
    const { W, H } = this.size();
    const i = this.hooks.insets();
    const x0 = i.left, x1 = Math.max(x0 + 100, W - i.right), y0 = i.top, y1 = Math.max(y0 + 100, H - i.bottom);
    return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }
  fitScale() { const f = this.free(); return Math.min(f.w / 360, f.h / 180); }
  /** The closest zoom (a little further out with the smaller picture of Smooth graphics). */
  maxScale() { const f = this.free(); return f.w / (MIN_VIEW_KM * Math.sqrt(8192 / this.texW) * 1000 / M_PER_DEG); }
  /** Keep the map's top and bottom edges from leaving the free area once it is taller than it. */
  private clampView(v: FlatView): FlatView {
    const f = this.free();
    const s = clamp(v.s, this.fitScale(), this.maxScale());
    const half = f.h / 2 / s;
    const latC = 90 - half <= 0 ? 0 : clamp(v.latC, -90 + half, 90 - half);
    return { lonC: wrap180(v.lonC), latC, s };
  }
  wholeView(lonC = this.view.lonC): FlatView { return { lonC, latC: 0, s: this.fitScale() }; }
  toScreen(lat: number, lon: number, v = this.view) {
    const f = this.free();
    return { x: f.cx + wrap180(lon - v.lonC) * v.s, y: f.cy - (lat - v.latC) * v.s };
  }
  toLatLon(x: number, y: number, v = this.view) {
    const f = this.free();
    return { lat: v.latC - (y - f.cy) / v.s, lon: wrap180(v.lonC + (x - f.cx) / v.s) };
  }

  resize() {
    const { W, H } = this.size();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [this.glCanvas, this.ui]) {
      const w = Math.round(W * this.dpr), h = Math.round(H * this.dpr);
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
    if (this.active && !this.busy) this.view = this.clampView(this.view);
    this.request();
  }

  // ---- drawing -----------------------------------------------------------------------------
  request() { if (!this.raf) this.raf = requestAnimationFrame(this.frame); }
  private frame = (now: number) => {
    this.raf = 0;
    const dt = this.lastTick ? Math.min(0.064, (now - this.lastTick) / 1000) : 0.016;
    this.lastTick = now;
    const before = this.view;
    let more = this.stepMotion(now, dt);
    if (this.active && (this.view !== before || this.drag)) this.hooks.onView?.((this.free().h / this.view.s) * M_PER_DEG / 1000 / (2 * Math.tan(this.fovy / 2)));
    this.draw();
    more = this.drawOverlay(dt) || more;
    if (this.busy) { if (this.lastFrame) this.frameLog.push(now - this.lastFrame); this.lastFrame = now; } else this.lastFrame = 0;
    if (more || this.busy) this.request();
  };

  draw() {
    const gl = this.gl;
    if (!this.prog || !this.tex) return;
    const { W, H } = this.size();
    gl.viewport(0, 0, this.glCanvas.width, this.glCanvas.height);
    const b = this.backdrop;
    gl.clearColor(BACKDROP[0] * b, BACKDROP[1] * b, BACKDROP[2] * b, b);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.prog);
    // perspective camera on the z axis, looking at the centre (as Cesium's camera at the whole-Moon pose)
    const aspect = W / H, f = 1 / Math.tan(this.fovy / 2), near = 0.05, far = 60;
    const P = new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]);
    gl.uniformMatrix4fv(this.u.uProj, false, P);
    // the plane (at z = 1) in world units per screen pixel
    const k = (this.camD - 1) * 2 * Math.tan(this.fovy / 2) / H;
    const v = this.view, fr = this.free();
    const sRad = v.s / DEG * k;
    gl.uniform1f(this.u.uC, v.lonC * DEG);
    gl.uniform1f(this.u.uA, this.morphA);
    gl.uniform1f(this.u.uB, this.morphB);
    gl.uniform1f(this.u.uS, sRad);
    gl.uniform1f(this.u.uD, this.camD);
    gl.uniform2f(this.u.uO, (fr.cx - W / 2) * k, (H / 2 - fr.cy) * k - v.latC * DEG * sRad);
    gl.uniform1f(this.u.uSunOn, this.sunOn ? 1 : 0);
    gl.uniform3f(this.u.uSun, this.sun[0], this.sun[1], this.sun[2]);
    gl.uniform1f(this.u.uDetail, this.detail);
    gl.uniform1f(this.u.uGrid, this.grid * this.morphB);
    const t = (c: [number, number, number]) => [c[0] / 255, c[1] / 255, c[2] / 255] as const;
    gl.uniform3f(this.u.uTint0, ...t(DETAIL_COLORS.sharp));
    gl.uniform3f(this.u.uTint1, ...t(DETAIL_COLORS.global));
    gl.uniform3f(this.u.uTint2, ...t(DETAIL_COLORS.rebuilt));
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u.uTex, 0);
    // the polar pictures: asked for when a pole is on screen closer than the whole-Moon picture can show
    if (!this.light && this.active) for (let i = 0; i < 2; i++) {
      const edge = i ? v.latC + fr.h / 2 / v.s : v.latC - fr.h / 2 / v.s;
      if (this.polState[i] === 'none' && (i ? edge > 52 : edge < -52) && v.s > 8) this.loadPolar(i); // (8 px per degree: the whole-Moon picture starts to blur)
    }
    for (let i = 0; i < 2; i++) { gl.activeTexture(gl.TEXTURE1 + i); gl.bindTexture(gl.TEXTURE_2D, this.pol[i] ?? this.tex); }
    gl.uniform1i(this.u.uPolS, 1); gl.uniform1i(this.u.uPolN, 2);
    gl.uniform2f(this.u.uPolOn, this.pol[0] ? 1 : 0, this.pol[1] ? 1 : 0);
    gl.uniform1f(this.u.uSharp, this.light ? 0 : 1);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  }

  /** Names, icons, pins, the Sun / Earth points and grid labels. Returns true while something is still fading. */
  private drawOverlay(dt: number): boolean {
    const ctx = this.ctx, { W, H } = this.size();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    this.hits.length = 0;
    if (this.overlayAlpha <= 0.001 || this.morphB < 0.999) return false;
    ctx.globalAlpha = this.overlayAlpha;
    const v = this.view, fr = this.free();
    const boxes: Box[] = [];
    const free = (b: Box) => !boxes.some(o => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
    for (const b of this.hooks.panelBoxes()) boxes.push(b);
    // grid labels (quiet), every 30 degrees, along the top and left of the map
    ctx.font = `500 10px ${'"Google Sans Flex Variable", system-ui, sans-serif'}`;
    ctx.fillStyle = 'rgba(220,228,240,0.42)';
    ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    const topY = Math.max(fr.y0 + 4, this.toScreen(90, 0).y + 4);
    for (let lon = -150; lon <= 180; lon += 30) {
      const p = this.toScreen(0, lon);
      if (p.x < fr.x0 + 14 || p.x > fr.x1 - 14) continue;
      const t = lon === 0 || lon === 180 ? `${lon}°` : `${Math.abs(lon)}°${lon < 0 ? 'W' : 'E'}`;
      ctx.fillText(t, p.x, topY);
      boxes.push({ x0: p.x - 16, y0: topY - 2, x1: p.x + 16, y1: topY + 12 });
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const leftX = Math.max(fr.x0 + 4, this.toScreen(0, v.lonC - 180).x + 4);
    for (let lat = -60; lat <= 60; lat += 30) {
      const p = this.toScreen(lat, 0);
      if (p.y < fr.y0 + 16 || p.y > fr.y1 - 8) continue;
      ctx.fillText(lat === 0 ? '0°' : `${Math.abs(lat)}°${lat < 0 ? 'S' : 'N'}`, leftX, p.y - 7);
      boxes.push({ x0: leftX - 2, y0: p.y - 14, x1: leftX + 30, y1: p.y });
    }
    // pins: always drawn
    const pinDraw: { x: number; y: number; im: HTMLImageElement }[] = [];
    for (const p of this.hooks.pins()) {
      const s = this.toScreen(p.lat, p.lon);
      if (s.x < -20 || s.x > W + 20 || s.y < -40 || s.y > H + 20) continue;
      pinDraw.push({ x: s.x, y: s.y, im: img(p.image, () => this.request()) });
      boxes.push({ x0: s.x - 15, y0: s.y - 37, x1: s.x + 15, y1: s.y + 2 });
    }
    // the points right under the Sun and the Earth
    const glyphs: { x: number; y: number; im: HTMLImageElement }[] = [];
    for (const [vec, url] of [[this.sunOn ? this.sun : null, SUN_URL], [this.sunOn ? this.earth : null, EARTH_URL]] as const) {
      if (!vec) continue;
      const lat = Math.asin(clamp(vec[2], -1, 1)) / DEG, lon = Math.atan2(vec[1], vec[0]) / DEG;
      const s = this.toScreen(lat, lon);
      if (s.x < fr.x0 || s.x > fr.x1 || s.y < fr.y0 || s.y > fr.y1) continue;
      glyphs.push({ x: s.x, y: s.y, im: img(url, () => this.request()) });
      boxes.push({ x0: s.x - 14, y0: s.y - 14, x1: s.x + 14, y1: s.y + 14 });
    }
    // names and icons, by importance; fades as on the globe
    const mPerPx = M_PER_DEG / v.s;
    const entries = this.entries ?? (this.entries = this.hooks.labels());
    const want = new Set<unknown>(), wantIcon = new Set<unknown>();
    const iconCand: { e: FlatLabel; score: number; x: number; y: number }[] = [];
    const cand: { e: FlatLabel; score: number; x: number; y: number }[] = [];
    for (const e of entries) {
      const p = this.toScreen(e.lat, e.lon);
      if (p.x < fr.x0 - 50 || p.x > fr.x1 + 50 || p.y < fr.y0 - 20 || p.y > fr.y1 + 20) continue;
      const fd = this.fades.get(e.id);
      if (e.fixed) {
        const iconOk = e.fixed === 2 || mPerPx < 1900;
        if (iconOk) iconCand.push({ e, score: 1e6 * e.fixed - mPerPx + (fd?.it === 1 ? 5e5 : 0), x: p.x, y: p.y });
        if (!((e.fixed === 2 && mPerPx > 2700) || (e.fixed === 3 && mPerPx > 840))) cand.push({ e, score: 1e6 * e.fixed, x: p.x, y: p.y });
      } else {
        // a little stricter than on the globe: the whole map shows four times the area of a globe view
        const score = (e.sizeM / mPerPx) * e.weight;
        if (score >= MIN_PX * 1.5) cand.push({ e, score: score * (fd?.t === 1 ? 1.35 : 1), x: p.x, y: p.y });
      }
    }
    iconCand.sort((a, b) => b.score - a.score);
    for (const c of iconCand) {
      const r = c.e.iconR + 1, b = { x0: c.x - r, y0: c.y - r, x1: c.x + r, y1: c.y + r };
      if (c.x > fr.x0 && c.x < fr.x1 && c.y > fr.y0 - 10 && c.y < fr.y1 + 10 && free(b)) { boxes.push(b); wantIcon.add(c.e.id); this.hits.push({ x0: b.x0 - 2, y0: b.y0 - 2, x1: b.x1 + 2, y1: b.y1 + 2, id: c.e.id }); }
    }
    cand.sort((a, b) => b.score - a.score);
    let placed = 0;
    for (const c of cand) {
      const e = c.e;
      if (!((placed < MAX_LABELS || e.fixed) && (!e.fixed || wantIcon.has(e.id) || !this.hooks.icon(e.kind!)))) continue;
      const isPlace = e.kind !== null;
      const x0 = isPlace ? c.x + e.iconR + 5 : c.x - e.w / 2, y0 = c.y - e.h / 2;
      const b = { x0: x0 - (isPlace ? 0 : 4), y0: y0 - 2, x1: x0 + e.w + 4, y1: y0 + e.h + 2 };
      if (x0 >= fr.x0 + 2 && y0 >= fr.y0 && x0 + e.w <= fr.x1 - 2 && y0 + e.h <= fr.y1 && free(b)) {
        boxes.push(b); placed++; want.add(e.id);
        this.hits.push({ x0, y0, x1: x0 + e.w, y1: y0 + e.h, id: e.id });
      }
    }
    // fades
    const step = dt / 0.25;
    let fading = false;
    for (const e of entries) {
      const t = want.has(e.id) ? 1 : 0, it = wantIcon.has(e.id) ? 1 : 0;
      let fd = this.fades.get(e.id);
      if (!fd) { if (!t && !it) continue; fd = { a: 0, t, ia: 0, it }; this.fades.set(e.id, fd); }
      fd.t = t; fd.it = it;
      fd.a = t > fd.a ? Math.min(1, fd.a + step) : Math.max(0, fd.a - step);
      fd.ia = it > fd.ia ? Math.min(1, fd.ia + step) : Math.max(0, fd.ia - step);
      if (fd.a !== fd.t || fd.ia !== fd.it) fading = true;
      if (!fd.a && !fd.ia && !t && !it) { this.fades.delete(e.id); continue; }
      const p = this.toScreen(e.lat, e.lon);
      if (fd.ia > 0 && e.kind) {
        const look = this.hooks.icon(e.kind);
        if (look) {
          const im = img(look.image, () => this.request());
          ctx.globalAlpha = this.overlayAlpha * fd.ia * fd.ia * (3 - 2 * fd.ia);
          if (im.complete) ctx.drawImage(im, p.x - look.size / 2, p.y - look.size / 2, look.size, look.size);
        }
      }
      if (fd.a > 0) {
        const a = fd.a * fd.a * (3 - 2 * fd.a);
        ctx.globalAlpha = this.overlayAlpha * a;
        ctx.font = e.font;
        ctx.textAlign = e.kind ? 'left' : 'center'; ctx.textBaseline = 'middle';
        const x = e.kind ? p.x + e.iconR + 5 : p.x;
        const text = e.text.includes(HAIR) ? e.text : e.text;
        ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(5,6,10,0.78)';
        ctx.strokeText(text, x, p.y);
        ctx.fillStyle = e.id === this.hovered ? '#8ab4f8' : e.color;
        ctx.fillText(text, x, p.y);
      }
    }
    ctx.globalAlpha = this.overlayAlpha;
    for (const g of glyphs) {
      if (!g.im.complete) continue;
      ctx.save();
      ctx.beginPath(); ctx.arc(g.x, g.y, 12, 0, 2 * Math.PI); ctx.fillStyle = 'rgba(5,6,10,0.55)'; ctx.fill();
      ctx.drawImage(g.im, g.x - 10, g.y - 10, 20, 20);
      ctx.restore();
    }
    for (const p of pinDraw) if (p.im.complete) ctx.drawImage(p.im, p.x - 19, p.y - 38 + 2, 38, 38);
    ctx.globalAlpha = 1;
    return fading;
  }

  /** Names or switches changed: read them again. */
  refreshLabels() { this.entries = null; this.request(); }

  // ---- motion ------------------------------------------------------------------------------
  private stepMotion(now: number, dt: number): boolean {
    if (this.flight) {
      const f = this.flight, t = Math.min(1, (now - f.t0) / f.dur), e = ease(t);
      const dl = wrap180(f.to.lonC - f.from.lonC);
      const ls = Math.log(f.from.s) + (Math.log(f.to.s) - Math.log(f.from.s)) * e;
      // zoom out a little in the middle of long moves, so you see where you are going
      const hop = Math.min(1.2, Math.abs(dl) * f.from.s / this.free().w * 0.5 + Math.abs(f.to.latC - f.from.latC) * f.from.s / this.free().h * 0.5);
      const s = Math.max(Math.exp(ls - hop * Math.sin(Math.PI * e)), this.busy ? 0 : this.fitScale());
      this.view = { lonC: wrap180(f.from.lonC + dl * e), latC: f.from.latC + (f.to.latC - f.from.latC) * e, s };
      if (!this.busy) this.view = this.clampView(this.view);
      if (t >= 1) { this.view = f.to; this.flight = null; f.done(); }
      this.entriesMaybeChanged();
      return true;
    }
    let more = false;
    if (this.zoomTarget) {
      const z = this.zoomTarget, fr = this.free();
      const s = this.view.s + (z.s - this.view.s) * (1 - Math.exp(-dt * 14));
      const done = Math.abs(Math.log(s / z.s)) < 0.002;
      const s2 = done ? z.s : s;
      // keep the anchor point under the cursor
      this.view = this.clampView({ s: s2, lonC: z.lon - (z.x - fr.cx) / s2, latC: z.lat + (z.y - fr.cy) / s2 });
      if (done) this.zoomTarget = null;
      more = true;
    }
    if (this.fling) {
      const fl = this.fling;
      const v = this.view;
      this.view = this.clampView({ s: v.s, lonC: v.lonC - fl.vx * dt / v.s, latC: v.latC + fl.vy * dt / v.s });
      const k = Math.exp(-dt * 4);
      fl.vx *= k; fl.vy *= k;
      if (Math.hypot(fl.vx, fl.vy) < 8) this.fling = null;
      more = true;
    }
    if (this.keysHeld.size && this.active && !this.busy) {
      const sp = 500 * dt / this.view.s;
      const kx = (this.keysHeld.has('ArrowRight') ? 1 : 0) - (this.keysHeld.has('ArrowLeft') ? 1 : 0);
      const ky = (this.keysHeld.has('ArrowUp') ? 1 : 0) - (this.keysHeld.has('ArrowDown') ? 1 : 0);
      this.view = this.clampView({ ...this.view, lonC: this.view.lonC + kx * sp, latC: this.view.latC + ky * sp });
      more = true;
    }
    return more;
  }
  private entriesMaybeChanged() { /* names are placed every frame: nothing to do */ }

  /** A smooth pan / zoom to a view. */
  flyTo(to: FlatView, durS?: number): Promise<void> {
    this.zoomTarget = null; this.fling = null;
    const target = this.busy ? to : this.clampView(to);
    const from = { ...this.view };
    const dist = Math.abs(wrap180(target.lonC - from.lonC)) * from.s / this.free().w + Math.abs(Math.log(target.s / from.s)) * 0.25;
    const dur = (durS ?? clamp(0.5 + dist * 0.5, 0.5, 1.6)) * 1000;
    if (this.flight) this.flight.done();
    return new Promise(res => { this.flight = { from, to: target, t0: performance.now(), dur, done: res }; this.request(); });
  }
  /** A view centred on a spot, about `km` across. */
  viewAt(lat: number, lon: number, km: number): FlatView {
    return this.clampView({ lonC: lon, latC: lat, s: this.free().w / (km * 1000 / M_PER_DEG) });
  }
  zoomBy(logFactor: number, at?: { x: number; y: number }) {
    const fr = this.free();
    const x = at?.x ?? fr.cx, y = at?.y ?? fr.cy;
    const base = this.zoomTarget?.s ?? this.view.s;
    const s = clamp(base * Math.exp(logFactor), this.fitScale(), this.maxScale());
    const ll = this.toLatLon(x, y);
    // already as close as the flat map goes and asked for closer: offer the globe, at the place under the pointer
    if (logFactor > 0 && base >= this.maxScale() * 0.995 && Math.abs(ll.lat) <= 90) this.showPill(ll);
    else if (logFactor < 0) this.hidePill();
    this.flight = null; this.fling = null;
    this.zoomTarget = { s, x, y, lat: this.zoomTarget && !at ? this.zoomTarget.lat : ll.lat, lon: this.zoomTarget && !at ? this.zoomTarget.lon : ll.lon };
    this.request();
  }
  stop() { this.flight?.done(); this.flight = null; this.zoomTarget = null; this.fling = null; this.drag = null; this.keysHeld.clear(); this.hidePill(); }
  private showPill(at: { lat: number; lon: number }) {
    const txt = this.hooks.limitText?.();
    if (!txt || !this.hooks.onCloser) return;
    this.pillAt = at;
    if (!this.pill.classList.contains('show')) {
      this.pill.replaceChildren();
      const msg = document.createElement('span'); msg.className = 'fl-msg'; msg.textContent = txt.msg;
      const go = document.createElement('span'); go.className = 'fl-go'; go.textContent = txt.go;
      this.pill.append(msg, go);
      const fr = this.free();
      this.pill.style.left = `${fr.cx}px`; this.pill.style.top = `${fr.y1 - 20}px`;
      this.pill.classList.add('show');
    }
    clearTimeout(this.pillTimer);
    this.pillTimer = window.setTimeout(() => this.hidePill(), 5000);
  }
  private hidePill() { clearTimeout(this.pillTimer); this.pill.classList.remove('show'); this.pillAt = null; }

  // ---- input -------------------------------------------------------------------------------
  private local(e: { clientX: number; clientY: number }) { const r = this.ui.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  private tagAt(x: number, y: number): unknown {
    for (let i = this.hits.length - 1; i >= 0; i--) { const h = this.hits[i]; if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) return h.id; }
    return undefined;
  }
  private pinAt(x: number, y: number) {
    for (const p of this.hooks.pins()) {
      const s = this.toScreen(p.lat, p.lon);
      if (x >= s.x - 15 && x <= s.x + 15 && y >= s.y - 40 && y <= s.y + 2) return p;
    }
    return null;
  }
  private setHover(id: unknown) { if (id !== this.hovered) { this.hovered = id; this.request(); } }
  private onDown = (e: PointerEvent) => {
    if (!this.active || this.busy || e.button !== 0) return;
    this.ui.setPointerCapture(e.pointerId);
    this.stop();
    const p = this.local(e), ll = this.toLatLon(p.x, p.y);
    this.drag = { x0: p.x, y0: p.y, lat: ll.lat, lon: ll.lon, moved: false, hist: [{ x: p.x, y: p.y, t: performance.now() }] };
  };
  private onMove = (e: PointerEvent) => {
    if (!this.active || this.busy) return;
    const p = this.local(e);
    const d = this.drag;
    if (!d) {
      const id = this.tagAt(p.x, p.y);
      this.setHover(id);
      this.ui.style.cursor = id !== undefined || this.pinAt(p.x, p.y) ? 'pointer' : 'grab';
      const ll = this.toLatLon(p.x, p.y);
      this.hooks.onHover(Math.abs(ll.lat) <= 90 ? ll : null);
      return;
    }
    if (!d.moved && Math.hypot(p.x - d.x0, p.y - d.y0) < 4) return;
    d.moved = true;
    this.ui.style.cursor = 'grabbing';
    const fr = this.free(), s = this.view.s;
    // grab: the point under the cursor stays under it
    this.view = this.clampView({ s, lonC: d.lon - (p.x - fr.cx) / s, latC: d.lat + (p.y - fr.cy) / s });
    const now = performance.now();
    d.hist.push({ x: p.x, y: p.y, t: now });
    while (d.hist.length > 2 && now - d.hist[0].t > 90) d.hist.shift();
    this.request();
  };
  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    this.drag = null;
    if (!d || !this.active) return;
    this.ui.style.cursor = 'grab';
    if (d.moved) {
      const h = d.hist, a = h[0], b = h[h.length - 1], dt = (b.t - a.t) / 1000;
      if (dt > 0.01 && performance.now() - b.t < 60) {
        const vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
        if (Math.hypot(vx, vy) > 120) { this.fling = { vx, vy }; this.request(); }
      }
      return;
    }
    const p = this.local(e);
    if (this.clickTimer) { clearTimeout(this.clickTimer); this.clickTimer = 0; return; } // second click: dblclick handles it
    this.clickTimer = window.setTimeout(() => {
      this.clickTimer = 0;
      if (!this.active || this.busy) return;
      const id = this.tagAt(p.x, p.y);
      if (id !== undefined) return this.hooks.onClickTag(id);
      const pin = this.pinAt(p.x, p.y);
      if (pin) return this.hooks.onClickGround(pin.lat, pin.lon);
      const ll = this.toLatLon(p.x, p.y);
      if (Math.abs(ll.lat) <= 90) this.hooks.onClickGround(ll.lat, ll.lon);
    }, 240);
  };
  private onDbl = (e: MouseEvent) => {
    if (!this.active || this.busy) return;
    e.preventDefault();
    if (this.clickTimer) { clearTimeout(this.clickTimer); this.clickTimer = 0; }
    this.zoomBy(Math.log(2.5), this.local(e));
  };
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!this.active || this.busy) return;
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.zoomBy(clamp(-px * 0.0022, -0.9, 0.9), this.local(e));
  };
  private typing() { const a = document.activeElement as HTMLElement | null; return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable); }
  private onKey = (e: KeyboardEvent) => {
    if (!this.active || this.busy || this.typing() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.startsWith('Arrow')) { e.preventDefault(); this.stop(); this.keysHeld.add(e.key); this.request(); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomBy(0.6); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); this.zoomBy(-0.6); }
  };
  private onKeyUp = (e: KeyboardEvent) => { this.keysHeld.delete(e.key); };

  /** Show (or hide) the layer itself; while shown it takes the pointer. */
  setShown(on: boolean, opacity = on ? 1 : 0) {
    this.el.style.visibility = on || opacity > 0 ? 'visible' : 'hidden';
    this.el.style.opacity = String(opacity);
    this.el.style.pointerEvents = on ? 'auto' : 'none';
    this.ui.style.cursor = this.busy ? 'default' : 'grab';
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
    this.el.remove();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/** Run `fn(e)` for `ms` milliseconds with e eased 0..1 (fn gets the raw t too); resolves at the end. */
export function tween(ms: number, fn: (e: number, t: number) => void, easing: (t: number) => number = ease): Promise<void> {
  return new Promise(res => {
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      fn(easing(t), t);
      if (t < 1) requestAnimationFrame(step); else res();
    };
    if (ms <= 0) { fn(1, 1); res(); } else requestAnimationFrame(step);
  });
}
export { ease, easeOut };
