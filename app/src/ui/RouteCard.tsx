// The route card: one small boxed card that says what the planned route is like and lets you choose its kind.
// It stands beside the place panel on the overview (RouteTool.tsx). The big surface map shows the same route
// as a bar along its bottom edge instead (explore/RoutePanel.tsx): there a boxed card sat on top of the photo.
// Both use the four kinds and their pictures from here, so a route reads the same wherever it was planned.

import { Broadcast, Feather, Lightning, Path, Sun, WarningCircle, X, type Icon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { useT, type Key } from '../i18n';
import type { RoutePrefer } from '../science/route';
import './routeTool.css';

export const ROUTE_KINDS = ['fastest', 'gentle', 'sun', 'earth'] as const;
export type RouteKind = typeof ROUTE_KINDS[number];
// each kind of route has its own small picture, so the four read at a glance
export const KIND_ICON: Record<RouteKind, Icon> = { fastest: Lightning, gentle: Feather, sun: Sun, earth: Broadcast };

interface Props {
  /** pick: waiting for a destination; working: being worked out; ready: the figures below; failed: no way found */
  state: 'pick' | 'working' | 'ready' | 'failed';
  /** what to do to get a route (shown while waiting for a destination) */
  hint: string;
  distance?: string;
  duration?: string;
  slope?: string;
  failTitle?: string;
  failWhy?: string;
  prefer: RoutePrefer;
  onPrefer(kind: RouteKind): void;
  onClear?(): void;
  /** further rows under the kinds (the big map adds the climb and the sunlight along the way) */
  children?: ReactNode;
  className?: string;
}

export function RouteCard({ state, hint, distance, duration, slope, failTitle, failWhy, prefer, onPrefer, onClear, children, className }: Props) {
  const t = useT();
  const chosen: RouteKind = prefer === 'balanced' ? 'fastest' : prefer;
  return (
    <section className={`rcard panel${className ? ` ${className}` : ''}`} aria-label={t('route.title')} data-route-state={state}
      onPointerDown={e => e.stopPropagation()} onKeyDown={e => { if (e.key.startsWith('Arrow') || e.key === ' ') e.stopPropagation(); }}>
      <header className="rcard-head">
        <span className="rcard-mark" aria-hidden="true"><Path size={16} weight="bold" /></span>
        <h3>{t('route.title')}</h3>
        {onClear && <button type="button" className="rcard-clear" aria-label={t('route.clear')} data-tip={t('route.clear')} onClick={onClear}><X size={15} /></button>}
      </header>

      <div className="rcard-body" role="status" aria-live="polite">
        {state === 'pick' ? <p className="rcard-hint"><i className="rcard-pulse" aria-hidden="true" />{hint}</p>
          : state === 'working' ? <p className="rcard-hint"><i className="spinner" aria-hidden="true" />{t('route.working')}</p>
            : state === 'ready' ? (
              <dl className="rcard-stats">
                <div><dd>{distance}</dd><dt>{t('route.distance')}</dt></div>
                <div><dd>{duration}</dd><dt>{t('route.drivingTime')}</dt></div>
                <div><dd>{slope}</dd><dt>{t('route.steepest')}</dt></div>
              </dl>
            ) : <p className="rcard-fail"><WarningCircle size={18} aria-hidden="true" /><span><b>{failTitle}</b>{failWhy}</span></p>}
      </div>

      <div className="rcard-kinds" role="radiogroup" aria-label={t('route.prefer')}>
        {ROUTE_KINDS.map(kind => {
          const Glyph = KIND_ICON[kind], on = chosen === kind;
          return (
            <button key={kind} type="button" role="radio" aria-checked={on} className={on ? 'on' : undefined} onClick={() => onPrefer(kind)}>
              <Glyph size={17} weight={on ? 'fill' : 'regular'} />{t(`route.prefer.${kind}`)}
            </button>
          );
        })}
      </div>
      {/* one plain line about the kind that is chosen, instead of four tooltips to hunt for */}
      <p className="rcard-about">{t(`ex.route.prefer.${chosen}.tip` as Key)}</p>
      {children}
    </section>
  );
}
