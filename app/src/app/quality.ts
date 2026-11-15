// The two graphics modes, as plain data, so every part of the app reads the same numbers.
//
//   'full'  ("Full detail"): the sharpest Moon, the 8k Milky Way, smooth edges. For a recent laptop or desktop.
//   'light' ("Smooth"):      fewer, coarser photo tiles, a smaller drawing size and the 4k Milky Way, so it
//                            stays fluid on older computers and tablets (and loads less over a slow network).
//
// The person's choice lives in settings (settings.get().quality). On the first visit nothing is chosen yet:
// the start screen uses detectQuality() and marks that mode "Recommended for this computer".
// applyQuality() changes what Cesium can change while running; MoonMap calls it at start and on every change.

import type { Viewer } from 'cesium';
import { settings, type Quality } from './settings';

export type { Quality };

export interface QualityKnobs {
  /** globe.maximumScreenSpaceError: how many screen pixels one photo pixel may be stretched over before a
   *  sharper tile is fetched. Lower = sharper, but more tiles to download and draw after every zoom. */
  maxSSE: number;
  /** The drawing size is at most this many pixels per CSS pixel (2 on a Retina screen = full sharpness). */
  maxPixelRatio: number;
  /** Edge smoothing: MSAA samples (1 = off), and the cheap FXAA filter instead where MSAA is off. */
  msaaSamples: number;
  fxaa: boolean;
  /** How many globe tiles stay in memory, so going back to a place does not load it again. */
  tileCacheSize: number;
  /** Also load the tiles beside the ones in view, so a small pan shows no blur. */
  preloadSiblings: boolean;
  /** How many sharper tiles may load at once before the blurrier parent stops being drawn in their place. */
  loadingDescendantLimit: number;
  /** The sky's Milky Way picture: 8k (10 MB) or only the 4k one (2 MB). Read by the sky (src/moon/sky). */
  milkyWay8k: boolean;
}

export const QUALITY: Record<Quality, QualityKnobs> = {
  full: { maxSSE: 1, maxPixelRatio: 2, msaaSamples: 2, fxaa: false, tileCacheSize: 3000, preloadSiblings: true, loadingDescendantLimit: 20, milkyWay8k: true },
  light: { maxSSE: 2, maxPixelRatio: 1.25, msaaSamples: 1, fxaa: true, tileCacheSize: 1200, preloadSiblings: false, loadingDescendantLimit: 12, milkyWay8k: false },
};

/** Small touch-only screens share memory with the browser and cannot keep a desktop tile cache. */
let phonePointers: { coarse: MediaQueryList; fine: MediaQueryList } | undefined;
export function isPhoneGraphics(q: Quality = settings.get().quality): boolean {
  if (q !== 'light' || typeof window === 'undefined') return false;
  phonePointers ??= { coarse: matchMedia('(pointer: coarse)'), fine: matchMedia('(pointer: fine)') };
  const touchOnly = phonePointers.coarse.matches && !phonePointers.fine.matches;
  const shortSide = Math.min(screen.width || innerWidth, screen.height || innerHeight);
  return touchOnly && shortSide <= 600;
}

const PHONE_QUALITY: QualityKnobs = {
  // Keep the same photo detail per CSS pixel while drawing names and flags at twice the density.
  ...QUALITY.light, maxSSE: 6, maxPixelRatio: 2, tileCacheSize: 80, loadingDescendantLimit: 2, fxaa: false,
};
let phoneSurface = false;
const PHONE_SURFACE_QUALITY = { ...PHONE_QUALITY, maxPixelRatio: 1.5 };
export function setPhoneSurfaceGraphics(on: boolean): void { phoneSurface = on; }

/** The knobs for the mode chosen right now. */
export const knobs = (q: Quality = settings.get().quality): QualityKnobs => isPhoneGraphics(q) ? phoneSurface ? PHONE_SURFACE_QUALITY : PHONE_QUALITY : QUALITY[q];

/** A canvas and its offscreen targets must both fit the actual driver's drawing limits. */
const drawingLimits = new WeakMap<WebGLRenderingContext | WebGL2RenderingContext, { edge: number; width: number; height: number }>();
export function drawingPixelRatio(gl: WebGLRenderingContext | WebGL2RenderingContext, width: number, height: number, ratio: number): number {
  let limits = drawingLimits.get(gl);
  if (!limits) {
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null;
    const edge = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);
    // A lost context returns null; use its last good limits once the context comes back.
    if (!viewport || edge <= 0) return ratio;
    drawingLimits.set(gl, (limits = { edge, width: viewport[0], height: viewport[1] }));
  }
  return Math.min(ratio, limits.edge / Math.max(1, width), limits.edge / Math.max(1, height),
    limits.width / Math.max(1, width), limits.height / Math.max(1, height));
}

/** The text keys for each mode (English in src/i18n/en/start.ts). */
export const QUALITY_TEXT: Record<Quality, { title: 'start.mode.full' | 'start.mode.light'; body: 'start.mode.full.body' | 'start.mode.light.body' }> = {
  full: { title: 'start.mode.full', body: 'start.mode.full.body' },
  light: { title: 'start.mode.light', body: 'start.mode.light.body' },
};

/** The graphics chip's name, read once (WebGL tells it to pages; Safari only says "Apple GPU"). */
function gpuName(): string {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return '';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
    gl.getExtension('WEBGL_lose_context')?.loseContext(); // give the context back at once: browsers allow only a few
    return name;
  } catch { return ''; }
}

let detected: Quality | null = null;

/** Our best guess for this computer: Apple M-series and real graphics cards get 'full', everything else 'light'. */
export function detectQuality(): Quality {
  if (detected) return detected;
  const gpu = gpuName().toLowerCase();
  const nav = navigator as Navigator & { deviceMemory?: number };
  const memory = nav.deviceMemory ?? 8;           // GB, rounded down by the browser (Chrome only; at most 8)
  const cores = nav.hardwareConcurrency ?? 4;
  const screenPx = (screen.width || 0) * (screen.height || 0);
  const touchOnly = matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
  const weakGpu = /swiftshader|llvmpipe|software|mali|adreno|powervr|intel|mesa|virgl/.test(gpu);
  const strongGpu = /apple m\d|apple gpu|geforce|nvidia|rtx|radeon rx|radeon pro|arc a\d/.test(gpu);
  let q: Quality;
  if (weakGpu || memory < 4 || cores < 4 || touchOnly) q = 'light';
  else if (strongGpu) q = 'full';
  else q = memory >= 8 && cores >= 8 && screenPx > 0 ? 'full' : 'light';
  detected = q;
  return q;
}

/** On a first visit (nothing chosen yet) the detected mode becomes the setting, without marking it chosen. */
export function initQuality(): Quality {
  const s = settings.get();
  if (!s.qualityChosen) {
    const q = detectQuality();
    if (q !== s.quality) settings.set({ quality: q });
  }
  return settings.get().quality;
}

/** The person picked a mode themselves: remember it for later visits. */
export function chooseQuality(q: Quality): void { settings.set({ quality: q, qualityChosen: true }); }

/** Apply everything that can change while the map is running. Safe to call again at any time. */
export function applyQuality(viewer: Viewer, q: Quality = settings.get().quality): void {
  if (viewer.isDestroyed()) return;
  const k = knobs(q);
  const scene = viewer.scene, globe = scene.globe;
  const dpr = window.devicePixelRatio || 1;
  // useBrowserRecommendedResolution is off, so the drawing size is devicePixelRatio x resolutionScale
  const gl = viewer.canvas.getContext('webgl2');
  const ratio = gl ? drawingPixelRatio(gl, viewer.canvas.clientWidth, viewer.canvas.clientHeight, Math.min(dpr, k.maxPixelRatio)) : Math.min(dpr, k.maxPixelRatio);
  viewer.resolutionScale = ratio / dpr;
  globe.maximumScreenSpaceError = k.maxSSE;
  globe.tileCacheSize = k.tileCacheSize;
  globe.preloadAncestors = true;
  globe.preloadSiblings = k.preloadSiblings;
  globe.loadingDescendantLimit = k.loadingDescendantLimit;
  try { scene.msaaSamples = k.msaaSamples; } catch { /* WebGL 1: no MSAA, FXAA below still works */ }
  scene.postProcessStages.fxaa.enabled = k.fxaa || !scene.msaaSupported;
  scene.requestRender();
}

/**
 * Edge smoothing and drawing size while standing on the surface ("Stand here"), where the robot's thin parts
 * (mast, camera head, wheels) sit right in front of you and stair-step easily, and where every ground pixel runs
 * the expensive ground shader (craters, regolith scans, little shadows: ~12 ms of a frame at 2880 x 1800).
 * Full detail: the drawing is at most LANDER_MAX_PX pixels with 2 MSAA samples. The surface shader runs for
 * every ground pixel, so this modest surface-only cap saves work while preserving terrain and photo detail.
 * An external screen at 1x is unchanged unless it exceeds the cap. Smooth: unchanged (FXAA).
 * on = false puts back the map's own setting. Both are set once, while the view fades in or out.
 */
export const LANDER_MAX_PX = 2.1e6;
export function landerAntialias(viewer: Viewer, on: boolean, q: Quality = settings.get().quality): void {
  if (viewer.isDestroyed()) return;
  const scene = viewer.scene, k = knobs(q);
  const dpr = window.devicePixelRatio || 1;
  let res = Math.min(1, k.maxPixelRatio / dpr);
  const css = viewer.canvas.clientWidth * viewer.canvas.clientHeight;
  if (on && q === 'full' && css > 0) {
    const px = css * (dpr * res) ** 2;
    if (px > LANDER_MAX_PX) res *= Math.sqrt(LANDER_MAX_PX / px);
  }
  const gl = viewer.canvas.getContext('webgl2');
  if (gl) res = drawingPixelRatio(gl, viewer.canvas.clientWidth, viewer.canvas.clientHeight, dpr * res) / dpr;
  if (Math.abs(viewer.resolutionScale - res) > 1e-3) viewer.resolutionScale = res;
  if (!scene.msaaSupported) return;
  let samples = k.msaaSamples;
  if (on && q === 'full') samples = 2;
  if (scene.msaaSamples !== samples) { try { scene.msaaSamples = samples; } catch { /* keep what works */ } }
}
