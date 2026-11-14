// Hand-checked list of special places: NASA's Artemis candidate landing regions and past missions.
// Positions of Artemis regions are APPROXIMATE example points inside each region (NASA publishes
// the regions as outlines on a map, not as single coordinates). Mission positions are the published
// landing / impact points rounded to about 0.01°.

export type PlaceKind = 'artemis' | 'mission' | 'spot';

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
}

const ARTEMIS_SRC = { name: 'NASA, "NASA Provides Update on Artemis III Moon Landing Regions" (Oct 2024)', url: 'https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/' };

const artemis = (id: string, name: string, lat: number, lon: number, detail: string): Place => ({
  id, kind: 'artemis', name, lat, lon,
  short: 'NASA candidate region for the first crewed south-pole landing',
  detail: `${detail} The marker is an approximate point inside the region; NASA's region is an area several kilometres across.`,
  source: ARTEMIS_SRC,
});

const LOLA_SRC = { name: 'Mazarico et al. 2011, "Illumination conditions of the lunar polar regions using LOLA topography", Icarus 211', url: 'https://doi.org/10.1016/j.icarus.2010.10.030' };

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

  { id: 'm-chandrayaan3', kind: 'mission', name: 'Chandrayaan-3 (Vikram)', lat: -69.37, lon: 32.32, date: '23 Aug 2023',
    short: 'First landing near the south polar region (India, ISRO)', detail: 'India\'s Vikram lander and Pragyan rover landed at the place ISRO named "Shiv Shakti point". It is about 600 km from the pole, outside the core polar region.',
    source: { name: 'ISRO Chandrayaan-3', url: 'https://www.isro.gov.in/Chandrayaan3_Details.html' } },
  { id: 'm-im1', kind: 'mission', name: 'IM-1 Odysseus', lat: -80.13, lon: 1.44, date: '22 Feb 2024',
    short: 'First US landing since Apollo (Intuitive Machines)', detail: 'Odysseus landed near Malapert A crater and tipped onto its side, but still sent back data.',
    source: { name: 'NASA CLPS IM-1', url: 'https://www.nasa.gov/mission/im-1/' } },
  { id: 'm-im2', kind: 'mission', name: 'IM-2 Athena', lat: -84.81, lon: 29.20, date: '6 Mar 2025',
    short: 'Closest landing to the south pole so far (Intuitive Machines)', detail: 'Athena landed on Mons Mouton but ended up on its side inside a small crater, which cut its power from the solar panels — a real example of why terrain and sunlight matter.',
    source: { name: 'NASA CLPS IM-2', url: 'https://www.nasa.gov/mission/im-2/' } },
  { id: 'm-lcross', kind: 'mission', name: 'LCROSS impact', lat: -84.68, lon: -48.69, date: '9 Oct 2009',
    short: 'NASA crashed a rocket stage here and found water ice', detail: 'LCROSS hit the permanently shadowed floor of Cabeus crater; the spray of debris contained water ice.',
    source: { name: 'NASA LCROSS', url: 'https://science.nasa.gov/mission/lcross/' } },
  { id: 'm-change4', kind: 'mission', name: "Chang'e-4", lat: -45.44, lon: 177.59, date: '3 Jan 2019',
    short: 'First soft landing on the far side (China, CNSA)', detail: 'Landed in Von Kármán crater. Earth is never visible from the far side, so it talked to Earth through a relay satellite.',
    source: { name: 'CNSA', url: 'https://www.cnsa.gov.cn/english/' } },
  { id: 'm-change6', kind: 'mission', name: "Chang'e-6", lat: -41.64, lon: -153.99, date: '1 Jun 2024',
    short: 'First samples from the far side (China, CNSA)', detail: 'Collected rock and soil from the Apollo basin and returned it to Earth.',
    source: { name: 'CNSA', url: 'https://www.cnsa.gov.cn/english/' } },
  { id: 'm-slim', kind: 'mission', name: 'SLIM', lat: -13.32, lon: 25.25, date: '19 Jan 2024',
    short: "Japan's precision lander (JAXA)", detail: 'Landed within about 100 m of its target near Shioli crater, upside down.',
    source: { name: 'JAXA SLIM', url: 'https://www.isas.jaxa.jp/en/missions/spacecraft/current/slim.html' } },
  { id: 'm-blueghost', kind: 'mission', name: 'Blue Ghost 1', lat: 18.56, lon: 61.81, date: '2 Mar 2025',
    short: 'Firefly Aerospace lander in Mare Crisium', detail: 'Landed upright and worked through a full lunar day.',
    source: { name: 'NASA CLPS', url: 'https://www.nasa.gov/commercial-lunar-payload-services/' } },
  { id: 'm-apollo11', kind: 'mission', name: 'Apollo 11', lat: 0.67, lon: 23.47, date: '20 Jul 1969',
    short: 'First humans on the Moon', detail: 'Neil Armstrong and Buzz Aldrin landed in the Sea of Tranquility.',
    source: { name: 'NASA Apollo 11', url: 'https://www.nasa.gov/mission/apollo-11/' } },
  { id: 'm-apollo12', kind: 'mission', name: 'Apollo 12', lat: -3.01, lon: -23.42, date: '19 Nov 1969',
    short: 'Second crewed landing', detail: 'Landed next to the Surveyor 3 robot lander in the Ocean of Storms.',
    source: { name: 'NASA Apollo 12', url: 'https://www.nasa.gov/mission/apollo-12/' } },
  { id: 'm-apollo14', kind: 'mission', name: 'Apollo 14', lat: -3.65, lon: -17.47, date: '5 Feb 1971',
    short: 'Third crewed landing', detail: 'Landed in the Fra Mauro highlands.', source: { name: 'NASA Apollo 14', url: 'https://www.nasa.gov/mission/apollo-14/' } },
  { id: 'm-apollo15', kind: 'mission', name: 'Apollo 15', lat: 26.13, lon: 3.63, date: '30 Jul 1971',
    short: 'First lunar rover drive', detail: 'Landed between the Apennine mountains and Hadley Rille.', source: { name: 'NASA Apollo 15', url: 'https://www.nasa.gov/mission/apollo-15/' } },
  { id: 'm-apollo16', kind: 'mission', name: 'Apollo 16', lat: -8.97, lon: 15.50, date: '21 Apr 1972',
    short: 'Landing in the highlands', detail: 'Explored the Descartes highlands.', source: { name: 'NASA Apollo 16', url: 'https://www.nasa.gov/mission/apollo-16/' } },
  { id: 'm-apollo17', kind: 'mission', name: 'Apollo 17', lat: 20.19, lon: 30.77, date: '11 Dec 1972',
    short: 'Last crewed landing so far', detail: 'Explored the Taurus-Littrow valley.', source: { name: 'NASA Apollo 17', url: 'https://www.nasa.gov/mission/apollo-17/' } },
];
