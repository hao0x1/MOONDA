// Lander-view test helper: builds a scripts/drive.mjs scenario from short steps and runs it.
//   node scripts/lander-drive.mjs <run-name> '<json list of steps>' [--port 5204] [--width 1440 --height 900] [--query '?ownBodies=0']
// Extra steps on top of drive.mjs:
//   {"do":"stand","lat":-89.79,"lon":-154.3}        select the spot and enter the lander view, wait until it is shown
//   {"do":"waitOn"}                                  wait until the lander view is fully shown
//   {"do":"waitOff"}                                 wait until the map is fully back
//   {"do":"time","ms":1795572000000} | {"do":"time","lit":true|false}   set the time bar (lit: first time the Sun is in view / hidden)
//   {"do":"face","az":120,"el":0}                    turn the camera at once (no animation)
//   {"do":"roll","name":"r1"}                        measure camera roll (degrees) and heading
//   {"do":"skyline","name":"s1","step":5}            compare the drawn hill edge with the calculated skyline, all round
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const run = args[0], steps = JSON.parse(args[1]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'shots', run);
mkdirSync(out, { recursive: true });

const WAIT = (cond, timeout = 20000) => `new Promise(r => { const t0 = performance.now(); const iv = setInterval(() => { const L = window.__moonda?.lander; const ok = L && (${cond}); if (ok || performance.now() - t0 > ${timeout}) { clearInterval(iv); r({ ok: !!ok, waitedMs: Math.round(performance.now() - t0), phase: L?.phase, stats: { ...L?.stats } }); } }, 30); })`;
const ROLL = `(() => { const v = window.__viewer, c = v.camera, p = c.positionWC, n = Math.hypot(p.x, p.y, p.z); const L = window.__moonda.lander;
  return { rollDeg: +(Math.asin((c.rightWC.x * p.x + c.rightWC.y * p.y + c.rightWC.z * p.z) / n) * 180 / Math.PI).toFixed(5), az: +L.az.toFixed(2), el: +L.el.toFixed(2), fov: +L.fov.toFixed(2), heightAboveGround: +(L.eyeHeight - window.__moonda.heights.heightAt(L.spec.lat, L.spec.lon, true)).toFixed(2) }; })()`;
// Drawn hill edge vs calculated skyline: for each compass direction turn the camera there, let the tiles load,
// then find by bisection the highest ray that still hits the drawn terrain.
const SKYLINE = step => `(async () => {
  const v = window.__viewer, L = window.__moonda.lander, scene = v.scene, C = window.__moondaCesium;
  const sk = L.spec.skyline; if (!sk) return { error: 'no skyline' };
  const frame = () => new Promise(r => requestAnimationFrame(() => r()));
  // A fine mesh can still be in a worker after the high queue empties. Wait for terrain in all
  // queues and a stable drawn tile set; photo-only requests need not delay a skyline ray.
  const settle = async () => { let ok = 0, n = 0, previous = ''; while (ok < 4 && n < 240) {
    scene.requestRender(); await frame(); const s = scene.globe._surface;
    const pending = [...s._tileLoadQueueHigh, ...s._tileLoadQueueMedium, ...s._tileLoadQueueLow].some(t => t.data?.terrainState !== 6);
    const signature = s._tilesToRender.map(t => t.level + '/' + t.x + '/' + t.y).join(',');
    ok = !pending && signature === previous ? ok + 1 : 0; previous = signature; n++;
  } return n; };
  const observer = () => ({view:L.view,walking:L.walking,eyeM:C.Cartesian3.magnitude(L.eye)-1737400,eyeHeight:L.eyeHeight,groundM:L.groundUnder(L.eye),exactM:window.__moonda.heights.heightAt(L.spec.lat,L.spec.lon,true),mastM:L.spec.mastM});
  const observerStart=observer();
  const az0 = L.az, el0 = L.el, rows = []; let worst = 0, sum = 0, cnt = 0, slow = 0;
  for (let az = 0; az < 360; az += ${step}) {
    const want = sk.elevations[Math.round(az / sk.stepDeg) % sk.elevations.length];
    L.az = az; L.el = Math.max(-20, Math.min(30, want)); L.applyCamera();
    if (await settle() >= 240) slow++;
    const hit = el => { const d = L.dirFor(az, el, new C.Cartesian3()); return !!scene.globe.pick(new C.Ray(C.Cartesian3.clone(L.eye), d), scene); };
    let lo = want - 6, hi = want + 6;
    if (!hit(lo)) lo = -60; if (hit(hi)) hi = 60;
    for (let i = 0; i < 22; i++) { const m = (lo + hi) / 2; if (hit(m)) lo = m; else hi = m; }
    const drawn = (lo + hi) / 2, diff = drawn - want;
    rows.push([az, +want.toFixed(3), +drawn.toFixed(3), +diff.toFixed(3)]);
    worst = Math.max(worst, Math.abs(diff)); sum += Math.abs(diff); cnt++;
  }
  L.az = az0; L.el = el0; L.applyCamera(); scene.requestRender();
  const over = rows.filter(r => Math.abs(r[3]) > 0.3);
  return { observerStart, observerEnd:observer(), worstDeg: +worst.toFixed(3), meanAbsDeg: +(sum / cnt).toFixed(3), over03: over.length, of: cnt, notSettled: slow, worstRows: [...rows].sort((a, b) => Math.abs(b[3]) - Math.abs(a[3])).slice(0, 8) };
})()`;

const built = [];
for (const s of steps) {
  if (s.do === 'stand') {
    built.push({ do: 'eval', js: `window.__moondaTest.stand(${s.lat}, ${s.lon}); 'ok'` });
    built.push({ do: 'eval', js: WAIT(`L.phase === 'on'`, s.timeout ?? 25000), name: s.name ?? 'stand' });
  } else if (s.do === 'waitOn') built.push({ do: 'eval', js: WAIT(`L.phase === 'on'`, s.timeout ?? 25000), name: s.name ?? 'waitOn' });
  else if (s.do === 'waitOff') built.push({ do: 'eval', js: WAIT(`L.phase === 'off'`, s.timeout ?? 15000), name: s.name ?? 'waitOff' });
  else if (s.do === 'time' && s.ms !== undefined) built.push({ do: 'eval', js: `window.__moondaTest.setTime(${s.ms}); 'ok'` }, { do: 'wait', ms: 350 });
  else if (s.do === 'time') {
    built.push({ do: 'eval', name: s.name ?? 'time', js: `(() => { const T = window.__moondaTest, st = T.state(); if (!st.sunPart) return 'no timeline';
      const want = ${s.lit ? 'p => p > 0.999' : 'p => p <= 0'}; let i = st.sunPart.findIndex(want); if (i < 0) return 'never';
      i = Math.min(st.sunPart.length - 1, i + ${s.after ?? 12}); if (!want(st.sunPart[i])) i -= ${s.after ?? 12};
      const ms = st.startMs + i * st.stepMs; T.setTime(ms); return { ms, iso: new Date(ms).toISOString(), sunPart: st.sunPart[i] }; })()` });
    built.push({ do: 'wait', ms: 350 });
  } else if (s.do === 'face') built.push({ do: 'eval', js: `(() => { const L = window.__moonda.lander; L.anim = null; L.velAz = L.velEl = 0; L.az = ${s.az ?? 'L.az'}; L.el = ${s.el ?? 'L.el'}; ${s.fov ? `L.fov = L.fovTarget = ${s.fov};` : ''} L.kick(); return 'ok'; })()` }, { do: 'wait', ms: s.ms ?? 500 });
  else if (s.do === 'roll') built.push({ do: 'eval', js: ROLL, name: s.name ?? 'roll' });
  else if (s.do === 'skyline') built.push({ do: 'eval', js: SKYLINE(s.step ?? 5), name: s.name ?? 'skyline' });
  else built.push(s);
}
const file = join(out, 'scenario.json');
writeFileSync(file, JSON.stringify(built));
const port = flag('--port', '5204');
const r = spawnSync('node', [join(dirname(fileURLToPath(import.meta.url)), 'drive.mjs'), file, '--url', `http://127.0.0.1:${port}/${flag('--query', '')}`, '--out', out,
  ...(flag('--modules', '') ? ['--modules', flag('--modules', '')] : []),
  '--profile', flag('--profile', join(root, 'chrome-profile')), '--width', flag('--width', '1440'), '--height', flag('--height', '900')], { encoding: 'utf8', maxBuffer: 1 << 26 });
const res = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
console.log(JSON.stringify({ measures: res.measures, evals: res.evals, errors: res.errors, notes: res.steps.filter(s => s.note && /NOT FOUND|ERROR|TIMED OUT/.test(s.note)) }, null, 1));
if (r.stderr) console.error(r.stderr.slice(0, 2000));
