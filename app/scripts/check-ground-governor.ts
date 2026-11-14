// Run: node scripts/check-ground-governor.ts
// A controlled clock and fake completed GPU queries check the frame governor's decisions. No
// browser or GPU is needed: this tests when it changes drawing size, not the cost of the shader.
import assert from 'node:assert/strict';
import { GroundGovernor } from '../src/moon/groundLod.ts';

const originalPerformance = globalThis.performance;
const originalDpr = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio');
let now = 1000;
Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });

class Signal {
  listeners = new Set<() => void>();
  addEventListener(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  fire() { for (const fn of this.listeners) fn(); }
}

function fixture(timer = true, base = 2, dpr = 2) {
  now += 1000;
  Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: dpr });
  const preRender = new Signal(), postRender = new Signal();
  let measuredMs = 8, deleted = 0, frameNumber = 0, queryDelay = 0;
  let active: { ms: number; readyAt: number } | null = null;
  const ext = { TIME_ELAPSED_EXT: 1, GPU_DISJOINT_EXT: 2 };
  const gl = {
    QUERY_RESULT_AVAILABLE: 3, QUERY_RESULT: 4,
    getExtension: () => timer ? ext : null,
    createQuery: () => ({ ms: measuredMs, readyAt: frameNumber + queryDelay }),
    beginQuery: (_kind: number, q: { ms: number; readyAt: number }) => { active = q; },
    endQuery: () => { if (active) { active.ms = measuredMs; active.readyAt = frameNumber + queryDelay; active = null; } },
    getParameter: () => false,
    getQueryParameter: (q: { ms: number; readyAt: number }, name: number) => name === 3 ? frameNumber >= q.readyAt : q.ms * 1e6,
    deleteQuery: () => { deleted++; },
  };
  const scene = { context: { webgl2: true, _gl: gl }, preRender, postRender };
  let resolution = base;
  const resizes: { at: number; from: number; to: number }[] = [];
  const viewer = {
    get resolutionScale() { return resolution; },
    set resolutionScale(value: number) { if (value !== resolution) resizes.push({ at: now, from: resolution, to: value }); resolution = value; },
  };
  const lod = { x: 1, y: 1 };
  const governor = new GroundGovernor(scene as never);
  governor.resetDrawing(viewer as never);
  const frame = (dt: number, moving: boolean, ms = measuredMs) => {
    measuredMs = ms; now += dt * 1000; frameNumber++;
    const busy = governor.step(dt, moving, lod as never, viewer as never);
    preRender.fire(); postRender.fire();
    return busy;
  };
  const run = (seconds: number, moving: boolean, ms = measuredMs, dt = 1 / 60) => {
    for (let s = 0; s < seconds - 1e-9; s += dt) frame(Math.min(dt, seconds - s), moving, ms);
  };
  const destroy = () => {
    governor.destroy();
    assert.equal(preRender.listeners.size + postRender.listeners.size, 0, 'timer callbacks survived destroy');
  };
  return { governor, viewer, lod, frame, run, destroy, resizes, delayQueries: (frames: number) => { queryDelay = frames; }, deleted: () => deleted };
}

const checks: string[] = [];
try {
  {
    const f = fixture(); f.run(0.1, false, 8);
    f.run(0.35, true, 30);
    assert.ok(f.lod.x < 1 && f.lod.x > 0.2, 'shader detail was not shed first');
    assert.equal(f.viewer.resolutionScale, 2, 'drawing shrank before shader detail');
    f.run(2, true, 30);
    assert.equal(f.viewer.resolutionScale, 1.5, 'drawing floor must stay at 75 percent');
    f.destroy(); checks.push('shader detail goes first; drawing stops at 75 percent');
  }
  {
    const f = fixture(); f.run(0.1, false, 8); f.governor.hold = 0.1;
    let highFor = 0, firstShrinkAt = 0;
    for (let i = 0; i < 80; i++) {
      const oldGpu = f.governor.gpu, oldSize = f.viewer.resolutionScale;
      f.frame(0.01, true, 30);
      // A resize starts a fresh timer history, so its just-consumed high estimate becomes zero.
      const shrank = f.viewer.resolutionScale < oldSize;
      highFor = f.governor.gpu > 14 || (shrank && oldGpu > 14) ? highFor + 0.01 : 0;
      if (!firstShrinkAt && highFor < 0.4 - 1e-9) assert.equal(f.viewer.resolutionScale, 2, `drawing shrank after only ${highFor}s over budget`);
      if (!firstShrinkAt && shrank) firstShrinkAt = highFor;
    }
    assert.ok(firstShrinkAt >= 0.4 - 1e-9 && firstShrinkAt <= 0.66, `high-time dwell or resize cadence is wrong: ${firstShrinkAt}`);
    f.destroy(); checks.push('drawing waits 400 ms of continuous high timings, then responds within one resize interval');
  }
  {
    const f = fixture(); f.run(0.1, false, 8); f.governor.hold = 0.1;
    f.run(0.25, true, 30, 0.01);
    f.run(0.3, true, 8, 0.01);
    assert.equal(f.viewer.resolutionScale, 2, 'short high burst changed drawing size');
    let highFor = 0;
    for (let i = 0; i < 38; i++) {
      f.frame(0.01, true, 30); highFor = f.governor.gpu > 14 ? highFor + 0.01 : 0;
      assert.equal(f.viewer.resolutionScale, 2, 'separate high bursts were added together');
    }
    assert.ok(highFor < 0.4);
    f.frame(0.01, false, 30); f.frame(0.01, true, 30);
    assert.equal(f.viewer.resolutionScale, 2, 'stopping did not reset the high dwell');
    f.destroy(); checks.push('low timings and stopping reset the high-time dwell');
  }
  {
    const base = 0.8673608, f = fixture(true, base, 2);
    f.run(0.1, false, 8); f.run(3, true, 30);
    assert.ok(f.viewer.resolutionScale >= 0.75, 'a capped Retina drawing fell below 1.5 native pixels per point');
    assert.ok(f.viewer.resolutionScale < base, 'the native floor prevented all permitted shedding');
    assert.equal(f.resizes.filter(r => r.to < r.from).length, 1, 'one bounded Retina correction caused more than one buffer allocation');
    f.run(1.02, false, 30); assert.equal(f.viewer.resolutionScale, base);
    f.destroy(); checks.push('a capped 2x Retina view keeps at least 1.5 native pixels per point');
  }
  {
    const f = fixture(); f.run(0.1, false, 8); f.governor.hold = 0.1;
    f.governor.samples = [];
    f.run(0.25, true, 16, 0.01); f.delayQueries(100);
    for (let i = 0; i < 80 && f.resizes.length === 0; i++) f.frame(0.01, true, 16);
    assert.equal(f.resizes.length, 1, 'first bounded correction did not happen');
    assert.ok(f.viewer.resolutionScale > 1.5 && f.viewer.resolutionScale < 1.9, 'modest overload was cut to the floor instead of its measured budget');
    assert.equal(f.governor.gpu, 0, 'old-size GPU estimate survived the correction');
    const samples = f.governor.samples.length, deletes = f.deleted();
    assert.ok(samples > 0 && deletes > 0, 'valid raw timings were not retained');
    f.run(0.8, true, 13, 0.01);
    assert.equal(f.resizes.length, 1, 'stale timings caused another allocation before fresh results arrived');
    assert.equal(f.governor.gpu, 0, 'an unavailable old-buffer readback was treated as a fresh measurement');
    f.delayQueries(0); f.run(2, true, 13, 0.01);
    assert.equal(f.resizes.length, 1, 'an in-budget replacement caused unnecessary buffer allocations');
    assert.ok(f.governor.samples.length >= samples, 'resizing erased raw GPU telemetry');
    f.destroy(); checks.push('one budget correction keeps raw telemetry and ignores stale old-size readbacks');
  }
  {
    const f = fixture(); f.run(0.1, false, 8); f.governor.hold = 0.1;
    for (let i = 0; i < 100 && f.resizes.length === 0; i++) f.frame(0.01, true, 16);
    assert.equal(f.resizes.length, 1);
    f.run(0.39, true, 16, 0.01);
    assert.equal(f.resizes.length, 1, 'a second correction did not wait for a fresh 400 ms high dwell');
    f.run(0.3, true, 16, 0.01);
    assert.equal(f.resizes.length, 2, 'a still-over-budget replacement never received its next bounded correction');
    f.destroy(); checks.push('each further correction waits for a fresh 400 ms high dwell');
  }
  for (const [dpr, base] of [[1, 1], [2, 0.625], [1, 1.25]]) {
    const f = fixture(true, base, dpr); f.run(0.1, false, 8); f.run(3, true, 30);
    assert.equal(f.viewer.resolutionScale, base, `a ${dpr}x screen's chosen ${base} drawing was reduced below its native floor`);
    f.destroy();
  }
  checks.push('1x displays and a chosen 1.25x Smooth drawing keep their normal size');
  {
    const f = fixture(); f.run(0.1, false, 8); f.run(2, true, 30);
    assert.equal(f.viewer.resolutionScale, 1.5);
    while (f.governor.gpu >= 12.5) f.frame(0.01, true, 8);
    const before = f.viewer.resolutionScale / 2, level = f.lod.x;
    f.run(0.5, true, 8, 0.01);
    const grown = f.viewer.resolutionScale / 2 - before;
    assert.ok(grown >= 0.1 && grown <= 0.15, `moving drawing recovery is not 0.25 per second: ${grown / 0.5}`);
    assert.equal(f.lod.x, level, 'shader recovered before the full drawing size');
    f.run(0.65, true, 8, 0.01);
    assert.equal(f.viewer.resolutionScale, 2, 'moving drawing did not recover fully');
    f.run(0.2, true, 8, 0.01);
    assert.ok(f.lod.x > level, 'shader did not recover after the full drawing size');
    f.destroy(); checks.push('moving drawing recovers at 0.25 per second before shader detail');
  }
  {
    const f = fixture(); f.run(0.1, false, 8); f.run(2, true, 30);
    assert.equal(f.viewer.resolutionScale, 1.5); assert.equal(f.lod.x, 0);
    let frames = 0, busy: boolean;
    do { busy = f.frame(1 / 60, false, 30); frames++; } while (busy && frames < 120);
    assert.ok(frames <= 62, `still recovery took longer than about one second: ${frames} frames`);
    assert.equal(f.viewer.resolutionScale, 2, 'still drawing did not recover despite a slow GPU');
    assert.equal(f.lod.x, 1); assert.equal(f.lod.y, 1);
    assert.equal(f.frame(1 / 60, false, 30), false, 'fully restored governor keeps the loop awake');
    f.destroy(); checks.push('still restores full drawing and detail within a second even over budget, then sleeps');
  }
  {
    const f = fixture(); f.governor.level = 0.9994; f.lod.x = 0.9994;
    let frames = 0, busy: boolean;
    do { busy = f.frame(0.0001, false, 30); frames++; } while (busy && frames < 30);
    assert.ok(frames > 1 && frames < 30, 'sub-threshold still recovery did not keep drawing until complete');
    assert.equal(f.lod.x, 1); assert.equal(f.lod.y, 1);
    assert.equal(f.frame(0.0001, false, 30), false, 'completed tiny recovery keeps the loop awake');
    f.governor.hold = 0.5; f.frame(1 / 60, false, 30);
    assert.equal(f.frame(1 / 60, false, 30), false, 'a held debug level keeps the loop awake');
    f.destroy(); checks.push('sub-threshold recovery reaches full detail before sleeping; a held debug level can sleep');
  }
  {
    const f = fixture(); f.run(0.1, false, 8); f.run(2, true, 30);
    while (f.governor.gpu >= 12.5) f.frame(0.01, true, 8);
    const before = f.viewer.resolutionScale;
    for (let i = 0; i < 50 && f.viewer.resolutionScale === before; i++) f.frame(0.01, true, 8);
    assert.ok(f.viewer.resolutionScale > before && f.viewer.resolutionScale < 1.9);
    // An uneven frame interval can leave the smooth recovery just below one. Reach that real
    // output, then hold shader detail at one so only the drawing size can keep the loop awake.
    const elapsed = (1 - 0.0000005 - f.viewer.resolutionScale / 2) / 0.25;
    now += (elapsed - 0.1) * 1000; f.frame(0.1, true, 8);
    assert.ok(f.viewer.resolutionScale > 1.999 && f.viewer.resolutionScale < 2);
    f.governor.hold = 1; f.frame(0.00001, true, 8);
    let busy: boolean;
    let frames = 0;
    do { busy = f.frame(1 / 60, false, 30); frames++; } while (busy && frames < 30);
    assert.equal(f.viewer.resolutionScale, 2, 'a tiny drawing gap was left behind when the loop slept');
    assert.equal(f.lod.x, 1); assert.equal(f.lod.y, 1);
    assert.ok(frames <= 17);
    f.destroy(); checks.push('sub-threshold drawing recovery reaches the exact base before sleeping');
  }
  {
    const f = fixture(false); f.run(0.2, false, 8); f.governor.hold = 0.1;
    f.frame(0.2, true); f.run(0.5, true, 8);
    assert.equal(f.viewer.resolutionScale, 2, 'one slow CPU frame shrank a timer-free drawing');
    f.governor.hold = null; f.run(2, true, 8, 0.12);
    assert.ok(f.viewer.resolutionScale < 2, 'timer-free 120 ms frames did not trigger governing');
    assert.ok(f.viewer.resolutionScale >= 1.5, 'timer-free drawing went below its floor');
    f.run(1.02, false, 8, 0.12);
    assert.equal(f.viewer.resolutionScale, 2); assert.equal(f.lod.x, 1); assert.equal(f.lod.y, 1);
    f.destroy(); checks.push('without a GPU timer, isolated slow frames do not shrink but sustained slow frames do');
  }
  {
    const f = fixture(); f.run(0.1, false, 8); f.run(2, true, 30);
    f.viewer.resolutionScale = 1.8; f.frame(1 / 60, false, 30);
    f.run(1.02, false, 30);
    assert.equal(f.viewer.resolutionScale, 1.8, 'external quality setting was overwritten by the old drawing base');
    f.destroy(); assert.ok(f.deleted() > 0, 'completed GPU queries were never freed');
    checks.push('a new quality setting becomes the drawing base; GPU queries and callbacks are freed');
  }
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: originalPerformance });
  if (originalDpr) Object.defineProperty(globalThis, 'devicePixelRatio', originalDpr);
  else delete (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
}
