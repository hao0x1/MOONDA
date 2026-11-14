// One place that answers "how high is the ground here?" anywhere on the Moon, using NASA
// LOLA laser-altimeter data:
//   - south of 80°S: the 80 m polar map (tiles loaded on demand) and its 240 m overview
//   - everywhere else: the global 16 pixels-per-degree map (~1.9 km)
// Heights are metres above (or below) a 1,737.4 km sphere. Used by the 3D terrain on the
// page and by the skyline calculator in the background worker.

import { MOON_RADIUS_M } from './ephemeris.ts';

const R = MOON_RADIUS_M;

/** Download a file completely, trying again (up to 4 times, waiting longer each time) if the connection drops. */
async function fetchBytes(url: string, tries = 4): Promise<ArrayBuffer> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.arrayBuffer();
    } catch (e) {
      last = e;
      await new Promise(res => setTimeout(res, 800 * 2 ** i));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
const DEG = Math.PI / 180;
// The polar maps and the global map disagree by up to a few hundred metres at 80°S. Between
// 80.5°S and 80°S we fade from the polar map to the global one so there is no cliff on the line.
const BLEND_FROM = -80.5;
const BLEND_FROM_Z = Math.sin(BLEND_FROM * DEG);
function blend(polar: number, global: number, latDeg: number) {
  const t = (latDeg - BLEND_FROM) / (-80 - BLEND_FROM); // 0 at 80.5°S, 1 at 80°S
  const w = t * t * (3 - 2 * t);
  return polar + (global - polar) * w;
}

export interface DemMeta {
  overview: { file: string; size: number; res: number; min: number; max: number };
  tiles: { dir: string; tileSize: number; count: number; res: number; min: number; max: number };
  global: { file: string; width: number; height: number; ppd: number };
}

export class MoonHeights {
  meta: DemMeta | null = null;
  global: Int16Array | null = null;
  overview: Int16Array | null = null;
  tiles = new Map<string, Int16Array | null>();
  private pendingTiles = new Map<string, Promise<void>>();
  readonly ready: Promise<void>;
  private base: string;

  /** `base` is the absolute URL of the app's data folder (ending in /data/). `preset`: height maps already
   *  downloaded elsewhere (the page hands its copy to the background worker, so they are not fetched twice). */
  constructor(base: string, preset?: { meta: DemMeta; global: Int16Array; overview: Int16Array }) {
    this.base = base;
    if (preset) {
      this.meta = preset.meta; this.global = preset.global; this.overview = preset.overview;
      this.ready = Promise.resolve();
      return;
    }
    this.ready = (async () => {
      this.meta = JSON.parse(new TextDecoder().decode(await fetchBytes(base + 'dem/dem.json'))) as DemMeta;
      const [g, o] = await Promise.all([
        fetchBytes(base + 'dem/' + this.meta.global.file),
        fetchBytes(base + 'dem/' + this.meta.overview.file),
      ]);
      this.global = new Int16Array(g);
      this.overview = new Int16Array(o);
    })();
  }

  /** Make sure the 80 m tiles covering a polar box (map metres) are loaded. */
  async loadTiles(x0: number, y0: number, x1: number, y1: number, maxTiles = 16): Promise<void> {
    await this.ready;
    const t = this.meta!.tiles, span = t.tileSize * t.res;
    const c0 = Math.max(0, Math.floor((x0 - t.min) / span)), c1 = Math.min(t.count - 1, Math.floor((x1 - t.min) / span));
    const r0 = Math.max(0, Math.floor((t.max - y1) / span)), r1 = Math.min(t.count - 1, Math.floor((t.max - y0) / span));
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > maxTiles) return;
    const jobs: Promise<void>[] = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const key = `${c}_${r}`;
      if (this.tiles.has(key)) continue;
      let p = this.pendingTiles.get(key);
      if (!p) {
        p = fetchBytes(`${this.base}dem/${t.dir}/${key}.bin`, 3)
          .then(b => { this.tiles.set(key, new Int16Array(b)); }).catch(() => { this.tiles.set(key, null); });
        this.pendingTiles.set(key, p);
      }
      jobs.push(p);
    }
    await Promise.all(jobs);
  }

  async loadTilesAround(lat: number, lon: number, radiusM: number) {
    const [x, y] = toMap(lat, lon);
    return this.loadTiles(x - radiusM, y - radiusM, x + radiusM, y + radiusM, 25);
  }

  /** 80 m polar height, or NaN if that tile isn't loaded / outside. */
  private fine(mx: number, my: number): number {
    const t = this.meta!.tiles;
    const fx = (mx - t.min) / t.res - 0.5, fy = (t.max - my) / t.res - 0.5;
    const c0 = Math.floor(fx), r0 = Math.floor(fy);
    if (c0 < 0 || r0 < 0 || c0 >= 7599 || r0 >= 7599) return NaN;
    const tx = fx - c0, ty = fy - r0, ts = t.tileSize;
    const at = (c: number, r: number) => {
      const tile = this.tiles.get(`${(c / ts) | 0}_${(r / ts) | 0}`);
      return tile ? tile[(r % ts) * ts + (c % ts)] : NaN;
    };
    const a = at(c0, r0), b = at(c0 + 1, r0), c = at(c0, r0 + 1), d = at(c0 + 1, r0 + 1);
    const top = a + (b - a) * tx, bot = c + (d - c) * tx;
    return top + (bot - top) * ty;
  }

  /** 240 m polar overview height, NaN outside. */
  private coarsePolar(mx: number, my: number): number {
    const o = this.meta!.overview, d = this.overview!;
    const fx = (mx - o.min) / o.res - 0.5, fy = (o.max - my) / o.res - 0.5;
    const c0 = Math.floor(fx), r0 = Math.floor(fy);
    if (c0 < 0 || r0 < 0 || c0 >= o.size - 1 || r0 >= o.size - 1) return NaN;
    const tx = fx - c0, ty = fy - r0, i = r0 * o.size + c0;
    const top = d[i] + (d[i + 1] - d[i]) * tx, bot = d[i + o.size] + (d[i + o.size + 1] - d[i + o.size]) * tx;
    return top + (bot - top) * ty;
  }

  private globalAt(latDeg: number, lonDeg: number): number {
    const g = this.meta!.global, d = this.global!;
    const fx = (lonDeg + 180) * g.ppd - 0.5, fy = (90 - latDeg) * g.ppd - 0.5;
    let c0 = Math.floor(fx);
    const r0 = Math.max(0, Math.min(g.height - 2, Math.floor(fy)));
    const tx = fx - c0, ty = Math.max(0, Math.min(1, fy - r0));
    c0 = ((c0 % g.width) + g.width) % g.width;
    const c1 = (c0 + 1) % g.width;
    const top = d[r0 * g.width + c0] * (1 - tx) + d[r0 * g.width + c1] * tx;
    const bot = d[(r0 + 1) * g.width + c0] * (1 - tx) + d[(r0 + 1) * g.width + c1] * tx;
    return top + (bot - top) * ty;
  }

  /** Height (m) at lat/lon. `detail` false skips the 80 m tiles (faster, smoother). */
  heightAt(latDeg: number, lonDeg: number, detail = true): number {
    if (!this.global) return 0;
    if (latDeg < -80) {
      const [mx, my] = toMap(latDeg, lonDeg);
      let p = detail ? this.fine(mx, my) : NaN;
      if (Number.isNaN(p)) p = this.coarsePolar(mx, my);
      if (!Number.isNaN(p)) return latDeg < BLEND_FROM ? p : blend(p, this.globalAt(latDeg, lonDeg), latDeg);
    }
    return this.globalAt(latDeg, lonDeg);
  }

  /** Same, from a unit vector (Moon body-fixed); avoids trig in the polar region. */
  heightAtUnit(ux: number, uy: number, uz: number, detail = true): number {
    if (uz < -0.98481) { // south of 80°S
      const f = (2 * R) / (1 - uz);
      const mx = f * uy, my = f * ux;
      let p = detail ? this.fine(mx, my) : NaN;
      if (Number.isNaN(p)) p = this.coarsePolar(mx, my);
      if (!Number.isNaN(p)) {
        if (uz < BLEND_FROM_Z) return p;
        const lat = Math.asin(uz) / DEG;
        return blend(p, this.globalAt(lat, Math.atan2(uy, ux) / DEG), lat);
      }
    }
    return this.globalAt(Math.asin(Math.max(-1, Math.min(1, uz))) / DEG, Math.atan2(uy, ux) / DEG);
  }

  /** How fine the height data is at a latitude, in metres (for honest labels). */
  static resolutionAt(latDeg: number): number { return latDeg < -80 ? 80 : 1900; }
}

/** lat/lon (deg) -> south polar stereographic map x/y (m). */
export function toMap(lat: number, lon: number): [number, number] {
  const rho = 2 * R * Math.tan(Math.PI / 4 + (lat * DEG) / 2);
  return [rho * Math.sin(lon * DEG), rho * Math.cos(lon * DEG)];
}
