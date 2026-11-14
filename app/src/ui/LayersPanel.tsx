// The Layers box: useful switches, compact colour keys and colour-map strength.

import { X } from '@phosphor-icons/react';
import type { CSSProperties } from 'react';
import { useT, type Key } from '../i18n';
import { CLASS_LAYERS, layerCoverage, layerHelp, layerSource, layerTitle, type LayerDef, type LayerGroup, type LegendStop } from '../moon/layers';
import { Help } from './Help';
import { IconButton, useReachesControls } from './kit';

interface Props {
  /** `title` and `note` are only the English fallback: the words on screen come from the group of the layers inside. */
  groups: { title: string; group?: LayerGroup; note?: string; layers: LayerDef[] }[];
  state: Record<string, boolean>;
  opacity: Record<string, number>;
  onToggle(id: string, on: boolean): void;
  onOpacity(id: string, v: number): void;
  onClose(): void;
  /** true while the box is tall enough to reach the map controls (they then move aside). */
  onReach?(reaches: boolean): void;
}

/** A tidy number with a real minus sign; whole numbers once the scale is wide enough for decimals not to matter. */
const num = (v: number, whole: boolean) => { const r = whole ? Math.round(v) : Math.round(v * 10) / 10; return `${r < 0 ? '−' : ''}${Math.abs(r)}`; };

/** A colour key. Kelvin is shown as °C and metres as km, so the numbers mean something to everyone. */
export function Legend({ stops, units }: { stops: LegendStop[]; units?: string }) {
  const t = useT();
  if (!stops?.length) return null;
  const min = stops[0].value, max = stops[stops.length - 1].value;
  if (stops.length === 2 && min === 0 && max === 1) {
    return <div className="legend-one"><i style={{ background: stops[1].color }} />{t('layers.neverLit')}</div>;
  }
  const grad = stops.map(s => `${s.color} ${((s.value - min) / (max - min || 1)) * 100}%`).join(', ');
  const conv = units === 'K' ? (v: number) => v - 273.15 : units === 'm' ? (v: number) => v / 1000 : (v: number) => v;
  const unit = units === 'K' ? ' °C' : units === 'm' ? ' km' : units === '%' || units === '°' ? units : units ? ` ${units}` : '';
  const tight = unit === '%' || unit === '°';
  const whole = Math.abs(conv(max) - conv(min)) >= 20;
  const tick = (v: number, last: boolean) => `${num(conv(v), whole)}${tight || last ? unit : ''}`;
  return (
    <div className="legend">
      <div className="legend-bar" style={{ background: `linear-gradient(90deg, ${grad})` }} />
      <div className="legend-ticks"><span>{tick(min, false)}</span><span>{tick((min + max) / 2, false)}</span><span>{tick(max, true)}</span></div>
    </div>
  );
}

/** The colour key of a layer: a list of swatches for maps that show classes, a scale bar for the rest. */
export function LayerLegend({ layer }: { layer: Pick<LayerDef, 'id' | 'legend' | 'units'> }) {
  const t = useT();
  const classes = CLASS_LAYERS[layer.id];
  if (classes) {
    return (
      <div className="legend-classes">
        {classes.map(c => <div key={c.key} className="legend-one"><i style={{ background: c.color }} />{t(c.key as Key)}</div>)}
        {layer.id === 'waterice' && <div className="legend-marker-note">{t('layer.waterice.markers')}</div>}
      </div>
    );
  }
  return layer.legend ? <Legend stops={layer.legend} units={layer.units} /> : null;
}
export function LayersPanel({ groups, state, opacity, onToggle, onOpacity, onClose, onReach }: Props) {
  const root = useReachesControls(r => onReach?.(r));
  const t = useT();
  return (
    <section ref={root} className="layers panel" role="dialog" aria-label={t('layers.aria')}>
      <header className="drawer-head">
        <h2>{t('layers.title')}</h2>
        <span className="drawer-gap" />
        <IconButton size="sm" label={t('layers.close')} onClick={onClose}><X size={16} /></IconButton>
      </header>
      <div className="layers-body">
        {groups.map(g => {
          const kind = g.group ?? g.layers[0]?.group;
          const groupTitle = kind ? t(`layers.group.${kind}`) : g.title;
          const groupNote = g.note;
          return (
          <div key={g.title} className="layer-group">
            <div className="layer-group-title">{groupTitle}{groupNote && <span>{groupNote}</span>}</div>
            {g.layers.map(l => {
              const on = !!state[l.id];
              const overlay = l.group === 'science' || l.id === 'height';
              const strength = opacity[l.id] ?? 0.7;
              const title = layerTitle(l), source = layerSource(l), coverage = layerCoverage(l);
              return (
                <div key={l.id} className={`layer${on ? ' on' : ''}`}>
                  <label className="layer-row" htmlFor={`layer-${l.id}`}>
                    <span className="layer-text">
                      <span className="layer-title">{title}</span>
                      {coverage && <small style={{ color: 'var(--text-3)', fontSize: 11 }}>{coverage}</small>}
                    </span>
                    <Help side="left" text={<>{layerHelp(l)}{source && <span className="layer-help-source">{t('place.source', { name: source })}</span>}</>} />
                    <input id={`layer-${l.id}`} type="checkbox" className="sr-only" checked={on} onChange={e => onToggle(l.id, e.target.checked)} />
                    <span className="switch" aria-hidden="true"><i /></span>
                  </label>
                  {on && (l.legend || overlay) && (
                    <div className="layer-extra">
                      {l.legend && <LayerLegend layer={l} />}
                      {overlay && (
                        <label className="strength">
                          <span>{t('layers.strength')}</span>
                          <input type="range" min={0.2} max={1} step={0.05} value={strength} style={{ '--fill': `${((strength - 0.2) / 0.8) * 100}%` } as CSSProperties}
                            aria-label={t('layers.strength.aria', { name: title })} onChange={e => onOpacity(l.id, +e.target.value)} />
                          <span className="strength-val">{Math.round(strength * 100)}%</span>
                        </label>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          );
        })}
      </div>
    </section>
  );
}
