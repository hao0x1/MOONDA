// The MOONDA rover's sounds in "Stand here". The sounds themselves are synthesised in audio/roverEngine.ts
// (no sound files; what each one should sound like is described there). This file is the switchboard: one
// audio context made on the start screen (prewarm), the settings (sound on/off, volume, graphics mode), the
// browser's "no sound before a click" rule, and when each sound may play:
//   - nothing plays outside Stand here: leaving fades everything out and puts the audio thread to sleep;
//   - MOONDA says a curious hello a moment after you arrive, and a sleepy note after a while parked;
//   - its calls are rate-limited, so a flickering "blocked" never repeats like knocking;
//   - a hard sudden stop (running into a rock) gives a soft bump even if nobody calls impact().
// There is no air on the Moon, so all of it is "heard through the robot's body and the helmet radio".

import { settings } from '../app/settings';
import { createRoverEngine, createMaster, type RoverEngine, type Voice } from './roverEngine';

/** Master loudness at the default volume (0.5): drive at about -30 LUFS, under the (ducked) music. */
const MASTER = 0.55;
/** Driving sounds are normalised to these: top speed (m/s) and a fast turn (deg/s). */
const TOP_SPEED = 5, FAST_TURN = 50;
/** Seconds parked (after driving) before MOONDA gets sleepy; seconds between helmet radio key-ups. */
const SLEEPY_S = 25, RADIO_S: [number, number] = [24, 55];
/** Shortest gap between two of the same call (s), so nothing ever repeats like knocking. */
const GAP: Record<Voice, number> = { wake: 5, start: 1.5, blocked: 3, sleep: 30, view: 0.15, lights: 0.3 };

interface Ctx { ctx: AudioContext; master: GainNode; eng: RoverEngine }

let g: Ctx | null = null;
let bedOn = false;
let gestureOff: (() => void) | null = null;
let radioTimer = 0, sleepTimer = 0, offTimer = 0, servoTimer = 0, slipTimer = 0;
const lastSaid: Partial<Record<Voice, number>> = {};
// the last values sent to the engine (only send when something audible changed)
let sent = { sp: -1, push: -1, turn: -1, t: 0 };
let prevSpeed = 0, prevT = 0, lastBump = 0, drove = false, moving = false;

function masterLevel(): number {
  const s = settings.get();
  return s.sound && !document.hidden ? MASTER * Math.min(2, s.volume / 0.5) : 0;
}
const live = () => !!g && g.ctx.state === 'running' && masterLevel() > 0;

function build(): Ctx | null {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC({ latencyHint: 'interactive' });
  const m = createMaster(ctx);
  const eng = createRoverEngine(ctx, m.input, { light: settings.get().quality === 'light' });
  return { ctx, master: m.input, eng };
}

/** Master level, and the audio thread asleep whenever nothing can be heard (outside Stand here, or muted). */
function applyMaster() {
  if (!g) return;
  const t = g.ctx.currentTime, lv = bedOn ? masterLevel() : 0;
  g.master.gain.cancelScheduledValues(t);
  g.master.gain.setTargetAtTime(lv, t, 0.15);
  window.clearTimeout(offTimer);
  if (lv === 0 && g.ctx.state === 'running') offTimer = window.setTimeout(() => { if (g && !(bedOn && masterLevel() > 0)) void g.ctx.suspend().catch(() => {}); }, 900);
  else if (lv > 0 && g.ctx.state === 'suspended') void g.ctx.resume().catch(() => {});
}

function resumeOnGesture() {
  if (gestureOff) return;
  const go = () => { if (g && bedOn && g.ctx.state !== 'running' && masterLevel() > 0) void g.ctx.resume().then(applyMaster, () => {}); };
  window.addEventListener('pointerdown', go, true);
  window.addEventListener('keydown', go, true);
  gestureOff = () => { window.removeEventListener('pointerdown', go, true); window.removeEventListener('keydown', go, true); };
}

function say(kind: Voice, delay = 0.01) {
  if (!g || !live()) return;
  const now = g.ctx.currentTime;
  if (now - (lastSaid[kind] ?? -1e9) < GAP[kind]) return;
  lastSaid[kind] = now;
  g.eng.say(kind, now + delay);
}

function scheduleRadio(first = false) {
  window.clearTimeout(radioTimer);
  if (!bedOn) return;
  const [a, b] = first ? [7, 14] : RADIO_S;
  radioTimer = window.setTimeout(() => {
    if (g && bedOn && live()) g.eng.radio(g.ctx.currentTime + 0.05);
    scheduleRadio();
  }, (a + Math.random() * (b - a)) * 1000);
}

/** After a while parked (having driven), MOONDA gets sleepy; any movement re-arms it. */
function armSleepy() {
  window.clearTimeout(sleepTimer);
  if (!bedOn || !drove) return;
  sleepTimer = window.setTimeout(() => { if (bedOn) say('sleep'); drove = false; }, SLEEPY_S * 1000);
}

const duckListeners = new Set<(k: number) => void>();
let duck = 1;

export const roverAudio = {
  /**
   * How loud the music should be while driving (1 = normal, 0.6 = 40% quieter). music.ts listens with
   * onDuck() and multiplies its volume by k; returns the function that stops listening.
   */
  onDuck(fn: (k: number) => void): () => void { duckListeners.add(fn); fn(duck); return () => { duckListeners.delete(fn); }; },
  /** Driving on or off: the music steps back while the rover is driven. */
  driving(on: boolean) {
    const k = on ? 0.6 : 1;
    if (k === duck) return;
    duck = k;
    duckListeners.forEach(l => l(k));
  },

  /** Build every node now (quietly, suspended), so the first "Stand here" and the first drive never wait for audio. */
  prewarm() {
    if (g) return;
    try { g = build(); } catch { g = null; }
    if (!g) return;
    if (import.meta.env.DEV) (window as unknown as { __moondaRoverAudio: unknown }).__moondaRoverAudio = roverAudio;
    void g.ctx.suspend().catch(() => {});
    resumeOnGesture();
    settings.subscribe((s, prev) => { if (s.sound !== prev.sound || s.volume !== prev.volume) applyMaster(); });
    document.addEventListener('visibilitychange', applyMaster);
  },

  /** In Stand here (on) or not (off): the helmet bed, and the whole rover sound, live only while on. */
  bed(on: boolean) {
    if (on === bedOn) return;
    bedOn = on;
    if (!g) roverAudio.prewarm();
    if (!g) return;
    const t = g.ctx.currentTime;
    g.eng.bed(on, t);
    if (!on) {
      g.eng.silence(t);
      sent = { sp: -1, push: -1, turn: -1, t: 0 }; prevSpeed = 0; drove = false; moving = false;
      window.clearTimeout(radioTimer); window.clearTimeout(sleepTimer);
    }
    applyMaster();
    if (on) {
      scheduleRadio(true);
      // a curious hello once the view has settled (only if sound can already play)
      window.setTimeout(() => { if (bedOn) say('wake'); }, 1400);
    }
  },

  /** Follow the rover: speed (m/s), whether the motors are pushing (0 / 1), how fast it turns (deg/s). */
  drive(speed: number, push: number, turnDegS: number) {
    if (!g || !bedOn) return;
    const t = g.ctx.currentTime, wall = performance.now() / 1000;
    const sp = Math.min(1, Math.abs(speed) / TOP_SPEED), turn = Math.min(1, Math.abs(turnDegS) / FAST_TURN), p = push > 0 ? 1 : 0;
    // a hard sudden stop (ran into a rock): a soft bump
    const dt = wall - prevT;
    if (dt > 0 && dt < 0.2 && prevSpeed > 1.2 && (prevSpeed - Math.abs(speed)) / dt > 12 && wall - lastBump > 0.6) {
      lastBump = wall;
      if (live()) g.eng.impact(Math.min(1, prevSpeed / TOP_SPEED) * 0.6, t + 0.005);
    }
    prevSpeed = Math.abs(speed); prevT = wall;
    // parked after driving: MOONDA gets sleepy after a while (the render loop may stop, so a timer)
    const movingNow = sp > 0.02 || p > 0;
    if (movingNow && !moving) { drove = true; window.clearTimeout(sleepTimer); }
    else if (!movingNow && moving) armSleepy();
    moving = movingNow;
    // only touch the audio graph when something audible changed (the engine glides between values)
    if (Math.abs(sp - sent.sp) < 0.01 && Math.abs(turn - sent.turn) < 0.03 && p === sent.push) return;
    if (wall - sent.t < 0.05 && p === sent.push && Math.abs(sp - sent.sp) < 0.1) return;
    sent = { sp, push: p, turn, t: wall };
    g.eng.drive(sp, p, turn, t);
  },

  /** A short call: 'start' (happy run), 'blocked' (questioning wobble), 'view' (soft double tick),
   *  and also 'wake', 'sleep', 'lights'. Each is rate-limited. */
  chirp(kind: 'start' | 'blocked' | 'view' | 'wake' | 'sleep' | 'lights') {
    say(kind);
  },

  // ---- optional extras (call them when you can; all safe to call every frame)

  /** Landing after air time, or a hard knock on a rock: strength 0..1 (about vertical m/s / 3). */
  /** a landing after air time, from the speed it came down with (m/s): the robot code calls this */
  land(speed: number) { roverAudio.impact(Math.min(1, speed / 2.5)); },
  /** a wheel meeting a bump or a rock, from the driving speed (m/s) */
  bump(speed: number) { roverAudio.impact(Math.min(1, speed / 5) * 0.55); },
  impact(strength: number) {
    if (!g || !live()) return;
    const wall = performance.now() / 1000;
    if (wall - lastBump < 0.25) return;
    lastBump = wall;
    g.eng.impact(strength, g.ctx.currentTime + 0.005);
  },
  /** How much the wheels slip (0..1); call every frame while it changes, it fades by itself when calls stop. */
  slip(amount: number) {
    if (!g || !bedOn) return;
    g.eng.slip(amount, g.ctx.currentTime);
    window.clearTimeout(slipTimer);
    if (amount > 0) slipTimer = window.setTimeout(() => { if (g) g.eng.slip(0, g.ctx.currentTime); }, 200);
  },
  /** The mast head turning (deg/s): a little servo purr; fades by itself when calls stop. */
  headTurn(degPerS: number) {
    if (!g || !bedOn) return;
    const a = Math.min(1, Math.abs(degPerS) / 120);
    g.eng.servo(a < 0.05 ? 0 : a, g.ctx.currentTime);
    window.clearTimeout(servoTimer);
    if (a >= 0.05) servoTimer = window.setTimeout(() => { if (g) g.eng.servo(0, g.ctx.currentTime); }, 150);
  },
  /** The lights were switched (on or off): a double tick (and a little power-on hum when on). */
  lights(on: boolean) { say(on ? 'lights' : 'view'); },
  /** For tests: the audio context state, nodes kept alive, the master level now. */
  debug() { return { state: g?.ctx.state ?? 'none', nodes: g?.eng.nodes ?? 0, master: g ? +g.master.gain.value.toFixed(3) : 0, bed: bedOn }; },
};
