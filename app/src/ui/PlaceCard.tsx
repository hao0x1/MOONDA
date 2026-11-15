// The left-hand info panel, like the Google Maps place panel. Every kind of spot (dropped pin,
// named crater, Artemis region, past landing) gets exactly the same structure:
//   header → three actions → daily Sun / Earth charts → mission summary
//   → panel height and six ground values → one About sentence, with evidence folded away.

import { ArrowLineDown, ArrowSquareOut, CaretDown, CaretUp, Check, Columns, Copy, MagnifyingGlassPlus, X } from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { containingName, distanceKm, formatLatLon, nearestNames, type MoonName } from '../data/names';
import type { Place } from '../data/places';
import { getLang, monthShort, t, tMaybe, useT } from '../i18n';
import type { ScienceManifestEntry } from '../moon/layers';
import { statsFor } from '../science/analysis';
import type { SpotEntry } from '../science/client';
import { POLAR_LIMIT_LAT } from '../science/terrain';
import { describeEarth, describeSun } from './describe';
import { DayBars } from './DayBars';
import { durationParts, fmtKm } from './format';
import { Help } from './Help';
import { isPhone } from './device';
import { PhoneSheetHandle, usePhoneSheet } from './PhoneSheet';
import { IconButton, Segmented } from './kit';

export type Selection =
  | { type: 'name'; name: MoonName }
  | { type: 'place'; place: Place }
  | { type: 'pin'; lat: number; lon: number };

export function selectionLatLon(s: Selection): { lat: number; lon: number } {
  if (s.type === 'name') return { lat: s.name.lat, lon: s.name.lon };
  if (s.type === 'place') return { lat: s.place.lat, lon: s.place.lon };
  return { lat: s.lat, lon: s.lon };
}

let lastPinTitle: { names: MoonName[] | null; lat: number; lon: number; lang: string; title: string } | null = null;

/** A name for any selection. A dropped pin is named after the crater it is in, or the nearest named place. */
export function selectionTitle(s: Selection, names: MoonName[] | null): string {
  if (s.type === 'name') return s.name.name;
  if (s.type === 'place') return s.place.name;
  // asked for on every redraw while the clock plays: remember the last answer
  const lang = getLang();
  if (lastPinTitle && lastPinTitle.names === names && lastPinTitle.lat === s.lat && lastPinTitle.lon === s.lon && lastPinTitle.lang === lang) return lastPinTitle.title;
  const inside = names ? containingName(names, s.lat, s.lon) : null;
  const near = !inside && names ? nearestNames(names, s.lat, s.lon, 1)[0] : null;
  const title = inside ? t('place.spotIn', { name: inside.name }) : near && near.km <= 150 ? t('place.spotNear', { name: near.name }) : t('place.dropped');
  lastPinTitle = { names, lat: s.lat, lon: s.lon, lang, title };
  return title;
}

interface Props {
  selection: Selection;
  names: MoonName[] | null;
  spot: SpotEntry | undefined;
  /** true while a new answer is being worked out and `spot` is still the previous one for this place */
  stale?: boolean;
  cursor: number;
  days: number;
  mastM: number;
  science: ScienceManifestEntry[];
  scienceValues: Record<string, number | null>;
  inCompare: boolean;
  onMast(m: number): void;
  onClose(): void;
  onZoom(): void;
  /** Add this spot to Compare, or take it out again when it is already there. */
  onCompare(): void;
  onStand(): void;
  onSeek(ms: number): void;
}

const MAST_OPTIONS = [2, 5, 10].map(m => ({ value: m, label: `${m} m` }));

const fmtHeight = (m: number) => `${m < 0 ? '−' : '+'}${(Math.abs(m) / 1000).toFixed(2)} km`;
// Descriptions can contain a full article's worth of context. Keep the first sentence here;
// the linked source holds the detail, without making every selected pin a long read.
const firstSentence = (text: string) => (text.trim().match(/^.*?[.!?។](?:\s|$)/u)?.[0] ?? text.trim()).trim();
const sentence = (text: string) => /[.!?។]$/u.test(text) ? text : `${text}.`;

export function PlaceCard(p: Props) {
  const t = useT();
  const { lat, lon } = selectionLatLon(p.selection);
  const polar = lat <= POLAR_LIMIT_LAT;
  const title = selectionTitle(p.selection, p.names);
  const nearest = useMemo(() => (p.selection.type === 'pin' && p.names ? nearestNames(p.names, lat, lon, 1)[0] : null), [p.names, lat, lon, p.selection.type]);
  // (on a phone the card is a sheet across the bottom: it starts folded to its name and buttons, so the Moon stays in view)
  const [collapsed, setCollapsed] = useState(isPhone);
  const sheetRoot = useRef<HTMLElement>(null);
  const sheet = usePhoneSheet(sheetRoot, true, `${lat},${lon}`);
  const folded = sheet.phone ? !sheet.expanded : collapsed;
  const [copied, setCopied] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [moreBelow, setMoreBelow] = useState(false);
  const [coordsBelow, setCoordsBelow] = useState(true);
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const nameRow = useRef<HTMLDivElement>(null);
  const nameMeasure = useRef<HTMLSpanElement>(null);
  const coordsButton = useRef<HTMLButtonElement>(null);
  // A new spot: open the panel again and start at the top.
  useEffect(() => { setCollapsed(isPhone()); setCopied(false); setScrolled(false); if (body.current) body.current.scrollTop = 0; }, [lat, lon]);

  const ready = p.spot?.status === 'ready' ? p.spot : null;
  const failed = p.spot?.status === 'error' ? p.spot.message : null;
  const tl = ready?.timeline;
  useLayoutEffect(() => {
    const measure = () => {
      const row = nameRow.current, name = nameMeasure.current, coords = coordsButton.current;
      if (!row || !name || !coords) return;
      const room = row.clientWidth - coords.offsetWidth - 10;
      // A short name can share the line; a long one keeps at least half the panel.
      setCoordsBelow(name.offsetWidth > room && room < row.clientWidth * .55);
    };
    const observer = new ResizeObserver(measure);
    if (nameRow.current) observer.observe(nameRow.current);
    if (nameMeasure.current) observer.observe(nameMeasure.current);
    if (coordsButton.current) observer.observe(coordsButton.current);
    measure();
    void document.fonts.ready.then(measure);
    return () => observer.disconnect();
  }, [title, lat, lon]);
  useLayoutEffect(() => {
    const update = () => {
      const el = body.current;
      if (!el) return;
      setScrolled(el.scrollTop > 2);
      setMoreBelow(el.scrollHeight - el.clientHeight - el.scrollTop > 2);
    };
    const observer = new ResizeObserver(update);
    if (body.current) observer.observe(body.current);
    if (content.current) observer.observe(content.current);
    update();
    return () => observer.disconnect();
  }, [folded, title, tl]);
  // these only change with the timeline, not on every tick of the clock
  const stats = useMemo(() => (tl ? statsFor(tl) : null), [tl]);
  const earthNever = useMemo(() => (tl ? Array.from(tl.earthEl).every(v => v < 0) : false), [tl]);
  const inside = useMemo(() => (p.selection.type === 'pin' && p.names ? containingName(p.names, lat, lon) : null), [p.names, lat, lon, p.selection.type]);
  const c = tl ? Math.min(tl.count - 1, Math.max(0, Math.round((p.cursor - tl.startMs) / tl.stepMs))) : 0;
  const sunNow = describeSun(tl ? { el: tl.sunEl[c], sky: tl.sunSky[c], part: tl.sunPart[c] } : null);
  const earthNow = describeEarth(tl ? { el: tl.earthEl[c], sky: tl.earthSky[c], part: tl.earthPart[c] } : null, earthNever);
  // A short word beside each chart; the full sentence stays in its tooltip.
  const sunWord = !tl ? '' : t(tl.sunPart[c] >= 0.999 ? 'sun.word.lit' : tl.sunPart[c] > 0 ? 'sun.partly' : tl.sunEl[c] > 0 ? 'sun.shadow' : 'sun.night');
  const earthWord = !tl ? '' : t(tl.earthEl[c] > tl.earthSky[c] ? 'earth.word.view' : earthNever ? 'earth.word.never' : tl.earthEl[c] > 0 ? 'earth.word.hill' : 'earth.word.down');

  // Header: one quiet line that says what kind of thing this is, the name, and a line of plain words.
  const poleKm = distanceKm(lat, lon, -90, 0);
  const poleBit = poleKm < 0.5 ? t('place.atPole') : poleKm <= 450 ? t('place.fromPole', { km: fmtKm(poleKm) }) : Math.abs(lon) <= 90 ? t('place.nearSide') : t('place.farSide');
  let kind: string, line: string, about: ReactNode = null;
  let sourceName = t('place.source.calculation');
  let sourceUrl = 'https://pgda.gsfc.nasa.gov/';
  if (p.selection.type === 'name') {
    const n = p.selection.name;
    kind = tMaybe(`kind.${n.kind}`, n.kind);
    sourceName = t('place.source.gazetteer');
    sourceUrl = `https://planetarynames.wr.usgs.gov/Feature/${n.usgsId}`;
    line = `${n.diameterKm ? `${t('place.across', { km: n.diameterKm < 10 ? n.diameterKm.toFixed(1) : Math.round(n.diameterKm) })} · ` : ''}${poleBit}`;
    about = <>
      <p>{n.origin ? t('place.namedAfter', { who: firstSentence(n.origin).replace(/[.!?។]$/u, '') }) : t('place.officialName')}</p>
    </>;
  } else if (p.selection.type === 'place') {
    const pl = p.selection.place;
    sourceName = pl.source.name;
    sourceUrl = pl.source.url;
    const site = pl.kind === 'mission' || pl.kind === 'active' || pl.kind === 'planned';
    kind = t(pl.kind === 'artemis' ? 'place.kind.artemis' : pl.kind === 'spot' ? 'place.kind.spot' : pl.kind === 'planned' ? 'place.kind.planned' : pl.kind === 'active' ? 'place.kind.active'
      : pl.kind === 'ice' ? 'place.kind.ice' : pl.what === 'impact' ? 'place.kind.impact' : 'place.kind.mission');
    line = pl.kind === 'planned' ? `${pl.date ? `${t('place.planned.when', { date: pl.date })} · ` : ''}${poleBit}`
      : site ? `${pl.date ? `${pl.date} · ` : ''}${poleBit}`
        : pl.kind === 'ice' ? `${pl.diameterKm ? `${t('place.across', { km: Math.round(pl.diameterKm) })} · ` : ''}${poleBit}`
          : `${t(pl.kind === 'artemis' ? 'place.nasaCandidate' : 'place.unofficial')} · ${poleBit}`;
    const iceColor = pl.ice === 'confirmed' ? '#ffffff' : pl.ice === 'predicted' ? '#6e96ff' : '#50d2ff';
    const short = sentence(firstSentence(tMaybe(`pl.${pl.id}.short`, pl.short)));
    const detail = firstSentence(tMaybe(`pl.${pl.id}.detail`, pl.detail));
    const note = pl.verify && pl.note ? firstSentence(pl.note) : pl.kind === 'planned' ? t('place.planned.note')
      : site && pl.precisionKm !== undefined && pl.precisionKm >= 1 ? t('place.precision', { km: pl.precisionKm }) : '';
    about = <>
      <p>{pl.kind === 'ice' && pl.ice
        ? <span className="ice-tag" style={{ '--ice': iceColor } as React.CSSProperties} data-tip={short}><i /><b>{sentence(tMaybe(`ice.${pl.ice}`, pl.ice))}</b></span>
        : short}</p>
      {site && detail && detail.length <= 150 && detail !== short && <p>{sentence(detail)}</p>}
      {note && <p className="fine ex-place-note" data-tip={pl.verify ? `${t('place.unconfirmed')}. ${pl.note}` : note} tabIndex={0}>{pl.verify ? `${t('place.unconfirmed')}. ` : ''}{note}</p>}
      {pl.evidence && pl.evidence.length > 0 && (
        <details key={pl.id} className="disclosure ex-place-evidence">
          <summary>{t('ice.evidence')} <CaretDown size={14} /></summary>
          {pl.evidence.map((ev, i) => (
            <div key={i} className="ev-item">
              <b>{ev.instrument}</b>
              <span>{ev.finding} </span>
              <a className="src-link" href={ev.url} target="_blank" rel="noreferrer" data-tip={ev.citation}>{t('place.sourceLink')} <ArrowSquareOut size={12} /></a>
            </div>
          ))}
        </details>
      )}
    </>;
  } else {
    kind = t('place.kind.pin');
    line = `${inside ? (inside.kind === 'Mountain' ? t('place.on', { name: inside.name }) : t('place.inside', { name: inside.name })) : nearest ? t('place.from', { km: fmtKm(nearest.km), name: nearest.name }) : t('place.youChose')} · ${poleBit}`;
    about = null;
  }

  const coords = formatLatLon(lat, lon, polar ? 3 : 2);
  const copy = () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1600); };
    try { void navigator.clipboard.writeText(`${lat.toFixed(4)}, ${lon.toFixed(4)}`).then(done, () => {}); } catch { /* clipboard not allowed */ }
  };

  // Six values in one fixed order. A missing map stays a dash; it must never turn into a zero.
  const groundRows: { id: string; label: string; tip: string; value: string }[] = [];
  const heightEntry = p.science.find(e => e.id === 'height');
  const heightM = (polar && heightEntry ? p.scienceValues.height : null) ?? ready?.horizon.groundM ?? null;
  if (heightM !== null && heightM !== undefined) groundRows.push({ id: 'height', label: t('ground.height'), tip: t('ground.height.tip'), value: fmtHeight(heightM) });
  // The maps now reach beyond the south pole (slope over the whole Moon, PSR and ice predictions at both poles).
  // Near the south pole every row shows, as before; elsewhere a row shows only where its map has a value.
  for (const id of ['slope', 'sunlight', 'earth', 'psr', 'waterice']) {
    const e = p.science.find(entry => entry.id === id) ?? (id === 'psr' ? p.science.find(entry => entry.id === 'ice') : undefined);
    if (!e) continue;
    const v = p.scienceValues[e.id];
    if (!polar && (v === null || v === undefined)) continue;
    let value = '—';
    if (v !== null && v !== undefined) {
      value = id === 'slope' ? `${v.toFixed(1)}°` : id === 'sunlight' || id === 'earth' ? `${Math.round(v)}%`
        : id === 'waterice' ? tMaybe(`ground.waterice.${Math.round(v)}`, String(Math.round(v)))
          : e.id === 'ice' ? t(v >= 0.5 ? 'ground.psr.yes' : 'ground.no')
            : t(v < 0.5 ? 'ground.no' : v > 99.5 ? 'ground.psr.yes' : 'ground.psr.part');
    }
    groundRows.push({ id, label: tMaybe(id === 'psr' ? 'ground.psr.short' : `ground.${id}`, e.title), tip: `${e.shortHelp ?? ''}${e.source?.name ? ` (${e.source.name})` : ''} ${id === 'sunlight' || id === 'earth' ? t('place.ground.tip') : ''}`, value });
  }

  const dark = stats && stats.longestDarkH ? durationParts(stats.longestDarkH) : null;
  const noEarth = stats && stats.longestNoEarthH ? durationParts(stats.longestNoEarthH) : null;
  const staleCls = p.stale ? ' stale' : '';
  const date = (ms: number) => { const d = new Date(ms); return `${d.getUTCDate()} ${monthShort(d.getUTCMonth())}`; };
  const missionDates = tl ? `${date(tl.startMs)} – ${date(tl.startMs + p.days * 86400000)}` : '';
  const tiles = stats ? [
    { id: 'sunlight', tone: 'sun', label: t('stat.sunlight'), tip: t('place.summary.sun.tip'), n: String(Math.round(stats.sunPct)), unit: '%', note: t('place.summary.mission') },
    { id: 'dark', tone: 'sun', label: t('stat.dark'), tip: t('place.summary.dark.tip'), n: dark?.n ?? t('common.none'), unit: dark?.unit ?? '', note: t(dark ? 'place.summary.battery' : 'place.summary.noDark') },
    { id: 'earth', tone: 'earth', label: t('stat.earth'), tip: t('place.summary.earth.tip'), n: String(Math.round(stats.earthPct)), unit: '%', note: t('place.summary.mission') },
    { id: 'noEarth', tone: 'earth', label: t('stat.noEarth'), tip: t('place.summary.noEarth.tip'), n: noEarth?.n ?? t('common.none'), unit: noEarth?.unit ?? '', note: t(noEarth ? 'place.summary.radio' : 'place.summary.alwaysEarth') },
  ] : [];

  return (
    <aside ref={sheetRoot} className={`place panel${folded ? ' collapsed' : ''}${scrolled ? ' scrolled' : ''}${sheet.className}`} aria-label={title}>
      <PhoneSheetHandle sheet={sheet} />
      <header className="place-head">
        <div className="place-top">
          <span className="place-kind">{kind}</span>
          <span className="place-top-gap" />
          <IconButton size="sm" className="place-toggle" label={collapsed ? t('place.show') : t('place.hide')} aria-expanded={!collapsed} onClick={() => setCollapsed(v => !v)}>{collapsed ? <CaretDown size={16} /> : <CaretUp size={16} />}</IconButton>
          <IconButton size="sm" label={t('common.close')} onClick={p.onClose}><X size={16} /></IconButton>
        </div>
        <div ref={nameRow} className={`place-name-row${coordsBelow ? ' coords-below' : ''}`}>
          <h2 className="place-title">{title}</h2>
          <span ref={nameMeasure} className="place-title place-name-measure" aria-hidden="true">{title}</span>
          <button ref={coordsButton} type="button" className="place-coords" onClick={copy} data-tip={copied ? t('place.copied') : t('place.copy')} aria-label={`${coords}. ${t('place.copy')}`}>
            <span>{coords}</span>{copied ? <Check size={13} weight="bold" color="var(--good)" /> : <Copy size={13} />}
          </button>
        </div>
        <div className="place-line">{line}</div>
        <a className="place-source" href={sourceUrl} target="_blank" rel="noreferrer" data-tip={t('place.source', { name: sourceName })}>
          <span>{t('place.source', { name: sourceName })}</span><ArrowSquareOut size={11} />
        </a>
      </header>

      {/* (the sheet on a phone keeps its three buttons when folded: Land here is what most people came for) */}
      {(!folded || sheet.phone) && (
        <div className="place-actions">
          <button type="button" className="btn primary" onClick={p.onStand} disabled={!ready} data-tip={ready ? t('place.standTip') : t('place.standWait')}>
            {ready ? <ArrowLineDown size={18} weight="bold" /> : <span className="spinner dark" />} {t('place.stand')}
          </button>
          <button type="button" className="btn" onClick={p.onCompare} aria-pressed={p.inCompare}
            data-tip={p.inCompare ? t('place.compareRemove') : t('place.compareAdd')}>
            {p.inCompare ? <Check size={18} weight="bold" /> : <Columns size={18} />} {p.inCompare ? t('place.comparing') : t('place.compare')}
          </button>
          <button type="button" className="btn" onClick={p.onZoom} data-tip={t('place.zoomTip')}>
            <MagnifyingGlassPlus size={18} /> {t('place.zoom')}
          </button>
        </div>
      )}

      {!folded && (
        <div className={`place-body${moreBelow ? ' has-more' : ''}`} ref={body} onScroll={e => {
          const el = e.currentTarget;
          setScrolled(el.scrollTop > 2);
          setMoreBelow(el.scrollHeight - el.clientHeight - el.scrollTop > 2);
        }}>
          <div className="place-body-content" ref={content}>
          <div className={`place-mission${staleCls}`}>
            <div className="place-mission-heading"><h3>{t('place.timeline')}</h3><span>{missionDates}</span></div>
            {failed !== null ? (
              <div className="loading-line"><span className="bad-text">{t('place.failed', { why: failed })}</span></div>
            ) : ready && stats && tl ? (
              <>
                <DayBars timeline={tl} days={p.days} cursor={p.cursor} kind="sun" nowWord={getLang() === 'en' ? sunWord.toLowerCase() : sunWord}
                  nowTip={`${sunNow.title}: ${sunNow.text}`} onSeek={p.onSeek} />
                <DayBars timeline={tl} days={p.days} cursor={p.cursor} kind="earth" nowWord={getLang() === 'en' ? earthWord.toLowerCase() : earthWord}
                  nowTip={`${earthNow.title}: ${earthNow.text}`} onSeek={p.onSeek} />
                <h3 className="place-summary-heading">{t('place.summary')}</h3>
                <div className="place-summary-grid">
                  {tiles.map(tile => (
                    <div className={`place-summary-tile place-summary-${tile.tone}`} key={tile.id} data-stat={tile.id}>
                      <i className="place-summary-dash" aria-hidden="true" />
                      <div className="place-summary-label"><span>{tile.label}</span>
                        <Help text={tile.tip} label={`${tile.label}: ${tile.tip}`} />
                      </div>
                      <div className={`place-summary-number${tile.unit === '%' ? ' is-percent' : ''}`}><span>{tile.n}</span>{tile.unit && <small>{tile.unit}</small>}</div>
                      <p>{tile.note}</p>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="place-skeleton" aria-busy="true">
                <div className="place-skeleton-message"><span className="spinner" />{p.spot?.status === 'loading' ? p.spot.message : t('place.starting')}</div>
                {[0, 1].map(n => <div className="pday-chart place-skeleton-chart" key={n}>
                  <div className="pday-heading"><h4>{t(n === 0 ? 'place.day.sun' : 'place.day.earth')}</h4></div>
                  <div className="pday-bars place-skeleton-bars">{Array.from({ length: Math.min(31, Math.ceil(p.days)) }, (_, i) => <i className="skel" key={i} />)}</div>
                  <div className="pday-axis" /><div className="pday-labels place-skeleton-scale"><span>{t('place.day.single', { n: 1 })}</span><span>{Math.ceil(p.days)}</span></div>
                </div>)}
                <h3 className="place-summary-heading">{t('place.summary')}</h3>
                <div className="place-summary-grid">{[0, 1, 2, 3].map(n => <div className="place-summary-tile" key={n}>
                  <i className="place-summary-dash skel" /><div className="place-summary-label"><span className="skel line" /></div>
                  <div className="place-summary-number"><span className="skel place-skeleton-number" /></div><p><span className="skel line" /></p>
                </div>)}</div>
              </div>
            )}
          </div>

          <div className="prow">
            <span className="prow-label" data-tip={t('place.panelHeight.tip')} tabIndex={0}>{t('place.panelHeight')}</span>
            <Segmented size="sm" label={t('place.panelHeight')} options={MAST_OPTIONS.map(o => ({ ...o, tip: t('place.panelHeight.tip') }))} value={p.mastM} onChange={p.onMast} />
          </div>
          {groundRows.map(r => (
            <div key={r.id} className="prow">
              <span className="prow-label" data-tip={r.tip || undefined} tabIndex={r.tip ? 0 : undefined}>{r.label}</span>
              <span className="prow-val" data-tip={`${r.value}. ${r.tip}`} tabIndex={0}>{r.value}</span>
            </div>
          ))}

          {about && <div className="about">{about}</div>}
          </div>
        </div>
      )}
    </aside>
  );
}
