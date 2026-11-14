// Full-screen start-up screen. The map loads its data behind it and reports real progress.

import { Wordmark } from './kit';

interface Props {
  progress: { pct: number; step: string };
  /** true while it fades away */
  leaving?: boolean;
  onSkip?(): void;
}

export function LoadingScreen({ progress, leaving, onSkip }: Props) {
  const pct = Math.max(2, Math.min(100, Math.round(progress.pct)));
  return (
    <div className={`loading${leaving ? ' leaving' : ''}`} role="status" aria-live="polite" aria-label="Loading MOONDA">
      <div className="loading-box">
        <div className="loading-name"><Wordmark /></div>
        <div className="loading-tag">Explore the Moon. Find a place to land.</div>
        <div className="loading-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></div>
        <div className="loading-step">{progress.step}</div>
      </div>
      {onSkip && <button type="button" className="loading-skip" onClick={onSkip}>Skip</button>}
      <div className="loading-foot">Getting everything ready now, so the Moon moves smoothly afterwards.</div>
    </div>
  );
}
