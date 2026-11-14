// One leased browser, using the same GPU/ready rules as app/scripts/drive.mjs.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireBrowserLease } from '../../../app/scripts/browserLease.mjs';
const require = createRequire(new URL('../../../app/package.json', import.meta.url));
const { default: puppeteer } = await import(pathToFileURL(require.resolve('puppeteer-core')));
const mode = process.argv[2] ?? 'baseline';
const out = resolve(process.argv[3]);
mkdirSync(out, { recursive: true });
const lease = await acquireBrowserLease({ script: `layers memory ${mode}`, noteDir: out, timeoutMs: 300000 });
let browser;
const result = { mode, errors: [], snapshots: {}, timings: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    userDataDir: result.profile = mkdtempSync(resolve(`data-prep/layers/qa/.profile-${mode}-`)),
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
    args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run', '--hide-scrollbars', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  await lease.afterLaunch(browser);
  const page = (await browser.pages())[0];
  // Freeze hot-reload notifications only for this benchmark. Other sessions keep editing;
  // repeatedly replacing the viewer would make cache and heap measurements meaningless.
  if (mode === 'compact') await page.evaluateOnNewDocument(() => {
    const RealWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(RealWebSocket, { construct(Target, args) {
      const socket = new Target(...args);
      if (args[1] === 'vite-hmr') {
        const add = socket.addEventListener.bind(socket);
        socket.addEventListener = (type, listener, options) => add(type, type === 'message' ? event => {
          let payload; try { payload = JSON.parse(event.data); } catch { /* a normal WebSocket event */ }
          if (['update', 'full-reload', 'prune'].includes(payload?.type)) return;
          if (typeof listener === 'function') listener.call(socket, event); else listener?.handleEvent(event);
        } : listener, options);
      }
      return socket;
    } });
  });
  if (mode.startsWith('baseline')) {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = new URL(req.url());
      if (mode === 'baseline-worker' && u.pathname === '/') { void req.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Layer worker memory baseline</title>' }); return; }
      const name = u.pathname.match(/^\/src\/moon\/(imagery|imageryWorker|MoonMap|preload)\.tsx?$/)?.[1];
      const file = name ? resolve(`data-prep/layers/qa/baseline-modules/${name}${u.search.includes('worker_file') ? '.worker' : ''}.js`)
        : u.pathname === '/data/layers/manifest.json' ? resolve('data-prep/layers/qa/baseline-modules/manifest.json') : null;
      if (file && existsSync(file)) void req.respond({ status: 200, contentType: file.endsWith('.json') ? 'application/json' : 'text/javascript', body: readFileSync(file) });
      else void req.continue();
    });
  }
  page.on('pageerror', e => result.errors.push(e.stack || String(e)));
  page.on('console', msg => { if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) result.errors.push(msg.text().slice(0, 1600)); });
  const ready = async () => {
    const start = Date.now(); let quiet = 0;
    while (Date.now() - start < 280000) {
      const ok = await page.evaluate(() => !!window.__moonda?.idle?.()).catch(() => false);
      quiet = ok ? quiet + 1 : 0;
      if (quiet >= 4) return Date.now() - start;
      await sleep(250);
    }
    result.notReady = await page.evaluate(() => ({ progress: window.__moonda?.progress, text: document.body.innerText.slice(0, 900), science: window.__moondaScienceMemory?.(), waiting: window.__moondaImagery?.waiting?.().slice(0, 10) })).catch(() => null);
    await page.screenshot({ path: out + '/not-ready.png' });
    throw Error('Ready timed out after 280000 ms');
  };
  const heap = async () => {
    const rows = [];
    for (const worker of page.workers()) {
      try {
        const client = worker.client;
        await client.send('HeapProfiler.collectGarbage');
        const science = await worker.evaluate(() => self.__moondaScienceWorkerStats?.()).catch(() => null);
        rows.push({ url: worker.url(), science, ...(await client.send('Runtime.getHeapUsage')) });
      } catch (e) { rows.push({ url: worker.url(), error: String(e) }); }
    }
    return rows;
  };
  const snapshot = async name => {
    await page.evaluate(() => window.__moondaScienceSnapshot?.());
    result.snapshots[name] = {
      heaps: await heap(),
      page: await page.evaluate(() => ({ progress: window.__moonda.progress, imagery: window.__moondaImagery.stats(), science: window.__moondaScienceMemory?.(), values: window.__moondaLayerValueMemory?.(), craters: document.querySelector('.moon-crater-rims')?.__craterDiagnostics?.(), memory: performance.memory && { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize } })),
    };
    const science = result.snapshots[name].page.science?.worker;
    console.log('Snapshot ' + name + ': ' + JSON.stringify(science && { compressed: science.compressedBytes, decoded: science.decodedBytes, previews: science.previewBytes, failed: science.failedUrls }));
  };
  if (mode === 'baseline-worker') {
    await page.goto('http://127.0.0.1:5190/', { waitUntil: 'domcontentloaded', timeout: 180000 });
    const manifest = JSON.parse(readFileSync('data-prep/layers/qa/baseline-modules/manifest.json'));
    const wanted = new Set(['psr', 'waterice', 'danger', 'slope', 'height']);
    const sources = manifest.filter(e => wanted.has(e.id)).flatMap(e => e.rasterSources ?? [{ url: `./data/layers/${e.id}.png`, projection: 'polar', pole: 'south', extentM: 304000, clipTrueLatDeg: -80.02 }]);
    await page.evaluate(sources => {
      const w = window.__baselineWorker = new Worker('/src/moon/imageryWorker.ts?worker_file&type=module', { type: 'module' });
      window.__baselineDone = false;
      w.onmessage = ({ data }) => { if (data.cache) window.__baselineCache = data.cache; if (data.warmFrac === 1) window.__baselineDone = true; };
      w.postMessage({ cacheBudgetBytes: 512 * 2 ** 20 });
      w.postMessage({ warmScience: sources.map(s => ({ ...s, url: new URL(s.url, document.baseURI).href })), warmId: 1 });
    }, sources);
    await page.waitForFunction(() => window.__baselineDone, { timeout: 280000 });
    for (let retry = 0; retry < 2; retry++) {
      const complete = await page.evaluate(() => window.__baselineCache?.retainedCount === 12);
      if (complete) break;
      await page.evaluate(sources => {
        window.__baselineDone = false; window.__baselineWorker.postMessage({ forgetFailures: true });
        window.__baselineWorker.postMessage({ warmScience: sources.map(s => ({ ...s, url: new URL(s.url, document.baseURI).href })), warmId: 2 });
      }, sources);
      await page.waitForFunction(() => window.__baselineDone, { timeout: 280000 });
    }
    result.snapshots.startup = { heaps: await heap(), cache: await page.evaluate(() => window.__baselineCache), maps: await page.workers()[0].evaluate(() => self.__baselineScienceStats()) };
    result.snapshots['all-on'] = result.snapshots.startup;
    writeFileSync(out + '/result.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } else {
  await page.goto('http://127.0.0.1:5190/', { waitUntil: 'domcontentloaded', timeout: 180000 });
  result.readyMs = await ready();
  await snapshot('startup');
  if (mode === 'compact') {
    const science = result.snapshots.startup.page.science.worker;
    if (science.compressedBytes !== 43412906 || science.failedUrls?.length || !science.maps.every(m => m.available)) throw Error('Startup did not finish downloading all stored maps');
    if (science.decodedBytes || science.previewBytes) throw Error('Startup decoded maps before a switch was used');
  }
  await page.evaluate(() => [...document.querySelectorAll('button')].find(e => /^(Just enter|Enter)$/.test(e.innerText.trim()))?.click());
  await page.evaluate(() => [...document.querySelectorAll('button')].find(e => e.innerText.trim() === 'Layers')?.click());
  await page.evaluate(async () => {
    if (document.querySelector('.ctl-sun')?.getAttribute('aria-checked') === 'true') document.querySelector('.ctl-sun').click();
    const { poseLookingAt } = await import('/src/moon/navigation.ts');
    const p = poseLookingAt(-90, 0, 0, 820000, 0, -90);
    window.__viewer.camera.setView({ destination: p.destination, orientation: { direction: p.direction, up: p.up } });
    window.__viewer.scene.requestRender();
  });
  await sleep(1800);
  if (mode === 'compact') {
    await page.evaluate(() => window.__moondaScienceDropDecoded());
    result.timings = await page.evaluate(async () => {
      const v = window.__viewer, rows = [];
      for (const id of ['psr', 'waterice', 'danger', 'slope', 'craters', 'height']) {
        const input = document.getElementById('layer-' + id);
        const old = new Map(Array.from({ length: v.imageryLayers.length }, (_, i) => { const l = v.imageryLayers.get(i); return [l, l.show]; }));
        const start = performance.now(); input.click();
        const row = await new Promise(resolve => {
          let off; const timer = setTimeout(() => { off?.(); resolve({ ms: null, timeout: true }); }, 30000);
          off = v.scene.postRender.addEventListener(() => {
            const changed = Array.from({ length: v.imageryLayers.length }, (_, i) => v.imageryLayers.get(i)).filter(l => l.show && !old.get(l));
            const tiles = v.scene.globe._surface._tilesToRender || [];
            const vector = id === 'craters' && Number(document.querySelector('.moon-crater-rims')?.dataset.rings) > 0;
            const paint = vector || tiles.some(t => (t.data?.imagery || []).some(i => i.readyImagery?.texture && changed.includes(i.readyImagery.imageryLayer)));
            if (paint) { clearTimeout(timer); off(); resolve({ ms: +(performance.now() - start).toFixed(1), vector }); }
            v.scene.requestRender();
          }); v.scene.requestRender();
        });
        rows.push({ id, ...row }); input.click();
        const stop = performance.now() + 20000;
        while (performance.now() < stop && window.__moondaImagery.waiting().some(j => j.kind === 'science')) await new Promise(r => setTimeout(r, 50));
        await new Promise(r => setTimeout(r, 100));
      }
      return rows;
    });
    console.log('Timings: ' + JSON.stringify(result.timings));
  }
  await page.evaluate(() => {
    for (const id of ['psr', 'waterice', 'danger', 'slope', 'craters', 'height']) {
      const e = document.getElementById('layer-' + id); if (e && !e.checked) e.click();
    }
  });
  await sleep(3000);
  await snapshot('all-on');
  await page.screenshot({ path: out + '/all-on.png' });
  if (mode === 'compact') {
    await page.evaluate(async () => {
      const { poseLookingAt } = await import('/src/moon/navigation.ts'); const p = poseLookingAt(0, 10, 0, 6500000, 0, -90);
      window.__viewer.camera.setView({ destination: p.destination, orientation: { direction: p.direction, up: p.up } }); window.__viewer.scene.requestRender();
    });
    await sleep(8000); await snapshot('all-on-world'); await page.screenshot({ path: out + '/all-on-world.png' });
    // Intermediate zoom must keep the real fine map, rather than staying on a small preview.
    for (const id of ['slope', 'danger']) {
      await page.evaluate(async id => {
        for (const other of ['psr', 'waterice', 'danger', 'slope', 'craters', 'height']) { const e = document.getElementById('layer-' + other); if (e.checked !== (other === id)) e.click(); }
        const { poseLookingAt } = await import('/src/moon/navigation.ts'); const p = poseLookingAt(0.674, 23.473, 0, 1700000, 0, -90);
        window.__viewer.camera.setView({ destination: p.destination, orientation: { direction: p.direction, up: p.up } }); window.__viewer.scene.requestRender();
      }, id);
      await sleep(2000); await page.screenshot({ path: out + '/mid-' + id + '.png' });
    }
    await page.evaluate(() => { for (const id of ['psr', 'waterice', 'danger', 'slope', 'craters', 'height']) { const e = document.getElementById('layer-' + id); if (!e.checked) e.click(); } });
    await page.evaluate(() => window.__moondaTest.select(-84.678, -48.6937));
    await sleep(3000); await snapshot('selected-spot');
    // Reuse the app's timestamped module. Importing an unversioned Vite URL would create
    // another value cache, and asking for it only offline would test module caching.
    await page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').map(e => e.name).find(u => /\/src\/science\/layerValues\.ts(?:\?|$)/.test(u));
      if (!url) throw Error('The app value module was not loaded');
      window.__memoryValues = await import(url);
      await window.__memoryValues.loadManifest();
    });
    await page.setOfflineMode(true);
    await page.evaluate(() => window.__moondaScienceDropDecoded(true));
    await sleep(6000); await snapshot('offline-redecoded'); await page.screenshot({ path: out + '/offline.png' });
    result.offline = await page.evaluate(() => ({ online: navigator.onLine, science: window.__moondaScienceMemory(), canvas: !!window.__viewer.scene.canvas, errors: document.body.innerText.includes('An error occurred') }));
    await page.evaluate(async () => {
      const { poseLookingAt } = await import('/src/moon/navigation.ts'); const p = poseLookingAt(90, 0, 0, 820000, 0, -90);
      window.__viewer.camera.setView({ destination: p.destination, orientation: { direction: p.direction, up: p.up } }); window.__viewer.scene.requestRender();
    });
    await sleep(3000); await snapshot('offline-north'); await page.screenshot({ path: out + '/offline-north.png' });
    result.offlineValues = await page.evaluate(async () => {
      const { loadManifest, valueAt } = window.__memoryValues;
      return Object.fromEntries(await Promise.all((await loadManifest()).filter(e => ['slope', 'psr', 'waterice'].includes(e.id)).map(async e => [e.id, await valueAt(e, 89.5, 0)])));
    });
    if (result.offlineValues.slope !== 3.25 || result.offlineValues.psr !== 0 || result.offlineValues.waterice !== 1) throw Error('Offline spot values differ from the stored maps');
    await page.setOfflineMode(false);
    // Visit again in the same browser: CacheStorage supplies the downloaded maps.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 180000 });
    result.warmReadyMs = await ready(); await snapshot('startup-warm');
  }
  writeFileSync(out + '/result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ out, errors: result.errors, timings: result.timings, readyMs: result.readyMs, warmReadyMs: result.warmReadyMs, offline: result.offline?.online }, null, 2));
  }
} catch (error) { result.fatal = String(error); throw error; }
finally { writeFileSync(out + '/result.json', JSON.stringify(result, null, 2)); try { await browser?.close(); } finally { lease.release(); } }
