// "Stand here": Street View on the Moon.
//
// You stand on the real NASA terrain at the chosen spot, with your eyes at the height of the
// lander's solar panel / antenna. Everything you see is worked out from the same data as the numbers:
//
//   - Ground and hills: the 3D terrain (NASA LOLA heights) wearing NASA's own photo of the place (the
//     same photo layers as the map), with the orbiter's baked-in shadows taken out (see PhotoMeans) and
//     nothing invented on top.
//   - Light: the real Sun direction for the time on the time bar. Hills cast real shadows: we sweep
//     the height map along the Sun's direction (see TerrainShadows) and hand the result to the
//     ground shader. In shadow the ground stays readable, lit faintly by Earth and by sunlit hills.
//   - Exposure: a light meter (see meter()) sets it from what is in view, like the Apollo cameras.
//   - The dotted line is the skyline the science worker calculated; it sits on the drawn hills.
//
// The camera is ours alone while standing: it only turns (never rolls, never moves), so the horizon
// is always level. Going in and out fades through black, so there is no flying through mountains,
// and "Back to map" returns to exactly the map view you had.
//
// Everything is placed in the rotated display frame (frame.ts); compass directions are TRUE north.

import * as Cesium from 'cesium';
import {
  Appearance, ArcType, BoundingSphere, Cartesian2, Cartesian3, Cartesian4, Cartographic, Color, ComponentDatatype, CustomShader, Geometry, GeometryAttribute,
  GeometryInstance, LightingModel, Material, Matrix4, Model, PolylineDashMaterialProperty, Primitive, PrimitiveType, ShadowMode, UniformType,
  type Entity, type Viewer,
} from 'cesium';
import type { Vec3 } from '../science/ephemeris';
import type { MoonHeights } from '../science/heights';
import '../ui/lander.css';
import { MOON_ELLIPSOID } from './ellipsoid';
import { MOON_R, toCartesian, toTrueLatLon, trueENU, trueToDisplayVec } from './frame';
import { Driver, ROBOT_SCALE, type WalkEnv, type WalkObstacle } from './walk';
import { rockOutlines } from './rockOutline';
import { roverAudio } from '../audio/rover';
import { RobotRig, Dust, type DustLight } from './robotFx';
import { WheelTracks } from './wheelTracks';
import { onLangChange, t as tr } from '../i18n';
import { settings } from '../app/settings';
import { landerAntialias } from '../app/quality';
import { slopePicture } from './groundMaps';
import { SunShadows, SUN_MAP_GLSL, sunMapUniforms, placeContact } from './sunShadow';
import { FAR_ROCKS, FarRocks, type FarSpot } from './farRocks';
import { GroundGovernor, landerTerrainFog } from './groundLod';
import { FAR_GROUND_GLSL } from './groundFar';

export interface LanderSpec { lat: number; lon: number; groundM: number; mastM: number; skyline?: { elevations: Float32Array; stepDeg: number } | null }
/** sun / earth: positions from the Moon's centre in the TRUE Moon frame (metres). */
export interface SkyState { sun: Vec3; earth: Vec3; sunPart: number | null; earthUp: boolean | null }

export interface LanderOptions {
  /**
   * true (default): we draw our own simple Sun and Earth pictures in the 3D scene.
   * false: something else (SpaceSky) draws the real ones; we only draw the small name tags.
   */
  ownBodies?: boolean;
  /**
   * true (default): the ground-lighting shader is installed once at start (switched off on the map),
   * so going into the lander view never has to build shaders, which is what used to freeze the page.
   */
  prewarm?: boolean;
  /** Hills cast real shadows in the lander view (default true). */
  terrainShadows?: boolean;
  /**
   * Told how bright the stars and Milky Way should be (0..1) while standing: low when the ground is in
   * sunshine (a camera set for sunlit ground sees a black sky, as in Apollo photos), 1 in shade or at night,
   * and 1 again after leaving. MoonMap passes it on to SpaceSky.exposure.
   */
  onSkyExposure?(value: number): void;
}

// ---------------------------------------------------------------------------------------------
// A tiny link between the 3D view and the on-screen controls (LanderHud.tsx), so the compass can
// follow the camera every frame without re-drawing the whole page.

export type LanderPhase = 'off' | 'loading' | 'ready' | 'leaving';
const linkListeners = new Set<() => void>();
export const landerLink = {
  /** Compass direction the camera faces (0 = north, 90 = east) and how far up it looks (degrees). */
  az: 0, el: 0,
  /** Width of the view in degrees (smaller = zoomed in). */
  fovDeg: 70,
  phase: 'off' as LanderPhase,
  subscribe(fn: () => void): () => void { linkListeners.add(fn); return () => { linkListeners.delete(fn); }; },
  /** Zoom the lens: +1 = one step closer, -1 = one step wider. */
  zoom(step: number) { zoomHandler?.(step); },
  /** Driving the rover (see walk.ts): the keys drive it; how far it is from the landing spot (m); what stopped it last ('' / 'slope' / 'rock'). */
  walking: false,
  walkDistM: 0,
  walkBlocked: '' as '' | 'slope' | 'rock',
  /** the mouse is captured for looking around (click while walking; Esc gives it back) */
  mouseLocked: false,
  /** when the browser last gave the mouse back (so that Esc does not also leave the view) */
  unlockedAt: 0,
  setWalk(on: boolean) { walkHandler?.(on); },
  /** back to the view from the landing spot (the rover stays where it is) */
  home() { homeHandler?.(); },
  /** where the camera is: at the landing spot, behind the rover, or on the rover's mast */
  view: 'spot' as 'spot' | 'third' | 'first',
  setView(v: 'spot' | 'third' | 'first') { viewHandler?.(v); },
  /** the rover's speed (m/s, rounded for the HUD) */
  speedMs: 0,
  /** headlights: on, off, or by themselves (on when the Sun is down); and whether they are lit right now */
  lights: 'auto' as 'auto' | 'on' | 'off',
  lightsLit: false,
  setLights(v: 'auto' | 'on' | 'off') { if (landerLink.lights === v) return; landerLink.lights = v; lightsHandler?.(); emitLink(); },
  /** the calculated skyline as a faint dotted line (off unless asked for) */
  skyline: false,
  setSkyline(on: boolean) { if (landerLink.skyline === on) return; landerLink.skyline = on; skylineHandler?.(); emitLink(); },
};
let skylineHandler: (() => void) | null = null;
let walkHandler: ((on: boolean) => void) | null = null;
let homeHandler: (() => void) | null = null;
let viewHandler: ((v: 'spot' | 'third' | 'first') => void) | null = null;
let lightsHandler: (() => void) | null = null;
let zoomHandler: ((step: number) => void) | null = null;
const emitLink = () => { linkListeners.forEach(l => l()); };
if (import.meta.env.DEV) (window as unknown as { __landerLink: unknown }).__landerLink = landerLink; // for test scripts

// ---------------------------------------------------------------------------------------------

const DEG = Math.PI / 180;
const EARTH_R = 6371e3;
const FOV_MIN = 20, FOV_MAX = 90, FOV_START = 70;
const EL_MIN = -60, EL_MAX = 90;
const MIN_CLEARANCE_M = 1.5; // the eye is never closer than this to the drawn ground
const FADE_OUT_MS = 170, FADE_IN_MS = 340;
const LOAD_TIMEOUT_MS = 4000, LEAVE_TIMEOUT_MS = 1500;
/** behind the curtain we look round in this many steps (each a view's width) and stop looking round after RING_MS */
const RING_STEPS = 5, RING_MS = 2600, RING_ON = false; // (measured 13 Nov: +2.3 to 3.3 s before the view opens for -25% / +9% tile loads on a 360 turn: off)
const LANDER_SSE = 1.5; // sharper hills than the map (2) while standing on the surface
const BODY_DIST = 5e7; // how far away our own Sun / Earth pictures are placed: far behind every hill, same direction as the real thing

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Keys that drive the rover (and start driving). */
const DRIVE_KEYS = new Set(['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const NO_KEYS = new Set<string>();
const wrap360 = (a: number) => ((a % 360) + 360) % 360;
const svgUrl = (svg: string) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

// Cesium's own GPU texture classes are exported but left out of its TypeScript definitions.
interface GpuTexture { copyFrom(o: { source: { width: number; height: number; arrayBufferView: Uint8Array | Uint16Array } }): void; generateMipmap(): void; destroy(): void }
const Gpu = Cesium as unknown as {
  Texture: new (o: Record<string, unknown>) => GpuTexture;
  Sampler: new (o: Record<string, unknown>) => unknown;
  TextureWrap: { CLAMP_TO_EDGE: number; REPEAT: number };
  TextureMinificationFilter: { LINEAR: number; LINEAR_MIPMAP_LINEAR: number; NEAREST: number };
  TextureMagnificationFilter: { LINEAR: number; NEAREST: number };
  PixelFormat: { RGBA: number };
  PixelDatatype: { FLOAT: number; HALF_FLOAT: number };
  ContextLimits: { maximumTextureFilterAnisotropy: number };
};

// ---------------------------------------------------------------------------------------------
// Real shadows from real hills.
//
// Near the pole the Sun is only a degree or two above the horizon, so a hill 50 km away can put a
// spot in shadow. We keep three square height maps centred on the lander (80 m, 320 m and 1280 m per
// cell: about 10, 41 and 164 km to each side), stored as "height above the flat plane through the
// lander", so the Moon's curve is already included and sunlight travels in straight lines.
//
// For a given Sun direction we turn each map so its rows point at the Sun and walk every row away
// from the Sun, remembering how high the shadow of everything passed so far reaches. The Sun is a
// disc half a degree wide, so we track two shadow lines (from its top and bottom edge): between them
// only part of the Sun shows and the shadow edge is soft. The coarse map hands its shadow lines to
// the finer map at the finer map's sunward edge. Result: one small picture (how much of the Sun each
// piece of ground sees), which the ground shader reads. About 2 ms per Sun position.

const SH_N = 256; // cells per side of each Sun-aligned shadow picture
const SH_SRC = 364; // cells per side of each north-aligned height map (covers the picture at any Sun direction)
const SH_CELL = [80, 320, 1280]; // metres per cell
const SUN_ANG_R = 0.2666; // the Sun's radius in the sky, degrees

class TerrainShadows {
  readonly rgba = new Uint8Array(SH_N * SH_N * 4).fill(255);
  readonly ready = [false, false, false];
  buildMs = 0;
  sweepMs = 0;
  private grids = SH_CELL.map(() => new Float32Array(SH_SRC * SH_SRC));
  private su = SH_CELL.map(() => new Float32Array(SH_N * SH_N));
  private sl = SH_CELL.map(() => new Float32Array(SH_N * SH_N));
  private blurRow = new Uint8Array(SH_N);
  private job: { c: number; row: number } | null = null;
  private detailReady = false;
  private heights: MoonHeights;
  private E: Vec3 = [0, 1, 0];
  private N: Vec3 = [0, 0, 1];
  private U: Vec3 = [1, 0, 0];
  private run = 0;

  constructor(heights: MoonHeights) { this.heights = heights; }

  /** Start building the height maps around a spot (true lat/lon). Work is done in small slices by work(). */
  start(lat: number, lon: number) {
    const φ = lat * DEG, λ = lon * DEG;
    this.E = [-Math.sin(λ), Math.cos(λ), 0];
    this.N = [-Math.sin(φ) * Math.cos(λ), -Math.sin(φ) * Math.sin(λ), Math.cos(φ)];
    this.U = [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];
    this.ready.fill(false);
    this.rgba.fill(255);
    this.buildMs = 0;
    this.job = { c: SH_CELL.length - 1, row: 0 };
    const run = ++this.run;
    this.detailReady = lat > -79.4; // outside the polar map there is no 80 m data to wait for
    if (!this.detailReady) {
      const done = () => { if (run === this.run) this.detailReady = true; };
      this.heights.loadTilesAround(lat, lon, 16000).then(done, done);
    }
  }

  get busy(): boolean { return this.job !== null; }

  /** Build height-map rows for at most `budgetMs`. Returns true when a whole map was finished in this call. */
  work(budgetMs: number): boolean {
    const job = this.job;
    if (!job) return false;
    if (job.c === 0 && !this.detailReady) return false;
    const t0 = performance.now();
    let finished = false;
    while (this.job && performance.now() - t0 < budgetMs) {
      this.buildRow(job.c, job.row);
      if (++job.row >= SH_SRC) {
        this.ready[job.c] = true;
        finished = true;
        if (job.c === 0) this.job = null; else { job.c--; job.row = 0; if (job.c === 0 && !this.detailReady) break; }
      }
    }
    this.buildMs += performance.now() - t0;
    return finished;
  }

  private buildRow(c: number, r: number) {
    const s = SH_CELL[c], g = this.grids[c], h = this.heights, half = SH_SRC / 2, E = this.E, N = this.N, U = this.U;
    const n = ((r - half) * s) / MOON_R; // sample (half, half) sits exactly on the lander
    const detail = c === 0;
    for (let q = 0, k = r * SH_SRC; q < SH_SRC; q++, k++) {
      const e = ((q - half) * s) / MOON_R;
      const rho2 = e * e + n * n;
      if (rho2 > 0.9) { g[k] = -1e7; continue; }
      const up = Math.sqrt(1 - rho2);
      const height = h.heightAtUnit(E[0] * e + N[0] * n + U[0] * up, E[1] * e + N[1] * n + U[1] * up, E[2] * e + N[2] * n + U[2] * up, detail);
      g[k] = (MOON_R + height) * up - MOON_R; // height above the flat plane through the lander's spot on the sphere
    }
  }

  /** Work out the shadows for a Sun direction (compass direction and height above the flat horizon, degrees). */
  sweep(sunAzDeg: number, sunElDeg: number) {
    const t0 = performance.now();
    const sa = Math.sin(sunAzDeg * DEG), ca = Math.cos(sunAzDeg * DEG);
    const el = clamp(sunElDeg, -40, 80);
    const tanU = Math.tan((el + SUN_ANG_R) * DEG), tanL = Math.tan((el - SUN_ANG_R) * DEG);
    const N = SH_N, half = N / 2, srcHalf = SH_SRC / 2, rgba = this.rgba;
    for (let c = SH_CELL.length - 1; c >= 0; c--) {
      if (!this.ready[c]) { for (let k = c; k < rgba.length; k += 4) rgba[k] = 255; continue; }
      const s = SH_CELL[c], grid = this.grids[c], su = this.su[c], sl = this.sl[c];
      const dropU = s * tanU, dropL = s * tanL;
      const outer = c + 1 < SH_CELL.length && this.ready[c + 1] ? c + 1 : -1;
      const ratio = outer >= 0 ? s / SH_CELL[outer] : 0;
      const suO = outer >= 0 ? this.su[outer] : null, slO = outer >= 0 ? this.sl[outer] : null;
      for (let j = 0; j < N; j++) {
        const b = j - half; // in cells from the lander; the Sun is towards +a
        let Su = -1e9, Sl = -1e9;
        if (suO && slO) {
          // shadow lines arriving from outside this map: read them from the coarser map one cell sunward of our edge
          const fi = clamp(half * ratio + half, 0, N - 1.001), fj = clamp(b * ratio + half, 0, N - 1.001);
          const i0 = Math.floor(fi), j0 = Math.floor(fj), tx = fi - i0, ty = fj - j0, k = j0 * N + i0;
          Su = (suO[k] * (1 - tx) + suO[k + 1] * tx) * (1 - ty) + (suO[k + N] * (1 - tx) + suO[k + N + 1] * tx) * ty - dropU;
          Sl = (slO[k] * (1 - tx) + slO[k + 1] * tx) * (1 - ty) + (slO[k + N] * (1 - tx) + slO[k + N + 1] * tx) * ty - dropL;
        }
        for (let i = N - 1; i >= 0; i--) {
          const a = i - half;
          // (a, b) -> east/north cells -> height by bilinear interpolation
          const gx = a * sa + b * ca + srcHalf, gy = a * ca - b * sa + srcHalf;
          const x0 = Math.floor(gx), y0 = Math.floor(gy), tx = gx - x0, ty = gy - y0, k = y0 * SH_SRC + x0;
          const z = (grid[k] * (1 - tx) + grid[k + 1] * tx) * (1 - ty) + (grid[k + SH_SRC] * (1 - tx) + grid[k + SH_SRC + 1] * tx) * ty;
          const vis = z >= Sl ? 1 : z <= Su ? 0 : (z - Su) / (Sl - Su);
          const o = j * N + i;
          rgba[o * 4 + c] = Math.round(vis * 255);
          if (z > Su) Su = z;
          if (z > Sl) Sl = z;
          su[o] = Su; sl[o] = Sl;
          Su -= dropU; Sl -= dropL;
        }
      }
      // Soften shadow edges across the Sun's direction: each row is worked out on its own, and an 80 m
      // cell would otherwise draw long, ruler-straight stripes on the ground when the Sun is this low.
      const tmp = this.blurRow;
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) tmp[j] = rgba[(j * N + i) * 4 + c];
        for (let j = 0; j < N; j++) {
          const a = tmp[j > 0 ? j - 1 : 0], b = tmp[j], d = tmp[j < N - 1 ? j + 1 : N - 1];
          rgba[(j * N + i) * 4 + c] = (a + 2 * b + d + 2) >> 2;
        }
      }
    }
    this.sweepMs = performance.now() - t0;
  }

  /**
   * The finest height map as a picture the ground shader can read (16-bit height in the red and green
   * channels), so it can work out smooth ground slopes itself. `range` is the height span in metres.
   */
  packHeights(): { rgba: Uint8Array; size: number; span: number; range: number } | null {
    if (!this.ready[0]) return null;
    const g = this.grids[0], n = g.length;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < n; k++) { const z = g[k]; if (z > -1e6) { if (z < lo) lo = z; if (z > hi) hi = z; } }
    const range = Math.max(1, hi - lo), out = new Uint8Array(n * 4);
    for (let k = 0; k < n; k++) {
      const v = Math.round((clamp(g[k], lo, hi) - lo) / range * 65535);
      out[4 * k] = v >> 8; out[4 * k + 1] = v & 255; out[4 * k + 3] = 255;
    }
    return { rgba: out, size: SH_SRC, span: SH_SRC * SH_CELL[0], range };
  }

  /** The 80 m map's slopes, for the ground shader (see slopePicture). */
  packSlopes(): { half: Uint16Array; size: number; span: number } | null {
    if (!this.ready[0]) return null;
    const half = slopePicture(this.grids[0], SH_SRC, SH_CELL[0]);
    return half ? { half, size: SH_SRC, span: SH_SRC * SH_CELL[0] } : null;
  }

  /**
   * Ground height (m above the lander's flat plane) at e / n metres east / north of the lander, from the
   * finest map that covers it (bilinear), or NaN outside them all. `cell` gets that map's cell size.
   */
  zAt(e: number, n: number, cell?: { s: number }): number {
    const half = SH_SRC / 2;
    for (let c = 0; c < SH_CELL.length; c++) {
      if (!this.ready[c]) continue;
      const s = SH_CELL[c], fx = e / s + half, fy = n / s + half;
      if (fx < 1 || fy < 1 || fx > SH_SRC - 2 || fy > SH_SRC - 2) continue;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, g = this.grids[c], k = y0 * SH_SRC + x0;
      if (cell) cell.s = s;
      return (g[k] * (1 - tx) + g[k + 1] * tx) * (1 - ty) + (g[k + SH_SRC] * (1 - tx) + g[k + SH_SRC + 1] * tx) * ty;
    }
    return NaN;
  }

  /** How much of the Sun the ground sees at e / n metres from the lander (0..1), from the last sweep. */
  visAt(e: number, n: number, sunAzDeg: number): number {
    const sa = Math.sin(sunAzDeg * DEG), ca = Math.cos(sunAzDeg * DEG), half = SH_N / 2;
    const a = e * sa + n * ca, b = e * ca - n * sa; // towards the Sun, and across
    for (let c = 0; c < SH_CELL.length; c++) {
      if (!this.ready[c]) continue;
      const i = Math.round(a / SH_CELL[c] + half), j = Math.round(b / SH_CELL[c] + half);
      if (i < 0 || j < 0 || i >= SH_N || j >= SH_N) continue;
      return this.rgba[(j * SH_N + i) * 4 + c] / 255;
    }
    return 1;
  }

  /** How much of the Sun the ground at the lander sees (0..1), or null before any map is ready. */
  here(): number | null {
    const c = this.ready[0] ? 0 : this.ready[1] ? 1 : this.ready[2] ? 2 : -1;
    if (c < 0) return null;
    return this.rgba[((SH_N / 2) * SH_N + SH_N / 2) * 4 + c] / 255;
  }
}

// ---------------------------------------------------------------------------------------------
// How bright the photo is "on average" around the lander.
//
// NASA's south-pole photo mosaic was taken with the Sun low and in many different directions, so most
// of its large brightness changes are not the ground's colour but the orbiter's own sunlight and shadow
// (whole hillsides are black in it). To light the place with OUR Sun we divide the photo by its own
// average over ~100 m: what is left is the real small detail (craters, boulder fields, bright and dark
// soil), which the real light then shades. The averages come from the same mosaic, stored with the app
// (public/data/polar/t, the 74 m and 297 m per pixel levels), resampled onto two square maps centred on
// the lander like the shadow maps: 60 m cells (15 km across) and 480 m cells (123 km across).

const PM_N = 256;
const PM_CELL = [60, 480];
const PM_K = [4, 2]; // pyramid level read for each map
const PM_HALF = 304000, PM_TILE = 512;

class PhotoMeans {
  /** r, g = average photo brightness (fine, coarse map); b, a = 255 where that map has data. */
  readonly rgba = new Uint8Array(PM_N * PM_N * 4);
  ready = false;
  /** true when the lander is inside the stored south-pole photo square at all */
  covered = false;
  buildMs = 0;
  private run = 0;
  private base: string;
  private index: Promise<Map<number, Set<number>> | null> | null = null;
  private tiles = new Map<string, Promise<Uint8Array | null>>();

  constructor(base: string) { this.base = base.replace(/\/?$/, '/'); }

  private listed(): Promise<Map<number, Set<number>> | null> {
    this.index ??= fetch(`${this.base}index.json`).then(r => (r.ok ? r.json() : null)).then((j: { tilePx?: number; halfM?: number; levels?: Record<string, { runs?: number[][] }> } | null) => {
      if (!j || j.tilePx !== PM_TILE || j.halfM !== PM_HALF || !j.levels) return null;
      const out = new Map<number, Set<number>>();
      for (const k of PM_K) {
        const set = new Set<number>(), n = 2 ** k;
        for (const [row, c0, c1] of j.levels[String(k)]?.runs ?? []) for (let c = c0; c <= c1; c++) set.add(row * n + c);
        out.set(k, set);
      }
      return out;
    }).catch(() => null);
    return this.index;
  }

  private tile(k: number, col: number, row: number): Promise<Uint8Array | null> {
    const key = `${k}/${col}_${row}`;
    let p = this.tiles.get(key);
    if (!p) {
      p = fetch(`${this.base}${key}.jpg`).then(r => (r.ok && (r.headers.get('content-type') ?? '').startsWith('image/') ? r.blob() : null))
        .then(b => (b ? createImageBitmap(b) : null))
        .then(bmp => {
          if (!bmp) return null;
          const c = new OffscreenCanvas(PM_TILE, PM_TILE), g = c.getContext('2d', { willReadFrequently: true });
          if (!g) return null;
          g.drawImage(bmp, 0, 0, PM_TILE, PM_TILE);
          bmp.close();
          const d = g.getImageData(0, 0, PM_TILE, PM_TILE).data, out = new Uint8Array(PM_TILE * PM_TILE);
          for (let i = 0; i < out.length; i++) out[i] = d[4 * i + 1]; // grey pictures: any channel
          return out;
        })
        .catch(() => null);
      this.tiles.set(key, p);
    }
    return p;
  }

  /** Average photo brightness (0..1) at e / n metres from the lander, from the finest map with data there; NaN where there is none. */
  meanAt(e: number, n: number): number {
    if (!this.ready || !this.covered) return NaN;
    const half = PM_N / 2;
    for (let m = 0; m < PM_K.length; m++) {
      const q = Math.round(e / PM_CELL[m] + half), r = Math.round(n / PM_CELL[m] + half);
      if (q < 0 || r < 0 || q >= PM_N || r >= PM_N) continue;
      const o = (r * PM_N + q) * 4;
      if (this.rgba[o + 2 + m]) return this.rgba[o + m] / 255;
    }
    return NaN;
  }

  /** Build both maps around a true lat/lon. Resolves when done (or when there is nothing to build). */
  async start(lat: number, lon: number): Promise<void> {
    const run = ++this.run;
    this.ready = false;
    this.rgba.fill(0);
    const φ = lat * DEG, λ = lon * DEG;
    const E: Vec3 = [-Math.sin(λ), Math.cos(λ), 0];
    const N: Vec3 = [-Math.sin(φ) * Math.cos(λ), -Math.sin(φ) * Math.sin(λ), Math.cos(φ)];
    const U: Vec3 = [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];
    const polar = (e: number, n: number): [number, number] => {
      const up = Math.sqrt(Math.max(0, 1 - e * e - n * n));
      const ux = E[0] * e + N[0] * n + U[0] * up, uy = E[1] * e + N[1] * n + U[1] * up, uz = E[2] * e + N[2] * n + U[2] * up;
      const f = (2 * MOON_R) / (1 - uz);
      return [f * uy, f * ux];
    };
    const [x0, y0] = polar(0, 0);
    this.covered = Math.abs(x0) < PM_HALF - 2000 && Math.abs(y0) < PM_HALF - 2000;
    if (!this.covered) { this.ready = true; return; }
    const index = await this.listed();
    if (run !== this.run) return;
    if (!index) { this.covered = false; this.ready = true; return; }
    this.buildMs = 0;
    for (let m = 0; m < PM_K.length; m++) {
      const k = PM_K[m], n = 2 ** k, S = (2 * PM_HALF) / n, px = S / PM_TILE, cell = PM_CELL[m], half = PM_N / 2;
      // which squares does this map touch? (corners + centre of the map, padded by one pixel)
      const need = new Set<number>();
      const reach = (half + 1) * cell / MOON_R;
      for (const [a, b] of [[-1, -1], [-1, 1], [1, -1], [1, 1], [0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const [x, y] = polar(a * reach, b * reach);
        for (const dx of [-px, px]) for (const dy of [-px, px]) {
          const col = Math.floor((x + dx + PM_HALF) / S), row = Math.floor((PM_HALF - y - dy) / S);
          if (col >= 0 && row >= 0 && col < n && row < n) need.add(row * n + col);
        }
      }
      // (a 123 km map near the pole can touch more squares than the 9 points find: add the box between them)
      const cols = [...need].map(v => v % n), rows = [...need].map(v => Math.floor(v / n));
      for (let r = Math.min(...rows); r <= Math.max(...rows); r++) for (let c = Math.min(...cols); c <= Math.max(...cols); c++) need.add(r * n + c);
      const listedHere = index.get(k) ?? new Set<number>();
      const got = new Map<number, Uint8Array>();
      await Promise.all([...need].filter(v => listedHere.has(v)).map(async v => { const t = await this.tile(k, v % n, Math.floor(v / n)); if (t) got.set(v, t); }));
      if (run !== this.run) return;
      const t1 = performance.now();
      const at = (gx: number, gy: number): number => { // one pixel of the whole level (global pixel coordinates), -1 if missing
        const col = Math.floor(gx / PM_TILE), row = Math.floor(gy / PM_TILE);
        const t = col >= 0 && row >= 0 && col < n && row < n ? got.get(row * n + col) : undefined;
        return t ? t[(gy - row * PM_TILE) * PM_TILE + (gx - col * PM_TILE)] : -1;
      };
      const rgba = this.rgba;
      for (let r = 0; r < PM_N; r++) {
        const nn = ((r - half) * cell) / MOON_R;
        for (let q = 0; q < PM_N; q++) {
          const [x, y] = polar(((q - half) * cell) / MOON_R, nn);
          const fx = (x + PM_HALF) / px - 0.5, fy = (PM_HALF - y) / px - 0.5;
          const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
          const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
          const o = (r * PM_N + q) * 4;
          if (a < 0 || b < 0 || c < 0 || d < 0) { rgba[o + m] = 0; rgba[o + 2 + m] = 0; continue; }
          rgba[o + m] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty);
          rgba[o + 2 + m] = 255;
        }
      }
      this.buildMs += performance.now() - t1;
    }
    this.buildMs = Math.round(this.buildMs);
    this.ready = true;
  }
}

// ---------------------------------------------------------------------------------------------
// The ground shader: NASA's own photo of the place, lit by the real Sun.
//
// Cesium normally draws the photo and lets a globe "material" blend a colour over it. We read the photo
// ourselves (computeDayColor is Cesium's own function that samples the photo layers; GlobeFS declares it
// and defines it after our code, so a matching declaration is enough) and draw
//     colour = camera(light) * albedo,   albedo = photo / (its average around here) * a little of that average
//   - light = sunlight on this piece of ground (its real slope from NASA heights, whether a hill blocks
//     the Sun, and how moon dust reflects: bright seen down-sun, darker towards the Sun) + faint blue
//     light from Earth + a little light bounced off sunlit hills;
//   - camera() is an exposure with a soft shoulder, like the Apollo and Chang'e surface cameras;
//   - albedo keeps all the photo's small detail (craters, boulder fields, bright and dark soil) but not
//     the orbiter's own large shadows, which came from a different Sun and would fight the real light
//     (see PhotoMeans). Where no averages exist (far away, or away from the south pole) the photo's
//     brightness is kept but squeezed, for the same reason. In shade more of it is kept, so the place
//     stays recognisable by Earthlight.
// Nothing is invented: no noise, no fake pebbles. Switched off (lvOn = 0) the map photo is untouched.

const GROUND_SHADER = `
vec4 computeDayColor(vec4 initialColor, vec3 textureCoordinates, float nightBlend);

// How much of the Sun this piece of ground sees (see TerrainShadows): finest map that covers it.
float lvShadow(vec2 ab) {
    const float lvHalfTexel = 0.5 + 0.5 / 256.0;
    float m = max(abs(ab.x), abs(ab.y));
    float vis = 1.0;
    vec3 halfSpan = lvSpan * 0.5;
    if (m < halfSpan.z) {
        vis = mix(texture(lvShadowTex, ab / lvSpan.z + lvHalfTexel).b, 1.0, smoothstep(0.85, 1.0, m / halfSpan.z));
    }
    if (m < halfSpan.y) {
        vis = mix(texture(lvShadowTex, ab / lvSpan.y + lvHalfTexel).g, vis, smoothstep(0.85, 1.0, m / halfSpan.y));
    }
    if (m < halfSpan.x) {
        vis = mix(texture(lvShadowTex, ab / lvSpan.x + lvHalfTexel).r, vis, smoothstep(0.85, 1.0, m / halfSpan.x));
    }
    return vis;
}
// Ground slope (dh/de, dh/dn) at a point given in metres east / north of the lander, from the 80 m height
// map: a half-float picture of each cell's slope (see slopePicture), blended by the GPU in one read.
vec2 lvSlope(vec2 en) {
    return texture(lvHeightTex, en / lvHeightInfo.x + (0.5 + 0.5 / 364.0)).rg;
}
// The photo's average brightness around a point (see PhotoMeans); the photo itself where no map covers it.
float lvMean(vec2 en, float photo) {
    const float lvHalfTexel = 0.5 + 0.5 / 256.0;
    float m = max(abs(en.x), abs(en.y));
    float M = photo;
    vec2 halfSpan = lvMeanSpan * 0.5;
    if (m < halfSpan.y) {
        vec4 t = texture(lvMeanTex, en / lvMeanSpan.y + lvHalfTexel);
        M = mix(M, t.g / max(t.a, 0.004), t.a * (1.0 - smoothstep(0.75, 1.0, m / halfSpan.y)));
    }
    if (m < halfSpan.x) {
        vec4 t = texture(lvMeanTex, en / lvMeanSpan.x + lvHalfTexel);
        M = mix(M, t.r / max(t.b, 0.004), t.b * (1.0 - smoothstep(0.75, 1.0, m / halfSpan.x)));
    }
    return M;
}
// ---- The ground under your feet: real photo-scanned lunar regolith (Poly Haven, CC0) ----------------
// No orbiter sees anything smaller than a metre, so the near ground uses scans of real regolith-like soil
// (public/lander/regolith_*.webp: R,G = surface slope as a normal map, B = height). The scans are laid
// down at four sizes (3 m, 13 m, 50 m and 200 m tiles; craters come in every size on the Moon), each turned
// differently so the repeats do not line up, and each fades out with distance (the grain within ~20 m, as in
// Apollo photos, where the middle distance is smooth ground with small craters).
// They only change the SHAPE of the ground (slopes and little shadows), lit by the same real Sun; how bright
// the ground is stays the NASA photo's business.
vec2 lvRot(vec2 p, vec2 cs) { return vec2(cs.x * p.x - cs.y * p.y, cs.y * p.x + cs.x * p.y); }
// Smooth (cubic B-spline) sampling for a scan blown up bigger than the screen pixels: plain linear
// sampling would draw its texels as little flat facets with straight edges.
vec4 lvCubic(sampler2D tex, vec2 uv) {
    vec2 size = vec2(textureSize(tex, 0));
    vec2 p = uv * size - 0.5, i = floor(p), f = p - i;
    vec2 f2 = f * f, f3 = f2 * f;
    vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0, w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0, w3 = f3 / 6.0;
    vec2 g0 = w0 + w1, g1 = w2 + w3;
    vec2 h0 = (i - 0.5 + w1 / g0) / size, h1 = (i + 1.5 + w3 / g1) / size;
    return g0.y * (g0.x * textureLod(tex, vec2(h0.x, h0.y), 0.0) + g1.x * textureLod(tex, vec2(h1.x, h0.y), 0.0))
         + g1.y * (g0.x * textureLod(tex, vec2(h0.x, h1.y), 0.0) + g1.x * textureLod(tex, vec2(h1.x, h1.y), 0.0));
}
// one layer: slope (dh/de, dh/dn) and height (m), filtered for this pixel. L = (1 / tile size, cos, sin, height span);
// mag = screen pixel / scan texel (below 1 the scan is blown up)
vec3 lvLayer(sampler2D tex, vec2 en, vec4 L, float gain, float mag) {
    vec2 uv = lvRot(en, L.yz) * L.x;
    // (the detail governor lowers both limits: fewer pixels pay for the smooth reads while the view moves)
    float m0 = 0.6 * lvLod.x, m1 = 0.9 * lvLod.x + 1e-3;
    vec4 t = mag > m1 ? texture(tex, uv) : mag < m0 ? lvCubic(tex, uv) : mix(lvCubic(tex, uv), texture(tex, uv), (mag - m0) / (m1 - m0));
    vec2 n = t.rg * 2.0 - 1.0;
    float nz = sqrt(max(1.0 - dot(n, n), 0.09));
    vec2 g = -n / nz * gain;
    return vec3(L.y * g.x + L.z * g.y, -L.z * g.x + L.y * g.y, (t.b - 0.5) * L.w);
}
float lvLayerH(sampler2D tex, vec2 en, vec4 L, float lod) {
    return (textureLod(tex, lvRot(en, L.yz) * L.x, max(lod, 0.7)).b - 0.5) * L.w;
}
// height of all layers together at a point, smoothed over about \`blur\` metres
float lvDetailH(vec2 en, vec4 w, float blur) {
    // (a layer smoothed over more than a tenth of its tile is flat: skip it)
    float h = 0.0;
    vec4 b = blur * vec4(lvL1.x, lvL2.x, lvL3.x, lvL4.x);
    if (w.x > 0.0 && b.x < 0.1) h += w.x * lvLayerH(lvDA, en, lvL1, log2(max(b.x * 2048.0, 1.0)));
    if (w.y > 0.0 && b.y < 0.1) h += w.y * lvLayerH(lvDB, en, lvL2, log2(max(b.y * 2048.0, 1.0)));
    if (w.z > 0.0 && b.z < 0.1) h += w.z * lvLayerH(lvDC, en, lvL3, log2(max(b.z * 2048.0, 1.0)));
    if (w.w > 0.0 && b.w < 0.1) h += w.w * lvLayerH(lvDC, en, lvL4, log2(max(b.w * 2048.0, 1.0)));
    return h;
}

${SUN_MAP_GLSL}
// The rocks lying around (see placeRocks): their shadows and the slightly darker ground hugging each
// rock, drawn into a small picture on the CPU (rasterRocks): a fine one near you, a coarse one further out.
float lvRockShade(vec2 en, inout float ao) {
    float m = max(abs(en.x), abs(en.y));
    vec2 halfSpan = lvRocks.zw * 0.5;
    float lit = 1.0;
    if (m < halfSpan.y) {
        vec4 t = texture(lvRockTex, en / lvRocks.w + 0.5);
        float k = smoothstep(0.9, 1.0, m / halfSpan.y);
        lit = mix(t.b, 1.0, k); ao = mix(t.a, 1.0, k);
    }
    if (m < halfSpan.x) {
        vec4 t = texture(lvRockTex, en / lvRocks.z + 0.5);
        float k = smoothstep(0.9, 1.0, m / halfSpan.x);
        lit = mix(t.r, lit, k); ao = mix(t.g, ao, k);
    }
    return lit;
}

// ---- Craters at every scale --------------------------------------------------------------------------
// The Moon is craters at every size, but NASA's heights stop at 80 m (south pole) or 1.9 km (elsewhere)
// and the photos at ~1-100 m, so a few hundred metres out the ground looked like smooth grey felt. Here
// craters are laid down by their real statistics, the same for the same place every time: in square cells
// of 8, 31, 122 m (and, away from the pole where the heights are coarse, 475 m and 1.85 km), about every other
// cell holds one crater 16-56 % of the cell across, most of them old and shallow (depth 4-8 % of the width), a
// few fresh and deep (up to 20 %) with a light halo of fresh dust, each a bowl with a raised rim and an ejecta
// apron. They only shade the real hills (no height is added), with the real Sun, and the bowl's own shadow is
// worked out exactly (the sunbeam from a point inside must clear the rim). They are a stand-in for the real ones.
vec3 lvHash3(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yxz + 33.33);
    return fract((q.xxy + q.yzz) * q.zyx);
}
// ---- Gentle rolling between the craters -------------------------------------------------------------
// Smooth noise with its slope worked out exactly (so it shades without any extra texture reads), at three
// sizes (40, 160, 640 m), each faded once its bumps get smaller than a few pixels. Slopes of a few degrees.
vec3 lvNoiseD(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
    float a = lvHash3(i).x, b = lvHash3(i + vec2(1.0, 0.0)).x, c = lvHash3(i + vec2(0.0, 1.0)).x, d = lvHash3(i + vec2(1.0, 1.0)).x;
    float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
    return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
}
vec2 lvRough(vec2 en, float fp, float scales) {
    vec2 g = vec2(0.0);
    for (int i = 0; i < 3; i++) {
        float S = 40.0 * pow(4.0, float(i));
        float wr = 1.0 - smoothstep(0.02 * S, 0.06 * S, fp);
        if (wr <= 0.0) continue;
        // (the 640 m size is already in the 80 m polar heights)
        if (scales < 3.5 && i == 2) break;
        vec3 n = lvNoiseD(en / S + float(i) * 7.31);
        g += wr * 0.09 * n.yz; // about 5 degrees at the steepest
    }
    return g;
}
${FAR_GROUND_GLSL}

// one scale of craters at p (m): xy = height slope, z = height (m), w = how much of the Sun reaches p (0..1).
// One cell per scale (the cost of this function is most of the ground's): each scale's grid is turned by its own
// angle (rot = cos, sin) so the grids never line up, and a crater stays inside its own cell (its centre may wander
// as far as its ejecta allows), so only the cell under p has to be read. Sizes: R = 0.08..0.22 S, most of them
// small (many small, few large, as on the Moon; with one crater per cell at every scale the count above a size
// grows as 1 / size^2, the Moon's "saturated" crater fields).
vec4 lvCraterScale(vec2 p, float S, float seed, vec2 rot, vec2 sdir, float tanE, inout float alb, float wc) {
    vec4 acc = vec4(0.0, 0.0, 0.0, 1.0);
    vec2 qc = lvRot(p, rot) / S;
    vec2 cell = floor(qc);
    vec3 r = lvHash3(cell + seed);
    if (r.z > lvCraters.z) return acc; // an empty cell
    float sz = r.z / lvCraters.z;
    float R = S * 0.08 * pow(2.75, sz * sz);
    float j = 1.0 - 3.6 * R / S; // how far the centre may wander and keep the ejecta (1.8 R) in the cell
    vec2 dq = (qc - cell - 0.5 - (r.xy - 0.5) * j) * S;
    vec2 d = lvRot(dq, vec2(rot.x, -rot.y)); // back to east / north
    vec2 ctr = p - d;
    {
        float x2 = dot(d, d) / (R * R);
        if (x2 > 3.24) return acc; // beyond the ejecta (1.8 radii)
        // never a made-up crater under the landing spot: it could put the lander in a shadow the real
        // terrain (and our sunlight numbers) do not have
        vec2 dl = lvCraterKeep.xy - ctr;
        if (dot(dl, dl) < 3.4 * R * R) return acc;
        float fresh = fract(dot(r.xy, vec2(41.31, 27.17))); fresh *= fresh; fresh *= fresh * fresh; // most small craters are old and shallow, a few are fresh
        float depth = 2.0 * R * mix(0.035, 0.18, fresh) * lvCraters.w, rim = 2.0 * R * mix(0.005, 0.035, fresh) * lvCraters.w;
        // bowl inside, apron outside, both flat at the crest (x = 1) and the apron flat where it ends (x = 1.8):
        // height and slope are continuous everywhere, so no line can show at the rim at any Sun angle
        float x = sqrt(x2), h, dhdr;
        if (x < 1.0) {
            float u = 1.0 - x2;
            h = rim - (depth + rim) * u * u; dhdr = 4.0 * (depth + rim) * x * u / R;
        } else {
            float t = min((x - 1.0) / 0.8, 1.0), q = 1.0 - t;
            h = rim * (1.0 + 3.0 * t) * q * q * q; dhdr = -12.0 * rim * t * q * q / (0.8 * R);
        }
        acc.xy += dhdr * d / max(x * R, 1e-4);
        acc.z += h;
        // fresh craters threw out bright, less weathered dust: a light halo that fades as the crater ages
        alb *= 1.0 + wc * 0.12 * fresh * (1.0 - smoothstep(0.7, 1.7, x));
        if (x < 1.0 && tanE < 2.0) {
            // the sunbeam from here leaves the bowl at the rim; is the rim in the way?
            float b = dot(d, sdir), c = dot(d, d) - R * R;
            float tOut = -b + sqrt(max(b * b - c, 0.0));
            float clear = h + tOut * tanE - rim;
            // (a shadowed floor still gets a little light back from the sunlit far wall)
            // (the soft edge lies below the rim line, so a point on the crest itself is lit, like the ground outside)
            acc.w = min(acc.w, mix(0.1, 1.0, smoothstep(-0.04 * R - tOut * 0.0093, 0.0, clear)));
        }
    }
    return acc;
}

// The rover's headlights (eye coordinates: lvLampPos is where they are, lvLampDir where they point; the beam's
// edge and middle are cosines in lvLamp.yz). Returned already "exposed": they are the light the camera is set for at night.
vec3 lvLampLight(vec3 P, vec3 N) {
    vec3 d = lvLampPos - P;
    float r = length(d);
    vec3 l = d / max(r, 0.01);
    float spot = smoothstep(lvLamp.y, lvLamp.z, dot(-l, lvLampDir));
    return vec3(1.0, 0.95, 0.88) * (lvLamp.x * spot * max(dot(N, l), 0.0) * 9.0 / (r * r + 1.0));
}

czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);
    material.diffuse = vec3(0.0);
    material.alpha = 0.0;
    if (lvOn < 0.5) {
        return material;
    }
    vec3 toEye = materialInput.positionToEyeEC;
    float dist = length(toEye);
    vec3 V = toEye / max(dist, 0.01);
    vec3 N = normalize(materialInput.normalEC);
    vec3 L = normalize(czm_viewRotation * lvSunDir);
    vec3 Ee = czm_viewRotation * lvEast;
    vec3 Ne = czm_viewRotation * lvNorth;
    vec3 Ue = czm_viewRotation * lvUp;
    // metres east / north of the map centre (the landing spot): the eye's own place there (lvWalk.xy, 0 unless
    // walking) plus this piece of ground's offset from the eye
    vec2 en = lvWalk.xy + vec2(dot(-toEye, Ee), dot(-toEye, Ne));
    // ground size of one screen pixel (m), across the line of sight (the short side of its footprint)
    vec2 dx = dFdx(en), dy = dFdy(en);
    float fp = max(min(length(dx), length(dy)), 1e-4);
    float fpMax = max(max(length(dx), length(dy)), fp); // ...and along it (much longer when looking across the ground)

    // Near the lander, take the slope of the ground straight from the height picture. (The 3D tiles
    // store slopes rounded to about half a degree, which shows as flat patches when the Sun is this low.)
    if (lvHeightInfo.x > 0.0) {
        float edge = max(abs(en.x), abs(en.y)) / (0.5 * lvHeightInfo.x);
        if (edge < 0.97) {
            vec2 sl = lvSlope(en);
            vec3 Nh = normalize(Ue - sl.x * Ee - sl.y * Ne);
            N = normalize(mix(Nh, N, smoothstep(0.8, 0.97, edge)));
        }
    }
    vec2 az = lvSunAz;
    float vis = lvShadow(vec2(dot(en, az), dot(en, vec2(az.y, -az.x))));
    float rockAo = 1.0;
    // the robot's and the rocks' shadows: the real Sun shadow map near you (sunShadow.ts), the CPU rock picture beyond it
    float shFw = 0.0;
    float shMap = lvSunMap(-toEye, N, L, shFw);
    float shRock = lvRocks.x > 0.0 ? lvRockShade(en - lvWalk.zw, rockAo) : 1.0;
    vis *= mix(shRock, shMap, shFw);
    float contact = lvContact(en);
    rockAo *= contact;
    float a = degrees(acos(clamp(dot(L, V), -1.0, 1.0))); // phase angle: Sun - ground - eye

    // The small-scale ground (see lvLayer): its slopes, and the little shadows its lumps and craters cast.
    vec3 Nd = N;
    float micro = 1.0, cavity = 1.0, wD = 0.0, craterLit = 1.0, craterAlb = 1.0;
    vec3 Te = normalize(Ee - dot(Ee, N) * N), Tn = normalize(Ne - dot(Ne, N) * N);
    vec3 g = vec3(0.0);
    vec4 w = vec4(0.0);
    bool near = lvDetail.x > 0.5 && dist < lvFade.w;
    if (near) {
        w = (1.0 - smoothstep(lvFade * 0.3, lvFade, vec4(dist))) * lvDetail.x;
        vec4 mag = fp * 2048.0 * vec4(lvL1.x, lvL2.x, lvL3.x, lvL4.x);
        if (w.x > 0.0) g += w.x * lvLayer(lvDA, en, lvL1, lvGain.x, mag.x);
        if (w.y > 0.0) g += w.y * lvLayer(lvDB, en, lvL2, lvGain.y, mag.y);
        if (w.z > 0.0) g += w.z * lvLayer(lvDC, en, lvL3, lvGain.z, mag.z);
        // (the largest, gentlest scan never shows its texels as facets: plain filtering, a quarter of the reads)
        if (w.w > 0.0) g += w.w * lvLayer(lvDC, en, lvL4, lvGain.w, 1.0);
    }
    // craters (see lvCraterScale) at every distance, each scale faded out before its craters get smaller than a
    // few pixels. The size that counts is the pixel's footprint on the ground averaged over both directions
    // (fpE): far away a pixel covers a long strip of ground along the line of sight, so a crater there shows as a
    // flat streak, a few pixels tall at least (never a dot that sparkles); its short side alone (fp) would keep
    // craters far too long ("dark lens spots" on the horizon).
    float fpE = sqrt(fp * fpMax);
    // Below the smallest size still drawn, craters do not vanish: they are too small to see one by one but their
    // shadows still darken the ground, more the lower the Sun (an unresolved rough surface, as in Hapke's model of
    // the Moon). unres = how much of the crater sizes this pixel can no longer show (0 near you, 1 far away).
    float unres = 0.0;
    if (lvCraters.x > 0.5) {
        vec2 Lh0 = vec2(dot(L, Te), dot(L, Tn));
        float lh0 = max(length(Lh0), 1e-3);
        vec2 sdir = Lh0 / lh0;
        float tanE = dot(N, L) / lh0;
        unres = smoothstep(0.03, 0.4, fpE * lvLod.y);
        for (int i = 0; i < 6; i++) {
            if (float(i) >= lvCraters.y) break;
            float S = 8.0 * pow(3.9, float(i)); // 8, 31, 122, 475, 1850, 7200 m cells
            float wc = 1.0 - smoothstep(0.012 * S, 0.04 * S, fpE * lvLod.y);
            if (wc <= 0.0) continue;
            float ang = 1.1 + 2.39996 * float(i); // a different turn of the grid for each size
            vec4 c = lvCraterScale(en, S, 17.0 * float(i + 1), vec2(cos(ang), sin(ang)), sdir, tanE, craterAlb, wc);
            g.xy += wc * c.xy;
            if (vis > 0.0 && dot(N, L) > 0.0) craterLit = min(craterLit, mix(1.0, c.w, wc));
        }
    }
    // gentle rolling and hummocks between the craters (a few degrees of slope, as measured by orbiting
    // lasers), at the sizes the height map is too coarse to show; faded like the craters
    if (lvCraters.x > 0.5) g.xy += lvRough(en, fpE * lvLod.y, lvCraters.y);
    if (near || lvCraters.x > 0.5) {
        Nd = normalize(N - g.x * Te - g.y * Tn);
        // A lump's far side is hidden behind the lump itself, but a flat ground drawn with bumpy shading
        // would still show it (as black streaks when you look across the ground, like ripples on water).
        // Turn such facets towards the eye, as the facets you really see there do.
        float nv = dot(Nd, V);
        if (nv < 0.25) Nd = normalize(Nd + (0.25 - nv) * V);
    }
    if (near) {
        wD = max(max(w.x, w.y), max(w.z, w.w));
        float span = dot(w, vec4(lvL1.w, lvL2.w, lvL3.w, lvL4.w));
        cavity = clamp(1.0 + lvDetail.z * g.z / max(span, 1e-5), 0.55, 1.25);
        // little cast shadows: walk from this point towards the Sun over the detail heights
        float muL = dot(N, L);
        vec2 Lh = vec2(dot(L, Te), dot(L, Tn));
        float lh = length(Lh);
        // (the walk's reach: lvWalkQ.x, shorter while moving (stepMarch), and shorter again when the detail governor sheds)
        float reach = lvWalkQ.x * (0.4 + 0.6 * lvLod.x);
        if (vis > 0.0 && muL > -0.01 && lh > 1e-3 && a > 1.0 && dist < reach) {
            vec2 dirH = Lh / lh;
            float tanE = muL / lh;
            // (heights smoothed over the whole pixel: a pixel far away covers a long strip of ground, and
            // tracing one point of it would sprinkle the view with flickering lines)
            float h0 = lvDetailH(en, w, fpMax);
            // nothing can rise higher than this above h0, so the walk can stop once the sunbeam is above it
            float top = 0.5 * dot(w, vec4(lvL1.w, lvL2.w, lvL3.w, lvL4.w)) - h0;
            float t = max(0.005, fp * 0.7), m = 1.0;
            for (int k = 0; k < 8; k++) {
                float dh = lvDetailH(en + dirH * t, w, max(t * 0.3, fpMax)) - h0;
                // (steps past the 4th count less as the detail governor sheds detail, and stop at its lowest)
                float mk = clamp(0.5 + (t * tanE - dh) / (t * 0.0093 + 0.002), 0.0, 1.0);
                m = min(m, k < 4 ? mk : mix(1.0, mk, lvLod.x));
                t *= 2.0;
                if (m < 0.01 || t > lvDetail.w || t * tanE > top || (k >= 3 && lvLod.x < 0.02)) break;
            }
            // shadows hide behind their own lumps when the Sun is behind you; faded out (not cut) at the
            // walk's reach, which shrinks while the view moves fast (see stepMarch)
            micro = mix(1.0, m, smoothstep(2.0, 25.0, a) * (1.0 - smoothstep(0.55 * reach, reach, dist)));
        }
    }
    micro = min(micro, mix(1.0, craterLit, smoothstep(1.0, 12.0, a)));
    // the craters too small to draw (see unres): the share of the ground their shadows cover grows with the
    // Sun's slant, and you only see those shadows when the Sun is not behind you (they hide behind their own rims)
    float muS = dot(N, L);
    if (unres > 0.0 && muS > 0.0) {
        float tanI = sqrt(max(1.0 - muS * muS, 0.0)) / max(muS, 0.02);
        micro *= 1.0 - unres * clamp(1.0 - exp(-0.1 * tanI), 0.0, 0.9) * smoothstep(3.0, 40.0, a);
        // (not an even grey: the thin dark and bright strokes of Apollo panoramas, see groundFar.ts)
        vec2 fg = lvFarGround(en, fp * lvLod.y, lvSunAz, a, tanI);
        micro *= mix(1.0, fg.x, unres);
        craterAlb *= mix(1.0, fg.y, unres);
    }

    // Sunlight, reflected the way moon dust does ("lunar-Lambert", McEwen 1991): seen with the Sun behind
    // you the ground is bright and nearly shadowless; looking towards the Sun it is darker.
    float mu0 = max(dot(Nd, L), 0.0) * smoothstep(-0.02, 0.01, dot(N, L));
    float mu = max(dot(Nd, V), 0.05);
    float limb = clamp(1.0 + a * (-0.019 + a * (2.42e-4 - 1.46e-6 * a)), 0.0, 1.0);
    float phase = lvLook.x + (1.0 - lvLook.x) * exp(-a / lvLook.y) + lvLook.z * exp(-a / 4.0);
    float sun = phase * (2.0 * limb * mu0 / (mu0 + mu) + (1.0 - limb) * mu0) * micro * mix(1.0, lvDetail.y, wD);
    vec3 Le = normalize(czm_viewRotation * lvEarthDir);
    vec3 direct = lvSunColor * (sun * vis * mix(1.0, contact, 0.55));
    float upF = max(dot(Nd, Ue), 0.0);
    vec3 fill = (lvEarthLight * (0.25 + 0.75 * max(dot(Nd, Le), 0.0)) + lvAmbient * (0.65 + 0.35 * dot(Nd, Ue)) + lvStar * upF * upF) * cavity * rockAo;
    vec3 x = max((direct + fill) * lvExposure, vec3(0.0));
    // the helmet lamp: a warm pool of light on the ground ahead, from the eye, fading with distance
    if (lvLamp.x > 0.0) x += lvLampLight(-toEye, Nd) * cavity * rockAo;
    vec3 disp = x * (1.0 + x * lvLook.w) / (1.0 + x); // the camera: straight in the dark, a soft shoulder in bright light

    // The photo of this exact spot, and how bright the ground itself is.
    vec4 photo = computeDayColor(vec4(0.227, 0.235, 0.255, 1.0), vec3(clamp(materialInput.st, 0.0, 1.0), 0.0), 0.0);
    float p = dot(photo.rgb, vec3(0.2126, 0.7152, 0.0722));
    float M = max(lvMean(en, p), 0.0);
    float sunny = clamp(dot(direct, vec3(0.33)) / max(dot(fill, vec3(0.33)) * 6.0, 1e-6), 0.0, 1.0);
    float detail = clamp((p + lvPhoto.z) / (M + lvPhoto.z), 0.2, 3.0);
    float albedo = pow(max(M, 0.004) / lvPhoto.x, mix(lvPhoto.w, lvPhoto.y, sunny)) * detail;
    material.diffuse = disp * albedo * craterAlb;
    material.alpha = 1.0;
    return material;
}
`;

// Look of the ground (the same numbers are used by the shader and by the exposure below).
/** Sunlight colour on the ground: moon dust is a slightly warm grey. */
const SUN_TINT: [number, number, number] = [1.03, 0.99, 0.93];
/** Moon-dust reflection: [phase floor, phase width (deg), opposition glow, 1 / white point²]. */
const LOOK: [number, number, number, number] = [0.4, 45, 0.15, 1 / 16];
/**
 * The photo: [its typical brightness, how much of its large-scale brightness to keep in sunlight
 * (0 = none, 1 = all), a floor that keeps noise in its darkest parts from being blown up, the same as
 * the second number but in shade].
 */
const PHOTO: [number, number, number, number] = [0.4, 0.3, 0.04, 0.45];
/** Light bounced from sunlit hills, a faint glow that is always there, and full-Earth light (Sun = 1). */
const BOUNCE = 0.045, FLOOR = 0.003, EARTH_LIGHT = 0.012;
/** Starlight and the Milky Way: light from the whole black sky, so slopes that face up stay a touch lighter at night. */
const STAR_LIGHT = 0.0035;
/** The rover's headlights: strength, the edge of the beam and its bright middle (cosines). Where they sit: see ROVER. */
const LAMP: [number, number, number, number] = [16, Math.cos(34 * DEG), Math.cos(12 * DEG), 0];
/** At night the camera is set darker (a night photo, not a grey day): the key value for "no Sun anywhere", and with Earth up. */
const NIGHT_KEY = 0.15, EARTH_NIGHT_KEY = 0.22;
/** Exposure before the light meter has a reading: a gentle sunlit slope seen from the side comes out mid-grey; ground in shade dim. */
const X_LIT = 0.9, X_SHADE = 0.5;
/** Light meter: where the typical ground in view lands [mostly sunlit, mostly shade], and the most the brightest tenth may get (before the camera curve). */
const METER: [number, number, number] = [0.75, 0.34, 3.0];
const METER_ROWS = 13, METER_COLS = 11;
/** Star and Milky Way brightness (SpaceSky.exposure) with sunlit ground in view, and with the Sun itself in view: a black sky, as in Apollo photos. */
const SKY_LIT = 0.12, SKY_SUN = 0.06;

/**
 * The photo-scanned regolith (public/lander/, see CREDITS.md): Poly Haven "Moon 02", "Moon Meteor 01" and
 * "Moon Meteor 02" (CC0), packed by .v4/lander/tools/pack_regolith.py. size = the real width of one scan,
 * span = its height range (both metres, the span fitted from the scan's own normal map).
 */
const REGOLITH = [
  { url: 'lander/regolith_a.webp', sizeM: 3.1, spanM: 0.0722 },
  { url: 'lander/regolith_b.webp', sizeM: 3.2, spanM: 0.0452 },
  { url: 'lander/regolith_c.webp', sizeM: 3.2, spanM: 0.0574 },
];
/**
 * The four sizes the scans are laid down at: which scan, how many times larger than real, turned by
 * (radians), how steep compared with the scan (bigger lumps on the Moon are gentler: RMS slopes fall from
 * ~20° at centimetres to ~5° at tens of metres), and the distance (m) by which it has faded out.
 */
const DETAIL_LAYERS = [
  { tex: 0, scale: 1, rot: 0.0, gain: 0.8, fadeM: 18 },
  { tex: 1, scale: 4.1, rot: 1.9, gain: 0.5, fadeM: 90 },
  { tex: 2, scale: 15.7, rot: 4.1, gain: 0.45, fadeM: 700 },
  { tex: 2, scale: 61, rot: 2.7, gain: 0.18, fadeM: 4500 },
];
/** Overall sunlit brightness with the detail on (keeps near and far ground equally bright on average), how much hollows darken the fill light, and how far the little shadows are traced (m). */
const DETAIL_NORM = 1.0, DETAIL_CAVITY = 0.5, DETAIL_MARCH_M = 60;
function layerVec(i: number): Cartesian4 {
  const l = DETAIL_LAYERS[i], r = REGOLITH[l.tex];
  return new Cartesian4(1 / (r.sizeM * l.scale), Math.cos(l.rot), Math.sin(l.rot), r.spanM * l.scale * l.gain);
}

// ---------------------------------------------------------------------------------------------
// Rocks. Every Apollo and Chang'e photo shows loose rocks lying on the soil; no orbiter can see them
// (the best photos are ~0.5-1 m per pixel), so these are photo-scanned real rocks (Poly Haven "Moon Rock
// 01-07", CC0; public/lander/rocks, packed by .v4/lander/tools/pack_rocks.py) scattered around the lander
// the way rocks are on the Moon: many small ones, few big ones (number larger than D ~ 1/D^2), the same
// pattern every time you stand on the same spot. They sit on the drawn ground, are lit by the same Sun and
// light meter as the ground (ROCK_SHADER), get dark in a hill's shadow, and cast their own shadows on the
// ground (rasterRocks + lvRockShade). They are a stand-in for the real ones, not a map of them.

const ROCK_MODELS: { url: string; w: number; h: number }[] = [
  [0.2121, 0.0751], [0.2465, 0.2020], [0.1121, 0.0581], [0.1738, 0.0538], [0.0811, 0.0734], [0.0918, 0.0550], [0.0968, 0.0603],
].map(([w, h], i) => ({ url: `lander/rocks/moon_rock_0${i + 1}/rock.gltf`, w, h }));
const ROCK_POOL = 96;
/** Rock brightness: the scans average ~0.21; scaled so a rock is about as bright as the soil it lies on. */
const ROCK_ALBEDO = 0.75 / 0.21;
/** How deep a rock's base sits in the dust (fraction of its height), and how often rocks are re-seated on the drawn ground (ms). */
const ROCK_BURY = 0.2, ROCK_SEAT_MS = 50;
/** Little-shadow distance standing still and while moving (m), and Cesium's tile-loading time per frame while moving (ms). */
const MARCH_FAR = 350, MARCH_FAR_MOVING = 60, TILE_SLICE_MOVING = 2;
/** Share of crater cells that hold a crater (see lvCraterScale). */
const CRATER_SHARE = 0.55;
/** Walk this far from the centre of the shadow / height maps (m) and they are rebuilt round you. */
const RECENTRE_M = 3000;
/** Camera near plane while standing / walking (m). */
const NEAR_M = 0.2;
/** The rock-shadow pictures (see rasterRocks): cells per side, and metres per cell (fine near you, coarse further out). */
const ROCK_MAP_N = 512, ROCK_MAP_CELL = [0.03, 0.25];
/** Rocks: cell sizes (m), rocks per small cell, smallest / biggest (m), how far they are drawn, the smallest a rock may look (size / distance), and the clear patch round the lander (m). */
const ROCK_FIELD = {
  // (reach: the near rock models; further out the far stones take over, see farRocks.ts)
  cell: 16, perCell: 19, d0: 0.05, d1: 0.7, reach: 26, // ~0.075 rocks per m^2 of 5 cm .. 70 cm
  bigCell: 80, bigChance: 0.6, bigD0: 0.6, bigD1: 1.8, bigReach: 26, // a boulder in about every other 80 m square
  minAngle: 0.0045, clear: 2.2,
};
/** The rover's headlights for the rocks (the same beam as lvLampLight in the ground shader). */
const LAMP_GLSL = `
vec3 lampLight(vec3 P, vec3 N, float k) {
    vec3 d = u_lampPos - P;
    float r = length(d);
    vec3 l = d / max(r, 0.01);
    float spot = smoothstep(${LAMP[1].toFixed(5)}, ${LAMP[2].toFixed(5)}, dot(-l, u_lampDir));
    return vec3(1.0, 0.95, 0.88) * (k * spot * max(dot(N, l), 0.0) * 9.0 / (r * r + 1.0));
}
`;
const ROCK_SHADER = LAMP_GLSL + `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
    vec3 N = normalize(material.normalEC);
    vec3 V = normalize(-fsInput.attributes.positionEC);
    vec3 L = normalize(czm_viewRotation * u_sun);
    vec3 Ue = normalize(czm_viewRotation * u_up);
    vec3 Le = normalize(czm_viewRotation * u_earth);
    float mu0 = max(dot(N, L), 0.0), mu = max(dot(N, V), 0.05);
    float a = degrees(acos(clamp(dot(L, V), -1.0, 1.0)));
    float limb = clamp(1.0 + a * (-0.019 + a * (2.42e-4 - 1.46e-6 * a)), 0.0, 1.0);
    float phase = u_look.x + (1.0 - u_look.x) * exp(-a / u_look.y) + u_look.z * exp(-a / 4.0);
    float sun = phase * (2.0 * limb * mu0 / (mu0 + mu) + (1.0 - limb) * mu0) * u_vis;
    vec3 fill = u_earthLight * (0.25 + 0.75 * max(dot(N, Le), 0.0)) + u_ambient * (0.65 + 0.35 * dot(N, Ue));
    vec3 x = max((u_sunColor * sun + fill) * u_exposure, vec3(0.0));
    if (u_lamp > 0.0) x += lampLight(fsInput.attributes.positionEC, N, u_lamp);
    vec3 disp = x * (1.0 + x * u_look.w) / (1.0 + x);
    // (moon rocks are grey: keep only a little of the scan's colour)
    float lum = dot(material.diffuse, vec3(0.2126, 0.7152, 0.0722));
    vec3 c = disp * mix(vec3(lum), material.diffuse, 0.3) * u_albedo;
    material.diffuse = czm_srgbToLinear(clamp(c, 0.0, 1.0)); // unlit: Cesium turns it back into screen colour
}
`;

// ---------------------------------------------------------------------------------------------
// MOONDA, our rover (named like the app). The model is NASA's Mars 2020 Perseverance 3D model (NASA 3D Resources,
// no copyright; see public/lander/CREDITS.md), at its true size: about 3 m long and 2.7 m wide. In the GLB +Y is
// up, +Z the front and +X the rover's left, and the wheels touch y = 0. It is lit like the rocks: the same Sun
// (and hill shadows), Earth and fill light, at the same exposure, with a faint floor so it is never fully black.

const ROVER_URL = 'lander/rover/rover-moonda.glb'; // rover.glb with its wheels split and a solar panel (data-prep/rover/)
export const ROVER = {
  /**
   * The robot's size against NASA's full-size Perseverance model (set in walk.ts, ROBOT_SCALE, so the wheels and
   * bumps there follow it too). Every length below marked "model m" is multiplied by it where it is used.
   */
  scale: ROBOT_SCALE,
  /** parked this far in front of the landing spot when you arrive (model m), turned this much from the way you face (deg) */
  parkM: 12, parkTurn: 60,
  /** the chase camera looks at this point above the ground under the rover, from this far, closest (model m), farthest (m), tilted down (deg) */
  lookUp: 1.5, dist: 10, distMin: 3.5, distMax: 30, chaseEl: -14,
  /** the mast camera, in the model's own coordinates (model m) */
  mast: [-0.45, 2.15, 0.95] as readonly number[],
  /** on the mast: how far it looks down when you get there (deg), and the camera's near plane (m) */
  firstEl: -10, firstNear: 0.04,
  /** headlights: height above the ground and how far in front of the middle (model m), tipped down (deg) */
  lightUp: 1.0, lightFwd: 1.6, lightDown: 10,
  /** the two lamp glows on the camera head: forward of its middle, apart to each side, up (model m) */
  lampAt: [0.14, 0.12, -0.12] as readonly number[],
  /** brightness of the model's paint under our light, and how much its metal parts shine (tuned on screenshots) */
  gain: 2.6, spec: 0.5,
  /** how long a glide between camera views takes (ms) */
  glideMs: 950,
  /** where in each of the model's own animations (mast, arm, covers) it is held: a share of the animation's length */
  poseT: 0.375, // NASA's animations unfold the rover from 0 to 5 s, hold until 10 s, fold it up by 15 s (of 20)
  /** the camera head: its pan and tilt joints in the model, their axes, how quickly it follows (s), its reach (deg) */
  panNode: 'top', tiltNode: 'Cylinder.002', panAxis: [0, 1, 0] as readonly number[], tiltAxis: [1, 0, 0] as readonly number[], tiltSign: 1,
  headS: 0.35, panMax: 165, tiltMin: -35, tiltMax: 30,
  /** parked: a curious look around every few seconds (ms, from..to) */
  glanceMs: [2800, 6500] as readonly number[],
  /** the body rocks on its springs when it speeds up or brakes: nose-up per m/s^2 (rad), period (s), damping */
  rockGain: 0, rockS: 0.55, rockDamp: 0.3, // (0: the springs in walk.ts's Driver do this now)
  /** on the mast: the ride's sway (rad) from speed, and how much bumps under the wheels kick it */
  swaySpeed: 0.0035, swayKick: 6,
};
if (import.meta.env.DEV) (window as unknown as { __rover: unknown }).__rover = ROVER; // for tuning from test scripts
const ROVER_SHADER = `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
    vec3 V = normalize(-fsInput.attributes.positionEC);
    vec3 N = normalize(material.normalEC);
    if (dot(N, V) < 0.0) N = -N; // thin panels seen from behind
    vec3 L = normalize(czm_viewRotation * u_sun);
    vec3 Ue = normalize(czm_viewRotation * u_up);
    vec3 Le = normalize(czm_viewRotation * u_earth);
    float sun = smoothstep(-0.04, 0.12, dot(N, L)) * max(dot(N, L) + 0.04, 0.0) / 1.04 * u_vis;
    float sky = 0.5 + 0.5 * dot(N, Ue);
    // the sunlit ground below throws light up onto the underside; the black sky gives nothing
    vec3 fill = u_earthLight * (0.25 + 0.75 * max(dot(N, Le), 0.0)) + u_ambient * (0.35 + 0.65 * sky) + u_bounce * (1.0 - sky);
    vec3 y = max((u_sunColor * sun + fill) * u_exposure, vec3(0.0)) * material.diffuse * u_gain;
    // metal, foil and lenses catch the Sun
    // small, curved parts seen from afar: widen their highlights to what one pixel can show, so they glint
    // smoothly instead of sparkling pixel by pixel (the "jagged" look); also rounds off the harsh terminator
    float aa = clamp(length(fwidth(N)) * 1.6, 0.0, 1.0);
    float rough = clamp(max(material.roughness, aa), 0.08, 1.0);
    float shin = mix(120.0, 4.0, rough);
    vec3 H = normalize(L + V);
    float glint = pow(max(dot(N, H), 0.0), shin) * (shin + 2.0) / 25.0 * sun * u_spec;
    y += u_sunColor * glint * mix(vec3(0.04), max(material.specular, vec3(0.04)), 0.7) * u_exposure * 4.0;
    vec3 c = y * (1.0 + y * 0.08) / (1.0 + y);
    // never fully black: a faint cool floor, as if it caught a little starlight
    c = max(c, (material.diffuse + 0.03) * vec3(0.05, 0.058, 0.08) * (0.55 + 0.45 * sky));
    material.diffuse = czm_srgbToLinear(clamp(c, 0.0, 1.0)); // unlit: Cesium turns it back into screen colour
}
`;
/** A small fast random-number generator with a seed (the same spot always gets the same rocks). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A terrain tile Cesium is drawing this frame (its private GlobeSurfaceTile data). */
interface DrawnTile { rectangle: Cesium.Rectangle; data?: { renderedMesh?: unknown; pick?: (...a: unknown[]) => Cartesian3 | undefined } }

interface RockSpot { id: string; e: number; n: number; d: number; kind: number; yaw: number; tilt: number; tiltAz: number }

/**
 * The rocks of one square cell of ground (metres east / north of the landing spot, in the landing spot's
 * frame), always the same for the same cell: you can walk away and come back and find the same rocks.
 * Small cells hold the many small rocks, big cells the few boulders.
 */
const cellCache = new Map<string, RockSpot[]>();
function rockCell(seed: number, big: boolean, ix: number, iy: number): RockSpot[] {
  const key = `${seed}:${big ? 'B' : 's'}:${ix}:${iy}`;
  let out = cellCache.get(key);
  if (out) return out;
  const F = ROCK_FIELD, size = big ? F.bigCell : F.cell;
  const rnd = seeded((seed ^ Math.imul(ix + 7919, 73856093) ^ Math.imul(iy - 104729, 19349663) ^ (big ? 0x5bd1e995 : 0)) >>> 0);
  const n = big ? (rnd() < F.bigChance ? 1 : 0) : F.perCell;
  const d0 = big ? F.bigD0 : F.d0, d1 = big ? F.bigD1 : F.d1;
  out = [];
  for (let i = 0; i < n; i++) {
    const e = (ix + rnd()) * size, nn = (iy + rnd()) * size;
    const d = d0 / Math.sqrt(1 - rnd() * (1 - (d0 / d1) ** 2)); // number bigger than D ~ 1 / D^2
    const spot = { id: `${key}:${i}`, e, n: nn, d, kind: Math.floor(rnd() * ROCK_MODELS.length), yaw: rnd() * 2 * Math.PI, tilt: rnd() * 0.25, tiltAz: rnd() * 2 * Math.PI };
    if (Math.hypot(e, nn) > F.clear) out.push(spot); // the lander's own patch of ground stays clear
  }
  if (cellCache.size > 4000) cellCache.clear();
  cellCache.set(key, out);
  return out;
}

/**
 * The rocks worth drawing as seen from (we, wn) (m from the landing spot): the biggest-looking ROCK_POOL, each with
 * how much of its size to show (0..1). There is no edge anywhere: a rock's "looks" (size / distance) also fades over
 * the last 30 % of its reach, and rocks whose looks are close to the weakest one still drawn are shown smaller, down to
 * nothing at that cut. So a rock entering or leaving the set (as you move) does so at zero size: it grows out of the
 * dust instead of popping in, and nowhere does a circle of rocks end.
 */
function rockSpots(lat: number, lon: number, we: number, wn: number, park: readonly number[] | null = null): { s: RockSpot; size: number }[] {
  const seed = (Math.round((lat + 90) * 1e5) * 92821 ^ Math.round((lon + 360) * 1e5)) >>> 0;
  const F = ROCK_FIELD, out: { s: RockSpot; score: number }[] = [];
  const scan = (big: boolean, reach: number) => {
    const size = big ? F.bigCell : F.cell;
    for (let iy = Math.floor((wn - reach) / size); iy <= Math.floor((wn + reach) / size); iy++) {
      for (let ix = Math.floor((we - reach) / size); ix <= Math.floor((we + reach) / size); ix++) {
        for (const s of rockCell(seed, big, ix, iy)) {
          const dist = Math.max(0.5, Math.hypot(s.e - we, s.n - wn));
          const looks = s.d / dist * (1 - smooth01((dist - 0.7 * reach) / (0.3 * reach)));
          if (looks < F.minAngle) continue;
          // (the rover's parking place is clear of anything it could not stand on)
          if (park && s.d > 0.25 && Math.hypot(s.e - park[0], s.n - park[1]) < park[2]) continue;
          out.push({ s, score: looks });
        }
      }
    }
  };
  scan(false, F.reach);
  scan(true, F.bigReach);
  const best = out.sort((a, b) => b.score - a.score).slice(0, ROCK_POOL);
  // the cut: the weakest rock drawn when the pool is full, else the smallest looks we draw at all
  const cut = best.length >= ROCK_POOL ? best[best.length - 1].score : F.minAngle;
  return best.map(o => ({ s: o.s, size: smooth01((o.score - cut) / (0.6 * cut)) }));
}
/** Every rock (both cell sizes) between r0 and r1 m from (we, wn): the far stones (farRocks.ts). */
function farSpots(lat: number, lon: number, we: number, wn: number, r0: number, r1: number): FarSpot[] {
  const seed = (Math.round((lat + 90) * 1e5) * 92821 ^ Math.round((lon + 360) * 1e5)) >>> 0;
  const F = ROCK_FIELD, out: FarSpot[] = [];
  for (const big of [false, true]) {
    const size = big ? F.bigCell : F.cell;
    for (let iy = Math.floor((wn - r1) / size); iy <= Math.floor((wn + r1) / size); iy++) {
      for (let ix = Math.floor((we - r1) / size); ix <= Math.floor((we + r1) / size); ix++) {
        for (const s of rockCell(seed, big, ix, iy)) {
          const dist = Math.hypot(s.e - we, s.n - wn);
          if (dist >= r0 && dist < r1) out.push(s);
        }
      }
    }
  }
  return out;
}
const smooth01 = (x: number) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

/** Moon dust (lunar-Lambert, McEwen 1991): brightness for Sun height `mu0`, view `mu` (cosines) and phase angle in degrees. */
function moonDust(mu0: number, mu: number, phaseDeg: number): number {
  const a = phaseDeg, limb = clamp(1 + a * (-0.019 + a * (2.42e-4 - 1.46e-6 * a)), 0, 1);
  const phase = LOOK[0] + (1 - LOOK[0]) * Math.exp(-a / LOOK[1]) + LOOK[2] * Math.exp(-a / 4);
  mu0 = Math.max(0, mu0); mu = Math.max(0.05, mu);
  return phase * (2 * limb * mu0 / (mu0 + mu) + (1 - limb) * mu0);
}

const SUN_SPRITE_HALF_DEG = 9;
const SUN_SVG = svgUrl(
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs>'
  + '<radialGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset="0.027" stop-color="#fff"/><stop offset="0.034" stop-color="#fff8e4" stop-opacity="0.92"/>'
  + '<stop offset="0.07" stop-color="#ffefca" stop-opacity="0.42"/><stop offset="0.16" stop-color="#ffe1a8" stop-opacity="0.15"/>'
  + '<stop offset="0.42" stop-color="#ffd28c" stop-opacity="0.045"/><stop offset="1" stop-color="#ffc878" stop-opacity="0"/></radialGradient>'
  + '<radialGradient id="s"><stop offset="0" stop-color="#fff" stop-opacity="0.75"/><stop offset="0.25" stop-color="#fff3d6" stop-opacity="0.22"/><stop offset="1" stop-color="#ffe9b8" stop-opacity="0"/></radialGradient>'
  + '</defs><circle cx="256" cy="256" r="256" fill="url(#g)"/>'
  + '<ellipse cx="256" cy="256" rx="120" ry="1.1" fill="url(#s)" opacity="0.7"/><ellipse cx="256" cy="256" rx="1.1" ry="120" fill="url(#s)" opacity="0.7"/></svg>');

const EARTH_SPRITE = 256, EARTH_DISC_R = 100;
/** Earth as a small lit ball: `k` = how much of the face is lit (0..1). The lit edge is drawn at the top; the picture is then turned to face the Sun. */
function earthSvg(k: number): string {
  const c = EARTH_SPRITE / 2, r = EARTH_DISC_R, ry = (Math.abs(2 * k - 1) * r).toFixed(2), sweep = k >= 0.5 ? 1 : 0;
  return svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${EARTH_SPRITE}" height="${EARTH_SPRITE}" viewBox="0 0 ${EARTH_SPRITE} ${EARTH_SPRITE}"><defs>`
    + '<radialGradient id="halo"><stop offset="0.76" stop-color="#6fb1ff" stop-opacity="0.34"/><stop offset="0.86" stop-color="#6fb1ff" stop-opacity="0.1"/><stop offset="1" stop-color="#6fb1ff" stop-opacity="0"/></radialGradient>'
    + '<radialGradient id="day" gradientUnits="userSpaceOnUse" cx="128" cy="40" r="170"><stop offset="0" stop-color="#f2f8ff"/><stop offset="0.3" stop-color="#a9d2f7"/><stop offset="0.65" stop-color="#3b88da"/><stop offset="1" stop-color="#14438c"/></radialGradient>'
    + `<filter id="soft" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="2.2"/></filter><clipPath id="disc"><circle cx="${c}" cy="${c}" r="${r}"/></clipPath></defs>`
    + `<circle cx="${c}" cy="${c}" r="${c}" fill="url(#halo)"/><circle cx="${c}" cy="${c}" r="${r}" fill="#0a1424"/>`
    + `<g clip-path="url(#disc)" filter="url(#soft)"><path d="M${c - r} ${c} A${r} ${r} 0 0 1 ${c + r} ${c} A${r} ${ry} 0 0 ${sweep} ${c - r} ${c} Z" fill="url(#day)"/></g>`
    + `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#8fc2ff" stroke-opacity="0.5" stroke-width="1.5"/></svg>`);
}

/**
 * A flat picture standing far away in the 3D scene (our own Sun / Earth). It is real geometry, so the
 * drawn hills hide exactly the right part of it. `cull: false` matters: at a spot below the Moon's
 * average radius (a mare, a crater floor) with no ground on screen, Cesium's horizon test throws away
 * everything that can be culled, and the Sun would vanish when you look up at it.
 */
function picture(image: string): Primitive {
  const geometry = new Geometry({
    attributes: {
      position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: new Float64Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]) }),
      st: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]) }),
    } as unknown as ConstructorParameters<typeof Geometry>[0]['attributes'],
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: new BoundingSphere(Cartesian3.ZERO, Math.SQRT2),
  });
  const renderState = (Appearance as unknown as { getDefaultRenderState(translucent: boolean, closed: boolean): object }).getDefaultRenderState(true, false);
  return new Primitive({
    geometryInstances: new GeometryInstance({ geometry }),
    appearance: new Appearance({
      translucent: true, closed: false, renderState,
      material: Material.fromType('Image', { image }),
      vertexShaderSource: 'in vec3 position3DHigh;\nin vec3 position3DLow;\nin vec2 st;\nin float batchId;\nout vec2 v_st;\nvoid main() {\n    vec4 p = czm_computePosition();\n    v_st = st;\n    gl_Position = czm_modelViewProjectionRelativeToEye * p;\n}\n',
      fragmentShaderSource: 'in vec2 v_st;\nvoid main() {\n    czm_materialInput materialInput;\n    materialInput.st = v_st;\n    materialInput.s = v_st.x;\n    materialInput.str = vec3(v_st, 0.0);\n    materialInput.normalEC = vec3(0.0, 0.0, 1.0);\n    materialInput.tangentToEyeMatrix = mat3(1.0);\n    materialInput.positionToEyeEC = vec3(0.0, 0.0, 1.0);\n    czm_material material = czm_getMaterial(materialInput);\n    out_FragColor = vec4(material.diffuse, material.alpha);\n}\n',
    }),
    asynchronous: false, cull: false, allowPicking: false, show: false,
  });
}
/** Stand a picture at `centre`, `half` metres from its middle to its edge, its top pointing along `up` (unit, at right angles to `toward`). */
function placePicture(p: Primitive, centre: Cartesian3, toward: Cartesian3, up: Cartesian3, half: number) {
  const right = Cartesian3.cross(up, toward, scratchF), m = p.modelMatrix as unknown as number[];
  m[0] = right.x * half; m[1] = right.y * half; m[2] = right.z * half; m[3] = 0;
  m[4] = up.x * half; m[5] = up.y * half; m[6] = up.z * half; m[7] = 0;
  m[8] = toward.x; m[9] = toward.y; m[10] = toward.z; m[11] = 0;
  m[12] = centre.x; m[13] = centre.y; m[14] = centre.z; m[15] = 1;
}

type Phase = 'off' | 'out' | 'load' | 'in' | 'on' | 'leaveOut' | 'leaveLoad' | 'leaveIn';
interface SavedView {
  position: Cartesian3; direction: Cartesian3; up: Cartesian3; right: Cartesian3; fov: number;
  sse: number; darkness: number; lambert: number; inputs: boolean; cursor: string; near: number;
}
/** A name tag: `dir` points at the body; while it is out of sight the tag sits on the skyline at compass `az` instead. */
interface Tag { el: HTMLDivElement; text: HTMLSpanElement; dir: Cartesian3; radiusDeg: number; label: string; state: string; az: number; onSky: Cartesian3 }

const scratchA = new Cartesian3(), scratchB = new Cartesian3(), scratchC = new Cartesian3(), scratchD = new Cartesian3(), scratchE = new Cartesian3();
const scratchF = new Cartesian3(), scratchG = new Cartesian3(), scratchH = new Cartesian3(), scratchI = new Cartesian3(), scratchJ = new Cartesian3();
const scratchK = new Cartesian3(), scratchL = new Cartesian3(), scratchM = new Cartesian3();
const scratchSunA = new Cartesian3(), scratchSunB = new Cartesian3();
const scratchCarto = new Cartographic(), scratchCarto2 = new Cartographic(), scratchCarto3 = new Cartographic();
const scratchRay = new Cesium.Ray();

export class LanderView {
  /** True from enter() until exit(). */
  active = false;
  /** Timings of the last enter, for tests: milliseconds from enter() to the view being fully shown, etc. */
  readonly stats = {
    enterMs: 0, loadMs: 0, loadTimedOut: false, detailMs: -1, rocksMs: -1, recentreMs: 0, recentres: 0, exitMs: 0, shadowBuildMs: 0, shadowSweepMs: 0, meanBuildMs: 0, sunHere: -1,
    /** longest gap between two frames in each step of the last enter / exit (ms) */
    worstFrame: { out: 0, load: 0, in: 0, leaveOut: 0, leaveLoad: 0, leaveIn: 0 } as Record<string, number>,
  };

  private viewer: Viewer;
  private heights: MoonHeights;
  private ownBodies: boolean;
  private useShadows: boolean;
  private canvas: HTMLCanvasElement;

  private phase: Phase = 'off';
  private phaseT0 = 0;
  private enterT0 = 0;
  private exitT0 = 0;
  private okFrames = 0;
  private ticksInPhase = 0;
  private shapeDoneT = 0;
  private photoWait = 0;
  private photoWaitT = 0;
  private raf = 0;
  private lastTick = 0;

  private spec: LanderSpec | null = null;
  private sky: SkyState | null = null;
  private east = new Cartesian3(0, 0, 1);
  private north = new Cartesian3(0, -1, 0);
  private up = new Cartesian3(1, 0, 0);
  private eye = new Cartesian3();
  private eyeHeight = 0;
  private placed = false; // the camera is ours

  // where the camera looks
  private az = 0;
  private el = 0;
  private fov = FOV_START;
  private fovTarget = FOV_START;
  private velAz = 0;
  private velEl = 0;
  private anim: { az0: number; el0: number; dAz: number; dEl: number; t0: number; dur: number } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { d: number; fov: number } | null = null;
  private lastMoveT = 0;
  private keys = new Set<string>();
  private downT = 0;
  private downX = 0;
  private downY = 0;
  /** mouse captured (pointer lock): every mouse movement turns the view */
  private onLockMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== this.canvas || !this.canLook()) return;
    const k = (0.11 * this.fov) / FOV_START; // degrees per pixel of mouse movement
    this.anim = null;
    this.az = wrap360(this.az + e.movementX * k);
    this.el = clamp(this.el - e.movementY * k, EL_MIN, EL_MAX);
    this.kick();
  };
  private onLockChange = () => {
    const locked = document.pointerLockElement === this.canvas;
    if (!locked && landerLink.mouseLocked) landerLink.unlockedAt = performance.now();
    if (landerLink.mouseLocked !== locked) { landerLink.mouseLocked = locked; emitLink(); }
  };

  private saved: SavedView | null = null;
  private fade: HTMLDivElement;
  private fadeNote: HTMLDivElement;
  private tagLayer: HTMLDivElement;
  private fadeText: HTMLSpanElement;
  private tags: { sun: Tag; earth: Tag };
  private entities: Entity[] = [];
  /** how far the eye has walked from the landing spot (m) */
  private fromSpot = 0;
  private sunPic: Primitive | null = null;
  private earthPic: Primitive | null = null;
  private earthKey = '';

  // light
  private material: Material | null = null;
  private materialOn = false;
  private shadows: TerrainShadows | null = null;
  private shadowTex: GpuTexture | null = null;
  private heightTex: GpuTexture | null = null;
  private means: PhotoMeans | null = null;
  private meanTex: GpuTexture | null = null;
  private shadowDirty = false;
  private sunAzDeg = 0;
  private sunElDeg = 0;
  private sweptAz = 999;
  private sweptEl = 999;
  private exposure = 1;
  private exposureTarget = 1;
  /** 0 = day, 1 = the Sun well below the horizon; Earth's share of the night light; starlight for the light meter */
  private night = 0;
  private earthShare = 0;
  private fillStar = 0;
  /** the helmet lamp: 0 off .. 1 on (eases in while walking after sunset) */
  private lampIn = 0;
  private onSkyExposure: ((v: number) => void) | null;
  private skyExposure = 1;
  private skyTarget = 1;
  // light meter (see meter())
  private earthEnu: Vec3 = [0, 0, 1];
  private fillEarth = 0;
  private fillAmb = 0;
  private meterLogs = new Float64Array(METER_ROWS * METER_COLS);
  private meterAt = 0;
  private meterKey = '';
  private offs: (() => void)[] = [];
  // the rocks (see loadRocks() / placeRocks())
  private rocks: {
    model: Model; shader: CustomShader; kind: number; e: number; n: number; vis: number;
    spot: RockSpot | null; scale: number; h: number; probe: Cartographic[] | null; probeM: number; ground: number; slopeE: number; slopeN: number;
    tile: DrawnTile | null; mesh: unknown; base: Cartesian3;
    /** how much of its size is shown (0..1, see rockSpots), and whether it must be re-seated at a new size */
    size: number; resize: boolean;
  }[] = [];
  /** the rocks' own frame (the landing spot's east / north and its point on the ground), fixed while standing at a spot */
  private rockE = new Cartesian3(); private rockN = new Cartesian3(); private rockOrigin = new Cartesian3();
  /** where the rock set was last chosen from, and the centre of the rock-shadow picture (map frame, m) */
  private rockAt: [number, number] = [0, 0];
  private rockMapAt: [number, number] = [0, 0];
  private rockSeatT = 0;
  private seatTimer = 0;
  // the rover (see walk.ts for how it drives; loadRover() / placeRoverModel() for the model)
  private driver: Driver | null = null;
  /** the rover is parked at this spot (from place() until the map is back) */
  private roverParked = false;
  /** the camera head: base local matrices of the pan and tilt joints, current and wanted pan / tilt (deg), next glance */
  private head: { pan: Cesium.ModelNode; tilt: Cesium.ModelNode; pan0: Matrix4; tilt0: Matrix4; m: Matrix4 } | null = null;
  private headPan = 0; private headTilt = 0; private headWantPan = 0; private headWantTilt = 0; private glanceAt = 0;
  private glanceTimer = 0;
  /** the body's rocking on its springs (rad, rad/s) and the speed a moment ago */
  private rock = 0; private rockV = 0; private lastSpeed = 0;
  /** the mast camera's ride: pitch and roll sway (rad), their speeds, the phase of the speed sway, the body's last up */
  private swayP = 0; private swayR = 0; private swayPV = 0; private swayRV = 0; private swayT = 0; private swayAmp = 0; private swayUp = new Cartesian3();
  private lampOnT = 0; private lampWant = 0;
  /** while the curtain is up: a quick look round in RING_STEPS directions, so turning later shows no tiles arriving */
  private ringStep = 0; private ringAz0 = 0;
  private parkBase = new Cartesian3();
  /** where it was parked, in the landing spot's frame (east, north, clear radius), so no boulder sits under it */
  private parkAt: number[] | null = null;
  private rover: Model | null = null;
  /** the robot's wheels and solar panel (robotFx.ts), the dust its wheels throw, whether its shadow map is on */
  private rig: RobotRig | null = null;
  private dust: Dust | null = null;
  /** the wheel tracks it leaves (wheelTracks.ts) */
  private tracks: WheelTracks | null = null;
  /** the rock-shadow picture without the robot, where it was drawn from (map frame), the robot's last patch per level, and what it was drawn for */
  private rockMapC = [0, 0];
  private robotSig = '';
  private dustLight: DustLight = { sun: new Cartesian3(1, 0, 0), vis: 1, eye: new Cartesian3(), exposure: 1, lamp: 0, lampPos: new Cartesian3(), lampDir: new Cartesian3(1, 0, 0) };
  private roverShader: CustomShader | null = null;
  private roverStarted = false;
  private roverReady = false;
  private roverM = new Matrix4();
  private roverLightAt = 0;
  /** where the camera is (see landerLink.view), how far the chase camera is from the rover, and the glide between views */
  private view: 'spot' | 'third' | 'first' = 'spot';
  private chaseDist = ROVER.dist * ROVER.scale;
  private glide: { from: Cartesian3; t0: number } | null = null;
  /** the eye at the landing spot (panel height), also while the camera is on the rover */
  private spotEye = new Cartesian3();
  /** the eye is away from the landing spot (on or behind the rover, or gliding) */
  private get walkerActive() { return this.view !== 'spot' || this.glide !== null; }
  /** the keys drive the rover */
  private walking = false;
  private viewE = new Cartesian3(0, 0, 1);
  private viewN = new Cartesian3(0, -1, 0);
  private viewU = new Cartesian3(1, 0, 0);
  private walkEnv: WalkEnv = {
    ground: p => this.groundUnder(p),
    obstacles: () => this.rockObstacles(),
  };
  private obstacleList: WalkObstacle[] = [];
  private lastWalkLink = 0;
  private rocksStarted = false;
  private rocksShown = 0;
  private rockMap = new Uint8Array(ROCK_MAP_N * ROCK_MAP_N * 4);
  private rockTex: GpuTexture | null = null;
  private rockMs = 0;
  // the photo-scanned regolith (see loadDetail())
  private detailTex: GpuTexture[] = [];
  private detailStarted = false;
  private detailT0 = performance.now();

  constructor(viewer: Viewer, heights: MoonHeights, opts: LanderOptions = {}) {
    this.viewer = viewer;
    this.heights = heights;
    this.ownBodies = opts.ownBodies !== false;
    this.useShadows = opts.terrainShadows !== false;
    this.onSkyExposure = opts.onSkyExposure ?? null;
    this.canvas = viewer.scene.canvas;
    const host = viewer.container as HTMLElement;

    this.fade = document.createElement('div');
    this.fade.className = 'lv-fade';
    this.fadeNote = document.createElement('div');
    this.fadeNote.className = 'lv-fade-note';
    this.fadeNote.innerHTML = '<span class="lv-spin"></span><span></span>';
    this.fadeText = this.fadeNote.lastElementChild as HTMLSpanElement;
    this.fadeText.textContent = tr('lander.gettingReady');
    this.fade.append(this.fadeNote);

    this.tagLayer = document.createElement('div');
    this.tagLayer.className = 'lv-sky';
    this.tagLayer.style.display = 'none';
    const tag = (kind: 'sun' | 'earth', radiusDeg: number): Tag => {
      const el = document.createElement('div');
      el.className = `lv-tag ${kind}`;
      const ring = document.createElement('i'), text = document.createElement('span');
      el.append(ring, text);
      this.tagLayer.append(el);
      return { el, text, dir: new Cartesian3(1, 0, 0), radiusDeg, label: '', state: '', az: 0, onSky: new Cartesian3(1, 0, 0) };
    };
    this.tags = { sun: tag('sun', SUN_ANG_R), earth: tag('earth', 0.95) };
    host.append(this.tagLayer, this.fade);
    // a new language: the tags are written again on the next light update
    this.offs.push(onLangChange(() => { this.tags.sun.label = this.tags.earth.label = ''; this.fadeText.textContent = tr('lander.gettingReady'); this.applyLight(); }));

    if (opts.prewarm !== false) {
      this.ensureMaterial();
      if (this.ownBodies) this.warmPictures();
    }
    // the regolith scans: not needed for the map, so fetched once start-up has settled
    const detailTimer = window.setTimeout(() => { if (this.material) this.loadDetail(); }, 2500);
    this.offs.push(() => window.clearTimeout(detailTimer));

    const scene = viewer.scene;
    this.offs.push(scene.preRender.addEventListener(() => { if (this.placed) { this.applyCamera(); this.placeLamp(); } }));
    this.offs.push(scene.preRender.addEventListener(() => this.stepSunShadow()));
    // finer ground tiles arrived: put the parked rover back on the ground they draw (the loop sleeps when nothing moves)
    this.offs.push(scene.globe.tileLoadProgressEvent.addEventListener((n: number) => { if (n === 0 && this.placed && this.roverParked) this.kick(); }));
    this.offs.push(scene.postRender.addEventListener(() => {
      if (!this.placed) return;
      this.placeTags();
      // the ground under the rocks gets finer as tiles arrive, and other tiles come on screen as you turn
      const now = performance.now();
      if (this.rocksShown && now - this.rockSeatT > ROCK_SEAT_MS) { this.rockSeatT = now; this.seatRocks(); }
      else if (this.rocksShown && !this.seatTimer) {
        // too soon to look again: make sure one more frame is drawn later, so the last change gets looked at
        this.seatTimer = window.setTimeout(() => { this.seatTimer = 0; if (this.placed) scene.requestRender(); }, ROCK_SEAT_MS);
      }
    }));
    const c = this.canvas;
    c.addEventListener('pointerdown', this.onDown);
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerup', this.onUp);
    c.addEventListener('pointercancel', this.onUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('mousemove', this.onLockMove);
    document.addEventListener('pointerlockchange', this.onLockChange);
    this.offs.push(() => {
      document.removeEventListener('mousemove', this.onLockMove);
      document.removeEventListener('pointerlockchange', this.onLockChange);
      c.removeEventListener('pointerdown', this.onDown);
      c.removeEventListener('pointermove', this.onMove);
      c.removeEventListener('pointerup', this.onUp);
      c.removeEventListener('pointercancel', this.onUp);
      window.removeEventListener('keydown', this.onKeyDown);
      window.removeEventListener('keyup', this.onKeyUp);
      window.removeEventListener('blur', this.onBlur);
    });
  }

  /**
   * Fetch and decode every picture and model this view needs (regolith scans, rocks, the rover, our Sun and Earth)
   * and compile their shaders, without showing anything, so "Stand here" opens without a loading pause.
   * Resolves when all is ready (or after 20 s, so a slow network never blocks the caller).
   */
  prewarm(): Promise<void> {
    this.ensureMaterial();
    if (this.ownBodies && !this.sunPic) this.warmPictures();
    if (this.material) this.loadDetail();
    roverAudio.prewarm();
    const t0 = performance.now();
    return new Promise(resolve => {
      const check = () => {
        const done = !this.material || (this.stats.detailMs > 0 && this.rockMs > 0 && this.roverReady);
        if (done || this.viewer.isDestroyed() || performance.now() - t0 > 20000) resolve();
        else window.setTimeout(check, 100);
      };
      check();
    });
  }

  /** True compass direction the camera faces (0 = north, 90 = east). */
  headingDeg(): number { return this.spec ? this.az : 0; }

  // ---- going in ------------------------------------------------------------------------------

  enter(spec: LanderSpec, sky: SkyState, faceAzDeg: number) {
    const same = this.active && this.spec && Math.abs(this.spec.lat - spec.lat) < 1e-7 && Math.abs(this.spec.lon - spec.lon) < 1e-7;
    if (same && this.phase !== 'off' && !this.phase.startsWith('leave')) {
      // same spot, new details (panel height, or the calculated skyline has arrived): no fade needed
      this.spec = spec;
      this.sky = sky;
      if (this.placed) { this.setEyeHeight(true); this.drawSkyline(); this.applyLight(); this.kick(); }
      return;
    }
    if (this.phase.startsWith('leave')) this.restoreMap(); // asked to go back in while still leaving: finish leaving first
    const cam = this.viewer.camera, globe = this.viewer.scene.globe, ssc = this.viewer.scene.screenSpaceCameraController;
    if (!this.saved) {
      this.saved = {
        position: Cartesian3.clone(cam.position), direction: Cartesian3.clone(cam.direction), up: Cartesian3.clone(cam.up), right: Cartesian3.clone(cam.right),
        fov: (cam.frustum as unknown as { fov: number }).fov,
        sse: globe.maximumScreenSpaceError, darkness: globe.vertexShadowDarkness, lambert: globe.lambertDiffuseMultiplier,
        near: (cam.frustum as unknown as { near: number }).near,
        inputs: ssc.enableInputs, cursor: this.canvas.style.cursor,
      };
    }
    cam.cancelFlight();
    ssc.enableInputs = false; // from now on only we move the camera
    this.active = true;
    this.spec = spec;
    this.sky = sky;
    this.az = wrap360(faceAzDeg);
    this.el = 0;
    this.fov = this.fovTarget = FOV_START;
    this.velAz = this.velEl = 0;
    this.anim = null;
    this.pointers.clear();
    this.keys.clear();
    this.fromSpot = 0;
    this.enterT0 = performance.now();
    this.stats.loadTimedOut = false;
    // the 80 m height tiles around the spot (needed for the exact eye height); usually already downloaded
    void this.heights.loadTilesAround(spec.lat, spec.lon, 4000).then(() => { if (this.placed && this.spec === spec) { this.setEyeHeight(this.phase !== 'on'); this.kick(); } }, () => {});
    zoomHandler = step => this.zoomFov(-step * 260);
    walkHandler = on => this.setWalk(on);
    homeHandler = () => this.setView('spot');
    viewHandler = v => this.setView(v);
    lightsHandler = () => this.kick();
    skylineHandler = () => this.showSkyline();
    landerLink.az = this.az; landerLink.el = this.el; landerLink.fovDeg = this.fov;
    this.fade.classList.add('on');
    this.fadeNote.classList.remove('show');
    this.setPhase('out');
    this.kick();
  }

  /** The screen is black: move the camera to the spot and switch the lander lighting on. */
  private place() {
    const spec = this.spec!, v = this.viewer, globe = v.scene.globe;
    const enu = trueENU(spec.lat, spec.lon);
    Cartesian3.clone(enu.east, this.east); Cartesian3.clone(enu.north, this.north); Cartesian3.clone(enu.up, this.up);
    // the view turns in the same frame until you walk away (then in the frame where you are, see walk.ts)
    Cartesian3.clone(enu.east, this.viewE); Cartesian3.clone(enu.north, this.viewN); Cartesian3.clone(enu.up, this.viewU);
    // rocks are laid out in the landing spot's frame for as long as you stay at this spot
    Cartesian3.clone(enu.east, this.rockE); Cartesian3.clone(enu.north, this.rockN);
    this.walking = false;
    this.view = 'spot';
    this.glide = null;
    this.chaseDist = ROVER.dist * ROVER.scale;
    this.placed = true;
    roverAudio.bed(true);
    this.setEyeHeight(true);
    Cartesian3.clone(this.eye, this.rockOrigin);
    // (tried the map's 1 in 'full' graphics on 13 Nov: sharper, but twice the tiles arriving on a 360 turn)
    globe.maximumScreenSpaceError = LANDER_SSE;
    landerTerrainFog(v.scene, true); // far tiles seen edge-on refined a little less (groundLod.ts)
    landerAntialias(this.viewer, true);
    // the camera's near plane: 1 m by default, which would cut open a boulder you stand next to
    (this.viewer.camera.frustum as unknown as { near: number }).near = NEAR_M;

    this.ensureMaterial();
    if (this.material) this.loadDetail();
    const mat = this.material;
    this.materialOn = !!mat && globe.material === mat && !!(v.terrainProvider as unknown as { hasVertexNormals?: boolean }).hasVertexNormals;
    if (this.materialOn && mat) {
      const u = mat.uniforms as Record<string, unknown>;
      u.lvOn = 1;
      Cartesian3.clone(this.east, u.lvEast as Cartesian3);
      Cartesian3.clone(this.north, u.lvNorth as Cartesian3);
      Cartesian3.clone(this.up, u.lvUp as Cartesian3);
      Cartesian3.fromElements(0, 0, 0, u.lvSpan as Cartesian3);
      (u.lvHeightInfo as Cartesian2).x = 0;
      Cartesian2.fromElements(0, 0, u.lvMeanSpan as Cartesian2);
      // the photo's own average brightness around the spot (south pole only; elsewhere none is needed)
      this.means ??= new PhotoMeans(new URL('./data/polar/t/', document.baseURI).href);
      void this.means.start(spec.lat, spec.lon).then(() => { if (this.placed && this.spec === spec) this.uploadMeans(); });
      // our shader does all the lighting: make Cesium's own day/night shading a no-op
      globe.vertexShadowDarkness = 1;
      globe.lambertDiffuseMultiplier = 0;
      if (this.useShadows) {
        this.shadows ??= new TerrainShadows(this.heights);
        this.shadows.start(spec.lat, spec.lon);
        this.sweptAz = this.sweptEl = 999;
      }
      this.recentre = null;
      this.homeMaps = null;
      this.mapAt = { lat: spec.lat, lon: spec.lon };
      // (near the pole the 80 m heights already show the bigger craters; 'light' quality skips the far ones to save time)
      ((u.lvCraters as Cartesian4)).y = spec.lat < -80 || settings.get().quality === 'light' ? 3 : 5;
      Cartesian2.fromElements(0, 0, u.lvCraterKeep as Cartesian2);
    }
    this.exposure = -1; // snap to the right exposure on the first applyLight
    this.drawSkyline();
    this.tagLayer.style.display = '';
    if (this.ownBodies) this.makePictures();
    this.applyLight();
    this.applyCamera();
    this.canvas.style.cursor = 'grab';
    this.okFrames = 0;
    this.shapeDoneT = 0;
    this.parkRover();
    this.setWalkLink();
    this.setLoadBoost(true);
    this.setPhase('load');
  }

  /**
   * Is the view ready to be shown? The hills must have their final shape (no 3D tile that blocks
   * sharper tiles is still loading). Photos get a short grace period on top: they may come from a
   * slow server, and waiting for every last one is what made this view feel frozen.
   */
  private groundReady(now: number, sweep = false): boolean {
    const globe = this.viewer.scene.globe;
    if (globe.tilesLoaded) { this.okFrames++; return this.okFrames >= 3; }
    const surface = (globe as unknown as { _surface?: { _tileLoadQueueHigh?: unknown[]; _tileLoadQueueMedium?: unknown[]; _tileLoadQueueLow?: unknown[] } })._surface;
    const high = surface?._tileLoadQueueHigh, medium = surface?._tileLoadQueueMedium, low = surface?._tileLoadQueueLow;
    if (!high || !medium || !low) { this.okFrames = 0; return false; } // unknown Cesium build: only the time limit applies
    if (high.length > 0) { this.okFrames = 0; this.shapeDoneT = 0; return false; }
    this.okFrames++;
    if (this.okFrames < 3) return false;
    const waiting = medium.length + low.length;
    if (!this.shapeDoneT) { this.shapeDoneT = now; this.photoWait = waiting; this.photoWaitT = now; }
    if (waiting < this.photoWait) { this.photoWait = waiting; this.photoWaitT = now; } // photos are still arriving quickly
    // a quick look in another direction (see the 'load' phase): the shapes and most photos are enough
    if (sweep) return waiting === 0 || now - this.shapeDoneT > 300;
    // the view you will see: wait for the photos too, unless they stop arriving or take too long
    return now - this.shapeDoneT > 2500 || (now - this.shapeDoneT > 250 && now - this.photoWaitT > 700);
  }

  /** While the screen is black, let Cesium spend more of each frame on loading tiles. */
  private setLoadBoost(on: boolean) {
    const surface = (this.viewer.scene.globe as unknown as { _surface?: { _loadQueueTimeSlice?: number } })._surface;
    if (surface && typeof surface._loadQueueTimeSlice === 'number') surface._loadQueueTimeSlice = on ? 9 : 5;
  }

  /**
   * Eye = panel height above the ground as drawn (what you see under you, and what the rover stands on), or
   * above the exact NASA ground until the drawn ground is there. (Above the exact ground alone the eye could
   * float several metres over the drawn ground where the two disagree, e.g. 6.8 m at 38.8 S, 1.0 E.)
   */
  private setEyeHeight(snap: boolean): boolean {
    const spec = this.spec;
    if (!spec) return false;
    const mast = Math.max(MIN_CLEARANCE_M, spec.mastM);
    const exact = this.heights.heightAt(spec.lat, spec.lon, true);
    Cartographic.fromCartesian(toCartesian(spec.lat, spec.lon, 0, scratchA), MOON_ELLIPSOID, scratchCarto);
    const drawn = this.viewer.scene.globe.getHeight(scratchCarto);
    const want = drawn !== undefined ? drawn + mast : exact + mast;
    if (snap || Math.abs(want - this.eyeHeight) < 0.02) this.eyeHeight = want;
    else this.eyeHeight += (want - this.eyeHeight) * (want > this.eyeHeight ? 0.5 : 0.12);
    toCartesian(spec.lat, spec.lon, this.eyeHeight, this.spotEye);
    if (!this.walkerActive) Cartesian3.clone(this.spotEye, this.eye);
    return Math.abs(want - this.eyeHeight) > 0.02;
  }

  // ---- going out -----------------------------------------------------------------------------

  exit() {
    if (!this.active) return;
    this.active = false;
    this.exitT0 = performance.now();
    zoomHandler = null; walkHandler = null; homeHandler = null; skylineHandler = null; viewHandler = null; lightsHandler = null;
    roverAudio.bed(false);
    roverAudio.driving(false);
    window.clearTimeout(this.glanceTimer);
    roverAudio.drive(0, 0, 0);
    this.pointers.clear();
    this.keys.clear();
    if (this.phase === 'out') {
      // the camera has not moved yet: just lift the curtain again
      this.viewer.scene.screenSpaceCameraController.enableInputs = this.saved?.inputs ?? true;
      this.saved = null;
      this.spec = null;
      this.sky = null;
      this.fade.classList.remove('on');
      this.setPhase('leaveIn');
    } else {
      this.fade.classList.add('on');
      this.fadeNote.classList.remove('show');
      this.setPhase('leaveOut');
    }
    this.kick();
  }

  /** The screen is black: put the map back exactly as it was. */
  private restoreMap() {
    const v = this.viewer, cam = v.camera, globe = v.scene.globe, s = this.saved;
    this.stopWalking();
    this.view = 'spot';
    this.glide = null;
    this.roverParked = false;
    this.parkAt = null;
    if (this.rover) this.rover.show = false;
    this.dust?.clear();
    this.tracks?.clear();
    this.placed = false;
    this.setLoadBoost(false);
    this.clearEntities();
    this.tagLayer.style.display = 'none';
    if (this.sunPic) this.sunPic.show = false;
    if (this.earthPic) this.earthPic.show = false;
    if (this.material) (this.material.uniforms as Record<string, unknown>).lvOn = 0;
    this.hideRocks();
    this.materialOn = false;
    this.skyTarget = 1;
    this.setSkyExposure(1);
    if (s) {
      globe.maximumScreenSpaceError = s.sse;
      landerTerrainFog(v.scene, false);
      landerAntialias(this.viewer, false);
      globe.vertexShadowDarkness = s.darkness;
      globe.lambertDiffuseMultiplier = s.lambert;
      (cam.frustum as unknown as { fov: number }).fov = s.fov;
      (cam.frustum as unknown as { near: number }).near = s.near;
      Cartesian3.clone(s.position, cam.position); Cartesian3.clone(s.direction, cam.direction);
      Cartesian3.clone(s.up, cam.up); Cartesian3.clone(s.right, cam.right);
      v.scene.screenSpaceCameraController.enableInputs = s.inputs;
      this.canvas.style.cursor = s.cursor;
    }
    for (let i = 0; i < v.imageryLayers.length; i++) v.imageryLayers.get(i).brightness = 1;
    this.saved = null;
    this.spec = null;
    this.sky = null;
    v.scene.requestRender();
  }

  // ---- the loop (runs only while something is changing) ----------------------------------------

  private setPhase(p: Phase) {
    this.phase = p;
    if (p === 'load') { this.ringStep = 0; this.ringAz0 = this.az; }
    this.phaseT0 = performance.now();
    this.ticksInPhase = 0;
    if (p === 'out') for (const k of ['out', 'load', 'in']) this.stats.worstFrame[k] = 0;
    if (p === 'leaveOut') for (const k of ['leaveOut', 'leaveLoad', 'leaveIn']) this.stats.worstFrame[k] = 0;
    const link: LanderPhase = p === 'off' ? 'off' : p.startsWith('leave') ? 'leaving' : p === 'on' || p === 'in' ? 'ready' : 'loading';
    if (link !== landerLink.phase) { landerLink.phase = link; emitLink(); }
  }

  private kick() {
    if (!this.raf) { this.lastTick = performance.now(); this.raf = requestAnimationFrame(this.tick); }
  }

  private tick = (now: number) => {
    this.raf = 0;
    const gap = now - this.lastTick;
    const dt = Math.min(0.1, Math.max(0.001, gap / 1000));
    this.lastTick = now;
    if (this.phase in this.stats.worstFrame && this.ticksInPhase++ > 0) this.stats.worstFrame[this.phase] = Math.max(this.stats.worstFrame[this.phase], Math.round(gap));
    const scene = this.viewer.scene, since = now - this.phaseT0;
    let again = false;

    switch (this.phase) {
      case 'out':
        if (since >= FADE_OUT_MS) this.place();
        again = true;
        break;
      case 'load': {
        this.setEyeHeight(true);
        const shadowsOk = !this.shadows || !this.materialOn || (this.shadows.ready[1] && this.shadows.ready[2] && (!this.means || this.means.ready));
        if (since > 700) this.fadeNote.classList.add('show');
        const looking = this.ringStep > 0 && this.ringStep < RING_STEPS;
        if (looking && (this.groundReady(now, true) || since > RING_MS)) {
          // next direction round (and, after the last, back to where you will look first)
          this.ringStep = since > RING_MS ? RING_STEPS : this.ringStep + 1;
          this.az = wrap360(this.ringAz0 + (this.ringStep < RING_STEPS ? this.ringStep * 360 / RING_STEPS : 0));
          this.okFrames = 0; this.shapeDoneT = 0;
        } else if (!looking && this.ringStep === 0 && this.groundReady(now, true) && since > 120 && RING_ON && settings.get().quality !== 'light') {
          this.ringStep = 1;
          this.az = wrap360(this.ringAz0 + 360 / RING_STEPS);
          this.okFrames = 0; this.shapeDoneT = 0;
        } else if (!looking && ((this.groundReady(now) && since > 120 && shadowsOk) || since > LOAD_TIMEOUT_MS)) {
          this.az = this.ringAz0;
          this.stats.loadTimedOut = since > LOAD_TIMEOUT_MS;
          this.stats.loadMs = Math.round(now - this.enterT0);
          this.setLoadBoost(false);
          // open the curtain on the right exposure, not on one that then drifts
          if (this.meter()) {
            this.meterAt = now;
            this.exposure = this.exposureTarget;
            if (this.material) (this.material.uniforms as Record<string, unknown>).lvExposure = this.exposure;
            this.setSkyExposure(this.skyTarget);
          }
          if (!this.walking && this.view === 'spot') this.parkRover(); // now on the final ground, in plain sight
          this.placeRocks();
          this.fade.classList.remove('on');
          this.setPhase('in');
        }
        again = true;
        break;
      }
      case 'in':
        if (since >= FADE_IN_MS) { this.stats.enterMs = Math.round(now - this.enterT0); this.setPhase('on'); }
        again = true;
        break;
      case 'leaveOut':
        if (since >= FADE_OUT_MS) { this.restoreMap(); this.okFrames = 0; this.shapeDoneT = 0; this.setPhase('leaveLoad'); }
        again = true;
        break;
      case 'leaveLoad':
        // the map view was on screen a moment ago, so its tiles are normally still in memory
        if ((this.groundReady(now) && since > 60) || since > LEAVE_TIMEOUT_MS) { this.fade.classList.remove('on'); this.setPhase('leaveIn'); }
        again = true;
        break;
      case 'leaveIn':
        if (since >= FADE_IN_MS) { this.stats.exitMs = Math.round(now - this.exitT0); this.setPhase('off'); } else again = true;
        break;
      default:
    }

    if (this.placed) {
      if (this.stepView(dt, now)) again = true;
      if (this.stepLamp(dt)) again = true;
      const d = this.driver;
      if (d && this.roverParked && this.phase !== 'out') {
        // the rover: driven by the keys, and always standing on the ground as finer tiles arrive
        const k = this.walking && this.phase === 'on' ? this.keys : NO_KEYS;
        const fwd = (k.has('w') || k.has('ArrowUp') ? 1 : 0) - (k.has('s') || k.has('ArrowDown') ? 1 : 0);
        const turn = (k.has('d') || k.has('ArrowRight') ? 1 : 0) - (k.has('a') || k.has('ArrowLeft') ? 1 : 0);
        const was = d.blocked;
        const moving = d.step(dt, { fwd, turn, fast: k.has('Shift') }, this.walkEnv);
        if (d.blocked && !was && (fwd || turn)) roverAudio.chirp('blocked');
        // on and behind the rover the camera turns with it
        if (this.view !== 'spot' && d.turned) { this.az = wrap360(this.az + d.turned); if (this.anim) this.anim.az0 += d.turned; }
        // driving on, the chase camera drifts back behind the rover (unless you are looking around)
        if (this.view === 'third' && Math.abs(d.speed) > 0.5 && !this.anim && !this.pointers.size && !landerLink.mouseLocked && now - this.lastMoveT > 1500) {
          const k = 1 - Math.exp(-dt / 2.5), off = ((d.heading - this.az + 540) % 360) - 180;
          this.az = wrap360(this.az + off * k);
          this.el += (ROVER.chaseEl - this.el) * k;
        }
        roverAudio.drive(Math.abs(d.speed), fwd || turn ? 1 : 0, Math.abs(d.yawRate));
        if (this.stepBody(dt, d.speed)) again = true;
        if (this.stepSway(dt)) again = true;
        if (this.stepHead(dt, now)) again = true;
        this.placeRoverModel();
        if (this.stepRobotFx(dt, d)) again = true;
        if (moving) this.roverMoved(now);
        this.setMoving(this.view !== 'spot' && Math.abs(d.speed) > 0.05);
        if (moving || fwd || turn || this.phase === 'in' || (this.phase === 'on' && since < 3000)) again = true;
      }
      if (this.phase === 'on' || this.phase === 'in' || this.phase === 'load') {
        const spotMoving = this.setEyeHeight(this.phase === 'load');
        if (this.walkerActive) {
          if (this.placeEye(now)) again = true;
          this.afterMove();
          this.setWalkLink(false);
          if (this.stepRecentre()) again = true;
        } else if (spotMoving && this.phase === 'on') again = true;
      }
      // shadows: build the height maps in small slices, then sweep when the Sun has moved
      const sh = this.shadows;
      if (sh && this.materialOn) {
        if (sh.busy) {
          if (sh.work(3)) {
            this.shadowDirty = true;
            this.stats.shadowBuildMs = Math.round(sh.buildMs);
            if (!sh.busy) this.uploadHeights();
          }
          again = true;
        }
        if (this.shadowDirty) { this.sweepShadows(); this.applyLight(); }
        // the light meter follows the view (a few times a second is plenty: the exposure eases anyway)
        const key = `${this.az.toFixed(1)},${this.el.toFixed(1)},${this.fov.toFixed(1)},${(this.eye.x / 2).toFixed(0)},${(this.eye.y / 2).toFixed(0)},${(this.eye.z / 2).toFixed(0)}`;
        if (key !== this.meterKey) {
          again = true;
          if (now - this.meterAt > 60) { this.meterKey = key; if (this.meter()) this.meterAt = now; }
        }
      }
      if (this.stepMarch(dt)) again = true;
      if (this.exposure > 0 && Math.abs(this.exposure / this.exposureTarget - 1) > 0.004) {
        // the camera adjusts like an eye (in steps of brightness, not of numbers), over about a second
        this.exposure *= Math.exp(Math.log(this.exposureTarget / this.exposure) * (1 - Math.exp(-dt / 0.3)));
        if (this.material) (this.material.uniforms as Record<string, unknown>).lvExposure = this.exposure;
        if (this.rocksShown) for (const r of this.rocks) if (r.spot) r.shader.setUniform('u_exposure', this.exposure);
        this.roverShader?.setUniform('u_exposure', this.exposure);
        again = true;
      }
      if (Math.abs(this.skyExposure - this.skyTarget) > 0.004) {
        this.setSkyExposure(this.skyExposure + (this.skyTarget - this.skyExposure) * (1 - Math.exp(-dt / 0.3)));
        again = true;
      }
      scene.requestRender();
    } else if (this.phase !== 'off') scene.requestRender();

    if (again) this.raf = requestAnimationFrame(this.tick);
  };

  /** Turning, zooming and coasting. Returns true while something is still moving. */
  private stepView(dt: number, now: number): boolean {
    let moving = false;
    const a = this.anim;
    if (a) {
      const t = clamp((now - a.t0) / a.dur, 0, 1), e = t * t * (3 - 2 * t);
      this.az = wrap360(a.az0 + a.dAz * e);
      this.el = a.el0 + a.dEl * e;
      if (t >= 1) this.anim = null; else moving = true;
    }
    if (this.keys.size && this.phase === 'on') {
      const sp = this.fov * 0.75 * dt;
      if (!this.walking) {
        if (this.keys.has('ArrowLeft')) this.az -= sp;
        if (this.keys.has('ArrowRight')) this.az += sp;
        if (this.keys.has('ArrowUp')) this.el += sp * 0.7;
        if (this.keys.has('ArrowDown')) this.el -= sp * 0.7;
      }
      if (this.keys.has('+')) this.fovTarget = clamp(this.fovTarget * Math.exp(-1.2 * dt), FOV_MIN, FOV_MAX);
      if (this.keys.has('-')) this.fovTarget = clamp(this.fovTarget * Math.exp(1.2 * dt), FOV_MIN, FOV_MAX);
      if (!this.walking) this.anim = null;
      moving = true;
    }
    if (!this.pointers.size && (Math.abs(this.velAz) > 0.4 || Math.abs(this.velEl) > 0.4)) {
      // coast to a stop after a flick
      this.az += this.velAz * dt;
      this.el += this.velEl * dt;
      const k = Math.exp(-dt / 0.16);
      this.velAz *= k; this.velEl *= k;
      moving = true;
    }
    this.az = wrap360(this.az);
    this.el = clamp(this.el, EL_MIN, EL_MAX);
    if (Math.abs(this.fov - this.fovTarget) > 0.01) {
      this.fov += (this.fovTarget - this.fov) * (1 - Math.exp(-dt / 0.07));
      moving = true;
    } else this.fov = this.fovTarget;
    if (this.pointers.size) moving = true;
    if (landerLink.az !== this.az || landerLink.el !== this.el || landerLink.fovDeg !== this.fov) {
      landerLink.az = this.az; landerLink.el = this.el; landerLink.fovDeg = this.fov;
      emitLink();
    }
    return moving;
  }

  /** A direction (compass az / elevation, degrees) in the view's frame, or the landing spot's frame (`spot`). */
  private dirFor(azDeg: number, elDeg: number, out: Cartesian3, spot = false): Cartesian3 {
    const a = azDeg * DEG, e = elDeg * DEG, h = Math.cos(e), s = Math.sin(e), n = h * Math.cos(a), ea = h * Math.sin(a);
    const N = spot ? this.north : this.viewN, E = spot ? this.east : this.viewE, U = spot ? this.up : this.viewU;
    out.x = N.x * n + E.x * ea + U.x * s;
    out.y = N.y * n + E.y * ea + U.y * s;
    out.z = N.z * n + E.z * ea + U.z * s;
    return out;
  }

  /** The camera only ever turns about the spot's own up direction and tilts: it cannot roll. */
  private applyCamera() {
    const cam = this.viewer.camera;
    this.dirFor(this.az, this.el, cam.direction);
    this.dirFor(this.az, this.el + 90, cam.up);
    Cartesian3.cross(cam.direction, cam.up, cam.right);
    Cartesian3.clone(this.eye, cam.position);

    const fr = cam.frustum as unknown as { fov: number; aspectRatio: number };
    // our "fov" is the width of the view; Cesium's is along the longer side of the window
    const want = fr.aspectRatio >= 1 ? this.fov * DEG : 2 * Math.atan(Math.tan(this.fov * DEG / 2) / fr.aspectRatio);
    if (Math.abs(fr.fov - want) > 1e-6) fr.fov = want;
  }

  // ---- the rover (see walk.ts) ---------------------------------------------------------------

  /** Park the rover a few metres in front of the landing spot, turned a little, so you see it when you arrive. */
  private parkRover() {
    const spec = this.spec;
    if (!spec || !this.materialOn) { this.roverParked = false; return; }
    const base = Cartesian3.clone(toCartesian(spec.lat, spec.lon, 0, scratchA), this.parkBase);
    // the first place in front of you (straight ahead first, then a little to either side, near first) where
    // you can see the whole rover from the eye: not hidden behind a crest, not on a steep bit
    const eyeH = Cartesian3.magnitude(this.spotEye) - MOON_R;
    const at = (e: number, n: number, out: Cartesian3) => Cartesian3.fromElements(base.x + this.east.x * e + this.north.x * n, base.y + this.east.y * e + this.north.y * n, base.z + this.east.z * e + this.north.z * n, out);
    const S = ROVER.scale, parkM = ROVER.parkM * S;
    let e = Math.sin(this.az * DEG) * parkM, n = Math.cos(this.az * DEG) * parkM;
    search: for (const dist of [parkM, 13 * S, 16 * S]) {
      for (const off of [0, -22, 22, -45, 45]) {
        const a = (this.az + off) * DEG, ce = Math.sin(a) * dist, cn = Math.cos(a) * dist;
        const g = this.groundUnder(at(ce, cn, scratchB));
        const g2 = this.groundUnder(at(ce + Math.sin(a) * 1.5, cn + Math.cos(a) * 1.5, scratchB));
        if (Math.abs(g2 - g) / 1.5 > 0.3) continue;
        // the line from the eye to the rover's deck (1 m up) stays above the ground
        let seen = true;
        for (let k = 1; k < 8 && seen; k++) {
          const t = k / 8, h = eyeH + (g + S - eyeH) * t;
          if (this.groundUnder(at(ce * t, cn * t, scratchB)) > h - 0.1) seen = false;
        }
        if (seen) { e = ce; n = cn; break search; }
      }
    }
    this.parkAt = [e, n, 2.4 * S];
    const p = Cartesian3.fromElements(base.x + this.east.x * e + this.north.x * n, base.y + this.east.y * e + this.north.y * n, base.z + this.east.z * e + this.north.z * n, scratchB);
    this.driver ??= new Driver();
    this.driver.reset(p, this.north, wrap360(this.az + ROVER.parkTurn), this.walkEnv, base);
    this.roverParked = true;
    this.robotSig = '';
    if (this.rover && this.roverReady) { this.placeRoverModel(); this.rover.show = true; }
  }

  /**
   * Start or stop driving. Driving starts behind the rover (the chase camera); stopping keeps the camera where
   * it is. "Back to lander" (setView('spot')) glides back to the landing spot; the rover stays where it is.
   */
  setWalk(on: boolean) {
    if (on === this.walking) return;
    if (!on) {
      this.walking = false;
      roverAudio.driving(false);
      this.keys.clear();
      if (document.pointerLockElement === this.canvas) document.exitPointerLock();
      this.setWalkLink();
      return;
    }
    if (!this.canLook() || !this.driver || !this.roverParked) return;
    this.walking = true;
    if (this.view === 'spot') this.setView('third');
    roverAudio.chirp('start');
    roverAudio.driving(true);
    this.velAz = this.velEl = 0;
    this.setWalkLink();
    this.kick();
  }

  /** Move the camera: the landing spot, behind the rover, or on its mast. A smooth glide, never a cut. */
  setView(v: 'spot' | 'third' | 'first') {
    if (!this.placed || !this.canLook() || v === this.view) return;
    const d = this.driver;
    if (v !== 'spot' && (!d || !this.roverParked)) return;
    this.glide = { from: Cartesian3.clone(this.eye), t0: performance.now() };
    this.view = v;
    let az = this.az, el = this.el;
    if (d && v === 'third') { az = d.heading; el = ROVER.chaseEl; }
    else if (d && v === 'first') { az = d.heading; el = ROVER.firstEl; }
    else if (d) {
      // back at the lander: look over at the rover
      Cartesian3.subtract(d.feet, this.spotEye, scratchA);
      az = wrap360(Math.atan2(Cartesian3.dot(scratchA, this.east), Cartesian3.dot(scratchA, this.north)) / DEG);
      el = -6;
      this.walking = false;
      roverAudio.driving(false);
      this.keys.clear();
      if (document.pointerLockElement === this.canvas) document.exitPointerLock();
      this.goHome();
    }
    const dAz = ((wrap360(az) - this.az + 540) % 360) - 180;
    this.velAz = this.velEl = 0;
    this.anim = { az0: this.az, el0: this.el, dAz, dEl: el - this.el, t0: performance.now(), dur: ROVER.glideMs };
    roverAudio.chirp('view');
    this.setWalkLink();
    this.kick();
  }

  /**
   * Where the eye is for the view (and on the glide into it). Behind the rover the camera looks at a point a
   * metre above it from chaseDist away, and never dips under the ground (it rises and looks down a little more).
   * True while still gliding.
   */
  private placeEye(now: number): boolean {
    const d = this.driver, target = scratchH;
    if (this.view === 'spot' || !d) {
      Cartesian3.clone(this.spotEye, target);
      Cartesian3.clone(this.east, this.viewE); Cartesian3.clone(this.north, this.viewN); Cartesian3.clone(this.up, this.viewU);
    } else {
      Cartesian3.clone(d.east, this.viewE); Cartesian3.clone(d.north, this.viewN); Cartesian3.clone(d.up, this.viewU);
      if (this.view === 'third') {
        const look = Cartesian3.add(d.base(scratchI), Cartesian3.multiplyByScalar(d.up, ROVER.lookUp * ROVER.scale, scratchJ), scratchI);
        const D = this.chaseDist, minClear = Math.max(0.45, 0.9 * ROVER.scale);
        for (let i = 0; i < 2; i++) {
          this.dirFor(this.az, this.el, scratchJ);
          Cartesian3.subtract(look, Cartesian3.multiplyByScalar(scratchJ, D, scratchJ), target);
          const clear = Cartesian3.magnitude(target) - MOON_R - this.groundUnder(target);
          if (clear >= minClear) break;
          // too low: rise along the orbit until the camera is clear of the ground again
          const h = -Math.sin(this.el * DEG) * D + (minClear - clear);
          this.el = clamp(-Math.asin(clamp(h / D, -1, 1)) / DEG, EL_MIN, 60);
        }
      } else {
        // on the mast the camera rides with the body but keeps the horizon level (a gimballed camera): only a
        // little of the springs' rocking and the ride's sway reach it (see stepSway)
        const U = this.viewU, p = this.rock * 0.5 + this.swayP + this.swayAmp * 0.35 * Math.sin(this.swayT * 1.7), r = this.swayR + this.swayAmp * Math.sin(this.swayT);
        const F = Cartesian3.subtract(d.fwd, Cartesian3.multiplyByScalar(d.up, Cartesian3.dot(d.fwd, d.up), scratchL), scratchL);
        Cartesian3.normalize(F, F);
        const Rt = Cartesian3.cross(F, d.up, scratchM);
        Cartesian3.fromElements(
          d.up.x * Math.cos(p) - F.x * Math.sin(p) + Rt.x * Math.sin(r),
          d.up.y * Math.cos(p) - F.y * Math.sin(p) + Rt.y * Math.sin(r),
          d.up.z * Math.cos(p) - F.z * Math.sin(p) + Rt.z * Math.sin(r), U);
        Cartesian3.normalize(U, U);
        Cartesian3.subtract(d.east, Cartesian3.multiplyByScalar(U, Cartesian3.dot(d.east, U), scratchL), this.viewE);
        Cartesian3.normalize(this.viewE, this.viewE);
        Cartesian3.cross(U, this.viewE, this.viewN);
        const S = ROVER.scale, m = [ROVER.mast[0] * S, ROVER.mast[1] * S, ROVER.mast[2] * S];
        const b = d.base(scratchI);
        Cartesian3.fromElements(
          b.x - d.right.x * m[0] + d.bodyUp.x * m[1] + d.fwd.x * m[2],
          b.y - d.right.y * m[0] + d.bodyUp.y * m[1] + d.fwd.y * m[2],
          b.z - d.right.z * m[0] + d.bodyUp.z * m[1] + d.fwd.z * m[2], target);
      }
    }
    // the mast camera is small and close to the deck: a nearer near plane, so the deck is drawn, not cut open
    const fr = this.viewer.camera.frustum as unknown as { near: number }, near = this.view === 'first' ? ROVER.firstNear : NEAR_M;
    if (fr.near !== near) fr.near = near;
    const g = this.glide;
    if (!g) { Cartesian3.clone(target, this.eye); return false; }
    const t = clamp((now - g.t0) / ROVER.glideMs, 0, 1), e = t * t * (3 - 2 * t);
    Cartesian3.lerp(g.from, target, e, this.eye);
    // (an arc, not a straight line: the camera lifts a little on the way so it never skims through the ground)
    const lift = Math.sin(Math.PI * t) * Math.min(4, 0.25 * Cartesian3.distance(g.from, target));
    Cartesian3.add(this.eye, Cartesian3.multiplyByScalar(this.viewU, lift, scratchJ), this.eye);
    if (t >= 1) { this.glide = null; this.setWalkLink(); }
    return true;
  }

  /** Put the model where the rover is: its body on its wheels, tilted with the ground. */
  private placeRoverModel() {
    const d = this.driver, m = this.rover;
    if (!d || !m || !this.roverReady || !this.roverParked) return;
    const b = d.base(scratchI), R = d.right;
    // rocking on its springs: the body turns about its right axis (nose up = positive)
    const c = Math.cos(this.rock), sn = Math.sin(this.rock);
    const F = Cartesian3.add(Cartesian3.multiplyByScalar(d.fwd, c, scratchK), Cartesian3.multiplyByScalar(d.bodyUp, sn, scratchL), scratchK);
    const U = Cartesian3.subtract(Cartesian3.multiplyByScalar(d.bodyUp, c, scratchL), Cartesian3.multiplyByScalar(d.fwd, sn, scratchM), scratchL);
    // the GLB: +X = the rover's left, +Y = up, +Z = forward
    const S = ROVER.scale;
    m.modelMatrix = Matrix4.fromArray([-R.x * S, -R.y * S, -R.z * S, 0, U.x * S, U.y * S, U.z * S, 0, F.x * S, F.y * S, F.z * S, 0, b.x, b.y, b.z, 1], 0, this.roverM);
    this.rig?.pose(d);
    if (!m.show) m.show = true;
  }

  /** After the rover moved: its shadow on the ground (now and then) and its light. */
  private roverMoved(now: number) {
    const d = this.driver;
    if (!d) return;
    // (the robot's own shadow is redrawn every frame by drawRobotShadow; the whole picture only when it nears the edge of the sharp part)
    if (Math.hypot(Cartesian3.dot(d.feet, this.east) - this.rockMapC[0], Cartesian3.dot(d.feet, this.north) - this.rockMapC[1]) > 3) this.rasterRocks();
    if (now - this.roverLightAt > 250) { this.roverLightAt = now; this.updateRoverLight(); }
  }

  /** Leave driving altogether (going back to the map). */
  private stopWalking() {
    this.setMoving(false);
    this.walking = false;
    roverAudio.driving(false);
    this.keys.clear();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.setWalkLink();
  }

  /** Back at the landing spot: its own shadow and height maps again if the rover had driven far. */
  private goHome() {
    if (!this.placed || !this.spec) return;
    const spec = this.spec;
    this.recentre = null;
    if (this.homeMaps && (this.mapAt.lat !== spec.lat || this.mapAt.lon !== spec.lon)) {
      const hm = this.homeMaps;
      this.homeMaps = null;
      this.swapMaps(spec.lat, spec.lon, hm.sh, hm.means);
    }
  }

  /**
   * Walking far: the shadow and height maps (and the photo averages) are centred on the landing spot and
   * cover about 10 km round it. Once you are RECENTRE_M away we build a second set round where you are, a
   * few milliseconds per frame, and swap to it in one frame when it is complete (nothing changes on screen
   * except that far shadows stay right). The landing spot's set is kept for the way back.
   */
  private stepRecentre() {
    if (!this.walkerActive || this.view === 'spot' || !this.driver || !this.shadows || !this.materialOn) return false;
    const rc = this.recentre;
    if (!rc) {
      const off = Math.hypot(Cartesian3.dot(this.eye, this.east), Cartesian3.dot(this.eye, this.north));
      if (off < RECENTRE_M) return false;
      const t = toTrueLatLon(this.driver.feet);
      const sh = new TerrainShadows(this.heights);
      sh.start(t.lat, t.lon);
      const next = { lat: t.lat, lon: t.lon, sh, means: null as PhotoMeans | null, meansDone: false };
      this.recentre = next;
      if (this.means) {
        const pm = new PhotoMeans(new URL('./data/polar/t/', document.baseURI).href);
        next.means = pm;
        void pm.start(t.lat, t.lon).then(() => { next.meansDone = true; }, () => { next.meansDone = true; });
      } else next.meansDone = true;
      return true;
    }
    if (rc.sh.busy) { rc.sh.work(2); return true; }
    if (!rc.meansDone) return true;
    this.swapMaps(rc.lat, rc.lon, rc.sh, rc.means);
    this.recentre = null;
    return true;
  }

  /** Make (lat, lon) the centre of the shadow / height / photo-average maps (true lat / lon of the new centre). */
  private swapMaps(lat: number, lon: number, sh: TerrainShadows, means: PhotoMeans | null) {
    const spec = this.spec, mat = this.material;
    if (!spec || !mat) return;
    const t0 = performance.now();
    const atHome = Math.abs(this.mapAt.lat - spec.lat) < 1e-9 && Math.abs(this.mapAt.lon - spec.lon) < 1e-9;
    if (atHome && this.shadows) this.homeMaps = { sh: this.shadows, means: this.means };
    this.shadows = sh;
    if (means) this.means = means;
    this.mapAt = { lat, lon };
    const enu = trueENU(lat, lon);
    Cartesian3.clone(enu.east, this.east); Cartesian3.clone(enu.north, this.north); Cartesian3.clone(enu.up, this.up);
    const u = mat.uniforms as Record<string, unknown>;
    Cartesian3.clone(this.east, u.lvEast as Cartesian3);
    Cartesian3.clone(this.north, u.lvNorth as Cartesian3);
    Cartesian3.clone(this.up, u.lvUp as Cartesian3);
    this.sweptAz = this.sweptEl = 999;
    Cartesian2.fromElements(Cartesian3.dot(this.rockOrigin, this.east), Cartesian3.dot(this.rockOrigin, this.north), u.lvCraterKeep as Cartesian2);
    this.applyLight(); // sun direction in the new frame
    this.sweepShadows();
    this.uploadHeights();
    this.uploadMeans();
    this.afterMove(true);
    this.applyLight();
    this.stats.recentreMs = Math.round(performance.now() - t0);
    this.stats.recentres++;
  }
  private recentre: { lat: number; lon: number; sh: TerrainShadows; means: PhotoMeans | null; meansDone: boolean } | null = null;
  private homeMaps: { sh: TerrainShadows; means: PhotoMeans | null } | null = null;
  private mapAt = { lat: 0, lon: 0 };

  /** While you move: lighter little shadows and gentler tile loading, so walking stays smooth; full detail when you stop. */
  private setMoving(on: boolean) {
    if (on === this.moving) return;
    this.moving = on;
    const surface = (this.viewer.scene.globe as unknown as { _surface?: { _loadQueueTimeSlice?: number } })._surface;
    if (surface && typeof surface._loadQueueTimeSlice === 'number') surface._loadQueueTimeSlice = on ? TILE_SLICE_MOVING : 5;
    if (!on) this.viewer.scene.requestRender();
  }
  private moving = false;

  /**
   * How far the ground's little cast shadows are traced (the costliest part of the ground shader). While you
   * walk or turn the view quickly it eases down to MARCH_FAR_MOVING (motion hides them anyway) so frames keep
   * coming every 16 ms; it eases back out once the view settles. The shader fades them out at that reach
   * instead of cutting them, so the change never shows as a line. True while still easing.
   */
  private stepMarch(dt: number): boolean {
    const mat = this.material;
    if (!mat) return false;
    const turn = Math.abs(((this.az - this.marchAz + 540) % 360) - 180) / Math.max(dt, 1e-3);
    this.marchAz = this.az;
    const fast = this.moving || turn > 25;
    if (fast) this.marchHold = 0.35; else this.marchHold = Math.max(0, this.marchHold - dt);
    const goal = this.marchHold > 0 ? MARCH_FAR_MOVING : MARCH_FAR;
    // the detail governor (groundLod.ts): sheds detail while moving if the graphics chip runs over its budget
    this.lod ??= new GroundGovernor(this.viewer.scene);
    const lodBusy = this.lod.step(dt, this.marchHold > 0, (mat.uniforms as Record<string, unknown>).lvLod as Cartesian2);
    const q = (mat.uniforms as Record<string, unknown>).lvWalkQ as Cartesian2;
    if (Math.abs(q.x - goal) < 0.5) { q.x = goal; return lodBusy; }
    // down fast (the next frame must be cheap), back up gently (shadows grow out over ~half a second)
    q.x += (goal - q.x) * (1 - Math.exp(-dt / (goal < q.x ? 0.05 : 0.25)));
    return true;
  }
  private marchAz = 0;
  private lod: GroundGovernor | null = null;
  private marchHold = 0;

  /** Ground height under a world position (m above the sphere): the drawn ground, else the NASA height map. */
  private groundUnder(p: Cartesian3): number {
    const c = Cartographic.fromCartesian(p, MOON_ELLIPSOID, scratchCarto3);
    const h = c ? this.drawnHeight(c) : undefined;
    if (h !== undefined) return h;
    const t = toTrueLatLon(p);
    return this.heights.heightAt(t.lat, t.lon, true);
  }

  /** Rocks you can bump into (the ones drawn near you). */
  private rockObstacles(): readonly WalkObstacle[] {
    const out = this.obstacleList;
    out.length = 0;
    const w = this.driver;
    if (!w) return out;
    // each rock's real outline from above as a short row of circles (rockOutline.ts), within reach of the robot
    return rockOutlines(out, this.rocks, w.feet, this.rockE, this.rockN, ROCK_BURY, 2.5);
  }

  /** Publish the walking state to the HUD (a few times a second at most while moving). */
  private setWalkLink(force = true) {
    const now = performance.now();
    if (!force && now - this.lastWalkLink < 200) return;
    this.lastWalkLink = now;
    const dr = this.driver && this.roverParked ? this.driver : null;
    const d = dr ? Math.hypot(Cartesian3.dot(dr.feet, this.rockE), Cartesian3.dot(dr.feet, this.rockN)) : 0;
    const blocked = this.walking && dr ? dr.blocked : '';
    const speed = dr ? Math.round(Math.abs(dr.speed) * 10) / 10 : 0;
    const lit = this.lampIn > 0.5;
    if (landerLink.walking !== this.walking || Math.abs(landerLink.walkDistM - d) > 0.5 || landerLink.walkBlocked !== blocked || landerLink.view !== this.view
      || landerLink.speedMs !== speed || landerLink.lightsLit !== lit) {
      landerLink.walking = this.walking; landerLink.walkDistM = d; landerLink.walkBlocked = blocked; landerLink.view = this.view;
      landerLink.speedMs = speed; landerLink.lightsLit = lit;
      emitLink();
    }
  }

  /**
   * After the eye has moved (walking): the view's frame, the shader's idea of where the eye is, the skyline
   * (it belongs to the landing spot), the rocks around you and their shadow picture.
   */
  private afterMove(force = false) {
    const mat = this.material;
    if (mat) {
      const w = (mat.uniforms as Record<string, unknown>).lvWalk as Cartesian4;
      w.x = Cartesian3.dot(this.eye, this.east); w.y = Cartesian3.dot(this.eye, this.north);
    }
    const fromSpot = Math.hypot(Cartesian3.dot(this.eye, this.rockE), Cartesian3.dot(this.eye, this.rockN));
    this.fromSpot = fromSpot;
    this.showSkyline();
    // new rocks come into reach every metre or so; the rock-shadow picture follows your feet
    const we = Cartesian3.dot(this.eye, this.rockE), wn = Cartesian3.dot(this.eye, this.rockN);
    if (force || Math.hypot(we - this.rockAt[0], wn - this.rockAt[1]) > 1.5) this.placeRocks();
    else {
      const cx = Cartesian3.dot(this.eye, this.east), cy = Cartesian3.dot(this.eye, this.north);
      if (Math.hypot(cx - this.rockMapAt[0], cy - this.rockMapAt[1]) > 1.2) this.rasterRocks();
    }
  }

  // ---- looking around ------------------------------------------------------------------------

  private canLook() { return this.placed && this.active && (this.phase === 'on' || this.phase === 'in'); }

  private degPerPx(): number {
    // at the middle of the screen one pixel is this many degrees, so the ground follows the hand
    return (2 * Math.tan(this.fov * DEG / 2)) / (this.canvas.clientWidth || 1) / DEG;
  }

  private onDown = (e: PointerEvent) => {
    if (!this.canLook()) return;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.downT = performance.now(); this.downX = e.clientX; this.downY = e.clientY;
    this.anim = null;
    this.velAz = this.velEl = 0;
    this.lastMoveT = performance.now();
    this.pinch = null;
    if (this.pointers.size === 2) {
      const [p, q] = [...this.pointers.values()];
      this.pinch = { d: Math.max(20, Math.hypot(p.x - q.x, p.y - q.y)), fov: this.fovTarget };
    }
    this.canvas.style.cursor = 'grabbing';
    e.preventDefault();
    this.kick();
  };

  private onMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.canLook()) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.max(20, Math.hypot(a.x - b.x, a.y - b.y));
      this.fov = this.fovTarget = clamp(this.pinch.fov * this.pinch.d / d, FOV_MIN, FOV_MAX);
      this.kick();
      return;
    }
    // Street-View direction: the scene follows the hand (drag left -> the view turns right)
    const k = this.degPerPx();
    const dAz = (-dx * k) / Math.max(0.4, Math.cos(this.el * DEG)), dEl = dy * k;
    this.az = wrap360(this.az + dAz);
    this.el = clamp(this.el + dEl, EL_MIN, EL_MAX);
    const now = performance.now(), dt = Math.max(4, now - this.lastMoveT) / 1000;
    this.lastMoveT = now;
    this.velAz += (dAz / dt - this.velAz) * 0.45;
    this.velEl += (dEl / dt - this.velEl) * 0.45;
    this.kick();
  };

  private onUp = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!this.pointers.delete(e.pointerId)) return;
    // a click (no drag) while walking captures the mouse for looking around, as in a game; Esc gives it back
    if (p && this.walking && this.pointers.size === 0 && performance.now() - this.downT < 300 && Math.hypot(e.clientX - this.downX, e.clientY - this.downY) < 4
      && document.pointerLockElement !== this.canvas && performance.now() - landerLink.unlockedAt > 600) {
      try { void (this.canvas.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {}); } catch { /* not allowed here */ }
    }
    this.pinch = null;
    if (!this.pointers.size) {
      if (this.placed) this.canvas.style.cursor = 'grab';
      if (performance.now() - this.lastMoveT > 90) this.velAz = this.velEl = 0; // the hand had stopped: no coasting
      this.velAz = clamp(this.velAz, -400, 400);
      this.velEl = clamp(this.velEl, -300, 300);
    } else this.velAz = this.velEl = 0;
    this.kick();
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.canLook() || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('input, textarea, select, [contenteditable], [role=slider]')) return;
    const key = e.key === '=' ? '+' : e.key === '_' ? '-' : e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // driving: W A S D / arrows drive (and start driving), Shift is fast, V changes the camera, L the headlights
    if (key === 'v' && !e.repeat) {
      if (this.roverParked) this.setView(this.view === 'third' ? 'first' : 'third');
      e.preventDefault();
      return;
    }
    if (key === 'l' && !e.repeat) {
      landerLink.setLights(this.lampIn > 0.5 ? 'off' : 'on');
      e.preventDefault();
      return;
    }
    if (DRIVE_KEYS.has(key)) {
      if (!this.walking) this.setWalk(true);
      if (!this.walking) return;
      this.keys.add(key);
      e.preventDefault();
      this.kick();
      return;
    }
    if (this.walking && key === 'Shift') {
      this.keys.add(key);
      e.preventDefault();
      this.kick();
      return;
    }
    if (!['+', '-'].includes(key)) return;
    if (!e.repeat && key.startsWith('Arrow')) {
      // a short tap nudges the view; holding the key keeps turning (see stepView)
      const push = this.fov * 0.45;
      this.anim = null;
      if (key === 'ArrowLeft') this.velAz = -push; else if (key === 'ArrowRight') this.velAz = push;
      else if (key === 'ArrowUp') this.velEl = push * 0.7; else this.velEl = -push * 0.7;
    }
    this.keys.add(key);
    e.preventDefault();
    this.kick();
  };
  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.key === '=' ? '+' : e.key === '_' ? '-' : e.key.length === 1 ? e.key.toLowerCase() : e.key); };
  private onBlur = () => { this.keys.clear(); };

  /** Turn smoothly to face a compass direction / height in the sky. */
  look(azDeg: number, elDeg: number) {
    if (!this.placed || !this.active) return;
    const el1 = clamp(elDeg, EL_MIN, 85);
    const dAz = ((wrap360(azDeg) - this.az + 540) % 360) - 180, dEl = el1 - this.el;
    const dur = clamp(Math.hypot(dAz, dEl) * 9, 350, 1100);
    this.velAz = this.velEl = 0;
    this.anim = { az0: this.az, el0: this.el, dAz, dEl, t0: performance.now(), dur };
    this.kick();
  }

  /** Zoom the lens (wheel delta: positive = wider, negative = closer). The view is 20°..90° wide. */
  zoomFov(delta: number) {
    if (!this.placed || !this.active) return;
    if (this.view === 'third') {
      // behind the rover the wheel moves the camera nearer or further instead
      this.chaseDist = clamp(this.chaseDist * Math.exp(clamp(delta, -400, 400) * 0.0016), ROVER.distMin * ROVER.scale, ROVER.distMax);
      this.kick();
      return;
    }

    this.fovTarget = clamp(this.fovTarget * Math.exp(clamp(delta, -400, 400) * 0.0016), FOV_MIN, FOV_MAX);
    this.kick();
  }

  // ---- Sun, Earth and light --------------------------------------------------------------------

  updateSky(sky: SkyState) {
    if (!this.active) return;
    this.sky = sky;
    if (!this.placed) return;
    this.applyLight();
    this.kick();
  }

  private makePictures() {
    if (this.sunPic) return;
    const prims = this.viewer.scene.primitives;
    this.sunPic = prims.add(picture(SUN_SVG)) as Primitive;
    this.earthPic = prims.add(picture(earthSvg(0.5))) as Primitive;
  }

  /**
   * Build the Sun / Earth pictures at start and draw them once, invisibly small at the Moon's centre, so their
   * shaders are compiled while the loading screen is still up and not on the first "Stand here".
   */
  private warmPictures() {
    this.makePictures();
    const scene = this.viewer.scene, pics = [this.sunPic!, this.earthPic!];
    for (const p of pics) { placePicture(p, Cartesian3.ZERO, Cartesian3.UNIT_Z, Cartesian3.UNIT_Y, 0.5); p.show = true; }
    let frames = 0;
    const off = scene.postRender.addEventListener(() => {
      if (++frames < 4) { scene.requestRender(); return; }
      off();
      if (!this.placed) for (const p of pics) p.show = false;
    });
    this.offs.push(off);
    scene.requestRender();
  }

  private ensureMaterial() {
    const globe = this.viewer.scene.globe;
    if (this.material || globe.material) return;
    this.material = new Material({
      translucent: false,
      fabric: {
        type: 'MoondaLanderGround',
        uniforms: {
          lvOn: 0, lvExposure: 1,
          lvSunDir: new Cartesian3(1, 0, 0), lvEarthDir: new Cartesian3(1, 0, 0),
          lvEast: new Cartesian3(0, 0, 1), lvNorth: new Cartesian3(0, -1, 0),
          lvSunAz: new Cartesian2(0, 1), lvSpan: new Cartesian3(0, 0, 0),
          lvSunColor: new Cartesian3(...SUN_TINT),
          lvAmbient: new Cartesian3(0.03, 0.03, 0.035), lvEarthLight: new Cartesian3(0, 0, 0),
          // starlight from the whole sky (lights slopes that face up) and the helmet lamp while walking (see LAMP)
          lvStar: new Cartesian3(0, 0, 0), lvLamp: new Cartesian4(0, LAMP[1], LAMP[2], LAMP[3]),
          lvLampPos: new Cartesian3(0, 0, 0), lvLampDir: new Cartesian3(0, 0, -1),
          lvUp: new Cartesian3(1, 0, 0), lvHeightInfo: new Cartesian2(0, 1),
          lvLook: new Cartesian4(...LOOK), lvPhoto: new Cartesian4(...PHOTO), lvMeanSpan: new Cartesian2(0, 0),
          lvShadowTex: Material.DefaultImageId, lvHeightTex: Material.DefaultImageId, lvMeanTex: Material.DefaultImageId,
          lvDA: Material.DefaultImageId, lvDB: Material.DefaultImageId, lvDC: Material.DefaultImageId,
          lvRockTex: Material.DefaultImageId, lvRocks: new Cartesian4(0, 0, ROCK_MAP_CELL[0] * ROCK_MAP_N, ROCK_MAP_CELL[1] * ROCK_MAP_N),
          lvWalk: new Cartesian4(0, 0, 0, 0),
          ...sunMapUniforms(), // the Sun shadow map and the robot's contact shadow (sunShadow.ts)
          // craters: on, how many scales (4; 3 where the 80 m polar heights already show the biggest ones), share of cells with a crater, depth scale
          lvCraters: new Cartesian4(1, 4, CRATER_SHARE, 1),
          // the landing spot in the map frame (no made-up crater there)
          lvCraterKeep: new Cartesian2(0, 0),
          // x: little shadows are traced on ground nearer than this (m): beyond ~350 m they are smaller than a pixel;
          // while you walk only near the feet, where they matter (it keeps walking at 60 frames a second)
          lvWalkQ: new Cartesian2(MARCH_FAR, 0),
          lvLod: new Cartesian2(1, 1), // the ground's detail governor (groundLod.ts): level 0..1, crater footprint factor
          lvDetail: new Cartesian4(0, DETAIL_NORM, DETAIL_CAVITY, DETAIL_MARCH_M),
          lvL1: layerVec(0), lvL2: layerVec(1), lvL3: layerVec(2), lvL4: layerVec(3),
          lvGain: new Cartesian4(...DETAIL_LAYERS.map(l => l.gain) as [number, number, number, number]),
          lvFade: new Cartesian4(...DETAIL_LAYERS.map(l => l.fadeM) as [number, number, number, number]),
        },
        source: GROUND_SHADER,
      },
    });
    globe.material = this.material;
  }

  /**
   * Download the regolith scans (about 10 MB) a little after start-up, decode them off the main thread and
   * hand them to the GPU one per frame (with mipmaps and anisotropic filtering, so the ground stays sharp
   * to the horizon without shimmering). Until they arrive the ground is drawn without them.
   */
  private loadDetail() {
    if (this.detailStarted) return;
    this.detailStarted = true;
    const ctx = (this.viewer.scene as unknown as { context: unknown }).context;
    const names = ['lvDA', 'lvDB', 'lvDC'];
    const load = (url: string) => fetch(new URL(url, document.baseURI).href)
      .then(r => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.blob(); })
      .then(b => createImageBitmap(b, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }));
    void Promise.all(REGOLITH.map(r => load(r.url))).then(bitmaps => {
      let i = 0;
      const step = () => {
        if (this.viewer.isDestroyed() || !this.material) return;
        const tex = new Gpu.Texture({
          context: ctx, source: bitmaps[i], flipY: false,
          sampler: new Gpu.Sampler({
            wrapS: Gpu.TextureWrap.REPEAT, wrapT: Gpu.TextureWrap.REPEAT,
            minificationFilter: Gpu.TextureMinificationFilter.LINEAR_MIPMAP_LINEAR, magnificationFilter: Gpu.TextureMagnificationFilter.LINEAR,
            maximumAnisotropy: Math.min(16, Math.max(1, Gpu.ContextLimits.maximumTextureFilterAnisotropy || 1)),
          }),
        });
        tex.generateMipmap();
        bitmaps[i].close();
        this.detailTex.push(tex);
        const u = this.material.uniforms as Record<string, unknown>;
        u[names[i]] = tex;
        if (++i < bitmaps.length) { requestAnimationFrame(step); return; }
        (u.lvDetail as Cartesian4).x = 1;
        this.stats.detailMs = Math.round(performance.now() - this.detailT0);
        this.loadRocks();
        this.loadRover();
        this.viewer.scene.requestRender();
      };
      requestAnimationFrame(step);
    }, err => { console.warn('lander: regolith detail not loaded', err); });
  }

  /**
   * Load the rock models once (a pool of ROCK_POOL, about 4 MB in all) and draw them once, invisibly at
   * the Moon's centre, so their shaders are built now and not on the next "Stand here".
   */
  /** At night the camera is set for a dark scene (stars bright, ground dim but readable), not for a grey day. */
  private nightScale(): number {
    const key = NIGHT_KEY + (EARTH_NIGHT_KEY - NIGHT_KEY) * clamp(this.earthShare * 1.5, 0, 1);
    return 1 + (key / METER[1] - 1) * this.night;
  }

  /** The rover's headlights ease on (L, or by themselves once the Sun is down) and off. True while changing. */
  private stepLamp(dt: number): boolean {
    const mat = this.material;
    if (!mat) return false;
    const L = landerLink.lights;
    const want = this.roverParked && (this.phase === 'on' || this.phase === 'in') ? (L === 'on' ? 1 : L === 'off' ? 0 : this.night > 0.3 ? 1 : 0) : 0;
    const now = performance.now();
    if (want === 1 && this.lampWant !== 1) this.lampOnT = now;
    this.lampWant = want;
    this.lampIn += (want - this.lampIn) * (1 - Math.exp(-dt / (want ? 0.06 : 0.25)));
    if (Math.abs(want - this.lampIn) < 0.002) this.lampIn = want;
    const lamp = (mat.uniforms as Record<string, unknown>).lvLamp as Cartesian4;
    // switching on, the lamps warm up over a quarter of a second (a quick flicker, then up to full)
    const t = now - this.lampOnT;
    const wake = want === 1 && t < 250 ? (t < 40 ? 0.35 : t < 70 ? 0.08 : ((t - 70) / 180) ** 1.5) : 1;
    const x = LAMP[0] * this.lampIn * wake;
    if (lamp.x !== x) {
      lamp.x = x;
      if (this.rocksShown) for (const r of this.rocks) if (r.spot) r.shader.setUniform('u_lamp', x);
      if ((x > 0) !== (landerLink.lightsLit) && Math.abs(this.lampIn - 0.5) < 0.5) this.setWalkLink();
    }
    this.rig?.setLamps(x / LAMP[0]);
    return this.lampIn !== want || (want === 1 && t < 250);
  }

  /** Every frame, after the camera: where the headlights are and where they point, in eye coordinates. */
  private placeLamp() {
    const mat = this.material, d = this.driver;
    if (!mat || !d || this.lampIn <= 0) return;
    const u = mat.uniforms as Record<string, unknown>, view = this.viewer.camera.viewMatrix;
    const b = d.base(scratchI), k = Math.sin(ROVER.lightDown * DEG), c = Math.cos(ROVER.lightDown * DEG);
    const lu = ROVER.lightUp * ROVER.scale, lf = ROVER.lightFwd * ROVER.scale;
    const p = Cartesian3.fromElements(
      b.x + d.bodyUp.x * lu + d.fwd.x * lf, b.y + d.bodyUp.y * lu + d.fwd.y * lf,
      b.z + d.bodyUp.z * lu + d.fwd.z * lf, scratchJ);
    const dir = Cartesian3.fromElements(d.fwd.x * c - d.bodyUp.x * k, d.fwd.y * c - d.bodyUp.y * k, d.fwd.z * c - d.bodyUp.z * k, scratchF);
    Matrix4.multiplyByPoint(view, p, u.lvLampPos as Cartesian3);
    Cartesian3.normalize(Matrix4.multiplyByPointAsVector(view, dir, u.lvLampDir as Cartesian3), u.lvLampDir as Cartesian3);
    if (this.rocksShown) for (const r of this.rocks) if (r.spot) { r.shader.setUniform('u_lampPos', u.lvLampPos as Cartesian3); r.shader.setUniform('u_lampDir', u.lvLampDir as Cartesian3); }
  }

  /**
   * Fetch the rover (NASA's Perseverance model, about 5 MB) and draw it once, invisibly small at the Moon's centre,
   * so its textures are on the GPU and its shader is built before the first "Stand here".
   */
  private loadRover() {
    if (this.roverStarted || !this.material) return;
    this.roverStarted = true;
    const scene = this.viewer.scene;
    const shader = this.roverShader = new CustomShader({
      lightingModel: LightingModel.UNLIT,
      uniforms: {
        u_sun: { type: UniformType.VEC3, value: new Cartesian3(1, 0, 0) },
        u_up: { type: UniformType.VEC3, value: new Cartesian3(1, 0, 0) },
        u_earth: { type: UniformType.VEC3, value: new Cartesian3(1, 0, 0) },
        u_sunColor: { type: UniformType.VEC3, value: new Cartesian3(...SUN_TINT) },
        u_ambient: { type: UniformType.VEC3, value: new Cartesian3(0.03, 0.03, 0.035) },
        u_earthLight: { type: UniformType.VEC3, value: new Cartesian3(0, 0, 0) },
        u_bounce: { type: UniformType.VEC3, value: new Cartesian3(0, 0, 0) },
        u_exposure: { type: UniformType.FLOAT, value: 1 },
        u_vis: { type: UniformType.FLOAT, value: 1 },
        u_gain: { type: UniformType.FLOAT, value: ROVER.gain },
        u_spec: { type: UniformType.FLOAT, value: ROVER.spec },
      },
      fragmentShaderText: ROVER_SHADER,
    });
    void Model.fromGltfAsync({
      url: new URL(ROVER_URL, document.baseURI).href, modelMatrix: Matrix4.fromUniformScale(1e-6), customShader: shader,
      show: true, cull: false, backFaceCulling: false, shadows: ShadowMode.DISABLED, allowPicking: false,
      incrementallyLoadTextures: false, asynchronous: true, upAxis: Cesium.Axis.Z, forwardAxis: Cesium.Axis.X,
      environmentMapOptions: { enabled: false },
    } as Parameters<typeof Model.fromGltfAsync>[0]).then(model => {
      if (this.viewer.isDestroyed()) { model.destroy(); return; }
      scene.primitives.add(model);
      this.rover = model;
      let frames = 0;
      const off = scene.postRender.addEventListener(() => {
        if (!model.ready || ++frames < 3) { scene.requestRender(); return; }
        off();
        this.poseRover(model);
        this.roverReady = true;
        this.grabHead(model);
        this.rig = new RobotRig(model);
        model.show = false;
        if (this.roverParked) { this.placeRoverModel(); this.updateRoverLight(); }
        this.kick();
      });
      this.offs.push(off);
      scene.requestRender();
    }, err => { console.warn('lander: rover not loaded', err); });
  }

  /**
   * The camera head on the mast: keep its pan and tilt joints in their working pose (from NASA's animation), then
   * let go of those two animations so we can turn the head ourselves (see stepHead).
   */
  private grabHead(model: Model) {
    try {
      const pan = model.getNode(ROVER.panNode), tilt = model.getNode(ROVER.tiltNode);
      if (!pan || !tilt) return;
      const anims = model.activeAnimations as unknown as { length: number; get(i: number): { name?: string }; remove(a: unknown): boolean };
      const drop: unknown[] = [];
      for (let i = 0; i < anims.length; i++) { const a = anims.get(i); if (a.name === `${ROVER.panNode}Action` || a.name === `${ROVER.tiltNode}Action`) drop.push(a); }
      for (const a of drop) anims.remove(a);
      this.head = { pan, tilt, pan0: Matrix4.clone(pan.matrix), tilt0: Matrix4.clone(tilt.matrix), m: new Matrix4() };
    } catch (err) { console.warn('lander: rover head not found', err); this.head = null; }
  }

  /**
   * The head looks where you look: behind the rover it follows the camera's direction with a little lag, on the
   * mast it is the camera; parked (seen from the lander) it glances around now and then, sometimes at you.
   * True while it is still turning.
   */
  private stepHead(dt: number, now: number): boolean {
    const h = this.head, d = this.driver;
    if (!h || !d) return false;
    if (this.view !== 'spot') {
      this.headWantPan = clamp(((this.az - d.heading + 540) % 360) - 180, -ROVER.panMax, ROVER.panMax);
      this.headWantTilt = clamp(this.el - (this.view === 'third' ? ROVER.chaseEl : 0), ROVER.tiltMin, ROVER.tiltMax);
    } else if (now >= this.glanceAt) {
      const rnd = Math.random();
      if (rnd < 0.3) {
        // a look at you, at the lander
        Cartesian3.subtract(this.spotEye, d.feet, scratchK);
        const az = Math.atan2(Cartesian3.dot(scratchK, d.east), Cartesian3.dot(scratchK, d.north)) / DEG;
        this.headWantPan = clamp(((az - d.heading + 540) % 360) - 180, -ROVER.panMax, ROVER.panMax);
        this.headWantTilt = 8;
      } else {
        this.headWantPan = rnd < 0.45 ? 0 : (Math.random() * 2 - 1) * 110;
        this.headWantTilt = -20 + Math.random() * 30;
      }
      const wait = ROVER.glanceMs[0] + Math.random() * (ROVER.glanceMs[1] - ROVER.glanceMs[0]);
      this.glanceAt = now + wait;
      window.clearTimeout(this.glanceTimer);
      this.glanceTimer = window.setTimeout(() => { if (this.placed && this.active) this.kick(); }, wait + 20);
    }
    // turn: quick but not instant, the way a motor would (a little faster on the mast, where it is the camera)
    const k = 1 - Math.exp(-dt / (this.view === 'first' ? 0.08 : ROVER.headS));
    const dp = this.headWantPan - this.headPan, dtl = this.headWantTilt - this.headTilt;
    this.headPan += dp * k; this.headTilt += dtl * k;
    const moving = Math.abs(dp) > 0.15 || Math.abs(dtl) > 0.15;
    // on the mast you look out of the head: hide it (and what hangs on it), or you would see its inside
    const showHead = this.view !== 'first' || !!this.glide;
    if (h.pan.show !== showHead) h.pan.show = showHead;
    const ax = ROVER.panAxis, tx = ROVER.tiltAxis;
    const q = Cesium.Quaternion.fromAxisAngle(Cartesian3.fromElements(ax[0], ax[1], ax[2], scratchK), this.headPan * DEG, new Cesium.Quaternion());
    h.pan.matrix = Matrix4.multiply(h.pan0, Matrix4.fromRotationTranslation(Cesium.Matrix3.fromQuaternion(q), Cartesian3.ZERO, h.m), h.m);
    const q2 = Cesium.Quaternion.fromAxisAngle(Cartesian3.fromElements(tx[0], tx[1], tx[2], scratchK), ROVER.tiltSign * -this.headTilt * DEG, new Cesium.Quaternion());
    h.tilt.matrix = Matrix4.multiply(h.tilt0, Matrix4.fromRotationTranslation(Cesium.Matrix3.fromQuaternion(q2), Cartesian3.ZERO, new Matrix4()), new Matrix4());
    return moving;
  }

  /** The body rocks a little on its springs when the rover speeds up or brakes, and settles. True while rocking. */
  private stepBody(dt: number, speed: number): boolean {
    const acc = (speed - this.lastSpeed) / Math.max(dt, 1e-3);
    this.lastSpeed = speed;
    const w = 2 * Math.PI / ROVER.rockS;
    // speeding up pushes the nose up, braking dips it
    const force = clamp(acc, -6, 6) * ROVER.rockGain * w * w;
    this.rockV += (force - w * w * this.rock - 2 * ROVER.rockDamp * w * this.rockV) * dt;
    this.rock += this.rockV * dt;
    if (Math.abs(this.rock) < 1e-4 && Math.abs(this.rockV) < 1e-3) { this.rock = 0; this.rockV = 0; return false; }
    return true;
  }

  /**
   * Every frame while the robot is out: the solar panel follows the Sun, the wheels throw dust (lit by the Sun and
   * the headlights), and the sounds of landing and sliding. True while anything still moves.
   */
  private stepRobotFx(dt: number, d: Driver): boolean {
    const mat = this.material, scene = this.viewer.scene;
    if (!mat || !this.rover || !this.roverReady) return false;
    const u = mat.uniforms as Record<string, unknown>;
    const L = this.dustLight;
    Cartesian3.clone(u.lvSunDir as Cartesian3, L.sun);
    const sh = this.shadows && this.materialOn ? this.shadows : null;
    L.vis = this.sunElDeg <= -0.3 ? 0 : clamp(sh ? sh.visAt(Cartesian3.dot(d.feet, this.east), Cartesian3.dot(d.feet, this.north), this.sunAzDeg) : this.sunElDeg > 0 ? 1 : 0, 0, 1);
    let again = this.rig ? this.rig.stepPanel(dt, d, L.sun, L.vis > 0.05) : false;
    Cartesian3.clone(this.viewer.camera.positionWC, L.eye);
    L.exposure = this.exposure;
    L.lamp = ((u.lvLamp as Cartesian4).x / LAMP[0]) || 0;
    if (L.lamp > 0) {
      const b = d.base(scratchI), k = Math.sin(ROVER.lightDown * DEG), c = Math.cos(ROVER.lightDown * DEG);
      const lu = ROVER.lightUp * ROVER.scale, lf = ROVER.lightFwd * ROVER.scale;
      Cartesian3.fromElements(b.x + d.bodyUp.x * lu + d.fwd.x * lf, b.y + d.bodyUp.y * lu + d.fwd.y * lf, b.z + d.bodyUp.z * lu + d.fwd.z * lf, L.lampPos);
      Cartesian3.fromElements(d.fwd.x * c - d.bodyUp.x * k, d.fwd.y * c - d.bodyUp.y * k, d.fwd.z * c - d.bodyUp.z * k, L.lampDir);
    }
    // the shadow follows every move of the body, wheels and panel
    const sig = `${d.feet.x.toFixed(3)},${d.feet.y.toFixed(3)},${d.feet.z.toFixed(3)},${d.heading.toFixed(1)},${(d.pitch * 500).toFixed(0)},${(d.roll * 500).toFixed(0)},${d.wheelLift.reduce((a, v) => a + Math.abs(v), 0).toFixed(3)},${this.rig?.panelYaw.toFixed(0)},${this.rig?.panelTilt.toFixed(0)},${this.sunAzDeg.toFixed(2)},${this.sunElDeg.toFixed(2)}`;
    if (sig !== this.robotSig) { this.robotSig = sig; this.drawRobotShadow(); }
    this.dust ??= new Dust(scene, settings.get().quality === 'light');
    if (this.dust.step(dt, this.phase === 'on' ? d : null, L)) again = true;
    if (this.phase === 'on') (this.tracks ??= new WheelTracks(scene, settings.get().quality === 'light')).step(d, this.walkEnv, L.sun);
    this.placeLampGlow(L.lamp);
    // sounds the "sound" builder may add (called only if they exist)
    const A = roverAudio as unknown as Record<string, ((...a: number[]) => void) | undefined>;
    if (d.landed) A.land?.(d.landed);
    if (d.impact > 0.15) A.bump?.(d.impact);
    A.slip?.(d.slip);
    return again;
  }

  /**
   * The two lamps on the camera head glow when the headlights are on: at the head (read from the model's own
   * camera-head node), facing where the head looks, a little apart.
   */
  private placeLampGlow(k: number) {
    const m = this.rover, d = this.driver, dust = this.dust;
    if (!m || !d || !dust) return;
    if (k <= 0.01) { dust.glow(scratchI, scratchI, 0); return; }
    const node = (() => { try { return m.getNode('Mastcam_Z_cams') as unknown as { _runtimeNode?: { computedTransform: Matrix4 } } | undefined; } catch { return undefined; } })();
    const sg = (m as unknown as { _sceneGraph?: { _components?: { transform: Matrix4 }; _axisCorrectionMatrix?: Matrix4 } })._sceneGraph;
    const T = node?._runtimeNode?.computedTransform;
    if (!T || !sg?._components || !sg._axisCorrectionMatrix) return;
    const W = Matrix4.multiplyTransformation(Matrix4.multiplyTransformation(this.roverM, sg._components.transform, new Matrix4()), sg._axisCorrectionMatrix, new Matrix4());
    Matrix4.multiplyTransformation(W, T, W);
    const P = Matrix4.getTranslation(W, scratchI);
    // the head's facing: the body's forward turned by the head's pan (right = positive)
    const a = this.headPan * DEG, S = ROVER.scale;
    const Fh = Cartesian3.add(Cartesian3.multiplyByScalar(d.fwd, Math.cos(a), scratchK), Cartesian3.multiplyByScalar(d.right, Math.sin(a), scratchL), scratchK);
    const Rh = Cartesian3.cross(Fh, d.bodyUp, scratchL);
    const f = ROVER.lampAt[0] * S, sd = ROVER.lampAt[1] * S, up = ROVER.lampAt[2] * S;
    const A = new Cartesian3(P.x + Fh.x * f - Rh.x * sd + d.bodyUp.x * up, P.y + Fh.y * f - Rh.y * sd + d.bodyUp.y * up, P.z + Fh.z * f - Rh.z * sd + d.bodyUp.z * up);
    const B = new Cartesian3(P.x + Fh.x * f + Rh.x * sd + d.bodyUp.x * up, P.y + Fh.y * f + Rh.y * sd + d.bodyUp.y * up, P.z + Fh.z * f + Rh.z * sd + d.bodyUp.z * up);
    dust.glow(A, B, k);
  }

  /** The Sun shadow map (sunShadow.ts): made on the first frame standing, after the ground material. */
  private sunShadow: SunShadows | null = null;
  private sunCasterN = -1;
  /** the rocks further out (farRocks.ts) */
  private farRocks: FarRocks | null = null;

  /** Before each frame: aim the Sun shadow map, hand it its casters, place the contact shadow. */
  private stepSunShadow() {
    const mat = this.material;
    if (!mat) return;
    const standing = this.placed && this.materialOn && (this.phase === 'on' || this.phase === 'in');
    if (!standing) { if (this.sunShadow?.active) this.sunShadow.off(); placeContact(mat, null, this.east, this.north, false); return; }
    const S = this.sunShadow ??= new SunShadows(this.viewer, mat);
    const casters: Model[] = [];
    if (this.rover && this.roverReady) casters.push(this.rover);
    for (const r of this.rocks) if (r.model.ready) casters.push(r.model);
    if (casters.length !== this.sunCasterN) { this.sunCasterN = casters.length; S.setCasters(casters); }
    const u = mat.uniforms as Record<string, unknown>;
    const d = this.driver, robot = !!(d && this.rover?.show && this.roverParked);
    const cam = this.viewer.camera;
    const look = Cartesian3.subtract(cam.directionWC, Cartesian3.multiplyByScalar(this.up, Cartesian3.dot(cam.directionWC, this.up), scratchSunA), scratchSunA);
    if (Cartesian3.magnitude(look) < 1e-3) Cartesian3.clone(this.north, look); else Cartesian3.normalize(look, look);
    // centred on the ground ahead of the camera: under the robot when it is out, else under the eye
    const centre = robot && d ? Cartesian3.clone(d.feet, scratchSunB) : Cartesian3.subtract(cam.positionWC, Cartesian3.multiplyByScalar(this.up, 1.6, scratchSunB), scratchSunB);
    const sh = this.shadows;
    const sunVis = sh ? sh.visAt(Cartesian3.dot(centre, this.east), Cartesian3.dot(centre, this.north), this.sunAzDeg) : this.sunElDeg > 0 ? 1 : 0;
    S.update({ on: !(import.meta.env.DEV && (window as unknown as { __noSunShadow?: boolean }).__noSunShadow), sun: u.lvSunDir as Cartesian3, up: this.up, origin: this.rockOrigin, centre, look, sunEl: this.sunElDeg, sunVis, light: settings.get().quality === 'light' });
    placeContact(mat, d, this.east, this.north, robot);
    this.farRocks?.frame(cam.positionWC);
  }

  /** The robot's shadow is drawn by the Sun shadow map (sunShadow.ts); nothing to draw by hand any more. */
  private drawRobotShadow() { /* (kept so the callers stay as they are) */ }

  /**
   * The mast camera's ride: a soft spring kicked by bumps under the wheels (how fast the body's tilt changes) plus
   * a faint sway that grows with speed. Small on purpose: a hint of motion, never a wobble. True while it moves.
   */
  private stepSway(dt: number): boolean {
    const d = this.driver;
    if (!d || dt <= 0) return false;
    const du = Cartesian3.subtract(d.bodyUp, this.swayUp, scratchK);
    const fresh = Cartesian3.magnitude(this.swayUp) < 0.5;
    Cartesian3.clone(d.bodyUp, this.swayUp);
    const kickP = fresh ? 0 : -Cartesian3.dot(du, d.fwd) * ROVER.swayKick, kickR = fresh ? 0 : Cartesian3.dot(du, d.right) * ROVER.swayKick;
    const w = 2 * Math.PI / 0.4, z = 0.35;
    this.swayPV += kickP * w; this.swayRV += kickR * w;
    this.swayPV += (-w * w * this.swayP - 2 * z * w * this.swayPV) * dt; this.swayP = clamp(this.swayP + this.swayPV * dt, -0.02, 0.02);
    this.swayRV += (-w * w * this.swayR - 2 * z * w * this.swayRV) * dt; this.swayR = clamp(this.swayR + this.swayRV * dt, -0.02, 0.02);
    const sp = Math.abs(d.speed);
    this.swayAmp = ROVER.swaySpeed * Math.min(1, sp / 2);
    this.swayT += dt * (2 + sp * 2.2);
    if (sp < 0.02 && Math.abs(this.swayPV) + Math.abs(this.swayRV) < 1e-3 && Math.abs(this.swayP) + Math.abs(this.swayR) < 1e-4) { this.swayP = this.swayR = this.swayPV = this.swayRV = 0; return false; }
    return true;
  }

  /** The model comes with NASA's own animations (mast, arm, covers): hold each one still in its working pose. */
  private poseRover(model: Model) {
    const anims = model.activeAnimations as unknown as { add(o: object): unknown; length: number };
    const gltf = (model as unknown as { _loader?: { components?: { animations?: { name?: string }[] } } })._loader?.components?.animations;
    const n = gltf?.length ?? 0;
    for (let i = 0; i < n; i++) {
      // the arm stays folded on the front (its rest pose); the mast stands up, the camera covers open
      if (/^(arm|turret|hinge|Empty\.002)/.test(gltf?.[i]?.name ?? '')) continue;
      try { anims.add({ index: i, loop: Cesium.ModelAnimationLoop.NONE, animationTime: () => ROVER.poseT }); } catch { /* no such animation */ } // (animationTime: a share of the animation, not seconds)
    }
  }

  /** The rover gets the same light as the rocks (the hill shadow where it stands), plus light thrown up from sunlit ground. */
  private updateRoverLight() {
    const S = this.roverShader, mat = this.material, d = this.driver;
    if (!S || !mat || !d || !this.sky) return;
    const u = mat.uniforms as Record<string, unknown>;
    const sh = this.shadows && this.materialOn ? this.shadows : null;
    const vis = sh ? sh.visAt(Cartesian3.dot(d.feet, this.east), Cartesian3.dot(d.feet, this.north), this.sunAzDeg) : this.sky.sunPart ?? (this.sunElDeg > 0 ? 1 : 0);
    S.setUniform('u_sun', u.lvSunDir as Cartesian3);
    S.setUniform('u_up', d.up);
    S.setUniform('u_earth', u.lvEarthDir as Cartesian3);
    S.setUniform('u_ambient', u.lvAmbient as Cartesian3);
    S.setUniform('u_earthLight', u.lvEarthLight as Cartesian3);
    S.setUniform('u_exposure', this.exposure);
    S.setUniform('u_vis', clamp(vis, 0, 1));
    S.setUniform('u_gain', ROVER.gain);
    S.setUniform('u_spec', ROVER.spec);
    // grey dust in sunshine sends back about a tenth of the light, scaled by how high the Sun is
    const b = 0.1 * clamp(vis, 0, 1) * Math.max(0, Math.sin(this.sunElDeg * DEG));
    S.setUniform('u_bounce', Cartesian3.fromElements(b, b * 0.98, b * 0.95, scratchG));
  }

  private loadRocks() {
    if (this.rocksStarted || !this.material) return;
    this.rocksStarted = true;
    const t0 = performance.now(), scene = this.viewer.scene;
    const hidden = Matrix4.fromUniformScale(1e-4);
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < ROCK_POOL; i++) {
      const kind = i % ROCK_MODELS.length;
      const shader = new CustomShader({
        lightingModel: LightingModel.UNLIT,
        uniforms: {
          u_sun: { type: UniformType.VEC3, value: new Cartesian3(1, 0, 0) },
          u_up: { type: UniformType.VEC3, value: new Cartesian3(1, 0, 0) },
          u_earth: { type: UniformType.VEC3, value: new Cartesian3(1, 0, 0) },
          u_sunColor: { type: UniformType.VEC3, value: new Cartesian3(...SUN_TINT) },
          u_ambient: { type: UniformType.VEC3, value: new Cartesian3(0.03, 0.03, 0.035) },
          u_earthLight: { type: UniformType.VEC3, value: new Cartesian3(0, 0, 0) },
          u_look: { type: UniformType.VEC4, value: new Cartesian4(...LOOK) },
          u_exposure: { type: UniformType.FLOAT, value: 1 },
          u_vis: { type: UniformType.FLOAT, value: 1 },
          u_albedo: { type: UniformType.FLOAT, value: ROCK_ALBEDO },
          u_lamp: { type: UniformType.FLOAT, value: 0 },
          u_lampPos: { type: UniformType.VEC3, value: new Cartesian3(0, 0, 0) },
          u_lampDir: { type: UniformType.VEC3, value: new Cartesian3(0, 0, -1) },
        },
        fragmentShaderText: ROCK_SHADER,
      });
      jobs.push(Model.fromGltfAsync({
        url: new URL(ROCK_MODELS[kind].url, document.baseURI).href, modelMatrix: hidden, customShader: shader,
        show: false, cull: false, shadows: ShadowMode.DISABLED, allowPicking: false, incrementallyLoadTextures: false, asynchronous: true,
        // unlit (we light them ourselves): no sky reflections, which Cesium would otherwise re-measure with a GPU
        // read-back every time a rock moves (that stalled walking)
        environmentMapOptions: { enabled: false },
      } as Parameters<typeof Model.fromGltfAsync>[0]).then(model => {
        if (this.viewer.isDestroyed()) { model.destroy(); return; }
        scene.primitives.add(model);
        this.rocks.push({ model, shader, kind, e: 0, n: 0, vis: 1, spot: null, scale: 1, h: 0, probe: null, probeM: 0.3, ground: NaN, slopeE: 0, slopeN: 0, tile: null, mesh: null, base: new Cartesian3(), size: 1, resize: false });
      }));
    }
    void Promise.all(jobs).then(() => {
      if (this.viewer.isDestroyed()) return;
      // draw them all once (hidden inside the Moon) so every shader is compiled while nobody is looking
      if (!this.placed) for (const r of this.rocks) r.model.show = true;
      let frames = 0;
      const off = scene.postRender.addEventListener(() => {
        const ready = this.rocks.every(r => r.model.ready);
        if (!ready || ++frames < 4) { scene.requestRender(); return; }
        off();
        if (!this.placed) for (const r of this.rocks) r.model.show = false;
        else if (this.phase === 'on' || this.phase === 'in') this.placeRocks();
        this.rockMs = Math.round(performance.now() - t0);
        this.stats.rocksMs = this.rockMs;
      });
      this.offs.push(off);
      scene.requestRender();
    }, err => { console.warn('lander: rocks not loaded', err); });
  }

  /**
   * Choose the rocks to draw around you (which model, where, how big, how turned) from the fixed rock
   * cells (see rockCell): the ROCK_POOL that look biggest from where you stand. Rocks still in the set keep
   * their model, so walking never makes them jump. New ones show once seatRocks() finds the ground under them.
   */
  /** A rock's drawn size: its true size times k (0..1, see rockSpots); a tiny one is not drawn at all. */
  private sizeRock(rock: LanderView['rocks'][number], k: number) {
    const sp = rock.spot;
    if (!sp) return;
    const m = ROCK_MODELS[rock.kind];
    rock.size = k;
    rock.scale = Math.max(1e-3, k) * sp.d / m.w;
    rock.h = m.h * rock.scale;
  }

  private placeRocks() {
    const spec = this.spec, mat = this.material;
    if (!spec || !mat || !this.materialOn || !this.rocks.length || !this.rocks.every(r => r.model.ready)) return;
    const E = this.rockE, N = this.rockN;
    const we = this.walkerActive ? Cartesian3.dot(this.eye, E) : 0;
    const wn = this.walkerActive ? Cartesian3.dot(this.eye, N) : 0;
    this.rockAt = [we, wn];
    const spots = rockSpots(spec.lat, spec.lon, we, wn, this.parkAt);
    const want = new Map(spots.map(o => [o.s.id, o.s])), sizes = new Map(spots.map(o => [o.s.id, o.size]));
    // keep what stays (at its new size), free the rest
    const free: number[] = [];
    this.rocks.forEach((r, i) => {
      if (r.spot && want.has(r.spot.id)) {
        want.delete(r.spot.id);
        const k = sizes.get(r.spot.id) ?? 1;
        if (Math.abs(k - r.size) > 0.01) { this.sizeRock(r, k); r.resize = true; }
      } else { if (r.spot) { r.spot = null; r.probe = null; r.model.show = false; } free.push(i); }
    });
    const at = (e: number, n: number, out: Cartographic) => {
      const W = Cartesian3.add(this.rockOrigin, Cartesian3.add(Cartesian3.multiplyByScalar(E, e, scratchA), Cartesian3.multiplyByScalar(N, n, scratchB), scratchB), scratchC);
      return Cartographic.fromCartesian(W, MOON_ELLIPSOID, out) ?? out;
    };
    for (const sp of want.values()) {
      if (!free.length) break;
      const fi = Math.max(0, free.findIndex(i => this.rocks[i].kind === sp.kind));
      const idx = free.splice(fi, 1)[0];
      const rock = this.rocks[idx];
      rock.spot = sp;
      this.sizeRock(rock, sizes.get(sp.id) ?? 1);
      rock.ground = NaN; rock.tile = null; rock.mesh = null;
      // where to read the drawn ground: under the rock, and on four sides of it (for the slope it rests on)
      const a = Math.max(0.3, 0.5 * sp.d);
      rock.probe = [at(sp.e, sp.n, new Cartographic()), at(sp.e + a, sp.n, new Cartographic()), at(sp.e - a, sp.n, new Cartographic()),
        at(sp.e, sp.n + a, new Cartographic()), at(sp.e, sp.n - a, new Cartographic())];
      rock.probeM = a;
    }
    this.rocksShown = this.rocks.filter(r => r.spot).length;
    // the rocks further out: one batch of stones, remade round you now and then
    this.farRocks ??= new FarRocks(this.viewer, {
      spots: (e, n, r0, r1) => { const sp = this.spec; return sp ? farSpots(sp.lat, sp.lon, e, n, r0, r1) : []; },
      origin: this.rockOrigin, east: this.rockE, north: this.rockN, up: this.up,
      height: c => this.drawnHeight(c),
      vis: (e, n) => this.shadows ? clamp(this.shadows.visAt(e, n, this.sunAzDeg), 0, 1) : 1,
      toCartographic: (p, out) => Cartographic.fromCartesian(p, MOON_ELLIPSOID, out) ?? out,
      fromHeight: (c, h, out) => Cartesian3.fromRadians(c.longitude, c.latitude, h, MOON_ELLIPSOID, out),
      changed: () => this.rasterRocks(),
    });
    this.farRocks.show(true);
    this.farRocks.update(we, wn);
    this.rockSeatT = 0;
    this.seatRocks();
    this.rasterRocks();
    this.updateRockLight();
    this.viewer.scene.requestRender();
  }

  /**
   * Height of the ground exactly as it is drawn right now (m above the Moon sphere), or undefined. Cesium's
   * own globe.getHeight reads the most detailed tile that has been loaded, which is not always the one on
   * screen (finer tiles keep loading after you arrive, a far tile is drawn coarser): a rock seated on that
   * would float above, or sink into, the ground you see. So we read the tile being drawn, the same way.
   */
  private drawnHeight(c: Cartographic, found?: { tile: DrawnTile | null }): number | undefined {
    const globe = this.viewer.scene.globe;
    const surface = (globe as unknown as { _surface?: { _tilesToRender?: DrawnTile[]; _tileProvider?: { tilingScheme: { projection: unknown } } } })._surface;
    const tiles = surface?._tilesToRender;
    if (found) found.tile = null;
    if (tiles) {
      for (const t of tiles) {
        if (!t.data?.renderedMesh || !t.data.pick || !Cesium.Rectangle.contains(t.rectangle, c)) continue;
        if (found) found.tile = t;
        const ell = globe.ellipsoid, ray = scratchRay;
        const p = Cartesian3.fromRadians(c.longitude, c.latitude, 0, ell, scratchE);
        ell.geodeticSurfaceNormal(p, ray.direction);
        Cartesian3.subtract(p, Cartesian3.multiplyByScalar(ray.direction, 20000, ray.origin), ray.origin); // from 20 km below, upwards
        const hit = t.data.pick(ray, Cesium.SceneMode.SCENE3D, surface?._tileProvider?.tilingScheme.projection, false, scratchF);
        if (hit) return ell.cartesianToCartographic(hit, scratchCarto2)?.height;
      }
    }
    return globe.getHeight(c);
  }

  /**
   * Seat every rock on the ground as it is drawn now: base buried by a fifth of its height (as real rocks
   * sit in the dust), turned to the slope under it. Called after placing and then a few times a second
   * while standing, because the ground keeps getting finer as tiles arrive (we measured a far-side spot
   * whose first tiles were 54 m below the final ground) and a turn of the head brings other tiles on screen.
   * A rock is only looked at again when the tile under it is no longer the one drawn (well under 1 ms).
   */
  private seatRocks() {
    const E = this.east, N = this.north, U = this.up;
    let changed = false, firstSeat = false;
    const drawn = new Set((this.viewer.scene.globe as unknown as { _surface?: { _tilesToRender?: DrawnTile[] } })._surface?._tilesToRender ?? []);
    const found = { tile: null as DrawnTile | null };
    for (const rock of this.rocks) {
      const sp = rock.spot, pr = rock.probe;
      if (!sp || !pr) continue;
      // nothing to do while the tile under the rock is still drawn with the same mesh as when we seated it
      if (!rock.resize && rock.tile && drawn.has(rock.tile) && rock.tile.data?.renderedMesh === rock.mesh) continue;
      const g0 = this.drawnHeight(pr[0], found);
      if (g0 === undefined) { if (Number.isNaN(rock.ground)) rock.model.show = false; continue; }
      // out of view (its tile is not drawn): keep it where it is until it comes back on screen
      if (!found.tile && !Number.isNaN(rock.ground)) continue;
      rock.tile = found.tile; rock.mesh = found.tile?.data?.renderedMesh;
      const hs = [1, 2, 3, 4].map(i => this.drawnHeight(pr[i]));
      const a = rock.probeM;
      const dE = hs[0] !== undefined && hs[1] !== undefined ? (hs[0] - hs[1]) / (2 * a) : 0;
      const dN = hs[2] !== undefined && hs[3] !== undefined ? (hs[2] - hs[3]) / (2 * a) : 0;
      if (!rock.resize && Math.abs(g0 - rock.ground) < 0.003 && Math.abs(dE - rock.slopeE) < 0.002 && Math.abs(dN - rock.slopeN) < 0.002 && (rock.model.show || rock.size <= 0.02)) continue;
      rock.resize = false;
      if (Number.isNaN(rock.ground)) firstSeat = true;
      rock.ground = g0; rock.slopeE = dE; rock.slopeN = dN;
      // the rock's own up: the ground's up there, plus its random lean
      const n = Cartesian3.normalize(Cartesian3.fromElements(
        U.x - dE * E.x - dN * N.x, U.y - dE * E.y - dN * N.y, U.z - dE * E.z - dN * N.z, scratchG), scratchG);
      const xg = Cartesian3.normalize(Cartesian3.subtract(E, Cartesian3.multiplyByScalar(n, Cartesian3.dot(E, n), scratchA), scratchA), scratchA);
      const yg = Cartesian3.cross(n, xg, scratchB);
      const cy = Math.cos(sp.yaw), sy = Math.sin(sp.yaw), tx = Math.sin(sp.tilt) * Math.cos(sp.tiltAz), ty = Math.sin(sp.tilt) * Math.sin(sp.tiltAz);
      const toW = (v0: number, v1: number, v2: number, out: Cartesian3) => Cartesian3.fromElements(
        xg.x * v0 + yg.x * v1 + n.x * v2, xg.y * v0 + yg.y * v1 + n.y * v2, xg.z * v0 + yg.z * v1 + n.z * v2, out);
      const X = toW(cy, sy, 0, scratchC), Y = toW(-sy, cy, 0, scratchD), Z = Cartesian3.normalize(toW(tx, ty, 1, scratchE), scratchE);
      const base = Cartesian3.fromRadians(pr[0].longitude, pr[0].latitude, g0 - ROCK_BURY * rock.h, MOON_ELLIPSOID, rock.base);
      const mm = rock.model.modelMatrix as unknown as number[], s = rock.scale;
      // Cesium turns glTF's y-up into z-up before this matrix, so local x / y / z = across / along / up
      mm[0] = X.x * s; mm[1] = X.y * s; mm[2] = X.z * s; mm[3] = 0;
      mm[4] = Y.x * s; mm[5] = Y.y * s; mm[6] = Y.z * s; mm[7] = 0;
      mm[8] = Z.x * s; mm[9] = Z.y * s; mm[10] = Z.z * s; mm[11] = 0;
      mm[12] = base.x; mm[13] = base.y; mm[14] = base.z; mm[15] = 1;
      rock.model.show = rock.size > 0.02;
      changed = true;
    }
    if (firstSeat) this.rasterRocks();
    if (changed) this.viewer.scene.requestRender();
  }

  /**
   * Draw the rocks' shadows (for the Sun as it is now) and the darker ground hugging each rock into the
   * rock-shadow picture: r, g = shadow, darkening on the fine map; b, a = the same on the coarse map. Each
   * rock is a squashed ball; a cell is in shadow when the line from it to the Sun passes through the ball
   * (soft at the edge by the Sun's own width). About 1-3 ms; done again whenever the Sun moves.
   */
  private rasterRocks() {
    const mat = this.material;
    if (!mat || !this.materialOn) return;
    const u = mat.uniforms as Record<string, unknown>, map = this.rockMap, NN = ROCK_MAP_N;
    map.fill(255);
    // the picture is centred where you stand (map frame), so the fine part is always round your feet;
    // on or behind the rover it is centred on the rover, so its shadow is drawn sharp
    const dr = this.driver && this.roverParked ? this.driver : null;
    const centre = dr && this.view !== 'spot' ? dr.feet : this.eye;
    const cx = Cartesian3.dot(centre, this.east), cy = Cartesian3.dot(centre, this.north);
    this.rockMapAt = [Cartesian3.dot(this.eye, this.east), Cartesian3.dot(this.eye, this.north)];
    const list: { x: number; y: number; rx: number; rz: number; zc: number; cap?: number }[] = [];
    for (const rock of this.rocks) {
      if (!rock.spot || Number.isNaN(rock.ground)) continue; // (no shadow or dark rim under a rock that is not drawn yet)
      list.push({ x: Cartesian3.dot(rock.base, this.east) - cx, y: Cartesian3.dot(rock.base, this.north) - cy, rx: 0.5 * rock.spot.d * rock.size * 0.8, rz: 0.5 * rock.h, zc: 0.5 * rock.h });
    }
    // the far stones (farRocks.ts) too: their short shadow strokes, past the Sun shadow map's reach (same sizes as drawn there)
    const far = this.farRocks?.casters ?? [];
    if (far.length) {
      const o = this.rockOrigin, E = this.rockE, Nn = this.rockN;
      const ox = Cartesian3.dot(o, this.east) - cx, oy = Cartesian3.dot(o, this.north) - cy;
      const ee = Cartesian3.dot(E, this.east), en = Cartesian3.dot(E, this.north), ne = Cartesian3.dot(Nn, this.east), nn = Cartesian3.dot(Nn, this.north);
      const r0 = FAR_ROCKS.near + FAR_ROCKS.fadeM * 0.5;
      for (const f of far) {
        const x = ox + f.e * ee + f.n * ne, y = oy + f.e * en + f.n * nn;
        if (x * x + y * y < r0 * r0) continue; // (a near rock model there casts its own)
        const rz = 0.5 * f.d * 0.45;
        list.push({ x, y, rx: 0.45 * f.d, rz, zc: rz * (1 - 2 * FAR_ROCKS.bury), cap: 12 });
      }
    }
    const az = this.sunAzDeg * DEG, el = this.sunElDeg * DEG;
    const lx = Math.sin(az) * Math.cos(el), ly = Math.cos(az) * Math.cos(el), lz = Math.sin(el);
    const hx = Math.sin(az), hy = Math.cos(az), tanE = Math.tan(Math.max(el, 0.4 * DEG));
    const sunUp = this.sunElDeg > -0.6;
    for (let lev = 0; lev < 2; lev++) {
      const cell = ROCK_MAP_CELL[lev], half = (NN * cell) / 2, ch = lev * 2;
      for (const r of list) {
        if (Math.abs(r.x) > half + 60 || Math.abs(r.y) > half + 60) continue;
        if (lev === 0 && r.rx < cell * 1.5 && Math.hypot(r.x, r.y) > 6) continue;
        const len = sunUp ? Math.min((r.zc + r.rz) / tanE + r.rx, r.cap ?? 80) : 0; // shadow length on flat ground
        const pad = r.rx * 1.7 + 0.05 + len * 0.0093;
        const ex = r.x - hx * len, ey = r.y - hy * len;
        const i0 = Math.max(0, Math.floor((Math.min(r.x, ex) - pad + half) / cell)), i1 = Math.min(NN - 1, Math.ceil((Math.max(r.x, ex) + pad + half) / cell));
        const j0 = Math.max(0, Math.floor((Math.min(r.y, ey) - pad + half) / cell)), j1 = Math.min(NN - 1, Math.ceil((Math.max(r.y, ey) + pad + half) / cell));
        const ax = lx / r.rx, ay = ly / r.rx, az2 = lz / r.rz, dd = ax * ax + ay * ay + az2 * az2;
        const oz = -r.zc / r.rz; // the ground at the rock's foot, in units of its vertical radius
        const onGround = r.zc < r.rz * 1.2;
        for (let j = j0; j <= j1; j++) {
          const y = (j + 0.5) * cell - half, dy = y - r.y;
          for (let i = i0; i <= i1; i++) {
            const x = (i + 0.5) * cell - half, dx = x - r.x;
            const o = (j * NN + i) * 4 + ch;
            const hd = Math.hypot(dx, dy) / r.rx;
            // (contact darkening: only a thin rim shows round a rock that sits in the dust)
            if (hd < 1.35 && onGround) { const k2
 = clamp((hd - 0.85) / 0.5, 0, 1); const ao = 0.75 + 0.25 * k2 * k2 * (3 - 2 * k2); map[o + 1] = Math.min(map[o + 1], Math.round(ao * 255)); }
            if (!sunUp) continue;
            const ox = dx / r.rx, oy = dy / r.rx;
            const t = -(ox * ax + oy * ay + oz * az2) / dd;
            if (t <= 0) continue;
            const mx = ox + ax * t, my = oy + ay * t, mz = oz + az2 * t, miss = Math.sqrt(mx * mx + my * my + mz * mz);
            const pen = 0.04 + (t * 0.0093) / r.rx;
            const k1 = clamp((miss - (1 - pen)) / (2 * pen), 0, 1), lit = k1 * k1 * (3 - 2 * k1);
            map[o] = Math.min(map[o], Math.round(lit * 255));
          }
        }
      }
    }
    this.rockMapC = [cx, cy];
    const source = { width: NN, height: NN, arrayBufferView: map };
    if (!this.rockTex) { this.rockTex = this.gpuTexture(source); u.lvRockTex = this.rockTex; } else this.rockTex.copyFrom({ source });
    (u.lvRocks as Cartesian4).x = list.length ? 1 : 0;
    const w = u.lvWalk as Cartesian4;
    w.z = cx; w.w = cy;
    this.viewer.scene.requestRender();
  }

  /** Hide the rocks (going back to the map). */
  private hideRocks() {
    this.farRocks?.show(false);
    for (const r of this.rocks) { r.model.show = false; r.spot = null; r.probe = null; }
    this.rocksShown = 0;
    if (this.material) ((this.material.uniforms as Record<string, unknown>).lvRocks as Cartesian4).x = 0;
  }

  /** Give the rocks the same light as the ground: Sun, Earth, fill, exposure, and whether a hill shades them. */
  private updateRockLight() {
    if (!this.rocksShown || !this.material) return;
    const u = this.material.uniforms as Record<string, unknown>;
    const sh = this.shadows;
    for (const r of this.rocks) {
      if (!r.spot) continue;
      const vis = sh && !Number.isNaN(r.ground) ? sh.visAt(Cartesian3.dot(r.base, this.east), Cartesian3.dot(r.base, this.north), this.sunAzDeg) : 1;
      const S = r.shader;
      S.setUniform('u_sun', u.lvSunDir as Cartesian3);
      S.setUniform('u_up', this.up);
      S.setUniform('u_earth', u.lvEarthDir as Cartesian3);
      S.setUniform('u_ambient', u.lvAmbient as Cartesian3);
      S.setUniform('u_earthLight', u.lvEarthLight as Cartesian3);
      S.setUniform('u_look', u.lvLook as Cartesian4);
      S.setUniform('u_exposure', this.exposure);
      S.setUniform('u_vis', vis);
      S.setUniform('u_lamp', (u.lvLamp as Cartesian4).x);
    }
    // the far stones: the same light
    const F = this.farRocks;
    if (F) {
      const fu = F.uniforms;
      Cartesian3.clone(u.lvSunDir as Cartesian3, fu.u_sun as Cartesian3);
      Cartesian3.clone(this.up, fu.u_up as Cartesian3);
      Cartesian3.clone(u.lvEarthDir as Cartesian3, fu.u_earth as Cartesian3);
      Cartesian3.clone(u.lvAmbient as Cartesian3, fu.u_ambient as Cartesian3);
      Cartesian3.clone(u.lvEarthLight as Cartesian3, fu.u_earthLight as Cartesian3);
      Cartesian3.clone(u.lvSunColor as Cartesian3, fu.u_sunColor as Cartesian3);
      Object.assign(fu.u_look as object, { x: (u.lvLook as Cartesian4).x, y: (u.lvLook as Cartesian4).y, z: (u.lvLook as Cartesian4).z, w: (u.lvLook as Cartesian4).w });
      fu.u_exposure = this.exposure;
      F.relight(this.sunAzDeg, this.sunElDeg);
    }
  }

  /** Sun/Earth directions as seen from the eye, the lighting numbers for the ground shader, our own Sun/Earth pictures. */
  private applyLight() {
    const sky = this.sky, spec = this.spec;
    if (!sky || !spec || !this.placed) return;
    const s = trueToDisplayVec(sky.sun), e = trueToDisplayVec(sky.earth);
    const sunDir = Cartesian3.normalize(Cartesian3.fromElements(s[0], s[1], s[2], scratchA), this.tags.sun.dir);
    const earthPos = Cartesian3.fromElements(e[0], e[1], e[2], scratchB);
    const earthVec = Cartesian3.subtract(earthPos, this.eye, scratchC);
    const earthDist = Cartesian3.magnitude(earthVec);
    const earthDir = Cartesian3.normalize(earthVec, this.tags.earth.dir);
    this.tags.earth.radiusDeg = Math.asin(EARTH_R / earthDist) / DEG;
    const sunEl = Math.asin(clamp(Cartesian3.dot(sunDir, this.up), -1, 1)) / DEG;
    const sunAz = wrap360(Math.atan2(Cartesian3.dot(sunDir, this.east), Cartesian3.dot(sunDir, this.north)) / DEG);
    const earthEl = Math.asin(clamp(Cartesian3.dot(earthDir, this.up), -1, 1)) / DEG;
    this.sunAzDeg = sunAz; this.sunElDeg = sunEl;
    // how much of Earth's face is lit, seen from here (1 = "full Earth")
    const toSun = Cartesian3.normalize(Cartesian3.subtract(Cartesian3.fromElements(s[0], s[1], s[2], scratchD), earthPos, scratchD), scratchD);
    const earthLit = (1 - Cartesian3.dot(toSun, earthDir)) / 2;

    // shadows follow the Sun
    if (this.shadows && this.materialOn && (Math.abs(sunAz - this.sweptAz) > 0.04 || Math.abs(sunEl - this.sweptEl) > 0.01)) {
      this.shadowDirty = true;
      if (!this.raf) this.sweepShadows();
    }
    const maskHere = this.shadows && this.materialOn ? (this.walkerActive ? this.shadows.visAt(Cartesian3.dot(this.eye, this.east), Cartesian3.dot(this.eye, this.north), sunAz) : this.shadows.here()) : null;
    const sunHere = maskHere ?? sky.sunPart ?? (sunEl > 0 ? 1 : 0);
    this.stats.sunHere = maskHere ?? -1;

    if (this.materialOn && this.material) {
      const u = this.material.uniforms as Record<string, unknown>;
      Cartesian3.clone(sunDir, u.lvSunDir as Cartesian3);
      Cartesian3.clone(earthDir, u.lvEarthDir as Cartesian3);
      (u.lvSunAz as Cartesian2).x = Math.sin(sunAz * DEG); (u.lvSunAz as Cartesian2).y = Math.cos(sunAz * DEG);
      // Fill light. Sunlit hills around bounce a little warm light into the shadows; Earth adds a faint blue.
      const dayAround = clamp((sunEl + 2.5) / 4, 0, 1);
      const earthUp = sky.earthUp ?? earthEl > 0;
      const earthPower = EARTH_LIGHT * (0.12 + 0.88 * earthLit) * (earthUp ? 1 : earthEl > -3 ? 0.35 : 0.08);
      // (the ground around is lit at the same low angle, so it sends less light back when the Sun is low)
      const bounce = BOUNCE * dayAround * (0.3 + 0.7 * clamp(Math.sin(Math.max(sunEl, 0) * DEG) / 0.34, 0, 1));
      Cartesian3.fromElements(bounce + FLOOR * 0.62, bounce * 0.98 + FLOOR * 0.74, bounce * 0.95 + FLOOR, u.lvAmbient as Cartesian3);
      Cartesian3.fromElements(earthPower * 0.74, earthPower * 0.84, earthPower, u.lvEarthLight as Cartesian3);
      // starlight is nearly white (the Milky Way is a little warm, the bright stars a little blue)
      Cartesian3.fromElements(STAR_LIGHT * 0.92, STAR_LIGHT * 0.95, STAR_LIGHT, u.lvStar as Cartesian3);
      // how much of a night it is: the Sun below the horizon (not just behind a hill, where sunlit hills still light the view)
      this.night = clamp((-sunEl - 0.3) / 2, 0, 1);
      this.earthShare = earthPower / (earthPower + FLOOR + STAR_LIGHT * 0.6 + bounce);
      // Camera-like exposure, set once for the place and time (not for where you look, so turning around
      // never "pumps"): in sunshine a gentle slope facing the Sun comes out mid-grey, so flat ground in
      // grazing light is darker and slopes turned to the Sun glow; in shade or at night the camera opens up
      // until the ground is dim but readable, and anything still in sunlight far away burns out bright.
      const sunRef = moonDust(Math.sin((sunEl + 12) * DEG), 0.25, 90) * sunHere;
      const fillRef = bounce * 0.95 + FLOOR * 0.7 + STAR_LIGHT * 0.6 + earthPower * 0.6;
      const litExp = clamp(X_LIT / Math.max(sunRef, 1e-4), 0.4, 14);
      const shadeExp = clamp(X_SHADE * this.nightScale() / Math.max(fillRef, 1e-5), 1, 400);
      this.exposureTarget = Math.exp(Math.log(shadeExp) + (Math.log(Math.min(litExp, shadeExp)) - Math.log(shadeExp)) * clamp(sunHere, 0, 1));
      // like a photo taken in sunlight: the sky is black and only the brightest stars show
      this.skyTarget = clamp(1 - 0.78 * sunHere, 0.22, 1);
      // ...and once the height maps are ready, the light meter decides from what is really in view
      const amb = u.lvAmbient as Cartesian3, earthL = u.lvEarthLight as Cartesian3;
      this.fillAmb = 0.2126 * amb.x + 0.7152 * amb.y + 0.0722 * amb.z;
      this.fillStar = STAR_LIGHT * 0.95;
      this.fillEarth = 0.2126 * earthL.x + 0.7152 * earthL.y + 0.0722 * earthL.z;
      this.earthEnu = [Cartesian3.dot(earthDir, this.east), Cartesian3.dot(earthDir, this.north), Cartesian3.dot(earthDir, this.up)];
      if (this.meter()) this.meterAt = performance.now();
      if (this.exposure < 0) { this.exposure = this.exposureTarget; this.setSkyExposure(this.skyTarget); }
      u.lvExposure = this.exposure;
      this.updateRockLight();
      this.updateRoverLight();
    } else {
      // no shader (3D mountains switched off): simply dim the photo when the lander is in shadow
      const br = sky.sunPart === null ? 1 : 0.42 + 0.58 * sky.sunPart;
      for (let i = 0; i < this.viewer.imageryLayers.length; i++) this.viewer.imageryLayers.get(i).brightness = br;
    }

    // our own Sun and Earth pictures (the drawn hills hide them properly because they stand in the 3D scene)
    if (this.sunPic && this.earthPic) {
      const sp = this.sunPic, ep = this.earthPic;
      // the Sun: upright (its faint cross of light stays level with the horizon)
      const sunUp = Cartesian3.normalize(Cartesian3.subtract(this.up, Cartesian3.multiplyByScalar(sunDir, Cartesian3.dot(this.up, sunDir), scratchG), scratchG), scratchG);
      placePicture(sp, Cartesian3.add(this.eye, Cartesian3.multiplyByScalar(sunDir, BODY_DIST, scratchE), scratchE), sunDir, sunUp, BODY_DIST * Math.tan(SUN_SPRITE_HALF_DEG * DEG));
      // hidden behind a hill only a faint glow is left (the Sun's outer halo really is seen past the Moon's edge)
      ((sp.appearance.material.uniforms as { color: Color }).color).alpha = 0.16 + 0.84 * clamp(sky.sunPart ?? 1, 0, 1);
      sp.show = true;
      // Earth: its lit edge is drawn at the top of the picture, so the top points at the Sun
      const earthUp = Cartesian3.normalize(Cartesian3.subtract(toSun, Cartesian3.multiplyByScalar(earthDir, Cartesian3.dot(toSun, earthDir), scratchG), scratchG), scratchG);
      placePicture(ep, Cartesian3.add(this.eye, Cartesian3.multiplyByScalar(earthDir, BODY_DIST, scratchE), scratchE), earthDir, earthUp, BODY_DIST * (EARTH_R / earthDist) * (EARTH_SPRITE / 2 / EARTH_DISC_R));
      const key = (Math.round(earthLit * 40) / 40).toFixed(3);
      if (key !== this.earthKey) { this.earthKey = key; (ep.appearance.material.uniforms as { image: string }).image = earthSvg(+key); }
      ep.show = true;
    }
    this.tags.sun.az = sunAz;
    this.tags.earth.az = wrap360(Math.atan2(Cartesian3.dot(earthDir, this.east), Cartesian3.dot(earthDir, this.north)) / DEG);
    this.updateTagText(sunEl, earthEl);
  }

  /**
   * The camera's light meter. Moon dust looks many times brighter seen down-sun than towards a low Sun
   * (the Apollo crews used different camera settings for each), so one exposure for a place cannot work.
   * Like a camera we measure what is in view: 13 x 11 rays across the screen (dense enough to catch a thin sunlit ridge on the skyline) are followed over the height
   * maps (no GPU read-back, about 0.3 ms), each finds the ground it hits, how that ground is lit (slope,
   * shadow, moon-dust reflection, Earth and bounce light, the same sums as the shader) and the exposure
   * puts the typical brightness at mid-grey: brighter when most of the view is sunlit, dimmer in shade.
   * It also keeps the brightest sunlit tenth from burning out to white. Looking up at the sky the eye
   * adjusts to the dark and the stars come out. Returns false when the height maps are not ready yet.
   */
  private meter(): boolean {
    const sh = this.shadows;
    if (!sh || !this.materialOn || !sh.ready[2] || !this.sky) return false;
    const W = Math.max(1, this.canvas.clientWidth), H = Math.max(1, this.canvas.clientHeight);
    const tanX = Math.tan((this.fov * DEG) / 2), tanY = (tanX * H) / W;
    const az = this.az * DEG, el = this.el * DEG, ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
    const sAz = this.sunAzDeg * DEG, sEl = this.sunElDeg * DEG;
    const sx = Math.cos(sEl) * Math.sin(sAz), sy = Math.cos(sEl) * Math.cos(sAz), sz = Math.sin(sEl);
    const ex = this.earthEnu, logs = this.meterLogs, cell = { s: 80 };
    // where the eye is in the height maps' frame (the landing spot, unless you walked away)
    const oe = Cartesian3.dot(this.eye, this.east), on = Cartesian3.dot(this.eye, this.north), zEye = Cartesian3.dot(this.eye, this.up) - MOON_R;
    let hits = 0, lit = 0, sum = 0;
    for (let iy = 0; iy < METER_ROWS; iy++) {
      const v = ((iy / (METER_ROWS - 1)) * 2 - 1) * 0.9 * tanY;
      for (let ix = 0; ix < METER_COLS; ix++) {
        const u = ((ix / (METER_COLS - 1)) * 2 - 1) * 0.9 * tanX;
        // forward + u * right + v * up, in east / north / up
        let dx = ce * sa + u * ca - v * se * sa, dy = ce * ca - u * sa - v * se * ca, dz = se + v * ce;
        const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
        let t = 0.3, z = NaN, hit = false;
        while (t < 120000) {
          z = sh.zAt(oe + t * dx, on + t * dy, cell);
          if (Number.isNaN(z)) break;
          if (zEye + t * dz <= z) { hit = true; break; }
          t = t * 1.035 + 0.25;
        }
        if (!hit) continue;
        const e = oe + t * dx, n = on + t * dy, s = cell.s;
        const ge = (sh.zAt(e + s, n) - sh.zAt(e - s, n)) / (2 * s), gn = (sh.zAt(e, n + s) - sh.zAt(e, n - s)) / (2 * s);
        let nx = Number.isNaN(ge) ? 0 : -ge, ny = Number.isNaN(gn) ? 0 : -gn, nz = 1;
        const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
        const mu0 = nx * sx + ny * sy + nz * sz, mu = -(nx * dx + ny * dy + nz * dz);
        const phaseDeg = Math.acos(clamp(-(sx * dx + sy * dy + sz * dz), -1, 1)) / DEG;
        const vis = sh.visAt(e, n, this.sunAzDeg), direct = moonDust(mu0, mu, phaseDeg) * vis * 0.99;
        const fill = this.fillEarth * (0.25 + 0.75 * Math.max(0, nx * ex[0] + ny * ex[1] + nz * ex[2])) + this.fillAmb * (0.65 + 0.35 * nz) + this.fillStar * nz * nz;
        // like a real light meter it also sees how dark the ground itself is (the photo's average there)
        const M = this.means ? this.means.meanAt(e, n) : NaN;
        const albedo = Number.isNaN(M) ? 1 : Math.pow(Math.max(M, 0.004) / PHOTO[0], vis > 0.5 ? PHOTO[1] : PHOTO[3]);
        const L = (direct + fill) * albedo;
        logs[hits++] = Math.log(Math.max(L, 1e-6));
        sum += Math.log(Math.max(L, 1e-6));
        if (vis > 0.5 && mu0 > 0.005) lit++; // in sunshine (even if it looks dark seen towards a low Sun)
      }
    }
    // the Sun itself in view: dazzling, no stars
    const sunInView = this.sunElDeg > -0.3 && (this.sky.sunPart ?? 1) > 0.01 && this.inView(sx, sy, sz, tanX, tanY);
    if (hits < 4) {
      // (nearly) only sky in view: keep the exposure, let the eye get used to the dark
      this.skyTarget = sunInView ? SKY_SUN : 1;
      return true;
    }
    const litFrac = lit / hits, groundFrac = hits / (METER_ROWS * METER_COLS);
    const sorted = logs.subarray(0, hits).sort();
    const high = Math.exp(sorted[hits - 1]); // the brightest ground in view (a sunlit ridge can be a thin line)
    let exposure = Math.exp(Math.log(METER[1] * this.nightScale()) + (Math.log(METER[0]) - Math.log(METER[1] * this.nightScale())) * litFrac - sum / hits);
    // sunlit slopes stay light grey, never snow-white; standing in shade the camera still lets far sunlit
    // hills get brighter so the ground around you stays readable (as a camera exposed for the shade would)
    exposure = Math.min(exposure, (METER[2] * (2.5 - 1.5 * litFrac)) / high);
    this.exposureTarget = clamp(exposure, 0.3, 600);
    this.skyTarget = clamp(1 - (1 - SKY_LIT) * litFrac * Math.min(1, groundFrac * 2.5), SKY_LIT, 1);
    if (sunInView) this.skyTarget = Math.min(this.skyTarget, SKY_SUN);
    return true;
  }

  /** Is a direction (east / north / up) inside the current view? */
  private inView(x: number, y: number, z: number, tanX: number, tanY: number): boolean {
    const az = this.az * DEG, el = this.el * DEG, ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
    const f = x * ce * sa + y * ce * ca + z * se;
    if (f <= 0.05) return false;
    const r = x * ca - y * sa, u = -x * se * sa - y * se * ca + z * ce;
    return Math.abs(r / f) < tanX && Math.abs(u / f) < tanY;
  }

  private setSkyExposure(v: number) {
    if (v === this.skyExposure) return;
    this.skyExposure = v;
    this.onSkyExposure?.(v);
  }

  private sweepShadows() {
    const sh = this.shadows, mat = this.material;
    if (!sh || !mat) return;
    this.shadowDirty = false;
    sh.sweep(this.sunAzDeg, this.sunElDeg);
    this.sweptAz = this.sunAzDeg; this.sweptEl = this.sunElDeg;
    this.stats.shadowSweepMs = +sh.sweepMs.toFixed(2);
    if (this.rocksShown) this.rasterRocks();
    const source = { width: SH_N, height: SH_N, arrayBufferView: sh.rgba };
    const u = mat.uniforms as Record<string, unknown>;
    if (!this.shadowTex) { this.shadowTex = this.gpuTexture(source); u.lvShadowTex = this.shadowTex; } else this.shadowTex.copyFrom({ source });
    Cartesian3.fromElements(sh.ready[0] ? SH_N * SH_CELL[0] : 0, sh.ready[1] ? SH_N * SH_CELL[1] : 0, sh.ready[2] ? SH_N * SH_CELL[2] : 0, u.lvSpan as Cartesian3);
    this.viewer.scene.requestRender();
  }

  private gpuTexture(source: { width: number; height: number; arrayBufferView: Uint8Array | Uint16Array }, pixelDatatype?: number): GpuTexture {
    return new Gpu.Texture({
      context: (this.viewer.scene as unknown as { context: unknown }).context, source, flipY: false,
      ...(pixelDatatype !== undefined ? { pixelFormat: Gpu.PixelFormat.RGBA, pixelDatatype } : {}),
      sampler: new Gpu.Sampler({
        wrapS: Gpu.TextureWrap.CLAMP_TO_EDGE, wrapT: Gpu.TextureWrap.CLAMP_TO_EDGE,
        minificationFilter: Gpu.TextureMinificationFilter.LINEAR, magnificationFilter: Gpu.TextureMagnificationFilter.LINEAR,
      }),
    });
  }

  /** Hand the 80 m height map around the lander to the ground shader (once per spot). */
  private uploadHeights() {
    const packed = this.shadows?.packSlopes(), mat = this.material;
    if (!packed || !mat || !this.materialOn) return;
    const source = { width: packed.size, height: packed.size, arrayBufferView: packed.half };
    const u = mat.uniforms as Record<string, unknown>;
    if (!this.heightTex) { this.heightTex = this.gpuTexture(source, Gpu.PixelDatatype.HALF_FLOAT); u.lvHeightTex = this.heightTex; } else this.heightTex.copyFrom({ source });
    (u.lvHeightInfo as Cartesian2).x = packed.span;
    this.viewer.scene.requestRender();
  }

  /** Hand the photo's average brightness maps to the ground shader (once per spot). */
  private uploadMeans() {
    const pm = this.means, mat = this.material;
    if (!pm || !mat || !this.materialOn) return;
    const u = mat.uniforms as Record<string, unknown>;
    if (pm.covered) {
      const source = { width: PM_N, height: PM_N, arrayBufferView: pm.rgba };
      if (!this.meanTex) { this.meanTex = this.gpuTexture(source); u.lvMeanTex = this.meanTex; } else this.meanTex.copyFrom({ source });
      Cartesian2.fromElements(PM_N * PM_CELL[0], PM_N * PM_CELL[1], u.lvMeanSpan as Cartesian2);
    } else Cartesian2.fromElements(0, 0, u.lvMeanSpan as Cartesian2);
    this.stats.meanBuildMs = pm.buildMs;
    this.viewer.scene.requestRender();
  }

  /**
   * The tag's words and state. In view: just the name, under the body. Out of sight: the tag moves onto the
   * skyline in the body's compass direction and says why it cannot be seen (never a ring floating over the ground).
   */
  private updateTagText(sunEl: number, earthEl: number) {
    const sky = this.sky;
    if (!sky) return;
    const set = (t: Tag, name: string, part: number | null, el: number) => {
      let state = 'clear', label = name;
      const gone = part === null ? el < 0 : part <= 0.001;
      if (gone && el < 0) { state = 'below'; label = tr('lander.tag.below', { name }); }
      else if (gone) { state = 'hidden'; label = tr('lander.tag.hidden', { name }); }
      else if (part !== null && part < 0.999) { state = 'partial'; label = tr('lander.tag.partly', { name }); }
      if (t.label !== label) { t.label = label; t.text.textContent = label; }
      if (t.state !== state) { t.state = state; t.el.dataset.state = state; }
    };
    set(this.tags.sun, tr('lander.sun'), sky.sunPart, sunEl);
    set(this.tags.earth, tr('lander.earth'), sky.earthUp === null ? null : sky.earthUp ? 1 : 0, earthEl);
  }

  /** Every frame: put the small "Sun" / "Earth" name tags under the real things (or on the skyline). Screen-space maths only. */
  private placeTags() {
    const cam = this.viewer.camera, W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    const fovy = (cam.frustum as unknown as { fovy: number }).fovy;
    const focal = H / 2 / Math.tan(fovy / 2);
    let prev: { x: number; y: number; r: number } | null = null;
    for (const t of [this.tags.sun, this.tags.earth]) {
      const out = t.state === 'below' || t.state === 'hidden';
      const dir = out ? this.dirFor(t.az, this.skylineAt(t.az), t.onSky) : t.dir;
      const cz = Cartesian3.dot(dir, cam.direction);
      if (cz < 0.2) { if (t.el.style.display !== 'none') t.el.style.display = 'none'; continue; }
      const x = W / 2 + (Cartesian3.dot(dir, cam.right) / cz) * focal, y = H / 2 - (Cartesian3.dot(dir, cam.up) / cz) * focal;
      // on the skyline the compass tape already says where the body is: off screen means no tag at all
      const m = out ? 0 : 80, top = out ? 30 : -40;
      if (x < -m || x > W + m || y < top || y > H + 40) { if (t.el.style.display !== 'none') t.el.style.display = 'none'; continue; }
      // the words sit under the body, or just above the skyline (the text's top is --r + 10 px below the point)
      let r = out ? -26 : Math.max(5, t.radiusDeg * DEG * focal);
      // two tags in nearly the same direction (both under the horizon to the east at dawn): stack the words
      if (prev && Math.abs(x - prev.x) < 190 && Math.abs(y + r - (prev.y + prev.r)) < 18) r = prev.y + prev.r - y - 18;
      prev = { x, y, r };
      if (t.el.style.display !== '') t.el.style.display = '';
      t.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      t.el.style.setProperty('--r', `${r.toFixed(1)}px`);
    }
  }

  /** The skyline the science worker calculated, as a faint dotted line. */
  private drawSkyline() {
    this.clearEntities();
    const sk = this.spec?.skyline;
    if (!sk) return;
    const n = sk.elevations.length, pts: Cartesian3[] = [];
    const steps = Math.min(n, 720);
    for (let i = 0; i <= steps; i++) {
      const k = Math.round((i / steps) * n) % n;
      const d = this.dirFor(k * sk.stepDeg, sk.elevations[k], new Cartesian3(), true);
      pts.push(Cartesian3.add(this.eye, Cartesian3.multiplyByScalar(d, 60_000, d), d));
    }
    const dash = new PolylineDashMaterialProperty({ color: Color.WHITE.withAlpha(0.34), gapColor: Color.TRANSPARENT, dashLength: 9, dashPattern: 0b1110000011100000 });
    this.entities.push(this.viewer.entities.add({ polyline: { positions: pts, width: 1.25, arcType: ArcType.NONE, material: dash, depthFailMaterial: dash } }));
    this.showSkyline();
  }

  /** The dotted line belongs to the landing spot: shown only when asked for and while you are still near it. */
  private showSkyline() {
    const on = landerLink.skyline && this.fromSpot < 15;
    for (const e of this.entities) if (e.show !== on) e.show = on;
    this.viewer.scene.requestRender();
  }

  /** How high the calculated skyline stands (degrees) in a compass direction; 0 (the flat horizon) when unknown or far from the spot. */
  private skylineAt(azDeg: number): number {
    const sk = this.spec?.skyline;
    if (!sk || this.fromSpot > 2000) return 0;
    const n = sk.elevations.length, f = wrap360(azDeg) / sk.stepDeg, i = Math.floor(f), k = f - i;
    return sk.elevations[i % n] * (1 - k) + sk.elevations[(i + 1) % n] * k;
  }

  private clearEntities() {
    for (const e of this.entities) this.viewer.entities.remove(e);
    this.entities = [];
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    zoomHandler = null; walkHandler = null; homeHandler = null; skylineHandler = null;
    for (const off of this.offs) off();
    this.offs = [];
    this.fade.remove();
    this.tagLayer.remove();
    if (landerLink.phase !== 'off') { landerLink.phase = 'off'; emitLink(); }
    const v = this.viewer;
    if (v.isDestroyed()) return;
    this.clearEntities();
    if (this.sunPic) v.scene.primitives.remove(this.sunPic);
    if (this.earthPic) v.scene.primitives.remove(this.earthPic);
    this.sunShadow?.destroy();
    this.sunShadow = null;
    this.farRocks?.destroy();
    this.lod?.destroy();
    this.lod = null;
    this.farRocks = null;
    if (this.material && v.scene.globe.material === this.material) v.scene.globe.material = undefined;
    for (const t of this.detailTex) t.destroy();
    this.detailTex = [];
    for (const r of this.rocks) v.scene.primitives.remove(r.model);
    this.rocks = [];
    this.rockTex?.destroy();
    this.rockTex = null;
    if (this.rover) v.scene.primitives.remove(this.rover);
    this.rover = null;
    viewHandler = null; lightsHandler = null;

  }
}
