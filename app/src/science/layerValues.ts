// Read the value of a NASA polar science map (sunlight %, temperature…) under a spot.

import { useEffect, useState } from 'react';
import { POLAR_EXTENT_M, POLAR_SIZE, type ScienceManifestEntry } from '../moon/layers';
import { toMap } from './terrain';

let manifest: Promise<ScienceManifestEntry[]> | null = null;
export function loadManifest(): Promise<ScienceManifestEntry[]> {
  if (!manifest) {
    manifest = fetch('./data/layers/manifest.json')
      .then(r => (r.ok ? r.json() : []))
      .then((m: ScienceManifestEntry[] | { layers: ScienceManifestEntry[] }) => (Array.isArray(m) ? m : m.layers ?? []))
      .catch(() => []);
  }
  return manifest;
}

const grids = new Map<string, Promise<Uint16Array | null>>();
function grid(id: string) {
  let g = grids.get(id);
  if (!g) {
    g = fetch(`./data/layers/${id}.bin`).then(r => (r.ok ? r.arrayBuffer() : null)).then(b => (b ? new Uint16Array(b) : null)).catch(() => null);
    grids.set(id, g);
  }
  return g;
}

export async function valueAt(entry: ScienceManifestEntry, lat: number, lon: number): Promise<number | null> {
  if (lat > -79.9) return null;
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
    if (lat === null || lon === null || lat > -79.9) { setValues({}); return; }
    let live = true;
    Promise.all(entries.map(async e => [e.id, await valueAt(e, lat, lon)] as const)).then(pairs => { if (live) setValues(Object.fromEntries(pairs)); });
    return () => { live = false; };
  }, [entries, lat, lon]);
  return values;
}
