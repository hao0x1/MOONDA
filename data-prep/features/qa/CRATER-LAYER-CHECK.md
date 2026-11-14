# Crater layer check

## Cause

The former layer already used the correct spherical small-circle formula and the
`(x, -z, y)` display rotation. The PDS label declares planetocentric latitude,
positive-east longitude from 0 to 360 degrees and a 1,737,400 m Moon radius. The
old source conversion was correct; diameters were already divided by two.

The large shifts came later: the layer returned an unflipped
`OffscreenCanvas.transferToImageBitmap()` tile. Cesium sets `UNPACK_FLIP_Y_WEBGL`
when uploading a texture, but WebGL ignores that setting for `ImageBitmap`.
The photo worker explicitly reverses rows before making its bitmaps; the old
crater provider did not. Its rings therefore appeared mirrored inside each
display tile, which moves them in both true lunar latitude and longitude.

Separate tile choices also broke rings: each tile stopped after 420 entries,
and parent/child tiles used different size thresholds. Sampling in display
longitude did not account for stretching near the display poles. Finally, the
old global subset omitted most craters smaller than 5 km.

Primary references:

- [WebGL texture upload specification](https://registry.khronos.org/webgl/specs/latest/1.0/#TEXIMAGE2D_HTML).
- [USGS Robbins catalogue](https://astrogeology.usgs.gov/search/map/moon_crater_database_v1_robbins).
- [Official PDS archive](https://pdsimage2.wr.usgs.gov/Individual_Investigations/moon_lro.kaguya_multi_craterdatabase_robbins_2018/).

## Change

`app/src/moon/craterLayer.ts` draws entire spherical rims as vectors over the
view. It uses the same display rotation and ground heights as the photo; the
flat map uses its existing `toScreen` projection. There are no imagery tiles,
texture uploads or per-tile choices in this drawing path. One view chooses at
most 400 whole rims, largest first. Lines are 1.25 CSS pixels, pale, 70% opaque,
with no fill. Paths adapt to their size and shape on screen. Scans and path
preparation yield in small slices, including within a large rim.

`app/src/moon/MoonMap.tsx` only changes the crater creation/switch block.
No new interface controls or translated strings were needed.

`data-prep/features/scripts/build_crater_drawing.py` creates 385 regional/size
chunks from the full official release, with 1,296,796 records. Float32 triples
preserve centres to within 0.23 m, without an extra quantisation step. Drawing
records use 15,561,552 bytes, plus a 206,269-byte index; the largest chunk is
286,404 bytes. Only overlapping regions and relevant size classes are fetched,
with four requests at once and a 10 MiB cache target. The planner's `craters.bin`
and the separate small south-polar catalogue are unchanged by SHA256.

## Maths and data checks

Run `cd app && node scripts/check-crater-layer.ts`.

- 24 named/extreme cases and 17,304 rim points.
- Worst radius error: 8.97e-12%, below the requested 1%.
- 200 shared-edge checks; worst difference: 2.23e-10 pixels.
- Three regression checks for depth-only updates, tiny matrix noise and real camera moves.
- All 1,296,796 drawing records, sorting, size bands and region caps checked.
- All drawing data, index, metadata and retained crater binaries: 17,165,152 bytes.
- Existing route and small south-polar binaries match their original SHA256.

Machine-readable results: `crater-maths.json` in this folder and
`../crater-drawing-check.json`.

## Browser checks

The scripts use the running dev server at `http://127.0.0.1:5190`, one leased
headless Chrome at a time, the real Metal GPU, and a 280000 ms initial readiness
window. The repeatable full run is `node data-prep/features/scripts/check_crater_browser.mjs <output-folder>` from the project root. It ignores Vite updates only in its own page. Each browser closes in the harness's `finally` block. No server or build
was started.

The first run's Firmicus and 300 km images were visually checked. Firmicus follows
the measured rim and the wider view has continuous lines. The 300 km view shows
400 rings and held 60 fps (0 long tasks, 0 frames over 33 ms) during a 3 s idle
measurement. Its initial load logged two generic Cesium `DeveloperError` events;
the map recovered and screenshots were usable. The stable runs below logged no such errors.

The full run logged **zero page errors**. It exposed a further refresh bug: depth
plane changes were counted as camera moves, and a render request could start
another catalogue choice. Those could blank a busy view. The renderer now keys
only screen x/y/w (with tiny numeric noise removed), finishes one drawing at a
time, and keeps selection separate from repainting. Regression checks cover the
camera key. The two affected south-polar views were repeated with the corrected
code and **zero page errors**. Their canvas checks counted 295,699 and 237,819
non-transparent pixels respectively, so an internal ring counter cannot pass a
blank image again.

All twelve proof images below were opened and inspected. Rings follow the
catalogue's measured rims; no systematic shift or straight tile-edge cut is
visible. An independent reviewer also checked the two corrected polar images.
The close view contains 40 rings down to 1.026 km; the wider view contains 400,
with a 3.331 km minimum. The photo in the 30 km view remained coarse while remote
detail loaded; the vector lines and their positions stayed clear.

The full run held 60.00 fps both during the 3 s wide-view idle measurement and
8 s arrival at the close view: p95 16.7 ms, maximum 16.8 ms, no long tasks and no
frames over 100 ms. Every proof view had real sunlight off, 1.25 px lines and at
most 400 rings. The flat-map proof was captured after pressing M; the button
reads 3D because the flat map is active.

Final type check: `cd app && npx tsc -b` passed. No builds, commits, pushes or
deployments were performed. Both final browser runs closed and released their
single-browser lease. Earlier blank/reset images are excluded from proof.

Machine-readable browser results, screenshot hashes and the old bitmap upload
probe are in `crater-browser-report.json` in this folder.

| View | Screenshot |
| --- | --- |
| 01-firmicus | [01-firmicus.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/final/01-firmicus.png) |
| 02-copernicus | [02-copernicus.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/final/02-copernicus.png) |
| 03-tycho | [03-tycho.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/final/03-tycho.png) |
| 04-plato | [04-plato.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/final/04-plato.png) |
| 05-aristarchus | [05-aristarchus.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/final/05-aristarchus.png) |
| 06-tsiolkovskiy | [06-tsiolkovskiy.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/final/06-tsiolkovskiy.png) |
| 07-schrodinger | [07-schrodinger.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/polar-verified/07-schrodinger.png) |
| 08-shackleton | [08-shackleton.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/polar-verified/08-shackleton.png) |
| 09-peary | [09-peary.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/final/09-peary.png) |
| 10-wide-300km | [10-wide-300km.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/final/10-wide-300km.png) |
| 11-small-craters-30km | [11-small-craters-30km.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/final/11-small-craters-30km.png) |
| 12-copernicus-flat-2d | [12-copernicus-flat-2d.png](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/final/12-copernicus-flat-2d.png) |


## Requests for other owners

Update the README's old 113,000-crater description to the full drawing catalogue.
The route planner intentionally keeps its smaller compatible catalogue.

The outlines are the source's circular fits, not newly traced rim polygons.
Degraded, overlapping and irregular craters cannot have an exact circular outline.
The published fit is preserved, including Peary's measured centre near
88.5746 N, 26.2633 E, rather than forcing it to the rounded named target.
