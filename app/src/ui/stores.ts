// Tiny stores for values that change many times per second (mouse position, camera height),
// so only the small readout re-renders, not the whole app.
import { useSyncExternalStore } from 'react';

function store<T>(initial: T) {
  let v = initial;
  const ls = new Set<() => void>();
  return {
    set(next: T) { v = next; ls.forEach(l => l()); },
    use(): T { return useSyncExternalStore(l => { ls.add(l); return () => ls.delete(l); }, () => v); },
  };
}

export const hoverStore = store<{ lat: number; lon: number } | null>(null);
export const cameraStore = store<{ km: number; heading: number; pitch: number }>({ km: 0, heading: 0, pitch: -90 });
