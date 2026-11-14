// node scripts/montage-far.mjs out.png w img1 img2 ... : the images stacked 2 per row at width w (for before/after sheets)
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
const [out, w, ...imgs] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const p = await b.newPage();
await p.setViewport({ width: +w, height: 400 });
const src = imgs.map(f => `<figure><img src="data:image/png;base64,${readFileSync(f).toString('base64')}"><figcaption>${f.split('/').pop()}</figcaption></figure>`).join('');
await p.setContent(`<style>body{margin:0;background:#222;display:grid;grid-template-columns:1fr 1fr;gap:2px;font:11px sans-serif;color:#ccc}figure{margin:0}img{width:100%;display:block}</style>${src}`);
await p.screenshot({ path: out, fullPage: true });
await b.close();
