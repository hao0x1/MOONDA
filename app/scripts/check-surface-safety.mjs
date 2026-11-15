// Compare the actual selected terrain meshes with the rover and camera on every rendered frame.
// node scripts/check-surface-safety.mjs --out <folder> [--baseline] [--drive-ms 8000]
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {acquireBrowserLease} from './browserLease.mjs';
const args=process.argv.slice(2),flag=(k,d)=>args.includes(k)?args[args.indexOf(k)+1]:d;
const out=resolve(flag('--out','/private/tmp/moonda-surface-safety'));
mkdirSync(out,{recursive:true});
const baseline=args.includes('--baseline'),driveMs=+flag('--drive-ms',8000);
const result={baseline,tileDelayMs:+flag('--tile-delay-ms',0),meshDelayMs:+flag('--mesh-delay-ms',0),cases:[],errors:[],requests:[]};
const cases=[
  {name:'shackleton-rim',lat:-89.79,lon:-154.3,view:'spot'},
  {name:'connecting-ridge',lat:-89.45,lon:-137.3,view:'spot'},
  {name:'tycho-inner-wall',lat:-42.3,lon:-11.2,view:'spot'},
  // The owner's coordinates are the same rim: repeat its Behind-view spawn separately.
  {name:'owner-behind',lat:-89.79,lon:-154.3,view:'third'},
];
const lease=await acquireBrowserLease({script:'check-surface-safety.mjs',noteDir:out,timeoutMs:+flag('--lease-wait-ms',90000)});
let browser,page;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
 browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,
  userDataDir:join(out,'chrome-profile'),defaultViewport:{width:1440,height:900,deviceScaleFactor:2},
  args:['--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--no-first-run','--hide-scrollbars','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
 await lease.afterLaunch(browser);
 page=(await browser.pages())[0];
 const modules=flag('--modules',null);
 if(modules){await page.setRequestInterception(true);page.on('request',r=>{const n=new URL(r.url()).pathname.match(/^\/src\/moon\/(\w+)\.ts$/)?.[1],p=n&&join(modules,n+'.js');if(p&&existsSync(p))void r.respond({status:200,contentType:'text/javascript',body:readFileSync(p)});else void r.continue();});}
 page.on('pageerror',e=>result.errors.push(e.stack||String(e)));
 page.on('requestfailed',r=>result.requests.push({url:r.url(),error:r.failure()?.errorText}));
 await page.evaluateOnNewDocument(()=>{
  const Native=window.WebSocket;
  window.WebSocket=new Proxy(Native,{construct(T,a){const s=Reflect.construct(T,a);
   if(a[1]==='vite-hmr')s.addEventListener('message',e=>{try{if(['update','full-reload'].includes(JSON.parse(e.data).type))e.stopImmediatePropagation();}catch{}},true);
   return s;}});
 });
 await page.goto('http://127.0.0.1:5190/',{waitUntil:'domcontentloaded',timeout:280000});
 await page.waitForFunction(()=>!!window.__moondaTest&&!!window.__moondaCesium&&window.__moonda?.progress?.done,{timeout:280000});
 if(+flag('--mesh-delay-ms',0)>0)await page.evaluate(delay=>{
  const proto=window.__moondaCesium.QuantizedMeshTerrainData.prototype,original=proto.createMesh,tasks=new WeakMap();
  // Delay the worker's START, not just delivery of an already cached mesh. Both ordinary
  // loading and ahead-of-rover preparation meet the same controlled worker stall.
  proto.createMesh=function(options){if(tasks.has(this))return tasks.get(this);const data=this;
   const start=()=>original.call(data,options)??new Promise(r=>setTimeout(r,20)).then(start);
   const task=new Promise(r=>setTimeout(r,delay)).then(start);tasks.set(this,task);return task;};
 },+flag('--mesh-delay-ms',0));
 if(+flag('--tile-delay-ms',0)>0)await page.evaluate(delay=>{
  const p=window.__viewer.terrainProvider,request=p.requestTileGeometry;
  p.requestTileGeometry=function(...a){const data=request.apply(this,a);return data&&a[2]>=8?Promise.resolve(data).then(d=>new Promise(r=>setTimeout(()=>r(d),delay))):data;};
 },+flag('--tile-delay-ms',0));
 await page.evaluate(async()=>{
  const C=window.__moondaCesium,L=window.__moonda.lander,v=window.__viewer;
  const {WHEELS,ROBOT_SCALE}=await import('/src/moon/walk.ts');
  const {craterRelief}=await import('/src/moon/craterField.ts');
  const {toTrueLatLon}=await import('/src/moon/frame.ts');
  const q=window.__surfaceSafety={rows:[],part:'landing',run:false,missing:0,renderErrors:[]};
  v.scene.renderError.addEventListener((_,e)=>q.renderErrors.push(String(e?.stack||e)));
  const cart=new C.Cartographic(),hit=new C.Cartesian3(),unit=new C.Cartesian3(),point=new C.Cartesian3();
  const ray=new C.Ray(),delta=new C.Cartesian3();
  // Do not use globe.pick's _tilesRenderedThisFrame: it also retains children kicked
  // out of this frame's final selection. The final array is the actual picture.
  q.drawn=(p,includeSupport=false)=>{
   const surface=v.scene.globe._surface,c=C.Cartographic.fromCartesian(p,v.scene.globe.ellipsoid,cart);
   if(!c)return null;
   C.Cartesian3.normalize(p,unit);
   C.Cartesian3.multiplyByScalar(unit,1737400+20000,ray.origin);
   C.Cartesian3.negate(unit,ray.direction);
   let best=null;
   const tiles=new Set(surface._tilesToRender);
   if(includeSupport)for(const t of surface._tilesToRender)for(let a=t.parent;a;a=a.parent)if(C.Rectangle.contains(a.rectangle,c))tiles.add(a);
   for(const t of tiles){
    if(!t.data?.renderedMesh||!t.data.pick||!C.Rectangle.contains(t.rectangle,c))continue;
    const h=t.data.pick(ray,C.SceneMode.SCENE3D,surface._tileProvider.tilingScheme.projection,false,hit);
    if(h){const height=C.Cartesian3.magnitude(h)-1737400;if(!best||t.level>best.level||(t.level===best.level&&height>best.h))best={h:height,level:t.level,id:`${t.level}/${t.x}/${t.y}`,fill:!!t.data.fill,support:!surface._tilesToRender.includes(t)};}
   }
   return best;
  };
  q.exact=p=>{
   const t=toTrueLatLon(p),h=window.__moonda.heights.heightAt(t.lat,t.lon,true);
   C.Cartesian3.subtract(p,L.rockOrigin,delta);
   return h+(L.relief?craterRelief(C.Cartesian3.dot(delta,L.rockE),C.Cartesian3.dot(delta,L.rockN)):0);
  };
  q.read=()=>{
   if(!L.placed||!L.driver||!L.roverParked)return;
   const d=L.driver,p=v.camera.positionWC,draw=q.drawn(p)??q.drawn(p,true),eye=C.Cartesian3.magnitude(p)-1737400;
   const wheel=[];
   for(let i=0;i<6;i++){
    d.wheelContact(i,point);const g=q.drawn(point),w=WHEELS[i];
    const bottom=d.bodyH+w.z*ROBOT_SCALE*Math.tan(d.pitch)-w.x*ROBOT_SCALE*Math.tan(d.roll)+d.wheelLift[i]-d.sink;
    const bare=d.wheelTerrain[i],rockLift=d.wheelGround[i]-bare;
    wheel.push({drawn:g?.h??null,exact:q.exact(point),sample:d.wheelGround[i],bare,rockLift,bottom,gap:g?bottom-g.h:null,
      supportGap:g?bare-g.h:null,contactGap:g?bottom-g.h-rockLift:null,level:g?.level??null,on:d.wheelOn[i]});
   }
   const row={ms:performance.now(),part:q.part,phase:L.phase,view:L.view,visible:L.phase==='in'||L.phase==='on',
    eye,drawn:draw?.h??null,exact:q.exact(p),clearance:draw?eye-draw.h:null,cameraTile:draw,
    undergroundCommands:v.scene._frameState.cameraUnderground,
    roverExact:q.exact(d.feet),roverDrawn:q.drawn(d.feet)?.h??null,
    groundUnder:L.groundUnder(p),wheel,speed:d.speed,slide:d.slide,pitch:d.pitch*180/Math.PI,
    lat:window.__roverLink.pose.lat,lon:window.__roverLink.pose.lon,tiles:v.scene.globe._surface._tilesToRender.length};
   q.rows.push(row);
  };
  q.off=v.scene.postRender.addEventListener(()=>{if(q.run)q.read();});
 });
 for(const spot of cases){
  await page.evaluate(()=>{const q=window.__surfaceSafety;q.rows=[];q.part='landing';q.run=true;q.start=performance.now();});
  await page.evaluate(s=>window.__moondaTest.stand(s.lat,s.lon),spot);
  await page.waitForFunction(()=>['in','on'].includes(window.__moonda.lander.phase),{timeout:45000});
  if(spot.view!=='spot')await page.evaluate(view=>window.__landerLink.setView(view),spot.view);
  await page.waitForFunction(()=>window.__moonda.lander.phase==='on',{timeout:15000});
  await page.screenshot({path:join(out,`${spot.name}-landed.png`),clip:{x:0,y:0,width:1440,height:900,scale:.5}});
  if(spot.view==='third'){
   await page.waitForFunction(()=>!window.__moonda.lander.glide&&!window.__moonda.lander.anim,{timeout:4000});
   await page.screenshot({path:join(out,`${spot.name}-settled.png`),clip:{x:0,y:0,width:1440,height:900,scale:.5}});
   if(args.includes('--inspect-rim')){
    const pixels=await page.evaluate(()=>{
     const C=window.__moondaCesium,v=window.__viewer,scene=v.scene,tiles=scene.globe._surface._tilesToRender;
     return [[1080,143],[1170,136],[850,143],[1010,132],[850,190],[1170,180],[1230,190],[1120,190]].map(([x,y])=>{
      const pixel=new C.Cartesian2(x,y),ray=v.camera.getPickRay(pixel),p=new C.Cartesian3();let best=null;
      for(const t of tiles){const hit=t.data?.pick?.(ray,C.SceneMode.SCENE3D,scene.globe._surface._tileProvider.tilingScheme.projection,false,p);
       if(hit){const distance=C.Cartesian3.distance(ray.origin,hit);if(!best||distance<best.distance)best={tile:t,distance,point:C.Cartesian3.clone(hit)};}}
      let depth=null;try{const p=scene.pickPositionSupported?scene.pickPosition(pixel):undefined;if(p)depth={distance:C.Cartesian3.distance(ray.origin,p),height:C.Cartesian3.magnitude(p)-1737400};}catch(e){depth={error:String(e)};}
      if(!best)return{x,y,depth,terrain:null};
      const m=best.tile.data.renderedMesh,a=new C.Cartesian3(),b=new C.Cartesian3(),c=new C.Cartesian3();let closest=Infinity,at=-1;
      for(let i=0;i<m.indices.length;i+=3){m.encoding.getExaggeratedPosition(m.vertices,m.indices[i],a);m.encoding.getExaggeratedPosition(m.vertices,m.indices[i+1],b);m.encoding.getExaggeratedPosition(m.vertices,m.indices[i+2],c);
       const t=C.IntersectionTests.rayTriangleParametric(ray,a,b,c,false);if(t!==undefined&&t>=0&&t<closest){closest=t;at=i;}}
      const chain=[];for(let t=best.tile;t;t=t.parent){const q=t.data?.terrainData;chain.push({level:t.level,x:t.x,y:t.y,cut:q?.wasCreatedByUpsampling?.(),mask:q?._childTileMask,skirts:q?['_westSkirtHeight','_southSkirtHeight','_eastSkirtHeight','_northSkirtHeight'].map(k=>q[k]):null});}
      return{x,y,depth,terrain:{level:best.tile.level,x:best.tile.x,y:best.tile.y,distance:best.distance,height:C.Cartesian3.magnitude(best.point)-1737400,triangleIndex:at/3,skirt:at>=m.indexCountWithoutSkirts,fullScanDistance:closest,chain}};
     });
    });
    result.rimPixels=pixels;writeFileSync(join(out,'rim-pixels.json'),JSON.stringify(pixels,null,2));
    if(!baseline)for(const p of pixels)if(p.terrain)assert.ok(p.depth,`rim pixel ${p.x}/${p.y}: sky shows through a selected terrain triangle`);
   }
  }
  await page.evaluate(()=>{const q=window.__surfaceSafety;q.part='view';window.__landerLink.setView('third');});
  await wait(1000);
  const setup=await page.evaluate(()=>{
   const L=window.__moonda.lander,C=window.__moondaCesium,q=window.__surfaceSafety,d=L.driver;
   // Steepest local descent, sampled in the same metres as the wheel ground.
   let best=Infinity,heading=0;
   for(let a=0;a<360;a+=10){const r=a*Math.PI/180,p=C.Cartesian3.add(d.feet,C.Cartesian3.add(C.Cartesian3.multiplyByScalar(d.north,8*Math.cos(r),new C.Cartesian3()),C.Cartesian3.multiplyByScalar(d.east,8*Math.sin(r),new C.Cartesian3()),new C.Cartesian3()),new C.Cartesian3()),h=q.exact(p);if(h<best){best=h;heading=a;}}
   const t=window.__roverLink.pose;window.__roverLink.teleport(t.lat,t.lon,heading);
   return {heading,slopeDeg:Math.atan((q.exact(d.feet)-best)/8)*180/Math.PI,stats:{...L.stats}};
  });
  // teleport uses a brief black curtain and clears held keys when it places the rover.
  // Press W only after that placement, or this check would merely watch a parked rover.
  await wait(700);
  await page.evaluate(()=>{const q=window.__surfaceSafety;window.__landerLink.setWalk(true);document.activeElement?.blur();q.part='driving';q.driveOdo=window.__moonda.lander.driver.odometer;});
  await page.keyboard.down('Shift');await page.keyboard.down('w');await wait(driveMs);
  await page.keyboard.up('w');await page.keyboard.up('Shift');
  await page.evaluate(()=>{window.__surfaceSafety.part='stopped';window.__landerLink.setWalk(false);});
  await wait(350);
  if(args.includes('--camera-modes')){
   for(const view of ['first','spot']){await page.evaluate(v=>{window.__surfaceSafety.part=`camera-${v}`;window.__landerLink.setView(v);},view);await wait(700);}
  }
  const data=await page.evaluate(()=>{const q=window.__surfaceSafety;q.run=false;return {rows:q.rows,distance:window.__moonda.lander.driver.odometer-q.driveOdo,
   rendering:{loop:window.__viewer.useDefaultRenderLoop,errors:q.renderErrors,panel:document.querySelector('.cesium-widget-errorPanel')?.innerText??null}};}),rows=data.rows;
  const visible=rows.filter(r=>r.visible),below=visible.filter(r=>r.clearance!==null&&r.clearance<-.001);
  const gaps=visible.flatMap(r=>r.wheel.map(w=>w.gap).filter(Number.isFinite));
  const support=visible.flatMap(r=>r.wheel.map(w=>w.supportGap).filter(Number.isFinite));
  const contacts=visible.flatMap(r=>r.wheel.filter(w=>w.on).map(w=>w.contactGap).filter(Number.isFinite));
  const exactGaps=visible.filter(r=>r.drawn!==null).map(r=>r.exact-r.drawn);
  const summary={...spot,setup,rendering:data.rendering,drivenDistance:data.distance,maxSpeed:Math.max(...rows.map(r=>Math.abs(r.speed))),frames:visible.length,cameraBelowFrames:below.length,worstCameraDepth:Math.max(0,...below.map(r=>-r.clearance)),
   missingCamera:visible.filter(r=>r.drawn===null).length,cameraSupportFrames:visible.filter(r=>r.cameraTile?.support).length,
   undergroundCommandFrames:visible.filter(r=>r.drawn!==null&&r.clearance>=.35&&r.undergroundCommands).length,
   minimumCameraClearance:Math.min(...visible.map(r=>r.clearance).filter(Number.isFinite)),worstWheelBelow:Math.max(0,...gaps.map(x=>-x)),worstWheelAbove:Math.max(0,...gaps),
   worstSupportGap:Math.max(0,...support.map(Math.abs)),worstSupportedContactGap:Math.max(0,...contacts.map(Math.abs)),
   worstExactDrawnGap:Math.max(0,...exactGaps.map(Math.abs)),openingMs:rows.find(r=>r.phase==='on')?.ms-rows[0]?.ms};
  summary.byView=Object.fromEntries(['spot','third','first'].map(v=>{const a=visible.filter(r=>r.view===v);return[v,{frames:a.length,below:a.filter(r=>r.clearance!==null&&r.clearance<-.001).length}];}));
  result.cases.push({summary,rows});writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(summary));
  assert.ok(summary.drivenDistance>2,`${spot.name}: the fast descent did not move at least two metres`);
  assert.ok(summary.frames>=30&&summary.maxSpeed>1,`${spot.name}: not enough live rendered driving frames`);
  assert.ok(data.rendering.loop&&!data.rendering.panel&&!data.rendering.errors.length,`${spot.name}: rendering stopped`);
  await page.evaluate(()=>window.__moondaTest.exit());
  await page.waitForFunction(()=>window.__moonda.lander.phase==='off',{timeout:15000});
 }
 await page.evaluate(()=>window.__surfaceSafety.off());
 if(!baseline){for(const {summary:s}of result.cases){assert.equal(s.cameraBelowFrames,0,`${s.name}: camera below drawn ground`);assert.equal(s.undergroundCommandFrames,0,`${s.name}: safe eye still drew terrain without skirts`);assert.ok(s.worstSupportGap<.05,`${s.name}: wheels used another surface (${s.worstSupportGap} m)`);assert.ok(s.worstSupportedContactGap<.035,`${s.name}: supported tyre missed the ground (${s.worstSupportedContactGap} m)`);}assert.deepEqual(result.errors,[]);}
 result.ok=true;writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));
}catch(e){result.failure=String(e.stack||e);writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));throw e;}
finally{try{await browser?.close();}finally{lease.release();}}
