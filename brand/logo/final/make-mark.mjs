// MOONDA mark, round 3 (Codex's round-2 numbers applied).
// Top edge: skyline computed by MOONDA's horizon code from NASA LOLA heights at de Gerlache Rim 2 (88.39°S, 68.87°W).
import { readFileSync, writeFileSync } from 'node:fs';
const OUT = '/Volumes/CodexWork/Projects/MOONDA/brand/logo/final/';
const d = JSON.parse(readFileSync('/Volumes/CodexWork/Projects/MOONDA/brand/logo/real-horizons.json'));
const e = d['degerlache-rim-2'].elevations, st = 0.5;
const el = a => { const f = a / st, i = Math.floor(f), t = f - i; return e[i] * (1 - t) + e[i + 1] * t; };
const K = [1, 2, 3, 4, 3, 2, 1], sm = a => K.reduce((s, k, j) => s + k * el(a + (j - 3) * 0.75), 0) / 16;
const f = n => +n.toFixed(2);
const args = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')).map(([k, v]) => [k, +v]));
const P0 = { B: 0.3, legTopY: 56, leg: 20, Tl: 21, TlL: 14, TlR: 29, tipY: 62, sunR: 11.5, sunY: 27, ...args };

const B = P0.B; let aL = 150, aR = 172; while (sm(aL) > B) aL -= 0.25; while (sm(aR) > B) aR += 0.25;
const raw = []; for (let a = aL; a < aR; a += 1) raw.push([a, sm(a)]); raw.push([aR, sm(aR)]);
const top = Math.max(...raw.map(p => p[1]));
const sx = 100 / (aR - aL), sy = P0.legTopY / (top - B);
const P = raw.map(([a, v]) => [(a - aL) * sx, P0.legTopY - (v - B) * sy]);
let vi = 0; P.forEach((p, i) => { if (raw[i][0] > 158 && raw[i][0] < 170 && p[1] > P[vi][1]) vi = i; }); if (!(raw[vi][0] > 158)) { vi = P.findIndex((_, i) => raw[i][0] > 158); P.forEach((p, i) => { if (raw[i][0] > 158 && raw[i][0] < 170 && p[1] > P[vi][1]) vi = i; }); }
const [vx, vy] = P[vi];
let c = ''; for (let i = 0; i < P.length - 1; i++) { const p0 = P[i - 1] || P[i], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2] || p2;
  c += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])} `; }
const yAt = x => { for (let i = 0; i < P.length - 1; i++) if (P[i][0] <= x && P[i + 1][0] >= x) { const t = (x - P[i][0]) / (P[i + 1][0] - P[i][0]); return P[i][1] * (1 - t) + P[i + 1][1] * t; } return P.at(-1)[1]; };
const xL = 0, xR = 100;
const iL = [xL + P0.leg, yAt(xL + P0.leg) + (P0.TlL ?? P0.Tl)], iR = [xR - P0.leg, yAt(xR - P0.leg) + (P0.TlR ?? P0.Tl)], iv = [vx, P0.tipY];
const ridge = `M0 100 L0 ${f(P[0][1])} ${c}L100 100 L${f(iR[0])} 100 L${f(iR[0])} ${f(iR[1])} L${f(iv[0])} ${f(iv[1])} L${f(iL[0])} ${f(iL[1])} L${f(iL[0])} 100 Z`;
// perpendicular band thickness: min distance from each inner diagonal to the skyline polyline
const segDist = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
const thick = (a, b) => { let m = 1e9; for (let k = 10; k <= 30; k++) { const q = [a[0] + (b[0] - a[0]) * k / 40, a[1] + (b[1] - a[1]) * k / 40]; let dmin = 1e9; for (let i = 0; i < P.length - 1; i++) dmin = Math.min(dmin, segDist(q, P[i], P[i + 1])); m = Math.min(m, dmin); } return m; };
console.log(JSON.stringify({ vx: f(vx), vy: f(vy), leftArm: f(thick(iL, iv)), rightArm: f(thick(iv, iR)), exaggeration: f(sy / sx), spanDeg: f(aR - aL), aL, aR }));

const WHITE = '#eeeff1', GOLD = '#f1c56b', INK = '#141519', GOLD_D = '#d99a2b';
const sun = { cx: f(vx), cy: P0.sunY, r: P0.sunR };
const circ = (fill, extra = '') => `<circle cx="${sun.cx}" cy="${sun.cy}" r="${sun.r}" fill="${fill}"${extra}/>`;
const VB = 'viewBox="0 0 100 100"';
const colour = (fg, sg) => `<svg xmlns="http://www.w3.org/2000/svg" ${VB}>${circ(sg)}<path d="${ridge}" fill="${fg}"/></svg>`;
// one colour: the Sun is only its visible part, separated from the (untouched) ridge by a 2.75-unit gap
const mono = (fg, gap = 2.75) => `<svg xmlns="http://www.w3.org/2000/svg" ${VB}><defs><mask id="s" maskUnits="userSpaceOnUse" x="-10" y="-10" width="120" height="120"><rect x="-10" y="-10" width="120" height="120" fill="#fff"/><path d="${ridge}" fill="#000" stroke="#000" stroke-width="${gap * 2}" stroke-linejoin="round"/></mask></defs>${circ(fg, ' mask="url(#s)"')}<path d="${ridge}" fill="${fg}"/></svg>`;
const monoNoSun = fg => `<svg xmlns="http://www.w3.org/2000/svg" ${VB}><path d="${ridge}" fill="${fg}"/></svg>`;
writeFileSync(OUT + 'moonda-mark.svg', colour(WHITE, GOLD));
writeFileSync(OUT + 'moonda-mark-on-light.svg', colour(INK, GOLD_D));
writeFileSync(OUT + 'moonda-mark-mono-white.svg', mono(WHITE));
writeFileSync(OUT + 'moonda-mark-mono-black.svg', mono('#000'));
writeFileSync(OUT + 'moonda-mark-tiny-white.svg', monoNoSun(WHITE));
// app icon: rounded tile, mark ~58% of the tile, optically a touch low
const S = 512, m = 0.58 * S, ox = (S - m) / 2, oy = (S - m) / 2 + 0.02 * S;
const iconInner = `<rect width="${S}" height="${S}" rx="${0.225 * S}" fill="#0b0c10"/><g transform="translate(${f(ox)} ${f(oy)}) scale(${f(m / 100)})">${circ(GOLD)}<path d="${ridge}" fill="${WHITE}"/></g>`;
writeFileSync(OUT + 'moonda-icon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">${iconInner}</svg>`);
// favicon: follows the browser's light/dark theme; mark fills the square (tabs are already a surface)
writeFileSync(OUT + 'favicon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 108 108"><style>.r{fill:${INK}}.s{fill:${GOLD_D}}@media (prefers-color-scheme:dark){.r{fill:${WHITE}}.s{fill:${GOLD}}}</style><circle class="s" cx="${sun.cx}" cy="${sun.cy}" r="${sun.r + 1.5}"/><path class="r" d="${ridge}"/></svg>`);
writeFileSync(OUT + 'mark-path.json', JSON.stringify({ ridge, sun, viewBox: '0 0 100 100', params: P0 }));
