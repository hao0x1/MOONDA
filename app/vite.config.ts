import react from '@vitejs/plugin-react';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';
// @ts-expect-error plain JS module shared with the Netlify Function
import { proxyChat, readNodeBody } from './server/aiProxy.mjs';

/** POST /api/ai on the local dev (5190) and preview (5191) servers: same proxy as the Netlify Function online.
 *  The key is read from app/.env.local (DEEPSEEK_API_KEY=...), never shipped to the browser. */
function aiRoute(env: Record<string, string>): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url !== '/api/ai') return next();
    if (req.method !== 'POST') { res.statusCode = 405; res.end('Use POST'); return; }
    void (async () => {
      try {
        const body = JSON.parse(await readNodeBody(req));
        const r: Response = await proxyChat(body, { key: env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_MODEL || process.env.DEEPSEEK_MODEL, baseUrl: env.DEEPSEEK_BASE_URL || process.env.DEEPSEEK_BASE_URL });
        res.statusCode = r.status;
        r.headers.forEach((v, k) => res.setHeader(k, v));
        if (!r.body) { res.end(); return; }
        // never let a broken stream crash the dev server; stop reading when the page goes away
        const stream = Readable.fromWeb(r.body as unknown as WebReadableStream);
        stream.on('error', err => { console.error('[ai proxy] stream:', err.message); res.end(); });
        res.on('close', () => stream.destroy());
        stream.pipe(res);
      } catch (err) {
        console.error('[ai proxy]', err);
        if (res.headersSent) { res.end(); return; }
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'service' }));
      }
    })();
  };
  return {
    name: 'moonda-ai-route',
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

// CesiumJS's Workers / Assets / Widgets are copied into public/cesium by scripts/copy-cesium.mjs.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'DEEPSEEK_');
  return {
    base: './',
    // Parallel working copies (.v4/*) share node_modules through a symlink: give each its own cache.
    cacheDir: process.env.MOONDA_VITE_CACHE ?? 'node_modules/.vite',
    plugins: [react(), aiRoute(env)],
    server: { host: '127.0.0.1', port: 5190, fs: { allow: ['/Volumes/CodexWork/Projects/MOONDA'] } },
    preview: { host: '127.0.0.1', port: 5191 },
    worker: { format: 'es' },
    build: { chunkSizeWarningLimit: 6000 },
  };
});
