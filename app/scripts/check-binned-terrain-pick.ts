// Run: node scripts/check-binned-terrain-pick.ts. Every accepted pick must equal a full native
// triangle scan exactly, including cut-up meshes, real curved positions, exaggeration and skirts.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && context.parentURL && !/\.[a-z]+$/i.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
  }
  return nextResolve(specifier, context);
} });
const C = await import('cesium');
const { default: TerrainEncoding } = await import('@cesium/engine/Source/Core/TerrainEncoding.js');
const { pickBinnedTerrain } = await import('../src/moon/lolaTerrain.ts');
assert.equal(typeof pickBinnedTerrain, 'function', 'the binned terrain picker is exported');
type V3 = InstanceType<typeof C.Cartesian3>;
type Ray = InstanceType<typeof C.Ray>;
const R = 1737400, ellipsoid = new C.Ellipsoid(R, R, R), scheme = new C.GeographicTilingScheme({ ellipsoid });
let seed = 705173, worstErrorM = 0, exactHits = 0, nativeMisses = 0, skirtOnlyHits = 0;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const shuffle = <T>(values: T[]) => {
  for (let i = values.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [values[i], values[j]] = [values[j], values[i]]; }
  return values;
};

function fixture(total: 52 | 1151 | 4485, level: number, latitude: number, longitude: number, exaggeration: number, upsampled: boolean, baseHeight: number) {
  const nx = total === 4485 ? 65 : total === 52 ? 5 : 31, ny = total === 4485 ? 65 : total === 52 ? 6 : 31;
  const xy = scheme.positionToTileXY(C.Cartographic.fromDegrees(longitude, latitude), level)!;
  const rectangle = scheme.tileXYToRectangle(xy.x, xy.y, level);
  const centre = C.Cartesian3.fromRadians((rectangle.west + rectangle.east) / 2, (rectangle.south + rectangle.north) / 2, baseHeight, ellipsoid);
  const fromENU = C.Transforms.eastNorthUpToFixedFrame(centre, ellipsoid), toENU = C.Matrix4.inverseTransformation(fromENU, new C.Matrix4());
  const points: { p: V3; uv: InstanceType<typeof C.Cartesian2>; h: number; local: V3 }[] = [];
  const height = (u: number, v: number) => {
    const bowl = Math.hypot(u - 0.44, v - 0.56) / 0.23;
    return baseHeight + 19 * Math.sin(8 * u) * Math.cos(6 * v) + 5 * u - (bowl < 1 ? 13 * (1 - bowl * bowl) ** 2 : 0);
  };
  const add = (u: number, v: number, h = height(u, v)) => {
    const p = C.Cartesian3.fromRadians(C.Math.lerp(rectangle.west, rectangle.east, u), C.Math.lerp(rectangle.south, rectangle.north, v), h, ellipsoid);
    points.push({ p, uv: new C.Cartesian2(u, v), h, local: C.Matrix4.multiplyByPoint(toENU, p, new C.Cartesian3()) });
    return points.length - 1;
  };
  const us = Array.from({ length: nx }, (_, i) => (i / (nx - 1)) ** 1.17);
  const vs = Array.from({ length: ny }, (_, i) => (i / (ny - 1)) ** 1.09);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const u = us[i] + (i > 0 && i < nx - 1 && j > 0 && j < ny - 1 ? (random() - 0.5) * 0.25 * Math.min(us[i] - us[i - 1], us[i + 1] - us[i]) : 0);
    const v = vs[j] + (i > 0 && i < nx - 1 && j > 0 && j < ny - 1 ? (random() - 0.5) * 0.25 * Math.min(vs[j] - vs[j - 1], vs[j + 1] - vs[j]) : 0);
    add(u, v);
  }
  let triangles: number[][] = [];
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const sw = j * nx + i, se = sw + 1, nw = sw + nx, ne = nw + 1;
    if (random() < 0.5) triangles.push([sw, se, ne], [sw, ne, nw]);
    else triangles.push([sw, se, nw], [se, ne, nw]);
  }
  // Extra vertices inside arbitrary triangles resemble clipped child topology: neither vertex
  // order nor the diagonal pattern can be treated as the provider's regular 65 x 65 grid.
  if (total === 1151) {
    const split = new Set<number>();
    while (split.size < 66) split.add(Math.floor(random() * triangles.length));
    triangles = triangles.flatMap((t, i) => {
      if (!split.has(i)) return [t];
      const u = t.reduce((sum, k) => sum + points[k].uv.x, 0) / 3, v = t.reduce((sum, k) => sum + points[k].uv.y, 0) / 3;
      const middle = add(u, v);
      return [[t[0], t[1], middle], [t[1], t[2], middle], [t[2], t[0], middle]];
    });
  }
  const vertexCountWithoutSkirts = points.length;
  const mainIndices = shuffle(triangles).flat(), mainIndexCount = mainIndices.length;
  const allIndices = [...mainIndices];
  const edges = [Array.from({ length: ny }, (_, j) => j * nx), Array.from({ length: nx }, (_, i) => nx - 1 - i),
    Array.from({ length: ny }, (_, j) => (ny - 1 - j) * nx + nx - 1), Array.from({ length: nx }, (_, i) => (ny - 1) * nx + i)];
  edges.forEach((edge, side) => {
    const first = points.length;
    edge.forEach(index => {
      const { uv, h } = points[index];
      add(uv.x + (side === 0 ? -0.0001 : side === 2 ? 0.0001 : 0), uv.y + (side === 1 ? -0.0001 : side === 3 ? 0.0001 : 0), h - 17);
    });
    for (let i = 0; i < edge.length - 1; i++) allIndices.push(edge[i], edge[i + 1], first + i + 1, edge[i], first + i + 1, first + i);
  });
  assert.equal(points.length, total, 'the irregular fixture has the requested vertex count');
  const order = shuffle(Array.from({ length: total }, (_, i) => i)), remap = new Uint16Array(total);
  order.forEach((old, index) => { remap[old] = index; });
  const box = C.AxisAlignedBoundingBox.fromPoints(points.map(p => p.local));
  const minH = Math.min(...points.map(p => p.h)), maxH = Math.max(...points.map(p => p.h));
  const encoding = new TerrainEncoding(centre, box, minH, maxH, fromENU, true, false, true, exaggeration, 1000);
  const vertices = new Float32Array(total * encoding.stride), normal = new C.Cartesian2(128, 128);
  let offset = 0;
  order.forEach(old => { const { p, uv, h } = points[old]; offset = encoding.encode(vertices, offset, p, uv, h, normal, undefined, ellipsoid.geodeticSurfaceNormal(p)); });
  const mesh = { vertices, indices: new Uint16Array(allIndices.map(index => remap[index])), encoding, vertexCountWithoutSkirts, indexCountWithoutSkirts: mainIndexCount };
  const surface = { mesh, renderedMesh: mesh, terrainData: { wasCreatedByUpsampling: () => upsampled } };
  let decoded: V3[] = [];
  const refreshDecoded = () => { decoded = Array.from({ length: total }, (_, i) => encoding.getExaggeratedPosition(mesh.vertices, i, new C.Cartesian3())); };
  refreshDecoded();
  const rayAt = (u: number, v: number) => {
    const place = new C.Cartographic(C.Math.lerp(rectangle.west, rectangle.east, u), C.Math.lerp(rectangle.south, rectangle.north, v));
    const up = C.Cartesian3.normalize(C.Cartesian3.fromRadians(place.longitude, place.latitude, 0, ellipsoid), new C.Cartesian3());
    return { place, ray: new C.Ray(C.Cartesian3.multiplyByScalar(up, R + 30000, new C.Cartesian3()), C.Cartesian3.negate(up, new C.Cartesian3())) };
  };
  const fullPick = (ray: Ray, skirts = true) => {
    let nearest = Infinity;
    const end = skirts ? mesh.indices.length : mainIndexCount;
    for (let i = 0; i < end; i += 3) {
      const t = C.IntersectionTests.rayTriangleParametric(ray, decoded[mesh.indices[i]], decoded[mesh.indices[i + 1]], decoded[mesh.indices[i + 2]], false);
      if (t !== undefined && t >= 0) nearest = Math.min(nearest, t);
    }
    return Number.isFinite(nearest) ? C.Ray.getPoint(ray, nearest) : undefined;
  };
  return { total, level, latitude, rectangle, encoding, mesh, surface, rayAt, fullPick, refreshDecoded, us, vs };
}

function compare(f: ReturnType<typeof fixture>, u: number, v: number, label: string) {
  const { place, ray } = f.rayAt(u, v), expected = f.fullPick(ray), result = new C.Cartesian3();
  const actual = pickBinnedTerrain(f.surface, f.rectangle, f.level, place, ray, result);
  if (!expected) { nativeMisses++; assert.equal(actual, undefined, `${label}: native miss stays a miss`); return; }
  assert.ok(actual, `${label}: fast path must find the actual drawn triangle L${f.level} ${u}/${v}`);
  assert.equal(actual, result, 'the picker returns its supplied result');
  const error = C.Cartesian3.distance(actual, expected); worstErrorM = Math.max(worstErrorM, error); exactHits++;
  assert.equal(error, 0, `${label}: exact full-triangle parity, got ${error}m at L${f.level} ${u}/${v}`);
  if (!f.fullPick(ray, false)) skirtOnlyHits++;
}

const cases = [
  // A level-7 tile is 0.02454 radians wide: the same bounded angular proof covers it. These
  // source meshes have all 4,225 main vertices plus Cesium's four 65-vertex skirt strips.
  [4485, 7, 0, 20, 1, false, 1200], [4485, 7, 77, -137, 1.8, false, -2200],
  [52, 8, 0, 20, 1, false, 1200], [1151, 10, -57, -137, 1, true, -2200],
  [52, 11, 33, 85, 1.8, true, 6800], [1151, 12, 77, 140, 0.6, false, 100],
  [1151, 18, -11, -22, 1.8, true, 1200], [52, 20, 23, 61, 1, true, -1500],
  [1151, 24, -70, -169, 0.6, true, 2300], [52, 14, 50, 179.9, 1, false, -100],
] as const;
const rows: object[] = [], quantizations = new Set<number>();
for (const [total, level, latitude, longitude, exaggeration, upsampled, baseHeight] of cases) {
  const f = fixture(total, level, latitude, longitude, exaggeration, upsampled, baseHeight), startHits = exactHits;
  quantizations.add(f.encoding.quantization);
  const first = f.rayAt(0.51, 0.48), firstResult = new C.Cartesian3();
  const beforeFirst = performance.now();
  const firstHit = pickBinnedTerrain(f.surface, f.rectangle, level, first.place, first.ray, firstResult);
  const firstMs = performance.now() - beforeFirst;
  assert.ok(firstHit, 'the first call builds and uses the bins');
  compare(f, 0.51, 0.48, 'cold-call parity');
  const samples = Array.from({ length: 70 }, () => [0.002 + random() * 0.996, 0.002 + random() * 0.996]);
  // Both sides of uneven grid borders, exact vertices, cell diagonals, and bin borders.
  for (const epsilon of [-1e-9, 0, 1e-9]) {
    for (const u of [0, 1, 0.25, 0.5, 0.75, f.us[1], f.us[Math.floor(f.us.length / 2)]]) samples.push([u + epsilon, 0.43], [0.57, u + epsilon]);
    samples.push([f.us[1] + epsilon, f.vs[1] - epsilon], [0.5 + epsilon, 0.5 + epsilon]);
  }
  for (const [u, v] of [[-0.00005, 0.37], [1.00005, 0.61], [0.41, -0.00005], [0.67, 1.00005], [0, 0], [1, 1]]) samples.push([u, v]);
  samples.forEach(([u, v]) => compare(f, u, v, 'irregular/cut mesh'));
  const middle = f.rayAt(0.5, 0.5), result = new C.Cartesian3();
  const pick = (surface = f.surface, testLevel = level, place = middle.place, ray = middle.ray, rectangle = f.rectangle) => pickBinnedTerrain(surface, rectangle, testLevel, place, ray, result);
  assert.equal(pick({ ...f.surface, renderedMesh: {} } as typeof f.surface), undefined, 'fill mesh retains native picking');
  for (const invalid of [-1, 6, 25, NaN, 12.5]) assert.equal(pick(f.surface, invalid), undefined, `invalid level ${invalid} retains native picking`);
  assert.equal(pick(f.surface, level, new C.Cartographic(middle.place.longitude, 80 * Math.PI / 180)), undefined, 'high latitude retains native picking');
  assert.equal(pick(f.surface, level, middle.place, new C.Ray(C.Cartesian3.clone(middle.ray.origin), C.Cartesian3.negate(middle.ray.direction, new C.Cartesian3()))), undefined, 'upward radial rays retain native picking');
  assert.equal(pick(f.surface, level, middle.place, new C.Ray(C.Cartesian3.clone(middle.ray.origin), new C.Cartesian3(1, 0, 0))), undefined, 'camera rays retain native picking');
  const offsetOrigin = C.Cartesian3.add(middle.ray.origin, new C.Cartesian3(0, 2, 3), new C.Cartesian3());
  assert.equal(pick(f.surface, level, middle.place, new C.Ray(offsetOrigin, C.Cartesian3.clone(middle.ray.direction))), undefined, 'offset parallel rays retain native picking');
  const distant = f.rayAt(-0.02, 0.5);
  assert.equal(pick(f.surface, level, distant.place, distant.ray), undefined, 'outside the skirt margin retains native picking');
  const wrapped = new C.Rectangle(3, f.rectangle.south, -3, f.rectangle.north);
  assert.equal(pick(f.surface, level, middle.place, middle.ray, wrapped), undefined, 'wrapped rectangles retain native picking');
  const beneath = new C.Ray(C.Cartesian3.multiplyByScalar(C.Cartesian3.negate(middle.ray.direction, new C.Cartesian3()), R - 30000, new C.Cartesian3()), C.Cartesian3.clone(middle.ray.direction));
  assert.equal(f.fullPick(beneath), undefined, 'the native inward ray from below really misses');
  assert.equal(pick(f.surface, level, middle.place, beneath), undefined, 'a genuine miss returns native control');
  // Cached decoded positions must follow a changed exaggeration or replaced worker vertex buffer.
  f.encoding.exaggeration = exaggeration + 0.37; f.refreshDecoded(); compare(f, 0.36, 0.62, 'changed exaggeration');
  f.encoding.exaggerationRelativeHeight = 800; f.refreshDecoded(); compare(f, 0.42, 0.58, 'changed relative height');
  f.mesh.vertices = f.mesh.vertices.slice(); f.refreshDecoded(); compare(f, 0.61, 0.29, 'replaced vertices');
  f.mesh.indices = f.mesh.indices.slice(); compare(f, 0.28, 0.71, 'replaced indices');
  const probes = samples.slice(0, 64).map(([u, v]) => f.rayAt(u, v)), repeats = 2048;
  const beginRepeated = performance.now();
  for (let i = 0; i < repeats; i++) { const q = probes[i % probes.length]; pickBinnedTerrain(f.surface, f.rectangle, level, q.place, q.ray, result); }
  const repeatedMs = performance.now() - beginRepeated;
  rows.push({ vertices: total, mainVertices: f.mesh.vertexCountWithoutSkirts, triangles: f.mesh.indices.length / 3,
    skirtTriangles: (f.mesh.indices.length - f.mesh.indexCountWithoutSkirts) / 3, level, latitude, upsampled, quantization: f.encoding.quantization, exaggeration, hits: exactHits - startHits,
    firstMs: +firstMs.toFixed(3), repeatedCalls: repeats, repeatedMs: +repeatedMs.toFixed(3), repeatedMeanUs: +(repeatedMs * 1000 / repeats).toFixed(3) });
}
assert.ok(quantizations.has(0) && quantizations.has(1), 'fixtures exercise NONE and BITS12 TerrainEncoding');
assert.ok(skirtOnlyHits > 0, 'some rays hit only an outward skirt, not the ground above it');
assert.equal(worstErrorM, 0, 'all returned positions have zero error against native full scanning');
console.log(JSON.stringify({ result: 'OK', exactHits, nativeMisses, skirtOnlyHits, worstErrorM, cases: rows }, null, 2));
