// Bottom time area, no box: over a soft dark shade, three groups on one baseline.
//   left   — three quiet menus: arrival date, mission length, play speed
//   centre — "Time since landing (days)": play, a ruler with day numbers and a draggable cursor; with a spot
//            selected, two hairlines on top show when it sees the Sun (warm) and Earth (blue)
//   right  — the big clock: the projected time in UTC, the date, and Cambodia time + mission day

import { CaretDown, Pause, Play } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { monthShort, useT } from '../i18n';
import { runs, type SpotTimeline } from '../science/analysis';
import { DateTimePicker } from './DateTimePicker';
import { fmtCambodia, fmtClockUtc, fmtDay, fmtUtc } from './format';
import { MenuButton, Popover } from './kit';

interface Props {
  arrival: number;
  days: number;
  cursor: number;
  playing: boolean;
  speed: number;
  timeline: SpotTimeline | null;
  loading: boolean;
  spotLabel: string | null;
  onArrival(ms: number): void;
  onDays(d: number): void;
  onCursor(ms: number): void;
  onPlaying(p: boolean): void;
  onSpeed(s: number): void;
}

export function Tracks({ timeline, from = 0, to }: { timeline: SpotTimeline; from?: number; to?: number }) {
  const end = to ?? timeline.count;
  const n = end - from;
  const bars = (test: (i: number) => boolean) => runs(test, from, end).map(([a, b]) => (
    <i key={a} style={{ left: `${((a - from) / n) * 100}%`, width: `${((b - a) / n) * 100}%` }} />
  ));
  return (
    <>
      <div className="track-row sun">{bars(i => timeline.sunEl[i] > timeline.sunSky[i])}</div>
      <div className="track-row earth">{bars(i => timeline.earthEl[i] > timeline.earthSky[i])}</div>
    </>
  );
}

const DAY_CHOICES = [3, 7, 14, 30];
const SPEED_CHOICES = [1, 6, 24] as const;
const SPEED_NOTE = { 1: 'tb.slow', 6: 'tb.normal', 24: 'tb.fast' } as const;

/** "1 Dec, 2026" */
function fmtDayComma(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${monthShort(d.getUTCMonth())}, ${d.getUTCFullYear()}`;
}

/** Fine ticks: more per day for short missions, fewer for long ones. */
const ticksPerDay = (days: number) => (days <= 7 ? 8 : days <= 14 ? 4 : 2);

export function TimeBar(p: Props) {
  const t = useT();
  const [calOpen, setCalOpen] = useState(false);
  const [trackW, setTrackW] = useState(0);
  const dateBtn = useRef<HTMLButtonElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const menus = useRef<HTMLDivElement>(null);
  const mid = useRef<HTMLDivElement>(null);
  const clock = useRef<HTMLDivElement>(null);
  // Tell the rest of the layout where the time area starts, so nothing hides behind it:
  //   --dock   = window bottom → top of the menus on the left (the info card ends above it)
  //   --dock-r = window bottom → top of the clock on the right (right-hand panels end above it)
  //   --tb     = what the lander view's bottom-left / centre controls expect: top of menus + ruler, − 16 px
  //   --tb-r   = the same for its bottom-right controls: top of the clock − 16 px
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const h = window.innerHeight;
      const top = (el: HTMLElement | null) => (el ? Math.round(h - el.getBoundingClientRect().top) : 0);
      const dock = top(menus.current);
      const left = Math.max(dock, top(mid.current));
      const right = top(clock.current);
      root.style.setProperty('--dock', `${dock}px`);
      root.style.setProperty('--dock-r', `${right}px`);
      root.style.setProperty('--tb', `${left - 16}px`);
      root.style.setProperty('--tb-r', `${right - 16}px`);
    };
    apply();
    const ro = new ResizeObserver(() => { apply(); setTrackW(track.current?.clientWidth ?? 0); });
    for (const el of [bar.current, menus.current, mid.current, clock.current, track.current]) if (el) ro.observe(el);
    window.addEventListener('resize', apply);
    return () => { ro.disconnect(); window.removeEventListener('resize', apply); };
  }, []);
  const span = p.days * 86400000;
  const frac = Math.min(1, Math.max(0, (p.cursor - p.arrival) / span));

  const scrub = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    p.onCursor(p.arrival + Math.round((f * span) / 600000) * 600000);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 86400000 : 3600000;
    // stopPropagation: the map also listens for arrow keys (to pan); here they belong to the time slider
    if (e.key === 'ArrowRight') { p.onCursor(Math.min(p.arrival + span, p.cursor + step)); e.preventDefault(); e.stopPropagation(); }
    if (e.key === 'ArrowLeft') { p.onCursor(Math.max(p.arrival, p.cursor - step)); e.preventDefault(); e.stopPropagation(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.stopPropagation();
    if (e.key === ' ') { p.onPlaying(!p.playing); e.preventDefault(); }
  };
  const elapsedDays = (p.cursor - p.arrival) / 86400000;
  // Day numbers under the ruler: as many as fit (at least 28 px apart), always 0, the last day when there is room.
  const perDay = (trackW || 480) / p.days;
  const labelStep = [1, 2, 5, 10, 15].find(n => perDay * n >= 28) ?? p.days;
  const dayLabels: number[] = [];
  for (let d = 0; d <= p.days; d += labelStep) dayLabels.push(d);
  if (dayLabels[dayLabels.length - 1] !== p.days) {
    if ((p.days - dayLabels[dayLabels.length - 1]) * perDay < 24) dayLabels.pop();
    dayLabels.push(p.days);
  }
  const tpd = ticksPerDay(p.days);
  const nTicks = p.days * tpd;
  const ticks: { x: number; major: boolean }[] = [];
  for (let i = 0; i <= nTicks; i++) ticks.push({ x: (i / nTicks) * 100, major: i % tpd === 0 });
  const atEnd = p.cursor >= p.arrival + span;

  const dayOptions = DAY_CHOICES.map(d => ({ value: d, label: t('tb.days', { n: d }) }));
  const speedOptions = SPEED_CHOICES.map(s => ({ value: s as number, label: t(`tb.speed.${s}`), note: t(SPEED_NOTE[s]) }));
  const speedShort = p.speed === 1 || p.speed === 6 || p.speed === 24 ? t(`tb.speed.${p.speed}.short`) : `${p.speed} h / sec`;
  const tl = p.timeline;

  return (
    <>
      <div className="tb-shade" aria-hidden="true" />
      <div ref={bar} className="timebar" role="region" aria-label={t('tb.region')}>
        <div ref={menus} className="tbar-menus">
          <button ref={dateBtn} type="button" className="mbtn" aria-haspopup="dialog" aria-expanded={calOpen} onClick={() => setCalOpen(o => !o)}>
            <span className="mbtn-cap">{t('tb.arrives')}</span>
            <span className="mbtn-val">{fmtDay(p.arrival)} • {fmtClockUtc(p.arrival)}</span>
            <CaretDown className="mbtn-caret" size={11} weight="bold" aria-hidden="true" />
          </button>
          <MenuButton caption={t('tb.length')} text={t('tb.days', { n: p.days })} options={dayOptions} value={p.days} onChange={p.onDays}
            help={t('tb.length.help')} placement="top-start" />
          <MenuButton caption={t('tb.speed')} text={speedShort} options={speedOptions} value={p.speed} onChange={p.onSpeed}
            help={t('tb.speed.help')} placement="top-start" />
        </div>

        <div ref={mid} className="tbar-mid">
          <div className="tbar-cap">{t('tb.since')} <span>{t('tb.sinceUnit')}</span></div>
          <div className="tbar-row">
            <button type="button" className="tbar-play" aria-label={p.playing ? t('tb.pause') : t('tb.play')} data-tip={p.playing ? t('tb.pause') : t('tb.playTip')}
              onClick={() => { if (!p.playing && atEnd) p.onCursor(p.arrival); p.onPlaying(!p.playing); }}>
              {p.playing ? <Pause size={11} weight="fill" /> : <Play size={11} weight="fill" />}
            </button>
            <div className={`ruler${tl ? ' has-tl' : ''}${p.loading ? ' is-loading' : ''}`}>
              {tl && (
                <div className="ruler-keys" aria-hidden="true">
                  <span className="k-sun" data-tip={t('tb.sunTip')}>{t('tb.sun')}</span>
                  <span className="k-earth" data-tip={t('tb.earthTip')}>{t('tb.earth')}</span>
                </div>
              )}
              <div ref={track} className="track" tabIndex={0} role="slider" aria-label={t('tb.slider')} aria-valuemin={0} aria-valuemax={p.days * 24}
                aria-valuenow={Math.round(elapsedDays * 24)} aria-valuetext={fmtUtc(p.cursor)} onKeyDown={onKey}
                aria-busy={p.loading || undefined}
                onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); p.onPlaying(false); scrub(e.clientX); }}
                onPointerMove={e => { if (e.buttons === 1) scrub(e.clientX); }}>
                {(tl || p.loading) && <div className="ruler-lines">{tl && <Tracks timeline={tl} />}</div>}
                <svg className="ruler-ticks" width="100%" height="14" aria-hidden="true">
                  {ticks.map((k, i) => <line key={i} x1={`${k.x}%`} x2={`${k.x}%`} y1={k.major ? 0 : 6} y2={14} className={k.major ? 'maj' : undefined} />)}
                </svg>
                <div className="track-days" aria-hidden="true">
                  {dayLabels.map(d => (
                    <span key={d} className={d === 0 ? 'first' : d === p.days ? 'last' : undefined} style={{ left: `${(d / p.days) * 100}%` }}>{d}</span>
                  ))}
                </div>
                <div className="track-cursor" style={{ left: `${frac * 100}%` }} />
              </div>
            </div>
          </div>
        </div>

        <div ref={clock} className="tbar-clock" aria-live="off">
          <div className="clk-cap">{t('tb.projecting')}</div>
          <div className="clk-time">{fmtClockUtc(p.cursor)}</div>
          <div className="clk-date">{fmtDayComma(p.cursor)}</div>
          <div className="clk-sub">{fmtCambodia(p.cursor)} • {t('time.dayOf', { day: elapsedDays.toFixed(1), days: p.days })}</div>
        </div>
        {calOpen && dateBtn.current && (
          <Popover anchor={dateBtn.current} onClose={() => setCalOpen(false)} placement="top-start" label={t('dtp.label')} className="dtp">
            <DateTimePicker value={p.arrival} onChange={p.onArrival} />
          </Popover>
        )}
      </div>
    </>
  );
}
