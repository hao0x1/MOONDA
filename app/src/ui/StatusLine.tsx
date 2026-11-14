// The thin line along the bottom edge, like Google Earth's: what is under the cursor (in words and
// as coordinates), how high the eye is, and who the data comes from.

import { useMemo } from 'react';
import { containingName, formatLatLon, type MoonName } from '../data/names';
import { t, useLang, useT } from '../i18n';
import { fmtKm } from './format';
import { cameraStore, hoverStore } from './stores';

/** A few plain words for a point on the Moon. */
export function whereWords(names: MoonName[] | null, lat: number, lon: number): string {
  const inside = names ? containingName(names, lat, lon) : null;
  if (inside) return inside.kind === 'Mountain' ? inside.name : t('where.crater', { name: inside.name });
  if (lat <= -80) return t('where.southPolar');
  if (lat >= 80) return t('where.northPolar');
  return Math.abs(lon) <= 90 ? t('where.near') : t('where.far');
}

interface Props {
  names: MoonName[] | null;
  /** Set while standing on the surface: there is no cursor position then. */
  standingAt: { lat: number; lon: number; label: string } | null;
  onCredits(): void;
}

export function StatusLine({ names, standingAt, onCredits }: Props) {
  const tt = useT();
  const lang = useLang();
  const hover = hoverStore.use();
  const cam = cameraStore.use();
  const words = useMemo(() => (hover ? whereWords(names, hover.lat, hover.lon) : ''), [names, hover, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <footer className="statusline" aria-live="off">
      <div className="st-left">
        {standingAt ? (
          <><span className="st-words">{tt('status.standing', { name: standingAt.label })}</span><span className="st-coords">{formatLatLon(standingAt.lat, standingAt.lon, 3)}</span></>
        ) : hover ? (
          <><span className="st-words">{words}</span><span className="st-coords">{formatLatLon(hover.lat, hover.lon, 3)}</span></>
        ) : <span className="st-words muted">{tt('status.move')}</span>}
      </div>
      {!standingAt && <div className="st-eye">{tt('status.eye')} <b>{fmtKm(cam.km)}</b></div>}
      <button type="button" className="st-credits" onClick={onCredits} data-tip={tt('status.creditsTip')}>{tt('status.credits')}</button>
    </footer>
  );
}
