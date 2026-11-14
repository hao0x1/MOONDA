// The sound engine behind audio/rover.ts: every MOONDA sound in "Stand here", synthesised with the Web Audio
// API (no sound files). It works on any audio context, so the very same graph can also be rendered offline
// (OfflineAudioContext) to measure it: loudness, peaks, and that nothing knocks while cruising.
//
// What you should hear (check by ear):
//   - DRIVE: a smooth electric hum, like a small toy motor heard through the robot's own body. Three voices a
//     few cents apart (a slow, soft chorus), a thin gear whine that rises with speed, a slight wobble when the
//     motors work hard. It glides with the speed, never steps. Silent when the robot stands still.
//   - ROLLING: a soft continuous "shhh" of wheels on fine dust, brighter and louder as it speeds up, with tiny
//     irregular variations. No thumps, no clicks, no rhythm.
//   - EVENTS (only for real things): a soft low "tump" plus a puff of dust when it lands after air time
//     (impact), a thin hiss while a wheel slips (slip), a strained motor when it cannot climb (blocked).
//   - VOICE (MOONDA's own): short sung blips with one shape of their own: every note glides up, overshoots a
//     little and settles (a tiny "wu-ee"). Notes from one bright five-note scale, so all calls sound like the
//     same little character: curious two-note on waking, a happy little run when it sets off, a questioning
//     wobble when blocked, a sleepy slide down when parked a while, a soft double tick for lights / camera,
//     and a quiet servo purr when the head turns.
//   - HELMET: an almost inaudible air hiss that slowly breathes (never a noticeable loop), and now and then a
//     radio "key-up": a short high tone, a few seconds of faint static, a slightly lower closing tone.
// There is no air on the Moon, so all of it is band-limited, a little muffled and dry (no echo): what you hear
// is the robot's body and the helmet radio.

/** Loudness of each part (before the master level). */
export const LEVEL = {
  motor: 0.024, gear: 0.004, roll: 0.036, grit: 0.011, slip: 0.022, impact: 0.06, dust: 0.025,
  voice: 0.05, tick: 0.03, servo: 0.012, bed: 0.009, radio: 0.012, static: 0.006,
};

/** Notes of MOONDA's voice: one bright pentatonic scale (A major), so every call belongs to the same character. */
const N = { E5: 659.3, Fs5: 740, A5: 880, B5: 987.8, Cs6: 1108.7, E6: 1318.5, Fs6: 1480, A6: 1760, A4: 440, E4: 329.6 };

export type Voice = 'wake' | 'start' | 'blocked' | 'sleep' | 'view' | 'lights';

export interface RoverEngine {
  /** helmet bed on / off */
  bed(on: boolean, t: number): void;
  /** speed 0..1 (of top speed), push 0/1, turning 0..1 */
  drive(sp: number, push: number, turning: number, t: number): void;
  slip(amount: number, t: number): void;
  servo(amount: number, t: number): void;
  impact(strength: number, t: number): void;
  say(kind: Voice, t: number): void;
  radio(t: number): void;
  /** fade the drive layers out quickly (leaving Stand here) */
  silence(t: number): void;
  nodes: number;
}

// ---------------------------------------------------------------------------------------------- buffers

/** Noise that loops without a seam: the tail is cross-faded into the head. `tilt` 0 = white, ~0.9 = soft/pink. */
function loopNoise(ctx: BaseAudioContext, seconds: number, tilt: number, seed: number): AudioBuffer {
  const sr = ctx.sampleRate, fade = Math.round(sr * 0.3), n = Math.round(sr * seconds);
  const raw = new Float32Array(n + fade);
  let s = seed >>> 0 || 1, last = 0, sum2 = 0;
  for (let i = 0; i < raw.length; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    const w = (s >>> 0) / 4294967296 * 2 - 1;
    last = tilt * last + (1 - tilt) * w;
    raw[i] = last; sum2 += last * last;
  }
  const norm = 0.35 / Math.sqrt(sum2 / raw.length); // same loudness whatever the tilt
  const buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = raw[i] * norm;
  for (let i = 0; i < fade; i++) { // equal-power cross-fade of the extra tail over the head
    const x = i / fade;
    d[i] = raw[i] * norm * Math.sin(x * Math.PI / 2) + raw[n + i] * norm * Math.cos(x * Math.PI / 2);
  }
  return buf;
}

/** A slow smooth random wave in -1..1 (cosine steps between random points), looping exactly. */
function wanderBuffer(ctx: BaseAudioContext, points: number, stepS: number, seed: number): AudioBuffer {
  const rate = 3000; // a control signal: a low rate is plenty and costs nothing
  const pts: number[] = [];
  let s = seed;
  for (let i = 0; i < points; i++) { s = (s * 16807) % 2147483647; pts.push((s / 2147483647) * 2 - 1); }
  const per = Math.round(stepS * rate), buf = ctx.createBuffer(1, per * points, rate), d = buf.getChannelData(0);
  for (let i = 0; i < points; i++) {
    const a = pts[i], b = pts[(i + 1) % points];
    for (let j = 0; j < per; j++) { const k = (1 - Math.cos(Math.PI * j / per)) / 2; d[i * per + j] = a + (b - a) * k; }
  }
  return buf;
}

/** A shaped curve of `n` points from a function of x in 0..1. */
function curve(n: number, f: (x: number) => number): Float32Array {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = f(i / (n - 1));
  return c;
}

/** Click-free envelope: rises in `a`, falls to exactly 0 at the end. */
const env = (a: number) => (x: number) => x < a ? Math.sin((x / a) * Math.PI / 2) ** 2 : Math.cos(((x - a) / (1 - a)) * Math.PI / 2) ** 1.6;

// ---------------------------------------------------------------------------------------------- engine

export function createRoverEngine(ctx: BaseAudioContext, out: AudioNode, opts: { light: boolean }): RoverEngine {
  let nodes = 0;
  const gain = (v: number, to?: AudioNode) => { const n = ctx.createGain(); n.gain.value = v; if (to) n.connect(to); nodes++; return n; };
  const filt = (type: BiquadFilterType, f: number, q: number, to?: AudioNode) => {
    const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; if (to) n.connect(to); nodes++; return n;
  };
  const loop = (buf: AudioBuffer, rate = 1) => { const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true; n.playbackRate.value = rate; n.start(); nodes++; return n; };

  const pinkish = loopNoise(ctx, 5.3, 0.86, 71);
  const white = loopNoise(ctx, 7.7, 0.25, 1013);
  const wander = wanderBuffer(ctx, 61, 0.19, 4242);

  // --- buses. The body: what a microphone on the frame would pick up (band-limited, a little muffled).
  const body = filt('lowpass', 4200, 0.5);
  const bodyHp = filt('highpass', 60, 0.5);
  const comp = ctx.createDynamicsCompressor(); nodes++;
  comp.threshold.value = -24; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.012; comp.release.value = 0.3;
  body.connect(bodyHp); bodyHp.connect(comp); comp.connect(out);
  const driveBus = gain(1, body);
  const voiceBus = filt('lowpass', 6500, 0.4, out);
  const radioBus = filt('bandpass', 1600, 0.45, out); // the helmet radio: telephone-like band

  // --- the motor: one pitch (Hz) feeds every voice so they glide together
  const hz = ctx.createConstantSource(); hz.offset.value = 60; hz.start(); nodes++;
  const harm = new Float32Array(14), im = new Float32Array(14);
  for (let k = 1; k < 14; k++) im[k] = (k % 2 ? 1 : 0.55) / k ** 1.35; // warm, a little hollow; nothing above ~14x
  const motorWave = ctx.createPeriodicWave(harm, im);
  const motorF = filt('lowpass', 400, 0.6);
  const motorG = gain(0, driveBus);
  motorF.connect(motorG);
  const vib = ctx.createOscillator(); vib.frequency.value = 5.3; vib.start(); nodes++; // load wobble
  const vibG = gain(0);
  vib.connect(vibG);
  const wobble = loop(wander, 1.7); // slow random pitch drift (cents)
  const wobbleG = gain(6);
  wobble.connect(wobbleG);
  // the main voice, plus quieter ones a few cents off that drift on their own: a soft chorus whose beating
  // never settles into a regular throb (equal levels a fixed few cents apart throbbed about once a second, 6 dB deep)
  const voicesDef: Array<[number, number, number, number]> = opts.light
    ? [[1, 0, 0.8, 0], [1, 5, 0.1, 2.3]] : [[1, 0, 0.8, 0], [1, 5, 0.1, 2.3], [2, -3, 0.035, 3.7]];
  for (const [mult, cents, level, drift] of voicesDef) {
    const o = ctx.createOscillator(); nodes++;
    o.setPeriodicWave(motorWave); o.frequency.value = 0; o.detune.value = cents;
    if (mult === 1) hz.connect(o.frequency); else { const m = gain(mult); hz.connect(m); m.connect(o.frequency); }
    vibG.connect(o.detune); wobbleG.connect(o.detune);
    if (drift) { const w = loop(wander, drift); const wg = gain(7); w.connect(wg); wg.connect(o.detune); }
    o.connect(gain(level, motorF)); o.start();
  }
  // the gear whine: a pure tone a fixed ratio above the motor, thin and quiet, louder with speed
  const gear = ctx.createOscillator(); gear.frequency.value = 0; nodes++;
  const gearMul = gain(6.2); hz.connect(gearMul); gearMul.connect(gear.frequency);
  vibG.connect(gear.detune);
  const gearG = gain(0, driveBus);
  gear.connect(gearG); gear.start();

  // --- rolling on fine soil: continuous filtered noise, level and brightness follow speed
  const rollSrc = loop(pinkish, 1);
  const rollHp = filt('highpass', 110, 0.5);
  const rollLp = filt('lowpass', 500, 0.5);
  const rollAm = gain(1); // 1 +- small random variation
  const rollG = gain(0, driveBus);
  rollSrc.connect(rollHp); rollHp.connect(rollLp); rollLp.connect(rollAm); rollAm.connect(rollG);
  const rollWander = loop(wander, 3.1);
  const rollWG = gain(0.18);
  rollWander.connect(rollWG); rollWG.connect(rollAm.gain);
  // fine grit on top (full detail only): a little sparkle, its level wanders smoothly (no grains, no clicks)
  let gritG: GainNode | null = null, gritBp: BiquadFilterNode | null = null;
  if (!opts.light) {
    const gritSrc = loop(white, 1);
    gritBp = filt('bandpass', 2400, 0.9);
    const gritAm = gain(0.7);
    gritG = gain(0, driveBus);
    gritSrc.connect(gritBp); gritBp.connect(gritAm); gritAm.connect(gritG);
    const gw = loop(wander, 5.3); const gwG = gain(0.3); gw.connect(gwG); gwG.connect(gritAm.gain);
  }
  // a wheel slipping: a thin, brighter hiss
  const slipSrc = loop(white, 0.83);
  const slipBp = filt('bandpass', 1700, 1.4);
  const slipG = gain(0, driveBus);
  slipSrc.connect(slipBp); slipBp.connect(slipG);
  // the head servo: a small purr
  const servoO = ctx.createOscillator(); servoO.type = 'sawtooth'; servoO.frequency.value = 150; nodes++;
  const servoBp = filt('bandpass', 1100, 2.2);
  const servoG = gain(0, voiceBus);
  servoO.connect(servoBp); servoBp.connect(servoG); servoO.start();

  // --- the helmet bed: soft air hiss that slowly breathes
  const bedSrc = loop(white, 0.61);
  const bedHp = filt('highpass', 350, 0.5);
  const bedLp = filt('lowpass', 3200, 0.5);
  const bedAm = gain(1);
  const bedG = gain(0, out);
  bedSrc.connect(bedHp); bedHp.connect(bedLp); bedLp.connect(bedAm); bedAm.connect(bedG);
  const bedW = loop(wander, 0.23);
  const bedWG = gain(0.3);
  bedW.connect(bedWG); bedWG.connect(bedAm.gain);

  const set = (p: AudioParam, v: number, t: number, tau: number) => { p.cancelScheduledValues(t); p.setTargetAtTime(v, t, tau); };

  /** One short event: a source through an envelope (a curve that starts and ends at 0). */
  function shot(src: AudioScheduledSourceNode, to: AudioNode, t: number, dur: number, level: number, shape: (x: number) => number) {
    const a = ctx.createGain(); a.gain.value = 0;
    a.gain.setValueCurveAtTime(curve(96, x => level * shape(x)), t, dur);
    src.connect(a); a.connect(to);
    src.start(t); src.stop(t + dur + 0.02);
    src.onended = () => { src.disconnect(); a.disconnect(); };
  }

  // MOONDA's voice: a warm tone (fundamental, a soft second and third harmonic)
  const vr = new Float32Array([0, 0, 0, 0]), vi = new Float32Array([0, 1, 0.22, 0.07]);
  const voiceWave = ctx.createPeriodicWave(vr, vi);
  /** One sung note in MOONDA's own shape: glides from `from` up past `to`, overshoots by `over`, settles.
   *  wob = vibrato depth (ratio), wobHz its speed; fall = ratio the pitch sags to at the very end. */
  function note(t: number, dur: number, from: number, to: number, level: number, o: { over?: number; wob?: number; wobHz?: number; fall?: number; attack?: number } = {}) {
    const over = o.over ?? 1.06, wob = o.wob ?? 0, wobHz = o.wobHz ?? 9, fall = o.fall ?? 1;
    const osc = ctx.createOscillator(); osc.setPeriodicWave(voiceWave);
    osc.frequency.setValueCurveAtTime(curve(128, x => {
      const rise = 1 - Math.exp(-x * 9);                     // fast glide up...
      const bump = 1 + (over - 1) * Math.sin(Math.min(1, x / 0.45) * Math.PI); // ...a little past the note...
      const settle = from + (to - from) * rise;               // ...and settle
      const sag = 1 + (fall - 1) * Math.max(0, (x - 0.6) / 0.4) ** 2;
      return settle * bump * sag * (1 + wob * Math.sin(2 * Math.PI * wobHz * x * dur) * Math.min(1, x * 4));
    }), t, dur);
    shot(osc, voiceBus, t, dur, level, env(o.attack ?? 0.12));
  }
  function tick(t: number, f: number, level: number) {
    const osc = ctx.createOscillator(); osc.type = 'sine';
    osc.frequency.setValueAtTime(f, t); osc.frequency.exponentialRampToValueAtTime(f * 0.8, t + 0.03);
    shot(osc, voiceBus, t, 0.03, level, env(0.15));
  }
  function noiseShot(t: number, dur: number, f: number, q: number, level: number, shape: (x: number) => number, to: AudioNode, buf = white) {
    const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.loopStart = 0; s.loopEnd = buf.duration;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
    bp.connect(to);
    // start at a random place in the buffer so no two puffs are the same
    const s2 = s; s2.start(t, Math.random() * (buf.duration - dur - 0.1));
    const a = ctx.createGain(); a.gain.value = 0; a.gain.setValueCurveAtTime(curve(96, x => level * shape(x)), t, dur);
    s.connect(a); a.connect(bp); s.stop(t + dur + 0.02);
    s.onended = () => { s.disconnect(); a.disconnect(); bp.disconnect(); };
  }

  let bedOn = false, lastSp = 0;
  const eng: RoverEngine = {
    nodes: 0,
    bed(on, t) { bedOn = on; set(bedG.gain, on ? LEVEL.bed : 0, t, on ? 1.2 : 0.25); },
    drive(sp, push, turning, t) {
      const motor = Math.max(sp, turning * 0.5);
      const moving = motor > 0.004 || push > 0;
      const strain = push > 0 && motor < 0.15 ? 1 : 0;   // pushing but not going: the motors work hard
      set(hz.offset, 58 + 190 * motor + 14 * strain, t, 0.18);
      set(motorF.frequency, 380 + 1700 * motor + 300 * strain, t, 0.2);
      const lv = moving ? LEVEL.motor * (0.22 + 0.78 * Math.sqrt(motor)) * (0.8 + 0.2 * push) + LEVEL.motor * 0.2 * strain : 0;
      set(motorG.gain, lv, t, moving ? 0.1 : 0.3);
      set(vibG.gain, 4 + 10 * push * (1 - motor) + 14 * strain, t, 0.3); // cents of wobble
      set(gearG.gain, LEVEL.gear * motor ** 1.4, t, 0.2);
      const r = Math.min(1, sp * 1.4 + turning * 0.35);
      set(rollG.gain, LEVEL.roll * r ** 0.8, t, sp < lastSp ? 0.22 : 0.12);
      set(rollLp.frequency, 320 + 1500 * r, t, 0.2);
      if (gritG && gritBp) { set(gritG.gain, LEVEL.grit * r ** 1.3, t, 0.15); set(gritBp.frequency, 1800 + 1600 * r, t, 0.3); }
      lastSp = sp;
    },
    slip(amount, t) {
      const a = Math.max(0, Math.min(1, amount));
      set(slipG.gain, LEVEL.slip * a, t, 0.06);
      set(slipBp.frequency, 1400 + 1200 * a, t, 0.1);
    },
    servo(amount, t) {
      const a = Math.max(0, Math.min(1, amount));
      set(servoG.gain, LEVEL.servo * a, t, 0.04);
      set(servoO.frequency, 120 + 90 * a, t, 0.05);
    },
    impact(s, t) {
      const k = Math.max(0, Math.min(1, s));
      if (k < 0.03) return;
      // the body: a soft, low "tump" (pitch drops as the springs take it)
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.22);
      shot(o, driveBus, t, 0.26, LEVEL.impact * k ** 1.2, env(0.04));
      // a little spring wobble after it
      const sp = ctx.createOscillator(); sp.type = 'sine';
      sp.frequency.setValueCurveAtTime(curve(64, x => 210 * (1 + 0.04 * Math.sin(x * 40))), t + 0.02, 0.3);
      shot(sp, driveBus, t + 0.02, 0.3, LEVEL.impact * 0.12 * k, x => env(0.05)(x) * Math.exp(-x * 3));
      // the dust: a soft puff that settles
      noiseShot(t, 0.5 + 0.4 * k, 900, 0.6, LEVEL.dust * (0.4 + 0.6 * k), x => env(0.06)(x) * (1 - x * 0.5), driveBus, pinkish);
    },
    say(kind, t) {
      const v = LEVEL.voice;
      if (kind === 'wake') {          // curious rising two-note: "wu-ee? wu-EE?"
        note(t, 0.17, N.E5 * 0.9, N.A5, v * 0.8);
        note(t + 0.22, 0.26, N.Cs6 * 0.88, N.E6, v, { over: 1.09 });
      } else if (kind === 'start') {  // a happy little run up the scale, last one bounces
        const run = [N.A5, N.Cs6, N.E6];
        run.forEach((f, i) => note(t + i * 0.075, 0.08, f * 0.94, f, v * (0.65 + 0.1 * i), { over: 1.03, attack: 0.18 }));
        note(t + 0.24, 0.2, N.Fs6 * 0.9, N.A6, v * 0.85, { over: 1.06 });
      } else if (kind === 'blocked') { // a questioning wobble: "hm-m-m?" rising at the end
        note(t, 0.36, N.E5, N.Fs5, v * 0.85, { over: 1.02, wob: 0.035, wobHz: 11, fall: 1.12 });
      } else if (kind === 'sleep') {  // sleepy slide down, then a tiny low "mm"
        note(t, 0.9, N.A5, N.A5, v * 0.7, { over: 1.03, wob: 0.012, wobHz: 4, fall: 0.5, attack: 0.08 });
        note(t + 1.0, 0.3, N.E4 * 0.95, N.E4, v * 0.35, { over: 1.01, fall: 0.9 });
      } else if (kind === 'view') {   // soft double tick
        tick(t, 2600, LEVEL.tick); tick(t + 0.07, 3100, LEVEL.tick * 0.8);
      } else if (kind === 'lights') { // double tick, then a little rising "power on" hum
        tick(t, 3100, LEVEL.tick); tick(t + 0.07, 3600, LEVEL.tick * 0.8);
        note(t + 0.12, 0.28, N.A4 * 0.7, N.A4, v * 0.3, { over: 1.04, attack: 0.3 });
      }
    },
    radio(t) {
      if (!bedOn) return;
      const hold = 1.6 + Math.random() * 2.2;                 // the key-up: a short high tone...
      const beep = (at: number, f: number) => { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; shot(o, radioBus, at, 0.16, LEVEL.radio, env(0.1)); };
      beep(t, 2525);
      noiseShot(t + 0.12, hold, 1500, 0.5, LEVEL.static, x => env(0.08)(x) * (0.8 + 0.2 * Math.sin(x * 23)), radioBus); // ...faint static...
      beep(t + 0.2 + hold, 2475);                              // ...and a slightly lower closing tone
    },
    silence(t) {
      for (const p of [motorG.gain, gearG.gain, rollG.gain, slipG.gain, servoG.gain]) set(p, 0, t, 0.08);
      if (gritG) set(gritG.gain, 0, t, 0.08);
    },
  };
  eng.nodes = nodes;
  return eng;
}

/** The last stage: master level and a gentle limiter, so nothing ever clips. */
export function createMaster(ctx: BaseAudioContext): { input: GainNode; lim: DynamicsCompressorNode } {
  const input = ctx.createGain(); input.gain.value = 0;
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -9; lim.knee.value = 3; lim.ratio.value = 16; lim.attack.value = 0.002; lim.release.value = 0.12;
  input.connect(lim); lim.connect(ctx.destination);
  return { input, lim };
}
