// Talks to the background worker and remembers results, so React components can just ask
// "what's the sunlight / Earth view at this spot for this time window?"

import { useEffect, useSyncExternalStore } from 'react';
import type { SpotTimeline } from './analysis';
import type { DemMeta } from './heights';
import type { HorizonResult } from './terrain';
import type { WorkerRequest, WorkerResponse } from './worker';

export interface SpotSpec { lat: number; lon: number; mastM: number; startMs: number; days: number; quick?: boolean }

export type SpotEntry =
  | { status: 'loading'; message: string }
  | { status: 'ready'; horizon: HorizonResult; timeline: SpotTimeline }
  | { status: 'error'; message: string };

const cache = new Map<string, SpotEntry>();
const jobs = new Map<number, { key: string; req: WorkerRequest }>(); // sent to the worker, not answered yet
const waiting = new Map<string, number>(); // how many promise callers wait for each spot
const listeners = new Set<() => void>();
let nextId = 1;
let heard = 0;                              // last time the worker said anything
let lastHeights: WorkerRequest | null = null;
let warmed: WorkerRequest | null = null;

function makeWorker() {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = onMessage;
  return w;
}
let worker = makeWorker();

/** A worker that stopped answering is replaced by a fresh one, which gets the height maps and every unanswered job again. */
function restartWorker() {
  worker.terminate();
  worker = makeWorker();
  if (lastHeights) worker.postMessage(lastHeights);
  else if (warmed) worker.postMessage(warmed);
  for (const j of jobs.values()) worker.postMessage(j.req);
}

/** Ask the worker if it is still alive; restart it when it does not answer within 3 s. */
let checking: Promise<void> | null = null;
function checkWorker(): Promise<void> {
  if (checking) return checking;
  const asked = Date.now();
  worker.postMessage({ type: 'ping' } satisfies WorkerRequest);
  checking = new Promise<void>(res => setTimeout(() => { if (heard < asked) restartWorker(); checking = null; res(); }, 3000));
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
  heard = Date.now();
  if (msg.type === 'pong') return;
  const job = jobs.get(msg.id);
  if (!job) return;
  if (msg.type === 'progress') set(job.key, { status: 'loading', message: msg.message });
  else {
    jobs.delete(msg.id);
    if (msg.type === 'result') set(job.key, { status: 'ready', horizon: msg.horizon, timeline: msg.timeline });
    else set(job.key, { status: 'error', message: msg.message });
  }
}

/** Forget an unfinished spot (timed out or no longer wanted): the next request starts it afresh. */
function dropSpot(key: string) {
  for (const [id, j] of jobs) if (j.key === key) { jobs.delete(id); worker.postMessage({ type: 'cancel', id } satisfies WorkerRequest); }
  if (cache.get(key)?.status === 'loading') { cache.delete(key); listeners.forEach(l => l()); }
}

/** Give the worker the page's already-downloaded height maps (a copy: about 46 MB, a few ms), so it
 *  never downloads them a second time. Call once the page's MoonHeights is ready. */
export function shareHeights(h: { meta: DemMeta | null; global: Int16Array | null; overview: Int16Array | null }) {
  if (!h.meta || !h.global || !h.overview) return;
  lastHeights = { type: 'heights', dataBase: new URL('./data/', document.baseURI).href, meta: h.meta, global: h.global, overview: h.overview };
  worker.postMessage(lastHeights);
}

/** Start loading the height maps in the background (call once after the page has drawn). */
export function warmUp() {
  warmed = { type: 'warm', dataBase: new URL('./data/', document.baseURI).href };
  worker.postMessage(warmed);
}

export function requestSpot(spec: SpotSpec) {
  const key = specKey(spec);
  const cur = cache.get(key);
  if (cur && cur.status !== 'error') return;
  const id = nextId++;
  set(key, { status: 'loading', message: 'Starting…' });
  const req: WorkerRequest = { type: 'analyse', id, ...spec, stepMin: stepMinutesFor(spec.days), dataBase: new URL('./data/', document.baseURI).href };
  jobs.set(id, { key, req });
  worker.postMessage(req);
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
