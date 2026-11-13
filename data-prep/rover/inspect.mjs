// node inspect.mjs <file.glb> : nodes, meshes (triangles, bounds), materials, textures
import { io } from './_tools.mjs';
const doc = await (await io()).read(process.argv[2]);
const root = doc.getRoot();
const walk = (n, d) => {
  const m = n.getMesh();
  let info = '';
  if (m) { let tris = 0; for (const p of m.listPrimitives()) { const i = p.getIndices(); tris += (i ? i.getCount() : p.getAttribute('POSITION').getCount()) / 3; } info = ` mesh=${m.getName()} tris=${tris} prims=${m.listPrimitives().length} mat=${m.listPrimitives().map(p => p.getMaterial()?.getName()).join(',')}`; }
  console.log(`${'  '.repeat(d)}${n.getName()} t=${n.getTranslation().map(v => v.toFixed(2))} r=${n.getRotation().map(v => v.toFixed(2))} s=${n.getScale().map(v => v.toFixed(2))}${info}`);
  for (const c of n.listChildren()) walk(c, d + 1);
};
for (const s of root.listScenes()) for (const n of s.listChildren()) walk(n, 0);
for (const t of root.listTextures()) console.log('tex', t.getName(), t.getMimeType(), t.getSize(), t.getImage()?.byteLength);
for (const m of root.listMaterials()) console.log('mat', m.getName(), 'base', !!m.getBaseColorTexture(), 'nrm', !!m.getNormalTexture(), 'mr', !!m.getMetallicRoughnessTexture(), m.getMetallicFactor(), m.getRoughnessFactor());
console.log('anims', root.listAnimations().map(a => a.getName() + ':' + a.listChannels().map(c => c.getTargetNode()?.getName() + '.' + c.getTargetPath()).join('|')).join('\n'));
console.log('exts', root.listExtensionsUsed().map(e => e.extensionName));
