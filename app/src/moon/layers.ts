// Map layers and their defaults; the panel lists only the useful switches.
//
// The words themselves live in src/i18n (en/layers.ts, km/layers.ts). `title` and `help` below are the
// English text, for code that needs a fixed name; anything shown on screen should use layerTitle(),
// layerLine(), layerHelp() and layerNotes(), which give the text in the current language.

import { tMaybe } from '../i18n';
import { layers as EN } from '../i18n/en/layers';

export type LayerGroup = 'map' | 'science' | 'markers' | 'hazards';

export interface LegendStop { value: number; color: string }

export interface LayerDef {
  id: string;
  title: string;
  group: LayerGroup;
  help: string; // the longer explanation, plain English
  defaultOn: boolean;
  needsInternet?: boolean;
  polarOnly?: boolean;
  units?: string;
  legend?: LegendStop[];
  source?: { name: string; url: string; citation?: string };
  notes?: string;
  /** A quiet coverage line, separate from the explanation in the help bubble. */
  coverage?: string;
  rasterSources?: ScienceRasterSource[];
  // science layers (polar rasters)
  scale?: number;
  offset?: number;
}

export const BASE_LAYERS: LayerDef[] = [
  { id: 'photo', title: EN['layer.photo.title'], group: 'map', defaultOn: true,
    help: EN['layer.photo.help'],
    source: { name: 'NASA Moon Trek · LRO WAC global mosaic; LROC WAC south-pole summer mosaic (ASU)', url: 'https://trek.nasa.gov/moon/' } },
  { id: 'polarPhoto', title: EN['layer.polarPhoto.title'], group: 'map', defaultOn: true, needsInternet: true, polarOnly: true,
    help: EN['layer.polarPhoto.help'],
    source: { name: 'LROC NAC south-pole controlled mosaic · ASU Lunaserv (the server behind QuickMap)', url: 'https://quickmap.lroc.asu.edu/' } },
  { id: 'terrain', title: EN['layer.terrain.title'], group: 'map', defaultOn: true,
    help: EN['layer.terrain.help'],
    source: { name: 'NASA LRO LOLA: 80 m south-pole map + 1.9 km global map', url: 'https://pgda.gsfc.nasa.gov/' } },
  { id: 'height', title: EN['layer.height.title'], group: 'map', defaultOn: false, needsInternet: true,
    help: EN['layer.height.help'],
    units: 'km', legend: [{ value: -9, color: '#2b1a6b' }, { value: -4, color: '#2f7bd8' }, { value: 0, color: '#4fc56b' }, { value: 3, color: '#f2d34b' }, { value: 6, color: '#e2603c' }, { value: 10, color: '#ffffff' }],
    source: { name: 'NASA Moon Trek · LRO LOLA elevation, colour hillshade v6', url: 'https://trek.nasa.gov/moon/' } },
  { id: 'dataDetail', title: EN['layer.dataDetail.title'], group: 'map', defaultOn: false,
    help: EN['layer.dataDetail.help'],
    source: { name: 'NASA LRO LOLA (LDEM 80 m south of 80° S, global ~1.9 km); NASA Moon Trek LRO WAC mosaic; LROC NAC; NASA SVS CGI Moon Kit albedo', url: 'https://trek.nasa.gov/moon/' } },
  { id: 'realSun', title: EN['layer.realSun.title'], group: 'map', defaultOn: true,
    help: EN['layer.realSun.help'] },
  { id: 'skymarkers', title: EN['layer.skymarkers.title'], group: 'map', defaultOn: false,
    help: EN['layer.skymarkers.help'] },
  { id: 'stars', title: EN['layer.stars.title'], group: 'map', defaultOn: true,
    help: EN['layer.stars.help'],
    source: { name: 'NASA SVS Deep Star Maps 2020 · bright star catalogue', url: 'https://svs.gsfc.nasa.gov/4851' } },
  { id: 'skyNames', title: EN['layer.skyNames.title'], group: 'map', defaultOn: true,
    help: EN['layer.skyNames.help'] },
];

export const MARKER_LAYERS: LayerDef[] = [
  { id: 'names', title: EN['layer.names.title'], group: 'markers', defaultOn: true,
    help: EN['layer.names.help'],
    source: { name: 'Gazetteer of Planetary Nomenclature (IAU / USGS)', url: 'https://planetarynames.wr.usgs.gov/' } },
  { id: 'artemis', title: EN['layer.artemis.title'], group: 'markers', defaultOn: true,
    help: EN['layer.artemis.help'] },
  { id: 'missions', title: EN['layer.missions.title'], group: 'markers', defaultOn: true,
    help: EN['layer.missions.help'],
    source: { name: 'LROC list of human-made objects on the Moon (NASA/GSFC/Arizona State University) and NASA NSSDCA; each place names its own source', url: 'https://lroc.im-ldi.com/' } },
  { id: 'sitesActive', title: EN['layer.sitesActive.title'], group: 'markers', defaultOn: true,
    help: EN['layer.sitesActive.help'] },
  { id: 'sitesPlanned', title: EN['layer.sitesPlanned.title'], group: 'markers', defaultOn: true,
    help: EN['layer.sitesPlanned.help'] },
];

/** Things a rover or lander should keep clear of: drawn over the photo, each with its own switch. */
export const HAZARD_LAYERS: LayerDef[] = [
  { id: 'craters', title: EN['layer.craters.title'], group: 'map', defaultOn: false,
    help: EN['layer.craters.help'],
    source: { name: 'Robbins (2019), A New Global Database of Lunar Impact Craters >1–2 km, JGR Planets 124 · USGS Astrogeology / NASA PDS; small south-polar craters: Marco Figuera et al. (CC BY 4.0)', url: 'https://astrogeology.usgs.gov/search/map/moon_crater_database_v1_robbins' } },
];

/** Class maps use swatches rather than a smooth scale. */
export const CLASS_LAYERS: Record<string, { value: number; color: string; key: string }[]> = {
  waterice: [
    { value: 3, color: '#a36cdb', key: 'layer.waterice.class.hydrogen' },
    { value: 2, color: '#50d2ff', key: 'layer.waterice.class.surface' },
    { value: 1, color: '#6e96ff', key: 'layer.waterice.class.buried' },
  ],
  danger: [
    { value: 1, color: '#f5c83c', key: 'layer.danger.class.caution' },
    { value: 2, color: '#f58228', key: 'layer.danger.class.steep' },
    { value: 3, color: '#e63232', key: 'layer.danger.class.tooSteep' },
  ],
};
/** Sizes of the south-pole pictures that are sharper than the usual 2048 pixels (they may be drawn one zoom level deeper). */
export const SHARP_POLAR_LAYERS = new Set(['psr', 'waterice', 'danger']);
/** Maps kept for the numbers or another control, without a separate switch in the box. */
export const HIDDEN_SCIENCE = new Set(['height', 'ice', 'temp-avg']);

/** Local science maps, composited from broad coverage to the sharper polar map. */
export interface ScienceRasterSource {
  url: string;
  projection: 'global' | 'polar';
  pole?: 'north' | 'south';
  extentM?: number;
  clipTrueLatDeg?: number;
  maximumTrueLatDeg?: number;
  encoding?: 'gray8';
  palette?: string[];
  replace?: boolean;
  packed?: SciencePackedSource;
  preview?: SciencePackedSource;
}

export interface SciencePackedSource {
  url: string;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
  bits: 2 | 8;
  compression: 'deflate';
  tileSize?: number;
  offsets?: number[];
  predictor?: 'sub';
}

/** Small numeric maps. The old south-pole Uint16 grids remain unchanged for the planner. */
export interface ScienceValueSource extends Omit<ScienceRasterSource, 'palette'> {
  format: 'png-u8' | 'u8';
  width: number;
  height: number;
  scale: number;
  offset?: number;
  noData?: number;
  /** Some evidence is a class label, rather than an abundance or a temperature. */
  presenceClass?: number;
  minimumCode?: number;
}

export interface ScienceManifestEntry {
  id: string;
  title: string;
  shortHelp: string;
  units: string;
  scale: number;
  offset: number;
  valueMin: number;
  valueMax: number;
  legend: LegendStop[];
  source: { name: string; url: string; citation?: string; version?: string };
  notes?: string;
  coverage?: string;
  rasterSources?: ScienceRasterSource[];
  valueSources?: ScienceValueSource[];
}

export const POLAR_EXTENT_M = 304000;
export const POLAR_SIZE = 2048;

export function scienceToLayer(e: ScienceManifestEntry): LayerDef {
  return { id: e.id, title: e.title, group: 'science', help: e.shortHelp, defaultOn: false, polarOnly: !e.rasterSources?.some(s => s.projection === 'global'), units: e.units,
    legend: e.legend, source: e.source, notes: e.notes, coverage: e.coverage, rasterSources: e.rasterSources, scale: e.scale, offset: e.offset };
}

// ---------- the words for a layer, in the current language ----------

const firstSentence = (s: string) => { const m = s.match(/^[^.!?]*[.!?]?/); return (m ? m[0] : s).replace(/[.]$/, ''); };

/** The layer's name. */
export const layerTitle = (l: Pick<LayerDef, 'id' | 'title'>) => tMaybe(`layer.${l.id}.title`, l.title);
/** A short explanation for the help bubble. */
export const layerHelp = (l: Pick<LayerDef, 'id' | 'help'>) => tMaybe(`layer.${l.id}.help`, l.help);
/** One short line for the list (falls back to the first sentence of the explanation). */
export const layerLine = (l: Pick<LayerDef, 'id' | 'help'>) => tMaybe(`layer.${l.id}.line`, firstSentence(layerHelp(l)));
/** A source name short enough for a quiet line in a help bubble. */
export function layerSource(l: Pick<LayerDef, 'id' | 'source'>): string {
  const names: Record<string, string> = {
    photo: 'NASA LROC', polarPhoto: 'NASA LROC', terrain: 'NASA LOLA', height: 'NASA LOLA',
    dataDetail: 'NASA LRO', stars: 'NASA SVS', names: 'IAU / USGS', missions: 'NASA LROC',
    craters: 'Robbins / USGS', sunlight: 'NASA LOLA', earth: 'NASA LOLA', ice: 'NASA LOLA',
    psr: 'NASA LOLA', waterice: 'NASA Diviner / LOLA / Lunar Prospector', danger: 'NASA LOLA / USGS',
    'temp-max': 'NASA Diviner', 'temp-avg': 'NASA Diviner', slope: 'NASA LOLA',
  };
  return l.source ? names[l.id] ?? l.source.name.split(/[;·]/)[0].trim() : '';
}
/** The technical small print of a NASA map, if it has any. */
export const layerNotes = (l: Pick<LayerDef, 'id' | 'notes'>) => (l.notes ? tMaybe(`layer.${l.id}.notes`, l.notes) : '');
export const layerCoverage = (l: Pick<LayerDef, 'id' | 'coverage'>) => (l.coverage ? tMaybe(`layer.${l.id}.coverage`, l.coverage) : '');

// ---------- what the Layers box lists, and what is on at the start ----------

/** Every layer's on / off state when the app starts (layers without a switch keep this state for good). */
export function layerDefaults(): Record<string, boolean> {
  // Science maps load after the first render, so keep their off states here too.
  const scienceIds = ['sunlight', 'earth', 'ice', 'temp-max', 'temp-avg', 'slope', 'psr', 'waterice', 'danger'];
  return { ...Object.fromEntries(scienceIds.map(id => [id, false])), ...Object.fromEntries([...BASE_LAYERS, ...HAZARD_LAYERS, ...MARKER_LAYERS].map(l => [l.id, l.defaultOn])) };
}

/**
 * The groups of switches in the Layers box. `science` = the NASA south-pole maps from the data's own list
 * (already as layers), `height` = the Height colours layer with its colour key.
 */
export function panelGroups(science: LayerDef[], height: LayerDef): { title: string; group: LayerGroup; note?: string; layers: LayerDef[] }[] {
  const mapOrder = ['psr', 'waterice', 'danger', 'slope'];
  const markerOrder = ['names', 'artemis', 'missions', 'sitesPlanned'];
  return [
    { title: 'Maps', group: 'science', layers: [...mapOrder.flatMap(id => science.filter(l => l.id === id)), ...HAZARD_LAYERS, height] },
    { title: 'Names and markers', group: 'markers', layers: markerOrder.flatMap(id => MARKER_LAYERS.filter(l => l.id === id)) },
  ];
}
