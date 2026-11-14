// Real wheel/drag motion proof on the existing dev server. Never starts a server or build.
// node data-prep/features/scripts/check_crater_motion.mjs before|after <output-folder>
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireBrowserLease } from '../../../app/scripts/browserLease.mjs';
const require = createRequire(new URL('../../../app/package.json', import.meta.url));
const puppeteer = require('puppeteer-core');
const mode = process.argv[2], out = process.argv[3];
if (!['before', 'after'].includes(mode) || !out) throw Error('Give before|after and output folder');
const baseline = '/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/motion-before/craterLayer-baseline.js';
mkdirSync(out, { recursive: true });
const result = { mode, errors: [], actions: [], shots: [] };
let frozen;
if (mode === 'before') {
  const original = readFileSync(baseline, 'utf8');
  result.baselineModuleSha256 = createHash('sha256').update(original).digest('hex');
  const needle = 'this.canvas.__craterDiagnostics = () => this.diagnostics();';
  if (!original.includes(needle)) throw Error('Baseline diagnostics marker changed');
  frozen = original.replace(needle, needle + `
    this.canvas.__craterFrame = () => {
      const rings = this.paths.map(p => ({ id: [p.record.lat,p.record.lon,p.record.km].join(','), alpha:p.alpha, target:1, fading:false }));
      return { rings, ids:rings.map(p=>p.id), currentKey:this.view().key, paintedKey:this.pathKey,
        paintedAt:this.__qaPaintedAt||0, count:rings.length, baseline:true };
    };`).replace('this.paths = paths;', 'this.paths = paths; this.__qaPaintedAt = performance.now();');
}
const lease = await acquireBrowserLease({ script:`crater motion ${mode}`, noteDir:out, timeoutMs:30*60_000 });
let browser;
try {
  browser = await puppeteer.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true,
    userDataDir:mkdtempSync(join(tmpdir(), `moonda-motion-${mode}-`)), defaultViewport:{width:1440,height:900,deviceScaleFactor:2},
    args:['--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--no-first-run','--hide-scrollbars','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows'] });
  await lease.afterLaunch(browser);
  const page = (await browser.pages())[0];
  page.on('pageerror', e=>result.errors.push(e.stack||String(e)));
  page.on('console', m=>{if(m.type()==='error')result.errors.push(m.text());});
  await page.evaluateOnNewDocument(()=>{
    const Native = window.WebSocket;
    window.__craterHotUpdatesIgnored=0;
    window.WebSocket=class extends Native { constructor(url,protocols){super(url,protocols);if(protocols==='vite-hmr')this.addEventListener('message',event=>{let type;try{type=JSON.parse(event.data).type;}catch{return;}if(['update','full-reload','prune'].includes(type)){window.__craterHotUpdatesIgnored++;event.stopImmediatePropagation();}});}};
  });
  if (frozen) {
    await page.setRequestInterception(true);
    page.on('request',r=>new URL(r.url()).pathname==='/src/moon/craterLayer.ts'
      ? void r.respond({status:200,contentType:'text/javascript',body:frozen}) : void r.continue());
  }
  const wait = ms=>new Promise(r=>setTimeout(r,ms));
  await page.goto('http://127.0.0.1:5190/?start',{waitUntil:'domcontentloaded',timeout:180000});
  await page.waitForFunction(()=>window.__moonda?.progress?.done===true&&!!window.__moondaCesium,{timeout:280000});
  result.timeOrigin=await page.evaluate(()=>performance.timeOrigin);
  await page.evaluate(async()=>{
    [...document.querySelectorAll('button')].find(e=>/^(Just enter|Enter)$/.test(e.innerText.trim()))?.click();
    await new Promise(r=>setTimeout(r,400));
    const s=document.querySelector('.ctl-sun');if(s?.getAttribute('aria-checked')==='true')s.click();
    [...document.querySelectorAll('button')].find(e=>e.innerText.trim()==='Layers')?.click();
    await new Promise(r=>setTimeout(r,250));
    const c=document.querySelector('#layer-craters');if(c&&!c.checked)c.click();
    document.querySelector('.layers header button')?.click();
    document.activeElement?.blur();
  });
  await page.waitForFunction(()=>typeof document.querySelector('.moon-crater-rims')?.__craterFrame==='function',{timeout:30000});
  // A tiny reusable copy checks actual pixels without reading twenty megabytes on every frame.
  await page.evaluate(()=>{
    window.__motionDictionary=[];window.__motionDictionaryMap=new Map();window.__motionRows=[];window.__motionRunning=false;
    const probe=document.createElement('canvas');probe.width=192;probe.height=120;const pg=probe.getContext('2d',{willReadFrequently:true});
    const idNumber=id=>{let n=window.__motionDictionaryMap.get(id);if(n===undefined){n=window.__motionDictionary.length;window.__motionDictionary.push(id);window.__motionDictionaryMap.set(id,n);}return n;};
    const sample=(kind)=>{
      if(!window.__motionRunning)return;
      const c=document.querySelector('.moon-crater-rims'), f=c?.__craterFrame?.();if(!f)return;
      let raw=f.rings??f.drawn??(f.ids??[]).map(id=>({id,alpha:1}));
      const rings=raw.filter(r=>(r.alpha??1)>.001 && r.visible!==false);
      const ids=rings.map(r=>idNumber(String(r.id))), alphas=rings.map(r=>Math.round((r.alpha??1)*1000));
      const fading=rings.filter(r=>r.fading==='out'||r.target===0||r.target===false||r.fadingOut===true||r.sizeFading===true).map(r=>idNumber(String(r.id)));
      pg.clearRect(0,0,192,120);pg.drawImage(c,0,0,192,120);const pixels=pg.getImageData(0,0,192,120).data;let alphaPixels=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i])alphaPixels++;
      const p=window.__viewer.camera.positionWC,heightKm=(Math.hypot(p.x,p.y,p.z)-1737400)/1000;
      const row={t:performance.now(),kind,count:ids.length,ids,alphas,fading,alphaPixels,heightKm,
        stale:f.currentKey!==undefined&&f.paintedKey!==undefined&&f.currentKey!==f.paintedKey,
        paintedAt:f.paintedAt??null,frame:f.frame??f.sequence??f.serial??null,activePoolCount:Array.isArray(f.activePool)?f.activePool.length:(f.activePool??null),retiringPoolCount:f.fadingCount??null,diagnostic:f.diagnostic??undefined};
      window.__motionRows.push(row);
    };
    window.__motionRemove=window.__viewer.scene.postRender.addEventListener(()=>sample('postRender'));
    const raf=()=>{sample('raf');requestAnimationFrame(raf);};requestAnimationFrame(raf);
    window.__motionStart=()=>{window.__motionRows=[];window.__motionRunning=true;};
    window.__motionStop=()=>{window.__motionRunning=false;return window.__motionRows;};
  });
  const fly=async(heightKm,heading=0,pitch=-90)=>{
    await page.evaluate(async({heightKm,heading,pitch})=>{
      const {poseLookingAt}=await import('/src/moon/navigation.ts');const lat=7.3,lon=63.4;
      const h=window.__moonda.heights.heightAt(lat,lon,false),p=poseLookingAt(lat,lon,h,heightKm*1000-h,heading,pitch);
      window.__moonda.nav.cancel();window.__viewer.camera.setView({destination:p.destination,orientation:{direction:p.direction,up:p.up}});window.__viewer.scene.requestRender();
    },{heightKm,heading,pitch});
    await wait(4500);
    await page.waitForFunction(()=>{const c=document.querySelector('.moon-crater-rims');return c?.__craterFrame?.().ids?.length>0||Number(c?.dataset.rings)>0;},{timeout:60000});
    await wait(500);
  };
  const collect=async(name,fn)=>{
    await page.evaluate(()=>window.__motionStart());const start=Date.now();const gesture=await fn();await wait(700);
    const rows=await page.evaluate(()=>window.__motionStop());
    result.actions.push({name,elapsedMs:Date.now()-start,gesture,rows});
    // Save after every action so a later unrelated edit/error cannot erase the measurements.
    writeFileSync(join(out,'result-partial.json'),JSON.stringify(result));
  };
  await page.evaluate(()=>{window.__motionWheelEvents=[];window.__viewer.canvas.addEventListener('wheel',e=>window.__motionWheelEvents.push({deltaY:e.deltaY,deltaMode:e.deltaMode}),{passive:true});});
  await fly(800);
  const calibrationGround=await page.evaluate(()=>window.__moonda.heights.heightAt(7.3,63.4,false));
  await page.mouse.move(720,450);await page.mouse.wheel({deltaY:-30});await wait(1400);
  const calibratedHeight=await page.evaluate(()=>{const p=window.__viewer.camera.positionWC;return(Math.hypot(p.x,p.y,p.z)-1737400)/1000;});
  const zoomCoefficient=Math.log((calibratedHeight*1000-calibrationGround)/(800000-calibrationGround))/-30;
  result.wheelCalibration={requestedDeltaY:-30,events:await page.evaluate(()=>window.__motionWheelEvents),startHeightKm:800,endHeightKm:calibratedHeight,zoomCoefficient};
  if(!(zoomCoefficient>0.0001&&zoomCoefficient<0.01))throw Error('Wheel calibration is outside its expected range');
  const cdp=await page.createCDPSession();let shots=0,casting=false;
  cdp.on('Page.screencastFrame',event=>{
    void cdp.send('Page.screencastFrameAck',{sessionId:event.sessionId});
    if(shots>=6)return;
    const path=join(out,`zoom-mid-${String(shots+1).padStart(2,'0')}.png`);writeFileSync(path,Buffer.from(event.data,'base64'));
    result.shots.push({path,metadata:event.metadata});shots++;
    if(shots===6){casting=false;void cdp.send('Page.stopScreencast');}
  });
  const wheel=async(from,to,events,everyMs,takeShots=false)=>{
    const ground=await page.evaluate(()=>window.__moonda.heights.heightAt(7.3,63.4,false));
    const total=Math.log((to*1000-ground)/(from*1000-ground))/zoomCoefficient;
    await page.mouse.move(720,450);
    for(let i=0;i<events;i++){
      if(takeShots&&i===Math.floor(events*.40)){casting=true;await cdp.send('Page.startScreencast',{format:'png',maxWidth:1440,maxHeight:900,everyNthFrame:1});}
      await page.mouse.wheel({deltaY:total/events});await wait(everyMs);
    }
    await wait(1300);
    const heightKm=await page.evaluate(()=>{const p=window.__viewer.camera.positionWC;return(Math.hypot(p.x,p.y,p.z)-1737400)/1000;});
    return{fromKm:from,toKm:to,events,everyMs,deltaY:total/events,endHeightKm:heightKm,zoomCoefficient};
  };
  await fly(800);
  await collect('slow zoom in',()=>wheel(800,60,80,100,mode==='after'));
  await collect('slow zoom out',()=>wheel(60,800,80,100));
  await fly(800);
  await collect('fast zoom in',()=>wheel(800,60,16,20));
  await collect('fast zoom out',()=>wheel(60,800,16,20));
  await fly(200);
  await collect('pan',async()=>{
    await page.mouse.move(570,450);await page.mouse.down();
    for(let i=1;i<=100;i++){await page.mouse.move(570+400*i/100,450);await wait(30);}await wait(120);await page.mouse.up();await wait(500);
    return{from:[570,450],to:[970,450],steps:100,everyMs:30};
  });
  await fly(200,0,-75);
  await collect('turn',async()=>{
    await page.mouse.move(640,430);await page.mouse.down({button:'right'});
    for(let i=1;i<=100;i++){await page.mouse.move(640+220*i/100,430+60*i/100);await wait(30);}await wait(120);await page.mouse.up({button:'right'});await wait(500);
    return{from:[640,430],to:[860,490],steps:100,everyMs:30,button:'right'};
  });
  if(casting)await cdp.send('Page.stopScreencast');await cdp.detach();
  result.dictionary=await page.evaluate(()=>window.__motionDictionary);
  result.diagnostics=await page.evaluate(()=>document.querySelector('.moon-crater-rims')?.__craterDiagnostics?.());
  result.hotUpdatesIgnored=await page.evaluate(()=>window.__craterHotUpdatesIgnored);
  for(const action of result.actions){
    const summaries={};
    for(const kind of ['postRender','raf']){
      const rows=action.rows.filter(r=>r.kind===kind);let zero=0,stale=0,largeDrop=0,unfadedLargeDrop=0,maxDrop=0,minRetention=1,sumRetention=0,pairs=0;const dt=[];
      for(let i=0;i<rows.length;i++){
        const r=rows[i];if(!r.count||!r.alphaPixels)zero++;if(r.stale)stale++;
        if(i){const p=rows[i-1];dt.push(r.t-p.t);if(p.count){const set=new Set(r.ids),missing=p.ids.filter(id=>!set.has(id));const retention=1-missing.length/p.count;r.previousCount=p.count;r.retainedCount=p.count-missing.length;r.retentionShare=retention;r.countDropFraction=Math.max(0,(p.count-r.count)/p.count);minRetention=Math.min(minRetention,retention);sumRetention+=retention;pairs++;const drop=Math.max(0,(p.count-r.count)/p.count);maxDrop=Math.max(maxDrop,drop);if(drop>.15){largeDrop++;const fading=new Set(p.fading);if(!missing.every(id=>fading.has(id)))unfadedLargeDrop++;}}}
      }
      dt.sort((a,b)=>a-b);summaries[kind]={frames:rows.length,zeroFrames:zero,staleFrames:stale,largeDropFrames:largeDrop,unfadedLargeDropFrames:unfadedLargeDrop,maxDrop,minRetention,meanRetention:pairs?sumRetention/pairs:null,minCount:Math.min(...rows.map(r=>r.count)),maxCount:Math.max(...rows.map(r=>r.count)),p95FrameMs:dt[Math.floor(dt.length*.95)]??null};
    }
    action.summary=summaries;
  }
  result.summary=result.actions.map(a=>({name:a.name,gesture:a.gesture,...a.summary}));
  console.log(JSON.stringify({mode,summary:result.summary,shots:result.shots,errors:result.errors},null,2));
}catch(error){result.failure=String(error);console.error(error);process.exitCode=1;
  if(browser)result.failureState=await(await browser.pages())[0].evaluate(()=>({progress:window.__moonda?.progress,body:document.body.innerText.slice(-1800),crater:{...document.querySelector('.moon-crater-rims')?.dataset}})).catch(()=>null);
}finally{
  try{writeFileSync(join(out,'result.json'),JSON.stringify(result));if(result.summary)writeFileSync(join(out,'summary.json'),JSON.stringify({mode,summary:result.summary,shots:result.shots,errors:result.errors},null,2));}
  finally{try{await browser?.close();}finally{lease.release();}}
}
