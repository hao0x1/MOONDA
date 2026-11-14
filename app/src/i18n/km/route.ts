// Khmer twins of every overview route string.
import type { route as en } from '../en/route';

export const route: Record<keyof typeof en, string> = {
  'route.title': 'ផ្លូវ',
  'route.button': 'រៀបផ្លូវចេញពីកន្លែងនេះ',
  'route.pickFirst': 'ជ្រើសកន្លែងមួយជាមុនសិន',
  'route.hint': 'ចុចលើព្រះច័ន្ទត្រង់កន្លែងដែលអ្នកចង់ទៅ',
  'route.working': 'កំពុងរកផ្លូវ',
  'route.unsafe': 'គ្មានផ្លូវសុវត្ថិភាពទៅទីនោះទេ',
  'route.reason.far': 'ចំណុចទាំងពីរឆ្ងាយគ្នាពេកសម្រាប់ការបើកមួយលើក',
  'route.reason.blocked': 'ដីចោតពេក',
  'route.reason.same': 'ចំណុចចាប់ផ្ដើម និងចំណុចបញ្ចប់នៅកន្លែងតែមួយ',
  'route.reason.error': 'មិនអាចគណនាផ្លូវនេះបានទេ។ សូមសាកម្ដងទៀត',
  'route.distance': 'ចម្ងាយ',
  'route.drivingTime': 'ពេលបើកបរ',
  'route.steepest': 'ជម្រាលចោតបំផុត',
  'route.slopeValue': 'ចោតបំផុត {n}°',
  'route.prefer': 'ប្រភេទផ្លូវ',
  'route.prefer.fastest': 'លឿនបំផុត',
  'route.prefer.gentle': 'ជម្រាលតិច',
  'route.prefer.sun': 'មានពន្លឺថ្ងៃ',
  'route.prefer.earth': 'ឃើញផែនដី',
  'route.clear': 'លុបផ្លូវ',
  'route.metres': '{n} m',
  'route.kilometres': '{n} km',
  'route.minutes': '{n} នាទី',
  'route.hoursMinutes': '{h} ម៉ោង {m} នាទី',
};
