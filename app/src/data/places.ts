// Special places on the map.
//   - NASA's nine candidate regions for the first crewed south-pole landing (hand-checked): positions are APPROXIMATE
//     example points inside each region (NASA publishes the regions as outlines on a map, not as single coordinates);
//   - two well-known sunny spots;
//   - every landing, impact and planned landing site, and the craters with evidence about water ice: sites.ts
//     (made from researched lists in data-prep/sites and data-prep/features, with a source for each).

import { SITES } from './sites';

/**
 * artemis = candidate crewed-landing region · spot = well-known natural spot · mission = finished landing or impact ·
 * active = hardware last reported working · planned = announced future landing · ice = crater with water-ice evidence
 */
export type PlaceKind = 'artemis' | 'mission' | 'spot' | 'active' | 'planned' | 'ice';

export interface Place {
  id: string;
  kind: PlaceKind;
  name: string;
  lat: number;
  lon: number;
  short: string; // one-line plain description
  detail: string;
  date?: string;
  source: { name: string; url: string };
  /** landing sites: what it is, who flew it, how it went, and how exact the position is (km) */
  what?: string;
  operator?: string;
  outcome?: string;
  precisionKm?: number;
  /** the status or position could not be confirmed from a primary source (the note says what is uncertain) */
  verify?: boolean;
  note?: string;
  /** ice places: measured there / signs seen from orbit / only predicted by temperature, with each piece of evidence */
  ice?: string;
  diameterKm?: number;
  evidence?: { instrument: string; finding: string; citation: string; url: string }[];
}

const ARTEMIS_SRC = { name: 'NASA, "NASA Provides Update on Artemis III Moon Landing Regions" (Oct 2024)', url: 'https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/' };

const artemis = (id: string, name: string, lat: number, lon: number, detail: string): Place => ({
  id, kind: 'artemis', name, lat, lon,
  short: 'NASA candidate region for the first crewed south-pole landing',
  detail: `${detail} The marker is an approximate point inside the region; NASA's region is an area several kilometres across.`,
  source: ARTEMIS_SRC,
});

const LOLA_SRC = { name: 'Mazarico et al. 2011, "Illumination conditions of the lunar polar regions using LOLA topography", Icarus 211', url: 'https://doi.org/10.1016/j.icarus.2010.10.030' };

/** Kinds that are landing sites (past, present, future). */
export const SITE_KINDS: readonly PlaceKind[] = ['mission', 'active', 'planned'];

export const PLACES: Place[] = [
  { id: 's-connecting-ridge', kind: 'spot', name: 'Connecting Ridge', lat: -89.45, lon: -137.3,
    short: 'One of the sunniest places on the Moon (unofficial name)', detail: 'The ridge joining the rims of Shackleton and de Gerlache craters. Because it is high and close to the pole, the Sun stays above its skyline most of the year. Try it with the landing check.',
    source: LOLA_SRC },
  { id: 's-shackleton-rim', kind: 'spot', name: 'Shackleton rim (high point)', lat: -89.79, lon: -154.3,
    short: 'A high, often-sunlit point on Shackleton crater\'s rim (unofficial name)', detail: 'The rim of Shackleton sits right next to the pole and next to the permanently shadowed crater floor, where ice may be trapped.',
    source: LOLA_SRC },

  artemis('a-cabeus-b', 'Peak near Cabeus B', -83.76, -69.98, 'A high peak near Cabeus B crater, on the nearside-facing edge of the polar region.'),
  artemis('a-haworth', 'Haworth', -86.77, -20.51, 'Ridges beside Haworth crater, whose floor is permanently in shadow and may trap ice.'),
  artemis('a-malapert', 'Malapert Massif', -85.94, -0.94, 'A mountain about 5 km high that faces Earth, so Earth stays in view for a long time.'),
  artemis('a-mouton-plateau', 'Mons Mouton Plateau', -85.11, 26.71, 'A broad, flat-topped plateau beside Mons Mouton.'),
  artemis('a-mouton', 'Mons Mouton', -85.42, 31.85, 'A large flat-topped mountain named after NASA mathematician Melba Mouton.'),
  artemis('a-nobile-1', 'Nobile Rim 1', -85.30, 36.92, 'Part of the rim of Nobile crater.'),
  artemis('a-nobile-2', 'Nobile Rim 2', -84.05, 56.48, 'Another stretch of Nobile crater rim, further from the pole.'),
  artemis('a-degerlache-2', 'de Gerlache Rim 2', -88.39, -68.87, 'The rim of de Gerlache crater, close to the pole and to Shackleton.'),
  artemis('a-slater', 'Slater Plain', -87.48, 124.52, 'A plain near Slater crater on the far side of the pole.'),

  // landings, impacts, planned landings and ice evidence (sites.ts)
  ...SITES,
];
