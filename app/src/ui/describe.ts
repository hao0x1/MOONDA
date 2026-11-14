// Plain-language descriptions of where the Sun and Earth are, for people who don't think in degrees.

import { t } from '../i18n';

export interface BodyNow { el: number; sky: number; part: number }

/** `title` = the verdict in two or three words, `short` = the reason in a few words, `text` = a full sentence. */
export interface BodyWords { title: string; short: string; text: string; on: boolean }

export function describeSun(s: BodyNow | null): BodyWords {
  if (!s) return { title: t('body.working'), short: '', text: '', on: false };
  if (s.part >= 0.999) {
    const low = s.el - s.sky < 2;
    return { title: t('sun.lit'), short: t(low ? 'sun.lit.low' : 'sun.lit.clear'), text: t(low ? 'sun.lit.low.text' : 'sun.lit.clear.text'), on: true };
  }
  const pct = Math.round(s.part * 100);
  if (s.part > 0) return { title: t('sun.partly'), short: t('sun.partly.why', { pct }), text: t('sun.partly.text', { pct }), on: true };
  if (s.el > 0) return { title: t('sun.shadow'), short: t('sun.shadow.why'), text: t('sun.shadow.text'), on: false };
  return { title: t('sun.night'), short: t('sun.night.why'), text: t('sun.night.text'), on: false };
}

export function describeEarth(e: BodyNow | null, neverRises: boolean): BodyWords {
  if (!e) return { title: t('body.working'), short: '', text: '', on: false };
  if (e.el > e.sky) return { title: t('earth.view'), short: t('earth.view.why'), text: t('earth.view.text'), on: true };
  if (neverRises) return { title: t('earth.never'), short: t('earth.never.why'), text: t('earth.never.text'), on: false };
  if (e.el > 0) return { title: t('earth.hidden'), short: t('earth.hidden.why'), text: t('earth.hidden.text'), on: false };
  return { title: t('earth.down'), short: t('earth.down.why'), text: t('earth.down.text'), on: false };
}

const COMPASS = ['compass.n', 'compass.ne', 'compass.e', 'compass.se', 'compass.s', 'compass.sw', 'compass.w', 'compass.nw'] as const;

export function compassName(az: number): string {
  return t(COMPASS[Math.round((((az % 360) + 360) % 360) / 45) % 8]);
}
