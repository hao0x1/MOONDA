// Khmer text for: markers (same keys as ../en/markers.ts; a missing key shows the English).
import type { markers as en } from '../en/markers';

export const markers: Partial<Record<keyof typeof en, string>> = {
  'markers.sun': 'ព្រះអាទិត្យ',
  'markers.earth': 'ផែនដី',
  'markers.behind': '{name} · នៅក្រោយព្រះច័ន្ទ',
  'markers.showSun': 'បង្ហាញព្រះអាទិត្យ',
  'markers.showEarth': 'បង្ហាញផែនដី',
  'markers.sunOverhead': 'ព្រះអាទិត្យចំពីលើ',
  'markers.earthOverhead': 'ផែនដីចំពីលើ',
};
