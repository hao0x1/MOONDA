// Compare our Sun/Earth directions with NASA/JPL Horizons (airless, apparent az/el)
// for a site at 89°S, 0°E on 14-15 Nov 2026. Run: node scripts/check-ephemeris.ts
import { readFileSync } from 'node:fs';
import { azEl, bodyFixedState, localFrame } from '../src/science/ephemeris.ts';

const dir = '/Volumes/CodexWork/Projects/MOONDA/data-raw/source/geometry/';
function rows(file: string) {
  const txt = readFileSync(dir + file, 'utf8');
  const body = txt.split('$$SOE')[1].split('$$EOE')[0].trim().split('\n');
  return body.map(l => { const p = l.split(','); return { t: Date.parse(p[0].trim().replace(/(\d{4})-(\w{3})-(\d{2}) (\d{2}:\d{2})/, '$2 $3 $1 $4 UTC')), az: +p[3], el: +p[4] }; });
}
const site = localFrame({ lat: -89, lon: 0, heightM: 0 });
let worst = 0;
for (const [file, key] of [['sun-response.txt', 'sun'], ['earth-response.txt', 'earth']] as const) {
  for (const r of rows(file)) {
    const s = bodyFixedState(r.t);
    const a = azEl(site, s[key]);
    const dAz = ((a.az - r.az + 540) % 360) - 180, dEl = a.el - r.el;
    worst = Math.max(worst, Math.abs(dEl), Math.abs(dAz) * Math.cos(r.el * Math.PI / 180));
    console.log(key.padEnd(5), new Date(r.t).toISOString().slice(0, 16), 'horizons', r.az.toFixed(3), r.el.toFixed(3), ' ours', a.az.toFixed(3), a.el.toFixed(3), ' d', dAz.toFixed(3), dEl.toFixed(3));
  }
}
console.log('worst angular difference (deg):', worst.toFixed(4));
