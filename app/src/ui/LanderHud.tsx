// The controls shown while you "stand" at a spot: where you are, a compass tape that follows the
// camera (with the real Sun and Earth marked on it), what the lander gets right now in plain words
// (click the Sun or Earth line to turn the view to it, even when it is behind a hill or below the
// horizon), and the Drive bar for MOONDA, our rover (W A S D / arrows also start driving).
// Kept small and at the edges so the rover and the middle of the view stay free.

import { ArrowLeft, HandGrabbing, Headlights, Info, Minus, Plus, SteeringWheel } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { t as tr, tn, useT } from '../i18n';
import { landerLink } from '../moon/lander';
import type { SpotTimeline } from '../science/analysis';
import { compassName, type BodyNow } from './describe';
import { EarthGlyph, SunGlyph } from './glyphs';
import './lander.css';

interface Props {
  name: string;
  sun: (BodyNow & { az: number }) | null;
  earth: (BodyNow & { az: number }) | null;
  earthNeverRises: boolean;
  mastM: number;
  /** Optional: with the mission timeline and the time on the time bar we can say "for 3 more days". */
  timeline?: SpotTimeline | null;
  cursor?: number;
  onLook(az: number, el: number): void;
  onExit(): void;
}

// The tape: 4 px per degree, drawn one and a half times round so it never runs out while turning.
const PX = 4, TAPE_FROM = -180, TAPE_TO = 540;
const tapeX = (deg: number) => (deg - TAPE_FROM) * PX;
const TURNS = [-360, 0, 360];
const LETTER: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
const MARKS: { deg: number; txt: string; cls: string }[] = [];
for (let deg = TAPE_FROM; deg <= TAPE_TO; deg += 15) {
  const a = ((deg % 360) + 360) % 360;
  if (a % 90 === 0) MARKS.push({ deg, txt: LETTER[a], cls: a === 0 ? 'card n' : 'card' });
  else if (a % 45 === 0) MARKS.push({ deg, txt: LETTER[a], cls: 'inter' });
  else if (a % 30 === 0) MARKS.push({ deg, txt: String(a), cls: 'num' });
}

/** "35 m", "1.2 km". */
function metres(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

/** "for 3 more days", "for 5 more hours", "for 20 more minutes", "for the rest of the mission"; '' when unknown. */
function howLong(hours: number | null | undefined): string {
  if (hours === undefined) return '';
  if (hours === null) return tr('hud.forRest');
  if (hours < 1) return tr('hud.forMinutes', { n: Math.max(5, Math.round((hours * 60) / 5) * 5) });
  if (hours < 36) return tn('hud.forHours', Math.round(hours));
  const d = hours / 24, shown = d < 10 ? d.toFixed(1).replace(/\.0$/, '') : String(Math.round(d));
  return tn('hud.forDays', Number(shown), { shown });
}

/** Hours until `visible` flips, null if it stays the same until the mission ends, undefined if unknown. */
function untilChange(tl: SpotTimeline | null | undefined, cursor: number | undefined, visible: (i: number) => boolean): number | null | undefined {
  if (!tl || cursor === undefined) return undefined;
  const i0 = Math.min(tl.count - 1, Math.max(0, Math.round((cursor - tl.startMs) / tl.stepMs)));
  const now = visible(i0);
  for (let i = i0 + 1; i < tl.count; i++) if (visible(i) !== now) return ((i - i0) * tl.stepMs) / 3600000;
  return null;
}

interface Line { verdict: string; note: string; on: boolean }
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

function sunLine(s: Props['sun'], until: number | null | undefined): Line {
  if (!s) return { verdict: tr('hud.working'), note: '', on: false };
  if (s.part >= 0.999) return { verdict: tr(s.el - s.sky < 2 ? 'hud.sun.just' : 'hud.sun.clear'), note: tidy(tr('hud.sun.power', { howLong: howLong(until) })), on: true };
  if (s.part > 0.001) return { verdict: tr('hud.sun.partly'), note: tr('hud.sun.partPower', { pct: Math.round(s.part * 100) }), on: true };
  if (s.el > 0) return { verdict: tidy(tr('hud.sun.hill', { howLong: howLong(until) })), note: tr('hud.sun.battery'), on: false };
  return { verdict: tidy(tr('hud.sun.below', { howLong: howLong(until) })), note: tr('hud.sun.night'), on: false };
}

function earthLine(e: Props['earth'], never: boolean, until: number | null | undefined): Line {
  if (!e) return { verdict: tr('hud.working'), note: '', on: false };
  if (e.el > e.sky) return { verdict: tr('hud.earth.view'), note: tidy(tr('hud.earth.link', { howLong: howLong(until) })), on: true };
  if (never) return { verdict: tr('hud.earth.never'), note: tr('hud.earth.relay'), on: false };
  if (e.el > 0) return { verdict: tidy(tr('hud.earth.hill', { howLong: howLong(until) })), note: tr('hud.earth.noLink'), on: false };
  return { verdict: tidy(tr('hud.earth.below', { howLong: howLong(until) })), note: tr('hud.earth.noLink'), on: false };
}

export function LanderHud({ name, sun, earth, earthNeverRises, mastM, timeline, cursor, onLook, onExit }: Props) {
  const t = useT();
  const tape = useRef<HTMLDivElement>(null);
  const degText = useRef<HTMLElement>(null);
  const zoomTip = useRef<HTMLDivElement>(null);
  const [facing, setFacing] = useState(() => compassName(landerLink.az));
  const read = () => ({ on: landerLink.walking, dist: landerLink.walkDistM, blocked: landerLink.walkBlocked, locked: landerLink.mouseLocked,
    view: landerLink.view, speed: landerLink.speedMs, lit: landerLink.lightsLit });
  const [drive, setDrive] = useState(read);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Esc first gives the captured mouse back, then stops driving, then goes back to the lander, and only then leaves the view
      if (landerLink.mouseLocked || performance.now() - landerLink.unlockedAt < 500) return;
      if (landerLink.walking) landerLink.setWalk(false);
      else if (landerLink.view !== 'spot') landerLink.setView('spot');
      else onExit();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onExit]);

  useEffect(() => {
    const apply = () => setDrive(w => {
      const n = read();
      return w.on === n.on && Math.round(w.dist) === Math.round(n.dist) && w.blocked === n.blocked && w.locked === n.locked && w.view === n.view && w.speed === n.speed && w.lit === n.lit ? w : n;
    });
    apply();
    return landerLink.subscribe(apply);
  }, []);
  const onRover = drive.view !== 'spot';

  // Follow the camera every frame without re-drawing the whole panel.
  useEffect(() => {
    let lastFov = landerLink.fovDeg, hide = 0, lastDeg = -1;
    const apply = () => {
      const az = ((landerLink.az % 360) + 360) % 360;
      if (tape.current) tape.current.style.transform = `translateX(${(-tapeX(az)).toFixed(1)}px)`;
      const deg = Math.round(az) % 360;
      if (deg !== lastDeg && degText.current) { lastDeg = deg; degText.current.textContent = `${String(deg).padStart(3, '0')}°`; }
      setFacing(compassName(az));
      const tip = zoomTip.current;
      if (tip && Math.abs(landerLink.fovDeg - lastFov) > 0.05) {
        lastFov = landerLink.fovDeg;
        tip.textContent = tr('hud.zoomX', { x: (70 / landerLink.fovDeg).toFixed(1) });
        tip.classList.add('show');
        clearTimeout(hide);
        hide = window.setTimeout(() => tip.classList.remove('show'), 1200);
      }
    };
    apply();
    const off = landerLink.subscribe(apply);
    return () => { off(); clearTimeout(hide); };
  }, []);

  const s = sunLine(sun, untilChange(timeline, cursor, i => timeline!.sunPart[i] > 0.001));
  const e = earthLine(earth, earthNeverRises, earthNeverRises ? undefined : untilChange(timeline, cursor, i => timeline!.earthEl[i] > timeline!.earthSky[i]));
  // a click turns the view to the body, or to the point on the skyline where it is hidden
  const turnTo = (b: Props['sun']) => { if (b) onLook(b.az, Math.max(b.el, b.sky)); };
  const blur = (ev: { currentTarget: HTMLElement }) => ev.currentTarget.blur();

  return (
    <div className="lv-hud">
      <div className="lv-scrim" aria-hidden="true" />
      <div className="lv-top lv-glass">
        <button className="lv-back" onClick={onExit}><ArrowLeft size={16} weight="bold" /> {t('hud.back')}</button>
        <div className="lv-place">
          <div className="lv-name">{name}</div>
          <div className="lv-sub">{onRover || drive.on
            ? <>{t('hud.roverShort')} · <b>{t('hud.fromLander', { dist: metres(drive.dist) })}</b>{drive.speed >= 0.1 && <> · <span className="mono">{drive.speed.toFixed(1)} m/s</span></>}</>
            : <>{t('hud.standingHere')} · {t('hud.eyes', { m: mastM })}</>}</div>
        </div>
      </div>

      <div className="lv-compass" role="img" aria-label={t('hud.compass', { dir: facing })}>
        <div className="lv-tape-clip">
          <div className="lv-tape" ref={tape}>
            {MARKS.map(m => <span key={m.deg} className={m.cls} style={{ left: tapeX(m.deg) }}>{m.txt}</span>)}
            {sun && TURNS.map(k => <i key={`s${k}`} style={{ left: tapeX(sun.az + k) }}><SunGlyph size={14} off={!s.on} /></i>)}
            {earth && !earthNeverRises && TURNS.map(k => <i key={`e${k}`} style={{ left: tapeX(earth.az + k) }}><EarthGlyph size={14} off={!e.on} /></i>)}
          </div>
        </div>
        <div className="lv-caret" />
        <div className="lv-facing"><b ref={degText} className="mono">000°</b> {t('hud.facing', { dir: facing })}</div>
      </div>

      <div className="lv-status lv-glass">
        <button className={`lv-row${s.on ? '' : ' off'}`} disabled={!sun} onClick={ev => { blur(ev); turnTo(sun); }} data-tip={t('hud.turnSun')}>
          <SunGlyph size={20} off={!s.on} />
          <span><span className="lv-verdict">{s.verdict}</span>{s.note && <span className="lv-note">{s.note}</span>}</span>
        </button>
        <button className={`lv-row${e.on ? '' : ' off'}`} disabled={!earth} onClick={ev => { blur(ev); turnTo(earth); }} data-tip={t('hud.turnEarth')}>
          <EarthGlyph size={20} off={!e.on} />
          <span><span className="lv-verdict">{e.verdict}</span>{e.note && <span className="lv-note">{e.note}</span>}</span>
        </button>
        <div className="lv-foot" data-tip={t('hud.note.tip')} tabIndex={0}><Info size={14} /><span>{t('hud.note')}</span></div>
      </div>

      <div className="lv-zoom lv-glass" ref={zoomTip} aria-hidden="true" />
      <div className="lv-lens lv-glass" role="group" aria-label={t('hud.zoom')}>
        <button onClick={() => landerLink.zoom(1)} aria-label={t('hud.zoomIn')} data-tip={t('hud.zoomIn')} data-tip-side="left"><Plus size={18} /></button>
        <button onClick={() => landerLink.zoom(-1)} aria-label={t('hud.zoomOut')} data-tip={t('hud.zoomOut')} data-tip-side="left"><Minus size={18} /></button>
      </div>

      <div className="lv-drive">
        {drive.on && (
          <div className="lv-keys" aria-hidden="true">
            {drive.blocked === 'slope' ? <em>{t('hud.steep')}</em> : drive.blocked === 'rock' ? <em>{t('hud.rock')}</em>
              : <><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> {t('hud.drive.move')}<i /><kbd>Shift</kbd> {t('hud.drive.fast')}<i /><kbd>V</kbd> {t('hud.drive.camera')}<i /><kbd>L</kbd> {t('hud.drive.lights')}</>}
          </div>
        )}
        <div className="lv-walkbar lv-glass" role="group" aria-label={t('hud.driveGroup')}>
          <button className={`lv-walk${drive.on ? ' on' : ''}`} aria-pressed={drive.on} onClick={ev => { blur(ev); landerLink.setWalk(!drive.on); }}
            data-tip={drive.on ? t('hud.driveStop') : t('hud.driveStart')}><SteeringWheel size={18} weight={drive.on ? 'fill' : 'regular'} /> {t('hud.drive')}</button>
          <div className="lv-seg" role="radiogroup" aria-label={t('hud.camera')}>
            {(['spot', 'third', 'first'] as const).map(v => (
              <button key={v} role="radio" aria-checked={drive.view === v} className={drive.view === v ? 'on' : ''}
                onClick={ev => { blur(ev); landerLink.setView(v); }} data-tip={t(`hud.view.${v}.tip`)}>{t(`hud.view.${v}`)}</button>
            ))}
          </div>
          <button className={`lv-light${drive.lit ? ' on' : ''}`} aria-pressed={drive.lit} aria-label={t('hud.lights')}
            onClick={ev => { blur(ev); landerLink.setLights(drive.lit ? 'off' : 'on'); }} data-tip={t('hud.lights')}><Headlights size={18} weight={drive.lit ? 'fill' : 'regular'} /></button>
        </div>
      </div>

      {!drive.on && !onRover && <div className="lv-hint lv-glass"><HandGrabbing size={16} /> {t('hud.hint')}</div>}
    </div>
  );
}
