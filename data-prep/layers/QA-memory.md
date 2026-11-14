# Layer memory and startup review, 14 November 2026

The compact maps meet the requested memory and first-switch targets on this
machine. No science map stays decoded at startup. All six first painted in
18–92 ms, without a decoded-map exception. Coverage, science classes, markers,
keys and the English/Khmer Layers box from [QA.md](QA.md) are retained.

## What is stored

The twelve rendered sources now use compressed, independently readable
512 × 512 blocks. PSR keeps one-byte percentages; slope and hydrogen keep
one-byte values; danger and predicted water keep two-bit classes. The worker
applies their colour tables per tile. Height keeps exact RGB colours. It does
not inflate a full PNG into RGBA or retain full colour mip chains. Small
averaged colour previews preserve mixtures of classes and coverage at distant
zooms. Fine requests await the needed compact blocks in the worker.

| Map | Previous decoded bases and mipmaps (bytes) | All compact bases if fully held (bytes) | Downloaded blocks and previews (bytes) |
| --- | ---: | ---: | ---: |
| PSR | 89,477,120 | 67,108,864 | 3,251,621 |
| Water ice | 78,636,184 | 8,647,808 | 859,353 |
| Danger zones | 117,436,416 | 12,582,912 | 5,917,247 |
| Slope | 95,067,136 | 37,748,736 | 24,934,320 |
| Height colours | 16,776,192 | 12,582,912 | 7,298,519 |
| Total | 397,393,048 | 138,671,232 | 42,261,060 |

The full compact-base column describes the format, not actual retention.
Decoded blocks share a hard **64 MiB** LRU limit; small previews share
**12 MiB**. Inactive decoded blocks/previews expire after **120 seconds**,
checked every 20 seconds even without a render request. Main-thread prepared
tile bitmaps share **4 MiB**, with safe closing after their borrowers finish.
Legacy numeric grids share **16 MiB** and expire after two minutes. Hashes in
file names prevent stale compressed data from being reused after an update.

Only downloaded bytes remain for unused maps. Six extra numeric files add
1,151,846 bytes, so the startup download is **43,412,906 bytes**. This is larger
than the earlier 30.84 MB *added-data* figure because it includes pre-existing
southern height/slope and the numeric files. Total added shipped assets remain
**50.22 MB**, below 60 MB; see [NOTES-compact.md](NOTES-compact.md).

## Measured memory

All figures below use decimal MB. The final fresh-profile run is
`L/memory-final-proof/result.json` under the evidence root below. Worker V8
heap and ArrayBuffer backing storage were measured separately with Chrome
DevTools after requesting garbage collection. The science worker is selected
by its non-empty compressed cache; the photo workers expose the same diagnostic
function with empty science caches.

| Measurement | Previous | After: all maps off at startup | After: all six on, selected spot |
| --- | ---: | ---: | ---: |
| Science retained map arrays | 397.393 MB, decoded | 43.413 MB, compressed only | 121.264 MB, compressed + blocks + previews |
| Science worker V8 heap | 0.777 MB in partial repeat described below | 0.827 MB | 2.475 MB |
| Science worker backing storage | 322.892 MB in partial repeat | 47.263 MB | 137.435 MB |
| Managed map total, including tile bitmaps, spot grids and Craters reserve | At least the 397.393 MB science arrays | **72.661 MB** | **171.846 MB** |
| Conservative total using actual worker heap/backing instead of source counters | Partial baseline only | **77.338 MB** | **190.492 MB** |

The managed total includes Session K's reported Craters canvas/chunk/index and
work reserve: 29.248 MB at startup, 29.611 MB at the selected spot. It includes
4.194 MB of prepared bitmaps and 16.777 MB of legacy spot grids when in use.
Worker backing storage already includes the source arrays, so it is never
added to those arrays a second time. Scratch space and pending work explain
the difference between source counters and backing storage.

At the south view with all six on the managed total was 153.615 MB; at the
whole-Moon view it was 154.860 MB. Both startup totals are below 120 MB and all
observed all-on totals are below 220 MB. These are **map-pipeline** figures,
not whole-tab RAM: always-on photos, terrain, the planner, browser overhead
and GPU-driver allocations are outside this session's memory total. Photo
code and its existing budgets were not changed.

The accepted earlier full run recorded exactly 397,393,048 decoded bytes.
For an independent worker-heap repeat, frozen copies of the old worker were
run in a minimal page. Eleven of twelve old PNGs decoded; the large original
global slope PNG failed, so that repeat retained 319,102,104 bytes, with
776,988 bytes of V8 heap and 322,892,312 bytes of backing storage. It is **not**
a measured full-baseline heap. Its raw result is
`L/memory-before-worker-full/result.json`; the earlier full-cache proof is
`L/after/result.json`. A full-page baseline retry timed out during concurrent
edits, and was not counted as passing evidence.

## First-switch and startup timing

The clock starts immediately before the real checkbox click and stops on the
first Cesium post-render frame with that layer's ready texture; Craters stops
at its first drawn rings. This measures first visible paint, not completion
of the finest visible detail. Decoded map caches and prepared bitmaps are
empty before the first switch. Downloads are already stored as requested.
Each map is then switched off before measuring the next.

| Map | Previous eager-decoded version (ms) | Compact first switch (ms) |
| --- | ---: | ---: |
| PSR | 49.4 | **91.6** |
| Water ice | 54.7 | **76.9** |
| Danger zones | 27.2 | **46.3** |
| Slope | 28.2 | **50.3** |
| Craters | 411.0 | **17.6** |
| Height colours | 33.4 | **25.2** |

None needs to remain decoded at startup. Session K independently improved
Craters' startup preparation; this session did not edit its renderer or data.
Other sessions were working on the same machine, so these are device
observations, not a controlled benchmark. A preceding complete run measured
80.2, 71.1, 44.9, 49.9, 21.3 and 72.7 ms respectively, also below 250 ms.

The **Map layers** row took **7,172 ms cold** in a fresh browser profile and
**560 ms warm** on a second visit in that profile. It awaited downloads only:
43,412,906 compressed bytes, no missing files, **zero decoded blocks and zero
decoded previews** at both startup snapshots. It no longer fetches the bulk
128 remote height tiles or prepares science-provider roots before entry.
Other startup work ran in parallel; total ready was 19,236 ms cold and
10,920 ms warm. This row added no decode gate to Enter.

## Offline and checks

**Offline:** stored science maps redraw and northern spot values work with the
network off after one online visit. The browser test disabled the network,
cleared both decoded maps and their RAM compressed cache, and then redrew from
CacheStorage. It moved to the north pole and independently queried 89.5° N,
0°: slope **3.25°**, PSR **0%**, predicted water class **1**. No science-file
failure or page error occurred. This tests the visited open page and stored
maps; it does not claim an offline app-shell relaunch or uncached remote
height detail.

**Imagery:** `cd app && node scripts/check-imagery.ts` passes. Its recorded
output is `L/memory-verified/check-imagery.txt`. An initial run during five
parallel checks and a browser exceeded its photo CPU timing threshold; the
isolated rerun passed without a code change.

Also passed:

- `cd app && npx --no-install tsc -b`.
- `node data-prep/layers/check-science-memory.ts`: real worker with browser API
  stand-ins; no startup decoding, bounded block reads, idle expiry without
  render requests, offline CacheStorage, retry and failure reporting.
- `node data-prep/layers/check-science-imagery.ts`: projections, packed bits,
  palette mixtures, bounds, fine-vs-preview selection and cache eviction.
- `.venv-data/bin/python -I data-prep/layers/check_compact_layers.py`: all
  **18 products / 820 blocks** reconstructed exactly; hashes and previews pass.
- Scoped `git diff --check`.

## Evidence and scope

Evidence root:
`/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/`

The reproducible runner is `data-prep/layers/qa/memory-run.mjs`. It uses the
existing 5190 server, one leased headless Chrome with the real Metal GPU,
1440 × 900 CSS pixels, scale 2 and a 280,000 ms ready limit. Only that benchmark
page suppresses Vite hot-reload messages while other sessions edit. Six
screenshots were taken in the final run, all with real Sun off, and inspected:

| File under `L/memory-final-proof/` | Check |
| --- | --- |
| `all-on.png` | Six maps on at the south pole; sharp shadow and water detail remains |
| `all-on-world.png` | All six on at the whole Moon |
| `mid-slope.png` | Global slope at intermediate zoom, with visible crater detail |
| `mid-danger.png` | Global warning classes at intermediate zoom |
| `offline.png` | Redraw after dropping RAM maps with network off |
| `offline-north.png` | North coverage and water markers after the offline move |

The `*-review.png` files are 1440-pixel review copies of the originals, not
extra captures. `result.json` records timings, heaps, per-source arrays,
startup rows, offline values and **zero page/console errors**. The lease log
records browser closure. Temporary profiles were removed only after their
Chrome processes exited.

This follow-up changed science-map parts of `imagery.ts` and
`imageryWorker.ts`, `preload.ts`, the layer wiring in `MoonMap.tsx`,
`layerValues.ts`, packed layer assets/manifest, rebuild/check/QA files under
`data-prep/layers/`, and the layer credits. The box, translations, data sources,
markers and planner binary formats are retained. No browser, profile process
or server from this session is left running. No app build, commit, push or
deployment was performed.

## Requests for other owners

No new code request is needed for this memory follow-up. The existing card,
translation and 2D coverage requests remain listed in [NOTES.md](NOTES.md).
