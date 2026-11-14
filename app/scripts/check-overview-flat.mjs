// Check the flat map's real pick helpers. --scenario prints steps for scripts/drive.mjs;
// the browser half clicks a grid and reads the actual drawing shader at those pixels.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireBrowserLease } from './browserLease.mjs';
import { stripTypeScriptTypes } from 'node:module';

const source = readFileSync(new URL('../src/moon/flatMap.ts', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('const wrap180 ='), source.indexOf('const VS ='));
const compiled = stripTypeScriptTypes(helpers.replaceAll('export function ', 'function '), { mode: 'strip' });
const api = new Function(`${compiled}; return { flatScreen, flatGround };`)();
let points = 0, worstPx = 0, worstDeg = 0;
for (const [width, height] of [[360, 700], [1024, 768], [1440, 900], [1920, 1200]]) {
  for (const left of [0, 64, Math.min(375, width / 3)]) for (const dpr of [1, 1.25, 2, 3]) for (const cssScale of [0.75, 1, 1.3]) {
    const origin = { cx: (left + width - 76) / 2, cy: (76 + height - 160) / 2 };
    for (const [latC, lonC] of [[0, 0], [60, 179.9], [-84.9, -179.9], [89.9, 82]]) for (const s of [Math.max(width / 360, height / 180), 40, 8000]) {
      const view = { s, latC, lonC };
      for (let j = 1; j < 6; j++) for (let i = 1; i < 8; i++) {
        const x = width * i / 8 + 0.5, y = height * j / 6 + 0.5;
        // Browser client coordinates may be scaled and offset; device pixels never enter picking.
        const client = { x: 27 + x * cssScale, y: 49 + y * cssScale };
        const local = { x: (client.x - 27) / cssScale, y: (client.y - 49) / cssScale };
        const ll = api.flatGround(local.x, local.y, view, origin);
        if (Math.abs(ll.lat) > 90 || Math.abs(x - origin.cx) / s >= 180) continue;
        const screen = api.flatScreen(ll.lat, ll.lon, view, origin);
        const error = Math.hypot(screen.x - x, screen.y - y);
        worstPx = Math.max(worstPx, error);
        const back = api.flatGround(screen.x, screen.y, view, origin);
        worstDeg = Math.max(worstDeg, Math.abs(back.lat - ll.lat), Math.abs(((back.lon - ll.lon + 540) % 360) - 180));
        assert.ok(error < 1e-6, `click drift ${error}px at ${JSON.stringify({ width, height, left, dpr, cssScale, view, x, y })}`);
        points++;
      }
    }
  }
}
const summary = { points, worstPx, worstDeg, result: 'PASS' };

// This function is stringified for the existing harness, which owns and closes the one browser.
async function browserGrid() {
  const flat = window.__moonda?.flat;
  if (!flat?.active) throw new Error('Switch to the flat map first');
  const saved = { view: { ...flat.view }, click: flat.hooks.onClickGround, choosing: flat.hooks.choosingDestination, capture: flat.ui.setPointerCapture };
  flat.ui.setPointerCapture = () => {}; // Synthetic pointer IDs do not own a native capture.
  const reports = [], cases = [];
  flat.hooks.onClickGround = (lat, lon) => reports.push({ lat, lon });
  flat.hooks.choosingDestination = () => true;
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  let clicks = 0, worstClickPx = 0, worstShaderPx = 0;
  try {
    for (const [lat, lon, km] of [[0.674, 23.473, 9000], [60, 179.9, 700], [-84.9, -179.9, 40], [0.674, 23.473, 5]]) {
      flat.stop(); flat.view = flat.viewAt(lat, lon, km); flat.request(); await frame();
      const f = flat.free(), points = [];
      for (let j = 1; j <= 3; j++) for (let i = 1; i <= 5; i++) {
        const x = Math.floor(f.x0 + f.w * i / 6) + 0.5, y = Math.floor(f.y0 + f.h * j / 4) + 0.5;
        const ll = flat.drawnGround(x, y);
        if (Math.abs(ll.lat) <= 89.999 && Math.abs(x - f.cx) / flat.view.s < 179.9) points.push({ x, y });
      }
      const shader = flat.checkDrawnGrid(points);
      for (const item of shader) worstShaderPx = Math.max(worstShaderPx, item.errorPx);
      await frame();
      for (const p of points) {
        const expected = flat.drawnGround(p.x, p.y), r = flat.ui.getBoundingClientRect();
        const clientX = r.left + p.x * r.width / flat.ui.clientWidth, clientY = r.top + p.y * r.height / flat.ui.clientHeight;
        const countBefore = reports.length;
        // Dispatch through the actual canvas handlers. The destination mode bypasses name hits.
        flat.ui.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 91, button: 0, clientX, clientY }));
        flat.ui.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 91, button: 0, clientX, clientY }));
        await new Promise(resolve => setTimeout(resolve, 265));
        const got = reports.at(-1);
        if (!got || reports.length !== countBefore + 1) throw new Error('Flat click did not report exactly one point');
        const dLon = ((got.lon - expected.lon + 540) % 360) - 180;
        worstClickPx = Math.max(worstClickPx, Math.hypot(dLon, got.lat - expected.lat) * flat.view.s);
        clicks++;
      }
      cases.push({ lat, lon, km, points: points.length, shaderWorstPx: Math.max(0, ...shader.map(p => p.errorPx)), detail: flat.diagnostics() });
    }
    if (worstClickPx > 0.001 || worstShaderPx > 0.12) throw new Error(`Grid mismatch: click ${worstClickPx}px, shader ${worstShaderPx}px`);
    return { clicks, worstClickPx, worstShaderPx, cases, result: 'PASS' };
  } finally {
    flat.ui.setPointerCapture = saved.capture; flat.hooks.onClickGround = saved.click; flat.hooks.choosingDestination = saved.choosing; flat.view = saved.view; flat.request();
  }
}

async function standaloneBrowser() {
  const args = process.argv.slice(2), outFlag = args.indexOf('--out');
  const out = resolve(outFlag >= 0 ? args[outFlag + 1] : '/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/R/flat-standalone');
  mkdirSync(out, { recursive: true });
  const lease = await acquireBrowserLease({ script: 'check-overview-flat.mjs', noteDir: out, timeoutMs: 280000 });
  const { default: puppeteer } = await import('puppeteer-core');
  const result = { pure: summary, grids: [], zoom: null, sharp: [], errors: [], shots: [] };
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, protocolTimeout: 300000,
      defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run', '--hide-scrollbars', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    });
    await lease.afterLaunch(browser);
    const page = (await browser.pages())[0] ?? await browser.newPage();
    page.setDefaultTimeout(280000);
    page.on('pageerror', error => result.errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') result.errors.push(message.text().slice(0, 300)); });
    // Keep the live Vite module transforms and data, but do not load App or the HMR client.
    // Other owners can edit their screens without restarting this small renderer check.
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        void request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><title>Flat map check</title><style>html,body{margin:0;background:#0a0b0f;color:#eee;font:14px system-ui;overflow:hidden}#parent{position:absolute;left:0;top:0;width:1440px;height:900px;transform-origin:0 0}</style></head><body><div id="parent"></div></body></html>' });
      } else void request.continue();
    });
    await page.goto('http://127.0.0.1:5190/', { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.evaluate(async () => {
      // A glyph is a TSX module, so install React's small development preamble. Keep its
      // HMR transport disconnected: this page is a fixed renderer check, outside App.
      window.WebSocket = class extends EventTarget {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        readyState = 0; bufferedAmount = 0; protocol = ''; extensions = ''; binaryType = 'blob';
        constructor(url) { super(); this.url = String(url); }
        send() {} close() { this.readyState = 3; }
      };
      const RefreshRuntime = (await import('/@react-refresh')).default;
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const { FlatMap } = await import('/src/moon/flatMap.ts');
      window.__flatInsets = { top: 76, bottom: 160, left: 64, right: 76 };
      const flat = new FlatMap(document.querySelector('#parent'), {
        labels: () => [], icon: () => undefined, pins: () => [], panelBoxes: () => [],
        insets: () => window.__flatInsets, onClickTag() {}, onClickGround() {}, onHover() {}, choosingDestination: () => true,
      });
      window.__moonda = { flat };
      await flat.prepare(true);
      flat.active = true; flat.morphA = 1; flat.morphB = 1; flat.sunOn = false;
      flat.setShown(true); flat.resize(); flat.view = flat.wholeView(); flat.request();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const configs = [
      { width: 1440, height: 900, dpr: 1, parentWidth: 1440, parentHeight: 900, left: 0, top: 0, scale: 1, inset: 64 },
      { width: 1440, height: 900, dpr: 2, parentWidth: 1440, parentHeight: 900, left: 0, top: 0, scale: 1, inset: 375 },
      { width: 1024, height: 768, dpr: 1, parentWidth: 1100, parentHeight: 760, left: 27, top: 31, scale: 0.82, inset: 64 },
      { width: 1024, height: 768, dpr: 2, parentWidth: 800, parentHeight: 620, left: 43, top: 29, scale: 1.15, inset: 280 },
    ];
    for (const config of configs) {
      await page.setViewport({ width: config.width, height: config.height, deviceScaleFactor: config.dpr });
      await page.evaluate(config => {
        const parent = document.querySelector('#parent');
        Object.assign(parent.style, { width: `${config.parentWidth}px`, height: `${config.parentHeight}px`, left: `${config.left}px`, top: `${config.top}px`, transform: `scale(${config.scale})` });
        window.__flatInsets.left = config.inset;
        window.__moonda.flat.resize();
      }, config);
      const grid = await page.evaluate(browserGrid);
      result.grids.push({ config, ...grid });
      writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
      console.error(`[flat check] DPR ${config.dpr}, ${config.width} x ${config.height}, inset ${config.inset}, scale ${config.scale}: ${grid.clicks} clicks, GPU ${grid.worstShaderPx.toFixed(4)} px`);
    }
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
    await page.evaluate(() => {
      Object.assign(document.querySelector('#parent').style, { width: '1440px', height: '900px', left: '0px', top: '0px', transform: 'none' });
      window.__flatInsets = { top: 76, bottom: 160, left: 64, right: 76 };
      const flat = window.__moonda.flat; flat.resize(); flat.view = flat.viewAt(0.674, 23.473, 10); flat.request();
    });
    await new Promise(resolve => setTimeout(resolve, 200));
    result.zoom = await page.evaluate(async () => {
      const flat = window.__moonda.flat, rect = flat.ui.getBoundingClientRect(), start = flat.view.s;
      const point = { x: 900, y: 400 }, before = flat.toLatLon(point.x, point.y), times = [], t0 = performance.now();
      flat.ui.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: rect.left + point.x, clientY: rect.top + point.y }));
      let last = t0;
      while (performance.now() - t0 < 220) {
        const now = await new Promise(resolve => requestAnimationFrame(resolve));
        times.push(now - last); last = now;
      }
      const after = flat.toLatLon(point.x, point.y), ratio = flat.view.s / start;
      const anchorErrorPx = Math.hypot(after.lat - before.lat, ((after.lon - before.lon + 540) % 360) - 180) * flat.view.s;
      if (Math.abs(ratio - 1.6) > 0.001 || anchorErrorPx > 0.01) throw new Error(`Zoom mismatch: factor ${ratio}, anchor ${anchorErrorPx}`);
      times.sort((a, b) => a - b);
      return { ratio, anchorErrorPx, frames: times.length, medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.floor(times.length * 0.95)], maxMs: times.at(-1) };
    });
    for (const place of [{ name: 'apollo11-5km', lat: 0.674, lon: 23.473 }, { name: 'south-pole-5km', lat: -89.45, lon: -137.3 }]) {
      await page.evaluate(place => { const flat = window.__moonda.flat; flat.stop(); flat.view = flat.viewAt(place.lat, place.lon, 5); flat.request(); }, place);
      const started = Date.now();
      let detail;
      do {
        await new Promise(resolve => setTimeout(resolve, 500));
        detail = await page.evaluate(() => window.__moonda.flat.diagnostics());
        if (detail.tileLevels.some(level => level.startsWith('detail-') || level.startsWith('polar:'))) break;
      } while (Date.now() - started < 30000);
      await new Promise(resolve => setTimeout(resolve, 400));
      detail = await page.evaluate(() => window.__moonda.flat.diagnostics());
      result.sharp.push({ ...place, ...detail, realDetail: detail.tileLevels.some(level => level.startsWith('detail-') || level.startsWith('polar:')) });
      const file = join(out, `${place.name}.png`);
      await page.screenshot({ path: file }); result.shots.push(file);
      console.error(`[flat check] ${place.name}: ${detail.tileLevels.join(', ') || 'base fallback'}`);
    }
    result.gpu = await page.evaluate(() => {
      const gl = window.__moonda.flat.gl, extension = gl.getExtension('WEBGL_debug_renderer_info');
      return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : 'unknown';
    });
    await page.evaluate(() => window.__moonda.flat.destroy());
    result.result = 'PASS';
    writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    result.result = 'FAIL'; result.failure = error?.stack ?? String(error);
    writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
    throw error;
  } finally {
    try { await browser?.close(); } finally { lease.release(); }
  }
}

if (process.argv.includes('--scenario')) console.log(JSON.stringify([{ do: 'eval', name: 'flat-click-grid', js: `(${browserGrid.toString()})()` }]));
else if (process.argv.includes('--browser')) console.log(JSON.stringify(await standaloneBrowser(), null, 2));
else console.log(JSON.stringify(summary, null, 2));
