// Round-trip and orientation checks for the display frame. Run: node scripts/check-frame.ts
import { displayToTrueLatLon, toCartesian, toTrueLatLon, trueToDisplayLatLon, azimuthOf, directionFor, polarMapFromDisplayUnit } from '../src/moon/frame.ts';
import { toMap } from '../src/science/heights.ts';
let worst = 0;
for (let i = 0; i < 2000; i++) {
  const lat = -90 + 180 * ((i * 0.618) % 1), lon = -180 + 360 * ((i * 0.377) % 1);
  const c = toCartesian(lat, lon, 123);
  const back = toTrueLatLon(c);
  const d = trueToDisplayLatLon(lat, lon); const t2 = displayToTrueLatLon(d.lat, d.lon);
  const dlon = Math.abs(((back.lon - lon + 540) % 360) - 180) * Math.cos(lat * Math.PI / 180);
  const dlon2 = Math.abs(((t2.lon - lon + 540) % 360) - 180) * Math.cos(lat * Math.PI / 180);
  worst = Math.max(worst, Math.abs(back.lat - lat), dlon, Math.abs(back.height - 123) / 1000, Math.abs(t2.lat - lat), dlon2);
  const az = (i * 7.3) % 360, el = ((i * 3.1) % 60) - 20;
  const dir = directionFor(az, el, lat, lon);
  if (Math.abs(lat) < 89.9) worst = Math.max(worst, Math.abs(((azimuthOf(dir, lat, lon) - az + 540) % 360) - 180) * Math.cos(el * Math.PI / 180));
  if (lat < -80) { const u = toCartesian(lat, lon, 0); const r = Math.hypot(u.x, u.y, u.z); const [mx, my] = polarMapFromDisplayUnit(u.x / r, u.y / r, u.z / r); const [ex, ey] = toMap(lat, lon); worst = Math.max(worst, Math.hypot(mx - ex, my - ey) / 1000); }
}
const sp = trueToDisplayLatLon(-90, 0), np = trueToDisplayLatLon(90, 0);
console.log('south pole -> display', (sp.lat * 180 / Math.PI).toFixed(3), (sp.lon * 180 / Math.PI).toFixed(3), '| north pole ->', (np.lat * 180 / Math.PI).toFixed(3), (np.lon * 180 / Math.PI).toFixed(3));
console.log('worst round-trip error (deg / km):', worst.toExponential(2), worst < 1e-6 ? 'OK' : 'FAIL');
