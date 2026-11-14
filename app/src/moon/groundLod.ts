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

import type { Cartesian2, Scene } from 'cesium';

/** How dense the (invisible) fog is for refining tiles: errors far away may grow by up to FOG_SSE px (reached ~60 km out). */
const FOG_DENSITY = 1 / 30000, FOG_SSE = 2;

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

type TimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

export class GroundGovernor {
  /** detail level: 1 = everything, 0 = the cheapest look */
  level = 1;
  private gpuMs = 0;
  /** for tests: every measured GPU frame time (ms), when set to an array */
  samples: number[] | null = null;
  /** for tests: hold the level here (no governing) */
  hold: number | null = null;
  private frameMs = 16.7;
  private lastT = 0;
  private readonly gl: WebGL2RenderingContext | null;
  private readonly ext: TimerExt | null;
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private readonly offs: (() => void)[] = [];

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
        this.active = q;
      }));
      this.offs.push(scene.postRender.addEventListener(() => {
        if (!this.active) return;
        g.endQuery(X.TIME_ELAPSED_EXT);
        this.pending.push(this.active);
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
  step(dt: number, moving: boolean, lod: Cartesian2): boolean {
    const now = performance.now();
    if (this.lastT && now - this.lastT < 100) this.frameMs += (now - this.lastT - this.frameMs) * 0.15;
    this.lastT = now;
    this.poll();
    let L = this.level;
    if (this.hold !== null) L = this.hold;
    else if (!moving) L = Math.min(1, L + dt * BACK_RATE_STILL);
    else {
      const high = this.ext ? this.gpuMs > GPU_HIGH_MS : this.frameMs > FRAME_HIGH_MS;
      const low = this.ext ? this.gpuMs < GPU_TARGET_MS : this.frameMs < 17.2;
      if (high) L = Math.max(0, L - dt * SHED_RATE);
      else if (low) L = Math.min(1, L + dt * BACK_RATE_MOVING);
    }
    this.level = L;
    const x = L, y = 1 + (FOOTPRINT_MAX - 1) * (1 - L) * (1 - L * 0.5);
    const changed = Math.abs(lod.x - x) > 1e-3 || Math.abs(lod.y - y) > 1e-3;
    lod.x = x; lod.y = y;
    return changed;
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
