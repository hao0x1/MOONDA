// Record every file the start screen downloads on a first visit (clean browser), including the
// downloads made by the app's background workers, and print them grouped by host with sizes.
// Also writes the same-site paths to <out>/paths.txt, which scripts/warm-cache.sh can pre-load
// into the CDN cache so the first visitor anywhere is served from a nearby copy.
//
//   node scripts/startup-files.mjs --url https://moonda.us/ [--out /tmp/startup] [--max 170]
//
// --max: seconds to wait for the start screen to finish ("Getting ready…" gone) before stopping.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { acquireBrowserLease } from './browserLease.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const url = flag('--url', 'https://moonda.us/');
const out = flag('--out', '/tmp/moonda-startup-files');
const maxS = Number(flag('--max', '170'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
mkdirSync(out, { recursive: true });

const files = new Map(); // requestId@session -> { url, bytes, status, fromCache }
const track = (session, tag) => {
  session.on('Network.responseReceived', e => {
    const k = `${tag}:${e.requestId}`;
    files.set(k, { ...(files.get(k) ?? {}), url: e.response.url, status: e.response.status, cf: e.response.headers['cf-cache-status'] ?? e.response.headers['CF-Cache-Status'] });
  });
  session.on('Network.loadingFinished', e => {
    const k = `${tag}:${e.requestId}`;
    files.set(k, { ...(files.get(k) ?? {}), bytes: e.encodedDataLength });
  });
  return session.send('Network.enable').catch(() => {});
};

const lease = await acquireBrowserLease({ script: 'startup-files.mjs', noteDir: out });
let browser;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1440,900'], defaultViewport: { width: 1440, height: 900 } });
  await lease.afterLaunch(browser);
  let n = 0;
  browser.on('targetcreated', async target => {
    if (!['worker', 'shared_worker', 'service_worker'].includes(target.type())) return;
    try { const s = await target.createCDPSession(); await track(s, `w${n++}`); await s.send('Runtime.runIfWaitingForDebugger').catch(() => {}); } catch {}
  });
  const page = await browser.newPage();
  const ps = await page.createCDPSession();
  await track(ps, 'page');
  await ps.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
  ps.connection()?.on?.('sessionattached', s => { if (s) track(s, `a${n++}`); });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
  let seen = false, readyAt = null, progress = '';
  while ((Date.now() - t0) / 1000 < maxS) {
    const txt = await page.evaluate(() => document.body.innerText).catch(() => '');
    progress = (txt.match(/Getting ready[^\n]*/) ?? [''])[0];
    if (progress) seen = true; else if (seen && /Enter/.test(txt)) { readyAt = (Date.now() - t0) / 1000; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  const rows = await page.evaluate(() => { const r = document.body.innerText.split('\n').map(x => x.trim()).filter(Boolean); const i = r.indexOf('App'); return r.slice(i, i + 18).join(' | '); }).catch(() => '');
  const list = [...files.values()].filter(f => f.url && !f.url.startsWith('data:') && !f.url.startsWith('blob:'));
  const byHost = {};
  for (const f of list) { const h = new URL(f.url).host; (byHost[h] ??= { files: 0, MB: 0 }); byHost[h].files++; byHost[h].MB += (f.bytes ?? 0) / 1e6; }
  for (const h in byHost) byHost[h].MB = Math.round(byHost[h].MB * 10) / 10;
  const site = new URL(url).host;
  const paths = [...new Set(list.filter(f => new URL(f.url).host === site && f.status === 200).map(f => new URL(f.url).pathname))].filter(p => !p.startsWith('/api/'));
  writeFileSync(join(out, 'paths.txt'), paths.join('\n') + '\n');
  writeFileSync(join(out, 'files.json'), JSON.stringify(list, null, 1));
  const cf = {}; for (const f of list) if (f.cf) cf[f.cf] = (cf[f.cf] ?? 0) + 1;
  console.log(JSON.stringify({ url, readyAt, stoppedAt: readyAt ? null : maxS, progress, rows, byHost, cloudflare: cf, sitePaths: paths.length, out }, null, 1));
} finally {
  await browser?.close().catch(() => {});
  await lease.release?.();
}
