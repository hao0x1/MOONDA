// Quiet background music: one calm ambient piece on a loop, well under the level of a voice.
// Browsers only allow sound after the person has clicked or pressed a key, so it starts with the
// first gesture (any click or key on the start screen) and fades in slowly. It is set up right after the
// start screen's video (src/main.tsx), so it loads before the Moon data. The speaker
// button in the top bar turns it off and on; the choice is remembered (app/settings.ts).
// Track: "Cylinder Five" by Chris Zabriskie, CC BY 4.0 (see public/audio/CREDITS.md).

import { settings } from '../app/settings';
import { roverAudio } from './rover';

const SRC = `${import.meta.env.BASE_URL}audio/cylinder-five.m4a`;
const LEVEL = 0.34;        // loudness at volume setting 0.5 (the default): background, not foreground
const FADE_IN_MS = 3500, FADE_OUT_MS = 700;

let el: HTMLAudioElement | null = null;
let unlocked = false;
let raf = 0;
let duck = 1; // the rover asks the music to step back a little while it is driving

function player(): HTMLAudioElement {
  if (!el) {
    el = new Audio();
    el.src = SRC;
    el.loop = true;
    el.preload = 'auto';
    el.volume = 0;
  }
  return el;
}

function fadeTo(target: number, ms: number, then?: () => void) {
  const a = player();
  cancelAnimationFrame(raf);
  const from = a.volume, t0 = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / ms);
    a.volume = Math.max(0, Math.min(1, from + (target - from) * k * k * (3 - 2 * k)));
    if (k < 1) raf = requestAnimationFrame(step); else then?.();
  };
  raf = requestAnimationFrame(step);
}

function apply() {
  if (!unlocked) return;
  const s = settings.get();
  const a = player();
  const want = s.sound && !document.hidden ? Math.min(1, LEVEL * (s.volume / 0.5)) * duck : 0;
  if (want > 0) {
    if (a.paused) void a.play().catch(() => { /* the browser still says no: the next gesture tries again */ unlocked = false; });
    fadeTo(want, FADE_IN_MS);
  } else if (!a.paused) {
    fadeTo(0, FADE_OUT_MS, () => a.pause());
  }
}

/** Fetch the track early (during start-up loading) so it can start the moment the person enters. */
export function prefetchMusic(): Promise<void> {
  if (!settings.get().sound) return Promise.resolve();
  return fetch(SRC).then(r => r.arrayBuffer()).then(() => undefined, () => undefined);
}

// for tests (scripts/drive.mjs): is it playing, how loud
(window as unknown as { __moondaMusic?: () => unknown }).__moondaMusic = () => el && { paused: el.paused, volume: +el.volume.toFixed(2), ready: el.readyState };

/** Call once. Returns the function that removes everything again. */
export function installMusic(): () => void {
  const unlock = () => { if (!unlocked) { unlocked = true; apply(); } };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  document.addEventListener('visibilitychange', apply);
  // Some browsers allow sound straight away (Chrome does for sites the person often plays sound on): try now.
  if (settings.get().sound) {
    const a = player();
    a.volume = 0;
    void a.play().then(() => { if (!unlocked) { unlocked = true; apply(); } }, () => { /* needs a click first */ });
  } else player();
  const off = settings.subscribe((s, prev) => { if (s.sound !== prev.sound || s.volume !== prev.volume) apply(); });
  const offDuck = roverAudio.onDuck(k => { duck = k; apply(); });
  return () => {
    off();
    offDuck();
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
    document.removeEventListener('visibilitychange', apply);
    cancelAnimationFrame(raf);
    el?.pause();
  };
}
