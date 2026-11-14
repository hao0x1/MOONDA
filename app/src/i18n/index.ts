// Words on screen, in English and Khmer.
//
//   import { t, tn, useT } from '../i18n';
//   t('place.standHere')                         → "Stand here" / "ឈរនៅទីនេះ"
//   t('time.dayOf', { day: '5.1', days: 14 })    → "day 5.1 of 14"      ({name} is replaced)
//   tn('unit.hour', 3)                           → "3 hours"            (looks up unit.hour.one / unit.hour.other, {n} is the number)
//
// React components call `const t = useT()` once at the top so they redraw when the language changes.
// Code outside React (map overlays, the AI tools) imports `t` directly and, if it keeps text on
// screen, listens with onLangChange().
//
// English text lives in src/i18n/en/<area>.ts, one file per part of the app. Khmer lives in
// src/i18n/km/<area>.ts with the same keys; a key missing in Khmer falls back to English, so the
// app never shows a blank. Official Moon names (IAU) are never translated.

import { useSyncExternalStore } from 'react';
import { settings, type Lang } from '../app/settings';
import { en } from './en';
import { km } from './km';

export type { Lang };
export type Key = keyof typeof en;
export type Vars = Record<string, string | number>;

const TABLES: Record<Lang, Partial<Record<string, string>>> = { en, km };

export function getLang(): Lang { return settings.get().lang; }
export function setLang(lang: Lang): void { settings.set({ lang }); }

function fill(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** The text for a key in the current language (English if Khmer has none; the key itself if nothing is found). */
export function t(key: Key, vars?: Vars): string {
  const lang = getLang();
  const text = TABLES[lang][key] ?? (en as Record<string, string>)[key] ?? key;
  return fill(text, vars);
}

/** Like t(), for a key that may not be in the typed list (built at run time, e.g. `layer.${id}.title`). Returns `fallback` when missing. */
export function tMaybe(key: string, fallback: string, vars?: Vars): string {
  const lang = getLang();
  const text = TABLES[lang][key] ?? (lang !== 'en' ? (en as Record<string, string>)[key] : undefined);
  return text === undefined ? fill(fallback, vars) : fill(text, vars);
}

/**
 * A counted phrase: tn('unit.day', 2) uses "unit.day.one" when n is exactly 1, otherwise "unit.day.other".
 * {n} in the text is the number (pass `shown` to print it differently, e.g. "2.5"). Khmer has no plural:
 * it only needs the ".other" form.
 */
export function tn(base: string, n: number, vars?: Vars & { shown?: string | number }): string {
  const lang = getLang();
  const table = TABLES[lang], eng = en as Record<string, string>;
  const one = `${base}.one`, other = `${base}.other`;
  const text = (n === 1 ? table[one] : undefined) ?? table[other] ?? (n === 1 ? eng[one] : undefined) ?? eng[other] ?? base;
  return fill(text, { ...vars, n: vars?.shown ?? n });
}

/** Run `fn` whenever the language changes. Returns the function that stops listening. */
export function onLangChange(fn: (lang: Lang) => void): () => void {
  return settings.subscribe((s, prev) => { if (s.lang !== prev.lang) fn(s.lang); });
}

/** The current language, as a React value (the component redraws when it changes). */
export function useLang(): Lang { return useSyncExternalStore(l => settings.subscribe(l), () => settings.get().lang); }

/** `const t = useT()` — same as importing t, but the component redraws when the language changes. */
export function useT(): typeof t { useLang(); return t; }

/** Keep <html lang> and the "lang-km" class in step, so CSS can switch to the Khmer font and line height. */
export function installLang(): () => void {
  const apply = (lang: Lang) => {
    document.documentElement.lang = lang;
    document.documentElement.classList.toggle('lang-km', lang === 'km');
  };
  apply(getLang());
  return onLangChange(apply);
}

// ---------- dates and numbers ----------

const MONTHS_SHORT: Record<Lang, string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  km: ['មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា', 'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'],
};
const MONTHS_LONG: Record<Lang, string[]> = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  km: MONTHS_SHORT.km,
};
const DAYS_SHORT: Record<Lang, string[]> = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  km: ['អាទិត្យ', 'ចន្ទ', 'អង្គារ', 'ពុធ', 'ព្រហស្បតិ៍', 'សុក្រ', 'សៅរ៍'],
};
const DAYS_MIN: Record<Lang, string[]> = {
  en: ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
  km: ['អា', 'ច', 'អ', 'ព', 'ព្រ', 'សុ', 'ស'],
};

export const monthShort = (m: number) => MONTHS_SHORT[getLang()][m];
export const monthLong = (m: number) => MONTHS_LONG[getLang()][m];
export const dayShort = (d: number) => DAYS_SHORT[getLang()][d];
export const dayMin = (d: number) => DAYS_MIN[getLang()][d];

/** 1,250 — the same digits in both languages (Cambodian science and tech writing uses them too). */
export const num = (n: number, digits = 0) => n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
