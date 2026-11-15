// Driving by touch: a thumb pad at the bottom left and a "fast" button at the bottom right. A phone has no
// W A S D, so the pad holds those keys down for you: it sends the page the very key events a keyboard would,
// which keeps the drive code (moon/lander.ts) unaware of where a key came from. The first push starts the
// drive, as the first W does. A second finger on the picture still looks around while the thumb drives.
// Shown only where the pointer is a finger (ui/device.ts, LanderHud.tsx).
import { CaretDown, CaretLeft, CaretRight, CaretUp, Lightning } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';

const send = (type: 'keydown' | 'keyup', key: string) => window.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true }));

export function TouchDrive() {
  const t = useT();
  const held = useRef(new Set<string>());
  const padPointer = useRef<number | null>(null);
  const fastPointer = useRef<number | null>(null);
  const [knob, setKnob] = useState<{ x: number; y: number } | null>(null);
  const [fast, setFast] = useState(false);
  const release = () => { for (const key of held.current) send('keyup', key); held.current.clear(); padPointer.current = null; setKnob(null); };
  const releaseFast = () => { fastPointer.current = null; setFast(false); send('keyup', 'Shift'); };
  // Let go when a finger is cancelled or the page goes into the background.
  useEffect(() => {
    const reset = () => {
      for (const key of held.current) send('keyup', key);
      held.current.clear(); padPointer.current = null; fastPointer.current = null;
      send('keyup', 'Shift'); setKnob(null); setFast(false);
    };
    const visibility = () => { if (document.hidden) reset(); };
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', visibility);
    return () => { reset(); window.removeEventListener('blur', reset); document.removeEventListener('visibilitychange', visibility); };
  }, []);

  const steer = (ev: React.PointerEvent<HTMLDivElement>) => {
    const r = ev.currentTarget.getBoundingClientRect(), reach = r.width / 2;
    let x = (ev.clientX - r.left - reach) / reach, y = (ev.clientY - r.top - reach) / reach;
    const far = Math.hypot(x, y);
    if (far > 1) { x /= far; y /= far; }
    setKnob({ x, y });
    // forward is the easy direction; backing up and turning need a clearer push, so a slightly crooked thumb still drives straight
    const want = new Set<string>();
    if (y < -0.26) want.add('w'); else if (y > 0.42) want.add('s');
    if (x < -0.4) want.add('a'); else if (x > 0.4) want.add('d');
    for (const key of held.current) if (!want.has(key)) { send('keyup', key); held.current.delete(key); }
    // (sent again on every movement: the view forgets held keys when it stops the drive itself, e.g. for the big map)
    for (const key of want) { send('keydown', key); held.current.add(key); }
  };

  return <>
    <div className={`lv-pad${knob ? ' held' : ''}`} role="group" aria-label={t('hud.pad')}
      onPointerDown={ev => { ev.preventDefault(); ev.stopPropagation(); if (padPointer.current !== null) return; padPointer.current = ev.pointerId; ev.currentTarget.setPointerCapture(ev.pointerId); steer(ev); }}
      onPointerMove={ev => { if (padPointer.current === ev.pointerId && ev.currentTarget.hasPointerCapture(ev.pointerId)) steer(ev); }}
      onPointerUp={ev => { if (padPointer.current === ev.pointerId) release(); }}
      onPointerCancel={ev => { if (padPointer.current === ev.pointerId) release(); }} onLostPointerCapture={ev => { if (padPointer.current === ev.pointerId) release(); }} onContextMenu={ev => ev.preventDefault()}>
      <CaretUp className="lv-pad-n" size={14} weight="bold" aria-hidden="true" /><CaretDown className="lv-pad-s" size={14} weight="bold" aria-hidden="true" />
      <CaretLeft className="lv-pad-w" size={14} weight="bold" aria-hidden="true" /><CaretRight className="lv-pad-e" size={14} weight="bold" aria-hidden="true" />
      <i className="lv-pad-knob" style={knob ? { transform: `translate(${knob.x * 34}px, ${knob.y * 34}px)` } : undefined} />
    </div>
    <button type="button" className={`lv-fast${fast ? ' held' : ''}`} aria-label={t('hud.fast')} aria-pressed={fast}
      onPointerDown={ev => { ev.preventDefault(); ev.stopPropagation(); if (fastPointer.current !== null) return; fastPointer.current = ev.pointerId; ev.currentTarget.setPointerCapture(ev.pointerId); setFast(true); send('keydown', 'Shift'); }}
      onPointerUp={ev => { if (fastPointer.current === ev.pointerId) releaseFast(); }} onPointerCancel={ev => { if (fastPointer.current === ev.pointerId) releaseFast(); }}
      onLostPointerCapture={ev => { if (fastPointer.current === ev.pointerId) releaseFast(); }}
      onContextMenu={ev => ev.preventDefault()}>
      <Lightning size={20} weight="fill" /><span>{t('hud.fast')}</span>
    </button>
  </>;
}
