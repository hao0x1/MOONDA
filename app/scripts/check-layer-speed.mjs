// Measure actual map pixels, after start-up, with the same leased Chrome as drive.mjs.
// Example: node scripts/check-layer-speed.mjs --label before --view pole --out /tmp/layers
// Use --view all (or a comma-list) for separate short browser leases. The persistent profile warms HTTP cache.
// --base-wait-ms 30000 lets the surface photo become quiet before its layer timings start.
// Lease waits retry up to three times; a run that started Chrome is never retried automatically.
// --phase aged --allow-long-run adds two minutes of pan/zoom before repeating the switches;
// that explicit flag is required because this one test exceeds the normal two-minute lease.
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(flag('--out', '/tmp/moonda-layer-speed'));
const modules = args.includes('--modules') ? resolve(flag('--modules', '')) : null;
const moduleSnapshot = modules ? Object.fromEntries(['imagery.js', 'imageryWorker.js', 'imageryWorker.worker.js', 'MoonMap.js', 'preload.js', 'flatMap.js', 'mapImagery.js'].map(name => [name, createHash('sha256').update(readFileSync(join(modules, name))).digest('hex')])) : null;
const label = flag('--label', 'run'), phase = flag('--phase', 'warm');
const selected = flag('--view', 'all');
const memoryHelper = args.includes('--memory-helper') ? resolve(flag('--memory-helper', '')) : null;
if (memoryHelper && !existsSync(memoryHelper)) throw new Error(`Memory helper unavailable: ${memoryHelper}`);
const baseWaitMs = Number(flag('--base-wait-ms', '30000'));
if (!Number.isFinite(baseWaitMs) || baseWaitMs < 0) throw new Error('--base-wait-ms must be nonnegative');
const leaseRetries = Number(flag('--lease-retries', '3'));
if (!Number.isInteger(leaseRetries) || leaseRetries < 0) throw new Error('--lease-retries must be a nonnegative integer');
const layerIds = flag('--layers', 'psr,waterice,danger,slope,craters,height').split(',');
if (layerIds.some(id => !['psr', 'waterice', 'danger', 'slope', 'craters', 'height'].includes(id))) throw new Error('Unknown --layers');
const views = selected === 'all' ? ['whole', 'pole', 'flat', 'mid', 'rim'] : selected.split(',');
// (the browser profile with its warm cache: about 1 GB after a full run, kept out of the project folder)
const profile = resolve(flag('--profile', join(tmpdir(), 'moonda-layer-speed-profile')));
const url = new URL(flag('--url', 'http://localhost:5190/'));
url.searchParams.set('start', '');
if (views.some(v => !['whole', 'pole', 'flat', 'mid', 'rim'].includes(v))) throw new Error('Unknown --view');
if (!['warm', 'aged'].includes(phase)) throw new Error('Unknown --phase');
if (phase === 'aged' && !args.includes('--allow-long-run')) throw new Error('The real two-minute use test needs --allow-long-run and a longer lease.');
mkdirSync(out, { recursive: true });
mkdirSync(profile, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function install(baseWaitMs) {
  const ids = ['psr', 'waterice', 'danger', 'slope', 'craters', 'height'];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const api = window.__layerSpeed = { ids, rows: [], samples: [], capture: null };
  api.until = async (predicate, timeout = 10000) => {
    const start = performance.now();
    while (!predicate()) { if (performance.now() - start > timeout) throw new Error('Timed out waiting for view'); await sleep(50); }
  };
  api.button = (text) => [...document.querySelectorAll('button')].find(e => {
    const r = e.getBoundingClientRect();
    return r.width && r.height && (e.textContent?.trim() === text || e.getAttribute('aria-label') === text);
  });
  api.start = async () => {
    await api.until(() => window.__moonda?.progress?.done, 85000);
    api.startup = { frozenHmr: window.__layerSpeedFrozenHmr === true, tsxNameShim: window.__layerSpeedTsxNameShim === true, frozenModules: window.__layerSpeedFrozenModules, singletonCanonicalized: window.__layerSpeedSingletonCanonicalized === true, ms: performance.now(), progress: structuredClone(window.__moonda.progress), layerWarm: structuredClone(window.__moonda.layerWarm ?? null), poleHeightWarm: structuredClone(window.__moonda.poleHeightWarm ?? null), trace: window.__moonda.preloadTrace, heap: performance.memory?.usedJSHeapSize, at: Date.now() };
    const uiWaitStarted = performance.now();
    let just;
    // The progress hook updates before React commits the enabled Enter button.
    await api.until(() => {
      just = api.button('Just enter') ?? document.querySelector('.start-enter');
      return !!just && !just.disabled && just.getBoundingClientRect().width > 0;
    }, 5000);
    api.startup.enterButtonWaitMs = Math.round(performance.now() - uiWaitStarted);
    just.click();
    await api.until(() => !document.querySelector('.start'), 5000);
    api.button('Explore the whole Moon')?.click();
    api.entered = true;
    api.startup.enteredMs = performance.now();
    api.startup.enteredAt = Date.now();
    window.__moondaTest?.setTime(window.__moondaTest.state().cursor);
    return api.startup;
  };
  api.snapshot = () => ({
    at: Date.now(), heap: performance.memory?.usedJSHeapSize, entered: api.entered === true, globeTilesLoaded: window.__viewer?.scene.globe.tilesLoaded ?? null, base: api.base ?? null,
    layerWarm: structuredClone(window.__moonda?.layerWarm ?? null),
    poleHeightWarm: structuredClone(window.__moonda?.poleHeightWarm ?? null),
    imagery: structuredClone(window.__moondaImagery?.stats()),
    waiting: structuredClone(window.__moondaImagery?.waiting()),
    science: window.__moondaScienceMemory?.(),
    flat: window.__moonda?.flat?.diagnostics?.(),
    flatOverlays: window.__moonda?.flat ? [...window.__moonda.flat.ovTex].map(([id, entry]) => ({ id, state: entry.state })) : null,
    crater: document.querySelector('.moon-crater-rims')?.__craterDiagnostics?.(),
    surface: window.__moondaSurfaceMap?.getDiagnostics(),
    rasters: window.__moondaSurfaceMap?.getRasterDiagnostics(),
    resources: performance.getEntriesByType('resource').filter(e => /layers|ClrShade|science|craters/.test(e.name)).map(e => ({ name: e.name, ms: e.duration, bytes: e.transferSize, start: e.startTime })),
  });
  api.setup = async view => {
    if (api.entered !== true || document.querySelector('.start')) throw new Error('Cannot set up a measurement before Enter completes');
    api.view = view;
    if (view === 'pole') { const b = api.button('South Pole'); if (!b) throw new Error('South Pole button missing'); b.click(); await sleep(3000); }
    if (view === 'flat') { const b = api.button('2D'); if (!b) throw new Error('2D button missing'); b.click(); await sleep(3500); }
    if (view === 'mid' || view === 'rim') {
      const [lat, lon] = view === 'mid' ? [-26.46, 11.85] : [-89.79, -154.3];
      window.__moondaTest.stand(lat, lon);
      await api.until(() => window.__moondaTest.state().standing, 18000);
      await sleep(500);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'm', code: 'KeyM', bubbles: true }));
      await api.until(() => !!window.__moondaSurfaceMap, 5000);
      await sleep(1500);
    } else {
      const b = api.button('Layers'); if (b) b.click();
      await api.until(() => !!document.querySelector('#layer-height'));
    }
    api.surface = view === 'mid' || view === 'rim';
    api.originalLayers = api.surface ? { ...window.__moondaSurfaceMap.layers } : null;
    api.switch = (id, on) => {
      if (api.surface) {
        const layers = { ...api.originalLayers };
        for (const other of ids) layers[other] = false;
        if (id) layers[id] = on;
        window.__moondaSurfaceMap.update({ layers });
      } else {
        for (const other of ids) {
          const e = document.querySelector(`#layer-${other}`);
          const wanted = id === other && on;
          if (e && e.checked !== wanted) e.click();
        }
      }
    };
    api.switch(null, false);
    await sleep(1000);
    if (api.surface) {
      const started = performance.now();
      let quietSince = null, ready = false;
      const quiet = () => {
        const stats = window.__moondaSurfaceMap.getDiagnostics().imagery;
        return stats.pending === 0 && stats.active === 0 && (stats.scienceActive ?? 0) === 0;
      };
      // Waiting only for the surface photo makes later grayscale detail an honest baseline.
      // Globe toggles retain their original schedule so unfinished startup warming stays visible.
      while (performance.now() - started < baseWaitMs) {
        const now = performance.now();
        if (quiet()) {
          quietSince ??= now;
          if (now - quietSince >= 400) {
            if (now - started + 250 > baseWaitMs) break;
            await sleep(250);
            if (quiet()) { ready = true; break; }
            quietSince = null;
          }
        } else quietSince = null;
        await sleep(50);
      }
      api.base = { baseWaitMs: Math.round(performance.now() - started), baseReady: ready,
        pending: window.__moondaSurfaceMap.getDiagnostics().imagery.pending,
        active: window.__moondaSurfaceMap.getDiagnostics().imagery.active };
    }
    const canvas = api.surface ? document.querySelector('.sm-map-area > canvas') : view === 'flat' ? document.querySelector('.flat-map canvas') : window.__viewer.canvas;
    if (!canvas) throw new Error('Map canvas missing');
    api.canvas = canvas;
    const flatUi = view === 'flat' ? document.querySelector('.flat-map > canvas:nth-of-type(2)') : null;
    if (view === 'flat' && !flatUi) throw new Error('Flat-map UI canvas missing');
    const sample = document.createElement('canvas'); sample.width = 512; sample.height = 256;
    const ctx = sample.getContext('2d', { willReadFrequently: true });
    api.read = () => {
      ctx.clearRect(0, 0, 512, 256);
      api.firstPixels = null;
      if (api.surface || api.measuringId !== 'craters') ctx.drawImage(canvas, 0, 0, 512, 256);
      // Separate the raster from its annotations: moving labels cannot prove a science image arrived.
      if (flatUi && api.measuringId !== 'craters') api.firstPixels = ctx.getImageData(0, 0, 512, 256).data;
      // Flat-map ice markers and labels live above its GL picture and belong in settling time.
      if (flatUi && api.measuringId !== 'craters' && getComputedStyle(flatUi).visibility !== 'hidden' && getComputedStyle(flatUi).display !== 'none') ctx.drawImage(flatUi, 0, 0, 512, 256);
      if (!api.surface) {
        const crater = document.querySelector('.moon-crater-rims');
        if (crater && getComputedStyle(crater).visibility !== 'hidden') ctx.drawImage(crater, 0, 0, 512, 256);
      }
      return ctx.getImageData(0, 0, 512, 256).data;
    };
    const capture = () => { if (api.capture) { const pixels = api.read(); api.capture(pixels, performance.now(), api.firstPixels); } };
    if (!api.surface && view !== 'flat') window.__viewer.scene.postRender.addEventListener(capture);
    else if (view === 'flat') {
      const gl = canvas.getContext('webgl2'); let queued = false;
      for (const name of ['drawArrays', 'drawElements']) {
        const original = gl[name].bind(gl);
        gl[name] = (...args) => { const value = original(...args); if (!queued) { queued = true; queueMicrotask(() => { queued = false; capture(); }); } return value; };
      }
    }
    api.diff = (a, b, mask) => {
      let count = 0;
      for (let i = 0; i < a.length; i += 4) if ((!mask || !mask[i / 4]) && Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 3) count++;
      return count;
    };
    // Photo refinement changes gray intensity; a science layer must add its own colour.
    api.layerDiff = (a, b, mask) => {
      let count = 0;
      for (let i = 0; i < a.length; i += 4) if (!mask[i / 4]) {
        const dr = a[i] - b[i], dg = a[i + 1] - b[i + 1], db = a[i + 2] - b[i + 2];
        if (Math.max(dr, dg, db) - Math.min(dr, dg, db) > 6) count++;
      }
      return count;
    };
    api.force = () => {
      if (view === 'flat') {
        if (window.__moonda?.flat) window.__moonda.flat.request();
        else document.querySelector('.flat-map canvas:last-of-type').dispatchEvent(new WheelEvent('wheel', { deltaY: 0, bubbles: true }));
      }
      else if (!api.surface) window.__viewer.scene.requestRender();
    };
    api.measure = async (id, pass) => {
      if (api.entered !== true || document.querySelector('.start')) throw new Error('Cannot measure pixels behind the start screen');
      api.measuringId = id;
      const unsupported = api.surface && id === 'craters';
      api.switch(null, false); await sleep(250);
      const offFrames = [], offRasterFrames = [];
      api.capture = (px, _now, raster) => {
        offFrames.push(new Uint8ClampedArray(px));
        if (raster) offRasterFrames.push(new Uint8ClampedArray(raster));
      };
      for (let i = 0; i < 4; i++) { api.force(); await new Promise(r => requestAnimationFrame(r)); if (api.surface) capture(); }
      api.capture = null;
      if (!offFrames.length) { if (!api.surface) throw new Error('No rendered baseline frames captured'); offFrames.push(api.read()); }
      const off = offFrames.at(-1), mask = new Uint8Array(off.length / 4);
      for (const frame of offFrames) for (let i = 0; i < off.length; i += 4) if (Math.max(Math.abs(frame[i] - off[i]), Math.abs(frame[i + 1] - off[i + 1]), Math.abs(frame[i + 2] - off[i + 2])) > 3) mask[i / 4] = 1;
      const offRaster = offRasterFrames.at(-1) ?? off;
      let rasterMask = mask;
      if (offRasterFrames.length) {
        rasterMask = new Uint8Array(offRaster.length / 4);
        for (const frame of offRasterFrames) for (let i = 0; i < offRaster.length; i += 4) if (Math.max(Math.abs(frame[i] - offRaster[i]), Math.abs(frame[i + 1] - offRaster[i + 1]), Math.abs(frame[i + 2] - offRaster[i + 2])) > 3) rasterMask[i / 4] = 1;
      }
      const before = api.snapshot();
      const baselineUnsettled = api.surface ? api.base?.baseReady !== true || before.surface?.imagery?.pending > 0 || before.surface?.imagery?.active > 0 : view === 'flat' ? before.flat?.tileFading === true : before.waiting?.some(job => !job.background) || !window.__viewer.scene.globe.tilesLoaded;
      let first = null, last = null, previous = off, changed = 0, layerChanged = 0, count = 0;
      const t0 = performance.now(), timeline = [];
      api.capture = (px, now, raster) => {
        const fromOff = api.diff(px, off, mask), temporal = api.diff(px, previous, mask);
        const layerPixels = unsupported ? 0 : id === 'craters' ? fromOff : api.layerDiff(raster ?? px, offRaster, rasterMask);
        if (layerPixels >= 3 && first === null) first = now - t0;
        if (temporal >= 3) last = now - t0;
        changed = Math.max(changed, fromOff); layerChanged = Math.max(layerChanged, layerPixels); count++;
        if (temporal >= 3 || timeline.length < 3) timeline.push({ ms: Math.round(now - t0), changed: fromOff, layerPixels, temporal });
        previous = new Uint8ClampedArray(px);
      };
      api.switch(id, true);
      let timedOut = false;
      while (true) {
        api.force(); await new Promise(r => requestAnimationFrame(r));
        if (api.surface) capture();
        const elapsed = performance.now() - t0;
        const surfaceScience = window.__moondaSurfaceMap?.getDiagnostics().imagery?.scienceByLayer;
        const pending = api.surface ? Object.entries(surfaceScience ?? {}).some(([key, value]) => (key === id || id === 'height' && key.startsWith('height')) && value.pending > 0) : view === 'flat' ? window.__moonda?.flat ? window.__moonda.flat.overlays.some(o => { const e = window.__moonda.flat.ovTex.get(o.id); return e?.state === 'loading' || !!e?.pending; }) : window.__moondaImagery?.pending() > 0 : !window.__viewer.scene.globe.tilesLoaded || window.__moondaImagery?.waiting()?.some(job => !job.background);
        const quiet = last === null ? elapsed : elapsed - last;
        if (unsupported && elapsed >= 1000) break;
        if (first !== null && elapsed >= 1000 && quiet >= 350 && !pending) break;
        if (elapsed >= 6000) { timedOut = pending || first !== null && quiet < 350; break; }
      }
      api.capture = null;
      const result = { view, layer: id, pass, baselineUnsettled, unsupported, sampling: { width: 512, height: 256, flatUiIncluded: view === 'flat', ...(view === 'flat' ? { firstSampling: id === 'craters' ? 'crateroverlay' : 'GLlayercolour', settledSampling: id === 'craters' ? 'crateroverlay' : 'GL+UI' } : {}), firstThreshold: '3 pixels with RGB delta chroma >6; crater overlay alone uses RGB delta >3' }, firstMs: first === null ? null : Math.round(first), settledMs: first === null || timedOut ? null : Math.round(last ?? first), changedPixels: changed, layerChangedPixels: layerChanged, sampledFrames: count, timedOut, observationMs: Math.round(performance.now() - t0), noisePixels: mask.reduce((a, b) => a + b, 0), timeline, before, after: api.snapshot() };
      api.rows.push(result); return result;
    };
    api.age = async () => {
      api.switch(null, false);
      const start = performance.now(), map = window.__moondaSurfaceMap;
      const original = map?.getAcross();
      const flat = window.__moonda?.flat, flatView = flat ? { ...flat.view } : null;
      const camera = window.__viewer.camera;
      const globePose = { destination: camera.position.clone(), orientation: { direction: camera.direction.clone(), up: camera.up.clone() } };
      while (performance.now() - start < 120000) {
        if (api.surface) { map.setAcross(original * (1 + Math.sin((performance.now() - start) / 1500) * .25)); map.pan?.(15, 7); }
        else {
          const target = view === 'flat' ? document.querySelector('.flat-map canvas:last-of-type') : canvas;
          target.dispatchEvent(new WheelEvent('wheel', { deltaY: Math.sin((performance.now() - start) / 1200) * 30, clientX: 756, clientY: 370, bubbles: true }));
          if (view !== 'flat') window.__viewer.camera.rotateRight(.003);
        }
        await sleep(200);
      }
      if (api.surface) { map.setAcross(original); map.centre(); }
      else if (view === 'flat' && flatView) { flat.stop(); flat.view = flatView; flat.request(); }
      else if (view !== 'flat') { camera.setView(globePose); window.__viewer.scene.requestRender(); }
      await sleep(1000);
      return { ms: performance.now() - start, at: Date.now() };
    };
    return api.snapshot();
  };
  return true;
}

function chromeRss(pid) {
  try {
    const rows = execFileSync('/bin/ps', ['-axo', 'pid,ppid,rss,command'], { encoding: 'utf8', maxBuffer: 8 << 20 }).split('\n').flatMap(s => {
      const m = s.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); return m ? [{ pid: +m[1], parent: +m[2], bytes: +m[3] * 1024, command: m[4] }] : [];
    });
    const descendants = new Set([pid]); let last;
    do { last = descendants.size; for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.pid); } while (last !== descendants.size);
    const chrome = rows.filter(r => descendants.has(r.pid) && /Google Chrome/.test(r.command));
    const chromeMain = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const otherHeadlessPids = rows.filter(row => !descendants.has(row.pid)
      && (row.command === chromeMain || row.command.startsWith(`${chromeMain} `))
      && /--headless(?:=|\s|$)/.test(row.command)).map(row => row.pid);
    let footprintBytes = null, footprintProcesses = 0, footprintError;
    if (memoryHelper && chrome.length) {
      try {
        const footprints = JSON.parse(execFileSync(memoryHelper, chrome.map(row => String(row.pid)), { encoding: 'utf8', timeout: 2000, maxBuffer: 1 << 20 }));
        const values = chrome.map(row => footprints[String(row.pid)]).filter(value => Number.isFinite(value) && value >= 0);
        footprintProcesses = values.length;
        if (values.length === chrome.length) footprintBytes = values.reduce((total, value) => total + value, 0);
      } catch (error) { footprintError = String(error).slice(0, 200); }
    }
    return { at: Date.now(), bytes: chrome.reduce((n, r) => n + r.bytes, 0), processes: chrome.length,
      footprintBytes, footprintProcesses, otherHeadlessPids, ...(footprintError ? { footprintError } : {}) };
  } catch { return null; }
}

let activeChild = null, interrupted = false;
const onSignal = signal => { interrupted = true; process.exitCode = signal === 'SIGINT' ? 130 : 143; activeChild?.kill('SIGTERM'); };
const onInt = () => onSignal('SIGINT'), onTerm = () => onSignal('SIGTERM');
process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
async function driveAttempt(folder, scenario, view) {
  const spawnedAt = Date.now();
  const child = activeChild = spawn(process.execPath, ['--import', './scripts/check-layer-no-hmr.mjs', 'scripts/drive.mjs', scenario, '--out', folder, '--url', url.href, '--width', '1512', '--height', '741', '--profile', profile], { cwd: root, env: { ...process.env, ...(modules ? { MOONDA_LAYER_MODULES: modules } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '', leaseLimit = false, completedCleanup = false; const memory = [];
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => { errors += b; process.stderr.write(b); });
  const interval = setInterval(() => {
    const value = chromeRss(child.pid); if (value?.processes) memory.push(value);
    try {
      const lease = JSON.parse(readFileSync(join(folder, 'browser-lease.json')));
      const launch = lease.notes.find(n => n.event === 'Chrome started alone');
      const released = lease.notes.findLast(n => n.event === 'released');
      const artifact = join(folder, 'result.json');
      // A completed drive can retain an idle Node handle. Its own signal cleanup is safe once
      // the fresh result is saved, its lease is released and all Chrome descendants have exited.
      if (!completedCleanup && lease.pid === child.pid && released && Date.now() - Date.parse(released.at) > 1000 && value?.processes === 0 && existsSync(artifact) && statSync(artifact).mtimeMs >= spawnedAt) {
        completedCleanup = true; child.kill('SIGTERM');
      } else if (lease.pid === child.pid && phase !== 'aged' && !released && launch && Date.now() - Date.parse(launch.at) > 115000) { leaseLimit = true; child.kill('SIGTERM'); }
    } catch { /* lease not yet acquired */ }
  }, 500);
  const code = await new Promise(r => child.on('close', r)); clearInterval(interval); activeChild = null;
  writeFileSync(join(folder, 'console.log'), output + errors);
  writeFileSync(join(folder, 'memory-rss.json'), JSON.stringify(memory, null, 1));
  const freshResult = existsSync(join(folder, 'result.json')) && statSync(join(folder, 'result.json')).mtimeMs >= spawnedAt;
  let result = freshResult ? JSON.parse(readFileSync(join(folder, 'result.json'))) : { errors: [`Browser run exited ${code}${leaseLimit ? ' at the 115 s lease limit' : ''}`], evals: {} };
  const evalErrors = (result.steps ?? []).filter(step => step.note?.startsWith('ERROR:')).map(step => step.note);
  result.errors = [...(result.errors ?? []), ...evalErrors];
  result = { label, phase, view, moduleSnapshot, freshResult, exitCode: completedCleanup && evalErrors.length === 0 ? 0 : code, rawExitCode: code, completedCleanup, leaseLimit, ...result, memory: { method: 'Sum of Chrome process RSS; optional Darwin physical footprint includes compressed pages. Shared pages may be counted more than once.', helper: memoryHelper, samples: memory } };
  const lease = existsSync(join(folder, 'browser-lease.json')) ? JSON.parse(readFileSync(join(folder, 'browser-lease.json'))) : null;
  const chromeStarted = memory.some(x => x.processes > 0) || lease?.notes.some(x => ['Chrome started alone', 'closed own browser after launch race'].includes(x.event));
  const requested = lease?.notes.find(x => x.event === 'requested'), acquired = lease?.notes.find(x => x.event === 'acquired');
  const endedAt = Date.now();
  result.leaseAttempt = { childPid: child.pid, spawnedAt, chromeStarted: !!chromeStarted, freshResult, leaseTimeout: /Timed out waiting.*browser lease/.test(errors), waitMs: requested ? (acquired ? Date.parse(acquired.at) : endedAt) - Date.parse(requested.at) : null };
  return result;
}
const results = [];
for (const view of views) {
  if (interrupted) break;
  const folder = join(out, `${label}-${phase}-${view}`); mkdirSync(folder, { recursive: true });
  const evalStep = (name, js) => ({ do: 'eval', name, js });
  const steps = [evalStep('install', `(${install.toString()})(${baseWaitMs})`), evalStep('startup', 'window.__layerSpeed.start()'), evalStep('view', `window.__layerSpeed.setup(${JSON.stringify(view)})`), { do: 'shot', name: 'off' }];
  for (const id of layerIds) {
    steps.push(evalStep(`${id}-warm`, `window.__layerSpeed.measure(${JSON.stringify(id)}, 'warm')`), { do: 'shot', name: `${id}-warm` }, evalStep(`${id}-second`, `window.__layerSpeed.measure(${JSON.stringify(id)}, 'second')`));
  }
  if (phase === 'aged') {
    steps.push(evalStep('two-minute-use', 'window.__layerSpeed.age()'));
    for (const id of layerIds) steps.push(evalStep(`${id}-aged`, `window.__layerSpeed.measure(${JSON.stringify(id)}, 'aged')`), { do: 'shot', name: `${id}-aged` });
  }
  steps.push(evalStep('steady', 'window.__moondaScienceSnapshot().then(() => window.__layerSpeed.snapshot())'));
  const scenario = join(folder, 'scenario.json'); writeFileSync(scenario, JSON.stringify(steps));
  console.log(`${label}: ${view} (${phase}), taking one browser lease`);
  const runStartedAt = Date.now(), attempts = [];
  writeFileSync(join(folder, 'run-state.json'), JSON.stringify({ status: 'running', startedAt: runStartedAt }));
  let result;
  for (let attempt = 0; attempt <= leaseRetries; attempt++) {
    result = await driveAttempt(folder, scenario, view);
    attempts.push({ attempt: attempt + 1, ...result.leaseAttempt, exitCode: result.exitCode });
    writeFileSync(join(folder, 'lease-attempts.json'), JSON.stringify(attempts, null, 1));
    const retry = !interrupted && attempt < leaseRetries && !result.leaseAttempt.chromeStarted && !result.freshResult && result.leaseAttempt.leaseTimeout;
    if (!retry) break;
    const archive = join(folder, `lease-attempt-${runStartedAt}-${attempt + 1}`); mkdirSync(archive, { recursive: true });
    for (const name of ['browser-lease.json', 'console.log', 'memory-rss.json']) if (existsSync(join(folder, name))) copyFileSync(join(folder, name), join(archive, name));
    attempts.at(-1).archive = archive;
    writeFileSync(join(folder, 'lease-attempts.json'), JSON.stringify(attempts, null, 1));
    console.log(`${label}: ${view}, lease timed out before Chrome started; retry ${attempt + 1}/${leaseRetries}`);
  }
  writeFileSync(join(folder, 'run-state.json'), JSON.stringify({ status: result.freshResult ? 'complete' : 'failed', startedAt: runStartedAt, endedAt: Date.now(), attempts: attempts.length }));
  result.leaseAttempts = attempts;
  result.totalLeaseWaitMs = attempts.reduce((total, attempt) => total + (attempt.waitMs ?? 0), 0);
  const memory = result.memory.samples;
  const startupAt = result.evals.startup?.at;
  const startup = memory.filter(x => startupAt && x.at >= startupAt - 1500 && x.at <= startupAt);
  result.memory.startupFootprintBytes = startup.map(x => x.footprintBytes).filter(Number.isFinite).sort((a, b) => a - b).at(Math.floor(startup.filter(x => Number.isFinite(x.footprintBytes)).length / 2)) ?? null;
  result.memory.startupBytes = startup.length ? [...startup].sort((a, b) => a.bytes - b.bytes)[Math.floor(startup.length / 2)].bytes : null;
  const steadyAt = result.evals.steady?.at;
  const steady = memory.filter(x => steadyAt && x.at >= steadyAt - 3000 && x.at <= steadyAt);
  result.memory.steadyFootprintBytes = steady.map(x => x.footprintBytes).filter(Number.isFinite).sort((a, b) => a - b).at(Math.floor(steady.filter(x => Number.isFinite(x.footprintBytes)).length / 2)) ?? null;
  result.memory.steadyBytes = steady.length ? [...steady].sort((a, b) => a.bytes - b.bytes)[Math.floor(steady.length / 2)].bytes : null;
  results.push(result);
  const rows = Object.values(result.evals).filter(x => x && typeof x === 'object' && 'firstMs' in x);
  for (const row of rows) console.log(`${view.padEnd(5)} ${row.layer.padEnd(8)} ${row.pass.padEnd(6)} first ${String(row.firstMs).padStart(5)} settled ${String(row.settledMs).padStart(5)} ms  pixels ${row.changedPixels}${row.timedOut ? ' TIMEOUT' : ''}`);
  writeFileSync(join(out, `${label}-${phase}.json`), JSON.stringify(results, null, 1));
  await sleep(250);
}
process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
if (!interrupted && results.some(result => result.exitCode || result.leaseLimit || result.errors.some(e => e.startsWith('ERROR:')) || !Object.values(result.evals).some(row => row && typeof row === 'object' && 'firstMs' in row))) process.exitCode = 1;
