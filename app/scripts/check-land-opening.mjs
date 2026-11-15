// Matched opening timings on captured before modules and the current app, one Chrome.
// node scripts/check-land-opening.mjs <out> <captured-modules>
import puppeteer from 'puppeteer-core';
import {acquireBrowserLease} from './browserLease.mjs';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
const out=resolve(process.argv[2]),modules=resolve(process.argv[3]);mkdirSync(out,{recursive:true});
const lease=await acquireBrowserLease({script:'check-land-opening.mjs',noteDir:out,timeoutMs:600000});
const result={runs:[],errors:[]};let browser;
try{
 const current=await(await fetch('http://127.0.0.1:5190/src/moon/lander.ts')).text();
 const dependencyHash=current.match(/cesium\.js\?v=([\da-f]+)/)?.[1];
 result.dependencyHash=dependencyHash;
 browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,userDataDir:join(out,'chrome-profile'),defaultViewport:{width:1440,height:900,deviceScaleFactor:2},args:['--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--no-first-run','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
 await lease.afterLaunch(browser);
 for(const mode of (process.argv.includes('--after-only')?['after']:['before','after'])){
  const page=(await browser.pages()).find(p=>p.url()==='about:blank')??await browser.newPage();await page.bringToFront();
  let rejectStartup;const failed=new Promise((_,r)=>rejectStartup=r);void failed.catch(()=>{});
  page.on('pageerror',e=>{result.errors.push({mode,error:String(e.stack||e)});rejectStartup(e);});
  page.on('response',r=>{if(r.url().startsWith('http://127.0.0.1:5190/')&&r.status()>=400&&r.request().resourceType()==='script')rejectStartup(new Error(`Local script ${r.status()}: ${r.url()}`));});
  await page.evaluateOnNewDocument(()=>{const Native=window.WebSocket;window.WebSocket=new Proxy(Native,{construct(T,a){const s=Reflect.construct(T,a);if(a[1]==='vite-hmr')s.addEventListener('message',e=>{try{if(['update','full-reload'].includes(JSON.parse(e.data).type))e.stopImmediatePropagation();}catch{}},true);return s;}});});
  if(mode==='before'){
   await page.setRequestInterception(true);page.on('request',r=>{const n=new URL(r.url()).pathname.match(/^\/src\/moon\/(\w+)\.ts$/)?.[1],p=n&&join(modules,n+'.js');if(p&&existsSync(p)){
    // Vite can regenerate dependency URLs while other sessions work. Keep captured source,
    // but resolve its unchanged installed libraries through this server's live cache key.
    const body=readFileSync(p,'utf8').replace(/(\/node_modules\/\.vite\/deps\/[^?"']+\?v=)[\da-f]+/g,(_,a)=>a+dependencyHash);
    void r.respond({status:200,contentType:'text/javascript',body});
   }else void r.continue();});
  }
  await page.goto('http://127.0.0.1:5190/',{waitUntil:'domcontentloaded',timeout:280000});
  await Promise.race([page.waitForFunction(()=>!!window.__moondaTest&&window.__moonda?.progress?.done,{timeout:280000}),failed]);
  const cdp=process.argv.includes('--profile-opening')?await page.createCDPSession():null;
  if(cdp){await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:500});}
  for(const spot of [{name:'ridge',lat:-89.45,lon:-137.3},{name:'apollo',lat:.674,lon:23.473}]){
   if(process.argv.includes('--apollo-only')&&spot.name!=='apollo')continue;
   if(cdp)await cdp.send('Profiler.start');
   await page.evaluate(s=>{window.__openingAt=performance.now();window.__moondaTest.stand(s.lat,s.lon);},spot);
   await page.waitForFunction(()=>window.__moonda.lander.phase==='on',{timeout:45000});
   const data=await page.evaluate(async()=>{
    const observedMs=performance.now()-window.__openingAt;
    const L=window.__moonda.lander,C=window.__moondaCesium,diag=[];
    if(L.selectedHeight){
     const {craterRelief}=await import('/src/moon/craterField.ts'),{toTrueLatLon}=await import('/src/moon/frame.ts');
     const points=[L.driver.feet,...Array.from({length:6},(_,i)=>L.driver.wheelContact(i,new C.Cartesian3()))];
     for(const p of points){
      const c=C.Cartographic.fromCartesian(p,window.__viewer.scene.globe.ellipsoid),f={tile:null,source:'none'},drawn=L.selectedHeight(c,f,true),t=toTrueLatLon(p),delta=C.Cartesian3.subtract(p,L.rockOrigin,new C.Cartesian3());
      const exact=window.__moonda.heights.heightAt(t.lat,t.lon,true)+craterRelief(C.Cartesian3.dot(delta,L.rockE),C.Cartesian3.dot(delta,L.rockN));
      const path=[];for(let n=f.tile;n;n=n.parent){const d=n.data;path.push({level:n.level,state:d?.terrainState,va:!!d?.vertexArray,mesh:!!d?.mesh,rendered:!!d?.renderedMesh,tileCut:n.upsampledFromParent,dataCut:d?.terrainData?.wasCreatedByUpsampling?.(),vertices:d?.mesh?.vertexCountWithoutSkirts});}
      diag.push({drawn,exact,error:drawn-exact,source:f.source,path});
     }
    }
    return {ms:observedMs,stats:{...L.stats},diag,prepared:[...(L.reliefProvider?.prepared?.values()??[])].map(p=>({key:p.key,mesh:!!p.mesh,task:!!p.task,data:!!p.data})),upgrades:[...(L.reliefProvider?.upgrades?.keys()??[])].map(t=>({level:t.level,x:t.x,y:t.y}))};
   });
   if(cdp){const {profile}=await cdp.send('Profiler.stop');writeFileSync(join(out,`${mode}-${spot.name}.cpuprofile`),JSON.stringify(profile));
    const nodes=new Map(profile.nodes.map(n=>[n.id,n.callFrame])),sum=new Map();
    for(let i=0;i<(profile.samples?.length??0);i++){const f=nodes.get(profile.samples[i]);if(!f)continue;const k=`${f.functionName} ${f.url.split('/').slice(-2).join('/').split('?')[0]}:${f.lineNumber+1}`;sum.set(k,(sum.get(k)??0)+(profile.timeDeltas?.[i]??0)/1000);}
    data.profile=[...sum].sort((a,b)=>b[1]-a[1]).slice(0,30).map(([name,ms])=>({name,ms}));}
   result.runs.push({mode,...spot,...data});console.log(JSON.stringify(result.runs.at(-1)));
   writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));
   await page.evaluate(()=>window.__moondaTest.exit());await page.waitForFunction(()=>window.__moonda.lander.phase==='off',{timeout:15000});
  }
  await page.close();
 }
 writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));
}catch(e){result.failure=String(e.stack||e);writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));throw e;}
finally{try{await browser?.close();}finally{lease.release();}}
