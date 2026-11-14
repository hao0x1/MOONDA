// All English text, one object. Each part of the app owns one file.
import { ai } from './ai';
import { common } from './common';
import { compare } from './compare';
import { hud } from './hud';
import { lander } from './lander';
import { layers } from './layers';
import { markers } from './markers';
import { places } from './places';
import { science } from './science';
import { shell } from './shell';
import { start } from './start';
import { timebar } from './timebar';

export const en = { ...common, ...shell, ...timebar, ...compare, ...ai, ...lander, ...hud, ...markers, ...start, ...layers, ...places, ...science } as const;
