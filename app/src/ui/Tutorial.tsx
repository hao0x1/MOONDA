// The first-visit tour, as six small objectives in ONE banner at the top of the page ("2 · Pick a spot ·
// Click anywhere on the Moon"). It watches what the visitor really does, all the time and in any order: whatever
// they have done is ticked off, and the banner always shows the next thing still to try, with a soft ring on the
// control to use. Nothing is blocked and nothing has to be clicked to go on. It follows them onto the surface
// after "Land here" and back to the map. "Skip" passes one objective; the cross closes the tour.
// Opened from the start screen or the Tutorial button (tutorialStore).

import { Check, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT, type Key } from '../i18n';
import { roverLink } from '../moon/roverLink';
import { tutorialStore } from './tutorialStore';
import './tutorial.css';

const TASKS = ['move', 'pick', 'land', 'drive', 'compare', 'layers'] as const;
type Task = typeof TASKS[number];
interface Box { x: number; y: number; width: number; height: number }
/** What the banner says and points at right now. */
interface Show { task: Task | 'finish'; body: Key; ring: Box | null; ghost: { kind: 'drag' | 'click'; x: number; y: number } | null; top: number }

function boxOf(selector: string, label?: string): Box | null {
  const el = [...document.querySelectorAll<HTMLElement>(selector)].find(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (!label || [el.textContent, el.getAttribute('aria-label')].some(text => text?.trim().startsWith(label)));
  });
  if (!el) return null;
  const r = el.getBoundingClientRect(), pad = 5;
  return { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}
const isStanding = () => !!document.querySelector('.app.standing');
const hasSpot = () => !!document.querySelector('.place');
const planCount = () => Number.parseInt(document.querySelector('.topbar .tb-count')?.textContent ?? '0', 10) || 0;
/** The open middle of the Moon, clear of the left panel. */
const moonCentre = () => ({ x: innerWidth * (innerWidth < 760 ? .5 : .56), y: innerHeight * .46 });

export function Tutorial() {
  const { active, run } = tutorialStore.use();
  return active ? <Tour key={run} /> : null;
}

function Tour() {
  const t = useT();
  const [done, setDone] = useState<Record<Task, boolean>>({ move: false, pick: false, land: false, drive: false, compare: false, layers: false });
  /** the objective just completed, shown ticked for a moment before the next one slides in */
  const [ticked, setTicked] = useState<Task | null>(null);
  const [show, setShow] = useState<Show | null>(null);
  const [visible, setVisible] = useState(false);
  // what the visitor has done since the tour opened (plain fields: read every frame, never drawn)
  const seen = useRef({ moved: false, layerSwitched: false, plans0: -1, dist0: 0, tick: 0, finish: 0 });
  const live = useRef({ done, ticked });
  useEffect(() => { live.current = { done, ticked }; }, [done, ticked]);

  // The visitor's own gestures: a real drag or a scroll on the Moon; any switch flipped in the Layers box.
  useEffect(() => {
    let down: { x: number; y: number } | null = null;
    const start = (e: PointerEvent) => { down = e.target instanceof Element && e.target.closest('.moon-canvas') ? { x: e.clientX, y: e.clientY } : null; };
    const move = (e: PointerEvent) => { if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) >= 24) seen.current.moved = true; };
    const end = () => { down = null; };
    const wheel = (e: WheelEvent) => { if (e.target instanceof Element && e.target.closest('.moon-canvas')) seen.current.moved = true; };
    const change = (e: Event) => { if (e.target instanceof Element && e.target.closest('.layers')) seen.current.layerSwitched = true; };
    window.addEventListener('pointerdown', start, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('wheel', wheel, { capture: true, passive: true });
    window.addEventListener('change', change, true);
    return () => {
      window.removeEventListener('pointerdown', start, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('wheel', wheel, true);
      window.removeEventListener('change', change, true);
    };
  }, []);

  useEffect(() => {
    const s = seen.current;
    let frame = 0, last = -Infinity, signature = '';
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - last < 100) return;
      last = now;
      const ready = !document.querySelector('.start'); // the start screen is still leaving
      setVisible(ready);
      if (!ready) return;
      const standing = isStanding(), spot = hasSpot();
      if (s.plans0 < 0) { s.plans0 = planCount(); s.dist0 = roverLink.distM; }
      if (roverLink.distM < s.dist0) s.dist0 = 0; // a new landing starts a new trail
      // Everything is checked all the time, so a thing done early (or in another order) is never asked for again.
      const d = live.current.done;
      const state: Record<Task, boolean> = {
        move: d.move || s.moved,
        pick: d.pick || spot || standing,
        land: d.land || standing,
        drive: d.drive || (standing && roverLink.distM - s.dist0 > 2),
        compare: d.compare || planCount() > s.plans0,
        layers: d.layers || s.layerSwitched,
      };
      const current = TASKS.find(k => !d[k]) ?? null;
      if (TASKS.some(k => state[k] !== d[k])) {
        // the one on show gets its tick and a moment to be seen; the others are simply noted
        if (current && state[current] && !live.current.ticked) {
          setTicked(current);
          live.current.ticked = current;
          window.clearTimeout(s.tick);
          s.tick = window.setTimeout(() => setTicked(null), 950);
        }
        live.current.done = state;
        setDone(state);
      }
      const next = live.current.ticked ?? TASKS.find(k => !state[k]) ?? null;
      if (!next && !s.finish) s.finish = window.setTimeout(() => tutorialStore.stop(), 3200);
      // A step whose control lives in a spot's panel: a visitor who skipped "Pick a spot" gets a good one
      // (the sunny ridge by the south pole) through the app's own selection hook, so the control is there.
      if ((next === 'land' || next === 'compare' || next === 'drive') && !standing && !spot) {
        (window as unknown as { __moondaTest?: { select(lat: number, lon: number): void } }).__moondaTest?.select(-89.45, -137.3);
      }
      let body: Key = 'tutorial.finish.body', ring: Box | null = null, ghost: Show['ghost'] = null;
      const c = moonCentre();
      if (next === 'move') { body = 'tutorial.move.body'; ghost = { kind: 'drag', ...c }; }
      else if (next === 'pick') { body = 'tutorial.pick.body'; ghost = { kind: 'click', ...c }; }
      else if (next === 'land') { body = 'tutorial.land.body'; ring = boxOf('.place-actions .btn.primary'); }
      else if (next === 'drive') {
        if (standing) { body = 'tutorial.drive.body'; ring = document.querySelector('.lv-walk.on') ? null : boxOf('.lv-walk'); }
        else { body = 'tutorial.drive.land'; ring = boxOf('.place-actions .btn.primary'); }
      } else if (next === 'compare') {
        if (standing) { body = 'tutorial.compare.back'; ring = boxOf('.lv-back'); }
        else { body = 'tutorial.compare.body'; ring = boxOf('.place-actions .btn:nth-child(2)') ?? boxOf('.topbar .tb[aria-expanded]', t('top.compare')); }
      } else if (next === 'layers') {
        if (standing) { body = 'tutorial.layers.back'; ring = boxOf('.lv-back'); }
        else if (document.querySelector('.layers.panel')) body = 'tutorial.layers.open';
        else { body = 'tutorial.layers.body'; ring = boxOf('.topbar .tb[aria-expanded]', t('top.layers')); }
      }
      if (live.current.ticked) { ring = null; ghost = null; }
      // under the top bar on the map; under the compass on the surface
      const value: Show = { task: next ?? 'finish', body, ring, ghost, top: standing ? 96 : 76 };
      const sig = JSON.stringify(value);
      if (sig !== signature) { signature = sig; setShow(value); }
    };
    tick(performance.now());
    return () => { cancelAnimationFrame(frame); window.clearTimeout(s.tick); window.clearTimeout(s.finish); };
  }, [t]);

  if (!show) return null;
  const finish = show.task === 'finish';
  const n = finish ? TASKS.length : TASKS.indexOf(show.task as Task) + 1;
  const isTicked = !finish && ticked === show.task;
  const skip = () => { if (!finish) setDone(d => ({ ...d, [show.task]: true })); };
  return createPortal(
    <div className={`moonda-tutorial${visible ? ' moonda-tutorial-visible' : ''}`}>
      {show.ring && <div className="moonda-tutorial-ring" style={{ left: show.ring.x, top: show.ring.y, width: show.ring.width, height: show.ring.height }} />}
      {show.ghost && <i className={`moonda-tutorial-ghost moonda-tutorial-ghost-${show.ghost.kind}`} aria-hidden="true" style={{ left: show.ghost.x, top: show.ghost.y }} />}
      <div className={`moonda-tutorial-banner${isTicked || finish ? ' done' : ''}`} role="status" aria-live="polite" aria-label={t('tutorial.aria')} data-task={show.task} style={{ top: show.top }}>
        <span className="moonda-tutorial-num" aria-hidden="true">{isTicked || finish ? <Check size={13} weight="bold" /> : n}</span>
        <div key={`${show.task}${show.body}${isTicked}`} className="moonda-tutorial-text">
          <b>{t(`tutorial.${show.task}.title` as Key)}</b>
          <span>{isTicked ? t('tutorial.done') : t(show.body)}</span>
        </div>
        <div className="moonda-tutorial-dots" aria-label={t('tutorial.count', { n, total: TASKS.length })}>
          {TASKS.map(k => <i key={k} className={done[k] ? 'done' : k === show.task ? 'on' : undefined} />)}
        </div>
        {!finish && <button type="button" className="moonda-tutorial-skip" onClick={skip} data-tip={t('tutorial.skipStep.tip')}>{t('tutorial.skipStep')}</button>}
        <button type="button" className="moonda-tutorial-close" aria-label={t('tutorial.skip')} data-tip={t('tutorial.skip')} onClick={tutorialStore.stop}><X size={14} weight="bold" /></button>
      </div>
    </div>, document.body,
  );
}
