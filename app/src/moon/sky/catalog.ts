// The star catalogue (public/space/stars.json, made by data-prep/space/stars.py from the HYG database):
// about 9,000 stars a person could see without a telescope, brightest first.
//   [raDeg, decDeg, magnitude, colourIndex, name | null (, constellation, lightYears)]

import { bvToRgb, raDecToUnit } from '../../science/skyMath.ts';
import type { V3 } from '../frame.ts';

type Row = [number, number, number, number, string | null, (string | null)?, (number | null)?];

export interface NamedStar { name: string; j2000: V3; mag: number; constellation: string | null; lightYears: number | null }

export interface StarCatalog {
  count: number;
  /** x, y, z (J2000 unit direction), magnitude — four numbers per star. */
  dirMag: Float32Array;
  /** r, g, b, 255 — four bytes per star. */
  color: Uint8Array;
  /** Stars with a proper name, brightest first (for name tags and for "what is this?"). */
  named: NamedStar[];
}

/** Friendlier names than the official ones, where most people know another one. */
const ALIAS: Record<string, string> = { 'Rigil Kentaurus': 'Alpha Centauri' };
/** Close companions that would only put a second tag on the same spot. */
const NO_TAG = new Set(['Toliman']);

const CONSTELLATIONS: Record<string, string> = {
  And: 'Andromeda', Ant: 'Antlia', Aps: 'Apus', Aqr: 'Aquarius', Aql: 'Aquila', Ara: 'Ara', Ari: 'Aries', Aur: 'Auriga', Boo: 'Boötes',
  Cae: 'Caelum', Cam: 'Camelopardalis', Cnc: 'Cancer', CVn: 'Canes Venatici', CMa: 'Canis Major', CMi: 'Canis Minor', Cap: 'Capricornus',
  Car: 'Carina', Cas: 'Cassiopeia', Cen: 'Centaurus', Cep: 'Cepheus', Cet: 'Cetus', Cha: 'Chamaeleon', Cir: 'Circinus', Col: 'Columba',
  Com: 'Coma Berenices', CrA: 'Corona Australis', CrB: 'Corona Borealis', Crv: 'Corvus', Crt: 'Crater', Cru: 'the Southern Cross', Cyg: 'Cygnus',
  Del: 'Delphinus', Dor: 'Dorado', Dra: 'Draco', Equ: 'Equuleus', Eri: 'Eridanus', For: 'Fornax', Gem: 'Gemini', Gru: 'Grus', Her: 'Hercules',
  Hor: 'Horologium', Hya: 'Hydra', Hyi: 'Hydrus', Ind: 'Indus', Lac: 'Lacerta', Leo: 'Leo', LMi: 'Leo Minor', Lep: 'Lepus', Lib: 'Libra',
  Lup: 'Lupus', Lyn: 'Lynx', Lyr: 'Lyra', Men: 'Mensa', Mic: 'Microscopium', Mon: 'Monoceros', Mus: 'Musca', Nor: 'Norma', Oct: 'Octans',
  Oph: 'Ophiuchus', Ori: 'Orion', Pav: 'Pavo', Peg: 'Pegasus', Per: 'Perseus', Phe: 'Phoenix', Pic: 'Pictor', Psc: 'Pisces', PsA: 'Piscis Austrinus',
  Pup: 'Puppis', Pyx: 'Pyxis', Ret: 'Reticulum', Sge: 'Sagitta', Sgr: 'Sagittarius', Sco: 'Scorpius', Scl: 'Sculptor', Sct: 'Scutum',
  Ser: 'Serpens', Sex: 'Sextans', Tau: 'Taurus', Tel: 'Telescopium', Tri: 'Triangulum', TrA: 'Triangulum Australe', Tuc: 'Tucana',
  UMa: 'the Great Bear', UMi: 'the Little Bear', Vel: 'Vela', Vir: 'Virgo', Vol: 'Volans', Vul: 'Vulpecula',
};

export function parseStars(rows: Row[]): StarCatalog {
  const n = rows.length;
  const dirMag = new Float32Array(n * 4), color = new Uint8Array(n * 4);
  const named: NamedStar[] = [];
  const d: V3 = [0, 0, 0], c: V3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    raDecToUnit(r[0], r[1], d);
    dirMag[4 * i] = d[0]; dirMag[4 * i + 1] = d[1]; dirMag[4 * i + 2] = d[2]; dirMag[4 * i + 3] = r[2];
    bvToRgb(r[3], c);
    // star colours are pale; push them a little away from white so orange giants and blue stars read on a screen
    const grey = (c[0] + c[1] + c[2]) / 3;
    for (let k = 0; k < 3; k++) color[4 * i + k] = Math.round(255 * Math.max(0, Math.min(1, grey + (c[k] - grey) * 1.5)));
    color[4 * i + 3] = 255;
    if (r[4] && !NO_TAG.has(r[4])) {
      named.push({ name: ALIAS[r[4]] ?? r[4], j2000: [d[0], d[1], d[2]], mag: r[2], constellation: r[5] ? CONSTELLATIONS[r[5]] ?? null : null, lightYears: r[6] ?? null });
    }
  }
  return { count: n, dirMag, color, named };
}

/** One plain sentence about a star. */
export function starNote(s: NamedStar): string {
  const where = s.constellation ? `, in ${s.constellation}` : '';
  const far = s.lightYears ? ` Its light takes ${s.lightYears < 100 ? s.lightYears : Math.round(s.lightYears).toLocaleString('en-US')} years to get here.` : '';
  const kind = s.mag < 0 ? 'One of the very brightest stars in the whole sky' : s.mag < 1.5 ? 'One of the brightest stars in the sky' : 'A bright star';
  return `${kind}${where}.${far}`;
}

/** The stars that get a name tag: the brightest ones plus the North Star. */
export function taggedStars(cat: StarCatalog, count = 16): NamedStar[] {
  const out = cat.named.slice(0, count);
  const polaris = cat.named.find(s => s.name === 'Polaris');
  if (polaris && !out.includes(polaris)) out.push(polaris);
  return out;
}

const KM = (m: number) => m / 1000;
/** Distances in words a person can picture. */
export function distanceWords(m: number): string {
  const km = KM(m);
  if (km < 1e6) return `${Math.round(km / 100) * 100 > 0 ? (Math.round(km / 100) * 100).toLocaleString('en-US') : Math.round(km)} km`;
  if (km < 1e9) return `${Math.round(km / 1e6).toLocaleString('en-US')} million km`;
  return `${(km / 1e9).toFixed(1)} billion km`;
}

export const PLANET_STYLE: Record<string, { rgb: [number, number, number]; about: string }> = {
  Mercury: { rgb: [224, 212, 196], about: 'The small planet closest to the Sun' },
  Venus: { rgb: [255, 248, 226], about: 'The brightest planet, wrapped in white clouds' },
  Mars: { rgb: [255, 150, 96], about: 'The red planet' },
  Jupiter: { rgb: [255, 236, 208], about: 'The biggest planet' },
  Saturn: { rgb: [246, 226, 170], about: 'The planet with the rings' },
};
