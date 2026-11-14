// Numerical checks for the sky maths. Run: node scripts/check-sky.ts
//  1. our J2000 -> Moon rotation reproduces the Sun / Earth vectors of bodyFixedState (same convention)
//  2. star directions in the Moon frame agree with an independent build from Astronomy Engine
//     (north-pole vector from RotationAxis + prime meridian from Libration, a different theory)
//  3. the Earth's orientation: at the "Moon overhead" / "Sun overhead" points our matrix gives,
//     Astronomy Engine's own horizon maths puts the Moon / Sun at the zenith
//  4. planets from the Moon agree with Astronomy Engine's BackdatePosition(observer = Moon)
//  5. what the sky code draws (direction from the camera) equals `bodies`; skyline / hidden-Sun geometry
//  6. speed of the per-update maths
import { Body, BackdatePosition, DefineStar, Equator, GeoMoon, GeoVector, Horizon, Libration, Observer, RotationAxis } from 'astronomy-engine';
import { bodyFixedState, type Vec3 } from '../src/science/ephemeris.ts';
import { AU_M, angleBetweenDeg, bvToRgb, earthFromJ2000, earthToMoonFixed, latLonOf, mat3MulVec, mat3Transpose, moonFromJ2000, planetSky, raDecToUnit } from '../src/science/skyMath.ts';
import { MOON_R, trueToDisplayVec } from '../src/moon/frame.ts';
import { aimFrom, angularRadius, discVisible, skylineElevation, SUN_RADIUS_M } from '../src/moon/sky/geometry.ts';

const DEG = Math.PI / 180;
const DATES = ['2026-11-14T00:00:00Z', '2027-03-21T13:30:00Z', '2028-09-01T06:45:00Z'].map(s => Date.parse(s));
const STARS: [string, number, number][] = [['Sirius', 101.2829, -16.7253], ['Canopus', 95.9882, -52.6955], ['Vega', 279.2365, 38.7858], ['Polaris', 37.9546, 89.2641], ['Acrux', 186.6496, -63.0991], ['Betelgeuse', 88.7931, 7.4071]];
let fail = 0;
const ok = (name: string, value: number, limit: number, unit = 'deg') => {
  const good = value < limit;
  if (!good) fail++;
  console.log(`${good ? 'ok  ' : 'FAIL'} ${name}: ${value.toExponential(2)} ${unit} (limit ${limit})`);
};
const norm = (v: Vec3): Vec3 => { const d = Math.hypot(v[0], v[1], v[2]); return [v[0] / d, v[1] / d, v[2] / d]; };
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---- 1. same convention as bodyFixedState -----------------------------------------------------
let w1 = 0;
for (const t of DATES) {
  const date = new Date(t), M = moonFromJ2000(t), moon = GeoMoon(date), sun = GeoVector(Body.Sun, date, true);
  const s = bodyFixedState(t);
  w1 = Math.max(w1, angleBetweenDeg(mat3MulVec(M, [sun.x - moon.x, sun.y - moon.y, sun.z - moon.z]), s.sun), angleBetweenDeg(mat3MulVec(M, [-moon.x, -moon.y, -moon.z]), s.earth));
  // a rotation: rows are unit length and at right angles
  const r0: Vec3 = [M[0], M[1], M[2]], r1: Vec3 = [M[3], M[4], M[5]], r2: Vec3 = [M[6], M[7], M[8]];
  w1 = Math.max(w1, Math.abs(dot(r0, r1)), Math.abs(dot(r0, r2)), Math.abs(dot(r1, r2)), Math.abs(dot(r0, r0) - 1), Math.abs(dot(cross(r0, r1), r2) - 1));
}
ok('1  Sun/Earth through our matrix vs bodyFixedState (3 dates)', w1, 1e-9);

// ---- 2. stars vs an independent Moon frame from Astronomy Engine -------------------------------
// z = north pole (RotationAxis.north); the prime meridian is set so that the Earth sits at the
// longitude Libration() reports (Meeus' libration theory, independent of the IAU spin angle W).
let w2 = 0, w2lib = 0, w2def = 0;
for (const t of DATES) {
  const date = new Date(t), M = moonFromJ2000(t), ax = RotationAxis(Body.Moon, date), lib = Libration(date), moon = GeoMoon(date);
  const z: Vec3 = [ax.north.x, ax.north.y, ax.north.z];
  const e = norm([-moon.x, -moon.y, -moon.z]);
  const eFlat = norm([e[0] - dot(e, z) * z[0], e[1] - dot(e, z) * z[1], e[2] - dot(e, z) * z[2]]); // Earth direction laid onto the Moon's equator
  const q = cross(z, eFlat); // 90 deg east of it
  const L = lib.elon * DEG;
  const x: Vec3 = [Math.cos(L) * eFlat[0] - Math.sin(L) * q[0], Math.cos(L) * eFlat[1] - Math.sin(L) * q[1], Math.cos(L) * eFlat[2] - Math.sin(L) * q[2]];
  const y = cross(z, x);
  const ours = latLonOf(mat3MulVec(M, e));
  w2lib = Math.max(w2lib, Math.abs(ours.lat - lib.elat), Math.abs(ours.lon - lib.elon));
  for (let i = 0; i < STARS.length; i++) {
    const [name, ra, dec] = STARS[i];
    const j = raDecToUnit(ra, dec);
    const mine = mat3MulVec(M, j), theirs: Vec3 = [dot(j, x), dot(j, y), dot(j, z)];
    const d = angleBetweenDeg(mine, theirs);
    w2 = Math.max(w2, d);
    if (t === DATES[0]) { const ll = latLonOf(mine); console.log(`     ${name.padEnd(10)} over Moon lat ${ll.lat.toFixed(3)} lon ${ll.lon.toFixed(3)}  (independent frame differs by ${d.toFixed(4)} deg)`); }
    // RA/Dec convention: Astronomy Engine's own star vector (RA in hours there)
    DefineStar(Body.Star1, ra / 15, dec, 100000);
    const g = GeoVector(Body.Star1, date, false);
    w2def = Math.max(w2def, angleBetweenDeg(j, [g.x, g.y, g.z]));
  }
}
ok('2a star directions, ours vs Astronomy Engine pole + Libration meridian (6 stars x 3 dates)', w2, 0.05);
ok('2b sub-Earth point, ours vs Libration() elat/elon', w2lib, 0.05);
ok('2c raDecToUnit vs Astronomy Engine DefineStar/GeoVector', w2def, 1e-3);
{ // the Moon's pole is 1.54 deg from the pole of the ecliptic
  const eclPole = raDecToUnit(270, 90 - 23.4393);
  const lat = latLonOf(mat3MulVec(moonFromJ2000(DATES[0]), eclPole)).lat;
  ok('2d ecliptic pole sits 1.54 deg from the Moon\'s north pole (wobbles by a few hundredths)', Math.abs(90 - lat - 1.54), 0.06);
}

// ---- 3. Earth orientation ----------------------------------------------------------------------
let w3 = 0, w3axis = 0;
for (const t of DATES) {
  const date = new Date(t), E = earthFromJ2000(t), moon = GeoMoon(date), sun = GeoVector(Body.Sun, date, true);
  for (const [body, v] of [[Body.Moon, [moon.x, moon.y, moon.z]], [Body.Sun, [sun.x, sun.y, sun.z]]] as [Body, Vec3][]) {
    const sub = latLonOf(mat3MulVec(E, v));
    // "straight overhead" on a map means along the local vertical, so the map latitude equals the body's declination
    const obs = new Observer(sub.lat, sub.lon, 0);
    const eq = Equator(body, date, obs, true, true);
    const alt = Horizon(date, obs, eq.ra, eq.dec).altitude;
    w3 = Math.max(w3, 90 - alt);
    if (t === DATES[0]) console.log(`     ${body} straight overhead at Earth lat ${sub.lat.toFixed(3)} lon ${sub.lon.toFixed(3)} -> Astronomy Engine altitude there ${alt.toFixed(4)} deg`);
  }
  const ax = RotationAxis(Body.Earth, date);
  w3axis = Math.max(w3axis, angleBetweenDeg([E[6], E[7], E[8]], [ax.north.x, ax.north.y, ax.north.z]));
  // Earth-fixed -> Moon-fixed must send the Earth's "Moon overhead" direction to minus the Moon's "Earth overhead" direction
  const EM = earthToMoonFixed(t);
  const a = mat3MulVec(EM, norm(mat3MulVec(E, [moon.x, moon.y, moon.z])));
  w3axis = Math.max(w3axis, angleBetweenDeg(a, norm(bodyFixedState(t).earth).map(c => -c) as Vec3));
}
ok('3a Moon/Sun at the zenith of the overhead points our Earth matrix gives', w3, 0.02);
ok('3b Earth axis vs RotationAxis(Earth).north; Earth->Moon matrix consistency', w3axis, 0.01);

// ---- 4. planets --------------------------------------------------------------------------------
let w4 = 0;
for (const t of DATES) {
  const date = new Date(t);
  for (const p of planetSky(t)) {
    const b = BackdatePosition(date, Body.Moon, Body[p.name], false);
    w4 = Math.max(w4, angleBetweenDeg(p.j2000, [b.x, b.y, b.z]));
    const g = GeoVector(Body[p.name], date, true);
    if (t === DATES[0]) console.log(`     ${p.name.padEnd(8)} mag ${p.mag.toFixed(1).padStart(5)}  ${(p.distM / AU_M).toFixed(3)} AU  shift Moon-vs-Earth view ${angleBetweenDeg(p.j2000, [g.x, g.y, g.z]).toFixed(3)} deg`);
  }
}
ok('4  planets seen from the Moon vs BackdatePosition(Moon, planet) (aberration is the 0.006 deg difference)', w4, 0.01);

// ---- 5. what is drawn ----------------------------------------------------------------------------
let w5 = 0;
const out: Vec3 = [0, 0, 0];
for (const t of DATES) {
  const s = bodyFixedState(t);
  for (const b of [s.sun, s.earth]) {
    aimFrom(trueToDisplayVec(b), [0, 0, 0], out);
    w5 = Math.max(w5, angleBetweenDeg(out, trueToDisplayVec(b)));
  }
  // and the star route: Sun as a "star" through the J2000 matrix, then to the display frame
  const date = new Date(t), moon = GeoMoon(date), sun = GeoVector(Body.Sun, date, true);
  const viaStars = trueToDisplayVec(mat3MulVec(moonFromJ2000(t), [sun.x - moon.x, sun.y - moon.y, sun.z - moon.z]));
  aimFrom(trueToDisplayVec(s.sun), [0, 0, 0], out);
  w5 = Math.max(w5, angleBetweenDeg(out, viaStars));
}
ok('5a drawn Sun/Earth directions (camera at the Moon\'s centre) vs bodies', w5, 0.01);
{
  // Earth parallax from a camera 25,000 km out, at right angles to the Earth direction
  const s = bodyFixedState(DATES[0]), e = trueToDisplayVec(s.earth), eh = norm(e);
  const side = norm(cross(eh, [0, 0, 1]));
  const d = aimFrom(e, [side[0] * 2.5e7, side[1] * 2.5e7, side[2] * 2.5e7], out);
  console.log(`     Earth from a camera 25,000 km to the side: direction shifts ${angleBetweenDeg(out, eh).toFixed(3)} deg, looks ${(2 * angularRadius(6371e3, d) / DEG).toFixed(3)} deg wide`);
  // smooth ball: a disc exactly on the skyline is half hidden; one radius above is clear; one below is gone
  const cam: Vec3 = [MOON_R + 2_000_000, 0, 0], rho = angularRadius(SUN_RADIUS_M, 1.5e11), dip = -Math.acos(MOON_R / (MOON_R + 2_000_000));
  const at = (el: number): Vec3 => [Math.sin(el), Math.cos(el), 0];
  const half = discVisible(cam, at(dip), rho, null), clear = discVisible(cam, at(dip + rho * 1.01), rho, null), gone = discVisible(cam, at(dip - rho * 1.01), rho, null);
  ok('5b hidden-Sun maths on a smooth ball (half / clear / gone)', Math.max(Math.abs(half - 0.5), 1 - clear, gone), 1e-3, '');
  // flat ground function at +3 km: skyline from 100 m above it = dip of a ball of that radius; and the strip method agrees with the formula
  const flat = () => 3000, camLow: Vec3 = [MOON_R + 3100, 0, 0];
  const sky = skylineElevation(camLow, 0, 1, 0, flat), want = -Math.acos((MOON_R + 3000) / (MOON_R + 3100));
  ok('5c skyline over level ground vs the exact dip angle', Math.abs(sky - want) / DEG, 0.01);
  const strips = discVisible(camLow, at(want + 0.3 * rho), rho, flat);
  const x = 0.3, exact = 0.5 + (x * Math.sqrt(1 - x * x) + Math.asin(x)) / Math.PI;
  ok('5d visible part of a disc 0.3 radii above the skyline, strips vs formula', Math.abs(strips - exact), 0.03, '');
  // a 4 km wall 30 km away hides a Sun 3 deg up, but not one 12 deg up
  const wall: (ux: number, uy: number, uz: number) => number = (ux, uy) => { const th = Math.atan2(uy, ux) * MOON_R; return th > 29_000 && th < 31_000 ? 4000 : 0; };
  const camG: Vec3 = [MOON_R + 2, 0, 0];
  ok('5e a 4 km wall 30 km away hides a Sun 3 deg up, not one 12 deg up', discVisible(camG, at(3 * DEG), rho, wall) + (1 - discVisible(camG, at(12 * DEG), rho, wall)), 1e-6, '');
}

// ---- 6. speed -----------------------------------------------------------------------------------
{
  const M = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let t0 = performance.now();
  for (let i = 0; i < 2000; i++) { moonFromJ2000(DATES[0] + i * 60000, M); earthToMoonFixed(DATES[0] + i * 60000, M); }
  const rot = (performance.now() - t0) / 2000;
  t0 = performance.now();
  for (let i = 0; i < 200; i++) planetSky(DATES[0] + i * 600000);
  const pl = (performance.now() - t0) / 200;
  const bumpy: (ux: number, uy: number, uz: number) => number = (ux, uy, uz) => 2000 * Math.sin(ux * 900) * Math.cos(uy * 700 + uz * 300);
  const cam: Vec3 = [MOON_R + 2100, 0, 0], rho = 0.00465;
  t0 = performance.now();
  for (let i = 0; i < 200; i++) discVisible(cam, [Math.sin(0.01), Math.cos(0.01) * Math.cos(i * 0.01), Math.cos(0.01) * Math.sin(i * 0.01)], rho, bumpy);
  const dv = (performance.now() - t0) / 200;
  console.log(`     per call: Moon + Earth rotation ${(rot * 1000).toFixed(1)} us, five planets ${(pl * 1000).toFixed(0)} us, hidden-Sun test on rough ground ${(dv * 1000).toFixed(0)} us`);
  const c = bvToRgb(1.5), b = bvToRgb(-0.03), sunc = bvToRgb(0.65);
  console.log(`     star colours: Betelgeuse ${c.map(v => v.toFixed(2))}  Rigel ${b.map(v => v.toFixed(2))}  Sun-like ${sunc.map(v => v.toFixed(2))}`);
  void mat3Transpose;
}
console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nall sky checks passed');
process.exit(fail ? 1 : 0);
