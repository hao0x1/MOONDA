// Phone capability stand-in, using drive.mjs and its shared browser lease unchanged.
// node scripts/check-phone-graphics.mjs --out /absolute/evidence/path --phase overview|surface|tycho|pole
// --desktop captures Full detail on the real GPU for resource/source comparison.
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const args = process.argv.slice(2), flag = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const outArg = flag('--out', null);
if (!outArg) throw new Error('--out is required; profiles and caches must stay in the evidence folder.');
const out = resolve(outArg), phase = flag('--phase', 'overview'), scripts = dirname(fileURLToPath(import.meta.url));
mkdirSync(out, { recursive: true });
const ev = (name, js) => ({ do: 'eval', name, js });
const shot = name => [ev(name, `window.__phoneGraphics.checkpoint(${JSON.stringify(name)})`), { do: 'shot', name }];
const waitFor = (expression, timeout = 15000) => `new Promise(async resolve => { const t=performance.now(); while(performance.now()-t<${timeout}) { if (${expression}) return resolve(true); await new Promise(r=>setTimeout(r,100)); } resolve(false); })`;
const toggle = id => ev(`layer-${id}`, `(()=>{const e=document.getElementById('layer-${id}'); if(!e) return {found:false}; if(!e.checked)e.click(); return {found:true,checked:e.checked};})()`);
const closeLayers = () => ev('close-layers', `(()=>{const e=document.querySelector('.sm-layers-btn[aria-expanded=true]')??document.querySelector('.layers header button');e?.click();return !!e;})()`);
const layers = ['psr', 'waterice', 'danger', 'slope', 'height', 'craters'];
let steps = [{ do: 'wait', ms: 1200 }, ...shot('startup'), { do: 'ready', timeout: 60000 }, ev('app-ready', waitFor('window.__moonda?.progress?.done', 5000)), { do: 'wait', ms: 700 }];
if (phase === 'overview') {
  steps.push(...shot('overview'), ev('south-pole', `import('/src/moon/navigation.ts').then(m=>window.__moonda.nav.flyTo(m.poseLookingAt(-89.79,-154.3,0,50000,0,-60),{duration:0.3}))`), { do: 'wait', ms: 1000 }, ...shot('south-pole'));
  for (const id of layers) steps.push({ do: 'click', text: 'Layers' }, toggle(id), closeLayers(), { do: 'wait', ms: 600 }, ...shot(`globe-${id}`));
  steps.push(ev('flat', 'window.__moonda.modes.toFlat()'), { do: 'wait', ms: 1000 }, ...shot('flat-layers'));
} else if (['surface', 'tycho', 'pole'].includes(phase)) {
  const [lat, lon] = phase === 'tycho' ? [-42.3, -11.2] : phase === 'pole' ? [-89.79, -154.3] : [-26.46, 11.85];
  steps.push(ev('land', `window.__moondaTest.stand(${lat},${lon})`), ev('land-ready', waitFor("window.__moonda?.lander?.phase === 'on'", 23000)), { do: 'wait', ms: 800 }, ...shot('lander-spot'));
  for (const view of ['third', 'first']) steps.push(ev(`camera-${view}`, `window.__landerLink.setView('${view}');window.__landerLink.setWalk(true);document.activeElement?.blur();`), { do: 'wait', ms: 700 }, { do: 'keydown', key: 'w' }, { do: 'wait', ms: 800 }, { do: 'keyup', key: 'w' }, ...shot(`lander-${view}`));
  steps.push({ do: 'key', key: 'm' }, { do: 'wait', ms: 1200 }, { do: 'click', text: 'Layers' });
  for (const id of layers) steps.push(toggle(id), { do: 'wait', ms: 200 });
  steps.push(closeLayers(), { do: 'wait', ms: 700 }, ...shot('big-map-layers'));
} else throw new Error(`Unknown phase ${phase}`);
steps.push(ev('summary', '({errors:window.__phoneGraphics.checkpoint("summary").errors, state:window.__moondaTest.state()})'));
writeFileSync(join(out, 'scenario.json'), JSON.stringify(steps, null, 2));
const profile = join(out, 'browser-profile');
const child = spawn(process.execPath, ['--import', join(scripts, 'check-phone-profile.mjs'), join(scripts, 'drive.mjs'), join(out, 'scenario.json'), '--out', out, '--url', flag('--url', 'http://localhost:5194/'), '--width', args.includes('--desktop') ? '1440' : '412', '--height', args.includes('--desktop') ? '900' : '915', '--profile', profile], { cwd: resolve(scripts, '..'), env: { ...process.env, TMPDIR: out, MOONDA_PHONE_OUT: out, MOONDA_PHONE_DESKTOP: args.includes('--desktop') ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.on('data', b => { stdout += b; });
child.stderr.on('data', b => { stderr += b; process.stderr.write(b); });
const code = await new Promise(done => child.on('exit', done));
writeFileSync(join(out, 'driver-stdout.txt'), stdout); writeFileSync(join(out, 'driver-stderr.txt'), stderr);
// drive leaves explicit profiles alone. Remove ours only after its Chrome has exited.
const commands = execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' });
for (const path of [profile, join(out, 'browser-cache')]) {
  if (!existsSync(path)) continue;
  const identity = realpathSync(path);
  if (!commands.split('\n').some(c => c.includes('--user-data-dir=') && c.includes(identity))) rmSync(path, { recursive: true, force: true });
}
const failures = [], checks = { phase, driverExit: code, failures, pixels: [], resourceMaximums: {} };
if (code !== 0) failures.push(`Driver exited ${code}`);
const resultPath = join(out, 'result.json'), graphicsPath = join(out, 'graphics.json');
if (!existsSync(resultPath) || !existsSync(graphicsPath)) failures.push('Driver or graphics capture is missing');
else {
  const result = JSON.parse(readFileSync(resultPath, 'utf8')), graphics = JSON.parse(readFileSync(graphicsPath, 'utf8'));
  for (const step of result.steps) if (/ERROR:|NOT FOUND:|TIMED OUT/.test(step.note ?? '')) failures.push(step.note);
  for (const key of ['app-ready', ...(phase === 'overview' ? [] : ['land-ready'])]) if (result.evals[key] !== true) failures.push(`${key} did not finish`);
  for (const id of layers) if (!result.evals[`layer-${id}`]?.found || !result.evals[`layer-${id}`]?.checked) failures.push(`Layer ${id} was not switched on`);
  failures.push(...result.errors.map(e=>`Page: ${e}`));
  failures.push(...graphics.errors.map(e=>`GL: ${JSON.stringify(e)}`));
  failures.push(...graphics.renderErrors.map(e=>`Cesium: ${e.message}`));
  for (const shader of graphics.shaders) if (!shader.compiled) failures.push(`Shader ${shader.file} did not compile: ${shader.log}`);
  for (const [index, program] of graphics.programs.entries()) if (!program.linked) failures.push(`Program ${index} did not link: ${program.log}`);
  const samplerTypes = new Set([35678, 35679, 35680, 35682, 36289, 36292, 36293, 36298, 36299, 36300, 36303, 36306, 36307, 36308, 36311]);
  const resources = graphics.programs.map(p=>({ samplers:p.uniforms.reduce((n,u)=>n+(samplerTypes.has(u.type)?u.size:0),0), uniformVectors:p.uniforms.reduce((n,u)=>n+u.size*({35674:2,35675:3,35676:4,35685:2,35686:2,35687:3,35688:3,35689:4,35690:4}[u.type]??1),0) }));
  checks.resourceMaximums = { samplers:Math.max(0,...resources.map(r=>r.samplers)), conservativeCombinedUniformVectors:Math.max(0,...resources.map(r=>r.uniformVectors)) };
  if (!args.includes('--desktop') && checks.resourceMaximums.samplers > 16) failures.push('A linked program exceeds 16 conservative combined sampler elements');
  if (!args.includes('--desktop') && checks.resourceMaximums.conservativeCombinedUniformVectors > 224) failures.push('Review required: combined uniforms exceed 224 conservative vectors');
  const names = phase === 'overview' ? ['overview','south-pole',...layers.map(id=>`globe-${id}`),'flat-layers'] : ['lander-spot','lander-third','lander-first','big-map-layers'];
  for (const name of names) {
    const checkpoint = graphics.checkpoints.find(c=>c.name===name);
    if (!checkpoint) { failures.push(`Missing checkpoint ${name}`); continue; }
    if (name.startsWith('lander-') && (checkpoint.phase !== 'on' || checkpoint.view !== name.slice(7))) failures.push(`${name} did not reach its surface camera`);
    if (name.startsWith('lander-') && !checkpoint.minimap) failures.push(`${name} has no round minimap`);
    if (name === 'big-map-layers' && !checkpoint.map) failures.push('The big map was not opened');
    const file = join(out, `${name}.png`);
    if (!existsSync(file)) { failures.push(`Missing screenshot ${name}`); continue; }
    try {
      const png = decodePng(readFileSync(file));
      const region = name.startsWith('lander-') ? [.22,.48,.78,.72] : name.startsWith('big-map') ? [.30,.25,.70,.70] : [.22,.38,.78,.65];
      const pixels = samplePixels(png, region); checks.pixels.push({ name, ...pixels });
      if (pixels.meanLuma < 3 || pixels.visibleFraction < .02 || pixels.colors < 32) failures.push(`${name} has a black or nearly uniform sampled scene region`);
    } catch (error) { failures.push(`Cannot inspect ${name}: ${error.message}`); }
  }
  if (phase === 'surface') {
    const first=graphics.checkpoints.find(c=>c.name==='lander-spot'),last=graphics.checkpoints.find(c=>c.name==='lander-first');
    if (!(last?.distanceM > first?.distanceM + .1)) failures.push('The flat-site drive did not move at least 10 cm');
  }
  if (!args.includes('--desktop')) {
    if (!graphics.coarse || graphics.fine || !graphics.userAgent.includes('Android')) failures.push('Phone touch/user-agent profile did not apply');
    const large = graphics.resources.filter(r=>/\/(?:moon8k|south6|north6|milkyway_8k)[./]/.test(r.url));
    if (large.length) failures.push(`Phone requested a large base/sky image: ${large.map(r=>r.url).join(', ')}`);
  }
  checks.shaders = graphics.shaders.length; checks.programs = graphics.programs.length;
}
writeFileSync(join(out, 'check.json'), JSON.stringify(checks, null, 2));
console.log(JSON.stringify({ phase, out, passed: failures.length === 0, failures, shaders:checks.shaders, programs:checks.programs }));
process.exitCode = failures.length ? 1 : 0;

function decodePng(buffer) {
  let width, height, channels, offset=8; const chunks=[];
  while(offset<buffer.length) {
    const length=buffer.readUInt32BE(offset), name=buffer.toString('ascii',offset+4,offset+8), data=buffer.subarray(offset+8,offset+8+length);
    if(name==='IHDR') { width=data.readUInt32BE(0);height=data.readUInt32BE(4);channels=({2:3,6:4})[data[9]];if(data[8]!==8||!channels||data[12])throw new Error('Unsupported PNG pixel format'); }
    if(name==='IDAT')chunks.push(data); offset+=length+12;
  }
  const raw=inflateSync(Buffer.concat(chunks)), stride=width*channels, pixels=Buffer.alloc(height*stride);
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<height;y++) { const filter=raw[y*(stride+1)]; for(let x=0;x<stride;x++) { const i=y*stride+x,a=x>=channels?pixels[i-channels]:0,b=y?pixels[i-stride]:0,c=y&&x>=channels?pixels[i-stride-channels]:0,v=raw[y*(stride+1)+1+x];pixels[i]=(v+([0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter]??0))&255; } }
  return {width,height,channels,pixels};
}
function samplePixels(png, region) {
  let total=0, visible=0, n=0;const colors=new Set();
  for(let y=Math.floor(region[1]*png.height);y<region[3]*png.height;y+=2)for(let x=Math.floor(region[0]*png.width);x<region[2]*png.width;x+=2){const i=(y*png.width+x)*png.channels,r=png.pixels[i],g=png.pixels[i+1],b=png.pixels[i+2],l=.2126*r+.7152*g+.0722*b;total+=l;visible+=l>8?1:0;n++;colors.add((r<<16)|(g<<8)|b);}
  return {meanLuma:+(total/n).toFixed(3),visibleFraction:+(visible/n).toFixed(4),colors:colors.size};
}
