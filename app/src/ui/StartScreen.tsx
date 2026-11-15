// The start screen: what MOONDA is, what is loading (each part with its real state), the graphics mode,
// language and music, and a choice to enter with a short tutorial once everything is ready. It replaces the
// old loading screen and the first-run welcome card; returning visitors see it too, with their saved choices.
// The "Enter" click is also the click that lets the music start (src/audio/music.ts listens for it).

import { Check } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { chooseQuality, detectQuality, initQuality, QUALITY_TEXT, type Quality } from '../app/quality';
import { settings } from '../app/settings';
import { setLang, useT } from '../i18n';
import type { LoadProgress, Stage } from '../moon/preload';
import { Segmented, Wordmark } from './kit';
import { tutorialStore } from './tutorialStore';
import { WaitQuestions } from './WaitQuestions';
import './start.css';

interface Props {
  progress: LoadProgress;
  /** true while it fades away */
  leaving?: boolean;
  onEnter(): void;
  /** finish loading now (the rest keeps loading in the background) */
  onSkip?(): void;
}

const MODES: Quality[] = ['full', 'light'];
const SKIP_AFTER_MS = 20000; // only offer "Skip waiting" when start-up is really slow

function removeIntro() {
  document.getElementById('intro-video')?.dispatchEvent(new Event('moonda-intro-dispose'));
  document.getElementById('intro-bg')?.remove();
}

function StageRow({ s }: { s: Stage }) {
  const t = useT();
  const right = s.state === 'done' ? (
    <span className="st-right">{s.ms !== undefined && s.ms >= 100 && <span className="st-num">{(s.ms / 1000).toFixed(1)} s</span>}<Check size={14} weight="bold" aria-label={t('start.state.done')} /></span>
  ) : s.state === 'loading' ? (
    <span className="st-right st-num">{s.frac !== null ? `${Math.round(s.frac * 100)}%` : ''}</span>
  ) : (
    <span className="st-right st-quiet">{t(s.state === 'later' ? 'start.state.later' : s.state === 'off' ? 'start.state.off' : 'start.state.waiting')}</span>
  );
  return (
    <li className={`st-row ${s.state}`}>
      <span className="st-name">{t(`start.stage.${s.id}`)}</span>
      {right}
      {s.state === 'loading' && (
        <span className={`st-line${s.frac === null ? ' busy' : ''}`} aria-hidden="true" style={{ '--f': s.frac ?? 0 } as CSSProperties}><i /></span>
      )}
    </li>
  );
}

export function StartScreen({ progress, leaving, onEnter, onSkip }: Props) {
  const t = useT();
  // the space video behind this screen lives in index.html: fade it with this screen, then remove it
  useEffect(() => {
    const bg = document.getElementById('intro-bg');
    if (!bg || !leaving) return;
    bg.classList.add('gone');
    const id = setTimeout(removeIntro, 520);
    return () => clearTimeout(id);
  }, [leaving]);
  useEffect(() => removeIntro, []);
  const prefs = settings.use();
  const { seen } = tutorialStore.use();
  const [recommended] = useState(() => { initQuality(); return detectQuality(); });
  const ready = progress.done;
  const enter = useRef<HTMLButtonElement>(null);
  const [slow, setSlow] = useState(false);
  useEffect(() => { const id = setTimeout(() => setSlow(true), SKIP_AFTER_MS); return () => clearTimeout(id); }, []);

  const enterWithTutorial = useCallback(() => {
    tutorialStore.start();
    onEnter();
  }, [onEnter]);
  const enterWithoutTutorial = useCallback(() => {
    tutorialStore.stop();
    onEnter();
  }, [onEnter]);
  const enterPrimary = seen ? enterWithoutTutorial : enterWithTutorial;

  // Enter takes the main choice; Escape keeps the old quick way into the map.
  useEffect(() => {
    if (!ready || leaving) return;
    enter.current?.focus({ preventScroll: true });
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      const el = e.target as HTMLElement | null;
      if (e.key === 'Enter' && el && el !== enter.current && el.closest('button, input, [role=radio]')) return; // that control's own Enter
      e.preventDefault();
      if (e.key === 'Escape') enterWithoutTutorial();
      else enterPrimary();
    };
    window.addEventListener('keydown', onKey);
    // automated test runs (scripts/drive.mjs) go straight in, unless the address asks for the start screen (?start)
    if (navigator.webdriver && !/[?&]start\b/.test(location.search)) onEnter();
    return () => window.removeEventListener('keydown', onKey);
  }, [ready, leaving, onEnter, enterPrimary, enterWithoutTutorial]);

  const pick = (q: Quality) => chooseQuality(q);
  const onModeKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!next) return;
    e.preventDefault();
    const j = (i + next + MODES.length) % MODES.length;
    pick(MODES[j]);
    (e.currentTarget.parentElement?.children[j] as HTMLElement | undefined)?.focus();
  };

  // drawn straight into <body> so it sits above the space video (index.html), not inside the map's layer
  return createPortal(
    <div className={`start${leaving ? ' leaving' : ''}`} role="dialog" aria-modal="true" aria-label={t('start.aria')}>
      <div className="start-col">
        <header className="start-head">
          <h1 className="start-name"><Wordmark /></h1>
          <p className="start-tag">{t('start.tag')}</p>
        </header>

        <ul className="start-stages" aria-label={t('start.loadingList')} aria-live="polite">
          {progress.stages.map(s => <StageRow key={s.id} s={s} />)}
        </ul>

        <section className="start-modes">
          <h2 id="start-graphics">{t('start.graphics')}</h2>
          <div className="start-mode-list" role="radiogroup" aria-labelledby="start-graphics">
            {MODES.map((q, i) => (
              <button key={q} type="button" role="radio" aria-checked={prefs.quality === q} tabIndex={prefs.quality === q ? 0 : -1}
                className={`start-mode${prefs.quality === q ? ' on' : ''}`} data-tip={t(`start.mode.${q}.tip`)} onClick={() => pick(q)} onKeyDown={e => onModeKey(e, i)}>
                <b>{t(QUALITY_TEXT[q].title)}</b>
                <span>{t(QUALITY_TEXT[q].body)}</span>
                {q === recommended && <em>{t('start.recommended')}</em>}
              </button>
            ))}
          </div>
        </section>

        <div className="start-prefs">
          <Segmented label={t('start.language')} size="sm" value={prefs.lang} onChange={setLang}
            options={[{ value: 'en', label: 'English', tip: t('start.language.en.tip') }, { value: 'km', label: 'ខ្មែរ', tip: t('start.language.km.tip') }]} />
          <label className="start-music" data-tip={t(prefs.sound ? 'start.music.on.tip' : 'start.music.off.tip')}>
            <span>{t('start.music')}</span>
            <input type="checkbox" className="sr-only" checked={prefs.sound} data-tip={t(prefs.sound ? 'start.music.on.tip' : 'start.music.off.tip')} onChange={e => settings.set({ sound: e.target.checked })} />
            <span className="switch" aria-hidden="true"><i /></span>
          </label>
        </div>

        <div className="start-actions">
          <button ref={enter} type="button" className="btn primary lg start-enter" disabled={!ready}
            data-tip={t(seen ? 'start.enter.tip' : 'start.tutorial.tip')} onClick={enterPrimary}>
            {ready ? t(seen ? 'start.enter' : 'start.tutorial') : t('start.wait', { pct: Math.round(progress.pct) })}
          </button>
          <button type="button" className="btn start-enter-quiet" disabled={!ready}
            data-tip={t(seen ? 'start.tutorial.tip' : 'start.justEnter.tip')} onClick={seen ? enterWithTutorial : enterWithoutTutorial}>
            {t(seen ? 'start.showTutorial' : 'start.justEnter')}
          </button>
        </div>
        {!ready && slow && onSkip && <button type="button" className="start-skip" data-tip={t('start.skip.tip')} onClick={onSkip}>{t('start.skip')}</button>}

      </div>
      {/* beside the column, never in the way of it; automated runs go straight in and never see it */}
      {!navigator.webdriver || /[?&]start\b/.test(location.search) ? <WaitQuestions leaving={!!leaving} /> : null}
    </div>,
    document.body,
  );
}
