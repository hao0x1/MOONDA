// Read-only diagnostic: executes the current preload.ts source with browser dependencies
// stubbed and an accelerated fake clock. It never imports or changes app modules.
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
const base = new URL('../../../', import.meta.url);
const source = fs.readFileSync(new URL('app/src/moon/preload.ts',base),'utf8');
const src = stripTypeScriptTypes(source.replace(/^import .*;\n/gm,'').replace(/^export /gm,''));
async function scenario(name, options) {
 let now=0,id=0,finished=false,analyses=0; const timers=new Map(), logs=[],snapshots=[];
 const later=(fn,ms,interval=0)=>{ const key=++id;timers.set(key,{at:now+ms,fn,interval});return key; };
 const timeout=(fn,ms)=>later(fn,ms), clear=key=>timers.delete(key);
 const ctx={console,Promise,URL,Map,setTimeout:timeout,clearTimeout:clear,setInterval:(fn,ms)=>later(fn,ms,ms),clearInterval:clear,performance:{now:()=>now},requestAnimationFrame:fn=>later(()=>fn(now),16),window:{__moonda:{}},settings:{get:()=>({sound:false}),subscribe:()=>()=>{}},prefetchMusic:()=>Promise.resolve(),t:x=>x,loadManifest:()=>Promise.resolve([]),analyseSpotAsync:()=>{analyses++;return Promise.resolve();},fetch:()=>Promise.resolve({ok:false,arrayBuffer:()=>Promise.resolve(new ArrayBuffer(0))})};
 ctx.globalThis=ctx;vm.createContext(ctx);vm.runInContext(src+';globalThis.run=runPreload;',ctx);
 const viewer={isDestroyed:()=>false,camera:{setView:()=>{}},scene:{requestRender:()=>{},globe:{tilesLoaded:options.tilesReady}}};
 const heights=options.rejectHeights ? Promise.reject(new Error('DEM failed')) : new Promise(r=>timeout(r,options.heightsAt));
 const pending=()=>options.pending ? options.pending(now) : options.tilesReady?0:1;
 const d={heightsReady:heights,namesReady:Promise.resolve(),skyReady:Promise.resolve(),startView:{},imageryPending:pending,lander:{prewarm:()=>Promise.resolve()},warmLayers:()=>options.stallLayers ? new Promise(()=>{}) : Promise.resolve(true),warmViews:()=>[],onProgress:p=>logs.push({at:now,p}),cancelled:()=>false};
 if(options.layer404)d.layerFiles=async()=>['https://example.invalid/diagnostic-missing.bin'];
 ctx.run(viewer,d).then(()=>{finished=true;});
 for(const at of options.snapshots??[])timeout(()=>snapshots.push({at,pending:pending(),lastEmitted:logs.at(-1)}),at);
 await new Promise(setImmediate);
 let at180;
 for(let k=0;k<100000 && !finished;k++){
  let key,next;for(const [n,t]of timers)if(!next||t.at<next.at){key=n;next=t;}
  if(!next)throw Error('No timers; unfinished');
  if(next.at>180000 && !at180)at180=logs.at(-1);
  now=next.at;timers.delete(key);if(next.interval)timers.set(key,{...next,at:now+next.interval});next.fn();await new Promise(setImmediate);
  if(now>230000)break;
 }
 return {name,finishedAt:now,analyses,at180:at180?{done:at180.p.done,pct:at180.p.pct,stages:at180.p.stages}:null,snapshots,final:logs.at(-1)?.p,emittedProgress:logs};
}
const results=[];
results.push(await scenario('rejected DEM is marked done and starts science',{rejectHeights:true,tilesReady:true,heightsAt:0}));
results.push(await scenario('near-deadline heights plus stalled layers outlast UI failsafe',{tilesReady:false,heightsAt:89990,stallLayers:true}));
results.push(await scenario('supporting layer file 404 is marked done',{tilesReady:true,heightsAt:0,layer404:true}));
results.push(await scenario('stage fractions suppressed when total integer percent is unchanged',{tilesReady:false,heightsAt:0,pending:now=>now<1000?100:now<1100?42:now<1200?40:38,snapshots:[1050,1150,1250]}));
const result={method:'Executed unedited preload.ts in node:vm; browser/UI dependencies stubbed; accelerated fake timers; no real network or browser reproduction.',node:process.version,sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),results};
const out=new URL('startup-state-results.json',import.meta.url);fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({output:out.pathname,sourceSha256:result.sourceSha256,results:results.map(({name,finishedAt,analyses,at180,snapshots,final})=>({name,finishedAt,analyses,doneAt180:at180?.done,finalStages:final.stages.map(s=>[s.id,s.state]),snapshots:snapshots.map(s=>({at:s.at,pending:s.pending,displayPhotoFraction:s.lastEmitted.p.stages.find(x=>x.id==='photo').frac,total:s.lastEmitted.p.pct}))}))},null,2));
