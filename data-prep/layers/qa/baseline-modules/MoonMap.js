import { createHotContext as __vite__createHotContext } from "/@vite/client";import.meta.hot = __vite__createHotContext("/src/moon/MoonMap.tsx");import.meta.env = {"BASE_URL": "/", "DEV": true, "MODE": "development", "PROD": false, "SSR": false};const forwardRef = __vite__cjsImport3_react["forwardRef"]; const useEffect = __vite__cjsImport3_react["useEffect"]; const useImperativeHandle = __vite__cjsImport3_react["useImperativeHandle"]; const useRef = __vite__cjsImport3_react["useRef"];const _jsxDEV = __vite__cjsImport28_react_jsxDevRuntime["jsxDEV"];// The 3D Moon. CesiumJS streams small map tiles for whatever is on screen, so zooming stays
// smooth and detail keeps sharpening as you get closer (the same idea as Google Earth).
// Mountains are real 3D shapes from NASA's LOLA heights, lit by the Sun at the chosen time.
//
// The Moon is rotated inside Cesium so the south pole is on Cesium's equator (see frame.ts).
// Always convert with frame.ts: never feed true lat/lon straight into Cesium.
import "/src/moon/ellipsoid.ts";
import * as Cesium from "/node_modules/.vite/deps/cesium.js?v=f79bc84e";
import { Cartesian2, Cartesian3, Color, DirectionalLight, EllipsoidTerrainProvider, Globe, ImageryLayer, ScreenSpaceEventType, VerticalOrigin, Viewer } from "/node_modules/.vite/deps/cesium.js?v=f79bc84e";
import __vite__cjsImport3_react from "/node_modules/.vite/deps/react.js?v=dcf335c5";
import { PLACES } from "/src/data/places.ts?t=1794656855457";
import { shareHeights } from "/src/science/client.ts?t=1794645275498";
import { MoonHeights } from "/src/science/heights.ts";
import { cameraStore } from "/src/ui/stores.ts";
import { MOON_ELLIPSOID } from "/src/moon/ellipsoid.ts";
import { toCartesian, toTrueLatLon, trueToDisplayVec } from "/src/moon/frame.ts";
import { cancelOffscreenImagery, createBaseMosaicProvider, createMoonTrekProvider, createPolarPyramidProvider, createPolarRasterProvider, createScienceRasterProvider, createSeamFixProvider, imageryPending, imageryReloaded, warmScienceRasters } from "/src/moon/imagery.ts?t=1794657614824";
import { createCraterLayer } from "/src/moon/craterLayer.ts?t=1794658926604";
import { NameLabels } from "/src/moon/labels.ts";
import { LanderView } from "/src/moon/lander.ts?t=1794657753993";
import { POLAR_EXTENT_M, SHARP_POLAR_LAYERS, scienceToLayer } from "/src/moon/layers.ts?t=1794657825222";
import { LolaTerrainProvider } from "/src/moon/lolaTerrain.ts?t=1794642679603";
import { attachNavigation, cameraHeadingPitch, poseGlobe, poseLookingAt } from "/src/moon/navigation.ts";
import { runPreload } from "/src/moon/preload.ts?t=1794657825225";
import { applyQuality, initQuality, knobs } from "/src/app/quality.ts";
import { settings } from "/src/app/settings.ts";
import { t } from "/src/i18n/index.ts?t=1794657753993";
import { SpaceSky } from "/src/moon/sky/index.ts";
import { SkyMarkers } from "/src/moon/skyMarkers.ts?t=1794657753993";
import { FlatMap, flatTrekTiles } from "/src/moon/flatMap.ts?t=1794657825222";
import { loadManifest } from "/src/science/layerValues.ts?t=1794657825225";
import { MapModes } from "/src/moon/mapMode.ts?t=1794657905469";
import { createDataDetailLayer } from "/src/moon/dataDetail.ts";
import { setExploreHeights } from "/src/explore/context.ts";
var _jsxFileName = "/Volumes/CodexWork/Projects/MOONDA/app/src/moon/MoonMap.tsx";
import __vite__cjsImport28_react_jsxDevRuntime from "/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=dcf335c5";
var _s = $RefreshSig$();
/** The Height colours layer's NASA Moon Trek map (globe, flat map and start-up preload use the same one).
*  North of minTrueLat only: the sharper south-pole height map (data/layers/height.png) is drawn below it. */
const HEIGHT_TREK = {
	layer: "LRO_LOLA_ClrShade_Global_256ppd_v06",
	ext: "png",
	minTrueLat: -80.4
};
const svgUrl = (svg) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
// Map markers are our own small drawings (one family), at about 2x their screen size for sharpness.
// The pin: a slim teardrop whose tip is at (40, 75) of 80, exactly where the old pin's tip was, so
// the anchor and the hit area are unchanged. A soft shadow under the tip and a hairline dark edge
// keep it readable on bright and on dark ground.
const PIN_BODY = "M40 75C38 70 25.2 46.9 21.4 39.8A21 21 0 1 1 58.6 39.8C54.8 46.9 42 70 40 75Z";
const PIN_SVG = (ring, label = "") => svgUrl("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"80\" height=\"80\" viewBox=\"0 0 80 80\">" + "<defs><filter id=\"b\" x=\"-1\" y=\"-1\" width=\"3\" height=\"3\"><feGaussianBlur stdDeviation=\"1.6\"/></filter></defs>" + "<ellipse cx=\"40\" cy=\"75.5\" rx=\"7.5\" ry=\"2.6\" fill=\"#000\" fill-opacity=\"0.45\" filter=\"url(#b)\"/>" + (label ? `<path d="${PIN_BODY}" fill="#f2f3f5" stroke="#0b0d10" stroke-opacity="0.6" stroke-width="1.6"/>` + `<circle cx="40" cy="30" r="15" fill="none" stroke="${ring}" stroke-width="3.5"/>` + `<text x="40" y="37" font-family="'Google Sans Flex Variable', 'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="20" font-weight="600" fill="#15161a" text-anchor="middle">${label}</text>` : `<path d="${PIN_BODY}" fill="#ff6b5a" stroke="#0b0d10" stroke-opacity="0.6" stroke-width="1.6"/><circle cx="40" cy="30" r="7.5" fill="#fff"/>`) + "</svg>");
_c = PIN_SVG;
/** A round marker for special places: dark glass disc, white symbol drawn in a 22-unit box, an optional thin coloured ring. */
const BADGE_SVG = (symbol, ring) => svgUrl("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"44\" height=\"44\" viewBox=\"0 0 22 22\">" + `<circle cx="11" cy="11" r="10" fill="#151619" fill-opacity="0.86" stroke="${ring}" stroke-width="1.1"/>` + `<g fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${symbol}</g></svg>`);
_c2 = BADGE_SVG;
/** A round marker with an ice crystal: ring colour, ring dashes ('' = solid) and crystal colour. */
function ICE_SVG(ring, dash, ink) {
	return svgUrl("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"44\" height=\"44\" viewBox=\"0 0 22 22\">" + `<circle cx="11" cy="11" r="10" fill="#151619" fill-opacity="0.86" stroke="${ring}" stroke-width="1.3"${dash ? ` stroke-dasharray="${dash}"` : ""}/>` + `<g fill="none" stroke="${ink}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5.4v11.2M6.2 8.2l9.6 5.6M15.8 8.2l-9.6 5.6"/><path d="M9.6 6.3 11 7.6l1.4-1.3M9.6 15.7 11 14.4l1.4 1.3"/></g></svg>`);
}
_c3 = ICE_SVG;
/** Pictures of the special places, by kind (ice evidence has one per strength of evidence: see labels.ts iconKeyOf). */
const ICON = {
	// corner brackets around a dot: "a region picked as a landing target"
	artemis: BADGE_SVG("<path d=\"M6.5 9V6.5H9M13 6.5h2.5V9M15.5 13v2.5H13M9 15.5H6.5V13\"/><circle cx=\"11\" cy=\"11\" r=\"1.2\" fill=\"#fff\" stroke=\"none\"/>", "#7fcfa8"),
	spot: BADGE_SVG("<path d=\"M5.8 14.6 9.4 8.4l2.3 3.6 1.4-1.9 3.1 4.5Z\" fill=\"#fff\" stroke-width=\"1\"/>", "rgba(255,255,255,0.28)"),
	// a small flag on a pole: something landed (or hit the ground) here
	mission: BADGE_SVG("<path d=\"M7.6 16.4V5.6\"/><path d=\"M8.3 6.1h6.4l-1.7 2.3 1.7 2.3H8.3Z\" fill=\"#fff\" stroke-width=\"0.8\"/>", "rgba(255,255,255,0.28)"),
	// the same flag with radio waves and a green ring: it may still be working
	active: BADGE_SVG("<path d=\"M6.6 16.4V6.6\"/><path d=\"M7.3 7.1h4.6l-1.3 1.8 1.3 1.8H7.3Z\" fill=\"#fff\" stroke-width=\"0.8\"/><path d=\"M13.6 12.4a3 3 0 0 0 0-4.6M15.5 14.2a5.6 5.6 0 0 0 0-8.2\"/>", "#6fcf9d"),
	// an empty flag in a dashed ring: planned, not there yet
	planned: svgUrl("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"44\" height=\"44\" viewBox=\"0 0 22 22\">" + "<circle cx=\"11\" cy=\"11\" r=\"10\" fill=\"#151619\" fill-opacity=\"0.86\" stroke=\"#a99ee8\" stroke-width=\"1.2\" stroke-dasharray=\"2.4 2\"/>" + "<g fill=\"none\" stroke=\"#fff\" stroke-width=\"1.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M7.6 16.4V5.6\"/><path d=\"M8.3 6.1h6.4l-1.7 2.3 1.7 2.3H8.3Z\"/></g></svg>"),
	// water ice: a six-armed crystal. White ring = measured there, cyan = signs seen from orbit, dashed blue = only predicted
	"ice-confirmed": ICE_SVG("#ffffff", "", "#ffffff"),
	"ice-detected": ICE_SVG("#50d2ff", "", "#bfeeff"),
	"ice-predicted": ICE_SVG("#6e96ff", "2.4 2", "#c9d6ff"),
	ice: ICE_SVG("#50d2ff", "", "#bfeeff")
};
/** A short drop-in when a pin is placed on a new spot: it falls the last few pixels onto it. */
let lastDrop = "";
function dropIn(viewer, e, spot) {
	if (spot === lastDrop) return;
	lastDrop = spot;
	const t0 = performance.now();
	const step = () => {
		if (!e.billboard || viewer.isDestroyed()) return;
		const k = Math.min(1, (performance.now() - t0) / 260), ease = 1 - (1 - k) ** 3;
		e.billboard.pixelOffset = new Cartesian2(0, 2 - 12 * (1 - ease));
		viewer.scene.requestRender();
		if (k < 1) requestAnimationFrame(step);
	};
	step();
}
/** Pictures the ground shader of the surface view reads (lander.ts ensureMaterial: 7, and the Sun shadow map in sunShadow.ts). */
const GROUND_SHADER_TEXTURES = 8;
/** Which kinds of special place show, from the layer switches (`on` = the globe is showing and you are not standing on it). */
function placeFlags(on, l) {
	return {
		artemis: on && !!l.artemis,
		spot: on && !!l.artemis,
		mission: on && !!l.missions,
		active: on && !!l.missions,
		planned: on && l.sitesPlanned !== false,
		ice: on && !!l.waterice
	};
}
const tagOf = (id) => id?.moonda;
const WHOLE = {
	lat: -35,
	lon: 10,
	alt: 65e5
};
const SCIENCE_SWITCHES = new Set([
	"psr",
	"waterice",
	"danger",
	"slope",
	"height"
]);
const scienceSources = (def) => def.rasterSources ?? [{
	url: `./data/layers/${def.id}.png`,
	projection: "polar",
	pole: "south",
	extentM: POLAR_EXTENT_M,
	clipTrueLatDeg: -80.02
}];
function prepareScienceLayers(viewer, layers, defs) {
	for (const def of defs) {
		if (!SCIENCE_SWITCHES.has(def.id)) continue;
		const id = def.id === "height" ? "heightPolar" : def.id;
		if (layers.has(id)) continue;
		const layer = new ImageryLayer(createScienceRasterProvider({
			sources: scienceSources(def),
			credit: def.source?.name ?? "NASA",
			maximumLevel: SHARP_POLAR_LAYERS.has(def.id) ? 10 : 9
		}), { show: false });
		viewer.imageryLayers.add(layer);
		layers.set(id, layer);
	}
}
export const MoonMap = _s(forwardRef(_c4 = _s(function MoonMap(props, ref) {
	_s();
	const host = useRef(null);
	const viewerRef = useRef(null);
	const imagery = useRef(new Map());
	const heightsRef = useRef(null);
	const labelsRef = useRef(null);
	const navRef = useRef(null);
	const landerRef = useRef(null);
	const markersRef = useRef(null);
	const skyRef = useRef(null);
	const selectedEntity = useRef(null);
	const pinEntities = useRef(new Map());
	const cb = useRef(props);
	cb.current = props;
	const namesLoaded = useRef(() => {});
	const skipPreload = useRef(false);
	const flatRef = useRef(null);
	const modesRef = useRef(null);
	useEffect(() => {
		const heights = new MoonHeights(new URL("./data/", document.baseURI).href);
		heightsRef.current = heights;
		const viewer = new Viewer(host.current, {
			globe: new Globe(MOON_ELLIPSOID),
			baseLayer: false,
			terrainProvider: new EllipsoidTerrainProvider({ ellipsoid: MOON_ELLIPSOID }),
			animation: false,
			timeline: false,
			baseLayerPicker: false,
			geocoder: false,
			homeButton: false,
			sceneModePicker: false,
			navigationHelpButton: false,
			fullscreenButton: false,
			infoBox: false,
			selectionIndicator: false,
			skyAtmosphere: false,
			scene3DOnly: true,
			requestRenderMode: true,
			maximumRenderTimeChange: Infinity,
			useBrowserRecommendedResolution: false,
			msaaSamples: knobs(initQuality()).msaaSamples,
			creditContainer: document.getElementById("cesium-credits") ?? undefined
		});
		viewerRef.current = viewer;
		// Cesium draws as many map layers per ground tile as the graphics card has texture slots (16 on many), but it
		// does not count the 8 pictures our own ground shader reads (lander.ts: hill shadows, heights, soil scans, rock
		// shadows, the Sun shadow map). With 9 or more layers on one tile the shader then asked for more slots than
		// exist and rendering stopped ("texture image units count exceeds MAX_TEXTURE_IMAGE_UNITS"). Tell Cesium the
		// slots that are really left: it then draws a tile with many layers in two passes instead.
		const limits = Cesium.ContextLimits;
		if (limits && typeof limits._maximumTextureImageUnits === "number") limits._maximumTextureImageUnits = Math.max(4, limits._maximumTextureImageUnits - GROUND_SHADER_TEXTURES);
		// Small test/debug hook (used by scripts/drive.mjs): is the map finished loading what is on screen?
		window.__viewer = viewer;
		// idle(): start-up loading is over and the map has nothing left to load for what is on screen
		const debugHook = { viewer };
		debugHook.idle = () => !viewer.isDestroyed() && debugHook.progress?.done === true && scene.globe.tilesLoaded;
		window.__moonda = debugHook;
		if (import.meta.env.DEV) void import("/node_modules/.vite/deps/cesium.js?v=f79bc84e").then((m) => {
			window.__moondaCesium = m;
		});
		const scene = viewer.scene;
		scene.backgroundColor = Color.fromCssColorString("#04050a");
		scene.fog.enabled = false;
		if (scene.sun) scene.sun.show = false;
		if (scene.moon) scene.moon.show = false;
		const globe = scene.globe;
		globe.baseColor = Color.fromCssColorString("#3a3c41");
		globe.showGroundAtmosphere = false;
		globe.dynamicAtmosphereLighting = false;
		globe.lightingFadeOutDistance = 0;
		globe.lightingFadeInDistance = 1;
		// sharpness, drawing size, edge smoothing and tile caching come from the graphics mode (app/quality.ts),
		// and follow it live when the person switches mode (also while the start screen is loading)
		applyQuality(viewer);
		const offQuality = settings.subscribe((s, prev) => {
			if (s.quality !== prev.quality) applyQuality(viewer, s.quality);
		});
		globe.depthTestAgainstTerrain = true;
		globe.vertexShadowDarkness = .2;
		globe.lambertDiffuseMultiplier = 1.15;
		// Redraw only when something changes, but keep drawing while tiles are still arriving.
		let lastPhotoCull = 0;
		let lastPhotoMove = -Infinity;
		let photoCullTimer;
		const offPhotoCull = viewer.camera.changed.addEventListener(() => {
			lastPhotoMove = performance.now();
			clearTimeout(photoCullTimer);
			photoCullTimer = setTimeout(() => cancelOffscreenImagery(viewer), 400);
		});
		scene.postRender.addEventListener(() => {
			if (!globe.tilesLoaded) scene.requestRender();
			const now = performance.now();
			// Cesium also prepares a rim of neighbouring terrain. Once the camera settles, let
			// those jobs finish: repeatedly culling that rim would make it request them forever.
			if (now - lastPhotoCull > 100 && (now - lastPhotoMove < 350 || !globe.tilesLoaded)) {
				lastPhotoCull = now;
				cancelOffscreenImagery(viewer, now - lastPhotoMove < 350);
			}
		});
		viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
		heights.ready.then(() => {
			if (!viewer.isDestroyed() && cb.current.layers.terrain !== false) viewer.terrainProvider = new LolaTerrainProvider(heights);
		});
		heights.ready.then(() => shareHeights(heights)).catch(() => {});
		setExploreHeights(heights);
		// Photos and optional map layers (all re-projected into the rotated display frame).
		const add = (id, layer) => {
			viewer.imageryLayers.add(layer);
			imagery.current.set(id, layer);
		};
		// Bottom: a whole-Moon picture stored locally, so the Moon is never blank and works without internet.
		add("base", new ImageryLayer(createBaseMosaicProvider({
			url: "./data/base/v5/",
			credit: "NASA Moon Trek · LRO WAC, LOLA; NASA SVS CGI Moon Kit; LROC WAC polar summer mosaics · NASA/GSFC/ASU"
		})));
		// Sharper sources are chosen inside this provider, so they use no extra texture slot.
		add("photo", new ImageryLayer(createMoonTrekProvider({
			layer: "LRO_WAC_Mosaic_Global_303ppd_v02",
			ext: "jpg",
			maxSourceLevel: 8,
			minTrueLat: -81.5,
			credit: "NASA/GSFC/ASU · LRO WAC/NAC; ISAS/JAXA · Kaguya TC; Lunar QuickMap · NASA, Intuitive Machines, ACT",
			overBase: true,
			sharpPhoto: true
		})));
		// Where NASA's WAC mosaic is lit from the other side (true lon -180..-90): albedo x hillshade instead, so no seam shows.
		add("photoFix", new ImageryLayer(createSeamFixProvider({ credit: "NASA Moon Trek · LOLA / SLDEM2015 hillshade; NASA SVS CGI Moon Kit" })));
		add("photoPolar", new ImageryLayer(createPolarRasterProvider({
			url: "./data/base/southpole4096.jpg",
			extentM: POLAR_EXTENT_M,
			credit: "LROC WAC/NAC · Lunaserv",
			maximumLevel: 8
		})));
		// Sharp south-pole photos: read from the local store first (public/data/polar/t), the remote server only where nothing is stored.
		// The layer names must match the stored set exactly.
		add("polarPhoto", new ImageryLayer(createPolarPyramidProvider({
			layers: "luna_wac_roi_south_summer,luna_nac_pole_control_south",
			minK: 4,
			credit: "LROC NAC south-pole mosaic · NASA/GSFC/ASU"
		}), { show: false }));
		add("height", new ImageryLayer(createMoonTrekProvider({
			...HEIGHT_TREK,
			maxSourceLevel: 6,
			credit: "NASA Moon Trek · LRO LOLA"
		}), {
			show: false,
			alpha: .75
		}));
		// After a failed download is retried, draw once so the refilled tiles start loading.
		const offReload = imageryReloaded.addEventListener(() => {
			if (!viewer.isDestroyed()) scene.requestRender();
		});
		// The real sky: Milky Way, stars, planets, a 3D Earth and the Sun, all in their true directions.
		const sky = new SpaceSky(viewer, { heights });
		skyRef.current = sky;
		debugHook.sky = sky;
		// The lander view only adds name tags for the Sun and Earth; the sky draws the bodies themselves.
		// The lander view dims the stars and Milky Way when sunlit ground or the Sun is in view (as a camera would).
		const lander = new LanderView(viewer, heights, {
			ownBodies: false,
			onSkyExposure: (v) => {
				sky.exposure = v;
			}
		});
		landerRef.current = lander;
		debugHook.lander = lander;
		debugHook.heights = heights;
		// Clicking the Sun or Earth chip glides the camera to a view where that body shows above the Moon's edge.
		markersRef.current = new SkyMarkers(viewer, { onPick: (_body, dir) => {
			if (!lander.active) void navRef.current?.showBody(dir);
		} });
		const labels = new NameLabels(viewer);
		labelsRef.current = labels;
		if (import.meta.env.DEV) window.__labels = labels;
		heights.ready.then(() => {
			if (viewer.isDestroyed()) return;
			// Artemis regions, famous spots and past landings: icon + name, both placed by the label manager so nothing overlaps
			labels.setPlaces(PLACES, heights, Object.fromEntries(Object.entries(ICON).map(([k, image]) => [k, {
				image,
				size: k === "mission" ? 20 : 22
			}])));
			labels.update();
			scene.requestRender();
		});
		// Names and icons keep clear of the pins and of the Sun/Earth spots.
		const pinScratchR = new Cartesian3(), pinWinR = new Cartesian2();
		labels.reserved = [
			() => {
				const out = [];
				if (cb.current.lander) return out;
				const list = [...cb.current.pins];
				if (cb.current.selectedPin) list.push(cb.current.selectedPin);
				const camPos = viewer.camera.positionWC;
				for (const pin of list) {
					const pos = toCartesian(pin.lat, pin.lon, heights.heightAt(pin.lat, pin.lon, false), pinScratchR);
					const toCam = Cartesian3.subtract(camPos, pos, new Cartesian3());
					if (Cartesian3.dot(toCam, pos) < -.08 * Cartesian3.magnitude(toCam) * Cartesian3.magnitude(pos)) continue;
					const w = scene.cartesianToCanvasCoordinates(pos, pinWinR);
					if (w) out.push({
						x0: w.x - 15,
						y0: w.y - 37,
						x1: w.x + 15,
						y1: w.y + 2
					});
				}
				return out;
			},
			() => markersRef.current?.spotBoxes() ?? [],
			() => {
				const out = [];
				const c = scene.canvas.getBoundingClientRect();
				for (const el of document.querySelectorAll(".panel, .ibtn.glass")) {
					const r = el.getBoundingClientRect();
					if (r.width < 2 || r.height < 2) continue;
					out.push({
						x0: r.left - c.left - 6,
						y0: r.top - c.top - 4,
						x1: r.right - c.left + 6,
						y1: r.bottom - c.top + 4
					});
				}
				return out;
			}
		];
		let lastLabel = 0, settle = 0;
		const readBars = () => {
			const st = getComputedStyle(document.documentElement);
			const dock = parseFloat(st.getPropertyValue("--dock"));
			if (Number.isFinite(dock) && dock > 0) labels.bottom = dock + 8;
		};
		// Pins are drawn on top of everything (never cut by a hill), so hide the ones round the far side by hand.
		const pinFacing = () => {
			const cam = viewer.camera.positionWC;
			const ents = [...pinEntities.current.values()];
			if (selectedEntity.current) ents.push(selectedEntity.current);
			for (const e of ents) {
				const p = e.position?.getValue(undefined);
				if (!p) continue;
				const toCam = Cartesian3.subtract(cam, p, new Cartesian3());
				const show = Cartesian3.dot(toCam, p) > .01 * Cartesian3.magnitude(toCam) * Cartesian3.magnitude(p);
				if (e.show !== show) e.show = show;
			}
		};
		debugHook.pinFacing = pinFacing;
		const relabel = () => {
			readBars();
			pinFacing();
			labels.update();
			scene.requestRender();
		};
		const report = () => {
			const hp = cameraHeadingPitch(viewer);
			cameraStore.set({
				km: hp.km,
				heading: lander.active ? lander.headingDeg() : hp.heading,
				pitch: hp.pitch
			});
		};
		viewer.camera.changed.addEventListener(() => {
			report();
			const now = performance.now();
			if (now - lastLabel > 90) {
				lastLabel = now;
				relabel();
			}
			clearTimeout(settle);
			settle = window.setTimeout(relabel, 140);
		});
		viewer.camera.percentageChanged = .002;
		// Window or panel resized: names must be re-fitted to the new screen size.
		const resizeObs = new ResizeObserver(() => {
			clearTimeout(settle);
			settle = window.setTimeout(relabel, 60);
			flatRef.current?.resize();
		});
		resizeObs.observe(host.current);
		// A panel opened or closed (info panel, Compare, Layers): re-place the names once it has slid in.
		const appEl = host.current.closest(".app");
		const panelObs = new MutationObserver(() => {
			clearTimeout(settle);
			settle = window.setTimeout(relabel, 260);
		});
		if (appEl) panelObs.observe(appEl, {
			childList: true,
			attributes: true,
			attributeFilter: ["class"]
		});
		// What is under the pointer? Screen-space maths only (asking the GPU costs 10-200 ms per question).
		const pickPos = new Cartesian2(), pinScratch = new Cartesian3(), pinWin = new Cartesian2();
		const groundAt = (x, y) => {
			const ray = viewer.camera.getPickRay(Cartesian2.fromElements(x, y, pickPos));
			const hit = ray && globe.pick(ray, scene);
			if (!hit) return null;
			const t = toTrueLatLon(hit);
			return {
				lat: t.lat,
				lon: t.lon
			};
		};
		const tagAt = (x, y) => tagOf(labels.hitTest(x, y));
		/** A compare pin (or the selected pin) drawn at this screen position, if any. */
		const pinAt = (x, y) => {
			const list = [...cb.current.pins];
			if (cb.current.selectedPin) list.push(cb.current.selectedPin);
			for (const pin of list) {
				const w = scene.cartesianToCanvasCoordinates(toCartesian(pin.lat, pin.lon, heights.heightAt(pin.lat, pin.lon, false), pinScratch), pinWin);
				if (w && x >= w.x - 15 && x <= w.x + 15 && y >= w.y - 40 && y <= w.y + 2) return {
					lat: pin.lat,
					lon: pin.lon
				};
			}
			return null;
		};
		let lastHover = 0;
		navRef.current = attachNavigation(viewer, heights, {
			onFovWheel: (d) => lander.zoomFov(d),
			isClickableAt: (x, y) => !!tagAt(x, y) || !!pinAt(x, y),
			// Click: a name or marker first, then a pin, otherwise drop a new pin on the ground.
			onClick: (x, y) => {
				if (lander.active) return;
				if (cb.current.choosingDestination) {
					const g = groundAt(x, y);
					if (g) cb.current.onRouteDestination?.(g.lat, g.lon);
					return;
				}
				const tag = tagAt(x, y);
				if (tag?.type === "name" && tag.name) return cb.current.onSelect({
					type: "name",
					name: tag.name
				});
				if (tag?.type === "place" && tag.place) return cb.current.onSelect({
					type: "place",
					place: tag.place
				});
				const g = pinAt(x, y) ?? groundAt(x, y);
				if (g) cb.current.onSelect({
					type: "pin",
					...g
				});
			},
			onHoverMove: (x, y) => {
				labels.setHover(labels.hitTest(x, y));
				const now = performance.now();
				if (now - lastHover > 80) {
					lastHover = now;
					cb.current.onHover(groundAt(x, y));
				}
			}
		});
		debugHook.nav = navRef.current;
		// The flat map (2D) and the move between it and the globe (flatMap.ts, mapMode.ts).
		const flat = new FlatMap(host.current, {
			labels: () => labels.flatEntries(),
			route: () => cb.current.overviewRoute ?? null,
			destination: () => cb.current.routeDestination ?? null,
			choosingDestination: () => !!cb.current.choosingDestination,
			icon: (kind) => labels.iconOf(kind),
			pins: () => {
				const out = cb.current.pins.map((p) => ({
					lat: p.lat,
					lon: p.lon,
					image: PIN_SVG(p.color, p.letter)
				}));
				if (cb.current.selectedPin) out.push({
					...cb.current.selectedPin,
					image: PIN_SVG("")
				});
				return out;
			},
			panelBoxes: () => {
				const out = [];
				const c = host.current.getBoundingClientRect();
				for (const el of document.querySelectorAll(".panel, .ibtn.glass, .tbar-clock")) {
					const r = el.getBoundingClientRect();
					if (r.width >= 2 && r.height >= 2) out.push({
						x0: r.left - c.left - 6,
						y0: r.top - c.top - 4,
						x1: r.right - c.left + 6,
						y1: r.bottom - c.top + 4
					});
				}
				return out;
			},
			// fixed margins (the button column, the top bar, the time bar): panels opening later must not shift the map
			insets: () => ({
				top: labels.top + 8,
				bottom: labels.bottom + 34,
				left: 64,
				right: 76
			}),
			onClickTag: (id) => {
				const tag = tagOf(id);
				if (tag?.type === "name" && tag.name) cb.current.onSelect({
					type: "name",
					name: tag.name
				});
				else if (tag?.type === "place" && tag.place) cb.current.onSelect({
					type: "place",
					place: tag.place
				});
			},
			onClickGround: (lat, lon) => {
				if (cb.current.choosingDestination) cb.current.onRouteDestination?.(lat, lon);
				else cb.current.onSelect({
					type: "pin",
					lat,
					lon
				});
			},
			onHover: (pos) => cb.current.onHover(pos),
			// the status line's eye height: the height a camera would need to see what the flat map shows
			onView: (km) => cameraStore.set({
				km,
				heading: 0,
				pitch: -90
			}),
			// zooming in at the flat map's closest zoom: offer to roll back to the globe right there
			limitText: () => ({
				msg: t("map.flatLimit"),
				go: t("map.flatCloser")
			}),
			onCloser: (lat, lon) => {
				void modesRef.current?.toGlobe({ at: {
					lat,
					lon,
					km: 140
				} });
			}
		});
		flatRef.current = flat;
		const modes = new MapModes(flat, {
			viewer,
			nav: navRef.current,
			heightAt: (lat, lon) => heights.heightAt(lat, lon, false),
			setGlobeExtras: (on) => {
				const p = cb.current;
				labels.visible = on && !!p.layers.names && !p.lander;
				labels.placesVisible = placeFlags(on && !p.lander, p.layers);
				labels.update();
				const m = markersRef.current;
				if (m) m.show = on && p.layers.realSun !== false && !p.lander;
				viewer.entities.show = on;
				scene.requestRender();
			}
		});
		modes.onChange = (m) => cb.current.onMapMode?.(m);
		modesRef.current = modes;
		debugHook.flat = flat;
		debugHook.modes = modes;
		// Start: whole Moon, tilted so the south pole is visible, true north up.
		const start = poseGlobe(WHOLE.lat, WHOLE.lon, WHOLE.alt);
		viewer.camera.setView({
			destination: start.destination,
			orientation: {
				direction: start.direction,
				up: start.up
			}
		});
		report();
		// Behind the loading screen: load data and quietly visit the south-pole views so they are instant later.
		const debug = debugHook;
		debug.skipLoading = () => {
			skipPreload.current = true;
		};
		navRef.current.enabled = false;
		void runPreload(viewer, {
			heightsReady: heights.ready,
			namesReady: new Promise((res) => {
				namesLoaded.current = res;
			}),
			startView: start,
			skyReady: sky.ready,
			imageryPending,
			lander,
			// Fetch the maps, then prepare their real providers while the start screen is still up.
			layerFiles: () => loadManifest().catch(() => []).then((list) => [
				...list.filter((e) => SCIENCE_SWITCHES.has(e.id)).flatMap((e) => "rasterSources" in e && Array.isArray(e.rasterSources) ? e.rasterSources.map((s) => s.url) : [`./data/layers/${e.id}.png`]).map((url) => new URL(url, document.baseURI).href),
				new URL("./data/features/craters.bin", document.baseURI).href,
				new URL("./data/features/craters-small-south.bin", document.baseURI).href,
				...flatTrekTiles(HEIGHT_TREK.layer, HEIGHT_TREK.ext)
			]),
			warmLayers: async (onFrac) => {
				const defs = (await loadManifest()).map(scienceToLayer).filter((d) => SCIENCE_SWITCHES.has(d.id));
				if (viewer.isDestroyed()) return;
				prepareScienceLayers(viewer, imagery.current, defs);
				await warmScienceRasters(defs.flatMap(scienceSources), onFrac);
				// Each map has a ready parent tile everywhere, even after the camera moves.
				const providers = [...defs.map((d) => imagery.current.get(d.id === "height" ? "heightPolar" : d.id)?.imageryProvider), imagery.current.get("height")?.imageryProvider];
				for (const provider of providers) if (provider) {
					for (const x of [0, 1]) {
						const image = await provider.requestImage(x, 0, 0);
						if (image instanceof ImageBitmap) image.close();
					}
				}
			},
			warmViews: () => {
				const ridge = {
					lat: -89.45,
					lon: -136.7
				};
				const g = heights.heightAt(ridge.lat, ridge.lon, false);
				return [
					{
						pose: poseLookingAt(-90, 0, 0, 82e4, 0, -90),
						label: "Getting the south pole ready…",
						maxMs: 6e3
					},
					{
						pose: poseLookingAt(ridge.lat, ridge.lon, g, 9e4, 20, -38),
						label: "Building the 3D mountains…",
						maxMs: 5e3
					},
					{
						pose: poseLookingAt(ridge.lat, ridge.lon, g, 12e3, 60, -18),
						label: "Sharpening the landing area…",
						maxMs: 4e3
					}
				];
			},
			onProgress: (p) => {
				debug.progress = p;
				if (p.done && navRef.current && !lander.active) navRef.current.enabled = true;
				// the flat map's picture and shaders, quietly, once the start-up loading is over (the first switch must not hitch)
				if (p.done) {
					const go = () => void flat.prepare(settings.get().quality === "light").catch((e) => console.warn("Flat map not available:", e));
					if ("requestIdleCallback" in window) requestIdleCallback(go, { timeout: 1500 });
					else setTimeout(go, 300);
				}
				cb.current.onLoadProgress?.(p);
			},
			cancelled: () => skipPreload.current
		});
		return () => {
			flat.destroy();
			offQuality();
			offReload();
			offPhotoCull();
			clearTimeout(photoCullTimer);
			resizeObs.disconnect();
			panelObs.disconnect();
			clearTimeout(settle);
			navRef.current?.destroy();
			lander.destroy();
			markersRef.current?.destroy();
			labels.destroy();
			sky.destroy();
			skyRef.current = null;
			viewer.destroy();
			viewerRef.current = null;
		};
	}, []);
	// Names
	useEffect(() => {
		const labels = labelsRef.current, heights = heightsRef.current;
		if (!labels || !heights || !props.names) return;
		let live = true;
		Promise.all([document.fonts.load("500 13px \"Inter Variable\""), heights.ready]).finally(() => {
			if (!live) return;
			labels.setNames(props.names, heights);
			labels.update();
			namesLoaded.current();
			viewerRef.current?.scene.requestRender();
		});
		return () => {
			live = false;
		};
	}, [props.names]);
	// Layers
	useEffect(() => {
		const viewer = viewerRef.current;
		if (!viewer) return;
		if (props.layers.dataDetail && !imagery.current.get("dataDetail")) {
			const layer = createDataDetailLayer();
			viewer.imageryLayers.add(layer);
			imagery.current.set("dataDetail", layer);
		}
		createCraterLayer(viewer, () => flatRef.current, (lat, lon) => heightsRef.current?.heightAt(lat, lon, false) ?? 0).show = !!props.layers.craters && !props.lander;
		prepareScienceLayers(viewer, imagery.current, props.scienceLayers);
		for (const [id, layer] of imagery.current) {
			layer.show = id === "photoPolar" || id === "base" || id === "photoFix" ? !!props.layers.photo : id === "heightPolar" ? !!props.layers.height : !!props.layers[id];
			const opKey = id === "heightPolar" ? "height" : id === "base" || id === "photoFix" ? "photo" : id;
			layer.alpha = id === "dataDetail" ? 1 : id === "craters" ? 1 : props.opacity[opKey] ?? (id === "photo" || id === "base" || id === "photoFix" || id === "photoPolar" || id === "polarPhoto" ? 1 : .7);
		}
		for (const def of props.scienceLayers) {
			const l = imagery.current.get(def.id === "height" ? "heightPolar" : def.id);
			if (l) viewer.imageryLayers.raiseToTop(l);
		}
		const dd = imagery.current.get("dataDetail");
		if (dd) viewer.imageryLayers.raiseToTop(dd);
		const cr = imagery.current.get("craters");
		if (cr) viewer.imageryLayers.raiseToTop(cr);
		const labels = labelsRef.current;
		const onGlobe = (modesRef.current?.mode ?? "globe") === "globe" && !modesRef.current?.moving;
		if (labels) {
			labels.visible = onGlobe && !!props.layers.names && !props.lander;
			labels.placesVisible = placeFlags(onGlobe && !props.lander, props.layers);
			labels.flatNames = !!props.layers.names;
			labels.flatPlaces = placeFlags(true, props.layers);
			labels.update();
		}
		const flat = flatRef.current;
		if (flat) {
			flat.detail = props.layers.dataDetail ? 1 : 0;
			flat.photo = props.layers.photo !== false;
			// the coloured layers, in the globe's order: Height colours first, then the south-pole maps
			const over = [];
			if (props.layers.height) {
				const a = props.opacity.height ?? .7;
				over.push({
					id: "height",
					kind: "global",
					layer: HEIGHT_TREK.layer,
					ext: HEIGHT_TREK.ext,
					latMin: HEIGHT_TREK.minTrueLat,
					alpha: a
				});
				if (props.scienceLayers.some((d) => d.id === "height")) over.push({
					id: "heightPolar",
					kind: "polar",
					url: "./data/layers/height.png",
					alpha: a
				});
			}
			for (const def of props.scienceLayers) if (def.id !== "height" && props.layers[def.id]) over.push({
				id: def.id,
				kind: "polar",
				url: `./data/layers/${def.id}.png`,
				alpha: props.opacity[def.id] ?? .7
			});
			flat.setOverlays(over);
			flat.refreshLabels();
		}
		viewer.scene.requestRender();
	}, [
		props.layers,
		props.opacity,
		props.scienceLayers,
		props.lander
	]);
	// 3D mountains on/off
	useEffect(() => {
		const viewer = viewerRef.current, heights = heightsRef.current;
		if (!viewer || !heights) return;
		heights.ready.then(() => {
			if (viewer.isDestroyed()) return;
			const want3d = props.layers.terrain !== false;
			const is3d = viewer.terrainProvider instanceof LolaTerrainProvider;
			if (want3d && !is3d) viewer.terrainProvider = new LolaTerrainProvider(heights);
			if (!want3d && is3d) viewer.terrainProvider = new EllipsoidTerrainProvider({ ellipsoid: MOON_ELLIPSOID });
		});
	}, [props.layers.terrain]);
	// A ground polyline uses the terrain's depth, including our rotated lunar tiles.
	useEffect(() => {
		const viewer = viewerRef.current;
		if (!viewer) return;
		const scene = viewer.scene;
		let live = true, line = null;
		let flag = null;
		const route = props.overviewRoute, dest = props.routeDestination;
		flatRef.current?.request();
		if (dest && !props.lander) {
			flag = viewer.entities.add({
				id: "overview-route-end",
				position: toCartesian(dest.lat, dest.lon),
				billboard: {
					image: svgUrl("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40\" height=\"44\" viewBox=\"0 0 40 44\"><path d=\"M10 44V4M11 5h23l-6 8 6 8H11\" fill=\"#acdfff\" stroke=\"#182f43\" stroke-width=\"3\" stroke-linejoin=\"round\"/><path d=\"M10 44V4\" stroke=\"#acdfff\" stroke-width=\"2\"/></svg>"),
					width: 27,
					height: 30,
					verticalOrigin: VerticalOrigin.BOTTOM,
					horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
					pixelOffset: new Cartesian2(-7, 0),
					heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
				}
			});
		}
		const off = scene.preRender.addEventListener(() => {
			if (line) line.show = !cb.current.lander && viewer.entities.show;
		});
		if (route?.ok && route.path.length >= 4 && !props.lander) {
			void Cesium.GroundPolylinePrimitive.initializeTerrainHeights().then(() => {
				if (!live || viewer.isDestroyed()) return;
				const positions = [];
				for (let i = 0; i < route.path.length; i += 2) positions.push(toCartesian(route.path[i], route.path[i + 1]));
				line = new Cesium.GroundPolylinePrimitive({
					geometryInstances: new Cesium.GeometryInstance({ geometry: new Cesium.GroundPolylineGeometry({
						positions,
						width: 5
					}) }),
					appearance: new Cesium.PolylineMaterialAppearance({ material: Cesium.Material.fromType("PolylineOutline", {
						color: Color.fromCssColorString("#acdfff").withAlpha(.94),
						outlineColor: Color.fromCssColorString("#182f43").withAlpha(.9),
						outlineWidth: 1
					}) }),
					classificationType: Cesium.ClassificationType.TERRAIN,
					asynchronous: false,
					allowPicking: false
				});
				// Cesium ships Earth's height bounds. Some are below the lunar ground, which clips
				// the line away. Only while this synchronous primitive builds its volume, give it
				// a generous lunar envelope; the visible line still clamps to the real terrain.
				const bounds = Cesium.ApproximateTerrainHeights;
				const updating = line;
				const update = updating.update.bind(line);
				updating.update = (frame) => {
					const saved = bounds.getMinimumMaximumHeights;
					const savedMax = bounds._defaultMaxTerrainHeight;
					bounds.getMinimumMaximumHeights = () => ({
						minimumTerrainHeight: -15e3,
						maximumTerrainHeight: 15e3
					});
					bounds._defaultMaxTerrainHeight = 15e3;
					try {
						update(frame);
					} finally {
						bounds.getMinimumMaximumHeights = saved;
						bounds._defaultMaxTerrainHeight = savedMax;
					}
				};
				scene.groundPrimitives.add(line);
				scene.requestRender();
			}).catch((error) => console.warn("Route line could not load:", error));
		}
		scene.requestRender();
		return () => {
			live = false;
			off();
			if (!viewer.isDestroyed()) {
				if (line) scene.groundPrimitives.remove(line);
				if (flag) viewer.entities.remove(flag);
				scene.requestRender();
			}
		};
	}, [
		props.overviewRoute,
		props.routeDestination,
		props.lander
	]);
	// Selected pin + compare pins. Placed at the real ground height and drawn over everything:
	// "clamped to ground" pins get partly cut by nearby hills in Cesium, so we do not use that.
	useEffect(() => {
		const viewer = viewerRef.current;
		if (!viewer) return;
		const h = heightsRef.current;
		const pinPos = (lat, lon) => toCartesian(lat, lon, (h?.heightAt(lat, lon, true) ?? 0) + 3);
		if (selectedEntity.current) {
			viewer.entities.remove(selectedEntity.current);
			selectedEntity.current = null;
		}
		if (props.selectedPin && !props.lander) {
			selectedEntity.current = viewer.entities.add({
				position: pinPos(props.selectedPin.lat, props.selectedPin.lon),
				billboard: {
					image: PIN_SVG(""),
					width: 38,
					height: 38,
					verticalOrigin: VerticalOrigin.BOTTOM,
					pixelOffset: new Cartesian2(0, 2),
					disableDepthTestDistance: Number.POSITIVE_INFINITY
				}
			});
			dropIn(viewer, selectedEntity.current, `${props.selectedPin.lat},${props.selectedPin.lon}`);
		}
		for (const [, e] of pinEntities.current) viewer.entities.remove(e);
		pinEntities.current.clear();
		if (!props.lander) for (const p of props.pins) {
			pinEntities.current.set(p.id, viewer.entities.add({
				position: pinPos(p.lat, p.lon),
				billboard: {
					image: PIN_SVG(p.color, p.letter),
					width: 38,
					height: 38,
					verticalOrigin: VerticalOrigin.BOTTOM,
					pixelOffset: new Cartesian2(0, 2),
					disableDepthTestDistance: Number.POSITIVE_INFINITY
				}
			}));
		}
		viewerRef.current && window.__moonda?.pinFacing?.();
		labelsRef.current?.update();
		flatRef.current?.request();
		viewer.scene.requestRender();
	}, [
		props.selectedPin,
		props.pins,
		props.lander
	]);
	// Real sunlight at the chosen time: shading of the whole Moon, the Sun/Earth chips and the sky.
	useEffect(() => {
		const viewer = viewerRef.current;
		if (!viewer) return;
		const sunOn = props.layers.realSun !== false;
		const s = trueToDisplayVec(props.bodies.sun);
		const d = Cartesian3.normalize(new Cartesian3(s[0], s[1], s[2]), new Cartesian3());
		viewer.scene.light = new DirectionalLight({
			direction: Cartesian3.negate(d, d),
			intensity: 2
		});
		viewer.scene.globe.enableLighting = sunOn;
		const m = markersRef.current;
		const flat = flatRef.current;
		if (flat) {
			const len = Math.hypot(...props.bodies.sun) || 1, le = Math.hypot(...props.bodies.earth) || 1;
			flat.sun = [
				props.bodies.sun[0] / len,
				props.bodies.sun[1] / len,
				props.bodies.sun[2] / len
			];
			flat.earth = [
				props.bodies.earth[0] / le,
				props.bodies.earth[1] / le,
				props.bodies.earth[2] / le
			];
			flat.sunOn = sunOn;
			flat.request();
		}
		const onGlobe = (modesRef.current?.mode ?? "globe") === "globe" && !modesRef.current?.moving;
		if (m) {
			m.show = sunOn && !props.lander && onGlobe;
			m.spots = props.layers.skymarkers === true;
			m.update(props.bodies.sun, props.bodies.earth);
			labelsRef.current?.update();
		}
		skyRef.current?.update(props.timeMs ?? Date.now(), props.bodies);
		viewer.scene.requestRender();
	}, [
		props.layers.realSun,
		props.layers.skymarkers,
		props.bodies,
		props.lander,
		props.timeMs
	]);
	// Stars, Milky Way, planets and their name tags follow the layer switches (the Sun and Earth are always drawn).
	useEffect(() => {
		const sky = skyRef.current;
		if (!sky) return;
		const stars = props.layers.stars !== false;
		sky.show = {
			stars,
			milkyWay: stars,
			planets: stars,
			earth: true,
			sun: true,
			names: stars && props.layers.skyNames !== false
		};
		viewerRef.current?.scene.requestRender();
	}, [props.layers.stars, props.layers.skyNames]);
	// First-person lander view
	const landerKey = props.lander ? `${props.lander.lat},${props.lander.lon},${props.lander.mastM},${!!props.lander.skyline}` : "";
	useEffect(() => {
		const lander = landerRef.current, nav = navRef.current;
		if (!lander || !nav) return;
		if (props.lander && props.sky) {
			const spec = props.lander, sky = props.sky;
			const go = () => {
				nav.enabled = false;
				lander.enter(spec, sky, spec.faceAz);
			};
			const modes = modesRef.current;
			// from the flat map: first a shortened move back to the globe at that spot
			if (modes && modes.mode === "flat") void modes.toGlobe({
				at: {
					lat: spec.lat,
					lon: spec.lon,
					km: 40
				},
				fast: true,
				handOff: go
			});
			else go();
		} else if (!props.lander && lander.active) {
			lander.exit();
			nav.enabled = true;
		}
	}, [landerKey]);
	useEffect(() => {
		if (props.sky) landerRef.current?.updateSky(props.sky);
	}, [props.sky]);
	const flatOn = () => modesRef.current?.mode === "flat" && !modesRef.current.moving ? flatRef.current : null;
	useImperativeHandle(ref, () => ({
		flyTo(lat, lon, heightKm = 60, tilted = false) {
			const v = viewerRef.current;
			if (!v || modesRef.current?.moving) return;
			const flat = flatOn();
			if (flat) {
				void flat.flyTo(flat.viewAt(lat, lon, Math.max(20, heightKm * 1.15)));
				return;
			}
			const ground = heightsRef.current?.heightAt(lat, lon, false) ?? 0;
			const pose = tilted ? poseLookingAt(lat, lon, ground, heightKm * 1600, cameraHeadingPitch(v).heading, -38) : poseLookingAt(lat, lon, ground, heightKm * 1e3, 0, -90);
			void navRef.current?.flyTo(pose);
		},
		flyWhole() {
			const flat = flatOn();
			if (flat) {
				void flat.flyTo(flat.wholeView());
				return;
			}
			const p = poseGlobe(WHOLE.lat, WHOLE.lon, WHOLE.alt);
			void navRef.current?.flyTo(p);
		},
		flyPole() {
			// Straight down on the south pole, nearside (0° longitude) at the top — like NASA's polar maps.
			const p = poseLookingAt(-90, 0, 0, 82e4, 0, -90);
			// the pole is badly stretched on a flat map: go back to the globe and fly there
			if (modesRef.current?.mode === "flat") {
				void modesRef.current.toGlobe({
					at: {
						lat: -90,
						lon: 0,
						km: 900
					},
					pose: p
				});
				return;
			}
			void navRef.current?.flyTo(p);
		},
		zoomBy(f) {
			const flat = flatOn();
			if (flat) flat.zoomBy(f);
			else navRef.current?.zoomBy(f);
		},
		resetNorth() {
			if (!flatOn()) navRef.current?.resetNorth();
		},
		setTilt(p) {
			if (!flatOn()) navRef.current?.setTilt(p);
		},
		setMapMode(m) {
			const modes = modesRef.current;
			if (!modes || modes.moving || landerRef.current?.active || window.__moonda?.progress?.done !== true) return;
			if (m === "flat") void modes.toFlat();
			else void modes.toGlobe();
		},
		look(az, el) {
			landerRef.current?.look(az, el);
		},
		warmLayers() {
			void warmScienceRasters(cb.current.scienceLayers.filter((d) => SCIENCE_SWITCHES.has(d.id)).flatMap(scienceSources));
		}
	}), []);
	return /* @__PURE__ */ _jsxDEV("div", {
		ref: host,
		className: "moon-canvas"
	}, void 0, false, {
		fileName: _jsxFileName,
		lineNumber: 806,
		columnNumber: 10
	}, this);
}, "hWB4Sk1Kk+SdUrUFrwqolzvWBvk=")), "hWB4Sk1Kk+SdUrUFrwqolzvWBvk=");
_c5 = MoonMap;
var _c, _c2, _c3, _c4, _c5;
$RefreshReg$(_c, "PIN_SVG");
$RefreshReg$(_c2, "BADGE_SVG");
$RefreshReg$(_c3, "ICE_SVG");
$RefreshReg$(_c4, "MoonMap$forwardRef");
$RefreshReg$(_c5, "MoonMap");
import * as RefreshRuntime from "/@react-refresh";
const inWebWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
import * as __vite_react_currentExports from "/src/moon/MoonMap.tsx?t=1794658926604";
if (import.meta.hot && !inWebWorker) {
  if (!window.$RefreshReg$) {
    throw new Error(
      "@vitejs/plugin-react can't detect preamble. Something is wrong."
    );
  }

  const currentExports = __vite_react_currentExports;
  queueMicrotask(() => {
    RefreshRuntime.registerExportsForReactRefresh("/Volumes/CodexWork/Projects/MOONDA/app/src/moon/MoonMap.tsx", currentExports);
    import.meta.hot.accept((nextExports) => {
      if (!nextExports) return;
      const invalidateMessage = RefreshRuntime.validateRefreshBoundaryAndEnqueueUpdate("/Volumes/CodexWork/Projects/MOONDA/app/src/moon/MoonMap.tsx", currentExports, nextExports);
      if (invalidateMessage) import.meta.hot.invalidate(invalidateMessage);
    });
  });
}
function $RefreshReg$(type, id) { return RefreshRuntime.register(type, "/Volumes/CodexWork/Projects/MOONDA/app/src/moon/MoonMap.tsx" + ' ' + id); }
function $RefreshSig$() { return RefreshRuntime.createSignatureFunctionForTransform(); }

//# sourceMappingURL=data:application/json;base64,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aEksS0FBSyxPQUFPLFNBQVMsTUFBTSxDQUFDO0VBQzlCO0VBQ0EsT0FBTyxHQUFHO0dBQUUsTUFBTSxPQUFPLE9BQU87R0FBRyxJQUFJLE1BQU0sS0FBSyxPQUFPLENBQUM7UUFBUSxPQUFPLFNBQVMsT0FBTyxDQUFDO0VBQUc7RUFDN0YsYUFBYTtHQUFFLElBQUksQ0FBQyxPQUFPLEdBQUcsT0FBTyxTQUFTLFdBQVc7RUFBRztFQUM1RCxRQUFRLEdBQUc7R0FBRSxJQUFJLENBQUMsT0FBTyxHQUFHLE9BQU8sU0FBUyxRQUFRLENBQUM7RUFBRztFQUN4RCxXQUFXLEdBQUc7R0FDWixNQUFNLFFBQVEsU0FBUztHQUN2QixJQUFJLENBQUMsU0FBUyxNQUFNLFVBQVUsVUFBVSxTQUFTLFVBQVcsT0FBaUUsVUFBVSxVQUFVLFNBQVMsTUFBTTtHQUNoSyxJQUFJLE1BQU0sUUFBUSxLQUFLLE1BQU0sT0FBTztRQUFRLEtBQUssTUFBTSxRQUFRO0VBQ2pFO0VBQ0EsS0FBSyxJQUFJLElBQUk7R0FBRSxVQUFVLFNBQVMsS0FBSyxJQUFJLEVBQUU7RUFBRztFQUNoRCxhQUFhO0dBQ1gsS0FBSyxtQkFBbUIsR0FBRyxRQUFRLGNBQWMsUUFBTyxNQUFLLGlCQUFpQixJQUFJLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxRQUFRLGNBQWMsQ0FBQztFQUNsSDtDQUNGLElBQUksQ0FBQyxDQUFDO0NBRU4sT0FBTyx3QkFBQyxPQUFEO0VBQUssS0FBSztFQUFNLFdBQVU7Q0FBZTs7Ozs7QUFDbEQsa0NBQUMiLCJuYW1lcyI6W10sInNvdXJjZXMiOlsiTW9vbk1hcC50c3giXSwidmVyc2lvbiI6Mywic291cmNlc0NvbnRlbnQiOlsiLy8gVGhlIDNEIE1vb24uIENlc2l1bUpTIHN0cmVhbXMgc21hbGwgbWFwIHRpbGVzIGZvciB3aGF0ZXZlciBpcyBvbiBzY3JlZW4sIHNvIHpvb21pbmcgc3RheXNcbi8vIHNtb290aCBhbmQgZGV0YWlsIGtlZXBzIHNoYXJwZW5pbmcgYXMgeW91IGdldCBjbG9zZXIgKHRoZSBzYW1lIGlkZWEgYXMgR29vZ2xlIEVhcnRoKS5cbi8vIE1vdW50YWlucyBhcmUgcmVhbCAzRCBzaGFwZXMgZnJvbSBOQVNBJ3MgTE9MQSBoZWlnaHRzLCBsaXQgYnkgdGhlIFN1biBhdCB0aGUgY2hvc2VuIHRpbWUuXG4vL1xuLy8gVGhlIE1vb24gaXMgcm90YXRlZCBpbnNpZGUgQ2VzaXVtIHNvIHRoZSBzb3V0aCBwb2xlIGlzIG9uIENlc2l1bSdzIGVxdWF0b3IgKHNlZSBmcmFtZS50cykuXG4vLyBBbHdheXMgY29udmVydCB3aXRoIGZyYW1lLnRzOiBuZXZlciBmZWVkIHRydWUgbGF0L2xvbiBzdHJhaWdodCBpbnRvIENlc2l1bS5cblxuaW1wb3J0ICcuL2VsbGlwc29pZCc7XG5pbXBvcnQgKiBhcyBDZXNpdW0gZnJvbSAnY2VzaXVtJztcbmltcG9ydCB7XG4gIENhcnRlc2lhbjIsIENhcnRlc2lhbjMsIENvbG9yLCBEaXJlY3Rpb25hbExpZ2h0LCBFbGxpcHNvaWRUZXJyYWluUHJvdmlkZXIsIEdsb2JlLCBJbWFnZXJ5TGF5ZXIsXG4gIFNjcmVlblNwYWNlRXZlbnRUeXBlLCBWZXJ0aWNhbE9yaWdpbiwgVmlld2VyLCB0eXBlIEVudGl0eSxcbn0gZnJvbSAnY2VzaXVtJztcbmltcG9ydCB7IGZvcndhcmRSZWYsIHVzZUVmZmVjdCwgdXNlSW1wZXJhdGl2ZUhhbmRsZSwgdXNlUmVmIH0gZnJvbSAncmVhY3QnO1xuaW1wb3J0IHR5cGUgeyBNb29uTmFtZSB9IGZyb20gJy4uL2RhdGEvbmFtZXMnO1xuaW1wb3J0IHsgUExBQ0VTLCB0eXBlIFBsYWNlIH0gZnJvbSAnLi4vZGF0YS9wbGFjZXMnO1xuaW1wb3J0IHR5cGUgeyBWZWMzIH0gZnJvbSAnLi4vc2NpZW5jZS9lcGhlbWVyaXMnO1xuaW1wb3J0IHsgc2hhcmVIZWlnaHRzIH0gZnJvbSAnLi4vc2NpZW5jZS9jbGllbnQnO1xuaW1wb3J0IHR5cGUgeyBSb3V0ZVJlc3VsdCB9IGZyb20gJy4uL3NjaWVuY2Uvcm91dGUnO1xuaW1wb3J0IHsgTW9vbkhlaWdodHMgfSBmcm9tICcuLi9zY2llbmNlL2hlaWdodHMnO1xuaW1wb3J0IHsgY2FtZXJhU3RvcmUgfSBmcm9tICcuLi91aS9zdG9yZXMnO1xuaW1wb3J0IHsgTU9PTl9FTExJUFNPSUQgfSBmcm9tICcuL2VsbGlwc29pZCc7XG5pbXBvcnQgeyB0b0NhcnRlc2lhbiwgdG9UcnVlTGF0TG9uLCB0cnVlVG9EaXNwbGF5VmVjIH0gZnJvbSAnLi9mcmFtZSc7XG5pbXBvcnQgeyBjYW5jZWxPZmZzY3JlZW5JbWFnZXJ5LCBjcmVhdGVCYXNlTW9zYWljUHJvdmlkZXIsIGNyZWF0ZU1vb25UcmVrUHJvdmlkZXIsIGNyZWF0ZVBvbGFyUHlyYW1pZFByb3ZpZGVyLCBjcmVhdGVQb2xhclJhc3RlclByb3ZpZGVyLCBjcmVhdGVTY2llbmNlUmFzdGVyUHJvdmlkZXIsIGNyZWF0ZVNlYW1GaXhQcm92aWRlciwgaW1hZ2VyeVBlbmRpbmcsIGltYWdlcnlSZWxvYWRlZCwgd2FybVNjaWVuY2VSYXN0ZXJzIH0gZnJvbSAnLi9pbWFnZXJ5JztcbmltcG9ydCB7IGNyZWF0ZUNyYXRlckxheWVyIH0gZnJvbSAnLi9jcmF0ZXJMYXllcic7XG5pbXBvcnQgeyBOYW1lTGFiZWxzIH0gZnJvbSAnLi9sYWJlbHMnO1xuaW1wb3J0IHsgTGFuZGVyVmlldywgdHlwZSBMYW5kZXJTcGVjLCB0eXBlIFNreVN0YXRlIH0gZnJvbSAnLi9sYW5kZXInO1xuaW1wb3J0IHsgUE9MQVJfRVhURU5UX00sIFNIQVJQX1BPTEFSX0xBWUVSUywgc2NpZW5jZVRvTGF5ZXIsIHR5cGUgTGF5ZXJEZWYsIHR5cGUgU2NpZW5jZVJhc3RlclNvdXJjZSB9IGZyb20gJy4vbGF5ZXJzJztcbmltcG9ydCB7IExvbGFUZXJyYWluUHJvdmlkZXIgfSBmcm9tICcuL2xvbGFUZXJyYWluJztcbmltcG9ydCB7IGF0dGFjaE5hdmlnYXRpb24sIGNhbWVyYUhlYWRpbmdQaXRjaCwgcG9zZUdsb2JlLCBwb3NlTG9va2luZ0F0LCB0eXBlIE5hdmlnYXRpb24gfSBmcm9tICcuL25hdmlnYXRpb24nO1xuaW1wb3J0IHsgcnVuUHJlbG9hZCwgdHlwZSBMb2FkUHJvZ3Jlc3MgfSBmcm9tICcuL3ByZWxvYWQnO1xuaW1wb3J0IHsgYXBwbHlRdWFsaXR5LCBpbml0UXVhbGl0eSwga25vYnMgfSBmcm9tICcuLi9hcHAvcXVhbGl0eSc7XG5pbXBvcnQgeyBzZXR0aW5ncyB9IGZyb20gJy4uL2FwcC9zZXR0aW5ncyc7XG5pbXBvcnQgeyB0IH0gZnJvbSAnLi4vaTE4bic7XG5pbXBvcnQgeyBTcGFjZVNreSB9IGZyb20gJy4vc2t5JztcbmltcG9ydCB7IFNreU1hcmtlcnMgfSBmcm9tICcuL3NreU1hcmtlcnMnO1xuaW1wb3J0IHsgRmxhdE1hcCwgZmxhdFRyZWtUaWxlcywgdHlwZSBGbGF0T3ZlcmxheSB9IGZyb20gJy4vZmxhdE1hcCc7XG5pbXBvcnQgeyBsb2FkTWFuaWZlc3QgfSBmcm9tICcuLi9zY2llbmNlL2xheWVyVmFsdWVzJztcbmltcG9ydCB7IE1hcE1vZGVzLCB0eXBlIE1hcE1vZGUgfSBmcm9tICcuL21hcE1vZGUnO1xuaW1wb3J0IHsgY3JlYXRlRGF0YURldGFpbExheWVyIH0gZnJvbSAnLi9kYXRhRGV0YWlsJztcbmltcG9ydCB7IHNldEV4cGxvcmVIZWlnaHRzIH0gZnJvbSAnLi4vZXhwbG9yZS9jb250ZXh0JztcblxuLyoqIFRoZSBIZWlnaHQgY29sb3VycyBsYXllcidzIE5BU0EgTW9vbiBUcmVrIG1hcCAoZ2xvYmUsIGZsYXQgbWFwIGFuZCBzdGFydC11cCBwcmVsb2FkIHVzZSB0aGUgc2FtZSBvbmUpLlxuICogIE5vcnRoIG9mIG1pblRydWVMYXQgb25seTogdGhlIHNoYXJwZXIgc291dGgtcG9sZSBoZWlnaHQgbWFwIChkYXRhL2xheWVycy9oZWlnaHQucG5nKSBpcyBkcmF3biBiZWxvdyBpdC4gKi9cbmNvbnN0IEhFSUdIVF9UUkVLID0geyBsYXllcjogJ0xST19MT0xBX0NsclNoYWRlX0dsb2JhbF8yNTZwcGRfdjA2JywgZXh0OiAncG5nJywgbWluVHJ1ZUxhdDogLTgwLjQgfSBhcyBjb25zdDtcblxuZXhwb3J0IHR5cGUgTWFwU2VsZWN0aW9uID1cbiAgfCB7IHR5cGU6ICduYW1lJzsgbmFtZTogTW9vbk5hbWUgfVxuICB8IHsgdHlwZTogJ3BsYWNlJzsgcGxhY2U6IFBsYWNlIH1cbiAgfCB7IHR5cGU6ICdwaW4nOyBsYXQ6IG51bWJlcjsgbG9uOiBudW1iZXIgfTtcblxuZXhwb3J0IGludGVyZmFjZSBNYXBQaW4geyBpZDogc3RyaW5nOyBsYXQ6IG51bWJlcjsgbG9uOiBudW1iZXI7IGxldHRlcjogc3RyaW5nOyBjb2xvcjogc3RyaW5nIH1cblxuZXhwb3J0IGludGVyZmFjZSBNb29uTWFwSGFuZGxlIHtcbiAgZmx5VG8obGF0OiBudW1iZXIsIGxvbjogbnVtYmVyLCBoZWlnaHRLbT86IG51bWJlciwgdGlsdGVkPzogYm9vbGVhbik6IHZvaWQ7XG4gIGZseVdob2xlKCk6IHZvaWQ7XG4gIGZseVBvbGUoKTogdm9pZDtcbiAgem9vbUJ5KGxvZ0ZhY3RvcjogbnVtYmVyKTogdm9pZDtcbiAgcmVzZXROb3J0aCgpOiB2b2lkO1xuICBzZXRUaWx0KHBpdGNoRGVnOiBudW1iZXIpOiB2b2lkO1xuICBsb29rKGF6RGVnOiBudW1iZXIsIGVsRGVnOiBudW1iZXIpOiB2b2lkO1xuICAvKiogR2xvYmUgPC0+IGZsYXQgbWFwICh3aXRoIHRoZSBjaG9yZW9ncmFwaGVkIG1vdmUpLiAqL1xuICBzZXRNYXBNb2RlKG1vZGU6IE1hcE1vZGUpOiB2b2lkO1xuICAvKiogR2V0IHRoZSBzb3V0aC1wb2xlIG1hcHMgcmVhZHkgdG8gc2hvdyBhdCBvbmNlIChjYWxsZWQgd2hlbiB0aGUgTGF5ZXJzIGJveCBvcGVucykuICovXG4gIHdhcm1MYXllcnMoKTogdm9pZDtcbn1cbmV4cG9ydCB0eXBlIHsgTWFwTW9kZSB9O1xuXG5pbnRlcmZhY2UgUHJvcHMge1xuICBsYXllcnM6IFJlY29yZDxzdHJpbmcsIGJvb2xlYW4+O1xuICBvcGFjaXR5OiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+O1xuICBzY2llbmNlTGF5ZXJzOiBMYXllckRlZltdO1xuICBuYW1lczogTW9vbk5hbWVbXSB8IG51bGw7XG4gIHNlbGVjdGVkUGluOiB7IGxhdDogbnVtYmVyOyBsb246IG51bWJlciB9IHwgbnVsbDtcbiAgb3ZlcnZpZXdSb3V0ZT86IFJvdXRlUmVzdWx0IHwgbnVsbDtcbiAgcm91dGVEZXN0aW5hdGlvbj86IHsgbGF0OiBudW1iZXI7IGxvbjogbnVtYmVyIH0gfCBudWxsO1xuICBjaG9vc2luZ0Rlc3RpbmF0aW9uPzogYm9vbGVhbjtcbiAgb25Sb3V0ZURlc3RpbmF0aW9uPyhsYXQ6IG51bWJlciwgbG9uOiBudW1iZXIpOiB2b2lkO1xuICBwaW5zOiBNYXBQaW5bXTtcbiAgLyoqIFN1biBhbmQgRWFydGggcG9zaXRpb25zIChUUlVFIGZyYW1lLCBtZXRyZXMgZnJvbSB0aGUgTW9vbidzIGNlbnRyZSkgYXQgdGhlIHRpbWUgb24gdGhlIHRpbWUgYmFyLiAqL1xuICBib2RpZXM6IHsgc3VuOiBWZWMzOyBlYXJ0aDogVmVjMyB9O1xuICBsYW5kZXI6IChMYW5kZXJTcGVjICYgeyBmYWNlQXo6IG51bWJlciB9KSB8IG51bGw7XG4gIHNreTogU2t5U3RhdGUgfCBudWxsO1xuICBvblNlbGVjdChzZWw6IE1hcFNlbGVjdGlvbik6IHZvaWQ7XG4gIG9uSG92ZXIocG9zOiB7IGxhdDogbnVtYmVyOyBsb246IG51bWJlciB9IHwgbnVsbCk6IHZvaWQ7XG4gIC8qKiBUaGUgdGltZSBvbiB0aGUgdGltZSBiYXIgKG1zIHNpbmNlIDE5NzAsIFVUQyk6IGRyaXZlcyB0aGUgc2t5LiAqL1xuICB0aW1lTXM/OiBudW1iZXI7XG4gIC8qKiBTdGFydC11cCBsb2FkaW5nIHByb2dyZXNzIGZvciB0aGUgbG9hZGluZyBzY3JlZW47IGBkb25lYCBhcnJpdmVzIGV4YWN0bHkgb25jZSBwZXIgcGFnZSBsb2FkLiAqL1xuICBvbkxvYWRQcm9ncmVzcz8ocDogTG9hZFByb2dyZXNzKTogdm9pZDtcbiAgLyoqIFRoZSBnbG9iZSAvIGZsYXQgbWFwIG1vZGUgY2hhbmdlZCAoYWxzbyB3aGVuIHRoZSBhcHAgZ29lcyBiYWNrIHRvIHRoZSBnbG9iZSBieSBpdHNlbGYsIGUuZy4gU3RhbmQgaGVyZSkuICovXG4gIG9uTWFwTW9kZT8obW9kZTogTWFwTW9kZSk6IHZvaWQ7XG59XG5leHBvcnQgdHlwZSB7IExvYWRQcm9ncmVzcyB9O1xuXG5jb25zdCBzdmdVcmwgPSAoc3ZnOiBzdHJpbmcpID0+ICdkYXRhOmltYWdlL3N2Zyt4bWw7Y2hhcnNldD11dGYtOCwnICsgZW5jb2RlVVJJQ29tcG9uZW50KHN2Zyk7XG4vLyBNYXAgbWFya2VycyBhcmUgb3VyIG93biBzbWFsbCBkcmF3aW5ncyAob25lIGZhbWlseSksIGF0IGFib3V0IDJ4IHRoZWlyIHNjcmVlbiBzaXplIGZvciBzaGFycG5lc3MuXG4vLyBUaGUgcGluOiBhIHNsaW0gdGVhcmRyb3Agd2hvc2UgdGlwIGlzIGF0ICg0MCwgNzUpIG9mIDgwLCBleGFjdGx5IHdoZXJlIHRoZSBvbGQgcGluJ3MgdGlwIHdhcywgc29cbi8vIHRoZSBhbmNob3IgYW5kIHRoZSBoaXQgYXJlYSBhcmUgdW5jaGFuZ2VkLiBBIHNvZnQgc2hhZG93IHVuZGVyIHRoZSB0aXAgYW5kIGEgaGFpcmxpbmUgZGFyayBlZGdlXG4vLyBrZWVwIGl0IHJlYWRhYmxlIG9uIGJyaWdodCBhbmQgb24gZGFyayBncm91bmQuXG5jb25zdCBQSU5fQk9EWSA9ICdNNDAgNzVDMzggNzAgMjUuMiA0Ni45IDIxLjQgMzkuOEEyMSAyMSAwIDEgMSA1OC42IDM5LjhDNTQuOCA0Ni45IDQyIDcwIDQwIDc1Wic7XG5jb25zdCBQSU5fU1ZHID0gKHJpbmc6IHN0cmluZywgbGFiZWwgPSAnJykgPT4gc3ZnVXJsKFxuICAnPHN2ZyB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgd2lkdGg9XCI4MFwiIGhlaWdodD1cIjgwXCIgdmlld0JveD1cIjAgMCA4MCA4MFwiPidcbiAgKyAnPGRlZnM+PGZpbHRlciBpZD1cImJcIiB4PVwiLTFcIiB5PVwiLTFcIiB3aWR0aD1cIjNcIiBoZWlnaHQ9XCIzXCI+PGZlR2F1c3NpYW5CbHVyIHN0ZERldmlhdGlvbj1cIjEuNlwiLz48L2ZpbHRlcj48L2RlZnM+J1xuICArICc8ZWxsaXBzZSBjeD1cIjQwXCIgY3k9XCI3NS41XCIgcng9XCI3LjVcIiByeT1cIjIuNlwiIGZpbGw9XCIjMDAwXCIgZmlsbC1vcGFjaXR5PVwiMC40NVwiIGZpbHRlcj1cInVybCgjYilcIi8+J1xuICArIChsYWJlbFxuICAgID8gYDxwYXRoIGQ9XCIke1BJTl9CT0RZfVwiIGZpbGw9XCIjZjJmM2Y1XCIgc3Ryb2tlPVwiIzBiMGQxMFwiIHN0cm9rZS1vcGFjaXR5PVwiMC42XCIgc3Ryb2tlLXdpZHRoPVwiMS42XCIvPmBcbiAgICAgICsgYDxjaXJjbGUgY3g9XCI0MFwiIGN5PVwiMzBcIiByPVwiMTVcIiBmaWxsPVwibm9uZVwiIHN0cm9rZT1cIiR7cmluZ31cIiBzdHJva2Utd2lkdGg9XCIzLjVcIi8+YFxuICAgICAgKyBgPHRleHQgeD1cIjQwXCIgeT1cIjM3XCIgZm9udC1mYW1pbHk9XCInR29vZ2xlIFNhbnMgRmxleCBWYXJpYWJsZScsICdIZWx2ZXRpY2EgTmV1ZScsIEhlbHZldGljYSwgQXJpYWwsIHNhbnMtc2VyaWZcIiBmb250LXNpemU9XCIyMFwiIGZvbnQtd2VpZ2h0PVwiNjAwXCIgZmlsbD1cIiMxNTE2MWFcIiB0ZXh0LWFuY2hvcj1cIm1pZGRsZVwiPiR7bGFiZWx9PC90ZXh0PmBcbiAgICA6IGA8cGF0aCBkPVwiJHtQSU5fQk9EWX1cIiBmaWxsPVwiI2ZmNmI1YVwiIHN0cm9rZT1cIiMwYjBkMTBcIiBzdHJva2Utb3BhY2l0eT1cIjAuNlwiIHN0cm9rZS13aWR0aD1cIjEuNlwiLz48Y2lyY2xlIGN4PVwiNDBcIiBjeT1cIjMwXCIgcj1cIjcuNVwiIGZpbGw9XCIjZmZmXCIvPmApXG4gICsgJzwvc3ZnPicpO1xuLyoqIEEgcm91bmQgbWFya2VyIGZvciBzcGVjaWFsIHBsYWNlczogZGFyayBnbGFzcyBkaXNjLCB3aGl0ZSBzeW1ib2wgZHJhd24gaW4gYSAyMi11bml0IGJveCwgYW4gb3B0aW9uYWwgdGhpbiBjb2xvdXJlZCByaW5nLiAqL1xuY29uc3QgQkFER0VfU1ZHID0gKHN5bWJvbDogc3RyaW5nLCByaW5nOiBzdHJpbmcpID0+IHN2Z1VybChcbiAgJzxzdmcgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIHdpZHRoPVwiNDRcIiBoZWlnaHQ9XCI0NFwiIHZpZXdCb3g9XCIwIDAgMjIgMjJcIj4nXG4gICsgYDxjaXJjbGUgY3g9XCIxMVwiIGN5PVwiMTFcIiByPVwiMTBcIiBmaWxsPVwiIzE1MTYxOVwiIGZpbGwtb3BhY2l0eT1cIjAuODZcIiBzdHJva2U9XCIke3Jpbmd9XCIgc3Ryb2tlLXdpZHRoPVwiMS4xXCIvPmBcbiAgKyBgPGcgZmlsbD1cIm5vbmVcIiBzdHJva2U9XCIjZmZmXCIgc3Ryb2tlLXdpZHRoPVwiMS40XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCI+JHtzeW1ib2x9PC9nPjwvc3ZnPmApO1xuLyoqIEEgcm91bmQgbWFya2VyIHdpdGggYW4gaWNlIGNyeXN0YWw6IHJpbmcgY29sb3VyLCByaW5nIGRhc2hlcyAoJycgPSBzb2xpZCkgYW5kIGNyeXN0YWwgY29sb3VyLiAqL1xuZnVuY3Rpb24gSUNFX1NWRyhyaW5nOiBzdHJpbmcsIGRhc2g6IHN0cmluZywgaW5rOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gc3ZnVXJsKCc8c3ZnIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiB3aWR0aD1cIjQ0XCIgaGVpZ2h0PVwiNDRcIiB2aWV3Qm94PVwiMCAwIDIyIDIyXCI+J1xuICAgICsgYDxjaXJjbGUgY3g9XCIxMVwiIGN5PVwiMTFcIiByPVwiMTBcIiBmaWxsPVwiIzE1MTYxOVwiIGZpbGwtb3BhY2l0eT1cIjAuODZcIiBzdHJva2U9XCIke3Jpbmd9XCIgc3Ryb2tlLXdpZHRoPVwiMS4zXCIke2Rhc2ggPyBgIHN0cm9rZS1kYXNoYXJyYXk9XCIke2Rhc2h9XCJgIDogJyd9Lz5gXG4gICAgKyBgPGcgZmlsbD1cIm5vbmVcIiBzdHJva2U9XCIke2lua31cIiBzdHJva2Utd2lkdGg9XCIxLjNcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIj48cGF0aCBkPVwiTTExIDUuNHYxMS4yTTYuMiA4LjJsOS42IDUuNk0xNS44IDguMmwtOS42IDUuNlwiLz48cGF0aCBkPVwiTTkuNiA2LjMgMTEgNy42bDEuNC0xLjNNOS42IDE1LjcgMTEgMTQuNGwxLjQgMS4zXCIvPjwvZz48L3N2Zz5gKTtcbn1cbi8qKiBQaWN0dXJlcyBvZiB0aGUgc3BlY2lhbCBwbGFjZXMsIGJ5IGtpbmQgKGljZSBldmlkZW5jZSBoYXMgb25lIHBlciBzdHJlbmd0aCBvZiBldmlkZW5jZTogc2VlIGxhYmVscy50cyBpY29uS2V5T2YpLiAqL1xuY29uc3QgSUNPTjogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgLy8gY29ybmVyIGJyYWNrZXRzIGFyb3VuZCBhIGRvdDogXCJhIHJlZ2lvbiBwaWNrZWQgYXMgYSBsYW5kaW5nIHRhcmdldFwiXG4gIGFydGVtaXM6IEJBREdFX1NWRygnPHBhdGggZD1cIk02LjUgOVY2LjVIOU0xMyA2LjVoMi41VjlNMTUuNSAxM3YyLjVIMTNNOSAxNS41SDYuNVYxM1wiLz48Y2lyY2xlIGN4PVwiMTFcIiBjeT1cIjExXCIgcj1cIjEuMlwiIGZpbGw9XCIjZmZmXCIgc3Ryb2tlPVwibm9uZVwiLz4nLCAnIzdmY2ZhOCcpLFxuICBzcG90OiBCQURHRV9TVkcoJzxwYXRoIGQ9XCJNNS44IDE0LjYgOS40IDguNGwyLjMgMy42IDEuNC0xLjkgMy4xIDQuNVpcIiBmaWxsPVwiI2ZmZlwiIHN0cm9rZS13aWR0aD1cIjFcIi8+JywgJ3JnYmEoMjU1LDI1NSwyNTUsMC4yOCknKSxcbiAgLy8gYSBzbWFsbCBmbGFnIG9uIGEgcG9sZTogc29tZXRoaW5nIGxhbmRlZCAob3IgaGl0IHRoZSBncm91bmQpIGhlcmVcbiAgbWlzc2lvbjogQkFER0VfU1ZHKCc8cGF0aCBkPVwiTTcuNiAxNi40VjUuNlwiLz48cGF0aCBkPVwiTTguMyA2LjFoNi40bC0xLjcgMi4zIDEuNyAyLjNIOC4zWlwiIGZpbGw9XCIjZmZmXCIgc3Ryb2tlLXdpZHRoPVwiMC44XCIvPicsICdyZ2JhKDI1NSwyNTUsMjU1LDAuMjgpJyksXG4gIC8vIHRoZSBzYW1lIGZsYWcgd2l0aCByYWRpbyB3YXZlcyBhbmQgYSBncmVlbiByaW5nOiBpdCBtYXkgc3RpbGwgYmUgd29ya2luZ1xuICBhY3RpdmU6IEJBREdFX1NWRygnPHBhdGggZD1cIk02LjYgMTYuNFY2LjZcIi8+PHBhdGggZD1cIk03LjMgNy4xaDQuNmwtMS4zIDEuOCAxLjMgMS44SDcuM1pcIiBmaWxsPVwiI2ZmZlwiIHN0cm9rZS13aWR0aD1cIjAuOFwiLz48cGF0aCBkPVwiTTEzLjYgMTIuNGEzIDMgMCAwIDAgMC00LjZNMTUuNSAxNC4yYTUuNiA1LjYgMCAwIDAgMC04LjJcIi8+JywgJyM2ZmNmOWQnKSxcbiAgLy8gYW4gZW1wdHkgZmxhZyBpbiBhIGRhc2hlZCByaW5nOiBwbGFubmVkLCBub3QgdGhlcmUgeWV0XG4gIHBsYW5uZWQ6IHN2Z1VybCgnPHN2ZyB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgd2lkdGg9XCI0NFwiIGhlaWdodD1cIjQ0XCIgdmlld0JveD1cIjAgMCAyMiAyMlwiPidcbiAgICArICc8Y2lyY2xlIGN4PVwiMTFcIiBjeT1cIjExXCIgcj1cIjEwXCIgZmlsbD1cIiMxNTE2MTlcIiBmaWxsLW9wYWNpdHk9XCIwLjg2XCIgc3Ryb2tlPVwiI2E5OWVlOFwiIHN0cm9rZS13aWR0aD1cIjEuMlwiIHN0cm9rZS1kYXNoYXJyYXk9XCIyLjQgMlwiLz4nXG4gICAgKyAnPGcgZmlsbD1cIm5vbmVcIiBzdHJva2U9XCIjZmZmXCIgc3Ryb2tlLXdpZHRoPVwiMS40XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCI+PHBhdGggZD1cIk03LjYgMTYuNFY1LjZcIi8+PHBhdGggZD1cIk04LjMgNi4xaDYuNGwtMS43IDIuMyAxLjcgMi4zSDguM1pcIi8+PC9nPjwvc3ZnPicpLFxuICAvLyB3YXRlciBpY2U6IGEgc2l4LWFybWVkIGNyeXN0YWwuIFdoaXRlIHJpbmcgPSBtZWFzdXJlZCB0aGVyZSwgY3lhbiA9IHNpZ25zIHNlZW4gZnJvbSBvcmJpdCwgZGFzaGVkIGJsdWUgPSBvbmx5IHByZWRpY3RlZFxuICAnaWNlLWNvbmZpcm1lZCc6IElDRV9TVkcoJyNmZmZmZmYnLCAnJywgJyNmZmZmZmYnKSxcbiAgJ2ljZS1kZXRlY3RlZCc6IElDRV9TVkcoJyM1MGQyZmYnLCAnJywgJyNiZmVlZmYnKSxcbiAgJ2ljZS1wcmVkaWN0ZWQnOiBJQ0VfU1ZHKCcjNmU5NmZmJywgJzIuNCAyJywgJyNjOWQ2ZmYnKSxcbiAgaWNlOiBJQ0VfU1ZHKCcjNTBkMmZmJywgJycsICcjYmZlZWZmJyksXG59O1xuLyoqIEEgc2hvcnQgZHJvcC1pbiB3aGVuIGEgcGluIGlzIHBsYWNlZCBvbiBhIG5ldyBzcG90OiBpdCBmYWxscyB0aGUgbGFzdCBmZXcgcGl4ZWxzIG9udG8gaXQuICovXG5sZXQgbGFzdERyb3AgPSAnJztcbmZ1bmN0aW9uIGRyb3BJbih2aWV3ZXI6IFZpZXdlciwgZTogRW50aXR5LCBzcG90OiBzdHJpbmcpIHtcbiAgaWYgKHNwb3QgPT09IGxhc3REcm9wKSByZXR1cm47IC8vIHRoZSBzYW1lIHBpbiBkcmF3biBhZ2FpbiAoZS5nLiBhIHBsYW4gd2FzIGFkZGVkKTogbm8gYm91bmNlXG4gIGxhc3REcm9wID0gc3BvdDtcbiAgY29uc3QgdDAgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgY29uc3Qgc3RlcCA9ICgpID0+IHtcbiAgICBpZiAoIWUuYmlsbGJvYXJkIHx8IHZpZXdlci5pc0Rlc3Ryb3llZCgpKSByZXR1cm47XG4gICAgY29uc3QgayA9IE1hdGgubWluKDEsIChwZXJmb3JtYW5jZS5ub3coKSAtIHQwKSAvIDI2MCksIGVhc2UgPSAxIC0gKDEgLSBrKSAqKiAzO1xuICAgIGUuYmlsbGJvYXJkLnBpeGVsT2Zmc2V0ID0gbmV3IENhcnRlc2lhbjIoMCwgMiAtIDEyICogKDEgLSBlYXNlKSkgYXMgbmV2ZXI7XG4gICAgdmlld2VyLnNjZW5lLnJlcXVlc3RSZW5kZXIoKTtcbiAgICBpZiAoayA8IDEpIHJlcXVlc3RBbmltYXRpb25GcmFtZShzdGVwKTtcbiAgfTtcbiAgc3RlcCgpO1xufVxuXG4vKiogUGljdHVyZXMgdGhlIGdyb3VuZCBzaGFkZXIgb2YgdGhlIHN1cmZhY2UgdmlldyByZWFkcyAobGFuZGVyLnRzIGVuc3VyZU1hdGVyaWFsOiA3LCBhbmQgdGhlIFN1biBzaGFkb3cgbWFwIGluIHN1blNoYWRvdy50cykuICovXG5jb25zdCBHUk9VTkRfU0hBREVSX1RFWFRVUkVTID0gODtcblxudHlwZSBUYWcgPSB7IHR5cGU6IHN0cmluZzsgbmFtZT86IE1vb25OYW1lOyBwbGFjZT86IFBsYWNlIH0gfCB1bmRlZmluZWQ7XG4vKiogV2hpY2gga2luZHMgb2Ygc3BlY2lhbCBwbGFjZSBzaG93LCBmcm9tIHRoZSBsYXllciBzd2l0Y2hlcyAoYG9uYCA9IHRoZSBnbG9iZSBpcyBzaG93aW5nIGFuZCB5b3UgYXJlIG5vdCBzdGFuZGluZyBvbiBpdCkuICovXG5mdW5jdGlvbiBwbGFjZUZsYWdzKG9uOiBib29sZWFuLCBsOiBSZWNvcmQ8c3RyaW5nLCBib29sZWFuPik6IFJlY29yZDxQbGFjZVsna2luZCddLCBib29sZWFuPiB7XG4gIHJldHVybiB7IGFydGVtaXM6IG9uICYmICEhbC5hcnRlbWlzLCBzcG90OiBvbiAmJiAhIWwuYXJ0ZW1pcywgbWlzc2lvbjogb24gJiYgISFsLm1pc3Npb25zLCBhY3RpdmU6IG9uICYmICEhbC5taXNzaW9ucywgcGxhbm5lZDogb24gJiYgbC5zaXRlc1BsYW5uZWQgIT09IGZhbHNlLCBpY2U6IG9uICYmICEhbC53YXRlcmljZSB9O1xufVxuY29uc3QgdGFnT2YgPSAoaWQ6IHVua25vd24pOiBUYWcgPT4gKGlkIGFzIHsgbW9vbmRhPzogVGFnIH0gfCB1bmRlZmluZWQpPy5tb29uZGE7XG5cbmNvbnN0IFdIT0xFID0geyBsYXQ6IC0zNSwgbG9uOiAxMCwgYWx0OiA2XzUwMF8wMDAgfTtcblxuY29uc3QgU0NJRU5DRV9TV0lUQ0hFUyA9IG5ldyBTZXQoWydwc3InLCAnd2F0ZXJpY2UnLCAnZGFuZ2VyJywgJ3Nsb3BlJywgJ2hlaWdodCddKTtcbmNvbnN0IHNjaWVuY2VTb3VyY2VzID0gKGRlZjogTGF5ZXJEZWYpOiBTY2llbmNlUmFzdGVyU291cmNlW10gPT4gZGVmLnJhc3RlclNvdXJjZXMgPz8gW3tcbiAgdXJsOiBgLi9kYXRhL2xheWVycy8ke2RlZi5pZH0ucG5nYCwgcHJvamVjdGlvbjogJ3BvbGFyJywgcG9sZTogJ3NvdXRoJywgZXh0ZW50TTogUE9MQVJfRVhURU5UX00sIGNsaXBUcnVlTGF0RGVnOiAtODAuMDIsXG59XTtcbmZ1bmN0aW9uIHByZXBhcmVTY2llbmNlTGF5ZXJzKHZpZXdlcjogVmlld2VyLCBsYXllcnM6IE1hcDxzdHJpbmcsIEltYWdlcnlMYXllcj4sIGRlZnM6IExheWVyRGVmW10pIHtcbiAgZm9yIChjb25zdCBkZWYgb2YgZGVmcykge1xuICAgIGlmICghU0NJRU5DRV9TV0lUQ0hFUy5oYXMoZGVmLmlkKSkgY29udGludWU7XG4gICAgY29uc3QgaWQgPSBkZWYuaWQgPT09ICdoZWlnaHQnID8gJ2hlaWdodFBvbGFyJyA6IGRlZi5pZDtcbiAgICBpZiAobGF5ZXJzLmhhcyhpZCkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGxheWVyID0gbmV3IEltYWdlcnlMYXllcihjcmVhdGVTY2llbmNlUmFzdGVyUHJvdmlkZXIoeyBzb3VyY2VzOiBzY2llbmNlU291cmNlcyhkZWYpLCBjcmVkaXQ6IGRlZi5zb3VyY2U/Lm5hbWUgPz8gJ05BU0EnLCBtYXhpbXVtTGV2ZWw6IFNIQVJQX1BPTEFSX0xBWUVSUy5oYXMoZGVmLmlkKSA/IDEwIDogOSB9KSBhcyBuZXZlciwgeyBzaG93OiBmYWxzZSB9KTtcbiAgICB2aWV3ZXIuaW1hZ2VyeUxheWVycy5hZGQobGF5ZXIpO1xuICAgIGxheWVycy5zZXQoaWQsIGxheWVyKTtcbiAgfVxufVxuXG5leHBvcnQgY29uc3QgTW9vbk1hcCA9IGZvcndhcmRSZWY8TW9vbk1hcEhhbmRsZSwgUHJvcHM+KGZ1bmN0aW9uIE1vb25NYXAocHJvcHMsIHJlZikge1xuICBjb25zdCBob3N0ID0gdXNlUmVmPEhUTUxEaXZFbGVtZW50PihudWxsKTtcbiAgY29uc3Qgdmlld2VyUmVmID0gdXNlUmVmPFZpZXdlciB8IG51bGw+KG51bGwpO1xuICBjb25zdCBpbWFnZXJ5ID0gdXNlUmVmKG5ldyBNYXA8c3RyaW5nLCBJbWFnZXJ5TGF5ZXI+KCkpO1xuICBjb25zdCBoZWlnaHRzUmVmID0gdXNlUmVmPE1vb25IZWlnaHRzIHwgbnVsbD4obnVsbCk7XG4gIGNvbnN0IGxhYmVsc1JlZiA9IHVzZVJlZjxOYW1lTGFiZWxzIHwgbnVsbD4obnVsbCk7XG4gIGNvbnN0IG5hdlJlZiA9IHVzZVJlZjxOYXZpZ2F0aW9uIHwgbnVsbD4obnVsbCk7XG4gIGNvbnN0IGxhbmRlclJlZiA9IHVzZVJlZjxMYW5kZXJWaWV3IHwgbnVsbD4obnVsbCk7XG4gIGNvbnN0IG1hcmtlcnNSZWYgPSB1c2VSZWY8U2t5TWFya2VycyB8IG51bGw+KG51bGwpO1xuICBjb25zdCBza3lSZWYgPSB1c2VSZWY8U3BhY2VTa3kgfCBudWxsPihudWxsKTtcbiAgY29uc3Qgc2VsZWN0ZWRFbnRpdHkgPSB1c2VSZWY8RW50aXR5IHwgbnVsbD4obnVsbCk7XG4gIGNvbnN0IHBpbkVudGl0aWVzID0gdXNlUmVmKG5ldyBNYXA8c3RyaW5nLCBFbnRpdHk+KCkpO1xuICBjb25zdCBjYiA9IHVzZVJlZihwcm9wcyk7XG4gIGNiLmN1cnJlbnQgPSBwcm9wcztcbiAgY29uc3QgbmFtZXNMb2FkZWQgPSB1c2VSZWY8KCkgPT4gdm9pZD4oKCkgPT4ge30pO1xuICBjb25zdCBza2lwUHJlbG9hZCA9IHVzZVJlZihmYWxzZSk7XG4gIGNvbnN0IGZsYXRSZWYgPSB1c2VSZWY8RmxhdE1hcCB8IG51bGw+KG51bGwpO1xuICBjb25zdCBtb2Rlc1JlZiA9IHVzZVJlZjxNYXBNb2RlcyB8IG51bGw+KG51bGwpO1xuXG4gIHVzZUVmZmVjdCgoKSA9PiB7XG4gICAgY29uc3QgaGVpZ2h0cyA9IG5ldyBNb29uSGVpZ2h0cyhuZXcgVVJMKCcuL2RhdGEvJywgZG9jdW1lbnQuYmFzZVVSSSkuaHJlZik7XG4gICAgaGVpZ2h0c1JlZi5jdXJyZW50ID0gaGVpZ2h0cztcbiAgICBjb25zdCB2aWV3ZXIgPSBuZXcgVmlld2VyKGhvc3QuY3VycmVudCEsIHtcbiAgICAgIGdsb2JlOiBuZXcgR2xvYmUoTU9PTl9FTExJUFNPSUQpLFxuICAgICAgYmFzZUxheWVyOiBmYWxzZSwgdGVycmFpblByb3ZpZGVyOiBuZXcgRWxsaXBzb2lkVGVycmFpblByb3ZpZGVyKHsgZWxsaXBzb2lkOiBNT09OX0VMTElQU09JRCB9KSxcbiAgICAgIGFuaW1hdGlvbjogZmFsc2UsIHRpbWVsaW5lOiBmYWxzZSwgYmFzZUxheWVyUGlja2VyOiBmYWxzZSwgZ2VvY29kZXI6IGZhbHNlLCBob21lQnV0dG9uOiBmYWxzZSxcbiAgICAgIHNjZW5lTW9kZVBpY2tlcjogZmFsc2UsIG5hdmlnYXRpb25IZWxwQnV0dG9uOiBmYWxzZSwgZnVsbHNjcmVlbkJ1dHRvbjogZmFsc2UsIGluZm9Cb3g6IGZhbHNlLFxuICAgICAgc2VsZWN0aW9uSW5kaWNhdG9yOiBmYWxzZSwgc2t5QXRtb3NwaGVyZTogZmFsc2UsIHNjZW5lM0RPbmx5OiB0cnVlLFxuICAgICAgcmVxdWVzdFJlbmRlck1vZGU6IHRydWUsIG1heGltdW1SZW5kZXJUaW1lQ2hhbmdlOiBJbmZpbml0eSxcbiAgICAgIHVzZUJyb3dzZXJSZWNvbW1lbmRlZFJlc29sdXRpb246IGZhbHNlLCBtc2FhU2FtcGxlczoga25vYnMoaW5pdFF1YWxpdHkoKSkubXNhYVNhbXBsZXMsXG4gICAgICBjcmVkaXRDb250YWluZXI6IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjZXNpdW0tY3JlZGl0cycpID8/IHVuZGVmaW5lZCxcbiAgICB9KTtcbiAgICB2aWV3ZXJSZWYuY3VycmVudCA9IHZpZXdlcjtcbiAgICAvLyBDZXNpdW0gZHJhd3MgYXMgbWFueSBtYXAgbGF5ZXJzIHBlciBncm91bmQgdGlsZSBhcyB0aGUgZ3JhcGhpY3MgY2FyZCBoYXMgdGV4dHVyZSBzbG90cyAoMTYgb24gbWFueSksIGJ1dCBpdFxuICAgIC8vIGRvZXMgbm90IGNvdW50IHRoZSA4IHBpY3R1cmVzIG91ciBvd24gZ3JvdW5kIHNoYWRlciByZWFkcyAobGFuZGVyLnRzOiBoaWxsIHNoYWRvd3MsIGhlaWdodHMsIHNvaWwgc2NhbnMsIHJvY2tcbiAgICAvLyBzaGFkb3dzLCB0aGUgU3VuIHNoYWRvdyBtYXApLiBXaXRoIDkgb3IgbW9yZSBsYXllcnMgb24gb25lIHRpbGUgdGhlIHNoYWRlciB0aGVuIGFza2VkIGZvciBtb3JlIHNsb3RzIHRoYW5cbiAgICAvLyBleGlzdCBhbmQgcmVuZGVyaW5nIHN0b3BwZWQgKFwidGV4dHVyZSBpbWFnZSB1bml0cyBjb3VudCBleGNlZWRzIE1BWF9URVhUVVJFX0lNQUdFX1VOSVRTXCIpLiBUZWxsIENlc2l1bSB0aGVcbiAgICAvLyBzbG90cyB0aGF0IGFyZSByZWFsbHkgbGVmdDogaXQgdGhlbiBkcmF3cyBhIHRpbGUgd2l0aCBtYW55IGxheWVycyBpbiB0d28gcGFzc2VzIGluc3RlYWQuXG4gICAgY29uc3QgbGltaXRzID0gKENlc2l1bSBhcyB1bmtub3duIGFzIHsgQ29udGV4dExpbWl0czogeyBfbWF4aW11bVRleHR1cmVJbWFnZVVuaXRzOiBudW1iZXIgfSB9KS5Db250ZXh0TGltaXRzO1xuICAgIGlmIChsaW1pdHMgJiYgdHlwZW9mIGxpbWl0cy5fbWF4aW11bVRleHR1cmVJbWFnZVVuaXRzID09PSAnbnVtYmVyJykgbGltaXRzLl9tYXhpbXVtVGV4dHVyZUltYWdlVW5pdHMgPSBNYXRoLm1heCg0LCBsaW1pdHMuX21heGltdW1UZXh0dXJlSW1hZ2VVbml0cyAtIEdST1VORF9TSEFERVJfVEVYVFVSRVMpO1xuICAgIC8vIFNtYWxsIHRlc3QvZGVidWcgaG9vayAodXNlZCBieSBzY3JpcHRzL2RyaXZlLm1qcyk6IGlzIHRoZSBtYXAgZmluaXNoZWQgbG9hZGluZyB3aGF0IGlzIG9uIHNjcmVlbj9cbiAgICAod2luZG93IGFzIHVua25vd24gYXMgeyBfX3ZpZXdlcjogVmlld2VyIH0pLl9fdmlld2VyID0gdmlld2VyO1xuICAgIC8vIGlkbGUoKTogc3RhcnQtdXAgbG9hZGluZyBpcyBvdmVyIGFuZCB0aGUgbWFwIGhhcyBub3RoaW5nIGxlZnQgdG8gbG9hZCBmb3Igd2hhdCBpcyBvbiBzY3JlZW5cbiAgICBjb25zdCBkZWJ1Z0hvb2s6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyB2aWV3ZXIgfTtcbiAgICBkZWJ1Z0hvb2suaWRsZSA9ICgpID0+ICF2aWV3ZXIuaXNEZXN0cm95ZWQoKSAmJiAoZGVidWdIb29rLnByb2dyZXNzIGFzIExvYWRQcm9ncmVzcyB8IHVuZGVmaW5lZCk/LmRvbmUgPT09IHRydWUgJiYgc2NlbmUuZ2xvYmUudGlsZXNMb2FkZWQ7XG4gICAgKHdpbmRvdyBhcyB1bmtub3duIGFzIHsgX19tb29uZGE6IHVua25vd24gfSkuX19tb29uZGEgPSBkZWJ1Z0hvb2s7XG4gICAgaWYgKGltcG9ydC5tZXRhLmVudi5ERVYpIHZvaWQgaW1wb3J0KCdjZXNpdW0nKS50aGVuKG0gPT4geyAod2luZG93IGFzIHVua25vd24gYXMgeyBfX21vb25kYUNlc2l1bTogdW5rbm93biB9KS5fX21vb25kYUNlc2l1bSA9IG07IH0pOyAvLyBsZXRzIHRlc3Qgc2NyaXB0cyBidWlsZCByYXlzIGluIHRoZSBwYWdlXG4gICAgY29uc3Qgc2NlbmUgPSB2aWV3ZXIuc2NlbmU7XG4gICAgc2NlbmUuYmFja2dyb3VuZENvbG9yID0gQ29sb3IuZnJvbUNzc0NvbG9yU3RyaW5nKCcjMDQwNTBhJyk7XG4gICAgc2NlbmUuZm9nLmVuYWJsZWQgPSBmYWxzZTtcbiAgICBpZiAoc2NlbmUuc3VuKSBzY2VuZS5zdW4uc2hvdyA9IGZhbHNlO1xuICAgIGlmIChzY2VuZS5tb29uKSBzY2VuZS5tb29uLnNob3cgPSBmYWxzZTtcbiAgICBjb25zdCBnbG9iZSA9IHNjZW5lLmdsb2JlO1xuICAgIGdsb2JlLmJhc2VDb2xvciA9IENvbG9yLmZyb21Dc3NDb2xvclN0cmluZygnIzNhM2M0MScpO1xuICAgIGdsb2JlLnNob3dHcm91bmRBdG1vc3BoZXJlID0gZmFsc2U7XG4gICAgZ2xvYmUuZHluYW1pY0F0bW9zcGhlcmVMaWdodGluZyA9IGZhbHNlO1xuICAgIGdsb2JlLmxpZ2h0aW5nRmFkZU91dERpc3RhbmNlID0gMDtcbiAgICBnbG9iZS5saWdodGluZ0ZhZGVJbkRpc3RhbmNlID0gMTtcbiAgICAvLyBzaGFycG5lc3MsIGRyYXdpbmcgc2l6ZSwgZWRnZSBzbW9vdGhpbmcgYW5kIHRpbGUgY2FjaGluZyBjb21lIGZyb20gdGhlIGdyYXBoaWNzIG1vZGUgKGFwcC9xdWFsaXR5LnRzKSxcbiAgICAvLyBhbmQgZm9sbG93IGl0IGxpdmUgd2hlbiB0aGUgcGVyc29uIHN3aXRjaGVzIG1vZGUgKGFsc28gd2hpbGUgdGhlIHN0YXJ0IHNjcmVlbiBpcyBsb2FkaW5nKVxuICAgIGFwcGx5UXVhbGl0eSh2aWV3ZXIpO1xuICAgIGNvbnN0IG9mZlF1YWxpdHkgPSBzZXR0aW5ncy5zdWJzY3JpYmUoKHMsIHByZXYpID0+IHsgaWYgKHMucXVhbGl0eSAhPT0gcHJldi5xdWFsaXR5KSBhcHBseVF1YWxpdHkodmlld2VyLCBzLnF1YWxpdHkpOyB9KTtcbiAgICBnbG9iZS5kZXB0aFRlc3RBZ2FpbnN0VGVycmFpbiA9IHRydWU7XG4gICAgZ2xvYmUudmVydGV4U2hhZG93RGFya25lc3MgPSAwLjI7IC8vIHRoZSBuaWdodCBzaWRlIHN0YXlzIGRpbSBidXQgcmVhZGFibGUsIGxpa2UgR29vZ2xlIEVhcnRoIGF0IG5pZ2h0XG4gICAgZ2xvYmUubGFtYmVydERpZmZ1c2VNdWx0aXBsaWVyID0gMS4xNTtcbiAgICAvLyBSZWRyYXcgb25seSB3aGVuIHNvbWV0aGluZyBjaGFuZ2VzLCBidXQga2VlcCBkcmF3aW5nIHdoaWxlIHRpbGVzIGFyZSBzdGlsbCBhcnJpdmluZy5cbiAgICBsZXQgbGFzdFBob3RvQ3VsbCA9IDA7XG4gICAgbGV0IGxhc3RQaG90b01vdmUgPSAtSW5maW5pdHk7XG4gICAgbGV0IHBob3RvQ3VsbFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZDtcbiAgICBjb25zdCBvZmZQaG90b0N1bGwgPSB2aWV3ZXIuY2FtZXJhLmNoYW5nZWQuYWRkRXZlbnRMaXN0ZW5lcigoKSA9PiB7XG4gICAgICBsYXN0UGhvdG9Nb3ZlID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gICAgICBjbGVhclRpbWVvdXQocGhvdG9DdWxsVGltZXIpO1xuICAgICAgcGhvdG9DdWxsVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IGNhbmNlbE9mZnNjcmVlbkltYWdlcnkodmlld2VyKSwgNDAwKTtcbiAgICB9KTtcbiAgICBzY2VuZS5wb3N0UmVuZGVyLmFkZEV2ZW50TGlzdGVuZXIoKCkgPT4ge1xuICAgICAgaWYgKCFnbG9iZS50aWxlc0xvYWRlZCkgc2NlbmUucmVxdWVzdFJlbmRlcigpO1xuICAgICAgY29uc3Qgbm93ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gICAgICAvLyBDZXNpdW0gYWxzbyBwcmVwYXJlcyBhIHJpbSBvZiBuZWlnaGJvdXJpbmcgdGVycmFpbi4gT25jZSB0aGUgY2FtZXJhIHNldHRsZXMsIGxldFxuICAgICAgLy8gdGhvc2Ugam9icyBmaW5pc2g6IHJlcGVhdGVkbHkgY3VsbGluZyB0aGF0IHJpbSB3b3VsZCBtYWtlIGl0IHJlcXVlc3QgdGhlbSBmb3JldmVyLlxuICAgICAgaWYgKG5vdyAtIGxhc3RQaG90b0N1bGwgPiAxMDAgJiYgKG5vdyAtIGxhc3RQaG90b01vdmUgPCAzNTAgfHwgIWdsb2JlLnRpbGVzTG9hZGVkKSkge1xuICAgICAgICBsYXN0UGhvdG9DdWxsID0gbm93O1xuICAgICAgICBjYW5jZWxPZmZzY3JlZW5JbWFnZXJ5KHZpZXdlciwgbm93IC0gbGFzdFBob3RvTW92ZSA8IDM1MCk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgdmlld2VyLmNlc2l1bVdpZGdldC5zY3JlZW5TcGFjZUV2ZW50SGFuZGxlci5yZW1vdmVJbnB1dEFjdGlvbihTY3JlZW5TcGFjZUV2ZW50VHlwZS5MRUZUX0RPVUJMRV9DTElDSyk7XG5cbiAgICBoZWlnaHRzLnJlYWR5LnRoZW4oKCkgPT4geyBpZiAoIXZpZXdlci5pc0Rlc3Ryb3llZCgpICYmIGNiLmN1cnJlbnQubGF5ZXJzLnRlcnJhaW4gIT09IGZhbHNlKSB2aWV3ZXIudGVycmFpblByb3ZpZGVyID0gbmV3IExvbGFUZXJyYWluUHJvdmlkZXIoaGVpZ2h0cykgYXMgbmV2ZXI7IH0pO1xuICAgIGhlaWdodHMucmVhZHkudGhlbigoKSA9PiBzaGFyZUhlaWdodHMoaGVpZ2h0cykpLmNhdGNoKCgpID0+IHt9KTsgLy8gdGhlIGJhY2tncm91bmQgY2FsY3VsYXRvciByZXVzZXMgdGhpcyBkb3dubG9hZFxuICAgIHNldEV4cGxvcmVIZWlnaHRzKGhlaWdodHMpOyAvLyB0aGUgbWluaW1hcCBhbmQgdGhlIHRyYWlsIHJlYWQgdGhlIHNhbWUgaGVpZ2h0IG1hcHNcblxuICAgIC8vIFBob3RvcyBhbmQgb3B0aW9uYWwgbWFwIGxheWVycyAoYWxsIHJlLXByb2plY3RlZCBpbnRvIHRoZSByb3RhdGVkIGRpc3BsYXkgZnJhbWUpLlxuICAgIGNvbnN0IGFkZCA9IChpZDogc3RyaW5nLCBsYXllcjogSW1hZ2VyeUxheWVyKSA9PiB7IHZpZXdlci5pbWFnZXJ5TGF5ZXJzLmFkZChsYXllcik7IGltYWdlcnkuY3VycmVudC5zZXQoaWQsIGxheWVyKTsgfTtcbiAgICAvLyBCb3R0b206IGEgd2hvbGUtTW9vbiBwaWN0dXJlIHN0b3JlZCBsb2NhbGx5LCBzbyB0aGUgTW9vbiBpcyBuZXZlciBibGFuayBhbmQgd29ya3Mgd2l0aG91dCBpbnRlcm5ldC5cbiAgICBhZGQoJ2Jhc2UnLCBuZXcgSW1hZ2VyeUxheWVyKGNyZWF0ZUJhc2VNb3NhaWNQcm92aWRlcih7IHVybDogJy4vZGF0YS9iYXNlL3Y1LycsIGNyZWRpdDogJ05BU0EgTW9vbiBUcmVrIMK3IExSTyBXQUMsIExPTEE7IE5BU0EgU1ZTIENHSSBNb29uIEtpdDsgTFJPQyBXQUMgcG9sYXIgc3VtbWVyIG1vc2FpY3MgwrcgTkFTQS9HU0ZDL0FTVScgfSkgYXMgbmV2ZXIpKTtcbiAgICAvLyBTaGFycGVyIHNvdXJjZXMgYXJlIGNob3NlbiBpbnNpZGUgdGhpcyBwcm92aWRlciwgc28gdGhleSB1c2Ugbm8gZXh0cmEgdGV4dHVyZSBzbG90LlxuICAgIGFkZCgncGhvdG8nLCBuZXcgSW1hZ2VyeUxheWVyKGNyZWF0ZU1vb25UcmVrUHJvdmlkZXIoeyBsYXllcjogJ0xST19XQUNfTW9zYWljX0dsb2JhbF8zMDNwcGRfdjAyJywgZXh0OiAnanBnJywgbWF4U291cmNlTGV2ZWw6IDgsIG1pblRydWVMYXQ6IC04MS41LCBjcmVkaXQ6ICdOQVNBL0dTRkMvQVNVIMK3IExSTyBXQUMvTkFDOyBJU0FTL0pBWEEgwrcgS2FndXlhIFRDOyBMdW5hciBRdWlja01hcCDCtyBOQVNBLCBJbnR1aXRpdmUgTWFjaGluZXMsIEFDVCcsIG92ZXJCYXNlOiB0cnVlLCBzaGFycFBob3RvOiB0cnVlIH0pIGFzIG5ldmVyKSk7XG4gICAgLy8gV2hlcmUgTkFTQSdzIFdBQyBtb3NhaWMgaXMgbGl0IGZyb20gdGhlIG90aGVyIHNpZGUgKHRydWUgbG9uIC0xODAuLi05MCk6IGFsYmVkbyB4IGhpbGxzaGFkZSBpbnN0ZWFkLCBzbyBubyBzZWFtIHNob3dzLlxuICAgIGFkZCgncGhvdG9GaXgnLCBuZXcgSW1hZ2VyeUxheWVyKGNyZWF0ZVNlYW1GaXhQcm92aWRlcih7IGNyZWRpdDogJ05BU0EgTW9vbiBUcmVrIMK3IExPTEEgLyBTTERFTTIwMTUgaGlsbHNoYWRlOyBOQVNBIFNWUyBDR0kgTW9vbiBLaXQnIH0pIGFzIG5ldmVyKSk7XG4gICAgYWRkKCdwaG90b1BvbGFyJywgbmV3IEltYWdlcnlMYXllcihjcmVhdGVQb2xhclJhc3RlclByb3ZpZGVyKHsgdXJsOiAnLi9kYXRhL2Jhc2Uvc291dGhwb2xlNDA5Ni5qcGcnLCBleHRlbnRNOiBQT0xBUl9FWFRFTlRfTSwgY3JlZGl0OiAnTFJPQyBXQUMvTkFDIMK3IEx1bmFzZXJ2JywgbWF4aW11bUxldmVsOiA4IH0pIGFzIG5ldmVyKSk7XG4gICAgLy8gU2hhcnAgc291dGgtcG9sZSBwaG90b3M6IHJlYWQgZnJvbSB0aGUgbG9jYWwgc3RvcmUgZmlyc3QgKHB1YmxpYy9kYXRhL3BvbGFyL3QpLCB0aGUgcmVtb3RlIHNlcnZlciBvbmx5IHdoZXJlIG5vdGhpbmcgaXMgc3RvcmVkLlxuICAgIC8vIFRoZSBsYXllciBuYW1lcyBtdXN0IG1hdGNoIHRoZSBzdG9yZWQgc2V0IGV4YWN0bHkuXG4gICAgYWRkKCdwb2xhclBob3RvJywgbmV3IEltYWdlcnlMYXllcihjcmVhdGVQb2xhclB5cmFtaWRQcm92aWRlcih7IGxheWVyczogJ2x1bmFfd2FjX3JvaV9zb3V0aF9zdW1tZXIsbHVuYV9uYWNfcG9sZV9jb250cm9sX3NvdXRoJywgbWluSzogNCwgY3JlZGl0OiAnTFJPQyBOQUMgc291dGgtcG9sZSBtb3NhaWMgwrcgTkFTQS9HU0ZDL0FTVScgfSkgYXMgbmV2ZXIsIHsgc2hvdzogZmFsc2UgfSkpO1xuICAgIGFkZCgnaGVpZ2h0JywgbmV3IEltYWdlcnlMYXllcihjcmVhdGVNb29uVHJla1Byb3ZpZGVyKHsgLi4uSEVJR0hUX1RSRUssIG1heFNvdXJjZUxldmVsOiA2LCBjcmVkaXQ6ICdOQVNBIE1vb24gVHJlayDCtyBMUk8gTE9MQScgfSkgYXMgbmV2ZXIsIHsgc2hvdzogZmFsc2UsIGFscGhhOiAwLjc1IH0pKTtcblxuICAgIC8vIEFmdGVyIGEgZmFpbGVkIGRvd25sb2FkIGlzIHJldHJpZWQsIGRyYXcgb25jZSBzbyB0aGUgcmVmaWxsZWQgdGlsZXMgc3RhcnQgbG9hZGluZy5cbiAgICBjb25zdCBvZmZSZWxvYWQgPSBpbWFnZXJ5UmVsb2FkZWQuYWRkRXZlbnRMaXN0ZW5lcigoKSA9PiB7IGlmICghdmlld2VyLmlzRGVzdHJveWVkKCkpIHNjZW5lLnJlcXVlc3RSZW5kZXIoKTsgfSk7XG5cbiAgICAvLyBUaGUgcmVhbCBza3k6IE1pbGt5IFdheSwgc3RhcnMsIHBsYW5ldHMsIGEgM0QgRWFydGggYW5kIHRoZSBTdW4sIGFsbCBpbiB0aGVpciB0cnVlIGRpcmVjdGlvbnMuXG4gICAgY29uc3Qgc2t5ID0gbmV3IFNwYWNlU2t5KHZpZXdlciwgeyBoZWlnaHRzIH0pO1xuICAgIHNreVJlZi5jdXJyZW50ID0gc2t5O1xuICAgIGRlYnVnSG9vay5za3kgPSBza3k7XG4gICAgLy8gVGhlIGxhbmRlciB2aWV3IG9ubHkgYWRkcyBuYW1lIHRhZ3MgZm9yIHRoZSBTdW4gYW5kIEVhcnRoOyB0aGUgc2t5IGRyYXdzIHRoZSBib2RpZXMgdGhlbXNlbHZlcy5cbiAgICAvLyBUaGUgbGFuZGVyIHZpZXcgZGltcyB0aGUgc3RhcnMgYW5kIE1pbGt5IFdheSB3aGVuIHN1bmxpdCBncm91bmQgb3IgdGhlIFN1biBpcyBpbiB2aWV3IChhcyBhIGNhbWVyYSB3b3VsZCkuXG4gICAgY29uc3QgbGFuZGVyID0gbmV3IExhbmRlclZpZXcodmlld2VyLCBoZWlnaHRzLCB7IG93bkJvZGllczogZmFsc2UsIG9uU2t5RXhwb3N1cmU6IHYgPT4geyBza3kuZXhwb3N1cmUgPSB2OyB9IH0pO1xuICAgIGxhbmRlclJlZi5jdXJyZW50ID0gbGFuZGVyO1xuICAgIGRlYnVnSG9vay5sYW5kZXIgPSBsYW5kZXI7IGRlYnVnSG9vay5oZWlnaHRzID0gaGVpZ2h0cztcbiAgICAvLyBDbGlja2luZyB0aGUgU3VuIG9yIEVhcnRoIGNoaXAgZ2xpZGVzIHRoZSBjYW1lcmEgdG8gYSB2aWV3IHdoZXJlIHRoYXQgYm9keSBzaG93cyBhYm92ZSB0aGUgTW9vbidzIGVkZ2UuXG4gICAgbWFya2Vyc1JlZi5jdXJyZW50ID0gbmV3IFNreU1hcmtlcnModmlld2VyLCB7IG9uUGljazogKF9ib2R5LCBkaXIpID0+IHsgaWYgKCFsYW5kZXIuYWN0aXZlKSB2b2lkIG5hdlJlZi5jdXJyZW50Py5zaG93Qm9keShkaXIpOyB9IH0pO1xuXG4gICAgY29uc3QgbGFiZWxzID0gbmV3IE5hbWVMYWJlbHModmlld2VyKTtcbiAgICBsYWJlbHNSZWYuY3VycmVudCA9IGxhYmVscztcbiAgICBpZiAoaW1wb3J0Lm1ldGEuZW52LkRFVikgKHdpbmRvdyBhcyB1bmtub3duIGFzIHsgX19sYWJlbHM6IE5hbWVMYWJlbHMgfSkuX19sYWJlbHMgPSBsYWJlbHM7XG4gICAgaGVpZ2h0cy5yZWFkeS50aGVuKCgpID0+IHtcbiAgICAgIGlmICh2aWV3ZXIuaXNEZXN0cm95ZWQoKSkgcmV0dXJuO1xuICAgICAgLy8gQXJ0ZW1pcyByZWdpb25zLCBmYW1vdXMgc3BvdHMgYW5kIHBhc3QgbGFuZGluZ3M6IGljb24gKyBuYW1lLCBib3RoIHBsYWNlZCBieSB0aGUgbGFiZWwgbWFuYWdlciBzbyBub3RoaW5nIG92ZXJsYXBzXG4gICAgICBsYWJlbHMuc2V0UGxhY2VzKFBMQUNFUywgaGVpZ2h0cywgT2JqZWN0LmZyb21FbnRyaWVzKE9iamVjdC5lbnRyaWVzKElDT04pLm1hcCgoW2ssIGltYWdlXSkgPT4gW2ssIHsgaW1hZ2UsIHNpemU6IGsgPT09ICdtaXNzaW9uJyA/IDIwIDogMjIgfV0pKSk7XG4gICAgICBsYWJlbHMudXBkYXRlKCk7IHNjZW5lLnJlcXVlc3RSZW5kZXIoKTtcbiAgICB9KTtcbiAgICAvLyBOYW1lcyBhbmQgaWNvbnMga2VlcCBjbGVhciBvZiB0aGUgcGlucyBhbmQgb2YgdGhlIFN1bi9FYXJ0aCBzcG90cy5cbiAgICBjb25zdCBwaW5TY3JhdGNoUiA9IG5ldyBDYXJ0ZXNpYW4zKCksIHBpbldpblIgPSBuZXcgQ2FydGVzaWFuMigpO1xuICAgIGxhYmVscy5yZXNlcnZlZCA9IFtcbiAgICAgICgpID0+IHtcbiAgICAgICAgY29uc3Qgb3V0OiB7IHgwOiBudW1iZXI7IHkwOiBudW1iZXI7IHgxOiBudW1iZXI7IHkxOiBudW1iZXIgfVtdID0gW107XG4gICAgICAgIGlmIChjYi5jdXJyZW50LmxhbmRlcikgcmV0dXJuIG91dDtcbiAgICAgICAgY29uc3QgbGlzdDogeyBsYXQ6IG51bWJlcjsgbG9uOiBudW1iZXIgfVtdID0gWy4uLmNiLmN1cnJlbnQucGluc107XG4gICAgICAgIGlmIChjYi5jdXJyZW50LnNlbGVjdGVkUGluKSBsaXN0LnB1c2goY2IuY3VycmVudC5zZWxlY3RlZFBpbik7XG4gICAgICAgIGNvbnN0IGNhbVBvcyA9IHZpZXdlci5jYW1lcmEucG9zaXRpb25XQztcbiAgICAgICAgZm9yIChjb25zdCBwaW4gb2YgbGlzdCkge1xuICAgICAgICAgIGNvbnN0IHBvcyA9IHRvQ2FydGVzaWFuKHBpbi5sYXQsIHBpbi5sb24sIGhlaWdodHMuaGVpZ2h0QXQocGluLmxhdCwgcGluLmxvbiwgZmFsc2UpLCBwaW5TY3JhdGNoUik7XG4gICAgICAgICAgY29uc3QgdG9DYW0gPSBDYXJ0ZXNpYW4zLnN1YnRyYWN0KGNhbVBvcywgcG9zLCBuZXcgQ2FydGVzaWFuMygpKTtcbiAgICAgICAgICBpZiAoQ2FydGVzaWFuMy5kb3QodG9DYW0sIHBvcykgPCAtMC4wOCAqIENhcnRlc2lhbjMubWFnbml0dWRlKHRvQ2FtKSAqIENhcnRlc2lhbjMubWFnbml0dWRlKHBvcykpIGNvbnRpbnVlOyAvLyB3ZWxsIHJvdW5kIHRoZSBmYXIgc2lkZVxuICAgICAgICAgIGNvbnN0IHcgPSBzY2VuZS5jYXJ0ZXNpYW5Ub0NhbnZhc0Nvb3JkaW5hdGVzKHBvcywgcGluV2luUik7XG4gICAgICAgICAgaWYgKHcpIG91dC5wdXNoKHsgeDA6IHcueCAtIDE1LCB5MDogdy55IC0gMzcsIHgxOiB3LnggKyAxNSwgeTE6IHcueSArIDIgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG91dDtcbiAgICAgIH0sXG4gICAgICAoKSA9PiBtYXJrZXJzUmVmLmN1cnJlbnQ/LnNwb3RCb3hlcygpID8/IFtdLFxuICAgICAgLy8gdGhlIHBhZ2UncyBvd24gcGFuZWxzIChpbmZvIHBhbmVsLCBDb21wYXJlIGRyYXdlciwgTGF5ZXJzIGJveCwgbWFwIGJ1dHRvbnMpOiBuYW1lcyBhcmUgbm90IHB1dCB1bmRlcm5lYXRoIHRoZW1cbiAgICAgICgpID0+IHtcbiAgICAgICAgY29uc3Qgb3V0OiB7IHgwOiBudW1iZXI7IHkwOiBudW1iZXI7IHgxOiBudW1iZXI7IHkxOiBudW1iZXIgfVtdID0gW107XG4gICAgICAgIGNvbnN0IGMgPSBzY2VuZS5jYW52YXMuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgICAgIGZvciAoY29uc3QgZWwgb2YgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJy5wYW5lbCwgLmlidG4uZ2xhc3MnKSkge1xuICAgICAgICAgIGNvbnN0IHIgPSBlbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgICAgICBpZiAoci53aWR0aCA8IDIgfHwgci5oZWlnaHQgPCAyKSBjb250aW51ZTtcbiAgICAgICAgICBvdXQucHVzaCh7IHgwOiByLmxlZnQgLSBjLmxlZnQgLSA2LCB5MDogci50b3AgLSBjLnRvcCAtIDQsIHgxOiByLnJpZ2h0IC0gYy5sZWZ0ICsgNiwgeTE6IHIuYm90dG9tIC0gYy50b3AgKyA0IH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBvdXQ7XG4gICAgICB9LFxuICAgIF07XG4gICAgbGV0IGxhc3RMYWJlbCA9IDAsIHNldHRsZSA9IDA7XG4gICAgY29uc3QgcmVhZEJhcnMgPSAoKSA9PiB7XG4gICAgICBjb25zdCBzdCA9IGdldENvbXB1dGVkU3R5bGUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50KTtcbiAgICAgIGNvbnN0IGRvY2sgPSBwYXJzZUZsb2F0KHN0LmdldFByb3BlcnR5VmFsdWUoJy0tZG9jaycpKTtcbiAgICAgIGlmIChOdW1iZXIuaXNGaW5pdGUoZG9jaykgJiYgZG9jayA+IDApIGxhYmVscy5ib3R0b20gPSBkb2NrICsgODtcbiAgICB9O1xuICAgIC8vIFBpbnMgYXJlIGRyYXduIG9uIHRvcCBvZiBldmVyeXRoaW5nIChuZXZlciBjdXQgYnkgYSBoaWxsKSwgc28gaGlkZSB0aGUgb25lcyByb3VuZCB0aGUgZmFyIHNpZGUgYnkgaGFuZC5cbiAgICBjb25zdCBwaW5GYWNpbmcgPSAoKSA9PiB7XG4gICAgICBjb25zdCBjYW0gPSB2aWV3ZXIuY2FtZXJhLnBvc2l0aW9uV0M7XG4gICAgICBjb25zdCBlbnRzID0gWy4uLnBpbkVudGl0aWVzLmN1cnJlbnQudmFsdWVzKCldO1xuICAgICAgaWYgKHNlbGVjdGVkRW50aXR5LmN1cnJlbnQpIGVudHMucHVzaChzZWxlY3RlZEVudGl0eS5jdXJyZW50KTtcbiAgICAgIGZvciAoY29uc3QgZSBvZiBlbnRzKSB7XG4gICAgICAgIGNvbnN0IHAgPSBlLnBvc2l0aW9uPy5nZXRWYWx1ZSh1bmRlZmluZWQgYXMgbmV2ZXIpIGFzIENhcnRlc2lhbjMgfCB1bmRlZmluZWQ7XG4gICAgICAgIGlmICghcCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IHRvQ2FtID0gQ2FydGVzaWFuMy5zdWJ0cmFjdChjYW0sIHAsIG5ldyBDYXJ0ZXNpYW4zKCkpO1xuICAgICAgICBjb25zdCBzaG93ID0gQ2FydGVzaWFuMy5kb3QodG9DYW0sIHApID4gMC4wMSAqIENhcnRlc2lhbjMubWFnbml0dWRlKHRvQ2FtKSAqIENhcnRlc2lhbjMubWFnbml0dWRlKHApO1xuICAgICAgICBpZiAoZS5zaG93ICE9PSBzaG93KSBlLnNob3cgPSBzaG93O1xuICAgICAgfVxuICAgIH07XG4gICAgZGVidWdIb29rLnBpbkZhY2luZyA9IHBpbkZhY2luZztcbiAgICBjb25zdCByZWxhYmVsID0gKCkgPT4geyByZWFkQmFycygpOyBwaW5GYWNpbmcoKTsgbGFiZWxzLnVwZGF0ZSgpOyBzY2VuZS5yZXF1ZXN0UmVuZGVyKCk7IH07XG4gICAgY29uc3QgcmVwb3J0ID0gKCkgPT4ge1xuICAgICAgY29uc3QgaHAgPSBjYW1lcmFIZWFkaW5nUGl0Y2godmlld2VyKTtcbiAgICAgIGNhbWVyYVN0b3JlLnNldCh7IGttOiBocC5rbSwgaGVhZGluZzogbGFuZGVyLmFjdGl2ZSA/IGxhbmRlci5oZWFkaW5nRGVnKCkgOiBocC5oZWFkaW5nLCBwaXRjaDogaHAucGl0Y2ggfSk7XG4gICAgfTtcbiAgICB2aWV3ZXIuY2FtZXJhLmNoYW5nZWQuYWRkRXZlbnRMaXN0ZW5lcigoKSA9PiB7XG4gICAgICByZXBvcnQoKTtcbiAgICAgIGNvbnN0IG5vdyA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICAgICAgaWYgKG5vdyAtIGxhc3RMYWJlbCA+IDkwKSB7IGxhc3RMYWJlbCA9IG5vdzsgcmVsYWJlbCgpOyB9XG4gICAgICBjbGVhclRpbWVvdXQoc2V0dGxlKTtcbiAgICAgIHNldHRsZSA9IHdpbmRvdy5zZXRUaW1lb3V0KHJlbGFiZWwsIDE0MCk7XG4gICAgfSk7XG4gICAgdmlld2VyLmNhbWVyYS5wZXJjZW50YWdlQ2hhbmdlZCA9IDAuMDAyO1xuICAgIC8vIFdpbmRvdyBvciBwYW5lbCByZXNpemVkOiBuYW1lcyBtdXN0IGJlIHJlLWZpdHRlZCB0byB0aGUgbmV3IHNjcmVlbiBzaXplLlxuICAgIGNvbnN0IHJlc2l6ZU9icyA9IG5ldyBSZXNpemVPYnNlcnZlcigoKSA9PiB7IGNsZWFyVGltZW91dChzZXR0bGUpOyBzZXR0bGUgPSB3aW5kb3cuc2V0VGltZW91dChyZWxhYmVsLCA2MCk7IGZsYXRSZWYuY3VycmVudD8ucmVzaXplKCk7IH0pO1xuICAgIHJlc2l6ZU9icy5vYnNlcnZlKGhvc3QuY3VycmVudCEpO1xuICAgIC8vIEEgcGFuZWwgb3BlbmVkIG9yIGNsb3NlZCAoaW5mbyBwYW5lbCwgQ29tcGFyZSwgTGF5ZXJzKTogcmUtcGxhY2UgdGhlIG5hbWVzIG9uY2UgaXQgaGFzIHNsaWQgaW4uXG4gICAgY29uc3QgYXBwRWwgPSBob3N0LmN1cnJlbnQhLmNsb3Nlc3QoJy5hcHAnKTtcbiAgICBjb25zdCBwYW5lbE9icyA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHsgY2xlYXJUaW1lb3V0KHNldHRsZSk7IHNldHRsZSA9IHdpbmRvdy5zZXRUaW1lb3V0KHJlbGFiZWwsIDI2MCk7IH0pO1xuICAgIGlmIChhcHBFbCkgcGFuZWxPYnMub2JzZXJ2ZShhcHBFbCwgeyBjaGlsZExpc3Q6IHRydWUsIGF0dHJpYnV0ZXM6IHRydWUsIGF0dHJpYnV0ZUZpbHRlcjogWydjbGFzcyddIH0pO1xuXG4gICAgLy8gV2hhdCBpcyB1bmRlciB0aGUgcG9pbnRlcj8gU2NyZWVuLXNwYWNlIG1hdGhzIG9ubHkgKGFza2luZyB0aGUgR1BVIGNvc3RzIDEwLTIwMCBtcyBwZXIgcXVlc3Rpb24pLlxuICAgIGNvbnN0IHBpY2tQb3MgPSBuZXcgQ2FydGVzaWFuMigpLCBwaW5TY3JhdGNoID0gbmV3IENhcnRlc2lhbjMoKSwgcGluV2luID0gbmV3IENhcnRlc2lhbjIoKTtcbiAgICBjb25zdCBncm91bmRBdCA9ICh4OiBudW1iZXIsIHk6IG51bWJlcikgPT4ge1xuICAgICAgY29uc3QgcmF5ID0gdmlld2VyLmNhbWVyYS5nZXRQaWNrUmF5KENhcnRlc2lhbjIuZnJvbUVsZW1lbnRzKHgsIHksIHBpY2tQb3MpKTtcbiAgICAgIGNvbnN0IGhpdCA9IHJheSAmJiBnbG9iZS5waWNrKHJheSwgc2NlbmUpO1xuICAgICAgaWYgKCFoaXQpIHJldHVybiBudWxsO1xuICAgICAgY29uc3QgdCA9IHRvVHJ1ZUxhdExvbihoaXQpO1xuICAgICAgcmV0dXJuIHsgbGF0OiB0LmxhdCwgbG9uOiB0LmxvbiB9O1xuICAgIH07XG4gICAgY29uc3QgdGFnQXQgPSAoeDogbnVtYmVyLCB5OiBudW1iZXIpID0+IHRhZ09mKGxhYmVscy5oaXRUZXN0KHgsIHkpKTtcbiAgICAvKiogQSBjb21wYXJlIHBpbiAob3IgdGhlIHNlbGVjdGVkIHBpbikgZHJhd24gYXQgdGhpcyBzY3JlZW4gcG9zaXRpb24sIGlmIGFueS4gKi9cbiAgICBjb25zdCBwaW5BdCA9ICh4OiBudW1iZXIsIHk6IG51bWJlcik6IHsgbGF0OiBudW1iZXI7IGxvbjogbnVtYmVyIH0gfCBudWxsID0+IHtcbiAgICAgIGNvbnN0IGxpc3Q6IHsgbGF0OiBudW1iZXI7IGxvbjogbnVtYmVyIH1bXSA9IFsuLi5jYi5jdXJyZW50LnBpbnNdO1xuICAgICAgaWYgKGNiLmN1cnJlbnQuc2VsZWN0ZWRQaW4pIGxpc3QucHVzaChjYi5jdXJyZW50LnNlbGVjdGVkUGluKTtcbiAgICAgIGZvciAoY29uc3QgcGluIG9mIGxpc3QpIHtcbiAgICAgICAgY29uc3QgdyA9IHNjZW5lLmNhcnRlc2lhblRvQ2FudmFzQ29vcmRpbmF0ZXModG9DYXJ0ZXNpYW4ocGluLmxhdCwgcGluLmxvbiwgaGVpZ2h0cy5oZWlnaHRBdChwaW4ubGF0LCBwaW4ubG9uLCBmYWxzZSksIHBpblNjcmF0Y2gpLCBwaW5XaW4pO1xuICAgICAgICBpZiAodyAmJiB4ID49IHcueCAtIDE1ICYmIHggPD0gdy54ICsgMTUgJiYgeSA+PSB3LnkgLSA0MCAmJiB5IDw9IHcueSArIDIpIHJldHVybiB7IGxhdDogcGluLmxhdCwgbG9uOiBwaW4ubG9uIH07XG4gICAgICB9XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9O1xuICAgIGxldCBsYXN0SG92ZXIgPSAwO1xuICAgIG5hdlJlZi5jdXJyZW50ID0gYXR0YWNoTmF2aWdhdGlvbih2aWV3ZXIsIGhlaWdodHMsIHtcbiAgICAgIG9uRm92V2hlZWw6IGQgPT4gbGFuZGVyLnpvb21Gb3YoZCksXG4gICAgICBpc0NsaWNrYWJsZUF0OiAoeCwgeSkgPT4gISF0YWdBdCh4LCB5KSB8fCAhIXBpbkF0KHgsIHkpLFxuICAgICAgLy8gQ2xpY2s6IGEgbmFtZSBvciBtYXJrZXIgZmlyc3QsIHRoZW4gYSBwaW4sIG90aGVyd2lzZSBkcm9wIGEgbmV3IHBpbiBvbiB0aGUgZ3JvdW5kLlxuICAgICAgb25DbGljazogKHgsIHkpID0+IHtcbiAgICAgICAgaWYgKGxhbmRlci5hY3RpdmUpIHJldHVybjtcbiAgICAgICAgaWYgKGNiLmN1cnJlbnQuY2hvb3NpbmdEZXN0aW5hdGlvbikge1xuICAgICAgICAgIGNvbnN0IGcgPSBncm91bmRBdCh4LCB5KTtcbiAgICAgICAgICBpZiAoZykgY2IuY3VycmVudC5vblJvdXRlRGVzdGluYXRpb24/LihnLmxhdCwgZy5sb24pO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCB0YWcgPSB0YWdBdCh4LCB5KTtcbiAgICAgICAgaWYgKHRhZz8udHlwZSA9PT0gJ25hbWUnICYmIHRhZy5uYW1lKSByZXR1cm4gY2IuY3VycmVudC5vblNlbGVjdCh7IHR5cGU6ICduYW1lJywgbmFtZTogdGFnLm5hbWUgfSk7XG4gICAgICAgIGlmICh0YWc/LnR5cGUgPT09ICdwbGFjZScgJiYgdGFnLnBsYWNlKSByZXR1cm4gY2IuY3VycmVudC5vblNlbGVjdCh7IHR5cGU6ICdwbGFjZScsIHBsYWNlOiB0YWcucGxhY2UgfSk7XG4gICAgICAgIGNvbnN0IGcgPSBwaW5BdCh4LCB5KSA/PyBncm91bmRBdCh4LCB5KTtcbiAgICAgICAgaWYgKGcpIGNiLmN1cnJlbnQub25TZWxlY3QoeyB0eXBlOiAncGluJywgLi4uZyB9KTtcbiAgICAgIH0sXG4gICAgICBvbkhvdmVyTW92ZTogKHgsIHkpID0+IHtcbiAgICAgICAgbGFiZWxzLnNldEhvdmVyKGxhYmVscy5oaXRUZXN0KHgsIHkpKTtcbiAgICAgICAgY29uc3Qgbm93ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gICAgICAgIGlmIChub3cgLSBsYXN0SG92ZXIgPiA4MCkgeyBsYXN0SG92ZXIgPSBub3c7IGNiLmN1cnJlbnQub25Ib3Zlcihncm91bmRBdCh4LCB5KSk7IH1cbiAgICAgIH0sXG4gICAgfSk7XG4gICAgZGVidWdIb29rLm5hdiA9IG5hdlJlZi5jdXJyZW50O1xuXG4gICAgLy8gVGhlIGZsYXQgbWFwICgyRCkgYW5kIHRoZSBtb3ZlIGJldHdlZW4gaXQgYW5kIHRoZSBnbG9iZSAoZmxhdE1hcC50cywgbWFwTW9kZS50cykuXG4gICAgY29uc3QgZmxhdCA9IG5ldyBGbGF0TWFwKGhvc3QuY3VycmVudCEsIHtcbiAgICAgIGxhYmVsczogKCkgPT4gbGFiZWxzLmZsYXRFbnRyaWVzKCksXG4gICAgICByb3V0ZTogKCkgPT4gY2IuY3VycmVudC5vdmVydmlld1JvdXRlID8/IG51bGwsXG4gICAgICBkZXN0aW5hdGlvbjogKCkgPT4gY2IuY3VycmVudC5yb3V0ZURlc3RpbmF0aW9uID8/IG51bGwsXG4gICAgICBjaG9vc2luZ0Rlc3RpbmF0aW9uOiAoKSA9PiAhIWNiLmN1cnJlbnQuY2hvb3NpbmdEZXN0aW5hdGlvbixcbiAgICAgIGljb246IGtpbmQgPT4gbGFiZWxzLmljb25PZihraW5kKSxcbiAgICAgIHBpbnM6ICgpID0+IHtcbiAgICAgICAgY29uc3Qgb3V0OiB7IGxhdDogbnVtYmVyOyBsb246IG51bWJlcjsgaW1hZ2U6IHN0cmluZyB9W10gPSBjYi5jdXJyZW50LnBpbnMubWFwKHAgPT4gKHsgbGF0OiBwLmxhdCwgbG9uOiBwLmxvbiwgaW1hZ2U6IFBJTl9TVkcocC5jb2xvciwgcC5sZXR0ZXIpIH0pKTtcbiAgICAgICAgaWYgKGNiLmN1cnJlbnQuc2VsZWN0ZWRQaW4pIG91dC5wdXNoKHsgLi4uY2IuY3VycmVudC5zZWxlY3RlZFBpbiwgaW1hZ2U6IFBJTl9TVkcoJycpIH0pO1xuICAgICAgICByZXR1cm4gb3V0O1xuICAgICAgfSxcbiAgICAgIHBhbmVsQm94ZXM6ICgpID0+IHtcbiAgICAgICAgY29uc3Qgb3V0OiB7IHgwOiBudW1iZXI7IHkwOiBudW1iZXI7IHgxOiBudW1iZXI7IHkxOiBudW1iZXIgfVtdID0gW107XG4gICAgICAgIGNvbnN0IGMgPSBob3N0LmN1cnJlbnQhLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgICBmb3IgKGNvbnN0IGVsIG9mIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCcucGFuZWwsIC5pYnRuLmdsYXNzLCAudGJhci1jbG9jaycpKSB7XG4gICAgICAgICAgY29uc3QgciA9IGVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgICAgIGlmIChyLndpZHRoID49IDIgJiYgci5oZWlnaHQgPj0gMikgb3V0LnB1c2goeyB4MDogci5sZWZ0IC0gYy5sZWZ0IC0gNiwgeTA6IHIudG9wIC0gYy50b3AgLSA0LCB4MTogci5yaWdodCAtIGMubGVmdCArIDYsIHkxOiByLmJvdHRvbSAtIGMudG9wICsgNCB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gb3V0O1xuICAgICAgfSxcbiAgICAgIC8vIGZpeGVkIG1hcmdpbnMgKHRoZSBidXR0b24gY29sdW1uLCB0aGUgdG9wIGJhciwgdGhlIHRpbWUgYmFyKTogcGFuZWxzIG9wZW5pbmcgbGF0ZXIgbXVzdCBub3Qgc2hpZnQgdGhlIG1hcFxuICAgICAgaW5zZXRzOiAoKSA9PiAoeyB0b3A6IGxhYmVscy50b3AgKyA4LCBib3R0b206IGxhYmVscy5ib3R0b20gKyAzNCwgbGVmdDogNjQsIHJpZ2h0OiA3NiB9KSxcbiAgICAgIG9uQ2xpY2tUYWc6IGlkID0+IHtcbiAgICAgICAgY29uc3QgdGFnID0gdGFnT2YoaWQpO1xuICAgICAgICBpZiAodGFnPy50eXBlID09PSAnbmFtZScgJiYgdGFnLm5hbWUpIGNiLmN1cnJlbnQub25TZWxlY3QoeyB0eXBlOiAnbmFtZScsIG5hbWU6IHRhZy5uYW1lIH0pO1xuICAgICAgICBlbHNlIGlmICh0YWc/LnR5cGUgPT09ICdwbGFjZScgJiYgdGFnLnBsYWNlKSBjYi5jdXJyZW50Lm9uU2VsZWN0KHsgdHlwZTogJ3BsYWNlJywgcGxhY2U6IHRhZy5wbGFjZSB9KTtcbiAgICAgIH0sXG4gICAgICBvbkNsaWNrR3JvdW5kOiAobGF0LCBsb24pID0+IHtcbiAgICAgICAgaWYgKGNiLmN1cnJlbnQuY2hvb3NpbmdEZXN0aW5hdGlvbikgY2IuY3VycmVudC5vblJvdXRlRGVzdGluYXRpb24/LihsYXQsIGxvbik7XG4gICAgICAgIGVsc2UgY2IuY3VycmVudC5vblNlbGVjdCh7IHR5cGU6ICdwaW4nLCBsYXQsIGxvbiB9KTtcbiAgICAgIH0sXG4gICAgICBvbkhvdmVyOiBwb3MgPT4gY2IuY3VycmVudC5vbkhvdmVyKHBvcyksXG4gICAgICAvLyB0aGUgc3RhdHVzIGxpbmUncyBleWUgaGVpZ2h0OiB0aGUgaGVpZ2h0IGEgY2FtZXJhIHdvdWxkIG5lZWQgdG8gc2VlIHdoYXQgdGhlIGZsYXQgbWFwIHNob3dzXG4gICAgICBvblZpZXc6IGttID0+IGNhbWVyYVN0b3JlLnNldCh7IGttLCBoZWFkaW5nOiAwLCBwaXRjaDogLTkwIH0pLFxuICAgICAgLy8gem9vbWluZyBpbiBhdCB0aGUgZmxhdCBtYXAncyBjbG9zZXN0IHpvb206IG9mZmVyIHRvIHJvbGwgYmFjayB0byB0aGUgZ2xvYmUgcmlnaHQgdGhlcmVcbiAgICAgIGxpbWl0VGV4dDogKCkgPT4gKHsgbXNnOiB0KCdtYXAuZmxhdExpbWl0JyksIGdvOiB0KCdtYXAuZmxhdENsb3NlcicpIH0pLFxuICAgICAgb25DbG9zZXI6IChsYXQsIGxvbikgPT4geyB2b2lkIG1vZGVzUmVmLmN1cnJlbnQ/LnRvR2xvYmUoeyBhdDogeyBsYXQsIGxvbiwga206IDE0MCB9IH0pOyB9LFxuICAgIH0pO1xuICAgIGZsYXRSZWYuY3VycmVudCA9IGZsYXQ7XG4gICAgY29uc3QgbW9kZXMgPSBuZXcgTWFwTW9kZXMoZmxhdCwge1xuICAgICAgdmlld2VyLCBuYXY6IG5hdlJlZi5jdXJyZW50LFxuICAgICAgaGVpZ2h0QXQ6IChsYXQsIGxvbikgPT4gaGVpZ2h0cy5oZWlnaHRBdChsYXQsIGxvbiwgZmFsc2UpLFxuICAgICAgc2V0R2xvYmVFeHRyYXM6IG9uID0+IHtcbiAgICAgICAgY29uc3QgcCA9IGNiLmN1cnJlbnQ7XG4gICAgICAgIGxhYmVscy52aXNpYmxlID0gb24gJiYgISFwLmxheWVycy5uYW1lcyAmJiAhcC5sYW5kZXI7XG4gICAgICAgIGxhYmVscy5wbGFjZXNWaXNpYmxlID0gcGxhY2VGbGFncyhvbiAmJiAhcC5sYW5kZXIsIHAubGF5ZXJzKTtcbiAgICAgICAgbGFiZWxzLnVwZGF0ZSgpO1xuICAgICAgICBjb25zdCBtID0gbWFya2Vyc1JlZi5jdXJyZW50O1xuICAgICAgICBpZiAobSkgbS5zaG93ID0gb24gJiYgcC5sYXllcnMucmVhbFN1biAhPT0gZmFsc2UgJiYgIXAubGFuZGVyO1xuICAgICAgICB2aWV3ZXIuZW50aXRpZXMuc2hvdyA9IG9uO1xuICAgICAgICBzY2VuZS5yZXF1ZXN0UmVuZGVyKCk7XG4gICAgICB9LFxuICAgIH0pO1xuICAgIG1vZGVzLm9uQ2hhbmdlID0gbSA9PiBjYi5jdXJyZW50Lm9uTWFwTW9kZT8uKG0pO1xuICAgIG1vZGVzUmVmLmN1cnJlbnQgPSBtb2RlcztcbiAgICBkZWJ1Z0hvb2suZmxhdCA9IGZsYXQ7IGRlYnVnSG9vay5tb2RlcyA9IG1vZGVzO1xuXG4gICAgLy8gU3RhcnQ6IHdob2xlIE1vb24sIHRpbHRlZCBzbyB0aGUgc291dGggcG9sZSBpcyB2aXNpYmxlLCB0cnVlIG5vcnRoIHVwLlxuICAgIGNvbnN0IHN0YXJ0ID0gcG9zZUdsb2JlKFdIT0xFLmxhdCwgV0hPTEUubG9uLCBXSE9MRS5hbHQpO1xuICAgIHZpZXdlci5jYW1lcmEuc2V0Vmlldyh7IGRlc3RpbmF0aW9uOiBzdGFydC5kZXN0aW5hdGlvbiwgb3JpZW50YXRpb246IHsgZGlyZWN0aW9uOiBzdGFydC5kaXJlY3Rpb24sIHVwOiBzdGFydC51cCB9IH0pO1xuICAgIHJlcG9ydCgpO1xuXG4gICAgLy8gQmVoaW5kIHRoZSBsb2FkaW5nIHNjcmVlbjogbG9hZCBkYXRhIGFuZCBxdWlldGx5IHZpc2l0IHRoZSBzb3V0aC1wb2xlIHZpZXdzIHNvIHRoZXkgYXJlIGluc3RhbnQgbGF0ZXIuXG4gICAgY29uc3QgZGVidWcgPSBkZWJ1Z0hvb2sgYXMgeyBwcm9ncmVzcz86IExvYWRQcm9ncmVzczsgc2tpcExvYWRpbmc/OiAoKSA9PiB2b2lkIH07XG4gICAgZGVidWcuc2tpcExvYWRpbmcgPSAoKSA9PiB7IHNraXBQcmVsb2FkLmN1cnJlbnQgPSB0cnVlOyB9O1xuICAgIG5hdlJlZi5jdXJyZW50LmVuYWJsZWQgPSBmYWxzZTtcbiAgICB2b2lkIHJ1blByZWxvYWQodmlld2VyLCB7XG4gICAgICBoZWlnaHRzUmVhZHk6IGhlaWdodHMucmVhZHksXG4gICAgICBuYW1lc1JlYWR5OiBuZXcgUHJvbWlzZTx2b2lkPihyZXMgPT4geyBuYW1lc0xvYWRlZC5jdXJyZW50ID0gcmVzOyB9KSxcbiAgICAgIHN0YXJ0Vmlldzogc3RhcnQsXG4gICAgICBza3lSZWFkeTogc2t5LnJlYWR5LFxuICAgICAgaW1hZ2VyeVBlbmRpbmcsXG4gICAgICBsYW5kZXI6IGxhbmRlciBhcyB7IHByZXdhcm0/OiAoKSA9PiBQcm9taXNlPHVua25vd24+IH0sXG4gICAgICAvLyBGZXRjaCB0aGUgbWFwcywgdGhlbiBwcmVwYXJlIHRoZWlyIHJlYWwgcHJvdmlkZXJzIHdoaWxlIHRoZSBzdGFydCBzY3JlZW4gaXMgc3RpbGwgdXAuXG4gICAgICBsYXllckZpbGVzOiAoKSA9PiBsb2FkTWFuaWZlc3QoKS5jYXRjaCgoKSA9PiBbXSBhcyB7IGlkOiBzdHJpbmcgfVtdKS50aGVuKGxpc3QgPT4gW1xuICAgICAgICAuLi5saXN0LmZpbHRlcihlID0+IFNDSUVOQ0VfU1dJVENIRVMuaGFzKGUuaWQpKS5mbGF0TWFwKGUgPT4gKCdyYXN0ZXJTb3VyY2VzJyBpbiBlICYmIEFycmF5LmlzQXJyYXkoZS5yYXN0ZXJTb3VyY2VzKSA/IGUucmFzdGVyU291cmNlcy5tYXAocyA9PiBzLnVybCkgOiBbYC4vZGF0YS9sYXllcnMvJHtlLmlkfS5wbmdgXSkpLm1hcCh1cmwgPT4gbmV3IFVSTCh1cmwsIGRvY3VtZW50LmJhc2VVUkkpLmhyZWYpLFxuICAgICAgICAvLyB0aGUgY3JhdGVyIGxpc3QgYmVoaW5kIHRoZSBDcmF0ZXJzIGxheWVyIGFuZCB0aGUgcm91dGUgcGxhbm5lciAoMS40IE1CKVxuICAgICAgICBuZXcgVVJMKCcuL2RhdGEvZmVhdHVyZXMvY3JhdGVycy5iaW4nLCBkb2N1bWVudC5iYXNlVVJJKS5ocmVmLCBuZXcgVVJMKCcuL2RhdGEvZmVhdHVyZXMvY3JhdGVycy1zbWFsbC1zb3V0aC5iaW4nLCBkb2N1bWVudC5iYXNlVVJJKS5ocmVmLFxuICAgICAgICAuLi5mbGF0VHJla1RpbGVzKEhFSUdIVF9UUkVLLmxheWVyLCBIRUlHSFRfVFJFSy5leHQpLFxuICAgICAgXSksXG4gICAgICB3YXJtTGF5ZXJzOiBhc3luYyBvbkZyYWMgPT4ge1xuICAgICAgICBjb25zdCBkZWZzID0gKGF3YWl0IGxvYWRNYW5pZmVzdCgpKS5tYXAoc2NpZW5jZVRvTGF5ZXIpLmZpbHRlcihkID0+IFNDSUVOQ0VfU1dJVENIRVMuaGFzKGQuaWQpKTtcbiAgICAgICAgaWYgKHZpZXdlci5pc0Rlc3Ryb3llZCgpKSByZXR1cm47XG4gICAgICAgIHByZXBhcmVTY2llbmNlTGF5ZXJzKHZpZXdlciwgaW1hZ2VyeS5jdXJyZW50LCBkZWZzKTtcbiAgICAgICAgYXdhaXQgd2FybVNjaWVuY2VSYXN0ZXJzKGRlZnMuZmxhdE1hcChzY2llbmNlU291cmNlcyksIG9uRnJhYyk7XG4gICAgICAgIC8vIEVhY2ggbWFwIGhhcyBhIHJlYWR5IHBhcmVudCB0aWxlIGV2ZXJ5d2hlcmUsIGV2ZW4gYWZ0ZXIgdGhlIGNhbWVyYSBtb3Zlcy5cbiAgICAgICAgY29uc3QgcHJvdmlkZXJzID0gWy4uLmRlZnMubWFwKGQgPT4gaW1hZ2VyeS5jdXJyZW50LmdldChkLmlkID09PSAnaGVpZ2h0JyA/ICdoZWlnaHRQb2xhcicgOiBkLmlkKT8uaW1hZ2VyeVByb3ZpZGVyKSwgaW1hZ2VyeS5jdXJyZW50LmdldCgnaGVpZ2h0Jyk/LmltYWdlcnlQcm92aWRlcl07XG4gICAgICAgIGZvciAoY29uc3QgcHJvdmlkZXIgb2YgcHJvdmlkZXJzKSBpZiAocHJvdmlkZXIpIHtcbiAgICAgICAgICBmb3IgKGNvbnN0IHggb2YgWzAsIDFdKSB7XG4gICAgICAgICAgICBjb25zdCBpbWFnZSA9IGF3YWl0IHByb3ZpZGVyLnJlcXVlc3RJbWFnZSh4LCAwLCAwKTtcbiAgICAgICAgICAgIGlmIChpbWFnZSBpbnN0YW5jZW9mIEltYWdlQml0bWFwKSBpbWFnZS5jbG9zZSgpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIHdhcm1WaWV3czogKCkgPT4ge1xuICAgICAgICBjb25zdCByaWRnZSA9IHsgbGF0OiAtODkuNDUsIGxvbjogLTEzNi43IH07IC8vIFNoYWNrbGV0b24g4oCTIGRlIEdlcmxhY2hlIGNvbm5lY3RpbmcgcmlkZ2VcbiAgICAgICAgY29uc3QgZyA9IGhlaWdodHMuaGVpZ2h0QXQocmlkZ2UubGF0LCByaWRnZS5sb24sIGZhbHNlKTtcbiAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICB7IHBvc2U6IHBvc2VMb29raW5nQXQoLTkwLCAwLCAwLCA4MjBfMDAwLCAwLCAtOTApLCBsYWJlbDogJ0dldHRpbmcgdGhlIHNvdXRoIHBvbGUgcmVhZHnigKYnLCBtYXhNczogNjAwMCB9LFxuICAgICAgICAgIHsgcG9zZTogcG9zZUxvb2tpbmdBdChyaWRnZS5sYXQsIHJpZGdlLmxvbiwgZywgOTBfMDAwLCAyMCwgLTM4KSwgbGFiZWw6ICdCdWlsZGluZyB0aGUgM0QgbW91bnRhaW5z4oCmJywgbWF4TXM6IDUwMDAgfSxcbiAgICAgICAgICB7IHBvc2U6IHBvc2VMb29raW5nQXQocmlkZ2UubGF0LCByaWRnZS5sb24sIGcsIDEyXzAwMCwgNjAsIC0xOCksIGxhYmVsOiAnU2hhcnBlbmluZyB0aGUgbGFuZGluZyBhcmVh4oCmJywgbWF4TXM6IDQwMDAgfSxcbiAgICAgICAgXTtcbiAgICAgIH0sXG4gICAgICBvblByb2dyZXNzOiBwID0+IHtcbiAgICAgICAgZGVidWcucHJvZ3Jlc3MgPSBwO1xuICAgICAgICBpZiAocC5kb25lICYmIG5hdlJlZi5jdXJyZW50ICYmICFsYW5kZXIuYWN0aXZlKSBuYXZSZWYuY3VycmVudC5lbmFibGVkID0gdHJ1ZTtcbiAgICAgICAgLy8gdGhlIGZsYXQgbWFwJ3MgcGljdHVyZSBhbmQgc2hhZGVycywgcXVpZXRseSwgb25jZSB0aGUgc3RhcnQtdXAgbG9hZGluZyBpcyBvdmVyICh0aGUgZmlyc3Qgc3dpdGNoIG11c3Qgbm90IGhpdGNoKVxuICAgICAgICBpZiAocC5kb25lKSB7IGNvbnN0IGdvID0gKCkgPT4gdm9pZCBmbGF0LnByZXBhcmUoc2V0dGluZ3MuZ2V0KCkucXVhbGl0eSA9PT0gJ2xpZ2h0JykuY2F0Y2goZSA9PiBjb25zb2xlLndhcm4oJ0ZsYXQgbWFwIG5vdCBhdmFpbGFibGU6JywgZSkpOyBpZiAoJ3JlcXVlc3RJZGxlQ2FsbGJhY2snIGluIHdpbmRvdykgcmVxdWVzdElkbGVDYWxsYmFjayhnbywgeyB0aW1lb3V0OiAxNTAwIH0pOyBlbHNlIHNldFRpbWVvdXQoZ28sIDMwMCk7IH1cbiAgICAgICAgY2IuY3VycmVudC5vbkxvYWRQcm9ncmVzcz8uKHApO1xuICAgICAgfSxcbiAgICAgIGNhbmNlbGxlZDogKCkgPT4gc2tpcFByZWxvYWQuY3VycmVudCxcbiAgICB9KTtcblxuICAgIHJldHVybiAoKSA9PiB7IGZsYXQuZGVzdHJveSgpOyBvZmZRdWFsaXR5KCk7IG9mZlJlbG9hZCgpOyBvZmZQaG90b0N1bGwoKTsgY2xlYXJUaW1lb3V0KHBob3RvQ3VsbFRpbWVyKTsgcmVzaXplT2JzLmRpc2Nvbm5lY3QoKTsgcGFuZWxPYnMuZGlzY29ubmVjdCgpOyBjbGVhclRpbWVvdXQoc2V0dGxlKTsgbmF2UmVmLmN1cnJlbnQ/LmRlc3Ryb3koKTsgbGFuZGVyLmRlc3Ryb3koKTsgbWFya2Vyc1JlZi5jdXJyZW50Py5kZXN0cm95KCk7IGxhYmVscy5kZXN0cm95KCk7IHNreS5kZXN0cm95KCk7IHNreVJlZi5jdXJyZW50ID0gbnVsbDsgdmlld2VyLmRlc3Ryb3koKTsgdmlld2VyUmVmLmN1cnJlbnQgPSBudWxsOyB9O1xuICB9LCBbXSk7XG5cbiAgLy8gTmFtZXNcbiAgdXNlRWZmZWN0KCgpID0+IHtcbiAgICBjb25zdCBsYWJlbHMgPSBsYWJlbHNSZWYuY3VycmVudCwgaGVpZ2h0cyA9IGhlaWdodHNSZWYuY3VycmVudDtcbiAgICBpZiAoIWxhYmVscyB8fCAhaGVpZ2h0cyB8fCAhcHJvcHMubmFtZXMpIHJldHVybjtcbiAgICBsZXQgbGl2ZSA9IHRydWU7XG4gICAgUHJvbWlzZS5hbGwoW2RvY3VtZW50LmZvbnRzLmxvYWQoJzUwMCAxM3B4IFwiSW50ZXIgVmFyaWFibGVcIicpLCBoZWlnaHRzLnJlYWR5XSkuZmluYWxseSgoKSA9PiB7XG4gICAgICBpZiAoIWxpdmUpIHJldHVybjtcbiAgICAgIGxhYmVscy5zZXROYW1lcyhwcm9wcy5uYW1lcyEsIGhlaWdodHMpO1xuICAgICAgbGFiZWxzLnVwZGF0ZSgpO1xuICAgICAgbmFtZXNMb2FkZWQuY3VycmVudCgpO1xuICAgICAgdmlld2VyUmVmLmN1cnJlbnQ/LnNjZW5lLnJlcXVlc3RSZW5kZXIoKTtcbiAgICB9KTtcbiAgICByZXR1cm4gKCkgPT4geyBsaXZlID0gZmFsc2U7IH07XG4gIH0sIFtwcm9wcy5uYW1lc10pO1xuXG4gIC8vIExheWVyc1xuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIGNvbnN0IHZpZXdlciA9IHZpZXdlclJlZi5jdXJyZW50O1xuICAgIGlmICghdmlld2VyKSByZXR1cm47XG4gICAgaWYgKHByb3BzLmxheWVycy5kYXRhRGV0YWlsICYmICFpbWFnZXJ5LmN1cnJlbnQuZ2V0KCdkYXRhRGV0YWlsJykpIHtcbiAgICAgIGNvbnN0IGxheWVyID0gY3JlYXRlRGF0YURldGFpbExheWVyKCk7XG4gICAgICB2aWV3ZXIuaW1hZ2VyeUxheWVycy5hZGQobGF5ZXIpO1xuICAgICAgaW1hZ2VyeS5jdXJyZW50LnNldCgnZGF0YURldGFpbCcsIGxheWVyKTtcbiAgICB9XG4gICAgY3JlYXRlQ3JhdGVyTGF5ZXIodmlld2VyLCAoKSA9PiBmbGF0UmVmLmN1cnJlbnQsXG4gICAgICAobGF0LCBsb24pID0+IGhlaWdodHNSZWYuY3VycmVudD8uaGVpZ2h0QXQobGF0LCBsb24sIGZhbHNlKSA/PyAwKS5zaG93ID0gISFwcm9wcy5sYXllcnMuY3JhdGVycyAmJiAhcHJvcHMubGFuZGVyO1xuICAgIHByZXBhcmVTY2llbmNlTGF5ZXJzKHZpZXdlciwgaW1hZ2VyeS5jdXJyZW50LCBwcm9wcy5zY2llbmNlTGF5ZXJzKTtcbiAgICBmb3IgKGNvbnN0IFtpZCwgbGF5ZXJdIG9mIGltYWdlcnkuY3VycmVudCkge1xuICAgICAgbGF5ZXIuc2hvdyA9IGlkID09PSAncGhvdG9Qb2xhcicgfHwgaWQgPT09ICdiYXNlJyB8fCBpZCA9PT0gJ3Bob3RvRml4JyA/ICEhcHJvcHMubGF5ZXJzLnBob3RvIDogaWQgPT09ICdoZWlnaHRQb2xhcicgPyAhIXByb3BzLmxheWVycy5oZWlnaHQgOiAhIXByb3BzLmxheWVyc1tpZF07XG4gICAgICBjb25zdCBvcEtleSA9IGlkID09PSAnaGVpZ2h0UG9sYXInID8gJ2hlaWdodCcgOiBpZCA9PT0gJ2Jhc2UnIHx8IGlkID09PSAncGhvdG9GaXgnID8gJ3Bob3RvJyA6IGlkO1xuICAgICAgbGF5ZXIuYWxwaGEgPSBpZCA9PT0gJ2RhdGFEZXRhaWwnID8gMSA6IGlkID09PSAnY3JhdGVycycgPyAxIDogcHJvcHMub3BhY2l0eVtvcEtleV0gPz8gKGlkID09PSAncGhvdG8nIHx8IGlkID09PSAnYmFzZScgfHwgaWQgPT09ICdwaG90b0ZpeCcgfHwgaWQgPT09ICdwaG90b1BvbGFyJyB8fCBpZCA9PT0gJ3BvbGFyUGhvdG8nID8gMSA6IDAuNyk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgZGVmIG9mIHByb3BzLnNjaWVuY2VMYXllcnMpIHsgY29uc3QgbCA9IGltYWdlcnkuY3VycmVudC5nZXQoZGVmLmlkID09PSAnaGVpZ2h0JyA/ICdoZWlnaHRQb2xhcicgOiBkZWYuaWQpOyBpZiAobCkgdmlld2VyLmltYWdlcnlMYXllcnMucmFpc2VUb1RvcChsKTsgfVxuICAgIGNvbnN0IGRkID0gaW1hZ2VyeS5jdXJyZW50LmdldCgnZGF0YURldGFpbCcpO1xuICAgIGlmIChkZCkgdmlld2VyLmltYWdlcnlMYXllcnMucmFpc2VUb1RvcChkZCk7XG4gICAgY29uc3QgY3IgPSBpbWFnZXJ5LmN1cnJlbnQuZ2V0KCdjcmF0ZXJzJyk7IC8vIG91dGxpbmVzIHN0YXkgcmVhZGFibGUgb3ZlciBldmVyeSBjb2xvdXIgbWFwXG4gICAgaWYgKGNyKSB2aWV3ZXIuaW1hZ2VyeUxheWVycy5yYWlzZVRvVG9wKGNyKTtcbiAgICBjb25zdCBsYWJlbHMgPSBsYWJlbHNSZWYuY3VycmVudDtcbiAgICBjb25zdCBvbkdsb2JlID0gKG1vZGVzUmVmLmN1cnJlbnQ/Lm1vZGUgPz8gJ2dsb2JlJykgPT09ICdnbG9iZScgJiYgIW1vZGVzUmVmLmN1cnJlbnQ/Lm1vdmluZztcbiAgICBpZiAobGFiZWxzKSB7XG4gICAgICBsYWJlbHMudmlzaWJsZSA9IG9uR2xvYmUgJiYgISFwcm9wcy5sYXllcnMubmFtZXMgJiYgIXByb3BzLmxhbmRlcjtcbiAgICAgIGxhYmVscy5wbGFjZXNWaXNpYmxlID0gcGxhY2VGbGFncyhvbkdsb2JlICYmICFwcm9wcy5sYW5kZXIsIHByb3BzLmxheWVycyk7XG4gICAgICBsYWJlbHMuZmxhdE5hbWVzID0gISFwcm9wcy5sYXllcnMubmFtZXM7XG4gICAgICBsYWJlbHMuZmxhdFBsYWNlcyA9IHBsYWNlRmxhZ3ModHJ1ZSwgcHJvcHMubGF5ZXJzKTtcbiAgICAgIGxhYmVscy51cGRhdGUoKTtcbiAgICB9XG4gICAgY29uc3QgZmxhdCA9IGZsYXRSZWYuY3VycmVudDtcbiAgICBpZiAoZmxhdCkge1xuICAgICAgZmxhdC5kZXRhaWwgPSBwcm9wcy5sYXllcnMuZGF0YURldGFpbCA/IDEgOiAwO1xuICAgICAgZmxhdC5waG90byA9IHByb3BzLmxheWVycy5waG90byAhPT0gZmFsc2U7XG4gICAgICAvLyB0aGUgY29sb3VyZWQgbGF5ZXJzLCBpbiB0aGUgZ2xvYmUncyBvcmRlcjogSGVpZ2h0IGNvbG91cnMgZmlyc3QsIHRoZW4gdGhlIHNvdXRoLXBvbGUgbWFwc1xuICAgICAgY29uc3Qgb3ZlcjogRmxhdE92ZXJsYXlbXSA9IFtdO1xuICAgICAgaWYgKHByb3BzLmxheWVycy5oZWlnaHQpIHtcbiAgICAgICAgY29uc3QgYSA9IHByb3BzLm9wYWNpdHkuaGVpZ2h0ID8/IDAuNztcbiAgICAgICAgb3Zlci5wdXNoKHsgaWQ6ICdoZWlnaHQnLCBraW5kOiAnZ2xvYmFsJywgbGF5ZXI6IEhFSUdIVF9UUkVLLmxheWVyLCBleHQ6IEhFSUdIVF9UUkVLLmV4dCwgbGF0TWluOiBIRUlHSFRfVFJFSy5taW5UcnVlTGF0LCBhbHBoYTogYSB9KTtcbiAgICAgICAgaWYgKHByb3BzLnNjaWVuY2VMYXllcnMuc29tZShkID0+IGQuaWQgPT09ICdoZWlnaHQnKSkgb3Zlci5wdXNoKHsgaWQ6ICdoZWlnaHRQb2xhcicsIGtpbmQ6ICdwb2xhcicsIHVybDogJy4vZGF0YS9sYXllcnMvaGVpZ2h0LnBuZycsIGFscGhhOiBhIH0pO1xuICAgICAgfVxuICAgICAgZm9yIChjb25zdCBkZWYgb2YgcHJvcHMuc2NpZW5jZUxheWVycykgaWYgKGRlZi5pZCAhPT0gJ2hlaWdodCcgJiYgcHJvcHMubGF5ZXJzW2RlZi5pZF0pIG92ZXIucHVzaCh7IGlkOiBkZWYuaWQsIGtpbmQ6ICdwb2xhcicsIHVybDogYC4vZGF0YS9sYXllcnMvJHtkZWYuaWR9LnBuZ2AsIGFscGhhOiBwcm9wcy5vcGFjaXR5W2RlZi5pZF0gPz8gMC43IH0pO1xuICAgICAgZmxhdC5zZXRPdmVybGF5cyhvdmVyKTtcbiAgICAgIGZsYXQucmVmcmVzaExhYmVscygpO1xuICAgIH1cbiAgICB2aWV3ZXIuc2NlbmUucmVxdWVzdFJlbmRlcigpO1xuICB9LCBbcHJvcHMubGF5ZXJzLCBwcm9wcy5vcGFjaXR5LCBwcm9wcy5zY2llbmNlTGF5ZXJzLCBwcm9wcy5sYW5kZXJdKTtcblxuICAvLyAzRCBtb3VudGFpbnMgb24vb2ZmXG4gIHVzZUVmZmVjdCgoKSA9PiB7XG4gICAgY29uc3Qgdmlld2VyID0gdmlld2VyUmVmLmN1cnJlbnQsIGhlaWdodHMgPSBoZWlnaHRzUmVmLmN1cnJlbnQ7XG4gICAgaWYgKCF2aWV3ZXIgfHwgIWhlaWdodHMpIHJldHVybjtcbiAgICBoZWlnaHRzLnJlYWR5LnRoZW4oKCkgPT4ge1xuICAgICAgaWYgKHZpZXdlci5pc0Rlc3Ryb3llZCgpKSByZXR1cm47XG4gICAgICBjb25zdCB3YW50M2QgPSBwcm9wcy5sYXllcnMudGVycmFpbiAhPT0gZmFsc2U7XG4gICAgICBjb25zdCBpczNkID0gdmlld2VyLnRlcnJhaW5Qcm92aWRlciBpbnN0YW5jZW9mIExvbGFUZXJyYWluUHJvdmlkZXI7XG4gICAgICBpZiAod2FudDNkICYmICFpczNkKSB2aWV3ZXIudGVycmFpblByb3ZpZGVyID0gbmV3IExvbGFUZXJyYWluUHJvdmlkZXIoaGVpZ2h0cykgYXMgbmV2ZXI7XG4gICAgICBpZiAoIXdhbnQzZCAmJiBpczNkKSB2aWV3ZXIudGVycmFpblByb3ZpZGVyID0gbmV3IEVsbGlwc29pZFRlcnJhaW5Qcm92aWRlcih7IGVsbGlwc29pZDogTU9PTl9FTExJUFNPSUQgfSk7XG4gICAgfSk7XG4gIH0sIFtwcm9wcy5sYXllcnMudGVycmFpbl0pO1xuXG4gIC8vIEEgZ3JvdW5kIHBvbHlsaW5lIHVzZXMgdGhlIHRlcnJhaW4ncyBkZXB0aCwgaW5jbHVkaW5nIG91ciByb3RhdGVkIGx1bmFyIHRpbGVzLlxuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIGNvbnN0IHZpZXdlciA9IHZpZXdlclJlZi5jdXJyZW50O1xuICAgIGlmICghdmlld2VyKSByZXR1cm47XG4gICAgY29uc3Qgc2NlbmUgPSB2aWV3ZXIuc2NlbmU7XG4gICAgbGV0IGxpdmUgPSB0cnVlLCBsaW5lOiBDZXNpdW0uR3JvdW5kUG9seWxpbmVQcmltaXRpdmUgfCBudWxsID0gbnVsbDtcbiAgICBsZXQgZmxhZzogRW50aXR5IHwgbnVsbCA9IG51bGw7XG4gICAgY29uc3Qgcm91dGUgPSBwcm9wcy5vdmVydmlld1JvdXRlLCBkZXN0ID0gcHJvcHMucm91dGVEZXN0aW5hdGlvbjtcbiAgICBmbGF0UmVmLmN1cnJlbnQ/LnJlcXVlc3QoKTtcbiAgICBpZiAoZGVzdCAmJiAhcHJvcHMubGFuZGVyKSB7XG4gICAgICBmbGFnID0gdmlld2VyLmVudGl0aWVzLmFkZCh7XG4gICAgICAgIGlkOiAnb3ZlcnZpZXctcm91dGUtZW5kJywgcG9zaXRpb246IHRvQ2FydGVzaWFuKGRlc3QubGF0LCBkZXN0LmxvbiksXG4gICAgICAgIGJpbGxib2FyZDoge1xuICAgICAgICAgIGltYWdlOiBzdmdVcmwoJzxzdmcgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIHdpZHRoPVwiNDBcIiBoZWlnaHQ9XCI0NFwiIHZpZXdCb3g9XCIwIDAgNDAgNDRcIj48cGF0aCBkPVwiTTEwIDQ0VjRNMTEgNWgyM2wtNiA4IDYgOEgxMVwiIGZpbGw9XCIjYWNkZmZmXCIgc3Ryb2tlPVwiIzE4MmY0M1wiIHN0cm9rZS13aWR0aD1cIjNcIiBzdHJva2UtbGluZWpvaW49XCJyb3VuZFwiLz48cGF0aCBkPVwiTTEwIDQ0VjRcIiBzdHJva2U9XCIjYWNkZmZmXCIgc3Ryb2tlLXdpZHRoPVwiMlwiLz48L3N2Zz4nKSxcbiAgICAgICAgICB3aWR0aDogMjcsIGhlaWdodDogMzAsIHZlcnRpY2FsT3JpZ2luOiBWZXJ0aWNhbE9yaWdpbi5CT1RUT00sXG4gICAgICAgICAgaG9yaXpvbnRhbE9yaWdpbjogQ2VzaXVtLkhvcml6b250YWxPcmlnaW4uTEVGVCxcbiAgICAgICAgICBwaXhlbE9mZnNldDogbmV3IENhcnRlc2lhbjIoLTcsIDApLCBoZWlnaHRSZWZlcmVuY2U6IENlc2l1bS5IZWlnaHRSZWZlcmVuY2UuQ0xBTVBfVE9fR1JPVU5ELFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgfVxuICAgIGNvbnN0IG9mZiA9IHNjZW5lLnByZVJlbmRlci5hZGRFdmVudExpc3RlbmVyKCgpID0+IHtcbiAgICAgIGlmIChsaW5lKSBsaW5lLnNob3cgPSAhY2IuY3VycmVudC5sYW5kZXIgJiYgdmlld2VyLmVudGl0aWVzLnNob3c7XG4gICAgfSk7XG4gICAgaWYgKHJvdXRlPy5vayAmJiByb3V0ZS5wYXRoLmxlbmd0aCA+PSA0ICYmICFwcm9wcy5sYW5kZXIpIHtcbiAgICAgIHZvaWQgQ2VzaXVtLkdyb3VuZFBvbHlsaW5lUHJpbWl0aXZlLmluaXRpYWxpemVUZXJyYWluSGVpZ2h0cygpLnRoZW4oKCkgPT4ge1xuICAgICAgICBpZiAoIWxpdmUgfHwgdmlld2VyLmlzRGVzdHJveWVkKCkpIHJldHVybjtcbiAgICAgICAgY29uc3QgcG9zaXRpb25zOiBDYXJ0ZXNpYW4zW10gPSBbXTtcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCByb3V0ZS5wYXRoLmxlbmd0aDsgaSArPSAyKSBwb3NpdGlvbnMucHVzaCh0b0NhcnRlc2lhbihyb3V0ZS5wYXRoW2ldLCByb3V0ZS5wYXRoW2kgKyAxXSkpO1xuICAgICAgICBsaW5lID0gbmV3IENlc2l1bS5Hcm91bmRQb2x5bGluZVByaW1pdGl2ZSh7XG4gICAgICAgICAgZ2VvbWV0cnlJbnN0YW5jZXM6IG5ldyBDZXNpdW0uR2VvbWV0cnlJbnN0YW5jZSh7IGdlb21ldHJ5OiBuZXcgQ2VzaXVtLkdyb3VuZFBvbHlsaW5lR2VvbWV0cnkoeyBwb3NpdGlvbnMsIHdpZHRoOiA1IH0pIH0pLFxuICAgICAgICAgIGFwcGVhcmFuY2U6IG5ldyBDZXNpdW0uUG9seWxpbmVNYXRlcmlhbEFwcGVhcmFuY2UoeyBtYXRlcmlhbDogQ2VzaXVtLk1hdGVyaWFsLmZyb21UeXBlKCdQb2x5bGluZU91dGxpbmUnLCB7XG4gICAgICAgICAgICBjb2xvcjogQ29sb3IuZnJvbUNzc0NvbG9yU3RyaW5nKCcjYWNkZmZmJykud2l0aEFscGhhKDAuOTQpLCBvdXRsaW5lQ29sb3I6IENvbG9yLmZyb21Dc3NDb2xvclN0cmluZygnIzE4MmY0MycpLndpdGhBbHBoYSgwLjkpLCBvdXRsaW5lV2lkdGg6IDEsXG4gICAgICAgICAgfSkgfSksXG4gICAgICAgICAgY2xhc3NpZmljYXRpb25UeXBlOiBDZXNpdW0uQ2xhc3NpZmljYXRpb25UeXBlLlRFUlJBSU4sIGFzeW5jaHJvbm91czogZmFsc2UsIGFsbG93UGlja2luZzogZmFsc2UsXG4gICAgICAgIH0pO1xuICAgICAgICAvLyBDZXNpdW0gc2hpcHMgRWFydGgncyBoZWlnaHQgYm91bmRzLiBTb21lIGFyZSBiZWxvdyB0aGUgbHVuYXIgZ3JvdW5kLCB3aGljaCBjbGlwc1xuICAgICAgICAvLyB0aGUgbGluZSBhd2F5LiBPbmx5IHdoaWxlIHRoaXMgc3luY2hyb25vdXMgcHJpbWl0aXZlIGJ1aWxkcyBpdHMgdm9sdW1lLCBnaXZlIGl0XG4gICAgICAgIC8vIGEgZ2VuZXJvdXMgbHVuYXIgZW52ZWxvcGU7IHRoZSB2aXNpYmxlIGxpbmUgc3RpbGwgY2xhbXBzIHRvIHRoZSByZWFsIHRlcnJhaW4uXG4gICAgICAgIGNvbnN0IGJvdW5kcyA9IChDZXNpdW0gYXMgdW5rbm93biBhcyB7IEFwcHJveGltYXRlVGVycmFpbkhlaWdodHM6IHsgX2RlZmF1bHRNYXhUZXJyYWluSGVpZ2h0OiBudW1iZXI7IGdldE1pbmltdW1NYXhpbXVtSGVpZ2h0czogKC4uLmFyZ3M6IHVua25vd25bXSkgPT4geyBtaW5pbXVtVGVycmFpbkhlaWdodDogbnVtYmVyOyBtYXhpbXVtVGVycmFpbkhlaWdodDogbnVtYmVyIH0gfSB9KS5BcHByb3hpbWF0ZVRlcnJhaW5IZWlnaHRzO1xuICAgICAgICBjb25zdCB1cGRhdGluZyA9IGxpbmUgYXMgdW5rbm93biBhcyB7IHVwZGF0ZShmcmFtZTogdW5rbm93bik6IHZvaWQgfTtcbiAgICAgICAgY29uc3QgdXBkYXRlID0gdXBkYXRpbmcudXBkYXRlLmJpbmQobGluZSk7XG4gICAgICAgIHVwZGF0aW5nLnVwZGF0ZSA9IGZyYW1lID0+IHtcbiAgICAgICAgICBjb25zdCBzYXZlZCA9IGJvdW5kcy5nZXRNaW5pbXVtTWF4aW11bUhlaWdodHM7XG4gICAgICAgICAgY29uc3Qgc2F2ZWRNYXggPSBib3VuZHMuX2RlZmF1bHRNYXhUZXJyYWluSGVpZ2h0O1xuICAgICAgICAgIGJvdW5kcy5nZXRNaW5pbXVtTWF4aW11bUhlaWdodHMgPSAoKSA9PiAoeyBtaW5pbXVtVGVycmFpbkhlaWdodDogLTE1MDAwLCBtYXhpbXVtVGVycmFpbkhlaWdodDogMTUwMDAgfSk7XG4gICAgICAgICAgYm91bmRzLl9kZWZhdWx0TWF4VGVycmFpbkhlaWdodCA9IDE1MDAwO1xuICAgICAgICAgIHRyeSB7IHVwZGF0ZShmcmFtZSk7IH0gZmluYWxseSB7IGJvdW5kcy5nZXRNaW5pbXVtTWF4aW11bUhlaWdodHMgPSBzYXZlZDsgYm91bmRzLl9kZWZhdWx0TWF4VGVycmFpbkhlaWdodCA9IHNhdmVkTWF4OyB9XG4gICAgICAgIH07XG4gICAgICAgIHNjZW5lLmdyb3VuZFByaW1pdGl2ZXMuYWRkKGxpbmUpO1xuICAgICAgICBzY2VuZS5yZXF1ZXN0UmVuZGVyKCk7XG4gICAgICB9KS5jYXRjaChlcnJvciA9PiBjb25zb2xlLndhcm4oJ1JvdXRlIGxpbmUgY291bGQgbm90IGxvYWQ6JywgZXJyb3IpKTtcbiAgICB9XG4gICAgc2NlbmUucmVxdWVzdFJlbmRlcigpO1xuICAgIHJldHVybiAoKSA9PiB7XG4gICAgICBsaXZlID0gZmFsc2U7IG9mZigpO1xuICAgICAgaWYgKCF2aWV3ZXIuaXNEZXN0cm95ZWQoKSkge1xuICAgICAgICBpZiAobGluZSkgc2NlbmUuZ3JvdW5kUHJpbWl0aXZlcy5yZW1vdmUobGluZSk7XG4gICAgICAgIGlmIChmbGFnKSB2aWV3ZXIuZW50aXRpZXMucmVtb3ZlKGZsYWcpO1xuICAgICAgICBzY2VuZS5yZXF1ZXN0UmVuZGVyKCk7XG4gICAgICB9XG4gICAgfTtcbiAgfSwgW3Byb3BzLm92ZXJ2aWV3Um91dGUsIHByb3BzLnJvdXRlRGVzdGluYXRpb24sIHByb3BzLmxhbmRlcl0pO1xuXG4gIC8vIFNlbGVjdGVkIHBpbiArIGNvbXBhcmUgcGlucy4gUGxhY2VkIGF0IHRoZSByZWFsIGdyb3VuZCBoZWlnaHQgYW5kIGRyYXduIG92ZXIgZXZlcnl0aGluZzpcbiAgLy8gXCJjbGFtcGVkIHRvIGdyb3VuZFwiIHBpbnMgZ2V0IHBhcnRseSBjdXQgYnkgbmVhcmJ5IGhpbGxzIGluIENlc2l1bSwgc28gd2UgZG8gbm90IHVzZSB0aGF0LlxuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIGNvbnN0IHZpZXdlciA9IHZpZXdlclJlZi5jdXJyZW50O1xuICAgIGlmICghdmlld2VyKSByZXR1cm47XG4gICAgY29uc3QgaCA9IGhlaWdodHNSZWYuY3VycmVudDtcbiAgICBjb25zdCBwaW5Qb3MgPSAobGF0OiBudW1iZXIsIGxvbjogbnVtYmVyKSA9PiB0b0NhcnRlc2lhbihsYXQsIGxvbiwgKGg/LmhlaWdodEF0KGxhdCwgbG9uLCB0cnVlKSA/PyAwKSArIDMpO1xuICAgIGlmIChzZWxlY3RlZEVudGl0eS5jdXJyZW50KSB7IHZpZXdlci5lbnRpdGllcy5yZW1vdmUoc2VsZWN0ZWRFbnRpdHkuY3VycmVudCk7IHNlbGVjdGVkRW50aXR5LmN1cnJlbnQgPSBudWxsOyB9XG4gICAgaWYgKHByb3BzLnNlbGVjdGVkUGluICYmICFwcm9wcy5sYW5kZXIpIHtcbiAgICAgIHNlbGVjdGVkRW50aXR5LmN1cnJlbnQgPSB2aWV3ZXIuZW50aXRpZXMuYWRkKHtcbiAgICAgICAgcG9zaXRpb246IHBpblBvcyhwcm9wcy5zZWxlY3RlZFBpbi5sYXQsIHByb3BzLnNlbGVjdGVkUGluLmxvbiksXG4gICAgICAgIGJpbGxib2FyZDogeyBpbWFnZTogUElOX1NWRygnJyksIHdpZHRoOiAzOCwgaGVpZ2h0OiAzOCwgdmVydGljYWxPcmlnaW46IFZlcnRpY2FsT3JpZ2luLkJPVFRPTSwgcGl4ZWxPZmZzZXQ6IG5ldyBDYXJ0ZXNpYW4yKDAsIDIpLCBkaXNhYmxlRGVwdGhUZXN0RGlzdGFuY2U6IE51bWJlci5QT1NJVElWRV9JTkZJTklUWSB9LFxuICAgICAgfSk7XG4gICAgICBkcm9wSW4odmlld2VyLCBzZWxlY3RlZEVudGl0eS5jdXJyZW50LCBgJHtwcm9wcy5zZWxlY3RlZFBpbi5sYXR9LCR7cHJvcHMuc2VsZWN0ZWRQaW4ubG9ufWApO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IFssIGVdIG9mIHBpbkVudGl0aWVzLmN1cnJlbnQpIHZpZXdlci5lbnRpdGllcy5yZW1vdmUoZSk7XG4gICAgcGluRW50aXRpZXMuY3VycmVudC5jbGVhcigpO1xuICAgIGlmICghcHJvcHMubGFuZGVyKSBmb3IgKGNvbnN0IHAgb2YgcHJvcHMucGlucykge1xuICAgICAgcGluRW50aXRpZXMuY3VycmVudC5zZXQocC5pZCwgdmlld2VyLmVudGl0aWVzLmFkZCh7XG4gICAgICAgIHBvc2l0aW9uOiBwaW5Qb3MocC5sYXQsIHAubG9uKSxcbiAgICAgICAgYmlsbGJvYXJkOiB7IGltYWdlOiBQSU5fU1ZHKHAuY29sb3IsIHAubGV0dGVyKSwgd2lkdGg6IDM4LCBoZWlnaHQ6IDM4LCB2ZXJ0aWNhbE9yaWdpbjogVmVydGljYWxPcmlnaW4uQk9UVE9NLCBwaXhlbE9mZnNldDogbmV3IENhcnRlc2lhbjIoMCwgMiksIGRpc2FibGVEZXB0aFRlc3REaXN0YW5jZTogTnVtYmVyLlBPU0lUSVZFX0lORklOSVRZIH0sXG4gICAgICB9KSk7XG4gICAgfVxuICAgICh2aWV3ZXJSZWYuY3VycmVudCAmJiAod2luZG93IGFzIHVua25vd24gYXMgeyBfX21vb25kYT86IHsgcGluRmFjaW5nPzogKCkgPT4gdm9pZCB9IH0pLl9fbW9vbmRhPy5waW5GYWNpbmc/LigpKTtcbiAgICBsYWJlbHNSZWYuY3VycmVudD8udXBkYXRlKCk7IC8vIG5hbWVzIHN0ZXAgYXNpZGUgZm9yIHRoZSBwaW5zXG4gICAgZmxhdFJlZi5jdXJyZW50Py5yZXF1ZXN0KCk7XG4gICAgdmlld2VyLnNjZW5lLnJlcXVlc3RSZW5kZXIoKTtcbiAgfSwgW3Byb3BzLnNlbGVjdGVkUGluLCBwcm9wcy5waW5zLCBwcm9wcy5sYW5kZXJdKTtcblxuICAvLyBSZWFsIHN1bmxpZ2h0IGF0IHRoZSBjaG9zZW4gdGltZTogc2hhZGluZyBvZiB0aGUgd2hvbGUgTW9vbiwgdGhlIFN1bi9FYXJ0aCBjaGlwcyBhbmQgdGhlIHNreS5cbiAgdXNlRWZmZWN0KCgpID0+IHtcbiAgICBjb25zdCB2aWV3ZXIgPSB2aWV3ZXJSZWYuY3VycmVudDtcbiAgICBpZiAoIXZpZXdlcikgcmV0dXJuO1xuICAgIGNvbnN0IHN1bk9uID0gcHJvcHMubGF5ZXJzLnJlYWxTdW4gIT09IGZhbHNlO1xuICAgIGNvbnN0IHMgPSB0cnVlVG9EaXNwbGF5VmVjKHByb3BzLmJvZGllcy5zdW4pO1xuICAgIGNvbnN0IGQgPSBDYXJ0ZXNpYW4zLm5vcm1hbGl6ZShuZXcgQ2FydGVzaWFuMyhzWzBdLCBzWzFdLCBzWzJdKSwgbmV3IENhcnRlc2lhbjMoKSk7XG4gICAgdmlld2VyLnNjZW5lLmxpZ2h0ID0gbmV3IERpcmVjdGlvbmFsTGlnaHQoeyBkaXJlY3Rpb246IENhcnRlc2lhbjMubmVnYXRlKGQsIGQpLCBpbnRlbnNpdHk6IDIuMCB9KTtcbiAgICB2aWV3ZXIuc2NlbmUuZ2xvYmUuZW5hYmxlTGlnaHRpbmcgPSBzdW5PbjtcbiAgICBjb25zdCBtID0gbWFya2Vyc1JlZi5jdXJyZW50O1xuICAgIGNvbnN0IGZsYXQgPSBmbGF0UmVmLmN1cnJlbnQ7XG4gICAgaWYgKGZsYXQpIHtcbiAgICAgIGNvbnN0IGxlbiA9IE1hdGguaHlwb3QoLi4ucHJvcHMuYm9kaWVzLnN1bikgfHwgMSwgbGUgPSBNYXRoLmh5cG90KC4uLnByb3BzLmJvZGllcy5lYXJ0aCkgfHwgMTtcbiAgICAgIGZsYXQuc3VuID0gW3Byb3BzLmJvZGllcy5zdW5bMF0gLyBsZW4sIHByb3BzLmJvZGllcy5zdW5bMV0gLyBsZW4sIHByb3BzLmJvZGllcy5zdW5bMl0gLyBsZW5dO1xuICAgICAgZmxhdC5lYXJ0aCA9IFtwcm9wcy5ib2RpZXMuZWFydGhbMF0gLyBsZSwgcHJvcHMuYm9kaWVzLmVhcnRoWzFdIC8gbGUsIHByb3BzLmJvZGllcy5lYXJ0aFsyXSAvIGxlXTtcbiAgICAgIGZsYXQuc3VuT24gPSBzdW5PbjtcbiAgICAgIGZsYXQucmVxdWVzdCgpO1xuICAgIH1cbiAgICBjb25zdCBvbkdsb2JlID0gKG1vZGVzUmVmLmN1cnJlbnQ/Lm1vZGUgPz8gJ2dsb2JlJykgPT09ICdnbG9iZScgJiYgIW1vZGVzUmVmLmN1cnJlbnQ/Lm1vdmluZztcbiAgICBpZiAobSkgeyBtLnNob3cgPSBzdW5PbiAmJiAhcHJvcHMubGFuZGVyICYmIG9uR2xvYmU7IG0uc3BvdHMgPSBwcm9wcy5sYXllcnMuc2t5bWFya2VycyA9PT0gdHJ1ZTsgbS51cGRhdGUocHJvcHMuYm9kaWVzLnN1biwgcHJvcHMuYm9kaWVzLmVhcnRoKTsgbGFiZWxzUmVmLmN1cnJlbnQ/LnVwZGF0ZSgpOyB9XG4gICAgc2t5UmVmLmN1cnJlbnQ/LnVwZGF0ZShwcm9wcy50aW1lTXMgPz8gRGF0ZS5ub3coKSwgcHJvcHMuYm9kaWVzKTtcbiAgICB2aWV3ZXIuc2NlbmUucmVxdWVzdFJlbmRlcigpO1xuICB9LCBbcHJvcHMubGF5ZXJzLnJlYWxTdW4sIHByb3BzLmxheWVycy5za3ltYXJrZXJzLCBwcm9wcy5ib2RpZXMsIHByb3BzLmxhbmRlciwgcHJvcHMudGltZU1zXSk7XG5cbiAgLy8gU3RhcnMsIE1pbGt5IFdheSwgcGxhbmV0cyBhbmQgdGhlaXIgbmFtZSB0YWdzIGZvbGxvdyB0aGUgbGF5ZXIgc3dpdGNoZXMgKHRoZSBTdW4gYW5kIEVhcnRoIGFyZSBhbHdheXMgZHJhd24pLlxuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIGNvbnN0IHNreSA9IHNreVJlZi5jdXJyZW50O1xuICAgIGlmICghc2t5KSByZXR1cm47XG4gICAgY29uc3Qgc3RhcnMgPSBwcm9wcy5sYXllcnMuc3RhcnMgIT09IGZhbHNlO1xuICAgIHNreS5zaG93ID0geyBzdGFycywgbWlsa3lXYXk6IHN0YXJzLCBwbGFuZXRzOiBzdGFycywgZWFydGg6IHRydWUsIHN1bjogdHJ1ZSwgbmFtZXM6IHN0YXJzICYmIHByb3BzLmxheWVycy5za3lOYW1lcyAhPT0gZmFsc2UgfTtcbiAgICB2aWV3ZXJSZWYuY3VycmVudD8uc2NlbmUucmVxdWVzdFJlbmRlcigpO1xuICB9LCBbcHJvcHMubGF5ZXJzLnN0YXJzLCBwcm9wcy5sYXllcnMuc2t5TmFtZXNdKTtcblxuICAvLyBGaXJzdC1wZXJzb24gbGFuZGVyIHZpZXdcbiAgY29uc3QgbGFuZGVyS2V5ID0gcHJvcHMubGFuZGVyID8gYCR7cHJvcHMubGFuZGVyLmxhdH0sJHtwcm9wcy5sYW5kZXIubG9ufSwke3Byb3BzLmxhbmRlci5tYXN0TX0sJHshIXByb3BzLmxhbmRlci5za3lsaW5lfWAgOiAnJztcbiAgdXNlRWZmZWN0KCgpID0+IHtcbiAgICBjb25zdCBsYW5kZXIgPSBsYW5kZXJSZWYuY3VycmVudCwgbmF2ID0gbmF2UmVmLmN1cnJlbnQ7XG4gICAgaWYgKCFsYW5kZXIgfHwgIW5hdikgcmV0dXJuO1xuICAgIGlmIChwcm9wcy5sYW5kZXIgJiYgcHJvcHMuc2t5KSB7XG4gICAgICBjb25zdCBzcGVjID0gcHJvcHMubGFuZGVyLCBza3kgPSBwcm9wcy5za3k7XG4gICAgICBjb25zdCBnbyA9ICgpID0+IHsgbmF2LmVuYWJsZWQgPSBmYWxzZTsgbGFuZGVyLmVudGVyKHNwZWMsIHNreSwgc3BlYy5mYWNlQXopOyB9O1xuICAgICAgY29uc3QgbW9kZXMgPSBtb2Rlc1JlZi5jdXJyZW50O1xuICAgICAgLy8gZnJvbSB0aGUgZmxhdCBtYXA6IGZpcnN0IGEgc2hvcnRlbmVkIG1vdmUgYmFjayB0byB0aGUgZ2xvYmUgYXQgdGhhdCBzcG90XG4gICAgICBpZiAobW9kZXMgJiYgbW9kZXMubW9kZSA9PT0gJ2ZsYXQnKSB2b2lkIG1vZGVzLnRvR2xvYmUoeyBhdDogeyBsYXQ6IHNwZWMubGF0LCBsb246IHNwZWMubG9uLCBrbTogNDAgfSwgZmFzdDogdHJ1ZSwgaGFuZE9mZjogZ28gfSk7XG4gICAgICBlbHNlIGdvKCk7XG4gICAgfSBlbHNlIGlmICghcHJvcHMubGFuZGVyICYmIGxhbmRlci5hY3RpdmUpIHtcbiAgICAgIGxhbmRlci5leGl0KCk7IC8vIGZpcnN0OiBpdCBwdXRzIENlc2l1bSdzIGlucHV0IHN3aXRjaCBiYWNrIHRoZSB3YXkgbmF2aWdhdGlvbiBsZWZ0IGl0XG4gICAgICBuYXYuZW5hYmxlZCA9IHRydWU7XG4gICAgfVxuICB9LCBbbGFuZGVyS2V5XSk7IC8vIGVzbGludC1kaXNhYmxlLWxpbmUgcmVhY3QtaG9va3MvZXhoYXVzdGl2ZS1kZXBzXG4gIHVzZUVmZmVjdCgoKSA9PiB7IGlmIChwcm9wcy5za3kpIGxhbmRlclJlZi5jdXJyZW50Py51cGRhdGVTa3kocHJvcHMuc2t5KTsgfSwgW3Byb3BzLnNreV0pO1xuXG4gIGNvbnN0IGZsYXRPbiA9ICgpID0+IG1vZGVzUmVmLmN1cnJlbnQ/Lm1vZGUgPT09ICdmbGF0JyAmJiAhbW9kZXNSZWYuY3VycmVudC5tb3ZpbmcgPyBmbGF0UmVmLmN1cnJlbnQgOiBudWxsO1xuICB1c2VJbXBlcmF0aXZlSGFuZGxlKHJlZiwgKCkgPT4gKHtcbiAgICBmbHlUbyhsYXQsIGxvbiwgaGVpZ2h0S20gPSA2MCwgdGlsdGVkID0gZmFsc2UpIHtcbiAgICAgIGNvbnN0IHYgPSB2aWV3ZXJSZWYuY3VycmVudDtcbiAgICAgIGlmICghdiB8fCBtb2Rlc1JlZi5jdXJyZW50Py5tb3ZpbmcpIHJldHVybjtcbiAgICAgIGNvbnN0IGZsYXQgPSBmbGF0T24oKTtcbiAgICAgIGlmIChmbGF0KSB7IHZvaWQgZmxhdC5mbHlUbyhmbGF0LnZpZXdBdChsYXQsIGxvbiwgTWF0aC5tYXgoMjAsIGhlaWdodEttICogMS4xNSkpKTsgcmV0dXJuOyB9XG4gICAgICBjb25zdCBncm91bmQgPSBoZWlnaHRzUmVmLmN1cnJlbnQ/LmhlaWdodEF0KGxhdCwgbG9uLCBmYWxzZSkgPz8gMDtcbiAgICAgIGNvbnN0IHBvc2UgPSB0aWx0ZWQgPyBwb3NlTG9va2luZ0F0KGxhdCwgbG9uLCBncm91bmQsIGhlaWdodEttICogMTYwMCwgY2FtZXJhSGVhZGluZ1BpdGNoKHYpLmhlYWRpbmcsIC0zOCkgOiBwb3NlTG9va2luZ0F0KGxhdCwgbG9uLCBncm91bmQsIGhlaWdodEttICogMTAwMCwgMCwgLTkwKTtcbiAgICAgIHZvaWQgbmF2UmVmLmN1cnJlbnQ/LmZseVRvKHBvc2UpO1xuICAgIH0sXG4gICAgZmx5V2hvbGUoKSB7XG4gICAgICBjb25zdCBmbGF0ID0gZmxhdE9uKCk7XG4gICAgICBpZiAoZmxhdCkgeyB2b2lkIGZsYXQuZmx5VG8oZmxhdC53aG9sZVZpZXcoKSk7IHJldHVybjsgfVxuICAgICAgY29uc3QgcCA9IHBvc2VHbG9iZShXSE9MRS5sYXQsIFdIT0xFLmxvbiwgV0hPTEUuYWx0KTtcbiAgICAgIHZvaWQgbmF2UmVmLmN1cnJlbnQ/LmZseVRvKHApO1xuICAgIH0sXG4gICAgZmx5UG9sZSgpIHtcbiAgICAgIC8vIFN0cmFpZ2h0IGRvd24gb24gdGhlIHNvdXRoIHBvbGUsIG5lYXJzaWRlICgwwrAgbG9uZ2l0dWRlKSBhdCB0aGUgdG9wIOKAlCBsaWtlIE5BU0EncyBwb2xhciBtYXBzLlxuICAgICAgY29uc3QgcCA9IHBvc2VMb29raW5nQXQoLTkwLCAwLCAwLCA4MjBfMDAwLCAwLCAtOTApO1xuICAgICAgLy8gdGhlIHBvbGUgaXMgYmFkbHkgc3RyZXRjaGVkIG9uIGEgZmxhdCBtYXA6IGdvIGJhY2sgdG8gdGhlIGdsb2JlIGFuZCBmbHkgdGhlcmVcbiAgICAgIGlmIChtb2Rlc1JlZi5jdXJyZW50Py5tb2RlID09PSAnZmxhdCcpIHsgdm9pZCBtb2Rlc1JlZi5jdXJyZW50LnRvR2xvYmUoeyBhdDogeyBsYXQ6IC05MCwgbG9uOiAwLCBrbTogOTAwIH0sIHBvc2U6IHAgfSk7IHJldHVybjsgfVxuICAgICAgdm9pZCBuYXZSZWYuY3VycmVudD8uZmx5VG8ocCk7XG4gICAgfSxcbiAgICB6b29tQnkoZikgeyBjb25zdCBmbGF0ID0gZmxhdE9uKCk7IGlmIChmbGF0KSBmbGF0Lnpvb21CeShmKTsgZWxzZSBuYXZSZWYuY3VycmVudD8uem9vbUJ5KGYpOyB9LFxuICAgIHJlc2V0Tm9ydGgoKSB7IGlmICghZmxhdE9uKCkpIG5hdlJlZi5jdXJyZW50Py5yZXNldE5vcnRoKCk7IH0sXG4gICAgc2V0VGlsdChwKSB7IGlmICghZmxhdE9uKCkpIG5hdlJlZi5jdXJyZW50Py5zZXRUaWx0KHApOyB9LFxuICAgIHNldE1hcE1vZGUobSkge1xuICAgICAgY29uc3QgbW9kZXMgPSBtb2Rlc1JlZi5jdXJyZW50O1xuICAgICAgaWYgKCFtb2RlcyB8fCBtb2Rlcy5tb3ZpbmcgfHwgbGFuZGVyUmVmLmN1cnJlbnQ/LmFjdGl2ZSB8fCAod2luZG93IGFzIHVua25vd24gYXMgeyBfX21vb25kYT86IHsgcHJvZ3Jlc3M/OiBMb2FkUHJvZ3Jlc3MgfSB9KS5fX21vb25kYT8ucHJvZ3Jlc3M/LmRvbmUgIT09IHRydWUpIHJldHVybjtcbiAgICAgIGlmIChtID09PSAnZmxhdCcpIHZvaWQgbW9kZXMudG9GbGF0KCk7IGVsc2Ugdm9pZCBtb2Rlcy50b0dsb2JlKCk7XG4gICAgfSxcbiAgICBsb29rKGF6LCBlbCkgeyBsYW5kZXJSZWYuY3VycmVudD8ubG9vayhheiwgZWwpOyB9LFxuICAgIHdhcm1MYXllcnMoKSB7XG4gICAgICB2b2lkIHdhcm1TY2llbmNlUmFzdGVycyhjYi5jdXJyZW50LnNjaWVuY2VMYXllcnMuZmlsdGVyKGQgPT4gU0NJRU5DRV9TV0lUQ0hFUy5oYXMoZC5pZCkpLmZsYXRNYXAoc2NpZW5jZVNvdXJjZXMpKTtcbiAgICB9LFxuICB9KSwgW10pO1xuXG4gIHJldHVybiA8ZGl2IHJlZj17aG9zdH0gY2xhc3NOYW1lPVwibW9vbi1jYW52YXNcIiAvPjtcbn0pO1xuIl19