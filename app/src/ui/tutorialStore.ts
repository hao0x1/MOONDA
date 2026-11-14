// The tour's small store: whether it is showing (the objectives themselves are in Tutorial.tsx).
// It can be opened from the start screen or the Tutorial button in the top bar.
// Only finishing or closing is remembered; opening it never changes the first-visit choice.
import { useSyncExternalStore } from 'react';

const KEY = 'moonda.tutorial.v1';
/** run: counts the times the tour was opened, so each opening starts from a clean sheet */
interface TutorialState { active: boolean; run: number; seen: boolean }
function readSeen(): boolean {
  try { return localStorage.getItem(KEY) !== null; } catch { return false; }
}
let state: TutorialState = { active: false, run: 0, seen: readSeen() };
const listeners = new Set<() => void>();
function update(patch: Partial<TutorialState>): void {
  state = { ...state, ...patch };
  listeners.forEach(fn => fn());
}
function stop(): void {
  try { localStorage.setItem(KEY, 'done'); } catch { /* The tour still works with storage blocked. */ }
  update({ active: false, seen: true });
}
export const tutorialStore = {
  start(): void { update({ active: true, run: state.run + 1 }); },
  stop,
  use(): TutorialState {
    return useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => state);
  },
};
