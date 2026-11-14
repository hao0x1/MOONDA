// English text for: the skyline chart, and what the AI helper's tools say while they work
// ('aitool.' keys: step titles, the short result lines and the small result tables).
// Keys are 'area.name'; {name} marks a value filled in by the code.
export const science = {
  'skyline.aria': 'Skyline around this spot with the paths of the Sun and Earth',

  // the example questions on the empty AI panel (wired in AiPanel with tMaybe(`aitool.try.${i + 1}`, english))
  'aitool.try.1': 'Find the best landing spot near Shackleton crater for my mission',
  'aitool.try.2': 'Which Artemis region keeps sunlight and Earth contact the longest?',
  'aitool.try.3': 'My battery lasts 3 days. Where near the south pole can the lander survive?',
  'aitool.try.4': 'Compare Malapert Massif and the Connecting Ridge for me',

  // a tool step: while it runs / once it is done
  'aitool.settings.doing': 'Reading your mission settings',
  'aitool.settings.done': 'Read your mission settings',
  'aitool.list.doing': 'Listing NASA candidate sites',
  'aitool.list.done': 'Listed NASA candidate sites',
  'aitool.search.doing': 'Searching Moon names for “{q}”',
  'aitool.search.done': 'Searched Moon names for “{q}”',
  'aitool.check.doing': 'Checking {name}',
  'aitool.check.done': 'Checked {name}',
  'aitool.scan.doing': 'Scanning {n} spots around {name}',
  'aitool.scan.done': 'Scanned {n} spots around {name}',
  'aitool.show.doing': 'Showing {name} on the map',
  'aitool.show.done': 'Showed {name} on the map',
  'aitool.add.doing': 'Adding {name} to Compare',
  'aitool.add.done': 'Added {name} to Compare',
  'aitool.aSpot': 'a spot',

  // progress while a tool runs
  'aitool.progress.skyline': 'working out the skyline and the Sun and Earth over the mission…',
  'aitool.progress.spot': 'spot {i} of {n}…',
  'aitool.nOfM': '{i} of {n}',

  // the short line under a finished step
  'aitool.sum.settings': 'Lands {date} · {days} days · battery {battery}',
  'aitool.sum.places': '{n} places',
  'aitool.sum.noMatch': 'no match',
  'aitool.sum.brief': 'Sun {sun}% · longest dark {dark} · Earth {earth}%',
  'aitool.sum.scan': '{n} points · best: {brief}',
  'aitool.sum.scanSkipped': '{n} points ({skipped} skipped) · best: {brief}',
  'aitool.sum.showing': 'Showing {name}',
  'aitool.pick': 'AI pick',
  'aitool.err.latlon': 'Need a valid latitude and longitude.',
  'aitool.err.stopped': 'Stopped.',
  'aitool.err.partial': 'Only {done} of {all} spots could be calculated in time.',

  // lengths of time
  'aitool.none': 'none',
  'aitool.hours': '{n} h',
  'aitool.days': '{n} days',
  'aitool.daysShort': '{n} d',
  'aitool.any': 'any',

  // what went in
  'aitool.arg.lat': 'lat',
  'aitool.arg.lon': 'lon',
  'aitool.arg.radius': 'radius',
  'aitool.arg.points': 'points',
  'aitool.arg.name': 'name',
  'aitool.arg.search': 'search',
  'aitool.arg.max': 'max',
  'aitool.arg.days': 'days',
  'aitool.arg.arrive': 'arrive',
  'aitool.arg.kinds': 'kinds',

  // what came back
  'aitool.batteryNeed': 'battery {time}',
  'aitool.radioNeed': 'radio {time}',
  'aitool.battery': 'Battery',
  'aitool.radio': 'Radio',
  'aitool.slope': 'Slope {deg}°',
  'aitool.permShadow': 'PSR (permanently shadowed region)',
  'aitool.max': 'Max {c}°C',
  'aitool.where': 'Where',
  'aitool.near': 'near {name}',
  'aitool.ground': 'Ground',
  'aitool.fromPole': '{km} km from the pole',
  'aitool.detail': 'Detail',
  'aitool.detail.quick': 'quick scan (240 m heights near the pole)',
  'aitool.detail.full': 'full (80 m heights near the pole)',
  'aitool.detail.coarse': 'coarse (240 m heights): the detailed map did not download in time',
  'aitool.arrive': 'Arrive',
  'aitool.mission': 'Mission',
  'aitool.missionLine': '{days} days · panels {m} m up',
  'aitool.batteryLasts': 'lasts {time} of darkness',
  'aitool.radioOk': 'OK {time} without Earth',
  'aitool.noLimit': 'no limit',
  'aitool.nothing': 'Nothing found.',
  'aitool.more': '+ {n} more',
  'aitool.dark': 'dark',
  'aitool.needs': 'needs',
  'aitool.spots': 'spots',
  'aitool.best': 'best',
} as const;
