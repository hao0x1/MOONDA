// One small tooltip for the whole page. Any element with data-tip="…" shows it after a short
// hover, or at once on keyboard focus. Only one can be open, so tooltips never pile up, and it
// floats above everything, so a scrolling panel can never cut it off.
//   data-tip-side="top | bottom | left | right" picks the side (default: above, or below near the top edge).

let tipEl: HTMLDivElement | null = null;
let timer = 0;
let current: HTMLElement | null = null;

function hide() {
  clearTimeout(timer);
  current = null;
  tipEl?.classList.remove('show');
}

function show(target: HTMLElement) {
  const text = target.getAttribute('data-tip');
  if (!text) return;
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
  }
  tipEl.textContent = text;
  const r = target.getBoundingClientRect();
  const side = target.getAttribute('data-tip-side') ?? (r.top < 120 ? 'bottom' : 'top');
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight, gap = 8;
  let x = r.left + r.width / 2 - w / 2, y = side === 'bottom' ? r.bottom + gap : r.top - gap - h;
  if (side === 'left') { x = r.left - gap - w; y = r.top + r.height / 2 - h / 2; }
  if (side === 'right') { x = r.right + gap; y = r.top + r.height / 2 - h / 2; }
  x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
  y = Math.max(8, Math.min(y, window.innerHeight - h - 8));
  tipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  tipEl.classList.add('show');
}

const tipTarget = (e: Event) => (e.target instanceof Element ? e.target.closest<HTMLElement>('[data-tip]') : null);

export function installTips(): () => void {
  const over = (e: Event) => {
    const t = tipTarget(e);
    if (t === current) return;
    hide();
    if (!t) return;
    current = t;
    timer = window.setTimeout(() => { if (current === t && t.isConnected) show(t); }, 450);
  };
  const focus = (e: Event) => {
    const t = tipTarget(e);
    if (!t || !t.matches(':focus-visible')) return;
    hide();
    current = t;
    show(t);
  };
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
  document.addEventListener('mouseover', over);
  document.addEventListener('focusin', focus);
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
  return () => {
    hide();
    document.removeEventListener('mouseover', over);
    document.removeEventListener('focusin', focus);
    document.removeEventListener('focusout', hide);
    document.removeEventListener('pointerdown', hide, true);
    document.removeEventListener('keydown', key, true);
    window.removeEventListener('scroll', hide, true);
    window.removeEventListener('blur', hide);
  };
}
