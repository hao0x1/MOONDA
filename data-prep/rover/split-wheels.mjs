// Re-runnable: splits the Perseverance model's single wheel mesh ('Wheels_objs', six wheels in one) into six nodes
// whose origins sit on their own axles, so the app can spin each wheel and move it up and down (suspension).
//   GLTF_TOOLS=<folder with @gltf-transform + draco3dgltf> node split-wheels.mjs <in rover.glb> <out rover-wheels.glb>
// Node names: wheel_LF, wheel_LM, wheel_LB, wheel_RF, wheel_RM, wheel_RB (L = model +X = the rover's left; F = +Z).
// Every other node, material and texture is left as it was. Prints each wheel's centre and radius (model metres).
import { io as getIO, core } from './_tools.mjs';
const [, , src, dst] = process.argv;
const io = await getIO();
const doc = await io.read(src);
const root = doc.getRoot();
const node = root.listNodes().find(n => n.getName() === 'Wheels_objs');
if (!node) throw new Error('no Wheels_objs node (already split?)');
const mesh = node.getMesh(), T = node.getTranslation();
if (node.getRotation().some((v, i) => Math.abs(v - [0, 0, 0, 1][i]) > 1e-6) || node.getScale().some(v => Math.abs(v - 1) > 1e-6)) throw new Error('Wheels_objs is rotated/scaled: script assumes translation only');

// 1. every triangle's centroid, over all primitives
const tris = []; // [prim index, tri index, cx, cy, cz]
const prims = mesh.listPrimitives();
prims.forEach((p, pi) => {
  const pos = p.getAttribute('POSITION'), idx = p.getIndices().getArray(), a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
  for (let t = 0; t < idx.length / 3; t++) {
    pos.getElement(idx[3 * t], a); pos.getElement(idx[3 * t + 1], b); pos.getElement(idx[3 * t + 2], c);
    tris.push([pi, t, (a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]);
  }
});
// 2. six clusters: left/right by x sign, then front/middle/back by z (k-means on z per side)
let zmin = Infinity, zmax = -Infinity;
for (const t of tris) { zmin = Math.min(zmin, t[4]); zmax = Math.max(zmax, t[4]); }
const label = new Int8Array(tris.length);
for (const side of [0, 1]) {
  let cz = [zmax - 0.1 * (zmax - zmin), (zmin + zmax) / 2, zmin + 0.1 * (zmax - zmin)]; // F, M, B
  for (let it = 0; it < 30; it++) {
    const s = [0, 0, 0], n = [0, 0, 0];
    tris.forEach((t, i) => {
      if ((t[2] >= 0 ? 0 : 1) !== side) return;
      let best = 0; for (let k = 1; k < 3; k++) if (Math.abs(t[4] - cz[k]) < Math.abs(t[4] - cz[best])) best = k;
      label[i] = side * 3 + best; s[best] += t[4]; n[best]++;
    });
    cz = cz.map((v, k) => n[k] ? s[k] / n[k] : v);
  }
}
const names = ['wheel_LF', 'wheel_LM', 'wheel_LB', 'wheel_RF', 'wheel_RM', 'wheel_RB'];
// 3. each wheel's axle: the middle of its bounding box (y, z), x = middle too (the pivot sits inside the wheel)
const box = names.map(() => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
prims.forEach((p, pi) => {
  const pos = p.getAttribute('POSITION'), idx = p.getIndices().getArray(), v = [0, 0, 0];
  tris.forEach((t, i) => {
    if (t[0] !== pi) return;
    const B = box[label[i]];
    for (let k = 0; k < 3; k++) { pos.getElement(idx[3 * t[1] + k], v); for (let j = 0; j < 3; j++) { B[j] = Math.min(B[j], v[j]); B[j + 3] = Math.max(B[j + 3], v[j]); } }
  });
});
const centre = box.map(B => [(B[0] + B[3]) / 2, (B[1] + B[4]) / 2, (B[2] + B[5]) / 2]);
const buffer = root.listBuffers()[0];
const out = [];
names.forEach((name, w) => {
  const m = doc.createMesh(name);
  prims.forEach((p, pi) => {
    const sel = [];
    tris.forEach((t, i) => { if (t[0] === pi && label[i] === w) sel.push(t[1]); });
    if (!sel.length) return;
    const idx = p.getIndices().getArray(), remap = new Map(), newIdx = new Uint32Array(sel.length * 3);
    sel.forEach((t, k) => { for (let j = 0; j < 3; j++) { const v = idx[3 * t + j]; if (!remap.has(v)) remap.set(v, remap.size); newIdx[3 * k + j] = remap.get(v); } });
    const np = doc.createPrimitive().setMaterial(p.getMaterial()).setMode(p.getMode());
    for (const sem of p.listSemantics()) {
      const a = p.getAttribute(sem), size = a.getElementSize(), arr = new Float32Array(remap.size * size), e = [];
      for (const [o, nw] of remap) { a.getElement(o, e); if (sem === 'POSITION') for (let j = 0; j < 3; j++) e[j] -= centre[w][j]; arr.set(e.slice(0, size), nw * size); }
      np.setAttribute(sem, doc.createAccessor().setType(a.getType()).setArray(arr).setNormalized(false).setBuffer(buffer));
    }
    const small = remap.size < 65536 ? new Uint16Array(newIdx) : newIdx;
    np.setIndices(doc.createAccessor().setType('SCALAR').setArray(small).setBuffer(buffer));
    m.addPrimitive(np);
  });
  const c = centre[w], B = box[w];
  const wn = doc.createNode(name).setMesh(m).setTranslation([T[0] + c[0], T[1] + c[1], T[2] + c[2]]);
  for (const s of root.listScenes()) s.addChild(wn);
  out.push({ name, centre: wn.getTranslation().map(v => +v.toFixed(4)), radius: +((B[4] - B[1]) / 2).toFixed(4), width: +(B[3] - B[0]).toFixed(4), tris: sel => 0 });
});
node.dispose(); mesh.dispose();
await io.write(dst, doc);
for (const o of out) console.log(JSON.stringify({ name: o.name, centre: o.centre, radius: o.radius, width: o.width }));
