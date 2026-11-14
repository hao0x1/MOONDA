// The controls shown while you "stand" at a spot: where you are, a compass tape that follows the
// camera (with the real Sun and Earth marked on it), what the lander gets right now in plain words
// (click the Sun or Earth line to turn the view to it, even when it is behind a hill or below the
// horizon), and the Drive bar for MOONDA, our rover (W A S D / arrows also start driving).
// Kept small and at the edges so the rover and the middle of the view stay free.

import { ArrowCounterClockwise, ArrowLeft, HandGrabbing, Headlights, Info, Minus, Plus, SteeringWheel } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { t as tr, tn, useT } from '../i18n';
import type { MoonName } from '../data/names';
import { Minimap } from '../explore/Minimap';
import { fmtDist } from '../explore/format';
import { landerLink } from '../moon/lander';
import type { LayerDef } from '../moon/layers';
import { roverLink, surfaceDistM, type Waypoint } from '../moon/roverLink';
import type { Vec3 } from '../science/ephemeris';
import type { RouteResult } from '../science/route';
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
  onOpenMap(): void;
  /** For the minimap: Sun and Earth at the time on the time bar (and a number naming that moment), the planned route, the official names. */
  bodies: { sun: Vec3; earth: Vec3 };
  layers: Record<string, boolean>;
  opacity: Record<string, number>;
  layerDefs: LayerDef[];
  timeKey: number;
  route: RouteResult | null;
  names: MoonName[] | null;
}

/** The little signs of the waypoint marks on the compass tape (as on the markers over the view). */
const WP_SIGN: Record<string, string> = {
  start: '<svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M7.5 13h7l1.2-3.9a4.9 4.9 0 0 0-9.4 0Z" fill="currentColor" stroke-width="1"/><path d="M8 13 6.2 17M14 13l1.8 4"/></svg>',
  dest: '<svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M7.2 17.5V4.8"/><path d="M7.9 5.3h7.8l-2 2.7 2 2.7H7.9Z" fill="currentColor" stroke-width="0.8"/></svg>',
};

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

export function LanderHud({ name, sun, earth, earthNeverRises, mastM, timeline, cursor, onLook, onExit, bodies, layers, opacity, layerDefs, timeKey, route, names, onOpenMap }: Props) {
  const t = useT();
  const tape = useRef<HTMLDivElement>(null);
  const degText = useRef<HTMLElement>(null);
  const zoomTip = useRef<HTMLDivElement>(null);
  const [facing, setFacing] = useState(() => compassName(landerLink.az));
  const read = () => {
    const home = roverLink.home, p = roverLink.pose;
    return { on: landerLink.walking, dist: landerLink.walkDistM, blocked: landerLink.walkBlocked, locked: landerLink.mouseLocked,
      view: landerLink.view, speed: landerLink.speedMs, lit: landerLink.lightsLit,
      // the rover has left its place by the lander (Reset rover is offered)
      away: !!home && p.on && surfaceDistM(home.lat, home.lon, p.lat, p.lon) > 3 };
  };
  // the pins shown as waypoints: one small mark each on the compass tape (placed every frame, below)
  const [wps, setWps] = useState<Waypoint[]>(() => roverLink.waypoints.filter(w => w.kind !== 'next'));
  useEffect(() => roverLink.onWaypoints(() => setWps(roverLink.waypoints.filter(w => w.kind !== 'next'))), []);
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
      return w.on === n.on && Math.round(w.dist) === Math.round(n.dist) && w.blocked === n.blocked && w.locked === n.locked && w.view === n.view && w.speed === n.speed && w.lit === n.lit && w.away === n.away ? w : n;
    });
    apply();
    const offs = [landerLink.subscribe(apply), roverLink.subscribe(apply)];
    return () => offs.forEach(o => o());
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
      // the waypoint marks: each at its compass bearing from where you are (three copies, as the tape runs round)
      for (const el of tape.current?.querySelectorAll<HTMLElement>('.lv-wp') ?? []) {
        const seen = roverLink.seen.get(el.dataset.id ?? '');
        if (!seen) { el.style.display = 'none'; continue; }
        el.style.display = '';
        el.style.left = `${tapeX(seen.az + Number(el.dataset.turn))}px`;
        const label = `${el.dataset.name}, ${fmtDist(seen.distM)}`;
        if (el.title !== label) el.title = label;
      }
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
    const offs = [landerLink.subscribe(apply), roverLink.subscribe(apply)];
    return () => { offs.forEach(o => o()); clearTimeout(hide); };
  }, [wps]);

  const s = sunLine(sun, untilChange(timeline, cursor, i => timeline!.sunPart[i] > 0.001));
  const e = earthLine(earth, earthNeverRises, earthNeverRises ? undefined : untilChange(timeline, cursor, i => timeline!.earthEl[i] > timeline!.earthSky[i]));
  // a click turns the view to the body, or to the point on the skyline where it is hidden
  const turnTo = (b: Props['sun']) => { if (b) onLook(b.az, Math.max(b.el, b.sky)); };
  const blur = (ev: { currentTarget: HTMLElement }) => ev.currentTarget.blur();

  return (
    <div className="lv-hud">
      <div className="lv-scrim" aria-hidden="true" />
      <div className="lv-top lv-glass">
        <button className="lv-back" onClick={onExit} data-tip={t('ex.back.tip')}><ArrowLeft size={16} weight="bold" /> {t('hud.back')}</button>
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
            {wps.map(w => TURNS.map(k => (
              <b key={`${w.id}:${k}`} className={`lv-wp k-${w.kind}`} data-id={w.id} data-turn={k} data-name={w.label} style={{ display: 'none', '--ring': w.color } as React.CSSProperties}
                >{w.kind === 'pin' ? w.letter : <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: WP_SIGN[w.kind] ?? WP_SIGN.dest }} />}</b>
            )))}
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
              : drive.locked ? <>{t('ex.locked')}<i /><kbd>Esc</kbd> {t('ex.locked.esc')}</>
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
          {drive.away && (
            <button className="lv-reset" aria-label={t('ex.reset')} onClick={ev => { blur(ev); roverLink.reset(); }} data-tip={t('ex.reset.tip')}><ArrowCounterClockwise size={18} /></button>
          )}
        </div>
      </div>

      {!drive.on && !onRover && <div className="lv-hint lv-glass"><HandGrabbing size={16} /> {t('hud.hint')}</div>}

      <Minimap bodies={bodies} layers={layers} opacity={opacity} layerDefs={layerDefs} timeKey={timeKey} mastM={mastM} route={route} names={names} onOpen={onOpenMap} />
    </div>
  );
}
