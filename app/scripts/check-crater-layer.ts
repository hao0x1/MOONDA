// Run: node scripts/check-crater-layer.ts
// These checks use the rim maths that the screen renderer uses. Rings are drawn
// whole, so tile lists and tile clipping cannot cut them. The tile checks below
// still guard the shared sphere/projection maths at ordinary edges and the seam.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  craterCircle, pointOnCrater, projectCraterPointToTile, craterScreenKey,
  craterSizeOpacity, craterScreenDiameter, trimCraterChunks,
  craterWillLeave,
  craterFade, chooseStableCraters,
} from '../src/moon/craterLayer.ts';

type Vec = [number, number, number];
type Rect = { west: number; east: number; south: number; north: number };
const DEG = Math.PI / 180, R_KM = 1737.4, TILE = 256;
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec) => Math.hypot(...a);
const angle = (a: Vec, b: Vec) => Math.atan2(length(cross(a, b)), dot(a, b));
const wrap = (x: number) => ((x + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const close = (a: number, b: number, tolerance: number, why: string) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${why}: ${a} versus ${b}`);
const trueUnit = (lat: number, lon: number): Vec => [Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG)];
// Written independently from frame.ts: this is the stated rigid rotation.
const toDisplay = (p: Vec): Vec => [p[0], -p[2], p[1]];
const toTrue = (p: Vec): Vec => [p[0], p[2], -p[1]];

// Streaming terrain changes depth planes without moving the photo. Those changes
// used to clear an otherwise correct screen drawing, especially near the poles.
const screenMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 30, -30000, 1800000];
const depthOnly = [...screenMatrix];
for (const i of [2, 6, 10, 14]) depthOnly[i] = 123456.789 * (i + 1);
assert.equal(craterScreenKey(depthOnly), craterScreenKey(screenMatrix), 'depth limits do not clear a still drawing');
const noiseOnly = [...screenMatrix]; noiseOnly[12] = -1e-10; noiseOnly[0] += 1e-14;
assert.equal(craterScreenKey(noiseOnly), craterScreenKey(screenMatrix), 'rounding noise does not clear a still drawing');
const moved = [...screenMatrix]; moved[12] += .01;
assert.notEqual(craterScreenKey(moved), craterScreenKey(screenMatrix), 'a real camera move redraws');

const edgeNow = { x0: 20, x1: 80, y0: 100, y1: 160 };
assert.equal(craterWillLeave(edgeNow, { ...edgeNow, x0: 40, x1: 100 }, 16, 1000, 600), true,
  'an outward-moving rim starts fading before it reaches the edge');
assert.equal(craterWillLeave(edgeNow, edgeNow, 16, 1000, 600), false, 'a still rim at the edge stays');
assert.equal(craterWillLeave(edgeNow, { ...edgeNow, x0: 0, x1: 60 }, 16, 1000, 600), false,
  'an inward-moving rim is retained');
assert.equal(craterWillLeave(edgeNow, { ...edgeNow, x0: 40, x1: 100 }, 200, 1000, 600), false,
  'a long pause is not treated as camera velocity');

close(craterSizeOpacity(1000, 1000), 1, 0, 'normal rim keeps its opacity');
close(craterSizeOpacity(1150, 1000), .5, 1e-12, 'large rim fades smoothly');
close(craterSizeOpacity(1300, 1000), 0, 1e-12, 'oversized rim is omitted');
assert.equal(craterSizeOpacity(Infinity, 1000), 0, 'a rim crossing the camera plane is omitted');
let previousOpacity = 1;
for (let ratio = 1; ratio <= 1.31; ratio += .001) {
  const opacity = craterSizeOpacity(ratio * 1000, 1000);
  assert.ok(opacity <= previousOpacity && previousOpacity - opacity < .006, 'size fade has no jump');
  previousOpacity = opacity;
}

// The exact projected diameter must agree with a separately sampled rim. In
// particular, a large off-centre basin cannot pass as a short visible arc.
const eyeZ = 1737400 + 300000, fovScale = 2.7;
const projection = [fovScale, 0, 0, 0, 0, fovScale, 0, 0, 0, 0, -1, -1, 0, 0, 0, eyeZ];
for (const [lat, lon, km] of [[0, 90, 56], [12, 65, 1200], [-5, 110, 500]]) {
  const circle = craterCircle(lat, lon, km);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < 7200; i++) {
    const p = pointOnCrater(circle, i / 7200 * 2 * Math.PI), w = eyeZ - p[2] * 1737400;
    const x = fovScale * p[0] * 1737400 / w * 1440 / 2;
    const y = fovScale * p[1] * 1737400 / w * 900 / 2;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const sampled = Math.max(x1 - x0, y1 - y0), exact = craterScreenDiameter(circle, projection, 1440, 900);
  close(sampled / exact, 1, .00001, 'whole-rim screen extent');
}

const lru = new Map([
  ['old', { data: new Float32Array(16), used: 1 }],
  ['recent', { data: new Float32Array(16), used: 3 }],
  ['middle', { data: new Float32Array(16), used: 2 }],
]);
assert.deepEqual(trimCraterChunks(lru, 128), { bytes: 128, evicted: 1 }, 'cache stays within its budget');
assert.deepEqual([...lru.keys()], ['recent', 'middle'], 'oldest chunk is dropped first');
lru.get('middle')!.used = 4;
assert.deepEqual(trimCraterChunks(lru, 64), { bytes: 64, evicted: 1 }, 'a smaller budget is enforced immediately');
assert.deepEqual([...lru.keys()], ['middle'], 'recently used chunk survives');

// A changed choice eases from its current opacity. No ring is removed halfway
// through its 200 ms fade, and reversing direction must not restart from zero.
close(craterFade(0, 1, 1000, 999), 0, 0, 'fade waits for its start');
close(craterFade(0, 1, 1000, 1000), 0, 0, 'fade-in starts transparently');
close(craterFade(0, 1, 1000, 1100), .5, 1e-12, 'fade-in midpoint');
close(craterFade(0, 1, 1000, 1200), 1, 0, 'fade-in finishes after 200 ms');
close(craterFade(0, 1, 1000, 1300), 1, 0, 'completed fade stays clamped');
close(craterFade(1, 0, 1000, 1100), .5, 1e-12, 'fade-out midpoint');
for (let ms = 0; ms < 200; ms++) {
  assert.ok(craterFade(.7, 0, 1000, 1000 + ms) > 0, 'outgoing ring stays until its fade ends');
}
close(craterFade(.7, 0, 1000, 1200), 0, 0, 'outgoing ring ends at zero');
const reversingAlpha = craterFade(1, 0, 1000, 1080);
close(reversingAlpha, .6, 1e-12, 'partly faded ring keeps its opacity');
close(craterFade(reversingAlpha, 1, 1080, 1080), reversingAlpha, 0, 'fade reversal is continuous');
close(craterFade(reversingAlpha, 1, 1080, 1180), .8, 1e-12, 'reversed fade rises from its current opacity');
close(craterFade(reversingAlpha, 1, 1080, 1280), 1, 0, 'reversed fade completes');
close(craterFade(0, 1, 1000, 1050, 100), .5, 1e-12, 'explicit fade duration is honoured');

type ChoiceCandidate = { id: string; km: number; diameterPx: number; nearView: boolean };
const choice = (id: string, diameterPx: number, km = 10, nearView = true): ChoiceCandidate =>
  ({ id, km, diameterPx, nearView });
const alreadyShown = new Set(['held']);
for (const px of [9, 10, 9.1, 9.9, 10.1, 8.9]) {
  assert.deepEqual(chooseStableCraters([choice('new', px), choice('held', px)], alreadyShown), ['held'],
    'small size changes keep a shown ring without adding another');
}
assert.deepEqual(chooseStableCraters([choice('held', 7), choice('new', 10.999)], alreadyShown), ['held'],
  'shown ring survives down to 7 px; new ring waits for 11 px');
assert.deepEqual(chooseStableCraters([choice('held', 6.999), choice('new', 11)], alreadyShown), ['new'],
  'clearly small old ring leaves and a readable new ring enters');
assert.deepEqual(chooseStableCraters([choice('held', 20, 10, false)], alreadyShown), [],
  'a ring clearly outside the view leaves the choice');
assert.deepEqual(chooseStableCraters([choice('held', 8)], alreadyShown), ['held'],
  'a returning fading ring remains an incumbent');
assert.deepEqual(chooseStableCraters([choice('held', 8)], new Set()), [],
  'a fully removed ring must meet the entry threshold again');

const incumbents = Array.from({ length: 400 }, (_, i) => choice(`held-${String(i).padStart(3, '0')}`, 9, 20 + i));
const incumbentIds = new Set(incumbents.map(c => c.id));
const crowded = [...incumbents, choice('new-large', 50, 10000)];
const stable = chooseStableCraters(crowded, incumbentIds);
assert.equal(stable.length, 400, 'stable choice keeps the 400-ring limit');
assert.deepEqual(new Set(stable), incumbentIds, 'a new larger crater cannot displace readable incumbents');
const oneOutside = crowded.map(c => c.id === 'held-000' ? { ...c, nearView: false } : c);
const replaced = chooseStableCraters(oneOutside, incumbentIds);
assert.equal(replaced.length, 400, 'a freed slot is filled without exceeding the limit');
assert.ok(!replaced.includes('held-000') && replaced.includes('new-large'), 'a ring enters after an incumbent leaves its limits');
const tied = [choice('b', 15, 50), choice('a', 15, 50), choice('large', 15, 60)];
assert.deepEqual(chooseStableCraters(tied, new Set()), ['large', 'a', 'b'], 'ties have a fixed order');
assert.deepEqual(chooseStableCraters([...tied].reverse(), new Set()), ['large', 'a', 'b'],
  'chunk arrival order cannot change equal-sized choices');

const spots: [string, number, number, number][] = [
  ['Firmicus', 7.3, 63.4, 56], ['Copernicus', 9.62, -20.08, 96],
  ['Tycho', -43.3, -11.2, 85], ['Plato', 51.6, -9.4, 101],
  ['Aristarchus', 23.7, -47.4, 40], ['Tsiolkovskiy', -20.4, 129.1, 185],
  ['Schrodinger', -75, 132.4, 316], ['Shackleton', -89.67, 129.8, 21],
  ['Peary', 88.6, 33, 73], ['Near side equator', 0, 0, 1],
  ['Far side equator', 0, 180, 240], ['Mid latitude north', 45, 135, 5],
  ['Mid latitude south', -45, -135, 120], ['True north pole', 90, 0, 21],
  ['True south pole', -90, 0, 21], ['Display north pole', 0, 90, 56],
  ['Display south pole', 0, -90, 56], ['Beside display north pole', .001, 89.999, 1],
  ['Beside display south pole', -.001, -89.999, 1], ['East of date line', 15, 179.999, 50],
  ['West of date line', -15, -179.999, 50], ['East-positive 0 to 360', 9.62, 339.92, 96],
  ['Small polar study crater', -89.9, -179.9, .0467], ['Largest basin', -53, -169, 2491.8701],
];

let samples = 0, worstRadiusFraction = 0, worstNeighbourPx = 0, edgeChecks = 0;

/** Independent inverse projection lets each tile recover its shared sphere point. */
function fromTile(p: { x: number; y: number }, r: Rect): Vec {
  const lon = r.west + p.x / TILE * (r.east - r.west);
  const lat = r.north - p.y / TILE * (r.north - r.south);
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

for (const [name, lat, lon, diameter] of spots) {
  const circle = craterCircle(lat, lon, diameter), expected = trueUnit(lat, lon);
  const wantedRadius = diameter / (2 * R_KM);
  close(angle(circle.centre, toDisplay(expected)), 0, 1e-12, `${name}: display centre`);
  close(angle(toTrue(circle.centre), expected), 0, 1e-12, `${name}: inverse frame`);
  close(circle.radiusRad, wantedRadius, 1e-14, `${name}: km to radians`);
  close(circle.cosRadius, Math.cos(wantedRadius), 1e-14, `${name}: radius cosine`);
  close(circle.sinRadius, Math.sin(wantedRadius), 1e-14, `${name}: radius sine`);
  for (const basis of [circle.centre, circle.east, circle.north]) close(length(basis), 1, 1e-12, `${name}: unit basis`);
  close(dot(circle.centre, circle.east), 0, 1e-12, `${name}: east tangent`);
  close(dot(circle.centre, circle.north), 0, 1e-12, `${name}: north tangent`);
  close(dot(circle.east, circle.north), 0, 1e-12, `${name}: perpendicular tangents`);
  for (let i = 0; i <= 720; i++) {
    const p = pointOnCrater(circle, i / 720 * 2 * Math.PI);
    close(length(p), 1, 1e-12, `${name}: unit rim`);
    const error = Math.abs(angle(circle.centre, p) / wantedRadius - 1);
    worstRadiusFraction = Math.max(worstRadiusFraction, error);
    assert.ok(error < .01, `${name}: rim radius differs by ${(error * 100).toFixed(5)}%`);
    close(angle(expected, toTrue(p)), wantedRadius, wantedRadius * .01, `${name}: true-frame radius`);
    samples++;
  }
  close(angle(pointOnCrater(circle, 0), pointOnCrater(circle, 2 * Math.PI)), 0, 1e-12, `${name}: closed rim`);

  // Solve the intersection of the rim plane and a meridian plane independently
  // of pointOnCrater. This includes rims round the display poles and date line.
  const meridian = Math.atan2(circle.centre[1], circle.centre[0]);
  const plane: Vec = [-Math.sin(meridian), Math.cos(meridian), 0];
  const offset = dot(circle.centre, plane);
  const q: Vec = circle.centre.map((v, i) => v - offset * plane[i]) as Vec;
  const q2 = dot(q, q), side = cross(plane, q), sideLength = length(side);
  const along = circle.cosRadius / q2;
  const across = Math.sqrt(Math.max(0, 1 - circle.cosRadius ** 2 / q2));
  const intersections: Vec[] = [-1, 1].map(sign => q.map((v, i) => along * v + sign * across * side[i] / sideLength) as Vec);
  for (const intersection of intersections) {
    if (Math.abs(wrap(Math.atan2(intersection[1], intersection[0]) - meridian)) > 1e-7) continue;
    const bearing = Math.atan2(dot(intersection, circle.north), dot(intersection, circle.east));
    close(angle(pointOnCrater(circle, bearing), intersection), 0, 1e-10, `${name}: independent edge intersection`);
    for (const level of [0, 3, 7, 12]) {
      const span = Math.PI / 2 ** level;
      const edgeLat = Math.asin(Math.max(-1, Math.min(1, intersection[2])));
      const north = Math.min(Math.PI / 2, Math.max(-Math.PI / 2 + span, edgeLat + span / 2));
      const left: Rect = { west: meridian - span, east: meridian, south: north - span, north };
      // Represent the right-hand date-line tile on the other side of +/-pi.
      const rightWest = meridian >= Math.PI - 1e-12 ? meridian - 2 * Math.PI : meridian;
      const right: Rect = { west: rightWest, east: rightWest + span, south: left.south, north };
      const a = projectCraterPointToTile(pointOnCrater(craterCircle(lat, lon, diameter), bearing), left);
      const b = projectCraterPointToTile(pointOnCrater(craterCircle(lat, lon, diameter), bearing), right);
      const error = Math.max(Math.abs(a.x - TILE), Math.abs(b.x), Math.abs(a.y - b.y));
      worstNeighbourPx = Math.max(worstNeighbourPx, error);
      assert.ok(error < 1e-5, `${name}: neighbouring tile edge differs by ${error} px at level ${level}`);
      close(angle(fromTile(a, left), fromTile(b, right)), 0, 1e-11, `${name}: shared edge returns the same sphere point`);
      // Both tiles must also agree on a short overlapping section beside it.
      for (const delta of [-1e-7, 1e-7]) {
        const pa = projectCraterPointToTile(pointOnCrater(craterCircle(lat, lon, diameter), bearing + delta), left);
        const pb = projectCraterPointToTile(pointOnCrater(craterCircle(lat, lon, diameter), bearing + delta), right);
        close(pa.x - pb.x, TILE, 1e-5, `${name}: overlapping rim x`);
        close(pa.y, pb.y, 1e-5, `${name}: overlapping rim y`);
      }
      edgeChecks++;
    }
  }

  // A horizontal shared edge uses the actual rim point, not its catalogue centre.
  const point = pointOnCrater(circle, .873), sharedLat = Math.asin(point[2]);
  const sharedLon = Math.atan2(point[1], point[0]);
  const span = Math.min(Math.PI / 8, (Math.PI / 2 - Math.abs(sharedLat)) * .9);
  assert.ok(span > 0, `${name}: horizontal edge has no extent`);
  const top: Rect = { west: sharedLon - span / 2, east: sharedLon + span / 2, south: sharedLat, north: sharedLat + span };
  const bottom: Rect = { ...top, south: sharedLat - span, north: sharedLat };
  const a = projectCraterPointToTile(point, top), b = projectCraterPointToTile(point, bottom);
  close(a.x, b.x, 1e-7, `${name}: horizontal shared x`);
  close(a.y, TILE, 1e-7, `${name}: top shared y`);
  close(b.y, 0, 1e-7, `${name}: bottom shared y`);
  close(angle(fromTile(a, top), fromTile(b, bottom)), 0, 1e-11, `${name}: horizontal shared sphere point`);
  edgeChecks++;
}

interface Chunk {
  file: string; count: number; bytes: number; minKm: number; maxKm: number;
  bandMinKm: number; bandMaxKm: number | null; centre: Vec; radiusRad: number;
}
interface Index { count: number; bytes: number; moonRadiusKm: number; chunks: Chunk[] }
const features = new URL('../public/data/features/', import.meta.url);
const indexBytes = readFileSync(new URL('craters-draw/index.json', features));
const index = JSON.parse(indexBytes.toString()) as Index;
close(index.moonRadiusKm, R_KM, 0, 'drawing catalogue Moon radius');
assert.equal(index.count, 1_296_796, 'the complete official Robbins release is present');
const files = new Set<string>();
let recordCount = 0, recordBytes = 0, largestChunk = 0;
for (const chunk of index.chunks) {
  assert.ok(/^craters-draw\/[a-z0-9-]+\.bin$/.test(chunk.file), 'chunk path stays in the drawing folder');
  assert.ok(!files.has(chunk.file), `repeated chunk ${chunk.file}`); files.add(chunk.file);
  const bytes = readFileSync(new URL(chunk.file, features));
  assert.equal(bytes.byteLength, chunk.bytes, `${chunk.file}: byte count`);
  assert.equal(bytes.byteLength, chunk.count * 12, `${chunk.file}: Float32 triple count`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let previous = Infinity;
  for (let i = 0; i < chunk.count; i++) {
    const lat = view.getFloat32(i * 12, true), lon = view.getFloat32(i * 12 + 4, true), km = view.getFloat32(i * 12 + 8, true);
    assert.ok(Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(km), `${chunk.file}: finite record ${i}`);
    assert.ok(lat >= -90 && lat <= 90 && lon >= -180 && lon < 180, `${chunk.file}: valid east longitude/latitude ${i}`);
    assert.ok(km >= chunk.bandMinKm && (chunk.bandMaxKm === null || km < chunk.bandMaxKm), `${chunk.file}: size band ${i}`);
    assert.ok(km <= previous, `${chunk.file}: bigger craters come first`); previous = km;
    if (i === 0) close(km, chunk.maxKm, 0, `${chunk.file}: maximum diameter`);
    if (i === chunk.count - 1) close(km, chunk.minKm, 0, `${chunk.file}: minimum diameter`);
    if (chunk.radiusRad < Math.PI) {
      const rimReach = angle(chunk.centre, toDisplay(trueUnit(lat, lon))) + km / (2 * R_KM);
      assert.ok(rimReach <= chunk.radiusRad + 1e-6, `${chunk.file}: region bound misses a rim`);
    }
  }
  recordCount += chunk.count; recordBytes += bytes.byteLength;
  largestChunk = Math.max(largestChunk, bytes.byteLength);
}
assert.equal(recordCount, index.count, 'all indexed drawing records exist');
assert.equal(recordBytes, index.bytes, 'indexed drawing byte total');
assert.ok(largestChunk < 500_000, 'each drawing download stays below 500 kB');
const onDisk = readdirSync(new URL('craters-draw/', features)).filter(f => f.endsWith('.bin'));
assert.equal(onDisk.length, files.size, 'no unindexed drawing chunks');
for (const f of onDisk) assert.ok(files.has(`craters-draw/${f}`), `unindexed chunk ${f}`);

const retained: Record<string, string> = {
  'craters.bin': 'ad361a2552e27c2e081f1b958be8cb96b7b8cdaaf8ded561c52d36b7986f0a40',
  'craters-small-south.bin': '32d3a5c1259e90dcd223965a30fa2bf0e0cba6ba9176ee43ebbd9e02653f6373',
};
let totalBytes = recordBytes + indexBytes.byteLength;
for (const [file, hash] of Object.entries(retained)) {
  const bytes = readFileSync(new URL(file, features));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, `${file}: existing route/polar data is unchanged`);
  assert.equal(bytes.byteLength % 12, 0, `${file}: existing Float32 triple format`);
  let previous = Infinity;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < bytes.byteLength; i += 12) {
    const diameter = view.getFloat32(i + 8, true);
    assert.ok(diameter > 0 && diameter <= previous, `${file}: descending positive diameters`);
    previous = diameter;
  }
  totalBytes += bytes.byteLength;
}
const metadata = new URL('craters.json', features);
totalBytes += statSync(metadata).size;
assert.ok(totalBytes < 25_000_000, 'all crater drawing and retained data stay below 25 MB');
console.log(JSON.stringify({
  result: 'PASS', cases: spots.length, rimPoints: samples,
  screenKeyChecks: 3,
  worstRadiusErrorPercent: worstRadiusFraction * 100, neighbourEdgeChecks: edgeChecks,
  worstNeighbourErrorPx: worstNeighbourPx, drawingRecords: recordCount,
  drawingChunks: files.size, largestChunkBytes: largestChunk,
  totalCraterBytes: totalBytes, retainedDataUnchanged: true,
  drawingIndex: fileURLToPath(new URL('craters-draw/index.json', features)),
}, null, 2));
