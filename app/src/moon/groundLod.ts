// How much detail the Stand-here ground shader draws, kept within the frame budget (see lander.ts GROUND_SHADER).
//
// Measured on the M5 (13 Nov, GPU timer, standing still, 2880 x 1800): the ground shader is 12-14 ms of a
// 17-21 ms frame; turning hitched because the graphics chip, not tile loading, ran over the 16.7 ms of a frame.
// Two helpers:
//   landerTerrainFog(): while standing, far terrain tiles seen edge-on are refined less (Cesium's fog-based
//     screen-space error, with the fog itself never drawn). At the polar ridge the 80 m tiles near the horizon
//     drew 1.2 million triangles, most smaller than a pixel (each pays the ground shader 2-4 times over);
//     now ~0.7 million, -2 ms, with the far hills' outline still within ~2.5 px of the full-detail one.
//   GroundGovernor: watches how long the graphics chip takes per frame (EXT_disjoint_timer_query_webgl2, or the
//     frame interval where the browser has no timer) and, only while the view moves, sheds detail smoothly
//     (small craters fade out earlier with distance, fewer smooth scan reads, shorter little-shadow walks);
//     when the view is still it brings it all back over about a second. Never a jump: every knob is a fade.

import type { Cartesian2, Scene, Viewer } from 'cesium';

/** Invisible refinement fog: far hills may grow by up to 3 px (~35 km out); nearby wheel terrain stays fine.
 * Ridge A/B: about 25% fewer terrain triangles, with genuine level-18 ground still under the rover. */
const FOG_DENSITY = 1 / 18000, FOG_SSE = 3;

let saved: { enabled: boolean; renderable: boolean; density: number; sse: number; heightScalar: number; heightFalloff: number } | null = null;

/** Far tiles refined a little less while standing (on), the map's own fog setting back (off). */
export function landerTerrainFog(scene: Scene, on: boolean): void {
  const f = scene.fog as Scene['fog'] & { heightScalar: number; heightFalloff: number };
  if (on) {
    saved ??= { enabled: f.enabled, renderable: f.renderable, density: f.density, sse: f.screenSpaceErrorFactor, heightScalar: f.heightScalar, heightFalloff: f.heightFalloff };
    // (no height dependence: the density is the same whatever the ground's height under you; still thinner when
    // you look down, Cesium's own rule, since tiles under you are seen face-on)
    f.enabled = true; f.renderable = false; f.density = FOG_DENSITY; f.screenSpaceErrorFactor = FOG_SSE; f.heightScalar = 1; f.heightFalloff = 0;
  } else if (saved) {
    f.enabled = saved.enabled; f.renderable = saved.renderable; f.density = saved.density; f.screenSpaceErrorFactor = saved.sse;
    f.heightScalar = saved.heightScalar; f.heightFalloff = saved.heightFalloff;
    saved = null;
  }
}

/** Graphics-chip time per frame we aim for while moving (ms): the rest of a 60 fps frame is the CPU and the screen. */
const GPU_TARGET_MS = 12.5, GPU_HIGH_MS = 14;
/** Without a GPU timer: frame intervals above this (ms, smoothed) count as "too slow". */
const FRAME_HIGH_MS = 18.5;
/** How fast detail is shed (per second, while over budget) and brought back (per second, view still / under budget). */
const SHED_RATE = 1.6, BACK_RATE_STILL = 1.0, BACK_RATE_MOVING = 0.25;
/** At the lowest level the crater sizes fade out this many times nearer (see lvLod.y in the shader). */
const FOOTPRINT_MAX = 2.4;
/** The drawing size never falls below this share of the full surface size while moving. */
const DRAWING_FLOOR = 0.75;
/** Under sustained load, keep at least 1.25 pixels per screen point, or the chosen size if already smaller. */
const DRAWING_NATIVE_FLOOR = 1.25;
/** Give shader detail time to ease down before reducing the picture's size. */
const DRAWING_HIGH_DWELL_S = 0.4, DRAWING_STEP_MS = 250;
const DRAWING_MIN_CUT = 0.025;
const DRAWING_BACK_MOVING = 0.25, DRAWING_BACK_STILL = 1;

type TimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

export class GroundGovernor {
  /** detail level: 1 = everything, 0 = the cheapest look */
  level = 1;
  private gpuMs = 0;
  /** for tests: every measured GPU frame time (ms), when set to an array */
  samples: number[] | null = null;
  /** for tests: hold shader detail here; drawing size still follows the frame budget */
  hold: number | null = null;
  private frameMs = 16.7;
  private lastT = 0;
  private readonly gl: WebGL2RenderingContext | null;
  private readonly ext: TimerExt | null;
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private drawingRevision = 0;
  private activeRevision = 0;
  private readonly offs: (() => void)[] = [];
  private drawingBase = 0;
  private drawingScale = 1;
  private drawingApplied = 0;
  private drawingAt = 0;
  private overBudgetS = 0;

  constructor(scene: Scene) {
    const gl = (scene as unknown as { context: { _gl: WebGL2RenderingContext; webgl2: boolean } }).context;
    this.gl = gl.webgl2 ? gl._gl : null;
    this.ext = (this.gl?.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null) ?? null;
    if (this.gl && this.ext) {
      const g = this.gl, X = this.ext;
      this.offs.push(scene.preRender.addEventListener(() => {
        // (only while standing: step() runs every frame there)
        if (this.active || this.pending.length > 3 || performance.now() - this.lastT > 500) return;
        const q = g.createQuery();
        if (!q) return;
        g.beginQuery(X.TIME_ELAPSED_EXT, q);
        this.active = q; this.activeRevision = this.drawingRevision;
      }));
      this.offs.push(scene.postRender.addEventListener(() => {
        if (!this.active) return;
        g.endQuery(X.TIME_ELAPSED_EXT);
        if (this.activeRevision === this.drawingRevision) this.pending.push(this.active);
        else g.deleteQuery(this.active); // drawing size changed after this query began
        this.active = null;
      }));
    }
  }

  /** read finished GPU timings (they arrive a frame or two late) */
  private poll() {
    const g = this.gl, X = this.ext;
    if (!g || !X) return;
    const disjoint = g.getParameter(X.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!g.getQueryParameter(q, g.QUERY_RESULT_AVAILABLE)) break;
      const ms = (g.getQueryParameter(q, g.QUERY_RESULT) as number) / 1e6;
      g.deleteQuery(q);
      this.pending.shift();
      if (!disjoint && ms > 0 && ms < 200 && this.samples) { this.samples.push(ms); if (this.samples.length > 2000) this.samples.shift(); }
      if (!disjoint && ms > 0 && ms < 200) this.gpuMs = this.gpuMs ? this.gpuMs + (ms - this.gpuMs) * 0.25 : ms;
    }
  }

  /**
   * Once a frame (lander.ts stepMarch). moving: the view turns fast or the robot drives. Sets lvLod
   * (x = level, y = crater footprint factor) and returns true while it still changes (draw another frame).
   */
  step(dt: number, moving: boolean, lod: Cartesian2, viewer?: Viewer): boolean {
    const now = performance.now();
    const gap = now - this.lastT;
    // Slow frames count too, but waking after a long idle is not a graphics-chip measurement.
    if (this.lastT && gap > 0 && gap < 500) this.frameMs += (Math.min(gap, 100) - this.frameMs) * 0.15;
    this.lastT = now;
    this.poll();
    const high = this.ext ? this.gpuMs > GPU_HIGH_MS : this.frameMs > FRAME_HIGH_MS;
    const low = this.ext ? this.gpuMs > 0 && this.gpuMs < GPU_TARGET_MS : this.frameMs < 17.2;
    this.overBudgetS = moving && high ? this.overBudgetS + Math.min(Math.max(dt, 0), 0.1) : 0;
    let L = this.level;
    if (this.hold !== null) L = this.hold;
    else if (!moving) L = Math.min(1, L + dt * BACK_RATE_STILL);
    else {
      if (high) L = Math.max(0, L - dt * SHED_RATE);
      // Recover a sharp picture first. Once its full size is back, richer shading may return.
      else if (low && (!viewer || this.drawingScale === 1)) L = Math.min(1, L + dt * BACK_RATE_MOVING);
    }
    this.level = L;
    const x = L, y = 1 + (FOOTPRINT_MAX - 1) * (1 - L) * (1 - L * 0.5);
    const changed = Math.abs(lod.x - x) > 1e-3 || Math.abs(lod.y - y) > 1e-3;
    lod.x = x; lod.y = y;
    // A tiny final recovery step can be smaller than the visible-change threshold. Keep the
    // sleeping render loop awake until full detail is back, unless a test deliberately holds it.
    const restoring = !moving && this.hold === null && L < 1;
    return (viewer ? this.stepDrawing(now, moving, viewer) : false) || changed || restoring;
  }

  /** Capture the surface view's normal drawing size after its quality setting is applied. */
  resetDrawing(viewer: Viewer): void {
    this.drawingBase = this.drawingApplied = viewer.resolutionScale;
    this.drawingScale = 1; this.drawingAt = performance.now();
    this.resetDrawingTimings();
  }

  /** Old buffer timings cannot tell us whether its replacement is still over budget. */
  private resetDrawingTimings(): void {
    this.drawingRevision++;
    if (this.gl) this.pending.forEach(q => this.gl!.deleteQuery(q));
    this.pending.length = 0;
    this.gpuMs = 0; this.frameMs = 16.7; this.overBudgetS = 0;
  }

  /**
   * Once shader detail has been shed, fewer pixels are the remaining way to meet the frame budget.
   * One bounded budget correction avoids several expensive buffer reallocations for the same
   * overload. Recovery stays smooth, at most four updates a second.
   * The terrain and wheel samples stay real; the full drawing size returns when the view stops.
   */
  private stepDrawing(now: number, moving: boolean, viewer: Viewer): boolean {
    if (!this.drawingBase || Math.abs(viewer.resolutionScale - this.drawingApplied) > 1e-3) this.resetDrawing(viewer);
    const elapsed = Math.min(1, Math.max(0, (now - this.drawingAt) / 1000));
    if (now - this.drawingAt < DRAWING_STEP_MS) return !moving && this.drawingScale < 1;
    this.drawingAt = now;
    let next = this.drawingScale;
    const high = this.ext ? this.gpuMs > GPU_HIGH_MS : this.frameMs > FRAME_HIGH_MS;
    const low = this.ext ? this.gpuMs > 0 && this.gpuMs < GPU_TARGET_MS : this.frameMs < 17.2;
    if (!moving) next = Math.min(1, next + elapsed * DRAWING_BACK_STILL);
    else if (high && this.level < 0.2 && this.overBudgetS >= DRAWING_HIGH_DWELL_S) {
      const budget = this.ext ? Math.sqrt(GPU_TARGET_MS / this.gpuMs) : Math.sqrt(16.7 / this.frameMs);
      const dpr = Number.isFinite(globalThis.devicePixelRatio) && globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 2;
      // Full detail already caps large Retina buffers. A further relative cut must not take
      // their actual drawing below 1.25x, or reduce a 1x / Smooth view below the user's choice.
      const floor = Math.max(DRAWING_FLOOR, Math.min(1, DRAWING_NATIVE_FLOOR / (dpr * this.drawingBase)));
      next = Math.max(floor, next * budget);
    } else if (low) next = Math.min(1, next + elapsed * DRAWING_BACK_MOVING);
    if (next === this.drawingScale) return !moving && next < 1;
    // Tiny cuts save less than the stall of reallocating every surface render target.
    if (moving && next < this.drawingScale && this.drawingScale - next < DRAWING_MIN_CUT) return false;
    this.drawingScale = next;
    this.drawingApplied = this.drawingBase * next;
    viewer.resolutionScale = this.drawingApplied;
    this.resetDrawingTimings();
    return true;
  }

  /** for tests: the smoothed GPU time per frame (ms; 0 without a timer) */
  get gpu(): number { return this.gpuMs; }

  destroy() {
    this.offs.forEach(o => o());
    this.offs.length = 0;
    const g = this.gl;
    if (g) {
      if (this.active && this.ext) { g.endQuery(this.ext.TIME_ELAPSED_EXT); g.deleteQuery(this.active); }
      this.pending.forEach(q => g.deleteQuery(q));
    }
    this.pending.length = 0; this.active = null;
  }
}
