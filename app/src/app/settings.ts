// What the person chose on the start screen and in the top bar, remembered between visits:
// graphics mode, sound, language. One tiny store; React parts use settings.use(), everything
// else reads settings.get() or listens with settings.subscribe().

import { useSyncExternalStore } from 'react';

/** 'full' = everything at its best (default on a capable computer); 'light' = lighter on the graphics card. */
export type Quality = 'full' | 'light';
export type Lang = 'en' | 'km';

export interface Settings {
  quality: Quality;
  /** false until the person picks a graphics mode themselves (until then the app may auto-pick). */
  qualityChosen: boolean;
  /** background music wanted (it only starts after the first click, browsers require that) */
  sound: boolean;
  /** 0…1 */
  volume: number;
  lang: Lang;
}

const KEY = 'moonda.settings.v1';
const DEFAULTS: Settings = { quality: 'full', qualityChosen: false, sound: true, volume: 0.5, lang: 'en' };

function read(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Settings> | null;
    if (raw && typeof raw === 'object') {
      return {
        quality: raw.quality === 'light' ? 'light' : 'full',
        qualityChosen: raw.qualityChosen === true,
        // music on by default: a choice saved before 13 Nov 2026 (no soundV) is reset to on once
        sound: (raw as { soundV?: number }).soundV === 2 ? raw.sound !== false : true,
        volume: typeof raw.volume === 'number' && raw.volume >= 0 && raw.volume <= 1 ? raw.volume : DEFAULTS.volume,
        lang: raw.lang === 'km' ? 'km' : 'en',
      };
    }
  } catch { /* private mode or broken value: use the defaults */ }
  return { ...DEFAULTS };
}

let current: Settings = read();
const listeners = new Set<(s: Settings, prev: Settings) => void>();

export const settings = {
  get(): Settings { return current; },
  set(patch: Partial<Settings>): void {
    const prev = current;
    const next = { ...current, ...patch };
    if ((Object.keys(next) as (keyof Settings)[]).every(k => next[k] === prev[k])) return;
    current = next;
    try { localStorage.setItem(KEY, JSON.stringify({ ...current, soundV: 2 })); } catch { /* private mode */ }
    listeners.forEach(l => l(current, prev));
  },
  /** Called with the new and the previous settings after every change. Returns the function that stops listening. */
  subscribe(fn: (s: Settings, prev: Settings) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
  use(): Settings { return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => current); },
};
