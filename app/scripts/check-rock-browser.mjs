// Drive over three actual scanned stones, then stop at a tall one and reverse away.
// node scripts/check-rock-browser.mjs <output-folder>
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {acquireBrowserLease} from './browserLease.mjs';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});
const lease=await acquireBrowserLease({script:'check-rock-browser.mjs',noteDir:out});
const result={cases:[],errors:[],navigations:[]};let browser,page;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{
 browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,userDataDir:join(out,'chrome-profile'),
  defaultViewport:{width:1440,height:900,deviceScaleFactor:2},args:['--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--no-first-run','--hide-scrollbars','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
 await lease.afterLaunch(browser);page=(await browser.pages())[0];page.on('pageerror',e=>result.errors.push(String(e.stack||e)));
 page.on('framenavigated',f=>{if(f===page.mainFrame())result.navigations.push({url:f.url(),at:new Date().toISOString()});});
 await page.evaluateOnNewDocument(()=>{const Native=window.WebSocket;window.WebSocket=new Proxy(Native,{construct(T,a){const s=Reflect.construct(T,a);if(a[1]==='vite-hmr')s.addEventListener('message',e=>{try{if(['update','full-reload'].includes(JSON.parse(e.data).type))e.stopImmediatePropagation();}catch{}},true);return s;}});});
 await page.goto('http://127.0.0.1:5190/',{waitUntil:'domcontentloaded',timeout:280000});
 await page.waitForFunction(()=>!!window.__moondaTest&&!!window.__moondaCesium&&window.__moonda?.progress?.done,{timeout:280000});
 await page.evaluate(()=>window.__moondaTest.stand(-89.45,-137.3));
 await page.waitForFunction(()=>window.__moonda.lander.phase==='on',{timeout:45000});
 await page.evaluate(async()=>{
  const C=window.__moondaCesium,L=window.__moonda.lander;
  const {ROCK_SHAPE}=await import('/src/moon/rockOutline.ts');
  const {toTrueLatLon}=await import('/src/moon/frame.ts');
  window.__rockTest={C,L,ROCK_SHAPE,toTrueLatLon,rows:[],run:false,targets:[]};
  const q=window.__rockTest;
  q.collect=()=>{
   for(const r of L.rocks){
    if(!r.spot||!r.model.show||r.size<.99)continue;
    const sh=ROCK_SHAPE[r.kind],h=sh.top*r.scale,width=2*sh.b*r.scale;
    if(!((h>=.2&&h<=.3&&width<.55)||h>=.4)||q.targets.some(t=>t.id===r.spot.id))continue;
    const cy=Math.cos(r.spot.yaw),sy=Math.sin(r.spot.yaw),ca=Math.cos(sh.ang*Math.PI/180),sa=Math.sin(sh.ang*Math.PI/180);
    const X=C.Cartesian3.add(C.Cartesian3.multiplyByScalar(L.rockE,cy,new C.Cartesian3()),C.Cartesian3.multiplyByScalar(L.rockN,sy,new C.Cartesian3()),new C.Cartesian3());
    const Y=C.Cartesian3.add(C.Cartesian3.multiplyByScalar(L.rockE,sy,new C.Cartesian3()),C.Cartesian3.multiplyByScalar(L.rockN,-cy,new C.Cartesian3()),new C.Cartesian3());
    const centre=C.Cartesian3.add(r.base,C.Cartesian3.add(C.Cartesian3.multiplyByScalar(X,sh.cx*r.scale,new C.Cartesian3()),C.Cartesian3.multiplyByScalar(Y,sh.cz*r.scale,new C.Cartesian3()),new C.Cartesian3()),new C.Cartesian3());
    const F=C.Cartesian3.add(C.Cartesian3.multiplyByScalar(X,ca,new C.Cartesian3()),C.Cartesian3.multiplyByScalar(Y,sa,new C.Cartesian3()),new C.Cartesian3());
    const heading=(Math.atan2(C.Cartesian3.dot(F,L.rockE),C.Cartesian3.dot(F,L.rockN))*180/Math.PI+360)%360;
    q.targets.push({id:r.spot.id,h,width,kind:r.kind,d:r.spot.d,centre,F,heading});
   }
   return q.targets.map(({centre,F,...t})=>t);
  };
  q.discover=()=>{
   // These are the ordinary field's stones, not added or resized test objects.
   for(const s of L.farRocks.env.spots(0,0,0,150)){
    const sh=ROCK_SHAPE[s.kind],scale=s.d/sh.w,h=sh.top*scale,width=2*sh.b*scale;
    if(!((h>=.2&&h<=.3&&width<.55)||h>=.4)||q.targets.some(t=>t.id===s.id))continue;
    const cy=Math.cos(s.yaw),sy=Math.sin(s.yaw),ca=Math.cos(sh.ang*Math.PI/180),sa=Math.sin(sh.ang*Math.PI/180);
    const X=C.Cartesian3.add(C.Cartesian3.multiplyByScalar(L.rockE,cy,new C.Cartesian3()),C.Cartesian3.multiplyByScalar(L.rockN,sy,new C.Cartesian3()),new C.Cartesian3());
    const Y=C.Cartesian3.add(C.Cartesian3.multiplyByScalar(L.rockE,sy,new C.Cartesian3()),C.Cartesian3.multiplyByScalar(L.rockN,-cy,new C.Cartesian3()),new C.Cartesian3());
    const base=C.Cartesian3.add(L.rockOrigin,C.Cartesian3.add(C.Cartesian3.multiplyByScalar(L.rockE,s.e,new C.Cartesian3()),C.Cartesian3.multiplyByScalar(L.rockN,s.n,new C.Cartesian3()),new C.Cartesian3()),new C.Cartesian3());
    const centre=C.Cartesian3.add(base,C.Cartesian3.add(C.Cartesian3.multiplyByScalar(X,sh.cx*scale,new C.Cartesian3()),C.Cartesian3.multiplyByScalar(Y,sh.cz*scale,new C.Cartesian3()),new C.Cartesian3()),new C.Cartesian3());
    const F=C.Cartesian3.add(C.Cartesian3.multiplyByScalar(X,ca,new C.Cartesian3()),C.Cartesian3.multiplyByScalar(Y,sa,new C.Cartesian3()),new C.Cartesian3());
    const heading=(Math.atan2(C.Cartesian3.dot(F,L.rockE),C.Cartesian3.dot(F,L.rockN))*180/Math.PI+360)%360;
    q.targets.push({id:s.id,h,width,kind:s.kind,d:s.d,centre,F,heading,e:s.e,n:s.n,distance:Math.hypot(s.e,s.n)});
   }
   return q.targets.map(({centre,F,...t})=>t);
  };
  q.off=window.__viewer.scene.postRender.addEventListener(()=>{if(!q.run)return;
   const d=L.driver,t=q.target,delta=C.Cartesian3.subtract(d.feet,t.centre,new C.Cartesian3());
   const side=C.Cartesian3.cross(t.F,d.up,new C.Cartesian3());
   q.rows.push({ms:performance.now(),along:C.Cartesian3.dot(delta,t.F),side:C.Cartesian3.dot(delta,side),speed:d.speed,
    pressing:d.pressing,blocked:d.blocked,impact:d.impact,pitch:d.pitch*180/Math.PI,ground:L.groundUnder(d.feet)});
  });
  window.__landerLink.setView('third');
 });
 await wait(1200);
 const available=await page.evaluate(()=>window.__rockTest.discover());
 const small=available.filter(t=>t.h<=.3).sort((a,b)=>(a.distance??0)-(b.distance??0)).slice(0,3);
 const tall=available.filter(t=>t.h>=.4).sort((a,b)=>a.h-b.h)[0];
 result.available=available;assert.equal(small.length,3,'Need three real 0.2–0.3 m stones');assert.ok(tall,'Need a real tall stone');
 for(const target of [...small,tall]){
  const large=target.h>=.4;
  await page.evaluate(id=>{
   const q=window.__rockTest,C=q.C,t=q.targets.find(t=>t.id===id);q.target=t;q.rows=[];q.run=false;
   const p=C.Cartesian3.subtract(t.centre,C.Cartesian3.multiplyByScalar(t.F,3.5,new C.Cartesian3()),new C.Cartesian3()),ll=q.toTrueLatLon(p);
   window.__roverLink.teleport(ll.lat,ll.lon,t.heading);
  },target.id);
  await wait(1300);
  const drawnTarget=await page.evaluate(id=>{
   const q=window.__rockTest,r=q.L.rocks.find(r=>r.spot?.id===id&&r.model.show),sh=r&&q.ROCK_SHAPE[r.kind];
   return r?{id,kind:r.kind,height:sh.top*r.scale,width:2*sh.b*r.scale,visible:r.model.show,ready:r.model.ready,size:r.size}:null;
  },target.id);
  assert.ok(drawnTarget?.visible&&drawnTarget.ready,`${target.id}: chosen field stone is not drawn`);
  if(!large)assert.ok(drawnTarget.height>=.2&&drawnTarget.height<=.3,`${target.id}: drawn stone is outside the requested height range`);
  await page.evaluate(()=>{const q=window.__rockTest;q.run=true;window.__landerLink.setWalk(true);document.activeElement?.blur();});
  await page.keyboard.down('w');
  let crossed=false,blocked=false;
  for(let i=0;i<100;i++){
   await wait(60);const s=await page.evaluate(()=>window.__rockTest.rows.at(-1));
   if(s?.along>=.05&&!crossed){crossed=true;await page.screenshot({path:join(out,`rock-${result.cases.length+1}-over.png`),clip:{x:0,y:0,width:1440,height:900,scale:.5}});}
   if(s?.blocked==='rock'&&Math.abs(s.speed)<.2){blocked=true;break;}
   if(s?.along>2)break;
  }
  await page.keyboard.up('w');
  if(large&&!crossed)await page.screenshot({path:join(out,'tall-rock-blocked.png'),clip:{x:0,y:0,width:1440,height:900,scale:.5}});
  const contact=await page.evaluate(()=>{const q=window.__rockTest;return {rows:q.rows,start:q.rows[0],last:q.rows.at(-1)};});
  let reverse=null;
  if(large||blocked){
   await page.keyboard.down('s');await wait(1000);await page.keyboard.up('s');
   reverse=await page.evaluate(()=>window.__rockTest.rows.at(-1));
  }
  await page.evaluate(()=>{window.__rockTest.run=false;window.__landerLink.setWalk(false);});
  const row={target,drawnTarget,crossed,blocked,contact,reverse};result.cases.push(row);writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));
 }
 await page.evaluate(()=>window.__rockTest.off());
 for(const r of result.cases.slice(0,3)){assert.ok(r.crossed&&r.contact.last.along>1.5,`${r.target.id}: centre-line straddle failed`);assert.ok(!r.contact.rows.some(s=>s.blocked==='rock'),`${r.target.id}: false rock block`);}
 const t=result.cases.at(-1);assert.ok(t.blocked,'Tall stone did not stop the rover');assert.ok(t.reverse.along<t.contact.last.along-.05&&t.reverse.speed<-.05,'Reverse did not free tall-rock contact within one second');
 assert.deepEqual(result.errors,[]);result.ok=true;writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({ok:true,cases:result.cases.map(r=>({target:r.target,crossed:r.crossed,blocked:r.blocked,end:r.contact.last,reverse:r.reverse})),errors:result.errors},null,2));
}catch(e){result.failure=String(e.stack||e);writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));throw e;}
finally{try{await browser?.close();}finally{lease.release();}}
