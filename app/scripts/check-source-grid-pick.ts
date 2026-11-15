// Run: node scripts/check-source-grid-pick.ts. Compare the fast candidate pick with a full native
// ray/triangle scan of actual TerrainEncoding vertices, including curved Moon geometry and skirts.
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
const { pickRegularSourceGrid } = await import('../src/moon/lolaTerrain.ts');
const N = 65, NV = N * N, Q = Array.from({ length: N }, (_, i) => Math.round(i * 32767 / 64) / 32767);
const R = 1737400, ellipsoid = new C.Ellipsoid(R, R, R), scheme = new C.GeographicTilingScheme({ ellipsoid });
const indices: number[] = [];
for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) { const a = j * N + i; indices.push(a, a + 1, a + N + 1, a, a + N + 1, a + N); }
const mainIndexCount = indices.length;
const triangle = C.IntersectionTests.rayTriangleParametric;
let seed = 1441, worstM = 0, exactHits = 0, edgeFallbacks = 0, exactBorderNativeMisses = 0;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

function fixture(level: number, latitude: number, longitude: number, exaggeration = 1) {
  const xy = scheme.positionToTileXY(C.Cartographic.fromDegrees(longitude, latitude), level)!;
  const rectangle = scheme.tileXYToRectangle(xy.x, xy.y, level);
  const centre = C.Cartesian3.fromRadians((rectangle.west + rectangle.east) / 2, (rectangle.south + rectangle.north) / 2, 1200, ellipsoid);
  const fromENU = C.Transforms.eastNorthUpToFixedFrame(centre, ellipsoid), toENU = C.Matrix4.inverseTransformation(fromENU, new C.Matrix4());
  const positions: InstanceType<typeof C.Cartesian3>[] = [], uv: InstanceType<typeof C.Cartesian2>[] = [], heights: number[] = [], local: InstanceType<typeof C.Cartesian3>[] = [];
  const height = (u: number, v: number) => {
    const d = Math.hypot(u - 0.47, v - 0.54) / 0.16;
    return 1200 + 23 * Math.sin(u * 11) * Math.cos(v * 7) + 9 * u - (d < 1 ? 11 * (1 - d * d) ** 2 : 0);
  };
  const add = (u: number, v: number, h: number) => {
    const p = C.Cartesian3.fromRadians(C.Math.lerp(rectangle.west, rectangle.east, u), C.Math.lerp(rectangle.south, rectangle.north, v), h, ellipsoid);
    positions.push(p); uv.push(new C.Cartesian2(u, v)); heights.push(h); local.push(C.Matrix4.multiplyByPoint(toENU, p, new C.Cartesian3()));
  };
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) add(Q[i], Q[j], height(Q[i], Q[j]));
  const allIndices = [...indices];
  // The same four edge orders and small outward skirt offset used by Cesium's quantized worker.
  const edges = [Array.from({ length: N }, (_, j) => j * N), Array.from({ length: N }, (_, i) => N - 1 - i),
    Array.from({ length: N }, (_, j) => (N - 1 - j) * N + N - 1), Array.from({ length: N }, (_, i) => (N - 1) * N + i)];
  edges.forEach((edge, side) => {
    const start = positions.length;
    edge.forEach(vertex => { const p = uv[vertex]; add(p.x + (side === 0 ? -0.0001 : side === 2 ? 0.0001 : 0), p.y + (side === 1 ? -0.0001 : side === 3 ? 0.0001 : 0), heights[vertex] - 17); });
    for (let i = 0; i < N - 1; i++) allIndices.push(edge[i], edge[i + 1], start + i + 1, edge[i], start + i + 1, start + i);
  });
  const box = C.AxisAlignedBoundingBox.fromPoints(local), minH = Math.min(...heights), maxH = Math.max(...heights);
  const encoding = new TerrainEncoding(centre, box, minH, maxH, fromENU, true, false, true, exaggeration, 1000);
  const vertices = new Float32Array(positions.length * encoding.stride), normal = new C.Cartesian2(128, 128);
  let offset = 0;
  positions.forEach((p, i) => { offset = encoding.encode(vertices, offset, p, uv[i], heights[i], normal, undefined, ellipsoid.geodeticSurfaceNormal(p)); });
  const mesh = { vertices, indices: new Uint16Array(allIndices), encoding, vertexCountWithoutSkirts: NV, indexCountWithoutSkirts: mainIndexCount };
  const surface = { mesh, renderedMesh: mesh, terrainData: { wasCreatedByUpsampling: () => false } };
  const decoded = positions.map((_, i) => encoding.getExaggeratedPosition(vertices, i, new C.Cartesian3()));
  const rayAt = (u: number, v: number) => {
    const place = new C.Cartographic(C.Math.lerp(rectangle.west, rectangle.east, u), C.Math.lerp(rectangle.south, rectangle.north, v));
    const up = C.Cartesian3.fromRadians(place.longitude, place.latitude, 0, ellipsoid);
    C.Cartesian3.normalize(up, up);
    return { place, ray: new C.Ray(C.Cartesian3.multiplyByScalar(up, R + 20000, new C.Cartesian3()), C.Cartesian3.negate(up, new C.Cartesian3())) };
  };
  const fullPick = (ray: InstanceType<typeof C.Ray>) => {
    let nearest = Infinity;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const t = triangle(ray, decoded[mesh.indices[i]], decoded[mesh.indices[i + 1]], decoded[mesh.indices[i + 2]], false);
      if (t !== undefined && t >= 0) nearest = Math.min(nearest, t);
    }
    return Number.isFinite(nearest) ? C.Ray.getPoint(ray, nearest) : undefined;
  };
  return { rectangle, mesh, surface, rayAt, fullPick, level, encoding };
}

const rows: { level: number; latitude: number; quantization: number; exaggeration: number; hits: number }[] = [];
for (const [level, latitude, longitude, exaggeration] of [[8, 0, 20, 1], [10, -57, -137, 1], [11, 33, 85, 1], [12, 77, 140, 1], [14, -11, -22, 1.8], [18, 23, 61, 1], [18, -70, -169, 0.6]]) {
  const f = fixture(level, latitude, longitude, exaggeration), startHits = exactHits;
  const samples: number[][] = Array.from({ length: 45 }, () => [0.04 + random() * 0.92, 0.04 + random() * 0.92]);
  // Both sides of quantized grid edges, plus shared triangle diagonals and almost-vertices.
  for (const index of [2, 17, 32, 61]) for (const epsilon of [-1e-8, 0, 1e-8]) samples.push([Q[index] + epsilon, Q[31] + epsilon], [Q[28] + epsilon, Q[index] - epsilon]);
  for (const [u, v] of samples) {
    const { place, ray } = f.rayAt(u, v), expected = f.fullPick(ray);
    assert.ok(expected, `native full scan hits L${level} at ${u}/${v}`);
    const actual = pickRegularSourceGrid(f.surface, f.rectangle, level, place, ray, new C.Cartesian3());
    assert.ok(actual, `regular interior takes fast path L${level} at ${u}/${v}`);
    const error = C.Cartesian3.distance(actual, expected); worstM = Math.max(worstM, error); exactHits++;
    assert.ok(error <= 1e-5, `exact triangle parity within 0.01mm, got ${error}m`);
  }
  for (const [u, v] of [[0, 0.5], [1, 0.5], [0.5, 0], [0.5, 1], [0.005, 0.31], [0.995, 0.77], [Q[1] - 1e-8, 0.5]]) {
    const { place, ray } = f.rayAt(u, v);
    assert.equal(pickRegularSourceGrid(f.surface, f.rectangle, level, place, ray, new C.Cartesian3()), undefined, 'tile edge retains native skirt truth');
    const native = f.fullPick(ray);
    if (u > 0 && u < 1 && v > 0 && v < 1) assert.ok(native, 'an interior edge-cell fallback has a real triangle hit');
    else if (!native) exactBorderNativeMisses++; // compression can move the whole edge beside the exact ray
    edgeFallbacks++;
  }
  const middle = f.rayAt(0.5, 0.5);
  assert.equal(pickRegularSourceGrid({ ...f.surface, renderedMesh: {} }, f.rectangle, level, middle.place, middle.ray, new C.Cartesian3()), undefined, 'fill mesh uses native picker');
  assert.equal(pickRegularSourceGrid({ ...f.surface, terrainData: { wasCreatedByUpsampling: () => true } }, f.rectangle, level, middle.place, middle.ray, new C.Cartesian3()), undefined, 'cut child uses native picker');
  assert.equal(pickRegularSourceGrid(f.surface, f.rectangle, 7, middle.place, middle.ray, new C.Cartesian3()), undefined, 'coarse source keeps native picker');
  const bentRay = new C.Ray(C.Cartesian3.clone(middle.ray.origin), new C.Cartesian3(1, 0, 0));
  assert.equal(pickRegularSourceGrid(f.surface, f.rectangle, level, middle.place, bentRay, new C.Cartesian3()), undefined, 'a camera ray cannot use a radial-cell guess');
  const inside = C.Cartesian3.normalize(middle.ray.origin, new C.Cartesian3());
  const missingRay = new C.Ray(C.Cartesian3.multiplyByScalar(inside, R - 20000, inside), C.Cartesian3.clone(middle.ray.direction));
  assert.equal(f.fullPick(missingRay), undefined, 'the inward ray from beneath the tile really misses');
  assert.equal(pickRegularSourceGrid(f.surface, f.rectangle, level, middle.place, missingRay, new C.Cartesian3()), undefined, 'a candidate miss returns control to native picking');
  const changed = { ...f.mesh, indices: f.mesh.indices.slice() }; changed.indices[0] = 1;
  assert.equal(pickRegularSourceGrid({ ...f.surface, mesh: changed, renderedMesh: changed }, f.rectangle, level, middle.place, middle.ray, new C.Cartesian3()), undefined, 'irregular index order rejects the fast path');
  rows.push({ level, latitude, quantization: f.encoding.quantization, exaggeration, hits: exactHits - startHits });
}
const polar = fixture(12, 84, 10), polarRay = polar.rayAt(0.5, 0.5);
assert.equal(pickRegularSourceGrid(polar.surface, polar.rectangle, 12, polarRay.place, polarRay.ray, new C.Cartesian3()), undefined, 'narrow polar cells retain native pick');
const wrapped = { ...polar.rectangle, west: 3, east: -3 };
assert.equal(pickRegularSourceGrid(polar.surface, wrapped, 12, polarRay.place, polarRay.ray, new C.Cartesian3()), undefined, 'wrapped bounds retain native pick');
console.log(JSON.stringify({ result: 'OK', exactHits, edgeFallbacks, exactBorderNativeMisses, worstErrorM: worstM, cases: rows }, null, 2));
