// Checks the 3D terrain tiles (src/moon/lolaTerrain.ts) without a browser.
// Run: node scripts/check-terrain.ts            (reads the height files from public/data/)
//  or: node scripts/check-terrain.ts http://127.0.0.1:5190/data/
//
// Each tile is built by LolaTerrainProvider and then fed through Cesium's own mesh worker
// (createVerticesFromQuantizedTerrainMesh), exactly as the globe does, so we check what Cesium
// would actually draw:
//   1. every vertex height equals heights.heightAt() at the vertex's TRUE lat/lon
//   2. every drawn 3D point, converted back to true lat/lon, sits at the LOLA height there
//   3. normals are unit length, point outward and agree with an independent slope estimate
//   4. bounding sphere / oriented box contain every vertex; the horizon point never hides a visible tile
//   5. neighbouring tiles share identical edge heights and normals
//   6. parent and child tiles agree where their vertices coincide, and skirts cover every crack
//   7. availability: 80 m levels reach the map edge plus one ring of tiles, parents always available
//   8. cracks where a real tile meets one Cesium cut up from its parent, all round the 80 m map edge
//   9. cracks between tiles 1-4 levels apart, all four edges, at many places in the 80 m map
//  10. tiles needing 80 m files not yet downloaded answer "not yet" and signal when the files arrive
//  11. main thread: Cesium's 5 ms per-frame load budget really limits the work per frame
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The app's own files import each other without the ".ts" ending (Vite style); teach node that.
const appSrc = new URL('../src/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL?.startsWith(appSrc)) {
      return nextResolve(specifier + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});

const base = process.argv[2] ?? new URL('../public/data/', import.meta.url).href;
if (base.startsWith('file:')) {
  const netFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('file:')) return netFetch(input, init);
    try { return new Response(await readFile(fileURLToPath(url))); } catch { return new Response(null, { status: 404 }); }
  }) as typeof fetch;
}

const C = await import('cesium');
const { MoonHeights, toMap } = await import('../src/science/heights.ts');
const { LolaTerrainProvider } = await import('../src/moon/lolaTerrain.ts');
const { displayToTrueLatLon, trueToDisplayLatLon, toTrueLatLon, trueENU } = await import('../src/moon/frame.ts');
const { MOON_ELLIPSOID } = await import('../src/moon/ellipsoid.ts');

// Cesium's mesh worker, run in-process: it registers self.onmessage and answers with postMessage.
const g = globalThis as any;
g.self ??= globalThis;
let posted: any;
g.postMessage = (m: any) => { posted = m; };
await import('@cesium/engine/Source/Workers/createVerticesFromQuantizedTerrainMesh.js');
const createMeshWorker = g.self.onmessage;
await import('@cesium/engine/Source/Workers/upsampleQuantizedTerrainMesh.js');
const upsampleWorker = g.self.onmessage;
async function runWorker(worker: any, parameters: any) {
  posted = undefined;
  await worker({ data: { id: 1, baseUrl: '', canTransferArrayBuffer: false, parameters } });
  if (!posted || posted.error) throw new Error('Cesium worker failed: ' + JSON.stringify(posted?.error));
  return posted.result;
}

const R = MOON_ELLIPSOID.maximumRadius, N = 65, NV = N * N, DEG = Math.PI / 180;
const heights = new MoonHeights(base);
await heights.ready;
const provider = new LolaTerrainProvider(heights);
const ts = provider.tilingScheme;

// Cesium's "a download finished" signal (the scene draws again on it). Tiles that answered "not yet"
// are asked again after it, exactly as the globe would on its next frame.
const downloadFinished = (C as any).RequestScheduler.requestCompletedEvent;
function nextDownload(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { remove(); reject(new Error('no download-finished signal within 20 s')); }, 20000);
    const remove = downloadFinished.addEventListener(() => { clearTimeout(timer); remove(); resolve(); });
  });
}
/** Ask like Cesium does: if the provider says "not yet" (undefined), wait for the download signal and ask again. */
async function request(p: any, x: number, y: number, level: number): Promise<any> {
  for (;;) {
    const r = p.requestTileGeometry(x, y, level);
    if (r) return r;
    await nextDownload();
  }
}

let failures = 0;
const check = (ok: boolean, what: string) => { if (!ok) { failures++; console.log('   FAIL:', what); } };
const fmt = (v: number, d = 2) => v.toFixed(d);
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

interface Built {
  x: number; y: number; level: number; rect: any; detail: boolean; data: any;
  h: Float64Array; normals: Float64Array; skirts: number[]; minH: number; maxH: number;
}

/** Build a tile with the provider and unpack what it handed to Cesium. */
const builtCache = new Map<string, Built>();
async function build(x: number, y: number, level: number): Promise<Built> {
  const key = `${level}/${x}/${y}`;
  const cached = builtCache.get(key);
  if (cached) return cached;
  const t = await buildNew(x, y, level);
  builtCache.set(key, t);
  return t;
}
async function buildNew(x: number, y: number, level: number): Promise<Built> {
  const data: any = await request(provider, x, y, level);
  const rect = ts.tileXYToRectangle(x, y, level);
  const detail = level >= 8 && provider.getTileDataAvailable(x, y, level);
  const qv: Uint16Array = data._quantizedVertices, minH = data._minimumHeight, maxH = data._maximumHeight;
  const h = new Float64Array(NV), normals = new Float64Array(NV * 3), n = new C.Cartesian3();
  for (let v = 0; v < NV; v++) {
    h[v] = C.Math.lerp(minH, maxH, qv[2 * NV + v] / 32767);
    C.AttributeCompression.octDecode(data._encodedNormals[2 * v], data._encodedNormals[2 * v + 1], n);
    normals[3 * v] = n.x; normals[3 * v + 1] = n.y; normals[3 * v + 2] = n.z;
  }
  return { x, y, level, rect, detail, data, h, normals, minH, maxH,
    skirts: [data._westSkirtHeight, data._southSkirtHeight, data._eastSkirtHeight, data._northSkirtHeight] };
}

/** Display lat/lon (radians) Cesium gives vertex v of a tile. */
function vertexLatLon(t: Built, v: number) {
  const qv: Uint16Array = t.data._quantizedVertices;
  return { lon: C.Math.lerp(t.rect.west, t.rect.east, qv[v] / 32767), lat: C.Math.lerp(t.rect.south, t.rect.north, qv[NV + v] / 32767) };
}

/** Run Cesium's real worker on the tile, with the same parameters QuantizedMeshTerrainData.createMesh sends. */
async function cesiumMesh(t: Built) {
  const d = t.data;
  return runWorker(createMeshWorker, {
    minimumHeight: d._minimumHeight, maximumHeight: d._maximumHeight, quantizedVertices: d._quantizedVertices,
    octEncodedNormals: d._encodedNormals, includeWebMercatorT: true, indices: d._indices,
    westIndices: d._westIndices, southIndices: d._southIndices, eastIndices: d._eastIndices, northIndices: d._northIndices,
    westSkirtHeight: d._westSkirtHeight, southSkirtHeight: d._southSkirtHeight, eastSkirtHeight: d._eastSkirtHeight, northSkirtHeight: d._northSkirtHeight,
    rectangle: t.rect, relativeToCenter: d._boundingSphere.center, ellipsoid: MOON_ELLIPSOID, exaggeration: 1, exaggerationRelativeHeight: 0,
  });
}

/** Where a tile has no finer data, Cesium cuts the parent's mesh in four. Check that works with our meshes. */
async function checkUpsample(t: Built, label: string) {
  const mesh = await cesiumMesh(t);
  let worst = 0, count = 0;
  for (const [east, north] of [[false, false], [true, false], [false, true], [true, true]]) {
    const cx = 2 * t.x + (east ? 1 : 0), cy = 2 * t.y + (north ? 0 : 1);
    const r = await runWorker(upsampleWorker, {
      vertices: new Float32Array(mesh.vertices), vertexCountWithoutSkirts: NV, indices: new Uint16Array(mesh.indices),
      indexCountWithoutSkirts: mesh.indexCountWithoutSkirts, encoding: mesh.encoding, minimumHeight: t.minH, maximumHeight: t.maxH,
      isEastChild: east, isNorthChild: north, childRectangle: ts.tileXYToRectangle(cx, cy, t.level + 1), ellipsoid: MOON_ELLIPSOID,
    });
    const q = new Uint16Array(r.vertices), n = q.length / 3;
    count += n;
    check(n > 100 && !!r.encodedNormals && new Uint8Array(r.encodedNormals).length === 2 * n, `${label}: upsampled child lost vertices or normals`);
    check(!!r.horizonOcclusionPoint && r.boundingSphere.radius > 0, `${label}: upsampled child has no bounding volumes`);
    // every child vertex must lie on the parent's surface: compare with the parent's own vertex grid
    const crect = ts.tileXYToRectangle(cx, cy, t.level + 1);
    for (let v = 0; v < n; v += 7) {
      const lon = C.Math.lerp(crect.west, crect.east, q[v] / 32767), lat = C.Math.lerp(crect.south, crect.north, q[n + v] / 32767);
      const h = C.Math.lerp(r.minimumHeight, r.maximumHeight, q[2 * n + v] / 32767);
      const fi = ((lon - t.rect.west) / (t.rect.east - t.rect.west)) * (N - 1), fj = ((lat - t.rect.south) / (t.rect.north - t.rect.south)) * (N - 1);
      const i = Math.min(N - 2, Math.floor(fi)), j = Math.min(N - 2, Math.floor(fj)), a = fi - i, b = fj - j;
      const sw = t.h[j * N + i], se = t.h[j * N + i + 1], nw = t.h[(j + 1) * N + i], ne = t.h[(j + 1) * N + i + 1];
      const onParent = a >= b ? sw + (se - sw) * a + (ne - se) * b : sw + (nw - sw) * b + (ne - nw) * a; // the triangle it falls in
      worst = Math.max(worst, Math.abs(h - onParent));
    }
  }
  console.log(`  upsampled children of ${label.padEnd(22)} ${count} vertices with normals; largest step off the parent surface ${fmt(worst, 2)} m`);
  check(worst < 0.01 * (t.maxH - t.minH) + 1, `${label}: upsampled children leave the parent surface`);
}

/** Independent normal: slope of heightAt() in the TRUE local east/north frame, step = vertex spacing. */
function referenceNormal(trueLat: number, trueLon: number, stepM: number, detail: boolean) {
  const { east, north, up } = trueENU(trueLat, trueLon);
  const h0 = heights.heightAt(trueLat, trueLon, detail), a = stepM / R;
  const hAt = (dir: any, sgn: number) => {
    const p = new C.Cartesian3(
      R * (up.x * Math.cos(a) + sgn * dir.x * Math.sin(a)), R * (up.y * Math.cos(a) + sgn * dir.y * Math.sin(a)), R * (up.z * Math.cos(a) + sgn * dir.z * Math.sin(a)));
    const t = toTrueLatLon(p);
    return heights.heightAt(t.lat, t.lon, detail);
  };
  const run = (2 * stepM * (R + h0)) / R;
  const gE = (hAt(east, 1) - hAt(east, -1)) / run, gN = (hAt(north, 1) - hAt(north, -1)) / run;
  const n = new C.Cartesian3(up.x - gE * east.x - gN * north.x, up.y - gE * east.y - gN * north.y, up.z - gE * east.z - gN * north.z);
  return C.Cartesian3.normalize(n, n);
}

const angleDeg = (ax: number, ay: number, az: number, b: any) => Math.acos(Math.max(-1, Math.min(1, ax * b.x + ay * b.y + az * b.z))) / DEG;

/** Checks 1-4 on one tile. */
async function checkTile(t: Built, label: string) {
  const { rect, detail } = t, range = t.maxH - t.minH;
  // 1. stored heights vs heightAt at the true lat/lon of each vertex
  let hErr = 0;
  for (let v = 0; v < NV; v++) {
    const d = vertexLatLon(t, v), tr = displayToTrueLatLon(d.lat, d.lon);
    hErr = Math.max(hErr, Math.abs(t.h[v] - heights.heightAt(tr.lat, tr.lon, detail)));
  }
  const hTol = range / 65534 + 1e-6;

  // 2. what Cesium's worker actually builds
  const mesh = await cesiumMesh(t);
  const enc = C.TerrainEncoding.clone(mesh.encoding), buf = new Float32Array(mesh.vertices);
  const P = new C.Cartesian3(), E = new C.Cartesian3(), c2 = new C.Cartesian2();
  const drawnErr: number[] = []; let posErr = 0, workerNormalDiff = 0;
  for (let v = 0; v < NV; v++) {
    enc.decodePosition(buf, v, P);
    const d = vertexLatLon(t, v);
    MOON_ELLIPSOID.cartographicToCartesian(new C.Cartographic(d.lon, d.lat, t.h[v]), E);
    posErr = Math.max(posErr, C.Cartesian3.distance(P, E));
    const tr = toTrueLatLon(P);
    drawnErr.push(Math.abs(tr.height - heights.heightAt(tr.lat, tr.lon, detail)));
    enc.getOctEncodedNormal(buf, v, c2); // unpacked from a float, so round back to the stored bytes
    if (Math.round(c2.x) !== t.data._encodedNormals[2 * v] || Math.round(c2.y) !== t.data._encodedNormals[2 * v + 1]) workerNormalDiff++;
  }
  // position precision of Cesium's vertex encoding (12-bit mode for small tiles, float32 otherwise)
  const dims = C.Cartesian3.magnitude(C.Matrix4.getScale(enc.fromScaledENU, new C.Cartesian3()));
  const posTol = enc.quantization === 1 ? dims / 4095 + 0.05 : 0.5;
  // skirt vertices hang exactly skirt metres below their edge vertex
  let skirtErr = 0;
  const edges = [t.data._westIndices, t.data._southIndices, t.data._eastIndices, t.data._northIndices];
  const order = [mesh.westIndicesSouthToNorth, mesh.southIndicesEastToWest, mesh.eastIndicesNorthToSouth, mesh.northIndicesWestToEast];
  let sv = NV;
  for (let e = 0; e < 4; e++) for (let i = 0; i < edges[e].length; i++) {
    skirtErr = Math.max(skirtErr, Math.abs(enc.decodeHeight(buf, order[e][i]) - t.skirts[e] - enc.decodeHeight(buf, sv++)));
  }

  // 3. normals
  let notUnit = 0, inward = 0, maxSlope = 0;
  const refAngles: number[] = [];
  const stepM = (R * (rect.north - rect.south)) / (N - 1);
  for (let v = 0; v < NV; v++) {
    const nx = t.normals[3 * v], ny = t.normals[3 * v + 1], nz = t.normals[3 * v + 2];
    if (Math.abs(Math.hypot(nx, ny, nz) - 1) > 1e-6) notUnit++;
    enc.decodePosition(buf, v, P);
    const r = C.Cartesian3.magnitude(P), cosUp = (nx * P.x + ny * P.y + nz * P.z) / r;
    if (!(cosUp > 0)) inward++;
    maxSlope = Math.max(maxSlope, Math.acos(Math.min(1, cosUp)) / DEG);
    const i = v % N, j = (v / N) | 0;
    if (i % 4 === 0 && j % 4 === 0 && Math.abs(vertexLatLon(t, v).lat) < 89.9 * DEG) {
      const tr = toTrueLatLon(P);
      refAngles.push(angleDeg(nx, ny, nz, referenceNormal(tr.lat, tr.lon, stepM, detail)));
    }
  }

  // 4. bounding volumes and horizon point
  const bs = t.data._boundingSphere, obb = t.data._orientedBoundingBox, hop = t.data._horizonOcclusionPoint;
  let outSphere = 0, outBox = 0;
  for (let v = 0; v < NV; v++) {
    const d = vertexLatLon(t, v);
    MOON_ELLIPSOID.cartographicToCartesian(new C.Cartographic(d.lon, d.lat, t.h[v]), E);
    outSphere = Math.max(outSphere, C.Cartesian3.distance(E, bs.center) - bs.radius);
    outBox = Math.max(outBox, Math.sqrt(obb.distanceSquaredTo(E)));
  }
  const m = Math.min(t.minH, 0), shrunk = new C.Ellipsoid(R + m, R + m, R + m);
  const centreDir = C.Cartesian3.normalize(bs.center, new C.Cartesian3());
  let culled = 0, wrongCull = 0, seed = 12345;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let s = 0; s < 400; s++) {
    // cameras all round the Moon, from just above the ground to 4 radii out
    const dir = new C.Cartesian3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
    if (s % 2 === 0) C.Cartesian3.add(dir, C.Cartesian3.multiplyByScalar(centreDir, -1.2, new C.Cartesian3()), dir); // many behind the tile
    C.Cartesian3.normalize(dir, dir);
    const cam = C.Cartesian3.multiplyByScalar(dir, R * (1.002 + 3 * rnd() ** 2), new C.Cartesian3());
    if (new C.EllipsoidalOccluder(MOON_ELLIPSOID, cam).isScaledSpacePointVisiblePossiblyUnderEllipsoid(hop, t.minH)) continue;
    culled++;
    const occ = new C.EllipsoidalOccluder(shrunk, cam);
    for (let v = 0; v < NV; v++) {
      const d = vertexLatLon(t, v);
      MOON_ELLIPSOID.cartographicToCartesian(new C.Cartographic(d.lon, d.lat, t.h[v]), E);
      if (occ.isPointVisible(E)) { wrongCull++; break; }
    }
  }

  console.log(`${label.padEnd(34)} L${String(t.level).padStart(2)} ${t.detail ? '80m ' : 'glob'} h ${fmt(t.minH, 0).padStart(6)}..${fmt(t.maxH, 0).padStart(6)}  `
    + `vtxErr ${fmt(hErr, 3)}  drawn med/max ${fmt(pct(drawnErr, 0.5))}/${fmt(pct(drawnErr, 1))} m  `
    + `nrm vs ref med/p95 ${fmt(pct(refAngles, 0.5))}/${fmt(pct(refAngles, 0.95))}°  slope<=${fmt(maxSlope, 0)}°  `
    + `skirts ${t.skirts.map(s => fmt(s, 0)).join('/')} m  culled ${culled}/400  mask ${t.data._childTileMask}`);
  check(hErr <= hTol, `${label}: vertex heights differ from heightAt by ${hErr} (> ${hTol})`);
  check(posErr <= posTol, `${label}: Cesium places vertices ${fmt(posErr, 3)} m from intended (> ${fmt(posTol, 3)})`);
  check(pct(drawnErr, 0.5) <= posTol, `${label}: drawn points median ${pct(drawnErr, 0.5)} m off the LOLA surface`);
  check(workerNormalDiff === 0, `${label}: ${workerNormalDiff} normals come out of Cesium's worker changed`);
  check(skirtErr <= posTol + 0.01, `${label}: skirt depth wrong by ${skirtErr}`);
  check(notUnit === 0, `${label}: ${notUnit} normals not unit length`);
  check(inward === 0, `${label}: ${inward} normals point inward`);
  check(pct(refAngles, 0.5) < 2 && pct(refAngles, 0.95) < 8, `${label}: normals disagree with reference slope`);
  check(outSphere <= 1e-6 * R, `${label}: vertex ${outSphere} m outside bounding sphere`);
  check(outBox <= 1e-3, `${label}: vertex ${outBox} m outside oriented box`);
  check(wrongCull === 0, `${label}: horizon point hid a visible tile ${wrongCull} times`);
  check(t.skirts.every(s => s > 0 && Number.isFinite(s)), `${label}: bad skirt`);
  return { refAngles, maxSlope };
}

/** Check 5: tiles side by side share identical edges. `b` is east of `a` (dx) or south of `a` (dy). */
function checkNeighbours(a: Built, b: Built, eastward: boolean, label: string) {
  let hDiff = 0, nDiff = 0, sameBytes = 0;
  for (let t = 0; t < N; t++) {
    const va = eastward ? t * N + N - 1 : t, vb = eastward ? t * N : (N - 1) * N + t; // a.east|b.west, a.south|b.north
    hDiff = Math.max(hDiff, Math.abs(a.h[va] - b.h[vb]));
    const ang = angleDeg(a.normals[3 * va], a.normals[3 * va + 1], a.normals[3 * va + 2], { x: b.normals[3 * vb], y: b.normals[3 * vb + 1], z: b.normals[3 * vb + 2] });
    nDiff = Math.max(nDiff, ang);
    if (a.data._encodedNormals[2 * va] === b.data._encodedNormals[2 * vb] && a.data._encodedNormals[2 * va + 1] === b.data._encodedNormals[2 * vb + 1]) sameBytes++;
  }
  const tol = (a.maxH - a.minH) / 65534 + (b.maxH - b.minH) / 65534 + 1e-6;
  console.log(`  neighbours ${label.padEnd(30)} edge height diff ${fmt(hDiff, 3)} m (rounding ${fmt(tol, 3)})  normals identical ${sameBytes}/${N}, max diff ${fmt(nDiff, 2)}°`);
  check(hDiff <= tol, `${label}: neighbour edge heights differ by ${hDiff}`);
  check(nDiff < 1.5 && sameBytes >= N - 3, `${label}: neighbour edge normals differ (${nDiff}°)`);
}

/** Check 6: parent vs its four children. */
async function checkFamily(p: Built, label: string) {
  const kids = [[0, 1], [1, 1], [0, 0], [1, 0]].map(([dx, dy]) => ({ dx, dy }));
  const shared: number[] = [];
  let worstRatio = 0, worstGap = 0, normAng: number[] = [];
  const pSpacing = (R * (p.rect.north - p.rect.south)) / (N - 1);
  for (const { dx, dy } of kids) {
    const c = await build(2 * p.x + dx, 2 * p.y + dy, p.level + 1);
    const ox = dx * 32, oy = (1 - dy) * 32; // child's offset inside the parent, in parent vertex steps (rows from south)
    for (let j = 0; j < N; j += 2) for (let i = 0; i < N; i += 2) {
      const vc = j * N + i, vp = (oy + j / 2) * N + ox + i / 2;
      shared.push(Math.abs(c.h[vc] - p.h[vp]));
      normAng.push(angleDeg(c.normals[3 * vc], c.normals[3 * vc + 1], c.normals[3 * vc + 2], { x: p.normals[3 * vp], y: p.normals[3 * vp + 1], z: p.normals[3 * vp + 2] }));
    }
    // outer edges of the child lie on the parent's edges: the gap to the parent's straight edge
    // (which sags chord²/8R below the curve between parent vertices) must fit under a skirt
    const outer: [number, (t: number) => number, (t: number) => number][] = [];
    if (dx === 0) outer.push([0, t => t * N, t => (oy + t / 2) * N]); // west
    if (dx === 1) outer.push([2, t => t * N + N - 1, t => (oy + t / 2) * N + N - 1]); // east
    if (dy === 0) outer.push([3, t => (N - 1) * N + t, t => (N - 1) * N + ox + t / 2]); // north child: north edge
    if (dy === 1) outer.push([1, t => t, t => ox + t / 2]); // south child: south edge
    for (const [edge, cv, pv] of outer) {
      const spacing = edge === 0 || edge === 2 ? pSpacing : R * Math.cos(edge === 1 ? p.rect.south : p.rect.north) * (p.rect.east - p.rect.west) / (N - 1);
      const sag = spacing ** 2 / (8 * R);
      for (let t = 0; t < N; t++) {
        const chord = t % 2 === 0 ? p.h[pv(t)] : (p.h[pv(t - 1)] + p.h[pv(t + 1)]) / 2 - sag;
        const gap = c.h[cv(t)] - chord; // > 0: child above parent (child's skirt covers); < 0: parent's skirt covers
        const skirt = gap > 0 ? c.skirts[edge] : p.skirts[edge];
        worstGap = Math.max(worstGap, Math.abs(gap));
        worstRatio = Math.max(worstRatio, Math.abs(gap) / skirt);
      }
    }
  }
  console.log(`  parent/children ${label.padEnd(25)} coincident vertices: median ${fmt(pct(shared, 0.5))} m, p99 ${fmt(pct(shared, 0.99))} m, max ${fmt(pct(shared, 1))} m;`
    + ` normals median ${fmt(pct(normAng, 0.5), 1)}°; worst edge crack ${fmt(worstGap, 1)} m = ${fmt(100 * worstRatio, 0)}% of its skirt`);
  check(worstRatio <= 1, `${label}: a crack between parent and child is longer than the skirt`);
  return shared;
}

/** Vertex index of the t-th vertex along edge e (0 W, 1 S, 2 E, 3 N; W/E run south->north, S/N west->east). */
const edgeVertex = (e: number, t: number) => (e === 0 ? t * N : e === 2 ? t * N + N - 1 : e === 1 ? t : (N - 1) * N + t);

/** Height of a tile's drawn surface (its two triangles per grid square) at a display lat/lon inside it. */
function surfaceOf(t: Built, lat: number, lon: number) {
  const fi = ((lon - t.rect.west) / (t.rect.east - t.rect.west)) * (N - 1), fj = ((lat - t.rect.south) / (t.rect.north - t.rect.south)) * (N - 1);
  const i = Math.max(0, Math.min(N - 2, Math.floor(fi))), j = Math.max(0, Math.min(N - 2, Math.floor(fj))), a = fi - i, b = fj - j;
  const sw = t.h[j * N + i], se = t.h[j * N + i + 1], nw = t.h[(j + 1) * N + i], ne = t.h[(j + 1) * N + i + 1];
  return a >= b ? sw + (se - sw) * a + (ne - se) * b : sw + (nw - sw) * b + (ne - nw) * a;
}

/**
 * Check 9: a real tile next to a real tile drawn d levels coarser, along all four edges of the coarse
 * tile. The coarse tile draws straight 3D lines between its vertices (they sag chord²/8R below the
 * curved surface); the gap at each finer vertex must fit under the skirt of the higher side.
 */
const lodStats = new Map<string, { pieces: number; bad: number; worst: number; worstM: number; finerHigher: boolean }>();
async function checkLodGap(a: Built, d: number) {
  const n = 1 << d, key = `L${a.level} next to L${a.level + d}`;
  const st = lodStats.get(key) ?? { pieces: 0, bad: 0, worst: 0, worstM: 0, finerHigher: false };
  lodStats.set(key, st);
  for (let e = 0; e < 4; e++) {
    const vertical = e === 0 || e === 2;
    const spacing = vertical ? (R * (a.rect.north - a.rect.south)) / (N - 1)
      : (R * Math.cos(e === 1 ? a.rect.south : a.rect.north) * (a.rect.east - a.rect.west)) / (N - 1);
    for (let j = 0; j < n; j++) {
      // the j-th descendant along edge e, counted from the edge's south/west end (tile y grows southward)
      const cx = e === 0 ? a.x * n : e === 2 ? a.x * n + n - 1 : a.x * n + j;
      const cy = e === 1 ? a.y * n + n - 1 : e === 3 ? a.y * n : a.y * n + (n - 1 - j);
      if (!provider.getTileDataAvailable(cx, cy, a.level + d)) continue;
      const t = await build(cx, cy, a.level + d);
      st.pieces++;
      let worst = 0, worstM = 0, finerHigher = false;
      for (let k = 0; k < N; k++) {
        const q = (j * (N - 1)) / n + k / n, q0 = Math.min(N - 2, Math.floor(q)), tau = q - q0;
        const chord = a.h[edgeVertex(e, q0)] + (a.h[edgeVertex(e, q0 + 1)] - a.h[edgeVertex(e, q0)]) * tau - (tau * (1 - tau) * spacing ** 2) / (2 * R);
        const gap = t.h[edgeVertex(e, k)] - chord, skirt = gap > 0 ? t.skirts[e] : a.skirts[e];
        if (Math.abs(gap) / skirt > worst) { worst = Math.abs(gap) / skirt; worstM = Math.abs(gap) - skirt; finerHigher = gap > 0; }
      }
      if (worst > 1) st.bad++;
      if (worst > st.worst) { st.worst = worst; st.finerHigher = finerHigher; }
      st.worstM = Math.max(st.worstM, worstM);
    }
  }
}

function tileAt(trueLat: number, trueLon: number, level: number) {
  const d = trueToDisplayLatLon(trueLat, trueLon);
  const xy = ts.positionToTileXY(C.Cartographic.fromRadians(d.lon, d.lat), level)!;
  return { x: xy.x, y: xy.y };
}

console.log('Data:', base);
console.log('--- tiles (vtxErr = stored height vs heightAt at the true lat/lon; drawn = Cesium-built point vs LOLA surface) ---');
const places: [string, number, number, number[]][] = [
  ['Shackleton (true -89.67, 129.78)', -89.67, 129.78, [5, 7, 8, 9, 10, 11]],
  ['Mons Malapert (-85.98, -1.67)', -85.98, -1.67, [7, 8, 11]],
  ['Edge of 80 m map (-80.2, 40)', -80.2, 40, [6, 7, 8]],
  ['Tycho (true -43.3, -11.2)', -43.3, -11.2, [3, 5, 6, 7]],
  ['Limb point = display pole (0, 90E)', 0.01, 90, [2, 4]],
];
for (const [name, lat, lon, levels] of places) {
  for (const level of levels) {
    const { x, y } = tileAt(lat, lon, level);
    await checkTile(await build(x, y, level), name);
  }
}
for (const x of [0, 1]) await checkTile(await build(x, 0, 0), `Level-0 half Moon #${x}`);

console.log('--- availability ---');
const avail = (name: string, lat: number, lon: number, level: number, want: boolean) => {
  const { x, y } = tileAt(lat, lon, level), got = provider.getTileDataAvailable(x, y, level);
  console.log(`  ${name} level ${level}: ${got ? 'available' : 'not available (Cesium reuses the parent)'}`);
  check(got === want, `${name} level ${level} availability`);
};
avail('Shackleton', -89.67, 129.78, 11, true);
avail('Shackleton', -89.67, 129.78, 12, false);
avail('Tycho', -43.3, -11.2, 7, true);
avail('Tycho', -43.3, -11.2, 8, false);
avail('true -79.9 (just outside the 80 m map, ring)', -79.9, 10, 8, true);
avail('true -78 (far outside the 80 m map)', -78, 10, 8, false);
avail('true -79.5 (more than two L11 tiles out)', -79.5, 10, 11, false);
{
  // Rules behind the crack-free edge, checked on every tile near the map edge at levels 8-11:
  //  a) a tile with any sample south of -80° is available, and so are its 8 neighbours
  //  b) an available tile's parent is available
  //  c) no tile more than two tile sizes from the map is available
  let touching = 0, ringOk = 0, parentBad = 0, farBad = 0, seen = 0;
  const minTrueLatOfTile = (x: number, y: number, l: number) => {
    const r = ts.tileXYToRectangle(x, y, l);
    let m = 90;
    for (let a = 0; a <= 8; a++) for (let b = 0; b <= 8; b++) m = Math.min(m, displayToTrueLatLon(C.Math.lerp(r.south, r.north, a / 8), C.Math.lerp(r.west, r.east, b / 8)).lat);
    return m;
  };
  for (let l = 8; l <= 11; l++) {
    const tileDeg = 180 / 2 ** l, keys = new Set<string>();
    for (let lat = -80 - 2 * tileDeg; lat <= -80 + 4 * tileDeg; lat += tileDeg / 3) {
      const lonStep = (tileDeg / 3) / Math.cos(lat * DEG);
      for (let lon = -180; lon < 180; lon += lonStep) { const t = tileAt(lat, lon, l); keys.add(`${t.x},${t.y}`); }
    }
    for (const k of keys) {
      const [x, y] = k.split(',').map(Number), a = provider.getTileDataAvailable(x, y, l), m = minTrueLatOfTile(x, y, l);
      seen++;
      if (m < -80) {
        touching++;
        let all = a;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) all &&= provider.getTileDataAvailable(x + dx, y + dy, l);
        if (all) ringOk++;
      }
      if (a && !provider.getTileDataAvailable(x >> 1, y >> 1, l - 1)) parentBad++;
      if (a && m > -80 + 2.2 * tileDeg) farBad++;
    }
  }
  console.log(`  ${seen} tiles near the map edge (L8-11): ${ringOk}/${touching} tiles reaching the 80 m map are available with all 8 neighbours;`
    + ` ${parentBad} available tiles with an unavailable parent; ${farBad} available tiles more than two tiles out`);
  check(ringOk === touching && touching > 0, 'tiles reaching the 80 m map (and their neighbours) must be available');
  check(parentBad === 0, 'an available tile has an unavailable parent');
  check(farBad === 0, 'tiles far from the 80 m map are available');
}

console.log('--- neighbours and parent/children ---');
for (const [name, lat, lon, level] of [['Shackleton', -89.67, 129.78, 10], ['Malapert', -85.98, -1.67, 8], ['Tycho', -43.3, -11.2, 6], ['Shackleton', -89.67, 129.78, 6]] as const) {
  const { x, y } = tileAt(lat, lon, level);
  const a = await build(x, y, level);
  checkNeighbours(a, await build(x + 1, y, level), true, `${name} L${level} east`);
  checkNeighbours(a, await build(x, y + 1, level), false, `${name} L${level} south`);
}
const fam: [string, number, number, number][] = [
  ['Shackleton L7->8 (240m->80m)', -89.67, 129.78, 7], ['Shackleton L9->10', -89.67, 129.78, 9], ['Shackleton L10->11', -89.67, 129.78, 10],
  ['Malapert L7->8 (240m->80m)', -85.98, -1.67, 7], ['Tycho L5->6', -43.3, -11.2, 5], ['Tycho L6->7', -43.3, -11.2, 6],
];
for (const [name, lat, lon, level] of fam) {
  const { x, y } = tileAt(lat, lon, level);
  await checkFamily(await build(x, y, level), name);
}

for (const [name, lat, lon, level] of [['Tycho L7', -43.3, -11.2, 7], ['Shackleton L11', -89.67, 129.78, 11], ['Edge of 80 m map L7', -80.2, 40, 7]] as const) {
  const { x, y } = tileAt(lat, lon, level);
  await checkUpsample(await build(x, y, level), name);
}

console.log('--- cracks where a real tile meets a tile Cesium cut up from its parent (all round the 80 m map edge) ---');
{
  // Cesium's rule when it cuts a parent mesh in four (QuantizedMeshTerrainData.upsample): outer edges
  // keep the parent's skirt, inner edges get half the parent's shortest skirt.
  const cutSkirts = (p: number[], x: number, y: number, px: number, py: number) => {
    const sh = Math.min(...p), east = x !== 2 * px, north = y === 2 * py;
    return [east ? sh / 2 : p[0], north ? sh / 2 : p[1], east ? p[2] : sh / 2, north ? p[3] : sh / 2];
  };
  for (let L = 8; L <= 11; L++) {
    const tileDeg = 180 / 2 ** L, real = new Set<string>();
    for (let lat = -80 - 2 * tileDeg; lat <= -80 + 4 * tileDeg; lat += tileDeg / 3) {
      const lonStep = (tileDeg / 3) / Math.cos(lat * DEG);
      for (let lon = -180; lon < 180; lon += lonStep) {
        const t = tileAt(lat, lon, L);
        if (provider.getTileDataAvailable(t.x, t.y, L)) real.add(`${t.x},${t.y}`);
      }
    }
    let pairs = 0, bad = 0, worstRatio = 0, worstUncovered = 0, notDirectChild = 0;
    for (const k of real) {
      const [x, y] = k.split(',').map(Number);
      for (const [dx, dy, eT, eU] of [[1, 0, 2, 0], [-1, 0, 0, 2], [0, 1, 1, 3], [0, -1, 3, 1]]) {
        const ux = x + dx, uy = y + dy;
        if (provider.getTileDataAvailable(ux, uy, L)) continue;
        // the cut-up tile shows the surface of its nearest available ancestor, with skirts handed down
        const chain: [number, number][] = [];
        let ax = ux, ay = uy, al = L;
        while (!provider.getTileDataAvailable(ax, ay, al)) { chain.push([ax, ay]); ax >>= 1; ay >>= 1; al--; }
        if (L - al !== 1) notDirectChild++;
        const A = await build(ax, ay, al);
        let sk = A.skirts, px = ax, py = ay;
        for (let g = chain.length - 1; g >= 0; g--) { sk = cutSkirts(sk, chain[g][0], chain[g][1], px, py); [px, py] = chain[g]; }
        const T = await build(x, y, L);
        pairs++;
        let worst = 0;
        for (let s2 = 0; s2 <= 1024; s2++) {
          const f = s2 / 1024, q = f * (N - 1), t0 = Math.min(N - 2, Math.floor(q)), tau = q - t0;
          const hT = T.h[edgeVertex(eT, t0)] + (T.h[edgeVertex(eT, t0 + 1)] - T.h[edgeVertex(eT, t0)]) * tau;
          const vert = eT === 0 || eT === 2;
          const lat = vert ? C.Math.lerp(T.rect.south, T.rect.north, f) : eT === 1 ? T.rect.south : T.rect.north;
          const lon = vert ? (eT === 0 ? T.rect.west : T.rect.east) : C.Math.lerp(T.rect.west, T.rect.east, f);
          const gap = hT - surfaceOf(A, lat, lon), skirt = gap > 0 ? T.skirts[eT] : sk[eU];
          worst = Math.max(worst, Math.abs(gap) / skirt);
          worstUncovered = Math.max(worstUncovered, Math.abs(gap) - skirt);
        }
        if (worst > 1) bad++;
        worstRatio = Math.max(worstRatio, worst);
      }
    }
    console.log(`  L${L}: ${real.size} real tiles near the edge, ${pairs} edges next to a cut-up tile: ${bad} uncovered, worst crack ${fmt(100 * worstRatio, 0)}% of its skirt`
      + `${worstUncovered > 0 ? `, worst uncovered ${fmt(worstUncovered, 1)} m` : ''}; cut-up tiles not a direct child of a real tile: ${notDirectChild}`);
    check(pairs > 0 && bad === 0, `L${L}: crack between a real tile and a cut-up tile longer than the skirt`);
    check(notDirectChild === 0, `L${L}: a cut-up tile next to a real tile is more than one level below real data`);
  }
}

console.log('--- skirts vs cracks between tiles 1-4 levels apart (all four edges, many places) ---');
{
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const sweep: [number, number][] = [[-89.67, 129.78], [-85.98, -1.67], [-80.13, 1.44]]; // Shackleton, Malapert, IM-1
  for (let i = 0; i < 40; i++) sweep.push([-80.2 - 9.7 * Math.sqrt(rnd()), 360 * rnd() - 180]);
  // Right on true -80°, where heightAt jumps from the 80 m map to the global map (tens of metres),
  // every 15° of longitude and at the longitude where that jump is largest.
  let worstLon = 0, worstJump = 0;
  for (let lon = -180; lon < 180; lon += 0.1) {
    const [mx, my] = toMap(-80, lon);
    await heights.loadTiles(mx - 300, my - 300, mx + 300, my + 300, 16);
    const jump = Math.abs(heights.heightAt(-80.0005, lon, true) - heights.heightAt(-79.9995, lon, true));
    if (jump > worstJump) { worstJump = jump; worstLon = lon; }
  }
  console.log(`  (largest jump between the 80 m and global maps at true -80°: ${fmt(worstJump, 0)} m at lon ${fmt(worstLon, 1)}°)`);
  for (let lon = -180; lon < 180; lon += 15) sweep.push([-80.0, lon]);
  sweep.push([-80.0, worstLon], [-80.02, worstLon], [-79.98, worstLon]);
  for (const [lat, lon] of sweep) for (const L0 of [7, 8, 9]) {
    const { x, y } = tileAt(lat, lon, L0);
    const a = await build(x, y, L0);
    for (let d = 1; d <= Math.min(4, 11 - L0); d++) await checkLodGap(a, d);
  }
  for (const [key, st] of lodStats) {
    console.log(`  ${key.padEnd(15)} ${String(st.pieces).padStart(5)} edge pieces: ${st.bad} uncovered, worst crack ${fmt(100 * st.worst, 1)}% of the skirt covering it`
      + ` (${st.finerHigher ? 'finer tile higher: measured skirt' : 'coarser tile higher: estimated skirt'})${st.worstM > 0 ? `, worst uncovered ${fmt(st.worstM, 1)} m` : ''}`);
    check(st.bad === 0, `${key}: crack longer than the skirt`);
  }
  // global map away from the pole (Tycho), where only levels 0-7 exist
  const { x, y } = tileAt(-43.3, -11.2, 3);
  const a = await build(x, y, 3);
  for (let d = 1; d <= 4; d++) await checkLodGap(a, d);
  for (const l of [4, 5, 6, 7]) {
    const st = lodStats.get(`L3 next to L${l}`)!;
    console.log(`  Tycho L3 next to L${l}: ${st.pieces} edge pieces, ${st.bad} uncovered, worst crack ${fmt(100 * st.worst, 1)}% of the skirt`
      + ` (${st.finerHigher ? 'finer tile higher: measured skirt' : 'coarser tile higher: estimated skirt'})`);
    check(st.bad === 0 && st.pieces > 0, `Tycho L3 next to L${l}: crack longer than the skirt`);
  }
}

console.log('--- tiles waiting for 80 m files ---');
{
  // a fresh MoonHeights has no 80 m files in memory yet
  const fresh = new MoonHeights(base);
  const cold = new LolaTerrainProvider(fresh);
  const before = cold.requestTileGeometry(0, 0, 0);
  await nextDownload(); // the provider signals once the height files are in
  const after = cold.requestTileGeometry(0, 0, 0);
  console.log(`  before the height files arrive: ${before === undefined ? '"not yet"' : 'built?!'}; after the signal: ${after ? 'built' : '"not yet"?!'}`);
  check(before === undefined && !!after, 'provider must answer "not yet" until the height files are loaded, then build');

  const { x, y } = tileAt(-89.67, 129.78, 11);
  let loads = 0;
  const loadTiles = fresh.loadTiles.bind(fresh);
  fresh.loadTiles = (...args: Parameters<typeof loadTiles>) => { loads++; return loadTiles(...args); };
  const first = cold.requestTileGeometry(x, y, 11), second = cold.requestTileGeometry(x, y, 11);
  const t0 = performance.now();
  await nextDownload();
  const waited = performance.now() - t0;
  const third = cold.requestTileGeometry(x, y, 11);
  const warm = await build(x, y, 11), got: any = await third;
  let same = !!got;
  if (got) for (let v = 0; v < NV; v++) same &&= got._quantizedVertices[2 * NV + v] === warm.data._quantizedVertices[2 * NV + v];
  const tycho = tileAt(-43.3, -11.2, 6), globalTile = cold.requestTileGeometry(tycho.x, tycho.y, 6);
  console.log(`  Shackleton L11 tile with no 80 m files: ${first === undefined && second === undefined ? '"not yet" twice' : 'built?!'} (${loads} download started),`
    + ` download signal after ${fmt(waited, 0)} ms, then ${got ? 'built' : '"not yet"?!'}, ${same ? 'identical to' : 'DIFFERENT from'} the tile built with the files already loaded;`
    + ` tiles still waiting: ${(cold as any).waiting.size}`);
  console.log(`  a global-map tile on the same fresh provider: ${globalTile ? 'built at once (needs no 80 m files)' : '"not yet"?!'}`);
  check(first === undefined && second === undefined && loads === 1, 'tile needing missing 80 m files must answer "not yet" and start the download');
  check(!!got && same, 'tile must build after the download signal, identical to a warm build');
  check((cold as any).waiting.size === 0, 'provider keeps a finished tile in its waiting list');
  check(!!globalTile, 'global tile must not wait for 80 m files');
}

console.log('--- main thread: Cesium\'s load loop (5 ms budget per frame, data already loaded) ---');
{
  // QuadtreePrimitive.processSinglePriorityLoadQueue: each frame Cesium keeps asking for queued tiles
  // until 5 ms have passed (always at least one). Promise callbacks then run before the next frame.
  const queue: [number, number, number][] = [];
  const d = trueToDisplayLatLon(-89.67, 129.78);
  for (const L of [9, 10, 11]) {
    const xy = ts.positionToTileXY(C.Cartographic.fromRadians(d.lon, d.lat), L)!;
    for (let i = -5; i <= 4; i++) for (let j = -5; j <= 4; j++) queue.push([xy.x + i, xy.y + j, L]);
  }
  for (const t of queue) await request(provider, ...t); // load the 80 m files first
  const fresh = new LolaTerrainProvider(heights); // same heights, so every file is in memory
  const frameMs: number[] = [];
  let built = 0;
  while (queue.length) {
    const t0 = performance.now(), end = t0 + 5;
    let did = false;
    for (let i = 0; i < queue.length && (performance.now() < end || !did);) {
      did = true;
      const r = fresh.requestTileGeometry(...queue[i]);
      if (r) { queue.splice(i, 1); r.then(() => built++); } else i++;
    }
    await new Promise(r => setImmediate(r)); // runs after every promise callback of this frame
    frameMs.push(performance.now() - t0);
  }
  console.log(`  300 tiles (Shackleton L9-11): ${frameMs.length} frames, ${built} built, main-thread time per frame median ${fmt(pct(frameMs, 0.5), 1)} ms, max ${fmt(pct(frameMs, 1), 1)} ms`);
  check(built === 300 && pct(frameMs, 1) < 12, 'tile building must stay inside Cesium\'s per-frame budget');
}

console.log('--- speed (main thread, data already loaded) ---');
for (const [name, lat, lon, level] of [['Shackleton 80 m', -89.67, 129.78, 10], ['Tycho global', -43.3, -11.2, 6]] as const) {
  const { x, y } = tileAt(lat, lon, level);
  for (let k = -1; k <= 1; k++) await request(provider, x + k, y, level); // warm up + load data
  const t0 = performance.now(), n = 60;
  for (let k = 0; k < n; k++) provider.requestTileGeometry(x + (k % 3) - 1, y, level);
  console.log(`  ${name} L${level}: ${fmt((performance.now() - t0) / n)} ms per tile`);
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
