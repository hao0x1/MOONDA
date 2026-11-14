// Checks the physical crater tiles with the real local LOLA data.
// Run from app/: node scripts/check-crater-terrain.ts
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const appSrc = new URL('../src/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL?.startsWith(appSrc)) {
      return nextResolve(specifier + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
const netFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (!String(input).startsWith('file:')) return netFetch(input, init);
  try { return new Response(await readFile(fileURLToPath(String(input)))); }
  catch { return new Response(null, { status: 404 }); }
}) as typeof fetch;

const C = await import('cesium');
const { MoonHeights } = await import('../src/science/heights.ts');
const { LolaTerrainProvider } = await import('../src/moon/lolaTerrain.ts');
const { craterRelief } = await import('../src/moon/craterField.ts');
const { trueENU, toCartesian, toTrueLatLon, trueToDisplayLatLon, displayToTrueLatLon } = await import('../src/moon/frame.ts');

const heights = new MoonHeights(new URL('../public/data/', import.meta.url).href);
await heights.ready;
const N = 65, NV = N * N, MAX_Q = 32767;
const CORE_RADII = [600, 300, 150, 75, 37.5, 18.75, 9.375];
let failures = 0;
const check = (ok: boolean, message: string) => { if (!ok) { failures++; console.error('FAIL:', message); } };
async function request(provider: InstanceType<typeof LolaTerrainProvider>, x: number, y: number, level: number) {
  const deadline = performance.now() + 20000;
  for (;;) {
    const tile = provider.requestTileGeometry(x, y, level);
    if (tile) return await tile as any;
    if (performance.now() > deadline) throw new Error(`Tile ${level}/${x}/${y} did not finish`);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
const decoded = (tile: any, vertex: number) => C.Math.lerp(tile._minimumHeight, tile._maximumHeight,
  tile._quantizedVertices[2 * NV + vertex] / MAX_Q);
const rounding = (tile: any) => (tile._maximumHeight - tile._minimumHeight) / (2 * MAX_Q);
const skirts = (tile: any): number[] => [tile._westSkirtHeight, tile._southSkirtHeight, tile._eastSkirtHeight, tile._northSkirtHeight];
const cutSkirts = (parent: number[], east: boolean, north: boolean): number[] => {
  const half = Math.min(...parent) / 2;
  return [east ? half : parent[0], north ? half : parent[1], east ? parent[2] : half, north ? parent[3] : half];
};
function surfaceAt(data: any, rect: any, lat: number, lon: number): number {
  const fi = (lon - rect.west) / (rect.east - rect.west) * (N - 1);
  const fj = (lat - rect.south) / (rect.north - rect.south) * (N - 1);
  const i = Math.max(0, Math.min(N - 2, Math.floor(fi))), j = Math.max(0, Math.min(N - 2, Math.floor(fj)));
  const a = fi - i, b = fj - j, sw = decoded(data, j * N + i), se = decoded(data, j * N + i + 1);
  const nw = decoded(data, (j + 1) * N + i), ne = decoded(data, (j + 1) * N + i + 1);
  return a >= b ? sw + (se - sw) * a + (ne - se) * b : sw + (nw - sw) * b + (ne - nw) * a;
}

/** The whole boundary at each real level, including the skirts inherited by cut children down to L22. */
async function boundarySweep(provider: InstanceType<typeof LolaTerrainProvider>, centre: InstanceType<typeof C.Cartographic>) {
  const cache = new Map<string, any>();
  const tile = async (x: number, y: number, level: number) => {
    const key = `${level}/${x}/${y}`;
    if (!cache.has(key)) cache.set(key, await request(provider, x, y, level));
    return cache.get(key);
  };
  const levels: { level: number; edges: number; worstSkirtShare: number }[] = [];
  for (let level = 12; level <= 18; level++) {
    const xy = provider.tilingScheme.positionToTileXY(centre, level)!;
    const rect = provider.tilingScheme.tileXYToRectangle(xy.x, xy.y, level);
    const spacing = 1737400 * Math.min(rect.north - rect.south, (rect.east - rect.west) * Math.cos(centre.latitude));
    const reach = Math.ceil(CORE_RADII[level - 12] / spacing) + 5;
    let edges = 0, worstSkirtShare = 0;
    for (let x = xy.x - reach; x <= xy.x + reach; x++) for (let y = xy.y - reach; y <= xy.y + reach; y++) {
      if (!provider.getTileDataAvailable(x, y, level)) continue;
      for (const [dx, dy, realEdge, cutEdge] of [[-1, 0, 0, 2], [0, 1, 1, 3], [1, 0, 2, 0], [0, -1, 3, 1]]) {
        const ux = x + dx, uy = y + dy;
        if (provider.getTileDataAvailable(ux, uy, level)) continue;
        const px = ux >> 1, py = uy >> 1;
        check(provider.getTileDataAvailable(px, py, level - 1), `L${level} boundary has an unavailable neighbour without a real direct parent`);
        const real = await tile(x, y, level), parent = await tile(px, py, level - 1);
        const rr = provider.tilingScheme.tileXYToRectangle(x, y, level);
        const pr = provider.tilingScheme.tileXYToRectangle(px, py, level - 1);
        const inherited = cutSkirts(skirts(parent), ux !== 2 * px, uy === 2 * py);
        // Along a shared outer edge, further cuts keep that edge's skirt rather than halve it.
        // Test both children on that edge at every later level, including L19–22 after real data stops.
        let current = inherited;
        for (let childLevel = level + 1; childLevel <= 22; childLevel++) {
          for (const along of [false, true]) {
            const east = cutEdge === 0 ? false : cutEdge === 2 ? true : along;
            const north = cutEdge === 1 ? false : cutEdge === 3 ? true : along;
            check(cutSkirts(current, east, north)[cutEdge] >= inherited[cutEdge], `L${childLevel} loses its shared boundary skirt`);
          }
          current = cutSkirts(current, cutEdge === 2, cutEdge === 3);
        }
        for (let sample = 0; sample <= 128; sample++) {
          const f = sample / 128, vertical = realEdge === 0 || realEdge === 2;
          const lat = vertical ? C.Math.lerp(rr.south, rr.north, f) : realEdge === 1 ? rr.south : rr.north;
          const lon = vertical ? realEdge === 0 ? rr.west : rr.east : C.Math.lerp(rr.west, rr.east, f);
          const gap = surfaceAt(real, rr, lat, lon) - surfaceAt(parent, pr, lat, lon);
          const covering = gap >= 0 ? skirts(real)[realEdge] : inherited[cutEdge];
          // Chord sag and position encoding are below a centimetre here, included in the margin.
          const share = (Math.abs(gap) + 0.01) / covering;
          worstSkirtShare = Math.max(worstSkirtShare, share);
          check(share <= 1, `L${level} boundary crack ${Math.abs(gap).toFixed(3)} m exceeds ${covering.toFixed(3)} m skirt`
            + ` at ${x}/${y} edge ${realEdge}, cut ${ux}/${uy} parent ${px}/${py}, f=${f}, gap=${gap}, parentMask=${parent._childTileMask}`);
        }
        edges++;
      }
    }
    check(edges > 0, `L${level} boundary was not reached by the sweep`);
    levels.push({ level, edges, worstSkirtShare });
  }
  return levels;
}

/** Real neighbours drawn one to four levels apart, including the first physical level beside LOLA. */
async function lodSweep(provider: InstanceType<typeof LolaTerrainProvider>, centre: InstanceType<typeof C.Cartographic>) {
  const cache = new Map<string, any>();
  const tile = async (x: number, y: number, level: number) => {
    const key = `${level}/${x}/${y}`;
    if (!cache.has(key)) cache.set(key, await request(provider, x, y, level));
    return cache.get(key);
  };
  const ev = (edge: number, i: number) => edge === 0 ? i * N : edge === 2 ? i * N + N - 1 : edge === 1 ? i : (N - 1) * N + i;
  let edges = 0, worstShare = 0;
  for (let level = 11; level < 18; level++) {
    const centreXY = provider.tilingScheme.positionToTileXY(centre, level)!;
    for (const offset of [-1, 0, 1]) {
      const x = centreXY.x + offset, y = centreXY.y + offset;
      if (!provider.getTileDataAvailable(x, y, level)) continue;
      const coarse = await tile(x, y, level);
      const rect = provider.tilingScheme.tileXYToRectangle(x, y, level);
      for (let delta = 1; delta <= Math.min(4, 18 - level); delta++) {
        const parts = 1 << delta;
        for (let edge = 0; edge < 4; edge++) for (let part = 0; part < parts; part++) {
          const fx = edge === 0 ? x * parts : edge === 2 ? (x + 1) * parts - 1 : x * parts + part;
          const fy = edge === 1 ? (y + 1) * parts - 1 : edge === 3 ? y * parts : y * parts + parts - 1 - part;
          if (!provider.getTileDataAvailable(fx, fy, level + delta)) continue;
          const fine = await tile(fx, fy, level + delta);
          const spacing = 1737400 * (edge === 0 || edge === 2 ? rect.north - rect.south
            : Math.cos(edge === 1 ? rect.south : rect.north) * (rect.east - rect.west)) / (N - 1);
          for (let i = 0; i < N; i++) {
            const q = (part * (N - 1) + i) / parts, i0 = Math.min(N - 2, Math.floor(q)), f = q - i0;
            const chord = C.Math.lerp(decoded(coarse, ev(edge, i0)), decoded(coarse, ev(edge, i0 + 1)), f)
              - f * (1 - f) * spacing * spacing / (2 * 1737400);
            const gap = decoded(fine, ev(edge, i)) - chord;
            const covering = gap >= 0 ? skirts(fine)[edge] : skirts(coarse)[edge];
            const share = (Math.abs(gap) + 0.005) / covering;
            worstShare = Math.max(worstShare, share);
            check(share <= 1, `L${level}/L${level + delta} real edge ${edge}: ${Math.abs(gap).toFixed(4)} m crack exceeds ${covering.toFixed(4)} m skirt`);
          }
          edges++;
        }
      }
    }
  }
  check(edges > 100, 'mixed-level sweep did not cover enough real edges');
  return { edges, worstShare };
}

/** Independent nearest-point search on the sphere; only used to check the availability boundary. */
function nearestMetres(rect: any, centre: InstanceType<typeof C.Cartographic>): number {
  const lon = Math.max(rect.west, Math.min(rect.east, centre.longitude));
  const cl = Math.cos(centre.latitude), sl = Math.sin(centre.latitude), cd = Math.cos(lon - centre.longitude);
  const cosine = (lat: number) => sl * Math.sin(lat) + cl * Math.cos(lat) * cd;
  let lo = rect.south, hi = rect.north;
  for (let i = 0; i < 35; i++) {
    const a = (2 * lo + hi) / 3, b = (lo + 2 * hi) / 3;
    if (cosine(a) > cosine(b)) hi = b; else lo = a;
  }
  return 1737400 * Math.acos(Math.min(1, Math.max(-1, cosine((lo + hi) / 2))));
}

/** Count fixed 65 x 65 source grids, rather than pretending this CPU check measured browser draw calls. */
function availabilityBudget(provider: InstanceType<typeof LolaTerrainProvider>, relief: any, centre: InstanceType<typeof C.Cartographic>) {
  const rows: { level: number; coreM: number; grids: number; previousGrids: number; furthestNearestM: number }[] = [];
  let grids = 0, previousGrids = 0;
  for (let level = 12; level <= 18; level++) {
    // Compensate for the new halving at this one level to reproduce the former 600 m-everywhere rule.
    const previous = new LolaTerrainProvider(heights, { ...relief, radius: 600 * 2 ** (level - 12) });
    const xy = provider.tilingScheme.positionToTileXY(centre, level)!;
    const middle = provider.tilingScheme.tileXYToRectangle(xy.x, xy.y, level);
    const spacing = 1737400 * Math.min(middle.north - middle.south,
      (middle.east - middle.west) * Math.cos(centre.latitude));
    const reach = Math.ceil(600 / spacing) + 5, coreM = CORE_RADII[level - 12];
    const diagonal = 1737400 * Math.hypot(middle.north - middle.south, middle.east - middle.west);
    let count = 0, oldCount = 0, furthestNearestM = 0;
    for (let x = xy.x - reach; x <= xy.x + reach; x++) for (let y = xy.y - reach; y <= xy.y + reach; y++) {
      if (previous.getTileDataAvailable(x, y, level)) oldCount++;
      if (!provider.getTileDataAvailable(x, y, level)) continue;
      count++;
      const nearest = nearestMetres(provider.tilingScheme.tileXYToRectangle(x, y, level), centre);
      furthestNearestM = Math.max(furthestNearestM, nearest);
      check(nearest <= coreM + diagonal + 0.01, `L${level} source outside its core and one-tile ring`);
      if (level === 18) check(nearest < 40, 'finest real source more than 40 m from the rover');
    }
    check(count > 0, `L${level} lost the rover's local source grids`);
    grids += count; previousGrids += oldCount;
    rows.push({ level, coreM, grids: count, previousGrids: oldCount, furthestNearestM });
  }
  // This is a conservative all-level source-grid budget, including overlapping ancestors. Actual
  // rendering selects only the patches it needs, and its triangle count is checked in the browser.
  const possibleFixedTriangles = grids * 2 * (N - 1) ** 2;
  const previousFixedTriangles = previousGrids * 2 * (N - 1) ** 2;
  check(possibleFixedTriangles < previousFixedTriangles * 0.15, 'fine source grids did not shrink enough');
  return { rows, possibleFixedTriangles, previousFixedTriangles };
}

for (const [lat, lon] of [[-89.45, -137.3], [0.674, 23.473]]) {
  await heights.loadTilesAround(lat, lon, 4000);
  const frame = { ...trueENU(lat, lon), origin: toCartesian(lat, lon, heights.heightAt(lat, lon, true)) };
  const relief = { centre: { lat, lon }, radius: 600, frame, heightAt: craterRelief };
  const provider = new LolaTerrainProvider(heights, relief);
  // Identical sampling with no displacement independently checks that crater lighting is not
  // included a second time in the vertex normals.
  const zero = new LolaTerrainProvider(heights, { ...relief, heightAt: () => 0 });
  const display = trueToDisplayLatLon(lat, lon), centre = C.Cartographic.fromRadians(display.lon, display.lat);
  const budget = availabilityBudget(provider, relief, centre);
  let worstFieldError = 0, worstEdgeError = 0, normalChanges = 0, outsideSphere = 0, outsideBox = 0;
  const timings: { level: number; ms: number }[] = [];
  for (const level of [12, 15, 17, 18]) {
    const xy = provider.tilingScheme.positionToTileXY(centre, level)!;
    const tile = await request(provider, xy.x, xy.y, level), flat = await request(zero, xy.x, xy.y, level);
    const east = await request(provider, xy.x + 1, xy.y, level);
    const south = await request(provider, xy.x, xy.y + 1, level);
    const rect = provider.tilingScheme.tileXYToRectangle(xy.x, xy.y, level), q = tile._quantizedVertices;
    for (let v = 0; v < NV; v++) {
      const dLat = C.Math.lerp(rect.south, rect.north, q[NV + v] / MAX_Q);
      const dLon = C.Math.lerp(rect.west, rect.east, q[v] / MAX_Q);
      const truth = displayToTrueLatLon(dLat, dLon), h = decoded(tile, v);
      const position = toCartesian(truth.lat, truth.lon, h);
      const delta = C.Cartesian3.subtract(position, frame.origin, new C.Cartesian3());
      const expected = heights.heightAt(truth.lat, truth.lon, true)
        + craterRelief(C.Cartesian3.dot(delta, frame.east), C.Cartesian3.dot(delta, frame.north));
      // Height quantisation and its tiny effect on the field's horizontal coordinates are allowed.
      worstFieldError = Math.max(worstFieldError, Math.abs(h - expected) - rounding(tile) * 1.02);
      outsideSphere = Math.max(outsideSphere, C.Cartesian3.distance(position, tile._boundingSphere.center) - tile._boundingSphere.radius);
      outsideBox = Math.max(outsideBox, C.OrientedBoundingBox.distanceSquaredTo(tile._orientedBoundingBox, position));
    }
    for (let v = 0; v < 2 * NV; v++) if (tile._encodedNormals[v] !== flat._encodedNormals[v]) normalChanges++;
    for (let i = 0; i < N; i++) {
      const edgeE = Math.abs(decoded(tile, i * N + N - 1) - decoded(east, i * N));
      const edgeS = Math.abs(decoded(tile, i) - decoded(south, (N - 1) * N + i));
      worstEdgeError = Math.max(worstEdgeError, edgeE - rounding(tile) - rounding(east), edgeS - rounding(tile) - rounding(south));
    }
    check(provider.getTileDataAvailable(xy.x, xy.y, level), `${lat}: near L${level} unavailable`);
    for (let parent = level - 1; parent >= 0; parent--) {
      const shift = level - parent;
      check(provider.getTileDataAvailable(xy.x >> shift, xy.y >> shift, parent), `${lat}: unavailable L${parent} ancestor`);
    }
    const t0 = performance.now(), count = 12;
    for (let k = 0; k < count; k++) await request(provider, xy.x, xy.y, level);
    timings.push({ level, ms: (performance.now() - t0) / count });
  }
  check(worstFieldError < 0.0001, `${lat}: field differs beyond height rounding by ${worstFieldError} m`);
  check(worstEdgeError < 0.00001, `${lat}: shared edge differs beyond height rounding by ${worstEdgeError} m`);
  check(normalChanges === 0, `${lat}: relief changed ${normalChanges} LOLA normal bytes`);
  check(outsideSphere < 0.01 && outsideBox < 0.01, `${lat}: displaced vertices outside bounds`);
  const boundaries = await boundarySweep(provider, centre);
  const lod = await lodSweep(provider, centre);
  const xy = provider.tilingScheme.positionToTileXY(centre, 18)!;
  const before = await request(provider, xy.x, xy.y, 18);
  relief.centre.lat += 1;
  check(!provider.getTileDataAvailable(xy.x, xy.y, 18), `${lat}: old area still available after centre moved 30 km`);
  const after = await request(provider, xy.x, xy.y, 18);
  check(before._quantizedVertices.every((v: number, i: number) => v === after._quantizedVertices[i]), `${lat}: moving centre changed an old tile`);
  check(!provider.getTileDataAvailable(xy.x, xy.y, 19), `${lat}: L19 should be interpolated`);
  // Cross the shadow-map recenter distance without changing the crater frame. At this distance a
  // radial displacement has a measurable east/north component; check the corrected vertex too.
  const angle = 3500 / 1737400;
  const away = toTrueLatLon(new C.Cartesian3(
    frame.up.x * Math.cos(angle) + frame.east.x * Math.sin(angle),
    frame.up.y * Math.cos(angle) + frame.east.y * Math.sin(angle),
    frame.up.z * Math.cos(angle) + frame.east.z * Math.sin(angle)));
  relief.centre.lat = away.lat; relief.centre.lon = away.lon;
  const awayDisplay = trueToDisplayLatLon(away.lat, away.lon);
  const axy = provider.tilingScheme.positionToTileXY(C.Cartographic.fromRadians(awayDisplay.lon, awayDisplay.lat), 18)!;
  const awayTile = await request(provider, axy.x, axy.y, 18), aq = awayTile._quantizedVertices;
  const ar = provider.tilingScheme.tileXYToRectangle(axy.x, axy.y, 18);
  let awayError = 0;
  for (let v = 0; v < NV; v += 7) {
    const truth = displayToTrueLatLon(C.Math.lerp(ar.south, ar.north, aq[NV + v] / MAX_Q), C.Math.lerp(ar.west, ar.east, aq[v] / MAX_Q));
    const h = decoded(awayTile, v), position = toCartesian(truth.lat, truth.lon, h);
    const delta = C.Cartesian3.subtract(position, frame.origin, new C.Cartesian3());
    const expected = heights.heightAt(truth.lat, truth.lon, true)
      + craterRelief(C.Cartesian3.dot(delta, frame.east), C.Cartesian3.dot(delta, frame.north));
    awayError = Math.max(awayError, Math.abs(h - expected) - rounding(awayTile) * 1.02);
  }
  check(awayError < 0.0001, `${lat}: field misaligned 3.5 km away by ${awayError} m`);
  relief.centre.lat = lat; relief.centre.lon = lon;
  check(provider.getTileDataAvailable(xy.x, xy.y, 18), `${lat}: original spot unavailable on return`);
  const returned = await request(provider, xy.x, xy.y, 18);
  check(before._quantizedVertices.every((v: number, i: number) => v === returned._quantizedVertices[i]), `${lat}: returning changed the crater field`);
  provider.setRelief(null);
  check(!provider.getTileDataAvailable(xy.x, xy.y, 18), `${lat}: fine tiles available with relief off`);
  console.log(JSON.stringify({ lat, lon, worstFieldError, worstEdgeError, normalChanges, outsideSphere, outsideBox, awayError, timings, boundaries, lod, budget }));
}

console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CRATER TERRAIN CHECKS PASSED');
process.exitCode = failures ? 1 : 0;
