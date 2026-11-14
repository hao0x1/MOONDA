// Synthesize the film's sound effects from the cue list the film exports (no samples, all generated).
//   node tools/sfx.mjs cues.json out.wav [durationSeconds]
// Cue: { type, t, d?, g? (gain), p? (pan -1..1), f? (pitch factor) }
import { readFileSync, writeFileSync } from 'node:fs';

const [, , cueFile, outFile, durArg] = process.argv;
const cues = JSON.parse(readFileSync(cueFile, 'utf8'));
const SR = 48000;
const DUR = +(durArg ?? Math.max(...cues.map(c => c.t + (c.d ?? 2))) + 6);
const N = Math.ceil(DUR * SR);
const L = new Float32Array(N), R = new Float32Array(N);       // dry bus
const RL = new Float32Array(N), RR = new Float32Array(N);     // reverb send

let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = () => rnd() * 2 - 1;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const put = (i, l, r, send = 0.3) => { if (i < 0 || i >= N) return; L[i] += l; R[i] += r; RL[i] += l * send; RR[i] += r * send; };
const panLR = p => [Math.cos((p + 1) * Math.PI / 4), Math.sin((p + 1) * Math.PI / 4)];

// state-variable filter (Chamberlin) — bandpass / lowpass with moving cutoff
function svf() { let lo = 0, bp = 0; return (x, fc, q) => { const f = 2 * Math.sin(Math.PI * clamp(fc, 20, SR / 6) / SR); const hp = x - lo - q * bp; bp += f * hp; lo += f * bp; return { lo, bp, hp }; }; }

const SYN = {
  // filtered-noise sweep; dir 1 = rising, -1 = falling; pans across
  whoosh(c) {
    const d = c.d ?? 1.1, g = c.g ?? 0.5, n = Math.floor(d * SR), i0 = Math.floor(c.t * SR), dir = c.dir ?? 1;
    const fl = svf(), fr = svf();
    for (let k = 0; k < n; k++) {
      const x = k / n, env = Math.pow(Math.sin(Math.PI * Math.pow(x, dir > 0 ? 0.8 : 1.25)), 2);
      const fc = dir > 0 ? 250 * Math.pow(18, x) : 4500 * Math.pow(1 / 18, x);
      const a = fl(noise(), fc, 0.9).bp, b = fr(noise(), fc * 1.07, 0.9).bp;
      const p = (c.p ?? 0) + (x - 0.5) * 0.9, [gl, gr] = panLR(clamp(p, -1, 1));
      put(i0 + k, a * env * g * gl * 1.4, b * env * g * gr * 1.4, 0.35);
    }
  },
  // rising tension: noise + upward glide, ends at t + d
  riser(c) {
    const d = c.d ?? 2, g = c.g ?? 0.35, n = Math.floor(d * SR), i0 = Math.floor(c.t * SR);
    const fl = svf(), fr = svf(); let ph = 0, ph2 = 0;
    for (let k = 0; k < n; k++) {
      const x = k / n, env = Math.pow(x, 2.2) * (1 - Math.pow(x, 40));
      const fc = 300 * Math.pow(25, x);
      const nl = fl(noise(), fc, 0.6).bp, nr = fr(noise(), fc * 1.1, 0.6).bp;
      const f0 = 110 * Math.pow(4, x); ph += 2 * Math.PI * f0 / SR; ph2 += 2 * Math.PI * f0 * 1.503 / SR;
      const tone = (Math.sin(ph) + 0.5 * Math.sin(ph2)) * 0.25;
      put(i0 + k, (nl * 0.9 + tone) * env * g, (nr * 0.9 + tone) * env * g, 0.4);
    }
  },
  // deep hit: sub drop + soft thump + air
  impact(c) {
    const g = c.g ?? 0.8, i0 = Math.floor(c.t * SR), n = Math.floor(3.2 * SR), lp = svf();
    let ph = 0;
    for (let k = 0; k < n; k++) {
      const s = k / SR, f = 32 + 34 * Math.exp(-s * 9);
      ph += 2 * Math.PI * f / SR;
      const sub = Math.sin(ph) * Math.exp(-s * 1.8) * Math.min(1, s * 400);
      const th = lp(noise(), 160 + 1400 * Math.exp(-s * 30), 0.7).lo * Math.exp(-s * 14) * 1.2;
      const air = noise() * Math.exp(-s * 5) * 0.05;
      const v = (sub * 0.9 + th + air) * g;
      put(i0 + k, v, v, 0.25);
    }
  },
  // tiny UI click
  tick(c) {
    const g = c.g ?? 0.12, i0 = Math.floor(c.t * SR), n = Math.floor(0.03 * SR), f = (c.f ?? 1) * 2400, [gl, gr] = panLR(c.p ?? 0);
    for (let k = 0; k < n; k++) { const s = k / SR, v = Math.sin(2 * Math.PI * f * s) * Math.exp(-s * 260) * g; put(i0 + k, v * gl, v * gr, 0.5); }
  },
  // soft bell blip (pitched), for markers and checks
  blip(c) {
    const g = c.g ?? 0.18, i0 = Math.floor(c.t * SR), n = Math.floor(1.2 * SR), f = 440 * (c.f ?? 2), [gl, gr] = panLR(c.p ?? 0);
    for (let k = 0; k < n; k++) { const s = k / SR, v = (Math.sin(2 * Math.PI * f * s) + 0.35 * Math.sin(2 * Math.PI * f * 2.76 * s) * Math.exp(-s * 6)) * Math.exp(-s * 5) * Math.min(1, s * 300) * g; put(i0 + k, v * gl, v * gr, 0.6); }
  },
  // low buzz for "fails"
  err(c) {
    const g = c.g ?? 0.2, i0 = Math.floor(c.t * SR), n = Math.floor(0.5 * SR), lp = svf();
    for (let k = 0; k < n; k++) { const s = k / SR, saw = ((s * 98) % 1) * 2 - 1 + ((s * 103.5) % 1) * 2 - 1; const v = lp(saw, 700, 0.5).lo * Math.exp(-s * 6) * Math.min(1, s * 200) * g; put(i0 + k, v, v, 0.3); }
  },
  // falling tone (battery draining)
  fall(c) {
    const d = c.d ?? 2, g = c.g ?? 0.12, n = Math.floor(d * SR), i0 = Math.floor(c.t * SR); let ph = 0;
    for (let k = 0; k < n; k++) { const x = k / n, f = 660 * Math.pow(0.25, x); ph += 2 * Math.PI * f / SR; const env = Math.sin(Math.PI * Math.min(1, x * 1.1)) ** 0.6; const v = (Math.sin(ph) + 0.3 * Math.sin(ph * 2)) * env * g; put(i0 + k, v, v, 0.5); }
  },
  // many small pitched grains (particles gathering)
  shimmer(c) {
    const d = c.d ?? 2, g = c.g ?? 0.08, n = Math.floor((c.n ?? 90) * d);
    const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
    for (let j = 0; j < n; j++) {
      const x = j / n, t = c.t + Math.pow(x, c.curve ?? 0.7) * d + rnd() * 0.04;
      const f = 523.25 * Math.pow(2, scale[Math.floor(rnd() * scale.length)] / 12) * (rnd() < 0.3 ? 2 : 1);
      const i0 = Math.floor(t * SR), m = Math.floor(0.6 * SR), [gl, gr] = panLR(rnd() * 1.6 - 0.8), amp = g * (0.4 + 0.6 * rnd()) * (c.swell ? Math.sin(Math.PI * x) : 1);
      for (let k = 0; k < m; k++) { const s = k / SR, v = Math.sin(2 * Math.PI * f * s) * Math.exp(-s * 9) * Math.min(1, s * 900) * amp; put(i0 + k, v * gl, v * gr, 0.7); }
    }
  },
  // warp: rushing noise that slows down with the stars
  warp(c) {
    const d = c.d ?? 9, g = c.g ?? 0.4, n = Math.floor(d * SR), i0 = Math.floor(c.t * SR), fl = svf(), fr = svf();
    for (let k = 0; k < n; k++) {
      const x = k / n, sp = x < 0.08 ? x / 0.08 : x < 0.55 ? 1 : Math.max(0, 1 - (x - 0.55) / 0.45) ** 1.6;
      const fc = 200 + 2600 * sp;
      const a = fl(noise(), fc, 1.1).lo, b = fr(noise(), fc * 1.05, 1.1).lo;
      const env = Math.min(1, x * 12) * (0.25 + 0.75 * sp);
      put(i0 + k, a * env * g, b * env * g, 0.2);
    }
  },
  // dark pad: detuned partials on A with slow movement
  drone(c) {
    const d = c.d ?? 20, g = c.g ?? 0.12, n = Math.floor(d * SR), i0 = Math.floor(c.t * SR);
    const parts = [[55, 1], [55.3, 0.8], [82.4, 0.5], [110, 0.35], [110.6, 0.3], [164.8, 0.12], [220.4, 0.08]];
    const ph = parts.map(() => rnd() * 6.28);
    const fade = c.fade ?? 3;
    for (let k = 0; k < n; k++) {
      const s = k / SR, env = Math.min(1, s / fade) * Math.min(1, (d - s) / fade);
      let v = 0; parts.forEach(([f, a], j) => { ph[j] += 2 * Math.PI * f / SR; v += Math.sin(ph[j]) * a * (0.75 + 0.25 * Math.sin(s * (0.13 + j * 0.05) + j)); });
      const vl = v * env * g, vr = v * env * g * (0.92 + 0.08 * Math.sin(s * 0.31));
      put(i0 + k, vl, vr, 0.5);
    }
  },
};

for (const c of cues) { if (SYN[c.type]) SYN[c.type](c); else console.warn('unknown cue', c.type); }

// Freeverb-style reverb on the send bus
function reverb(inp, sizeMul, wet) {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116].map(x => Math.floor(x * sizeMul * SR / 44100));
  const aps = [556, 441, 341, 225].map(x => Math.floor(x * SR / 44100));
  const out = new Float32Array(inp.length);
  const cb = combs.map(n => ({ b: new Float32Array(n), i: 0, s: 0 }));
  const ab = aps.map(n => ({ b: new Float32Array(n), i: 0 }));
  const fb = 0.86, damp = 0.35;
  for (let k = 0; k < inp.length; k++) {
    const x = inp[k] * 0.015; let y = 0;
    for (const c of cb) { const o = c.b[c.i]; c.s = o * (1 - damp) + c.s * damp; c.b[c.i] = x + c.s * fb; c.i = (c.i + 1) % c.b.length; y += o; }
    for (const a of ab) { const o = a.b[a.i]; const v = -y + o; a.b[a.i] = y + o * 0.5; a.i = (a.i + 1) % a.b.length; y = v; }
    out[k] = y * wet;
  }
  return out;
}
const wl = reverb(RL, 1.0, 1.0), wr = reverb(RR, 1.023, 1.0);
const outL = new Float32Array(N), outR = new Float32Array(N);
let peak = 0;
for (let k = 0; k < N; k++) { outL[k] = L[k] + wl[k] * 3.2; outR[k] = R[k] + wr[k] * 3.2; peak = Math.max(peak, Math.abs(outL[k]), Math.abs(outR[k])); }
const norm = peak > 0.89 ? 0.89 / peak : 1;
// 24-bit WAV
const buf = Buffer.alloc(44 + N * 6);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 6, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 6, 28); buf.writeUInt16LE(6, 32); buf.writeUInt16LE(24, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 6, 40);
for (let k = 0; k < N; k++) for (const [ch, arr] of [[0, outL], [1, outR]]) { const v = Math.round(clamp(arr[k] * norm, -1, 1) * 8388607); buf.writeIntLE(v, 44 + k * 6 + ch * 3, 3); }
writeFileSync(outFile, buf);
console.log(`sfx: ${cues.length} cues, ${DUR.toFixed(1)} s, peak ${peak.toFixed(2)} (scaled ${norm.toFixed(2)}) -> ${outFile}`);
