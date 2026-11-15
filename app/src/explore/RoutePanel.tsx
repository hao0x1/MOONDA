// The route in the big surface map: one bar along the bottom of the photo. On the left what the route is like
// (or what to do to get one), in the middle the four kinds of route, on the right the rest of the figures and
// the way to clear it. The owner on the boxed card that stood here before: "I like it when you put it on the
// overview, but when you put it in the map it don't look good." A bar leaves the photo free and is neutral
// white on dark glass, like the other controls on the map.
import { ArrowDown, ArrowUp, CaretUp, Path, WarningCircle, X } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { useT, type Key } from '../i18n';
import type { RoutePrefer, RouteResult } from '../science/route';
import { KIND_ICON, ROUTE_KINDS, type RouteKind } from '../ui/RouteCard';
import { fmtDist, fmtMinutes } from './format';
import './explore.css';

export interface RouteView {
  status: 'working' | 'ready' | 'error';
  to: { lat: number; lon: number; label: string };
  prefer: RoutePrefer;
  result: RouteResult | null;
  now?: { sun: number; earth: number } | null;
}
interface Props {
  route: RouteView | null;
  /** the kind of route that is chosen, also before there is a route */
  prefer: RoutePrefer;
  onPrefer(p: RoutePrefer): void;
  onClear(): void;
}

export function RoutePanel({ route, prefer, onPrefer, onClear }: Props) {
  const t = useT();
  const [more, setMore] = useState(false);
  const r = route?.result;
  const ok = route?.status === 'ready' && !!r?.ok;
  const working = !!route && (route.status === 'working' || (route.status === 'ready' && !r));
  // the sheet of further figures belongs to one finished route: a new search or a cleared route closes it
  useEffect(() => { if (!ok) setMore(false); }, [ok]);
  const predictedS = r?.driveS;
  const driveS = typeof predictedS === 'number' && Number.isFinite(predictedS) && predictedS >= 0 ? predictedS : (r?.lengthM ?? 0) / 2;
  const pct = (v: number) => Number.isFinite(v) ? `${Math.round(v)}%` : '—';
  const nowSun = route?.now?.sun ?? r?.sunNowShare;
  const nowEarth = route?.now?.earth ?? r?.earthNowShare;
  const nowPct = (value: number | undefined) => value !== undefined && Number.isFinite(value) ? Math.round(value * 100) : '—';
  // (the reason alone: the line above it already says "No safe way there")
  const failure = route?.status === 'error' ? 'route.reason.error'
    : r?.reason === 'far' ? 'route.reason.far' : r?.reason === 'same' ? 'route.reason.same' : 'route.reason.blocked';
  const state = !route ? 'pick' : working ? 'working' : ok ? 'ready' : 'failed';
  const chosen: RouteKind = prefer === 'balanced' ? 'fastest' : prefer;

  return <div className="sm-route-dock" onPointerDown={ev => ev.stopPropagation()}>
    {more && ok && r && <div className="sm-route-sheet" id="sm-route-sheet">
      <p className="sm-route-kind">{t(`ex.route.prefer.${chosen}.tip` as Key)}</p>
      <dl>
        <div><dt>{t('ex.route.climb')}</dt><dd><ArrowUp size={12} />{fmtDist(r.climbM)}</dd></div>
        <div><dt>{t('ex.route.descent')}</dt><dd><ArrowDown size={12} />{fmtDist(r.descentM)}</dd></div>
        <div data-tip={t('ex.route.sun.tip')} tabIndex={0}><dt>{t('ground.sunlight')}</dt><dd>{pct(r.sunPct_)}</dd></div>
        <div data-tip={t('ex.route.earth.tip')} tabIndex={0}><dt>{t('ground.earth')}</dt><dd>{pct(r.earthPct_)}</dd></div>
      </dl>
      {(Number.isFinite(nowSun) || Number.isFinite(nowEarth)) && <p data-tip={t('ex.route.now.tip')} tabIndex={0}>
        <b>{t('ex.route.now')}</b> {t('ex.route.now.value', { sun: nowPct(nowSun), earth: nowPct(nowEarth) })}
      </p>}
      {r.psrShare > .005 && <p>{t('ex.route.shadow')}: {Math.round(r.psrShare * 100)}%</p>}
      {r.steep && <p className="sm-route-warn"><WarningCircle size={14} />{t('ex.route.steep')}</p>}
      <p>{t(r.dataResM > 1000 ? 'ex.route.note.global.short' : 'ex.route.note.short')}</p>
    </div>}
    <section className="sm-route" aria-label={t('route.title')} data-route-state={state}
      onKeyDown={e => { if (e.key.startsWith('Arrow') || e.key === ' ') e.stopPropagation(); }}>
      <div className="sm-route-lead" role="status" aria-live="polite">
        {state === 'pick' ? <p className="sm-route-say"><Path size={18} aria-hidden="true" />{t('ex.route.empty')}</p>
          : state === 'working' ? <p className="sm-route-say"><i className="spinner" aria-hidden="true" />{t('route.working')}</p>
            : state === 'ready' && r ? (
              <dl className="sm-route-stats">
                <div><dd>{fmtDist(r.lengthM)}</dd><dt>{t('route.distance')}</dt></div>
                <div><dd>{fmtMinutes(driveS)}</dd><dt>{t('route.drivingTime')}</dt></div>
                <div><dd>{Math.round(r.maxSlopeDeg)}°</dd><dt>{t('ex.route.steepest')}</dt></div>
              </dl>
            ) : <p className="sm-route-say sm-route-fail"><WarningCircle size={18} aria-hidden="true" /><span><b>{t('route.unsafe')}</b>{t(failure)}</span></p>}
      </div>
      <div className="sm-route-kinds" role="radiogroup" aria-label={t('route.prefer')}>
        {ROUTE_KINDS.map(kind => {
          const Glyph = KIND_ICON[kind], on = chosen === kind;
          return (
            <button key={kind} type="button" role="radio" aria-checked={on} className={on ? 'on' : undefined}
              data-tip={t(`ex.route.prefer.${kind}.tip` as Key)} onClick={() => onPrefer(kind)}>
              <Glyph size={17} weight={on ? 'fill' : 'regular'} /><span>{t(`route.prefer.${kind}`)}</span>
            </button>
          );
        })}
      </div>
      {route && <div className="sm-route-tail">
        {ok && <button type="button" className={more ? 'on' : undefined} aria-expanded={more} aria-controls="sm-route-sheet" aria-label={t('ex.route.details')}
          data-tip={more ? undefined : t('ex.route.details.open.tip')} data-sm-route-info-close={more ? '' : undefined} onClick={() => setMore(v => !v)}><CaretUp size={16} /></button>}
        <button type="button" aria-label={t('route.clear')} data-tip={t('ex.route.clear.tip')} onClick={onClear}><X size={16} /></button>
      </div>}
    </section>
  </div>;
}
