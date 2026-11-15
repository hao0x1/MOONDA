// Inspect the exact drawn triangles behind a suspicious terrain strip. One Chrome, closed below.
// node scripts/check-terrain-seams.mjs <output-folder>
import puppeteer from 'puppeteer-core';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {acquireBrowserLease} from './browserLease.mjs';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});
const lease=await acquireBrowserLease({script:'check-terrain-seams.mjs',noteDir:out,timeoutMs:600000});let browser;
try{
 browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,userDataDir:join(out,'chrome-profile'),defaultViewport:{width:1440,height:900,deviceScaleFactor:2},args:['--enable-gpu','--use-angle=metal','--ignore-gpu-blocklist','--no-first-run','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});await lease.afterLaunch(browser);
 const page=(await browser.pages())[0],errors=[];page.on('pageerror',e=>errors.push(String(e.stack||e)));
 await page.evaluateOnNewDocument(()=>{const W=window.WebSocket;window.WebSocket=new Proxy(W,{construct(T,a){const s=Reflect.construct(T,a);if(a[1]==='vite-hmr')s.addEventListener('message',e=>{try{if(['update','full-reload'].includes(JSON.parse(e.data).type))e.stopImmediatePropagation();}catch{}},true);return s;}});});
 await page.goto('http://127.0.0.1:5190/',{waitUntil:'domcontentloaded',timeout:280000});await page.waitForFunction(()=>window.__moondaTest&&window.__moonda?.progress?.done,{timeout:280000});
 await page.evaluate(()=>window.__moondaTest.stand(-89.79,-154.3));await page.waitForFunction(()=>window.__moonda.lander.phase==='on',{timeout:45000});
 await page.evaluate(()=>window.__landerLink.setView('third'));await page.waitForFunction(()=>!window.__moonda.lander.glide&&!window.__moonda.lander.anim,{timeout:4000});
 await page.screenshot({path:join(out,'rim.png')});
 const data=await page.evaluate(()=>{
  const C=window.__moondaCesium,v=window.__viewer,L=window.__moonda.lander,scene=v.scene,surface=scene.globe._surface,tiles=surface._tilesToRender;
  const id=t=>`${t.level}/${t.x}/${t.y}`;
  const chain=t=>{const a=[];for(;t;t=t.parent){const d=t.data,q=d?.terrainData,m=d?.renderedMesh;a.push({id:id(t),state:d?.terrainState,cut:q?.wasCreatedByUpsampling?.(),childMask:q?._childTileMask,vertices:m?.vertexCountWithoutSkirts,skirts:q?['_westSkirtHeight','_southSkirtHeight','_eastSkirtHeight','_northSkirtHeight'].map(k=>q[k]):null,min:q?._minimumHeight,max:q?._maximumHeight});}return a;};
  const cast=(ray,cull)=>{const p=new C.Cartesian3();let best=null;for(const t of tiles){const h=t.data?.pick?.(ray,C.SceneMode.SCENE3D,surface._tileProvider.tilingScheme.projection,cull,p);if(h){const distance=C.Cartesian3.distance(ray.origin,h);if(!best||distance<best.distance)best={tile:t,distance,point:C.Cartesian3.clone(h)};}}return best;};
  const rays=[[1080,143],[1170,136],[850,143],[1010,132],[850,190]].map(([x,y])=>{
   const pixel=new C.Cartesian2(x,y),ray=v.camera.getPickRay(pixel),hit=cast(ray,false),front=cast(ray,true),m=hit?.tile.data.renderedMesh;
   let triangle=null,closest=Infinity;const a=new C.Cartesian3(),b=new C.Cartesian3(),c=new C.Cartesian3();
   if(m)for(let i=0;i<m.indices.length;i+=3){m.encoding.getExaggeratedPosition(m.vertices,m.indices[i],a);m.encoding.getExaggeratedPosition(m.vertices,m.indices[i+1],b);m.encoding.getExaggeratedPosition(m.vertices,m.indices[i+2],c);const t=C.IntersectionTests.rayTriangleParametric(ray,a,b,c,false);if(t!==undefined&&t>=0&&t<closest){closest=t;const cross=C.Cartesian3.cross(C.Cartesian3.subtract(b,a,new C.Cartesian3()),C.Cartesian3.subtract(c,a,new C.Cartesian3()),new C.Cartesian3());triangle={index:i/3,skirt:i>=m.indexCountWithoutSkirts,rayFacing:C.Cartesian3.dot(cross,ray.direction),radialFacing:C.Cartesian3.dot(cross,a),points:[C.Cartesian3.clone(a),C.Cartesian3.clone(b),C.Cartesian3.clone(c)]};}}
   const transitions=[];let previous=null;
   for(let s=0;s<=350;s+=1){const p=C.Ray.getPoint(ray,s),c=C.Cartographic.fromCartesian(p,scene.globe.ellipsoid),f={tile:null,source:'none'},h=L.selectedHeight(c,f);if(h===undefined)continue;const r={s,h,eye:c.height,clearance:c.height-h,tile:id(f.tile)};
    if(previous&&r.tile!==previous.tile)transitions.push({before:previous,after:r,source:chain(f.tile)});previous=r;}
   let depth=null;try{depth=scene.pickPositionSupported?scene.pickPosition(pixel):null;}catch{}
   return{x,y,ray,depth,hit:hit?{id:id(hit.tile),distance:hit.distance,chain:chain(hit.tile),triangle}:null,front:front?{id:id(front.tile),distance:front.distance}:null,transitions};
  });return{rays,stats:{...L.stats},camera:C.Cartesian3.clone(v.camera.positionWC),eye:C.Cartographic.fromCartesian(v.camera.positionWC,scene.globe.ellipsoid),tiles:tiles.length};
 });writeFileSync(join(out,'result.json'),JSON.stringify({...data,errors},null,2));console.log(JSON.stringify(data.rays.map(r=>({x:r.x,y:r.y,hit:r.hit?.id,facing:r.hit?.triangle.rayFacing,radial:r.hit?.triangle.radialFacing,front:r.front,steps:r.transitions.filter(t=>Math.abs(t.after.clearance-t.before.clearance)>.2).map(t=>({s:t.after.s,before:t.before,after:t.after,source:t.source.find(x=>x.cut===false)}))}))));
 await page.evaluate(()=>{window.__viewer.scene.globe.backFaceCulling=false;window.__viewer.scene.requestRender();});
 await new Promise(r=>setTimeout(r,100));await page.screenshot({path:join(out,'rim-no-culling.png')});
}finally{try{await browser?.close();}finally{lease.release();}}
