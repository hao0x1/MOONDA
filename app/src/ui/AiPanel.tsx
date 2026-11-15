// The AI landing-site helper panel (bottom right). Shows the agent at work as a list of steps
// (its thinking, every tool it runs with what went in and what came back), the answer as it is
// written, a results table with the real numbers, and follow-up ideas. Conversations are saved in
// this browser so they can be reopened and continued. The agent lives in ../ai/agent.ts, its tools
// in ../ai/tools.ts, the steps in ./AiTrace.tsx.
//
// Never stuck: only the run started in this page can look "working". A chat saved while it ran is
// shown as stopped when it is opened again (with "Run again"), and leaving a running chat stops it.

import { ArrowClockwise, ArrowRight, ArrowUp, ChatsCircle, Check, ClockCounterClockwise, Copy, NotePencil, Stop, Trash, WarningCircle, X } from '@phosphor-icons/react';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Agent, type AgentEvent } from '../ai/agent';
import { ago, chatTitle, loadActiveId, loadChats, newChatId, saveActiveId, saveChats, settleChat, type Block, type Chat, type Turn } from '../ai/history';
import { makeRunner, SYSTEM_PROMPT, TOOLS, type AppBridge } from '../ai/tools';
import { t as tr, tMaybe, tn, useT } from '../i18n';
import { ResultsTable, spotRows, Trace, type StepBlock } from './AiTrace';
import './ai.css';
import { PhoneSheetHandle, usePhoneSheet } from './PhoneSheet';

const SUGGESTIONS = [
  'Find the best landing spot near Shackleton crater for my mission',
  'Which Artemis region keeps sunlight and Earth contact the longest?',
  'My battery lasts 3 days. Where near the south pole can the lander survive?',
  'Compare Malapert Massif and the Connecting Ridge for me',
];
const FOLLOW_UPS = [
  'What if we arrive 7 days later?',
  'What if the battery only lasts 2 days?',
  'Which of these has the gentlest slope?',
];

/** MOONDA AI's mark: a small Moon with a lit crescent edge (no sparkles). */
export function AiMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className="ai-mark">
      <circle cx="8" cy="8" r="7" fill="currentColor" opacity=".18" />
      <path d="M8 1a7 7 0 1 1 0 14 5.2 7 0 0 0 0-14Z" fill="currentColor" />
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeOpacity=".5" strokeWidth="1" />
    </svg>
  );
}

/** Small, safe Markdown: paragraphs, **bold**, *italic*, `code`, headings, lists, tables. */
function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = (s: string) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/[✓✅✔]/g, '<span class="ai-yes">✓</span>')
      .replace(/[✗❌✘]/g, '<span class="ai-no">✗</span>');
    const numeric = (s: string) => /^[~≈<>+−-]?\s*[\d.,]+\s*(%|h|hours?|d|days?|°|km|m|K|°C)?$/.test(s.trim());
    const lines = text.split('\n');
    const out: string[] = [];
    let list: 'ul' | 'ol' | null = null;
    let first = true;
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        close();
        const cells = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        let t = `<div class="ai-md-table"><table><thead><tr>${cells(l).map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`;
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { t += `<tr>${cells(lines[i]).map(c => `<td${numeric(c) ? ' class="num"' : ''}>${inline(c)}</td>`).join('')}</tr>`; i++; }
        i--; out.push(`${t}</tbody></table></div>`); first = false; continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(l);
      const ul = /^\s*[-*•]\s+(.*)$/.exec(l);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(l);
      if (h) { close(); out.push(`<h4>${inline(h[2])}</h4>`); first = false; }
      else if (ul) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); first = false; }
      else if (ol) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(ol[1])}</li>`); first = false; }
      else if (!l.trim() || /^-{3,}$/.test(l.trim())) { close(); }
      else {
        close();
        // the bold one-line verdict at the top gets its own look
        const lead = first && /^\s*\*\*[^*]+\*\*[.!]?\s*$/.test(l);
        out.push(lead ? `<p class="ai-lead">${inline(l)}</p>` : `<p>${inline(l)}</p>`);
        first = false;
      }
    }
    close();
    return out.join('');
  }, [text]);
  return <div className="ai-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="ai-mini-btn" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); }); }}
      aria-label={t('ai.copyLabel')} data-tip={t('ai.tip.copy')}>
      {done ? <Check size={13} weight="bold" /> : <Copy size={13} />}{done ? t('ai.copied') : t('ai.copy')}
    </button>
  );
}

type Seg = { kind: 'trace'; steps: StepBlock[] } | Exclude<Block, StepBlock>;
function segments(blocks: Block[]): Seg[] {
  const out: Seg[] = [];
  for (const b of blocks) {
    if (b.kind === 'think' || b.kind === 'tool') {
      const last = out[out.length - 1];
      if (last?.kind === 'trace') last.steps.push(b); else out.push({ kind: 'trace', steps: [b] });
    } else out.push(b);
  }
  return out;
}

function AiTurn({ t: turn, question, isLast, busy, bridge, asked, onAsk }: {
  t: Turn; question: string; isLast: boolean; busy: boolean; bridge: AppBridge; asked: string[]; onAsk(q: string): void;
}) {
  const t = useT();
  const segs = segments(turn.blocks);
  const { rows, quick } = useMemo(() => spotRows(turn.blocks), [turn.blocks]);
  const next = FOLLOW_UPS.filter(q => !asked.includes(q));
  const answer = turn.blocks.filter(b => b.kind === 'answer').map(b => (b as { text: string }).text).join('\n\n');
  const hasError = turn.blocks.some(b => b.kind === 'error');
  return (
    <div className="ai-turn">
      {turn.blocks.length === 0 && turn.live && <div className="ai-trace live"><div className="ai-trace-head"><span className="ai-trace-title"><span className="ai-shimmer">{t('ai.starting')}</span></span></div></div>}
      {segs.map((s, i) => (
        <Fragment key={i}>
          {s.kind === 'trace' && <Trace steps={s.steps} live={turn.live && i === segs.length - 1} t0={s.steps[0]?.t0 ?? turn.t0} end={turn.end} />}
          {s.kind === 'answer' && <div className="ai-answer"><Markdown text={s.text} />{turn.live && i === segs.length - 1 && <span className="ai-caret-blink" />}</div>}
          {s.kind === 'error' && (
            <div className="ai-note bad" role="alert">
              <WarningCircle size={16} />
              <p>{s.text}</p>
              {s.retry && !busy && question && <button type="button" className="ai-note-btn" onClick={() => onAsk(question)} data-tip={t('ai.tip.retry')}><ArrowClockwise size={13} />{t('ai.retry')}</button>}
            </div>
          )}
        </Fragment>
      ))}
      {!turn.live && turn.end && !hasError && (
        <div className="ai-note">
          <Stop size={14} weight="fill" />
          <p>{turn.end === 'interrupted' ? t('ai.interrupted') : t('ai.stopped')}</p>
          {!busy && question && <button type="button" className="ai-note-btn" onClick={() => onAsk(question)} data-tip={t('ai.tip.runAgain')}><ArrowClockwise size={13} />{t('ai.runAgain')}</button>}
        </div>
      )}
      {!turn.live && rows.length > 0 && (
        <ResultsTable rows={rows} quick={quick}
          onShow={r => bridge.showOnMap(r.lat, r.lon, r.label)}
          onCompare={rs => { const msgs = rs.map(r => bridge.addToCompare(r.lat, r.lon, r.label)); return msgs.length === 1 ? msgs[0] : t('ai.addedToCompare', { n: rs.length }); }} />
      )}
      {!turn.live && answer && <div className="ai-turn-actions"><CopyButton text={answer} /></div>}
      {!turn.live && !turn.end && isLast && !busy && rows.length > 0 && next.length > 0 && (
        <div className="ai-related">
          <span>{t('ai.askNext')}</span>
          {next.map(q => <button type="button" key={q} onClick={() => onAsk(q)} data-tip={t('ai.tip.ask')}>{q}<ArrowRight size={13} /></button>)}
        </div>
      )}
    </div>
  );
}

function History({ chats, activeId, onOpen, onDelete, onNew }: { chats: Chat[]; activeId: string | null; onOpen(c: Chat): void; onDelete(id: string): void; onNew(): void }) {
  const t = useT();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const groups: [string, Chat[]][] = [[t('ai.today'), chats.filter(c => c.updated >= +today)], [t('ai.earlier'), chats.filter(c => c.updated < +today)]];
  return (
    <div className="ai-history">
      <button type="button" className="ai-hist-new" onClick={onNew} data-tip={t('ai.tip.newChat')}><NotePencil size={16} />{t('ai.newChat')}</button>
      {!chats.length && <div className="ai-hist-empty"><ChatsCircle size={28} /><p>{t('ai.noChats')}</p></div>}
      {groups.map(([name, list]) => list.length > 0 && (
        <Fragment key={name}>
          <div className="ai-hist-group">{name}</div>
          {list.map(c => {
            const asks = c.turns.filter(x => x.role === 'user').length;
            return (
              <div key={c.id} className={`ai-hist-item${c.id === activeId ? ' on' : ''}`} role="button" tabIndex={0} data-tip={t('ai.tip.openChat', { name: c.title })}
                onClick={() => onOpen(c)} onKeyDown={e => { if (e.key === 'Enter') onOpen(c); }}>
                <div className="ai-hist-text"><b>{c.title}</b><small>{tn('ai.questions', asks)} · {ago(c.updated)}</small></div>
                <button type="button" className="ai-icon-btn ai-hist-del" aria-label={t('ai.deleteChat')} data-tip={t('ai.tip.deleteChat')} onClick={e => { e.stopPropagation(); onDelete(c.id); }}><Trash size={15} /></button>
              </div>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

const now = () => Date.now();
/** End an answer in the page: thinking stops now, a running tool is marked stopped with the time it ran. */
function finish(turn: Turn, end?: 'stopped' | 'interrupted'): Turn {
  if (!turn.live) return turn;
  const at = now();
  return {
    ...turn, live: false, t1: at, end,
    blocks: turn.blocks.map((b): Block => (b.kind === 'think' && b.t1 === null ? { ...b, t1: b.seen ?? at }
      : b.kind === 'tool' && b.status === 'run' ? { ...b, status: 'stopped', summary: tr('ai.stepStopped'), ms: at - b.t0 } : b)),
  };
}

export function AiPanel({ bridge, hidden, onClose, onBusy }: { bridge: AppBridge; hidden: boolean; onClose(): void; onBusy?(busy: boolean): void }) {
  const t = useT();
  const sheetRoot = useRef<HTMLElement>(null);
  // (on a phone the AI opens as a full page, like a tab of its own)
  const sheet = usePhoneSheet(sheetRoot, !hidden, undefined, true);
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  const makeAgent = () => new Agent(SYSTEM_PROMPT, TOOLS, makeRunner(new Proxy({} as AppBridge, { get: (_t, k) => (bridgeRef.current as never)[k] })));

  // reopen the chat that was open last time (loadChats has already settled anything left running)
  const [boot] = useState(() => { const chats = loadChats(); const id = loadActiveId(); return { chats, active: chats.find(c => c.id === id) ?? null }; });
  const agent = useRef<Agent>(null as unknown as Agent);
  if (!agent.current) { agent.current = makeAgent(); if (boot.active) agent.current.load(boot.active.messages); }
  const [chats, setChats] = useState<Chat[]>(boot.chats);
  const [chatId, setChatId] = useState<string | null>(boot.active?.id ?? null);
  const [turns, setTurns] = useState<Turn[]>(boot.active?.turns ?? []);
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const dirty = useRef(false);   // something new happened in the open chat (opening an old one is not news)
  const gen = useRef(0);         // which run the agent events belong to (ignore a stopped run's last events)
  const stoppedByUser = useRef(false);
  const turnsRef = useRef(turns);
  const chatIdRef = useRef(chatId);
  useEffect(() => { turnsRef.current = turns; chatIdRef.current = chatId; }, [turns, chatId]);

  useEffect(() => { if (!sheet.phone && !hidden && view === 'chat') field.current?.focus(); }, [hidden, view, sheet.phone]);
  useEffect(() => { const el = scroller.current; if (el && stick.current && view === 'chat') el.scrollTop = el.scrollHeight; }, [turns, view, hidden]);
  useEffect(() => { onBusy?.(busy); }, [busy, onBusy]);
  useEffect(() => { saveActiveId(chatId); }, [chatId]);
  // the input grows with what is typed (up to 6 lines)
  useLayoutEffect(() => { const el = field.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 140)}px`; }, [input, view]);

  // save the open chat (a moment after it changes, and right away when an answer finishes)
  const persist = useCallback((id: string, ts: Turn[]) => {
    if (!ts.length) return;
    setChats(cs => {
      const prev = cs.find(c => c.id === id);
      const chat: Chat = { id, title: chatTitle(ts), created: prev?.created ?? Date.now(), updated: Date.now(), messages: agent.current.messages.slice(1), turns: ts };
      const next = [chat, ...cs.filter(c => c.id !== id)];
      saveChats(next);
      return next;
    });
  }, []);
  // while it works: at most every 1.5 s (thinking streams in many small pieces); when done: at once
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!chatId || !turns.length || !dirty.current) return;
    if (!busy) {
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      persist(chatId, turns);
      dirty.current = false;
      return;
    }
    if (saveTimer.current) return;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      if (chatIdRef.current === chatId) persist(chatId, turnsRef.current);
    }, 1500);
  }, [turns, chatId, busy, persist]);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const update = (fn: (blocks: Block[]) => Block[]) => { dirty.current = true; setTurns(ts => {
    const last = ts[ts.length - 1];
    if (!last || last.role !== 'ai' || !last.live) return ts;
    return [...ts.slice(0, -1), { ...last, blocks: fn(last.blocks) }];
  }); };
  /** Thinking ends now (the next step began), or, when the run ends early, where its last words came in. */
  const endThinking = (bl: Block[], atLastWord = false) => bl.map(b => (b.kind === 'think' && b.t1 === null ? { ...b, t1: atLastWord ? b.seen ?? now() : now() } : b));

  const roundStart = useRef(0);
  const handle = (run: number) => (e: AgentEvent) => { if (run === gen.current) onEvent(e); };
  const onEvent = (e: AgentEvent) => {
    switch (e.type) {
      case 'round': roundStart.current = now(); break;
      case 'tool-progress': update(bl => bl.map(b => (b.kind === 'tool' && b.id === e.id && b.status === 'run' ? { ...b, progress: e.text, seen: now() } : b))); break;
      case 'thinking': update(bl => {
        const last = bl[bl.length - 1];
        if (last?.kind === 'think' && last.t1 === null) return [...bl.slice(0, -1), { ...last, text: last.text + e.delta, seen: now() }];
        return [...bl, { kind: 'think', text: e.delta, t0: roundStart.current || now(), t1: null, seen: now() }];
      }); break;
      case 'answer': update(bl => {
        const done = endThinking(bl);
        const last = done[done.length - 1];
        if (last?.kind === 'answer') return [...done.slice(0, -1), { ...last, text: last.text + e.delta }];
        return [...done, { kind: 'answer', text: e.delta }];
      }); break;
      case 'tool-start': update(bl => [...endThinking(bl), { kind: 'tool', id: e.id, name: e.name, args: e.args, status: 'run', summary: '', progress: '', t0: now(), ms: 0, seen: now() }]); break;
      case 'tool-end': update(bl => bl.map(b => (b.kind === 'tool' && b.id === e.id ? { ...b, status: e.ok ? 'ok' : 'fail', summary: e.summary, ms: e.ms, result: e.result } : b))); break;
      case 'error': update(bl => [...endThinking(bl, true), { kind: 'error', text: e.message, code: e.code, retry: e.retry }]); break;
      case 'done': if (e.stopped) stoppedByUser.current = true; update(bl => endThinking(bl, true)); break;
      default: break;
    }
  };

  /** Stop the running answer (if any), mark it stopped and save it, before the panel shows something else. */
  const halt = () => {
    if (!agent.current.busy) return;
    gen.current++;
    agent.current.stop();
    const ts = turnsRef.current.map(x => finish(x, 'stopped'));
    setTurns(ts);
    setBusy(false);
    if (chatIdRef.current) persist(chatIdRef.current, ts);
  };

  const send = async (q: string) => {
    const text = q.trim();
    if (!text || agent.current.busy) return;
    const id = chatId ?? newChatId();
    if (!chatId) setChatId(id);
    setInput('');
    setView('chat');
    stick.current = true;
    dirty.current = true;
    stoppedByUser.current = false;
    const run = ++gen.current;
    const at = now();
    setTurns(ts => [...ts, { role: 'user', text, blocks: [], live: false, t0: at, t1: at }, { role: 'ai', q: text, blocks: [], live: true, t0: at, t1: null }]);
    setBusy(true);
    await agent.current.ask(text, handle(run), bridgeRef.current.view());
    if (run !== gen.current) return; // the user started or opened another chat meanwhile (halt() already closed it)
    setBusy(false);
    const end = stoppedByUser.current ? 'stopped' : undefined;
    setTurns(ts => ts.map(x => finish(x, end)));
  };

  const startFresh = () => { halt(); gen.current++; agent.current = makeAgent(); setTurns([]); setChatId(null); setBusy(false); setView('chat'); };
  const openChat = (c: Chat) => {
    if (c.id === chatId) { setView('chat'); return; } // already open (maybe still running): just go back to it
    halt();
    gen.current++;
    dirty.current = false;
    const safe = settleChat(c); // nothing in a saved chat is running in this page
    agent.current = makeAgent();
    agent.current.load(safe.messages);
    setChatId(safe.id); setTurns(safe.turns); setBusy(false); setView('chat'); stick.current = true;
  };
  const deleteChat = (id: string) => {
    if (id === chatId) startFresh();
    setChats(cs => { const next = cs.filter(c => c.id !== id); saveChats(next); return next; });
  };

  let content: ReactNode;
  if (view === 'history') {
    content = <History chats={chats} activeId={chatId} onOpen={openChat} onDelete={deleteChat} onNew={startFresh} />;
  } else if (!turns.length) {
    content = (
      <div className="ai-empty">
        <span className="ai-empty-mark"><AiMark size={28} /></span>
        <h3>{t('ai.emptyTitle')}</h3>
        <p>{t('ai.emptyBody')}</p>
        <div className="ai-suggest">
          <span>{t('ai.try')}</span>
          {SUGGESTIONS.map((s, i) => { const q = tMaybe(`aitool.try.${i + 1}`, s); return <button type="button" key={s} onClick={() => void send(q)} data-tip={t('ai.tip.ask')}>{q}<ArrowRight size={13} /></button>; })}
        </div>
        {chats.length > 0 && <button type="button" className="ai-link" onClick={() => setView('history')} data-tip={t('ai.tip.history')}><ClockCounterClockwise size={14} />{tn('ai.savedChats', chats.length)}</button>}
      </div>
    );
  } else {
    const lastAi = turns.length - 1;
    const asked = turns.filter(x => x.role === 'user').map(x => x.text ?? '');
    content = turns.map((x, ti) => (x.role === 'user'
      ? <div key={ti} className="ai-user">{x.text}</div>
      : <AiTurn key={ti} t={x} question={x.q ?? turns[ti - 1]?.text ?? ''} isLast={ti === lastAi} busy={busy} bridge={bridge} asked={asked} onAsk={q => void send(q)} />));
  }

  return (
    <section ref={sheetRoot} className={`ai-panel panel${sheet.className}`} aria-label={t('ai.panelLabel')} hidden={hidden}>
      <PhoneSheetHandle sheet={sheet} />
      <header className="ai-head">
        <span className="ai-head-mark"><AiMark size={18} /></span>
        <div className="ai-head-text">
          <h2>{view === 'history' ? t('ai.chats') : t('ai.title')}</h2>
          <span>{view === 'history' ? t('ai.chatsNote') : turns.length ? chatTitle(turns) : t('ai.subtitle')}</span>
        </div>
        <button type="button" className={`ai-icon-btn${view === 'history' ? ' on' : ''}`} onClick={() => { if (sheet.phone) sheet.setExpanded(true); setView(v => (v === 'history' ? 'chat' : 'history')); }}
          data-tip={t(view === 'history' ? 'ai.tip.backToChat' : 'ai.tip.history')} aria-label={t('ai.history')} aria-pressed={view === 'history'}><ClockCounterClockwise size={18} /></button>
        <button type="button" className="ai-icon-btn" onClick={() => { if (sheet.phone) sheet.setExpanded(true); startFresh(); }} data-tip={t('ai.tip.newChat')} aria-label={t('ai.newChat')} disabled={!turns.length && view === 'chat'}><NotePencil size={18} /></button>
        <button type="button" className="ai-icon-btn" onClick={onClose} aria-label={t('ai.close')} data-tip={t('ai.tip.close')}><X size={18} /></button>
      </header>
      <div ref={scroller} className="ai-body" onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {content}
      </div>
      {view === 'chat' && (
        <div className="ai-compose">
          <form className="ai-input" onSubmit={e => { e.preventDefault(); void send(input); }}>
            <textarea ref={field} value={input} rows={1} aria-label={t('ai.placeholder')} placeholder={busy ? t('ai.placeholderBusy') : turns.length ? t('ai.placeholderFollow') : t('ai.placeholder')} onChange={e => setInput(e.target.value)} onFocus={() => { if (sheet.phone) sheet.setExpanded(true); }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }} />
            {busy
              ? <button type="button" className="ai-send stop" onClick={() => agent.current.stop()} aria-label={t('ai.stop')} data-tip={t('ai.tip.stop')}><Stop size={12} weight="fill" /><span>{t('ai.stop')}</span></button>
              : <button type="submit" className="ai-send" disabled={!input.trim()} aria-label={t('ai.send')} data-tip={t('ai.tip.send')}><ArrowUp size={16} weight="bold" /></button>}
          </form>
          <div className="ai-foot">{t('ai.fine')}</div>
        </div>
      )}
    </section>
  );
}
