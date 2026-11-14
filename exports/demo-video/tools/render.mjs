// Render the GSAP film frame by frame in headless Chrome and pipe the frames into ffmpeg.
//
//   node tools/render.mjs --stills 3,12.5,40          PNG stills into <work>/stills/
//   node tools/render.mjs --from 0 --to 20 --out a.mp4  (default: whole film → <work>/film-video.mp4)
//   --fps 60  --scale 1 (1 = 1920x1080, 2 = 3840x2160)  --crf 16
import { createServer } from 'node:http';
import { createReadStream, statSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = process.env.DEMO_WORK ?? '/private/tmp/claude-501/-Users-zhihaowu--claude-spares-spare-DGEDYS/5a04221c-0252-414b-ade3-5c32ce93609c/scratchpad/work';
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const FPS = +flag('--fps', 60), SCALE = +flag('--scale', 1);

// ---- tiny static server with Range support (videos need it for seeking)
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer((req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = realpathSync(join(ROOT, p));
    const st = statSync(file); const type = TYPES[extname(file)] ?? 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const [a, b] = range.replace('bytes=', '').split('-'); const start = +a, end = b ? +b : st.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      createReadStream(file, { start, end }).pipe(res);
    } else { res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' }); createReadStream(file).pipe(res); }
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: SCALE }, protocolTimeout: 600000,
  args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run', '--hide-scrollbars', '--window-size=1920,1080',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text().slice(0, 300)); });
await page.goto(`http://127.0.0.1:${PORT}/film/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => document.body.dataset.ready === '1', { timeout: 120000 });
const duration = await page.evaluate(() => window.__film.duration);
console.log(`film duration ${duration.toFixed(2)} s; errors so far: ${errs.length}`);
if (errs.length) console.log(errs.slice(0, 8).join('\n'));
const cdp = await page.createCDPSession();
const grab = async (fmt = 'jpeg') => Buffer.from((await cdp.send('Page.captureScreenshot', { format: fmt, quality: fmt === 'jpeg' ? 95 : undefined, optimizeForSpeed: fmt === 'jpeg' })).data, 'base64');

if (flag('--cues', null)) {
  const { writeFileSync } = await import('node:fs');
  const cues = await page.evaluate(() => window.__film.cues);
  writeFileSync(flag('--cues'), JSON.stringify(cues.sort((a, b) => a.t - b.t), null, 0));
  console.log(`wrote ${cues.length} cues; film ${duration.toFixed(2)} s`);
  await browser.close(); server.close(); process.exit(0);
}
const stills = flag('--stills', null);
if (stills) {
  const dir = join(WORK, 'stills'); mkdirSync(dir, { recursive: true });
  for (const t of stills.split(',').map(Number)) {
    await page.evaluate(t => window.__film.seek(t), t);
    const { writeFileSync } = await import('node:fs');
    const f = join(dir, `t${t.toFixed(2).padStart(7, '0')}.png`);
    writeFileSync(f, await grab('png'));
    console.log(f);
  }
} else {
  const from = +flag('--from', 0), to = Math.min(+flag('--to', duration), duration);
  const out = flag('--out', join(WORK, 'film-video.mp4'));
  const n0 = Math.round(from * FPS), n1 = Math.round(to * FPS);
  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-vf', SCALE === 1 ? 'format=yuv420p' : 'scale=3840:2160:flags=lanczos,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', flag('--crf', '15'), '-tune', 'film', '-profile:v', 'high', '-movflags', '+faststart', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now();
  for (let i = n0; i < n1; i++) {
    await page.evaluate(t => window.__film.seek(t), i / FPS);
    const buf = await grab();
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if ((i - n0) % 300 === 0) { const el = (Date.now() - t0) / 1000; console.log(`  frame ${i - n0}/${n1 - n0}  (${(i / FPS).toFixed(1)} s)  ${((i - n0) / Math.max(el, 0.01)).toFixed(1)} fps`); }
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  console.log(`wrote ${out} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
if (errs.length) console.log('page errors/warnings:\n' + [...new Set(errs)].slice(0, 12).join('\n'));
await browser.close();
server.close();
