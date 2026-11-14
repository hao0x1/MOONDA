// How the AI panel shows the agent at work: one collapsible timeline per answer ("Worked for 41 s ·
// 6 steps"), a node per step on a connecting line (thinking, each tool call with a live progress
// bar), and for every tool what went in and what came back, drawn as small tables, metric tiles
// and a scan map instead of raw JSON. Also the results table under an answer.

import {
  ArrowUpRight, Brain, CaretDown, ChartLineUp, Check, Crosshair, Gear, ListBullets, MagnifyingGlass, MapPin,
  Scales, Sparkle, Stop, X,
} from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t, tMaybe, tn, useT, type Key } from '../i18n';
import type { Block } from '../ai/history';

type ToolBlock = Extract<Block, { kind: 'tool' }>;
type ThinkBlock = Extract<Block, { kind: 'think' }>;
export type StepBlock = ToolBlock | ThinkBlock;

export interface SpotResult {
  label: string; lat: number; lon: number; arrival_utc: string; mission_days: number; panel_height_m: number;
  ground_height_m: number; distance_from_south_pole_km: number; near: string | null;
  sunlight_pct: number; longest_dark_hours: number; earth_in_view_pct: number; longest_without_earth_hours: number;
  battery_need_hours: number | string; contact_need_hours: number | string; meets_battery_need: boolean; meets_contact_need: boolean;
  nasa_polar_maps: Record<string, number> | string; detail: string; rank?: number;
}

/* ---------- small helpers ---------- */

const fmtH = (h: number) => (!Number.isFinite(h) || h <= 0 ? t('aitool.none') : h < 48 ? t('aitool.hours', { n: Math.round(h) }) : t('aitool.daysShort', { n: (h / 24).toFixed(1) }));
const fmtLimitH = (h: number) => `${h} ${t('unit.h')}`;
const fmtMs = (ms: number) => (ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
const fmtLL = (lat: number, lon: number) => `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'} ${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`;
function coords(a: Record<string, unknown>) {
  const lat = Number(a.lat), lon = Number(a.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? fmtLL(lat, lon) : t('aitool.aSpot');
}
const isSpot = (r: unknown): r is SpotResult => !!r && typeof r === 'object' && typeof (r as SpotResult).sunlight_pct === 'number';
export const spotScore = (r: SpotResult) => (r.meets_battery_need ? 1000 : 0) + (r.meets_contact_need ? 500 : 0) + r.sunlight_pct + 0.5 * r.earth_in_view_pct - r.longest_dark_hours / 24;
function km(aLat: number, aLon: number, bLat: number, bLon: number) {
  const D = Math.PI / 180, s1 = Math.sin(((bLat - aLat) * D) / 2), s2 = Math.sin(((bLon - aLon) * D) / 2);
  return 2 * 1737.4 * Math.asin(Math.sqrt(s1 * s1 + Math.cos(aLat * D) * Math.cos(bLat * D) * s2 * s2));
}

export function useNow(on: boolean, every = 200) {
  const [, tick] = useState(0);
  useEffect(() => { if (!on) return; const t = setInterval(() => tick(x => x + 1), every); return () => clearInterval(t); }, [on, every]);
  return Date.now();
}

/* ---------- what each tool looks like ---------- */

/** The title of a step: "Checking X" while it runs, "Checked X" once it is done. */
const verb = (tool: string, vars?: (a: Record<string, unknown>) => Record<string, string | number>) =>
  (a: Record<string, unknown>, done: boolean) => t(`aitool.${tool}.${done ? 'done' : 'doing'}` as Key, vars?.(a));
const spotName = (a: Record<string, unknown>) => ({ name: String(a.label || coords(a)) });

export const TOOL_LOOK: Record<string, { icon: typeof Sparkle; verb(a: Record<string, unknown>, done: boolean): string }> = {
  get_mission_settings: { icon: Gear, verb: verb('settings') },
  list_candidate_sites: { icon: ListBullets, verb: verb('list') },
  search_moon_names: { icon: MagnifyingGlass, verb: verb('search', a => ({ q: String(a.query ?? '') })) },
  analyse_spot: { icon: ChartLineUp, verb: verb('check', spotName) },
  scan_area: { icon: Crosshair, verb: verb('scan', a => ({ n: Math.round(Number(a.points) || 10), ...spotName(a) })) },
  show_on_map: { icon: MapPin, verb: verb('show', spotName) },
  add_to_compare: { icon: Scales, verb: verb('add', spotName) },
};
const look = (name: string) => TOOL_LOOK[name] ?? { icon: Sparkle, verb: () => name };

const ARG_NAMES: Record<string, Key> = { lat: 'aitool.arg.lat', lon: 'aitool.arg.lon', radius_km: 'aitool.arg.radius', points: 'aitool.arg.points', label: 'aitool.arg.name', query: 'aitool.arg.search', limit: 'aitool.arg.max', days: 'aitool.arg.days', arrival_utc: 'aitool.arg.arrive', kinds: 'aitool.arg.kinds' };
/** How carefully a spot was calculated, in the user's language (the stored text is the English the AI was given). */
const detailText = (d: string) => (d.startsWith('quick') ? t('aitool.detail.quick') : d.startsWith('full') ? t('aitool.detail.full') : d.startsWith('coarse') ? t('aitool.detail.coarse') : d);
function Args({ args }: { args: Record<string, unknown> }) {
  const entries = Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return null;
  return (
    <div className="ai-args">
      {entries.map(([k, v]) => {
        let s = Array.isArray(v) ? v.join(', ') : typeof v === 'number' ? (k === 'lat' || k === 'lon' ? v.toFixed(3) : String(v)) : String(v);
        if (k === 'radius_km') s += ' km';
        return <span key={k}><b>{ARG_NAMES[k] ? t(ARG_NAMES[k]) : k}</b>{s.length > 40 ? `${s.slice(0, 38)}…` : s}</span>;
      })}
    </div>
  );
}

function Bar({ pct }: { pct: number }) {
  return <span className="ai-bar"><i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></span>;
}
function Need({ ok, label }: { ok: boolean; label: string }) {
  return <span className={`ai-chip ${ok ? 'good' : 'bad'}`}>{ok ? <Check size={10} weight="bold" /> : <X size={10} weight="bold" />}{label}</span>;
}

/** The four numbers of one spot as tiles. */
function SpotTiles({ r }: { r: SpotResult }) {
  const maps = typeof r.nasa_polar_maps === 'object' ? r.nasa_polar_maps : null;
  return (
    <>
      <div className="ai-tiles">
        <div className="ai-tile"><small>{t('stat.sunlight')}</small><b>{r.sunlight_pct}%</b><Bar pct={r.sunlight_pct} /></div>
        <div className="ai-tile"><small>{t('stat.dark')}</small><b>{fmtH(r.longest_dark_hours)}</b><span className="ai-tile-note">{t('aitool.batteryNeed', { time: typeof r.battery_need_hours === 'number' ? fmtLimitH(r.battery_need_hours) : t('aitool.any') })}</span></div>
        <div className="ai-tile"><small>{t('stat.earth')}</small><b>{r.earth_in_view_pct}%</b><Bar pct={r.earth_in_view_pct} /></div>
        <div className="ai-tile"><small>{t('stat.noEarth')}</small><b>{fmtH(r.longest_without_earth_hours)}</b><span className="ai-tile-note">{t('aitool.radioNeed', { time: typeof r.contact_need_hours === 'number' ? fmtLimitH(r.contact_need_hours) : t('aitool.any') })}</span></div>
      </div>
      <div className="ai-chips">
        <Need ok={r.meets_battery_need} label={t('aitool.battery')} />
        <Need ok={r.meets_contact_need} label={t('aitool.radio')} />
        {maps?.slope_deg !== undefined && <span className={`ai-chip ${maps.slope_deg <= 10 ? 'neutral' : 'bad'}`}>{t('aitool.slope', { deg: maps.slope_deg })}</span>}
        {maps?.permanently_shadowed !== undefined && maps.permanently_shadowed > 0.5 && <span className="ai-chip neutral">{t('aitool.permShadow')}</span>}
        {maps?.hottest_K !== undefined && <span className="ai-chip neutral">{t('aitool.max', { c: Math.round(maps.hottest_K - 273) })}</span>}
      </div>
      <dl className="ai-kv">
        <dt>{t('aitool.where')}</dt><dd>{fmtLL(r.lat, r.lon)}{r.near ? ` · ${t('aitool.near', { name: r.near })}` : ''}</dd>
        <dt>{t('aitool.ground')}</dt><dd>{r.ground_height_m.toLocaleString('en-US')} m · {t('aitool.fromPole', { km: r.distance_from_south_pole_km })}</dd>
        <dt>{t('aitool.detail')}</dt><dd>{detailText(r.detail)}</dd>
      </dl>
    </>
  );
}

/** Where the scanned points were, seen from above, brightest = best. */
function ScanMap({ lat0, lon0, ranked }: { lat0: number; lon0: number; ranked: SpotResult[] }) {
  const D = Math.PI / 180;
  const v = (la: number, lo: number) => [Math.cos(la * D) * Math.cos(lo * D), Math.cos(la * D) * Math.sin(lo * D), Math.sin(la * D)];
  const c = v(lat0, lon0);
  let e = [-c[1], c[0], 0];
  const en = Math.hypot(e[0], e[1]);
  e = en < 1e-6 ? [0, 1, 0] : [e[0] / en, e[1] / en, 0];
  const n = [c[1] * e[2] - c[2] * e[1], c[2] * e[0] - c[0] * e[2], c[0] * e[1] - c[1] * e[0]];
  const xy = ranked.map(r => { const q = v(r.lat, r.lon); return [(q[0] * e[0] + q[1] * e[1] + q[2] * e[2]) * 1737.4, (q[0] * n[0] + q[1] * n[1] + q[2] * n[2]) * 1737.4]; });
  const far = Math.max(1, ...xy.map(([x, y]) => Math.hypot(x, y)));
  const s = 46 / far;
  return (
    <svg className="ai-scanmap" viewBox="-60 -60 120 120" aria-hidden="true">
      <circle r="23" className="ring" /><circle r="46" className="ring" />
      <line x1="-54" x2="54" className="ring" /><line y1="-54" y2="54" className="ring" />
      {ranked.map((r, i) => {
        const [x, y] = xy[i];
        const k = 1 - i / Math.max(1, ranked.length - 1);
        return (
          <g key={i} transform={`translate(${(x * s).toFixed(1)} ${(-y * s).toFixed(1)})`}>
            {i === 0 && <circle r="8.5" className="best" />}
            <circle r={2.4 + (r.sunlight_pct / 100) * 2.6} style={{ opacity: 0.28 + 0.72 * k }} className="pt" />
          </g>
        );
      })}
      <text x="-56" y="-50">N</text>
    </svg>
  );
}

function ToolOutput({ b }: { b: ToolBlock }) {
  const r = b.result as Record<string, unknown> | unknown[] | undefined;
  if (!r) return null;
  switch (b.name) {
    case 'analyse_spot': return isSpot(r) ? <SpotTiles r={r} /> : null;
    case 'scan_area': {
      const ranked = (r as { ranked?: SpotResult[] }).ranked ?? [];
      if (!ranked.length) return null;
      return (
        <div className="ai-scan">
          <ScanMap lat0={Number(b.args.lat)} lon0={Number(b.args.lon)} ranked={ranked} />
          <ol className="ai-mini">
            {ranked.slice(0, 5).map((x, i) => (
              <li key={i}><span className="ai-rank">{i + 1}</span><span className="ai-mini-name">{Math.abs(x.lat).toFixed(2)}°{x.lat < 0 ? 'S' : 'N'} {Math.abs(x.lon).toFixed(1)}°{x.lon < 0 ? 'W' : 'E'}</span><span>☀ {Math.round(x.sunlight_pct)}%</span><span>⊕ {Math.round(x.earth_in_view_pct)}%</span></li>
            ))}
          </ol>
        </div>
      );
    }
    case 'get_mission_settings': {
      const m = r as Record<string, unknown>;
      return (
        <dl className="ai-kv">
          <dt>{t('aitool.arrive')}</dt><dd>{new Date(String(m.arrival_utc)).toUTCString().slice(5, 22)} UTC</dd>
          <dt>{t('aitool.mission')}</dt><dd>{t('aitool.missionLine', { days: String(m.mission_days), m: String(m.panel_height_m) })}</dd>
          <dt>{t('aitool.battery')}</dt><dd>{typeof m.battery_survives_darkness_hours === 'number' ? t('aitool.batteryLasts', { time: fmtLimitH(m.battery_survives_darkness_hours) }) : t('aitool.noLimit')}</dd>
          <dt>{t('aitool.radio')}</dt><dd>{typeof m.ok_without_earth_hours === 'number' ? t('aitool.radioOk', { time: fmtLimitH(m.ok_without_earth_hours) }) : t('aitool.noLimit')}</dd>
        </dl>
      );
    }
    case 'list_candidate_sites':
    case 'search_moon_names': {
      const list = (Array.isArray(r) ? r : []) as { name: string; kind: string; lat: number; lon: number; diameter_km?: number }[];
      if (!list.length) return <div className="ai-muted">{t('aitool.nothing')}</div>;
      return (
        <ul className="ai-list">
          {list.slice(0, 8).map((x, i) => (
            <li key={i}><span className="ai-list-name">{x.name}</span><span className="ai-tag">{tMaybe(`kind.${x.kind}`, x.kind)}</span><span className="ai-list-ll">{fmtLL(x.lat, x.lon)}</span></li>
          ))}
          {list.length > 8 && <li className="ai-muted">{t('aitool.more', { n: list.length - 8 })}</li>}
        </ul>
      );
    }
    default: return null;
  }
}

/** The short line under a finished step (always visible). */
/** The live line under a running tool: what it is doing, and for scans a thin bar "7 of 12". */
function Running({ b }: { b: ToolBlock }) {
  const m = /(\d+)\D+(\d+)/.exec(b.progress); // "spot 7 of 12…" in any language: the two numbers
  const text = b.progress.replace(/…$/, '');
  return (
    <div className="ai-run-line">
      {text && <span className="ai-step-sum">{m ? t('aitool.nOfM', { i: m[1], n: m[2] }) : text}</span>}
      <span className={`ai-bar run${m ? '' : ' indet'}`}><i style={m ? { width: `${(100 * (Number(m[1]) - 1)) / Number(m[2])}%` } : undefined} /></span>
    </div>
  );
}

/** The short line under a finished step (always visible). */
function Inline({ b }: { b: ToolBlock }) {
  if (b.status === 'stopped' || b.status === 'run') return null;
  if (b.status === 'fail') return <div className="ai-step-sum bad">{b.summary}</div>;
  if (b.name === 'analyse_spot' && isSpot(b.result)) {
    const r = b.result;
    return (
      <div className="ai-pills">
        <span>☀ <b>{r.sunlight_pct}%</b></span><span>{t('aitool.dark')} <b>{fmtH(r.longest_dark_hours)}</b></span><span>⊕ <b>{r.earth_in_view_pct}%</b></span>
        <span className={r.meets_battery_need && r.meets_contact_need ? 'good' : 'bad'}>{r.meets_battery_need && r.meets_contact_need ? <Check size={10} weight="bold" /> : <X size={10} weight="bold" />}{t('aitool.needs')}</span>
      </div>
    );
  }
  if (b.name === 'scan_area') {
    const ranked = (b.result as { ranked?: SpotResult[] } | undefined)?.ranked;
    if (ranked?.length) {
      const top = ranked[0];
      return (
        <div className="ai-pills">
          <span><b>{ranked.length}</b> {t('aitool.spots')}</span><span>{t('aitool.best')} ☀ <b>{Math.round(top.sunlight_pct)}%</b></span><span>{t('aitool.dark')} <b>{fmtH(top.longest_dark_hours)}</b></span><span>⊕ <b>{Math.round(top.earth_in_view_pct)}%</b></span>
        </div>
      );
    }
  }
  if (b.name === 'show_on_map') return null; // the title says it all
  return b.summary ? <div className="ai-step-sum">{b.summary}</div> : null;
}

/** The small state icon at the start of a step. */
function StepIcon({ b, live }: { b: StepBlock; live: boolean }) {
  if (b.kind === 'think') return <span className={`ai-node think${live ? ' run' : ''}`}><Brain size={14} weight={live ? 'fill' : 'regular'} /></span>;
  if (b.status === 'run' && live) return <span className="ai-node run"><span className="ai-spin" /></span>;
  if (b.status === 'fail') return <span className="ai-node fail"><X size={12} weight="bold" /></span>;
  if (b.status === 'stopped' || b.status === 'run') return <span className="ai-node stopped"><Stop size={11} weight="fill" /></span>;
  const I = look(b.name).icon;
  return <span className="ai-node ok"><I size={14} /></span>;
}

function ToolStep({ b, live }: { b: ToolBlock; live: boolean }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  const L = look(b.name);
  const running = live && b.status === 'run';
  const now = useNow(running, 100);
  const expandable = !running && (Object.keys(b.args).length > 0 || !!b.result);
  const ms = running ? now - b.t0 : b.ms;
  return (
    <li className={`ai-step tool ${running ? 'run' : b.status}`}>
      <StepIcon b={b} live={live} />
      <div className="ai-step-main">
        <button type="button" className="ai-step-head" onClick={() => expandable && setOpen(o => !o)} aria-expanded={expandable ? open : undefined} data-tip={expandable ? t(open ? 'ai.tip.hideStep' : 'ai.tip.showStep') : undefined} disabled={!expandable}>
          <span className="ai-step-title">{L.verb(b.args, !running)}</span>
          {expandable && <CaretDown size={12} weight="bold" className={`ai-caret${open ? ' up' : ''}`} />}
          <span className="ai-step-meta">{fmtMs(ms)}</span>
        </button>
        {running ? <Running b={b} /> : <Inline b={b} />}
        {open && (
          <div className="ai-detail">
            <div className="ai-io"><span>{t('ai.input')}</span><Args args={b.args} /></div>
            {b.result !== undefined && b.status === 'ok' && <div className="ai-io out"><span>{t('ai.result')}</span><div className="ai-out"><ToolOutput b={b} /></div></div>}
          </div>
        )}
      </div>
    </li>
  );
}

/** The latest sentence of the thinking, on one line. When it is wider than the row, the start
 *  fades out so the newest words stay in view (whole letters only: no clipping top or bottom). */
function ThinkPeek({ text }: { text: string }) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const cut = Math.max(flat.lastIndexOf('. ', flat.length - 30), flat.lastIndexOf('\n'));
  const line = (cut > 0 ? flat.slice(cut + 2) : flat).slice(-240);
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    if (box.current && inner.current) setOver(inner.current.offsetWidth > box.current.clientWidth);
  }, [line]);
  if (!line) return null;
  return <div ref={box} className={`ai-think-peek${over ? ' over' : ''}`} aria-hidden="true"><span ref={inner}>{line}</span></div>;
}

function ThinkStep({ b, live }: { b: ThinkBlock; live: boolean }) {
  const t = useT();
  const thinking = live && b.t1 === null;
  const [open, setOpen] = useState(false);
  const now = useNow(thinking, 100);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open && thinking && box.current) box.current.scrollTop = box.current.scrollHeight; }, [b.text, open, thinking]);
  const ms = (thinking ? now : b.t1 ?? b.seen ?? b.t0) - b.t0;
  const title = thinking ? t('ai.thinking') : ms < 900 ? t('ai.thoughtBriefly') : t('ai.thoughtFor', { time: fmtMs(ms) });
  return (
    <li className={`ai-step think${thinking ? ' run' : ' ok'}`}>
      <StepIcon b={b} live={thinking} />
      <div className="ai-step-main">
        <button type="button" className="ai-step-head" onClick={() => setOpen(o => !o)} aria-expanded={open} data-tip={b.text ? t(open ? 'ai.tip.hideThinking' : 'ai.tip.showThinking') : undefined} disabled={!b.text}>
          <span className={`ai-step-title${thinking ? ' ai-shimmer' : ''}`}>{title}</span>
          {b.text && <CaretDown size={12} weight="bold" className={`ai-caret${open ? ' up' : ''}`} />}
          {thinking && <span className="ai-step-meta">{fmtMs(ms)}</span>}
        </button>
        {open ? <div ref={box} className="ai-think-text" tabIndex={0}>{b.text.trim()}</div> : thinking && <ThinkPeek text={b.text} />}
      </div>
    </li>
  );
}

/** One answer's worth of steps. Open while working, folds into one line when the answer starts. */
export function Trace({ steps, live, t0, end }: { steps: StepBlock[]; live: boolean; t0: number; end?: 'stopped' | 'interrupted' }) {
  const t = useT();
  const [pref, setPref] = useState<boolean | null>(null);
  const open = pref ?? live;
  const now = useNow(live, 250);
  const tools = steps.filter((s): s is ToolBlock => s.kind === 'tool');
  const stepEnd = (s: StepBlock) => (s.kind === 'think' ? s.t1 ?? (live ? now : s.seen ?? s.t0) : s.status === 'run' && live ? now : s.t0 + s.ms);
  const last = Math.max(t0, ...steps.map(stepEnd));
  const current = live ? [...steps].reverse().find(s => (s.kind === 'tool' ? s.status === 'run' : s.t1 === null)) : undefined;
  const failed = tools.filter(x => x.status === 'fail').length;
  const time = fmtMs(last - t0);
  let title: ReactNode;
  if (live) title = <><span className="ai-shimmer">{t('ai.working')}</span>{current && <span className="ai-trace-now"> · {current.kind === 'think' ? t('ai.thinking').toLowerCase() : look(current.name).verb(current.args, false)}</span>}</>;
  else title = <>{end ? t('ai.stoppedAfter', { time }) : t('ai.workedFor', { time })}<span className="ai-trace-now"> · {tools.length ? tn('ai.tools', tools.length) : t('ai.thinkingOnly')}{failed ? ` · ${tn('ai.problems', failed)}` : ''}</span></>;
  return (
    <div className={`ai-trace${live ? ' live' : ''}${open ? ' open' : ''}`}>
      <button type="button" className="ai-trace-head" onClick={() => setPref(!open)} aria-expanded={open} data-tip={t(open ? 'ai.tip.hideTrace' : 'ai.tip.showTrace')}>
        <span className="ai-trace-title">{title}</span>
        <CaretDown size={12} weight="bold" className={`ai-caret${open ? ' up' : ''}`} />
        {live && <span className="ai-step-meta">{time}</span>}
      </button>
      {open && (
        <ol className="ai-tl">
          {steps.map((s, i) => (s.kind === 'think'
            ? <ThinkStep key={`t${i}`} b={s} live={live} />
            : <ToolStep key={s.id || `x${i}`} b={s} live={live} />))}
        </ol>
      )}
    </div>
  );
}

/* ---------- the results table under an answer ---------- */

export function spotRows(blocks: Block[]) {
  const rows: SpotResult[] = [];
  let pick: { lat: number; lon: number } | null = null;
  let quick = false;
  for (const b of blocks) {
    if (b.kind !== 'tool' || b.status !== 'ok') continue;
    if (b.name === 'analyse_spot' && isSpot(b.result)) {
      const r = b.result;
      const i = rows.findIndex(x => km(x.lat, x.lon, r.lat, r.lon) < 0.05);
      if (i >= 0) rows[i] = r; else rows.push(r);
    }
    if (b.name === 'show_on_map') pick = { lat: Number(b.args.lat), lon: Number(b.args.lon) };
  }
  if (!rows.length) { // only a quick scan: show its best few
    const scan = [...blocks].reverse().find((b): b is ToolBlock => b.kind === 'tool' && b.name === 'scan_area' && b.status === 'ok');
    const ranked = (scan?.result as { ranked?: SpotResult[] } | undefined)?.ranked;
    if (ranked?.length) { rows.push(...ranked.slice(0, 5).map(r => ({ ...r, label: fmtLL(r.lat, r.lon) }))); quick = true; }
  }
  rows.sort((a, b) => spotScore(b) - spotScore(a));
  let best = 0;
  if (pick) {
    const p = pick;
    const near = rows.map((r, i) => ({ i, d: km(r.lat, r.lon, p.lat, p.lon) })).sort((a, b) => a.d - b.d)[0];
    if (near && near.d < 1.5) best = near.i;
  }
  if (best > 0) rows.unshift(...rows.splice(best, 1));
  return { rows, quick };
}

export function ResultsTable({ rows, quick, onShow, onCompare }: {
  rows: SpotResult[]; quick: boolean; onShow(r: SpotResult): void; onCompare(rs: SpotResult[]): string;
}) {
  const t = useT();
  const [note, setNote] = useState('');
  if (!rows.length) return null;
  const needs = rows[0];
  const why = (r: SpotResult) => (r.meets_battery_need && r.meets_contact_need ? t('ai.needsMet')
    : t('ai.needsNotMet', { battery: r.meets_battery_need ? t('ai.ok') : t('ai.tooShort'), radio: r.meets_contact_need ? t('ai.ok') : t('ai.tooLongNoEarth') }));
  return (
    <div className="ai-results">
      <div className="ai-results-head">
        <h4>{rows.length === 1 ? t('ai.spotChecked') : t('ai.spotsChecked', { n: rows.length })}</h4>
        <span>{quick ? t('ai.quickScan') : t('ai.daysFrom', { days: needs.mission_days, date: needs.arrival_utc.slice(0, 10) })}</span>
      </div>
      <table className="ai-rt">
        <thead><tr><th>{t('ai.col.spot')}</th><th>{t('ai.col.sun')}</th><th>{t('ai.col.dark')}</th><th>{t('ai.col.earth')}</th><th>{t('ai.col.noEarth')}</th><th>{t('ai.col.needs')}</th></tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const ok = r.meets_battery_need && r.meets_contact_need;
            return (
              <tr key={i} onClick={() => onShow(r)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onShow(r); } }} tabIndex={0} data-tip={t('ai.tip.showOnMap')}>
                <td className="site"><span className="ai-site-name"><b>{r.label}</b>{i === 0 && rows.length > 1 && <em className="ai-best">{t('ai.best')}</em>}</span><small>{fmtLL(r.lat, r.lon)}</small></td>
                <td>{r.sunlight_pct}%</td>
                <td>{fmtH(r.longest_dark_hours)}</td>
                <td>{r.earth_in_view_pct}%</td>
                <td>{fmtH(r.longest_without_earth_hours)}</td>
                <td><span className={`ai-need ${ok ? 'good' : 'bad'}`} data-tip={why(r)} aria-label={why(r)}>{ok ? <Check size={13} weight="bold" /> : <X size={13} weight="bold" />}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="ai-results-foot">
        <span>{note || t('ai.rowHint')}</span>
        {!quick && <button type="button" onClick={() => setNote(onCompare(rows.slice(0, 4)))} data-tip={t('ai.tip.compare')}><Scales size={13} />{rows.length > 4 ? t('ai.compareTop') : rows.length > 1 ? t('ai.compareAll') : t('ai.compare')}<ArrowUpRight size={12} /></button>}
      </div>
    </div>
  );
}
