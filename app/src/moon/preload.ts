// Start-up loader. While the start screen is up we get EVERYTHING ready that the first minutes need,
// so nothing loads halfway once the person is in:
//   photo      the Moon's photo tiles for the opening view (sharp, nothing left to fetch) + the layer legends
//   mountains  the height maps (46 MB) and the 3D ground built from them at the opening view
//   sky        stars, Milky Way, Earth and Sun pictures for the chosen graphics mode
//   science    the landing-site calculator (background worker) has the heights and has done one real calculation
//   pole       a quick, invisible visit to the south-pole views people go to first (tiles, 3D ground, shaders)
//   surface    the "Stand here" view: its ground scans, rock models and shaders (lander.prewarm() when present)
//   layers     compact sources, decoded previews and cached tiles for the Layers switches
//   music      the music file, so it can start the moment the person enters
// (and "app": the app's own code, downloaded by the page before any of this starts; index.html shows it loading)
// Each stage reports its real state (waiting / loading with a fraction when we can count it / done).
// Every stage has a time limit, so a slow network delays the start but never blocks it: a stage that runs
// out of time is shown as "finishes in the background" and keeps loading after the person enters.

import type { Viewer } from 'cesium';
import type { CameraPose } from './navigation';
import { settings } from '../app/settings';
import { prefetchMusic } from '../audio/music';
import { t } from '../i18n';
import { analyseSpotAsync } from '../science/client';
import { loadManifest } from '../science/layerValues';

export type StageId = 'app' | 'photo' | 'mountains' | 'sky' | 'layers' | 'science' | 'pole' | 'surface' | 'music';
/** later = ran out of time, keeps loading in the background; off = not needed (music switched off) */
export type StageState = 'waiting' | 'loading' | 'done' | 'later' | 'off';
export interface Stage { id: StageId; state: StageState; /** 0…1 while loading, when it can be counted */ frac: number | null; /** how long it took */ ms?: number }
export interface LoadProgress { pct: number; step: string; done: boolean; stages: Stage[] }

export const STAGES: StageId[] = ['app', 'photo', 'mountains', 'sky', 'layers', 'science', 'pole', 'surface', 'music'];
/** Share of the overall percentage, roughly by how long each stage takes on a first visit. */
const WEIGHT: Record<StageId, number> = { app: 0, photo: 12, mountains: 30, sky: 10, layers: 12, science: 8, pole: 18, surface: 17, music: 5 };

/** The app's code is in by the time anything here runs: that row starts out done, with the time the page took to get it. */
const appStage = (): Stage => ({ id: 'app', state: 'done', frac: null, ms: Math.round(performance.now()) });
const freshStage = (id: StageId): Stage => (id === 'app' ? appStage() : { id, state: 'waiting', frac: null });

/** The state before anything has started (the start screen draws this on its first frame). */
export function initialProgress(): LoadProgress {
  return { pct: 0, step: t('start.step.start'), done: false, stages: STAGES.map(freshStage) };
}

export interface PreloadDeps {
  heightsReady: Promise<unknown>;
  namesReady: Promise<unknown>;
  skyReady?: Promise<unknown>;
  /** Number of photo-tile jobs still running in the background workers (0 when quiet). */
  imageryPending?: () => number;
  /** The "Stand here" view; prewarm() (when it exists) loads its textures and models and compiles its shaders. */
  lander?: { prewarm?: () => Promise<unknown> };
  /** Small supporting files behind the Layers switches, downloaded into the browser cache. */
  layerFiles?: () => Promise<string[]>;
  /** Prepare bounded previews and projected tiles alongside the existing pole warm-up. False means some work continues later. */
  warmLayers?: (onFrac: (frac: number) => void) => Promise<boolean | void>;
  /** The view the user will see first. */
  startView: CameraPose;
  /** Views to visit invisibly (camera jumps there, tiles load, shaders compile), in order. Called once the height map is loaded. */
  warmViews: () => { pose: CameraPose; label: string; maxMs: number; warm?: () => void }[];
  onProgress(p: LoadProgress): void;
  /** Set to true (e.g. by a "Skip" button) to finish as soon as possible. */
  cancelled?: () => boolean;
}

/** The south-pole views see far over the horizon, where the photos come from NASA's server (slow from far away):
 *  give each view this many times its own time limit before calling it "finishes in the background". */
const POLE_TIME = 2.5;

/** Which kinds of photo jobs are still waiting (for the trace), e.g. "trek×12 synth×4". */
function waitingKinds(): string {
  const w = (globalThis as { __moondaImagery?: { waiting(): { kind: string }[] } }).__moondaImagery?.waiting() ?? [];
  const n = new Map<string, number>();
  for (const x of w) n.set(x.kind, (n.get(x.kind) ?? 0) + 1);
  return [...n].map(([k, c]) => `${k}×${c}`).join(' ');
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
/** true when `p` settled in time (resolved or failed), false when the time ran out */
function withTimeout<T>(p: Promise<T>, ms: number, cancelled?: () => boolean): Promise<boolean> {
  return new Promise(resolve => {
    let over = false;
    const end = (ok: boolean) => { if (!over) { over = true; clearTimeout(timer); clearInterval(poll); resolve(ok); } };
    const timer = setTimeout(() => end(false), ms);
    const poll = setInterval(() => { if (cancelled?.()) end(false); }, 100); // a skip ends the wait at once
    p.then(() => end(true), () => end(true));
  });
}

/** Render frames until the globe has nothing left to load for a few frames in a row, or time runs out.
 *  `onFrac` hears how much of the photo work is done (from the most tile jobs seen waiting at once). */
export async function waitUntilLoaded(viewer: Viewer, maxMs: number, pending?: () => number, cancelled?: () => boolean, onFrac?: (f: number) => void): Promise<boolean> {
  const t0 = performance.now();
  let quiet = 0, peak = 1;
  while (performance.now() - t0 < maxMs) {
    if (viewer.isDestroyed() || cancelled?.()) return false;
    viewer.scene.requestRender();
    // setTimeout as well as requestAnimationFrame: a tab in the background gets very few animation frames
    await Promise.race([new Promise<void>(r => requestAnimationFrame(() => r())), sleep(50)]);
    if (viewer.isDestroyed()) return false;
    const n = pending ? pending() : 0;
    peak = Math.max(peak, n);
    const done = viewer.scene.globe.tilesLoaded && n === 0;
    onFrac?.(done ? 1 : Math.min(0.95, 1 - n / peak));
    quiet = done ? quiet + 1 : 0;
    if (quiet >= 4 && performance.now() - t0 > 250) return true;
  }
  return false;
}

const setPose = (viewer: Viewer, p: CameraPose) => {
  viewer.camera.setView({ destination: p.destination, orientation: { direction: p.direction, up: p.up } });
  viewer.scene.requestRender();
};

/** Until lander.prewarm() exists: fetch the files the Stand-here view asks for, so they come from the browser cache. */
async function fetchSurfaceFiles(onFrac: (f: number) => void, cancelled: () => boolean): Promise<void> {
  const base = new URL('./lander/', document.baseURI);
  const files = ['regolith_a.webp', 'regolith_b.webp', 'regolith_c.webp'].map(f => new URL(f, base).href);
  // the rock models: each glTF names its own mesh and picture files
  const rocks = Array.from({ length: 7 }, (_, i) => new URL(`rocks/moon_rock_0${i + 1}/rock.gltf`, base));
  const listed = await Promise.all(rocks.map(u => fetch(u).then(r => (r.ok ? r.json() : null)).then((g: { buffers?: { uri?: string }[]; images?: { uri?: string }[] } | null) =>
    [...(g?.buffers ?? []), ...(g?.images ?? [])].map(x => x.uri).filter((x): x is string => !!x && !x.startsWith('data:')).map(x => new URL(x, u).href),
  ).catch(() => [] as string[])));
  files.push(...listed.flat());
  let done = 0;
  // a few at a time: the network stays free for anything else the start-up still needs
  const queue = [...files];
  const lane = async () => {
    for (let f = queue.shift(); f && !cancelled(); f = queue.shift()) {
      await fetch(f).then(r => r.arrayBuffer()).catch(() => null);
      onFrac(++done / files.length);
    }
  };
  await Promise.all([lane(), lane(), lane()]);
}

/** Download files into the browser cache, a couple at a time, reporting how many are in. True when all arrived. */
async function fetchFiles(files: string[], onFrac: (f: number) => void, cancelled: () => boolean, lanes = 2): Promise<boolean> {
  let done = 0, ok = true;
  const queue = [...files];
  const lane = async () => {
    for (let f = queue.shift(); f && !cancelled(); f = queue.shift()) {
      const good = await fetch(f).then(r => r.arrayBuffer().then(() => r.ok)).catch(() => false);
      ok = ok && good;
      onFrac(++done / files.length);
    }
  };
  await Promise.all(Array.from({ length: lanes }, lane));
  return ok && done === files.length;
}

export async function runPreload(viewer: Viewer, d: PreloadDeps): Promise<void> {
  const stop = () => viewer.isDestroyed() || !!d.cancelled?.();
  const cancelled = () => !!d.cancelled?.();
  // what happened, for tests and for "why did it take so long" (window.__moonda.preloadTrace)
  const trace: string[] = [];
  const hook = (window as unknown as { __moonda?: Record<string, unknown> }).__moonda;
  if (hook) hook.preloadTrace = trace;
  const stages = new Map<StageId, Stage>(STAGES.map(id => [id, freshStage(id)]));
  const began = new Map<StageId, number>();
  let finished = false, lastPct = -1, lastSent = '';

  const send = () => {
    if (finished || viewer.isDestroyed()) return;
    const list = STAGES.map(id => ({ ...stages.get(id)! }));
    let got = 0, all = 0;
    for (const s of list) {
      all += WEIGHT[s.id];
      got += WEIGHT[s.id] * (s.state === 'done' || s.state === 'later' || s.state === 'off' ? 1 : s.state === 'loading' ? (s.frac ?? 0) : 0);
    }
    const pct = Math.min(99, Math.floor((100 * got) / all));
    const current = list.find(s => s.state === 'loading');
    const key = list.map(s => s.state).join() + pct;
    if (key === lastSent && pct === lastPct) return;
    lastSent = key; lastPct = pct;
    d.onProgress({ pct, step: current ? t(`start.stage.${current.id}`) : t('start.step.start'), done: false, stages: list });
  };
  const mark = (id: StageId, state: StageState, frac: number | null = null) => {
    const s = stages.get(id)!;
    if (state === 'loading' && !began.has(id)) began.set(id, performance.now());
    if (state !== 'loading' && state !== 'waiting' && began.has(id)) s.ms = Math.round(performance.now() - began.get(id)!);
    s.state = state; s.frac = frac;
    send();
  };
  const frac = (id: StageId) => (f: number) => {
    const s = stages.get(id)!;
    if (s.state !== 'loading' || (s.frac !== null && Math.abs(f - s.frac) < 0.02 && f < 1)) return;
    s.frac = f; send();
  };
  /** run one stage: loading → done when `job` says it finished in time, otherwise "later" */
  const stage = async (id: StageId, job: () => Promise<boolean | void>) => {
    mark(id, 'loading');
    let ok = false;
    try { ok = (await job()) !== false; } catch { ok = false; }
    if (!viewer.isDestroyed()) mark(id, ok && !cancelled() ? 'done' : 'later');
  };

  // music: only when it is switched on; switching it on during start-up fetches it then
  let musicJob: Promise<void> | null = null;
  const music = () => {
    if (!settings.get().sound) { if (stages.get('music')!.state === 'waiting') mark('music', 'off'); return; }
    if (musicJob) return;
    musicJob = stage('music', () => withTimeout(prefetchMusic(), 20000, cancelled).then(ok => ok));
  };
  const offSound = settings.subscribe((s, prev) => { if (s.sound && !prev.sound) music(); });

  try {
    send();
    music();
    const manifest = withTimeout(loadManifest(), 8000, cancelled); // the layer legends (small)
    const sky = d.skyReady ? stage('sky', () => withTimeout(d.skyReady!, 30000, cancelled)) : Promise.resolve(mark('sky', 'done'));

    // the height maps download from the very start, while the opening view's photo loads
    let heightsOk = false;
    let photoDone = () => {};
    const photoFinished = new Promise<void>(r => { photoDone = r; });
    const mountains = stage('mountains', async () => {
      heightsOk = await withTimeout(d.heightsReady, 90000, cancelled);
      await photoFinished;
      if (stop()) return false;
      await sleep(60); // the map swaps in the 3D ground when the heights arrive
      setPose(viewer, d.startView);
      // then the 3D ground at the opening view
      return heightsOk && await waitUntilLoaded(viewer, 15000, d.imageryPending, d.cancelled);
    });

    // the opening view's photo, on the smooth ball (the 3D ground replaces it once the heights are in)
    setPose(viewer, d.startView);
    await stage('photo', async () => {
      const ok = await waitUntilLoaded(viewer, 20000, d.imageryPending, d.cancelled, frac('photo'));
      await manifest;
      await withTimeout(d.namesReady, 6000, cancelled);
      return ok;
    }).finally(photoDone);
    await mountains;
    if (stop()) return;

    // the calculator and the Stand-here view work in the background (worker thread, network) while
    // the camera visits the south-pole views
    const science = stage('science', () => {
      if (!heightsOk) return Promise.resolve(false);
      // one real calculation at the first south-pole spot people try: the worker has the heights, its
      // 80 m tiles there are loaded and its code is warmed up
      const hour = 3600_000;
      return withTimeout(analyseSpotAsync({ lat: -89.45, lon: -136.7, mastM: 2, startMs: Math.floor(Date.now() / hour) * hour, days: 14 }, 40000), 40000, cancelled);
    });
    // Small previews and the opening view's real layer tiles prepare during the pole visits.
    // The warm callback bounds its additional work; slow sources remain marked "later".
    const layers = d.layerFiles || d.warmLayers
      ? stage('layers', async () => {
        const preparation = (async () => {
        let ok = true;
        let fetched = d.layerFiles ? 0 : 1, warmed = d.warmLayers ? 0 : 1;
        const report = () => frac('layers')(d.layerFiles && d.warmLayers ? fetched * 0.45 + warmed * 0.55 : d.layerFiles ? fetched : warmed);
        const fetchJob = d.layerFiles ? d.layerFiles().then(files => fetchFiles(files, f => { fetched = f; report(); }, cancelled)) : Promise.resolve();
        const warmJob = d.warmLayers && !stop() ? d.warmLayers(f => { warmed = f; report(); }).then(result => { ok = result !== false; }) : Promise.resolve();
        await Promise.all([fetchJob, warmJob]);
        return ok;
        })();
        return await withTimeout(preparation, 90000, cancelled) && await preparation;
      })
      : Promise.resolve(mark('layers', 'off'));
    const surface = stage('surface', async () => {
      const prewarm = d.lander?.prewarm;
      if (typeof prewarm === 'function') return withTimeout(prewarm.call(d.lander), 60000, cancelled);
      return withTimeout(fetchSurfaceFiles(frac('surface'), cancelled), 60000, cancelled);
    });

    await stage('pole', async () => {
      const views = d.warmViews();
      let ok = true;
      for (let i = 0; i < views.length; i++) {
        if (stop()) return false;
        setPose(viewer, views[i].pose);
        const t1 = performance.now();
        const got = await waitUntilLoaded(viewer, views[i].maxMs * POLE_TIME, d.imageryPending, d.cancelled, f => frac('pole')((i + f) / views.length));
        trace.push(`${views[i].label}: ${got ? 'sharp' : 'timed out'} after ${Math.round(performance.now() - t1)} ms, ${d.imageryPending?.() ?? 0} photo jobs left ${waitingKinds()}`);
        // Some hidden layers need this view's settled tile levels. Schedule them before moving on.
        if (got && !stop()) views[i].warm?.();
        ok = got && ok;
      }
      return ok;
    });
    await Promise.all([science, surface, sky, layers]);
    if (stop()) return;

    // back to the opening view, at the graphics mode chosen now (it may have changed while loading)
    setPose(viewer, d.startView);
    await waitUntilLoaded(viewer, 6000, d.imageryPending, d.cancelled);
    if (musicJob) await musicJob;
  } finally {
    offSound();
    // A destroyed viewer (React remount in development) must stay silent: the new viewer reports for itself.
    if (!viewer.isDestroyed()) {
      setPose(viewer, d.startView);
      for (const s of stages.values()) if (s.state === 'waiting' || s.state === 'loading') s.state = 'later';
      finished = true;
      d.onProgress({ pct: 100, step: t('start.step.ready'), done: true, stages: STAGES.map(id => ({ ...stages.get(id)! })) });
    }
  }
}
