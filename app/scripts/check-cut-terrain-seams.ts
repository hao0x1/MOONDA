// Run: node scripts/check-cut-terrain-seams.ts. Exercise Cesium's actual mesh and upsample CPU
// workers, including the integer 16383 cut and BITS12 positions, without starting a browser.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL && !/\.[a-z]+$/i.test(specifier)) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    // Keep the native calculations unchanged; only remove their browser message adapter.
    if (url.endsWith('/Workers/createTaskProcessorWorker.js')) return { format: 'module', shortCircuit: true, source: 'export default worker => worker;' };
    return nextLoad(url, context);
  },
});
const C = await import('cesium');
const { default: TaskProcessor } = await import('@cesium/engine/Source/Core/TaskProcessor.js');
const { default: createNativeMesh } = await import('@cesium/engine/Source/Workers/createVerticesFromQuantizedTerrainMesh.js');
const { default: upsampleNativeMesh } = await import('@cesium/engine/Source/Workers/upsampleQuantizedTerrainMesh.js');
const { LolaTerrainProvider } = await import('../src/moon/lolaTerrain.ts');
const { trueENU, toCartesian, trueToDisplayLatLon } = await import('../src/moon/frame.ts');
const oldSchedule = TaskProcessor.prototype.scheduleTask;
const workers: Record<string, number> = {};
TaskProcessor.prototype.scheduleTask = function (parameters: any) {
  const name = String((this as any)._workerPath ?? (this as any)._workerName).split('/').at(-1)!.replace(/\.js$/, '');
  const worker = name === 'createVerticesFromQuantizedTerrainMesh' ? createNativeMesh : name === 'upsampleQuantizedTerrainMesh' ? upsampleNativeMesh : null;
  if (!worker) throw new Error(`Unexpected worker ${name}`);
  workers[name] = (workers[name] ?? 0) + 1;
  return Promise.resolve(worker(parameters, []));
};

const lat = 0.674, lon = 23.473, frame = { ...trueENU(lat, lon), origin: toCartesian(lat, lon, 0) };
const heights: any = { ready: Promise.resolve(), global: {}, overview: {}, tiles: new Map(), heightAt: () => 0 };
const display = trueToDisplayLatLon(lat, lon), position = C.Cartographic.fromRadians(display.lon, display.lat);
const relief: any = { centre: { lat, lon }, radius: 600, frame, heightAt: () => 0 };
const initial = new LolaTerrainProvider(heights, relief), scheme = initial.tilingScheme;
const xy = scheme.positionToTileXY(position, 13)!, rect = scheme.tileXYToRectangle(xy.x, xy.y, 13);
const bowlWorld = C.Cartesian3.fromRadians((rect.west + rect.east) / 2, C.Math.lerp(rect.south, rect.north, 20.5 / 64), 0, scheme.ellipsoid);
const delta = C.Cartesian3.subtract(bowlWorld, frame.origin, new C.Cartesian3());
const bowlE = C.Cartesian3.dot(delta, frame.east), bowlN = C.Cartesian3.dot(delta, frame.north);
relief.heightAt = (e: number, n: number) => -0.9 * Math.exp(-((e - bowlE) ** 2 + (n - bowlN) ** 2) / (2 * 0.8 ** 2));
type Point = InstanceType<typeof C.Cartesian3>;
function edgePoints(mesh: any, indices: number[]): Point[] {
  return indices.map(index => mesh.encoding.getExaggeratedPosition(mesh.vertices, index, new C.Cartesian3()))
    .sort((a, b) => scheme.ellipsoid.cartesianToCartographic(a).latitude - scheme.ellipsoid.cartesianToCartographic(b).latitude);
}
function atLatitude(points: Point[], latitude: number): Point {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1], la = scheme.ellipsoid.cartesianToCartographic(a).latitude, lb = scheme.ellipsoid.cartesianToCartographic(b).latitude;
    if (latitude < la || latitude > lb || la === lb) continue;
    let lo = 0, hi = 1;
    for (let j = 0; j < 45; j++) {
      const t = (lo + hi) / 2, p = C.Cartesian3.lerp(a, b, t, new C.Cartesian3());
      if (scheme.ellipsoid.cartesianToCartographic(p).latitude < latitude) lo = t; else hi = t;
    }
    return C.Cartesian3.lerp(a, b, (lo + hi) / 2, new C.Cartesian3());
  }
  throw new Error('Native edge does not span the bowl latitude');
}
async function mesh(data: any, x: number, y: number, level: number) {
  const value = data.createMesh({ tilingScheme: scheme, x, y, level, throttle: false });
  assert.ok(value, 'native mesh task starts');
  return await value;
}
async function run(mask: 0 | 15, legacy: boolean) {
  const provider: any = new LolaTerrainProvider(heights, relief), available = provider.getTileDataAvailable;
  provider.getTileDataAvailable = () => mask === 15;
  if (legacy) provider.middleStep = () => 0; // Old masks 0/15 never added an interior-cut floor.
  const parent = await provider.requestTileGeometry(xy.x, xy.y, 13);
  provider.getTileDataAvailable = available;
  assert.ok(parent && parent._childTileMask === mask, 'source mask matches the fixture');
  const parentSkirts = [parent._westSkirtHeight, parent._southSkirtHeight, parent._eastSkirtHeight, parent._northSkirtHeight];
  const parentMesh = await mesh(parent, xy.x, xy.y, 13);
  // West/south child beside a genuine east/south child. Native upsampling clips at 16383,
  // then encodes the child again; ideal half-grid interpolation would miss that path.
  const cx = xy.x * 2, cy = xy.y * 2 + 1;
  const cut = await parent.upsample(scheme, xy.x, xy.y, 13, cx, cy, 14);
  assert.ok(cut?.wasCreatedByUpsampling(), 'actual native child is cut from its parent');
  const cutEdge = [...cut._eastIndices], inheritedSkirt = cut._eastSkirtHeight;
  assert.equal(inheritedSkirt, Math.min(...parentSkirts) / 2, 'native inner skirt is half the shortest parent skirt');
  const cutMesh = await mesh(cut, cx, cy, 14);
  const real = await provider.requestTileGeometry(cx + 1, cy, 14), realEdge = [...real._westIndices];
  const realMesh = await mesh(real, cx + 1, cy, 14);
  assert.equal(parentMesh.encoding.quantization, 1, 'source uses actual BITS12 positions');
  assert.equal(cutMesh.encoding.quantization, 1, 'cut child uses actual BITS12 positions');
  assert.equal(realMesh.encoding.quantization, 1, 'genuine child uses actual BITS12 positions');
  const cutPoints = edgePoints(cutMesh, cutEdge), realPoints = edgePoints(realMesh, realEdge);
  const lat0 = scheme.ellipsoid.cartesianToCartographic(cutPoints[0]).latitude;
  const lat1 = scheme.ellipsoid.cartesianToCartographic(cutPoints.at(-1)!).latitude;
  let worstGap = 0, worstUncovered = -Infinity, compared = 0, compressedEndpoints = 0;
  for (const point of realPoints) {
    const where = scheme.ellipsoid.cartesianToCartographic(point);
    // Compression can shift the two end corners past one another by a tiny amount. Compare
    // their actual common edge span; the deep bowl is well inside it, not at a corner.
    if (where.latitude < lat0 || where.latitude > lat1) { compressedEndpoints++; continue; }
    const cutPoint = atLatitude(cutPoints, where.latitude);
    const gap = scheme.ellipsoid.cartesianToCartographic(cutPoint).height - where.height;
    const skirt = gap >= 0 ? inheritedSkirt : real._westSkirtHeight;
    worstGap = Math.max(worstGap, Math.abs(gap)); worstUncovered = Math.max(worstUncovered, Math.abs(gap) - skirt);
    compared++;
  }
  assert.ok(compared >= 60, 'native edge overlap includes the bowl and most of the edge');
  assert.ok(worstGap > 0.8, 'the native fixture reaches the narrow bowl missed by the coarse source');
  return { mask, legacy, source: `13/${xy.x}/${xy.y}`, nativeCut: `14/${cx}/${cy}`, parentSkirts, inheritedSkirt,
    sourceQuantization: parentMesh.encoding.quantization, cutQuantization: cutMesh.encoding.quantization,
    cutMainVertices: cutMesh.vertexCountWithoutSkirts, cutEdgeVertices: cutEdge.length, compared, compressedEndpoints, worstGap, worstUncovered };
}

try {
  const cases = [];
  for (const mask of [15, 0] as const) for (const legacy of [true, false]) cases.push(await run(mask, legacy));
  console.log(JSON.stringify({ bowl: { e: bowlE, n: bowlN, depth: 0.9, sigma: 0.8 }, workers, cases }, null, 2));
  for (const row of cases) {
    if (row.legacy) assert.ok(row.worstUncovered > 0.8, `mask ${row.mask}: fixture must detect the old uncovered seam`);
    else assert.ok(row.worstUncovered <= 1e-5, `mask ${row.mask}: native cut seam still exposes ${row.worstUncovered} m`);
  }
  console.log('NATIVE CUT TERRAIN SEAMS PASSED');
} finally { TaskProcessor.prototype.scheduleTask = oldSchedule; }
