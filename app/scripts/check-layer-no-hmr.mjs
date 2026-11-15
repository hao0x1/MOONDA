// Freeze Vite hot updates while drive.mjs measures the renderer loaded at navigation.
// Optional captured modules also preserve a before run after the team resumes source edits.
import puppeteer from 'puppeteer-core';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
// Serialized TSX callbacks can also run in the generated Node harness.
globalThis.__name ??= fn => fn;
const modules = process.env.MOONDA_LAYER_MODULES ? resolve(process.env.MOONDA_LAYER_MODULES) : null;
const captured = new Map();
const capturedDefaultExports = new Set();
const snapshotQuery = '?__layer_speed_snapshot=1';
const paths = {
  '/src/moon/imagery.ts': 'imagery.js',
  '/src/moon/imageryWorker.ts': 'imageryWorker.js',
  '/src/moon/preload.ts': 'preload.js',
  '/src/moon/MoonMap.tsx': 'MoonMap.js',
  '/src/moon/flatMap.ts': 'flatMap.js',
  '/src/explore/mapImagery.ts': 'mapImagery.js',
};
let workerSource = null;
if (modules) {
  for (const [url, name] of Object.entries(paths)) {
    const file = join(modules, name);
    if (!existsSync(file)) throw new Error(`Captured layer module missing: ${file}`);
    const source = readFileSync(file, 'utf8');
    captured.set(url, source);
    const namedLists = [...source.matchAll(/^\s*export\s*\{([^}]*)\}/gm)];
    if (/^\s*export\s+default\b/m.test(source) || namedLists.some(list => list[1].split(',').some(item => /^(?:[\w$]+\s+as\s+)?default$/.test(item.trim())))) capturedDefaultExports.add(url);
  }
  const workerFile = ['imageryWorker.worker.js', 'imageryWorker_worker.js'].map(name => join(modules, name)).find(existsSync);
  if (!workerFile) throw new Error(`Captured imagery worker entry missing in ${modules}`);
  workerSource = readFileSync(workerFile, 'utf8');
}
const launch = puppeteer.launch;
puppeteer.launch = async function (...args) {
  const browser = await launch.apply(this, args);
  for (const page of await browser.pages()) {
    await page.evaluateOnNewDocument(({ workerSource, moduleNames, singletonCanonicalized }) => {
      // TSX can preserve a function-name helper in serialized browser callbacks. Its only
      // runtime effect is the name; returning the function keeps those test callbacks executable.
      if (typeof window.__name !== 'function') { window.__name = fn => fn; window.__layerSpeedTsxNameShim = true; }
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url, protocols) {
          super(url, protocols);
          const vite = protocols === 'vite-hmr' || Array.isArray(protocols) && protocols.includes('vite-hmr');
          if (vite) this.addEventListener('message', event => {
            try {
              if (['update', 'full-reload', 'prune'].includes(JSON.parse(event.data).type)) event.stopImmediatePropagation();
            } catch { /* Ordinary connection and heartbeat messages pass through. */ }
          }, { capture: true });
        }
      };
      if (workerSource) {
        const NativeWorker = window.Worker;
        // Chrome owns worker network targets separately. A same-origin blob ensures that
        // worker source is captured too, even when page request interception misses its entry.
        window.Worker = class extends NativeWorker {
          constructor(script, options) {
            const target = new URL(String(script), location.href);
            let frozen = null;
            if (target.origin === location.origin && target.pathname === '/src/moon/imageryWorker.ts' && target.searchParams.has('worker_file')) {
              const source = workerSource.replace(/(\bimport\s*["'])(\/[^"']+)(["'])/g, (_, before, path, after) => before + location.origin + path + after);
              frozen = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
            }
            super(frozen ?? script, options);
            this.__layerSpeedBlob = frozen;
          }
          terminate() { super.terminate(); if (this.__layerSpeedBlob) URL.revokeObjectURL(this.__layerSpeedBlob); }
        };
      }
      window.__layerSpeedFrozenHmr = true;
      window.__layerSpeedFrozenModules = moduleNames;
      window.__layerSpeedSingletonCanonicalized = singletonCanonicalized;
    }, { workerSource, moduleNames: [...captured.keys()], singletonCanonicalized: !!modules });
    if (modules) {
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = new URL(request.url());
        let body;
        if (url.pathname === '/src/moon/imageryWorker.ts' && url.searchParams.has('worker_file')) body = workerSource;
        else if (url.pathname === '/src/moon/imageryWorker.ts' && url.searchParams.has('worker') && url.searchParams.has('url')) body = 'export default "/src/moon/imageryWorker.ts?worker_file&type=module";';
        else if (captured.has(url.pathname)) {
          // Vite timestamps are distinct ESM identities. Re-export every alias from one body
          // so live and captured importers share the same worker pool and cache instances.
          if (url.search === snapshotQuery && !url.hash) body = captured.get(url.pathname);
          else {
            const canonical = JSON.stringify(url.pathname + snapshotQuery);
            body = `export * from ${canonical};`;
            if (capturedDefaultExports.has(url.pathname)) body += `export { default } from ${canonical};`;
          }
        }
        if (body !== undefined) void request.respond({ status: 200, contentType: 'text/javascript', body });
        else void request.continue();
      });
    }
  }
  return browser;
};
