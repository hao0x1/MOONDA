# Layer checks, 14 November 2026

The later memory review is in [QA-memory.md](QA-memory.md). It supersedes this
report's eager-decoding memory, startup and switch figures; the source and
visual checks below remain useful evidence of coverage and labels.

The browser runs use the existing Vite server at `http://127.0.0.1:5190`, the
project's `app/scripts/drive.mjs`, a fresh Chrome profile, real Apple Metal GPU,
1440 × 900 CSS pixels and device scale 2. The single-browser lease is held until
Chrome closes in the harness's `finally` block. No new server or build is used.
The ready step allows 280,000 ms.

Scenarios are in `data-prep/layers/qa/before.json` and `after.json`. Results and
screenshots are under:

`/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/L/`

## Timing method

At the south-pole view, the clock starts immediately before the actual checkbox
click. A Cesium post-render callback stops it when a newly shown layer has a
ready imagery texture on one of the rendered globe tiles. This measures the
first painted map frame, not completion of the finest visible detail. The new
vector Craters renderer is checked for its first drawn ring on its canvas.
Each map is switched off before the next measurement.

The baseline snapshot was captured before the new provider wiring. Its real
Sun was on; final proof views switch it off. Session K also changed Craters from
an imagery layer to a vector renderer between snapshots, so that row describes
two different renderers. Other sessions were editing the page during these
runs; the numbers are observations on this device, not a controlled benchmark.
The baseline also logged Vite hot-reload errors from another session's
`Compare.tsx` / `nextPlanIndex` edit. Its existing map remained usable for the
measurements. The final fresh-page run has no such errors.

| Layer | Before (ms) | After (ms) | Result |
| --- | ---: | ---: | --- |
| PSR | 540.0 | 49.4 | Under 250 ms |
| Water ice | 292.9 | 54.7 | Under 250 ms |
| Danger zones | 24.2 | 27.2 | Under 250 ms |
| Slope | 228.0 | 28.2 | Under 250 ms |
| Craters | 128.7 | 411.0 | Session K: new vector renderer needs its own startup warm-up |
| Height colours | 40.9 | 33.4 | Under 250 ms |

The final run has **no console or page errors**, and confirms the exact ten
switch IDs/order and real Sun off. Science-worker retained data was
397,393,048 bytes for all twelve rendered source pictures at startup, rising to
405,781,656 bytes after numeric lookups. Its 512 MiB budget had **zero evictions**.
The browser was closed by the harness; its lease log records release.

The Map layers loading row reached its existing 90-second background limit
while fetching the bulk remote height tiles. All local science pictures had
decoded, all five raster switches painted quickly, and the height parent tiles
were ready. Finer remote height detail can still finish in the background;
this run does not claim that every remote tile was ready before entry.

Spot-value checks through the live `layerValues.ts` service:

| Spot | Slope | PSR | Water prediction/evidence class |
| --- | ---: | ---: | --- |
| Apollo 11, 0.674° N, 23.473° E | 0.75° | No coverage | No model / strong-hydrogen flag |
| North, 89.5° N, 0° | 3.25° | 0% of the sampled cell | 1: predicted under the surface |
| LCROSS, 84.678° S, 48.6937° W | 1.32° | 100% | 2: predicted surface cold trap |

LCROSS's **marker** separately reports its direct measurement. Its underlying
prediction grid is deliberately not relabelled confirmed. PlaceCard still
needs its owner's polar-only display gate removed for the northern/global
values to appear.

## Inspected screenshots

All final views use real Sun off. Eleven screenshots were captured and visually
inspected in `L/after/` beneath the output root above:

| File | Proof |
| --- | --- |
| [layers-en.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/L/after/layers-en.png) | Exact requested order, one Maps group, quiet coverage notes, removed switches absent |
| [layers-km.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/L/after/layers-km.png) | Khmer twin of the same box |
| [whole-moon-slope.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/L/after/whole-moon-slope.png) | Global slope picture |
| [whole-moon-danger.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/L/after/whole-moon-danger.png) | Global warnings and class key |
| [whole-moon-water.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/L/after/whole-moon-water.png) | Global orbital hydrogen with an explicit non-ice label |
| [north-psr.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/L/after/north-psr.png) | North PSR |
| [south-psr.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/L/after/south-psr.png) | Retained sharp southern PSR |
| [north-water-markers.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/L/after/north-water-markers.png) | Northern prediction map, cyan orbital candidates and dashed Bosch |
| [south-water-markers.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/L/after/south-water-markers.png) | Southern prediction map with white/cyan/dashed markers |
| [cabeus-confirmed.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/L/after/cabeus-confirmed.png) | Card says Confirmed: water measured here, at LCROSS coordinates |
| [bosch-predicted.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/L/after/bosch-predicted.png) | Card says Predicted only: cold enough for ice to last |

Machine-readable timing, values, progress states, cache totals and zero-error
evidence are in `L/after/result.json`. Baseline is `L/before/result.json`.

## Files changed for session L

- `app/src/moon/layers.ts`, `app/src/ui/LayersPanel.tsx`, and the English/Khmer
  `layers.ts` dictionaries: switch list, notes and honest keys.
- Science-only additions in `imagery.ts` and `imageryWorker.ts`; `preload.ts`;
  layer wiring only in `MoonMap.tsx`; `science/layerValues.ts`.
- Rerunnable builders, downloaders, checks and source audits under
  `data-prep/layers/`; ice-marker source/generation files under `data-prep/sites/`.
- `app/public/data/layers/` maps, metadata and manifest;
  `app/public/data/features/ice-sites.json`; regenerated `app/src/data/sites.ts`.
- `app/public/data/CREDITS-layers.md` and only the permitted source-table rows
  in README. `places.ts` did not need a hand edit: it already imports the
  generated sites.

Added shipped map data/metadata and the full marker JSON total **30,840,610
bytes** (30.84 MB), plus small manifest/credit text changes. Raw NASA archives
remain in their separate `data-raw/` folders on the SSD and are not shipped.
Original south-pole planner grids, height data and photo behaviour are retained.
No app build, server, commit, push or deployment was performed.

## Reproducible checks

- `cd app && npx tsc -b`
- `cd app && node scripts/check-imagery.ts`
- `cd app && node scripts/check-imagery-runtime.ts`
- `node data-prep/layers/check-science-imagery.ts`
- `.venv-data/bin/python -I data-prep/layers/check_polar_water.py`
- `.venv-data/bin/python -I data-prep/layers/repack_south_terrain.py`

The independent science checks cover both-pole projection, global pixel
alignment at Apollo 11 and the longitude seam, colour-safe class minification,
and replacement of a coarse hazard by known-clear sharp terrain. The polar
checks compare native north PSR samples, retained southern pixels/classes and
hydrogen orientation/quantisation. The danger repack reconstructs every
original RGBA byte exactly. Global source checks, units, bounds, analytical
slopes, crater counts and spot values are in
`app/public/data/layers/global-terrain-report.json`.
