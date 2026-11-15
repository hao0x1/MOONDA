// Loaded with --import by check-phone-graphics.mjs before the shared driver starts Chrome.
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const out = process.env.MOONDA_PHONE_OUT;
if (!out) throw new Error('Run check-phone-graphics.mjs, not the profile module directly.');
const desktop = process.env.MOONDA_PHONE_DESKTOP === '1';
const launch = puppeteer.launch.bind(puppeteer);
puppeteer.launch = async options => {
  const browser = await launch({ ...options, args: [...options.args, `--disk-cache-dir=${join(out, 'browser-cache')}`, '--disk-cache-size=33554432'] });
  const pages = await browser.pages();
  for (const page of pages) {
    if (!desktop) {
      await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await page.setUserAgent('Mozilla/5.0 (Linux; Android 13; Phone Graphics Check) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36');
    }
    await page.evaluateOnNewDocument(installProfile, desktop);
  }
  // Keep a lease short even when a remote source or a calculator fails to settle.
  const deadline = setTimeout(() => process.kill(process.pid, 'SIGTERM'), 112000);
  deadline.unref();
  const close = browser.close.bind(browser);
  let closing;
  browser.close = () => closing ??= (async () => {
    clearTimeout(deadline);
    for (const page of await browser.pages()) {
      try {
        const capture = await page.evaluate(() => window.__phoneGraphics?.export());
        if (!capture) continue;
        mkdirSync(join(out, 'shaders'), { recursive: true });
        for (const shader of capture.shaders) {
          const hash = createHash('sha256').update(shader.source).digest('hex').slice(0, 16);
          shader.file = `shaders/${hash}.${shader.type === 35633 ? 'vert' : 'frag'}`;
          writeFileSync(join(out, shader.file), shader.source);
          if (shader.translated) {
            shader.translatedFile = `shaders/${hash}.translated.txt`;
            writeFileSync(join(out, shader.translatedFile), shader.translated);
          }
          delete shader.source; delete shader.translated;
        }
        writeFileSync(join(out, 'graphics.json'), JSON.stringify(capture, null, 2));
      } catch (error) { writeFileSync(join(out, 'capture-error.txt'), String(error)); }
    }
    return close();
  })();
  return browser;
};

function installProfile(desktop, worker = false) {
  const window = globalThis;
  const state = { profile: desktop ? 'desktop-full' : 'phone-smooth', shaders: [], programs: [], errors: [], renderErrors: [], checkpoints: [], requests: [], contexts: [] };
  const shaderRecords = new WeakMap(), shaderKeys = new Map(), contexts = new Map();
  const workerSnapshots = new Map();
  const denied = new Set(['OES_texture_float_linear', 'EXT_color_buffer_float', 'WEBGL_color_buffer_float', 'EXT_color_buffer_half_float', 'EXT_float_blend', 'EXT_texture_filter_anisotropic', 'WEBKIT_EXT_texture_filter_anisotropic', 'MOZ_EXT_texture_filter_anisotropic']);
  const limits = new Map([[3379, 4096], [34024, 4096], [34076, 4096], [36183, 4], [34930, 16], [35660, 16], [35661, 32], [36347, 256], [36348, 15], [36349, 224], [35659, 60], [37157, 60], [36063, 4], [34852, 4]]);
  try {
    localStorage.setItem('moonda.settings.v1', JSON.stringify({ quality: desktop ? 'full' : 'light', qualityChosen: true, lang: 'en', sound: false, soundV: 2, volume: 0 }));
    localStorage.setItem('moonda.welcome', '1');
  } catch { /* non-origin documents have no storage */ }
  if (!desktop) {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 4, configurable: true });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
  }
  const init = gl => {
    let c = contexts.get(gl);
    if (!c) {
      c = { id: contexts.size, gl, textures: new Map(), buffers: new Map(), renderbuffers: new Map(), boundTextures: new Map(), textureUnit: 33984, boundBuffers: new Map(), boundRenderbuffer: null, peakBytes: 0, uploads: [], lost: false };
      contexts.set(gl, c);
      gl.canvas?.addEventListener?.('webglcontextlost', () => { c.lost = true; });
      gl.canvas?.addEventListener?.('webglcontextrestored', () => { c.lost = false; });
    }
    return c;
  };
  const bytesPerPixel = (format, type) => {
    const known = { 32856: 4, 32849: 3, 33321: 1, 33323: 2, 33325: 2, 33327: 4, 34842: 8, 33326: 4, 33328: 8, 34836: 16, 33189: 2, 33190: 3, 33191: 4, 35056: 4, 36012: 4 };
    if (known[format]) return known[format];
    const channels = ({ 6408: 4, 6407: 3, 33319: 2, 6403: 1, 6402: 1, 6406: 1, 6409: 1, 6410: 2 })[format] ?? 4;
    if ([32819, 32820, 33635].includes(type)) return 2;
    if ([34042, 33640, 35899, 35902].includes(type)) return 4;
    return channels * ([5126, 5125, 5124].includes(type) ? 4 : [5131, 36193, 5123, 5122].includes(type) ? 2 : 1);
  };
  const total = c => c.lost ? 0 : [...c.textures.values()].reduce((n, t) => n + [...t.levels.values()].reduce((a, b) => a + b, 0), 0) + [...c.buffers.values()].reduce((a, b) => a + b, 0) + [...c.renderbuffers.values()].reduce((a, b) => a + b, 0);
  const update = c => { c.peakBytes = Math.max(c.peakBytes, total(c)); };
  for (const proto of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype].filter(Boolean)) {
    const originals = {};
    const wrap = (name, callback) => {
      const original = proto[name]; if (typeof original !== 'function') return;
      originals[name] = original;
      proto[name] = function (...args) { return callback.call(this, original, args, init(this)); };
    };
    wrap('getExtension', function (original, args) {
      if (!desktop && denied.has(args[0])) return null;
      return original.apply(this, args);
    });
    wrap('getSupportedExtensions', function (original, args) { return (original.apply(this, args) ?? []).filter(x => desktop || !denied.has(x)); });
    wrap('getParameter', function (original, args) {
      if (!desktop && [7937, 37446].includes(args[0])) return 'Mali-G78';
      if (!desktop && args[0] === 37445) return 'ARM';
      const actual = original.apply(this, args);
      if (!desktop && args[0] === 3386) return new Int32Array([Math.min(4096, actual[0]), Math.min(4096, actual[1])]);
      return !desktop && limits.has(args[0]) ? Math.min(actual, limits.get(args[0])) : actual;
    });
    wrap('getInternalformatParameter', function (original, args) {
      if (!desktop && args[2] === 32937 && [33325,33326,33327,33328,34836,34842,35898].includes(args[1])) return new Int32Array();
      return original.apply(this, args);
    });
    wrap('getError', function (original, args, c) {
      const value = original.apply(this, args);
      if (value) state.errors.push({ context: c.id, code: value, at: performance.now(), stack: new Error().stack });
      return value;
    });
    wrap('shaderSource', function (original, args, c) {
      const type = this.getShaderParameter(args[0], this.SHADER_TYPE), key = `${type}:${args[1]}`;
      let record = shaderKeys.get(key);
      if (!record) { record = { id: state.shaders.length, type, source: args[1], contexts: [], compiled: null, log: '' }; state.shaders.push(record); shaderKeys.set(key, record); }
      if (!record.contexts.includes(c.id)) record.contexts.push(c.id);
      shaderRecords.set(args[0], record);
      return original.apply(this, args);
    });
    wrap('compileShader', function (original, args) {
      const result = original.apply(this, args), record = shaderRecords.get(args[0]);
      if (record) {
        record.compiled = !!this.getShaderParameter(args[0], this.COMPILE_STATUS);
        record.log = this.getShaderInfoLog(args[0]) ?? '';
        try { record.translated = originals.getExtension.call(this, 'WEBGL_debug_shaders')?.getTranslatedShaderSource(args[0]); } catch { /* translation not exposed */ }
      }
      return result;
    });
    wrap('linkProgram', function (original, args, c) {
      const result = original.apply(this, args), program = args[0];
      const uniforms = [];
      if (this.getProgramParameter(program, this.LINK_STATUS)) {
        for (let i = 0; i < this.getProgramParameter(program, this.ACTIVE_UNIFORMS); i++) {
          const u = this.getActiveUniform(program, i); uniforms.push({ name: u.name, size: u.size, type: u.type });
        }
      }
      const attached = this.getAttachedShaders(program) ?? [];
      state.programs.push({ context: c.id, linked: !!this.getProgramParameter(program, this.LINK_STATUS), log: this.getProgramInfoLog(program) ?? '', shaders: attached.map(s => shaderRecords.get(s)?.id), uniforms });
      return result;
    });
    wrap('activeTexture', function (original, args, c) { c.textureUnit = args[0]; return original.apply(this, args); });
    wrap('bindTexture', function (original, args, c) { c.boundTextures.set(`${c.textureUnit}:${args[0]}`, args[1]); return original.apply(this, args); });
    const texture = (c, target) => {
      const handle = c.boundTextures.get(`${c.textureUnit}:${target >= 34069 && target <= 34074 ? 34067 : target}`);
      if (!handle) return null;
      let entry = c.textures.get(handle); if (!entry) { entry = { levels: new Map() }; c.textures.set(handle, entry); }
      return entry;
    };
    wrap('texImage2D', function (original, args, c) {
      const result = original.apply(this, args), t = texture(c, args[0]);
      if (t) {
        const sized = args.length >= 9, src = sized ? null : args[5];
        const w = sized ? args[3] : src?.videoWidth || src?.naturalWidth || src?.width || 0;
        const h = sized ? args[4] : src?.videoHeight || src?.naturalHeight || src?.height || 0;
        const format = sized ? args[6] : args[3], type = sized ? args[7] : args[4];
        t.levels.set(`${args[0]}:${args[1]}`, w * h * bytesPerPixel(format, type));
        if (args[1] === 0 && c.uploads.length < 5000) c.uploads.push({ w, h, format, type, url: src?.currentSrc || src?.src || '', bytes: w * h * bytesPerPixel(format, type) });
        update(c);
      }
      return result;
    });
    wrap('texStorage2D', function (original, args, c) {
      const result = original.apply(this, args), t = texture(c, args[0]);
      if (t) { let w = args[3], h = args[4]; for (let i = 0; i < args[1]; i++) { t.levels.set(`${args[0]}:${i}`, w * h * bytesPerPixel(args[2], 0)); w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); } update(c); }
      return result;
    });
    wrap('generateMipmap', function (original, args, c) {
      const result = original.apply(this, args), t = texture(c, args[0]);
      if (t) { let base = 0; for (const [k, v] of t.levels) if (k.endsWith(':0')) base += v; t.levels.set('generated-mips', Math.floor(base / 3)); update(c); }
      return result;
    });
    wrap('deleteTexture', function (original, args, c) { c.textures.delete(args[0]); return original.apply(this, args); });
    wrap('bindBuffer', function (original, args, c) { c.boundBuffers.set(args[0], args[1]); return original.apply(this, args); });
    wrap('bufferData', function (original, args, c) {
      const result = original.apply(this, args), b = c.boundBuffers.get(args[0]);
      if (b) { const bytes = typeof args[1] === 'number' ? args[1] : args[4] != null ? args[4] * (args[1]?.BYTES_PER_ELEMENT || 1) : args[1]?.byteLength || 0; c.buffers.set(b, bytes); update(c); }
      return result;
    });
    wrap('deleteBuffer', function (original, args, c) { c.buffers.delete(args[0]); return original.apply(this, args); });
    wrap('bindRenderbuffer', function (original, args, c) { c.boundRenderbuffer = args[1]; return original.apply(this, args); });
    wrap('renderbufferStorage', function (original, args, c) { const r = original.apply(this, args); if (c.boundRenderbuffer) c.renderbuffers.set(c.boundRenderbuffer, args[2] * args[3] * bytesPerPixel(args[1], 0)); update(c); return r; });
    wrap('renderbufferStorageMultisample', function (original, args, c) { const r = original.apply(this, args); if (c.boundRenderbuffer) c.renderbuffers.set(c.boundRenderbuffer, args[3] * args[4] * args[1] * bytesPerPixel(args[2], 0)); update(c); return r; });
    wrap('deleteRenderbuffer', function (original, args, c) { c.renderbuffers.delete(args[0]); return original.apply(this, args); });
    // Catch uploads which the real desktop accepts although this profile advertises a smaller GPU.
    for (const name of ['texImage2D', 'texStorage2D', 'renderbufferStorage', 'renderbufferStorageMultisample']) {
      const original = proto[name];
      proto[name] = function (...args) {
        const c = init(this);
        let w, h;
        if (name === 'texImage2D') { const src = args[5]; w = args.length >= 9 ? args[3] : src?.videoWidth || src?.naturalWidth || src?.width; h = args.length >= 9 ? args[4] : src?.videoHeight || src?.naturalHeight || src?.height; }
        else if (name === 'texStorage2D') { w = args[3]; h = args[4]; }
        else if (name === 'renderbufferStorage') { w = args[2]; h = args[3]; }
        else { w = args[3]; h = args[4]; }
        if (!desktop && (w > 4096 || h > 4096)) state.errors.push({ context: c.id, operation: name, reason: 'exceeds advertised 4096 limit', w, h });
        return original.apply(this, args);
      };
    }
  }
  let observedScene;
  const attach = () => {
    const scene = window.__viewer?.scene;
    if (scene && scene !== observedScene) { observedScene = scene; scene.renderError.addEventListener((_scene, error) => state.renderErrors.push({ message: String(error), stack: error?.stack })); }
  };
  const timer = setInterval(attach, 50);
  const contextStats = () => [...contexts.values()].map(c => ({ id: c.id, currentBytes: total(c), peakBytes: c.peakBytes, textures: c.textures.size, buffers: c.buffers.size, renderbuffers: c.renderbuffers.size, lost: c.lost, uploads: c.uploads, canvas: { w: c.gl.canvas.width, h: c.gl.canvas.height } }));
  const checkpoint = name => {
    attach();
    for (const c of contexts.values()) if (!c.lost) { for (let i = 0; i < 8; i++) if (!c.gl.getError()) break; }
    const v = window.__viewer, hook = window.__moonda;
    const modelStats = model => { const s = model?.statistics; return s ? { geometry: s.geometryByteLength, textures: s.texturesByteLength, triangles: s.trianglesLength, ready: model.ready } : null; };
    const textureStats = texture => ({ width: texture?.width, height: texture?.height, bytes: texture?.sizeInBytes, datatype: texture?.pixelDatatype, format: texture?.pixelFormat });
    const entry = { name, at: performance.now(), shaders: state.shaders.length, programs: state.programs.length, errors: state.errors.length, renderErrors: state.renderErrors.length,
      progress: hook?.progress, phase: hook?.lander?.phase, view: hook?.lander?.view, walking: window.__landerLink?.walking, distanceM: window.__landerLink?.walkDistM,
      scene: v ? { renderLoop: v.useDefaultRenderLoop, globeShown: v.scene.globe.show, tilesLoaded: v.scene.globe.tilesLoaded, cacheSize: v.scene.globe.tileCacheSize, msaa: v.scene.msaaSamples, hdr: v.scene.highDynamicRange, resolutionScale: v.resolutionScale } : null,
      canvases: worker ? [] : [...document.querySelectorAll('canvas')].map(c => { const r = c.getBoundingClientRect(); return { class: c.className, width: c.width, height: c.height, x: r.x, y: r.y, w: r.width, h: r.height, visible: getComputedStyle(c).visibility !== 'hidden' && getComputedStyle(c).display !== 'none' }; }),
      gpuBytes: contextStats().reduce((n, c) => n + c.currentBytes, 0), science: window.__moondaScienceMemory?.(), map: window.__moondaSurfaceMap?.getDiagnostics?.(), raster: window.__moondaSurfaceMap?.getRasterDiagnostics?.(), minimap: window.__moondaMinimap?.getDiagnostics?.(), heap: performance.memory?.usedJSHeapSize,
      models: { rover: modelStats(hook?.lander?.rover), rocks: hook?.lander?.rocks?.map(r=>modelStats(r.model)) },
      textures: { regolith: hook?.lander?.detailTex?.map(textureStats), sky: hook?.sky?.textures?.map(textureStats) }, landerStats: hook?.lander?.stats };
    state.checkpoints.push(entry); return entry;
  };
  window.__phoneGraphics = { checkpoint, export: () => {
    clearInterval(timer); checkpoint('end');
    const result = { ...state, shaders: [...state.shaders], programs: [...state.programs], errors: [...state.errors], contexts: contextStats() };
    for (const [id, snapshot] of workerSnapshots) {
      const ids = new Map();
      for (const shader of snapshot.shaders) {
        let entry = result.shaders.find(s=>s.type===shader.type&&s.source===shader.source);
        if (!entry) { entry = { ...shader, id: result.shaders.length, contexts: shader.contexts.map(c=>`worker-${id}:${c}`) }; result.shaders.push(entry); }
        ids.set(shader.id, entry.id);
      }
      result.programs.push(...snapshot.programs.map(p=>({...p,context:`worker-${id}:${p.context}`,shaders:p.shaders.map(s=>ids.get(s))})));
      result.errors.push(...snapshot.errors.map(e=>({...e,worker:id})));
      result.contexts.push(...snapshot.contexts.map(c=>({...c,id:`worker-${id}:${c.id}`})));
    }
    return { ...result, userAgent: navigator.userAgent, coarse: !worker&&matchMedia('(pointer: coarse)').matches, fine: !worker&&matchMedia('(pointer: fine)').matches, limits: desktop ? null : Object.fromEntries(limits), deniedExtensions: desktop ? [] : [...denied], resources: performance.getEntriesByType('resource').map(r => ({ url: r.name, bytes: r.transferSize, decoded: r.decodedBodySize })) };
  } };
  if (worker) {
    let previous = '';
    setInterval(() => {
      for (const c of contexts.values()) if (!c.lost) c.gl.getError();
      const signature = `${state.shaders.length}:${state.programs.length}:${state.errors.length}`;
      if (signature === previous) return;
      previous = signature;
      window.postMessage({ __moondaPhoneCapture: { shaders: state.shaders, programs: state.programs, errors: state.errors, contexts: contextStats() } });
    }, 200);
  } else {
    // Blob workers contain the surface map's small reprojection shader. Prefix their original Blob
    // directly so revoking its URL immediately after Worker construction remains safe.
    const blobs = new Map(), NativeWorker = window.Worker;
    const createURL = URL.createObjectURL.bind(URL), revokeURL = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = createURL(blob); blobs.set(url, blob); return url; };
    URL.revokeObjectURL = url => { blobs.delete(url); return revokeURL(url); };
    let nextWorker = 0;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        const id = nextWorker++, original = String(url), blob = blobs.get(original);
        const prelude = `(${installProfile.toString()})(${JSON.stringify(desktop)},true);\n`;
        // Only the inline photo worker creates GL contexts. The terrain/science module workers use
        // CPU arrays; leave their startup ordering intact instead of introducing an async import.
        const wrapped = blob ? createURL(new Blob([prelude, blob], { type: 'text/javascript' })) : original;
        super(wrapped, options); if (blob) revokeURL(wrapped);
        this.addEventListener('message', event => {
          if (!event.data?.__moondaPhoneCapture) return;
          workerSnapshots.set(id, event.data.__moondaPhoneCapture); event.stopImmediatePropagation();
        });
      }
    };
  }
}
