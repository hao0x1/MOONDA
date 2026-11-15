// Shown when the 3D map can no longer draw (Cesium's render loop stopped, usually because this device's graphics
// driver refused one of the shaders). Cesium's own answer is a raw red error box over a black page; on a phone
// that is all a visitor saw. This says what happened in plain words and offers what usually fixes it: the lighter
// graphics, and a reload. The technical line stays available for whoever has to mend the cause.
import { chooseQuality } from '../app/quality';
import { settings } from '../app/settings';
import { useT } from '../i18n';
import type { MapSelection } from '../moon/MoonMap';

export interface GraphicsView {
  position: number[]; direction: number[]; up: number[];
  flat?: { lonC: number; latC: number; s: number };
}
export interface GraphicsRecovery {
  at: number; entered: boolean; view: GraphicsView | null; selection: MapSelection | null;
  standing: boolean; rover: { lat: number; lon: number; headingDeg: number } | null;
  surfaceView: 'spot' | 'third' | 'first'; az: number; el: number;
  arrival: number; cursor: number; days: number; mastM: number;
  layers: Record<string, boolean>; opacity: Record<string, number>;
}
const RECOVERY_KEY = 'moonda.graphics-recovery.v1';

export function readGraphicsRecovery(): GraphicsRecovery | null {
  try {
    const raw = sessionStorage.getItem(RECOVERY_KEY);
    sessionStorage.removeItem(RECOVERY_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as GraphicsRecovery;
    const age = Date.now() - saved.at;
    if (age < 0 || age > 30 * 60_000 || !Number.isFinite(saved.at + saved.arrival + saved.cursor + saved.days + saved.mastM)
      || typeof saved.entered !== 'boolean' || typeof saved.standing !== 'boolean' || saved.days <= 0) return null;
    const point = (p: { lat: number; lon: number } | null | undefined) => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
    const selection = saved.selection;
    if (selection && !(selection.type === 'pin' ? point(selection) : selection.type === 'place' ? point(selection.place)
      : selection.type === 'name' ? point(selection.name) : false)) return null;
    if (saved.standing && !selection) return null;
    if (saved.rover && (!point(saved.rover) || !Number.isFinite(saved.rover.headingDeg))) saved.rover = null;
    if (!['spot', 'third', 'first'].includes(saved.surfaceView)) saved.surfaceView = 'spot';
    if (!Number.isFinite(saved.az + saved.el)) { saved.az = 0; saved.el = 0; }
    const v = saved.view;
    if (v && ![v.position, v.direction, v.up].every(a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) && Math.hypot(...a) > 1e-9)) saved.view = null;
    if (saved.view?.flat && (!point({ lat: saved.view.flat.latC, lon: saved.view.flat.lonC }) || !Number.isFinite(saved.view.flat.s) || saved.view.flat.s <= 0)) delete saved.view.flat;
    if (!saved.layers || typeof saved.layers !== 'object' || Array.isArray(saved.layers)) saved.layers = {};
    else saved.layers = Object.fromEntries(Object.entries(saved.layers).filter(([, value]) => typeof value === 'boolean'));
    if (!saved.opacity || typeof saved.opacity !== 'object' || Array.isArray(saved.opacity)) saved.opacity = {};
    else saved.opacity = Object.fromEntries(Object.entries(saved.opacity).filter(([, value]) => Number.isFinite(value) && value >= 0 && value <= 1));
    return saved;
  } catch { return null; }
}

export function saveGraphicsRecovery(saved: GraphicsRecovery): void {
  try { sessionStorage.setItem(RECOVERY_KEY, JSON.stringify(saved)); } catch { /* Browsing still works when storage is disabled. */ }
}

/** Detached map canvases need their own listener too. Remove it before deliberately destroying a context.
 *  onLost: a side canvas (the round map's photo plane, the hidden 2D map) handles its own loss and returns true
 *  when the page can carry on; only the Moon view itself (or a side canvas that is on screen) reloads the page.
 *  (Phones drop side contexts under memory pressure: reloading the whole site for one of those was the owner's
 *  "it suddenly just reloads".) */
export function watchGraphicsContext(canvas: HTMLCanvasElement, onLost?: () => boolean): () => void {
  const lost = (event: Event) => {
    event.preventDefault();
    if (onLost?.()) { console.warn('A side map lost its graphics context; carrying on without it.'); return; }
    window.dispatchEvent(new Event('moonda-context-lost'));
  };
  canvas.addEventListener('webglcontextlost', lost, true);
  return () => canvas.removeEventListener('webglcontextlost', lost, true);
}

export function RenderStopped({ message, contextLost = false }: { message: string; contextLost?: boolean }) {
  const t = useT();
  const light = settings.get().quality === 'light';
  return (
    <div className="render-stopped" role="alertdialog" aria-modal="true" aria-label={t(contextLost ? 'render.context.title' : 'render.stopped.title')}>
      <div className="render-stopped-card panel">
        <h2>{t(contextLost ? 'render.context.title' : 'render.stopped.title')}</h2>
        <p>{t(contextLost ? 'render.context.body' : light ? 'render.stopped.body.light' : 'render.stopped.body')}</p>
        <div className="render-stopped-actions">
          {!light && !contextLost && <button type="button" className="btn primary" onClick={() => { chooseQuality('light'); location.reload(); }}>{t('render.stopped.light')}</button>}
          <button type="button" className={`btn${light || contextLost ? ' primary' : ''}`} onClick={() => location.reload()}>{t('render.stopped.reload')}</button>
        </div>
        {!contextLost && <details>
          <summary>{t('render.stopped.detail')}</summary>
          <pre>{message}</pre>
        </details>}
      </div>
    </div>
  );
}
