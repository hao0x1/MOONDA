// Small craters are an artist's impression, not extra NASA measurements. Their cells and profiles
// are shared by the drawn light and the terrain, so the wheels follow the bowl that the eye sees.
// Coordinates are metres east / north of the landing spot and must never follow the shadow maps.

export const CRATER_SHARE = 0.55;
export const CRATER_PHYSICAL_SCALES = 3; // 1.3–53.5 m across; larger craters still only shade the coarse NASA ground
// Broad, old bowls are shallow. Their rims must not invent peaks in the measured NASA skyline;
// the two small sizes keep their full depth so the rover can still dip into a nearby hollow.
export const CRATER_RELIEF_GAIN = [1, 1, 0.2] as const;
// Float32 constants are written out in the shader too: asking two processors to take cos() can
// otherwise move a cell boundary. The hash itself uses only exact, wrapping 32-bit integers.
export const CRATER_SCALES = [8, 31.200000762939453, 121.68000030517578, 474.552001953125, 1850.7528076171875, 7217.93603515625] as const;
export const CRATER_ROTATIONS: readonly (readonly [number, number])[] = [
  [0.4535961151123047, 0.8912073373794556], [-0.9364707469940186, -0.3507457673549652],
  [0.9274485111236572, -0.37395086884498596], [-0.431268572807312, 0.9022235870361328],
  [-0.291442334651947, -0.9565883874893188], [0.8610683083534241, 0.5084892511367798],
];
/** Conservative sum of the deepest possible bowls (normally only one or two overlap). */
export const CRATER_MAX_DEPTH = 5.1;
export const CRATER_MAX_RIM = 1;

// PCG RXS-M-XS output permutation (O'Neill 2014, Apache 2.0 / MIT, pcg-random.org).
function pcg(value: number): number {
  const state = (Math.imul(value, 747796405) + 2891336453) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/** Three exact 16-bit fractions. Negative cells wrap in exactly the same way as GLSL uint(ivec2). */
export function craterHash(cellE: number, cellN: number, seed: number): [number, number, number] {
  const key = (Math.imul(cellE, 1597334677) ^ Math.imul(cellN, 3812015801) ^ Math.imul(seed, 2798796415)) >>> 0;
  return [(pcg(key) & 65535) / 65536, (pcg(key ^ 0x68bc21eb) & 65535) / 65536, (pcg(key ^ 0x02e5be93) & 65535) / 65536];
}

/** Take the fraction before converting to floating point: a rounded dot product can cross 1.0
 * and turn a fresh, deep crater into an old, shallow one on just one processor. */
export function craterFreshFraction(hashE: number, hashN: number): number {
  return ((hashE * 65536 * 4131 + hashN * 65536 * 2717) % 6553600) / 6553600;
}

export interface Crater {
  scale: number; cellE: number; cellN: number; e: number; n: number; radius: number; depth: number; rim: number; fresh: number;
}

/** The crater in a cell, or null for an empty cell or the clear patch round the lander. */
export function craterAtCell(scale: number, cellE: number, cellN: number): Crater | null {
  const S = CRATER_SCALES[scale], rot = CRATER_ROTATIONS[scale];
  if (S === undefined || !rot) return null;
  const r = craterHash(cellE, cellN, 17 * (scale + 1));
  if (r[2] > CRATER_SHARE) return null;
  const size = r[2] / CRATER_SHARE, radius = S * 0.08 * Math.pow(2.75, size * size);
  const wander = 1 - 3.6 * radius / S;
  const qe = (cellE + 0.5 + (r[0] - 0.5) * wander) * S;
  const qn = (cellN + 0.5 + (r[1] - 0.5) * wander) * S;
  const e = rot[0] * qe + rot[1] * qn, n = -rot[1] * qe + rot[0] * qn;
  if (e * e + n * n < 3.4 * radius * radius) return null;
  let fresh = craterFreshFraction(r[0], r[1]);
  fresh *= fresh; fresh *= fresh * fresh;
  const gain = CRATER_RELIEF_GAIN[scale] ?? 1;
  return { scale, cellE, cellN, e, n, radius, depth: 2 * radius * (0.035 + 0.145 * fresh) * gain, rim: 2 * radius * (0.005 + 0.03 * fresh) * gain, fresh };
}

/** Height in metres, above or below LOLA. Only the three sizes missing from its 80 m map are real relief. */
export function craterRelief(e: number, n: number): number {
  let height = 0;
  for (let i = 0; i < CRATER_PHYSICAL_SCALES; i++) {
    const S = CRATER_SCALES[i], rot = CRATER_ROTATIONS[i];
    const ce = Math.floor((rot[0] * e - rot[1] * n) / S), cn = Math.floor((rot[1] * e + rot[0] * n) / S);
    const r = craterHash(ce, cn, 17 * (i + 1));
    if (r[2] > CRATER_SHARE) continue;
    const size = r[2] / CRATER_SHARE, radius = S * 0.08 * Math.pow(2.75, size * size);
    const wander = 1 - 3.6 * radius / S;
    const qe = (ce + 0.5 + (r[0] - 0.5) * wander) * S;
    const qn = (cn + 0.5 + (r[1] - 0.5) * wander) * S;
    const ctrE = rot[0] * qe + rot[1] * qn, ctrN = -rot[1] * qe + rot[0] * qn;
    const de = e - ctrE, dn = n - ctrN, x2 = (de * de + dn * dn) / (radius * radius);
    if (x2 >= 3.24 || ctrE * ctrE + ctrN * ctrN < 3.4 * radius * radius) continue;
    let fresh = craterFreshFraction(r[0], r[1]);
    fresh *= fresh; fresh *= fresh * fresh;
    const gain = CRATER_RELIEF_GAIN[i];
    const depth = 2 * radius * (0.035 + 0.145 * fresh) * gain, rim = 2 * radius * (0.005 + 0.03 * fresh) * gain;
    if (x2 < 1) { const u = 1 - x2; height += rim - (depth + rim) * u * u; }
    else { const t = Math.min((Math.sqrt(x2) - 1) / 0.8, 1), q = 1 - t; height += rim * (1 + 3 * t) * q * q * q; }
  }
  return height;
}

/** A short central difference is useful for checks and slope previews; wheels read the actual mesh. */
export function craterSlope(e: number, n: number): [number, number] {
  const d = 0.005;
  return [(craterRelief(e + d, n) - craterRelief(e - d, n)) / (2 * d), (craterRelief(e, n + d) - craterRelief(e, n - d)) / (2 * d)];
}

/** WebGL1 keeps its old floating hash and shading; relief is enabled only alongside this exact WebGL2 path. */
export function craterShader(integerHash: boolean): string {
  return `${integerHash ? `
// Exact hash test vectors: cell E, cell N, seed -> three unsigned 16-bit words.
// 0, 0, 17 -> 53397, 11090, 54613
// 1, 0, 17 -> 52136, 36482, 19207
// 0, 1, 17 -> 54753, 32801, 41031
// -1, -1, 17 -> 65071, 51855, 43006
// -12345, 67890, 51 -> 24294, 29523, 36009
uint lvCraterPcg(uint value) {
    uint state = value * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}
vec3 lvCraterHash(vec2 cell, float seed) {
    uvec2 c = uvec2(ivec2(cell));
    uint key = c.x * 1597334677u ^ c.y * 3812015801u ^ uint(seed) * 2798796415u;
    return vec3(lvCraterPcg(key) & 65535u, lvCraterPcg(key ^ 0x68bc21ebu) & 65535u, lvCraterPcg(key ^ 0x02e5be93u) & 65535u) / 65536.0;
}
// Exact freshness boundary vectors, 16-bit words E / N -> integer remainder before division:
// 137, 43209 -> 0; 81, 38470 -> 1; 4, 36175 -> 6553599.
uint lvCraterFreshRemainder(vec2 hash) {
    uvec2 words = uvec2(hash * 65536.0);
    return (words.x * 4131u + words.y * 2717u) % 6553600u;
}
float lvCraterFreshFraction(vec2 hash) {
    return float(lvCraterFreshRemainder(hash)) / 6553600.0;
}
` : `
vec3 lvCraterHash(vec2 cell, float seed) { return lvHash3(cell + seed); }
float lvCraterFreshFraction(vec2 hash) { return fract(dot(hash, vec2(41.31, 27.17))); }
`}
float lvCraterSize(int i) {
    if (i == 0) return 8.0;
    if (i == 1) return 31.200000762939453;
    if (i == 2) return 121.68000030517578;
    if (i == 3) return 474.552001953125;
    if (i == 4) return 1850.7528076171875;
    return 7217.93603515625;
}
vec2 lvCraterRotation(int i) {
    if (i == 0) return vec2(0.4535961151123047, 0.8912073373794556);
    if (i == 1) return vec2(-0.9364707469940186, -0.3507457673549652);
    if (i == 2) return vec2(0.9274485111236572, -0.37395086884498596);
    if (i == 3) return vec2(-0.431268572807312, 0.9022235870361328);
    if (i == 4) return vec2(-0.291442334651947, -0.9565883874893188);
    return vec2(0.8610683083534241, 0.5084892511367798);
}
// Height, slope and the rim shadow use the same bowl and apron as craterRelief above. Keeping the
// base LOLA normal on displaced tiles means these analytical slopes light a crater just once.
vec4 lvCraterScale(vec2 p, float S, float seed, vec2 rot, vec2 sdir, float tanE, inout float alb, float wc) {
    vec4 acc = vec4(0.0, 0.0, 0.0, 1.0);
    vec2 cell = floor(lvRot(p, rot) / S);
    vec3 r = lvCraterHash(cell, seed);
    if (r.z > lvCraters.z) return acc;
    float sz = r.z / lvCraters.z;
    float R = S * 0.08 * pow(2.75, sz * sz);
    float j = 1.0 - 3.6 * R / S;
    vec2 ctr = lvRot((cell + 0.5 + (r.xy - 0.5) * j) * S, vec2(rot.x, -rot.y));
    vec2 d = p - ctr;
    float x2 = dot(d, d) / (R * R);
    if (x2 >= 3.24) return acc;
    vec2 dl = lvCraterKeep.xy - ctr;
    if (dot(dl, dl) < 3.4 * R * R) return acc;
    float fresh = lvCraterFreshFraction(r.xy); fresh *= fresh; fresh *= fresh * fresh;
    float gain = seed == 51.0 ? ${CRATER_RELIEF_GAIN[2]} : 1.0;
    float depth = 2.0 * R * mix(0.035, 0.18, fresh) * lvCraters.w * gain, rim = 2.0 * R * mix(0.005, 0.035, fresh) * lvCraters.w * gain;
    float x = sqrt(x2), h, dhdr;
    if (x < 1.0) {
        float u = 1.0 - x2;
        h = rim - (depth + rim) * u * u; dhdr = 4.0 * (depth + rim) * x * u / R;
    } else {
        float t = min((x - 1.0) / 0.8, 1.0), q = 1.0 - t;
        h = rim * (1.0 + 3.0 * t) * q * q * q; dhdr = -12.0 * rim * t * q * q / (0.8 * R);
    }
    acc.xy = dhdr * d / max(x * R, 1e-4);
    acc.z = h;
    alb *= 1.0 + wc * 0.12 * fresh * (1.0 - smoothstep(0.7, 1.7, x));
    if (x < 1.0 && tanE < 2.0) {
        float b = dot(d, sdir), c = dot(d, d) - R * R;
        float tOut = -b + sqrt(max(b * b - c, 0.0));
        float clear = h + tOut * tanE - rim;
        acc.w = mix(0.1, 1.0, smoothstep(-0.04 * R - tOut * 0.0093, 0.0, clear));
    }
    return acc;
}
`;
}
