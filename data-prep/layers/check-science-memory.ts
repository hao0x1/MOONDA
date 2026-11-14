// Exercise the real science worker with stored data and browser API stand-ins; no browser or network.
// Run: node data-prep/layers/check-science-memory.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FromWorker, ScienceRasterSource, ToWorker } from '../../app/src/moon/imageryWorker.ts';

const root = new URL('../../', import.meta.url), base = 'http://127.0.0.1:5190/';
const publicRoot = new URL('app/public/', root);
const compact = JSON.parse(readFileSync(new URL('app/public/data/layers/compact-sources.json', root), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('app/public/data/layers/manifest.json', root), 'utf8')) as { id: string; rasterSources?: ScienceRasterSource[] }[];
const source = (layer: string, contains: string): ScienceRasterSource => {
  const s = manifest.find(e => e.id === layer)?.rasterSources?.find(s => s.url.includes(contains));
  if (!s) throw new Error(`No fixture for ${layer}/${contains}`);
  const overlay = compact[s.url] ?? {}, combined = { ...s, ...overlay };
  return { ...combined, url: new URL(s.url, base).href,
    packed: combined.packed && { ...combined.packed, url: new URL(combined.packed.url, base).href },
    preview: combined.preview && { ...combined.preview, url: new URL(combined.preview.url, base).href } };
};
const slope = source('slope', 'global'), northWide = source('psr', 'psr-north.png');
const g = globalThis as unknown as Record<string, unknown>, replies: FromWorker[] = [];
let clock = 1_000_000, offline = false, fetched = 0, id = 100;
const fetchOptions: RequestInit[] = [];
const fetchedUrls: string[] = [], transientFailures = new Map<string, number>();
performance.now = () => clock;
const sweeps: (() => void)[] = [];
g.setInterval = (fn: () => void) => { sweeps.push(fn); return { unref() {} }; };
const stored = new Map<string, Response>();
g.caches = { open: async () => ({ match: async (u: string) => stored.get(u)?.clone(), put: async (u: string, r: Response) => { stored.set(u, r.clone()); } }) };
g.fetch = async (url: string, options: RequestInit = {}) => {
  if (offline) throw new TypeError('Offline fixture');
  fetched++;
  fetchOptions.push(options);
  fetchedUrls.push(url);
  const failuresLeft = transientFailures.get(url) ?? 0;
  if (failuresLeft) { transientFailures.set(url, failuresLeft - 1); throw new Error('Transient science fixture'); }
  const path = new URL(url).pathname.replace(/^\//, '');
  return new Response(readFileSync(fileURLToPath(new URL(path, publicRoot))));
};
g.WorkerGlobalScope = function () {};
g.self = globalThis;
g.postMessage = (message: FromWorker) => replies.push(message);
g.ImageData = class { data: Uint8ClampedArray; width: number; height: number; constructor(data: Uint8ClampedArray, width: number, height: number) { this.data = data; this.width = width; this.height = height; } };
g.createImageBitmap = async (src: { data: Uint8ClampedArray }) => ({ width: 256, height: 256, data: src.data, close() {} });
const W = await import('../../app/src/moon/imageryWorker.ts');
const send = async (message: ToWorker, match: (m: FromWorker) => boolean): Promise<FromWorker> => {
  (g.onmessage as (event: { data: ToWorker }) => void)({ data: message });
  for (let n = 0; n < 10000; n++) {
    const reply = replies.find(match); if (reply) return reply;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Worker fixture timed out');
};
let failed = 0;
const check = (name: string, good: boolean, detail = '') => { console.log(`${good ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!good) failed++; };
const stats = async () => { const requestId = id++; return (await send({ scienceStats: { requestId } }, m => m.scienceRequestId === requestId)).science!; };

const warmId = id++;
const warm = await send({ warmScience: [slope, northWide], warmId }, m => m.warmed === warmId && m.warmFrac === 1);
check('Startup stores compressed files without decoding any source or preview', warm.warmOk === true && warm.science?.decodedBytes === 0 && warm.science?.previewBytes === 0 && warm.science.compressedBytes > 0);
check('Science downloads use their own cache-first native requests', fetchOptions.every(options => options.cache === 'force-cache' && options.signal instanceof AbortSignal));
check('Completed warm-up reports every requested source available', warm.science?.maps.every(map => map.available) === true && warm.science.failedUrls.length === 0);
const worldId = id++;
await send({ id: worldId, flipRows: true, job: { kind: 'science', sources: [slope], level: 0, rect: { west: -Math.PI, east: 0, south: -Math.PI / 2, north: Math.PI / 2 } } }, m => m.id === worldId);
let memory = await stats();
check('The whole Moon uses only the small colour preview', memory.decodedBytes === 0 && memory.previewBytes === 512 * 256 * 4);

const valueId = id++, value = await send({ scienceValue: { source: slope, lat: 0.674, lon: 23.473 }, valueId }, m => m.valueId === valueId);
memory = await stats();
check('A numeric query decodes one source block rather than the whole global map', memory.decodedBytes === 512 * 512 && typeof value.value === 'number', `${memory.decodedBytes} bytes, code ${value.value}`);
const encoded = readFileSync(fileURLToPath(new URL(new URL(slope.packed!.url).pathname.replace(/^\//, ''), publicRoot)));
const width = slope.packed!.width, size = slope.packed!.tileSize!, x = Math.floor((23.473 + 180) / 360 * width), y = Math.floor((90 - 0.674) / 180 * slope.packed!.height);
const block = await W.decodeScienceBlock(encoded, slope.packed!, Math.floor(y / size) * Math.ceil(width / size) + Math.floor(x / size));
check('Worker numeric values equal an independent direct packed-block read', value.value === W.scienceCodeAt(block, y % size * block.w + x % size));

// A cold fine view asks for a few independent blocks; it must never inflate all 32 MiB.
const latitude = -43.31 * Math.PI / 180, longitude = -11.36 * Math.PI / 180;
const displayLon = Math.atan2(-Math.sin(latitude), Math.cos(latitude) * Math.cos(longitude));
const displayLat = Math.asin(Math.cos(latitude) * Math.sin(longitude));
const nx = 512, ny = 256, tx = Math.floor((displayLon + Math.PI) / (2 * Math.PI) * nx), ty = Math.floor((Math.PI / 2 - displayLat) / Math.PI * ny);
const fineId = id++, fineBegan = process.hrtime.bigint();
const fine = await send({ id: fineId, flipRows: true, job: { kind: 'science', sources: [slope], level: 8, rect: { west: tx / nx * 2 * Math.PI - Math.PI, east: (tx + 1) / nx * 2 * Math.PI - Math.PI, north: Math.PI / 2 - ty / ny * Math.PI, south: Math.PI / 2 - (ty + 1) / ny * Math.PI } } }, m => m.id === fineId);
const fineMs = Number(process.hrtime.bigint() - fineBegan) / 1e6;
memory = await stats();
check('A fine map paints from a few source blocks with no full-grid allocation', !!fine.bitmap && !fine.gaps && memory.decodedBytes <= 4 * 512 * 512, `${memory.decodedBytes} bytes, ${fineMs.toFixed(1)} ms CPU fixture`);

const beforeWide = memory.maps.find(m => m.url === northWide.url)!;
const skipId = id++;
await send({ id: skipId, flipRows: true, job: { kind: 'science', sources: [northWide], level: 8, rect: { west: -Math.PI / 2 - 0.01, east: -Math.PI / 2 + 0.01, south: -0.01, north: 0.01 } } }, m => m.id === skipId);
memory = await stats();
const afterWide = memory.maps.find(m => m.url === northWide.url)!;
check('A wide 65–80° map is skipped before decoding at the inner pole', beforeWide.decodedBytes === afterWide.decodedBytes && afterWide.previewBytes === 0);

const compressed = memory.compressedBytes;
clock += 121000; for (const sweep of sweeps) sweep();
memory = await stats();
check('The idle sweep releases inactive decoded blocks and previews without a render request', memory.decodedBytes === 0 && memory.previewBytes === 0 && memory.compressedBytes === compressed);
const trimId = id++;
await send({ scienceTrim: { dropAll: true, dropCompressed: true }, scienceRequestId: trimId }, m => m.scienceRequestId === trimId);
check('Explicit trim reports no retained science bytes', (await stats()).compressedBytes === 0);
offline = true;
const fetchBefore = fetched, offlineId = id++;
const offlineValue = await send({ scienceValue: { source: slope, lat: 0.674, lon: 23.473 }, valueId: offlineId }, m => m.valueId === offlineId);
check('The compressed file works offline from CacheStorage after memory is dropped', offlineValue.value === value.value && fetched === fetchBefore);
offline = false;
const retryUrl = `${northWide.packed!.url}?fixture=retry`, afterUrl = `${northWide.packed!.url}?fixture=after`, retryWarmId = id++;
const retrySource = { ...northWide, url: `${base}data/layers/retry-science-map.png`, packed: { ...northWide.packed!, url: retryUrl } };
const afterSource = { ...northWide, url: `${base}data/layers/after-science-map.png`, packed: { ...northWide.packed!, url: afterUrl } };
transientFailures.set(retryUrl, 1);
const retryBegan = fetchedUrls.length;
const retried = await send({ warmScience: [retrySource, afterSource], warmId: retryWarmId }, m => m.warmed === retryWarmId && m.warmFrac === 1);
const retryOrder = fetchedUrls.slice(retryBegan).filter(url => url === retryUrl || url === afterUrl);
check('Warm-up retries a missing file only after the other sources finish', retryOrder.join('|') === [retryUrl, afterUrl, retryUrl].join('|'));
check('The final warm acknowledgement waits for retry success and clears its error', retried.warmOk === true && retried.science?.maps.find(map => map.url === retrySource.url)?.available === true && !retried.science.failureReasons[retryUrl]);
const missingUrl = `${base}data/layers/compact/no-such-science-file.deflate`, missingWarmId = id++;
const missingSource = { ...slope, url: `${base}data/layers/no-such-science-map.png`, packed: { ...slope.packed!, url: missingUrl } };
const missingBegan = fetchedUrls.length;
const failedWarm = await send({ warmScience: [missingSource], warmId: missingWarmId }, m => m.warmed === missingWarmId && m.warmFrac === 1);
check('A failed source keeps warm-up incomplete and reports its exact URL', failedWarm.warmOk === false && failedWarm.science?.failedUrls.includes(missingUrl) === true && failedWarm.science.maps.find(map => map.url === missingSource.url)?.available === false);
check('A permanent failure has one retry and preserves its diagnostic reason', fetchedUrls.slice(missingBegan).filter(url => url === missingUrl).length === 2 && failedWarm.science?.failureReasons[missingUrl].includes('ENOENT') === true);
if (failed) process.exitCode = 1;
else console.log('All science memory checks passed.');
