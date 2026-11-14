// The arrival date and time, the way the user asked for it: TYPE it ("2008-07-01 14:30", "1 Jul 2008",
// "2040", "now", "+3d") or pick it, with month and year one click away instead of paging month by month.
// All times are UTC. Kept quiet: the reading line (what will be used, with the time in Cambodia) shows only
// while something is typed. It is only the inside of the box: the time bar shows it in a Popover.

import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { dayMin, monthLong, monthShort, useT } from '../i18n';
import { fmtCambodia, fmtUtc } from './format';
import { IconButton } from './kit';
import { ARRIVAL_MAX, ARRIVAL_MIN, parseDate } from './parseDate';

interface Props { value: number; onChange(ms: number): void }

const YEAR_MIN = 1900, YEAR_MAX = 2100, PAGE = 20;
const pad = (n: number) => String(n).padStart(2, '0');
const clamp = (ms: number) => Math.min(ARRIVAL_MAX, Math.max(ARRIVAL_MIN, ms));
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Digits typed into a two-digit box: "014" → 14, "235" → 5 (when 35 is too big). */
function twoDigits(raw: string, max: number): number | null {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  const two = Number(digits.slice(-2));
  return two <= max ? two : Number(digits.slice(-1));
}

export function DateTimePicker({ value, onChange }: Props) {
  const t = useT();
  const d = new Date(value);
  const Y = d.getUTCFullYear(), M = d.getUTCMonth(), D = d.getUTCDate(), h = d.getUTCHours(), mi = d.getUTCMinutes();
  const [text, setText] = useState('');
  const [view, setView] = useState<'days' | 'months' | 'years'>('days');
  const [page, setPage] = useState({ y: Y, m: M });
  useEffect(() => { setPage({ y: Y, m: M }); }, [Y, M]); // the calendar follows the value

  const typed = text.trim() ? parseDate(text, value) : null;
  const apply = (ms: number) => onChange(clamp(ms));
  const at = (y: number, m: number, day: number) => apply(Date.UTC(y, m, Math.min(day, daysIn(y, m)), h, mi));
  const submit = () => { if (typed && 'ms' in typed) { apply(typed.ms); setText(''); setView('days'); } };

  const now = new Date();
  const todayY = now.getUTCFullYear(), todayM = now.getUTCMonth(), todayD = now.getUTCDate();
  const first = Date.UTC(page.y, page.m, 1);
  const startDow = new Date(first).getUTCDay();
  const cells = Array.from({ length: 42 }, (_, i) => first + (i - startDow) * 86400000);
  const shiftMonth = (k: number) => setPage(v => {
    const m = v.m + k, y = v.y + Math.floor(m / 12);
    return y < YEAR_MIN || y > YEAR_MAX ? v : { y, m: ((m % 12) + 12) % 12 };
  });
  const pageStart = YEAR_MIN + Math.floor((page.y - YEAR_MIN) / PAGE) * PAGE;
  const years = Array.from({ length: PAGE }, (_, i) => pageStart + i).filter(y => y <= YEAR_MAX);

  return (
    <>
      <div className={`dtp-field${typed && 'error' in typed ? ' bad' : ''}`}>
        <input data-autofocus value={text} placeholder={t('dtp.placeholder')} aria-label={t('dtp.input')} spellCheck={false} autoComplete="off"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } e.stopPropagation(); if (e.key === 'Escape' && text) { e.preventDefault(); setText(''); } }} />
        {typed && 'ms' in typed && <kbd>{t('dtp.enter')}</kbd>}
      </div>
      {typed !== null && (
        <div className={`dtp-read${'error' in typed ? ' bad' : ''}`} aria-live="polite">
          {'ms' in typed ? <><b>{fmtUtc(typed.ms)}</b><br />{fmtCambodia(typed.ms)} · {t('dtp.means')}</>
            : t(typed.error === 'range' ? 'dtp.range' : 'dtp.bad')}
        </div>
      )}

      <div className="dtp-head">
        {view === 'days' && <IconButton label={t('dtp.prevMonth')} size="md" onClick={() => shiftMonth(-1)}><CaretLeft size={16} /></IconButton>}
        {view === 'years' && <IconButton label={t('dtp.prevYears')} size="md" disabled={pageStart <= YEAR_MIN} onClick={() => setPage(v => ({ ...v, y: Math.max(YEAR_MIN, pageStart - PAGE) }))}><CaretLeft size={16} /></IconButton>}
        <span className="dtp-gap" />
        {view !== 'years' && (
          <button type="button" className="dtp-jump" aria-expanded={view === 'months'} aria-label={t('dtp.pickMonth')} onClick={() => setView(v => (v === 'months' ? 'days' : 'months'))}>
            {monthLong(page.m)}
          </button>
        )}
        <button type="button" className="dtp-jump" aria-expanded={view === 'years'} aria-label={t('dtp.pickYear')} onClick={() => setView(v => (v === 'years' ? 'days' : 'years'))}>
          {view === 'years' ? `${years[0]} – ${years[years.length - 1]}` : page.y}
        </button>
        <span className="dtp-gap" />
        {view === 'days' && <IconButton label={t('dtp.nextMonth')} size="md" onClick={() => shiftMonth(1)}><CaretRight size={16} /></IconButton>}
        {view === 'years' && <IconButton label={t('dtp.nextYears')} size="md" disabled={pageStart + PAGE > YEAR_MAX} onClick={() => setPage(v => ({ ...v, y: Math.min(YEAR_MAX, pageStart + PAGE) }))}><CaretRight size={16} /></IconButton>}
      </div>

      {view === 'days' && (
        <div className="dtp-days">
          {[0, 1, 2, 3, 4, 5, 6].map(i => <div key={i} className="dow">{dayMin(i)}</div>)}
          {cells.map(ms => {
            const c = new Date(ms), cy = c.getUTCFullYear(), cm = c.getUTCMonth(), cd = c.getUTCDate();
            if (cy < YEAR_MIN || cy > YEAR_MAX) return <span key={ms} />;
            const sel = cy === Y && cm === M && cd === D;
            return (
              <button key={ms} type="button" aria-pressed={sel} aria-label={`${cd} ${monthLong(cm)} ${cy}`}
                className={`${cm !== page.m ? 'other' : ''}${cy === todayY && cm === todayM && cd === todayD ? ' today' : ''}`}
                onClick={() => apply(ms + h * 3600000 + mi * 60000)}>{cd}</button>
            );
          })}
        </div>
      )}
      {view === 'months' && (
        <div className="dtp-grid">
          {Array.from({ length: 12 }, (_, m) => (
            <button key={m} type="button" aria-pressed={m === M && page.y === Y} className={m === todayM && page.y === todayY ? 'today' : ''}
              onClick={() => { at(page.y, m, D); setPage(v => ({ ...v, m })); setView('days'); }}>{monthShort(m)}</button>
          ))}
        </div>
      )}
      {view === 'years' && (
        <div className="dtp-grid">
          {years.map(y => (
            <button key={y} type="button" aria-pressed={y === Y} className={y === todayY ? 'today' : ''}
              onClick={() => { at(y, page.m, D); setPage(v => ({ ...v, y })); setView('days'); }}>{y}</button>
          ))}
        </div>
      )}

      <div className="dtp-time">
        <span>{t('dtp.time')}</span>
        <input inputMode="numeric" aria-label={t('dtp.hour')} value={pad(h)} onFocus={e => e.target.select()} onKeyDown={e => e.stopPropagation()}
          onChange={e => { const n = twoDigits(e.target.value, 23); if (n !== null) apply(Date.UTC(Y, M, D, n, mi)); }} />
        <i>:</i>
        <input inputMode="numeric" aria-label={t('dtp.minute')} value={pad(mi)} onFocus={e => e.target.select()} onKeyDown={e => e.stopPropagation()}
          onChange={e => { const n = twoDigits(e.target.value, 59); if (n !== null) apply(Date.UTC(Y, M, D, h, n)); }} />
        <span className="dtp-gap" />
        <button type="button" className="dtp-now" onClick={() => apply(Math.floor(Date.now() / 3600000) * 3600000)} data-tip={t('dtp.nowTip')}>{t('dtp.now')}</button>
      </div>
    </>
  );
}
