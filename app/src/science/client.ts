// Talks to the background worker and remembers results, so React components can just ask
// "what's the sunlight / Earth view at this spot for this time window?"

import { useEffect, useSyncExternalStore } from 'react';
import type { SpotTimeline } from './analysis';
import type { DemMeta } from './heights';
import type { RoutePrefer, RouteResult } from './route';
import type { HorizonResult } from './terrain';
import type { WorkerRequest, WorkerResponse } from './worker';

export interface SpotSpec { lat: number; lon: number; mastM: number; startMs: number; days: number; quick?: boolean }

export type SpotEntry =
  | { status: 'loading'; message: string }
  | { status: 'ready'; horizon: HorizonResult; timeline: SpotTimeline }
  | { status: 'error'; message: string };

const cache = new Map<string, SpotEntry>();
const jobs = new Map<number, { key: string; req: WorkerRequest; timer: ReturnType<typeof setTimeout>; retries: number }>();
const waiting = new Map<string, number>(); // how many promise callers wait for each spot
const listeners = new Set<() => void>();
/** route requests sent to the worker and not answered yet (kept apart from the spot jobs above) */
const routes = new Map<number, { req: WorkerRequest; done: (r: RouteResult) => void; fail: (e: Error) => void; retries: number }>();
let nextId = 1;
let heard = 0;                              // messages heard (also distinguishes replies in the same millisecond)
let lastHeights: WorkerRequest | null = null;
let warmed: WorkerRequest | null = null;
let worker: Worker | null = null;
const SPOT_TIMEOUT_MS = 60000;

function makeWorker() {
  try {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = ev => { if (worker === w) onMessage(ev); };
    const failed = (ev: Event) => { ev.preventDefault(); if (worker === w) restartWorker(); };
    w.onerror = failed;
    w.onmessageerror = failed;
    return w;
  } catch { return null; }
}

function failPending(message: string) {
  for (const [id, j] of [...jobs]) {
    jobs.delete(id); clearTimeout(j.timer);
    set(j.key, { status: 'error', message });
  }
  for (const [id, r] of [...routes]) { routes.delete(id); r.fail(new Error(message)); }
}

/** Create lazily so an unavailable module worker cannot prevent the app itself from opening. */
function ensureWorker(skip?: WorkerRequest): Worker | null {
  if (worker) return worker;
  worker = makeWorker();
  try {
    const initial = lastHeights ?? warmed;
    if (initial && initial !== skip) worker?.postMessage(initial);
  } catch { worker?.terminate(); worker = null; }
  return worker;
}

/** Replay each unanswered request once, retaining its original deadline; repeated crashes become retryable errors. */
function restartWorker() {
  worker?.terminate(); worker = null;
  for (const [id, j] of [...jobs]) {
    if (j.retries++ === 0) continue;
    jobs.delete(id); clearTimeout(j.timer);
    set(j.key, { status: 'error', message: 'The calculator stopped. Select another spot, then try again.' });
  }
  for (const [id, r] of [...routes]) {
    if (r.retries++ === 0) continue;
    routes.delete(id); r.fail(new Error('The route calculator stopped. Try again.'));
  }
  if (!jobs.size && !routes.size) return;
  const w = ensureWorker();
  if (!w) { failPending('The calculator could not start. Select another spot, then try again.'); return; }
  try {
    for (const j of jobs.values()) w.postMessage(j.req);
    for (const r of routes.values()) w.postMessage(r.req);
  } catch { w.terminate(); worker = null; failPending('The calculator could not restart. Try again.'); }
}

function send(req: WorkerRequest) {
  const w = ensureWorker(req);
  if (!w) { failPending('The calculator could not start. Select another spot, then try again.'); return; }
  try { w.postMessage(req); } catch { restartWorker(); }
}

/** Ask the worker if it is still alive; restart it when it does not answer within 3 s. */
let checking: Promise<void> | null = null;
function checkWorker(): Promise<void> {
  if (checking) return checking;
  const w = worker;
  if (!w) return Promise.resolve();
  const asked = heard;
  try { w.postMessage({ type: 'ping' } satisfies WorkerRequest); } catch { restartWorker(); return Promise.resolve(); }
  checking = new Promise<void>(res => setTimeout(() => { if (worker === w && heard === asked) restartWorker(); checking = null; res(); }, 3000));
  return checking;
}

export const stepMinutesFor = (days: number) => (days <= 7 ? 5 : days <= 31 ? 10 : 30);
export const specKey = (s: SpotSpec) => `${s.lat.toFixed(5)},${s.lon.toFixed(5)},${s.mastM},${s.startMs},${s.days}${s.quick ? ',q' : ''}`;

function set(key: string, entry: SpotEntry) {
  cache.set(key, entry);
  if (cache.size > 80) cache.delete(cache.keys().next().value!);
  listeners.forEach(l => l());
}

function onMessage(ev: MessageEvent<WorkerResponse>) {
  const msg = ev.data;
  heard++;
  if (msg.type === 'pong') return;
  if (msg.type === 'route' || msg.type === 'routeError') {
    const r = routes.get(msg.id);
    if (!r) return;
    routes.delete(msg.id);
    if (msg.type === 'route') r.done(msg.result); else r.fail(new Error(msg.message));
    return;
  }
  const job = jobs.get(msg.id);
  if (!job) return;
  if (msg.type === 'progress') set(job.key, { status: 'loading', message: msg.message });
  else {
    jobs.delete(msg.id); clearTimeout(job.timer);
    if (msg.type === 'result') set(job.key, { status: 'ready', horizon: msg.horizon, timeline: msg.timeline });
    else set(job.key, { status: 'error', message: msg.message });
  }
}

/** Forget an unfinished spot (timed out or no longer wanted): the next request starts it afresh. */
function dropSpot(key: string) {
  for (const [id, j] of jobs) if (j.key === key) { jobs.delete(id); clearTimeout(j.timer); if (worker) send({ type: 'cancel', id }); }
  if (cache.get(key)?.status === 'loading') { cache.delete(key); listeners.forEach(l => l()); }
}

/** Give the worker the page's already-downloaded height maps (a copy: about 46 MB, a few ms), so it
 *  never downloads them a second time. Call once the page's MoonHeights is ready. */
export function shareHeights(h: { meta: DemMeta | null; global: Int16Array | null; overview: Int16Array | null }) {
  if (!h.meta || !h.global || !h.overview) return;
  lastHeights = { type: 'heights', dataBase: new URL('./data/', document.baseURI).href, meta: h.meta, global: h.global, overview: h.overview };
  send(lastHeights);
}

/** Start loading the height maps in the background (call once after the page has drawn). */
export function warmUp() {
  warmed = { type: 'warm', dataBase: new URL('./data/', document.baseURI).href };
  send(warmed);
}

export function requestSpot(spec: SpotSpec) {
  const key = specKey(spec);
  const cur = cache.get(key);
  if (cur && cur.status !== 'error') return;
  const id = nextId++;
  set(key, { status: 'loading', message: 'Starting…' });
  const req: WorkerRequest = { type: 'analyse', id, ...spec, stepMin: stepMinutesFor(spec.days), dataBase: new URL('./data/', document.baseURI).href };
  const timer = setTimeout(() => {
    if (!jobs.delete(id)) return;
    set(key, { status: 'error', message: 'The calculation took too long. Select another spot, then try again.' });
    if (worker) send({ type: 'cancel', id });
    void checkWorker();
  }, SPOT_TIMEOUT_MS);
  jobs.set(id, { key, req, timer, retries: 0 });
  send(req);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

export function useSpot(spec: SpotSpec | null): SpotEntry | undefined {
  const key = spec ? specKey(spec) : '';
  useEffect(() => { if (spec) requestSpot(spec); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return useSyncExternalStore(subscribe, () => (key ? cache.get(key) : undefined));
}

export function useSpots(specs: SpotSpec[]): (SpotEntry | undefined)[] {
  const keys = specs.map(specKey).join('|');
  useEffect(() => { specs.forEach(requestSpot); }, [keys]); // eslint-disable-line react-hooks/exhaustive-deps
  const snap = useSyncExternalStore(subscribe, () => specs.map(s => cache.get(specKey(s))).map(e => e ?? null).reduce((acc, e) => acc + '|' + (e ? e.status + (e.status === 'loading' ? e.message : '') : '-'), ''));
  void snap;
  return specs.map(s => cache.get(specKey(s)));
}

/** Promise version for code outside React (the AI helper): resolves when the worker has the answer.
 *  Rejects after `timeoutMs` or when `signal` is aborted; either way the unfinished job is forgotten
 *  (so it cannot block the same spot later) and a worker that stopped answering is restarted. */
export function analyseSpotAsync(spec: SpotSpec, timeoutMs = 60000, signal?: AbortSignal): Promise<{ horizon: HorizonResult; timeline: SpotTimeline }> {
  const key = specKey(spec);
  if (signal?.aborted) return Promise.reject(new Error('Stopped.'));
  requestSpot(spec);
  waiting.set(key, (waiting.get(key) ?? 0) + 1);
  return new Promise((resolve, reject) => {
    let over = false;
    const done = () => {
      if (over) return false;
      over = true;
      clearTimeout(timer);
      listeners.delete(check);
      signal?.removeEventListener('abort', onAbort);
      const left = (waiting.get(key) ?? 1) - 1;
      if (left > 0) waiting.set(key, left); else waiting.delete(key);
      return true;
    };
    const giveUp = (message: string) => {
      if (!done()) return;
      if (!waiting.has(key)) dropSpot(key);
      reject(new Error(message));
    };
    const check = () => {
      const e = cache.get(key);
      if (e?.status === 'ready') { if (done()) resolve({ horizon: e.horizon, timeline: e.timeline }); }
      else if (e?.status === 'error') { if (done()) reject(new Error(e.message)); }
    };
    const onAbort = () => giveUp('Stopped.');
    const timer = setTimeout(() => { void checkWorker(); giveUp('The calculation took too long.'); }, timeoutMs);
    signal?.addEventListener('abort', onAbort);
    listeners.add(check);
    check();
  });
}

/**
 * A predicted route for the rover between two places (science/route.ts), worked out in the background.
 * `timeMs` = the time on the time bar: the answer also says where the Sun and Earth can be seen along the way then.
 * Abort with `signal` when the answer is no longer wanted.
 */
export function planRouteAsync(o: { from: { lat: number; lon: number }; to: { lat: number; lon: number }; mastM: number; prefer: RoutePrefer; timeMs?: number; spot?: { lat: number; lon: number } }, signal?: AbortSignal): Promise<RouteResult> {
  const id = nextId++;
  const req: WorkerRequest = { type: 'route', id, dataBase: new URL('./data/', document.baseURI).href, ...o };
  return new Promise<RouteResult>((done, fail) => {
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    const stop = () => { if (routes.delete(id)) { clean(); if (worker) send({ type: 'cancel', id }); fail(new DOMException('Aborted', 'AbortError')); } };
    if (signal?.aborted) { fail(new DOMException('Aborted', 'AbortError')); return; }
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => {
      if (!routes.delete(id)) return;
      clean(); if (worker) send({ type: 'cancel', id });
      fail(new Error('The route took too long')); void checkWorker();
    }, 90000);
    routes.set(id, { req, retries: 0, done: r => { clean(); done(r); }, fail: e => { clean(); fail(e); } });
    send(req);
  });
}
