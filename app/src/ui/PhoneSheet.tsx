import { useEffect, useRef, useState, type RefObject } from 'react';
import { useT } from '../i18n';
import { isPhone, isTouch } from './device';

const phoneLayout = () => isPhone() || (isTouch() && matchMedia('(max-height: 520px)').matches);

// Keep rotation in sync with the two phone media queries.
export function usePhoneLayout() {
  const [phone, setPhone] = useState(phoneLayout);
  useEffect(() => {
    const update = () => setPhone(phoneLayout());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return phone;
}

/** open = true: the sheet opens at full height (AI, a Compare that has plans); else it opens at its short peek. */
export function usePhoneSheet(root: RefObject<HTMLElement | null>, active = true, resetKey?: unknown, open = false) {
  const phone = usePhoneLayout();
  const [expanded, setExpanded] = useState(open);
  const skipClick = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => { setExpanded(openRef.current); }, [active, resetKey]);

  // Drag the sheet by its grab bar OR anywhere on its header (the owner tried the title first, as in Google Earth).
  // Listened to natively on the sheet, so every sheet gets it without wiring each header; a finger that moves less
  // than 6 px is still a tap, so the header's own buttons keep working.
  useEffect(() => {
    const el = root.current;
    if (!phone || !el) return;
    let held: { id: number; y: number; height: number; lastY: number; lastTime: number; velocity: number; moved: boolean } | null = null;
    const limits = () => ({
      peek: parseFloat(getComputedStyle(el).getPropertyValue('--phone-peek')) || 280,
      max: window.innerHeight - Math.max(72, window.innerHeight * .1),
    });
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || held) return;
      const target = e.target as Element | null;
      if (!target?.closest(GRAB) || target.closest('input, textarea, select, [contenteditable]')) return;
      held = { id: e.pointerId, y: e.clientY, height: el.getBoundingClientRect().height, lastY: e.clientY, lastTime: performance.now(), velocity: 0, moved: false };
    };
    const move = (e: PointerEvent) => {
      if (!held || e.pointerId !== held.id) return;
      if (!held.moved) {
        if (Math.abs(e.clientY - held.y) < 6) return;
        held.moved = true;
        el.style.setProperty('--phone-sheet-size', `${held.height}px`);
        el.classList.add('phone-sheet-dragging');
      }
      e.preventDefault();
      const now = performance.now();
      held.velocity = (e.clientY - held.lastY) / Math.max(1, now - held.lastTime);
      held.lastY = e.clientY; held.lastTime = now;
      const { peek, max } = limits();
      el.style.setProperty('--phone-sheet-size', `${Math.max(peek * .6, Math.min(max, held.height + held.y - e.clientY))}px`);
    };
    const up = (e: PointerEvent) => {
      if (!held || e.pointerId !== held.id) return;
      const was = held; held = null;
      if (!was.moved) return;
      if (e.type !== 'pointercancel') {
        const { peek, max } = limits();
        const height = el.getBoundingClientRect().height;
        const velocity = performance.now() - was.lastTime < 120 ? was.velocity : 0;
        setExpanded(height - velocity * 180 > (peek + max) / 2);
        skipClick.current = true;
        window.setTimeout(() => { skipClick.current = false; }, 400);
      }
      el.classList.remove('phone-sheet-dragging');
      el.style.removeProperty('--phone-sheet-size');
    };
    // a drag that ends on a button must not also press it
    const click = (e: MouseEvent) => { if (skipClick.current) { skipClick.current = false; e.preventDefault(); e.stopPropagation(); } };
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    el.addEventListener('click', click, true);
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      el.removeEventListener('click', click, true);
      el.classList.remove('phone-sheet-dragging');
      el.style.removeProperty('--phone-sheet-size');
    };
  }, [phone, root]);

  return {
    phone, expanded, setExpanded,
    className: phone ? ` phone-sheet${expanded ? ' phone-sheet-expanded' : ' phone-sheet-peek'}` : '',
    handle: { onClick: () => setExpanded(v => !v) },
  };
}

/** Where a finger can grab a sheet: its bar and its header (title, close, the place's name and line). */
const GRAB = '.phone-sheet-handle, .place-head, .drawer-head, .ai-head, .phone-sheet-summary';

/** The grab bar alone, as in Google Earth: drag it, or tap it to open or fold the sheet. */
export function PhoneSheetHandle({ sheet }: { sheet: ReturnType<typeof usePhoneSheet> }) {
  const t = useT();
  if (!sheet.phone) return null;
  return <button type="button" className="phone-sheet-handle" aria-expanded={sheet.expanded}
    aria-label={t(sheet.expanded ? 'place.hide' : 'place.show')} {...sheet.handle}>
    <i aria-hidden="true" />
  </button>;
}
