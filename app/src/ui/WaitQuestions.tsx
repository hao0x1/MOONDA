// "While you wait": a small board that drops in on two ropes beside the loading list, a moment after loading has
// begun, and asks three quick things about the visitor's mission: when the lander arrives, how long its battery
// lasts in the dark, how long it can go without seeing Earth. One question at a time: two ready answers, or type
// your own number of days. Every answer is put to use at once (the arrival date on the time bar, the two limits
// in Compare), any of them can be skipped, and nothing here holds up loading.

import { ArrowRight, Check, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useT, type Key } from '../i18n';

const NEEDS_KEY = 'moonda.compare.needs.v2'; // the same place Compare keeps its two limits (hours, or null = not checked)
const DAY = 86400000;
/** the visitor's answers, in days */
type Answers = { land?: number; battery?: number; contact?: number };

/** Put the answers to work. The arrival date goes through the app's own hook (App.tsx sets it once the map is up). */
function apply(a: Answers): void {
  try {
    if (a.battery !== undefined || a.contact !== undefined) {
      const old = JSON.parse(localStorage.getItem(NEEDS_KEY) ?? 'null') as { batteryH?: number | null; contactH?: number | null } | null;
      localStorage.setItem(NEEDS_KEY, JSON.stringify({
        batteryH: a.battery !== undefined ? a.battery * 24 : old?.batteryH ?? 72,
        contactH: a.contact !== undefined ? a.contact * 24 : old?.contactH ?? 24,
      }));
    }
  } catch { /* private mode: the arrival date still holds for this visit */ }
  if (a.land !== undefined) {
    // a whole hour, so the time bar starts on a tidy number
    const ms = Math.round((Date.now() + a.land * DAY) / 3600000) * 3600000;
    (window as unknown as { __moondaTest?: { setArrival?(ms: number): void } }).__moondaTest?.setArrival?.(ms);
  }
}

interface Question { id: keyof Answers; ask: Key; lead: Key; quick: [number, number] }
const QUESTIONS: Question[] = [
  { id: 'land', ask: 'start.q.land', lead: 'start.q.land.lead', quick: [7, 30] },
  { id: 'battery', ask: 'start.q.battery', lead: 'start.q.lasts', quick: [3, 7] },
  { id: 'contact', ask: 'start.q.contact', lead: 'start.q.upTo', quick: [1, 3] },
];
const days = (t: ReturnType<typeof useT>, n: number) => t(n === 1 ? 'start.q.day' : 'start.q.days', { n: Number(n.toFixed(1)) });

/** A length of twisted rope, drawn: two strands winding round each other. */
function Rope({ side }: { side: 'left' | 'right' }) {
  return (
    <svg className={`start-rope ${side}`} width="10" height="400" viewBox="0 0 10 400" aria-hidden="true" preserveAspectRatio="none">
      <defs>
        <pattern id={`start-twist-${side}`} width="10" height="9" patternUnits="userSpaceOnUse">
          <rect width="10" height="9" fill="#b9966a" />
          <path d="M-2 9 L12 0" stroke="#7d5f3c" strokeWidth="2.2" />
          <path d="M-2 4.5 L12 -4.5 M-2 13.5 L12 4.5" stroke="#e2c79d" strokeWidth="1.1" />
        </pattern>
        <linearGradient id={`start-round-${side}`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity=".45" /><stop offset=".35" stopColor="#000" stopOpacity="0" />
          <stop offset=".7" stopColor="#000" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity=".5" />
        </linearGradient>
      </defs>
      <rect x="2" width="6" height="400" rx="3" fill={`url(#start-twist-${side})`} />
      <rect x="2" width="6" height="400" rx="3" fill={`url(#start-round-${side})`} />
    </svg>
  );
}

export function WaitQuestions({ leaving }: { leaving: boolean }) {
  const t = useT();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [typed, setTyped] = useState('');
  const [gone, setGone] = useState(false);
  const [nudge, setNudge] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // The app's hook may not be there yet when the first answer is given (the map is still starting): hand the
  // answers over again as the visitor enters.
  useEffect(() => { if (leaving) apply(answers); }, [leaving, answers]);

  if (gone) return null;
  const q = QUESTIONS[step];
  const answer = (value: number) => {
    if (!q || !Number.isFinite(value)) return;
    const next = { ...answers, [q.id]: Math.max(0, Math.min(365, value)) };
    setAnswers(next);
    apply(next);
    setTyped('');
    setStep(step + 1);
    setNudge(n => n + 1); // the board gives a little swing, as if tapped
  };
  const typedDays = Number.parseFloat(typed.replace(',', '.'));
  const submit = (e: FormEvent) => { e.preventDefault(); if (Number.isFinite(typedDays)) answer(typedDays); };
  return (
    <aside className={`start-sign${leaving ? ' leaving' : ''}`} aria-label={t('start.q.aria')}>
      <div key={nudge} className={`start-sign-swing${nudge ? ' nudged' : ''}`}>
        <Rope side="left" /><Rope side="right" />
        <div className="start-sign-board">
          <i className="start-eyelet left" aria-hidden="true" /><i className="start-eyelet right" aria-hidden="true" />
          <header className="start-sign-top">
            <span className="start-sign-kicker">{t('start.q.kicker')}</span>
            <button type="button" className="start-sign-close" aria-label={t('start.q.close')} data-tip={t('start.q.close')} onClick={() => setGone(true)}><X size={13} weight="bold" /></button>
          </header>
          {q ? (
            <div key={step} className="start-sign-q">
              <p className="start-sign-count">{t('start.q.count', { n: step + 1, total: QUESTIONS.length })}</p>
              <h2>{t(q.ask)}</h2>
              <div className="start-sign-quick">
                {q.quick.map(n => <button key={n} type="button" onClick={() => answer(n)}>{q.id === 'land' ? t('start.q.in', { days: days(t, n) }) : days(t, n)}</button>)}
              </div>
              <form className="start-sign-own" onSubmit={submit} onClick={() => input.current?.focus()}>
                <label htmlFor="start-sign-days">{t(q.lead)}</label>
                <input ref={input} id="start-sign-days" inputMode="decimal" autoComplete="off" placeholder="0" value={typed} maxLength={5}
                  onChange={e => setTyped(e.target.value.replace(/[^0-9.,]/g, ''))} aria-label={t('start.q.type')} />
                <span>{t('start.q.unit')}</span>
                <button type="submit" disabled={!Number.isFinite(typedDays)} aria-label={t('start.q.use')} data-tip={t('start.q.use')}><ArrowRight size={15} weight="bold" /></button>
              </form>
              <div className="start-sign-foot">
                <span className="start-sign-dots" aria-hidden="true">{QUESTIONS.map((_, i) => <i key={i} className={i < step ? 'done' : i === step ? 'on' : undefined} />)}</span>
                <button type="button" className="start-sign-skip" onClick={() => { setTyped(''); setStep(step + 1); }}>{t('start.q.skip')}</button>
              </div>
            </div>
          ) : (
            <div key="done" className="start-sign-q">
              <h2><Check size={16} weight="bold" color="var(--good)" /> {t('start.q.thanks')}</h2>
              <ul className="start-sign-sum">
                {answers.land !== undefined && <li><span>{t('start.q.sum.land')}</span><b>{t('start.q.in', { days: days(t, answers.land) })}</b></li>}
                {answers.battery !== undefined && <li><span>{t('start.q.sum.battery')}</span><b>{days(t, answers.battery)}</b></li>}
                {answers.contact !== undefined && <li><span>{t('start.q.sum.contact')}</span><b>{days(t, answers.contact)}</b></li>}
              </ul>
              <p className="start-sign-ask">{t('start.q.used')}</p>
              <div className="start-sign-foot"><span /><button type="button" className="start-sign-skip" onClick={() => setStep(0)}>{t('start.q.again')}</button></div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
