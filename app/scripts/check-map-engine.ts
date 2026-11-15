// Engine checks use the team's GPU harness and its single-browser lease. No second server is started.
// node scripts/check-map-engine.ts --phase before|after --out /path/to/evidence [--width 1440] [--prepare]
// node scripts/check-map-engine.ts --math --out /path/to/evidence (no browser)
// @ts-nocheck
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const phase = flag('--phase', 'after');
if (!['before', 'after'].includes(phase)) throw Error('--phase must be before or after');
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(flag('--out', join(app, '..', 'scratchpad', 'map-engine', phase)));
const width = Number(flag('--width', '1440')), height = width === 1280 ? 720 : 900;
mkdirSync(outDir, { recursive: true });
const require = createRequire(join(app, 'package.json'));
if (args.includes('--math')) { runMathChecks(); process.exit(0); }
if (args.includes('--round5-report')) { runRound5Report(); process.exit(0); }
if (args.includes('--trace-report')) { runTraceReport(); process.exit(0); }
const round5 = args.includes('--round5'), variant = flag('--variant', 'baseline');
if (round5 && !['baseline', 'no-blur', 'no-3d', 'no-blur-no-3d', 'dpr1', 'final', 'no-3d-final', 'no-blur-no-3d-final', 'no-3d-no-blur-no-polar', 'no-3d-no-blur-no-light', 'no-3d-no-blur-gpu-polar', 'no-3d-no-blur-no-react'].includes(variant)) throw Error('Unknown round-5 variant');
const scenario = [{ do: 'engine:boot' }, { do: 'ready', timeout: 280000 }, { do: 'engine:check', phase, round5, variant, trace: args.includes('--trace'), proof: args.includes('--round5-proof') || args.includes('--round5-layer-extra'), layerExtra: args.includes('--round5-layer-extra'), extras: args.includes('--extras'), shotsOnly: args.includes('--shots'), driveOnly: args.includes('--drive') }];
writeFileSync(join(outDir, 'scenario.json'), JSON.stringify(scenario, null, 2));

function runTraceReport() {
  const trace=JSON.parse(readFileSync(join(outDir,'performance-trace.json'),'utf8')),raw=trace.traceEvents??trace;
  const names=new Map(raw.filter(e=>e.ph==='M'&&e.name==='thread_name').map(e=>[`${e.pid}/${e.tid}`,e.args?.name??'']));
  const mark=raw.find(e=>e.name==='map-check:start');if(!mark)throw Error('No map-check:start marker in trace');
  const mainKey=`${mark.pid}/${mark.tid}`,timing=JSON.parse(readFileSync(join(outDir,'whole-frame-timings.json'),'utf8')),offset=mark.ts-timing.checkStartMs*1000;
  const events=raw.filter(e=>e.ph==='X'&&e.dur>0),threads=new Map(),slow=timing.frames.filter(f=>f.frameMs>20);
  const overlap=(e,a,b)=>Math.max(0,Math.min(b,e.ts+e.dur)-Math.max(a,e.ts));
  const describe=e=>({name:e.name,category:e.cat,pid:e.pid,tid:e.tid,thread:names.get(`${e.pid}/${e.tid}`),durationMs:e.dur/1000,timeMs:(e.ts-mark.ts)/1000,args:e.args});
  const bounds=[mark.ts,mark.ts+(timing.frames.at(-1)?.elapsedMs??11000)*1000],inRange=events.filter(e=>e.ts<bounds[1]&&e.ts+e.dur>bounds[0]);
  for(const e of inRange){const key=`${e.pid}/${e.tid}`,thread=threads.get(key)??{pid:e.pid,tid:e.tid,name:names.get(key)??'',events:0,byName:{}};thread.events++;const a=thread.byName[e.name]??={calls:0,totalMs:0,maxMs:0};a.calls++;a.totalMs+=e.dur/1000;a.maxMs=Math.max(a.maxMs,e.dur/1000);threads.set(key,thread);}
  const threadTable=[...threads.values()].map(t=>({...t,byName:Object.entries(t.byName).map(([name,x])=>({name,...x})).sort((a,b)=>b.totalMs-a.totalMs).slice(0,18)}));
  const main=inRange.filter(e=>`${e.pid}/${e.tid}`===mainKey),tasks=main.filter(e=>/RunTask|ProcessTaskFromWorkQueue/.test(e.name));
  const gpuWaits=inRange.filter(e=>/IOSurfaceImageBacking::WaitForCommandsToBeScheduled/.test(e.name)),gpuTasks=inRange.filter(e=>(names.get(`${e.pid}/${e.tid}`)??'')==='CrGpuMain'&&/RunTask/.test(e.name));
  const unionMs=(list,a,b)=>{const intervals=list.map(e=>[Math.max(a,e.ts),Math.min(b,e.ts+e.dur)]).filter(p=>p[1]>p[0]).sort((a,b)=>a[0]-b[0]);let end=-Infinity,sum=0;for(const [lo,hi]of intervals){sum+=Math.max(0,hi-Math.max(lo,end));end=Math.max(end,hi);}return sum/1000;};
  const slowFrames=slow.map(f=>{const end=offset+f.nowMs*1000,start=end-f.frameMs*1000,seen=main.filter(e=>overlap(e,start,end)>0),top=seen.slice().sort((a,b)=>overlap(b,start,end)-overlap(a,start,end)).slice(0,10).map(e=>({...describe(e),overlapMs:overlap(e,start,end)/1000}));return {phase:f.phase,frame:f.frame,acrossM:f.acrossM,frameMs:f.frameMs,mainBusyMs:unionMs(tasks,start,end),gpuWaitMs:unionMs(gpuWaits,start,end),gpuTaskMs:unionMs(gpuTasks,start,end),gpuTop:gpuWaits.filter(e=>overlap(e,start,end)>0).sort((a,b)=>overlap(b,start,end)-overlap(a,start,end)).slice(0,2).map(e=>({...describe(e),overlapMs:overlap(e,start,end)/1000})),mapMs:f.mapMs,top};});
  const expensiveMain=main.filter(e=>e.dur>=3000).sort((a,b)=>b.dur-a.dur).slice(0,40).map(describe);
  const specific=main.filter(e=>/FunctionCall|EvaluateScript|RunMicrotasks|GC|Layout|Paint|Decode|Image|Commit|Raster|Composite|UpdateLayer|v8.execute/i.test(e.name)).sort((a,b)=>b.dur-a.dur).slice(0,60).map(describe);
  const zoomSlow=slowFrames.filter(f=>f.phase==='zoom-in'),gpuWaitCoverage=zoomSlow.reduce((n,f)=>n+f.gpuWaitMs,0)/Math.max(1,zoomSlow.reduce((n,f)=>n+f.frameMs,0));
  const report={gpuWaitCoverageOfSlowZoomIn:gpuWaitCoverage,source:join(outDir,'performance-trace.json'),variant:timing.variant,main:{pid:mark.pid,tid:mark.tid,name:names.get(mainKey)},eventCount:raw.length,completeEventCount:events.length,traceRangeMs:(bounds[1]-bounds[0])/1000,slowFrameCount:slowFrames.length,slowFrames,expensiveMain,specific,threads:threadTable};
  writeFileSync(join(outDir,'TRACE-RESULTS.json'),JSON.stringify(report,null,2));
  const text=['# Residual frame trace','',`Renderer main thread: ${mark.pid}/${mark.tid} (${names.get(mainKey)}). ${raw.length} trace events; ${slowFrames.length} measured frame intervals over 20 ms.`, '', `GPU IOSurface scheduling waits cover ${(gpuWaitCoverage*100).toFixed(1)}% of the combined slow zoom-in intervals. The trace shows GPU-side waiting; it does not identify the exact resource or driver cause.`, '', 'Main-thread busy time is the union of top-level tasks overlapping each frame interval; nested event totals are not added together. Trace capture itself has overhead.','', '| Phase | Frame | Width m | Interval ms | Main busy ms | GPU IOSurface wait ms | Timed map ms | Largest main event |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |'];
  for(const f of slowFrames)text.push(`| ${f.phase} | ${f.frame} | ${f.acrossM.toFixed(0)} | ${f.frameMs.toFixed(1)} | ${f.mainBusyMs.toFixed(2)} | ${f.gpuWaitMs.toFixed(2)} | ${f.mapMs.toFixed(2)} | ${f.top[0]?.name??''} |`);
  text.push('', '## Longest main-thread events','', '| Event | Duration ms | Time after check start ms | Source |','| --- | ---: | ---: | --- |');
  for(const e of specific.slice(0,25)){const d=e.args?.data??{};text.push(`| ${e.name} | ${e.durationMs.toFixed(2)} | ${e.timeMs.toFixed(1)} | ${d.functionName??''} ${d.url??d.scriptName??''}:${d.lineNumber??''} |`);}
  text.push('', '## Threads','');for(const t of threadTable){text.push(`- ${t.pid}/${t.tid} ${t.name}: `+t.byName.slice(0,5).map(x=>`${x.name} ${x.totalMs.toFixed(1)} ms total / ${x.maxMs.toFixed(1)} ms max`).join('; '));}
  writeFileSync(join(outDir,'TRACE-RESULTS.md'),text.join('\n')+'\n');
  console.log(JSON.stringify({main:report.main,events:raw.length,slowFrames:slowFrames.length,longestMain:expensiveMain.slice(0,8)},null,2));
}

function runRound5Report() {
  const runs=[];
  for(const entry of readdirSync(outDir,{withFileTypes:true})){
    if(!entry.isDirectory())continue;
    const file=join(outDir,entry.name,'whole-frame-timings.json');if(!existsSync(file))continue;
    const value=JSON.parse(readFileSync(file,'utf8'));
    runs.push({folder:entry.name,variant:value.variant,setup:value.setup,appliedSetup:value.appliedSetup??value.setup?.applied??null,source:file,
      table:value.table.map(row=>({phase:row.phase,...row.frames,mapMeanMs:row.mapWork.meanMs,mapMaxMs:row.mapWork.maxMs,sceneMeanMs:row.sceneWork.meanMs,sceneMaxMs:row.sceneWork.maxMs,landerMeanMs:row.landerWork.meanMs}))});
  }
  const order=['baseline','no-blur','no-3d','no-blur-no-3d','dpr1','final','no-3d-final','no-blur-no-3d-final','no-3d-no-blur-no-polar','no-3d-no-blur-no-light','no-3d-no-blur-gpu-polar','no-3d-no-blur-no-react'];
  runs.sort((a,b)=>(order.indexOf(a.variant)-order.indexOf(b.variant))||a.folder.localeCompare(b.folder));
  const text=['# Whole-frame map checks','', 'Actual requestAnimationFrame intervals at devicePixelRatio 2. Each comparable gesture lasts 3 seconds; final endpoint holds are listed separately. The map remains over the real surface view.','',
    '| Variant | Gesture | Frames | Median ms | P95 ms | Max ms | Over 20 ms | Map mean / max ms | Scene mean ms |','| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for(const run of runs)for(const row of run.table)text.push(`| ${run.folder} | ${row.phase} | ${row.count} | ${row.medianMs.toFixed(1)} | ${row.p95Ms.toFixed(1)} | ${row.maxMs.toFixed(1)} | ${row.over20ms} | ${row.mapMeanMs.toFixed(2)} / ${row.mapMaxMs.toFixed(2)} | ${row.sceneMeanMs.toFixed(2)} |`);
  text.push('', 'These are separate fresh-page runs. Loading, cache state and the operating system can vary; the ablations identify large effects, and an isolated missed refresh is still recorded.','', 'The no-3d variants stop Cesium’s default render loop and suspend the lander’s separate RAF during measurement. The no-blur variants remove only the backdrop blur with a temporary inline style. The dpr1 variant changes only the full map canvas density; the browser and 3D view stay at DPR 2.','');
  writeFileSync(join(outDir,'whole-frame-summary.json'),JSON.stringify({runs},null,2));
  writeFileSync(join(outDir,'WHOLE-FRAME-RESULTS.md'),text.join('\n'));
  console.log(JSON.stringify({out:outDir,runs:runs.length,rows:runs.reduce((n,r)=>n+r.table.length,0)},null,2));
}

function runMathChecks() {
  const engineSource = readFileSync(join(app, 'src/explore/MapEngine.ts'), 'utf8');
  const localSource = readFileSync(join(app, 'src/explore/surfaceProjection.ts'), 'utf8').replace(/^import .*;\s*$/gm, '').replace('export class SurfaceProjection', 'class SurfaceProjection');
  const marker = 'class FlatMapProjection {';
  const start = engineSource.indexOf(marker);
  if (start < 0) throw Error('The engine no longer contains FlatMapProjection; update this extraction check.');
  // Extract the real class, so this check cannot silently pass against a stale copy of its maths.
  let depth = 0, end = -1, quote = '', lineComment = false, blockComment = false;
  for (let i = start + marker.indexOf('{'); i < engineSource.length; i++) {
    const c = engineSource[i], next = engineSource[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '/' && next === '/') { lineComment = true; i++; continue; }
    if (c === '/' && next === '*') { blockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw Error('FlatMapProjection has no closing brace.');
  const fixture = join(outDir, 'projection-fixture.ts'), compiled = join(outDir, 'compiled');
  const types = 'type FlatBasis = {up:[number,number,number];east:[number,number,number];north:[number,number,number]};\ntype FlatQuaternion=[number,number,number,number];';
  writeFileSync(fixture, `const MAP_R = 1737400;\n${localSource}\n${types}\n${engineSource.slice(start, end)}\n`);
  // The installed TypeScript 7 package uses a native compiler rather than transpileModule.
  // Compile this small, dependency-free fixture with that compiler; no package is downloaded.
  const compiler = join(dirname(require.resolve('typescript')), 'tsc.js');
  try {
    execFileSync(process.execPath, [compiler, fixture, '--ignoreConfig', '--target', 'es2022', '--module', 'es2022', '--moduleDetection', 'legacy', '--lib', 'es2022', '--skipLibCheck', '--outDir', compiled], { stdio: 'pipe' });
  } catch (error) { throw Error(`Projection fixture did not compile: ${String(error.stdout ?? error.stderr ?? error)}`); }
  const Flat = new Function(readFileSync(join(compiled, 'projection-fixture.js'), 'utf8') + '\nreturn FlatMapProjection;')();
  const R = 1737400, DEG = Math.PI / 180, circumference = 2 * Math.PI * R;
  let seed = 15551;
  const random = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const unit = (lat, lon) => { const p = lat * DEG, l = lon * DEG, cp = Math.cos(p); return [cp * Math.cos(l), cp * Math.sin(l), Math.sin(p)]; };
  const distance = (a, b) => {
    const u = unit(...a), v = unit(...b), cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    return R * Math.atan2(Math.hypot(...cross), u[0] * v[0] + u[1] * v[1] + u[2] * v[2]);
  };
  const results = [], failures = [], boundaries = [], farBounds = [];
  const places = [['connecting-ridge', -89.45, -137.3], ['apollo11', .674, 23.473], ['owner', -36.03, 19.44]];
  for (const [name, lat, lon] of places) {
    for (const across of [60, 200, 10000, 300000, 500000, 700000, 1200000, 2200000, 3500000, 4500000, circumference]) {
      const map = new Flat(lat, lon); map.setAcross(across, false);
      let points = 0, maxGroundErrorM = 0, maxScreenErrorM = 0;
      const check = ll => {
        const xy = map.project(...ll), back = map.unproject(...xy); points++;
        if (!Number.isFinite(back[0] + back[1])) { failures.push({ name, across, point: ll, reason: 'Missing inverse' }); return; }
        const groundErrorM = distance(ll, back), again = map.project(...back), rawX = again[0] - xy[0];
        const xError = Math.min(Math.abs(rawX), Math.abs(rawX - circumference), Math.abs(rawX + circumference));
        const screenErrorM = Math.hypot(xError, again[1] - xy[1]);
        maxGroundErrorM = Math.max(maxGroundErrorM, groundErrorM); maxScreenErrorM = Math.max(maxScreenErrorM, screenErrorM);
        if (groundErrorM > .01 && Math.abs(ll[0]) < 89.999999) failures.push({ name, across, point: ll, inverse: back, groundErrorM, reason: 'Ground error exceeds one centimetre' });
      };
      for (let i = 0; i < 400; i++) check([(random() - .5) * 179.98, (random() - .5) * 360]);
      for (let i = 0; i < 100; i++) {
        const ll = map.unproject((random() - .5) * across, (random() - .5) * across);
        if (Number.isFinite(ll[0] + ll[1])) check(ll);
      }
      results.push({ place: name, acrossM: across, blend: map.blend, points, maxGroundErrorM, maxScreenErrorM });
    }
    for (const across of [500000, 4500000]) {
      const map = new Flat(lat, lon), point = [Math.max(-89.99, Math.min(89.99, lat + .1)), lon + .2];
      map.setAcross(across * (1 - 1e-8), false); const before = map.project(...point);
      map.setAcross(across * (1 + 1e-8), false); const after = map.project(...point);
      const movementM = Math.hypot(after[0] - before[0], after[1] - before[1]);
      boundaries.push({ place: name, acrossM: across, relativeSpanChange: 2e-8, movementM });
      if (movementM > .01) failures.push({ name, across, movementM, reason: 'Discontinuous blend boundary' });
    }
    const map = new Flat(lat, lon); map.setAcross(circumference, false);
    const frame = map.basis(), offsetM = map.offsetN();
    const outsideX = map.unproject(Math.PI * R + 1, 0), outsideY = map.unproject(0, Math.PI * R / 2 - offsetM + 1);
    const valid = !Number.isFinite(outsideX[0]) && !Number.isFinite(outsideY[0]) && Math.abs(offsetM) < .000001 && Math.abs(frame.north[2] - 1) < 1e-12;
    farBounds.push({ place: name, offsetM, widthM: circumference, heightM: circumference / 2, rejectsOutsidePhoto: valid });
    if (!valid) failures.push({ name, reason: 'Far frame or rectangle bounds are wrong' });
  }
  const report = { source: 'Current MapEngine.ts FlatMapProjection and surfaceProjection.ts, compiled by the installed TypeScript',
    compilerVersion: require('typescript').version, cases: results.length, points: results.reduce((n, r) => n + r.points, 0),
    maxGroundErrorM: Math.max(...results.map(r => r.maxGroundErrorM)), maxScreenErrorM: Math.max(...results.map(r => r.maxScreenErrorM)),
    results, boundaries, farBounds, failures };
  writeFileSync(join(outDir, 'math-checks.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out: outDir, cases: report.cases, points: report.points, maxGroundErrorM: report.maxGroundErrorM, failures: failures.length }, null, 2));
  if (failures.length) throw Error(`${failures.length} map maths checks failed; see math-checks.json`);
}

// This function is inserted in drive.mjs, where page/result/out/sleep are the harness's locals.
async function engineStep(step) {
  if (step.do === 'engine:boot') {
    await page.waitForFunction(() => !!window.__moondaTest, { timeout: 280000 });
    await page.evaluate(() => new Promise((done, reject) => {
      const start = performance.now(), timer = setInterval(() => {
        const enter = document.querySelector('.start-enter'), skip = document.querySelector('.start-skip');
        if (enter && !enter.disabled) enter.click(); else if (skip) skip.click();
        document.querySelector('.moonda-tutorial-visible .moonda-tutorial-close')?.click();
        if (!document.querySelector('.start-enter') && !document.querySelector('.moonda-tutorial-visible')) { clearInterval(timer); done(true); }
        else if (performance.now() - start > 280000) { clearInterval(timer); reject(Error('Start screen timed out')); }
      }, 120);
    }));
    return 'entered';
  }
  if (step.do !== 'engine:check') throw Error(`Unknown engine step ${step.do}`);
  const totals = [], frames = [], draws = [], screenshots = [];
  const save = () => {
    writeFileSync(join(out, 'engine-timings.json'), JSON.stringify({ phase: step.phase, totals, frames, draws, screenshots }, null, 2));
    writeFileSync(join(out, 'zoom-frames.csv'), 'gesture,frame,elapsedMs,frameMs,acrossM,mapWorkMs,uploadWorkMs,draws\n' + frames.map(f => [f.gesture, f.frame, f.elapsedMs, f.frameMs, f.acrossM, f.mapWorkMs, f.uploadWorkMs ?? 0, f.draws].join(',')).join('\n') + '\n');
    writeFileSync(join(out, 'draw-frames.csv'), 'gesture,elapsedMs,acrossM,mapWorkMs,methods\n' + draws.map(f => [f.gesture, f.elapsedMs, f.acrossM, f.mapWorkMs, JSON.stringify(f.methods).replaceAll(',', ';')].join(',')).join('\n') + '\n');
    result.evals.engineTimings = totals;
  };
  const settle = async (timeout = 15000) => {
    const t0 = Date.now(); let previous = NaN, stable = 0;
    while (Date.now() - t0 < timeout) {
      const value = await page.evaluate(() => window.__moondaSurfaceMap?.getAcross());
      stable = Number.isFinite(previous) && Math.abs(value / previous - 1) < .00005 ? stable + 1 : 0;
      previous = value;
      if (stable >= 4) return value;
      await sleep(80);
    }
    return previous;
  };
  const photograph = async name => {
    if (screenshots.length >= 12) throw Error('At most twelve captures per run');
    const file = join(out, `${name}.png`);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
    screenshots.push(file); result.shots.push(file);
  };
  const land = async (lat, lon) => {
    if (await page.evaluate(() => !!window.__moondaSurfaceMap)) { await page.keyboard.press('m'); await sleep(250); }
    await page.evaluate(({ lat, lon }) => window.__moondaTest.stand(lat, lon), { lat, lon });
    await page.waitForFunction(({ lat, lon }) => {
      const spot = window.__roverLink?.spot;
      return window.__moonda?.lander?.phase === 'on' && !!window.__moondaMinimap && spot && Math.abs(spot.lat - lat) < 1e-7 && Math.abs(((spot.lon - lon + 540) % 360) - 180) < 1e-7;
    }, { timeout: 280000 }, { lat, lon });
    await page.keyboard.press('m');
    await page.waitForFunction(() => !!window.__moondaSurfaceMap, { timeout: 6000 });
    await sleep(280);
  };
  const instrument = async () => page.evaluate(() => {
    const m = window.__moondaSurfaceMap;
    const methods = ['draw', 'drawBase', 'drawPolar', 'drawTrek', 'drawRoundPhoto', 'drawFlat', 'drawFar', 'drawFlatPhoto', 'drawFeatheredSource', 'drawOverlays'];
    const state = { on: false, frame: [], draws: [], stack: [], completed: [], originals: [] };
    for (const name of methods) {
      if (typeof m[name] !== 'function') continue;
      const original = m[name]; state.originals.push([name, original]);
      m[name] = function (...args) {
        if (!state.on) return original.apply(this, args);
        const entry = { name, start: performance.now(), child: 0 };
        state.stack.push(entry);
        try { return original.apply(this, args); }
        finally {
          const inclusive = performance.now() - entry.start, exclusive = inclusive - entry.child;
          state.stack.pop();
          if (state.stack.length) state.stack.at(-1).child += inclusive;
          state.completed.push({ name, inclusive, exclusive });
          if (name === 'draw') {
            state.draws.push({ t: entry.start, acrossM: m.getAcross(), mapWorkMs: inclusive, methods: state.completed });
            state.completed = [];
          }
        }
      };
    }
    state.restore = () => { state.on = false; for (const [name, original] of state.originals) m[name] = original; };
    window.__mapEngineCheck = state;
    return methods.filter(name => typeof m[name] === 'function');
  });
  const gesture = async (name, factor, atRover = false, waitUploads = false) => {
    await settle();
    await page.evaluate(({ name, factor, atRover }) => {
      const m = window.__moondaSurfaceMap, state = window.__mapEngineCheck;
      state.frame = []; state.draws = []; state.completed = []; state.on = true; state.start = performance.now();
      let previous = state.start, nextDraw = 0;
      let previousBackground = m.basePlane?.getStats?.().backgroundCpuMs ?? 0;
      state.frame.push({ gesture: name, frame: 0, elapsedMs: 0, frameMs: 0, acrossM: m.getAcross(), mapWorkMs: 0, uploadWorkMs: 0, draws: 0 });
      const tick = now => {
        if (!state.on) return;
        const draws = state.draws.slice(nextDraw); nextDraw = state.draws.length;
        const background = m.basePlane?.getStats?.().backgroundCpuMs ?? previousBackground;
        const uploadWorkMs = Math.max(0, background - previousBackground); previousBackground = background;
        state.frame.push({ gesture: name, frame: state.frame.length, elapsedMs: now - state.start, frameMs: now - previous,
          acrossM: m.getAcross(), mapWorkMs: draws.reduce((sum, d) => sum + d.mapWorkMs, 0) + uploadWorkMs, uploadWorkMs, draws: draws.length });
        previous = now; requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick); const p=atRover?m.screenAt(window.__roverLink.pose.lat,window.__roverLink.pose.lon):null; m.zoomAt(factor,p?.x,p?.y);
    }, { name, factor, atRover });
    await settle();
    if(waitUploads) await page.waitForFunction(()=>window.__moondaSurfaceMap.basePlane.getStats().readyLarge>0,{timeout:10000});
    const measured = await page.evaluate(name => {
      const state = window.__mapEngineCheck; state.on = false;
      return { frames: state.frame, draws: state.draws.map(d => ({ ...d, gesture: name, elapsedMs: d.t - state.start })) };
    }, name);
    frames.push(...measured.frames); draws.push(...measured.draws);
    const values = measured.draws.map(d => d.mapWorkMs).sort((a, b) => a - b);
    const sum = measured.draws.reduce((s, d) => s + d.mapWorkMs, 0), counts = {};
    for (const draw of measured.draws) for (const method of draw.methods) {
      const total = counts[method.name] ??= { calls: 0, inclusiveMs: 0, exclusiveMs: 0, maxMs: 0 };
      total.calls++; total.inclusiveMs += method.inclusive; total.exclusiveMs += method.exclusive; total.maxMs = Math.max(total.maxMs, method.inclusive);
    }
    totals.push({ gesture: name, frameCount: measured.frames.length, mapDraws: values.length, meanMs: sum / Math.max(1, values.length),
      p95Ms: values[Math.floor(values.length * .95)] ?? 0, maxMs: values.at(-1) ?? 0, over8ms: values.filter(v => v > 8).length,
      peakFrameWorkMs: measured.frames.reduce((peak, frame) => Math.max(peak, frame.mapWorkMs), 0),
      over8msFrames: measured.frames.filter(frame => frame.mapWorkMs > 8).length,
      startM: measured.frames[0]?.acrossM, endM: measured.frames.at(-1)?.acrossM, methods: counts });
    save();
  };
  const coneChecks = async () => {
    const table = [];
    const available = await page.evaluate(() => typeof window.__moondaSurfaceMap?.getBearings === 'function' && typeof window.__moondaMinimap?.getBearings === 'function');
    if (!available) { result.evals.coneChecks = { skipped: 'getBearings is not available in this engine revision' }; return; }
    for (const mode of ['spot', 'third', 'first']) {
      await page.evaluate(mode => window.__landerLink.setView(mode), mode); await sleep(1200);
      for (const direction of [0, 90, 180, 270]) {
        await page.evaluate(direction => window.__moonda.lander.look(direction, 0), direction);
        await page.waitForFunction(direction => {
          const pose = window.__roverLink.pose;
          return Math.abs(((pose.camAz - direction + 540) % 360) - 180) < .025;
        }, { timeout: 3000 }, direction);
        await sleep(500);
        table.push(await page.evaluate(({ mode, direction }) => ({ mode, requestedCameraDeg: direction,
          pose: { camAz: window.__roverLink.pose.camAz, headingDeg: window.__roverLink.pose.headingDeg },
          round: window.__moondaMinimap.getBearings(), full: window.__moondaSurfaceMap.getBearings(),
          commands: ['__moondaMinimap','__moondaSurfaceMap'].map(key => {
            const trace = { map:key, coneScreenDeg:NaN, arrowScreenDeg:NaN };
            const context = new Proxy({
              arc(_x,_y,r,a,b) { if(r===49) trace.coneScreenDeg=((a+b)/2+Math.PI/2)*180/Math.PI; },
              rotate(a) { trace.arrowScreenDeg=a*180/Math.PI; },
              createRadialGradient() { return { addColorStop(){} }; }
            }, { get:(object,key)=>key in object?object[key]:(()=>{}) });
            window[key].drawRover(context); return trace;
          }) }), { mode, direction }));
      }
    }
    const gap=(a,b)=>Math.abs(((a-b+540)%360)-180);
    for(const row of table){
      for(const command of row.commands){const model=command.map==='__moondaMinimap'?row.round:row.full;
        if(gap(command.coneScreenDeg,model.coneScreenDeg)>.02||gap(command.arrowScreenDeg,model.arrowScreenDeg)>.02)throw Error('Drawn camera or rover bearing disagrees with its model');}
      if(gap(row.round.coneScreenDeg,0)>.02||gap(row.round.cameraDeg,row.pose.camAz)>.05||gap(row.round.roverDeg,row.pose.headingDeg)>.05)throw Error('Round map camera-up or pose bearing check failed');
    }
    result.evals.coneChecks = table;
    writeFileSync(join(out, 'cone-bearings.json'), JSON.stringify(table, null, 2));
    writeFileSync(join(out, 'cone-bearings.csv'), 'mode,requestedCameraDeg,poseCamAz,poseHeadingDeg,round,full\n' + table.map(row => [row.mode, row.requestedCameraDeg,
      row.pose.camAz, row.pose.headingDeg, JSON.stringify(row.round).replaceAll(',', ';'), JSON.stringify(row.full).replaceAll(',', ';')].join(',')).join('\n') + '\n');
  };
  const session = await page.createCDPSession();
  try {
    if (step.proof) {
      const states=[], pixelChecks=[], mapIds=['psr','waterice','danger','slope','craters','height'];
      const record=async(name,source)=>{const state=await page.evaluate(({name,source,ids})=>{
        const m=window.__moondaSurfaceMap,mini=window.__moondaMinimap;
        return {name,source,time:new Date().toISOString(),elapsedMs:performance.now(),app:window.__moondaTest.state(),
          full:m?.getDiagnostics?.(),mini:mini?.getDiagnostics?.(),sun:m?.sun?{...m.sun}:null,
          chips:Object.fromEntries(ids.map(id=>[id,document.querySelector('.sm-layers #layer-'+id)?.checked??null])),
          strength:Object.fromEntries(ids.map(id=>[id,document.querySelector('#layer-'+id)?.closest('.layer')?.querySelector('input[type=range]')?.value??null])),
          box:Object.fromEntries(ids.map(id=>[id,document.querySelector('#layer-'+id)?.checked??null]))};
      },{name,source,ids:mapIds});states.push(state);writeFileSync(join(out,'layer-states.json'),JSON.stringify(states,null,2));return state;};
      const layers=async wanted=>{
        // The big map's switches are in its Layers box now (the row of chips is gone): open the box, then use them.
        await page.evaluate(()=>{const open=document.querySelector('.sm-layers-btn');if(!open)throw Error('Missing the map\'s Layers button');if(open.getAttribute('aria-expanded')!=='true')open.click();});
        await page.waitForSelector('.sm-layers',{timeout:5000});
        for(const id of mapIds){const target=wanted.includes(id);await page.evaluate(({id,target})=>{const box=document.querySelector('.sm-layers #layer-'+id);if(!box)throw Error('Missing map switch: '+id);if(box.checked!==target)box.click();},{id,target});}
        await page.waitForFunction(wanted=>{const d=window.__moondaSurfaceMap?.getDiagnostics?.();return d&&['psr','waterice','danger','slope','craters','height'].every(id=>d.layers.includes(id)===wanted.includes(id));},{timeout:5000},wanted);
      };
      const rasterReady=async(name,engine='__moondaSurfaceMap')=>{
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        try {await page.waitForFunction(({engine})=>{
          const m=window[engine],d=m?.getDiagnostics?.(),retained=m?.getRasterDiagnostics?.();
          if(!m||!d||!retained)return false;
          const ids=['psr','waterice','danger','slope','height'].filter(id=>d.layers.includes(id)),checks=[];
          for(const id of ids){
            const sourceLayers=id==='height'?['height','heightGlobal','heightPolar']:[id],stats={tiles:0,bytes:0,pending:0},data={tiles:0,nonzeroAlphaSamples:0,alphaSum:0};
            for(const source of sourceLayers){const a=d.imagery.scienceByLayer?.[source],b=retained[source];if(a){stats.tiles+=a.tiles??0;stats.bytes+=a.bytes??0;stats.pending+=a.pending??0;}if(b){data.tiles+=b.tiles;data.nonzeroAlphaSamples+=b.nonzeroAlphaSamples;data.alphaSum+=b.alphaSum;}}
            checks.push({id,sourceLayers,stats,visibleCachedTiles:data.tiles,examinedTiles:data.tiles,nonzeroAlphaSamples:data.nonzeroAlphaSamples,alphaSum:data.alphaSum});
          }
          const pixels=new OffscreenCanvas(Math.min(512,m.canvas.width),Math.max(1,Math.round(Math.min(512,m.canvas.width)*m.canvas.height/m.canvas.width))),pctx=pixels.getContext('2d',{willReadFrequently:true});
          pctx.drawImage(m.canvas,0,0,pixels.width,pixels.height);const rgba=pctx.getImageData(0,0,pixels.width,pixels.height).data;
          let colouredSamples=0,samples=0;const centre=m.screenAt(window.__roverLink.pose.lat,window.__roverLink.pose.lon),sx=centre?.x/m.width*pixels.width,sy=centre?.y/m.height*pixels.height;
          for(let y=0;y<pixels.height;y+=2)for(let x=0;x<pixels.width;x+=2){if(Number.isFinite(sx+sy)&&Math.hypot(x-sx,y-sy)<32*pixels.width/m.width)continue;const i=(y*pixels.width+x)*4;if(rgba[i+3]<128)continue;samples++;const hi=Math.max(rgba[i],rgba[i+1],rgba[i+2]),lo=Math.min(rgba[i],rgba[i+1],rgba[i+2]);if(hi-lo>12)colouredSamples++;}
          const colourThreshold=engine==='__moondaMinimap'?8:Math.max(80,samples*.0004),ready=checks.every(c=>c.stats?.tiles>0&&c.visibleCachedTiles>0&&c.nonzeroAlphaSamples>0)&&(!ids.length||colouredSamples>=colourThreshold);
          window.__proofRasterSample={engine,checks,colouredSamples,samples,colourThreshold,ready,diagnostics:d};return ready;
        },{timeout:20000,polling:350},{engine});}
        catch(error){const detail=await page.evaluate(()=>window.__proofRasterSample??null);pixelChecks.push({name,failed:true,...detail});writeFileSync(join(out,'raster-pixels.json'),JSON.stringify(pixelChecks,null,2));throw Error('Layer pixels did not arrive within 20 seconds: '+name+' '+JSON.stringify(detail));}
        const detail=await page.evaluate(()=>{const m=window[window.__proofRasterSample.engine],errors=[];for(const [source,gl] of [['map',m.basePlane?.gl],['scene',window.__viewer?.scene?.context?._gl]])if(gl)for(let i=0;i<16;i++){const code=gl.getError();if(!code)break;errors.push({source,code});}return {...window.__proofRasterSample,glErrors:errors};});
        pixelChecks.push({name,...detail});writeFileSync(join(out,'raster-pixels.json'),JSON.stringify(pixelChecks,null,2));if(detail.glErrors.length)throw Error('WebGL errors after '+name+': '+JSON.stringify(detail.glErrors));
      };
      const frame=async(across,name)=>{await page.evaluate(across=>{const m=window.__moondaSurfaceMap;m.setAcross(across==='whole'?m.getZoomLimits().max:across);m.centre();},across);await rasterReady(name);await record(name,'shared app state and nonzero cached/rendered raster pixels');await photograph(name);};
      if(step.layerExtra){
        await land(-5.3,63.48);await layers(['slope']);await frame('whole','whole-moon-slope-poles-fixed');
        await layers(['height']);await frame(300000,'mid-height-colours');
        result.evals.layerExtra={screenshots,rasterPixels:join(out,'raster-pixels.json'),states:join(out,'layer-states.json')};save();return JSON.stringify(result.evals.layerExtra);
      }
      await land(-89.45,-137.3);
      await layers([]);
      let recorder;
      try {
        recorder=await page.screencast({path:join(out,'shared-layer-switches.webm'),format:'webm',fps:10,scale:.5,quality:34,ffmpegPath:'/opt/homebrew/bin/ffmpeg'});
        await record('switch-start','surface map chips');await layers(['psr']);await sleep(500);await record('map-psr-on','surface map PSR chip');
        await page.keyboard.press('m');await sleep(260);await page.evaluate(()=>window.__moondaTest.exit());
        await page.waitForFunction(()=>!window.__moondaTest.state().standing,{timeout:280000});
        await page.evaluate(()=>{const button=[...document.querySelectorAll('button.tb')].find(button=>button.textContent.trim()==='Layers');if(!button)throw Error('Layers toolbar button not found');button.click();});
        await page.waitForSelector('#layer-psr',{timeout:6000});await sleep(350);
        const mapToBox=await record('layers-box-psr-on','Layers box checkbox');if(mapToBox.box.psr!==true)throw Error('Map PSR switch was not shared with Layers box');
        await page.focus('.layer:has(#layer-psr) input[type="range"]');await page.keyboard.press('Home');for(let i=0;i<5;i++)await page.keyboard.press('ArrowRight');await sleep(150);
        const strength=await record('layers-box-psr-strength-45','Layers box strength range');if(Math.abs(Number(strength.strength.psr)-.45)>1e-6)throw Error('PSR strength did not become 45%');
        await page.click('label[for="layer-psr"]');await sleep(350);
        const boxOff=await record('layers-box-psr-off','Layers box checkbox');if(boxOff.box.psr!==false)throw Error('Layers box PSR did not switch off');
        await page.evaluate(()=>{const sun=document.querySelector('.ctl-sun');if(sun?.getAttribute('aria-checked')!=='true')sun?.click();});
        await land(-89.45,-137.3);await sleep(350);
        const boxToMap=await record('map-psr-off','surface map reflects Layers box');if(boxToMap.chips.psr!=='false'||boxToMap.full.layers.includes('psr'))throw Error('Layers box switch was not shared with map');
        if(Math.abs(boxToMap.full.opacity.psr-.45)>1e-6||Math.abs(boxToMap.mini.opacity.psr-.45)>1e-6)throw Error('PSR strength was not shared with both map engines');
      } finally {if(recorder)await recorder.stop();}
      await layers(['psr']);await frame(30000,'south-psr');
      await layers(['waterice']);await frame(90000,'south-water-ice');
      await page.keyboard.press('m');await sleep(300);await page.evaluate(()=>window.__moondaMinimap.setAcross(90000));await rasterReady('round-water-ice','__moondaMinimap');await record('round-water-ice','round map shares app Water ice state');await photograph('round-water-ice');
      await page.keyboard.press('m');await page.waitForFunction(()=>!!window.__moondaSurfaceMap,{timeout:6000});await sleep(260);
      await land(89.45,40);
      await layers(['psr']);await frame(90000,'north-psr');
      await layers(['waterice']);await frame(120000,'north-water-ice');
      await land(-5.3,63.48);
      await layers(['slope']);await frame(300000,'mid-slope');
      await layers(['danger']);await frame(300000,'mid-danger-zones');
      await layers(['slope']);await frame('whole','whole-moon-slope');
      await layers([]);
      const start=await page.evaluate(()=>window.__moondaTest.state().arrival);
      await page.evaluate(ms=>window.__moondaTest.setTime(ms),start);await sleep(1000);await frame('whole','whole-moon-sun-week-0');
      await page.evaluate(ms=>window.__moondaTest.setTime(ms),start+7*86400000);await sleep(1000);await frame('whole','whole-moon-sun-week-1');
      const last=states.at(-1), prior=states.at(-2);if(!last.full.realSun||!prior.full.realSun)throw Error('Real sunlight was not enabled in app state');
      if(JSON.stringify(last.sun)===JSON.stringify(prior.sun))throw Error('Time change did not reach map Sun direction');
      await layers(['slope']);await page.evaluate(()=>window.__moondaTest.setLanguage('km'));await sleep(200);await frame(300000,'khmer-slope');
      result.evals.layerProof={recording:join(out,'shared-layer-switches.webm'),states:join(out,'layer-states.json'),screenshots,sharedBothDirections:true,sharedStrength:.45,rasterPixels:join(out,'raster-pixels.json')};
      save();return JSON.stringify(result.evals.layerProof);
    }
    if (step.round5) {
      await land(-89.45, -137.3);
      await page.evaluate(() => { const m=window.__moondaSurfaceMap; m.setAcross(200); m.centre(); });
      await sleep(1000);
      const setup = await page.evaluate(variant => {
        const m=window.__moondaSurfaceMap, mini=window.__moondaMinimap, viewer=window.__viewer, lander=window.__moonda.lander;
        const backdrop=document.querySelector('.sm-backdrop'), originals=[], timing={map:[],mini:[],scene:[],lander:[]};
        const wrap=(object,key,bucket)=>{if(!object||typeof object[key]!=='function')return;const original=object[key];originals.push(()=>object[key]=original);object[key]=function(...args){const t=performance.now();try{return original.apply(this,args)}finally{timing[bucket].push({t,ms:performance.now()-t})}}};
        wrap(m,'draw','map');wrap(mini,'draw','mini');wrap(viewer.scene,'render','scene');wrap(lander,'tick','lander');
        const initial={variant,dpr:devicePixelRatio,canvas:[m.canvas.width,m.canvas.height],css:[m.width,m.height],backdropFilter:backdrop?getComputedStyle(backdrop).backdropFilter:null,
          viewerLoop:viewer.useDefaultRenderLoop,requestRenderMode:viewer.scene.requestRenderMode,landerRaf:lander.raf,landerPhase:lander.phase};
        let style='',loop=viewer.useDefaultRenderLoop,tick=lander.tick;
        const originalDensity={dpr:m.dpr,width:m.canvas.width,height:m.canvas.height};
        if(variant==='dpr1'){m.dpr=1;m.canvas.width=Math.round(m.width);m.canvas.height=Math.round(m.height);m.photoDirty=true;m.requestDraw();}
        if(variant.includes('no-blur')&&backdrop){style=backdrop.style.cssText;backdrop.style.setProperty('backdrop-filter','none','important');backdrop.style.setProperty('-webkit-backdrop-filter','none','important');}
        if(variant.includes('no-3d')){viewer.useDefaultRenderLoop=false;cancelAnimationFrame(lander.raf);lander.raf=0;lander.tick=()=>{lander.raf=0;};}
        if(variant.includes('no-react')){const onChange=m.options.onChange;originals.push(()=>m.options.onChange=onChange);m.options.onChange=()=>{};}
        if(variant.includes('no-polar')){const drawPolar=m.drawPolar;originals.push(()=>m.drawPolar=drawPolar);m.drawPolar=()=>{};m.photoDirty=true;m.requestDraw();}
        if(variant.includes('no-light')){const realSun=m.realSun,drawSunlight=m.drawSunlight;originals.push(()=>{m.realSun=realSun;m.drawSunlight=drawSunlight;m.requestDraw();});m.realSun=false;m.drawSunlight=()=>{};m.requestDraw();}
        if(variant.includes('gpu-polar')){const drawPolar=m.drawPolar;originals.push(()=>m.drawPolar=drawPolar);m.drawPolar=function(...args){const projection=this.projection,blend=projection?.blend;if(projection&&blend===0)projection.blend=Number.EPSILON;try{return drawPolar.apply(this,args);}finally{if(projection)projection.blend=blend;}};m.photoDirty=true;m.requestDraw();}
        const applied={deviceDpr:devicePixelRatio,canvasDpr:m.dpr,canvas:[m.canvas.width,m.canvas.height],css:[m.width,m.height],backdropFilter:backdrop?getComputedStyle(backdrop).backdropFilter:null,viewerLoop:viewer.useDefaultRenderLoop,landerRaf:lander.raf,realSun:m.realSun,polarDetailSuppressed:variant.includes('no-polar'),polarGpuForced:variant.includes('gpu-polar'),lightDrawSuppressed:variant.includes('no-light'),reactChangeSuppressed:variant.includes('no-react')};
        window.__round5={timing,initial,applied,holdEnds:variant.endsWith('final'),restore(){if(variant==='dpr1'){m.dpr=originalDensity.dpr;m.canvas.width=originalDensity.width;m.canvas.height=originalDensity.height;m.photoDirty=true;m.requestDraw();}if(backdrop&&variant.includes('no-blur'))backdrop.style.cssText=style;if(variant.includes('no-3d')){lander.tick=tick;lander.lastTick=performance.now();viewer.useDefaultRenderLoop=loop;lander.kick();}for(const restore of originals.reverse())restore();}};
        return {...initial,applied};
      }, step.variant);
      result.evals.round5Setup=setup;
      let tracing=false;
      try {
        if(step.trace){await page.tracing.start({path:join(out,'performance-trace.json'),screenshots:false,categories:['devtools.timeline','toplevel','v8','cc','gpu','blink.user_timing','disabled-by-default-devtools.timeline','disabled-by-default-devtools.timeline.frame']});tracing=true;await page.evaluate(()=>window.__round5.trace=true);result.evals.performanceTrace=join(out,'performance-trace.json');}
        const measured=await page.evaluate(async () => {
          const m=window.__moondaSurfaceMap,state=window.__round5, frames=[], start=performance.now();
          if(state.trace)performance.mark('map-check:start');
          const phases=[['zoom-out',200,m.getZoomLimits().max],['zoom-in',m.getZoomLimits().max,200],['pan',10000,10000]], duration=3000;
          let previous=0, frame=0, lastCounts={map:0,mini:0,scene:0,lander:0};
          for(const [name,from,to] of phases){
            m.stopMotion();m.setAcross(from);m.centre();
            if(name==='pan')await new Promise(resolve=>setTimeout(resolve,200));
            const phaseStart=performance.now();let previousProgress=0;previous=0;
            if(state.trace)performance.mark('map-check:'+name+':start');
            await new Promise(resolve=>{
              const step=now=>{
                const progress=Math.min(1,(now-phaseStart)/duration), target=from*Math.exp(Math.log(to/from)*progress);
                if(name==='pan'){const delta=progress-previousProgress;m.pan(Math.cos(progress*Math.PI*2)*delta*m.width*.7,Math.sin(progress*Math.PI*2)*delta*m.height*.5);}
                else m.zoomAt((m.zoomTarget??m.getAcross())/target,m.width*.5,m.height*.5);
                const costs={};for(const bucket of ['map','mini','scene','lander']){const values=state.timing[bucket];costs[bucket+'Ms']=values.slice(lastCounts[bucket]).reduce((sum,d)=>sum+d.ms,0);costs[bucket+'Calls']=values.length-lastCounts[bucket];lastCounts[bucket]=values.length;}
                if(state.trace&&previous&&now-previous>20)performance.mark('map-check:slow',{detail:{phase:name,frame,acrossM:m.getAcross(),frameMs:now-previous}});
                frames.push({phase:name,frame:frame++,nowMs:now,elapsedMs:now-start,phaseMs:now-phaseStart,frameMs:previous?now-previous:0,acrossM:m.getAcross(),targetM:target,...costs});
                previous=now;previousProgress=progress;
                if(progress<1)requestAnimationFrame(step);else resolve();
              };requestAnimationFrame(step);
            });
            if(state.trace){performance.mark('map-check:'+name+':end');performance.measure('map-check:'+name,'map-check:'+name+':start','map-check:'+name+':end');}
            if(state.holdEnds&&name!=='pan'){
              const holdStart=performance.now();
              await new Promise(resolve=>{const hold=now=>{
                const costs={};for(const bucket of ['map','mini','scene','lander']){const values=state.timing[bucket];costs[bucket+'Ms']=values.slice(lastCounts[bucket]).reduce((sum,d)=>sum+d.ms,0);costs[bucket+'Calls']=values.length-lastCounts[bucket];lastCounts[bucket]=values.length;}
                frames.push({phase:name+'-hold',frame:frame++,nowMs:now,elapsedMs:now-start,phaseMs:now-holdStart,frameMs:now-previous,acrossM:m.getAcross(),targetM:to,...costs});previous=now;
                if(now-holdStart<700)requestAnimationFrame(hold);else resolve();
              };requestAnimationFrame(hold);});
            }
          }
          return {frames,timing:state.timing,diagnostics:m.getDiagnostics?.(),setup:state.initial,appliedSetup:state.applied,checkStartMs:start};
        });
        const summarise=values=>{const sorted=values.slice().sort((a,b)=>a-b);return {count:values.length,meanMs:values.reduce((a,b)=>a+b,0)/Math.max(1,values.length),medianMs:sorted[Math.floor(sorted.length*.5)]??0,p95Ms:sorted[Math.floor(sorted.length*.95)]??0,maxMs:sorted.at(-1)??0,over20ms:values.filter(x=>x>20).length,over33ms:values.filter(x=>x>33.34).length};};
        const table=[...new Set(measured.frames.map(frame=>frame.phase))].map(phase=>{const values=measured.frames.filter(f=>f.phase===phase&&f.frameMs>0);return {phase,frames:summarise(values.map(f=>f.frameMs)),mapWork:summarise(values.map(f=>f.mapMs)),sceneWork:summarise(values.map(f=>f.sceneMs)),landerWork:summarise(values.map(f=>f.landerMs)),miniWork:summarise(values.map(f=>f.miniMs))};});
        const report={variant:step.variant,setup,table,...measured};
        writeFileSync(join(out,'whole-frame-timings.json'),JSON.stringify(report,null,2));
        const keys=['phase','frame','nowMs','elapsedMs','phaseMs','frameMs','acrossM','targetM','mapMs','mapCalls','miniMs','miniCalls','sceneMs','sceneCalls','landerMs','landerCalls'];
        writeFileSync(join(out,'whole-frame-timings.csv'),keys.join(',')+'\n'+measured.frames.map(f=>keys.map(k=>f[k]).join(',')).join('\n')+'\n');
        result.evals.round5={variant:step.variant,setup,table};
        return JSON.stringify(result.evals.round5);
      } finally {if(tracing)await page.tracing.stop().catch(error=>{result.evals.traceStopError=String(error);});await page.evaluate(()=>window.__round5?.restore());}
    }
    if(step.driveOnly) {
      await land(-89.45,-137.3);await page.keyboard.press('m');await sleep(350);
      await page.evaluate(()=>{window.__landerLink.setWalk(true);window.__landerLink.setView('third');});await sleep(1000);
      await page.evaluate(()=>{const m=window.__moondaMinimap,old=m.draw;window.__miniCpu=[];m.draw=function(){const t=performance.now();try{return old.call(this)}finally{window.__miniCpu.push(performance.now()-t)}};});
      const samples=[];
      await page.keyboard.down('w');
      try {
        await sleep(3000);
        for(const [name,active] of [['on1',true],['off',false],['on2',true]]){
          await page.evaluate(active=>{window.__moondaMinimap.setActive(active);document.querySelector('.sm-mini').style.visibility=active?'':'hidden';},active);
          const start=await page.evaluate(()=>({...window.__roverLink.pose}));
          await startMeasure();await sleep(3000);const timing=await stopMeasure();
          const end=await page.evaluate(()=>({...window.__roverLink.pose}));samples.push({name,active,timing,movedM:Math.hypot(end.e-start.e,end.n-start.n)});
        }
      } finally {await page.keyboard.up('w');await page.evaluate(()=>{window.__moondaMinimap.setActive(true);document.querySelector('.sm-mini').style.visibility='';});}
      const cpu=await page.evaluate(()=>window.__miniCpu),on=(samples[0].timing.fps+samples[2].timing.fps)/2;
      const driving={samples,onFps:on,offFps:samples[1].timing.fps,offMinusOn:samples[1].timing.fps-on,drawCpu:{draws:cpu.length,mean:cpu.reduce((a,b)=>a+b,0)/cpu.length,max:Math.max(...cpu)}};
      result.evals.driving=driving;writeFileSync(join(out,'driving-fps.json'),JSON.stringify(driving,null,2));await photograph('round-driving');save();return JSON.stringify(driving);
    }
    if(step.shotsOnly) {
      for(const [name,lat,lon] of [['connecting-ridge',-89.45,-137.3],['apollo11',.674,23.473],['owner',-36.03,19.44]]) {
        await land(lat,lon);
        await page.evaluate(()=>{const m=window.__moondaSurfaceMap;m.setAcross(300000);m.centre();});await sleep(3000);await photograph(`${name}-mid`);
        if(name==='connecting-ridge'){await page.evaluate(()=>{const m=window.__moondaSurfaceMap;m.setAcross(1800000);m.centre();});await sleep(2500);await photograph('connecting-ridge-transition');}
        await page.evaluate(()=>{const m=window.__moondaSurfaceMap;m.setAcross(m.getZoomLimits().max);m.centre();});await sleep(200);await photograph(`${name}-far`);
      }
      save();return 'Three places, loaded mid photos and flat whole Moon';
    }
    await land(-89.45, -137.3);
    result.evals.instrumentedMethods = await instrument();
    await page.evaluate(() => { window.__moondaSurfaceMap.setAcross(200); window.__moondaSurfaceMap.centre(); });
    await sleep(500);
    await session.send('Profiler.enable'); await session.send('Profiler.setSamplingInterval', { interval: 400 }); await session.send('Profiler.start');
    await gesture('200m-to-whole-moon', 1e-6);
    await photograph('connecting-ridge-far');
    const reverseFactor = await page.evaluate(() => window.__moondaSurfaceMap.getAcross()/200);
    await gesture('whole-moon-to-200m', reverseFactor, true);
    if(step.phase==='after'){await page.evaluate(()=>{const m=window.__moondaSurfaceMap;m.setAcross(200);m.centre();});await gesture('200m-to-1800km-with-detail',1/9000,false,true);result.evals.mediumGpu=await page.evaluate(()=>window.__moondaSurfaceMap.getDiagnostics());}
    const { profile } = await session.send('Profiler.stop');
    writeFileSync(join(out, 'engine.cpuprofile'), JSON.stringify(profile));
    await page.evaluate(() => window.__mapEngineCheck.restore());
    if (step.phase === 'after') {
      const inputSetup = await page.evaluate(() => {
        const m=window.__moondaSurfaceMap,c=m.canvas,r=c.getBoundingClientRect();
        m.setAcross(10000); m.centre();
        const x=r.width*.57,y=r.height*.51;
        window.__engineWheel={events:[],start:m.getAcross(),point:m.pointAt(x,y),x,y};
        c.addEventListener('wheel',event=>{const r=c.getBoundingClientRect();const x=(event.clientX-r.left)*m.width/r.width,y=(event.clientY-r.top)*m.height/r.height;window.__engineWheel.events.push({delta:event.deltaY,ctrl:event.ctrlKey,immediateM:m.getAcross(),x,y,ground:m.pointAt(x,y)});});
        return {x:r.left+x,y:r.top+y};
      });
      await page.mouse.move(inputSetup.x,inputSetup.y); await page.mouse.wheel({deltaY:240}); await settle();
      const notch=await page.evaluate(()=>{
        const s=window.__engineWheel,m=window.__moondaSurfaceMap;
        return {...s,end:m.getAcross(),pointAfter:m.pointAt(s.events[0].x,s.events[0].y)};
      });
      await page.keyboard.down('Control');
      try { await page.mouse.wheel({deltaY:-40}); await sleep(100); }
      finally { await page.keyboard.up('Control'); }
      const pinch=await page.evaluate(()=>({...window.__engineWheel,end:window.__moondaSurfaceMap.getAcross()}));
      result.evals.wheelInput={notch,pinch};
      await page.evaluate(()=>{const m=window.__moondaSurfaceMap;m.setAcross(1800000);m.centre();});
      await sleep(1800);if(!step.extras)await photograph('connecting-ridge-transition');
      await page.evaluate(()=>{const m=window.__moondaSurfaceMap;m.setAcross(60);m.centre();});
      await sleep(300);if(!step.extras)await photograph('connecting-ridge-60m');
    }
    await page.evaluate(() => window.__moondaSurfaceMap.setAcross(300000)); await sleep(3000); await photograph('connecting-ridge-mid');
    if (step.phase === 'after') {
      if (step.extras) {
        await page.evaluate(()=>{const m=window.__moondaSurfaceMap;m.setAcross(10000);m.centre();
          const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='PSR');button?.click();});
        await sleep(500);await photograph('polar-overlay');
        await page.evaluate(()=>{const m=window.__moondaSurfaceMap;m.setAcross(m.getZoomLimits().max);m.centre();});await sleep(200);await photograph('polar-overlay-far');
        await page.evaluate(()=>{const m=window.__moondaSurfaceMap;m.setAcross(10000);m.centre();});await sleep(150);
        const destination=await page.evaluate(()=>{const m=window.__moondaSurfaceMap,r=m.canvas.getBoundingClientRect();return {x:r.x+r.width*.65,y:r.y+r.height*.39};});
        await page.mouse.click(destination.x,destination.y);
        await page.waitForFunction(()=>window.__moondaSurfaceMap.route?.ok,{timeout:60000});
        await photograph('polar-route');
        result.evals.routePreserved=await page.evaluate(()=>{const r=window.__moondaSurfaceMap.route;return {ok:r.ok,lengthM:r.lengthM,points:r.path.length/2};});
        const hover=await page.evaluate(()=>{const m=window.__moondaSurfaceMap,r=m.route,c=m.canvas.getBoundingClientRect();let k=Math.floor(r.path.length/4)*2;
          const p=m.screenAt(r.path[k],r.path[k+1]);return {x:c.x+p.x,y:c.y+p.y,hit:m.hoverAt(p.x,p.y)};});
        await page.mouse.move(hover.x,hover.y);await sleep(250);result.evals.routeHover=hover.hit;
      }
      for (const [name, lat, lon] of [['apollo11', .674, 23.473], ['owner', -36.03, 19.44]]) {
        await land(lat, lon);
        await page.evaluate(() => window.__moondaSurfaceMap.setAcross(300000)); await sleep(3000); await photograph(`${name}-mid`);
        await page.evaluate(() => { const m = window.__moondaSurfaceMap; m.setAcross(m.getZoomLimits().max); }); await sleep(400); await photograph(`${name}-far`);
      }
      await page.evaluate(() => { const m = window.__moondaSurfaceMap; m.setAcross(10000); m.centre(); });
      await coneChecks();
      if(step.extras) {
        await page.evaluate(()=>window.__moondaTest.setLanguage('km'));await sleep(150);await photograph('khmer-engine');
        await page.keyboard.press('m');await sleep(300);
        const before=await page.evaluate(()=>window.__roverLink.pose.camAz);
        await page.mouse.move(300,300);await page.mouse.down();
        for(let i=1;i<=16;i++){await page.mouse.move(300+160*i/16,300+60*i/16);await sleep(16);}
        await page.mouse.up();await sleep(300);
        result.evals.freeLook=await page.evaluate(before=>({before,pose:{...window.__roverLink.pose},drawn:window.__moondaMinimap.getBearings()}),before);
        await photograph('round-free-look');
        await page.evaluate(()=>{const m=window.__moondaMinimap;window.__miniDraws=[];const draw=m.draw;m.draw=function(){let t=performance.now();try{return draw.call(this)}finally{window.__miniDraws.push({metres:m.getAcross(),ms:performance.now()-t})}};m.zoomAt(1e-8);});
        await page.waitForFunction(()=>Math.abs(window.__moondaMinimap.getAcross()-300000)<1,{timeout:5000});
        await sleep(200);await photograph('round-300km');
        result.evals.minimapZoom=await page.evaluate(()=>({draws:window.__miniDraws,span:window.__moondaMinimap.getAcross(),bearings:window.__moondaMinimap.getBearings(),diagnostics:window.__moondaMinimap.getDiagnostics()}));
      }
    }
    result.evals.engineDiagnostics = await page.evaluate(() => (window.__moondaSurfaceMap ?? window.__moondaMinimap)?.getDiagnostics?.() ?? null);
    save();
    if(step.phase==='after'&&totals.some(t=>t.over8msFrames))throw Error('Map work exceeded 8 ms in a measured animation frame; see engine-timings.json');
    return JSON.stringify({ phase: step.phase, gestures: totals.map(t => ({ name: t.gesture, meanMs: t.meanMs, p95Ms: t.p95Ms, maxMs: t.maxMs })), screenshots: screenshots.length });
  } finally {
    await page.evaluate(() => window.__mapEngineCheck?.restore?.()).catch(() => {});
    save();
  }
}

let source = readFileSync(join(app, 'scripts/drive.mjs'), 'utf8');
const patch = (before, after) => { if (!source.includes(before)) throw Error(`Harness changed: ${before}`); source = source.replace(before, after); };
patch("import puppeteer from 'puppeteer-core';", `import puppeteer from '${pathToFileURL(require.resolve('puppeteer-core')).href}';`);
// Keep the same atomic shared lease and launch guard. Poll outside Chrome frequently enough
// to get a turn between another session's back-to-back runs; no extra browser waits in memory.
const leaseFile = join(outDir, 'browser-lease.mjs');
writeFileSync(leaseFile, readFileSync(join(app, 'scripts/browserLease.mjs'), 'utf8').replace('Math.min(1000, Math.max(1, timeoutMs', 'Math.min(100, Math.max(1, timeoutMs'));
patch("import { acquireBrowserLease } from './browserLease.mjs';", `import { acquireBrowserLease } from '${pathToFileURL(leaseFile).href}';`);
patch('const ready = async (timeout = 30000) => {', `${engineStep.toString()}\nconst ready = async (timeout = 30000) => {`);
patch("acquireBrowserLease({script:'drive.mjs',noteDir:out})", "acquireBrowserLease({script:'check-map-engine.ts',noteDir:out,timeoutMs:600000})");
patch('await page.goto(baseUrl,', `await page.evaluateOnNewDocument(() => {
  try { localStorage.setItem('moonda.tutorial.v1', 'done'); } catch {}
  const Socket = window.WebSocket;
  window.WebSocket = class extends Socket { constructor(...args) { super(...args); this.addEventListener('message', ev => { try { if (['update', 'full-reload', 'prune', 'error'].includes(JSON.parse(ev.data).type)) ev.stopImmediatePropagation(); } catch {} }); } };
});
await page.goto(baseUrl,`);
patch("if (s.do === 'goto')", "if (s.do.startsWith('engine:')) note = await engineStep(s); else if (s.do === 'goto')");
const harness = join(outDir, 'engine-harness.mjs');
writeFileSync(harness, source);
if (args.includes('--prepare')) console.log(`Prepared ${phase} engine check: ${outDir}`);
else {
  process.argv = ['node', join(app, 'scripts/drive.mjs'), join(outDir, 'scenario.json'), '--out', outDir, '--width', String(width), '--height', String(height)];
  await import(pathToFileURL(harness).href);
  const result = JSON.parse(readFileSync(join(outDir, 'result.json'), 'utf8'));
  // The harness has closed Chrome and released the lease before this light image resize.
  for (const file of result.shots) execFileSync('/usr/bin/sips', ['-z', String(height), String(width), file], { stdio: 'ignore' });
  if (result.errors.length || result.steps.some(s => s.note?.startsWith('ERROR') || s.note?.includes('TIMED OUT'))) process.exitCode = 1;
}
