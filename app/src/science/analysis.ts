// Turn a skyline + Sun/Earth positions over time into simple answers:
// "When does this spot get sunlight? When can it see Earth? What's the longest dark stretch?"

import { angularRadiusDeg, azEl, type BodyFixedState, EARTH_RADIUS_M, localFrame, SUN_RADIUS_M } from './ephemeris.ts';
import { horizonAt, type HorizonResult } from './terrain.ts';

export interface SpotTimeline {
  startMs: number;
  stepMs: number;
  count: number;
  sunAz: Float32Array;
  sunEl: Float32Array;
  sunSky: Float32Array; // skyline angle in the Sun's direction
  sunPart: Float32Array; // 0..1 approx. fraction of the Sun's disc above the skyline
  earthAz: Float32Array;
  earthEl: Float32Array;
  earthSky: Float32Array;
  earthPart: Float32Array;
}

export interface SpotStats {
  sunPct: number; // % of time the Sun's centre is above the skyline
  earthPct: number; // % of time Earth's centre is above the skyline
  bothPct: number;
  longestDarkH: number;
  longestNoEarthH: number;
  firstDarkStartMs: number | null;
  sunNowPct: number; // disc fraction at the window start
}

/** Fraction of a disc of angular radius r above a straight line at `sky`, centre at `el`. */
function discFraction(el: number, sky: number, r: number): number {
  const d = (el - sky) / r; // -1 .. 1 across the disc
  if (d >= 1) return 1;
  if (d <= -1) return 0;
  // The part below the line is a circular segment whose chord sits d radii from the centre.
  return 1 - (Math.acos(d) - d * Math.sqrt(1 - d * d)) / Math.PI;
}

export function analyseSpot(h: HorizonResult, states: BodyFixedState[], stepMs: number): SpotTimeline {
  const frame = localFrame({ lat: h.lat, lon: h.lon, heightM: h.groundM + h.mastM });
  const n = states.length;
  const tl: SpotTimeline = {
    startMs: states[0].time, stepMs, count: n,
    sunAz: new Float32Array(n), sunEl: new Float32Array(n), sunSky: new Float32Array(n), sunPart: new Float32Array(n),
    earthAz: new Float32Array(n), earthEl: new Float32Array(n), earthSky: new Float32Array(n), earthPart: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const s = azEl(frame, states[i].sun);
    const e = azEl(frame, states[i].earth);
    const ss = horizonAt(h, s.az), es = horizonAt(h, e.az);
    tl.sunAz[i] = s.az; tl.sunEl[i] = s.el; tl.sunSky[i] = ss;
    tl.sunPart[i] = discFraction(s.el, ss, angularRadiusDeg(SUN_RADIUS_M, s.dist));
    tl.earthAz[i] = e.az; tl.earthEl[i] = e.el; tl.earthSky[i] = es;
    tl.earthPart[i] = discFraction(e.el, es, angularRadiusDeg(EARTH_RADIUS_M, e.dist));
  }
  return tl;
}

function longestRun(flags: (i: number) => boolean, n: number): { len: number; start: number } {
  let best = 0, bestStart = -1, cur = 0, curStart = 0;
  for (let i = 0; i < n; i++) {
    if (flags(i)) { if (cur === 0) curStart = i; cur++; if (cur > best) { best = cur; bestStart = curStart; } }
    else cur = 0;
  }
  return { len: best, start: bestStart };
}

export function statsFor(tl: SpotTimeline, from = 0, to = tl.count): SpotStats {
  const n = Math.max(1, to - from);
  let sun = 0, earth = 0, both = 0;
  for (let i = from; i < to; i++) {
    const s = tl.sunEl[i] > tl.sunSky[i], e = tl.earthEl[i] > tl.earthSky[i];
    if (s) sun++; if (e) earth++; if (s && e) both++;
  }
  const hours = tl.stepMs / 3600000;
  const dark = longestRun(i => !(tl.sunEl[from + i] > tl.sunSky[from + i]), n);
  const noEarth = longestRun(i => !(tl.earthEl[from + i] > tl.earthSky[from + i]), n);
  return {
    sunPct: (100 * sun) / n,
    earthPct: (100 * earth) / n,
    bothPct: (100 * both) / n,
    longestDarkH: dark.len * hours,
    longestNoEarthH: noEarth.len * hours,
    firstDarkStartMs: dark.len ? tl.startMs + (from + dark.start) * tl.stepMs : null,
    sunNowPct: tl.sunPart[from] * 100,
  };
}

/** Runs of true values as [startIndex, endIndexExclusive] pairs, for drawing bars. */
export function runs(test: (i: number) => boolean, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = from; i < to; i++) {
    const v = test(i);
    if (v && start < 0) start = i;
    if (!v && start >= 0) { out.push([start, i]); start = -1; }
  }
  if (start >= 0) out.push([start, to]);
  return out;
}
