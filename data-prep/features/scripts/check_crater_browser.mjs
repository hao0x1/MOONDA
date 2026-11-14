// Run from the project: node data-prep/features/scripts/check_crater_browser.mjs <output folder>.
// The shared dev server stays untouched. Ignore Vite hot updates in this browser only, so another
// owner's edit cannot reset the camera and switches halfway through the twelve reference shots.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireBrowserLease } from '../../../app/scripts/browserLease.mjs';
const require = createRequire(new URL('../../../app/package.json', import.meta.url));
const puppeteer = require('puppeteer-core');
const out = process.argv[2];
const only = process.argv[3]?.split(',');
if (!out) throw Error('Give an output folder');
mkdirSync(out, { recursive: true });
const lease = await acquireBrowserLease({ script: 'check_crater_browser.mjs', noteDir: out, timeoutMs: 15 * 60_000 });
let browser;
const result = { errors: [], checks: [], measures: {}, shots: [] };
try {
  browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
    userDataDir: mkdtempSync(join(tmpdir(), 'moonda-crater-rims-')),
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
          let type;
          try { type = JSON.parse(event.data).type; } catch { return; }
          if (['update', 'full-reload', 'prune'].includes(type)) {
            window.__craterHotUpdatesIgnored++; event.stopImmediatePropagation();
          }
        });
      }
    };
  });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ready = async () => {
    await page.waitForFunction(() => window.__moonda?.progress?.done === true && !!window.__moondaCesium,
      { timeout: 280000 });
  };
  await page.goto('http://127.0.0.1:5190/', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await ready();
  await page.evaluate(async () => {
    [...document.querySelectorAll('button')].find(e => /^(Just enter|Enter)$/.test(e.innerText.trim()))?.click();
    await new Promise(r => setTimeout(r, 400));
    const sun = document.querySelector('.ctl-sun');
    if (sun?.getAttribute('aria-checked') === 'true') sun.click();
    [...document.querySelectorAll('button')].find(e => e.innerText.trim() === 'Layers')?.click();
    await new Promise(r => setTimeout(r, 250));
    const craters = document.querySelector('#layer-craters');
    if (craters && !craters.checked) craters.click();
    document.querySelector('.layers header button')?.click();
  });
  const shot = async name => {
    const check = await page.evaluate(() => {
      const c = document.querySelector('.moon-crater-rims'), g = c?.getContext('2d');
      const pixels = g?.getImageData(0, 0, c.width, c.height).data;
      let alphaPixels = 0;
      if (pixels) for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) alphaPixels++;
      return { ready: window.__moonda?.progress?.done, sun: document.querySelector('.ctl-sun')?.getAttribute('aria-checked'),
        rings: Number(c?.dataset.rings), loading: Number(c?.dataset.loading), minKm: Number(c?.dataset.minKm),
        chunks: Number(c?.dataset.chunks), width: g?.lineWidth, stroke: g?.strokeStyle,
        flat: window.__moonda.flat.active, visible: c?.style.visibility,
        alphaPixels, errorPanel: document.querySelector('.cesium-widget-errorPanel')?.innerText };
    });
    result.checks.push({ name, ...check });
    if (!check.ready || check.sun !== 'false' || !check.rings || check.rings > 400 || check.width !== 1.25 || !check.alphaPixels || check.errorPanel || check.visible !== 'visible') {
      throw Error(`Invalid crater screenshot state: ${JSON.stringify(check)}`);
    }
    const path = join(out, name + '.png');
    await page.screenshot({ path, clip: { x: 0, y: 0, width: 1440, height: 900, scale: .5 } });
    result.shots.push(path);
  };
  const fly = async (lat, lon, diameterKm, heightKm) => {
    await page.evaluate(async ({ lat, lon, diameterKm, heightKm }) => {
      const { poseLookingAt } = await import('/src/moon/navigation.ts');
      const v = window.__viewer, ground = window.__moonda.heights.heightAt(lat, lon, false);
      const range = heightKm ? heightKm * 1000 : diameterKm * 1000 / (.33 * 2 * Math.tan(v.camera.frustum.fovy / 2));
      const p = poseLookingAt(lat, lon, ground, range, 0, -90);
      window.__moonda.nav.cancel();
      v.camera.setView({ destination: p.destination, orientation: { direction: p.direction, up: p.up } });
      v.scene.requestRender();
    }, { lat, lon, diameterKm, heightKm });
    await wait(8000);
    await page.waitForFunction(() => Number(document.querySelector('.moon-crater-rims')?.dataset.rings) > 0, { timeout: 60000 });
  };
  const measureStart = () => page.evaluate(() => {
    const m = window.__craterMeasure = { frames: [], longTasks: [], running: true, last: performance.now() };
    const tick = t => { if (!m.running) return; m.frames.push(t - m.last); m.last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    m.observer = new PerformanceObserver(list => m.longTasks.push(...list.getEntries().map(e => ({ ms: e.duration, name: e.name }))));
    m.observer.observe({ entryTypes: ['longtask'] });
  });
  const measureStop = () => page.evaluate(() => {
    const m = window.__craterMeasure; m.running = false; m.observer.disconnect();
    const f = m.frames.slice(1).sort((a, b) => a - b);
    return { frames: f.length, fps: 1000 * f.length / f.reduce((a, b) => a + b, 0),
      p95Ms: f[Math.floor(f.length * .95)], maxMs: f.at(-1), over100ms: f.filter(x => x > 100).length, longTasks: m.longTasks };
  });
  for (const [name, lat, lon, diameter] of [
    ['01-firmicus', 7.3, 63.4, 56], ['02-copernicus', 9.62, -20.08, 96],
    ['03-tycho', -43.3, -11.2, 85], ['04-plato', 51.6, -9.4, 101],
    ['05-aristarchus', 23.7, -47.4, 40], ['06-tsiolkovskiy', -20.4, 129.1, 185],
    ['07-schrodinger', -75, 132.4, 316], ['08-shackleton', -89.67, 129.8, 21], ['09-peary', 88.6, 33, 73],
  ]) { if (!only || only.includes(name)) { await fly(lat, lon, diameter); await shot(name); } }
  if (!only) {
  await fly(7.3, 63.4, 56, 300); await shot('10-wide-300km');
  await measureStart(); await wait(3000); result.measures.wideIdle = await measureStop();
  await measureStart(); await fly(7.9, 64.3, 56, 30); result.measures.closeArrival = await measureStop();
  await shot('11-small-craters-30km');
  await fly(9.62, -20.08, 96);
  await page.keyboard.press('m');
  await page.waitForFunction(() => window.__moonda.flat.active && !window.__moonda.flat.busy, { timeout: 30000 });
  await page.evaluate(async () => { const f = window.__moonda.flat; await f.flyTo(f.viewAt(9.62, -20.08, 300), .1); });
  await wait(6000); await shot('12-copernicus-flat-2d');
  }
  result.hotUpdatesIgnored = await page.evaluate(() => window.__craterHotUpdatesIgnored);
  result.gpu = await page.evaluate(() => { const gl = window.__viewer.scene.context._gl, ext = gl.getExtension('WEBGL_debug_renderer_info'); return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL); });
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  result.failure = String(e); console.error(e);
  if (browser) {
    const page = (await browser.pages())[0];
    result.failureState = await page.evaluate(() => ({ progress: window.__moonda?.progress,
      rims: { ...document.querySelector('.moon-crater-rims')?.dataset },
      hotUpdatesIgnored: window.__craterHotUpdatesIgnored, body: document.body.innerText.slice(-2000) })).catch(() => null);
  }
  process.exitCode = 1;
} finally {
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
  try { await browser?.close(); } finally { lease.release(); }
}
