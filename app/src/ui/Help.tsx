// A small "?" that explains something in one or two plain sentences.
// The tooltip floats above everything (portal) so it never pushes or covers other controls.

import { Question } from '@phosphor-icons/react';
import { useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';

export function Help({ text, label }: { text: ReactNode; label?: string }) {
  const t = useT();
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  const show = () => {
    const r = btn.current!.getBoundingClientRect();
    const below = r.top < 160;
    setPos({ x: Math.min(Math.max(12, r.left + r.width / 2 - 150), window.innerWidth - 312), y: below ? r.bottom + 8 : r.top - 8, below });
  };
  const hide = () => setPos(null);
  return (
    <>
      <button ref={btn} type="button" className="help-btn" aria-label={label ?? t('help.what')} aria-describedby={pos ? id : undefined}
        onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onKeyDown={e => { if (e.key === 'Escape' && pos) { e.stopPropagation(); hide(); } }}
        onClick={e => { e.stopPropagation(); e.preventDefault(); if (pos) hide(); else show(); }}><Question size={15} aria-hidden="true" /></button>
      {pos && createPortal(
        <div role="tooltip" id={id} className="tooltip" style={{ left: pos.x, top: pos.y, transform: pos.below ? undefined : 'translateY(-100%)' }}>{text}</div>,
        document.body,
      )}
    </>
  );
}
