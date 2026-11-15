// Turn the raw drive artifacts into a table without treating missing pixels as fast loading.
// node scripts/check-layer-report.mjs --out <the check-layer-speed evidence directory>
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const args = process.argv.slice(2);
const flag = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const out = resolve(flag('--out', join(tmpdir(), 'moonda-layer-speed')));
const labels = { before: flag('--before-label', 'before'), after: flag('--after-label', 'after') };
const views = ['whole', 'pole', 'flat', 'mid', 'rim'];
const layers = ['psr', 'waterice', 'danger', 'slope', 'craters', 'height'];
const names = { whole: 'Whole Moon globe', pole: 'South Pole globe', flat: 'Overview 2D', mid: 'Surface -26.46, 11.85', rim: 'Surface -89.79, -154.3' };
const load = file => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
const median = values => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
const around = (samples, at, windowMs, field = 'bytes') => at ? median(samples.filter(x => x.at >= at - windowMs && x.at <= at && x.processes > 0).map(x => x[field])) : null;
const mib = value => value === null || value === undefined ? 'unverified' : (value / 2 ** 20).toFixed(1);
const number = value => value === null || value === undefined ? 'unverified' : Math.round(value).toLocaleString('en-US');
const change = (after, before) => Number.isFinite(after) && Number.isFinite(before) ? after - before : null;
const counterDelta = (before, after) => {
  if (!before || !after) return null;
  const result = {};
  for (const [key, value] of Object.entries(after)) {
    if (typeof value === 'number' && typeof before[key] === 'number' && !/^(last|max|slowest|budget)/i.test(key)) result[key] = value - before[key];
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = counterDelta(before[key], value); if (nested && Object.keys(nested).length) result[key] = nested;
    }
  }
  return result;
};
const table = [], startup = [], causes = [], stages = [], sessions = [];
const get = (label, phase, view) => {
  const folder = join(out, `${label}-${phase}-${view}`), state = load(join(folder, 'run-state.json'));
  const resultFile = join(folder, 'result.json');
  const raw = state && (state.status !== 'complete' || !existsSync(resultFile) || statSync(resultFile).mtimeMs < state.startedAt) ? null : load(resultFile);
  if (!raw) return { folder, raw: null, rows: new Map(), memory: null };
  const memory = load(join(folder, 'memory-rss.json')) ?? [];
  const lease = load(join(folder, 'browser-lease.json'));
  const began = lease?.notes.find(x => x.event === 'requested');
  const acquired = lease?.notes.find(x => x.event === 'acquired');
  const attempts = load(join(folder, 'lease-attempts.json')) ?? [];
  const chromeAuditAvailable = memory.some(sample => Array.isArray(sample.otherHeadlessPids));
  const concurrentSamples = memory.filter(sample => sample.otherHeadlessPids?.length > 0);
  const concurrentOtherChromeSamples = chromeAuditAvailable ? concurrentSamples.length : null;
  const concurrentOtherChromePids = [...new Set(concurrentSamples.flatMap(sample => sample.otherHeadlessPids))];
  const errors = (raw.steps ?? []).filter(x => x.note?.startsWith('ERROR:')).map(x => x.note);
  const valid = !!raw.evals?.startup && !!raw.evals?.view;
  const rows = new Map(Object.values(valid ? raw.evals ?? {} : {}).filter(row => row && typeof row === 'object' && row.layer && row.pass).map(row => [`${row.layer}-${row.pass}`, { ...row, concurrentOtherChromeSamples }]));
  sessions.push({ label, phase, view, valid, artifact: join(folder, 'result.json'), waitingMs: attempts.length ? attempts.reduce((total, attempt) => total + (attempt.waitMs ?? 0), 0) : began && acquired ? Date.parse(acquired.at) - Date.parse(began.at) : null, attempts,
    leaseWaitReasons: lease?.notes.filter(x => x.event === 'waiting').map(x => x.reason) ?? [],
    chromeAuditAvailable, concurrentOtherChromeSamples, concurrentOtherChromePids, timingMayBeInflated: concurrentOtherChromeSamples > 0,
    leaseReleased: !!lease?.notes.some(x => x.event === 'released'), errors, frozenHmr: raw.evals?.startup?.frozenHmr ?? null,
    frozenModules: raw.evals?.startup?.frozenModules ?? [], warmState: { startup: { layerWarm: raw.evals?.startup?.layerWarm ?? null, poleHeightWarm: raw.evals?.startup?.poleHeightWarm ?? null }, view: { layerWarm: raw.evals?.view?.layerWarm ?? null, poleHeightWarm: raw.evals?.view?.poleHeightWarm ?? null }, steady: { layerWarm: raw.evals?.steady?.layerWarm ?? null, poleHeightWarm: raw.evals?.steady?.poleHeightWarm ?? null } }, gpu: raw.gpu });
  return { folder, raw: valid ? raw : null, rows, memory: valid ? memory : null };
};
const runs = {};
for (const [side, label] of Object.entries(labels)) for (const view of views) {
  const run = runs[`${side}-${view}`] = get(label, 'warm', view);
  const start = run.raw?.evals?.startup, steady = run.raw?.evals?.steady;
  const record = { side, view, baseWaitMs: run.raw?.evals?.view?.base?.baseWaitMs ?? null, baseReady: run.raw?.evals?.view?.base?.baseReady ?? null, startupMs: start?.ms ?? null, startupMainHeapBytes: start?.heap ?? null, steadyMainHeapBytes: steady?.heap ?? null,
    startupRssBytes: around(run.memory ?? [], start?.at, 1500), steadyRssBytes: around(run.memory ?? [], steady?.at, 3000),
    startupFootprintBytes: around(run.memory ?? [], start?.at, 1500, 'footprintBytes'), steadyFootprintBytes: around(run.memory ?? [], steady?.at, 3000, 'footprintBytes'),
    source: run.raw ? join(run.folder, 'result.json') : null };
  startup.push(record);
  for (const stage of start?.progress?.stages ?? []) stages.push({ side, view, id: stage.id, state: stage.state, ms: stage.ms ?? null });
  for (const row of run.rows.values()) {
    const before = row.before, after = row.after;
    const flatIds = row.layer === 'height' ? ['height', 'heightPolar'] : [row.layer];
    const flat = Object.fromEntries(flatIds.map(id => [id, counterDelta(before?.flat?.overlays?.[id]?.timings, after?.flat?.overlays?.[id]?.timings)]).filter(([, value]) => value));
    causes.push({ side, view, layer: row.layer, pass: row.pass, firstMs: row.firstMs, settledMs: row.settledMs,
      baselineUnsettled: row.baselineUnsettled ?? null, warmState: { before: { layerWarm: before?.layerWarm ?? null, poleHeightWarm: before?.poleHeightWarm ?? null }, after: { layerWarm: after?.layerWarm ?? null, poleHeightWarm: after?.poleHeightWarm ?? null } },
      worker: counterDelta(before?.science?.worker?.timing, after?.science?.worker?.timing),
      sourceCache: counterDelta(before?.science?.worker?.cache, after?.science?.worker?.cache),
      projectedCache: counterDelta(before?.science?.preparedCache, after?.science?.preparedCache),
      surfacePipeline: counterDelta(before?.surface?.imagery?.sciencePipeline, after?.surface?.imagery?.sciencePipeline),
      flat, imagery: counterDelta(before?.imagery, after?.imagery) });
  }
}
function status(row, view, layer) {
  if ((view === 'mid' || view === 'rim') && layer === 'craters' || row?.unsupported) return { state: 'unsupported', firstMs: null, settledMs: null, note: 'MapEngine has no Craters drawing path' };
  if (!row) return { state: 'unverified', firstMs: null, settledMs: null, note: 'No completed measurement artifact' };
  const flags = [];
  if (row.concurrentOtherChromeSamples > 0) flags.push('another headless Chrome ran concurrently; timings may be inflated');
  if (row.baselineUnsettled) flags.push('base imagery still pending');
  if (!row.sampling) flags.push('earlier RGB-only sampler');
  if (view === 'flat' && row.sampling?.flatUiIncluded !== true) flags.push('flat UI markers/labels excluded; whole-picture settling unverified');
  if (view === 'flat' && layer !== 'craters' && row.sampling?.flatUiIncluded === true && row.sampling?.firstSampling !== 'GLlayercolour') flags.push('flat first-pixel sampler included unrelated UI; raster arrival unverified');
  if (row.firstMs === null || row.firstMs === undefined) return { state: row.timedOut ? 'pending' : 'no-change', firstMs: null, settledMs: null, observationMs: row.observationMs,
    note: ['No layer pixels detected', ...flags].join('; '), flags };
  return { state: row.timedOut ? 'pending' : 'measured', firstMs: row.firstMs, settledMs: row.settledMs, observationMs: row.observationMs,
    targets: { first: view === 'flat' && layer !== 'craters' && row.sampling?.flatUiIncluded === true && row.sampling?.firstSampling !== 'GLlayercolour' ? null : row.pass === 'second' ? row.firstMs <= 100 : row.firstMs <= 150, settled: row.baselineUnsettled || view === 'flat' && row.sampling?.flatUiIncluded !== true ? null : row.settledMs !== null && row.settledMs <= (row.pass === 'second' ? 100 : 600) },
    note: flags.join('; '), flags, sampledPixels: row.layerChangedPixels ?? row.changedPixels };
}
for (const view of views) for (const layer of layers) {
  const record = { view, layer };
  for (const side of ['before', 'after']) for (const pass of ['warm', 'second']) record[`${side}-${pass}`] = status(runs[`${side}-${view}`].rows.get(`${layer}-${pass}`), view, layer);
  for (const [side, label] of Object.entries(labels)) {
    const agedFile = join(out, `${label}-aged-${view}`, 'result.json');
    const agedRaw = load(agedFile);
    const agedRow = Object.values(agedRaw?.evals?.startup && agedRaw?.evals?.view ? agedRaw.evals : {}).find(row => row?.layer === layer && row?.pass === 'aged');
    record[`${side}-aged`] = agedRow ? status(agedRow, view, layer) : { state: 'unverified', note: 'Real two-minute-use test has no completed artifact' };
  }
  table.push(record);
}
const startupComparisons = views.map(view => {
  const before = startup.find(x => x.side === 'before' && x.view === view), after = startup.find(x => x.side === 'after' && x.view === view);
  return { view, before, after, delta: { startupMs: change(after.startupMs, before.startupMs), steadyMainHeapBytes: change(after.steadyMainHeapBytes, before.steadyMainHeapBytes),
    startupRssBytes: change(after.startupRssBytes, before.startupRssBytes), steadyRssBytes: change(after.steadyRssBytes, before.steadyRssBytes), startupFootprintBytes: change(after.startupFootprintBytes, before.startupFootprintBytes), steadyFootprintBytes: change(after.steadyFootprintBytes, before.steadyFootprintBytes) } };
});
const cell = value => {
  if (value.state === 'unverified' || value.state === 'unsupported') return value.state;
  if (value.state === 'no-change') return `no pixels (${number(value.observationMs)} ms)`;
  if (value.state === 'pending' && value.firstMs === null) return `>${number(value.observationMs)} / pending`;
  return `${number(value.firstMs)} / ${value.settledMs === null || value.settledMs === undefined ? `>${number(value.observationMs)}` : number(value.settledMs)}${value.state === 'pending' ? ' pending' : ''}${value.flags?.length ? ' *' : ''}`;
};
const lines = [
  '# Layer timing measurements', '',
  'Times are milliseconds, shown as first layer pixels / last changing frame. Settled time is the final change, verified by a later quiet observation window. Blank or missing data is never counted as a fast draw.', '',
  '| View | Layer | Before warm | After warm | Before second | After second | Before aged | After aged |',
  '|---|---|---:|---:|---:|---:|---|---|',
  ...table.map(row => `| ${names[row.view]} | ${row.layer} | ${cell(row['before-warm'])} | ${cell(row['after-warm'])} | ${cell(row['before-second'])} | ${cell(row['after-second'])} | ${cell(row['before-aged'])} | ${cell(row['after-aged'])} |`), '',
  '* Asterisk: inspect timings.json flags. Earlier runs used RGB-only changes; current runs require chromatic layer changes, and measure Craters from its own overlay. First-pixel detection samples the map canvas at 512 x 256 and requires at least three changing samples; it can miss an earlier isolated physical pixel. Current flat-map runs detect first science pixels from the GL raster and compose GL plus UI for settling. This adds one 512 x 256 pixel readback per flat frame, equally in before and after runs. Older flat runs with UI in the first-pixel sample cannot prove raster arrival; older runs without UI cannot prove whole-picture settling. DOM panels, labels and icons are not subtracted from the canvas sample, so a sparse early pixel may be covered in the composited screen. This is a canvas visibility measurement, not proof of the first unobscured display pixel. A pending base photo is recorded and can affect whole-picture settling.', '',
  'Water ice also toggles ice-place billboards and labels. moon/labels.ts sets FADE_S = 0.25 and advances their alpha over that duration, so a second toggle can keep changing for about 250 ms even with zero imagery jobs. Meeting a strict 100 ms whole-picture second-toggle target requires a lead change in that protected file: apply the ice visibility switch immediately to icon and text alpha while retaining ordinary navigation/collision fades.', '',
  '## Startup and memory', '',
  'Single-run RSS deltas are noisy and cannot by themselves prove memory growth caused by the patch. Renderer/GPU allocations, cache state and garbage collection can vary. Chrome RSS is the sum across that browser process tree. Shared memory can be counted more than once; it is a comparison measure, not an exact GPU allocation count. Startup RSS uses the median over the last 1.5 seconds before startup finished; steady RSS uses the final 3 seconds before the steady snapshot. Heap figures cover the main renderer only.', '',
  '| View | Startup before / after / delta ms | Steady main heap before / after / delta MiB | Startup RSS before / after / delta MiB | Steady RSS before / after / delta MiB |',
  '|---|---:|---:|---:|---:|',
  ...startupComparisons.map(x => `| ${names[x.view]} | ${number(x.before.startupMs)} / ${number(x.after.startupMs)} / ${number(x.delta.startupMs)} | ${mib(x.before.steadyMainHeapBytes)} / ${mib(x.after.steadyMainHeapBytes)} / ${mib(x.delta.steadyMainHeapBytes)} | ${mib(x.before.startupRssBytes)} / ${mib(x.after.startupRssBytes)} / ${mib(x.delta.startupRssBytes)} | ${mib(x.before.steadyRssBytes)} / ${mib(x.after.steadyRssBytes)} / ${mib(x.delta.steadyRssBytes)} |`), '',
  '## Darwin physical footprint', '',
  'When --memory-helper is supplied, proc_pid_rusage reports physical footprint, including compressed pages, for each Chrome process. The sum can count shared resources more than once; paired runs remain an estimate rather than an exact GPU allocation measurement. Incomplete process queries are excluded.', '',
  '| View | Startup footprint before / after / delta MiB | Steady footprint before / after / delta MiB |', '|---|---:|---:|',
  ...startupComparisons.map(x => `| ${names[x.view]} | ${mib(x.before.startupFootprintBytes)} / ${mib(x.after.startupFootprintBytes)} / ${mib(x.delta.startupFootprintBytes)} | ${mib(x.before.steadyFootprintBytes)} / ${mib(x.after.steadyFootprintBytes)} / ${mib(x.delta.steadyFootprintBytes)} |`), '',
  '## Surface photo baseline', '', '| Run | View | Wait ms | Base ready |', '|---|---|---:|---|',
  ...startup.filter(x => x.view === 'mid' || x.view === 'rim').map(x => `| ${x.side} | ${names[x.view]} | ${number(x.baseWaitMs)} | ${x.baseReady === null ? 'unverified' : x.baseReady ? 'yes' : 'no'} |`), '',
  'Only surface views wait for photo work to remain quiet for 400 ms, then another 250 ms for GPU fades. The layer stopwatch starts afterwards. Globe tests retain the original timing and can still reveal unfinished startup warming.', '',
  '## Loader stages', '', '| Run | View | Stage | State | ms |', '|---|---|---|---|---:|',
  ...stages.map(x => `| ${x.side} | ${names[x.view]} | ${x.id} | ${x.state} | ${number(x.ms)} |`), '',
  '## Browser isolation', '', '| Run | View | Valid startup/view | Lease wait ms | HMR frozen | Captured layer modules | Other Chrome samples | Released |', '|---|---|---|---:|---|---:|---:|---|',
  ...sessions.map(x => `| ${x.label}-${x.phase} | ${names[x.view]} | ${x.valid ? 'yes' : 'no - rows discarded'} | ${number(x.waitingMs)} | ${String(x.frozenHmr)} | ${x.frozenModules.length} | ${x.concurrentOtherChromeSamples === null ? 'unavailable' : x.concurrentOtherChromeSamples} | ${x.leaseReleased ? 'yes' : 'no'} |`), '',
  'The optional mid-run audit samples other headless Chrome main processes every 500 ms while this browser runs. Any concurrent samples flag potentially inflated GPU timings; zero observed samples cannot rule out a shorter overlap. Older runs without this field have an unavailable audit, even when launch-time isolation passed.', '',
  'Raw per-toggle source/decode/queue/composite timing and cache counter differences are in timings.json under causes. Missing telemetry is null. Summed worker stage time can exceed wall time when jobs overlap; do not add it to the pixel timing.', '',
];
const result = { generatedAt: new Date().toISOString(), units: 'milliseconds and bytes', labels, table, startup: startupComparisons, stages, sessions, causes,
  agedVerified: table.every(row => row['before-aged'].state !== 'unverified' && row['after-aged'].state !== 'unverified') };
writeFileSync(join(out, 'timings.json'), JSON.stringify(result, null, 2));
writeFileSync(join(out, 'timings.md'), lines.join('\n'));
console.log(JSON.stringify({ rows: table.length, completedSessions: sessions.filter(session => session.valid).length, invalidSessions: sessions.filter(session => !session.valid).length, sourceTelemetryRows: causes.length, agedVerified: result.agedVerified, markdown: join(out, 'timings.md'), json: join(out, 'timings.json') }));
