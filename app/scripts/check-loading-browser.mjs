// Real-GPU startup, navigation and terrain-switch regression against a built or live app.
// node scripts/check-loading-browser.mjs --url http://127.0.0.1:5195/ --out ../outputs/loading-fixes-2026-11-15/local [--fault]
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { acquireBrowserLease } from './browserLease.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const base = new URL(flag('--url', 'http://127.0.0.1:5195/'));
base.searchParams.set('start', '');
const out = resolve(flag('--out', '../outputs/loading-fixes-2026-11-15/browser'));
mkdirSync(out, { recursive: true });
const result = { url: base.href, checks: [], runs: [], errors: [], requestFailures: [] };
const save = () => writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
const lease = await acquireBrowserLease({ script: 'check-loading-browser.mjs', noteDir: out });
const profile = mkdtempSync(join(out, 'chrome-profile-'));
let browser;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, userDataDir: profile,
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
    args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  await lease.afterLaunch(browser);
  const page = (await browser.pages())[0];
  page.on('pageerror', error => { result.errors.push(String(error.stack ?? error)); save(); });
  page.on('requestfailed', request => result.requestFailures.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.evaluateOnNewDocument(fault => {
    localStorage.setItem('moonda.settings.v1', JSON.stringify({ quality: 'full', qualityChosen: true, sound: false, soundV: 2, volume: 0.5, lang: 'en' }));
    localStorage.setItem('moonda.tutorial.seen', '1');
    window.__loadingFault = { baseAttempts: 0 };
    if (fault) {
      const original = window.fetch;
      window.fetch = function (input, options) {
        const url = typeof input === 'string' ? input : input.url ?? String(input);
        if (/\/base\/v5\/base\.json(?:\?|$)/.test(url)) {
          window.__loadingFault.baseAttempts++;
          if (window.__loadingFault.baseAttempts === 1) return new Promise((_, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new DOMException('Injected stalled metadata', 'AbortError')), { once: true });
          });
        }
        return original.call(this, input, options);
      };
    }
    window.__loadingSamples = [];
    setInterval(() => {
      const p = window.__moonda?.progress;
      if (p && !window.__loadingSamples.at(-1)?.done) window.__loadingSamples.push({ at: performance.now(), pct: p.pct, done: p.done });
    }, 100);
  }, args.includes('--fault'));
  const startup = async name => {
    const began = Date.now();
    if (name === 'cold') await page.goto(base.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    else await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.__moonda?.progress?.done, { timeout: 190000 });
    const data = await page.evaluate(() => ({ progress: window.__moonda.progress, samples: window.__loadingSamples, fault: window.__loadingFault, quality: JSON.parse(localStorage.getItem('moonda.settings.v1')).quality }));
    data.elapsedMs = Date.now() - began;
    console.log(`${name} startup ready in ${data.elapsedMs} ms`);
    for (let i = 1; i < data.samples.length; i++) assert(data.samples[i].pct >= data.samples[i - 1].pct, 'startup progress regressed');
    assert.equal(data.quality, 'full');
    result.runs.push({ name, ...data }); save();
    await page.screenshot({ path: join(out, `${name}-ready.png`) });
    await page.evaluate(() => document.querySelector('.start-enter-quiet')?.click());
    await page.waitForFunction(() => !document.querySelector('.start'), { timeout: 10000 });
    return data;
  };
  const cold = await startup('cold');
  if (args.includes('--fault')) assert(cold.fault.baseAttempts >= 2, 'stalled photo metadata did not retry');
  result.checks.push('full-quality startup completes with monotonic progress');
  if (args.includes('--fault')) result.checks.push('stalled photo metadata retries in the real browser');
  const before = await page.evaluate(() => {
    const v = window.__viewer;
    return { height: v.camera.positionCartographic.height, sse: v.scene.globe.maximumScreenSpaceError, resolution: v.resolutionScale, msaa: v.scene.msaaSamples };
  });
  await page.mouse.move(680, 470); await page.mouse.wheel({ deltaY: -260 }); await wait(1200);
  const height = await page.evaluate(() => window.__viewer.camera.positionCartographic.height);
  assert(Math.abs(height - before.height) > 100, 'navigation remained locked after startup');
  result.checks.push('navigation works immediately after entry');
  // Terrain can also be restored from a saved session even when the current Layers panel hides this switch.
  await page.evaluate(() => window.__moondaTest.setLayer('terrain', false));
  await page.waitForFunction(() => window.__viewer.terrainProvider.hasVertexNormals === false, { timeout: 10000 });
  await page.evaluate(() => window.__moondaTest.stand(-89.45, -136.7));
  await page.waitForFunction(() => window.__moonda.lander.phase === 'on', { timeout: 70000 });
  console.log('Terrain-off surface view opened');
  result.surface = await page.evaluate(() => ({ hasNormals: window.__viewer.terrainProvider.hasVertexNormals, materialOn: window.__moonda.lander.materialOn, stats: { ...window.__moonda.lander.stats } }));
  assert(result.surface.hasNormals && result.surface.materialOn, 'surface did not restore real terrain');
  assert(result.surface.stats.groundSourceLevel >= 7, 'surface opened without proven ground');
  result.checks.push('Stand here opens safely with globe mountains switched off');
  await page.screenshot({ path: join(out, 'terrain-off-surface.png') });
  await page.evaluate(() => window.__moondaTest.exit());
  await page.waitForFunction(() => window.__moonda.lander.phase === 'off' && window.__viewer.terrainProvider.hasVertexNormals === false, { timeout: 15000 });
  const restored = await page.evaluate(() => ({ sse: window.__viewer.scene.globe.maximumScreenSpaceError, resolution: window.__viewer.resolutionScale, msaa: window.__viewer.scene.msaaSamples, quality: JSON.parse(localStorage.getItem('moonda.settings.v1')).quality }));
  assert.deepEqual(restored, { sse: before.sse, resolution: before.resolution, msaa: before.msaa, quality: 'full' });
  result.restored = restored;
  result.checks.push('exit restores the terrain preference and original Moon quality');
  await startup('warm');
  assert.deepEqual(result.errors, [], 'browser runtime errors');
  result.ok = true; save();
  console.log(JSON.stringify({ ok: true, checks: result.checks, runs: result.runs.map(run => ({ name: run.name, elapsedMs: run.elapsedMs })), requestFailures: result.requestFailures.length, out }, null, 2));
} catch (error) {
  result.failure = String(error.stack ?? error); save();
  throw error;
} finally {
  try { await browser?.close(); if (!browser?.process() || browser.process().exitCode !== null || browser.process().signalCode !== null) rmSync(profile, { recursive: true, force: true }); }
  finally { lease.release(); }
}
