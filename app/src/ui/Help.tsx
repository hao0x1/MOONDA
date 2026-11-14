// A small "?" that explains something in one or two plain sentences.
// A portal keeps the short explanation clear of panel edges.

import { Question } from '@phosphor-icons/react';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';

export function Help({ text, label, side }: { text: ReactNode; label?: string; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  const t = useT();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const id = useId();
  const show = () => {
    // Sideways help sits outside the panel, leaving the row being read clear.
    const target = side === 'left' || side === 'right' ? btn.current!.closest('.layers, .drawer') ?? btn.current! : btn.current!;
    const r = target.getBoundingClientRect(), b = btn.current!.getBoundingClientRect();
    setAnchor(new DOMRect(r.x, b.y, r.width, b.height));
  };
  const hide = () => { setAnchor(null); setPos(null); };
  useLayoutEffect(() => {
    if (!anchor || !bubble.current) return;
    const w = bubble.current.offsetWidth, h = bubble.current.offsetHeight, gap = 8;
    const chosen = side ?? (anchor.top < h + 16 ? 'bottom' : 'top');
    let x = anchor.left + anchor.width / 2 - w / 2;
    let y = chosen === 'bottom' ? anchor.bottom + gap : anchor.top - h - gap;
    if (chosen === 'left' || chosen === 'right') {
      x = chosen === 'left' ? anchor.left - w - gap : anchor.right + gap;
      y = anchor.top + anchor.height / 2 - h / 2;
    }
    setPos({ x: Math.max(8, Math.min(x, window.innerWidth - w - 8)), y: Math.max(8, Math.min(y, window.innerHeight - h - 8)) });
  }, [anchor, side, text]);
  return (
    <>
      <button ref={btn} type="button" className="help-btn" aria-label={label ?? t('help.what')} aria-describedby={anchor ? id : undefined}
        onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onKeyDown={e => { if (e.key === 'Escape' && pos) { e.stopPropagation(); hide(); } }}
        onClick={e => { e.stopPropagation(); e.preventDefault(); if (anchor) hide(); else show(); }}><Question size={15} aria-hidden="true" /></button>
      {anchor && createPortal(
        <div ref={bubble} role="tooltip" id={id} className="tooltip" style={pos ? { left: pos.x, top: pos.y } : { left: 0, top: 0, visibility: 'hidden' }}>{text}</div>,
        document.body,
      )}
    </>
  );
}
