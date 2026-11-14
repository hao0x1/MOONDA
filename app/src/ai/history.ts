// Saved AI conversations (this browser only). Each chat keeps what the panel shows (turns with
// their steps and results) and what the model needs to carry on (the message history), so a
// conversation can be reopened later and follow-up questions keep their context.

import { t } from '../i18n';
import type { ChatMessage } from './agent';

// Durations shown for finished or stopped steps always come from what is stored here (t1, ms,
// seen), never from "now minus an old start", so a reopened chat can never count up.
export type Block =
  | { kind: 'think'; text: string; t0: number; t1: number | null; seen?: number }
  | { kind: 'tool'; id: string; name: string; args: Record<string, unknown>; status: 'run' | 'ok' | 'fail' | 'stopped'; summary: string; progress: string; t0: number; ms: number; result?: unknown; seen?: number }
  | { kind: 'answer'; text: string }
  | { kind: 'error'; text: string; code?: string; retry?: boolean; setup?: boolean };
/** end: how an answer that did not finish ended ('stopped' by the user, 'interrupted' when the page
 *  was closed or the chat left while it ran). q: the question, for "Run again". */
export interface Turn { role: 'user' | 'ai'; text?: string; blocks: Block[]; live: boolean; t0: number; t1: number | null; end?: 'stopped' | 'interrupted'; q?: string }
export interface Chat { id: string; title: string; created: number; updated: number; messages: ChatMessage[]; turns: Turn[] }

const KEY = 'moonda.ai.chats.v1';
const ACTIVE = 'moonda.ai.active.v1';
const MAX_CHATS = 20;

const blockEnd = (b: Block) => (b.kind === 'think' ? b.t1 ?? b.seen ?? b.t0 : b.kind === 'tool' ? (b.status === 'run' ? b.seen ?? b.t0 : b.t0 + b.ms) : 0);

/** Close every unfinished part of an answer that is not running in this page any more:
 *  thinking ends where it was last seen, a running tool becomes 'stopped' with its last known duration. */
export function settleTurn(turn: Turn, end: 'stopped' | 'interrupted'): Turn {
  const open = turn.live || turn.t1 === null || turn.blocks.some(b => (b.kind === 'think' && b.t1 === null) || (b.kind === 'tool' && b.status === 'run'));
  if (!open) return turn;
  const blocks = turn.blocks.map((b): Block => {
    if (b.kind === 'think' && b.t1 === null) return { ...b, t1: b.seen ?? b.t0 };
    if (b.kind === 'tool' && b.status === 'run') return { ...b, status: 'stopped', summary: t('ai.stepStopped'), ms: Math.max(0, (b.seen ?? b.t0) - b.t0) };
    return b;
  });
  const t1 = turn.t1 ?? Math.max(turn.t0, ...blocks.map(blockEnd));
  return { ...turn, live: false, t1, blocks, end: turn.end ?? (turn.role === 'ai' ? end : undefined) };
}

/** Older saved chats could hold the AI service's own error text: show our plain sentence instead. */
function cleanBlock(b: Block): Block {
  if (b.kind !== 'error' || b.code) return b;
  return { kind: 'error', code: b.setup ? 'no-key' : 'service', text: t(b.setup ? 'ai.err.noKey' : 'ai.err.service'), retry: !b.setup };
}

/** A saved chat as it must look when opened: nothing in it is running. */
export function settleChat(c: Chat): Chat {
  return { ...c, turns: c.turns.map(x => settleTurn({ ...x, blocks: x.blocks.map(cleanBlock) }, 'interrupted')) };
}

export function loadChats(): Chat[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Chat[];
    if (!Array.isArray(v)) return [];
    return v.filter(c => c && typeof c.id === 'string' && Array.isArray(c.turns) && Array.isArray(c.messages))
      .map(settleChat)
      .sort((a, b) => b.updated - a.updated);
  } catch { return []; }
}

export function saveChats(chats: Chat[]) {
  let list = [...chats].sort((a, b) => b.updated - a.updated).slice(0, MAX_CHATS);
  while (list.length) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); return; } catch { list = list.slice(0, -1); } // full: drop the oldest
  }
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

export function loadActiveId(): string | null { try { return localStorage.getItem(ACTIVE); } catch { return null; } }
export function saveActiveId(id: string | null) { try { if (id) localStorage.setItem(ACTIVE, id); else localStorage.removeItem(ACTIVE); } catch { /* storage blocked */ } }

export const newChatId = () => `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

export function chatTitle(turns: Turn[]) {
  const q = turns.find(t => t.role === 'user')?.text?.replace(/\s+/g, ' ').trim() ?? 'New chat';
  return q.length > 64 ? `${q.slice(0, 62).trimEnd()}…` : q;
}

export function ago(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : d < 7 ? `${d} days ago` : new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
