// Dates, durations and distances as text. Month and day names come from the language tables
// (the browser's own date formatting has no Khmer on some computers).

import { dayShort, monthShort, t, tn } from '../i18n';

const pad = (n: number) => String(n).padStart(2, '0');

export const CAMBODIA_OFFSET_H = 7;

/** "Wed 18 Nov 2026, 02:00 UTC" */
export function fmtUtc(ms: number, withDay = true): string {
  const d = new Date(ms);
  return `${withDay ? dayShort(d.getUTCDay()) + ' ' : ''}${d.getUTCDate()} ${monthShort(d.getUTCMonth())} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "Wed 18 Nov 2026" */
export function fmtWeekday(ms: number): string {
  const d = new Date(ms);
  return `${dayShort(d.getUTCDay())} ${d.getUTCDate()} ${monthShort(d.getUTCMonth())} ${d.getUTCFullYear()}`;
}

/** "18 Nov, 02:00 UTC" */
export function fmtUtcShort(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${monthShort(d.getUTCMonth())}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "18 Nov, 09:00 in Cambodia" */
export function fmtCambodia(ms: number): string {
  const d = new Date(ms + CAMBODIA_OFFSET_H * 3600000);
  return t('time.inCambodia', { time: `${d.getUTCDate()} ${monthShort(d.getUTCMonth())}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` });
}

export function fmtDateShort(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${monthShort(d.getUTCMonth())} ${d.getUTCFullYear()} · ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** A length of time split into the number and its unit, so the number can be set large: { n: "19", unit: "h" }. */
export function durationParts(hours: number): { n: string; unit: string } {
  if (hours < 1) return { n: String(Math.round(hours * 60)), unit: t('unit.min') };
  if (hours < 48) return { n: String(Math.round(hours)), unit: t('unit.h') };
  const d = hours / 24, n = d < 10 ? d.toFixed(1) : String(Math.round(d));
  return { n, unit: tn('unit.day', Number(n)) };
}

/** "45 min", "19 h", "2.3 days" */
export function fmtDuration(hours: number): string {
  const p = durationParts(hours);
  return `${p.n} ${p.unit}`;
}

/** "02:00 UTC" */
export function fmtClockUtc(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "18 Nov 2026" */
export function fmtDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${monthShort(d.getUTCMonth())} ${d.getUTCFullYear()}`;
}

/** A distance in plain form: "850 m", "12 km", "1,250 km". */
export function fmtKm(km: number): string {
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString('en-US')} km`;
}

/** A signed whole number with a real minus sign: "−53", "+4". */
export function fmtSigned(n: number, plus = false): string {
  const r = Math.round(n);
  return `${r < 0 ? '−' : plus && r > 0 ? '+' : ''}${Math.abs(r)}`;
}
