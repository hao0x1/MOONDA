// Real-GPU bowl traverse and stable-field evidence. Uses the running Vite server only.
// node scripts/check-crater-browser.mjs <output-folder>
import puppeteer from 'puppeteer-core';
import { acquireBrowserLease } from './browserLease.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const out = process.argv[2];
if (!out) throw new Error('Give an output folder');
mkdirSync(out, { recursive: true });
const lease = await acquireBrowserLease({ script: 'check-crater-browser.mjs', noteDir: out });
let browser, launchPromise, cleanupPromise, temporaryProfile;
async function cleanupBrowser() {
  cleanupPromise ??= (async () => {
    let closeError;
    try {
      browser ??= await launchPromise?.catch(() => undefined);
      await browser?.close();
    } catch (error) { closeError = error; }
    try {
      if (temporaryProfile && existsSync(temporaryProfile)) {
        const child = browser?.process?.();
        let inUse = !!closeError || !!(child?.pid && child.exitCode == null && child.signalCode == null);
        try {
          const identity = realpathSync(temporaryProfile);
          const commands = execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8', maxBuffer: 8 << 20 });
          inUse ||= commands.split('\n').some(command => {
            const match = command.match(/(?:^|\s)--user-data-dir=(?:"([^"]+)"|'([^']+)'|(\S+))/);
            const profile = match && (match[1] ?? match[2] ?? match[3]);
            if (!profile) return false;
            try { return realpathSync(profile) === identity; }
            catch { return resolve(profile) === resolve(temporaryProfile); }
          });
        } catch { inUse = true; }
        if (inUse) console.warn(`[profile cleanup] Kept ${temporaryProfile}: browser exit was not confirmed.`);
        else rmSync(temporaryProfile, { recursive: true, force: true });
      }
    } finally {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      lease.release();
    }
    if (closeError) throw closeError;
  })();
  return cleanupPromise;
}
function onSignal(code) {
  void cleanupBrowser().catch(error => console.error(error)).finally(() => process.exit(code));
}
const onSigint = () => onSignal(130), onSigterm = () => onSignal(143);
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);
let page;
try {
 const profile = process.argv[3] ?? (temporaryProfile = mkdtempSync(join(tmpdir(), 'moonda-craters-')));
 launchPromise = puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  handleSIGINT: false, handleSIGTERM: false,
  userDataDir: profile, defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--no-first-run', '--hide-scrollbars', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
browser = await launchPromise;
await lease.afterLaunch(browser);
page = (await browser.pages())[0];
const errors = [];
const requestFailures = [];
page.on('pageerror', e => errors.push(e.stack || String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 500)); });
page.on('requestfailed',r=>requestFailures.push({url:r.url(),error:r.failure()?.errorText}));
const wait = ms => new Promise(r => setTimeout(r, ms));
const shot = async name => page.screenshot({ path: join(out, name + '.png'), clip: { x: 0, y: 0, width: 1440, height: 900, scale: 0.5 } });
try {
  await page.goto('http://127.0.0.1:5190/', { waitUntil: 'domcontentloaded', timeout: 280000 });
  await page.waitForFunction(() => !!window.__moondaTest && !!window.__moondaCesium, { timeout: 280000 });
  await page.waitForFunction(() => window.__moonda?.progress?.done, { timeout: 280000 });
  await wait(800);
  await page.evaluate(() => { window.__craterStandAt=performance.now();window.__moondaTest.stand(-89.45, -137.3); });
  await page.waitForFunction(() => window.__moonda?.lander.phase === 'on', { timeout: 40000 });
  const ridgeOpeningMs=await page.evaluate(()=>performance.now()-window.__craterStandAt);
  await wait(2500);
  const setup = await page.evaluate(async () => {
    const L = window.__moonda.lander, C = window.__moondaCesium;
    const { toTrueLatLon } = await import('/src/moon/frame.ts');
    const { craterAtCell, craterRelief } = await import('/src/moon/craterField.ts');
    const bowl = craterAtCell(1, 0, 0);
    window.__craterBowl = bowl;
    window.__craterJump = (e, n, h = 90) => {
      const p = C.Cartesian3.add(L.rockOrigin, C.Cartesian3.add(C.Cartesian3.multiplyByScalar(L.rockE, e, new C.Cartesian3()), C.Cartesian3.multiplyByScalar(L.rockN, n, new C.Cartesian3()), new C.Cartesian3()), new C.Cartesian3());
      const t = toTrueLatLon(p); window.__roverLink.teleport(t.lat, t.lon, h);
    };
    window.__craterRead = () => {
      const d = L.driver, p = { ...window.__roverLink.pose };
      const e = C.Cartesian3.dot(d.feet, L.rockE), n = C.Cartesian3.dot(d.feet, L.rockN);
      return { ms: performance.now(), along: e - bowl.e, e, n, pitch: p.pitchDeg, roll: p.rollDeg, speed: p.speed,
        blocked: d.blocked, keys: [...L.keys], driving: L.walking, phase: L.phase, ground: L.groundUnder(d.feet), meshRelief: L.groundUnder(d.feet)-window.__moonda.heights.heightAt(p.lat,p.lon,true), relief: craterRelief(e,n), centre: { ...L.relief?.centre }, recentres: L.stats.recentres };
    };
    window.__landerLink.setView('third'); window.__landerLink.setWalk(false);
    window.__craterJump(bowl.e - bowl.radius - 2.1, bowl.n);
    return { bowl, webgl2: window.__viewer.scene.context.webgl2, stats: { ...L.stats } };
  });
  await wait(3500);
  await page.evaluate(() => { const L = window.__moonda.lander; L.az = 90; L.el = -12; L.chaseDist = 5; L.armDist = 5; L.kick(); });
  await wait(1000); await shot('bowl-rim-behind');
  const tiles = await page.evaluate(() => {
    const L=window.__moonda.lander, C=window.__moondaCesium;
    return window.__viewer.scene.globe._surface._tilesToRender.map(t=>({level:t.level,real:!t.upsampledFromParent})).reduce((a,t)=>{a[t.level+'-'+t.real]=(a[t.level+'-'+t.real]||0)+1;return a},{});
  });
  await page.evaluate(() => {
    window.__craterRows = []; window.__craterTimer = setInterval(() => window.__craterRows.push(window.__craterRead()), 250);
    window.__landerLink.setWalk(true);
  });
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.down('w');
  await page.waitForFunction(() => window.__craterRead().along > -2.0, { timeout: 16000 });
  await shot('bowl-wall-behind');
  await page.waitForFunction(() => window.__craterRead().along > -0.1, { timeout: 16000 });
  await shot('bowl-floor-behind');
  await page.waitForFunction(() => window.__craterRead().along > 5.3, { timeout: 16000 });
  await page.keyboard.up('w');
  await page.evaluate(() => { clearInterval(window.__craterTimer); window.__landerLink.setWalk(false); });
  const rows = await page.evaluate(() => window.__craterRows);
  writeFileSync(join(out,'traverse.json'),JSON.stringify({setup,tiles,rows,errors},null,2));
  // A quarter-metre eye beside the rim makes the hollow visible against the far ground.
  await page.evaluate(() => { const b=window.__craterBowl;window.__craterJump(b.e,b.n); });
  await wait(2500);
  await page.evaluate(() => {
    const L=window.__moonda.lander,C=window.__moondaCesium,b=window.__craterBowl;
    const at=(e,n)=>C.Cartesian3.add(L.rockOrigin,C.Cartesian3.add(C.Cartesian3.multiplyByScalar(L.rockE,e,new C.Cartesian3()),C.Cartesian3.multiplyByScalar(L.rockN,n,new C.Cartesian3()),new C.Cartesian3()),new C.Cartesian3());
    const p=at(b.e,b.n-6),target=at(b.e,b.n);
    C.Cartesian3.multiplyByScalar(C.Cartesian3.normalize(p,p),1737400+L.groundUnder(p)+0.25,p);
    C.Cartesian3.multiplyByScalar(C.Cartesian3.normalize(target,target),1737400+L.groundUnder(target)+0.3,target);
    const direction=C.Cartesian3.normalize(C.Cartesian3.subtract(target,p,new C.Cartesian3()),new C.Cartesian3());
    const right=C.Cartesian3.normalize(C.Cartesian3.cross(direction,L.up,new C.Cartesian3()),new C.Cartesian3());
    const up=C.Cartesian3.normalize(C.Cartesian3.cross(right,direction,new C.Cartesian3()),new C.Cartesian3());
    L.az=0; L.el=Math.asin(C.Cartesian3.dot(direction,L.up))*180/Math.PI;
    window.__craterCamera=L.applyCamera;
    L.applyCamera=()=>{C.Cartesian3.clone(p,L.eye);window.__viewer.camera.setView({destination:p,orientation:{direction,up}});L.updateCraterEye();};
    L.kick();
  });
  await wait(1000); await shot('bowl-side-low');
  await page.evaluate(()=>{window.__moonda.lander.applyCamera=window.__craterCamera;window.__moonda.lander.kick();});
  const sampleField = () => page.evaluate(() => { const L=window.__moonda.lander,b=window.__craterBowl,C=window.__moondaCesium;return [-4,-2,0,2,4].map(x=>{const p=C.Cartesian3.add(L.rockOrigin,C.Cartesian3.add(C.Cartesian3.multiplyByScalar(L.rockE,b.e+x,new C.Cartesian3()),C.Cartesian3.multiplyByScalar(L.rockN,b.n,new C.Cartesian3()),new C.Cartesian3()),new C.Cartesian3());return L.groundUnder(p)}); });
  await page.evaluate(() => {const L=window.__moonda.lander;L.az=0;L.el=-2;L.chaseDist=8;L.armDist=8;L.kick();});
  await wait(2500);
  const before = await sampleField();
  await shot('fixed-before');
  await page.evaluate(() => window.__craterJump(3500,0));
  await wait(8500);
  const away = await page.evaluate(() => ({...window.__craterRead(),stats:window.__moonda.lander.stats}));
  await page.evaluate(() => {const b=window.__craterBowl;window.__craterJump(b.e,b.n);});
  await wait(8500);
  await page.evaluate(() => { const L=window.__moonda.lander;L.az=0;L.el=-2;L.chaseDist=8;L.armDist=8;L.kick(); });
  await wait(1500); await shot('fixed-after');
  const after = await sampleField();
  const rendering=await page.evaluate(()=>({loop:window.__viewer.useDefaultRenderLoop,error:document.querySelector('.cesium-widget-errorPanel')?.innerText,resolutionScale:window.__viewer.resolutionScale}));
  const fineTile=await page.evaluate(()=>{
    const C=window.__moondaCesium,L=window.__moonda.lander,p=window.__viewer.terrainProvider;
    const c=C.Cartographic.fromCartesian(L.driver.feet,p.tilingScheme.ellipsoid);
    const t=p.tilingScheme.positionToTileXY(c,18);
    return {x:t.x,y:t.y,available:p.getTileDataAvailable(t.x,t.y,18)};
  });
  await page.evaluate(()=>window.__moondaTest.exit());
  await page.waitForFunction(()=>window.__moonda.lander.phase==='off',{timeout:10000});
  const off=await page.evaluate(t=>{
    const v=window.__viewer,p=v.terrainProvider;
    return {relief:p.relief!==null,available:p.getTileDataAvailable(t.x,t.y,18),
      drawnPhysical:v.scene.globe._surface._tilesToRender.filter(t=>t.data?.terrainData&&p.physicalData.has(t.data.terrainData)).length};
  },fineTile);
  await page.evaluate(()=>{window.__craterStandAt=performance.now();window.__moondaTest.stand(0.674,23.473);});
  await page.waitForFunction(()=>window.__moonda.lander.phase==='on',{timeout:40000});
  const apolloOpeningMs=await page.evaluate(()=>performance.now()-window.__craterStandAt);
  await page.evaluate(()=>window.__moondaTest.exit());
  await page.waitForFunction(()=>window.__moonda.lander.phase==='off',{timeout:10000});
  const result={setup,tiles,rows,stable:{before,after,away},rendering,fineTile,off,openings:{ridgeMs:ridgeOpeningMs,apolloMs:apolloOpeningMs},errors,requestFailures};
  writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));
  assert.ok(rows.some(r=>r.along<0 && r.pitch < -3),'nose did not dip entering the bowl');
  assert.ok(rows.some(r=>r.along>0 && r.pitch > 3),'nose did not rise leaving the bowl');
  assert.ok(Math.min(...rows.map(r=>r.meshRelief)) < -0.7,'drawn ground did not dip into the bowl');
  assert.ok(Math.max(...before.map((h,i)=>Math.abs(h-after[i]))) < 0.02,'craters moved after the map frame changed');
  assert.ok(result.rendering.loop && !result.rendering.error,'rendering stopped');
  assert.ok(fineTile.available,'fine source was unavailable under the rover');
  assert.deepEqual(off,{relief:false,available:false,drawnPhysical:0},'fine relief survived leaving the surface');
  assert.deepEqual(errors,[],'browser errors');
  console.log(JSON.stringify({setup,tiles,samples:rows.length,pitch:[Math.min(...rows.map(r=>r.pitch)),Math.max(...rows.map(r=>r.pitch))],ground:[Math.min(...rows.map(r=>r.ground)),Math.max(...rows.map(r=>r.ground))],stable:result.stable,errors},null,2));
 } catch (error) {
  const state = await page.evaluate(() => ({rows:window.__craterRows,pose:window.__craterRead?.(),stats:window.__moonda?.lander?.stats,exposure:window.__moonda?.lander?.exposure,target:window.__moonda?.lander?.exposureTarget})).catch(()=>null);
  writeFileSync(join(out,'failure.json'),JSON.stringify({error:String(error),state,errors},null,2));
  throw error;
}
} finally { await cleanupBrowser(); }
