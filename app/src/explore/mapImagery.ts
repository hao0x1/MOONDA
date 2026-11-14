// Photos shared by the two surface maps. Keep server addresses here so the round map and the
// planner ask for exactly the same ground. Credits: NASA / GSFC / Arizona State University.
// The polar request follows Lunaserv's WMS 1.1.1 contract (https://lunaserv.im-ldi.com/), as the
// globe does; Moon Trek tiles use its published geographic WMTS grid.

import { PHOTO_REGIONS, PHOTO_TC, PHOTO_TC_MAX_Z, trekUrl as sourceTrekUrl } from '../moon/imageryWorker';
import { createMoonTrekProvider, createScienceRasterProvider, type ReprojectedImageryProvider } from '../moon/imagery';
import { SHARP_POLAR_LAYERS, type LayerDef, type ScienceRasterSource } from '../moon/layers';

export const MAP_R = 1737400;
export const POLAR_HALF = 304000;
export const TILE = 512;
export const TREK_MAX_LEVEL = 8;
export const POLAR_MAX_LEVEL = 10;
const DEG = Math.PI / 180;
const POLAR_LAYERS = 'luna_wac_roi_south_summer,luna_nac_pole_control_south';
const WMS_HOSTS = ['wms', 'wms1', 'wms2', 'wms3', 'wms4', 'wms5', 'wms6', 'wms7'];
const BASE = './data/base/v5/';
const POLAR = './data/polar/t/';
const MAX_ITEMS = 300;
const MAX_BYTES = 160 * 1024 * 1024;
const MAX_FETCHES = 4;
const TIMEOUT_MS = 20000;
const RETRY_MS = 30000;
const SCIENCE_BYTES = 24 * 1024 * 1024;
export const SCIENCE_TILE_SIZE = 256;
const heightParts = new WeakMap<LayerDef, { global: LayerDef; polar: LayerDef }>();

/** The globe places the southern height picture above slope, while global heights lie below it. */
export function scienceHeightParts(def: LayerDef): { global: LayerDef; polar: LayerDef } {
  let parts = heightParts.get(def);
  if (!parts) {
    parts = {
      global: { ...def, id: 'heightGlobal', rasterSources: [] },
      polar: { ...def, id: 'heightPolar', rasterSources: def.rasterSources ?? [{ url: './data/layers/height.png', projection: 'polar', pole: 'south', extentM: POLAR_HALF, clipTrueLatDeg: -80.02 }] },
    };
    heightParts.set(def, parts);
  }
  return parts;
}

/** The shared science worker paints the same rotated geographic grid as the globe. */
export function scienceTileRect(level: number, x: number, y: number): { west: number; east: number; north: number; south: number } {
  const span = Math.PI / 2 ** level;
  return { west: -Math.PI + x * span, east: -Math.PI + (x + 1) * span, north: Math.PI / 2 - y * span, south: Math.PI / 2 - (y + 1) * span };
}

/** South-polar stereographic, in metres. Positive y is towards longitude zero. */
export function polarXY(lat: number, lon: number): [number, number] {
  const rho = 2 * MAP_R * Math.tan(Math.PI / 4 + lat * DEG / 2), a = lon * DEG;
  return [rho * Math.sin(a), rho * Math.cos(a)];
}

export function polarLatLon(x: number, y: number): [number, number] {
  return [(2 * Math.atan(Math.hypot(x, y) / (2 * MAP_R)) - Math.PI / 2) / DEG, Math.atan2(x, y) / DEG];
}

export interface BasePicture {
  id: string; url: string; width: number; height: number;
  /** These bounds are in the globe's rotated DISPLAY frame, not true Moon longitude/latitude. */
  west: number; east: number; north: number; south: number;
}

/** Stored pictures from data/base/v5/base.json. The small picture gets an immediate map on screen. */
export const BASE_PICTURES: readonly BasePicture[] = [
  { id: 'quick', url: `${BASE}moon2k.jpg`, width: 2048, height: 1024, west: -180, east: 180, north: 90, south: -90 },
  { id: 'global', url: `${BASE}moon8k.jpg`, width: 8192, height: 4096, west: -180, east: 180, north: 90, south: -90 },
  { id: 'south', url: `${BASE}south6.jpg`, width: 6144, height: 6144, west: 56.25, east: 123.75, north: 33.75, south: -33.75 },
  { id: 'north', url: `${BASE}north6.jpg`, width: 6144, height: 6144, west: -123.75, east: -56.25, north: 33.75, south: -33.75 },
];

export interface MapPhotoSource {
  layer: string; maxZ: number; west: number; east: number; south: number; north: number;
}

// Share the globe's checked catalogue so each view stops at the real last level of a photo.
export const MAP_DETAIL_SOURCES: readonly MapPhotoSource[] = [
  { layer: PHOTO_TC, maxZ: PHOTO_TC_MAX_Z, west: -180, east: 180, south: -80, north: 85.5 },
  ...PHOTO_REGIONS.filter(source => !source.quickmap),
];

export function detailUrl(source: MapPhotoSource, z: number, x: number, y: number): string {
  return sourceTrekUrl(source.layer, 'png', z, x, y);
}

/** The finest available photo at this point, so the map can stop without inventing more detail. */
export function finestPhotoMppAt(lat: number, lon: number): number {
  const l = ((lon + 180) % 360 + 360) % 360 - 180;
  let level = TREK_MAX_LEVEL;
  for (const source of MAP_DETAIL_SOURCES) {
    if (lat >= source.south && lat <= source.north && l >= source.west && l <= source.east) level = Math.max(level, source.maxZ);
  }
  return MAP_R * Math.PI / (256 * 2 ** level);
}

/** Native photo detail at a place, in metres per source pixel. */
export function photoMppAt(lat: number, lon: number): number {
  if (lat < -84) return POLAR_HALF * 2 / (TILE * 2 ** POLAR_MAX_LEVEL);
  if (lat < -79.5) return POLAR_HALF * 2 / (TILE * 2 ** 4);
  return finestPhotoMppAt(lat, lon);
}

/** Start from the detail already stored here; the finer remote photo can arrive afterwards. */
export function sharpOpeningSpan(lat: number, lon: number, widthPx: number): number {
  let mpp = photoMppAt(lat, lon);
  if (lat < -84) {
    const [x, y] = polarXY(lat, lon);
    for (let k = POLAR_MAX_LEVEL; k >= 0; k--) {
      const span = POLAR_HALF * 2 / 2 ** k;
      if (!mapImagery.localPolar(k, Math.floor((x + POLAR_HALF) / span), Math.floor((POLAR_HALF - y) / span))) continue;
      mpp = Math.max(mpp, span / TILE);
      break;
    }
  }
  return Math.max(60, Math.ceil(widthPx * mpp / 2 / 10) * 10);
}

/** True lon/lat tiles: level zero is two columns by one row, each tile 256 pixels. */
export function trekUrl(z: number, x: number, y: number): string {
  return `https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/${z}/${y}/${x}.jpg`;
}

function polarRemoteUrl(k: number, i: number, j: number): string {
  const span = POLAR_HALF * 2 / 2 ** k, x0 = -POLAR_HALF + i * span, y1 = POLAR_HALF - j * span;
  return `https://${WMS_HOSTS[(i + j * 3 + k) % WMS_HOSTS.length]}.im-ldi.com/?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&STYLES=&LAYERS=${POLAR_LAYERS}`
    + `&SRS=IAU2000:30120&BBOX=${x0},${y1 - span},${x0 + span},${y1}&WIDTH=${TILE}&HEIGHT=${TILE}&FORMAT=image/jpeg`;
}

/** This function is also sent to the photo worker; keep its dependencies inside the function. */
async function cleanTcBitmap(bitmap: ImageBitmap): Promise<ImageBitmap> {
  if (bitmap.width !== 256 || bitmap.height !== 256) return bitmap;
  const canvas = new OffscreenCanvas(256, 256), context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return bitmap;
  context.drawImage(bitmap, 0, 0);
  const pixels = context.getImageData(0, 0, 256, 256), data = pixels.data;
  let changed = false;
  for (let o = 0; o < data.length; o += 4) if (data[o] === 0 && data[o + 1] === 0 && data[o + 2] === 0 && data[o + 3] !== 0) {
    data[o + 3] = 0; changed = true;
  }
  if (!changed) return bitmap;
  const clean = await createImageBitmap(pixels, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  bitmap.close();
  return clean;
}

/** Copy into a small independent pixel store, rather than aliasing a whole 8k source texture. */
async function cropPhotoPixels(bitmap: ImageBitmap, x: number, y: number, width: number, height: number): Promise<ImageBitmap> {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Photo cropping unavailable');
  context.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
  return createImageBitmap(context.getImageData(0, 0, width, height), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

/** A small independent underlay stays visible while the sharper GPU tiles arrive. */
async function previewPhotoPixels(bitmap: ImageBitmap): Promise<ImageBitmap> {
  const width = Math.min(512, bitmap.width), height = Math.max(1, Math.round(bitmap.height * width / bitmap.width));
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Photo preview unavailable');
  context.drawImage(bitmap, 0, 0, width, height);
  return createImageBitmap(context.getImageData(0, 0, width, height), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

/** Match the globe's ImageBitmap row probe, on the worker rather than during a map frame. */
async function scienceRowsNeedFlip(): Promise<boolean> {
  const canvas = new OffscreenCanvas(1, 1), gl = canvas.getContext('webgl', { antialias: false, depth: false, stencil: false });
  if (!gl) return true;
  const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]), 1, 2), { premultiplyAlpha: 'none' });
  const texture = gl.createTexture(), frame = gl.createFramebuffer();
  gl.bindTexture(gl.TEXTURE_2D, texture); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, frame); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const pixel = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  bitmap.close(); gl.deleteFramebuffer(frame); gl.deleteTexture(texture); gl.getExtension('WEBGL_lose_context')?.loseContext();
  return pixel[2] <= pixel[0];
}

/** These are only 256 px prepared tiles; source blocks and colour tables stay in the shared worker. */
async function normaliseSciencePixels(bitmaps: ImageBitmap[], flip: boolean): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(256, 256), context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Science tile drawing unavailable');
  if (flip) { context.translate(0, 256); context.scale(1, -1); }
  for (const bitmap of bitmaps) context.drawImage(bitmap, 0, 0, 256, 256);
  return createImageBitmap(context.getImageData(0, 0, 256, 256), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

/** Reproject once on the GPU; every far-map frame then needs only ordinary image blits.
 * The true-to-display transform matches moon/flatMap.ts. Canvas bitmaps have north at the top,
 * whereas flatMap's intermediate GL texture has its first row at the bottom. */
function flatBitmap(bitmap: ImageBitmap): ImageBitmap {
  const width = Math.min(2048, bitmap.width), height = width / 2;
  const canvas = new OffscreenCanvas(width, height);
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
  if (!gl) throw new Error('Photo projection unavailable');
  const program = gl.createProgram();
  if (!program) throw new Error('Photo projection unavailable');
  const sources = [
    [gl.VERTEX_SHADER, `#version 300 es
      in vec2 p;
      void main() { gl_Position = vec4(p, 0.0, 1.0); }`],
    [gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      uniform sampler2D photo;
      uniform vec2 size;
      out vec4 colour;
      const float PI = 3.141592653589793;
      void main() {
        vec2 at = gl_FragCoord.xy / size;
        float lon = (at.x - 0.5) * 2.0 * PI, lat = (at.y - 0.5) * PI;
        vec3 n = vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat));
        float dLon = atan(-n.z, n.x), dLat = asin(clamp(n.y, -1.0, 1.0));
        colour = vec4(texture(photo, vec2(dLon / (2.0 * PI) + 0.5, 0.5 - dLat / PI)).rgb, 1.0);
      }`],
  ] as const;
  for (const [type, source] of sources) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Photo projection unavailable');
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); throw new Error('Photo projection unavailable'); }
    gl.attachShader(program, shader); gl.deleteShader(shader);
  }
  gl.bindAttribLocation(program, 0, 'p'); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); throw new Error('Photo projection unavailable'); }
  const vertices = gl.createBuffer(), texture = gl.createTexture(), vao = gl.createVertexArray();
  gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.useProgram(program); gl.uniform1i(gl.getUniformLocation(program, 'photo'), 0);
  gl.uniform2f(gl.getUniformLocation(program, 'size'), width, height);
  gl.viewport(0, 0, width, height); gl.drawArrays(gl.TRIANGLES, 0, 3);
  const result = canvas.transferToImageBitmap();
  gl.deleteTexture(texture); gl.deleteBuffer(vertices); gl.deleteVertexArray(vao); gl.deleteProgram(program);
  canvas.width = 1; canvas.height = 1;
  return result;
}

interface DecodeJob { kind: 'decode' | 'crop' | 'science'; resolve: (bitmap: ImageBitmap) => void; reject: (reason: Error) => void }
let photoWorker: Worker | null = null;
let workerFailed = false;
let decodeId = 0;
const decodeJobs = new Map<number, DecodeJob>();
const photoSourceIds = new WeakMap<ImageBitmap, number>();
const photoPreviews = new WeakMap<ImageBitmap, ImageBitmap>();
const decodeStats = { workerDecodes: 0, fallbackDecodes: 0, workerCrops: 0, fallbackCrops: 0, workerSourceCache: 0 };

/** Decoding and TC's missing-pixel cleanup share one worker, rather than interrupting a zoom frame. */
function decoder(): Worker | null {
  if (photoWorker || workerFailed) return photoWorker;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') { workerFailed = true; return null; }
  const source = `const cleanTc = (${cleanTcBitmap.toString()});
    const makeFlat = (${flatBitmap.toString()});
    const cropPixels = (${cropPhotoPixels.toString()});
    const previewPixels = (${previewPhotoPixels.toString()});
    const needScienceFlip = (${scienceRowsNeedFlip.toString()});
    const normaliseScience = (${normaliseSciencePixels.toString()});
    let scienceFlip;
    const photoSources = new Map();
    let nextSourceId = 0;
    const releaseSource = id => {
      const source = photoSources.get(id);
      if (source) { photoSources.delete(id); source.close(); }
    };
    self.onmessage = async ({ data }) => {
      if (data.operation === 'release') {
        releaseSource(data.sourceId);
        self.postMessage({ sourceCache: photoSources.size });
        return;
      }
      let bitmap, preview, input = null, sourceId;
      const ownsInput = data.operation === 'crop' && !data.sourceId;
      try {
        if (data.operation === 'science') {
          scienceFlip ??= needScienceFlip().catch(() => true);
          bitmap = await normaliseScience(data.bitmaps, await scienceFlip);
        } else if (data.operation === 'crop') {
          input = data.sourceId ? photoSources.get(data.sourceId) : data.bitmap;
          if (!input) throw new Error('Photo source unavailable');
          if (data.sourceId) { photoSources.delete(data.sourceId); photoSources.set(data.sourceId, input); }
          bitmap = await cropPixels(input, data.x, data.y, data.width, data.height);
        } else {
          bitmap = await createImageBitmap(data.blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
          if (data.clean) bitmap = await cleanTc(bitmap);
          if (data.flat) { const projected = makeFlat(bitmap); bitmap.close(); bitmap = projected; }
          if (bitmap.width * bitmap.height > 2097152) {
            // Keep the decoded large source here. Cloning it once on this worker lets the public
            // cache keep its usual bitmap while every later crop message contains only a number.
            sourceId = ++nextSourceId;
            photoSources.set(sourceId, bitmap);
            while (photoSources.size > 8) releaseSource(photoSources.keys().next().value);
            preview = await previewPixels(bitmap);
            bitmap = await createImageBitmap(bitmap, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
          }
        }
        self.postMessage({ id: data.id, bitmap, preview, sourceId, sourceCache: photoSources.size }, preview ? [bitmap, preview] : [bitmap]);
      } catch (error) {
        if (bitmap) bitmap.close();
        if (preview) preview.close();
        if (sourceId) releaseSource(sourceId);
        self.postMessage({ id: data.id, error: String(error), sourceCache: photoSources.size });
      } finally {
        if (ownsInput && input) input.close();
        if (data.operation === 'science') for (const source of data.bitmaps) source.close();
      }
    };`;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    const worker = new Worker(url, { name: 'moonda-map-photos' });
    worker.onmessage = (event: MessageEvent<{ id?: number; bitmap?: ImageBitmap; preview?: ImageBitmap; error?: string; sourceId?: number; sourceCache?: number }>) => {
      const result = event.data;
      if (result.sourceCache !== undefined) decodeStats.workerSourceCache = result.sourceCache;
      if (result.id === undefined) return;
      const job = decodeJobs.get(result.id);
      if (result.bitmap && result.sourceId) photoSourceIds.set(result.bitmap, result.sourceId);
      if (result.bitmap && result.preview) photoPreviews.set(result.bitmap, result.preview);
      if (!job) { if (result.bitmap) closeCachedPhoto(result.bitmap); return; }
      decodeJobs.delete(result.id);
      if (result.bitmap) {
        if (job.kind === 'crop') decodeStats.workerCrops++; else if (job.kind === 'decode') decodeStats.workerDecodes++;
        job.resolve(result.bitmap);
      }
      else job.reject(new Error(result.error ?? 'Photo decoding unavailable'));
    };
    worker.onerror = event => {
      event.preventDefault(); workerFailed = true; worker.terminate(); photoWorker = null; decodeStats.workerSourceCache = 0;
      for (const job of decodeJobs.values()) job.reject(new Error('Photo decoding unavailable'));
      decodeJobs.clear();
    };
    photoWorker = worker;
    return worker;
  } catch { workerFailed = true; return null; }
  finally { URL.revokeObjectURL(url); }
}

async function decodePhoto(blob: Blob, url: string, flat: boolean): Promise<ImageBitmap> {
  // Only TC uses opaque black for missing observations. NAC's black crater shadows are real.
  const clean = url.includes(PHOTO_TC) || url.includes(encodeURIComponent(PHOTO_TC));
  const worker = decoder();
  if (worker) {
    try {
      return await new Promise<ImageBitmap>((resolve, reject) => {
        const id = ++decodeId;
        decodeJobs.set(id, { kind: 'decode', resolve, reject });
        try { worker.postMessage({ id, blob, clean, flat }); }
        catch (error) { decodeJobs.delete(id); reject(error); }
      });
    } catch { /* Older browsers can still decode asynchronously without the worker. */ }
  }
  decodeStats.fallbackDecodes++;
  let bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  if (clean) bitmap = await cleanTcBitmap(bitmap);
  if (flat) {
    try { return flatBitmap(bitmap); }
    finally { closeCachedPhoto(bitmap); }
  }
  if (bitmap.width * bitmap.height > 2097152) photoPreviews.set(bitmap, await previewPhotoPixels(bitmap));
  return bitmap;
}

/** A bounded preview for a large photo or overlay, kept until the cached source is released. */
export function getPhotoPreview(bitmap: ImageBitmap): ImageBitmap | null { return photoPreviews.get(bitmap) ?? null; }

/** Crop from the worker's retained source using a token, without cloning a whole photo for each slice. */
export async function cropMapPhoto(bitmap: ImageBitmap, x: number, y: number, width: number, height: number): Promise<ImageBitmap> {
  const worker = decoder();
  if (worker) {
    try {
      return await new Promise<ImageBitmap>((resolve, reject) => {
        const id = ++decodeId;
        decodeJobs.set(id, { kind: 'crop', resolve, reject });
        const sourceId = photoSourceIds.get(bitmap);
        try { worker.postMessage(sourceId ? { id, operation: 'crop', sourceId, x, y, width, height }
          : { id, operation: 'crop', bitmap, x, y, width, height }); }
        catch (error) { decodeJobs.delete(id); reject(error); }
      });
    } catch { /* A small CPU canvas also works in browsers without worker bitmaps. */ }
  }
  decodeStats.fallbackCrops++;
  return cropPhotoPixels(bitmap, x, y, width, height);
}

/** Release both sides of a cached photo; the worker keeps no orphaned large decode after eviction. */
export function closeCachedPhoto(bitmap: ImageBitmap): void {
  const preview = photoPreviews.get(bitmap);
  if (preview) { photoPreviews.delete(bitmap); preview.close(); }
  const sourceId = photoSourceIds.get(bitmap);
  if (sourceId) {
    photoSourceIds.delete(bitmap);
    try { photoWorker?.postMessage({ operation: 'release', sourceId }); }
    catch { /* A stopped worker has already released its sources. */ }
  }
  bitmap.close();
}

let fallbackScienceFlip: Promise<boolean> | undefined;
async function prepareScienceTile(bitmaps: ImageBitmap[]): Promise<ImageBitmap> {
  const worker = decoder();
  if (worker) return new Promise<ImageBitmap>((resolve, reject) => {
    const id = ++decodeId;
    decodeJobs.set(id, { kind: 'science', resolve, reject });
    try { worker.postMessage({ id, operation: 'science', bitmaps }, bitmaps); }
    catch (error) { decodeJobs.delete(id); for (const bitmap of bitmaps) bitmap.close(); reject(error); }
  });
  try {
    fallbackScienceFlip ??= scienceRowsNeedFlip().catch(() => true);
    return await normaliseSciencePixels(bitmaps, await fallbackScienceFlip);
  } finally { for (const bitmap of bitmaps) bitmap.close(); }
}

interface Cached { bitmap: ImageBitmap; bytes: number; arrivedAt: number }
interface ScienceProvider { provider: ReprojectedImageryProvider; compact: boolean }
interface ScienceLayer { prefix: string; fingerprint: string; providers: ScienceProvider[] }
interface ScienceJob { layer: ScienceLayer; level: number; x: number; y: number }
interface Pending { key: string; urls: string[]; priority: number; at: number; ctl: AbortController | null; science?: ScienceJob }
interface Failure { count: number; until: number }
interface SiteFailure { count: number; until: number }
type Index = { layers?: string; halfM?: number; tilePx?: number; levels?: Record<string, { runs?: unknown }> };

/** A small shared LRU, with one download of a tile even while both maps use it. */
export class MapImagery {
  ready = false;
  private readonly rows = new Map<number, Map<number, number[]>>();
  private readonly cached = new Map<string, Cached>();
  private readonly pending = new Map<string, Pending>();
  private readonly failed = new Map<string, Failure>();
  private readonly sites = new Map<string, SiteFailure>();
  private readonly owners = new Map<object, Set<string>>();
  private readonly listeners = new Set<(key?: string) => void>();
  private bytes = 0;
  private active = 0;
  private scienceActive = 0;
  private scheduled = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private order = 0;
  private readonly fetchQueue: (() => boolean)[] = [];
  private fetchScheduled = false;
  private fetchStarts = 0;
  private maxStartsPerFrame = 0;
  private readonly scienceDefs = new WeakMap<LayerDef, ScienceLayer>();
  private readonly scienceLayers = new Map<string, ScienceLayer>();
  private scienceVersion = 0;
  private scienceStarts = 0;
  private maxScienceStartsPerFrame = 0;
  private readonly scienceQueue: { start: () => void; signal: AbortSignal }[] = [];
  private scienceScheduled = false;

  constructor() {
    void this.loadIndex();
    if (typeof window !== 'undefined') window.addEventListener('online', () => {
      this.failed.clear(); this.sites.clear(); this.notify(); this.schedule();
    });
  }

  subscribe(fn: (key?: string) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  localPolar(k: number, i: number, j: number): boolean {
    const runs = this.rows.get(k)?.get(j);
    if (!runs) return false;
    for (let n = 0; n < runs.length; n += 2) if (i >= runs[n] && i <= runs[n + 1]) return true;
    return false;
  }

  /** Wait for the local index before deciding that a tile needs the remote server. */
  polarUrls(k: number, i: number, j: number): string[] {
    if (!this.ready) return [];
    const remote = polarRemoteUrl(k, i, j);
    return this.localPolar(k, i, j) ? [`${POLAR}${k}/${i}_${j}.jpg`, remote] : [remote];
  }

  get(key: string): ImageBitmap | null {
    const entry = this.cached.get(key);
    if (!entry) return null;
    this.cached.delete(key); this.cached.set(key, entry);
    return entry.bitmap;
  }

  /** The same stored photo as the app's flat map, prepared once in true Moon longitude/latitude. */
  requestFlatBase(): ImageBitmap | null {
    return this.request('base-flat', [BASE_PICTURES[0].url], -110);
  }

  /** A stable key also lets the two map views share and retain the same prepared tile. */
  scienceTileKey(def: LayerDef, level: number, x: number, y: number): string {
    return `${this.scienceLayer(def).prefix}${level}/${x}/${y}`;
  }

  /** Colours, missing values, source replacement and both-pole coverage match the globe. */
  requestScienceTile(def: LayerDef, level: number, x: number, y: number, priority = 0): ImageBitmap | null {
    const layer = this.scienceLayer(def), key = `${layer.prefix}${level}/${x}/${y}`, bitmap = this.get(key);
    // These providers can be made after the globe last published its active switches. Their own
    // ready callbacks must still wake this map, without changing the worker's shared source list.
    for (const { provider, compact } of layer.providers) if (compact) (provider as ReprojectedImageryProvider & { active: boolean }).active = true;
    if (bitmap) return bitmap;
    const fail = this.failed.get(key);
    if (fail && performance.now() < fail.until) { this.wakeAt(fail.until); return null; }
    const old = this.pending.get(key);
    if (old) { old.priority = Math.min(old.priority, priority); return null; }
    this.pending.set(key, { key, urls: [], science: { layer, level, x, y }, priority, at: this.order++, ctl: null });
    this.schedule();
    return null;
  }

  private scienceLayer(def: LayerDef): ScienceLayer {
    const known = this.scienceDefs.get(def);
    if (known) return known;
    const sources: ScienceRasterSource[] = def.rasterSources ?? [{ url: `./data/layers/${def.id}.png`, projection: 'polar', pole: 'south', extentM: POLAR_HALF, clipTrueLatDeg: -80.02 }];
    const fingerprint = JSON.stringify(sources), existing = this.scienceLayers.get(def.id);
    if (existing?.fingerprint === fingerprint) { this.scienceDefs.set(def, existing); return existing; }
    const providers: ScienceProvider[] = [];
    // The globe keeps the NASA global colour height map under its sharper stored south map.
    if (def.id === 'height' || def.id === 'heightGlobal') providers.push({ provider: createMoonTrekProvider({ layer: 'LRO_LOLA_ClrShade_Global_256ppd_v06', ext: 'png', minTrueLat: -80.4, maxSourceLevel: 6, credit: 'NASA Moon Trek · LRO LOLA' }), compact: false });
    if (def.id !== 'heightGlobal') providers.push({ provider: createScienceRasterProvider({ sources, credit: def.source?.name ?? 'NASA', maximumLevel: SHARP_POLAR_LAYERS.has(def.id) ? 10 : 9 }), compact: true });
    const layer: ScienceLayer = { prefix: `science:${def.id}:${++this.scienceVersion}:`, fingerprint, providers };
    for (const { provider } of providers) provider._reload = () => this.invalidateScience(layer);
    this.scienceLayers.set(def.id, layer); this.scienceDefs.set(def, layer);
    return layer;
  }

  private invalidateScience(layer: ScienceLayer): void {
    for (const [key, entry] of this.cached) if (key.startsWith(layer.prefix)) {
      this.cached.delete(key); this.bytes -= entry.bytes; closeCachedPhoto(entry.bitmap);
    }
    for (const [key, item] of this.pending) if (key.startsWith(layer.prefix)) { item.ctl?.abort(); this.pending.delete(key); }
    this.notify(); this.schedule();
  }

  /** Small counters for repeatable browser checks; no logging runs in the drawing loop. */
  getStats() {
    let scienceBytes = 0, scienceTiles = 0;
    const scienceByLayer: Record<string, { tiles: number; bytes: number; pending: number }> = {};
    for (const [key, entry] of this.cached) if (key.startsWith('science:')) {
      scienceBytes += entry.bytes; scienceTiles++;
      const id = key.split(':', 3)[1], layer = scienceByLayer[id] ??= { tiles: 0, bytes: 0, pending: 0 };
      layer.tiles++; layer.bytes += entry.bytes;
    }
    for (const key of this.pending.keys()) if (key.startsWith('science:')) {
      const id = key.split(':', 3)[1], layer = scienceByLayer[id] ??= { tiles: 0, bytes: 0, pending: 0 };
      layer.pending++;
    }
    return { active: this.active, pending: this.pending.size, cached: this.cached.size, bytes: this.bytes,
      ...decodeStats, networkStarts: this.fetchStarts, maxStartsPerFrame: this.maxStartsPerFrame,
      scienceBytes, scienceTiles, scienceByLayer, scienceBudgetBytes: SCIENCE_BYTES, scienceActive: this.scienceActive, scienceStarts: this.scienceStarts, maxScienceStartsPerFrame: this.maxScienceStartsPerFrame };
  }

  /** New detail settles over the photo already on screen instead of popping into view. */
  fade(key: string): number {
    const entry = this.cached.get(key);
    return entry ? Math.min(1, Math.max(0, (performance.now() - entry.arrivedAt) / 120)) : 0;
  }

  /** Return the photo at once, or queue it without holding up a frame. Lower priorities go first. */
  request(key: string, urls: string[], priority = 0): ImageBitmap | null {
    const bitmap = this.get(key);
    if (bitmap || !urls.length) return bitmap;
    const now = performance.now(), fail = this.failed.get(key);
    if (fail && now < fail.until) { this.wakeAt(fail.until); return null; }
    const old = this.pending.get(key);
    if (old) { old.priority = Math.min(old.priority, priority); return null; }
    this.pending.set(key, { key, urls: [...urls], priority, at: this.order++, ctl: null });
    this.schedule();
    return null;
  }

  /** Call once after drawing. Moving the map drops downloads for ground no view needs any more. */
  retain(owner: object, keys: Set<string>): void {
    this.owners.set(owner, keys);
    this.cancelUnused();
    this.evict();
    this.schedule();
  }

  release(owner: object): void {
    this.owners.delete(owner);
    this.cancelUnused();
    this.evict();
  }

  /** Release this map's bitmaps and jobs without touching the globe's shared source blocks. */
  dispose(): void {
    this.owners.clear(); this.listeners.clear();
    for (const item of this.pending.values()) item.ctl?.abort();
    this.pending.clear();
    for (const item of this.cached.values()) closeCachedPhoto(item.bitmap);
    this.cached.clear(); this.bytes = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const layer of this.scienceLayers.values()) for (const { provider, compact } of layer.providers) {
      provider._reload = undefined;
      if (compact) {
        const science = provider as ReprojectedImageryProvider & { active: boolean; clearPrepared(): void };
        science.active = false; science.clearPrepared();
      }
    }
    this.scienceLayers.clear();
  }

  private needed(key: string): boolean {
    for (const keys of this.owners.values()) if (keys.has(key)) return true;
    return false;
  }

  private cancelUnused(): void {
    for (const [key, item] of this.pending) if (!this.needed(key)) {
      item.ctl?.abort();
      this.pending.delete(key);
    }
    for (const layer of this.scienceLayers.values()) {
      let active = false;
      for (const keys of this.owners.values()) { for (const key of keys) if (key.startsWith(layer.prefix)) { active = true; break; } if (active) break; }
      for (const { provider, compact } of layer.providers) if (compact) (provider as ReprojectedImageryProvider & { active: boolean }).active = active;
    }
  }

  private notify(key?: string): void {
    if (key !== undefined && !this.needed(key)) return;
    for (const fn of this.listeners) fn(key);
  }

  private async loadIndex(): Promise<void> {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${POLAR}index.json`, { signal: ctl.signal });
      if (!response.ok) return;
      const index = await response.json() as Index;
      if (index.halfM !== POLAR_HALF || index.tilePx !== TILE || index.layers !== POLAR_LAYERS || !index.levels) return;
      for (const [name, level] of Object.entries(index.levels)) {
        const k = Number(name);
        if (!Number.isInteger(k) || k < 0 || k > POLAR_MAX_LEVEL || !Array.isArray(level.runs)) continue;
        const rows = new Map<number, number[]>();
        for (const run of level.runs as unknown[]) {
          if (!Array.isArray(run) || run.length !== 3 || !run.every(Number.isInteger)) continue;
          const [j, first, last] = run as number[];
          if (j < 0 || j >= 2 ** k || first < 0 || first > last || last >= 2 ** k) continue;
          const spans = rows.get(j) ?? [];
          spans.push(first, last); rows.set(j, spans);
        }
        this.rows.set(k, rows);
      }
    } catch { /* The map can still use Lunaserv when its stored index is unavailable. */ }
    finally { clearTimeout(timer); this.ready = true; this.notify(); }
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }

  private siteOf(url: string): string {
    const host = new URL(url, document.baseURI).hostname;
    return host.endsWith('.im-ldi.com') ? 'im-ldi.com' : host;
  }

  private isRemote(url: string): boolean { return new URL(url, document.baseURI).origin !== location.origin; }

  private pump(): void {
    const now = performance.now();
    const waiting = [...this.pending.values()].filter(item => !item.ctl && this.needed(item.key));
    waiting.sort((a, b) => a.priority - b.priority || a.at - b.at);
    for (const item of waiting) {
      if (item.science) {
        // Local science work must not wait for four slow photo downloads. Its own small queue
        // still admits at most four tiles per frame and shares the globe's decoded blocks.
        if (this.scienceActive >= MAX_FETCHES) continue;
        item.ctl = new AbortController(); this.scienceActive++;
        void this.loadScience(item);
        continue;
      }
      if (this.active >= MAX_FETCHES) continue;
      // A known local tile is never made to wait for an unreachable remote service.
      const first = item.urls[0], site = first && this.isRemote(first) ? this.sites.get(this.siteOf(first)) : undefined;
      if (site && site.count >= 4 && site.until > now) { this.wakeAt(site.until); continue; }
      item.ctl = new AbortController(); this.active++;
      void this.load(item);
    }
  }

  private wakeAt(at: number): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.notify(); this.schedule();
    }, Math.max(50, at - performance.now() + 20));
  }

  /** Limit actual requests, including fallback URLs, to four starts in one animation frame. */
  private fetchPhoto(url: string, signal: AbortSignal): Promise<Response> {
    return new Promise((resolve, reject) => {
      let started = false;
      const aborted = () => { if (!started) reject(new DOMException('Map moved', 'AbortError')); };
      signal.addEventListener('abort', aborted, { once: true });
      this.fetchQueue.push(() => {
        signal.removeEventListener('abort', aborted);
        if (signal.aborted) { aborted(); return false; }
        started = true;
        fetch(url, { signal, mode: 'cors', credentials: 'omit' }).then(resolve, reject);
        return true;
      });
      this.scheduleFetches();
    });
  }

  private scheduleFetches(): void {
    if (this.fetchScheduled || !this.fetchQueue.length) return;
    this.fetchScheduled = true;
    requestAnimationFrame(() => {
      this.fetchScheduled = false;
      let starts = 0;
      while (this.fetchQueue.length && starts < MAX_FETCHES) if (this.fetchQueue.shift()!()) starts++;
      this.fetchStarts += starts; this.maxStartsPerFrame = Math.max(this.maxStartsPerFrame, starts);
      this.scheduleFetches();
    });
  }

  private async load(item: Pending): Promise<void> {
    const ctl = item.ctl!;
    let got: ImageBitmap | null = null;
    try {
      for (const url of item.urls) {
        if (ctl.signal.aborted) break;
        const remote = this.isRemote(url), siteName = this.siteOf(url), site = this.sites.get(siteName);
        if (remote && site && site.count >= 4 && site.until > performance.now()) continue;
        // A timeout belongs to this URL, while the parent abort means the map has moved away.
        // Keeping them separate lets failures back off instead of starting another timeout at once.
        const attempt = new AbortController(), cancel = () => attempt.abort();
        ctl.signal.addEventListener('abort', cancel, { once: true });
        const timeout = setTimeout(cancel, TIMEOUT_MS);
        let ok = false;
        try {
          const response = await this.fetchPhoto(url, attempt.signal);
          if (response.ok) {
            const blob = await response.blob();
            got = await decodePhoto(blob, url, item.key === 'base-flat');
            ok = true;
          } else if (response.status === 404) ok = true; // the server answered; its other tiles can still work
        } catch { /* A parent tile remains visible after a missing or failed picture. */ }
        finally { clearTimeout(timeout); ctl.signal.removeEventListener('abort', cancel); }
        if (remote && !ctl.signal.aborted) {
          if (ok) this.sites.delete(siteName);
          else {
            const count = (this.sites.get(siteName)?.count ?? 0) + 1;
            this.sites.set(siteName, { count, until: performance.now() + RETRY_MS * Math.min(8, 2 ** Math.max(0, count - 4)) });
          }
        }
        if (got) break;
      }
      if (got && !ctl.signal.aborted && this.pending.get(item.key) === item) {
        const bytes = got.width * got.height * 4;
        this.cached.set(item.key, { bitmap: got, bytes, arrivedAt: performance.now() }); this.bytes += bytes;
        this.failed.delete(item.key); this.evict(); this.notify(item.key);
      } else {
        if (got) closeCachedPhoto(got);
        if (!ctl.signal.aborted && this.pending.get(item.key) === item) {
          const count = (this.failed.get(item.key)?.count ?? 0) + 1;
          const until = performance.now() + RETRY_MS * Math.min(8, 2 ** (count - 1));
          this.failed.set(item.key, { count, until }); this.wakeAt(until);
        }
      }
    } finally {
      if (this.pending.get(item.key) === item) this.pending.delete(item.key);
      this.active--; this.schedule();
    }
  }

  /** Even a warm worker sees at most four new surface-map tile jobs in one frame. */
  private admitScience(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new DOMException('Map moved', 'AbortError'));
    return new Promise((resolve, reject) => {
      const stopped = () => reject(new DOMException('Map moved', 'AbortError'));
      signal.addEventListener('abort', stopped, { once: true });
      this.scienceQueue.push({ signal, start: () => { signal.removeEventListener('abort', stopped); resolve(); } });
      this.scheduleScience();
    });
  }

  private scheduleScience(): void {
    if (this.scienceScheduled || !this.scienceQueue.length) return;
    this.scienceScheduled = true;
    requestAnimationFrame(() => {
      this.scienceScheduled = false;
      let starts = 0;
      while (this.scienceQueue.length && starts < MAX_FETCHES) {
        const item = this.scienceQueue.shift()!;
        if (!item.signal.aborted) { item.start(); starts++; }
      }
      this.scienceStarts += starts; this.maxScienceStartsPerFrame = Math.max(this.maxScienceStartsPerFrame, starts);
      this.scheduleScience();
    });
  }

  private async loadScience(item: Pending): Promise<void> {
    const ctl = item.ctl!, { layer, level, x, y } = item.science!;
    const requests: { cancelled?: boolean; cancelFunction?: () => void }[] = [];
    const bitmaps: ImageBitmap[] = [];
    const cancel = () => { for (const request of requests) { request.cancelled = true; request.cancelFunction?.(); } };
    let prepared: ImageBitmap | null = null, busy = false;
    ctl.signal.addEventListener('abort', cancel, { once: true });
    try {
      await this.admitScience(ctl.signal);
      const results = await Promise.allSettled(layer.providers.map(async ({ provider, compact }) => {
        const request: { cancelled?: boolean; cancelFunction?: () => void } = {};
        requests.push(request);
        if (ctl.signal.aborted) { request.cancelled = true; return null; }
        const result = provider.requestImage(x, y, level, request);
        if (!result) { busy = true; return null; }
        const bitmap = await result;
        if (provider.tileDiscardPolicy.shouldDiscardImage(bitmap)) {
          // This is a request to keep the coarser picture, never a real transparent tile. Forget
          // the provider's prepared marker too, so the short retry can ask the worker afresh.
          busy = true;
          if (compact) (provider as ReprojectedImageryProvider & { clearPrepared(): void }).clearPrepared();
          return null;
        }
        if (bitmap.width <= 1 && bitmap.height <= 1) {
          // Science providers lend a clone; the Trek provider may return its shared blank pixel.
          if (compact) bitmap.close();
          return null;
        }
        return bitmap;
      }));
      let failed = false;
      for (const result of results) {
        if (result.status === 'fulfilled') { if (result.value) bitmaps.push(result.value); }
        else failed = true;
      }
      if (failed && !ctl.signal.aborted) throw new Error('Science tile not available');
      if (ctl.signal.aborted || busy) return;
      prepared = await prepareScienceTile(bitmaps.splice(0));
      if (ctl.signal.aborted || this.pending.get(item.key) !== item) return;
      const bytes = prepared.width * prepared.height * 4;
      this.cached.set(item.key, { bitmap: prepared, bytes, arrivedAt: performance.now() }); this.bytes += bytes;
      prepared = null; this.failed.delete(item.key); this.evict(); this.notify(item.key);
    } catch {
      if (!ctl.signal.aborted) {
        const until = performance.now() + RETRY_MS;
        this.failed.set(item.key, { count: 1, until }); this.wakeAt(until);
      }
    } finally {
      ctl.signal.removeEventListener('abort', cancel);
      for (const bitmap of bitmaps) bitmap.close(); prepared?.close();
      if (this.pending.get(item.key) === item) this.pending.delete(item.key);
      this.scienceActive--; this.schedule();
      if (busy && !ctl.signal.aborted) setTimeout(() => this.notify(item.key), 50);
    }
  }

  private evict(): void {
    let scienceBytes = 0;
    for (const [key, item] of this.cached) if (key.startsWith('science:')) scienceBytes += item.bytes;
    if (scienceBytes > SCIENCE_BYTES) for (const [key, item] of this.cached) {
      if (!key.startsWith('science:') || this.needed(key)) continue;
      this.cached.delete(key); this.bytes -= item.bytes; scienceBytes -= item.bytes; closeCachedPhoto(item.bitmap);
      if (scienceBytes <= SCIENCE_BYTES) break;
    }
    if (this.cached.size <= MAX_ITEMS && this.bytes <= MAX_BYTES) return;
    for (const [key, item] of this.cached) {
      if (this.needed(key)) continue;
      this.cached.delete(key); this.bytes -= item.bytes; closeCachedPhoto(item.bitmap);
      if (this.cached.size <= MAX_ITEMS && this.bytes <= MAX_BYTES) break;
    }
  }
}

export const mapImagery = new MapImagery();
import.meta.hot?.dispose(() => mapImagery.dispose());
