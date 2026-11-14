// Measure the real Craters switch and its retained data. No server or build is started.
// Usage: node data-prep/features/scripts/check_crater_polish.mjs before|after <output-folder>
// The before run serves the saved Vite-transformed crater module; other files remain live.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { acquireBrowserLease } from '../../../app/scripts/browserLease.mjs';
const require = createRequire(new URL('../../../app/package.json', import.meta.url));
const puppeteer = require('puppeteer-core');
const mode = process.argv[2], out = process.argv[3];
if (!['before', 'after'].includes(mode) || !out) throw Error('Give before|after and an output folder');
mkdirSync(out, { recursive: true });
const snapshot = fileURLToPath(new URL('../qa/baseline-modules/craterLayer.js', import.meta.url));
const result = { mode, errors: [], views: [], shots: [] };
if (mode === 'before') result.baselineModuleSha256 = createHash('sha256').update(readFileSync(snapshot)).digest('hex');
const lease = await acquireBrowserLease({ script: `crater polish ${mode}`, noteDir: out, timeoutMs: 20 * 60_000 });
let browser;
try {
  browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
    userDataDir: mkdtempSync(join(tmpdir(), `moonda-crater-${mode}-`)),
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
    args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run', '--hide-scrollbars',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  await lease.afterLaunch(browser);
  const page = (await browser.pages())[0];
  page.on('pageerror', e => result.errors.push({ message: e.message, stack: e.stack }));
  page.on('console', m => { if (m.type() === 'error') result.errors.push({ console: m.text() }); });
  await page.evaluateOnNewDocument(() => {
    const NativeWebSocket = window.WebSocket;
    window.__craterHotUpdatesIgnored = 0;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        if (protocols === 'vite-hmr') this.addEventListener('message', event => {
          let type; try { type = JSON.parse(event.data).type; } catch { return; }
          if (['update', 'full-reload', 'prune'].includes(type)) {
            window.__craterHotUpdatesIgnored++; event.stopImmediatePropagation();
          }
        });
      }
    };
  });
  if (mode === 'before') {
    await page.setRequestInterception(true);
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path === '/src/moon/craterLayer.ts') void request.respond({ status: 200, contentType: 'text/javascript', body: readFileSync(snapshot) });
      else void request.continue();
    });
  }
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const stats = () => page.evaluate(() => {
    const canvas = document.querySelector('.moon-crater-rims');
    const diagnostic = typeof canvas?.__craterDiagnostics === 'function' ? canvas.__craterDiagnostics() :
      (typeof window.__craterLayer?.diagnostics === 'function' ? window.__craterLayer.diagnostics() : null);
    return { diagnostic, data: canvas ? { ...canvas.dataset } : null, width: canvas?.width, height: canvas?.height,
      visible: canvas?.style.visibility, ready: window.__moonda?.progress?.done };
  });
  await page.goto('http://127.0.0.1:5190/?start', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__moonda?.progress?.done === true && !!window.__moondaCesium, { timeout: 280000 });
  result.beforeEnter = await stats();
  if (mode === 'after') {
    const d = result.beforeEnter.diagnostic;
    if (!d?.warmReady || d.warmBytes > d.warmLimitBytes || d.managedReservedBytes > d.limitBytes) {
      throw Error(`Opening view was not ready within the warm/memory budget: ${JSON.stringify(d)}`);
    }
  }
  await page.evaluate(() => {
    const enter = [...document.querySelectorAll('button')].find(e => /^(Just enter|Enter)$/.test(e.innerText.trim()));
    if (!enter) throw Error('No enter button after ready'); enter.click();
  });
  await wait(400);
  await page.evaluate(() => {
    const sun = document.querySelector('.ctl-sun'); if (sun?.getAttribute('aria-checked') === 'true') sun.click();
    const layers = [...document.querySelectorAll('button')].find(e => e.innerText.trim() === 'Layers');
    if (!layers) throw Error('No Layers button'); layers.click();
  });
  await wait(200);
  result.firstSwitch = await page.evaluate(() => new Promise((resolve, reject) => {
    const input = document.querySelector('#layer-craters');
    if (!input || input.checked) return reject(Error('Craters must start off'));
    const start = performance.now(); let polls = 0;
    input.click();
    const tick = () => {
      polls++;
      const c = document.querySelector('.moon-crater-rims');
      if (c && c.style.visibility === 'visible') {
        const p = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < p.length; i += 4) if (p[i]) {
          return resolve({ ms: performance.now() - start, polls, rings: Number(c.dataset.rings), canvasPixels: c.width * c.height,
            visible: c.style.visibility });
        }
      }
      if (performance.now() - start > 10000) return reject(Error('No first ring within 10 seconds'));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  result.afterFirstSwitch = await stats();
  await page.evaluate(() => document.querySelector('.layers header button')?.click());
  if (mode === 'after') {
    const cdp = await page.createCDPSession();
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    result.heapBeforeTravel = await cdp.send('Runtime.getHeapUsage');
    const fly = async (lat, lon, heightKm) => {
      await page.evaluate(async ({ lat, lon, heightKm }) => {
        const { poseLookingAt } = await import('/src/moon/navigation.ts');
        const v = window.__viewer, ground = window.__moonda.heights.heightAt(lat, lon, false);
        const p = poseLookingAt(lat, lon, ground, heightKm * 1000, 0, -90);
        window.__moonda.nav.cancel();
        v.camera.setView({ destination: p.destination, orientation: { direction: p.direction, up: p.up } });
        v.scene.requestRender();
      }, { lat, lon, heightKm });
      await wait(4000);
      await page.waitForFunction(() => {
        const c = document.querySelector('.moon-crater-rims');
        return c?.style.visibility === 'visible' && Number(c.dataset.rings) > 0;
      }, { timeout: 60000 });
    };
    const shot = async name => {
      const state = await page.evaluate(() => {
        const c = document.querySelector('.moon-crater-rims'), g = c.getContext('2d');
        const p = g.getImageData(0, 0, c.width, c.height).data;
        let alphaPixels = 0; for (let i = 3; i < p.length; i += 4) if (p[i]) alphaPixels++;
        return { alphaPixels, data: { ...c.dataset }, lineWidth: g.lineWidth, sun: document.querySelector('.ctl-sun')?.getAttribute('aria-checked') };
      });
      if (!state.alphaPixels || state.sun !== 'false' || Number(state.data.rings) > 400) throw Error('Invalid screenshot state');
      const path = join(out, name + '.png');
      await page.screenshot({ path, clip: { x: 0, y: 0, width: 1440, height: 900, scale: .5 } });
      result.shots.push({ name, path, state });
    };
    const regions = [
      ['Firmicus', 7.3, 63.4, 300], ['Far south-west', -45, -160, 100],
      ['Western equator', -10, -120, 100], ['Western mid latitude', 20, -80, 100],
      ['North-west', 55, -40, 100], ['South centre', -65, 0, 100],
      ['South-east', -30, 40, 100], ['East', 20, 100, 100],
      ['North far side', 65, 150, 100], ['Imbrium', 32.8, -15.6, 800],
    ];
    for (const [name, lat, lon, heightKm] of regions) {
      await fly(lat, lon, heightKm);
      const state = await stats(), d = state.diagnostic;
      if (!d || d.managedReservedBytes > d.limitBytes || d.pathSegments > d.maxPathSegments || d.maxDiameterRatio > 1.300001) {
        throw Error(`Crater budget/size limit failed: ${JSON.stringify(d)}`);
      }
      result.views.push({ name, lat, lon, heightKm, stats: state });
      if (name === 'Firmicus') await shot('firmicus-300km');
      if (name === 'Imbrium') await shot('imbrium-800km');
    }
    await cdp.send('HeapProfiler.collectGarbage');
    result.heapAfterTenRegions = await cdp.send('Runtime.getHeapUsage');
    result.afterTenRegions = await stats();
    await cdp.detach();
  }
  result.hotUpdatesIgnored = await page.evaluate(() => window.__craterHotUpdatesIgnored);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  result.failure = String(error); console.error(error);
  if (browser) result.failureState = await (await browser.pages())[0].evaluate(() => ({ progress: window.__moonda?.progress,
    crater: { ...document.querySelector('.moon-crater-rims')?.dataset }, body: document.body.innerText.slice(-2000) })).catch(() => null);
  process.exitCode = 1;
} finally {
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
  try { await browser?.close(); } finally { lease.release(); }
}
