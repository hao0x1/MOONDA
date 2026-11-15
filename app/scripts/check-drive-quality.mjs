// Real GPU check for Drive staying sharp again after stopping, plus the first W hitch.
// node scripts/check-drive-quality.mjs --out <folder> [--baseline] [--modules <frozen Vite modules>]
// By default two presses drive for 6 s and release for 4 s. --presses 10 keeps the longer first/tenth
// comparison; --rest-ms 8000 repeats the original stop window. Each press uses the same path.
// One browser globally: take the shared browser lease before starting Chrome.
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireBrowserLease } from './browserLease.mjs';

const args = process.argv.slice(2);
const flag = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
if (args.includes('--help')) {
  console.log('node scripts/check-drive-quality.mjs --out <folder> [--baseline] [--flat-relief-baseline] [--modules <folder>] [--presses 1|2|10] [--rest-ms 4000|8000] [--profile <folder>] [--url http://127.0.0.1:5190/]');
  process.exit(0);
}
const baseline = args.includes('--baseline');
const flatReliefBaseline = args.includes('--flat-relief-baseline');
// (results go to the system's temporary folder unless --out says otherwise)
const rootOut = join(tmpdir(), 'moonda-drive-quality');
const out = resolve(flag('--out', join(rootOut, baseline ? 'baseline' : 'final')));
const modules = flag('--modules', null);
const width = Number(flag('--width', 1440)), height = Number(flag('--height', 900));
const presses = Number(flag('--presses', 2));
const pressMs = Number(flag('--press-ms', 6000)), restMs = Number(flag('--rest-ms', 4000));
const warmMs = Number(flag('--warm-ms', 400)), warmRestMs = Number(flag('--warm-rest-ms', 800));
mkdirSync(out, { recursive: true });
const result = { mode: baseline ? 'baseline' : 'assert', modules, flatReliefBaseline, errors: [], consoleErrors: [], requestFailures: [], runs: [], samples: [], longTasks: [], setup: null, restoration: [], profiles: {}, shots: [] };
const wait = ms => new Promise(done => setTimeout(done, ms));
let browser, page, lease, cleanupPromise;
async function cleanup() {
  cleanupPromise ??= (async () => {
    try { await browser?.close(); }
    finally {
      lease?.release();
    }
  })();
  return cleanupPromise;
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => { void cleanup().finally(() => process.exit(code)); });

function frameSummary(frames, from = -Infinity, to = Infinity) {
  // Count the part of each frame interval that overlaps the input window. A long first frame
  // must not disappear just because its RAF callback falls just beyond the window's end.
  const intervals = frames.filter(f => Number.isFinite(f.dt) && f.dt > 0).map(f => ({ dt: f.dt,
    overlap: Math.max(0, Math.min(f.ms, to) - Math.max(f.ms - f.dt, from)) })).filter(f => f.overlap > 0);
  const values = intervals.map(f => f.dt).sort((a, b) => a - b);
  if (!values.length) return { frames: 0 };
  const total = intervals.reduce((sum, f) => sum + f.overlap, 0), weightedFrames = intervals.reduce((sum, f) => sum + f.overlap / f.dt, 0);
  const q = p => +values[Math.min(values.length - 1, Math.floor(values.length * p))].toFixed(2);
  return { frames: values.length, fps: +(1000 * weightedFrames / total).toFixed(2), coveredMs: +total.toFixed(2),
    partialFrames: intervals.filter(f => f.overlap < f.dt - 0.01).length, medianMs: q(0.5), p95Ms: q(0.95), maxMs: q(1), over33ms: values.filter(x => x > 33.34).length, over100ms: values.filter(x => x > 100).length };
}
function profileSummary(profile) {
  const nodes = new Map(profile.nodes.map(n => [n.id, n]));
  const self = new Map();
  for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
    const f = nodes.get(profile.samples[i])?.callFrame;
    if (!f) continue;
    const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').slice(-2).join('/').split('?')[0]}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas?.[i] ?? 0) / 1000);
  }
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 35).map(([name, ms]) => ({ name, ms: +ms.toFixed(2) }));
}
function restoration(run) {
  const frames = run.frames.filter(f => f.ms >= run.keyUpMs);
  const stopped = f => Math.abs(f.speed) <= 0.005 && Math.abs(f.slide) <= 0.005;
  // Ignore an instant at zero on the way to rolling backwards: speed must stay zero for 0.5 s.
  let zero = null;
  for (let i = 0; i < frames.length; i++) {
    if (!stopped(frames[i])) continue;
    const end = frames.findIndex((f, j) => j >= i && f.ms >= frames[i].ms + 500);
    if (end >= i && frames.slice(i, end + 1).every(stopped)) { zero = frames[i]; break; }
  }
  if (!zero) return { press: run.press, ok: false, reason: 'No stable zero speed in the release window', last: frames.at(-1) };
  const sharp = f => Math.abs(f.resScale - run.baseScale) <= 1e-6 && f.lodLevel === 1;
  const recovered = frames.find(f => f.ms >= zero.ms && sharp(f));
  const delayMs = recovered ? recovered.ms - zero.ms : null;
  const tail = frames.filter(f => f.ms >= zero.ms + 1500 && stopped(f) && !f.moving), badTail = tail.filter(f => !sharp(f));
  return { press: run.press, ok: delayMs !== null && delayMs <= 1500 && tail.length > 0 && badTail.length === 0,
    steadyTailFrames: tail.length, lateCuts: badTail.length, firstLateCut: badTail[0] ?? null,
    zeroAtMs: +zero.ms.toFixed(2), recoveredAtMs: recovered ? +recovered.ms.toFixed(2) : null,
    delayMs: delayMs === null ? null : +delayMs.toFixed(2), baseScale: run.baseScale, zeroState: zero, last: frames.at(-1) };
}

try {
  assert.ok(Number.isInteger(presses) && presses > 0, '--presses must be a positive whole number');
  lease = await acquireBrowserLease({ script: 'check-drive-quality.mjs', noteDir: out,
    timeoutMs: Number(flag('--lease-wait-ms', 90000)) });
  browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: !args.includes('--headful'),
    userDataDir: resolve(flag('--profile', join(out, 'chrome-profile'))), defaultViewport: { width, height, deviceScaleFactor: 2 },
    args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run', '--hide-scrollbars', `--window-size=${width},${height}`,
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  await lease.afterLaunch(browser);
  page = (await browser.pages())[0] ?? await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    // Keep this one test on its loaded source while other sessions edit. The actual Vite socket
    // stays connected; only hot updates and reload commands are stopped before Vite sees them.
    window.__driveSuppressedHmr = [];
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, { construct(Target, params, NewTarget) {
      const socket = Reflect.construct(Target, params, NewTarget), protocols = params[1];
      if (protocols === 'vite-hmr' || (Array.isArray(protocols) && protocols.includes('vite-hmr'))) {
        socket.addEventListener('message', event => {
          if (typeof event.data !== 'string') return;
          let message;
          try { message = JSON.parse(event.data); } catch { return; }
          if (message.type !== 'update' && message.type !== 'full-reload') return;
          const paths = [...new Set([message.path, ...(message.updates ?? []).flatMap(update => [update.path, update.acceptedPath])].filter(Boolean))];
          window.__driveSuppressedHmr.push({ ms: performance.now(), at: new Date().toISOString(), type: message.type,
            paths, urls: paths.map(path => new URL(path, location.href).href), serverTimestamp: message.timestamp ?? message.updates?.[0]?.timestamp ?? null });
          event.stopImmediatePropagation();
        }, true);
      }
      return socket;
    } });
  });
  let initialising = true, rejectInitialisation;
  const failedInitialisation = new Promise((_, reject) => { rejectInitialisation = reject; });
  void failedInitialisation.catch(() => {});
  page.on('pageerror', error => {
    result.errors.push(error.stack || String(error));
    if (initialising) rejectInitialisation(new Error(`Page failed while starting: ${error.message}`));
  });
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text().slice(0, 1000);
    result.errors.push(text); result.consoleErrors.push({ at: new Date().toISOString(), text, location: message.location() });
  });
  page.on('requestfailed', request => {
    const failure = { at: new Date().toISOString(), url: request.url(), method: request.method(), resourceType: request.resourceType(), errorText: request.failure()?.errorText ?? 'Unknown network failure' };
    result.requestFailures.push(failure);
    const local = new URL(request.url()).origin === new URL(flag('--url', 'http://127.0.0.1:5190/')).origin;
    if (initialising && local && ['document', 'script', 'stylesheet'].includes(failure.resourceType) && failure.errorText !== 'net::ERR_ABORTED') {
      rejectInitialisation(new Error(`Local ${failure.resourceType} failed while starting: ${failure.url} (${failure.errorText})`));
    }
  });
  page.on('response', response => {
    if (initialising && [500, 504].includes(response.status())) {
      const message = `HTTP ${response.status()} while starting: ${response.url()}`;
      result.errors.push(message); rejectInitialisation(new Error(message));
    }
  });
  if (modules) {
    await page.setRequestInterception(true);
    page.on('request', request => {
      const name = new URL(request.url()).pathname.match(/^\/src\/moon\/([\w]+)\.ts$/)?.[1];
      const file = name && join(modules, `${name}.js`);
      if (file && existsSync(file)) void request.respond({ status: 200, contentType: 'text/javascript', body: readFileSync(file) });
      else void request.continue();
    });
  }
  await Promise.race([(async () => {
    await page.goto(flag('--url', 'http://127.0.0.1:5190/'), { waitUntil: 'domcontentloaded', timeout: 280000 });
    await page.waitForFunction(() => !!window.__moondaTest && !!window.__moondaCesium, { timeout: 280000 });
    await page.waitForFunction(() => window.__moonda?.progress?.done, { timeout: 280000 });
    if (flatReliefBaseline) await page.evaluate(() => {
      const provider = window.__viewer.terrainProvider, reaches = provider.reachesRelief;
      if (typeof reaches !== 'function') throw new Error('The provider has no reachesRelief method for the density baseline');
      // Density only: keep the current shader and GPU warm-up, but request the old 600 m area
      // at every fine level. The current method's level-12 radius is exactly that old radius.
      provider.reachesRelief = function (rect, ring) { return reaches.call(this, rect, ring, 12); };
    });
    await page.evaluate(() => window.__moondaTest.stand(-89.45, -137.3));
    await page.waitForFunction(() => window.__moonda?.lander?.phase === 'on', { timeout: 45000 });
    await wait(2500);
  })(), failedInitialisation]);
  initialising = false;
  // Instrument the finished scene before Drive is first switched on. No application code is changed.
  result.setup = await page.evaluate(() => {
    const C = window.__moondaCesium, L = window.__moonda.lander, v = window.__viewer;
    const q = window.__driveQuality = { phase: 'setup', press: 0, samples: [], frames: [], inputs: [], longTasks: [], counts: {}, events: [], running: true, restore: [] };
    const input = event => {
      if (event.key.toLowerCase() !== 'w') return;
      const ms = performance.now(); q.inputs.push({ type: event.type, ms, stamp: event.timeStamp, press: q.press });
      if (event.type === 'keydown') q.lastKeyDownMs = ms; else q.lastKeyUpMs = ms;
    };
    window.addEventListener('keydown', input, true); window.addEventListener('keyup', input, true);
    q.restore.push(() => { window.removeEventListener('keydown', input, true); window.removeEventListener('keyup', input, true); });
    const count = (key, detail) => {
      q.counts[key] = (q.counts[key] ?? 0) + 1;
      if (q.events.length < 12000) q.events.push({ ms: performance.now(), phase: q.phase, press: q.press, key, ...(detail ? { detail } : {}) });
    };
    const wrap = (object, key, label = key, detail) => {
      const original = object?.[key]; if (typeof original !== 'function') return;
      const wrapped = function (...params) { count(label, detail?.(params)); return original.apply(this, params); };
      try { object[key] = wrapped; if (object[key] === wrapped) q.restore.push(() => { object[key] = original; }); } catch { /* unavailable private API */ }
    };
    const gl = v.scene.context._gl;
    for (const name of ['createProgram', 'createShader', 'compileShader', 'linkProgram', 'createBuffer', 'createTexture', 'createFramebuffer', 'createRenderbuffer', 'createVertexArray', 'bufferData', 'texImage2D', 'texStorage2D']) {
      const label = `gl.${name}`;
      wrap(gl, name, label, ['createProgram', 'createBuffer', 'createTexture', 'createVertexArray'].includes(name)
        ? () => (q.counts[label] ?? 0) < 40 ? { stack: new Error().stack?.split('\n').slice(2, 8).join('\n') } : undefined : undefined);
    }
    wrap(v.scene.primitives, 'add', 'scene.primitives.add', p => p[0]?.constructor?.name);
    wrap(v.scene.primitives, 'remove', 'scene.primitives.remove', p => p[0]?.constructor?.name);
    wrap(C.Model, 'fromGltfAsync', 'Model.fromGltfAsync', p => p[0]?.url);
    wrap(C.ShaderProgram, 'fromCache', 'ShaderProgram.fromCache');
    wrap(C.VertexArray, 'fromGeometry', 'VertexArray.fromGeometry');
    const provider = v.terrainProvider, request = provider.requestTileGeometry;
    provider.requestTileGeometry = function (...params) {
      const start = performance.now(), value = request.apply(this, params);
      count('terrain.requestTileGeometry', { level: params[2], ms: performance.now() - start, ready: value !== undefined });
      return value;
    };
    q.restore.push(() => { provider.requestTileGeometry = request; });
    q.refreshTerrain = () => {
      const tiles = v.scene.globe._surface._tilesToRender;
      const terrain = { ms: performance.now(), tiles: tiles.length, sourceGridTiles: 0, upsampledTiles: 0, fillTiles: 0,
        fineSourceGridTiles: 0, fineSourceGridNormalTiles: 0, fineUpsampledTiles: 0,
        supportingFineSourceTiles: 0, supportingFineNormalTiles: 0, supportingFineNormalBytes: 0, supportingFineSources: [], footSource: null,
        indexCountWithoutSkirts: 0, indexCountTotal: 0, trianglesWithoutSkirts: 0, trianglesTotal: 0, verticesWithoutSkirts: 0, levels: {}, sourceGridVertices: {} };
      const sources = new Map(), foot = L.driver ? v.scene.globe.ellipsoid.cartesianToCartographic(L.driver.feet) : null;
      for (const tile of tiles) {
        // Cesium can draw a level-20 piece cut from a real level-18 mesh. That is still real
        // relief, even when no genuine provider tile is itself in the current draw list.
        const underFoot = foot && C.Rectangle.contains(tile.rectangle, foot);
        let footSourceFound = false;
        for (let source = tile; source && source.level >= 12; source = source.parent) {
          const sourceData = source.data, terrainData = sourceData?.terrainData;
          if (!terrainData || terrainData.wasCreatedByUpsampling?.()) continue;
          const id = `${source.level}/${source.x}/${source.y}`, sourceMesh = sourceData.mesh ?? sourceData.renderedMesh;
          const gridVertices = sourceMesh?.vertexCountWithoutSkirts ?? (terrainData._quantizedVertices?.length ?? 0) / 3;
          const hasNormals = !!sourceMesh?.encoding?.hasVertexNormals || !!terrainData._encodedNormals?.byteLength;
          // A ready TerrainEncoding stores each oct-packed normal in one Float32 component.
          const normalBytes = sourceMesh?.encoding?.hasVertexNormals
            ? ((sourceMesh.vertices?.length ?? 0) / (sourceMesh.stride ?? sourceMesh.encoding.stride)) * 4
            : terrainData._encodedNormals?.byteLength ?? 0;
          const metadata = { id, level: source.level, gridVertices, hasNormals, normalBytes };
          if (!sources.has(id)) sources.set(id, metadata);
          if (underFoot && !footSourceFound) {
            if (!terrain.footSource || source.level > terrain.footSource.level) terrain.footSource = metadata;
            footSourceFound = true;
          }
        }
        const data = tile.data, mesh = data?.renderedMesh;
        if (!mesh) continue;
        const upsampled = tile.upsampledFromParent || data.terrainData?.wasCreatedByUpsampling?.() || false;
        const fill = mesh !== data.mesh;
        const total = mesh.indices?.length ?? 0, without = mesh.indexCountWithoutSkirts ?? total;
        const vertices = mesh.vertexCountWithoutSkirts ?? (mesh.vertices?.length ?? 0) / (mesh.stride ?? mesh.encoding?.stride ?? 1);
        const level = terrain.levels[tile.level] ??= { tiles: 0, sourceGridTiles: 0, upsampledTiles: 0, fillTiles: 0, trianglesWithoutSkirts: 0, trianglesTotal: 0 };
        level.tiles++; level.trianglesWithoutSkirts += without / 3; level.trianglesTotal += total / 3;
        if (upsampled) { terrain.upsampledTiles++; level.upsampledTiles++; if (tile.level >= 12) terrain.fineUpsampledTiles++; }
        else if (!fill) {
          terrain.sourceGridTiles++; level.sourceGridTiles++;
          if (tile.level >= 12) { terrain.fineSourceGridTiles++; if (mesh.encoding?.hasVertexNormals) terrain.fineSourceGridNormalTiles++; }
          terrain.sourceGridVertices[vertices] = (terrain.sourceGridVertices[vertices] ?? 0) + 1;
        }
        if (fill) { terrain.fillTiles++; level.fillTiles++; }
        terrain.indexCountWithoutSkirts += without; terrain.indexCountTotal += total; terrain.verticesWithoutSkirts += vertices;
      }
      terrain.supportingFineSources = [...sources.values()];
      terrain.supportingFineSourceTiles = sources.size;
      terrain.supportingFineNormalTiles = terrain.supportingFineSources.filter(source => source.hasNormals).length;
      terrain.supportingFineNormalBytes = terrain.supportingFineSources.reduce((sum, source) => sum + source.normalBytes, 0);
      terrain.trianglesWithoutSkirts = terrain.indexCountWithoutSkirts / 3; terrain.trianglesTotal = terrain.indexCountTotal / 3;
      q.terrain = terrain; return terrain;
    };
    q.read = (withTerrain = false) => {
      const d = L.driver, u = v.scene.globe.material?.uniforms, pose = window.__roverLink.pose;
      return { ms: performance.now(), phase: q.phase, press: q.press, resScale: v.resolutionScale, baseScale: q.baseScale,
        pixelRatio: v.canvas.width / v.canvas.clientWidth, devicePixelRatio: window.devicePixelRatio,
        lodLevel: L.lod?.level ?? u?.lvLod?.x ?? 1, shaderLod: u?.lvLod?.x ?? null, drawingScale: L.lod?.drawingScale ?? null,
        speed: d?.speed ?? 0, poseSpeed: pose.speed, slide: d?.slide ?? 0, moving: L.moving, marchHold: L.marchHold, yawRate: d?.yawRate ?? 0,
        restless: d?.restless ?? null, slip: d?.slip ?? null, az: L.az, el: L.el, fov: L.fov,
        eye: { x: L.eye.x, y: L.eye.y, z: L.eye.z }, armDist: L.armDist, armLift: L.armLift, armBusy: L.armBusy,
        walking: L.walking, view: L.view, raf: L.raf, keys: [...L.keys], tileCount: v.scene.globe._surface._tilesToRender.length,
        primitives: v.scene.primitives.length, dust: L.dust?.count ?? 0, tracksPresent: !!L.tracks, tracksMesh: !!L.tracks?.mesh,
        tracksSections: L.tracks?.count ?? 0, gpuMs: L.lod?.gpu ?? null,
        ...(withTerrain ? { terrain: q.terrain } : {}) };
    };
    q.baseScale = v.resolutionScale;
    q.refreshTerrain();
    q.samples.push(q.read(true));
    q.timer = setInterval(() => { q.refreshTerrain(); q.samples.push(q.read(true)); }, 500);
    let last = performance.now();
    const frame = now => { if (!q.running) return; q.frames.push({ ...q.read(), dt: now - last }); last = now; requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    try { q.observer = new PerformanceObserver(list => q.longTasks.push(...list.getEntries().map(e => ({ ms: e.startTime, duration: e.duration, name: e.name, phase: q.phase, press: q.press })))); q.observer.observe({ entryTypes: ['longtask'] }); } catch { /* unsupported */ }
    return { baseScale: v.resolutionScale, phase: L.phase, stats: { ...L.stats }, width: v.canvas.width, height: v.canvas.height,
      terrain: q.terrain, reliefActive: !!L.relief && !!provider.relief, landerRelief: !!L.relief, providerRelief: !!provider.relief,
      gpuWarm: { dust: L.dust?.gpuWarm ?? null, tracks: L.tracks?.gpuWarm ?? null },
      warmEffects: { trackSections: L.tracks?.count ?? 0, liveDust: L.dust?.count ?? 0,
        trailPoints: window.__roverLink.trail.length / 3, distanceM: window.__roverLink.distM, odometer: L.driver?.odometer ?? 0 },
      quality: JSON.parse(localStorage.getItem('moonda.settings.v1') ?? '{}').quality ?? 'full',
      instrumented: q.restore.length, gpu: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) };
  });
  assert.ok(result.setup.reliefActive, 'Relief geometry is inactive: refuse to measure a flat baseline or final scene');
  assert.ok(result.setup.terrain.supportingFineSourceTiles > 0, 'No genuine fine relief source supports the drawn tiles');
  assert.ok(result.setup.terrain.footSource?.level >= 18, 'The ground under the rover must come from genuine level-18 relief, including cut-up children');
  if (!baseline) {
    assert.ok(result.setup.gpuWarm.dust && result.setup.gpuWarm.tracks, 'Dust and wheel tracks must finish GPU warm-up before the first W');
    assert.ok(result.setup.warmEffects.trackSections <= 1 && result.setup.warmEffects.liveDust === 0, 'GPU warm-up left dummy tracks or live dust');
    assert.ok(result.setup.warmEffects.trailPoints <= 1 && Math.abs(result.setup.warmEffects.distanceM) <= 1e-6, 'GPU warm-up changed the drive trail');
  }
  const cdp = await page.createCDPSession();
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await page.evaluate(() => { window.__landerLink.setView('third'); window.__landerLink.setWalk(true); document.activeElement?.blur(); });
  // Starting Chrome's sampler itself can pause the renderer. Pay that cost during the existing
  // Behind-view settle, before any W timing window; keep the profile through the first press.
  await cdp.send('Profiler.start');
  const profileReadyMs = await page.evaluate(() => performance.now());
  await wait(2000);
  result.setup.behindStanding = await page.evaluate(() => { const q = window.__driveQuality; q.refreshTerrain(); return q.read(true); });
  for (let press = 1; press <= presses; press++) {
    const measured = press === 1 || press === presses;
    if (press > 1) {
      await page.evaluate(() => { const q = window.__driveQuality; q.phase = 'reset'; window.__roverLink.reset(); });
      await wait(1300);
      await page.evaluate(() => { window.__landerLink.setView('third'); window.__landerLink.setWalk(true); document.activeElement?.blur(); });
      await wait(700);
    }
    const start = await page.evaluate(press => {
      const q = window.__driveQuality; q.phase = 'press'; q.press = press; q.lastKeyDownMs = q.lastKeyUpMs = null;
      return { ms: performance.now(), counts: { ...q.counts }, state: q.read(), baseScale: q.baseScale };
    }, press);
    await page.keyboard.down('w');
    start.keyDownMs = await page.evaluate(() => window.__driveQuality.lastKeyDownMs);
    assert.ok(Number.isFinite(start.keyDownMs), 'Did not observe the actual W keydown');
    await wait(measured ? pressMs : warmMs);
    await page.keyboard.up('w');
    const keyUp = await page.evaluate(() => { const q = window.__driveQuality; q.phase = 'release'; return { ms: q.lastKeyUpMs, counts: { ...q.counts }, state: q.read() }; });
    assert.ok(Number.isFinite(keyUp.ms), 'Did not observe the actual W keyup');
    if (press === 1) {
      const { profile } = await cdp.send('Profiler.stop');
      writeFileSync(join(out, 'first-w.cpuprofile'), JSON.stringify(profile));
      result.profiles.firstW = profileSummary(profile);
      result.profiles.firstWWindow = { includesBehindIdle: true, samplerReadyMs: profileReadyMs,
        setupBeforeKeyMs: start.keyDownMs - profileReadyMs, keyDownMs: start.keyDownMs, keyUpMs: keyUp.ms,
        setupRaf: frameSummary((await page.evaluate(() => window.__driveQuality.frames)).filter(f => f.phase === 'setup'), profileReadyMs, start.keyDownMs) };
    }
    await wait(measured ? restMs : warmRestMs);
    const data = await page.evaluate(({ startMs, endPress }) => {
      const q = window.__driveQuality, end = performance.now();
      q.refreshTerrain();
      return { endMs: end, counts: { ...q.counts }, endState: q.read(true), frames: q.frames.filter(f => f.ms >= startMs && f.press === endPress), samples: q.samples.filter(f => f.ms >= startMs && f.press === endPress) };
    }, { startMs: start.ms, endPress: press });
    const delta = (a, b) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(key => [key, (b[key] ?? 0) - (a[key] ?? 0)]).filter(([, value]) => value));
    const run = { press, measured, baseScale: start.baseScale, keyDownMs: start.keyDownMs, keyUpMs: keyUp.ms, endMs: data.endMs,
      startState: start.state, keyUpState: keyUp.state, endState: data.endState, countsDuringPress: delta(start.counts, keyUp.counts), countsDuringRelease: delta(keyUp.counts, data.counts),
      frames: measured ? data.frames : [], samples: data.samples };
    if (measured) {
      run.raf = { firstSecond: frameSummary(data.frames, start.keyDownMs, Math.min(keyUp.ms, start.keyDownMs + 1000)),
        firstThree: frameSummary(data.frames, start.keyDownMs, Math.min(keyUp.ms, start.keyDownMs + 3000)),
        allDriving: frameSummary(data.frames, start.keyDownMs, keyUp.ms), released: frameSummary(data.frames, keyUp.ms, data.endMs) };
      result.restoration.push(restoration(run));
      const shot = join(out, `press-${press}-released.png`);
      await page.screenshot({ path: shot, clip: { x: 0, y: 0, width, height, scale: 0.5 } }); result.shots.push(shot);
    }
    result.runs.push(run);
  }
  const captured = await page.evaluate(() => {
    const q = window.__driveQuality; q.running = false; clearInterval(q.timer); q.observer?.disconnect();
    const result = { samples: q.samples, inputs: q.inputs, longTasks: q.longTasks, events: q.events,
      suppressedHmr: window.__driveSuppressedHmr ?? [], finalState: q.read() };
    q.restore.reverse().forEach(fn => fn()); return result;
  });
  Object.assign(result, captured);
  result.terrainComparison = { standing: result.setup.behindStanding.terrain,
    driving: result.samples.find(s => s.press === 1 && s.phase === 'press' && Math.abs(s.speed) > 0.5)?.terrain,
    stopped: result.runs.at(-1)?.endState?.terrain };
  result.pixelFloor = { quality: result.setup.quality, minimumNativeRatio: Math.min(...result.runs.flatMap(r => r.frames.filter(f => f.phase === 'press').map(f => f.pixelRatio))), requiredNativeRatio: 1.5 };
  result.conclusion = result.restoration.every(r => r.ok) ? 'Drawing size and detail returned within 1.5 s of stable zero speed.' : 'Drawing size or detail failed to return within 1.5 s of stable zero speed; inspect restoration and samples.';
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ out, mode: result.mode, setup: result.setup, restoration: result.restoration, pixelFloor: result.pixelFloor,
    terrainComparison: result.terrainComparison, runs: result.runs.filter(r => r.measured).map(({ frames, samples, ...run }) => run), profiles: result.profiles,
    errors: result.errors, consoleErrors: result.consoleErrors, requestFailures: result.requestFailures, suppressedHmr: result.suppressedHmr, conclusion: result.conclusion }, null, 2));
  if (!baseline) {
    assert.deepEqual(result.errors, [], 'Browser errors');
    for (const check of result.restoration) assert.ok(check.ok, `Press ${check.press}: drawing size/detail did not return within 1.5 s after speed reached stable zero`);
    if (result.setup.quality === 'full') assert.ok(result.pixelFloor.minimumNativeRatio >= 1.5 - 0.005, `Full detail drawing fell below 1.5 native pixels per CSS pixel (${result.pixelFloor.minimumNativeRatio})`);
  }
} catch (error) {
  result.failure = error.stack || String(error);
  if (page) {
    result.failureState = await page.evaluate(() => window.__driveQuality?.read?.()).catch(() => null);
    result.suppressedHmr = await page.evaluate(() => window.__driveSuppressedHmr ?? []).catch(() => []);
  }
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
  throw error;
} finally { await cleanup(); }
