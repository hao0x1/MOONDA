import { ArrowSquareOut, HandGrabbing, MapPin, Scales, X } from '@phosphor-icons/react';
import { useT, type Key } from '../i18n';
import { IconButton, Wordmark } from './kit';

// What each kind of data is (a text key), who made it and where to read more. Source names stay as published.
const SOURCES: [Key, string, string][] = [
  ['welcome.src.photos', 'NASA LRO camera (LROC) via NASA Moon Trek and ASU Lunaserv', 'https://trek.nasa.gov/moon/'],
  ['welcome.src.heights', 'NASA LRO laser altimeter (LOLA), 80 m south-pole map', 'https://pgda.gsfc.nasa.gov/'],
  ['welcome.src.names', 'IAU Gazetteer of Planetary Nomenclature (USGS)', 'https://planetarynames.wr.usgs.gov/'],
  ['welcome.src.positions', 'Astronomy Engine (open source), checked against NASA/JPL Horizons', 'https://ssd.jpl.nasa.gov/horizons/'],
  ['welcome.src.artemis', 'NASA, October 2024 update (approximate markers)', 'https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/'],
  ['welcome.src.engine', 'CesiumJS (open source, Apache 2.0)', 'https://cesium.com/platform/cesiumjs/'],
  ['welcome.src.music', '"Cylinder Five" by Chris Zabriskie (CC BY 4.0)', 'https://chriszabriskie.com/cylinders/'],
];

export function Welcome({ onPole, onExplore, onClose, showSources }: { onPole(): void; onExplore(): void; onClose(): void; showSources?: boolean }) {
  const t = useT();
  return (
    <div className="welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
      onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="welcome-card panel">
        <IconButton label={t('common.close')} className="welcome-close" onClick={onClose}><X size={18} /></IconButton>
        <div className="welcome-brand"><Wordmark /><em>NASA Space Apps 2026</em></div>
        <h1 id="welcome-title">{t('welcome.title')}</h1>
        <p className="welcome-lead">{t('welcome.lead')}</p>
        <ol className="welcome-steps">
          <li><span className="ws-icon"><HandGrabbing size={18} /></span><div><b>{t('welcome.step.look')}</b><span>{t('welcome.step.look.text')}</span></div></li>
          <li><span className="ws-icon"><MapPin size={18} weight="fill" color="var(--pin)" /></span><div><b>{t('welcome.step.click')}</b><span>{t('welcome.step.click.text')}</span></div></li>
          <li><span className="ws-icon"><Scales size={18} /></span><div><b>{t('welcome.step.compare')}</b><span>{t('welcome.step.compare.text')}</span></div></li>
        </ol>
        <div className="welcome-actions">
          <button type="button" className="btn primary lg" onClick={onPole} autoFocus>{t('welcome.toPole')}</button>
          <button type="button" className="btn lg" onClick={onExplore}>{t('welcome.explore')}</button>
        </div>
        <details className="welcome-sources" open={showSources}>
          <summary>{t('welcome.sources')}</summary>
          <table>
            <tbody>
              {SOURCES.map(([what, who, url]) => (
                <tr key={what}><td>{t(what)}</td><td><a href={url} target="_blank" rel="noreferrer">{who} <ArrowSquareOut size={11} /></a></td></tr>
              ))}
            </tbody>
          </table>
          <p>{t('welcome.fine')}</p>
          <p>{t('layer.dataDetail.note')}</p>
        </details>
      </div>
    </div>
  );
}
