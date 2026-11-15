// Static decoded-memory estimate. This is not the browser's total RSS or the driver's allocation size.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const out = process.argv[2];
function imageSize(b) {
  if (b[0] === 137 && b.subarray(1, 4).toString() === 'PNG') return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b[0] === 255 && b[1] === 216) {
    for (let i = 2; i < b.length - 8;) {
      if (b[i] !== 255) { i++; continue; }
      const marker = b[i + 1], len = b.readUInt16BE(i + 2);
      if ([192, 193, 194].includes(marker)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      i += 2 + len;
    }
  }
  if (b.subarray(0, 4).toString() === 'RIFF') {
    const kind = b.subarray(12, 16).toString();
    if (kind === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
    if (kind === 'VP8 ') return [b.readUInt16LE(26) & 16383, b.readUInt16LE(28) & 16383];
    if (kind === 'VP8L') { const n = b.readUInt32LE(21); return [(n & 16383) + 1, ((n >>> 14) & 16383) + 1]; }
  }
  throw Error('Unknown image');
}
function texBytes([w, h], channels = 4, max = Infinity) {
  const scale = Math.min(1, max / Math.max(w, h)); w = Math.max(1, Math.floor(w * scale)); h = Math.max(1, Math.floor(h * scale));
  let total = 0;
  for (;;) { total += w * h * channels; if (w === 1 && h === 1) break; w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
  return total;
}
function model(file, phoneMax = Infinity) {
  const bytes = readFileSync(join(root, file));
  let g, bin;
  if (file.endsWith('.glb')) { const n = bytes.readUInt32LE(12); g = JSON.parse(bytes.subarray(20, 20 + n).toString()); bin = bytes.subarray(28 + n); }
  else g = JSON.parse(bytes.toString());
  const image = id => { const im = g.images[id]; if (im.uri) return readFileSync(resolve(root, dirname(file), im.uri)); const v = g.bufferViews[im.bufferView]; return bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength); };
  const sizes = g.images.map((_, id) => imageSize(image(id)));
  function usedTextures(phone) {
    const ids = new Set();
    function walk(value) { if (!value || typeof value !== 'object') return; for (const [key, v] of Object.entries(value)) { if (phone && ['normalTexture', 'occlusionTexture', 'metallicRoughnessTexture'].includes(key)) continue; if (key.endsWith('Texture') && typeof v?.index === 'number') ids.add(v.index); else walk(v); } }
    for (const m of g.materials ?? []) walk(m);
    return [...ids].map(id => { const t = g.textures[id], im = t.extensions?.EXT_texture_webp?.source ?? t.source; return { id, image: im, name: g.images[im].name, size: sizes[im], bytesWithMips: texBytes(sizes[im], 4, phone ? phoneMax : Infinity) }; });
  }
  const accessors = new Set();
  for (const mesh of g.meshes ?? []) for (const p of mesh.primitives) { for (const id of Object.values(p.attributes ?? {})) accessors.add(id); if (p.indices !== undefined) accessors.add(p.indices); for (const target of p.targets ?? []) for (const id of Object.values(target)) accessors.add(id); }
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }, componentBytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const accessorBytes = [...accessors].reduce((n, id) => { const a = g.accessors[id]; return n + a.count * components[a.type] * componentBytes[a.componentType]; }, 0);
  const before = usedTextures(false), after = usedTextures(true);
  return { file, downloadBytes: bytes.length + (bin ? 0 : (g.buffers ?? []).reduce((n, b) => n + b.byteLength, 0)), accessorBytes, texturesBefore: before, texturesAfter: after, textureBytesBefore: before.reduce((n, t) => n + t.bytesWithMips, 0), textureBytesAfter: after.reduce((n, t) => n + t.bytesWithMips, 0) };
}
const rocks = readdirSync(join(root, 'lander/rocks')).filter(n => n.startsWith('moon_rock_')).sort().map(n => model(`lander/rocks/${n}/rock.gltf`, 512));
const rover = model('lander/rover/rover-moonda.glb', 512);
const sky = [['milkyway_4k.jpg', 3], ['earth_day_4k.jpg', 3], ['earth_night_4k.jpg', 1], ['earth_clouds_2k.jpg', 1]].map(([file, channels]) => { const b = readFileSync(join(root, 'space', file)), size = imageSize(b); return { file, size, downloadBytes: b.length, channels, bytesBefore: texBytes(size, channels), bytesAfter: texBytes(size, channels, 1024), rgbaUpperBefore: texBytes(size), rgbaUpperAfter: texBytes(size, 4, 1024) }; });
const regolith = ['a', 'b', 'c'].map(s => { const file = `lander/regolith_${s}.webp`, b = readFileSync(join(root, file)), size = imageSize(b); return { file, size, downloadBytes: b.length, bytesBefore: texBytes(size), bytesAfter: texBytes(size, 4, 1024) }; });
const dem = JSON.parse(readFileSync(join(root, 'data/dem/dem.json')));
const heights = { fixedBytesPerCopy: (dem.global.width * dem.global.height + dem.overview.size ** 2) * 2, polarTileBytes: dem.tiles.tileSize ** 2 * 2, availablePolarTileUpperBound: dem.tiles.count ** 2 };
const sum = (xs, k) => xs.reduce((n, x) => n + x[k], 0);
const totals = { regolithBefore: sum(regolith, 'bytesBefore'), regolithAfter: sum(regolith, 'bytesAfter'), skyBefore: sum(sky, 'bytesBefore'), skyAfter: sum(sky, 'bytesAfter'), rockTexturesBefore: sum(rocks, 'textureBytesBefore'), rockTexturesAfter: sum(rocks, 'textureBytesAfter'), rockGeometryAccessors: sum(rocks, 'accessorBytes'), roverTexturesBefore: rover.textureBytesBefore, roverTexturesAfter: rover.textureBytesAfter, roverGeometryAccessors: rover.accessorBytes };
const result = { method: 'Exact mip texel arithmetic for requested formats, 4 bytes/texel for Cesium model textures; distinct texture IDs count separately; geometry accessor bytes can differ from shared, interleaved, decoded and aligned driver allocations. No browser/driver overhead, framebuffers, tile cache, app JS, science rasters or transient decode included.', totals, heights, regolith, sky, rocks, rover };
if (out) { mkdirSync(dirname(resolve(out)), { recursive: true }); writeFileSync(out, JSON.stringify(result, null, 2)); }
console.log(JSON.stringify({ totals, totalsMiB: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, +(v / 2 ** 20).toFixed(3)])), heights }, null, 2));
