// MOONDA demo film — engine: drawing layers + a seekable master timeline.
// Everything on screen is a pure function of the film time t, so the renderer can step frame by frame.
/* global gsap, SplitText, ScrambleTextPlugin, DrawSVGPlugin, CustomEase */
gsap.registerPlugin(SplitText, ScrambleTextPlugin, DrawSVGPlugin, CustomEase);
gsap.ticker.lagSmoothing(0);
gsap.config({ force3D: true, nullTargetWarn: false });
CustomEase.create('cine', 'M0,0 C0.18,0 0.08,1 1,1');           // fast start, long soft landing
CustomEase.create('cineInOut', 'M0,0 C0.7,0 0.12,1 1,1');
CustomEase.create('swift', 'M0,0 C0.4,0 0,1 1,1');

const W = 1920, H = 1080, FPS = 60;
const $ = s => document.querySelector(s);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------------------------------------------------------------- state (tweened by the timeline)
const S = {
  stars: { a: 0, cx: W / 2, cy: H / 2, lift: 0 },
  milky: { a: 0, x: 0 },
  moon: { a: 0, cx: W / 2, cy: H / 2, r: 300, yaw: 0, pitch: 0, roll: 0, lx: -0.6, ly: 0.35, lz: 0.72, exp: 1.0, glow: 0, glowW: 0.06, rim: 0, earthshine: 0.02, warm: 0.0 },
  half: { p: 0, a: 1, cx: W / 2, cy: H / 2, s: 1, ink: 0.07, out: 0 },
  ascii: { a: 0, shift: 0, src: 0 },
  cam: { s: 1, x: 0, y: 0, r: 0 },
};

// ---------------------------------------------------------------- assets
const IMG = {};
const loadImg = (k, src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => { IMG[k] = i; res(i); }; i.onerror = rej; i.src = src; });

// ---------------------------------------------------------------- star field (warp → drift)
// warp speed keyframes [time, speed]; speed is "depth units per second"
const WARP = [[0, 0.0], [0.15, 0.0], [0.9, 1.9], [4.8, 1.6], [8.6, 0.05], [10.5, 0.012], [400, 0.012]];
function warpSpeed(t) {
  for (let i = 1; i < WARP.length; i++) if (t <= WARP[i][0]) { const [t0, v0] = WARP[i - 1], [t1, v1] = WARP[i]; return mix(v0, v1, smooth((t - t0) / (t1 - t0))); }
  return WARP.at(-1)[1];
}
const DIST = []; { let d = 0; for (let i = 0; i <= 400 * 120; i++) { DIST.push(d); d += warpSpeed(i / 120) / 120; } }
const distAt = t => { const f = t * 120, i = Math.floor(f); return i >= DIST.length - 1 ? DIST.at(-1) : mix(DIST[i], DIST[i + 1], f - i); };
const STARS = []; { const r = rng(7); for (let i = 0; i < 1500; i++) { const a = r() * Math.PI * 2, rad = Math.pow(r(), 0.55) * 1.35; STARS.push({ x: Math.cos(a) * rad * 1.78, y: Math.sin(a) * rad, z: r(), m: 0.35 + r() * 0.65, tw: r() * 6.28 }); } }

const bg = $('#bg').getContext('2d');
function drawBg(t) {
  bg.clearRect(0, 0, W, H);
  const m = S.milky;
  if (m.a > 0.001 && IMG.milky) {
    bg.globalAlpha = m.a;
    const iw = 3600, ih = 1800;
    bg.drawImage(IMG.milky, -600 + m.x, -360, iw, ih);
    bg.globalAlpha = 1;
  }
  const st = S.stars;
  if (st.a > 0.001) {
    const D = distAt(t), v = warpSpeed(t), F = 520;
    const cx = st.cx, cy = st.cy - st.lift;
    bg.lineCap = 'round';
    for (const s of STARS) {
      let z = s.z - D * 0.55; z = z - Math.floor(z); z = 0.02 + z * 0.98;   // 0.02..1
      const z2 = Math.min(1, z + v * 0.05 + 0.0015);
      const x1 = cx + (s.x / z) * F * 0.32, y1 = cy + (s.y / z) * F * 0.32;
      const x0 = cx + (s.x / z2) * F * 0.32, y0 = cy + (s.y / z2) * F * 0.32;
      if (x1 < -50 || x1 > W + 50 || y1 < -50 || y1 > H + 50) continue;
      const near = 1 - z;
      const twinkle = 0.85 + 0.15 * Math.sin(t * 2.1 + s.tw);
      const a = st.a * s.m * clamp(near * 1.4 + 0.15) * twinkle;
      bg.strokeStyle = `rgba(235,240,255,${a.toFixed(3)})`;
      bg.lineWidth = 0.6 + near * 1.6 * s.m;
      bg.beginPath(); bg.moveTo(x0, y0); bg.lineTo(x1 + 0.01, y1 + 0.01); bg.stroke();
    }
  }
  if (S.ascii.a > 0.001) drawAscii(t);
}

// ---------------------------------------------------------------- ASCII height field (science scene background)
let ASCII = null;
function prepAscii() {
  const cols = 160, rows = 62, c = document.createElement('canvas'); c.width = cols; c.height = rows;
  const g = c.getContext('2d'); g.drawImage(IMG.height, 0, 0, cols, rows);
  const d = g.getImageData(0, 0, cols, rows).data, lum = new Float32Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) lum[i] = (d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11) / 255;
  ASCII = { cols, rows, lum };
}
const RAMP = ' .·:-=+*#%@';
function drawAscii(t) {
  const { cols, rows, lum } = ASCII, cw = 12.5, ch = 18;
  bg.font = '13px GMono'; bg.textBaseline = 'top';
  const sh = S.ascii.shift;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const sx = (x + Math.floor(sh)) % cols;
    const l = lum[y * cols + sx];
    const k = Math.min(RAMP.length - 1, Math.floor(l * RAMP.length));
    if (k === 0) continue;
    const flick = 0.75 + 0.25 * Math.sin(t * 3 + x * 0.7 + y * 1.3);
    bg.fillStyle = `rgba(200,210,225,${(S.ascii.a * (0.15 + l * 0.55) * flick).toFixed(3)})`;
    bg.fillText(RAMP[k], x * cw - (sh % 1) * cw, y * ch);
  }
}

// ---------------------------------------------------------------- WebGL Moon (real NASA texture, lit sphere)
const gl = $('#gl').getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: true, preserveDrawingBuffer: true });
let GLP = null;
function initGL() {
  const vs = `#version 300 es
  in vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`;
  const fs = `#version 300 es
  precision highp float;
  uniform vec2 uC; uniform float uR; uniform mat3 uRot; uniform vec3 uL; uniform sampler2D uTex;
  uniform float uExp, uGlow, uGlowW, uRim, uAlpha, uES, uWarm;
  out vec4 o;
  void main(){
    vec2 px = vec2(gl_FragCoord.x, 1080.0 - gl_FragCoord.y);
    vec2 d = (px - uC) / uR; float r = length(d);
    vec3 L = normalize(uL);
    vec3 col = vec3(0.); float a = 0.;
    if (r < 1.0 + 2.0/uR) {
      float rr = min(r, 0.99999);
      vec2 dd = d * (rr / max(r, 1e-5));
      vec3 n = vec3(dd.x, -dd.y, sqrt(max(0., 1. - rr*rr)));
      vec3 w = uRot * n;
      float lon = atan(w.x, w.z), lat = asin(clamp(w.y, -1., 1.));
      vec2 uv = vec2(lon / 6.2831853 + 0.5, 0.5 - lat / 3.14159265);
      vec2 uv2 = vec2(fract(uv.x + 0.5) - 0.5, uv.y);
      vec2 dx = dFdx(uv), dy = dFdy(uv), dx2 = dFdx(uv2), dy2 = dFdy(uv2);
      vec3 tex = (abs(dx.x) + abs(dy.x) <= abs(dx2.x) + abs(dy2.x)) ? textureGrad(uTex, uv, dx, dy).rgb : textureGrad(uTex, uv2, dx2, dy2).rgb;
      tex = pow(tex, vec3(1.08));
      float ndl = dot(n, L), ndv = max(n.z, 0.02);
      float ls = max(ndl, 0.) / (max(ndl, 0.) + ndv) * 2.0;                 // Lommel-Seeliger (the Moon looks flat-lit)
      float lam = max(ndl, 0.);
      float shade = mix(lam, ls, 0.55);
      float term = smoothstep(-0.03, 0.10, ndl);
      vec3 lit = tex * shade * term * uExp;
      lit *= mix(vec3(1.), vec3(1.06, 1.0, 0.92), uWarm);
      lit += tex * uES;                                                        // earthshine on the night side
      float rim = pow(1. - ndv, 3.0) * smoothstep(-0.15, 0.25, ndl) * uRim;   // bright sunlit edge
      lit += vec3(1.0, 0.94, 0.84) * rim;
      a = clamp((1.0 - r) * uR + 0.5, 0., 1.);
      col = lit * a;
    }
    if (uGlow > 0.) {                                                          // soft light around the lit limb
      float dist = max(r - 1., 0.);
      vec2 dir = d / max(r, 1e-4);
      float facing = clamp(dot(normalize(vec3(dir.x, -dir.y, 0.25)), L) * 0.8 + 0.25, 0., 1.);
      float g = exp(-dist / uGlowW) * facing * uGlow;
      float g2 = exp(-dist / (uGlowW * 4.)) * facing * uGlow * 0.35;
      col += vec3(0.80, 0.86, 1.0) * g * (1. - a) + vec3(0.6, 0.68, 0.9) * g2 * (1. - a);
    }
    o = vec4(col * uAlpha, a * uAlpha);
  }`;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
  gl.useProgram(pr);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, IMG.moon);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  const ext = gl.getExtension('EXT_texture_filter_anisotropic'); if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  const U = n => gl.getUniformLocation(pr, n);
  GLP = { pr, u: { C: U('uC'), R: U('uR'), Rot: U('uRot'), L: U('uL'), Tex: U('uTex'), Exp: U('uExp'), Glow: U('uGlow'), GlowW: U('uGlowW'), Rim: U('uRim'), Alpha: U('uAlpha'), ES: U('uES'), Warm: U('uWarm') } };
  gl.viewport(0, 0, W, H);
}
function rotMat(yaw, pitch, roll) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  // R = Ry(yaw) * Rx(pitch) * Rz(roll)  (column-major for GL)
  const Rz = [cr, sr, 0, -sr, cr, 0, 0, 0, 1];
  const Rx = [1, 0, 0, 0, cp, sp, 0, -sp, cp];
  const Ry = [cy, 0, -sy, 0, 1, 0, sy, 0, cy];
  const mul = (A, B) => { const C = new Array(9).fill(0); for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) C[c * 3 + r] += A[k * 3 + r] * B[c * 3 + k]; return C; };
  return new Float32Array(mul(Ry, mul(Rx, Rz)));
}
function drawGL() {
  const m = S.moon;
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  if (m.a <= 0.001) return;
  const u = GLP.u, d2r = Math.PI / 180;
  gl.uniform2f(u.C, m.cx, m.cy); gl.uniform1f(u.R, m.r);
  gl.uniformMatrix3fv(u.Rot, false, rotMat(m.yaw * d2r, m.pitch * d2r, m.roll * d2r));
  gl.uniform3f(u.L, m.lx, m.ly, m.lz); gl.uniform1i(u.Tex, 0);
  gl.uniform1f(u.Exp, m.exp); gl.uniform1f(u.Glow, m.glow); gl.uniform1f(u.GlowW, m.glowW); gl.uniform1f(u.Rim, m.rim);
  gl.uniform1f(u.Alpha, m.a); gl.uniform1f(u.ES, m.earthshine); gl.uniform1f(u.Warm, m.warm);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// ---------------------------------------------------------------- halftone Moon made of dots (logo)
const fg = $('#fg').getContext('2d');
let DOTS = null;
function prepDots() {
  // sample the Moon photo on a lit sphere into a grid of dots
  const tw = 1024, th = 512, c = document.createElement('canvas'); c.width = tw; c.height = th;
  const g = c.getContext('2d'); g.drawImage(IMG.moon, 0, 0, tw, th);
  const px = g.getImageData(0, 0, tw, th).data;
  const R = 1, step = 0.046, out = [], r = rng(11);
  const L = [-0.28, 0.22, 0.93], ln = Math.hypot(...L); L.forEach((v, i) => { L[i] = v / ln; });
  for (let y = -R; y <= R; y += step * 0.866) {
    const row = Math.round((y + R) / (step * 0.866));
    for (let x = -R + (row % 2 ? step / 2 : 0); x <= R; x += step) {
      const rr = x * x + y * y; if (rr > 0.985) continue;
      const nz = Math.sqrt(1 - rr), n = [x, -y, nz];
      const yaw = 0.0, wx = n[0] * Math.cos(yaw) + n[2] * Math.sin(yaw), wz = -n[0] * Math.sin(yaw) + n[2] * Math.cos(yaw), wy = n[1];
      const lon = Math.atan2(wx, wz), lat = Math.asin(wy);
      const u = Math.floor((lon / (Math.PI * 2) + 0.5) * tw) % tw, v = Math.floor((0.5 - lat / Math.PI) * th);
      const i = (v * tw + u) * 4, tex = (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11) / 255;
      const ndl = Math.max(0, n[0] * L[0] + n[1] * L[1] + n[2] * L[2]);
      const b = clamp(clamp((tex - 0.16) / 0.5) * (0.45 + 0.55 * Math.pow(ndl, 0.7)));
      const dist = Math.sqrt(rr);
      const ang = r() * Math.PI * 2, far = 0.9 + r() * 1.6;
      out.push({ x, y, b, dist, sx: Math.cos(ang) * far * 1.8 + (r() - 0.5) * 0.4, sy: Math.sin(ang) * far + (r() - 0.5) * 0.4, delay: dist * 0.42 + r() * 0.16, sw: (r() - 0.5) * 2 });
    }
  }
  DOTS = out;
}
function drawFg(t) {
  fg.clearRect(0, 0, W, H);
  const h = S.half;
  if (h.a > 0.001 && h.p > 0) {
    const R = 250 * h.s, ink = h.ink;
    for (const d of DOTS) {
      const q = clamp((h.p - d.delay) / 0.5);
      if (q <= 0) continue;
      const e = 1 - Math.pow(1 - q, 4);
      const sw = Math.sin(Math.PI * e) * d.sw * 0.35;
      const x = mix(d.sx, d.x, e) + (-d.sy) * sw * (1 - e), y = mix(d.sy, d.y, e) + d.sx * sw * (1 - e);
      const o = h.out > 0 ? clamp(1 - (h.out * 1.6 - d.dist * 0.6)) : 1;
      if (o <= 0) continue;
      const rad = (0.7 + (1 - d.b) * 4.7) * h.s * mix(0.45, 1, e) * (h.out > 0 ? o : 1);
      fg.fillStyle = `rgba(${Math.round(ink * 255)},${Math.round(ink * 255)},${Math.round(ink * 255 + 4)},${(h.a * mix(0.25, 1, e) * o).toFixed(3)})`;
      fg.beginPath(); fg.arc(h.cx + x * R, h.cy + y * R, Math.max(0.3, rad), 0, Math.PI * 2); fg.fill();
    }
  }
}

// ---------------------------------------------------------------- grain
const GRAIN = [];
function prepGrain() {
  const r = rng(3);
  for (let k = 0; k < 8; k++) {
    const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d'); const im = g.createImageData(256, 256);
    for (let i = 0; i < im.data.length; i += 4) { const v = Math.floor(r() * 255); im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; }
    g.putImageData(im, 0, 0); GRAIN.push(c.toDataURL());
  }
}
function drawGrain(f) { const g = $('#grain'); g.style.backgroundImage = `url(${GRAIN[f % GRAIN.length]})`; g.style.backgroundPosition = `${(f * 37) % 256}px ${(f * 91) % 256}px`; }

// ---------------------------------------------------------------- footage clips
const CLIPS = [];
// local time = offset + (t - start) * rate ; held on its first/last frame outside that range while the window is open
function clip(video, start, opts = {}) { const c = { v: video, start, offset: opts.offset ?? 0, rate: opts.rate ?? 1, map: opts.map ?? null, until: opts.until ?? Infinity, last: -1 }; CLIPS.push(c); return c; }
// map: [[secondsAfterStart, footageTime], ...] piecewise-linear speed changes
function mapTime(map, r) { if (r <= map[0][0]) return map[0][1]; for (let i = 1; i < map.length; i++) if (r <= map[i][0]) { const [a, x] = map[i - 1], [b, y] = map[i]; return x + (y - x) * (r - a) / (b - a); } const [a, x] = map.at(-1); return x + (r - a); }
function seekVideo(v, time) {
  return new Promise(res => {
    let done = false; const fin = () => { if (!done) { done = true; v.removeEventListener('seeked', fin); res(); } };
    v.addEventListener('seeked', fin); v.currentTime = time; setTimeout(fin, 3000);
  });
}
async function syncClips(t) {
  const jobs = [];
  for (const c of CLIPS) {
    const v = c.v; if (!v.duration) continue;
    if (t < c.start - 0.5 || t > c.until + 0.5) continue;
    let lt = c.map ? mapTime(c.map, t - c.start) : c.offset + (t - c.start) * c.rate;
    lt = clamp(lt, 0, v.duration - 1 / 60);
    const target = (Math.floor(lt * 60 + 1e-6) + 0.5) / 60;
    if (Math.abs(target - c.last) < 1e-6) continue;
    c.last = target; jobs.push(seekVideo(v, Math.min(target, v.duration - 0.004)));
  }
  await Promise.all(jobs);
}

// ---------------------------------------------------------------- text helpers
function split(el, type = 'chars') { const s = SplitText.create(el, { type: type === 'chars' ? 'words,chars' : 'words', charsClass: 'char', wordsClass: 'word' }); return type === 'chars' ? s.chars : s.words; }
// blur in: characters arrive from blur, slightly below, staggered
function blurIn(tl, el, at, o = {}) {
  const parts = split(el, o.by ?? 'chars');
  tl.fromTo(parts, { opacity: 0, filter: `blur(${o.blur ?? 16}px)`, y: o.y ?? 26, scale: o.scale ?? 1 },
    { opacity: 1, filter: 'blur(0px)', y: 0, scale: 1, duration: o.dur ?? 1.0, ease: o.ease ?? 'cine', stagger: o.stagger ?? 0.028 }, at);
  return parts;
}
function blurOut(tl, el, at, o = {}) {
  tl.to(el, { opacity: 0, filter: `blur(${o.blur ?? 18}px)`, y: o.y ?? -18, scale: o.scale ?? 1.0, duration: o.dur ?? 0.6, ease: o.ease ?? 'power2.in' }, at);
}
function h(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; }
function scene(id, cls = '') { const s = h(`<section class="scene ${cls}" id="${id}"></section>`); $('#scenes').appendChild(s); return s; }
function show(tl, el, from, to) { tl.set(el, { visibility: 'visible' }, from); if (to !== undefined) tl.set(el, { visibility: 'hidden' }, to); }

// ---------------------------------------------------------------- master
const master = gsap.timeline({ paused: true });
const CUES = [];
const cue = (type, t, o = {}) => { CUES.push({ type, t: +t.toFixed(3), ...o }); };
window.FILM = { S, master, cue, clip, blurIn, blurOut, split, h, scene, show, clamp, mix, rng, W, H, IMG };

let readyP = null;
async function boot() {
  await Promise.all([loadImg('moon', 'assets/moon4k.jpg'), loadImg('milky', 'assets/milkyway.jpg'), loadImg('height', 'assets/pole-height.jpg')]);
  await document.fonts.load('400 40px GSF'); await document.fonts.load('400 20px GMono'); await document.fonts.load('400 20px Khmer');
  await document.fonts.ready;
  initGL(); prepDots(); prepAscii(); prepGrain();
  if (window.buildFilm) await window.buildFilm();
  await Promise.all([...document.querySelectorAll('video')].map(v => v.readyState >= 1 ? 0 : new Promise(r => { v.addEventListener('loadedmetadata', r, { once: true }); v.addEventListener('error', r, { once: true }); setTimeout(r, 8000); })));
  window.__film.duration = master.duration();
}
window.__film = {
  duration: 0,
  cues: CUES,
  ready: () => readyP ??= boot(),
  async seek(t) {
    master.time(t, false);
    const cm = S.cam; $('#cam').style.transform = `translate(${cm.x}px,${cm.y}px) scale(${cm.s}) rotate(${cm.r}deg)`;
    drawBg(t); drawGL(); drawFg(t); drawGrain(Math.round(t * FPS));
    await syncClips(t);
    return true;
  },
};
// preview: index.html?t=12.5 shows that moment;  ?play plays in real time (videos may lag)
(async () => {
  const q = new URLSearchParams(location.search);
  await window.__film.ready();
  if (q.has('t')) await window.__film.seek(+q.get('t'));
  if (q.has('play')) { const t0 = performance.now() - (+q.get('play') || 0) * 1000; const loop = async () => { await window.__film.seek((performance.now() - t0) / 1000); requestAnimationFrame(loop); }; loop(); }
  document.body.dataset.ready = '1';
})();
