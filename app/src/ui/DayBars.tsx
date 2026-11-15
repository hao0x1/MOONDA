// One bar is one mission day. Long missions group whole days so the bars stay readable.
// Use the same centre-above-skyline test as statsFor, rather than the visible disc fraction.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { monthShort, useT } from '../i18n';
import type { SpotTimeline } from '../science/analysis';

const DAY_MS = 86400000;

interface DayBin {
  firstDay: number;
  lastDay: number;
  startMs: number;
  endMs: number;
  samples: number;
  sunUp: number;
  earthUp: number;
}

/** Every sample belongs to one bar, including the endpoint in the final mission day. */
function dayBins(timeline: SpotTimeline, days: number): DayBin[] {
  const totalDays = Math.max(1, Math.ceil(days));
  const groupDays = Math.ceil(totalDays / 31);
  const bins: DayBin[] = [];
  for (let d = 0; d < totalDays; d += groupDays) {
    bins.push({
      firstDay: d + 1,
      lastDay: Math.min(totalDays, d + groupDays),
      startMs: timeline.startMs + d * DAY_MS,
      endMs: timeline.startMs + Math.min(days, d + groupDays) * DAY_MS,
      samples: 0, sunUp: 0, earthUp: 0,
    });
  }
  for (let i = 0; i < timeline.count; i++) {
    const day = Math.min(totalDays - 1, Math.max(0, Math.floor(i * timeline.stepMs / DAY_MS)));
    const bin = bins[Math.floor(day / groupDays)];
    bin.samples++;
    if (timeline.sunEl[i] > timeline.sunSky[i]) bin.sunUp++;
    if (timeline.earthEl[i] > timeline.earthSky[i]) bin.earthUp++;
  }
  return bins;
}

interface Props {
  timeline: SpotTimeline;
  days: number;
  cursor: number;
  kind: 'sun' | 'earth';
  nowWord: string;
  nowTip: string;
  onSeek(ms: number): void;
}

interface BarTip {
  index: number;
  text: string;
  /** what the small chip shows: the share ("75%") and, quieter, which day ("Day 8 · 25 Nov") */
  share: string;
  when: string;
  x: number;
  y: number;
  headingBottom: number;
}

const shortDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${monthShort(d.getUTCMonth())}`;
};

export function DayBars({ timeline, days, cursor, kind, nowWord, nowTip, onSeek }: Props) {
  const t = useT();
  const headingId = useId();
  const tipId = useId();
  const bins = useMemo(() => dayBins(timeline, days), [timeline, days]);
  const heading = useRef<HTMLDivElement>(null);
  const plot = useRef<HTMLDivElement>(null);
  const firstLabel = useRef<HTMLSpanElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const bubble = useRef<HTMLDivElement>(null);
  const tipTimer = useRef<number | undefined>(undefined);
  const pendingTip = useRef<(BarTip & { target: HTMLButtonElement }) | null>(null);
  // a finger cannot hover: on touch a tap moves the time there AND shows the bar's number for a moment
  const byFinger = useRef(false);
  const [widths, setWidths] = useState({ plot: 300, first: 30 });
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [tip, setTip] = useState<BarTip | null>(null);
  const [tipPosition, setTipPosition] = useState<{ left: number; top: number } | null>(null);
  const currentIndex = Math.max(0, bins.findIndex((bin, i) => cursor < bin.endMs || i === bins.length - 1));
  const tabIndex = Math.min(bins.length - 1, focusIndex ?? currentIndex);
  const slotWidth = widths.plot / bins.length;
  const labelStep = slotWidth >= 17 ? 1 : 2;

  const hideTip = useCallback(() => {
    window.clearTimeout(tipTimer.current);
    pendingTip.current = null;
    setTip(null);
    setTipPosition(null);
  }, []);

  const showTip = (index: number, target: HTMLButtonElement, text: string, share: string, when: string, pointerY?: number) => {
    hideTip();
    const r = target.getBoundingClientRect();
    const next = { index, target, text, share, when, x: r.left + r.width / 2, y: pointerY ?? r.bottom, headingBottom: heading.current?.getBoundingClientRect().bottom ?? r.top - 4 };
    pendingTip.current = next;
    if (pointerY === undefined) setTip(next);
    else tipTimer.current = window.setTimeout(() => {
      const pending = pendingTip.current;
      if (pending?.target.isConnected) setTip(pending);
    }, 450);
  };

  useLayoutEffect(() => {
    if (!tip || !bubble.current) return;
    const { width, height } = bubble.current.getBoundingClientRect();
    // Keep the small bubble near the bar, without hiding the chart's title.
    const left = Math.max(8, Math.min(tip.x - width / 2, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(Math.max(tip.headingBottom + 4, tip.y - height - 6), window.innerHeight - height - 8));
    setTipPosition({ left, top });
  }, [tip]);

  useEffect(() => {
    const onEscape = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') hideTip(); };
    const onResize = () => setTip(open => {
      if (!open) return null;
      const r = buttons.current[open.index]?.getBoundingClientRect();
      return r ? { ...open, x: r.left + r.width / 2, y: Math.min(open.y, r.bottom), headingBottom: heading.current?.getBoundingClientRect().bottom ?? r.top - 4 } : null;
    });
    window.addEventListener('scroll', hideTip, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', hideTip);
    window.addEventListener('keydown', onEscape, true);
    return () => {
      window.clearTimeout(tipTimer.current);
      window.removeEventListener('scroll', hideTip, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', hideTip);
      window.removeEventListener('keydown', onEscape, true);
    };
  }, [hideTip]);

  useEffect(() => {
    const measure = () => setWidths({ plot: plot.current?.clientWidth || 300, first: firstLabel.current?.getBoundingClientRect().width || 30 });
    const ro = new ResizeObserver(measure);
    if (plot.current) ro.observe(plot.current);
    if (firstLabel.current) ro.observe(firstLabel.current);
    measure();
    return () => ro.disconnect();
  }, []);

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(bins.length - 1, i + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = bins.length - 1;
    else return;
    // The map listens for arrows too; while reading a chart, they move only between its bars.
    e.preventDefault();
    e.stopPropagation();
    setFocusIndex(next);
    buttons.current[next]?.focus();
  };

  const labelVisible = (i: number) => {
    // Leave room for the word beside Day 1, even on a short mission with wide slots.
    if (bins[i].firstDay === 2) return false;
    if (i === 0 || i === bins.length - 1) return true;
    return i % labelStep === 0 && (i + .5) * slotWidth > widths.first + 6 && (bins.length - 1 - i) * slotWidth >= 15;
  };

  return (
    <section className={`pday-chart pday-${kind}`} aria-labelledby={headingId}>
      <div ref={heading} className="pday-heading">
        <h4 id={headingId}>{t(kind === 'sun' ? 'place.day.sun' : 'place.day.earth')}</h4>
        <span className="pday-now" data-tip={nowTip} tabIndex={0}>{t('place.day.now', { word: nowWord })}</span>
      </div>
      <div ref={plot} className="pday-plot" style={{
        '--pday-count': bins.length,
        '--pday-first-inset': `${Math.max(0, (slotWidth - Math.min(20, Math.max(3, slotWidth * .6))) / 2)}px`,
      } as React.CSSProperties}>
        <div className="pday-bars">
          {bins.map((bin, i) => {
            const up = kind === 'sun' ? bin.sunUp : bin.earthUp;
            const pct = bin.samples ? 100 * up / bin.samples : 0;
            const grouped = bin.lastDay > bin.firstDay;
            const day = grouped ? t('place.day.range', { from: bin.firstDay, to: bin.lastDay }) : t('place.day.single', { n: bin.firstDay });
            const date = grouped ? `${shortDate(bin.startMs)} – ${shortDate(bin.endMs - 1)}` : shortDate(bin.startMs);
            const state = t(kind === 'sun'
              ? grouped ? 'place.day.sun.group' : up === 0 ? 'place.day.sun.none' : up === bin.samples ? 'place.day.sun.all' : 'place.day.sun.some'
              : grouped ? 'place.day.earth.group' : up === 0 ? 'place.day.earth.none' : up === bin.samples ? 'place.day.earth.all' : 'place.day.earth.some', { pct: Math.round(pct) });
            const barTip = t('place.day.tip', { day, date, state });
            return (
              <button key={bin.startMs} ref={el => { buttons.current[i] = el; }} type="button"
                className={`pday-bar${i === currentIndex ? ' is-current' : ''}`} tabIndex={i === tabIndex ? 0 : -1}
                aria-label={barTip} aria-current={i === currentIndex ? 'time' : undefined} data-pday-tip={barTip}
                aria-describedby={tip?.index === i ? tipId : undefined}
                data-day={bin.firstDay} data-end-day={bin.lastDay} data-percent={pct} data-samples={bin.samples} data-visible={up}
                onMouseEnter={e => showTip(i, e.currentTarget, barTip, `${Math.round(pct)}%`, `${day} · ${date}`, e.clientY)}
                onMouseMove={e => {
                  const pending = pendingTip.current;
                  if (pending?.index !== i) return;
                  pending.y = e.clientY;
                  setTip(open => open?.index === i ? { ...open, y: e.clientY } : open);
                }}
                onMouseLeave={hideTip} onBlur={hideTip}
                onFocus={e => { setFocusIndex(i); if (e.currentTarget.matches(':focus-visible')) showTip(i, e.currentTarget, barTip, `${Math.round(pct)}%`, `${day} · ${date}`); }}
                onPointerDown={e => { byFinger.current = e.pointerType !== 'mouse'; }}
                onKeyDown={e => onKey(e, i)} onClick={e => {
                  hideTip(); onSeek(bin.startMs);
                  if (!byFinger.current) return;
                  showTip(i, e.currentTarget, barTip, `${Math.round(pct)}%`, `${day} · ${date}`);
                  tipTimer.current = window.setTimeout(hideTip, 2600);
                }}>
                <span className="pday-track" aria-hidden="true"><i className="pday-fill" style={{ height: `${pct}%`, minHeight: up > 0 ? 2 : 0 }} /></span>
              </button>
            );
          })}
        </div>
        <div className="pday-axis" aria-hidden="true" />
        <div className="pday-labels" aria-hidden="true">
          {bins.map((bin, i) => (
            <span key={bin.startMs} className={`pday-label${i === 0 ? ' pday-first' : i === bins.length - 1 ? ' pday-last' : ''}${i === currentIndex ? ' is-current' : ''}`}>
              <span ref={i === 0 ? firstLabel : undefined} className="pday-label-text">{labelVisible(i) ? i === 0 ? t('place.day.single', { n: 1 }) : bin.firstDay : ''}</span>
            </span>
          ))}
        </div>
      </div>
      {tip && createPortal(
        <div ref={bubble} id={tipId} role="tooltip" className="tooltip pday-tooltip"
          style={tipPosition ?? { left: 0, top: 0, visibility: 'hidden' }}><b>{tip.share}</b><span>{tip.when}</span></div>,
        document.body,
      )}
    </section>
  );
}
