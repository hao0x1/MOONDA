// Things the drive features share with the map without going through React: the height maps (one copy, owned by
// MoonMap) and the list of official names (loaded once by the app).

import type { MoonName } from '../data/names';
import type { MoonHeights } from '../science/heights';

let heights: MoonHeights | null = null;
let names: MoonName[] | null = null;

export function setExploreHeights(h: MoonHeights) { heights = h; }
/** The page's height maps (NASA LOLA), or null before the map exists. */
export function exploreHeights(): MoonHeights | null { return heights; }

export function setExploreNames(n: MoonName[] | null) { names = n; }
export function exploreNames(): MoonName[] | null { return names; }
