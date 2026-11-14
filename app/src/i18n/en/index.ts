// All English text, one object. Each part of the app owns one file.
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

export const en = { ...common, ...shell, ...timebar, ...compare, ...ai, ...lander, ...hud, ...markers, ...start, ...layers, ...places, ...science, ...explore, ...tutorial, ...route } as const;
