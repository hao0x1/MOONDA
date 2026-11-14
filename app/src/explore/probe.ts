// What the Sun, Earth and ground are like at a point on the trail or the route, for the time on the time bar.
// One ray of the skyline per body (science/route.ts probePoint, about 0.1 ms), on the page's own height maps.

import type { Vec3 } from '../science/ephemeris';
import { probePoint, type PointProbe } from '../science/route';
import { exploreHeights } from './context';

const cache = new Map<string, PointProbe>();

/** Sun / Earth / height / slope at a place for the Sun and Earth positions given (`key` names that moment, e.g. the minute). */
export function probeAt(lat: number, lon: number, mastM: number, sun: Vec3, earth: Vec3, key: string | number): PointProbe | null {
  const h = exploreHeights();
  if (!h || !h.meta) return null;
  const k = `${key}:${mastM}:${lat.toFixed(5)},${lon.toFixed(5)}`;
  let p = cache.get(k);
  if (!p) {
    p = probePoint(lat, lon, mastM, sun, earth, h);
    if (cache.size > 600) cache.clear();
    cache.set(k, p);
  }
  return p;
}
