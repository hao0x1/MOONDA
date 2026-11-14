// Read a science map under a spot, keeping the sharper southern planner grids where they exist.

import { useEffect, useState } from 'react';
import { POLAR_EXTENT_M, POLAR_SIZE, type ScienceManifestEntry, type ScienceValueSource } from '../moon/layers';
import { scienceRasterValueAt } from '../moon/imagery';
import { toMap } from './terrain';

let manifest: Promise<ScienceManifestEntry[]> | null = null;
export function loadManifest(): Promise<ScienceManifestEntry[]> {
  if (!manifest) {
    manifest = fetch('./data/layers/manifest.json', { cache: 'no-cache' }) // the list of maps: always asked afresh (a week-old copy hid new layers from returning visitors)
      .then(r => (r.ok ? r.json() : []))
      .then((m: ScienceManifestEntry[] | { layers: ScienceManifestEntry[] }) => (Array.isArray(m) ? m : m.layers ?? []))
      .catch(() => []);
  }
  return manifest;
}

interface ValueGrid<T> { promise: Promise<T | null>; lastUsed: number; bytes: number }
const VALUE_GRID_BUDGET = 16 * 2 ** 20;
const VALUE_IDLE_MS = 120_000;
const grids = new Map<string, ValueGrid<Uint16Array>>();
const byteGrids = new Map<string, ValueGrid<Uint8Array>>();
function trimValueGrids() {
  const now = performance.now();
  for (const cache of [grids, byteGrids]) for (const [key, entry] of cache) if (now - entry.lastUsed > VALUE_IDLE_MS) cache.delete(key);
  const all = [...grids.values(), ...byteGrids.values()].sort((a, b) => a.lastUsed - b.lastUsed);
  let bytes = all.reduce((n, e) => n + e.bytes, 0);
  for (const entry of all) {
    if (bytes <= VALUE_GRID_BUDGET) break;
    for (const cache of [grids, byteGrids]) for (const [key, e] of cache) if (e === entry) { cache.delete(key); bytes -= entry.bytes; }
  }
}
const valueGridSweep = setInterval(trimValueGrids, 20_000);
import.meta.hot?.dispose(() => { clearInterval(valueGridSweep); grids.clear(); byteGrids.clear(); });
(globalThis as unknown as { __moondaLayerValueMemory: unknown }).__moondaLayerValueMemory = () => ({
  retainedBytes: [...grids.values(), ...byteGrids.values()].reduce((n, e) => n + e.bytes, 0), budgetBytes: VALUE_GRID_BUDGET,
});
function grid(id: string) {
  let g = grids.get(id);
  if (!g) {
    g = { promise: Promise.resolve(null), lastUsed: performance.now(), bytes: 0 };
    const entry = g;
    g.promise = fetch(`./data/layers/${id}.bin`).then(r => (r.ok ? r.arrayBuffer() : null)).then(b => {
      const values = b ? new Uint16Array(b) : null;
      if (grids.get(id) === entry) { entry.bytes = values?.byteLength ?? 0; trimValueGrids(); }
      return values;
    }).catch(() => null);
    grids.set(id, g);
  }
  g.lastUsed = performance.now();
  return g.promise;
}

async function sourceValue(source: ScienceValueSource, lat: number, lon: number): Promise<number | null> {
  if (source.projection === 'polar' && (Math.abs(lat) > (source.maximumTrueLatDeg ?? 90) || (source.pole === 'north' ? lat < (source.clipTrueLatDeg ?? 80) : lat > (source.clipTrueLatDeg ?? -80)))) return null;
  let code: number | null;
  if (source.format === 'png-u8') code = await scienceRasterValueAt(source, lat, lon);
  else {
    let promise = byteGrids.get(source.url);
    if (!promise) {
      promise = { promise: Promise.resolve(null), lastUsed: performance.now(), bytes: 0 };
      const entry = promise;
      promise.promise = fetch(source.url).then(r => r.ok ? r.arrayBuffer() : null).then(b => {
        const values = b ? new Uint8Array(b) : null;
        if (byteGrids.get(source.url) === entry) { entry.bytes = values?.byteLength ?? 0; trimValueGrids(); }
        return values;
      }).catch(() => null);
      byteGrids.set(source.url, promise);
    }
    promise.lastUsed = performance.now();
    const values = await promise.promise;
    if (!values) return null;
    let u: number, v: number;
    if (source.projection === 'global') {
      u = ((lon + 180) % 360 + 360) % 360 / 360;
      v = (90 - lat) / 180;
    } else {
      const north = source.pole === 'north';
      if (north ? lat < (source.clipTrueLatDeg ?? 80) : lat > (source.clipTrueLatDeg ?? -80)) return null;
      const rho = 2 * 1737400 * Math.tan((90 - Math.abs(lat)) * Math.PI / 360);
      const x = rho * Math.sin(lon * Math.PI / 180), y = rho * Math.cos(lon * Math.PI / 180) * (north ? -1 : 1);
      const extent = source.extentM ?? POLAR_EXTENT_M;
      u = (x + extent) / (2 * extent); v = (extent - y) / (2 * extent);
    }
    const col = Math.floor(u * source.width), row = Math.floor(v * source.height);
    code = col >= 0 && row >= 0 && col < source.width && row < source.height ? values[row * source.width + col] : null;
  }
  if (code === null || code === (source.noData ?? 255) || code < (source.minimumCode ?? 0)) return null;
  return source.presenceClass ?? code * source.scale + (source.offset ?? 0);
}

export async function valueAt(entry: ScienceManifestEntry, lat: number, lon: number): Promise<number | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return null;
  // Keep the sharper existing south-pole values, including valid zeroes.
  if (lat <= -79.9) {
    const value = await legacyValueAt(entry, lat, lon);
    if (value !== null) return value;
  }
  // Later sources are the sharper ones. Fall through only for missing coverage, never for a valid zero.
  for (const source of [...(entry.valueSources ?? [])].reverse()) {
    const value = await sourceValue(source, lat, lon);
    if (value !== null) return value;
  }
  return null;
}

async function legacyValueAt(entry: ScienceManifestEntry, lat: number, lon: number): Promise<number | null> {
  const g = await grid(entry.id);
  if (!g) return null;
  const [x, y] = toMap(lat, lon);
  const col = Math.floor(((x + POLAR_EXTENT_M) / (2 * POLAR_EXTENT_M)) * POLAR_SIZE);
  const row = Math.floor(((POLAR_EXTENT_M - y) / (2 * POLAR_EXTENT_M)) * POLAR_SIZE);
  if (col < 0 || row < 0 || col >= POLAR_SIZE || row >= POLAR_SIZE) return null;
  const v = g[row * POLAR_SIZE + col];
  if (v === 65535) return null;
  return v * entry.scale + entry.offset;
}

export function useLayerValues(entries: ScienceManifestEntry[], lat: number | null, lon: number | null) {
  const [values, setValues] = useState<Record<string, number | null>>({});
  useEffect(() => {
    if (lat === null || lon === null) { setValues({}); return; }
    let live = true;
    // Only the rows on the card need values. Hidden temperature and danger maps stay encoded.
    const shown = new Set(['height', 'slope', 'sunlight', 'earth', 'psr', 'waterice']);
    if (!entries.some(e => e.id === 'psr')) shown.add('ice');
    Promise.all(entries.filter(e => shown.has(e.id)).map(async e => [e.id, await valueAt(e, lat, lon)] as const)).then(pairs => { if (live) setValues(Object.fromEntries(pairs)); });
    return () => { live = false; };
  }, [entries, lat, lon]);
  return values;
}
