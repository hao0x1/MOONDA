// The tools the AI helper may use. They run here in the page with MOONDA's own science, so every
// number in an answer comes from the same calculations the rest of the app shows.

import type { MoonName } from '../data/names';
import { distanceKm, searchNames } from '../data/names';
import type { Place } from '../data/places';
import { t } from '../i18n';
import type { ScienceManifestEntry } from '../moon/layers';
import { statsFor } from '../science/analysis';
import { analyseSpotAsync } from '../science/client';
import { valueAt } from '../science/layerValues';
import type { ToolRunner, ToolSpec } from './agent';

export interface AppBridge {
  places: Place[];
  names(): MoonName[] | null;
  mission(): { arrivalMs: number; days: number; mastM: number; batteryHours: number; contactHours: number };
  manifest(): ScienceManifestEntry[];
  view(): string;
  showOnMap(lat: number, lon: number, label: string): void;
  addToCompare(lat: number, lon: number, label: string): string;
}

const KM_PER_DEG = 30.3233; // 1,737.4 km Moon: km per degree of latitude
const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(+v) ? +v : dflt);
const fmtH = (h: number) => (h <= 0 ? t('aitool.none') : h < 48 ? t('aitool.hours', { n: round(h, 0) }) : t('aitool.days', { n: round(h / 24, 1) }));

export const SYSTEM_PROMPT = `You are MOONDA AI, the landing-site assistant built into MOONDA, a "Google Earth for the Moon" web app made by a student team for the NASA Space Apps Challenge "Lunar Landing Site Navigator". If someone asks which company or model is behind you, say you are MOONDA's built-in assistant; do not name any AI company or model.

Your job: help the user choose where (and when) a robotic lander should touch down near the Moon's south pole (or anywhere they ask), judged mainly on two things the app calculates from NASA LOLA terrain and real Sun/Earth positions:
- sunlight for the solar panels (percentage of the mission, and the longest stretch of darkness the battery must survive),
- a direct radio line to Earth (percentage of the mission, and the longest stretch without Earth in view).
Also useful when available (south of 80°S only): NASA's long-term average sunlight and Earth visibility maps, permanent shadow (possible water ice nearby is scientifically valuable), temperature, and slope (landers need gentle ground, ideally under about 8–10°).

How to work:
1. Call get_mission_settings at the start of a conversation, and again whenever the user may have changed the date, mission length, panel height or needs.
2. Find candidates with list_candidate_sites and/or search_moon_names. For a region, use scan_area to try several nearby points.
3. Check every spot you recommend with analyse_spot (or scan_area for a first look). NEVER state a number that did not come from a tool result. If something cannot be calculated, say so.
4. Pick the best 1–3 spots and explain why in plain English a 15-year-old understands. Define any technical word in a few words.
5. Call show_on_map for your top pick so the user sees it. Only call add_to_compare if the user asks to compare, or for the top 2–3 picks when the user asks you to choose between places.

This is a running conversation, and the user can come back to it later. Build on what you already found: do not re-run a tool for a spot and settings you already checked, keep your numbers consistent with earlier answers, and if a number changed (new date, new settings) say why. Answer follow-up questions in the context of the earlier ones.

How your answer is shown: under your answer the app automatically adds a results table with every spot you checked with analyse_spot (sunlight, longest dark, Earth in view, longest without Earth, ✓/✗ for the user's needs, with buttons to show each spot on the map). So do NOT write your own table of those numbers; refer to "the table below" if helpful. For other comparisons (for example two missions or two dates), a small Markdown table is fine.

Answer format, every time, so answers look the same and are easy to scan:
- First line: the verdict in bold, one sentence, e.g. "**Best pick: the west rim of Shackleton (89.45°S, 0.00°E).**"
- Then 2–4 short bullets on why, with the key numbers in bold (sunlight %, longest dark, Earth in view %, slope if known) and whether the user's battery and radio needs are met.
- If there are runner-ups, one bullet each starting with the name in bold.
- Optional last line in italics with one caveat.
No filler, no greetings, no repeating the question. Latitudes/longitudes with 2 decimals. Never invent facts about missions or places beyond what tools return.`;

export const TOOLS: ToolSpec[] = [
  { type: 'function', function: { name: 'get_mission_settings', description: 'The mission settings the user chose in the app: arrival time (UTC), mission length, solar panel/antenna height, and how long the battery can survive darkness and how long the lander can go without talking to Earth.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'list_candidate_sites', description: 'Known places: NASA\'s nine Artemis III candidate regions near the south pole, well-known sunny spots, and past landing sites. Returns name, kind, latitude, longitude and a short description.', parameters: { type: 'object', properties: { kinds: { type: 'array', items: { type: 'string', enum: ['artemis', 'spot', 'mission'] }, description: 'Which kinds to list (default all).' } } } } },
  { type: 'function', function: { name: 'search_moon_names', description: 'Search the official IAU list of lunar feature names (craters, mountains, plains). Returns matches with latitude, longitude, size and kind.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'Max results (default 6, max 12).' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'analyse_spot', description: 'Run MOONDA\'s full calculation for one landing spot: the real skyline from NASA LOLA heights and the Sun and Earth over the whole mission. Returns sunlight %, longest darkness, Earth-in-view %, longest time without Earth, whether the user\'s battery and contact needs are met, ground height, distance from the south pole, and NASA polar map values (south of 80°S).', parameters: { type: 'object', properties: { lat: { type: 'number', description: 'Latitude in degrees (south is negative).' }, lon: { type: 'number', description: 'Longitude in degrees east (-180..180).' }, label: { type: 'string' }, arrival_utc: { type: 'string', description: 'Optional ISO time; default the user\'s arrival time.' }, days: { type: 'number', description: 'Optional mission length in days (default the user\'s).' } }, required: ['lat', 'lon'] } } },
  { type: 'function', function: { name: 'scan_area', description: 'Quickly try several landing points in a circle around a place (e.g. along a crater rim or a ridge) and rank them for sunlight and Earth contact, using coarser heights. Use it to find candidates in a region, then confirm the best 1–3 with analyse_spot. Keep radius_km small (2–10) for crater rims and ridges.', parameters: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' }, radius_km: { type: 'number', description: 'Search radius, 1–30 km (default 8).' }, points: { type: 'number', description: 'How many points to try, 4–16 (default 10).' }, label: { type: 'string' } }, required: ['lat', 'lon'] } } },
  { type: 'function', function: { name: 'show_on_map', description: 'Fly the map to a spot and select it, so the user sees it and its info panel.', parameters: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' }, label: { type: 'string' } }, required: ['lat', 'lon'] } } },
  { type: 'function', function: { name: 'add_to_compare', description: 'Add a spot to the app\'s Compare panel (up to 4 plans) so the user can see the plans side by side.', parameters: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' }, label: { type: 'string' } }, required: ['lat', 'lon', 'label'] } } },
];

const POLAR_LAYERS: Record<string, string> = { sunlight: 'nasa_avg_sunlight_pct', earth: 'nasa_avg_earth_in_view_pct', ice: 'permanently_shadowed', 'temp-max': 'hottest_K', 'temp-avg': 'average_K', slope: 'slope_deg' };

export function makeRunner(app: AppBridge): ToolRunner {
  const analyse = async (lat: number, lon: number, label: string, arrivalMs?: number, days?: number, quick = false, signal?: AbortSignal, limitMs = 40000) => {
    const m = app.mission();
    const spec = { lat, lon, mastM: m.mastM, startMs: arrivalMs ?? m.arrivalMs, days: Math.max(1, Math.min(30, Math.round(days ?? m.days))), quick };
    // `detail` goes to the AI as data, so it stays English; the panel shows its own words for it (AiTrace).
    let detail = quick ? 'quick scan (240 m heights near the pole)' : 'full (80 m heights near the pole)';
    const { horizon, timeline } = await analyseSpotAsync(spec, limitMs, signal).catch(async (e: unknown) => {
      if (quick || signal?.aborted) throw e;
      detail = 'coarse (240 m heights): the detailed map did not download in time';
      return analyseSpotAsync({ ...spec, quick: true }, 25000, signal);
    });
    const st = statsFor(timeline);
    const maps: Record<string, number> = {};
    for (const e of app.manifest()) {
      const key = POLAR_LAYERS[e.id];
      if (!key) continue;
      const v = await valueAt(e, lat, lon).catch(() => null);
      if (v !== null && Number.isFinite(v)) maps[key] = round(v, e.id === 'ice' ? 2 : 1);
    }
    const nearest = (app.names() ?? []).map(n => ({ n, km: distanceKm(lat, lon, n.lat, n.lon) })).sort((a, b) => a.km - b.km)[0];
    return {
      label: label || `${round(lat, 2)}, ${round(lon, 2)}`,
      lat: round(lat, 4), lon: round(lon, 4),
      arrival_utc: new Date(spec.startMs).toISOString(), mission_days: spec.days, panel_height_m: spec.mastM,
      ground_height_m: Math.round(horizon.groundM),
      distance_from_south_pole_km: Math.round((90 + lat) * KM_PER_DEG),
      near: nearest ? `${nearest.n.name} (${Math.round(nearest.km)} km)` : null,
      sunlight_pct: round(st.sunPct, 1),
      longest_dark_hours: round(st.longestDarkH, 1),
      earth_in_view_pct: round(st.earthPct, 1),
      longest_without_earth_hours: round(st.longestNoEarthH, 1),
      sun_and_earth_together_pct: round(st.bothPct, 1),
      battery_need_hours: Number.isFinite(m.batteryHours) ? m.batteryHours : 'not needed',
      contact_need_hours: Number.isFinite(m.contactHours) ? m.contactHours : 'not needed',
      meets_battery_need: !Number.isFinite(m.batteryHours) || st.longestDarkH <= m.batteryHours,
      meets_contact_need: !Number.isFinite(m.contactHours) || st.longestNoEarthH <= m.contactHours,
      nasa_polar_maps: Object.keys(maps).length ? maps : 'only available south of 80°S',
      detail,
    };
  };
  const brief = (r: Awaited<ReturnType<typeof analyse>>) => t('aitool.sum.brief', { sun: r.sunlight_pct, dark: fmtH(r.longest_dark_hours), earth: r.earth_in_view_pct });

  return {
    async run(name, args, progress, signal) {
      switch (name) {
        case 'get_mission_settings': {
          const m = app.mission();
          const result = {
            arrival_utc: new Date(m.arrivalMs).toISOString(), mission_days: m.days, panel_height_m: m.mastM,
            battery_survives_darkness_hours: Number.isFinite(m.batteryHours) ? m.batteryHours : 'not needed',
            ok_without_earth_hours: Number.isFinite(m.contactHours) ? m.contactHours : 'not needed',
            user_is_looking_at: app.view(),
          };
          return { result, summary: t('aitool.sum.settings', { date: result.arrival_utc.slice(0, 10), days: m.days, battery: Number.isFinite(m.batteryHours) ? fmtH(m.batteryHours) : t('aitool.any') }) };
        }
        case 'list_candidate_sites': {
          const kinds = Array.isArray(args.kinds) && args.kinds.length ? args.kinds as string[] : ['artemis', 'spot', 'mission'];
          const list = app.places.filter(p => kinds.includes(p.kind)).map(p => ({ name: p.name, kind: p.kind, lat: round(p.lat, 4), lon: round(p.lon, 4), about: p.short }));
          return { result: list, summary: t('aitool.sum.places', { n: list.length }) };
        }
        case 'search_moon_names': {
          const all = app.names() ?? [];
          const hits = searchNames(all, String(args.query ?? ''), Math.min(12, Math.max(1, num(args.limit, 6))));
          const result = hits.map(n => ({ name: n.name, kind: n.kind, lat: round(n.lat, 4), lon: round(n.lon, 4), diameter_km: n.diameterKm }));
          return { result, summary: result.length ? result.slice(0, 3).map(r => r.name).join(', ') + (result.length > 3 ? '…' : '') : t('aitool.sum.noMatch') };
        }
        case 'analyse_spot': {
          progress?.(t('aitool.progress.skyline'));
          const lat = num(args.lat, NaN), lon = num(args.lon, NaN);
          if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) throw new Error(t('aitool.err.latlon'));
          const arr = typeof args.arrival_utc === 'string' ? Date.parse(args.arrival_utc) : NaN;
          const r = await analyse(lat, lon, String(args.label ?? ''), Number.isFinite(arr) ? arr : undefined, typeof args.days === 'number' ? args.days : undefined, false, signal);
          return { result: r, summary: brief(r) };
        }
        case 'scan_area': {
          const lat = num(args.lat, NaN), lon = num(args.lon, NaN);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error(t('aitool.err.latlon'));
          const radius = Math.min(30, Math.max(1, num(args.radius_km, 8)));
          const n = Math.round(Math.min(16, Math.max(4, num(args.points, 10))));
          // the centre plus a ring (and an inner ring when there are many points)
          const pts: { lat: number; lon: number }[] = [{ lat, lon }];
          const rings = n > 9 ? [radius * 0.5, radius] : [radius];
          const per = Math.ceil((n - 1) / rings.length);
          for (const r of rings) for (let i = 0; i < per && pts.length < n; i++) {
            const a = (2 * Math.PI * i) / per + (r === radius ? 0 : Math.PI / per);
            const dLat = (r * Math.cos(a)) / KM_PER_DEG;
            const dLon = (r * Math.sin(a)) / (KM_PER_DEG * Math.max(0.02, Math.cos(((lat + dLat) * Math.PI) / 180)));
            let L = lat + dLat, O = lon + dLon;
            if (L < -90) { L = -180 - L; O += 180; }
            O = ((O + 540) % 360) - 180;
            pts.push({ lat: L, lon: O });
          }
          const results: Awaited<ReturnType<typeof analyse>>[] = [];
          // a few seconds per spot (the first one may also wait for the height maps); a spot that
          // does not finish in time is skipped, and Stop ends the scan between or during spots
          let skipped = 0;
          for (let i = 0; i < pts.length; i++) {
            if (signal?.aborted) throw new Error(t('aitool.err.stopped'));
            progress?.(t('aitool.progress.spot', { i: i + 1, n: pts.length }));
            try { results.push(await analyse(pts[i].lat, pts[i].lon, '', undefined, undefined, true, signal, i === 0 ? 30000 : 8000)); }
            catch (e) { if (signal?.aborted) throw e; skipped++; }
          }
          if (results.length < Math.ceil(pts.length / 2)) throw new Error(t('aitool.err.partial', { done: results.length, all: pts.length }));
          const score = (r: (typeof results)[number]) => (r.meets_battery_need ? 1000 : 0) + (r.meets_contact_need ? 500 : 0) + r.sunlight_pct + 0.5 * r.earth_in_view_pct - r.longest_dark_hours / 24;
          results.sort((a, b) => score(b) - score(a));
          const result = results.map((r, i) => ({ rank: i + 1, ...r }));
          return { result: { searched: `${pts.length} points within ${radius} km of ${String(args.label ?? `${round(lat, 2)}, ${round(lon, 2)}`)}`, note: 'Quick scan with the 240 m height map near the pole: check your top picks with analyse_spot for the exact 80 m numbers before recommending them.', ranked: result, ...(skipped ? { skipped_spots: skipped } : {}) }, summary: skipped ? t('aitool.sum.scanSkipped', { n: results.length, skipped, brief: brief(results[0]) }) : t('aitool.sum.scan', { n: results.length, brief: brief(results[0]) }) };
        }
        case 'show_on_map': {
          const lat = num(args.lat, NaN), lon = num(args.lon, NaN);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error(t('aitool.err.latlon'));
          app.showOnMap(lat, lon, String(args.label ?? ''));
          return { result: { shown: true }, summary: t('aitool.sum.showing', { name: String(args.label ?? `${round(lat, 2)}, ${round(lon, 2)}`) }) };
        }
        case 'add_to_compare': {
          const lat = num(args.lat, NaN), lon = num(args.lon, NaN);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error(t('aitool.err.latlon'));
          const msg = app.addToCompare(lat, lon, String(args.label ?? t('aitool.pick')));
          return { result: { message: msg }, summary: msg };
        }
        default:
          throw new Error(`Unknown tool ${name}`);
      }
    },
  };
}
