// The route in the big surface map: the same boxed card as on the overview (ui/RouteCard.tsx), with the rest of
// the figures (climb, sunlight and Earth view along the way) folded under "More about this route".
import { ArrowDown, ArrowUp, CaretDown, WarningCircle } from '@phosphor-icons/react';
import { useT } from '../i18n';
import type { RoutePrefer, RouteResult } from '../science/route';
import { RouteCard } from '../ui/RouteCard';
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
  onPrefer(p: RoutePrefer): void;
  onClear(): void;
}

export function RoutePanel({ route, onPrefer, onClear }: Props) {
  const t = useT();
  const r = route?.result;
  const ok = route?.status === 'ready' && !!r?.ok;
  const working = !!route && (route.status === 'working' || (route.status === 'ready' && !r));
  const predictedS = r?.driveS;
  const driveS = typeof predictedS === 'number' && Number.isFinite(predictedS) && predictedS >= 0 ? predictedS : (r?.lengthM ?? 0) / 2;
  const pct = (v: number) => Number.isFinite(v) ? `${Math.round(v)}%` : '—';
  const nowSun = route?.now?.sun ?? r?.sunNowShare;
  const nowEarth = route?.now?.earth ?? r?.earthNowShare;
  const nowPct = (value: number | undefined) => value !== undefined && Number.isFinite(value) ? Math.round(value * 100) : '—';
  const failure = route?.status === 'error' ? 'ex.route.fail.error'
    : r?.reason === 'far' ? 'ex.route.fail.far' : r?.reason === 'same' ? 'ex.route.fail.same' : 'ex.route.fail.blocked';
  const state = !route ? 'pick' : working ? 'working' : ok ? 'ready' : 'failed';

  return <div className="sm-route-dock" onPointerDown={ev => ev.stopPropagation()}>
    <RouteCard state={state} hint={t('ex.route.empty')} prefer={route?.prefer ?? 'fastest'} onPrefer={onPrefer} onClear={route ? onClear : undefined}
      distance={r ? fmtDist(r.lengthM) : undefined} duration={fmtMinutes(driveS)} slope={r ? `${Math.round(r.maxSlopeDeg)}°` : undefined}
      failTitle={t('route.unsafe')} failWhy={t(failure)}>
      {ok && r && <details className="rcard-more">
        <summary>{t('ex.route.details')}<CaretDown size={13} /></summary>
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
        {r.steep && <p className="rcard-warn"><WarningCircle size={14} />{t('ex.route.steep')}</p>}
        <p>{t(r.dataResM > 1000 ? 'ex.route.note.global.short' : 'ex.route.note.short')}</p>
      </details>}
    </RouteCard>
  </div>;
}
