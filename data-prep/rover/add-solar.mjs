// Re-runnable: adds MOONDA's small solar array to the (wheel-split) rover model.
//   GLTF_TOOLS=<tools folder> node add-solar.mjs <in rover-wheels.glb> <out rover-moonda.glb>
// Nodes (model metres, +Y up, +Z front, +X the rover's left):
//   solar_post  - a short post standing on the rear deck (static)
//   solar_yaw   - at the top of the post: turns about +Y (the app turns it to face the Sun's compass direction)
//     solar_tilt - turns about +X (tilts the panel up towards the Sun; 0 = folded flat)
//       solar_panel - the framed panel: cells on top (+Y), a white back, an aluminium frame
// The cell texture is drawn here (no files read): a 6 x 4 grid of dark blue cells with silver bus lines.
import { io as getIO, sharp } from './_tools.mjs';
const [, , src, dst] = process.argv;
const io = await getIO();
const doc = await io.read(src);
const root = doc.getRoot(), buffer = root.listBuffers()[0], scene = root.listScenes()[0];
if (root.listNodes().some(n => n.getName() === 'solar_yaw')) throw new Error('already has a solar array');

const POST = [0.02, 1.13, -0.46], TOP = 1.80;      // post foot on the deck, pivot height
const W = 1.04, D = 0.72, TH = 0.03, RIM = 0.035;  // panel width (x), depth (z), thickness, frame width

// ---- geometry helpers -------------------------------------------------------------------------
function prim(mat, pos, nrm, uv, idx) {
  const p = doc.createPrimitive().setMaterial(mat);
  p.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer));
  p.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(nrm)).setBuffer(buffer));
  p.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(uv)).setBuffer(buffer));
  p.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(idx)).setBuffer(buffer));
  return p;
}
/** an axis-aligned box from (x0,y0,z0) to (x1,y1,z1); faces listed in `faces` ('+y','-y','+x','-x','+z','-z') */
function box(acc, x0, y0, z0, x1, y1, z1, faces = ['+y', '-y', '+x', '-x', '+z', '-z']) {
  const F = {
    '+y': [[0, 1, 0], [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]]],
    '-y': [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
    '+x': [[1, 0, 0], [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]]],
    '-x': [[-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]],
    '+z': [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
    '-z': [[0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]],
  };
  for (const f of faces) {
    const [n, q] = F[f], b = acc.pos.length / 3;
    q.forEach((v, i) => { acc.pos.push(...v); acc.nrm.push(...n); acc.uv.push(i === 1 || i === 2 ? 1 : 0, i >= 2 ? 1 : 0); });
    acc.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
}
function cyl(acc, r, y0, y1, seg = 14) {
  const b = acc.pos.length / 3;
  for (let i = 0; i <= seg; i++) {
    const a = i / seg * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
    acc.pos.push(r * c, y0, r * s, r * c, y1, r * s); acc.nrm.push(c, 0, s, c, 0, s); acc.uv.push(i / seg, 0, i / seg, 1);
  }
  for (let i = 0; i < seg; i++) { const k = b + 2 * i; acc.idx.push(k, k + 1, k + 3, k, k + 3, k + 2); }
}
const A = () => ({ pos: [], nrm: [], uv: [], idx: [] });

// ---- materials -----------------------------------------------------------------------------------
const metal = doc.createMaterial('solar_frame').setBaseColorFactor([0.62, 0.63, 0.65, 1]).setMetallicFactor(0.9).setRoughnessFactor(0.35);
const back = doc.createMaterial('solar_back').setBaseColorFactor([0.78, 0.78, 0.76, 1]).setMetallicFactor(0).setRoughnessFactor(0.8);
const cells = doc.createMaterial('solar_cells').setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0.35).setRoughnessFactor(0.18);
// the cell picture: 512 x 352 px for 6 x 4 cells, each cell with a slightly varied blue, thin silver fingers and two bus bars
{
  const w = 768, h = 512, px = Buffer.alloc(w * h * 3), cx = 6, cz = 4, gap = 6;
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const tone = []; for (let i = 0; i < cx * cz; i++) tone.push(0.9 + 0.2 * rnd());
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const cw = w / cx, ch = h / cz, i = Math.floor(x / cw), j = Math.floor(y / ch), u = x - i * cw, v = y - j * ch;
    let c;
    if (u < gap / 2 || u > cw - gap / 2 || v < gap / 2 || v > ch - gap / 2) c = [205, 208, 212]; // white backsheet between cells
    else if (Math.abs(u - cw / 3) < 1.6 || Math.abs(u - 2 * cw / 3) < 1.6) c = [178, 182, 188]; // bus bars
    else if (v % 9 < 1) c = [70, 82, 104]; // fine fingers
    else {
      const t = tone[j * cx + i], g = 0.85 + 0.15 * Math.sin((u + v) * 0.05 + i);
      c = [16 * t * g, 30 * t * g, 66 * t * g];
      // cut corners of mono cells
      const k = Math.min(u, cw - u) + Math.min(v, ch - v);
      if (Math.min(u, cw - u) + Math.min(v, ch - v) < 14 && k < 14) c = [205, 208, 212];
    }
    const o = (y * w + x) * 3; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2];
  }
  if (!sharp) throw new Error('sharp is needed in GLTF_TOOLS to encode the cell texture');
  const webp = await sharp(px, { raw: { width: w, height: h, channels: 3 } }).webp({ quality: 88 }).toBuffer();
  const png = await sharp(px, { raw: { width: w, height: h, channels: 3 } }).resize(512, 256).png({ compressionLevel: 9 }).toBuffer();
  // the model's textures are webp with a fallback; keep that shape: EXT_texture_webp on the webp, png as the source
  const texW = doc.createTexture('solar_cells').setImage(webp).setMimeType('image/webp');
  const texP = doc.createTexture('solar_cells_fallback').setImage(png).setMimeType('image/png');
  cells.setBaseColorTexture(texP);
  const ext = root.listExtensionsUsed().find(e => e.extensionName === 'EXT_texture_webp');
  if (ext) {
    // gltf-transform's webp extension swaps a texture in when its mime type is webp: point the material at the webp
    cells.setBaseColorTexture(texW);
    texP.dispose();
  }
}

// ---- meshes and nodes ----------------------------------------------------------------------------
const post = A(); cyl(post, 0.035, 0, TOP - POST[1] - 0.04);
box(post, -0.06, TOP - POST[1] - 0.06, -0.05, 0.06, TOP - POST[1] - 0.0, 0.05); // the turning head
const postMesh = doc.createMesh('solar_post').addPrimitive(prim(metal, post.pos, post.nrm, post.uv, post.idx));
const postNode = doc.createNode('solar_post').setMesh(postMesh).setTranslation(POST);
scene.addChild(postNode);

const yaw = doc.createNode('solar_yaw').setTranslation([POST[0], TOP, POST[2]]);
const tilt = doc.createNode('solar_tilt');
// hinge fork under the panel
const fork = A(); box(fork, -0.09, -0.03, -0.02, 0.09, 0.02, 0.02);
yaw.setMesh(doc.createMesh('solar_hinge').addPrimitive(prim(metal, fork.pos, fork.nrm, fork.uv, fork.idx)));
// panel: centred on the hinge in x and z, its underside 2.5 cm above the hinge axis
const y0 = 0.025, y1 = y0 + TH, hx = W / 2, hz = D / 2;
const top = A(); box(top, -hx + RIM, y1 - 0.004, -hz + RIM, hx - RIM, y1 - 0.004, hz - RIM, ['+y']);
const under = A(); box(under, -hx, y0, -hz, hx, y0, hz, ['-y']);
const frame = A();
box(frame, -hx, y0, -hz, hx, y1, -hz + RIM); box(frame, -hx, y0, hz - RIM, hx, y1, hz);
box(frame, -hx, y0, -hz + RIM, -hx + RIM, y1, hz - RIM); box(frame, hx - RIM, y0, -hz + RIM, hx, y1, hz - RIM);
box(frame, -0.03, y0 - 0.02, -hz + RIM, 0.03, y0, hz - RIM, ['-y', '+x', '-x']); // a spine under the panel
const panelMesh = doc.createMesh('solar_panel')
  .addPrimitive(prim(cells, top.pos, top.nrm, top.uv, top.idx))
  .addPrimitive(prim(back, under.pos, under.nrm, under.uv, under.idx))
  .addPrimitive(prim(metal, frame.pos, frame.nrm, frame.uv, frame.idx));
const panel = doc.createNode('solar_panel').setMesh(panelMesh);
tilt.addChild(panel); yaw.addChild(tilt); scene.addChild(yaw);
await io.write(dst, doc);
console.log(JSON.stringify({ post: POST, pivot: [POST[0], TOP, POST[2]], size: [W, D] }));
