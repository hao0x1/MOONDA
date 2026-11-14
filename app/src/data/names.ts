// Official Moon place names (IAU / USGS Gazetteer of Planetary Nomenclature).

export interface MoonName {
  idx: number;
  name: string;
  kind: string;
  diameterKm: number;
  lat: number;
  lon: number;
  origin: string;
  usgsId: number;
  satellite: boolean;
}

let cache: Promise<MoonName[]> | null = null;

// Six official names (and their satellite craters) lost their apostrophe in names.json and show a gap.
const APOSTROPHE = /^(Nefed|Idel|Artem|Khvol|Vil|Il) (ev|son|in)\b/;
const fixName = (s: string) => s.replace(APOSTROPHE, "$1'$2");

export function loadNames(): Promise<MoonName[]> {
  if (!cache) {
    cache = fetch('./data/names.json').then(r => r.json()).then((d: { rows: [string, string, number, number, number, string, number, number][] }) =>
      d.rows.map((r, idx) => ({ idx, name: fixName(r[0]), kind: r[1], diameterKm: r[2], lat: r[3], lon: r[4], origin: r[5], usgsId: r[6], satellite: r[7] === 1 })));
  }
  return cache;
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Simple ranked search: prefix matches first, then word matches, bigger features first. */
export function searchNames(all: MoonName[], query: string, limit = 8): MoonName[] {
  const q = fold(query.trim());
  if (!q) return [];
  const scored: [number, MoonName][] = [];
  for (const n of all) {
    const f = fold(n.name);
    let s = -1;
    if (f === q) s = 1000;
    else if (f.startsWith(q)) s = 500;
    else if (f.split(/[\s-]+/).some(w => w.startsWith(q))) s = 300;
    else if (q.length > 2 && f.includes(q)) s = 100;
    if (s < 0) continue;
    s += Math.min(200, n.diameterKm) - (n.satellite ? 320 : 0); // small satellite craters ("Malapert K") after main features
    scored.push([s, n]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(x => x[1]);
}

const DEG = Math.PI / 180;
/** Great-circle distance in km on the Moon. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a = Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
  return 2 * 1737.4 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function nearestNames(all: MoonName[], lat: number, lon: number, limit = 5, skipIdx = -1): (MoonName & { km: number })[] {
  const out: (MoonName & { km: number })[] = [];
  for (const n of all) {
    if (n.idx === skipIdx || n.satellite) continue;
    if (Math.abs(n.lat - lat) > 6) continue;
    out.push({ ...n, km: distanceKm(lat, lon, n.lat, n.lon) });
  }
  return out.sort((a, b) => a.km - b.km).slice(0, limit);
}

/** Named feature whose outline (approx. circle) contains the point, smallest first. */
export function containingName(all: MoonName[], lat: number, lon: number): MoonName | null {
  let best: MoonName | null = null;
  for (const n of all) {
    if (!n.diameterKm || Math.abs(n.lat - lat) > 5) continue;
    if (n.kind !== 'Crater' && n.kind !== 'Small crater' && n.kind !== 'Mountain') continue;
    if (distanceKm(lat, lon, n.lat, n.lon) <= n.diameterKm / 2 && (!best || n.diameterKm < best.diameterKm)) best = n;
  }
  return best;
}

export function formatLatLon(lat: number, lon: number, digits = 2): string {
  const la = `${Math.abs(lat).toFixed(digits)}° ${lat < 0 ? 'S' : 'N'}`;
  const lo = `${Math.abs(lon).toFixed(digits)}° ${lon < 0 ? 'W' : 'E'}`;
  return `${la}, ${lo}`;
}
