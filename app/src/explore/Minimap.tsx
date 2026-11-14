// The corner map is an instrument: camera-up ground photo, one clear rover arrow and a quiet place name.
// Its canvas engine owns the live pose and tiles, keeping rover movement out of React.
import { ArrowsOutSimple, Minus, Plus } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { containingName, nearestNames, type MoonName } from '../data/names';
import { useLang, useT } from '../i18n';
import { roverLink } from '../moon/roverLink';
import type { LayerDef } from '../moon/layers';
import type { Vec3 } from '../science/ephemeris';
import type { RouteResult } from '../science/route';
import { fmtKm } from '../ui/format';
import { MapEngine } from './MapEngine';
import { mapImagery, sharpOpeningSpan } from './mapImagery';
import './explore.css';

interface Props {
  bodies: { sun: Vec3; earth: Vec3 };
  layers: Record<string, boolean>;
  opacity: Record<string, number>;
  layerDefs: LayerDef[];
  timeKey: number;
  mastM: number;
  route: RouteResult | null;
  names: MoonName[] | null;
  onOpen(): void;
}
export function Minimap({ bodies, layers, opacity, layerDefs, route, names, onOpen }: Props) {
  const t = useT();
  const lang = useLang();
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<MapEngine | null>(null);
  const changeZoom = useRef<(factor: number, x?: number, y?: number) => void>(() => {});
  const openDelay = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [zoomLimits, setZoomLimits] = useState({ closer: true, further: true });
  const [place, setPlace] = useState('');

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const spot = roverLink.spot;
    const p = roverLink.pose;
    let initialised = !!spot || p.on, userZoomed = false;
    let width = cv.clientWidth || 196;
    // Keep the same useful ground area on standard and Retina screens, with no more than 2x photo stretch.
    const openingAt = (lat: number, lon: number) => Math.max(60, Math.min(300000,
      Math.ceil(sharpOpeningSpan(lat, lon, width * Math.max(2, Math.min(2.5, window.devicePixelRatio || 1))) / 10) * 10));
    let opening = openingAt(spot?.lat ?? p.lat, spot?.lon ?? p.lon);
    const showLimits = () => {
      const m = engine.current;
      if (!m) return;
      const closer = m.getAcross() > 60.01, further = m.getAcross() < 299999;
      setZoomLimits(old => old.closer === closer && old.further === further ? old : { closer, further });
    };
    const map = new MapEngine(cv, { round: true, follow: true, acrossM: opening, onChange: showLimits });
    const chooseOpening = () => {
      const at = roverLink.spot ?? roverLink.pose;
      opening = openingAt(at.lat, at.lon);
      map.setAcross(opening);
      showLimits();
    };
    // The HUD mounts before the rover is placed. Choose the first scale from that visit, not its previous pose.
    const initialise = () => {
      if (initialised || !roverLink.pose.on) return;
      initialised = true;
      chooseOpening();
    };
    const offInitialise = roverLink.subscribe(initialise);
    const offIndex = mapImagery.subscribe(key => {
      if (key === undefined && !userZoomed && initialised) chooseOpening();
    });
    initialise();
    engine.current = map;
    const testWindow = window as unknown as { __moondaMinimap?: MapEngine };
    if (import.meta.env.DEV) testWindow.__moondaMinimap = map;
    const size = new ResizeObserver(entries => {
      const r = entries[0].contentRect;
      width = r.width;
      map.resize(r.width, r.height);
      if (!userZoomed && initialised) chooseOpening();
    });
    size.observe(cv);
    changeZoom.current = (factor, x, y) => {
      initialised = true; userZoomed = true;
      if (openDelay.current) { clearTimeout(openDelay.current); openDelay.current = null; }
      map.zoomAt(factor, x, y);
    };
    const wheel = (ev: WheelEvent) => {
      ev.preventDefault(); ev.stopPropagation();
      const r = cv.getBoundingClientRect();
      const delta = ev.deltaY * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? r.height : 1);
      changeZoom.current(Math.exp(-Math.max(-900, Math.min(900, delta)) * .0015 * (ev.ctrlKey ? 2.5 : 1)), ev.clientX - r.left, ev.clientY - r.top);
    };
    cv.addEventListener('wheel', wheel, { passive: false });
    showLimits();
    return () => { if (openDelay.current) clearTimeout(openDelay.current); offInitialise(); offIndex(); size.disconnect(); cv.removeEventListener('wheel', wheel); map.destroy(); engine.current = null; changeZoom.current = () => {}; if (testWindow.__moondaMinimap === map) delete testWindow.__moondaMinimap; };
  }, []);
  useEffect(() => { engine.current?.update({ bodies, route, layers, opacity, layerDefs, realSun: layers.realSun !== false }); }, [bodies, route, layers, opacity, layerDefs]);
  useEffect(() => {
    let last = 0;
    const update = () => {
      const now = performance.now();
      if (now - last < 1000) return;
      last = now;
      const p = roverLink.pose;
      if (!p.on) return;
      const inside = names ? containingName(names, p.lat, p.lon) : null;
      const near = !inside && names ? nearestNames(names, p.lat, p.lon, 1)[0] : null;
      setPlace(inside ? t(inside.kind === 'Mountain' ? 'place.on' : 'place.inside', { name: inside.name })
        : near ? t('place.from', { km: fmtKm(near.km), name: near.name })
          : t(p.lat < -80 ? 'where.southPolar' : p.lat > 80 ? 'where.northPolar' : Math.abs(p.lon) < 90 ? 'where.near' : 'where.far'));
    };
    const off = roverLink.subscribe(update);
    update();
    return off;
  }, [names, t, lang]);

  return <aside className="sm-mini" aria-label={t('ex.map.aria')}>
    <div className="sm-mini-dial">
      <canvas ref={canvas} role="button" tabIndex={0} aria-label={t('ex.map.open')} data-tip={t('ex.map.open')} data-tip-side="left"
        onClick={ev => { ev.stopPropagation(); if (openDelay.current) clearTimeout(openDelay.current); openDelay.current = setTimeout(() => { openDelay.current = null; onOpen(); }, 250); }}
        onDoubleClick={ev => { ev.preventDefault(); ev.stopPropagation(); const r = ev.currentTarget.getBoundingClientRect(); changeZoom.current(2, ev.clientX - r.left, ev.clientY - r.top); }}
        onKeyDown={ev => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); onOpen(); }
          else if (['+', '=', '-', '_'].includes(ev.key)) { ev.preventDefault(); ev.stopPropagation(); changeZoom.current(ev.key === '+' || ev.key === '=' ? 2 : .5); }
        }} />
      <button type="button" className="sm-mini-control sm-mini-zoom-out" aria-label={t('ex.map.zoomOut')} data-tip={t('ex.map.zoomOut')} data-tip-side="left"
        disabled={!zoomLimits.further} onClick={ev => { ev.stopPropagation(); ev.currentTarget.blur(); changeZoom.current(.5); }}><Minus size={14} /></button>
      <button type="button" className="sm-mini-control sm-mini-zoom-in" aria-label={t('ex.map.zoomIn')} data-tip={t('ex.map.zoomIn')} data-tip-side="left"
        disabled={!zoomLimits.closer} onClick={ev => { ev.stopPropagation(); ev.currentTarget.blur(); changeZoom.current(2); }}><Plus size={14} /></button>
      <button type="button" className="sm-mini-control sm-mini-expand" aria-label={t('ex.map.open')} data-tip={t('ex.map.open')} data-tip-side="left"
        onClick={ev => { ev.stopPropagation(); ev.currentTarget.blur(); onOpen(); }}><ArrowsOutSimple size={15} /></button>
    </div>
    <div className="sm-mini-place">{place}</div>
  </aside>;
}
