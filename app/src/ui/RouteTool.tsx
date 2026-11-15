// The overview keeps the same route when the map changes between globe and flat.
// These controls use the shared tokens; their position does not change the map's click frame.
import { Path, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import type { RoutePrefer, RouteResult } from '../science/route';
import { IconButton } from './kit';
import { RouteCard } from './RouteCard';
import { PhoneSheetHandle, usePhoneSheet } from './PhoneSheet';
import './routeTool.css';

interface ButtonProps {
  selected: boolean;
  armed: boolean;
  onClick(): void;
}

/** The map buttons belong to another component, so give this button a small slot in their column. */
export function OverviewRouteButton({ selected, armed, onClick }: ButtonProps) {
  const t = useT();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let mount: HTMLDivElement | null = null;
    const findColumn = () => {
      const column = document.querySelector('.map-controls');
      if (!column || mount) return;
      mount = document.createElement('div');
      mount.className = 'oroute-slot';
      column.insertBefore(mount, column.querySelector('.ctl-compass'));
      setSlot(mount);
    };
    findColumn();
    // The start screen can finish after this component mounts.
    const observer = new MutationObserver(() => { findColumn(); if (mount) observer.disconnect(); });
    if (!mount) observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); mount?.remove(); };
  }, []);
  if (!slot) return null;
  return createPortal(<IconButton className="oroute-button" size="lg" variant="glass" tipSide="left"
    data-overview-route-button disabled={!selected} pressed={armed} onClick={onClick}
    label={t(selected ? 'route.button' : 'route.pickFirst')}><Path size={19} /></IconButton>, slot);
}

interface Props {
  route: RouteResult | null;
  busy: boolean;
  failed?: boolean;
  prefer: RoutePrefer;
  onPrefer(prefer: RoutePrefer): void;
  onClear(): void;
  armed?: boolean;
}

/** The route card of the overview: it sits beside the place panel, joined to it, while a route is being chosen or shown. */
export function RouteTool({ route, busy, failed = false, prefer, onPrefer, onClear, armed = false }: Props) {
  const t = useT();
  const hasRoute = !!route || busy || failed;
  const sheetRoot = useRef<HTMLDivElement>(null);
  const sheet = usePhoneSheet(sheetRoot, hasRoute || armed);
  if (!hasRoute && !armed) return null;
  const metres = route?.lengthM ?? 0;
  const distance = metres < 995 ? t('route.metres', { n: Math.round(metres) })
    : t('route.kilometres', { n: (metres / 1000).toFixed(metres < 9950 ? 1 : 0) });
  const seconds = route?.driveS;
  const driveS = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds : metres / 2;
  const minutes = Math.max(1, Math.round(driveS / 60));
  const duration = minutes < 60 ? t('route.minutes', { n: minutes })
    : t('route.hoursMinutes', { h: Math.floor(minutes / 60), m: String(minutes % 60).padStart(2, '0') });
  const slope = route && Number.isFinite(route.maxSlopeDeg) ? `${Math.round(route.maxSlopeDeg)}°` : '—';
  const reason = failed ? 'route.reason.error' : route?.reason === 'far' ? 'route.reason.far'
    : route?.reason === 'same' ? 'route.reason.same' : 'route.reason.blocked';
  const state = busy ? 'working' : !hasRoute ? 'pick' : failed || !route?.ok ? 'failed' : 'ready';

  return <div ref={sheetRoot} className={`oroute-dock${sheet.className}${sheet.phone ? ' panel' : ''}`} data-overview-route-bar data-route-state={state}>
    <PhoneSheetHandle sheet={sheet} />
    {sheet.phone && <header className="drawer-head"><h2>{t('route.title')}</h2><span className="drawer-gap" />
      <IconButton label={t('common.close')} onClick={onClear}><X size={18} /></IconButton></header>}
    <RouteCard state={state} hint={t('route.hint')} distance={distance} duration={duration} slope={slope}
      failTitle={t('route.unsafe')} failWhy={t(reason)} prefer={prefer} onPrefer={onPrefer} onClear={hasRoute ? onClear : undefined} />
    {/* while the tool is armed and a route is already shown, say that another click moves the destination */}
    {armed && hasRoute && <p className="oroute-again" data-overview-route-hint>{t('route.hint')}</p>}
  </div>;
}
