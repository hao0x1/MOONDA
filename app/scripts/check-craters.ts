// Run: node scripts/check-craters.ts
// Compare the CPU field with the REAL exported GLSL on this machine's WebGL2 GPU. No app server,
// downloads or screenshot folders are needed. The small GPU buffer is read back using transform feedback.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { acquireBrowserLease } from './browserLease.mjs';
import { craterAtCell, craterFreshFraction, craterHash, craterRelief, craterShader, CRATER_MAX_DEPTH, CRATER_MAX_RIM, CRATER_PHYSICAL_SCALES, CRATER_RELIEF_GAIN, CRATER_ROTATIONS, CRATER_SCALES } from '../src/moon/craterField.ts';

const vectors = [
  { cell: [0, 0, 17], words: [53397, 11090, 54613] },
  { cell: [1, 0, 17], words: [52136, 36482, 19207] },
  { cell: [0, 1, 17], words: [54753, 32801, 41031] },
  { cell: [-1, -1, 17], words: [65071, 51855, 43006] },
  { cell: [-12345, 67890, 51], words: [24294, 29523, 36009] },
];
// Values immediately either side of the discontinuity that a floating fract(dot()) can cross.
const freshVectors = [
  { words: [0, 0], remainder: 0 }, { words: [137, 43209], remainder: 0 },
  { words: [189, 11773], remainder: 0 }, { words: [81, 38470], remainder: 1 },
  { words: [4, 36175], remainder: 6553599 }, { words: [65535, 65535], remainder: 3138880 },
];
const source = craterShader(true);
for (const { cell, words } of vectors) {
  assert.deepEqual(craterHash(cell[0], cell[1], cell[2]).map(v => v * 65536), words, `CPU hash ${cell}`);
  assert.ok(source.includes(`${cell.join(', ')} -> ${words.join(', ')}`), `shader comment is missing hash vector ${cell}`);
}
for (const { words, remainder } of freshVectors) {
  assert.equal(craterFreshFraction(words[0] / 65536, words[1] / 65536), remainder / 6553600, `CPU freshness ${words}`);
}
assert.equal(craterRelief(0, 0), 0, 'landing spot has relief');
assert.ok(!/\buint\b/.test(craterShader(false)), 'WebGL1 fallback contains unsigned integers');
const radiusSum = CRATER_RELIEF_GAIN.reduce((sum, gain, i) => sum + CRATER_SCALES[i] * 0.08 * 2.75 * gain, 0);
assert.ok(CRATER_MAX_DEPTH >= 2 * radiusSum * 0.18, 'maximum depth bound is too short');
assert.ok(CRATER_MAX_RIM >= 2 * radiusSum * 0.035, 'maximum rim bound is too short');

let worstBorder = 0;
// Approach every side of many rotated cells. The apron ends before the side, with zero height
// and slope, so changing the selected cell must never change the height abruptly.
for (let scale = 0; scale < CRATER_PHYSICAL_SCALES; scale++) {
  const S = CRATER_SCALES[scale], [c, s] = CRATER_ROTATIONS[scale], epsilon = 1e-5;
  for (let i = -15; i <= 15; i++) for (let j = -15; j <= 15; j++) for (const t of [0.01, 0.25, 0.5, 0.75, 0.99]) {
    const qe = i * S, qn = (j + t) * S;
    const e = c * qe + s * qn, n = -s * qe + c * qn;
    const a = craterRelief(e - c * epsilon, n + s * epsilon), b = craterRelief(e + c * epsilon, n - s * epsilon);
    worstBorder = Math.max(worstBorder, Math.abs(a - b));
    const qe2 = (i + t) * S, qn2 = j * S;
    const e2 = c * qe2 + s * qn2, n2 = -s * qe2 + c * qn2;
    worstBorder = Math.max(worstBorder, Math.abs(craterRelief(e2 - s * epsilon, n2 - c * epsilon) - craterRelief(e2 + s * epsilon, n2 + c * epsilon)));
  }
}
assert.ok(worstBorder < 0.0001, `cell edge has a height jump: ${worstBorder} m`);

// Inputs have float32 precision, just like the coordinates handed to the ground shader. Include
// the 3.5 km recenter test, bowl floors, rims and aprons; random points alone mostly hit flat ground.
const rows: number[][] = [];
for (let i = 0; i < 16000; i++) {
  const e = Math.fround(8000 * (((i * 0.61803398875) % 1) - 0.5));
  const n = Math.fround(8000 * (((i * 0.41421356237) % 1) - 0.5));
  const v = vectors[i % vectors.length];
  rows.push([e, n, ...v.cell]);
}
for (let scale = 0; scale < CRATER_PHYSICAL_SCALES; scale++) for (let ce = -8; ce <= 8; ce++) for (let cn = -8; cn <= 8; cn++) {
  const bowl = craterAtCell(scale, ce, cn);
  if (!bowl) continue;
  for (const f of [0, 0.25, 0.65, 0.99, 1, 1.01, 1.4, 1.79, 1.8, 1.81]) {
    rows.push([Math.fround(bowl.e + f * bowl.radius), Math.fround(bowl.n), ...vectors[rows.length % vectors.length].cell]);
  }
}
rows.push([0, 0, 0, 0, 17]);
for (let i = 0; i < rows.length; i++) rows[i].push(...freshVectors[i % freshVectors.length].words);

const vertex = `#version 300 es
precision highp float;
precision highp int;
in vec2 point;
in vec3 hashInput;
in vec2 freshInput;
out vec4 checkValue;
out float freshnessValue;
out float freshnessRemainder;
const vec4 lvCraters = vec4(1.0, 6.0, 0.55, 1.0);
const vec2 lvCraterKeep = vec2(0.0);
vec2 lvRot(vec2 p, vec2 cs) { return vec2(cs.x*p.x-cs.y*p.y, cs.y*p.x+cs.x*p.y); }
${source}
void main() {
    float height = 0.0, alb = 1.0;
    for (int i = 0; i < ${CRATER_PHYSICAL_SCALES}; i++) {
        height += lvCraterScale(point, lvCraterSize(i), 17.0*float(i+1), lvCraterRotation(i), vec2(1.0, 0.0), 0.5, alb, 1.0).z;
    }
    checkValue = vec4(height, lvCraterHash(hashInput.xy, hashInput.z));
    freshnessValue = lvCraterFreshFraction(freshInput / 65536.0);
    freshnessRemainder = float(lvCraterFreshRemainder(freshInput / 65536.0));
    gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
    gl_PointSize = 1.0;
}`;

const lease = await acquireBrowserLease({ script: 'check-craters.ts' });
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
let gpu: { values: number[]; renderer: string };
try {
  browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run'],
});
  await lease.afterLaunch(browser);
  const page = (await browser.pages())[0] ?? await browser.newPage();
  gpu = await page.evaluate((vs, inputs) => {
    const canvas = document.createElement('canvas'), gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 is required to check the exact crater shader');
    const compile = (kind: number, text: string) => {
      const shader = gl.createShader(kind)!;
      gl.shaderSource(shader, text); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader compile failed');
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float; out vec4 colour; void main(){ colour=vec4(1.0); }'));
    gl.transformFeedbackVaryings(program, ['checkValue', 'freshnessValue', 'freshnessRemainder'], gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'shader link failed');
    gl.useProgram(program);
    const input = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, input); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(inputs.flat()), gl.STATIC_DRAW);
    for (const [name, size, offset] of [['point', 2, 0], ['hashInput', 3, 8], ['freshInput', 2, 20]] as const) {
      const loc = gl.getAttribLocation(program, name); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 28, offset);
    }
    const output = gl.createBuffer()!, feedback = gl.createTransformFeedback()!;
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, output); gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, inputs.length * 24, gl.STREAM_READ);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, output);
    gl.enable(gl.RASTERIZER_DISCARD); gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, inputs.length); gl.endTransformFeedback(); gl.disable(gl.RASTERIZER_DISCARD);
    const values = new Float32Array(inputs.length * 6); gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, values);
    const error = gl.getError(); if (error) throw new Error(`WebGL error ${error}`);
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return { values: Array.from(values), renderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)) };
  }, vertex, rows);
} finally { try { await browser?.close(); } finally { lease.release(); } }

let worstGpu = 0, worstFresh = 0, worstAt: number[] = [];
for (let i = 0; i < rows.length; i++) {
  const row = rows[i], cpu = craterRelief(row[0], row[1]), actual = gpu.values[i * 6];
  assert.ok(Number.isFinite(actual), `non-finite GPU relief at ${row.slice(0, 2)}`);
  const error = Math.abs(actual - cpu);
  if (error > worstGpu) { worstGpu = error; worstAt = row.slice(0, 2); }
  const hash = craterHash(row[2], row[3], row[4]);
  for (let h = 0; h < 3; h++) assert.equal(gpu.values[i * 6 + h + 1], hash[h], `GPU hash word ${h}, cell ${row.slice(2, 5)}`);
  assert.equal(gpu.values[i * 6 + 5], freshVectors[i % freshVectors.length].remainder, `GPU freshness remainder ${row.slice(5)}`);
  // Division may round by one float32 bit; the discontinuous integer remainder must be exact.
  worstFresh = Math.max(worstFresh, Math.abs(gpu.values[i * 6 + 4] - craterFreshFraction(row[5] / 65536, row[6] / 65536)));
}
assert.ok(worstGpu < 0.015, `CPU / actual GLSL relief differs by ${worstGpu} m at ${worstAt}`);
assert.ok(worstFresh < 1e-7, `CPU / GPU freshness fraction differs by ${worstFresh}`);
console.log(JSON.stringify({ ok: true, hashVectors: vectors.length, freshnessBoundaryVectors: freshVectors.length, worstFreshFraction: worstFresh, gpuSamples: rows.length, worstCpuGpuM: worstGpu, worstAt, worstCellBorderM: worstBorder, landingReliefM: craterRelief(0, 0), renderer: gpu.renderer }, null, 2));
