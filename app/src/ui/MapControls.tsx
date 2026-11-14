// Google-Earth-style column of small round buttons at the right edge, vertically centred:
// the AI helper, real sunlight, compass (click = north up), 2D / 3D tilt, zoom in, zoom out.
// When a right-hand panel is open the column slides to its left (styles.css, section 7).

import { Minus, Plus } from '@phosphor-icons/react';
import { useT } from '../i18n';
import { AiMark } from './AiPanel';
import { CompassNeedle, SunGlyph } from './glyphs';
import { IconButton } from './kit';
import { cameraStore } from './stores';

interface Props {
  sunOn: boolean;
  onSun(on: boolean): void;
  onNorth(): void;
  /** tilting stays on right-drag and the keys; this button switches globe / flat map */
  onTilt?(pitchDeg: number): void;
  mapMode: 'globe' | 'flat';
  onMapMode(mode: 'globe' | 'flat'): void;
  onZoom(logFactor: number): void;
  aiOpen: boolean;
  /** the AI is still working while its panel is closed */
  aiBusy?: boolean;
  onAi(): void;
}

export function MapControls({ sunOn, onSun, onNorth, onZoom, aiOpen, aiBusy, onAi, mapMode, onMapMode }: Props) {
  const t = useT();
  const cam = cameraStore.use();
  const flat = mapMode === 'flat';
  return (
    <div className="map-controls" role="group" aria-label={t('map.controls')}>
      <IconButton size="lg" variant="glass" tipSide="left" className={`ctl-ai${aiBusy ? ' busy' : ''}`} pressed={aiOpen} onClick={onAi}
        label={aiBusy ? t('map.aiBusy') : t('map.aiTip')}>
        <AiMark size={18} /><span className="ctl-ai-badge" aria-hidden="true">AI</span>
      </IconButton>
      <IconButton size="lg" variant="glass" tipSide="left" className="ctl-sun" onClick={() => onSun(!sunOn)} aria-checked={sunOn} role="switch"
        label={sunOn ? t('map.sunOn') : t('map.sunOff')}>
        <SunGlyph size={20} off={!sunOn} />
      </IconButton>
      <IconButton size="lg" variant="glass" tipSide="left" className="ctl-compass" onClick={onNorth} label={t('map.north')}>
        <CompassNeedle size={22} rotate={flat ? 0 : -cam.heading} />
      </IconButton>
      <IconButton size="lg" variant="glass" tipSide="left" className="ctl-tilt" onClick={() => onMapMode(flat ? 'globe' : 'flat')} pressed={flat}
        label={flat ? t('map.toGlobe') : t('map.toFlat')}>
        <b>{flat ? '3D' : '2D'}</b>
      </IconButton>
      <IconButton size="lg" variant="glass" tipSide="left" className="ctl-zoom" onClick={() => onZoom(0.9)} label={t('map.zoomIn')}><Plus size={16} /></IconButton>
      <IconButton size="lg" variant="glass" tipSide="left" className="ctl-zoom" onClick={() => onZoom(-0.9)} label={t('map.zoomOut')}><Minus size={16} /></IconButton>
    </div>
  );
}
