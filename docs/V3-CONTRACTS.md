# MOONDA v3 — module contracts (for parallel builders)

App: `/Volumes/CodexWork/Projects/MOONDA/app` (React 19 + TypeScript 7 + Vite 8 + CesiumJS 1.147). Read
`/Volumes/CodexWork/Projects/MOONDA/README.md` for what the product is. A Vite dev server is ALREADY running at
http://127.0.0.1:5190 — do not start/stop servers, do not run `npm run build`.

## Why v3

The user (a student, NASA Space Apps team) tested v2 on a MacBook and said: navigation isn't smooth like Google
Earth, the lander first-person view shows big blocky artifacts and sometimes the camera is inside a mountain,
labels should fade in/out like Google Earth, the Sun/lighting should be realistic and checkable, Compare needs
to be better. Root cause of most visual problems: Cesium's lon/lat tiling squeezes tiles into slivers at the
globe's poles, and our mission area is the lunar SOUTH POLE.

## The display frame (already written, tested — DO NOT EDIT)

`src/moon/frame.ts`: we rotate the Moon inside Cesium so the true south pole sits on Cesium's equator.
`display = (x, -z, y)`, `true = (x, z, -y)`. Every Cesium world position, every tile rectangle and every
lat/lon that Cesium gives you is in the DISPLAY frame. All science data (names, LOLA heights, polar rasters,
Moon Trek tiles, ephemeris vectors) is in the TRUE frame. Use the helpers:
`toCartesian(trueLat, trueLon, h)`, `toTrueLatLon(cartesian)`, `displayToTrueLatLon(dLatRad, dLonRad)`,
`trueToDisplayLatLon`, `trueToDisplayVec`, `displayToTrueVec`, `trueENU(lat, lon)` (true east/north/up as display
vectors), `azimuthOf(dir, lat, lon)`, `directionFor(az, el, lat, lon)`, `polarMapFromDisplayUnit(X,Y,Z)`,
`TRUE_NORTH_DISPLAY`, `MOON_R` (1,737,400 m). Check: `node scripts/check-frame.ts`.

Other shared code you may READ (and import) but not edit unless your brief says so:
`src/science/heights.ts` (`MoonHeights`: `heightAt(lat, lon, detail)`, `heightAtUnit`, `loadTiles`, `loadTilesAround`,
`ready`, `toMap`), `src/science/ephemeris.ts`, `src/moon/ellipsoid.ts` (`MOON_ELLIPSOID`), `src/moon/layers.ts`,
`src/data/*`, `src/ui/stores.ts`, `src/styles.css` (append-only, prefix your selectors).

## Rules for every builder

- Own ONLY the files listed in your brief. Other builders are editing other files at the same time.
- TypeScript: `erasableSyntaxOnly` (no constructor parameter properties, no enums, no namespaces),
  `noUnusedLocals`/`noUnusedParameters`. Type-check with `cd app && npx tsc -p tsconfig.app.json --noEmit` and fix
  errors in YOUR files only (others may be mid-edit).
- Inside `src/science/` imports use explicit `.ts` extensions (node runs those files directly). Elsewhere, no extension.
- Node can run `.ts` scripts directly (`node scripts/x.ts`, type stripping). Put any test scripts in `app/scripts/`.
- Cesium lessons already learned here: imagery providers must have `minimumLevel = 0` (a higher minimum makes the
  globe wait for thousands of tiles); `requestImage` may return a Promise of `HTMLCanvasElement | ImageBitmap`, or
  `undefined` to mean "throttled, ask again"; entity billboards with PNG data-URL images did NOT render in this
  setup (SVG data URLs did) — prefer SVG or HTML overlays; never import Cesium from a second URL/module instance.
- Scene uses `requestRenderMode: true`: after changing anything visible call `viewer.scene.requestRender()`.
- Plain English comments explaining WHAT/WHY for a student team. No dead code, no placeholder data, never fake science.
- Performance target: 60 fps on an Apple M5 MacBook at 2x device pixel ratio; keep heavy work off the main thread.

## Modules

### A. Imagery — owns `src/moon/imagery.ts`, `src/moon/imageryWorker.ts` (new), may delete `src/moon/polarImagery.ts` at the end
Export factory functions returning Cesium-compatible custom imagery providers in the DISPLAY frame
(tilingScheme = `new GeographicTilingScheme({ ellipsoid: MOON_ELLIPSOID })`, tile 256x256, minimumLevel 0):
- `createMoonTrekProvider({ layer, ext, maxSourceLevel, minTrueLat?, credit })` — reprojects NASA Moon Trek
  true-geographic WMTS tiles `https://trek.nasa.gov/tiles/Moon/EQ/{layer}/1.0.0/default/default028mm/{z}/{y}/{x}.{ext}`
  (level 0 = 2x1 tiles of 256 px, row 0 at 90°N, col 0 at 180°W) into display tiles. Pixels with true latitude
  below `minTrueLat` are transparent (polar layers cover them). Used for: photo `LRO_WAC_Mosaic_Global_303ppd_v02` (jpg,
  max 8) and height colours `LRO_LOLA_ClrShade_Global_256ppd_v06` (png, max 7).
- `createPolarRasterProvider({ url, extentM, credit, clipTrueLatDeg?, maximumLevel? })` — local south-polar-
  stereographic picture (x = rho·sin(lon), y = rho·cos(lon), extent ±extentM, row 0 = +y) draped in display frame.
  Used for `./data/polar/photo4096.jpg` (grey photo, ±304000 m) and `./data/layers/<id>.png` (RGBA science maps).
- `createPolarPyramidProvider({ layers, minK, credit })` — sharp polar photo tiles from ASU Lunaserv WMS
  (`https://wms{,1..7}.im-ldi.com/?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&STYLES=&LAYERS=...&SRS=IAU2000:30120&BBOX=x0,y0,x1,y1&WIDTH=512&HEIGHT=512&FORMAT=image/jpeg`),
  pyramid level k = 608 km square split 2^k x 2^k, k ≤ 10, fetched once and reused (see the current
  `src/moon/polarImagery.ts` for the working v2 logic and tested URLs). Produce only tiles needing k ≥ minK.
- All reprojection and decoding happens in a small Web Worker pool (`new Worker(new URL('./imageryWorker.ts', import.meta.url), { type: 'module' })`),
  returning `ImageBitmap`s (transferable). Memory budget ≤ 300 MB total (route all polar-raster jobs to one worker).
  Concurrency limits for network; LRU caches; never leave a smeared placeholder: if a source fails, return a fully
  transparent tile so the layer below shows. Bilinear sampling, alpha-aware at edges, no seams between tiles.
- Test: a node script that checks the reprojection math (e.g. display tile pixel -> true lat/lon -> source pixel)
  for known features (Shackleton at true 89.67°S 129.78°E must land in the right polar-raster pixel; Tycho at
  43.3°S 11.2°W must map to the right Moon Trek tile/pixel at level 6).

### B. Terrain — owns `src/moon/lolaTerrain.ts`
`export class LolaTerrainProvider { constructor(heights: MoonHeights) }` — Cesium custom terrain provider in the
DISPLAY frame: for each display tile vertex convert to true lat/lon and read `heights.heightAt(...)`.
- Return `QuantizedMeshTerrainData` WITH oct-encoded vertex normals (so `globe.enableLighting` gives real sun shading of
  craters and mountains), proper `minimumHeight/maximumHeight`, `boundingSphere`, `orientedBoundingBox`,
  `horizonOcclusionPoint` (EllipsoidalOccluder on MOON_ELLIPSOID), edge index lists and skirt heights.
- Availability: levels 0-7 everywhere (global ~1.9 km data); up to level 11 only where the whole tile is in the true
  80 m polar map (true lat < -80.05°). Load 80 m tiles via `heights.loadTiles` before building detailed tiles.
- Consistency so neighbouring tiles at different levels meet without visible walls: sample the SAME surface at all
  levels in a region (bilinear of the finest data available), keep skirts short (just enough to hide cracks), and
  make sure normals at shared edges match.
- Expose `static sampleCount` or similar only if useful; keep it simple.
- Test: node script building a few tiles (Shackleton area, Tycho area) without the browser, checking heights at
  vertices equal `heights.heightAt` at the converted true lat/lon, normals are unit length and point outward,
  and edge vertex heights of a parent and its children agree within data error. (`MoonHeights` fetches from the
  running dev server: `new MoonHeights('http://127.0.0.1:5190/data/')`.)

### C. Labels — owns `src/moon/labels.ts`
Keep the public API of the current `NameLabels` (constructor(viewer), setNames(names, heights), setPlaces(places,
heights), update(), visible, placesVisible, destroy()). Changes: positions via `toCartesian`; far-side test with the
display unit vector; Google-Earth-like behaviour: names FADE in/out (~250 ms, eased) instead of popping, a shown name
keeps priority (hysteresis), names never overlap and must fit fully on screen, importance = seas > mountains >
craters > small features, Artemis/famous spots/missions always win when on screen. Register your own
`scene.preRender` listener for the fade animation and `requestRender()` only while animating. Must stay cheap with
9,112 labels (no per-frame allocation in hot loops; update() runs ~10x per second while the camera moves).

### D. Lander first-person view — owns `src/moon/lander.ts`, `src/ui/LanderHud.tsx`
Keep the API used by `MoonMap.tsx`: `new LanderView(viewer, heights)`, `enter(spec, sky, faceAzDeg)`,
`updateSky(sky)`, `look(azDeg, elDeg)`, `zoomFov(delta)`, `exit()`, `destroy()`, `active`, plus NEW
`headingDeg(): number` (true compass azimuth the camera faces) and `onChange?: () => void` hook for the HUD.
`SkyState` vectors (`sun`, `earth`) are in the TRUE frame (metres from Moon centre) — convert with `trueToDisplayVec`.
Requirements: display frame everywhere (eye from `toCartesian`, look directions from `directionFor`, camera
constrainedAxis = local up); the eye must NEVER be inside rendered terrain (each postRender: `globe.getHeight` at the
eye; keep eye ≥ rendered ground + mast + 1.5 m, smoothly); while in lander view raise terrain/imagery detail
(e.g. `globe.maximumScreenSpaceError = 1`, restore on exit); Sun and Earth drawn as an HTML overlay pinned to their
true directions every frame (true apparent sizes, Sun glow, Earth shows its correct PHASE: lit fraction and the lit
limb facing the Sun's on-screen direction); hidden/partly-hidden state comes from `sky.sunPart` / `sky.earthUp`
(calculator results), dashed calculated skyline + compass letters along the horizon; ground darkens in shadow;
smooth fly-in and fly-out (back to a tilted 3D view of the same spot). LanderHud shows "Facing …" from `headingDeg()`
(true north), status in plain words, buttons Look at Sun / Look at Earth / Back to map, Esc to exit, compact layout
that never covers the Sun/Earth at the horizon on a 1440x900 screen.

### E. Compare — owns `src/ui/Compare.tsx` (and `src/ui/compare.css` if you want; import it from Compare.tsx)
Keep the exact Props interface of the current `Compare` component (App passes them) and the `CompareItem` export.
Make it a genuinely useful decision tool for a student pitch: the user sets simple mission needs — "battery can
last through darkness of: 1 day / 3 days / 1 week / any" and "OK to be out of contact for: 6 h / 1 day / 3 days / any"
(custom segmented buttons, no native selects) — and each plan gets clear PASS/FAIL chips per need, a one-sentence
verdict in plain words ("B is the only plan that meets both needs: …"), big readable numbers, the shared-mission-
clock timeline per plan (Sun row amber, Earth row blue, day ticks, cursor), and best-value highlights. Explain
"+3 days" (same spot, landing 72 h later). Must look great at 1440x900 and on a big projector; no layout overflow.

### F. Sky markers for the globe view — owns `src/moon/skyMarkers.ts` (new)
`export class SkyMarkers { constructor(viewer); update(sunTrue: V3, earthTrue: V3); show: boolean; destroy() }`
For checking that lighting is correct while spinning the Moon: draw (1) the sub-solar point ("Sun overhead") and
sub-Earth point ("Earth overhead") on the surface, (2) the terminator (day/night boundary) as a dashed great circle,
(3) HTML overlay discs/arrows showing where the Sun and Earth are in space relative to the Moon (Earth at its true
direction; if off screen, an arrow at the screen edge with its name). Use the display frame. SVG or HTML only.
