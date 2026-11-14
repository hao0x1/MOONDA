// Drive the app in a hidden copy of Chrome: click, drag, scroll, take real screenshots and
// measure real frame rates. Used to test changes the way a person would use the site.
//
//   node scripts/drive.mjs scenario.json [--out <dir>] [--url http://127.0.0.1:5190/] [--profile <dir>] [--width 1440 --height 900] [--headful]
//   --profile keeps Chrome's cache and site storage between runs (remote map tiles load much faster the second time;
//   the welcome dialog then only shows on the first run). Without it every run starts from a clean browser.
//   node scripts/drive.mjs '[{"do":"ready"},{"do":"shot","name":"start"}]' --out /tmp/x
//
// A scenario is a JSON list of steps:
//   {"do":"goto","url":"http://..."}              open a page (the first step is an implicit goto of --url)
//   {"do":"wait","ms":500}
//   {"do":"ready","timeout":30000}                wait until the 3D map has finished loading what is on screen
//   {"do":"click","text":"South Pole"}            click the first visible button/link containing this text
//   {"do":"click","x":700,"y":450}                click at a screen position (CSS pixels)
//   {"do":"dblclick","x":700,"y":450,"button":"left"}
//   {"do":"move","x":700,"y":450}
//   {"do":"drag","from":[700,450],"to":[900,500],"ms":600,"button":"left","keys":["Shift"],"hold":200,"measure":"drag1"}
//   {"do":"wheel","x":700,"y":450,"deltaY":-120,"times":10,"everyMs":40,"measure":"zoom1"}
//   {"do":"key","key":"n"}
//   {"do":"type","text":"Shackleton"}
//   {"do":"eval","js":"window.__viewer.camera.positionCartographic.height","name":"h"}
//   {"do":"shot","name":"pole"}                   save <out>/<name>.png at half size (1 image pixel per CSS pixel)
//   {"do":"shot","name":"detail","clip":[x,y,w,h]} one area at full device resolution; {"do":"shot","name":"big","full":true} whole page at full resolution
//   {"do":"measure","ms":2000,"name":"idle"}      record frame times for a while
//   {"do":"profile-start"} ... {"do":"profile-stop","name":"exit","top":25}   CPU profile: the functions that used the most time in between
// "measure" on drag/wheel records frames during the action plus 600 ms after it.
// The result (frame-rate numbers, eval results, console errors) is printed as JSON and saved to <out>/result.json.

import { mkdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const VALUE_FLAGS = ['--out', '--url', '--profile', '--width', '--height'];
const scenarioArg = args.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[i - 1]));
if (!scenarioArg) { console.error('usage: node scripts/drive.mjs <scenario.json | JSON> [--out dir] [--url url] [--headful]'); process.exit(2); }
const steps = JSON.parse(existsSync(scenarioArg) ? readFileSync(scenarioArg, 'utf8') : scenarioArg);
const out = resolve(flag('--out', join(tmpdir(), 'moonda-drive')));
const baseUrl = flag('--url', 'http://127.0.0.1:5190/');
const W = +flag('--width', 1440), H = +flag('--height', 900);
mkdirSync(out, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: !args.includes('--headful'),
  userDataDir: flag('--profile', null) ? resolve(flag('--profile', '')) : mkdtempSync(join(tmpdir(), 'moonda-chrome-')),
  defaultViewport: { width: W, height: H, deviceScaleFactor: 2 },
  args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run', '--hide-scrollbars', `--window-size=${W},${H}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const page = (await browser.pages())[0] ?? await browser.newPage();
const result = { steps: [], measures: {}, evals: {}, errors: [], shots: [] };
page.on('console', m => { if (m.type() === 'error') result.errors.push(m.text().slice(0, 300)); });
page.on('pageerror', e => result.errors.push('PAGE ERROR: ' + String(e).slice(0, 300)));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let cdp = null;
const startMeasure = () => page.evaluate(() => {
  const m = { t: [], long: 0, run: true }; window.__driveMeasure = m;
  let last = performance.now();
  const tick = now => { if (!m.run) return; m.t.push(now - last); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try { m.obs = new PerformanceObserver(l => { m.long += l.getEntries().length; }); m.obs.observe({ entryTypes: ['longtask'] }); } catch { /* not supported */ }
});
const stopMeasure = () => page.evaluate(() => {
  const m = window.__driveMeasure; if (!m) return null; m.run = false; m.obs?.disconnect();
  const t = m.t.slice(1).sort((a, b) => a - b); if (!t.length) return { frames: 0 };
  const q = p => +t[Math.min(t.length - 1, Math.floor(p * t.length))].toFixed(1);
  const total = t.reduce((a, b) => a + b, 0);
  return { frames: t.length, fps: +(1000 * t.length / total).toFixed(1), medianMs: q(0.5), p95Ms: q(0.95), maxMs: q(1), over33ms: t.filter(x => x > 33).length, over100ms: t.filter(x => x > 100).length, longTasks: m.long };
});
const ready = async (timeout = 30000) => {
  const t0 = Date.now(); let ok = 0;
  while (Date.now() - t0 < timeout) {
    const done = await page.evaluate(() => {
      const api = window.__moonda;
      if (api && typeof api.idle === 'function') return !!api.idle();
      const v = window.__viewer; return !!(v && v.scene.globe.tilesLoaded);
    }).catch(() => false);
    ok = done ? ok + 1 : 0;
    if (ok >= 4) return true;
    await sleep(250);
  }
  return false;
};

await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 180000 });
for (const s of steps) {
  const t0 = Date.now(); let note;
  try {
    if (s.do === 'goto') await page.goto(s.url ?? baseUrl, { waitUntil: 'domcontentloaded', timeout: 180000 });
    else if (s.do === 'wait') await sleep(s.ms ?? 500);
    else if (s.do === 'ready') note = (await ready(s.timeout)) ? 'ready' : 'TIMED OUT waiting for the map';
    else if (s.do === 'move') await page.mouse.move(s.x, s.y);
    else if (s.do === 'click' && s.text) {
      const pos = await page.evaluate(text => {
        const els = [...document.querySelectorAll('button, a, [role=button], [role=tab], [role=radio], [role=option], summary, label')];
        const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const el = els.find(e => vis(e) && (e.innerText || e.getAttribute('aria-label') || '').trim().toLowerCase() === text.toLowerCase())
          ?? els.find(e => vis(e) && ((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '')).toLowerCase().includes(text.toLowerCase()));
        if (!el) return null; const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];
      }, s.text);
      if (!pos) note = `NOT FOUND: "${s.text}"`; else await page.mouse.click(pos[0], pos[1]);
    }
    else if (s.do === 'click') await page.mouse.click(s.x, s.y, { button: s.button ?? 'left' });
    else if (s.do === 'dblclick') { // two real clicks in quick succession, like a person
      for (const k of s.keys ?? []) await page.keyboard.down(k);
      await page.mouse.move(s.x, s.y);
      for (let i = 1; i <= 2; i++) { await page.mouse.down({ button: s.button ?? 'left', clickCount: i }); await sleep(25); await page.mouse.up({ button: s.button ?? 'left', clickCount: i }); await sleep(70); }
      for (const k of s.keys ?? []) await page.keyboard.up(k);
    }
    else if (s.do === 'drag') {
      if (s.measure) await startMeasure();
      for (const k of s.keys ?? []) await page.keyboard.down(k);
      const [x0, y0] = s.from, [x1, y1] = s.to, ms = s.ms ?? 500, n = Math.max(2, Math.round(ms / 16));
      await page.mouse.move(x0, y0); await page.mouse.down({ button: s.button ?? 'left' });
      for (let i = 1; i <= n; i++) { await page.mouse.move(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n); await sleep(ms / n); }
      if (s.hold) await sleep(s.hold); // pause before letting go (no flick)
      await page.mouse.up({ button: s.button ?? 'left' });
      for (const k of s.keys ?? []) await page.keyboard.up(k);
      if (s.measure) { await sleep(s.settleMs ?? 600); result.measures[s.measure] = await stopMeasure(); }
    }
    else if (s.do === 'wheel') {
      if (s.measure) await startMeasure();
      await page.mouse.move(s.x, s.y);
      for (let i = 0; i < (s.times ?? 1); i++) { await page.mouse.wheel({ deltaY: s.deltaY ?? -100, deltaX: s.deltaX ?? 0 }); await sleep(s.everyMs ?? 30); }
      if (s.measure) { await sleep(s.settleMs ?? 600); result.measures[s.measure] = await stopMeasure(); }
    }
    else if (s.do === 'key') await page.keyboard.press(s.key);
    else if (s.do === 'keydown') await page.keyboard.down(s.key);   // hold a key (walking): {"do":"keydown","key":"w"} ... {"do":"keyup","key":"w"}
    else if (s.do === 'keyup') await page.keyboard.up(s.key);
    else if (s.do === 'type') await page.keyboard.type(s.text, { delay: 20 });
    else if (s.do === 'eval') { const v = await page.evaluate(js => (0, eval)(js), s.js); if (s.name) result.evals[s.name] = v; note = JSON.stringify(v)?.slice(0, 200); }
    else if (s.do === 'profile-start') { // CPU profile of the page's main thread (find what makes a freeze)
      cdp ??= await page.createCDPSession();
      await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 400 }); await cdp.send('Profiler.start');
    }
    else if (s.do === 'profile-stop') {
      const { profile } = await cdp.send('Profiler.stop');
      const byId = new Map(profile.nodes.map(n => [n.id, n]));
      const self = new Map();
      profile.samples.forEach((id, i) => {
        const f = byId.get(id).callFrame, dt = (profile.timeDeltas[i] ?? 0) / 1000;
        const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').slice(-2).join('/').split('?')[0]}:${f.lineNumber + 1}`;
        self.set(key, (self.get(key) ?? 0) + dt);
      });
      const top = [...self.entries()].filter(([k]) => !k.startsWith('(idle)') && !k.startsWith('(program)')).sort((a, b) => b[1] - a[1]).slice(0, s.top ?? 25).map(([k, ms]) => `${ms.toFixed(1)} ms  ${k}`);
      result.evals[s.name ?? 'profile'] = top; note = `${top.length} entries`;
    }
    else if (s.do === 'trace-start') { // browser trace: what the main thread and the GPU were busy with
      await page.tracing.start({ categories: s.categories ?? ['devtools.timeline', 'gpu', 'toplevel', 'gpu.angle', 'disabled-by-default-gpu.decoder', 'disabled-by-default-gpu.debug'] });
    }
    else if (s.do === 'trace-stop') {
      const buf = await page.tracing.stop();
      const ev = JSON.parse(Buffer.from(buf).toString('utf8')).traceEvents ?? [];
      const names = new Map(ev.filter(e => e.name === 'thread_name').map(e => [`${e.pid}:${e.tid}`, e.args.name]));
      const long = ev.filter(e => e.ph === 'X' && e.dur > (s.minMs ?? 40) * 1000).map(e => ({ ms: Math.round(e.dur / 1000), name: e.name, thread: names.get(`${e.pid}:${e.tid}`) ?? '?', extra: JSON.stringify(e.args?.data ?? e.args ?? {}).slice(0, 140) }));
      const agg = new Map();
      for (const e of long) { const k = `${e.thread} | ${e.name}`; const a = agg.get(k) ?? { n: 0, ms: 0, max: 0, ex: e.extra }; a.n++; a.ms += e.ms; a.max = Math.max(a.max, e.ms); agg.set(k, a); }
      result.evals[s.name ?? 'trace'] = [...agg.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, s.top ?? 30).map(([k, a]) => `${a.ms} ms total, ${a.n}x, max ${a.max}  ${k}  ${a.ex}`);
      note = `${long.length} long slices`;
    }
    else if (s.do === 'measure') { await startMeasure(); await sleep(s.ms ?? 2000); result.measures[s.name ?? 'measure'] = await stopMeasure(); }
    else if (s.do === 'shot') {
      const file = join(out, `${s.name ?? 'shot'}.png`);
      // Whole-page shots are saved at half size (one image pixel per CSS pixel) to keep them light; pass "full":true
      // for device pixels, or "clip":[x,y,w,h] to look at one area in full detail.
      const clip = s.clip ? { x: s.clip[0], y: s.clip[1], width: s.clip[2], height: s.clip[3], scale: s.scale ?? 1 } : { x: 0, y: 0, width: W, height: H, scale: s.full ? 1 : 0.5 };
      await page.screenshot({ path: file, clip });
      result.shots.push(file); note = file;
    }
    else note = `UNKNOWN STEP ${s.do}`;
  } catch (e) { note = 'ERROR: ' + String(e).slice(0, 300); }
  result.steps.push({ do: s.do, ms: Date.now() - t0, ...(note ? { note } : {}) });
}
result.gpu = await page.evaluate(() => { try { const c = document.createElement('canvas').getContext('webgl2'); const e = c.getExtension('WEBGL_debug_renderer_info'); return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; } catch { return 'unknown'; } });
await browser.close();
writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
