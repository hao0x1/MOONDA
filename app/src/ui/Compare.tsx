// Compare up to four landing plans (a spot + a landing time) as a decision tool.
// It lives in a drawer on the right, so the Moon in the middle of the screen stays visible.
//
// The user sets two simple mission needs:
//   - how long the battery can keep the lander alive with no sunlight ("darkness"), and
//   - how long the mission may go without seeing Earth (no direct radio).
// Each plan then gets a pass or fail per need. The drawer reads top to bottom:
//   the question it answers → the answer in one sentence (answerFor) → the two needs as sentences
//   → ONE table, a row per plan, two columns (longest dark, longest without Earth) with slim bars
//   on one shared time scale (gaugeScaleH) and a tick at the user's limit. A row opens to show the
//   plan's mission timeline, one plain sentence (planLine) and what you can do with it.
// Every number is measured from that plan's own landing, so a plan that lands 3 days later still
// compares fairly with the others.
//
// The maths here is only bookkeeping on the calculator's results (statsFor in analysis.ts):
// nothing is estimated or invented. "Sun in view" means the Sun's centre is above the skyline.

import { CaretDown, Check, DotsThree, Plus, WarningCircle, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { t, tn, useT, type Key } from '../i18n';
import { runs, statsFor, type SpotStats, type SpotTimeline } from '../science/analysis';
import type { SpotEntry } from '../science/client';
import './compare.css';
import { durationParts, fmtDuration, fmtUtc, fmtUtcShort } from './format';
import { EarthGlyph, SunGlyph } from './glyphs';
import { IconButton, Popover, useReachesControls } from './kit';
import { Tracks } from './TimeBar';

export interface CompareItem { id: string; letter: string; color: string; label: string; lat: number; lon: number; startMs: number }

interface Props {
  items: CompareItem[];
  entries: (SpotEntry | undefined)[];
  days: number;
  elapsedFrac: number;
  currentLabel: string | null;
  canAddCurrent: boolean;
  onAddCurrent(): void;
  onRemove(id: string): void;
  onDelay(item: CompareItem): void;
  onFocus(item: CompareItem): void;
  onStand(item: CompareItem): void;
  onClose(): void;
  /** true while the drawer is tall enough to reach the map controls (they then move aside). */
  onReach?(reaches: boolean): void;
}

// ---------------------------------------------------------------------------------------------
// Decision logic (pure functions)
// ---------------------------------------------------------------------------------------------

/** One choice for a need. `hours: Infinity` means "not needed" (no limit). `key` is its words. */
export interface NeedOption { key: Key; hours: number }

export const BATTERY_OPTIONS: NeedOption[] = [
  { key: 'cmp.opt.1d', hours: 24 }, { key: 'cmp.opt.3d', hours: 72 }, { key: 'cmp.opt.1w', hours: 168 }, { key: 'cmp.opt.off', hours: Infinity },
];
export const CONTACT_OPTIONS: NeedOption[] = [
  { key: 'cmp.opt.6h', hours: 6 }, { key: 'cmp.opt.1d', hours: 24 }, { key: 'cmp.opt.3d', hours: 72 }, { key: 'cmp.opt.off', hours: Infinity },
];

export interface Needs { battery: NeedOption; contact: NeedOption }

/** 'off' = the user chose "not needed", so this need is not tested. */
export type Check = 'pass' | 'fail' | 'off';

/** What the calculator's timeline says about one plan, plus where its longest gaps are. */
export interface PlanFacts {
  stats: SpotStats;
  /** Sample indices [start, end) of the longest stretch with the Sun hidden, or null if never dark. */
  darkRun: [number, number] | null;
  /** Sample indices [start, end) of the longest stretch with Earth hidden, or null if Earth is always up. */
  noEarthRun: [number, number] | null;
}

export interface PlanResult {
  item: CompareItem;
  entry: SpotEntry | undefined;
  timeline: SpotTimeline | null;
  facts: PlanFacts | null; // null while the plan is still being worked out, or if it failed
  battery: Check;
  contact: Check;
  /** Meets every need that is set (true when no needs are set). */
  passes: boolean;
  /** Smallest share of a limit left unused across the set needs (0.4 = 40% to spare, negative = over). */
  spare: number;
  /** Set when an earlier plan uses the same spot: this plan is that spot landing `hours` later. */
  delay: { base: CompareItem; hours: number } | null;
}

export interface Evaluation {
  plans: PlanResult[];
  /** The one plan that meets the needs with the most to spare (null when none works, or when the best ones tie). */
  pickId: string | null;
}

const isOn = (n: NeedOption) => Number.isFinite(n.hours);
const factsCache = new WeakMap<SpotTimeline, PlanFacts>();

function longestOf(list: [number, number][]): [number, number] | null {
  let best: [number, number] | null = null;
  for (const r of list) if (!best || r[1] - r[0] > best[1] - best[0]) best = r;
  return best;
}

/** Stats for a timeline (cached per timeline object, so re-renders while the clock plays are free). */
export function factsFor(tl: SpotTimeline): PlanFacts {
  let f = factsCache.get(tl);
  if (!f) {
    f = {
      stats: statsFor(tl),
      darkRun: longestOf(runs(i => !(tl.sunEl[i] > tl.sunSky[i]), 0, tl.count)),
      noEarthRun: longestOf(runs(i => !(tl.earthEl[i] > tl.earthSky[i]), 0, tl.count)),
    };
    factsCache.set(tl, f);
  }
  return f;
}

export function checkNeed(hours: number, need: NeedOption): Check {
  if (!isOn(need)) return 'off';
  return hours <= need.hours + 1e-9 ? 'pass' : 'fail';
}

const sameSpot = (a: CompareItem, b: CompareItem) => Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lon - b.lon) < 1e-6;

/** "3 days" / "1 day" / "12 h" for a landing delay. */
export function fmtDelay(hours: number): string {
  if (hours >= 24 && hours % 24 === 0) { const d = hours / 24; return `${d} ${tn('unit.day', d)}`; }
  return fmtDuration(hours);
}

/** "A", "A and B", "A, B and C". */
function listLetters(letters: string[]): string {
  return letters.length <= 1 ? letters.join('') : `${letters.slice(0, -1).join(', ')} ${t('cmp.and')} ${letters[letters.length - 1]}`;
}

/**
 * Order two passing plans: the one with the most room to spare first; ties broken by more Sun + Earth.
 * 0 means "equally good". Both plans must have facts.
 */
export function rankPlans(a: PlanResult, b: PlanResult): number {
  return Math.abs(b.spare - a.spare) > 1e-9 ? b.spare - a.spare
    : (b.facts!.stats.sunPct + b.facts!.stats.earthPct) - (a.facts!.stats.sunPct + a.facts!.stats.earthPct);
}

/** Of plans that all fail, the one that misses by the least (smallest worst overshoot, value / limit, over the needs that are set). */
export function closestPlan(ready: PlanResult[], needs: Needs): PlanResult {
  const over = (p: PlanResult) => Math.max(isOn(needs.battery) ? p.facts!.stats.longestDarkH / needs.battery.hours : 0, isOn(needs.contact) ? p.facts!.stats.longestNoEarthH / needs.contact.hours : 0);
  return [...ready].sort((a, b) => over(a) - over(b))[0];
}

/** Check every plan against the needs and pick the best one. `entries[i]` belongs to `items[i]`. */
export function evaluate(items: CompareItem[], entries: (SpotEntry | undefined)[], needs: Needs): Evaluation {
  const plans: PlanResult[] = items.map((item, i) => {
    const entry = entries[i];
    const timeline = entry?.status === 'ready' ? entry.timeline : null;
    const facts = timeline ? factsFor(timeline) : null;
    const battery = facts ? checkNeed(facts.stats.longestDarkH, needs.battery) : 'off';
    const contact = facts ? checkNeed(facts.stats.longestNoEarthH, needs.contact) : 'off';
    const spares: number[] = [];
    if (facts && isOn(needs.battery)) spares.push((needs.battery.hours - facts.stats.longestDarkH) / needs.battery.hours);
    if (facts && isOn(needs.contact)) spares.push((needs.contact.hours - facts.stats.longestNoEarthH) / needs.contact.hours);
    // The original plan at the same spot is the earliest-landing one before this plan.
    let base: CompareItem | null = null;
    for (const o of items) if (o !== item && sameSpot(o, item) && o.startMs < item.startMs && (!base || o.startMs < base.startMs)) base = o;
    return {
      item, entry, timeline, facts, battery, contact,
      passes: battery !== 'fail' && contact !== 'fail',
      spare: spares.length ? Math.min(...spares) : 1,
      delay: base ? { base, hours: (item.startMs - base.startMs) / 3600000 } : null,
    };
  });

  // Only a plan that meets the needs can be picked, and only when it beats the others.
  let pickId: string | null = null;
  const ready = plans.filter(p => p.facts);
  if (ready.length > 1 && (isOn(needs.battery) || isOn(needs.contact))) {
    const ranked = ready.filter(p => p.passes).sort(rankPlans);
    if (ranked.length === 1 || (ranked.length > 1 && rankPlans(ranked[0], ranked[1]) < 0)) pickId = ranked[0].item.id;
  }
  return { plans, pickId };
}

// ---------------------------------------------------------------------------------------------
// Plain-words answer, one sentence per plan, and the shared bar scale (pure)
// ---------------------------------------------------------------------------------------------

/** The one-sentence answer at the top of the drawer, plus at most one short note under it. */
export interface Answer {
  tone: 'good' | 'bad' | 'info' | 'wait';
  text: string;
  note: string | null;
  /** Plans that get the "Best" tag: the recommended plan, or every plan tied for best. */
  best: Set<string>;
}

/** What makes a working plan good, in a few words: "sunlight all mission and Earth always in view". */
function goodWhy(p: PlanResult, needs: Needs): string {
  const f = p.facts!.stats, parts: string[] = [];
  if (isOn(needs.battery)) parts.push(f.longestDarkH === 0 ? t('cmp.why.sunAll') : t('cmp.why.darkMax', { d: fmtDuration(f.longestDarkH) }));
  if (isOn(needs.contact)) parts.push(f.longestNoEarthH === 0 ? t('cmp.why.earthAll') : t('cmp.why.earthMax', { d: fmtDuration(f.longestNoEarthH) }));
  return parts.join(` ${t('cmp.and')} `);
}

/** Why a plan fails, in a few words: "the battery runs out in the dark and Earth stays hidden too long". */
function badWhy(p: PlanResult): string {
  const f = p.facts!.stats, parts: string[] = [];
  if (p.battery === 'fail') parts.push(f.sunPct === 0 ? t('cmp.why.noSun') : t('cmp.why.batteryOut'));
  if (p.contact === 'fail') parts.push(f.earthPct === 0 ? t('cmp.why.noEarth') : t('cmp.why.earthLong'));
  return parts.join(` ${t('cmp.and')} `);
}

const plansWord = (ps: PlanResult[]) => tn('cmp.plans', ps.length, { ls: listLetters(ps.map(p => p.item.letter)) });
const byLetter = (a: PlanResult, b: PlanResult) => a.item.letter.localeCompare(b.item.letter);

/** Turn the evaluation into the answer a 15-year-old reads first. Uses evaluate()'s own pick, so both always agree. */
export function answerFor(ev: Evaluation, needs: Needs): Answer {
  const { plans, pickId } = ev;
  const ready = plans.filter(p => p.facts);
  const best = new Set<string>();
  const notes: string[] = [];
  const anyOn = isOn(needs.battery) || isOn(needs.contact);
  let tone: Answer['tone'] = 'info', text = '';

  if (!plans.length) return { tone, text, note: null, best };

  if (!ready.length) {
    tone = 'wait';
    text = t('cmp.ans.working');
  } else if (!anyOn) {
    text = t('cmp.ans.noNeeds');
  } else if (ready.length === 1) {
    const p = ready[0];
    tone = p.passes ? 'good' : 'bad';
    text = p.passes ? t('cmp.ans.works', { l: p.item.letter, why: goodWhy(p, needs) }) : t('cmp.ans.fails', { l: p.item.letter, why: badWhy(p) });
    if (plans.length === 1) notes.push(t('cmp.note.one'));
    else if (!p.passes) notes.push(t('cmp.note.retry'));
  } else {
    const pass = ready.filter(p => p.passes).sort(rankPlans);
    if (!pass.length) {
      tone = 'bad';
      const c = closestPlan(ready, needs);
      text = t('cmp.ans.none', { l: c.item.letter, why: badWhy(c) });
      notes.push(t('cmp.note.retry'));
    } else {
      tone = 'good';
      const pick = pass.find(p => p.item.id === pickId);
      // No single winner: the top plans are equally good.
      const top = pick ? [pick] : pass.filter(p => rankPlans(pass[0], p) === 0).sort(byLetter);
      top.forEach(p => best.add(p.item.id));
      text = pick ? t('cmp.ans.best', { l: pick.item.letter, why: goodWhy(pick, needs) }) : t('cmp.ans.tie', { plans: plansWord(top), why: goodWhy(top[0], needs) });
      const others = pass.filter(p => !top.includes(p)).sort(byLetter);
      if (others.length) notes.push(t(others.length === 1 ? 'cmp.note.also.one' : 'cmp.note.also.other', { plans: plansWord(others) }));
    }
  }

  // Does arriving later at the same spot (the "Try arriving 3 days later" plans) break or rescue it?
  if (anyOn) for (const p of ready) {
    const base = p.delay && ready.find(b => b.item === p.delay!.base);
    if (!base) continue;
    const vars = { l: p.item.letter, d: fmtDelay(p.delay!.hours) };
    if (base.passes && !p.passes) notes.unshift(t('cmp.note.breaks', vars));
    else if (!base.passes && p.passes) notes.unshift(t('cmp.note.rescues', vars));
  }
  const pending = plans.filter(p => !p.facts && p.entry?.status !== 'error');
  if (pending.length && ready.length) notes.push(t('cmp.note.pending', { ls: listLetters(pending.map(p => p.item.letter)) }));
  for (const p of plans) if (p.entry?.status === 'error') notes.push(t('cmp.note.error', { l: p.item.letter }));
  return { tone, text, note: notes[0] ?? null, best };
}

/** The one plain sentence inside an opened row ("The battery runs out: the dark lasts 3.7 days, …"). */
export function planLine(p: PlanResult, needs: Needs): string | null {
  if (!p.facts) return null;
  const f = p.facts.stats;
  const dark = fmtDuration(f.longestDarkH), earth = fmtDuration(f.longestNoEarthH);
  const battery = t(needs.battery.key), contact = t(needs.contact.key);
  if (p.battery === 'fail' && p.contact === 'fail') return f.sunPct === 0 && f.earthPct === 0 ? t('cmp.line.neither') : t('cmp.line.both', { dark, earth });
  if (p.battery === 'fail') return f.sunPct === 0 ? t('cmp.line.noSun') : t('cmp.line.battery', { dark, limit: battery });
  if (p.contact === 'fail') return f.earthPct === 0 ? t('cmp.line.noEarth') : t('cmp.line.contact', { earth, limit: contact });
  const parts: string[] = [];
  if (p.battery === 'pass') parts.push(f.longestDarkH === 0 ? t('cmp.why.sunAll') : t('cmp.line.darkOk', { d: dark, limit: battery }));
  if (p.contact === 'pass') parts.push(f.longestNoEarthH === 0 ? t('cmp.why.earthAll') : t('cmp.line.earthOk', { d: earth, limit: contact }));
  if (parts.length) return t('cmp.line.works', { why: parts.join(` ${t('cmp.and')} `) });
  return t('cmp.line.free', {
    dark: f.longestDarkH === 0 ? t('cmp.line.neverDark') : t('cmp.line.darkUpTo', { d: dark }),
    earth: f.longestNoEarthH === 0 ? t('cmp.why.earthAll') : t('cmp.line.earthUpTo', { d: earth }),
  });
}

/**
 * One time scale (in hours) shared by every bar in the table, so bars can be compared across plans.
 * The longest bar ends at 90% of the width and every limit tick stays inside 85% of it.
 */
export function gaugeScaleH(plans: PlanResult[], needs: Needs): number {
  let m = 24;
  for (const p of plans) {
    if (!p.facts) continue;
    m = Math.max(m, p.facts.stats.longestDarkH / 0.9, p.facts.stats.longestNoEarthH / 0.9);
  }
  for (const n of [needs.battery, needs.contact]) if (isOn(n)) m = Math.max(m, n.hours / 0.85);
  return m;
}

// ---------------------------------------------------------------------------------------------
// Small UI pieces
// ---------------------------------------------------------------------------------------------

const NEEDS_KEY = 'moonda.compare.needs';
const DEFAULT_NEEDS: [number, number] = [1, 1]; // battery 3 days, contact 1 day

function loadNeeds(): [number, number] {
  try {
    const v = JSON.parse(localStorage.getItem(NEEDS_KEY) ?? '');
    if (Array.isArray(v) && v.length === 2 && v.every(x => Number.isInteger(x) && x >= 0 && x < 4)) return [v[0], v[1]];
  } catch { /* private mode or nothing saved yet */ }
  return DEFAULT_NEEDS;
}
function saveNeeds(v: [number, number]) {
  try { localStorage.setItem(NEEDS_KEY, JSON.stringify(v)); } catch { /* private mode */ }
}

const pct = (x: number) => `${Math.min(100, Math.max(0, x * 100))}%`;

/** Up/down arrows move between the items of a small menu. */
function menuKeys(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  e.stopPropagation();
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
}

/** The blank in a need's sentence: shows the choice, opens a short menu with all four. */
function NeedPick({ label, options, value, onChange }: { label: string; options: NeedOption[]; value: number; onChange(i: number): void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  // The shared Popover is still hidden (being measured) when it tries to focus the chosen item,
  // so focus it here once it is on screen: arrow keys and Enter then work straight away.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => document.querySelector<HTMLElement>('.need-menu [aria-checked="true"]')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [open]);
  const cur = options[value];
  return (
    <>
      <button ref={btn} type="button" className={`need-pick${isOn(cur) ? '' : ' off'}`} aria-haspopup="menu" aria-expanded={open}
        aria-label={t('cmp.pick.aria', { label, value: t(cur.key) })} onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setOpen(true); } }}>
        {t(cur.key)}<CaretDown size={10} weight="bold" aria-hidden="true" />
      </button>
      {open && btn.current && (
        <Popover anchor={btn.current} onClose={() => setOpen(false)} placement="bottom-start" label={label} className="menu need-menu">
          <div role="menu" aria-label={label} onKeyDown={menuKeys}>
            <div className="menu-title">{label}</div>
            {options.map((o, i) => (
              <button key={o.key} type="button" role="menuitemradio" aria-checked={i === value} className="menu-item"
                onClick={() => { onChange(i); setOpen(false); btn.current?.focus(); }}>
                <span className="menu-check" aria-hidden="true">{i === value && <Check size={14} weight="bold" />}</span>
                <span className="menu-label">{t(o.key)}</span>
                {!isOn(o) && <span className="menu-note">{t('cmp.opt.skip')}</span>}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

/** One measure in the table: the number, a check or a cross, and a slim bar with a tick at the limit. */
function Cell({ hours, need, check, scaleH, what }: { hours: number; need: NeedOption; check: Check; scaleH: number; what: string }) {
  const parts = hours === 0 ? null : durationParts(hours);
  const shown = parts ? `${parts.n} ${parts.unit}` : t('cmp.none');
  const tip = isOn(need) ? t('cmp.cell.tip', { what, value: shown, limit: t(need.key) }) : t('cmp.cell.tipOff', { what, value: shown });
  const said = check === 'pass' ? t('cmp.cell.fits') : check === 'fail' ? t('cmp.cell.over') : '';
  return (
    <div className={`cmp-cell ${check}`} role="img" aria-label={`${what}: ${shown}${said ? `, ${said}` : ''}.`} data-tip={tip}>
      <span className="cmp-val">
        {parts ? <>{parts.n}<small>{parts.unit}</small></> : <span className="cmp-none">{shown}</span>}
        {check === 'pass' && <Check className="cmp-mark" size={12} weight="bold" aria-hidden="true" />}
        {check === 'fail' && <X className="cmp-mark" size={12} weight="bold" aria-hidden="true" />}
      </span>
      <span className="cmp-track" aria-hidden="true">
        <i className="cmp-bar" style={{ width: pct(hours / scaleH) }} />
        {isOn(need) && <i className="cmp-tick" style={{ left: pct(need.hours / scaleH) }} />}
      </span>
    </div>
  );
}

interface RowProps {
  plan: PlanResult;
  needs: Needs;
  scaleH: number;
  best: boolean;
  open: boolean;
  canDelay: boolean;
  onToggle(): void;
  onFocus(): void;
  onDelay(): void;
  onStand(): void;
  onRemove(): void;
}

/** The four things you can do with a plan, as quiet text buttons (inside an opened row and in the "…" menu). */
function actions(r: RowProps, ready: boolean) {
  return [
    { key: 'show', label: t('cmp.act.show'), tip: undefined, run: r.onFocus, off: false },
    { key: 'stand', label: t('cmp.act.stand'), tip: t('cmp.act.stand.tip'), run: r.onStand, off: !ready },
    { key: 'later', label: t('cmp.act.later'), tip: r.canDelay ? t('cmp.act.later.tip') : t('cmp.act.full.tip'), run: r.onDelay, off: !r.canDelay },
    { key: 'remove', label: t('cmp.act.remove'), tip: undefined, run: r.onRemove, off: false },
  ];
}

/** The "…" button at the end of a row: every action, without opening the row. */
function RowMenu({ row, ready }: { row: RowProps; ready: boolean }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const label = t('cmp.more', { letter: row.plan.item.letter });
  return (
    <>
      <button ref={btn} type="button" className="ibtn sm cmp-more" aria-label={label} data-tip={label} aria-haspopup="menu" aria-expanded={open}
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}>
        <DotsThree size={18} weight="bold" aria-hidden="true" />
      </button>
      {open && btn.current && (
        <Popover anchor={btn.current} onClose={() => setOpen(false)} placement="bottom-end" label={label} className="menu cmp-menu">
          <div role="menu" aria-label={label} onKeyDown={menuKeys}>
            {actions(row, ready).map(a => (
              <button key={a.key} type="button" role="menuitem" className={`menu-item${a.key === 'remove' ? ' cmp-remove' : ''}`} disabled={a.off} data-tip={a.tip} data-tip-side="left"
                onClick={() => { setOpen(false); a.run(); }}>
                <span className="menu-label">{a.label}</span>
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

/** One plan = one row: letter, name and landing, the two measures, and a "…" menu. Click to open it. */
function PlanRow(r: RowProps) {
  const { plan, needs, scaleH, best, open } = r;
  const { item, facts, entry, timeline } = plan;
  const name = item.label.replace(/ \(\+\d+ days\)$/, ''); // the later arrival gets its own words below
  const s = facts?.stats;
  const when = plan.delay ? t('cmp.later', { delay: fmtDelay(plan.delay.hours), letter: plan.delay.base.letter }) : fmtUtcShort(item.startMs);
  const line = planLine(plan, needs);
  const detailId = `cmp-detail-${item.id}`;
  const rowEl = useRef<HTMLDivElement>(null);
  // An opened row may reach below the drawer's edge: bring all of it into view.
  useEffect(() => { if (open) rowEl.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [open]);

  return (
    <div ref={rowEl} className={`cmp-row${best ? ' best' : ''}${open ? ' open' : ''}`} role="listitem">
      <button type="button" className="cmp-who" aria-expanded={open} aria-controls={detailId} onClick={r.onToggle}
        aria-label={`${t('cmp.row', { letter: item.letter, name })}${best ? `, ${t('cmp.best')}` : ''}`} data-tip={t('cmp.lands', { date: fmtUtc(item.startMs) })}>
        <span className="cmp-badge" style={{ '--ring': item.color } as CSSProperties} aria-hidden="true">{item.letter}</span>
        <span className="cmp-text">
          <span className="cmp-name">{name}{best && <span className="cmp-best">{t('cmp.best')}</span>}</span>
          <span className="cmp-when">{when}</span>
        </span>
      </button>

      {s ? (
        <>
          <div className="cmp-cell-hit" onClick={r.onToggle}>
            <Cell hours={s.longestDarkH} need={needs.battery} check={plan.battery} scaleH={scaleH} what={t('cmp.col.dark')} />
          </div>
          <div className="cmp-cell-hit" onClick={r.onToggle}>
            <Cell hours={s.longestNoEarthH} need={needs.contact} check={plan.contact} scaleH={scaleH} what={t('cmp.col.earth')} />
          </div>
        </>
      ) : entry?.status === 'error' ? (
        <div className="cmp-msg bad" data-tip={entry.message}><WarningCircle size={14} weight="fill" aria-hidden="true" />{t('cmp.error')}</div>
      ) : (
        <div className="cmp-msg"><span className="spinner" aria-hidden="true" />{t('cmp.working')}</div>
      )}

      <RowMenu row={r} ready={!!facts} />

      {open && (
        <div className="cmp-detail" id={detailId}>
          {timeline && (
            <div className="cmp-tracks" role="img" aria-label={t('cmp.tracks')} data-tip={t('cmp.tracks')}>
              <span className="mt-keys"><SunGlyph size={12} /><EarthGlyph size={12} /></span>
              <span className="mt-bars"><Tracks timeline={timeline} /></span>
            </div>
          )}
          {line && <p className="cmp-line">{line}</p>}
          <div className="cmp-acts">
            {actions(r, !!facts).map(a => (
              <button key={a.key} type="button" className="btn ghost sm" disabled={a.off} data-tip={a.tip} onClick={a.run}>{a.label}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The drawer
// ---------------------------------------------------------------------------------------------

export function Compare(p: Props) {
  const t = useT();
  const [needIdx, setNeedIdx] = useState<[number, number]>(loadNeeds);
  const [openId, setOpenId] = useState<string | null>(null);
  const setNeed = (k: 0 | 1, i: number) => setNeedIdx(cur => {
    const next: [number, number] = k === 0 ? [i, cur[1]] : [cur[0], i];
    saveNeeds(next);
    return next;
  });
  const needs: Needs = { battery: BATTERY_OPTIONS[needIdx[0]], contact: CONTACT_OPTIONS[needIdx[1]] };
  const ev = evaluate(p.items, p.entries, needs);
  const answer = answerFor(ev, needs);
  const scaleH = gaugeScaleH(ev.plans, needs);
  const full = p.items.length >= 4;
  const nextLetter = ['A', 'B', 'C', 'D'].find(l => !p.items.some(it => it.letter === l)) ?? '';
  const root = useReachesControls(r => p.onReach?.(r));
  const empty = p.items.length === 0;
  const canAdd = !full && p.canAddCurrent && !!p.currentLabel;

  const pickBattery = <NeedPick label={t('cmp.battery.menu')} options={BATTERY_OPTIONS} value={needIdx[0]} onChange={i => setNeed(0, i)} />;
  const pickContact = <NeedPick label={t('cmp.contact.menu')} options={CONTACT_OPTIONS} value={needIdx[1]} onChange={i => setNeed(1, i)} />;

  return (
    <aside ref={root} className="drawer panel cmp" aria-label={t('cmp.aria')}>
      <header className="drawer-head">
        <h2>{t('cmp.title')}</h2>
        {!empty && <span className="drawer-sub">{t('cmp.count', { n: p.items.length })}</span>}
        <span className="drawer-gap" />
        <IconButton size="sm" label={t('cmp.close')} onClick={p.onClose}><X size={16} /></IconButton>
      </header>

      <div className="drawer-body">
        <p className="cmp-q">{t('cmp.question')}</p>

        {empty ? (
          <div className="cmp-empty">
            <p className="cmp-intro">{t('cmp.empty')}</p>
            <button type="button" className="btn primary" onClick={p.onAddCurrent} disabled={!canAdd}
              data-tip={canAdd ? t('cmp.addAs', { name: p.currentLabel ?? '', letter: nextLetter }) : t('cmp.addHint')}>
              <Plus size={16} weight="bold" aria-hidden="true" />{t('cmp.addSelected')}
            </button>
            <p className="cmp-hint">{canAdd ? p.currentLabel : t('cmp.addHint')}</p>
          </div>
        ) : (
          <div className={`cmp-answer ${answer.tone}`} aria-live="polite">
            <p className="cmp-answer-text">{answer.tone === 'wait' && <span className="spinner" aria-hidden="true" />}{answer.text}</p>
            {answer.note && <p className="cmp-answer-note">{answer.note}</p>}
          </div>
        )}

        <section className="cmp-needs" aria-label={t('cmp.needs')}>
          <p className="need">
            <span className="need-lead" tabIndex={0} data-tip={t('cmp.battery.tip')}>{isOn(needs.battery) ? t('cmp.battery.before') : t('cmp.battery.off')}</span>
            {pickBattery}
            {isOn(needs.battery) && <span>{t('cmp.battery.after')}</span>}
          </p>
          <p className="need">
            <span className="need-lead" tabIndex={0} data-tip={t('cmp.contact.tip')}>{isOn(needs.contact) ? t('cmp.contact.before') : t('cmp.contact.off')}</span>
            {pickContact}
            {isOn(needs.contact) && <span>{t('cmp.contact.after')}</span>}
          </p>
        </section>

        {!empty && (
          <section className="cmp-table" aria-label={t('cmp.aria')}>
            <div className="cmp-thead">
              <span className="cmp-th">{t('cmp.col.plan')}</span>
              <span className="cmp-th" tabIndex={0} data-tip={t('cmp.col.dark.tip')}><SunGlyph size={16} /><span>{t('cmp.col.dark')}</span></span>
              <span className="cmp-th" tabIndex={0} data-tip={t('cmp.col.earth.tip')}><EarthGlyph size={16} /><span>{t('cmp.col.earth')}</span></span>
            </div>
            <div className="cmp-rows" role="list">
              {ev.plans.map(plan => (
                <PlanRow key={plan.item.id} plan={plan} needs={needs} scaleH={scaleH} best={answer.best.has(plan.item.id)}
                  open={openId === plan.item.id} canDelay={!full} onToggle={() => setOpenId(id => (id === plan.item.id ? null : plan.item.id))}
                  onFocus={() => p.onFocus(plan.item)} onDelay={() => p.onDelay(plan.item)} onStand={() => p.onStand(plan.item)} onRemove={() => p.onRemove(plan.item.id)} />
              ))}
            </div>
            {canAdd ? (
              <button type="button" className="btn ghost sm cmp-add" onClick={p.onAddCurrent}>
                <Plus size={14} weight="bold" aria-hidden="true" /><span>{t('cmp.addAs', { name: p.currentLabel ?? '', letter: nextLetter })}</span>
              </button>
            ) : <p className="cmp-hint">{full ? t('cmp.full') : t('cmp.pickHint')}</p>}
          </section>
        )}
      </div>
    </aside>
  );
}
