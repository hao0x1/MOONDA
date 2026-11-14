// Khmer text for: science (same keys as ../en/science.ts; a missing key shows the English).
// Left out on purpose: 'aitool.hours' ("{n} h"), 'aitool.arg.lat' and 'aitool.arg.lon' stay in Latin letters.
// 'aitool.progress.skyline' must not contain numbers (the panel reads "3 of 12" out of progress lines).
import type { science as en } from '../en/science';

export const science: Partial<Record<keyof typeof en, string>> = {
  'skyline.aria': 'ខ្សែជើងមេឃជុំវិញកន្លែងនេះ ជាមួយផ្លូវដើររបស់ព្រះអាទិត្យ និងផែនដី',

  // the example questions on the empty AI panel
  'aitool.try.1': 'រកកន្លែងចុះចតល្អបំផុតជិតរណ្ដៅ Shackleton សម្រាប់បេសកកម្មរបស់ខ្ញុំ',
  'aitool.try.2': 'តំបន់ Artemis មួយណាមានពន្លឺព្រះអាទិត្យ និងទាក់ទងផែនដីបានយូរជាងគេ?',
  'aitool.try.3': 'ថ្មរបស់ខ្ញុំទ្របាន 3 ថ្ងៃ។ នៅជិតប៉ូលខាងត្បូង តើយានចុះចតអាចរស់បានត្រង់ណា?',
  'aitool.try.4': 'ជួយប្រៀបធៀប Malapert Massif និង Connecting Ridge ឱ្យខ្ញុំផង',

  // a tool step: while it runs / once it is done
  'aitool.settings.doing': 'កំពុងអានការកំណត់បេសកកម្មរបស់អ្នក',
  'aitool.settings.done': 'បានអានការកំណត់បេសកកម្មរបស់អ្នក',
  'aitool.list.doing': 'កំពុងរាយកន្លែងជម្រើសរបស់ NASA',
  'aitool.list.done': 'បានរាយកន្លែងជម្រើសរបស់ NASA',
  'aitool.search.doing': 'កំពុងរក «{q}» ក្នុងឈ្មោះលើព្រះច័ន្ទ',
  'aitool.search.done': 'បានរក «{q}» ក្នុងឈ្មោះលើព្រះច័ន្ទ',
  'aitool.check.doing': 'កំពុងពិនិត្យ {name}',
  'aitool.check.done': 'បានពិនិត្យ {name}',
  'aitool.scan.doing': 'កំពុងស្កេន {n} កន្លែងជុំវិញ {name}',
  'aitool.scan.done': 'បានស្កេន {n} កន្លែងជុំវិញ {name}',
  'aitool.show.doing': 'កំពុងបង្ហាញ {name} លើផែនទី',
  'aitool.show.done': 'បានបង្ហាញ {name} លើផែនទី',
  'aitool.add.doing': 'កំពុងបន្ថែម {name} ទៅ «ប្រៀបធៀប»',
  'aitool.add.done': 'បានបន្ថែម {name} ទៅ «ប្រៀបធៀប»',
  'aitool.aSpot': 'កន្លែងមួយ',

  // progress while a tool runs
  'aitool.progress.skyline': 'កំពុងគណនាខ្សែជើងមេឃ ព្រះអាទិត្យ និងផែនដី ពេញមួយបេសកកម្ម…',
  'aitool.progress.spot': 'កន្លែងទី {i} នៃ {n}…',
  'aitool.nOfM': '{i} នៃ {n}',

  // the short line under a finished step
  'aitool.sum.settings': 'ចុះចត {date} · {days} ថ្ងៃ · ថ្ម {battery}',
  'aitool.sum.places': '{n} កន្លែង',
  'aitool.sum.noMatch': 'រកមិនឃើញ',
  'aitool.sum.brief': 'ពន្លឺថ្ងៃ {sun}% · ងងឹតយូរបំផុត {dark} · ផែនដី {earth}%',
  'aitool.sum.scan': '{n} ចំណុច · ល្អបំផុត៖ {brief}',
  'aitool.sum.scanSkipped': '{n} ចំណុច (រំលង {skipped}) · ល្អបំផុត៖ {brief}',
  'aitool.sum.showing': 'កំពុងបង្ហាញ {name}',
  'aitool.pick': 'ជម្រើសរបស់ AI',
  'aitool.err.latlon': 'ត្រូវការរយៈទទឹង និងរយៈបណ្ដោយដែលត្រឹមត្រូវ។',
  'aitool.err.stopped': 'បានបញ្ឈប់។',
  'aitool.err.partial': 'គណនាទាន់ពេលបានតែ {done} ក្នុងចំណោម {all} កន្លែង។',

  // lengths of time
  'aitool.none': 'គ្មាន',
  'aitool.days': '{n} ថ្ងៃ',
  'aitool.daysShort': '{n} ថ្ងៃ',
  'aitool.any': 'ប៉ុន្មានក៏បាន',

  // what went in
  'aitool.arg.radius': 'កាំ',
  'aitool.arg.points': 'ចំណុច',
  'aitool.arg.name': 'ឈ្មោះ',
  'aitool.arg.search': 'ស្វែងរក',
  'aitool.arg.max': 'ច្រើនបំផុត',
  'aitool.arg.days': 'ថ្ងៃ',
  'aitool.arg.arrive': 'មកដល់',
  'aitool.arg.kinds': 'ប្រភេទ',

  // what came back
  'aitool.batteryNeed': 'ថ្ម {time}',
  'aitool.radioNeed': 'វិទ្យុ {time}',
  'aitool.battery': 'ថ្ម',
  'aitool.radio': 'វិទ្យុ',
  'aitool.slope': 'ជម្រាល {deg}°',
  'aitool.permShadow': 'PSR (តំបន់ក្នុងស្រមោលជានិច្ច)',
  'aitool.max': 'ក្ដៅបំផុត {c}°C',
  'aitool.where': 'ទីតាំង',
  'aitool.near': 'ជិត {name}',
  'aitool.ground': 'ដី',
  'aitool.fromPole': '{km} km ពីប៉ូល',
  'aitool.detail': 'កម្រិតលម្អិត',
  'aitool.detail.quick': 'ស្កេនរហ័ស (កម្ពស់លម្អិត 240 m ជិតប៉ូល)',
  'aitool.detail.full': 'ពេញលេញ (កម្ពស់លម្អិត 80 m ជិតប៉ូល)',
  'aitool.detail.coarse': 'គ្រោតគ្រាត (កម្ពស់លម្អិត 240 m)៖ ផែនទីលម្អិតទាញយកមិនទាន់ពេល',
  'aitool.arrive': 'មកដល់',
  'aitool.mission': 'បេសកកម្ម',
  'aitool.missionLine': '{days} ថ្ងៃ · ផ្ទាំងសូឡាខ្ពស់ {m} m',
  'aitool.batteryLasts': 'ទ្រពេលងងឹតបាន {time}',
  'aitool.radioOk': 'ទ្របាន {time} ដោយមិនឃើញផែនដី',
  'aitool.noLimit': 'គ្មានកំណត់',
  'aitool.nothing': 'រកមិនឃើញអ្វីទេ។',
  'aitool.more': '+ {n} ទៀត',
  'aitool.dark': 'ងងឹត',
  'aitool.needs': 'តម្រូវការ',
  'aitool.spots': 'កន្លែង',
  'aitool.best': 'ល្អបំផុត',
};
