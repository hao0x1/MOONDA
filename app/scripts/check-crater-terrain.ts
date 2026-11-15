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

/** Exercise the real refresh pipeline with deferred CPU meshes and counted, non-GPU draw handles. */
async function checkRefreshLifecycle() {
  const lat = -89.45, lon = -137.3, frame = { ...trueENU(lat, lon), origin: toCartesian(lat, lon, heights.heightAt(lat, lon, true)) };
  const relief = { centre: { lat, lon }, radius: 600, frame, heightAt: craterRelief };
  const provider = new LolaTerrainProvider(heights, relief);
  const display = trueToDisplayLatLon(lat, lon), xy = provider.tilingScheme.positionToTileXY(C.Cartographic.fromRadians(display.lon, display.lat), 18)!;
  const oldData: any = await request(provider, xy.x, xy.y, 18);
  oldData._createdByUpsampling = true;
  let released = 0, uploaded = 0, workerCalls = 0;
  class Surface {
    terrainState = 6; terrainData: any; mesh: any; vertexArray: any; imagery: unknown[] = [];
    boundingVolumeSourceTile: unknown; boundingVolumeIsFromMesh = false; fill: any;
    get renderedMesh() { return this.vertexArray ? this.mesh : this.fill?.mesh; }
    freeVertexArray() { if (this.vertexArray) { released++; this.vertexArray = undefined; } }
    static _createVertexArrayForMesh(_context: unknown, mesh: unknown) { uploaded++; return { mesh, ready: true }; }
  }
  const tile = (level: number, x: number, y: number, parent?: any) => {
    const data = new Surface(); data.terrainData = oldData; data.mesh = { old: true }; data.vertexArray = { old: true }; data.imagery = [{ photo: true }];
    // A ready photograph makes Cesium's tile flag false even when its terrain is still cut up.
    return { level, x, y, parent, data, state: 2, renderable: true, upsampledFromParent: false, clearPositionCache() {} };
  };
  const source = tile(18, xy.x, xy.y), child = tile(19, xy.x * 2, xy.y * 2, source), leaf = tile(20, xy.x * 4, xy.y * 4, child);
  const coarseXY = provider.tilingScheme.positionToTileXY(C.Cartographic.fromRadians(display.lon, display.lat), 12)!;
  const coarse = tile(12, coarseXY.x, coarseXY.y), far = tile(12, coarseXY.x + 1, coarseXY.y);
  const genuine: any = await request(provider, xy.x, xy.y, 18);
  const received = tile(18, xy.x, xy.y), transformed = tile(18, xy.x, xy.y);
  for (const [pending, state] of [[received, 3], [transformed, 5]] as const) {
    pending.data.terrainData = genuine; pending.data.terrainState = state;
    pending.data.vertexArray = undefined; pending.data.mesh = state === 5 ? { readyCPU: true } : undefined;
  }
  const transformedMesh = transformed.data.mesh;
  const oldChildSurface = child.data, photos = child.data.imagery, oldVA = source.data.vertexArray, oldMesh = source.data.mesh;
  const callbacks = new Set<() => void>();
  const loaded = [far, coarse, source, child, leaf, received, transformed];
  const surface: any = { _tilesToRender: [leaf], forEachLoadedTile(fn: (t: any) => void) { loaded.forEach(fn); } };
  const scene: any = { globe: { _surface: surface }, context: {}, isDestroyed: () => false, requestRender() {},
    postRender: { addEventListener(fn: () => void) { callbacks.add(fn); return () => callbacks.delete(fn); } } };
  const emit = () => { for (const fn of [...callbacks]) fn(); };
  const refresh = provider.refreshSceneTiles.bind(provider);
  let refreshCalls = 0;
  provider.refreshSceneTiles = (...args) => { refreshCalls++; return refresh(...args); };
  const proto: any = C.QuantizedMeshTerrainData.prototype, original = proto.createMesh;
  const jobs: { finish: () => void; promise: Promise<unknown>; key: string }[] = [];
  proto.createMesh = function (options: any) {
    workerCalls++;
    let finish!: () => void;
    const promise = new Promise(resolve => { finish = () => {
      const mesh = { ready: true, id: workerCalls }; this._mesh = mesh;
      this._quantizedVertices = this._encodedNormals = this._indices = undefined;
      resolve(mesh);
    }; });
    jobs.push({ finish, promise, key: `${options.level}/${options.x}/${options.y}` }); return promise;
  };
  try {
    provider.prepareAhead(scene); emit();
    check(received.data.terrainData === genuine && received.data.terrainState === 3,
      'refresh discarded a genuine received source before its mesh could start');
    check(transformed.data.terrainData === genuine && transformed.data.mesh === transformedMesh && transformed.data.terrainState === 5,
      'refresh discarded a genuine transformed source before its draw handle could be made');
    loaded.splice(0, loaded.length, source, child, leaf);
    check(source.data.vertexArray === oldVA && source.data.mesh === oldMesh && released === 0,
      'refinement discarded a drawn mesh while its replacement was still pending');
    const sourceKey = `18/${xy.x}/${xy.y}`, beforeLoaderCalls = workerCalls;
    check(jobs[0].key === sourceKey && (provider as any).meshJobs <= 2,
      'the wheel patch did not prepare first or preparation exceeded two workers');
    const warmed: any = await provider.requestTileGeometry(xy.x, xy.y, 18);
    const task = warmed.createMesh({ tilingScheme: provider.tilingScheme, x: xy.x, y: xy.y, level: 18 });
    check(workerCalls === beforeLoaderCalls, 'the normal loader duplicated an already prepared mesh worker');
    jobs[0].finish(); await task;
    check(source.data.vertexArray === oldVA, 'ready CPU mesh replaced the draw handle outside the frame boundary');
    const beforeSwapRefreshes = refreshCalls;
    emit();
    check(uploaded === 1 && source.data.vertexArray !== oldVA && source.renderable, 'ready replacement was not installed atomically');
    check(refreshCalls > beforeSwapRefreshes, 'an atomic parent swap waited for the next 250 ms refresh');
    check(child.data !== oldChildSurface && child.data.imagery === photos && !child.renderable,
      'old cut-up child was retained or its photos were discarded');
    oldChildSurface.mesh = { staleWorker: true }; oldChildSurface.terrainState = 6;
    check(child.data.mesh === undefined, 'an old child worker resurrected its detached mesh');
    const beforeReadyCalls = workerCalls;
    await warmed.createMesh({});
    check(workerCalls === beforeReadyCalls, 'ready createMesh tried to read freed raw arrays again');
    const installed = source.data.vertexArray;
    provider.setRelief(null);
    for (const job of jobs) job.finish(); await Promise.all(jobs.map(job => job.promise)); await Promise.resolve(); await Promise.resolve();
    emit();
    check(source.data.vertexArray === installed && callbacks.size === 0, 'obsolete warm jobs installed a mesh or kept a callback after exit');
    provider.setRelief(relief);
    const angle = 120 / 1737400, away = toTrueLatLon(new C.Cartesian3(
      frame.up.x * Math.cos(angle) + frame.east.x * Math.sin(angle),
      frame.up.y * Math.cos(angle) + frame.east.y * Math.sin(angle),
      frame.up.z * Math.cos(angle) + frame.east.z * Math.sin(angle)));
    relief.centre.lat = away.lat; relief.centre.lon = away.lon;
    surface._tilesToRender = [source];
    provider.refreshSceneTiles(scene, 'moving');
    check(source.data.vertexArray === installed && source.renderable, 'coarsening discarded a currently drawn source');
    surface._tilesToRender = []; source.data.terrainState = 4;
    provider.refreshSceneTiles(scene, 'moving');
    surface._tilesToRender = [source]; source.data.terrainState = 6; emit();
    check(source.data.vertexArray === installed, 'deferred coarsening did not recheck current visibility');
    surface._tilesToRender = []; source.data.terrainState = 4;
    provider.refreshSceneTiles(scene, 'moving');
    (source as any).data = undefined; emit();
    check((provider as any).pendingRefresh.size === 0 && callbacks.size === 0, 'an evicted tile stayed in the pending refresh set');
    relief.centre.lat = lat; relief.centre.lon = lon;
    const next = new LolaTerrainProvider(heights, relief), predicted = tile(18, xy.x, xy.y), keptVA = predicted.data.vertexArray;
    const nextCallbacks = new Set<() => void>();
    const nextScene: any = { ...scene, globe: { _surface: { _tilesToRender: [predicted], forEachLoadedTile(fn: (t: any) => void) { fn(predicted); } } },
      postRender: { addEventListener(fn: () => void) { nextCallbacks.add(fn); return () => nextCallbacks.delete(fn); } } };
    const beforePredictionJobs = jobs.length;
    next.prepareAhead(nextScene); for (const fn of [...nextCallbacks]) fn();
    const predictedJob = jobs.slice(beforePredictionJobs).find(job => job.key === sourceKey)!;
    relief.centre.lat = away.lat; relief.centre.lon = away.lon;
    predictedJob.finish(); await predictedJob.promise; await Promise.resolve(); await Promise.resolve();
    for (const fn of [...nextCallbacks]) fn();
    check(predicted.data.vertexArray === keptVA && (next as any).upgrades.size === 0,
      'an obsolete prediction replaced the old drawn mesh after a turn');
    next.setRelief(null);
    relief.centre.lat = lat; relief.centre.lon = lon;
    for (const state of [3, 5]) {
      const finishing = new LolaTerrainProvider(heights, relief), support = tile(18, xy.x, xy.y);
      support.data.terrainData = genuine; support.data.terrainState = state;
      support.data.vertexArray = undefined; support.data.mesh = state === 5 ? { oldCPU: true } : undefined;
      const drawn = tile(19, xy.x * 2, xy.y * 2, support), oldDrawn = drawn.data, keptPhotos = support.data.imagery;
      const finishCallbacks = new Set<() => void>();
      const finishScene: any = { ...scene,
        globe: { _surface: { _tilesToRender: [drawn], forEachLoadedTile(fn: (t: any) => void) { [support, drawn].forEach(fn); } } },
        postRender: { addEventListener(fn: () => void) { finishCallbacks.add(fn); return () => finishCallbacks.delete(fn); } } };
      const frame = () => { for (const fn of [...finishCallbacks]) fn(); };
      const beforeFinishJobs = jobs.length;
      finishing.prepareAhead(finishScene); frame();
      const finishJob = jobs.slice(beforeFinishJobs).find(job => job.key === sourceKey)!;
      finishJob.finish(); await finishJob.promise; await Promise.resolve(); await Promise.resolve();
      support.data.terrainState = state === 3 ? 4 : 2;
      frame();
      check(!support.data.vertexArray && drawn.data === oldDrawn,
        `finishing a support parent interrupted an active state ${support.data.terrainState} owner`);
      support.data.terrainState = state;
      frame();
      check(support.data.terrainState === 6 && !!support.data.vertexArray && support.data.imagery === keptPhotos,
        `a genuine state ${state} support parent did not consume its prepared mesh`);
      check(drawn.data !== oldDrawn && drawn.data.mesh === undefined,
        `finishing a state ${state} support parent left its old cut-up descendant live`);
      finishing.setRelief(null);
      for (const job of jobs) job.finish(); await Promise.all(jobs.map(job => job.promise));
      await Promise.resolve(); await Promise.resolve();
      check(finishCallbacks.size === 0, `a state ${state} support-parent fixture kept a callback after exit`);
    }
    for (const [buildMs, expectedStarts] of [[0.4, 2], [2.1, 1]]) {
      const budget = new LolaTerrainProvider(heights, relief), budgetCallbacks = new Set<() => void>();
      const budgetScene: any = { ...scene, globe: { _surface: { _tilesToRender: [], forEachLoadedTile() {} } },
        postRender: { addEventListener(fn: () => void) { budgetCallbacks.add(fn); return () => budgetCallbacks.delete(fn); } } };
      budget.prepareAhead(budgetScene);
      let clock = 0, builds = 0;
      // Isolate dispatch from file downloads: these held CPU meshes need only the worker API.
      (budget as any).buildTileData = () => { builds++; clock += buildMs; return { createMesh: proto.createMesh }; };
      const now = performance.now, beforeBudgetJobs = jobs.length;
      try {
        performance.now = () => clock;
        for (const fn of [...budgetCallbacks]) fn();
      } finally { performance.now = now; }
      check(builds === expectedStarts && jobs.length - beforeBudgetJobs === expectedStarts,
        `the 2 ms preparation slice started ${builds} grids/${jobs.length - beforeBudgetJobs} workers with ${buildMs} ms builds`);
      check((budget as any).meshJobs === expectedStarts && (budget as any).meshJobs <= 2,
        `preparation has ${(budget as any).meshJobs} active workers, expected ${expectedStarts} within its two-worker limit`);
      if (expectedStarts === 2) {
        const heldJobs = jobs.length;
        for (const fn of [...budgetCallbacks]) fn();
        check(jobs.length === heldJobs, 'a later frame started a third worker while two were active');
      }
      budget.setRelief(null);
      for (const job of jobs) job.finish(); await Promise.all(jobs.map(job => job.promise));
      await Promise.resolve(); await Promise.resolve();
    }
    const apolloLat = 0.674, apolloLon = 23.473;
    const apolloRelief = { centre: { lat: apolloLat, lon: apolloLon }, radius: 600,
      frame: { ...trueENU(apolloLat, apolloLon), origin: toCartesian(apolloLat, apolloLon, heights.heightAt(apolloLat, apolloLon, true)) }, heightAt: craterRelief };
    const lower = new LolaTerrainProvider(heights, apolloRelief), ordinary = new LolaTerrainProvider(heights);
    const apolloDisplay = trueToDisplayLatLon(apolloLat, apolloLon), apolloCarto = C.Cartographic.fromRadians(apolloDisplay.lon, apolloDisplay.lat);
    const lowerTiles: any[] = [];
    for (let level = 8; level <= 12; level++) {
      const point = lower.tilingScheme.positionToTileXY(apolloCarto, level)!;
      lowerTiles.push(tile(level, point.x, point.y, lowerTiles.at(-1)));
      if (level < 12) check(!ordinary.getTileDataAvailable(point.x, point.y, level) && lower.getTileDataAvailable(point.x, point.y, level),
        `Apollo L${level} fixture did not exercise a source made available only by relief`);
    }
    const lowerCallbacks = new Set<() => void>();
    const lowerScene: any = { ...scene, globe: { _surface: { _tilesToRender: [lowerTiles.at(-1)], forEachLoadedTile(fn: (t: any) => void) { lowerTiles.forEach(fn); } } },
      postRender: { addEventListener(fn: () => void) { lowerCallbacks.add(fn); return () => lowerCallbacks.delete(fn); } } };
    lower.prepareAhead(lowerScene);
    for (const ancestor of lowerTiles.slice(0, -1)) check((lower as any).upgrades.has(ancestor)
      && (lower as any).prepared.has(`${ancestor.level}/${ancestor.x}/${ancestor.y}`),
    `explicit Apollo L${ancestor.level} relief-only source upgrade did not queue`);
    lower.setRelief(null);
    check(lowerCallbacks.size === 0, 'explicit lower-level upgrades retained a listener after exit');
    for (const job of jobs) job.finish(); await Promise.all(jobs.map(job => job.promise));
    console.log(JSON.stringify({ refreshLifecycle: 'passed', uploaded, released, workerCalls, cacheLimit: (provider as any).prepared.size }));
  } finally {
    provider.setRelief(null); proto.createMesh = original;
  }
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

await checkRefreshLifecycle();
console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL CRATER TERRAIN CHECKS PASSED');
process.exitCode = failures ? 1 : 0;
