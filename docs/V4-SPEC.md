# MOONDA v4 — "Google Earth for the Moon" revamp

Read this whole file before you start. It is the contract between five builders working in parallel.

## 1. What the user said (13 Nov 2026) — this is the bar

The idea is good, the implementation is not. In their words:

- "the card placement with details and such is not as neat as google earth" — the left info box, the pin card, Compare ("add to compare just cover whole screen cant see anything"), "the Solar panel / antenna height … option shouldn't be in new line".
- "earth and sun geometry is bad looks like an image or coded with block of sphere" — wants real 3D-looking Earth, Sun, planets: "go and find like solar system online best model … and import". "dont try to build with your coded thing use svg or image".
- "the galaxy dont have like google earth like space" — "i want to see moon and the galaxy details tooo".
- "when i drag around it just keeps lagging even if my pc is m5 chip" — "make loading time on spawn browser … to fix this" (a loading screen at start is welcome if it makes everything smooth afterwards).
- "the default cursor dont put that as default" — Google Earth uses a grab hand. "google earth we can double click to increase zoom and stuff and so smooth".
- "the dragging thing sometimes when i hold moon and drag the behavior is not what i expected". They LIKE the drag of their old app, which used `GlobeControls` from NASA-AMMOS 3DTilesRendererJS (source: `/Volumes/CodexWork/Projects/NASA_space_app/3DTilesRendererJS/src/three/renderer/controls/{GlobeControls,EnvironmentControls,PointerTracker}.js`; old app config: `/Volumes/CodexWork/Projects/NASA_space_app/3DTilesRendererJS/moonda/src/Scene.tsx` ~line 225: damping on, dampingFactor .12, rotationSpeed .6).
- "stand here sometimes just freezed", and the lander view looks bad (black ground, tilted horizon, flat coloured discs for Sun/Earth).
- "see how google earth do it they make it so nice". Plain words, not jargon. Real icons (the Phosphor icon library is installed: `@phosphor-icons/react`; use it everywhere instead of hand-drawn shapes).

Measured facts about the current build (real Chrome on the M5, `scripts/drive.mjs`):
- Frame rate is ~60 fps most of the time, but there are freezes of 0.2–0.6 s (first-time shader compiles up to 190 ms each; `scene.pick` on hover cost 13 ms avg / 200 ms max — already removed).
- `globe.tilesLoaded` does not become true within 30 s at the South Pole view: something keeps loading forever, and zoomed-in views stay blurry (remote Lunaserv/Moon Trek tiles are slow).
- Lander view: horizon is tilted (camera has roll), ground is black when the spot is in shadow, the calculated dashed skyline does not sit on the drawn terrain.

## 2. Rules for every builder

1. **Your own copy.** You work in `/Volumes/CodexWork/Projects/MOONDA/.v4/<your-name>/app` — a full copy of `app/` (its `node_modules` and `public` are symlinks to the main app). Edit ONLY the files this spec says you own, inside your copy. Never edit `/Volumes/CodexWork/Projects/MOONDA/app/src` directly. If you need a change in a file you do not own (usually `src/moon/MoonMap.tsx` or `src/App.tsx`), make the minimal change in YOUR COPY so you can test, and list the exact change in your final report under "wiring I need".
2. **New data/assets** go through the `public` symlink into NEW folders that only you write (named in your section). Never modify or delete existing files under `public/`.
3. **Your own dev server**: `cd <your copy> && npx vite --host 127.0.0.1 --port <your port> --strictPort` (run it in the background; do NOT use `npm run dev`). Stop it when you finish. Never kill processes you did not start.
4. **Test like a user, in real Chrome**: `node scripts/drive.mjs '<json steps>' --url http://127.0.0.1:<port>/ --out <dir>` (read the header of `scripts/drive.mjs`). It drives a hidden Chrome on the real GPU: click, drag, wheel, double-click, screenshots (PNG includes HTML overlays), frame-time measurements. **Open the PNGs with the Read tool and judge them like a picky user comparing with Google Earth.** Write screenshots under `/Volumes/CodexWork/Projects/MOONDA/.v4/<your-name>/shots/`. Do not use any browser MCP tools.
   - The welcome dialog appears on a fresh profile: first step is usually `{"do":"click","text":"Explore the whole Moon"}`.
   - `{"do":"ready"}` waits for `window.__moonda.idle()` (map tiles loaded).
5. **TypeScript rules**: TS 7, `erasableSyntaxOnly` (no constructor parameter properties, no enums), `noUnusedLocals/Parameters`, `verbatimModuleSyntax` (use `import type`/`type` modifiers). `npx tsc -p tsconfig.app.json --noEmit` must exit 0 in your copy. Node test scripts live in `scripts/` and run with `node scripts/x.ts`.
6. **Cesium lessons** (hard-won): never import Cesium from a second URL/instance; the viewer runs in `requestRenderMode` — call `scene.requestRender()` after any change, and run your own `requestAnimationFrame` loop while animating; Cesium source is at `node_modules/@cesium/engine/Source` — read it instead of guessing; billboards from canvas/PNG data-URLs failed to draw before (file URLs and SVG data-URLs work); `scene.pick` is forbidden on hover/drag paths (too slow) — use screen-space maths.
7. **Words**: plain English a 15-year-old understands. No "azimuth", "elevation", "DEM", "ephemeris" in the UI. Explain with a `?` help tip where a term is needed.
8. **Final report** (your return value): files changed/added (absolute paths in your copy), "wiring I need" with exact code, tests you ran with numbers, the screenshot paths that prove it, and an honest list of what is not done or not verified.

## 3. The frame (unchanged)

The globe is drawn in a rotated **display frame** so Cesium's poles are far from the Moon's poles: `display = (x, −z, y)` of TRUE Moon body-fixed coordinates. Helpers in `src/moon/frame.ts` (`toCartesian(lat,lon,h)`, `toTrueLatLon(p)`, `trueToDisplayVec`, `trueENU`, `directionFor(az,el,lat,lon)`, `azimuthOf`, `TRUE_NORTH_DISPLAY`). Sun/Earth vectors from `src/science/ephemeris.ts` (`bodyFixedState(minute)`) are metres from the Moon's centre in the TRUE frame. Heights: `src/science/heights.ts` (`MoonHeights.heightAt(lat,lon,detail)`, metres above the 1,737.4 km sphere). Moon radius `MOON_R = 1_737_400`.

## 4. Modules, owners, contracts

Integrator (not a builder): owns `src/moon/MoonMap.tsx`, `src/moon/labels.ts`, `src/moon/layers.ts`, `src/moon/frame.ts`, `src/science/heights.ts`, start-up preloading. Builders code against the contracts below.

### 4.1 NAV — builder `nav`, port 5201 — owns `src/moon/navigation.ts` (+ `scripts/check-nav*.{ts,mjs}`)

Goal: the Moon must feel exactly like Google Earth / the old app's GlobeControls. Port the behaviour of GlobeControls + EnvironmentControls to Cesium's camera (set `camera.position/direction/up` yourself every frame; turn Cesium's own `screenSpaceCameraController.enableInputs` off while navigation is enabled).

Keep these exports working (same signatures): `CameraPose`, `poseLookingAt`, `poseGlobe`, `cameraHeadingPitch`, `attachNavigation`. New shape:

```ts
export interface NavOptions {
  onFovWheel?(d: number): void;                 // unchanged: wheel while nav.enabled === false (lander view)
  isClickableAt?(x: number, y: number): boolean; // true -> show 'pointer' cursor (canvas CSS px)
  onClick?(x: number, y: number): void;          // a true single click (no drag, and no second click within ~250 ms)
  onHoverMove?(x: number, y: number): void;      // pointer moved with no button down, at most once per frame
}
export interface Navigation {
  enabled: boolean;                // false = ignore all input (lander view owns the camera)
  readonly interacting: boolean;   // dragging, inertia, zoom animation or flight in progress
  zoomBy(logFactor: number, anchor?: { x: number; y: number }): void; // animated; positive = closer
  resetNorth(): void;              // animated; true north up, keeps the centre point
  setTilt(pitchDeg: number): void; // animated tilt about the point at the screen centre; -90 = straight down
  flyTo(pose: CameraPose, opts?: { duration?: number }): Promise<boolean>; // false if the user interrupted it
  cancel(): void;
  destroy(): void;
}
export function attachNavigation(viewer: Viewer, heights: MoonHeights, opts?: NavOptions | ((d: number) => void)): Navigation;
```
(The old call `attachNavigation(viewer, heights, d => …)` must keep working.)

Required behaviour:
- **Left-drag = grab.** The ground point under the cursor at press stays under the cursor for the whole drag (arcball relative to the pose at press, exactly like `GlobeControls._updatePosition`: total rotation from grab direction to cursor direction applied to the baseline pose; sphere radius = distance of the grabbed point; off the limb clamp to the horizon circle). No "north-up" constraint while dragging; no roll relative to the local horizon afterwards (as GlobeControls re-aligns camera up). Dragging across both true poles must work without flips or twisting. Release = **inertia** that decays smoothly (GlobeControls `_updateInertia`).
- **Wheel / trackpad pinch = zoom toward the cursor** (the point under the cursor stays put), eased, both directions, frame-rate independent. Trackpad two-finger scroll must feel as smooth as Google Earth (accumulate deltas; no steps). Min height ~100 m above the real terrain (`heights.heightAt`), max distance 25,000 km. Never go under the terrain. Zooming far out gently levels the view toward the Moon's centre and north-up (GlobeControls `_tiltTowardsCenter` / `_alignCameraUpToNorth`).
- **Double-click = smooth zoom in ×2 toward that point** (~350 ms ease-out). Right double-click (or Shift+double-click) zooms out. A double-click must not also fire `onClick`.
- **Right-drag, middle-drag, Ctrl/⌘+drag, Shift+drag = rotate (left/right) and tilt (up/down) about the grabbed point**, like Google Earth. Tilt range: straight down to ~85° from straight down. Context menu suppressed on the canvas.
- **Keyboard** (when focus is not in an input): arrows pan, `+`/`-` zoom, `N` north up, `U` top-down, Shift+arrows rotate/tilt.
- **Touch**: one finger pans, two fingers pinch-zoom + rotate; two-finger vertical drag tilts.
- **Cursor**: `grab` over the canvas, `grabbing` while left-dragging, `move` while rotate/tilt-dragging, `pointer` when `isClickableAt` says so. Never the default arrow over the map.
- `flyTo`: Google-Earth-like eased flight (for far targets pull back, travel, descend; always keeps the Moon in view; no passing through terrain). Any user input cancels it.
- Calls `scene.requestRender()` whenever the camera moves; keeps `camera.changed` firing (labels listen to it).
- Prove with `drive.mjs`: (a) grab test — record the true lat/lon under the cursor at press and under the cursor at release for 6 drags at whole-Moon, pole and 50 km-altitude views: error < 3 px equivalent; (b) drags through the south pole and the north pole; (c) zoom anchoring error; (d) double-click; (e) tilt/rotate; (f) frame times during drags/zooms (`measure`): no frame > 50 ms once tiles are loaded; (g) screenshots.

### 4.2 SKY — builder `sky`, port 5202 — owns `src/moon/sky/**` (new), `src/moon/skyMarkers.ts`, `src/science/skyMath.ts` (new), `public/space/**` (new), `data-prep/space/**` (new)

Goal: real space around the Moon, like Google Earth's sky: the Milky Way and stars in their true positions, a real-looking 3D Earth with the correct phase and the correct side facing the Moon, a believable Sun, and the bright planets. Everything in the true directions for the time on the time bar (they move when the time changes).

Assets: download them yourself with curl, **only from nasa.gov sites (svs.gsfc.nasa.gov, science.nasa.gov, eoimages.gsfc.nasa.gov, visibleearth.nasa.gov, solarsystem.nasa.gov, images.nasa.gov), github.com/astronexus/HYG-Database, or the Yale Bright Star Catalog at CDS/Harvard**. (Codex was asked to do this but its CLI is not usable on this account right now.) Never run anything you download; data and images only. What to get: NASA SVS "Deep Star Maps 2020" (SVS id 4851: the star map and, if offered, the Milky-Way-only map, 4k–8k, celestial RA/Dec layout — check and record which RA is at the centre and which way it increases; EXR needs tone-mapping to JPG, python3 with numpy/Pillow/imageio/OpenEXR may be available — check before relying on it, `pip install --user` of well-known packages is fine); a bright-star catalogue (HYG v3/v4 CSV or Yale BSC5) reduced to `[raDeg, decDeg, mag, bv, name|null]` for mag ≤ 6.5; NASA Blue Marble Next Generation day map (no clouds), Black Marble night lights, a cloud map; the Sun: a NASA SDO/SVS image or a shader-made photographic glare (a real-looking glare is fine; a flat coloured disc is not). Put the pieces you use into `public/space/` (aim ≤ 40 MB total: 4k–8k sky, 4k Earth) and record source page, direct URL and NASA's credit line for each in `public/space/CREDITS.md`. Do not draw planets/Sun/Earth with CSS or hand-made flat shapes.

Contract:
```ts
// src/moon/sky/index.ts
export interface SkyBodies { sun: V3; earth: V3 }           // TRUE frame, metres from the Moon's centre
export interface SkyShow { stars: boolean; milkyWay: boolean; earth: boolean; sun: boolean; planets: boolean; names: boolean }
export class SpaceSky {
  constructor(viewer: Viewer, opts?: { base?: string });     // base defaults to './space/'
  readonly ready: Promise<void>;                              // textures/catalogue loaded (never rejects; degrade gracefully)
  show: SkyShow;                                              // assigning a new object applies it
  exposure: number;                                           // 0..1.5 star/Milky-Way brightness (default 1)
  update(timeMs: number, bodies: SkyBodies): void;            // call when the time changes
  screenOf(body: 'sun' | 'earth'): { x: number; y: number; onScreen: boolean; behindMoon: boolean; sizePx: number } | null;
  pick(x: number, y: number): { kind: 'earth' | 'sun' | 'planet' | 'star'; name: string; note: string } | null; // screen-space maths only
  destroy(): void;
}
```
- Sky orientation: catalog/star-map coordinates are J2000 equatorial (RA/Dec). You need the rotation J2000 → Moon body-fixed TRUE frame at `timeMs` (the same convention `bodyFixedState` in `src/science/ephemeris.ts` uses — read it and reuse its maths; put new helpers in `src/science/skyMath.ts`, do not change existing exports), then TRUE → display with `trueToDisplayVec`. Verify numerically in a node script: the direction of a star computed your way must match Astronomy Engine for 3 dates; the Sun/Earth directions you draw must equal `bodies` to < 0.01°.
- No parallax and no clipping: the camera moves up to 25,000 km from the Moon's centre and the far plane is 5e8 m. Keep the sky shell and the far bodies centred on the camera (update a model matrix in `scene.preRender`), or use proxies at a reduced distance with the same direction and angular size. The Moon/terrain must hide what is behind it. The sky must not be affected by globe lighting.
- Stars: crisp points (size and brightness from magnitude, colour from B−V), not a blurry stretched photo; the Milky Way as a soft panorama behind them. It should look like the real night sky from space: Orion, the Southern Cross, the Magellanic Clouds recognisable.
- Earth: a lit sphere (day map, night-side city lights, clouds, thin blue atmosphere rim, soft terminator), true angular size (≈1.9° seen from the Moon), true phase from the real Sun direction, true orientation (the continents that really face the Moon at that time: Earth rotation + axial tilt). Must look right both from the globe view and from the lander view.
- Sun: bright photographic glare with a small intense core (use `sun-glare.png` or a NASA image), true direction, hidden by the Moon when behind it. No bloom that washes out the Moon.
- Planets (Mercury…Saturn): correct positions from Astronomy Engine; drawn as bright points with a small name tag when `show.names`; names for ~15 brightest stars too.
- `skyMarkers.ts`: keep "Sun overhead" / "Earth overhead" ground markers and the dashed day/night line, but remove the old CSS discs; keep the screen-edge arrows that point to the Sun/Earth when they are off screen, restyled (small, neat, real icons). Same class API (`show`, `update(sunTrue, earthTrue)`, `destroy()`).
- Wiring you will need in MoonMap (do it in your copy, report it): `const sky = new SpaceSky(viewer)`; in the sunlight effect `sky.update(timeMs, bodies)`; `sky.show = {...}` from layer switches `stars` and `skyNames`. MoonMap gets the time as a new prop `timeMs: number` (App has it as `cursor`/`minute`).
- Performance: sky must cost < 1 ms per frame on the main thread; no per-frame allocations in the hot path.
- Prove with screenshots: whole Moon with Milky Way; Earth close-up (use `eval` to point the camera / narrow `camera.frustum.fov` so Earth fills ~300 px) at two times 7 days apart showing different phases and faces; Sun; the lander view at a pole site; a view where the Moon hides the Sun.

### 4.3 IMAGERY — builder `imagery`, port 5203 — owns `src/moon/imagery.ts`, `src/moon/imageryWorker.ts`, `scripts/check-imagery*.ts`, `data-prep/polar_tiles.py` (new), `data-prep/base_mosaic.py` (new), `public/data/base/**` (new), `public/data/polar/t/**` (new)

Goal: the Moon appears instantly and sharpens fast, even on bad Wi-Fi; nothing loads forever.
1. **Find and fix why `scene.globe.tilesLoaded` never becomes true** at the South Pole view (30 s+). Use `drive.mjs` + `eval` to inspect each layer's pending/failed requests. Tiles that cannot load must resolve (blank) so loading ends.
2. **Local base mosaic**: a whole-Moon picture stored locally in the display frame so the globe is never blank or blocky at start and works offline. Build it in `data-prep/base_mosaic.py` from Moon Trek's own WAC mosaic tiles (same look as the detailed tiles; the WMTS URL pattern is in `imageryWorker.ts`, level 4 or 5). Target 8192×4096 (≤ ~8 MB JPG) plus a 2048×1024 quick-look. Expose it as an imagery provider the integrator can add as the bottom layer (`createBaseMosaicProvider({ url, credit })` in `imagery.ts`, or tell the integrator to use Cesium's `SingleTileImageryProvider` if you pre-rotate the image into the display frame).
3. **Local sharp south-pole tiles**: pre-download the polar photo pyramid that `createPolarPyramidProvider` requests from ASU Lunaserv (WMS, layers `luna_wac_global,luna_nac_pole_control_south`, the exact request format is in `imageryWorker.ts`) into `public/data/polar/t/{k}/{col}_{row}.jpg` with `data-prep/polar_tiles.py` (resumable, ≤ 4 parallel requests, retries, polite). Coverage: every level up to k=5 for the whole 608 km square; k=6 for the inner 304 km; k=7 for the inner 152 km; k=8 for the inner 60 km around the pole and around these sites if time allows: Shackleton rim (−89.78, −155.7... use `src/data/places.ts` for the Artemis regions). Budget ≤ 350 MB, ≤ 25 minutes of downloading; write `public/data/polar/t/index.json` describing what exists. The worker must read tiles **local first** (from the index, no 404 noise) and fall back to the remote server only where no local tile exists.
4. Report time-to-sharp (ms from arriving at a view to `idle()`), before/after, for: start view, South Pole button, zoom to 100 km and to 10 km altitude over the Shackleton–de Gerlache ridge. Target ≤ 1.5 s where local tiles exist.
5. Export `imageryPending(): number` (jobs in flight across all layers) for the loading screen.
Keep the three existing factory signatures (`createMoonTrekProvider`, `createPolarRasterProvider`, `createPolarPyramidProvider`) and `imageryReloaded`.

### 4.4 LANDER — builder `lander`, port 5204 — owns `src/moon/lander.ts`, `src/ui/LanderHud.tsx`, `src/ui/Skyline.tsx`, lander-related CSS in a NEW file `src/ui/lander.css`

Goal: "Stand here" must feel like Street View on the Moon: you are standing at the spot, the ground and hills look real, the horizon is level, the Sun and Earth are where they really are, and it never freezes.
- Fix: camera roll (horizon must be perfectly level at all headings and at every site, including near the true pole and at mid-latitudes); black ground (when the spot is in shadow the scene gets dimmer but stays readable — think moonlit night with a faint blue tint from Earthshine; sunlit slopes stay bright); the dashed "calculated skyline" must sit on the drawn terrain edge (find out why it does not; if a mismatch above ~0.3° remains at some headings because the drawn terrain is coarser in the distance, say so and keep the line subtle).
- Enter/exit without freezing and without flying through mountains: fade to black, place the camera, wait until the nearby terrain and photos are loaded (or 4 s), fade in; exit restores the exact map view the user had. Measure with `drive.mjs` `measure` (no frame > 100 ms during enter; total ≤ 2.5 s when data is cached).
- Controls: drag to look around (Street-View direction: drag left → view turns right; with inertia), wheel/pinch = zoom the lens (field of view 20°–90°), arrow keys, cursor `grab`/`grabbing`. No roll, ever. Looking up to the zenith and down to −60° allowed.
- HUD (`LanderHud.tsx`): a slim compass strip at the top (N · NE · E … with "Facing east"), a neat status card in plain words ("Sun: just above the hills — solar panels work" / "Sun: behind that hill for 3 more days"), buttons "Look at the Sun", "Look at Earth", "Back to map". Keep it small; it must not cover the view.
- Sun and Earth: the SKY builder draws them in 3D in the same scene (`SpaceSky`). In your copy they do not exist yet, so keep your own simple markers behind a constructor/option flag `ownBodies` (default true) and make sure that with `ownBodies: false` you draw only the small name tags ("Sun", "Earth — behind a hill") at the right screen positions.
- Keep the public API used by MoonMap: `new LanderView(viewer, heights)`, `enter(spec, sky, faceAz)`, `exit()`, `updateSky(sky)`, `look(az, el)`, `zoomFov(d)`, `headingDeg()`, `active`, `destroy()`, types `LanderSpec`, `SkyState`. You may add options.
- Prove with screenshots at 4 sites: Shackleton rim high point, Connecting Ridge, Malapert Massif, and a mid-latitude place (Tycho floor or Apollo 11), each sunlit and in shadow (change the time with the time bar or `eval`), plus frame-time numbers for enter/exit.

### 4.5 UI — builder `ui`, port 5205 — owns `src/App.tsx`, `src/ui/**` except `LanderHud.tsx`/`Skyline.tsx`/`lander.css`, `src/styles.css`, `src/ui/compare.css`, `index.html`

Goal: the page must look and behave as neat as Google Earth / Google Maps: calm, aligned, nothing covering the map centre, every card built the same way.

Layout (desktop first, 1280–2560 px wide; it is shown on a big screen):
- **Top bar**: floating pills, 12 px from the edges. Left: logo mark + "MOONDA", search. Right: `Whole Moon`, `South Pole`, `Layers`, `Compare (n)`, `?`.
- **Info panel (left, 380 px)** — like the Google Maps place panel. One consistent structure for every kind of selection (dropped pin, crater/named place, Artemis region, past landing):
  1. Header: small kind chip, title, one plain-words line ("Inside Shackleton crater · 12 km from the south pole"), coordinates in small mono text with a copy button, close ×.
  2. Action row: three equal buttons with icons — **Stand here** (primary), **Compare** (add/remove), **Zoom in**.
  3. "Right now": two one-line status rows (Sun, Earth) with icon, bold verdict and a short reason.
  4. "During your N-day mission": the two timeline bars and four stat tiles in a tidy 2×2 grid (same height, value big, label small, `?` help).
  5. "Lander": ONE row — label "Solar panel / antenna height" on the left, a segmented control (2 m · 5 m · 10 m) on the right, on the same line.
  6. "Ground here": NASA map values (ice, temperature, slope, average sunlight…) as neat label–value rows; outside the polar data a single muted sentence.
  7. "About": description + source.
  Sticky header + actions, the rest scrolls inside the panel; the panel never runs under the time bar; nothing is cut off mid-card. A collapse chevron shrinks it to its header.
- **Compare (right drawer, ~400 px)** — never covers the map centre. Header "Compare plans · 2 of 4" + close; "What the mission needs" (two segmented rows: battery, contact); a verdict banner in one or two sentences; then one **card per plan** stacked vertically: letter badge, name, arrival; two slim tracks (Sun, Earth) with the red "longest gap" marks; two stats with pass/fail chips; small icon buttons (stand here, +3 days, show on map, remove). The best plan is highlighted. Keep all the existing logic in `Compare.tsx` (needs, evaluate, verdict text) — re-lay it out, do not rewrite the science.
- **Time bar (bottom, one compact row ≤ 72 px)**: play/pause, current date-time (+ Cambodia time), the scrub track with Sun/Earth bars and day ticks, then small menus (popovers) for arrival date, mission length, play speed, and `Now`. No second row of controls.
- **Map controls (bottom right, above the time bar)**: compass (click = north up), tilt 2D/3D, +, −, and a sun toggle for "Real sunlight". 40 px round/rounded buttons, Google-Earth style.
- **Status line** (bottom, small): what is under the cursor in words + coordinates, eye height, data credits.
- **Loading screen**: full-screen, shown at start until the integrator reports done. Component `LoadingScreen({ progress }: { progress: { pct: number; step: string } })` — logo, one line of plain text ("Loading the Moon's height map…"), a thin progress bar, fades out. Use a clean typographic mark with the existing Moon glyph (no generated art is available).
- **Welcome** (first visit, after loading): shorter, three steps, two buttons.
- **Layers** popover: grouped switches with a legend strip and one-line plain explanation each; opacity slider only for map overlays.
- Visual language: dark glass like Google Earth's dark UI — panels `rgba(17,19,24,.88)` with `backdrop-filter: blur(18px)`, 1 px hairline `rgba(255,255,255,.08)`, radius 16 px panels / 999 px pills / 10 px controls, soft shadow; Inter Variable 13–14 px body, 20–22 px titles, tabular numbers; one accent per meaning: Sun amber `#F6B443`, Earth blue `#5AA9FF`, good green `#4FD18B`, bad red `#FF7A6B`; primary button white on dark. 8 px spacing grid. Motion 180–240 ms ease-out, no layout jumps, no overlapping tooltips. Custom controls only (no native select/date inputs).
- Keyboard and a11y: focus rings, `aria-pressed`, Escape closes popovers/panels.

Contract with the map (integrator will provide; in your copy keep using what exists and add props as needed, then report):
```ts
<MoonMap ref layers opacity scienceLayers names selectedPin pins bodies timeMs lander sky onSelect onHover
         onLoadProgress?={(p: { pct: number; step: string; done: boolean }) => void} />
MoonMapHandle: flyTo(lat, lon, heightKm?, tilted?), flyWhole(), flyPole(), zoomBy(f), resetNorth(), setTilt(p), look(az, el)
```
New layer ids the integrator adds to `layers.ts`: `stars` ("Stars and Milky Way", default on), `skyNames` ("Planet and star names", default on). The "Real sunlight" switch id is `realSun`.
Prove with screenshots at 1440×900 and 1920×1080 (`--width/--height`): start, pin selected (panel top and scrolled), named crater selected, Artemis region selected, compare with 1 / 2 / 4 plans while a pin panel is open, layers popover, time-bar menus, loading screen, welcome. Check alignment pixel by pixel in the PNGs; nothing clipped, nothing overlapping.

## 5. After the builders

The integrator merges the copies, rewires `MoonMap.tsx`, adds the start-up preloader (heights, names, base photo, sky textures, shader warm-up, south-pole tiles) behind the loading screen, then an independent review tests the merged app.
