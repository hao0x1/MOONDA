// Compare landing plans (a spot + a landing time) as a decision tool.
// It lives in a drawer on the right, so the Moon in the middle of the screen stays visible.
//
// The user sets two simple mission needs:
//   - how long the battery can keep the lander alive with no sunlight ("darkness"), and
//   - how long the mission may go without seeing Earth (no direct radio).
// Each plan then gets a pass or fail per need. The drawer reads top to bottom:
//   robot information with two day rulers → one comparison table, a row per plan,
//   two columns (longest dark, longest without Earth). A row opens to show the
//   plan's mission timeline, one plain sentence (planLine) and what you can do with it.
// Every number is measured from that plan's own landing, so a plan that lands 3 days later still
// compares fairly with the others.
//
// The maths here is only bookkeeping on the calculator's results (statsFor in analysis.ts):
// nothing is estimated or invented. "Sun in view" means the Sun's centre is above the skyline.

import { Check, DotsThree, Plus, WarningCircle, X } from '@phosphor-icons/react';
import { useEffect, useEffectEvent, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { t, tn, useT, type Key } from '../i18n';
import { runs, statsFor, type SpotStats, type SpotTimeline } from '../science/analysis';
import type { SpotEntry } from '../science/client';
import './compare.css';
import { durationParts, fmtDuration, fmtUtc, fmtUtcShort } from './format';
import { DateTimePicker } from './DateTimePicker';
import { ARRIVAL_MAX, ARRIVAL_MIN, parseDate } from './parseDate';
import { EarthGlyph, SunGlyph } from './glyphs';
import { IconButton, Popover, useReachesControls } from './kit';
import { Tracks } from './TimeBar';
import { PhoneSheetHandle, usePhoneSheet } from './PhoneSheet';

export interface CompareItem { id: string; letter: string; color: string; label: string; lat: number; lon: number; startMs: number }

// The first four keep their familiar colours; more plans continue through this light palette.
const PLAN_COLOURS = ['#a99ee8', '#d4b483', '#de94b6', '#82c2b3', '#8fbde8', '#e5a17d', '#c7ca7a', '#cb9cdb', '#8ecdd0', '#d89494', '#a4c38b', '#b5b6d0'];

/** Spreadsheet-style letters keep every plan named after Z. */
// oxlint-disable-next-line react/only-export-components
export function planLetter(index: number): string {
  let n = Math.max(0, Math.floor(index)) + 1, letter = '';
  while (n > 0) { n--; letter = String.fromCharCode(65 + n % 26) + letter; n = Math.floor(n / 26); }
  return letter;
}

// oxlint-disable-next-line react/only-export-components
export function nextPlanIndex(items: CompareItem[]): number {
  const used = new Set(items.map(item => item.letter));
  let index = 0;
  while (used.has(planLetter(index))) index++;
  return index;
}

// oxlint-disable-next-line react/only-export-components
export function planColour(index: number): string { return PLAN_COLOURS[index % PLAN_COLOURS.length]; }

interface Props {
  items: CompareItem[];
  entries: (SpotEntry | undefined)[];
  days: number;
  elapsedFrac: number;
  currentLabel: string | null;
  canAddCurrent: boolean;
  onAddCurrent(): void;
  onRemove(id: string): void;
  onAddDate(item: CompareItem, startMs: number): void;
  onChangeDate(item: CompareItem, startMs: number): void;
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

// These legacy presets and pure helpers remain public for App and calculation checks.
// oxlint-disable-next-line react/only-export-components
export const BATTERY_OPTIONS: NeedOption[] = [
  { key: 'cmp.opt.1d', hours: 24 }, { key: 'cmp.opt.3d', hours: 72 }, { key: 'cmp.opt.1w', hours: 168 }, { key: 'cmp.opt.off', hours: Infinity },
];
// oxlint-disable-next-line react/only-export-components
export const CONTACT_OPTIONS: NeedOption[] = [
  { key: 'cmp.opt.6h', hours: 6 }, { key: 'cmp.opt.1d', hours: 24 }, { key: 'cmp.opt.3d', hours: 72 }, { key: 'cmp.opt.off', hours: Infinity },
];

/** Plain hours; Infinity switches a check off. */
export interface Needs { battery: number; contact: number }

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

const isOn = (hours: number) => Number.isFinite(hours);
const limitWords = (hours: number) => fmtDelay(hours);
// A zero-hour limit is valid: no gap passes it, while a real gap has a finite penalty.
const spareFor = (hours: number, limit: number) => limit > 0 ? (limit - hours) / limit : hours <= 1e-9 ? 0 : -hours;
const overshootFor = (hours: number, limit: number) => limit > 0 ? hours / limit : hours <= 1e-9 ? 0 : 1 + hours;
const factsCache = new WeakMap<SpotTimeline, PlanFacts>();

function longestOf(list: [number, number][]): [number, number] | null {
  let best: [number, number] | null = null;
  for (const r of list) if (!best || r[1] - r[0] > best[1] - best[0]) best = r;
  return best;
}

/** Stats for a timeline (cached per timeline object, so re-renders while the clock plays are free). */
// oxlint-disable-next-line react/only-export-components
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

// oxlint-disable-next-line react/only-export-components
export function checkNeed(hours: number, need: number): Check {
  if (!isOn(need)) return 'off';
  return hours <= need + 1e-9 ? 'pass' : 'fail';
}

const sameSpot = (a: CompareItem, b: CompareItem) => Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lon - b.lon) < 1e-6;

/** "3 days" / "1 day" / "12 h" for a landing delay. */
// oxlint-disable-next-line react/only-export-components
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
// oxlint-disable-next-line react/only-export-components
export function rankPlans(a: PlanResult, b: PlanResult): number {
  return Math.abs(b.spare - a.spare) > 1e-9 ? b.spare - a.spare
    : (b.facts!.stats.sunPct + b.facts!.stats.earthPct) - (a.facts!.stats.sunPct + a.facts!.stats.earthPct);
}

/** Of plans that all fail, the one that misses by the least (smallest worst overshoot, value / limit, over the needs that are set). */
// oxlint-disable-next-line react/only-export-components
export function closestPlan(ready: PlanResult[], needs: Needs): PlanResult {
  const over = (p: PlanResult) => Math.max(isOn(needs.battery) ? overshootFor(p.facts!.stats.longestDarkH, needs.battery) : 0, isOn(needs.contact) ? overshootFor(p.facts!.stats.longestNoEarthH, needs.contact) : 0);
  return [...ready].sort((a, b) => over(a) - over(b))[0];
}

/** Check every plan against the needs and pick the best one. `entries[i]` belongs to `items[i]`. */
// oxlint-disable-next-line react/only-export-components
export function evaluate(items: CompareItem[], entries: (SpotEntry | undefined)[], needs: Needs): Evaluation {
  const plans: PlanResult[] = items.map((item, i) => {
    const entry = entries[i];
    const timeline = entry?.status === 'ready' ? entry.timeline : null;
    const facts = timeline ? factsFor(timeline) : null;
    const battery = facts ? checkNeed(facts.stats.longestDarkH, needs.battery) : 'off';
    const contact = facts ? checkNeed(facts.stats.longestNoEarthH, needs.contact) : 'off';
    const spares: number[] = [];
    if (facts && isOn(needs.battery)) spares.push(spareFor(facts.stats.longestDarkH, needs.battery));
    if (facts && isOn(needs.contact)) spares.push(spareFor(facts.stats.longestNoEarthH, needs.contact));
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
// oxlint-disable-next-line react/only-export-components
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

  // Does another landing date at the same spot break or rescue it?
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
// oxlint-disable-next-line react/only-export-components
export function planLine(p: PlanResult, needs: Needs): string | null {
  if (!p.facts) return null;
  const f = p.facts.stats;
  const dark = fmtDuration(f.longestDarkH), earth = fmtDuration(f.longestNoEarthH);
  const battery = limitWords(needs.battery), contact = limitWords(needs.contact);
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
// oxlint-disable-next-line react/only-export-components
export function gaugeScaleH(plans: PlanResult[], needs: Needs): number {
  let m = 24;
  for (const p of plans) {
    if (!p.facts) continue;
    m = Math.max(m, p.facts.stats.longestDarkH / 0.9, p.facts.stats.longestNoEarthH / 0.9);
  }
  for (const n of [needs.battery, needs.contact]) if (isOn(n)) m = Math.max(m, n / 0.85);
  return m;
}

// ---------------------------------------------------------------------------------------------
// Small UI pieces
// ---------------------------------------------------------------------------------------------

const NEEDS_KEY = 'moonda.compare.needs.v2';
const OLD_NEEDS_KEY = 'moonda.compare.needs';
interface NeedsHours { batteryH: number; contactH: number }
const DEFAULT_NEEDS: NeedsHours = { batteryH: 72, contactH: 24 };
const MAX_HOURS = 365 * 24;
const clampHours = (hours: number) => Math.max(0, Math.min(MAX_HOURS, hours));
const shownDays = (hours: number) => String(Number((hours / 24).toFixed(1)));
const DAY_RANGES = [
  { days: 7, labels: 1, minorH: 2, stepH: 6 },
  { days: 14, labels: 2, minorH: 24, stepH: 12 },
  { days: 30, labels: 5, minorH: 24, stepH: 24 },
  { days: 60, labels: 10, minorH: 48, stepH: 24 },
  { days: 120, labels: 20, minorH: 120, stepH: 24 },
  { days: 365, labels: 50, minorH: 240, stepH: 24 },
] as const;
const fitRange = (hours: number) => Math.max(0, DAY_RANGES.findIndex(range => hours <= range.days * 24));
// Keep tick identities while the scale compresses, rather than replacing every mark on a range change.
const RULER_TICKS = [...new Set(DAY_RANGES.flatMap(range => [0, ...Array.from({ length: Math.floor(range.days * 24 / range.minorH) }, (_, i) => (i + 1) * range.minorH), range.days * 24]))].sort((a, b) => a - b);
const RULER_LABELS = [...new Set(DAY_RANGES.flatMap(range => Array.from({ length: Math.floor(range.days / range.labels) + 1 }, (_, i) => i * range.labels)))].sort((a, b) => a - b);

function saveNeeds(v: NeedsHours) {
  try {
    localStorage.setItem(NEEDS_KEY, JSON.stringify({ batteryH: isOn(v.batteryH) ? v.batteryH : null, contactH: isOn(v.contactH) ? v.contactH : null }));
  } catch { /* private mode */ }
}

/** Shared by the drawer and App's AI bridge. Infinity means this check is off. */
// oxlint-disable-next-line react/only-export-components
export function readNeeds(): { batteryH: number; contactH: number } {
  try {
    let v: unknown;
    try { v = JSON.parse(localStorage.getItem(NEEDS_KEY) ?? 'null'); } catch { /* try the old key */ }
    const valid = (h: unknown) => h === null || (typeof h === 'number' && Number.isFinite(h) && h >= 0 && h <= MAX_HOURS);
    if (v && typeof v === 'object' && 'batteryH' in v && 'contactH' in v && valid(v.batteryH) && valid(v.contactH)) {
      return { batteryH: v.batteryH === null ? Infinity : clampHours(v.batteryH as number), contactH: v.contactH === null ? Infinity : clampHours(v.contactH as number) };
    }
    const old = JSON.parse(localStorage.getItem(OLD_NEEDS_KEY) ?? 'null');
    if (Array.isArray(old) && old.length === 2 && old.every(x => Number.isInteger(x) && x >= 0 && x < 4)) {
      const migrated = { batteryH: BATTERY_OPTIONS[old[0]].hours, contactH: CONTACT_OPTIONS[old[1]].hours };
      saveNeeds(migrated);
      return migrated;
    }
  } catch { /* private mode or nothing saved yet */ }
  return { ...DEFAULT_NEEDS };
}

/** Up/down arrows move between the items of a small menu. */
function menuKeys(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  e.stopPropagation();
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
}

interface DayRulerProps {
  label: string;
  tip: string;
  dragging: boolean;
  value: number;
  onChange(hours: number): void;
  onDragging(held: boolean): void;
}

/** A small physical scale: hold and scrub, use the keys, or type exact days. */
function DayRuler({ label, tip, dragging, value, onChange, onDragging }: DayRulerProps) {
  const t = useT();
  const scale = useRef<HTMLDivElement>(null);
  const pointer = useRef<number | null>(null);
  const chosenHours = useRef(value);
  const [rangeIndex, setRangeIndex] = useState(() => fitRange(isOn(value) ? value : 0));
  const currentRange = useRef(rangeIndex);
  const edgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [heldAt, setHeldAt] = useState<number | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const draftEdited = useRef(false);
  const range = DAY_RANGES[rangeIndex], maxH = range.days * 24;
  const stopEdgeTimer = () => {
    if (edgeTimer.current !== null) clearTimeout(edgeTimer.current);
    edgeTimer.current = null;
  };
  useEffect(() => () => { if (edgeTimer.current !== null) clearTimeout(edgeTimer.current); }, []);
  const showRange = (index: number) => { currentRange.current = index; setRangeIndex(index); };
  const change = (hours: number, mayShrink = pointer.current === null) => {
    const index = currentRange.current;
    if (!isOn(hours)) { if (mayShrink) showRange(0); }
    else if (hours > DAY_RANGES[index].days * 24) showRange(fitRange(hours));
    // A wide scale only shrinks once the value is comfortably inside the next smaller one.
    else if (mayShrink && index > 0 && hours <= DAY_RANGES[index - 1].days * 24 * .8) showRange(fitRange(hours));
    chosenHours.current = hours;
    onChange(hours);
  };
  const stepHours = (wholeDays: boolean) => wholeDays ? 24 : DAY_RANGES[currentRange.current].stepH;
  const wheelChange = useEffectEvent((e: WheelEvent) => {
    if (!e.deltaY && !e.deltaX) return;
    e.preventDefault(); e.stopPropagation();
    setDraft(null);
    change(clampHours((isOn(chosenHours.current) ? chosenHours.current : 0) + ((e.deltaY || e.deltaX) > 0 ? 1 : -1) * stepHours(e.shiftKey)));
  });
  useEffect(() => {
    const el = scale.current;
    if (!el) return;
    // Native listener is needed: React's wheel handlers are passive.
    const scrubWheel = (e: WheelEvent) => wheelChange(e);
    el.addEventListener('wheel', scrubWheel, { passive: false });
    return () => el.removeEventListener('wheel', scrubWheel);
  }, []);
  const scrub = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left - 6) / Math.max(1, rect.width - 12)));
    const hours = frac * DAY_RANGES[currentRange.current].days * 24;
    const step = stepHours(e.shiftKey);
    const snapped = clampHours(Math.round(hours / step) * step);
    setHeldAt(hours);
    change(snapped, false);
    if (frac < .985) stopEdgeTimer();
    else if (currentRange.current < DAY_RANGES.length - 1 && edgeTimer.current === null) {
      // Holding against the end opens more room. Keep the value in place until the pointer moves,
      // so one steady hold cannot race through every range all the way to a year.
      edgeTimer.current = setTimeout(() => {
        edgeTimer.current = null;
        if (pointer.current !== null) showRange(Math.min(DAY_RANGES.length - 1, currentRange.current + 1));
      }, 350);
    }
    return snapped;
  };
  const release = (e: PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== e.pointerId) return;
    // The range may have grown while the pointer stayed still: do not remap that same position
    // to a different value on release. Pointer moves have already saved the last chosen value.
    stopEdgeTimer();
    pointer.current = null;
    setHeldAt(null);
    onDragging(false);
    change(chosenHours.current, true);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const commit = () => {
    const text = (draft ?? (isOn(value) ? shownDays(value) : '')).trim();
    const parsed = Number(text);
    // Leaving an unchanged, rounded display must not lose the quarter-day value underneath it.
    const next = text === '' ? Infinity : Number.isFinite(parsed) ? (!draftEdited.current ? chosenHours.current : clampHours(parsed * 24)) : value;
    setDraft(null);
    change(next);
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : 0;
    if (!dir && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault(); e.stopPropagation();
    change(e.key === 'Home' ? 0 : e.key === 'End' ? MAX_HOURS : clampHours((isOn(chosenHours.current) ? chosenHours.current : 0) + dir * stepHours(e.shiftKey)));
  };
  return (
    <div className={`cmp-need-controls${heldAt !== null ? ' held' : ''}`}>
      <div ref={scale} className="cmp-days-scale" role="slider" tabIndex={0} aria-label={label}
        aria-valuemin={0} aria-valuemax={365} aria-valuenow={isOn(value) ? value / 24 : 0}
        aria-valuetext={isOn(value) ? limitWords(value) : t('cmp.opt.off')} data-range-days={range.days}
        data-tip={dragging || heldAt !== null ? undefined : tip} data-tip-side="left" onKeyDown={keys}
        onPointerDown={e => {
          if (e.button !== 0 || pointer.current !== null) return;
          e.preventDefault();
          pointer.current = e.pointerId;
          // Focus fires before React paints the held state, so remove the tip first.
          e.currentTarget.removeAttribute('data-tip');
          e.currentTarget.focus({ preventScroll: true });
          e.currentTarget.setPointerCapture(e.pointerId);
          onDragging(true);
          setDraft(null);
          scrub(e);
        }}
        onPointerMove={e => { if (pointer.current === e.pointerId) scrub(e); }}
        onPointerUp={e => release(e)} onPointerCancel={e => release(e)} onLostPointerCapture={e => release(e)}>
        <div className="cmp-days-tape" aria-hidden="true">
          <svg viewBox="0 0 336 48" preserveAspectRatio="none">
            <g className="cmp-days-comb" style={{ transform: `scaleX(${336 / maxH})` }}>
              {RULER_TICKS.map(h => {
                const major = h % (range.labels * 24) === 0;
                const visible = h <= maxH && (h % range.minorH === 0 || h === maxH);
                const lift = heldAt === null ? 0 : Math.max(0, 1 - Math.abs(h - heldAt) / (maxH * .11));
                return <line key={h} x1={h} x2={h} y1={(major ? 12 : 18) - lift * 5} y2={36 + lift * 2}
                  className={`cmp-days-tick${major ? ' major' : ''}${isOn(value) && h <= value ? ' filled' : ''}${visible ? '' : ' cmp-days-tick-hidden'}`}
                  style={{ strokeWidth: (major ? 1.4 : 1) + lift * .4, filter: lift ? `brightness(${1 + lift * .6})` : undefined }} />;
              })}
            </g>
          </svg>
        </div>
        <span className="cmp-days-labels" aria-hidden="true">{RULER_LABELS.map(d => {
          const visible = d <= range.days && d % range.labels === 0;
          return <span key={d} className={`${d === range.days ? 'last ' : ''}${visible ? '' : 'cmp-days-label-hidden'}`} style={{ left: `${d / range.days * 100}%` }}>{d}</span>;
        })}</span>
      </div>
      <input className={`cmp-days-input${isOn(value) ? ' set' : ''}`} type="text" inputMode="decimal" autoComplete="off"
        aria-label={label} data-tip={dragging || heldAt !== null ? undefined : t('cmp.days.inputTip')} data-tip-side="left" placeholder={t('cmp.days.set')} value={draft ?? (isOn(value) ? shownDays(value) : '')}
        onFocus={e => { draftEdited.current = false; setDraft(e.currentTarget.value); e.currentTarget.select(); }}
        onChange={e => { draftEdited.current = true; setDraft(e.target.value); if (e.target.value.trim() === '') change(Infinity); }}
        onBlur={() => { if (cancelled.current) { cancelled.current = false; return; } commit(); }}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
          if (e.key === 'Escape') { e.preventDefault(); cancelled.current = true; setDraft(null); e.currentTarget.blur(); }
        }} />
    </div>
  );
}

/** One measure in the table: the number, its unit and a check or a cross. */
function Cell({ hours, need, check, what }: { hours: number; need: number; check: Check; what: string }) {
  const parts = hours === 0 ? null : durationParts(hours);
  const shown = parts ? `${parts.n} ${parts.unit}` : t('cmp.none');
  const tip = isOn(need) ? t('cmp.cell.tip', { what, value: shown, limit: limitWords(need) }) : t('cmp.cell.tipOff', { what, value: shown });
  const said = check === 'pass' ? t('cmp.cell.fits') : check === 'fail' ? t('cmp.cell.over') : '';
  return (
    <div className={`cmp-cell ${check}`} data-phone-label={what} role="img" aria-label={`${what}: ${shown}${said ? `, ${said}` : ''}.`} data-tip={tip}>
      <span className="cmp-val">
        {parts ? <>{parts.n}<small>{parts.unit}</small></> : <span className="cmp-none">{shown}</span>}
        {check === 'pass' && <Check className="cmp-mark" size={12} weight="bold" aria-hidden="true" />}
        {check === 'fail' && <X className="cmp-mark" size={12} weight="bold" aria-hidden="true" />}
      </span>
    </div>
  );
}

type DateMode = 'add' | 'change';

/** Short, whole units keep arrival gaps readable; distant landings show their actual date. */
function arrivalWords(startMs: number, baseMs: number): string | null {
  const gap = startMs - baseMs;
  if (!gap) return null;
  let minutes = Math.round(Math.abs(gap) / 60000);
  if (minutes > 62 * 1440) return fmtUtc(startMs);
  const units: { size: number; key: 'cmp.gap.week' | 'cmp.gap.day' | 'cmp.gap.hour' | 'cmp.gap.minute' }[] = [
    ...(minutes >= 14 * 1440 ? [{ size: 7 * 1440, key: 'cmp.gap.week' as const }] : []),
    { size: 1440, key: 'cmp.gap.day' }, { size: 60, key: 'cmp.gap.hour' }, { size: 1, key: 'cmp.gap.minute' },
  ];
  const parts: string[] = [];
  for (const unit of units) {
    const n = Math.floor(minutes / unit.size);
    if (n) parts.push(tn(unit.key, n));
    minutes %= unit.size;
  }
  return t(gap > 0 ? 'cmp.laterShort' : 'cmp.earlierShort', { delay: parts.join(' ') });
}

interface RowProps {
  plan: PlanResult;
  needs: Needs;
  baseStartMs: number;
  best: boolean;
  bestTip: string;
  open: boolean;
  attention: number;
  onToggle(): void;
  onFocus(): void;
  onDate(mode: DateMode, startMs: number): void;
  onStand(): void;
  onRemove(): void;
}

/** The same actions appear in the row menu and its opened detail. */
function actions(r: RowProps, ready: boolean, openDate: (mode: DateMode) => void) {
  return [
    { key: 'show', label: t('cmp.act.show'), tip: t('cmp.act.show.tip'), run: r.onFocus, off: false },
    { key: 'stand', label: t('cmp.act.stand'), tip: t('cmp.act.stand.tip'), run: r.onStand, off: !ready },
    { key: 'anotherDate', label: t('cmp.act.anotherDate'), tip: t('cmp.act.anotherDate.tip'), run: () => openDate('add'), off: false },
    { key: 'changeDate', label: t('cmp.act.changeDate'), tip: t('cmp.act.changeDate.tip'), run: () => openDate('change'), off: false },
    { key: 'remove', label: t('cmp.act.remove'), tip: t('cmp.act.remove.tip'), run: r.onRemove, off: false },
  ];
}

/** Reuse the time bar's calendar, but keep changes local until the user confirms. */
function LandingDatePicker({ item, mode, anchor, onConfirm, onClose }: {
  item: CompareItem; mode: DateMode; anchor: HTMLElement; onConfirm(startMs: number): void; onClose(): void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(() => Math.min(ARRIVAL_MAX, item.startMs + (mode === 'add' ? 3 * 86400000 : 0)));
  const editor = useRef<HTMLDivElement>(null);
  const title = t(mode === 'add' ? 'cmp.act.anotherDate' : 'cmp.act.changeDate');
  const confirm = () => {
    const input = editor.current?.querySelector<HTMLInputElement>('.dtp-field input');
    // The calendar applies typed text on Enter. Confirm must also honour text that has not been submitted yet.
    const typed = input?.value.trim() ? parseDate(input.value, draft) : null;
    if (typed && 'error' in typed) { input?.focus(); return; }
    onConfirm(typed && 'ms' in typed ? typed.ms : draft);
  };
  useEffect(() => {
    const closeOnListScroll = (e: Event) => { if (e.target instanceof Element && e.target.matches('.cmp-rows')) onClose(); };
    window.addEventListener('scroll', closeOnListScroll, true);
    return () => window.removeEventListener('scroll', closeOnListScroll, true);
  }, [onClose]);
  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-end" gap={0} label={title} className="dtp cmp-date-picker">
      <div ref={editor}>
        <h3 className="cmp-date-title">{title}</h3>
        <div className="cmp-date-quick">
          {[1, 3, 7, 14].map(days => (
            <button key={days} type="button" className="btn sm" disabled={item.startMs + days * 86400000 > ARRIVAL_MAX}
              onClick={() => onConfirm(item.startMs + days * 86400000)}>{tn('cmp.date.quick', days)}</button>
          ))}
        </div>
        <DateTimePicker value={draft} onChange={setDraft} tipSide="left" />
        <p className="cmp-date-value">{fmtUtc(draft)}</p>
        <div className="cmp-date-actions">
          <button type="button" className="btn ghost sm" onClick={onClose}>{t('cmp.date.cancel')}</button>
          <button type="button" className="btn primary sm" onClick={confirm}>{t(mode === 'add' ? 'cmp.date.add' : 'cmp.date.save')}</button>
        </div>
      </div>
    </Popover>
  );
}

/** The "…" button at the end of a row: every action, without opening the row. */
function RowMenu({ row, ready, openDate }: { row: RowProps; ready: boolean; openDate(mode: DateMode): void }) {
  const [open, setOpen] = useState(false);
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null);
  const label = t('cmp.more', { letter: row.plan.item.letter });
  return (
    <>
      <button ref={setBtn} type="button" className="ibtn sm cmp-more" aria-label={label} data-tip={open ? undefined : label} aria-haspopup="menu" aria-expanded={open}
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}>
        <DotsThree size={18} weight="bold" aria-hidden="true" />
      </button>
      {open && btn && (
        <Popover anchor={btn} onClose={() => setOpen(false)} placement="bottom-end" label={label} className="menu cmp-menu">
          <div role="menu" aria-label={label} onKeyDown={menuKeys}>
            {actions(row, ready, openDate).map(a => (
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
  const { plan, needs, baseStartMs, best, open } = r;
  const { item, facts, entry, timeline } = plan;
  const name = item.label.replace(/ \(\+\d+ days\)$/, ''); // the later arrival gets its own words below
  const s = facts?.stats;
  const when = arrivalWords(item.startMs, baseStartMs);
  const line = planLine(plan, needs);
  const detailId = `cmp-detail-${item.id}`;
  const rowEl = useRef<HTMLDivElement>(null);
  const [dateMode, setDateMode] = useState<DateMode | null>(null);
  const [dateAnchor, setDateAnchor] = useState<HTMLSpanElement | null>(null);
  const returnFocus = () => rowEl.current?.querySelector<HTMLButtonElement>('.cmp-more')?.focus({ preventScroll: true });
  const closeDate = () => { setDateMode(null); returnFocus(); };
  useEffect(() => {
    if (!r.attention) return;
    const row = rowEl.current, list = row?.closest<HTMLElement>('.cmp-rows');
    if (row && list) list.scrollBy({ top: row.getBoundingClientRect().top - list.getBoundingClientRect().top, behavior: 'instant' });
    row?.classList.add('cmp-flash');
    const timer = setTimeout(() => row?.classList.remove('cmp-flash'), 1800);
    return () => { clearTimeout(timer); row?.classList.remove('cmp-flash'); };
  }, [r.attention]);
  // Scroll only the plan list, so opening a long row never moves the two rulers above it.
  useEffect(() => {
    const row = rowEl.current, list = row?.closest<HTMLElement>('.cmp-rows');
    if (!open || !row || !list) return;
    const r = row.getBoundingClientRect(), b = list.getBoundingClientRect();
    const delta = r.height > b.height || r.top < b.top ? r.top - b.top : Math.max(0, r.bottom - b.bottom);
    if (delta) list.scrollBy({ top: delta, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [open]);

  return (
    <div ref={rowEl} className={`cmp-row${best ? ' best' : ''}${open ? ' open' : ''}`} role="listitem"
      data-plan-id={item.id} data-start-ms={item.startMs}>
      <div className="cmp-who">
        <span className="cmp-badge" style={{ '--plan-colour': item.color } as CSSProperties} aria-hidden="true">{item.letter}</span>
        <div className="cmp-text">
          <button type="button" className="cmp-who-toggle" aria-expanded={open} aria-controls={detailId} onClick={r.onToggle}
            aria-label={`${t('cmp.row', { letter: item.letter, name })}${best ? `, ${t('cmp.best')}` : ''}`} data-tip={t('cmp.lands', { date: fmtUtc(item.startMs) })}>
            <span className="cmp-name">{name}{best && <span className="cmp-best" data-tip={r.bestTip}>{t('cmp.best')}</span>}</span>
          </button>
          {when && <button type="button" className="cmp-when" onClick={() => setDateMode('change')}
            aria-label={t('cmp.date.when', { letter: item.letter, when })} data-tip={t('cmp.date.when.tip', { date: fmtUtc(item.startMs) })} data-tip-side="left">{when}</button>}
        </div>
      </div>
      {/* The shared popover opens below an anchor. This edge anchor keeps it beside the drawer,
          without changing the calendar or the time bar's placement. Escape returns to the row menu. */}
      <span ref={setDateAnchor} className="cmp-date-anchor" tabIndex={-1} onFocus={returnFocus} />
      {dateMode && dateAnchor && <LandingDatePicker key={dateMode} item={item} mode={dateMode} anchor={dateAnchor} onClose={closeDate}
        onConfirm={ms => { closeDate(); r.onDate(dateMode, ms); }} />}

      {s ? (
        <>
          <div className="cmp-cell-hit" onClick={r.onToggle}>
            <Cell hours={s.longestDarkH} need={needs.battery} check={plan.battery} what={t('cmp.col.dark')} />
          </div>
          <div className="cmp-cell-hit" onClick={r.onToggle}>
            <Cell hours={s.longestNoEarthH} need={needs.contact} check={plan.contact} what={t('cmp.col.earth')} />
          </div>
        </>
      ) : entry?.status === 'error' ? (
        <div className="cmp-msg bad" data-tip={entry.message}><WarningCircle size={14} weight="fill" aria-hidden="true" />{t('cmp.error')}</div>
      ) : (
        <div className="cmp-msg"><span className="spinner" aria-hidden="true" />{t('cmp.working')}</div>
      )}

      <RowMenu row={r} ready={!!facts} openDate={setDateMode} />

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
            {actions(r, !!facts, setDateMode).map(a => (
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
  const [hours, setHours] = useState<NeedsHours>(readNeeds);
  const currentHours = useRef(hours);
  const dirty = useRef(false);
  const savedAt = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [attention, setAttention] = useState({ id: '', count: 0 });
  const [dateMessage, setDateMessage] = useState('');
  const flushNeeds = () => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (!dirty.current) return;
    saveNeeds(currentHours.current);
    dirty.current = false;
    savedAt.current = Date.now();
  };
  useEffect(() => () => flushNeeds(), []);
  const setNeed = (key: keyof NeedsHours, value: number) => {
    const next = { ...currentHours.current, [key]: value };
    currentHours.current = next;
    dirty.current = true;
    setHours(next);
    const wait = 120 - (Date.now() - savedAt.current);
    if (!held.current || wait <= 0) flushNeeds();
    else if (saveTimer.current === null) saveTimer.current = setTimeout(flushNeeds, wait);
  };
  const setHeld = (active: boolean) => {
    held.current = active;
    setDragging(active);
    if (!active) flushNeeds();
  };
  const needs: Needs = { battery: hours.batteryH, contact: hours.contactH };
  const ev = evaluate(p.items, p.entries, needs);
  const answer = answerFor(ev, needs);
  const nextLetter = planLetter(nextPlanIndex(p.items));
  const root = useReachesControls(r => p.onReach?.(r));
  // (on a phone, plans to compare open the sheet at full height: the cards are the point of it)
  const sheet = usePhoneSheet(root, true, undefined, p.items.length > 0);
  const empty = p.items.length === 0;
  const canAdd = p.canAddCurrent && !!p.currentLabel;

  const showAnswer = !empty && answer.best.size === 0;
  const sharedLanding = !empty && p.items.every(item => item.startMs === p.items[0].startMs);
  const pickDate = (item: CompareItem, mode: DateMode, ms: number) => {
    const startMs = Math.min(ARRIVAL_MAX, Math.max(ARRIVAL_MIN, Math.round(ms / 60000) * 60000));
    const existing = p.items.find(other => (mode === 'add' || other.id !== item.id) && sameSpot(other, item) && other.startMs === startMs);
    if (existing) {
      setAttention(previous => ({ id: existing.id, count: previous.count + 1 }));
      setDateMessage(t('cmp.date.exists', { letter: existing.letter }));
      return;
    }
    setDateMessage('');
    if (mode === 'add') p.onAddDate(item, startMs);
    else p.onChangeDate(item, startMs);
  };

  return (
    <aside ref={root} className={`drawer panel cmp${dragging ? ' cmp-scrubbing' : ''}${sheet.className}`} aria-label={t('cmp.aria')}>
      <PhoneSheetHandle sheet={sheet} />
      <header className="drawer-head">
        <h2>{t('cmp.title')}</h2>
        {!empty && <span className="drawer-sub">{tn('cmp.count', p.items.length)}</span>}
        <span className="drawer-gap" />
        <IconButton size="sm" label={t('cmp.close')} onClick={p.onClose}><X size={16} /></IconButton>
      </header>

      {sheet.phone && (empty || canAdd) && <div className="phone-sheet-summary">
        {empty && <p>{t('cmp.empty')}</p>}
        {canAdd && <button type="button" className="btn primary" onClick={() => { p.onAddCurrent(); sheet.setExpanded(true); }}>
          <Plus size={18} />{t('cmp.addSelected')}
        </button>}
      </div>}
      <div className="drawer-body">
        <section className="cmp-needs" aria-labelledby="cmp-robot-title">
          <h3 className="cmp-section-title" id="cmp-robot-title">{t('cmp.needs')} <span className="cmp-section-hint">{t('cmp.needs.hint')}</span></h3>
          <div className="cmp-need">
            <p className="cmp-need-label">
              {t('cmp.battery.label')} <span>{t('cmp.days.unit')}</span>
              <small> · {t('cmp.battery.hint')}</small>
            </p>
            <DayRuler label={`${t('cmp.battery.label')} ${t('cmp.days.unit')}`} tip={t('cmp.battery.tip')} dragging={dragging} value={hours.batteryH} onChange={v => setNeed('batteryH', v)} onDragging={setHeld} />
          </div>
          <div className="cmp-need">
            <p className="cmp-need-label">
              {t('cmp.contact.label')} <span>{t('cmp.days.unit')}</span>
            </p>
            <DayRuler label={`${t('cmp.contact.label')} ${t('cmp.days.unit')}`} tip={t('cmp.contact.tip')} dragging={dragging} value={hours.contactH} onChange={v => setNeed('contactH', v)} onDragging={setHeld} />
          </div>
        </section>

        <section className="cmp-table" aria-labelledby="cmp-comparison-title">
          <h3 className="cmp-section-title" id="cmp-comparison-title">{t('cmp.comparison')}{sharedLanding && <span className="cmp-section-hint cmp-landing">{fmtUtcShort(p.items[0].startMs)}</span>}</h3>
          <p className="sr-only" aria-live="polite" aria-atomic="true">{answer.text}</p>
          <p className="sr-only" aria-live="polite">{dateMessage}</p>
          {showAnswer && <p className="cmp-answer-secondary">{answer.text}</p>}
          {empty ? (
            <div className="cmp-empty">
              <p className="cmp-intro">{t('cmp.empty')}</p>
              <button type="button" className="btn primary" onClick={p.onAddCurrent} disabled={!canAdd}
                data-tip={canAdd ? t('cmp.addAs', { name: p.currentLabel ?? '', letter: nextLetter }) : t('cmp.addHint')}>
                <Plus size={16} weight="bold" aria-hidden="true" />{t('cmp.addSelected')}
              </button>
              <p className="cmp-hint">{canAdd ? p.currentLabel : t('cmp.addHint')}</p>
            </div>
          ) : <>
            <div className="cmp-thead">
              <span className="cmp-th">{t('cmp.col.plan')}</span>
              <span className="cmp-th" tabIndex={0} data-tip={t('cmp.col.dark.tip')}><span>{t('cmp.col.dark')}</span></span>
              <span className="cmp-th" tabIndex={0} data-tip={t('cmp.col.earth.tip')}><span>{t('cmp.col.earth')}</span></span>
            </div>
            <div className="cmp-rows" role="list">
              {ev.plans.map(plan => (
                <PlanRow key={plan.item.id} plan={plan} needs={needs} baseStartMs={p.items[0].startMs} best={answer.best.has(plan.item.id)} bestTip={answer.text}
                  open={openId === plan.item.id} attention={attention.id === plan.item.id ? attention.count : 0} onToggle={() => setOpenId(id => (id === plan.item.id ? null : plan.item.id))}
                  onFocus={() => p.onFocus(plan.item)} onDate={(mode, ms) => pickDate(plan.item, mode, ms)} onStand={() => p.onStand(plan.item)} onRemove={() => p.onRemove(plan.item.id)} />
              ))}
            </div>
            {canAdd ? (
              <button type="button" className="btn ghost sm cmp-add" onClick={p.onAddCurrent} data-tip={t('cmp.addAs', { name: p.currentLabel ?? '', letter: nextLetter })}>
                <Plus size={14} weight="bold" aria-hidden="true" /><span>{t('cmp.addAs', { name: p.currentLabel ?? '', letter: nextLetter })}</span>
              </button>
            ) : <p className="cmp-hint">{t('cmp.pickHint')}</p>}
          </>}
        </section>
      </div>
    </aside>
  );
}
