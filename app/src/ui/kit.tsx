// Shared building blocks. Every panel, button, switch and menu in the app is made from these,
// so everything lines up and behaves the same way (styles: the "kit" part of styles.css).

import { CaretDown, Check } from '@phosphor-icons/react';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Help } from './Help';

/** The MOONDA mark's outline: an M whose top edge is the lunar skyline seen from de Gerlache Rim 2 (88.39°S, 68.87°W),
 *  computed by our horizon code (science/terrain.ts) from NASA LOLA heights, azimuth 141.75°–184.5°, stretched 12.5× upward.
 *  Source and rules: MOONDA/brand/logo/final (README.md, make-mark.mjs). index.html repeats it for the boot screen. */
export const MARK_RIDGE = 'M0 100 L0 56.4 C0.4 55.4 1.6 52.3 2.3 50.3 C3.1 48.3 3.9 46.3 4.7 44.3 C5.5 42.4 6.2 40.4 7 38.6 C7.8 36.8 8.6 35.1 9.4 33.5 C10.1 31.8 10.9 30.3 11.7 28.9 C12.5 27.4 13.3 26.1 14 24.8 C14.8 23.6 15.6 22.4 16.4 21.2 C17.2 20.1 17.9 19 18.7 18 C19.5 17 20.3 16.1 21.1 15.2 C21.8 14.4 22.6 13.7 23.4 13.2 C24.2 12.6 25 12.2 25.7 11.9 C26.5 11.6 27.3 11.5 28.1 11.5 C28.9 11.5 29.6 11.6 30.4 11.8 C31.2 12.1 32 12.4 32.8 12.8 C33.5 13.2 34.3 13.6 35.1 14.1 C35.9 14.6 36.7 15.1 37.4 15.6 C38.2 16.1 39 16.7 39.8 17.2 C40.6 17.8 41.3 18.4 42.1 19 C42.9 19.7 43.7 20.4 44.4 21.2 C45.2 22 46 23 46.8 24 C47.6 25.1 48.3 26.3 49.1 27.5 C49.9 28.7 50.7 30.2 51.5 31.2 C52.2 32.2 53 33.3 53.8 33.6 C54.6 33.8 55.4 33.5 56.1 32.6 C56.9 31.7 57.7 29.9 58.5 28.1 C59.3 26.2 60 23.8 60.8 21.5 C61.6 19.3 62.4 16.7 63.2 14.6 C63.9 12.5 64.7 10.5 65.5 8.8 C66.3 7.1 67.1 5.6 67.8 4.3 C68.6 3.1 69.4 2.1 70.2 1.3 C71 0.6 71.7 0.1 72.5 0 C73.3 -0.1 74.1 0.1 74.9 0.6 C75.6 1.1 76.4 2.1 77.2 3 C78 3.9 78.8 5 79.5 6 C80.3 6.9 81.1 7.7 81.9 8.4 C82.7 9.2 83.4 9.8 84.2 10.7 C85 11.5 85.8 12.4 86.6 13.6 C87.3 14.8 88.1 16.1 88.9 17.8 C89.7 19.5 90.5 21.5 91.2 23.7 C92 25.9 92.8 28.3 93.6 31 C94.4 33.6 95.1 36.5 95.9 39.5 C96.7 42.6 97.6 46.3 98.3 49.3 C98.9 52.2 99.7 55.8 100 57.1 L100 100 L80 100 L80 35.4 L53.8 62 L20 30.5 L20 100 Z';

/** The MOONDA mark: the skyline M with the low polar Sun in its notch. Also the app icon and favicon. */
export function MoonMark({ size = 24 }: { size?: number }) {
  return (
    <svg className="moon-mark" width={size} height={size} viewBox="0 -1 100 101" aria-hidden="true">
      <circle cx="53.8" cy="27" r="11.5" fill="var(--sun)" />
      <path d={MARK_RIDGE} fill="currentColor" />
    </svg>
  );
}

/** The moon that is the logo's first "O": a white O with the yellow full Moon over it, leaving a thin
 *  crescent low on the left. Measured from the logo artwork (brand/logo/moonda-wordmark.jpeg): an 88 x 77 box
 *  whose height is 1.03 x the cap height, standing on the text baseline. index.html repeats it for the boot screen. */
export function MoonO({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 88 77" aria-hidden="true">
      <ellipse cx="44" cy="38.5" rx="44" ry="38.5" fill="currentColor" />
      <ellipse cx="50.5" cy="34.75" rx="37.5" ry="34.75" fill="var(--brand-moon, #fabc05)" />
    </svg>
  );
}

/** The MOONDA logo, "MOONDA." with the first O as the Moon. Size it with font-size.
 *  Google Sans Flex 860, tracking .05em (styles.css, .wordmark). In tight spots .wordmark-text can be hidden,
 *  leaving the moon alone as the mark. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`wordmark${className ? ` ${className}` : ''}`} role="img" aria-label="MOONDA">
      <span className="wordmark-text" aria-hidden="true">M</span>
      <MoonO className="wordmark-moon" />
      <span className="wordmark-text wordmark-rest" aria-hidden="true">ONDA.</span>
    </span>
  );
}

/** A titled block inside a panel. */
export function Section({ title, hint, help, tip, right, children, className }: { title: ReactNode; hint?: ReactNode; help?: ReactNode; /** a longer explanation, shown when the title is hovered or focused */ tip?: string; right?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={`sec${className ? ` ${className}` : ''}`}>
      <header className="sec-head">
        <h3 data-tip={tip} tabIndex={tip ? 0 : undefined}>{title}</h3>
        {hint && <span className="sec-hint">{hint}</span>}
        {help && <Help text={help} />}
        {right && <span className="sec-right">{right}</span>}
      </header>
      {children}
    </section>
  );
}

export interface SegOption<T> { value: T; label: string; tip?: string }

/** Pick one of a few choices (a radio group with a sliding highlight and arrow-key support). */
export function Segmented<T extends string | number>({ label, options, value, onChange, size, full }: {
  label: string; options: SegOption<T>[]; value: T; onChange(v: T): void; size?: 'sm' | 'md'; full?: boolean;
}) {
  const btns = useRef<(HTMLButtonElement | null)[]>([]);
  const idx = options.findIndex(o => o.value === value);
  const onKey = (e: KeyboardEvent) => {
    const last = options.length - 1, cur = Math.max(0, idx);
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? Math.min(last, cur + 1)
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? Math.max(0, cur - 1)
        : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(options[next].value);
    btns.current[next]?.focus();
  };
  return (
    <div className={`seg${size === 'sm' ? ' sm' : ''}${full ? ' full' : ''}${idx < 0 ? ' none' : ''}`} role="radiogroup" aria-label={label}
      style={{ '--n': options.length, '--i': Math.max(0, idx) } as CSSProperties}>
      <span className="seg-thumb" aria-hidden="true" />
      {options.map((o, i) => (
        <button key={String(o.value)} ref={el => { btns.current[i] = el; }} type="button" role="radio" aria-checked={i === idx}
          tabIndex={i === idx || (idx < 0 && i === 0) ? 0 : -1} data-tip={o.tip} onClick={() => onChange(o.value)} onKeyDown={onKey}>{o.label}</button>
      ))}
    </div>
  );
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'aria-pressed'> {
  /** What the button does, in words (read by screen readers and shown as the tooltip). */
  label: string;
  tipSide?: 'top' | 'bottom' | 'left' | 'right';
  pressed?: boolean;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'ghost' | 'soft' | 'glass';
}

/** A square or round button that only shows an icon. */
export function IconButton({ label, tipSide, pressed, size = 'md', variant = 'ghost', className, children, ...rest }: IconButtonProps) {
  return (
    <button type="button" {...rest} className={`ibtn ${size} ${variant}${className ? ` ${className}` : ''}`} aria-label={label} aria-pressed={pressed}
      data-tip={label} data-tip-side={tipSide}>{children}</button>
  );
}

/** One number with its label: same size everywhere. */
export function StatTile({ label, value, unit, note, help, tone }: { label: string; value: ReactNode; unit?: string; note?: string; help?: ReactNode; tone?: 'sun' | 'earth' }) {
  return (
    <div className={`tile${tone ? ` ${tone}` : ''}`}>
      <div className="tile-label"><span>{label}</span>{help && <Help text={help} />}</div>
      <div className="tile-value">{value}{unit && <small>{unit}</small>}</div>
      {note && <div className="tile-note">{note}</div>}
    </div>
  );
}

export function Chip({ tone, children }: { tone?: 'good' | 'bad' | 'muted' | 'sun' | 'earth' | 'pin' | 'artemis'; children: ReactNode }) {
  return <span className={`chip${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

/**
 * For the boxes on the right (Compare, Layers): tells the app whether the box reaches down to the
 * map controls, so the controls only move aside when they would really be covered.
 */
// oxlint-disable-next-line react/only-export-components -- The shared kit also owns this panel layout hook.
export function useReachesControls(onReach: (reaches: boolean) => void) {
  const ref = useRef<HTMLElement>(null);
  const reach = useEffectEvent(onReach);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      const controls = document.querySelector('.map-controls');
      const top = controls ? controls.getBoundingClientRect().top : window.innerHeight;
      reach(el.getBoundingClientRect().bottom + 8 > top);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    window.addEventListener('resize', check);
    return () => { ro.disconnect(); window.removeEventListener('resize', check); reach(false); };
  }, []);
  return ref;
}

export type Placement = 'top-start' | 'top-end' | 'top' | 'bottom-start' | 'bottom-end' | 'bottom';

/** A small floating box tied to the button that opened it. Closes with Escape or a click anywhere else. */
export function Popover({ anchor, onClose, placement = 'bottom-start', label, className, gap = 8, children }: {
  anchor: HTMLElement; onClose(): void; placement?: Placement; label: string; className?: string; gap?: number; children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = useEffectEvent(onClose);

  useLayoutEffect(() => {
    const place = () => {
      const el = box.current;
      if (!el) return;
      const a = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
      let left = placement.endsWith('end') ? a.right - w : placement.endsWith('start') ? a.left : a.left + a.width / 2 - w / 2;
      let top = placement.startsWith('top') ? a.top - gap - h : a.bottom + gap;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
      setPos(p => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    const ro = new ResizeObserver(place);
    if (box.current) ro.observe(box.current);
    window.addEventListener('resize', place);
    return () => { ro.disconnect(); window.removeEventListener('resize', place); };
  }, [anchor, placement, gap]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus(); } };
    const onDown = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    const q = (sel: string) => box.current?.querySelector<HTMLElement>(sel);
    // next frame: the box is still hidden while it is being positioned, and hidden things cannot take focus
    const raf = requestAnimationFrame(() => (q('[data-autofocus]') ?? q('[aria-checked="true"]') ?? q('[aria-pressed="true"]') ?? q('button'))?.focus({ preventScroll: true }));
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true); };
  }, [anchor]);

  return createPortal(
    <div ref={box} className={`pop panel${className ? ` ${className}` : ''}`} role="dialog" aria-label={label}
      onKeyDown={e => { if (e.key.startsWith('Arrow')) e.stopPropagation(); /* arrow keys also pan the map: not while a box is open */ }}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}>{children}</div>,
    document.body,
  );
}

export interface MenuOption<T> { value: T; label: string; note?: string; tip?: string }

/** A compact two-line button ("Mission length / 14 days") that opens a short list of choices. */
export function MenuButton<T extends string | number>({ caption, text, options, value, onChange, placement = 'top-end', help, tip }: {
  caption: string; text: string; options: MenuOption<T>[]; value: T; onChange(v: T): void; placement?: Placement; help?: string; tip?: string;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };
  return (
    <>
      <button ref={setAnchor} type="button" className="mbtn" aria-haspopup="menu" aria-expanded={open} data-tip={open ? undefined : tip} onClick={() => setOpen(o => !o)}>
        <span className="mbtn-cap">{caption}</span>
        <span className="mbtn-val">{text}</span>
        <CaretDown className="mbtn-caret" size={12} weight="bold" aria-hidden="true" />
      </button>
      {open && anchor && (
        <Popover anchor={anchor} onClose={() => setOpen(false)} placement={placement} label={caption} className="menu">
          <div role="menu" aria-label={caption} onKeyDown={onKey}>
            <div className="menu-title">{caption}</div>
            {options.map(o => (
              <button key={String(o.value)} type="button" role="menuitemradio" aria-checked={o.value === value} className="menu-item" data-tip={o.tip}
                onClick={() => { onChange(o.value); setOpen(false); anchor.focus(); }}>
                <span className="menu-check" aria-hidden="true">{o.value === value && <Check size={14} weight="bold" />}</span>
                <span className="menu-label">{o.label}</span>
                {o.note && <span className="menu-note">{o.note}</span>}
              </button>
            ))}
            {help && <div className="menu-help">{help}</div>}
          </div>
        </Popover>
      )}
    </>
  );
}
