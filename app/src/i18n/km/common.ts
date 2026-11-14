// Khmer text for: common (same keys as ../en/common.ts; a missing key shows the English).
//
// Glossary — every Khmer file uses these words, so the app speaks with one voice:
//   Moon ព្រះច័ន្ទ · Sun ព្រះអាទិត្យ · Earth ផែនដី · sky មេឃ · star ផ្កាយ · planet ភព
//   sunlight ពន្លឺព្រះអាទិត្យ (in tight labels: ពន្លឺថ្ងៃ) · shadow ស្រមោល · night យប់ · dark ងងឹត
//   lander យានចុះចត (short: យាន) · landing spot កន្លែងចុះចត · spot កន្លែង · mission បេសកកម្ម · plan ផែនការ
//   solar panel ផ្ទាំងសូឡា · solar power ថាមពលសូឡា · battery ថ្ម · antenna អង់តែន
//   radio វិទ្យុ · direct radio វិទ្យុផ្ទាល់ទៅផែនដី · relay satellite ផ្កាយរណបបញ្ជូនបន្ត
//   crater រណ្ដៅ · hill / mountain ភ្នំ · small bump ទួល · rock ដុំថ្ម · ground ដី · slope ជម្រាល · height កម្ពស់
//   south pole ប៉ូលខាងត្បូង · horizon ជើងមេឃ · skyline ខ្សែជើងមេឃ
//   near side ផ្នែកដែលបែរមកផែនដី · far side ផ្នែកម្ខាងទៀតនៃព្រះច័ន្ទ
//   map ផែនទី · layers ស្រទាប់ · compare ប្រៀបធៀប · time bar របារពេលវេលា · graphics ក្រាហ្វិក · music តន្ត្រី
//   click ចុច · drag អូស · scroll រមូរ · zoom in ពង្រីក · zoom out បង្រួម · tilt ផ្អៀង · work out គណនា
//   ice ទឹកកក · temperature សីតុណ្ហភាព · data ទិន្នន័យ · photo រូបថត · coordinates កូអរដោនេ
// Kept in Latin letters: MOONDA, NASA, UTC, Artemis, AI, LOLA, LRO, IAU, USGS, N/S/E/W, units (km, m, h, %, °C),
// official Moon names, mission names, sources and credits. Digits are always 0-9.
import type { common as en } from '../en/common';

export const common: Partial<Record<keyof typeof en, string>> = {
  'common.close': 'បិទ',
  'common.sun': 'ព្រះអាទិត្យ',
  'common.earth': 'ផែនដី',
  'common.none': 'គ្មាន',

  'search.tip': 'ស្វែងរកកន្លែងមានឈ្មោះ ឬកន្លែងចុះចតនៅលើព្រះច័ន្ទ',
  'search.result.tip': 'បង្ហាញ {name} លើផែនទី (Enter)',

  'unit.day.other': 'ថ្ងៃ',

  'time.inCambodia': '{time} នៅកម្ពុជា',
  'time.dayOf': 'ថ្ងៃទី {day} នៃ {days}',
  'time.landing': 'ចុះចត',
  'time.dayN': 'ថ្ងៃទី {n}',

  'body.working': 'កំពុងគណនា…',
  'sun.lit': 'មានពន្លឺព្រះអាទិត្យ',
  'sun.lit.low': 'ព្រះអាទិត្យនៅទាបៗលើកំពូលភ្នំ ផ្ទាំងសូឡាដំណើរការ',
  'sun.lit.clear': 'ព្រះអាទិត្យខ្ពស់ផុតពីភ្នំ ផ្ទាំងសូឡាដំណើរការ',
  'sun.lit.low.text': 'ព្រះអាទិត្យនៅទាបៗលើកំពូលភ្នំ — ផ្ទាំងសូឡាផលិតភ្លើងបាន។',
  'sun.lit.clear.text': 'ព្រះអាទិត្យខ្ពស់ផុតពីភ្នំ — ផ្ទាំងសូឡាផលិតភ្លើងបាន។',
  'sun.partly': 'មានពន្លឺខ្លះ',
  'sun.partly.why': 'ភ្នំបាំងព្រះអាទិត្យមួយផ្នែក (នៅឃើញ {pct}%)',
  'sun.partly.text': 'ភ្នំបាំងព្រះអាទិត្យមួយផ្នែក (នៅឃើញ {pct}%)។',
  'sun.shadow': 'នៅក្នុងស្រមោល',
  'sun.shadow.why': 'ភ្នំបាំងព្រះអាទិត្យ គ្មានថាមពលសូឡា',
  'sun.shadow.text': 'ព្រះអាទិត្យរះហើយ តែមានភ្នំបាំង។ គ្មានថាមពលសូឡាទេ។',
  'sun.night': 'យប់',
  'sun.word.lit': 'មានពន្លឺ',
  'earth.word.view': 'មើលឃើញ',
  'earth.word.hill': 'ភ្នំបាំង',
  'earth.word.down': 'នៅក្រោមជើងមេឃ',
  'earth.word.never': 'មិនដែលឃើញ',
  'sun.night.why': 'ព្រះអាទិត្យនៅក្រោមជើងមេឃ គ្មានថាមពលសូឡា',
  'sun.night.text': 'ព្រះអាទិត្យនៅក្រោមជើងមេឃ។ គ្មានថាមពលសូឡាទេ។',
  'earth.view': 'មើលឃើញផែនដី',
  'earth.view.why': 'បញ្ជូនវិទ្យុត្រង់ទៅផែនដីបាន',
  'earth.view.text': 'យានចុះចតអាចបញ្ជូនវិទ្យុត្រង់ទៅផែនដីបាន។',
  'earth.never': 'មិនដែលឃើញផែនដី',
  'earth.never.why': 'ផ្នែកម្ខាងទៀតនៃព្រះច័ន្ទ ត្រូវការផ្កាយរណបបញ្ជូនបន្ត',
  'earth.never.text': 'ទីនេះជាផ្នែកម្ខាងទៀតនៃព្រះច័ន្ទ។ ត្រូវមានផ្កាយរណបបញ្ជូនបន្ត ទើបទាក់ទងផែនដីបាន។',
  'earth.hidden': 'ផែនដីត្រូវបាំង',
  'earth.hidden.why': 'មានភ្នំបាំង គ្មានវិទ្យុផ្ទាល់ទៅផែនដី',
  'earth.hidden.text': 'ផែនដីនៅលើជើងមេឃ តែមានភ្នំបាំង។ គ្មានវិទ្យុផ្ទាល់ទៅផែនដីទេ។',
  'earth.down': 'ផែនដីលិចបាត់',
  'earth.down.why': 'នៅក្រោមជើងមេឃ គ្មានវិទ្យុផ្ទាល់ទៅផែនដី',
  'earth.down.text': 'ផែនដីបានលិចទៅក្រោមជើងមេឃ។ គ្មានវិទ្យុផ្ទាល់ទៅផែនដីទេ។',

  // used after ទិស ("facing ទិសខាងជើង")
  'compass.n': 'ខាងជើង', 'compass.ne': 'ឦសាន', 'compass.e': 'ខាងកើត', 'compass.se': 'អាគ្នេយ៍',
  'compass.s': 'ខាងត្បូង', 'compass.sw': 'និរតី', 'compass.w': 'ខាងលិច', 'compass.nw': 'ពាយ័ព្យ',
};
