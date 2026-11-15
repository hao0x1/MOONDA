// Shown when the 3D map can no longer draw (Cesium's render loop stopped, usually because this device's graphics
// driver refused one of the shaders). Cesium's own answer is a raw red error box over a black page; on a phone
// that is all a visitor saw. This says what happened in plain words and offers what usually fixes it: the lighter
// graphics, and a reload. The technical line stays available for whoever has to mend the cause.
import { chooseQuality } from '../app/quality';
import { settings } from '../app/settings';
import { useT } from '../i18n';

export function RenderStopped({ message }: { message: string }) {
  const t = useT();
  const light = settings.get().quality === 'light';
  return (
    <div className="render-stopped" role="alertdialog" aria-modal="true" aria-label={t('render.stopped.title')}>
      <div className="render-stopped-card panel">
        <h2>{t('render.stopped.title')}</h2>
        <p>{t(light ? 'render.stopped.body.light' : 'render.stopped.body')}</p>
        <div className="render-stopped-actions">
          {!light && <button type="button" className="btn primary" onClick={() => { chooseQuality('light'); location.reload(); }}>{t('render.stopped.light')}</button>}
          <button type="button" className={`btn${light ? ' primary' : ''}`} onClick={() => location.reload()}>{t('render.stopped.reload')}</button>
        </div>
        <details>
          <summary>{t('render.stopped.detail')}</summary>
          <pre>{message}</pre>
        </details>
      </div>
    </div>
  );
}
