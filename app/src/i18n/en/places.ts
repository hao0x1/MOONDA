// English text for: finding places (the search box, the kinds of named places) and the
// "How to use MOONDA" card. Keys are 'area.name'; {name} marks a value filled in by the code.
//
// The special places themselves (Artemis regions, past landings) keep their English in
// src/data/places.ts; Khmer for them is in ../km/places.ts under 'pl.<id>.short' and 'pl.<id>.detail'.
export const places = {
  'search.placeholder': 'Search the Moon',
  'search.clear': 'Clear search',
  'search.none': 'Nothing on the Moon is called “{q}”. Try a crater name like Tycho or Shackleton.',
  'search.sub.artemis': 'Artemis landing region',
  'search.sub.landing': 'Landing · {date}',

  // the kinds of official names (the words in the IAU list, made plain)
  'kind.Crater': 'Crater',
  'kind.Small crater': 'Small crater',
  'kind.Channel': 'Channel',
  'kind.Landing-site name': 'Landing-site name',
  'kind.Mountain': 'Mountain',
  'kind.Small dark plain': 'Small dark plain',
  'kind.Wrinkle ridge': 'Wrinkle ridge',
  'kind.Crater chain': 'Crater chain',
  'kind.Valley': 'Valley',
  'kind.Bay': 'Bay',
  'kind.Cape': 'Cape',
  'kind.Cliff': 'Cliff',
  'kind.Statio': 'Statio',
  'kind.Dark plain (marsh)': 'Dark plain (marsh)',
  'kind.Ocean': 'Ocean',
  'kind.Bright marking': 'Bright marking',
  'kind.Plain': 'Plain',

  // the "How to use MOONDA" card
  'welcome.title': 'Where should a lander touch down on the Moon?',
  'welcome.lead': 'Near the south pole the Sun stays low, so one hill can block a lander’s sunlight or its view of Earth for days. Explore the Moon like a map and check any spot.',
  'welcome.step.look': 'Look around',
  'welcome.step.look.text': 'Drag to move, scroll to zoom, right-drag to tilt.',
  'welcome.step.click': 'Click a spot',
  'welcome.step.click.text': 'See when it gets sunlight and can see Earth, then stand there.',
  'welcome.step.compare': 'Compare plans',
  'welcome.step.compare.text': 'Line up to four landing plans and see which one works.',
  'welcome.toPole': 'Take me to the south pole',
  'welcome.explore': 'Explore the whole Moon',
  'welcome.sources': 'Where the data comes from',
  'welcome.src.photos': 'Moon photos',
  'welcome.src.heights': 'Heights and hills',
  'welcome.src.names': 'Place names',
  'welcome.src.positions': 'Sun and Earth positions',
  'welcome.src.artemis': 'Artemis regions',
  'welcome.src.engine': '3D map engine',
  'welcome.src.music': 'Music',
  'welcome.fine': 'Sunlight and Earth-view results come from the shape of the ground only. Seeing Earth is needed for direct radio, but it does not prove a working radio link. Not an official NASA product.',
} as const;
