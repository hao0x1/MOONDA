// All Khmer text, one object (same keys as English; anything missing falls back to English).
import { ai } from './ai';
import { common } from './common';
import { compare } from './compare';
import { explore } from './explore';
import { hud } from './hud';
import { lander } from './lander';
import { layers } from './layers';
import { markers } from './markers';
import { places } from './places';
import { route } from './route';
import { science } from './science';
import { shell } from './shell';
import { start } from './start';
import { timebar } from './timebar';
import { tutorial } from './tutorial';

export const km: Partial<Record<string, string>> = { ...common, ...shell, ...timebar, ...compare, ...ai, ...lander, ...hud, ...markers, ...start, ...layers, ...places, ...science, ...explore, ...tutorial, ...route };
