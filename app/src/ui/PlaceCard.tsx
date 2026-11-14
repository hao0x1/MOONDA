// The left-hand info panel, like the Google Maps place panel. Every kind of spot (dropped pin,
// named crater, Artemis region, past landing) gets exactly the same structure:
//   header → three actions → one small Sun / Earth table (now · in view · longest gap) and the mission timeline
//   → one-line rows (panel height, ground values, skyline chart) → one About sentence → nearby names.
// The longer explanations live in tooltips on the cells, so the card stays short.

import { ArrowSquareOut, CaretDown, CaretUp, Check, Columns, Copy, Eye, MagnifyingGlassPlus, X } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { containingName, distanceKm, formatLatLon, nearestNames, type MoonName } from '../data/names';
import type { Place } from '../data/places';
import { getLang, t, tMaybe, useT } from '../i18n';
import type { ScienceManifestEntry } from '../moon/layers';
import { statsFor } from '../science/analysis';
import type { SpotEntry } from '../science/client';
import { POLAR_LIMIT_LAT } from '../science/terrain';
import { describeEarth, describeSun } from './describe';
import { durationParts, fmtKm, fmtSigned, fmtUtcShort } from './format';
import { IconButton, Segmented } from './kit';
import { Skyline } from './Skyline';
import { Tracks } from './TimeBar';

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
  canCompare: boolean;
  inCompare: boolean;
  onMast(m: number): void;
  onClose(): void;
  onZoom(): void;
  /** Add this spot to Compare, or take it out again when it is already there. */
  onCompare(): void;
  onStand(): void;
  onPickName(n: MoonName): void;
}

const MAST_OPTIONS = [2, 5, 10].map(m => ({ value: m, label: `${m} m` }));

function fmtValue(e: ScienceManifestEntry, v: number): string {
  if (e.id === 'ice') return v >= 0.5 ? t('ground.yesNeverLit') : t('ground.no');
  if (e.id === 'slope') return `${v.toFixed(1)}° · ${t(v < 5 ? 'ground.gentle' : v < 15 ? 'ground.moderate' : 'ground.steep')}`;
  const u = e.units?.toLowerCase() ?? '';
  if (u.includes('k')) return `${fmtSigned(v - 273.15)} °C`;
  if (u.includes('%')) return t('ground.ofTheTime', { pct: Math.round(v) });
  if (u === 'm') return fmtHeight(v);
  return `${Math.round(v * 10) / 10} ${e.units ?? ''}`;
}
const fmtHeight = (m: number) => `${m < 0 ? '−' : '+'}${(Math.abs(m) / 1000).toFixed(2)} km`;

export function PlaceCard(p: Props) {
  const t = useT();
  const { lat, lon } = selectionLatLon(p.selection);
  const polar = lat <= POLAR_LIMIT_LAT;
  const title = selectionTitle(p.selection, p.names);
  const nearby = useMemo(() => (p.names ? nearestNames(p.names, lat, lon, 3, p.selection.type === 'name' ? p.selection.name.idx : -1) : []), [p.names, lat, lon, p.selection]);
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  // A new spot: open the panel again and start at the top.
  useEffect(() => { setCollapsed(false); setCopied(false); setScrolled(false); if (body.current) body.current.scrollTop = 0; }, [lat, lon]);

  const ready = p.spot?.status === 'ready' ? p.spot : null;
  const failed = p.spot?.status === 'error' ? p.spot.message : null;
  const tl = ready?.timeline;
  // these only change with the timeline, not on every tick of the clock
  const stats = useMemo(() => (tl ? statsFor(tl) : null), [tl]);
  const earthNever = useMemo(() => (tl ? Array.from(tl.earthEl).every(v => v < 0) : false), [tl]);
  const inside = useMemo(() => (p.selection.type === 'pin' && p.names ? containingName(p.names, lat, lon) : null), [p.names, lat, lon, p.selection.type]);
  const c = tl ? Math.min(tl.count - 1, Math.max(0, Math.round((p.cursor - tl.startMs) / tl.stepMs))) : 0;
  const sunNow = describeSun(tl ? { el: tl.sunEl[c], sky: tl.sunSky[c], part: tl.sunPart[c] } : null);
  const earthNow = describeEarth(tl ? { el: tl.earthEl[c], sky: tl.earthSky[c], part: tl.earthPart[c] } : null, earthNever);
  // one or two words for the table; the full sentence is the cell's tooltip
  const sunWord = !tl ? '' : t(tl.sunPart[c] >= 0.999 ? 'sun.word.lit' : tl.sunPart[c] > 0 ? 'sun.partly' : tl.sunEl[c] > 0 ? 'sun.shadow' : 'sun.night');
  const earthWord = !tl ? '' : t(tl.earthEl[c] > tl.earthSky[c] ? 'earth.word.view' : earthNever ? 'earth.word.never' : tl.earthEl[c] > 0 ? 'earth.word.hill' : 'earth.word.down');

  // Header: one quiet line that says what kind of thing this is, the name, and a line of plain words.
  const poleKm = distanceKm(lat, lon, -90, 0);
  const poleBit = poleKm < 0.5 ? t('place.atPole') : poleKm <= 450 ? t('place.fromPole', { km: fmtKm(poleKm) }) : Math.abs(lon) <= 90 ? t('place.nearSide') : t('place.farSide');
  let kind: string, line: string, about: ReactNode = null;
  if (p.selection.type === 'name') {
    const n = p.selection.name;
    kind = tMaybe(`kind.${n.kind}`, n.kind);
    line = `${n.diameterKm ? `${t('place.across', { km: n.diameterKm < 10 ? n.diameterKm.toFixed(1) : Math.round(n.diameterKm) })} · ` : ''}${poleBit}`;
    about = <>
      <p>{n.origin ? t('place.namedAfter', { who: n.origin.replace(/\.$/, '') }) : t('place.officialName')}{' '}
      <a className="src-link" href={`https://planetarynames.wr.usgs.gov/Feature/${n.usgsId}`} target="_blank" rel="noreferrer">{t('place.officialRecord')} <ArrowSquareOut size={12} /></a></p>
    </>;
  } else if (p.selection.type === 'place') {
    const pl = p.selection.place;
    kind = t(pl.kind === 'artemis' ? 'place.kind.artemis' : pl.kind === 'spot' ? 'place.kind.spot' : 'place.kind.mission');
    line = pl.kind === 'mission' ? `${pl.date ? `${pl.date} · ` : ''}${poleBit}` : `${t(pl.kind === 'artemis' ? 'place.nasaCandidate' : 'place.unofficial')} · ${poleBit}`;
    about = <>
      <p>{tMaybe(`pl.${pl.id}.short`, pl.short)}.{' '}
      <a className="src-link" href={pl.source.url} target="_blank" rel="noreferrer">{t('place.source', { name: pl.source.name })} <ArrowSquareOut size={12} /></a></p>
    </>;
  } else {
    kind = t('place.kind.pin');
    line = `${inside ? (inside.kind === 'Mountain' ? t('place.on', { name: inside.name }) : t('place.inside', { name: inside.name })) : nearby[0] ? t('place.from', { km: fmtKm(nearby[0].km), name: nearby[0].name }) : t('place.youChose')} · ${poleBit}`;
    about = null;
  }

  const coords = formatLatLon(lat, lon, polar ? 3 : 2);
  const copy = () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1600); };
    try { void navigator.clipboard.writeText(`${lat.toFixed(4)}, ${lon.toFixed(4)}`).then(done, () => {}); } catch { /* clipboard not allowed */ }
  };

  // Ground values: height first (known everywhere once the spot is worked out), then the polar NASA maps.
  const groundRows: { id: string; label: string; tip: string; value: string }[] = [];
  const heightEntry = p.science.find(e => e.id === 'height');
  const heightM = (polar && heightEntry ? p.scienceValues.height : null) ?? ready?.horizon.groundM ?? null;
  if (heightM !== null && heightM !== undefined) groundRows.push({ id: 'height', label: t('ground.height'), tip: t('ground.height.tip'), value: fmtHeight(heightM) });
  if (polar) for (const e of p.science) {
    if (e.id === 'height') continue;
    const v = p.scienceValues[e.id];
    groundRows.push({ id: e.id, label: tMaybe(`ground.${e.id}`, e.title), tip: `${e.shortHelp ?? ''}${e.source?.name ? ` (${e.source.name})` : ''} ${t('place.ground.tip')}`, value: v === null || v === undefined ? '—' : fmtValue(e, v) });
  }

  const dark = stats && stats.longestDarkH ? durationParts(stats.longestDarkH) : null;
  const noEarth = stats && stats.longestNoEarthH ? durationParts(stats.longestNoEarthH) : null;
  const staleCls = p.stale ? ' stale' : '';

  return (
    <aside className={`place panel${collapsed ? ' collapsed' : ''}${scrolled ? ' scrolled' : ''}`} aria-label={title}>
      <header className="place-head">
        <div className="place-top">
          <span className="place-kind">{kind}</span>
          <span className="place-top-gap" />
          <IconButton size="sm" label={collapsed ? t('place.show') : t('place.hide')} aria-expanded={!collapsed} onClick={() => setCollapsed(v => !v)}>{collapsed ? <CaretDown size={16} /> : <CaretUp size={16} />}</IconButton>
          <IconButton size="sm" label={t('common.close')} onClick={p.onClose}><X size={16} /></IconButton>
        </div>
        <h2 className="place-title">{title}</h2>
        <div className="place-line">{line}</div>
        <button type="button" className="place-coords" onClick={copy} data-tip={copied ? t('place.copied') : t('place.copy')} aria-label={`${coords}. ${t('place.copy')}`}>
          <span>{coords}</span>{copied ? <Check size={13} weight="bold" color="var(--good)" /> : <Copy size={13} />}
        </button>
      </header>

      {!collapsed && (
        <div className="place-actions">
          <button type="button" className="btn primary" onClick={p.onStand} disabled={!ready} data-tip={ready ? t('place.standTip') : t('place.standWait')}>
            {ready ? <Eye size={18} weight="bold" /> : <span className="spinner dark" />} {t('place.stand')}
          </button>
          <button type="button" className="btn" onClick={p.onCompare} aria-pressed={p.inCompare} disabled={!p.inCompare && !p.canCompare}
            data-tip={p.inCompare ? t('place.compareRemove') : p.canCompare ? t('place.compareAdd') : t('place.compareFull')}>
            {p.inCompare ? <Check size={18} weight="bold" /> : <Columns size={18} />} {p.inCompare ? t('place.comparing') : t('place.compare')}
          </button>
          <button type="button" className="btn" onClick={p.onZoom} data-tip={t('place.zoomTip')}>
            <MagnifyingGlassPlus size={18} /> {t('place.zoom')}
          </button>
        </div>
      )}

      {!collapsed && (
        <div className="place-body" ref={body} onScroll={e => setScrolled(e.currentTarget.scrollTop > 2)}>
          <div className={`pt-block${staleCls}`}>
            {failed !== null ? (
              <div className="loading-line"><span className="bad-text">{t('place.failed', { why: failed })}</span></div>
            ) : ready && stats && tl ? (
              <>
                <table className="ptab">
                  <thead>
                    <tr>
                      <td />
                      <th scope="col">{t('place.now')}<small>{fmtUtcShort(p.cursor)}</small></th>
                      <th scope="col">{t('place.tab.inView')}<small>{t('place.tab.ofDays', { days: p.days })}</small></th>
                      <th scope="col">{t('place.tab.gap')}<small>&nbsp;</small></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="sun">
                      <th scope="row"><i aria-hidden="true" />{t('common.sun')}</th>
                      <td className={sunNow.on ? undefined : 'off'} tabIndex={0} data-tip={`${sunNow.title}: ${sunNow.text}`}>{sunWord}</td>
                      <td tabIndex={0} data-tip={t('stat.sunlight.tip')}>{Math.round(stats.sunPct)}%</td>
                      <td tabIndex={0} data-tip={t('stat.dark.tip')}>{dark ? `${dark.n} ${dark.unit}` : t('common.none')}</td>
                    </tr>
                    <tr className="earth">
                      <th scope="row"><i aria-hidden="true" />{t('common.earth')}</th>
                      <td className={earthNow.on ? undefined : 'off'} tabIndex={0} data-tip={`${earthNow.title}: ${earthNow.text}`}>{earthWord}</td>
                      <td tabIndex={0} data-tip={t('stat.earth.tip')}>{Math.round(stats.earthPct)}%</td>
                      <td tabIndex={0} data-tip={t('stat.noEarth.tip')}>{noEarth ? `${noEarth.n} ${noEarth.unit}` : t('common.none')}</td>
                    </tr>
                  </tbody>
                </table>
                <div className="mission-tracks">
                  <div className="mt-bars" role="img" aria-label={t('place.tracksLabel', { sun: Math.round(stats.sunPct), earth: Math.round(stats.earthPct) })}>
                    <Tracks timeline={tl} />
                    <div className="mt-cursor" style={{ left: `${(c / Math.max(1, tl.count - 1)) * 100}%` }} />
                  </div>
                  <div className="mt-scale" aria-hidden="true"><span>{t('time.landing')}</span><span>{t('time.dayN', { n: Math.round(p.days / 2) })}</span><span>{t('time.dayN', { n: p.days })}</span></div>
                </div>
              </>
            ) : (
              // same height as the table + timeline, so nothing jumps when the answer arrives
              <div className="pt-skel" aria-busy="true">
                <div className="pt-skel-msg"><span className="spinner" />{p.spot?.status === 'loading' ? p.spot.message : t('place.starting')}</div>
                <span className="skel line" style={{ width: '100%' }} />
                <span className="skel line" style={{ width: '100%' }} />
                <span className="skel bars" />
              </div>
            )}
          </div>

          <div className="prow">
            <span className="prow-label" data-tip={t('place.panelHeight.tip')} tabIndex={0}>{t('place.panelHeight')}</span>
            <Segmented size="sm" label={t('place.panelHeight')} options={MAST_OPTIONS} value={p.mastM} onChange={p.onMast} />
          </div>
          {groundRows.map(r => (
            <div key={r.id} className="prow">
              <span className="prow-label" data-tip={r.tip || undefined} tabIndex={r.tip ? 0 : undefined}>{r.label}</span>
              <span className="prow-val">{r.value}</span>
            </div>
          ))}

          {ready && (
            <details className="disclosure">
              <summary>{t('place.skyline')} <CaretDown size={14} /></summary>
              <p>{t('place.skyline.text')}</p>
              <Skyline horizon={ready.horizon} timeline={ready.timeline} cursorIndex={c} />
              <p className="fine">
                {t(ready.horizon.resolutionM < 100 ? 'place.skyline.fine80' : 'place.skyline.fineGlobal')} {t('place.skyline.fineEph', { ms: Math.round(ready.horizon.ms) })}
              </p>
            </details>
          )}

          {about && <div className="about">{about}</div>}
          {nearby.length > 0 && (
            <div className="nearby">
              <span className="nearby-title">{t('place.nearby')}</span>
              {nearby.slice(0, 3).map(n => (
                <button key={n.idx} type="button" onClick={() => p.onPickName(n)} data-tip={n.kind}>
                  <span className="nearby-name">{n.name}</span>
                  <span className="nearby-km">{fmtKm(n.km)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
