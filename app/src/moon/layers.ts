// Every switchable layer on the map, described in plain words.
//
// The words themselves live in src/i18n (en/layers.ts, km/layers.ts). `title` and `help` below are the
// English text, for code that needs a fixed name; anything shown on screen should use layerTitle(),
// layerLine(), layerHelp() and layerNotes(), which give the text in the current language.

import { tMaybe } from '../i18n';
import { layers as EN } from '../i18n/en/layers';

export type LayerGroup = 'map' | 'science' | 'markers';

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
    help: EN['layer.missions.help'] },
];

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
}

export const POLAR_EXTENT_M = 304000;
export const POLAR_SIZE = 2048;

export function scienceToLayer(e: ScienceManifestEntry): LayerDef {
  return { id: e.id, title: e.title, group: 'science', help: e.shortHelp, defaultOn: false, polarOnly: true, units: e.units,
    legend: e.legend, source: e.source, notes: e.notes, scale: e.scale, offset: e.offset };
}

// ---------- the words for a layer, in the current language ----------

const firstSentence = (s: string) => { const m = s.match(/^[^.!?]*[.!?]?/); return (m ? m[0] : s).replace(/[.]$/, ''); };

/** The layer's name. */
export const layerTitle = (l: Pick<LayerDef, 'id' | 'title'>) => tMaybe(`layer.${l.id}.title`, l.title);
/** The longer explanation (two or three plain sentences). */
export const layerHelp = (l: Pick<LayerDef, 'id' | 'help'>) => tMaybe(`layer.${l.id}.help`, l.help);
/** One short line for the list (falls back to the first sentence of the explanation). */
export const layerLine = (l: Pick<LayerDef, 'id' | 'help'>) => tMaybe(`layer.${l.id}.line`, firstSentence(layerHelp(l)));
/** The technical small print of a NASA map, if it has any. */
export const layerNotes = (l: Pick<LayerDef, 'id' | 'notes'>) => (l.notes ? tMaybe(`layer.${l.id}.notes`, l.notes) : '');
