// The big surface map: a wide photo card over the blurred rover view. Its glass controls float over the photo:
// the place and a Layers button top left (the same Layers box as on the overview), zoom top right, the route
// bar along the bottom. A tap places the destination straight away. The map carries the official place names
// and repeats sideways, so you can scroll right round the Moon.
import { Crosshair, Minus, Plus, Stack, X } from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { MoonName } from '../data/names';
import { useT } from '../i18n';
import { MARKER_LAYERS, layerTitle, type LayerDef } from '../moon/layers';
import type { Vec3 } from '../science/ephemeris';
import type { RoutePrefer } from '../science/route';
import { EarthGlyph, SunGlyph } from '../ui/glyphs';
import { LayerLegend, LayersPanel } from '../ui/LayersPanel';
import { MapEngine } from './MapEngine';
import { probeAt } from './probe';
import { RoutePanel, type RouteView } from './RoutePanel';
import './explore.css';

interface Props {
  bodies: { sun: Vec3; earth: Vec3 };
  layers: Record<string, boolean>;
  opacity: Record<string, number>;
  layerDefs: LayerDef[];
  onLayersChange: Dispatch<SetStateAction<Record<string, boolean>>>;
  onOpacityChange: Dispatch<SetStateAction<Record<string, number>>>;
  timeKey: number;
  mastM: number;
  names: MoonName[] | null;
  placeName: string;
  onClose(): void;
  route: RouteView | null;
  prefer: RoutePrefer;
  onPlan(lat: number, lon: number): void;
  onPrefer(p: RoutePrefer): void;
  onClear(): void;
}
interface Hover {
  x: number; y: number;
  kind: 'trail' | 'route';
  lat: number; lon: number;
  sunPct?: number; earthPct?: number;
}
interface Point { x: number; y: number }
interface Destination { lat: number; lon: number }
const MAP_LAYERS = new Set(['psr', 'waterice', 'danger', 'slope', 'craters', 'height']);
const MAP_MOTION_MS = 220;

// App parks driving keys in a window capture handler. Register before its mount effect so map
// zoom keys and the route popover's first Esc can be handled without changing that shared guard.
let activeMapKey: ((ev: KeyboardEvent) => boolean) | null = null;
const mapKeys = (ev: KeyboardEvent) => {
  if (!activeMapKey?.(ev)) return;
  ev.preventDefault(); ev.stopImmediatePropagation();
};
if (typeof window !== 'undefined') window.addEventListener('keydown', mapKeys, true);
if (import.meta.hot) import.meta.hot.dispose(() => window.removeEventListener('keydown', mapKeys, true));

/** Use the round map's centre as the origin while placing the small picture exactly over it. */
function miniMotion(full: { left: number; top: number; width: number; height: number }) {
  const mini = document.querySelector('.sm-mini-dial')?.getBoundingClientRect();
  if (!mini) return { origin: '50% 50%', transform: 'none' };
  const ox = mini.left + mini.width / 2 - full.left, oy = mini.top + mini.height / 2 - full.top;
  const sx = mini.width / full.width, sy = mini.height / full.height;
  return { origin: `${ox}px ${oy}px`, transform: `translate(${sx * (ox - full.width / 2)}px, ${sy * (oy - full.height / 2)}px) scale(${sx}, ${sy})` };
}
const valid = (at: Destination | null | undefined): at is Destination => !!at && Number.isFinite(at.lat) && Number.isFinite(at.lon);

const NAMES_LAYER = MARKER_LAYERS.filter(l => l.id === 'names');

export function SurfaceMap({ bodies, layers, opacity, layerDefs, onLayersChange, onOpacityChange, timeKey, mastM, names, placeName, onClose, route, prefer, onPlan, onPrefer, onClear }: Props) {
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<MapEngine | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const enterMotion = useRef<Animation | null>(null);
  const shadeMotion = useRef<Animation | null>(null);
  const refreshBounds = useRef<() => void>(() => {});
  const bounds = useRef({ left: 0, top: 0, width: 0, height: 0 });
  const mapLayers = layerDefs.filter(l => MAP_LAYERS.has(l.id));
  const activeLayers = mapLayers.filter(l => layers[l.id]);
  const [scale, setScale] = useState({ metres: 1000, widthPx: 90, label: '1 km' });
  const [viewSize, setViewSize] = useState({ width: 700, height: 700 });
  const [pointer, setPointer] = useState<{ lat: number; lon: number; heightM: number } | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [draggingFlag, setDraggingFlag] = useState(false);
  const [showLayers, setShowLayers] = useState(false);
  const closeLayers = useRef<(() => void) | null>(null);
  useLayoutEffect(() => { closeLayers.current = showLayers ? () => setShowLayers(false) : null; }, [showLayers]);
  const routeRef = useRef(route);
  const callbacks = useRef({ onPlan, onClear });
  useLayoutEffect(() => { routeRef.current = route; callbacks.current = { onPlan, onClear }; }, [route, onPlan, onClear]);
  const gesture = useRef({ points: new Map<number, Point>(), moved: false, multi: false, startX: 0, startY: 0, started: 0,
    at: 0, flag: false, offsetX: 0, offsetY: 0, destination: null as Destination | null });
  const lastTap = useRef<{ x: number; y: number; at: number; previous: Destination | null } | null>(null);

  const finishOpening = () => {
    // Touching the card takes over immediately, even during its short opening movement.
    if (!enterMotion.current && !shadeMotion.current) return;
    enterMotion.current?.finish(); shadeMotion.current?.finish(); refreshBounds.current();
  };

  useLayoutEffect(() => {
    const pane = dialog.current, shade = backdrop.current;
    if (!pane || !shade) return;
    document.querySelectorAll('.sm-exit-ghost').forEach(node => node.remove());
    const full = pane.getBoundingClientRect(), source = miniMotion(full);
    pane.style.transformOrigin = source.origin;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    if (!reduced.matches && typeof pane.animate === 'function') {
      const enter = pane.animate([{ transform: source.transform, opacity: .18 }, { transform: 'none', opacity: 1 }],
        { duration: MAP_MOTION_MS, easing: 'cubic-bezier(.2,.75,.25,1)' });
      const fade = shade.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MAP_MOTION_MS });
      enterMotion.current = enter; shadeMotion.current = fade;
      enter.onfinish = () => { enterMotion.current = null; shadeMotion.current = null; requestAnimationFrame(() => refreshBounds.current()); };
    }
    return () => {
      const start = getComputedStyle(pane);
      const transform = start.transform, opacity = start.opacity, shadeOpacity = getComputedStyle(shade).opacity;
      enterMotion.current?.cancel(); shadeMotion.current?.cancel();
      enterMotion.current = null; shadeMotion.current = null;
      if (reduced.matches || typeof pane.animate !== 'function' || !pane.isConnected) return;
      // M/Esc remove the live card immediately. An inert photo carries only its closing movement.
      const ghost = shade.cloneNode(true) as HTMLDivElement;
      ghost.classList.add('sm-exit-ghost'); ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true;
      ghost.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
      const originals = shade.querySelectorAll('canvas'), copies = ghost.querySelectorAll('canvas');
      originals.forEach((photo, i) => copies[i]?.getContext('2d')?.drawImage(photo, 0, 0));
      document.body.append(ghost);
      const picture = ghost.querySelector<HTMLElement>('.sm-dialog');
      if (!picture) { ghost.remove(); return; }
      const layout = { left: pane.offsetLeft, top: pane.offsetTop, width: pane.offsetWidth, height: pane.offsetHeight };
      const target = miniMotion(layout);
      // Keep the current origin on an interrupted opening; it already points at the same small map.
      if (transform === 'none') picture.style.transformOrigin = target.origin;
      const shrink = picture.animate([{ transform, opacity }, { transform: target.transform, opacity: .08 }],
        { duration: MAP_MOTION_MS, easing: 'cubic-bezier(.4,0,.8,.4)' });
      ghost.animate([{ opacity: shadeOpacity }, { opacity: 0 }], { duration: MAP_MOTION_MS });
      void shrink.finished.then(() => ghost.remove(), () => ghost.remove());
    };
  }, []);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const map = new MapEngine(cv, { round: false, follow: false, acrossM: 10000, onChange: () => {
      const current = engine.current;
      if (!current) return;
      setScale(current.getScale());
    } });
    engine.current = map;
    const testWindow = window as unknown as { __moondaSurfaceMap?: MapEngine };
    if (import.meta.env.DEV) testWindow.__moondaSurfaceMap = map;
    const size = () => {
      // Animation changes the picture's rectangle, never its canvas layout or Retina pixels.
      const width = cv.clientWidth, height = cv.clientHeight, r = cv.getBoundingClientRect();
      bounds.current = { left: r.left, top: r.top, width, height };
      map.resize(width, height); setViewSize({ width, height });
      const centre = map.pointAt(width / 2, height / 2);
      if (valid(centre)) setPointer(current => current ?? centre);
    };
    refreshBounds.current = () => {
      const r = cv.getBoundingClientRect();
      bounds.current = { left: r.left, top: r.top, width: cv.clientWidth, height: cv.clientHeight };
    };
    const observer = new ResizeObserver(size);
    observer.observe(cv); window.addEventListener('resize', size); size();
    const wheel = (ev: WheelEvent) => {
      ev.preventDefault(); ev.stopPropagation();
      finishOpening();
      const r = bounds.current, gain = ev.ctrlKey ? .00375 : .0015;
      const delta = ev.deltaY * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? r.height : 1);
      map.zoomAt(Math.exp(-Math.max(-1200, Math.min(1200, delta)) * gain), ev.clientX - r.left, ev.clientY - r.top);
      setHover(null);
    };
    cv.addEventListener('wheel', wheel, { passive: false });
    const key = (ev: KeyboardEvent) => {
      if ((ev.target as Element | null)?.closest?.('input,textarea,select,[contenteditable],[role=slider]')) return false;
      if (ev.key === 'Escape') {
        // the top-most open thing first: the Layers box, then the route's further figures, then (App) the map itself
        if (closeLayers.current) { closeLayers.current(); return true; }
        const popoverClose = paneButton('[data-sm-route-info-close]');
        if (popoverClose) { popoverClose.click(); return true; }
      }
      if (ev.key === '+' || ev.key === '=' || ev.key === '-' || ev.key === '_') {
        finishOpening(); map.zoomAt(ev.key === '+' || ev.key === '=' ? 2 : .5); return true;
      }
      return false;
    };
    const paneButton = (selector: string) => dialog.current?.querySelector<HTMLButtonElement>(selector);
    activeMapKey = key;
    close.current?.focus({ preventScroll: true });
    return () => {
      if (activeMapKey === key) activeMapKey = null;
      observer.disconnect(); window.removeEventListener('resize', size); cv.removeEventListener('wheel', wheel);
      map.destroy(); engine.current = null;
      if (testWindow.__moondaSurfaceMap === map) delete testWindow.__moondaSurfaceMap;
    };
  }, []);
  useEffect(() => {
    const drag = gesture.current;
    const destination = drag.flag && drag.moved && drag.destination ? drag.destination : route?.to ?? null;
    engine.current?.update({ route: route?.result?.ok ? route.result : null, destination, bodies,
      layers, opacity, layerDefs, realSun: layers.realSun !== false });
  }, [route?.result, route?.to, bodies, layers, opacity, layerDefs]);
  useEffect(() => { engine.current?.update({ names }); }, [names]);
  // Place names keep clear of the controls that float over the photo: a word half under a button reads as a fault.
  // Measured after every render (the controls change size with their contents), told to the map only when changed.
  const clearSeen = useRef('');
  useEffect(() => {
    const cv = canvas.current, area = cv?.parentElement, base = cv?.getBoundingClientRect();
    if (!cv || !area || !base?.width || !base.height) return;
    // (while the card is still growing out of the round map its rectangles are scaled: count in the card's own pixels)
    const sx = cv.clientWidth / base.width, sy = cv.clientHeight / base.height;
    const boxes = [...area.querySelectorAll('.sm-top>*, .sm-layers, .sm-legend, .sm-navigation, .sm-route, .sm-route-sheet, .sm-status-pill, .sm-photo-credit')].map(el => {
      const r = el.getBoundingClientRect();
      return [Math.round((r.left - base.left) * sx) - 6, Math.round((r.top - base.top) * sy) - 4, Math.round((r.right - base.left) * sx) + 6, Math.round((r.bottom - base.top) * sy) + 4];
    });
    const seen = boxes.join(';');
    if (seen === clearSeen.current) return;
    clearSeen.current = seen; engine.current?.update({ keepClear: boxes });
  });

  const point = (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX - bounds.current.left, y: ev.clientY - bounds.current.top });
  const restoreDestination = () => engine.current?.update({ destination: routeRef.current?.to ?? null });
  const onDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation(); finishOpening();
    const map = engine.current, p = point(ev), g = gesture.current;
    if (!map) return;
    map.stopMotion();
    ev.currentTarget.setPointerCapture(ev.pointerId);
    if (!g.points.size) {
      g.moved = false; g.multi = false; g.startX = p.x; g.startY = p.y; g.started = performance.now();
      g.destination = null;
      const destination = routeRef.current?.to, flag = destination && map.screenAt(destination.lat, destination.lon);
      g.flag = !!flag && Math.hypot(flag.x - p.x, flag.y - p.y) < 22;
      g.offsetX = flag ? flag.x - p.x : 0; g.offsetY = flag ? flag.y - p.y : 0;
      if (g.flag) setDraggingFlag(true);
    } else {
      g.multi = true;
      if (g.flag) { restoreDestination(); g.flag = false; setDraggingFlag(false); }
    }
    g.points.set(ev.pointerId, p); setHover(null);
  };
  const onMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    ev.stopPropagation();
    const p = point(ev), g = gesture.current, map = engine.current;
    if (!map) return;
    const before = g.points.get(ev.pointerId);
    if (before) {
      const old = [...g.points.values()]; g.points.set(ev.pointerId, p);
      if (Math.hypot(p.x - g.startX, p.y - g.startY) > 6) g.moved = true;
      if (g.points.size > 1 && old.length > 1) {
        const next = [...g.points.values()], a = Math.hypot(old[0].x - old[1].x, old[0].y - old[1].y), b = Math.hypot(next[0].x - next[1].x, next[0].y - next[1].y);
        if (a > 1 && b > 1) map.zoomAt(b / a, (next[0].x + next[1].x) / 2, (next[0].y + next[1].y) / 2);
        map.pan(((next[0].x + next[1].x) - (old[0].x + old[1].x)) / 2, ((next[0].y + next[1].y) - (old[0].y + old[1].y)) / 2);
      } else if (g.flag) {
        if (g.moved) {
          const at = map.pointAt(p.x + g.offsetX, p.y + g.offsetY);
          if (valid(at)) { g.destination = at; map.update({ destination: at }); }
        }
      } else if (g.moved || performance.now() - g.started > 350) map.pan(p.x - before.x, p.y - before.y);
      return;
    }
    if (performance.now() - g.at < 55) return;
    g.at = performance.now();
    const at = map.pointAt(p.x, p.y);
    if (!valid(at)) { setHover(null); return; }
    setPointer(at);
    const hit = map.hoverAt(p.x, p.y);
    setHover(hit ? { ...hit, x: p.x, y: p.y } : null);
  };
  const onUp = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    ev.stopPropagation();
    const g = gesture.current, p = point(ev), map = engine.current;
    if (!g.points.has(ev.pointerId) || !map) return;
    const moved = g.moved || Math.hypot(p.x - g.startX, p.y - g.startY) > 6;
    if (g.points.size === 1 && !g.multi) {
      if (g.flag) {
        const at = map.pointAt(p.x + g.offsetX, p.y + g.offsetY);
        if (moved && valid(at)) callbacks.current.onPlan(at.lat, at.lon);
        else restoreDestination();
      } else if (!moved && performance.now() - g.started <= 350) {
        const at = map.pointAt(p.x, p.y), previous = lastTap.current;
        const double = previous && performance.now() - previous.at < 350 && Math.hypot(previous.x - p.x, previous.y - p.y) <= 6;
        if (valid(at) && !double) {
          lastTap.current = { ...p, at: performance.now(), previous: routeRef.current?.to ?? null };
          callbacks.current.onPlan(at.lat, at.lon);
        }
      }
    }
    g.points.delete(ev.pointerId);
    if (!g.points.size) { g.flag = false; setDraggingFlag(false); }
    if (ev.currentTarget.hasPointerCapture(ev.pointerId)) ev.currentTarget.releasePointerCapture(ev.pointerId);
  };
  const cancelPointer = (id: number) => {
    const g = gesture.current;
    if (g.flag) restoreDestination();
    g.points.delete(id); g.flag = false; setDraggingFlag(false);
  };
  const clear = () => { lastTap.current = null; setHover(null); engine.current?.update({ destination: null }); onClear(); };
  const probe = useMemo(() => hover ? probeAt(hover.lat, hover.lon, mastM, bodies.sun, bodies.earth, timeKey) : null,
    [hover, mastM, timeKey, bodies.sun, bodies.earth]);
  const trapFocus = (ev: React.KeyboardEvent<HTMLElement>) => {
    if (ev.key !== 'Tab') return;
    const items = dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]');
    if (!items?.length) return;
    const first = items[0], last = items[items.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  };

  return <div ref={backdrop} className="sm-backdrop" onPointerDown={ev => ev.stopPropagation()} onMouseDown={ev => ev.stopPropagation()}
    onClick={ev => { ev.stopPropagation(); if (ev.target === ev.currentTarget) onClose(); }}>
    <section className="sm-dialog" ref={dialog} role="dialog" aria-modal="true" aria-label={`${t('ex.map.title')} · ${placeName}`} onKeyDown={trapFocus}>
      <div className={`sm-map-area${draggingFlag ? ' sm-dragging-flag' : ''}`}>
        <canvas ref={canvas} aria-label={t('ex.map.aria')} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
          onPointerCancel={ev => cancelPointer(ev.pointerId)} onLostPointerCapture={ev => { if (gesture.current.points.has(ev.pointerId)) cancelPointer(ev.pointerId); }} onPointerLeave={() => setHover(null)}
          onContextMenu={ev => { ev.preventDefault(); ev.stopPropagation(); clear(); }}
          onDoubleClick={ev => {
            ev.preventDefault(); ev.stopPropagation(); finishOpening();
            const p = point(ev), tap = lastTap.current;
            // Single taps stay immediate. A second tap changes that gesture into zoom, undoing only its first marker.
            if (tap && performance.now() - tap.at < 500 && Math.hypot(tap.x - p.x, tap.y - p.y) <= 10) {
              if (tap.previous) onPlan(tap.previous.lat, tap.previous.lon); else clear();
            }
            lastTap.current = null; engine.current?.zoomAt(2, p.x, p.y);
          }} />
        <div className="sm-top">
          <div className="sm-map-name">{placeName}</div>
          <button type="button" className="sm-layers-btn" aria-pressed={showLayers} aria-expanded={showLayers}
            data-tip={showLayers ? undefined : t('top.layers.tip')} onClick={() => setShowLayers(v => !v)}>
            <Stack size={17} />{t('top.layers')}{activeLayers.length > 0 && <span className="sm-layers-count">{activeLayers.length}</span>}
          </button>
        </div>
        {showLayers && <LayersPanel className="sm-layers" helpSide="right"
          groups={[{ title: 'Maps', group: 'science', layers: mapLayers }, { title: 'Names and markers', group: 'markers', layers: NAMES_LAYER }]}
          state={layers} opacity={opacity}
          onToggle={(id, on) => onLayersChange(cur => ({ ...cur, [id]: on }))}
          onOpacity={(id, v) => onOpacityChange(cur => ({ ...cur, [id]: v }))}
          onClose={() => setShowLayers(false)} />}
        {/* with the box closed, the colours of the maps that are on still need their key */}
        {!showLayers && activeLayers.some(l => l.legend) && <div className="sm-legend" aria-label={t('map.colours')}>
          {activeLayers.filter(l => l.legend).map(l => <div key={l.id} className="legend-item"><b>{layerTitle(l)}</b><LayerLegend layer={l} /></div>)}
        </div>}
        <div className="sm-navigation">
          <button ref={close} type="button" className="sm-close" aria-label={t('ex.map.close')} data-tip={t('ex.map.close')} data-tip-side="left" onClick={onClose}><X size={18} /></button>
          <button type="button" aria-label={t('ex.map.zoomIn')} data-tip={t('ex.map.zoomIn')} data-tip-side="left" onClick={() => engine.current?.zoomAt(2)}><Plus size={18} /></button>
          <button type="button" aria-label={t('ex.map.zoomOut')} data-tip={t('ex.map.zoomOut')} data-tip-side="left" onClick={() => engine.current?.zoomAt(.5)}><Minus size={18} /></button>
          <button type="button" aria-label={t('ex.map.centre')} data-tip={t('ex.map.centre')} data-tip-side="left" onClick={() => engine.current?.centre()}><Crosshair size={18} /></button>
        </div>
        <div className="sm-map-footer">
          <div className="sm-status-pill">
            <span className="sm-scale" aria-label={t('ex.map.scale')} data-tip={t('ex.map.scale')}>
              <span>{scale.label}</span><svg width={scale.widthPx + 2} height="5" aria-hidden="true"><path d={`M1 1V4H${scale.widthPx + 1}V1`} /></svg>
            </span>
            {pointer && <><i className="sm-status-divider" /><span className="sm-pointer-values" data-tip={t('ex.map.pointer')}>
              {Math.abs(pointer.lat).toFixed(3)}° {pointer.lat < 0 ? 'S' : 'N'}, {Math.abs(pointer.lon).toFixed(3)}° {pointer.lon < 0 ? 'W' : 'E'} · {Number.isFinite(pointer.heightM) ? Math.round(pointer.heightM).toLocaleString('en-US') : '—'} m
            </span></>}
          </div>
          <div className="sm-photo-credit">{t('ex.map.photos')}</div>
        </div>
        <RoutePanel route={route} prefer={prefer} onPrefer={onPrefer} onClear={clear} />
        {hover && <div className="sm-probe" style={{ left: Math.min(viewSize.width - 216, Math.max(12, hover.x + 15)), top: Math.min(viewSize.height - 210, Math.max(58, hover.y - 30)) }} role="status">
          <div className="sm-probe-title">{t(hover.kind === 'trail' ? 'ex.hover.trail' : 'ex.hover.route')}</div>
          {probe && <><div className={`sm-probe-body${probe.sunPart <= .001 ? ' sm-off' : ''}`}><SunGlyph size={15} off={probe.sunPart <= .001} />{t(probe.sunPart >= .999 ? 'ex.hover.sunYes' : probe.sunPart > .001 ? 'ex.hover.sunPart' : 'ex.hover.sunNo')}</div>
            <div className={`sm-probe-body${probe.earthPart <= .001 ? ' sm-off' : ''}`}><EarthGlyph size={15} off={probe.earthPart <= .001} />{t(probe.earthPart > .001 ? 'ex.hover.earthYes' : 'ex.hover.earthNo')}</div>
            <dl><dt>{t('ex.hover.height')}</dt><dd>{Math.round(probe.groundM).toLocaleString('en-US')} m</dd><dt>{t('ex.hover.slope')}</dt><dd>{probe.slopeDeg.toFixed(1)}°</dd></dl></>}
          <small>{t('ex.hover.when')}</small>
        </div>}
      </div>
    </section>
  </div>;
}
