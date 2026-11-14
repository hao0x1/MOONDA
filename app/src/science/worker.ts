// Background worker: keeps the height maps in memory and does the heavy maths
// (skyline + Sun/Earth over time) so the 3D map never stutters.

import { analyseSpot, type SpotTimeline } from './analysis.ts';
import { type BodyFixedState, stateSeries } from './ephemeris.ts';
import { MoonHeights } from './heights.ts';
import { planRoute, type RouteData, type RoutePrefer, type RouteResult } from './route.ts';
import { bodyFixedState } from './ephemeris.ts';
import { computeHorizon, type HorizonResult } from './terrain.ts';

export type WorkerRequest =
  | { type: 'warm'; dataBase: string }
  | { type: 'heights'; dataBase: string; meta: import('./heights.ts').DemMeta; global: Int16Array; overview: Int16Array }
  | { type: 'ping' }
  | { type: 'cancel'; id: number }
  | { type: 'analyse'; id: number; lat: number; lon: number; mastM: number; startMs: number; days: number; stepMin: number; dataBase: string; quick?: boolean }
  /** a predicted route for the rover between two pins (route.ts); `timeMs` = the time on the time bar */
  | { type: 'route'; id: number; dataBase: string; from: { lat: number; lon: number }; to: { lat: number; lon: number }; mastM: number; prefer: RoutePrefer; timeMs?: number; spot?: { lat: number; lon: number } };

export type WorkerResponse =
  | { type: 'progress'; id: number; message: string }
  | { type: 'result'; id: number; horizon: HorizonResult; timeline: SpotTimeline }
  | { type: 'error'; id: number; message: string }
  | { type: 'route'; id: number; result: RouteResult }
  | { type: 'routeError'; id: number; message: string }
  | { type: 'pong' };

let heights: MoonHeights | null = null;
// The page normally hands over its own copy of the height maps ('heights' message). If a request comes
// first, wait up to 8 s for that copy before downloading the maps ourselves.
let shared: (() => void) | null = null;
const sharedArrived = new Promise<void>(res => { shared = res; });
async function getHeights(dataBase: string): Promise<MoonHeights> {
  if (!heights) await Promise.race([sharedArrived, new Promise(res => setTimeout(res, 8000))]);
  if (!heights) { heights = new MoonHeights(dataBase); heights.ready.catch(() => { heights = null; }); }
  return heights;
}
const cancelled = new Set<number>(); // jobs the page no longer wants

// What the route planner reads besides the heights: NASA's polar sunlight, Earth-in-view and permanent-shadow maps
// (the same files the Layers box shows; near the pole only) and the crater list. Fetched once, when first needed.
let polarMaps: Promise<Pick<RouteData, 'sunlight' | 'earth' | 'psr'>> | null = null;
let craterList: Promise<Float32Array | null> | null = null;
const grab = (url: string) => fetch(url).then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
function routeData(dataBase: string, polar: boolean): Promise<RouteData> {
  craterList ??= grab(dataBase + 'features/craters.bin').then(b => (b ? new Float32Array(b) : null));
  if (polar) polarMaps ??= Promise.all([grab(dataBase + 'layers/sunlight.bin'), grab(dataBase + 'layers/earth.bin'), grab(dataBase + 'layers/ice.bin')])
    .then(([s, e, p]) => ({ sunlight: s ? new Uint16Array(s) : null, earth: e ? new Uint16Array(e) : null, psr: p ? new Uint16Array(p) : null }));
  return Promise.all([polar ? polarMaps! : Promise.resolve({ sunlight: null, earth: null, psr: null }), craterList]).then(([m, craters]) => ({ ...m, craters }));
}
const seriesCache = new Map<string, BodyFixedState[]>();

function series(startMs: number, days: number, stepMin: number) {
  const key = `${startMs}:${days}:${stepMin}`;
  let s = seriesCache.get(key);
  if (!s) {
    s = stateSeries(startMs, startMs + days * 86400000, stepMin * 60000);
    if (seriesCache.size > 6) seriesCache.delete(seriesCache.keys().next().value!);
    seriesCache.set(key, s);
  }
  return s;
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  const post = (msg: WorkerResponse) => (self as unknown as Worker).postMessage(msg);
  if (req.type === 'heights') { // the page's own copy of the height maps: no second download
    heights = new MoonHeights(req.dataBase, { meta: req.meta, global: req.global, overview: req.overview });
    shared?.();
    return;
  }
  if (req.type === 'ping') { post({ type: 'pong' }); return; }
  if (req.type === 'cancel') { cancelled.add(req.id); return; }
  if (req.type === 'warm') { // load the height maps early so the first click is instant
    void getHeights(req.dataBase);
    return;
  }
  if (req.type === 'route') {
    try {
      const h = await getHeights(req.dataBase);
      await h.ready;
      const polar = req.from.lat < -79 && req.to.lat < -79;
      const data = await routeData(req.dataBase, polar);
      const bodies = req.timeMs !== undefined ? bodyFixedState(req.timeMs) : null;
      // (it pauses every 25 ms of work, so a landing-site calculation asked for meanwhile is not kept waiting)
      const result = await planRoute({ from: req.from, to: req.to, mastM: req.mastM, prefer: req.prefer, spot: req.spot, sun: bodies?.sun, earth: bodies?.earth }, h, data, () => new Promise(res => setTimeout(res, 0)));
      if (cancelled.delete(req.id)) return;
      (self as unknown as Worker).postMessage({ type: 'route', id: req.id, result } satisfies WorkerResponse,
        [result.path.buffer, result.heightM.buffer, result.slopeDeg.buffer, result.sunPct.buffer, result.earthPct.buffer, result.psr.buffer, result.sunNow.buffer, result.earthNow.buffer] as Transferable[]);
    } catch (err) {
      post({ type: 'routeError', id: req.id, message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  try {
    if (req.type === 'analyse') {
      post({ type: 'progress', id: req.id, message: 'Loading NASA height maps…' });
      const h = await getHeights(req.dataBase);
      await h.ready;
      if (cancelled.delete(req.id)) return;
      // quick: rank with the 240 m polar map only (no 80 m downloads); used by the AI's area scans
      // on a slow connection do not wait forever for the 80 m tiles: after 15 s use what is there (240 m elsewhere)
      if (req.lat < -79.5 && !req.quick) await Promise.race([h.loadTilesAround(req.lat, req.lon, 20000), new Promise(res => setTimeout(res, 15000))]);
      if (cancelled.delete(req.id)) return;
      post({ type: 'progress', id: req.id, message: 'Tracing the skyline in 720 directions…' });
      const horizon = computeHorizon(req.lat, req.lon, req.mastM, h);
      post({ type: 'progress', id: req.id, message: 'Following the Sun and Earth…' });
      const timeline = analyseSpot(horizon, series(req.startMs, req.days, req.stepMin), req.stepMin * 60000);
      post({ type: 'result', id: req.id, horizon, timeline });
    }
  } catch (err) {
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
