// Record one "shot" of the real MOONDA app in headless Chrome (real GPU) as a perfectly smooth 60 fps clip.
//
//   node tools/capture.mjs <shot-name> [--keep-raw] [--url http://127.0.0.1:5191/]
//   (the program is tools/shots/<shot-name>.mjs)
//
// The page's clock is frozen (tools/vt-harness.js) and moved forward exactly 1/60 s per recorded frame,
// so the clip is smooth no matter how long each frame takes to draw or capture. Tiles, workers and the
// network keep running in real time between frames, so "sharp" frames can wait until the map has loaded.
//
// A shot program exports:
//   query            optional text added to the URL
//   setup(ctx)       before recording (real time): fly somewhere, set the time, wait for tiles
//   record(ctx)      recording, using ctx.frames / glide / drag / wheel / clickText / key / hold
//   timers           true = setTimeout/setInterval also follow the virtual clock

import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const VALUE = ['--url', '--w', '--h', '--dsf'];
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const shot = args.find((a, i) => !a.startsWith('--') && !VALUE.includes(args[i - 1]));
if (!shot) { console.error('usage: node tools/capture.mjs <shot>'); process.exit(2); }
const URL0 = flag('--url', 'http://127.0.0.1:5191/');
const prog = await import(join(ROOT, 'tools/shots', `${shot}.mjs`));
const W = +flag('--w', prog.W ?? 1440), H = +flag('--h', prog.H ?? 810), DSF = +flag('--dsf', prog.DSF ?? 2);
// heavy files live on the internal disk (the project drive is nearly full)
const WORK = process.env.DEMO_WORK ?? '/private/tmp/claude-501/-Users-zhihaowu--claude-spares-spare-DGEDYS/5a04221c-0252-414b-ade3-5c32ce93609c/scratchpad/work';
const DT = 1000 / 60;
const rawDir = join(WORK, 'raw', shot);
rmSync(rawDir, { recursive: true, force: true });
mkdirSync(rawDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: join(WORK, 'chrome-profile'),
  defaultViewport: { width: W, height: H, deviceScaleFactor: DSF },
  protocolTimeout: 600000,
  args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run', '--hide-scrollbars', `--window-size=${W},${H}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required'],
});
const page = (await browser.pages())[0] ?? await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
await page.evaluateOnNewDocument(readFileSync(join(ROOT, 'tools/vt-harness.js'), 'utf8'));
const cdp = await page.createCDPSession();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ready = async (timeout = 60000) => {
  const t0 = Date.now(); let ok = 0;
  while (Date.now() - t0 < timeout) {
    const done = await page.evaluate(() => { const api = window.__moonda; return !!(api && api.idle && api.idle()); }).catch(() => false);
    ok = done ? ok + 1 : 0;
    if (ok >= 4) return true;
    await sleep(250);
  }
  console.warn('  (ready timed out)');
  return false;
};

// ---------- frames
let frozen = false, nFrames = 0, sharpMs = 0;
let sharp = prog.sharp ?? 0;            // >0: before each frame, wait up to this many real ms for the map tiles on screen
const render = () => page.evaluate(() => { const v = window.__viewer; if (v && !v.isDestroyed()) { v.scene.requestRender(); v.render(); return v.scene.globe.tilesLoaded; } return true; });
const waitSharp = async max => {
  const t0 = Date.now();
  while (Date.now() - t0 < max) {
    const ok = await render().catch(() => true);
    if (ok) break;
    await sleep(25);
  }
  sharpMs += Date.now() - t0;
};
const frame = async () => {
  await page.evaluate(dt => window.__vt.step(dt), DT);
  if (sharp > 0) await waitSharp(sharp);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 94, optimizeForSpeed: true });
  writeFileSync(join(rawDir, `${String(nFrames).padStart(6, '0')}.jpg`), Buffer.from(data, 'base64'));
  nFrames++;
  if (nFrames % 120 === 0) process.stdout.write(`  ${nFrames} frames (${(nFrames / 60).toFixed(1)} s)\n`);
};
// run fn(p, i) before each of n frames (p goes 0..1)
const frames = async (sec, fn) => {
  const n = Math.max(1, Math.round(sec * 60));
  for (let i = 0; i < n; i++) { if (fn) await fn(n === 1 ? 1 : i / (n - 1), i); await frame(); }
};
const hold = sec => frames(sec);

// ---------- mouse (moves happen between frames, so drags are perfectly smooth)
let mx = W * 0.62, my = H * 0.55;
const ease3 = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const ease2 = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
const glide = async (x, y, sec = 0.6) => {
  const x0 = mx, y0 = my, arc = Math.min(50, Math.hypot(x - x0, y - y0) * 0.1);
  await frames(sec, async p => { const t = ease3(p), s = Math.sin(Math.PI * p); await page.mouse.move(x0 + (x - x0) * t - arc * s * 0.3, y0 + (y - y0) * t - arc * s); });
  mx = x; my = y;
};
const click = async (x, y, opts = {}) => {
  if (x !== undefined) await glide(x, y, opts.sec ?? 0.6);
  await frames(opts.pause ?? 0.12);
  await page.mouse.down(); await frames(0.07); await page.mouse.up();
};
const dblclick = async (x, y, opts = {}) => {
  await glide(x, y, opts.sec ?? 0.6);
  await frames(0.1);
  await page.mouse.down({ clickCount: 1 }); await frame(); await page.mouse.up({ clickCount: 1 });
  await frames(0.08);
  await page.mouse.down({ clickCount: 2 }); await frame(); await page.mouse.up({ clickCount: 2 });
};
const drag = async (from, to, sec = 1, opts = {}) => {
  if (from) await glide(from[0], from[1], opts.approach ?? 0.45);
  const [x0, y0] = [mx, my];
  if (opts.keys) for (const k of opts.keys) await page.keyboard.down(k);
  await page.mouse.down({ button: opts.button ?? 'left' });
  await frames(0.06);
  const e = opts.ease ?? ease2;
  await frames(sec, async p => { const t = e(p); await page.mouse.move(x0 + (to[0] - x0) * t, y0 + (to[1] - y0) * t); });
  if (opts.hold) await frames(opts.hold);
  await page.mouse.up({ button: opts.button ?? 'left' });
  if (opts.keys) for (const k of opts.keys) await page.keyboard.up(k);
  mx = to[0]; my = to[1];
};
const wheel = async (x, y, deltaY, times, every = 2) => {
  if (x !== undefined) await glide(x, y, 0.4);
  for (let i = 0; i < times; i++) { await page.mouse.wheel({ deltaY }); await frames(every / 60); }
};
const clickText = async (text, opts = {}) => {
  const pos = await page.evaluate(text => {
    const els = [...document.querySelectorAll('button, a, [role=button], [role=tab], [role=radio], [role=option], summary, label')];
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const el = els.find(e => vis(e) && (e.innerText || e.getAttribute('aria-label') || '').trim().toLowerCase() === text.toLowerCase())
      ?? els.find(e => vis(e) && ((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '')).toLowerCase().includes(text.toLowerCase()));
    if (!el) return null; const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];
  }, text);
  if (!pos) { console.warn(`  click: "${text}" not found`); return null; }
  await click(pos[0], pos[1], opts);
  return pos;
};
const setupClick = async (text) => {
  const pos = await page.evaluate(text => {
    const els = [...document.querySelectorAll('button, a, [role=button], [role=tab], [role=radio], [role=option], summary, label')];
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const el = els.find(e => vis(e) && (e.innerText || e.getAttribute('aria-label') || '').trim().toLowerCase() === text.toLowerCase())
      ?? els.find(e => vis(e) && ((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '')).toLowerCase().includes(text.toLowerCase()));
    if (!el) return null; const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];
  }, text);
  if (!pos) { console.warn(`  setupClick: "${text}" not found`); return null; }
  await page.mouse.click(pos[0], pos[1]); mx = pos[0]; my = pos[1];
  return pos;
};
const typeText = async (text, perChar = 3) => { for (const ch of text) { await page.keyboard.type(ch); await frames(perChar / 60); } };
const key = async (k, sec = 0.05) => { await page.keyboard.press(k); await frames(sec); };
const js = (fn, ...a) => page.evaluate(fn, ...a);
// wait in real time while the picture stays frozen (lets tiles, workers or the network catch up)
const settle = async (ms, alsoReady = false) => { const t0 = Date.now(); if (alsoReady) await waitSharp(ms); const left = ms - (Date.now() - t0); if (left > 0 && !alsoReady) await sleep(left); };

const CURSOR = () => {
  if (document.getElementById('__demo_cursor')) return;
  const c = document.createElement('div');
  c.id = '__demo_cursor';
  c.style.cssText = 'position:fixed;left:0;top:0;width:28px;height:28px;pointer-events:none;z-index:2147483647;transform:translate(-100px,-100px);filter:drop-shadow(0 1px 2px rgba(0,0,0,.55))';
  const arrow = '<svg width="26" height="26" viewBox="0 0 28 28"><path d="M5 3 L5 22 L10 17.5 L13.4 25 L16.6 23.6 L13.3 16.3 L20 16.3 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const hand = '<svg width="30" height="30" viewBox="0 0 28 28" style="margin:-9px 0 0 -9px"><path d="M8.5 12.2c0-1.3 1.9-1.6 2.4-.3V10c0-1.4 2.1-1.5 2.3-.1v-.6c.1-1.4 2.2-1.4 2.3 0v.8c.2-1.3 2.2-1.2 2.3.2v6.2c0 3.7-2.2 6.2-5.3 6.2-2.4 0-3.6-1.1-5-3.4l-2-3.3c-.7-1.2.9-2.3 1.9-1.2l1.1 1.2z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  c.innerHTML = arrow;
  document.documentElement.appendChild(c);
  addEventListener('mousemove', e => { c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
  addEventListener('pointermove', e => { c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
  addEventListener('mousedown', () => { c.innerHTML = hand; }, true);
  addEventListener('mouseup', () => { c.innerHTML = arrow; }, true);
  window.__demoCursor = { hide(v) { c.style.opacity = v ? '0' : '1'; } };
};

console.log(`[${shot}] opening ${URL0}${prog.query ?? ''}`);
await page.goto(URL0 + (prog.query ?? ''), { waitUntil: 'domcontentloaded', timeout: 180000 });
await ready(120000);
// every take starts in English (the Khmer take saves its language in the shared browser profile)
if (!prog.keepLang) {
  const lang = await page.evaluate(() => document.querySelector('button.tb.lang')?.textContent.trim());
  if (lang === 'English') { await page.click('button.tb.lang'); await sleep(1200); console.log('  switched the app back to English'); }
}
await page.evaluate(CURSOR);
await page.mouse.move(mx, my);
await page.evaluate(() => document.querySelectorAll('audio').forEach(a => { a.muted = true; }));

const ctx = {
  page, cdp, sleep, ready, js, settle, render, waitSharp, W, H,
  frame, frames, hold, glide, setupClick, click, dblclick, drag, wheel, clickText, typeText, key,
  setSharp(ms) { sharp = ms; },
  get mouse() { return [mx, my]; }, setMouse(x, y) { mx = x; my = y; },
  freeze: async () => { if (!frozen) { await page.evaluate(t => window.__vt.freeze({ timers: t }), !!prog.timers); frozen = true; } },
};
if (prog.setup) { console.log(`[${shot}] setup`); await prog.setup(ctx); }
await ctx.freeze();
const tRec = Date.now();
console.log(`[${shot}] recording`);
await prog.record(ctx);
const secs = (Date.now() - tRec) / 1000;
await browser.close();

const outFile = join(WORK, 'footage', `${shot}.mp4`);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '60', '-i', join(rawDir, '%06d.jpg'),
  '-vf', `scale=${prog.outW ?? 2560}:${prog.outH ?? 1440}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '15', '-g', '1', '-movflags', '+faststart', outFile]);
console.log(`[${shot}] ${nFrames} frames = ${(nFrames / 60).toFixed(2)} s of video, took ${secs.toFixed(0)} s (${(nFrames / secs).toFixed(1)} frames/s; waited ${(sharpMs / 1000).toFixed(0)} s for tiles); errors ${errors.length}`);
if (errors.length) console.log('  ' + errors.slice(0, 5).join('\n  '));
writeFileSync(join(WORK, 'footage', `${shot}.json`), JSON.stringify({ frames: nFrames, seconds: nFrames / 60, recordSecs: secs, errors }, null, 1));
if (!args.includes('--keep-raw')) rmSync(rawDir, { recursive: true, force: true });
