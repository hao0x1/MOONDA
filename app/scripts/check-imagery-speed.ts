// Time-to-sharp for the map pictures, measured in real Chrome on the real GPU.
// "Sharp" = Cesium has nothing left to load for what is on screen (globe.tilesLoaded) and the
// imagery workers are idle. Measured from the moment the camera is put at a view.
//
//   node scripts/check-imagery-speed.ts --url http://127.0.0.1:5203/ [--label after] [--runs 2]
//        [--out <dir>]        also saves <label>-<view>.png (half size) and <label>.json there
//        [--block-remote]     pretend trek.nasa.gov and *.im-ldi.com are unreachable (works with no internet?)
//        [--profile <dir>]    keep Chrome's cache between runs (default: a fresh, empty browser every run = cold cache)
//        [--timeout 90000]    give up waiting for a view after this many ms (reported as "never")
//        [--seams]            also visit the places where NASA's WAC mosaic flips its lighting (v5 seam fix)
//        [--extra]            also visit views that need more than the app stores (Moon Trek detail at Tycho, the
//                             deepest NAC squares, a view just above the ground) and one where the photos end
//                             (outside 84 deg S): shows that loading always ends, with and without --block-remote
//
// Views: the opening view (from page load, with the start-up loader running), then, with the
// loader's warm-up visits skipped so every arrival is a first arrival: the "South Pole" button
// view, and straight down on the Shackleton - de Gerlache ridge from 100 km and from 10 km.
// Prints one line per view and exits 1 if a view never finished loading.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (name: string, dflt: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const url = flag('--url', 'http://127.0.0.1:5203/'), label = flag('--label', 'run'), runs = +flag('--runs', '1'), timeout = +flag('--timeout', '90000');
const out = args.includes('--out') ? resolve(flag('--out', '.')) : null;
const blockRemote = args.includes('--block-remote');
if (out) mkdirSync(out, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1440, H = 900;
const VIEWS = [
  { name: 'south-pole', title: 'South Pole button (820 km up)', lat: -90, lon: 0, altM: 820_000, onGround: false },
  { name: 'ridge-100km', title: 'Shackleton-de Gerlache ridge, 100 km up', lat: -89.45, lon: -136.7, altM: 100_000, onGround: true },
  { name: 'ridge-10km', title: 'Shackleton-de Gerlache ridge, 10 km up', lat: -89.45, lon: -136.7, altM: 10_000, onGround: true },
];

const EXTRA = [
  { name: 'tycho-200km', title: 'Tycho, 200 km up (Moon Trek detail)', lat: -43.3, lon: -11.2, altM: 200_000, onGround: true },
  { name: 'wac-ring-20km', title: '82 S 40 E, 20 km up (photos end at 74 m/px)', lat: -82, lon: 40, altM: 20_000, onGround: true },
  { name: 'ridge-1500m', title: 'Ridge, 1.5 km up (deepest NAC squares)', lat: -89.45, lon: -136.7, altM: 1_500, onGround: true },
  { name: 'ridge-150m', title: 'Ridge, 150 m above the ground', lat: -89.45, lon: -136.7, altM: 150, onGround: true },
];

// --seams: the places where NASA's WAC mosaic flips its lighting (v5 seam fix: hillshade tiles from Moon Trek there)
const SEAMS = [
  { name: 'larmor-300km', title: 'Larmor on the 180 deg line, 300 km up', lat: 31.85, lon: -179.67, altM: 300_000, onGround: true },
  { name: 'orientale-90w-300km', title: 'Orientale on the 90 W line, 300 km up', lat: -15, lon: -90, altM: 300_000, onGround: true },
  { name: 'orientale-90w-50km', title: 'Orientale on the 90 W line, 50 km up', lat: -15, lon: -90, altM: 50_000, onGround: true },
  { name: 'smythii-90e-300km', title: 'Smythii on the 90 E line, 300 km up', lat: -2, lon: 90, altM: 300_000, onGround: true },
];

interface Stats { asked: number; remote?: number; files?: number; failed?: number; parents?: number; deepest?: Record<string, number> }
interface ViewResult { ms: number; frames: number; stats: Stats | null }
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>['newPage']>>;

/** Runs in the page before the app starts: note when the start-up loader reaches each step, and skip its warm-up visits. */
function installMarks() {
  const w = window as unknown as { __speed: Record<string, number>; __moonda?: { progress?: { pct: number; done: boolean }; skipLoading?: () => void } };
  w.__speed = {};
  const tick = () => {
    const p = w.__moonda?.progress, s = w.__speed, now = performance.now();
    if (p) {
      if (p.pct >= 36 && s.photoStep === undefined) s.photoStep = now;
      if ((p.pct > 36 || p.done) && s.startLoaded === undefined) { s.startLoaded = now; w.__moonda?.skipLoading?.(); }
      if (p.done && s.done === undefined) s.done = now;
    }
    if (s.done === undefined) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Runs in the page: put the camera straight above a place and wait until nothing is left to load. */
async function arrive(v: { lat: number; lon: number; altM: number; onGround: boolean }, maxMs: number): Promise<ViewResult> {
  const w = window as unknown as {
    __viewer: { camera: { setView(o: unknown): void }; scene: { requestRender(): void; globe: { tilesLoaded: boolean } } };
    __moonda: { heights?: { heightAt(lat: number, lon: number, detail: boolean): number } };
    __moondaImagery?: { pending(): number; stats(): Stats | null };
  };
  const R = 1737400, la = (v.lat * Math.PI) / 180, lo = (v.lon * Math.PI) / 180;
  const up = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]; // TRUE frame
  const north = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
  const display = (t: number[], k = 1) => ({ x: t[0] * k, y: -t[2] * k, z: t[1] * k }); // frame.ts: display = (x, -z, y)
  const r = R + (v.onGround ? w.__moonda.heights?.heightAt(v.lat, v.lon, false) ?? 0 : 0) + v.altM;
  const t0 = performance.now();
  w.__viewer.camera.setView({ destination: display(up, r), orientation: { direction: display(up, -1), up: display(north) } });
  let quiet = 0, first = -1, frames = 0;
  while (performance.now() - t0 < maxMs) {
    w.__viewer.scene.requestRender();
    await new Promise<void>(res => requestAnimationFrame(() => res()));
    frames++;
    const done = frames > 2 && w.__viewer.scene.globe.tilesLoaded && (w.__moondaImagery ? w.__moondaImagery.pending() === 0 : true);
    if (done && quiet === 0) first = performance.now() - t0;
    quiet = done ? quiet + 1 : 0;
    if (quiet >= 8) return { ms: Math.round(first), frames, stats: w.__moondaImagery?.stats() ?? null };
  }
  return { ms: -1, frames, stats: w.__moondaImagery?.stats() ?? null };
}

const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
const all: Record<string, unknown>[] = [];
let never = 0;

for (let run = 1; run <= runs; run++) {
  const temp = args.includes('--profile') ? null : mkdtempSync(join(tmpdir(), 'moonda-speed-'));
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, userDataDir: temp ?? resolve(flag('--profile', '')),
    defaultViewport: { width: W, height: H, deviceScaleFactor: 2 },
    args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run', '--hide-scrollbars', `--window-size=${W},${H}`,
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  const page: Page = (await browser.pages())[0] ?? await browser.newPage();
  const errors: string[] = [];
  let remoteRequests = 0, remoteFailed = 0;
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => errors.push(`PAGE ERROR: ${String(e).slice(0, 200)}`));
  if (blockRemote) await page.setRequestInterception(true); // every request to NASA's servers fails at once, like a dead connection
  page.on('request', r => {
    const remote = /trek\.nasa\.gov|im-ldi\.com/.test(r.url());
    if (remote) remoteRequests++;
    if (blockRemote) void (remote ? r.abort('connectionrefused') : r.continue());
  });
  page.on('requestfailed', r => { if (/trek\.nasa\.gov|im-ldi\.com/.test(r.url())) remoteFailed++; });
  await page.evaluateOnNewDocument(installMarks);
  await page.goto(url, { waitUntil: 'load' });
  const shot = async (name: string) => { if (out) await page.screenshot({ path: join(out, `${label}-${name}.png`), clip: { x: 0, y: 0, width: W, height: H, scale: 0.5 } }); };

  // 1. The opening view: page load -> the loader's "photo" step is over (the whole Moon is drawn sharp).
  const t0 = Date.now();
  let marks: Record<string, number> = {};
  while (Date.now() - t0 < timeout) {
    marks = await page.evaluate(() => (window as unknown as { __speed: Record<string, number> }).__speed).catch(() => ({}));
    if (marks.done !== undefined) break;
    await sleep(100);
  }
  const startStats = await page.evaluate(() => (window as unknown as { __moondaImagery?: { stats(): unknown } }).__moondaImagery?.stats() ?? null) as Stats | null;
  const row = (name: string, ms: number, s: Stats | null, remote: number) =>
    console.log(`${label} run ${run}  ${name.padEnd(42)} ${ms < 0 ? '   never' : String(ms).padStart(6) + ' ms'}   remote requests ${String(remote).padStart(4)}${s?.files !== undefined ? `   stored files ${s.files}, failed ${s.failed}, kept parent ${s.parents}, deepest ${JSON.stringify(s.deepest)}` : ''}`);
  const startMs = marks.startLoaded === undefined ? -1 : Math.round(marks.startLoaded);
  if (startMs < 0) never++;
  row('opening view (from page load)', startMs, startStats, remoteRequests);
  // close the welcome dialog so screenshots show the map
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(e => /explore the whole moon/i.test(e.textContent ?? '')); b?.click(); });
  await sleep(300);
  await shot('start');
  const result: Record<string, unknown> = { label, run, blockRemote, start: { ms: startMs, photoStepAt: Math.round(marks.photoStep ?? -1), remoteRequests, stats: startStats } };

  // 2. First arrivals at the south-pole views.
  for (const v of [...VIEWS, ...(args.includes('--extra') ? EXTRA : []), ...(args.includes('--seams') ? SEAMS : [])]) {
    const before = remoteRequests;
    const r = await page.evaluate(arrive, v, timeout);
    if (r.ms < 0) never++;
    row(v.title, r.ms, r.stats, remoteRequests - before);
    await sleep(250);
    await shot(v.name);
    result[v.name] = { ...r, remoteRequests: remoteRequests - before };
  }
  result.remoteFailed = remoteFailed;
  result.errors = errors;
  if (errors.length) console.log(`  console errors: ${errors.length}  first: ${errors[0]}`);
  all.push(result);
  await browser.close();
  if (temp) rmSync(temp, { recursive: true, force: true });
}
if (out) writeFileSync(join(out, `${label}.json`), JSON.stringify(all, null, 1));
process.exit(never ? 1 : 0);
