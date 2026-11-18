// Production smoke check. This file does not depend on development-only Cesium exports.
// node outputs/pitch-2026-11-15/live-check.mjs --expected-hash index-ABC.js
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { acquireBrowserLease } from '../../app/scripts/browserLease.mjs';

const require = createRequire(new URL('../../app/package.json', import.meta.url));
const puppeteer = require('puppeteer-core');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node outputs/pitch-2026-11-15/live-check.mjs [--url https://moonda.us/] [--expected-hash index-HASH.js] [--out folder] [--profile folder] [--headful]');
  process.exit(0);
}
const flag = (key, fallback) => {
  const i = args.indexOf(key);
  return i < 0 ? fallback : args[i + 1];
};
const url = flag('--url', 'https://moonda.us/');
const out = resolve(flag('--out', fileURLToPath(new URL('./live-after/', import.meta.url))));
const profile = resolve(flag('--profile', join(out, 'chrome-profile')));
const expectedHash = flag('--expected-hash', flag('--expected-index-hash', null));
const maxReadyMs = Number(flag('--max-ready-ms', 180000));
const siteOrigin = new URL(url).origin;
const profileExisted = existsSync(profile) && readdirSync(profile).length > 0;
mkdirSync(out, { recursive: true });
const result = {
  url, expectedHash, startedAt: new Date().toISOString(), profile, profileExisted,
  viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  pageErrors: [], consoleErrors: [],
  httpErrors: { sameSite: [], external: [] },
  requestFailures: { sameSite: [], external: [] },
  renderErrors: [], runs: [], landing: null, driving: null, checks: {},
};
const wait = ms => new Promise(done => setTimeout(done, ms));
let browser, page, lease, part = 'launch', cleanupPromise;
const save = () => writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
const classify = resourceUrl => {
  try { return new URL(resourceUrl).origin === siteOrigin ? 'sameSite' : 'external'; }
  catch { return 'external'; }
};
const recordFailure = (resourceUrl, error, source) => {
  if (/ERR_ABORTED|aborted|cancelled|canceled/i.test(error || '')) return;
  result.requestFailures[classify(resourceUrl)].push({ part, url: resourceUrl, error, source });
};
async function cleanup() {
  cleanupPromise ??= (async () => {
    try { await browser?.close(); }
    finally { lease?.release(); }
  })();
  return cleanupPromise;
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    result.failure = `Interrupted by ${signal}`;
    save();
    void cleanup().finally(() => process.exit(code));
  });
}

async function snapshot() {
  return page.evaluate(() => {
    const m = window.__moonda, viewer = m?.viewer, lander = m?.lander;
    const errorPanel = document.querySelector('.render-stopped, .cesium-widget-errorPanel');
    return {
      progress: m?.progress ?? null,
      preloadTrace: m?.preloadTrace ?? [], layerWarm: m?.layerWarm ?? null,
      poleHeightWarm: m?.poleHeightWarm ?? null,
      render: { loop: viewer?.useDefaultRenderLoop ?? null,
        errorOverlay: errorPanel?.innerText ?? null, errors: window.__liveCheckRenderErrors ?? [] },
      lander: lander ? { phase: lander.phase, active: lander.active, placed: lander.placed,
        stats: { ...lander.stats }, rocksShown: lander.rocksShown,
        roverReady: lander.roverReady, resolutionScale: viewer?.resolutionScale,
        msaaSamples: viewer?.scene?.msaaSamples,
        driver: lander.driver ? { speed: lander.driver.speed, odometer: lander.driver.odometer,
          bodyH: lander.driver.bodyH, pitch: lander.driver.pitch, roll: lander.driver.roll } : null } : null,
      title: document.title,
      indexScripts: [...document.querySelectorAll('script[src]')].map(s => s.src).filter(src => /\/assets\/index-[^/]+\.js/.test(src)),
      resourceIndexes: performance.getEntriesByType('resource').map(r => r.name).filter(src => /\/assets\/index-[^/]+\.js/.test(src)),
      timing: performance.getEntriesByType('navigation').map(n => ({
        type: n.type, responseStart: n.responseStart, domContentLoadedEventEnd: n.domContentLoadedEventEnd,
        transferSize: n.transferSize, encodedBodySize: n.encodedBodySize,
      })),
    };
  });
}

async function enterIfVisible() {
  // WebDriver normally auto-enters. ?start deliberately leaves the real button visible.
  for (const selector of ['.start-enter-quiet:not([disabled])', '.start-enter:not([disabled])']) {
    const button = await page.$(selector);
    if (button && await button.boundingBox()) {
      await button.click();
      await wait(650);
      return selector;
    }
  }
  return null;
}

async function loadRun(name, reload = false) {
  part = name;
  const t0 = Date.now();
  const response = reload
    ? await page.reload({ waitUntil: 'domcontentloaded', timeout: maxReadyMs })
    : await page.goto(url, { waitUntil: 'domcontentloaded', timeout: maxReadyMs });
  const html = await response.text();
  const run = {
    name, navigationStatus: response.status(), finalUrl: page.url(),
    htmlSha256: createHash('sha256').update(html).digest('hex'),
    htmlIndexes: [...html.matchAll(/(?:src|href)=["']([^"']*\/assets\/index-[^"']+\.js)["']/g)].map(m => m[1]),
    ready: false, readyMs: null,
  };
  result.runs.push(run);
  try {
    await page.waitForFunction(() => window.__moonda?.progress?.done === true && !!window.__moondaTest,
      { polling: 250, timeout: Math.max(1, maxReadyMs - (Date.now() - t0)) });
    run.ready = true;
    run.readyMs = Date.now() - t0;
  } catch (error) { run.readyFailure = String(error.message); }
  await page.evaluate(() => {
    window.__liveCheckRenderErrors ??= [];
    const scene = window.__moonda?.viewer?.scene;
    if (scene && !window.__liveCheckRenderListener) {
      window.__liveCheckRenderListener = scene.renderError.addEventListener((_, error) => {
        window.__liveCheckRenderErrors.push(String(error?.stack || error));
      });
    }
  });
  Object.assign(run, await snapshot());
  const seenIndexes = [...run.htmlIndexes, ...run.indexScripts, ...run.resourceIndexes];
  run.expectedHashMatches = expectedHash === null ? null
    : run.htmlSha256 === expectedHash || seenIndexes.some(src => src.includes(expectedHash));
  if (run.ready) { run.enterClicked = await enterIfVisible(); await wait(650); }
  await page.screenshot({ path: join(out, `${name}-globe.png`), fullPage: false });
  save();
  console.log(JSON.stringify({ event: name, ready: run.ready, readyMs: run.readyMs,
    index: run.htmlIndexes, expectedHashMatches: run.expectedHashMatches,
    laterStages: run.progress?.stages?.filter(stage => stage.state === 'later').map(stage => stage.id),
    renderOverlay: run.render?.errorOverlay }));
  return run;
}

try {
  lease = await acquireBrowserLease({ script: 'live-check.mjs', noteDir: out,
    timeoutMs: Number(flag('--lease-wait-ms', 180000)) });
  browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: !args.includes('--headful'), userDataDir: profile,
    defaultViewport: result.viewport,
    args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run',
      '--hide-scrollbars', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows'],
  });
  await lease.afterLaunch(browser);
  browser.on('targetcreated', async target => {
    if (!['worker', 'shared_worker', 'service_worker'].includes(target.type())) return;
    try {
      const session = await target.createCDPSession(), workerUrls = new Map();
      session.on('Network.requestWillBeSent', event => workerUrls.set(event.requestId, event.request.url));
      session.on('Network.responseReceived', event => {
        if (event.response.status >= 400) result.httpErrors[classify(event.response.url)].push({
          part, url: event.response.url, status: event.response.status, source: target.type(),
        });
      });
      session.on('Network.loadingFailed', event => {
        if (!event.canceled) recordFailure(workerUrls.get(event.requestId) ?? target.url(), event.errorText, target.type());
      });
      await session.send('Network.enable');
    } catch { /* A worker may finish before its diagnostics attach. */ }
  });
  page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport(result.viewport);
  page.on('pageerror', error => result.pageErrors.push({ part, error: error.stack || String(error) }));
  page.on('console', message => {
    if (message.type() === 'error') result.consoleErrors.push({ part, text: message.text().slice(0, 2000) });
  });
  page.on('response', response => {
    if (response.status() >= 400) result.httpErrors[classify(response.url())].push({
      part, url: response.url(), status: response.status(), source: 'page',
    });
  });
  page.on('requestfailed', request => recordFailure(request.url(), request.failure()?.errorText, 'page'));

  const cold = await loadRun(profileExisted ? 'cached-first' : 'cold');
  if (cold.ready) {
    part = 'landing';
    const t0 = Date.now();
    await page.evaluate(() => window.__moondaTest.stand(-89.45, -137.3));
    try {
      await page.waitForFunction(() => window.__moonda?.lander?.phase === 'on', { polling: 100, timeout: 60000 });
      result.landing = { ready: true, readyMs: Date.now() - t0, ...(await snapshot()) };
    } catch (error) {
      result.landing = { ready: false, readyMs: Date.now() - t0, failure: String(error.message), ...(await snapshot()) };
    }
    await page.screenshot({ path: join(out, 'live-landed.png'), fullPage: false });
    console.log(JSON.stringify({ event: 'landing', ready: result.landing.ready,
      readyMs: result.landing.readyMs, phase: result.landing.lander?.phase,
      cameraClearanceM: result.landing.lander?.stats?.cameraClearanceM,
      renderOverlay: result.landing.render?.errorOverlay }));
    save();
    if (result.landing.ready) {
      part = 'driving';
      // Exercise the production HUD: its module-local link is deliberately not a window global.
      const driveButton = await page.waitForSelector('.lv-walkbar > .lv-walk', { visible: true, timeout: 10000 });
      if (await driveButton.evaluate(button => button.getAttribute('aria-pressed')) !== 'true') await driveButton.click();
      const cameraButtons = await page.$$('.lv-walkbar .lv-seg > button[role="radio"]');
      if (cameraButtons.length !== 3) throw new Error('Production HUD did not expose the three camera buttons');
      if (await cameraButtons[1].evaluate(button => button.getAttribute('aria-checked')) !== 'true') await cameraButtons[1].click();
      await page.waitForFunction(() => {
        const lander = window.__moonda?.lander;
        return lander?.view === 'third' && lander.walking === true;
      }, { timeout: 10000 });
      await page.evaluate(() => document.activeElement?.blur());
      await wait(700);
      await page.evaluate(() => {
        const lander = window.__moonda.lander;
        const data = window.__liveCheckDrive = {
          startMs: performance.now(), odometerStart: lander.driver?.odometer,
          frames: [], running: true, previous: null,
        };
        const sample = now => {
          if (!data.running) return;
          // There is no complete frame interval on the first callback.
          if (data.previous !== null) data.frames.push({
            ms: now - data.startMs, dt: now - data.previous,
            speed: lander.driver?.speed, resolutionScale: window.__moonda.viewer.resolutionScale,
          });
          data.previous = now;
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      try {
        await page.keyboard.down('w');
        await wait(4000);
      } finally {
        await page.keyboard.up('w');
      }
      const drive = await page.evaluate(() => {
        const data = window.__liveCheckDrive;
        data.running = false;
        data.endMs = performance.now();
        data.odometerEnd = window.__moonda.lander.driver?.odometer;
        return data;
      });
      const intervals = drive.frames.map(frame => frame.dt).filter(dt => Number.isFinite(dt) && dt > 0).sort((a, b) => a - b);
      const sum = intervals.reduce((total, dt) => total + dt, 0);
      result.driving = {
        heldWMs: 4000, frames: drive.frames,
        summary: { frames: intervals.length,
          averageFps: intervals.length ? +(1000 * intervals.length / sum).toFixed(2) : null,
          averageFrameMs: intervals.length ? +(sum / intervals.length).toFixed(2) : null,
          p95FrameMs: intervals.length ? +intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * .95))].toFixed(2) : null,
          maxFrameMs: intervals.length ? +intervals.at(-1).toFixed(2) : null,
          elapsedMs: +(drive.endMs - drive.startMs).toFixed(2),
          drivenMetres: drive.odometerEnd - drive.odometerStart,
        },
        afterKeyUp: await snapshot(),
      };
      await wait(8000);
      result.driving.afterRest = await snapshot();
      await page.screenshot({ path: join(out, 'live-driven-rested.png'), fullPage: false });
      const stopButton = await page.waitForSelector('.lv-walkbar > .lv-walk[aria-pressed="true"]', { visible: true, timeout: 5000 });
      await stopButton.click();
      await page.waitForFunction(() => window.__moonda?.lander?.walking === false, { timeout: 5000 });
      console.log(JSON.stringify({ event: 'driving', ...result.driving.summary,
        resolutionScaleAfterRest: result.driving.afterRest.lander?.resolutionScale,
        cameraClearanceM: result.driving.afterRest.lander?.stats?.cameraClearanceM }));
      save();
    }
    await page.evaluate(() => window.__moondaTest.exit());
    try { await page.waitForFunction(() => window.__moonda?.lander?.phase === 'off', { timeout: 20000 }); }
    catch (error) { result.exitFailure = String(error.message); }
    result.afterExit = await snapshot();
  }
  await loadRun('warm', true);
  const snapshots = [...result.runs, ...(result.landing ? [result.landing] : []),
    ...(result.driving ? [result.driving.afterKeyUp, result.driving.afterRest] : []),
    ...(result.afterExit ? [result.afterExit] : [])];
  result.renderErrors = snapshots.flatMap(run => run.render?.errors ?? []);
  result.checks = {
    bothLoadsReady: result.runs.length === 2 && result.runs.every(run => run.ready),
    expectedBuild: expectedHash === null ? null : result.runs.every(run => run.expectedHashMatches),
    landingReady: result.landing?.ready === true,
    drivingFrames: (result.driving?.summary.frames ?? 0) > 0,
    exitReady: !!result.afterExit && !result.exitFailure && result.afterExit.lander?.phase === 'off',
    noRenderOverlay: snapshots.every(run => !run.render?.errorOverlay),
    renderLoopRunning: snapshots.every(run => run.render?.loop === true),
    noRenderErrors: result.renderErrors.length === 0,
    noPageErrors: result.pageErrors.length === 0,
    noSameSiteHttpErrors: result.httpErrors.sameSite.length === 0,
    noSameSiteRequestFailures: result.requestFailures.sameSite.length === 0,
  };
  result.ok = Object.values(result.checks).every(value => value !== false);
  result.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ ok: result.ok, checks: result.checks, profileExisted,
    firstLoadReadyMs: result.runs[0]?.readyMs,
    coldReadyMs: profileExisted ? null : result.runs[0]?.readyMs, warmReadyMs: result.runs[1]?.readyMs,
    landingReadyMs: result.landing?.readyMs, driving: result.driving?.summary,
    pageErrorCount: result.pageErrors.length,
    httpErrorCount: { sameSite: result.httpErrors.sameSite.length, external: result.httpErrors.external.length },
    requestFailureCount: { sameSite: result.requestFailures.sameSite.length, external: result.requestFailures.external.length }, out }));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  result.ok = false;
  result.failure = error.stack || String(error);
  result.finishedAt = new Date().toISOString();
  save();
  console.error(result.failure);
  process.exitCode = 1;
} finally {
  await cleanup();
}
