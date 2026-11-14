# Libraries and implementation references

Checked **14 November 2026** against npm metadata and the maintainers' GitHub repositories. Read the project README, existing places list, and app package manifest first. Nothing was installed, and no downloaded code was executed. These are research recommendations for Claude to review, not changes to the app.

**Recommended additions:** `flatqueue` for the worker's open set; `simplify-js` for drawing recorded trails; `d3-contour` only if the minimap needs contours. Write the raster search, hillshade, long ruler, waypoint overlay, and minimap integration ourselves. Cesium is already installed.

## Package metadata

Versions below are the current **npm `latest` dist-tag**, obtained with `npm view <name> version license dist.unpackedSize types typings … --json`. Unpacked size is the entire published package, **not** minified, compressed, or tree-shaken browser size; it excludes dependencies. Full captured fields are in `npm-metadata.json`.

| Need / role | npm name | Version | Licence | Unpacked bytes | TypeScript |
| --- | --- | --- | --- | ---: | --- |
| Raster A* reference / fallback | `easystarjs` | 0.4.4 | MIT | 879,422 | Bundled `index.d.ts` |
| Maintained general graph search alternative | `ngraph.path` | 1.6.1 | MIT | 2,863,901 | Bundled `index.d.ts` |
| Graph container if using that alternative | `ngraph.graph` | 20.1.2 | BSD-3-Clause | 133,816 | Bundled `index.d.ts` |
| Binary heap, recommended | `flatqueue` | 3.1.0 | ISC | 13,062 | Bundled `index.d.ts` |
| Recorded trail simplification, recommended | `simplify-js` | 1.2.4 | BSD-2-Clause | 7,105 | Bundled `index.d.ts` |
| Contour polygons, optional | `d3-contour` | 4.0.3 | ISC | 38,680 | Separate types below |
| Contour types, development only | `@types/d3-contour` | 3.0.6 | MIT | 13,477 | Declaration package; version number follows DT's API line |
| Inertia reference / optional finite ruler base | `embla-carousel-react` | 8.6.0 | MIT | 50,629 | Bundled `index.d.ts`; React 19 allowed by peer range |
| Embla runtime dependency | `embla-carousel` | 8.6.0 | MIT | 489,743 | Bundled `index.d.ts` |
| Vertical wheel picker alternative | `@ncdai/react-wheel-picker` | 1.2.3 | MIT | 41,936 | Bundled `dist/index.d.ts`; React 19 allowed by peer range |
| Existing globe, markers and projection | `cesium` | 1.147.0 | Apache-2.0 | 80,196,017 | Bundled `Source/Cesium.d.ts` |

No React peer dependency is needed for the worker packages. `@types/d3-contour` also depends on `@types/geojson` and `@types/d3-array`. Confirm declarations against the selected runtime API when integrating; no compilation or runtime benchmark was performed here.

## a. Weighted raster A* / any-angle routing

**Write it ourselves:** an implicit eight-neighbour raster A* over typed arrays, using `flatqueue`. A 500 × 500 grid has 250,000 cells; a general graph would require many node and edge objects that the raster already represents. Keep cell IDs as `y * width + x`, with separate cost, best-distance, predecessor, and visited arrays. Transfer the grid's `ArrayBuffer` to a dedicated module worker and return cell IDs or projected points.

Use finite positive traversal costs and a separate blocked-cell mask. For a grid in metres, use `stepLength * (cost[u] + cost[v]) / 2`; diagonal distance is `sqrt(2)` times the axial spacing on a square grid. An admissible octile heuristic is that distance times the lowest allowed cost. Block a diagonal when either adjacent axial cell is blocked. Handle unreachable targets, cancellation and stale worker replies explicitly. Use the local polar projected grid's scale, not degrees of longitude near the pole. These are implementation recommendations, not measured performance claims.

The closest simple raster package is [EasyStar](https://github.com/prettymuchbryce/easystarjs). It supports tile weights, point costs, diagonal rules and iteration budgets, and is usable without a DOM. Its last repository push was **2024-01-23**, so it is a stable fallback rather than an actively developed 2026 choice. [ngraph.path](https://github.com/anvaka/ngraph.path) is the better-maintained graph alternative (push **2026-07-27**), with custom edge costs and heuristics; it normally uses [ngraph.graph](https://github.com/anvaka/ngraph.graph). Prefer it only if the product later has a sparse waypoint graph. Its greedy finder sacrifices optimality.

For genuine any-angle movement, use the [Theta* paper](https://arxiv.org/abs/1401.3843) as the algorithm reference. Do not substitute straight-line smoothing for weighted routing: every shortcut needs a supercover traversal, obstacle checks and integrated cost along the segment. A* plus validated shortcuts is a practical first version; label its optimality honestly. Do not use ordinary Jump Point Search unchanged on a variable-cost surface.

## b. Fast priority queue

**Use [flatqueue](https://github.com/mourner/flatqueue)**. It stores items and numeric priorities in parallel arrays, is ES-module friendly, has no DOM requirement, and was pushed **2026-07-21**. Push integer cell IDs with their `f = g + h` priority. It has no decrease-key operation: enqueue a new priority after an improvement and skip stale entries when popped. Its fixed-capacity typed-array mode is optional; stale duplicate entries mean capacity may exceed the number of cells. Begin with the growable queue unless an indexed decrease-key heap is justified by profiling. Tied priorities are not stable.

## c. Simplifying recorded trails

**Use [simplify-js](https://github.com/mourner/simplify-js)**, a tiny, established implementation. The repository is unarchived but last pushed **2022-11-14**; the algorithm is mature, so a newer release is not inherently better. Its [API reference](https://mourner.github.io/simplify-js/) documents `simplify(points, tolerance, highestQuality)`; `highestQuality: true` skips the preliminary radial-distance pass and uses Douglas–Peucker alone.

Convert trail points into local projected metres before applying a metre tolerance. Keep raw samples for distance, elapsed time and science results; simplify a copy for drawing. Do not use an RDP line as a new drivable route without checking every replacement segment against the cost and obstacle grids.

## d. Contours and hillshade for the canvas minimap

**Contours: use [d3-contour](https://github.com/d3/d3-contour)** if required. It is actively maintained (push **2026-11-03**). The [official API](https://d3js.org/d3-contour/contour) accepts a row-major numeric grid and returns planar GeoJSON MultiPolygons for chosen thresholds. Call `contours().size([width, height]).thresholds(levels)(heights)` in the worker, then stroke polygon rings on canvas. Output coordinates are grid coordinates, with cell centres at `(i + 0.5, j + 0.5)`, not Moon longitude/latitude. Handle the grid's outside boundary separately if only interior elevation lines should be visible. Install only this module, not all of D3.

**Hillshade: write it ourselves.** A small central-difference or Horn 3 × 3 derivative pass can produce normals from the existing height grid; shade with a chosen light direction and write pixels through `ImageData`. Use metres for height and horizontal spacing, distinguish no-data cells, and account for raster row direction. Do not present a decorative hillshade as the app's calculated real-time terrain shadow. Reuse a computed bitmap until the grid or display light changes.

## e. Ruler / Apple Timer style tick slider

**Write the horizontal timeline ourselves.** MOONDA spans 1900–2100 and changes tick spacing with zoom; it should render only visible ticks around a continuous time value rather than one DOM slide per date. Keep motion state in refs and draw/update once per animation frame. Sample recent drag velocity, decay it using elapsed time, clamp bounds, and cancel momentum immediately on new input. Include arrow/Page/Home/End keys, a labelled slider value, and reduced-motion support. Reuse the interaction conventions already in `app/src/moon/navigation.ts`.

The best maintained reference is [Embla Carousel](https://github.com/davidjerleke/embla-carousel) (push **2026-11-01**). Consult its version-pinned [DragTracker](https://github.com/davidjerleke/embla-carousel/blob/v8.6.0/packages/embla-carousel/src/components/DragTracker.ts) and [ScrollBody](https://github.com/davidjerleke/embla-carousel/blob/v8.6.0/packages/embla-carousel/src/components/ScrollBody.ts) for release velocity and settling. Its [v8 documentation](https://www.embla-carousel.com/docs/v8) matches npm `latest` **8.6.0**; the website defaults to a **9.0.0 release candidate**, whose options differ. For a short, finite ruler, the React wrapper with `dragFree` is a reasonable base, but wheel gestures require separate handling.

For an actual vertical time wheel, [React Wheel Picker](https://github.com/ncdai/react-wheel-picker) is a closer ready-made component. It has inertia, keyboard interaction, unstyled primitives and loop support, with a repository push on **2026-11-11**. Its [maintainer documentation](https://react-wheel-picker.chanhdai.com/docs/getting-started) describes the wheel's controlled value API. It does not directly provide the horizontal ruler requested here. Preserve the relevant MIT notice if adapting reference code.

## f. Game-style waypoints and minimap

**Write the integration ourselves using the existing [CesiumJS](https://github.com/CesiumGS/cesium) dependency.** Use [BillboardGraphics](https://cesium.com/learn/cesiumjs/ref-doc/BillboardGraphics.html) and labels for world-attached pins, distance fades, and selected waypoint rings. Use [SceneTransforms.worldToWindowCoordinates](https://cesium.com/learn/cesiumjs/ref-doc/SceneTransforms.html) for HTML distance badges and screen-edge arrows. Explicitly handle targets behind the camera and beyond the lunar horizon; do not let far-side pins appear to sit on the visible surface. Reuse the app's lunar ellipsoid and coordinate frame.

For the minimap, paint the same local projected height/image grid on one canvas, then overlay the rover position, heading triangle, breadcrumb trail and numbered waypoints. This shares coordinates with routing, works offline and avoids a second map engine. Cesium's [Multiple Synced Views example](https://sandcastle.cesium.com/index.html?id=multiple-synced-views) is a useful reference if a second Cesium view is later desired, but an additional live WebGL globe is unnecessary for a small local minimap. No Phaser, Three.js, Leaflet or React minimap dependency is justified for these features.

## Verification scope

`npm-metadata.json` contains the metadata-only queries and repository maintenance snapshot. `url-checks.json` records HTTP GET results for every web URL in this document; all responded successfully when checked. URL checks confirm responses, not browser behaviour or compatibility. No package tarballs, executables or source archives were downloaded. npm's temporary metadata cache was removed from this folder after capture.
