// Khmer text for: lander (same keys as ../en/lander.ts; a missing key shows the English).
import type { lander as en } from '../en/lander';

export const lander: Partial<Record<keyof typeof en, string>> = {
  'lander.gettingReady': 'កំពុងរៀបចំទេសភាព…',
  'lander.sun': 'ព្រះអាទិត្យ',
  'lander.earth': 'ផែនដី',
  'lander.tag.partly': '{name} ភ្នំបាំងមួយផ្នែក',
  'lander.tag.below': '{name} · នៅក្រោមជើងមេឃ',
  'lander.tag.hidden': '{name} · នៅក្រោយភ្នំនោះ',
};
