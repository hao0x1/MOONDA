// Turn what someone typed into a moment in time (UTC), forgivingly:
//   2008-07-01 14:30 · 2008-07-01 · 1 Jul 2008 · July 1 2008 14:30 · 1/7/2008 (day first) · jul 2008
//   2040 (same day and time, that year) · 14:30 (same day, that time) · now · +3d · -12h · +1w
// Anything else, or a date outside 1900–2100, is refused: the caller shows a hint and changes nothing.

export const ARRIVAL_MIN = Date.UTC(1900, 0, 1);
export const ARRIVAL_MAX = Date.UTC(2100, 11, 31, 23, 59);

export type Parsed = { ms: number } | { error: 'format' | 'range' };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const month = (word: string) => MONTHS.indexOf(word.slice(0, 3));
const STEP: Record<string, number> = { m: 60000, min: 60000, h: 3600000, hr: 3600000, hour: 3600000, hours: 3600000, d: 86400000, day: 86400000, days: 86400000, w: 604800000, week: 604800000, weeks: 604800000 };

function check(ms: number): Parsed {
  if (!Number.isFinite(ms)) return { error: 'format' };
  if (ms < ARRIVAL_MIN || ms > ARRIVAL_MAX) return { error: 'range' };
  return { ms: Math.round(ms / 60000) * 60000 };
}

/** `base` is the current value: relative entries ("+3d") and missing parts (a year alone, a time alone) start from it. */
export function parseDate(input: string, base: number): Parsed {
  let s = input.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').replace(/ ?(utc|z)$/, '').replace(/(\d)t(\d)/, '$1 $2');
  if (!s) return { error: 'format' };
  if (s === 'now') return check(Date.now());

  const rel = s.match(/^([+\-−]) ?(\d+(?:\.\d+)?) ?([a-z]+)$/);
  if (rel) {
    const unit = STEP[rel[3]];
    return unit ? check(base + (rel[1] === '+' ? 1 : -1) * Number(rel[2]) * unit) : { error: 'format' };
  }

  const b = new Date(base);
  let Y = b.getUTCFullYear(), Mo = b.getUTCMonth(), D = b.getUTCDate(), h = b.getUTCHours(), mi = b.getUTCMinutes();
  let clampDay = false; // a year or a month alone: keep the day, but never roll past the end of the month

  const time = s.match(/(?:^| )(\d{1,2})[:.h](\d{2})(?::\d{2})?$/);
  if (time) {
    h = Number(time[1]); mi = Number(time[2]);
    if (h > 23 || mi > 59) return { error: 'format' };
    s = s.slice(0, time.index).trim();
  }
  if (s) {
    let r: RegExpMatchArray | null;
    if ((r = s.match(/^(\d{4})$/))) { Y = Number(r[1]); clampDay = true; }
    else if ((r = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?$/))) { Y = Number(r[1]); Mo = Number(r[2]) - 1; D = r[3] ? Number(r[3]) : 1; }
    else if ((r = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) { D = Number(r[1]); Mo = Number(r[2]) - 1; Y = Number(r[3]); }
    else if ((r = s.match(/^([a-z]{3,9})\.? (\d{4})$/))) { Mo = month(r[1]); Y = Number(r[2]); D = 1; }
    else if ((r = s.match(/^(\d{1,2})(?:st|nd|rd|th)? ?([a-z]{3,9})\.?(?: (\d{4}))?$/))) { D = Number(r[1]); Mo = month(r[2]); if (r[3]) Y = Number(r[3]); }
    else if ((r = s.match(/^([a-z]{3,9})\.? ?(\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/))) { Mo = month(r[1]); D = Number(r[2]); if (r[3]) Y = Number(r[3]); }
    else return { error: 'format' };
  }
  if (Mo < 0 || Mo > 11 || D < 1 || D > 31) return { error: 'format' };
  const last = new Date(Date.UTC(Y, Mo + 1, 0)).getUTCDate();
  if (D > last) { if (clampDay) D = last; else return { error: 'format' }; }
  return check(Date.UTC(Y, Mo, D, h, mi));
}
