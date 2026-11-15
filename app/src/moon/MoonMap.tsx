// The 3D Moon. CesiumJS streams small map tiles for whatever is on screen, so zooming stays
// smooth and detail keeps sharpening as you get closer (the same idea as Google Earth).
// Mountains are real 3D shapes from NASA's LOLA heights, lit by the Sun at the chosen time.
//
// The Moon is rotated inside Cesium so the south pole is on Cesium's equator (see frame.ts).
// Always convert with frame.ts: never feed true lat/lon straight into Cesium.

import './ellipsoid';
import * as Cesium from 'cesium';
import {
  Cartesian2, Cartesian3, Color, DirectionalLight, EllipsoidTerrainProvider, Globe, ImageryLayer,
  ScreenSpaceEventType, VerticalOrigin, Viewer, type Entity,
} from 'cesium';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { MoonName } from '../data/names';
import { PLACES, type Place } from '../data/places';
import type { Vec3 } from '../science/ephemeris';
import { shareHeights } from '../science/client';
import type { RouteResult } from '../science/route';
import { MoonHeights } from '../science/heights';
import { cameraStore } from '../ui/stores';
import { MOON_ELLIPSOID } from './ellipsoid';
import { toCartesian, toTrueLatLon, trueToDisplayVec } from './frame';
import { cancelOffscreenImagery, captureVisibleLayerTiles, createBaseMosaicProvider, createMoonTrekProvider, createPolarPyramidProvider, createPolarRasterProvider, createScienceRasterProvider, createSeamFixProvider, imageryPending, imageryReloaded, releaseScienceLayers, setScienceLayersActive, warmScienceRasters, warmVisibleLayerTiles, type ReprojectedImageryProvider } from './imagery';
import { createCraterLayer } from './craterLayer';
import { NameLabels } from './labels';
import { LanderView, type LanderSpec, type SkyState } from './lander';
import { POLAR_EXTENT_M, SHARP_POLAR_LAYERS, scienceToLayer, type LayerDef, type ScienceRasterSource } from './layers';
import { LolaTerrainProvider } from './lolaTerrain';
import { attachNavigation, cameraHeadingPitch, poseGlobe, poseLookingAt, type Navigation } from './navigation';
import { runPreload, type LoadProgress } from './preload';
import { applyQuality, initQuality, isPhoneGraphics, knobs, setPhoneSurfaceGraphics } from '../app/quality';
import { settings } from '../app/settings';
import { t } from '../i18n';
import { SpaceSky } from './sky';
import { SkyMarkers } from './skyMarkers';
import { FlatMap, type FlatOverlay } from './flatMap';
import { loadManifest } from '../science/layerValues';
import { MapModes, type MapMode } from './mapMode';
import { createDataDetailLayer } from './dataDetail';
import { setExploreHeights } from '../explore/context';
import { mapImagery, prefetchMapHeightAt } from '../explore/mapImagery';
import { watchGraphicsContext, type GraphicsView } from '../ui/RenderStopped';

/** The Height colours layer's NASA Moon Trek map (globe, flat map and start-up preload use the same one).
 *  North of minTrueLat only: the sharper south-pole height map (data/layers/height.png) is drawn below it. */
const HEIGHT_TREK = { layer: 'LRO_LOLA_ClrShade_Global_256ppd_v06', ext: 'png', minTrueLat: -80.4 } as const;

export type MapSelection =
  | { type: 'name'; name: MoonName }
  | { type: 'place'; place: Place }
  | { type: 'pin'; lat: number; lon: number };

export interface MapPin { id: string; lat: number; lon: number; letter: string; color: string }

export interface MoonMapHandle {
  captureView(): GraphicsView | null;
  restoreView(view: GraphicsView): void;
  flyTo(lat: number, lon: number, heightKm?: number, tilted?: boolean): void;
  flyWhole(): void;
  flyPole(): void;
  zoomBy(logFactor: number): void;
  resetNorth(): void;
  setTilt(pitchDeg: number): void;
  look(azDeg: number, elDeg: number): void;
  /** Globe <-> flat map (with the choreographed move). */
  setMapMode(mode: MapMode): void;
  /** Get the south-pole maps ready to show at once (called when the Layers box opens). */
  warmLayers(): void;
  /**
   * Stop (or start again) drawing the 3D view while something covers it. The big surface map does: with the 3D
   * scene still being drawn behind it every frame, the map's own zoom ran at half the frame rate (measured
   * 33 ms a frame against 17 ms with the scene held still). The last picture stays on screen while it is held.
   */
  setRenderPaused(paused: boolean): void;
}
export type { MapMode };

interface Props {
  layers: Record<string, boolean>;
  opacity: Record<string, number>;
  scienceLayers: LayerDef[];
  names: MoonName[] | null;
  selectedPin: { lat: number; lon: number } | null;
  overviewRoute?: RouteResult | null;
  routeDestination?: { lat: number; lon: number } | null;
  choosingDestination?: boolean;
  onRouteDestination?(lat: number, lon: number): void;
  pins: MapPin[];
  /** Sun and Earth positions (TRUE frame, metres from the Moon's centre) at the time on the time bar. */
  bodies: { sun: Vec3; earth: Vec3 };
  lander: (LanderSpec & { faceAz: number }) | null;
  sky: SkyState | null;
  onSelect(sel: MapSelection): void;
  onHover(pos: { lat: number; lon: number } | null): void;
  /** The time on the time bar (ms since 1970, UTC): drives the sky. */
  timeMs?: number;
  /** Start-up loading progress for the loading screen; `done` arrives exactly once per page load. */
  onLoadProgress?(p: LoadProgress): void;
  /** The 3D map cannot be drawn (no WebGL 2, or the graphics driver refused a shader): the page says so itself (ui/RenderStopped.tsx). */
  onRenderError?(message: string): void;
  /** The globe / flat map mode changed (also when the app goes back to the globe by itself, e.g. Stand here). */
  onMapMode?(mode: MapMode): void;
}
export type { LoadProgress };

const svgUrl = (svg: string) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
// Map markers are our own small drawings (one family), at about 2x their screen size for sharpness.
// The pin: a slim teardrop whose tip is at (40, 75) of 80, exactly where the old pin's tip was, so
// the anchor and the hit area are unchanged. A soft shadow under the tip and a hairline dark edge
// keep it readable on bright and on dark ground.
const PIN_BODY = 'M40 75C38 70 25.2 46.9 21.4 39.8A21 21 0 1 1 58.6 39.8C54.8 46.9 42 70 40 75Z';
const PIN_SVG = (ring: string, label = '') => svgUrl(
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">'
  + '<defs><filter id="b" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="1.6"/></filter></defs>'
  + '<ellipse cx="40" cy="75.5" rx="7.5" ry="2.6" fill="#000" fill-opacity="0.45" filter="url(#b)"/>'
  + (label
    ? `<path d="${PIN_BODY}" fill="#f2f3f5" stroke="#0b0d10" stroke-opacity="0.6" stroke-width="1.6"/>`
      + `<circle cx="40" cy="30" r="15" fill="none" stroke="${ring}" stroke-width="3.5"/>`
      + `<text x="40" y="37" font-family="'Google Sans Flex Variable', 'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="20" font-weight="600" fill="#15161a" text-anchor="middle">${label}</text>`
    : `<path d="${PIN_BODY}" fill="#ff6b5a" stroke="#0b0d10" stroke-opacity="0.6" stroke-width="1.6"/><circle cx="40" cy="30" r="7.5" fill="#fff"/>`)
  + '</svg>');
/** A round marker for special places: dark glass disc, white symbol drawn in a 22-unit box, an optional thin coloured ring. */
const BADGE_SVG = (symbol: string, ring: string) => svgUrl(
  '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 22 22">'
  + `<circle cx="11" cy="11" r="10" fill="#151619" fill-opacity="0.86" stroke="${ring}" stroke-width="1.1"/>`
  + `<g fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${symbol}</g></svg>`);
/** A round marker with an ice crystal: ring colour, ring dashes ('' = solid) and crystal colour. */
function ICE_SVG(ring: string, dash: string, ink: string): string {
  return svgUrl('<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 22 22">'
    + `<circle cx="11" cy="11" r="10" fill="#151619" fill-opacity="0.86" stroke="${ring}" stroke-width="1.3"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
    + `<g fill="none" stroke="${ink}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5.4v11.2M6.2 8.2l9.6 5.6M15.8 8.2l-9.6 5.6"/><path d="M9.6 6.3 11 7.6l1.4-1.3M9.6 15.7 11 14.4l1.4 1.3"/></g></svg>`);
}
/** Pictures of the special places, by kind (ice evidence has one per strength of evidence: see labels.ts iconKeyOf). */
const ICON: Record<string, string> = {
  // corner brackets around a dot: "a region picked as a landing target"
  artemis: BADGE_SVG('<path d="M6.5 9V6.5H9M13 6.5h2.5V9M15.5 13v2.5H13M9 15.5H6.5V13"/><circle cx="11" cy="11" r="1.2" fill="#fff" stroke="none"/>', '#7fcfa8'),
  spot: BADGE_SVG('<path d="M5.8 14.6 9.4 8.4l2.3 3.6 1.4-1.9 3.1 4.5Z" fill="#fff" stroke-width="1"/>', 'rgba(255,255,255,0.28)'),
  // a small flag on a pole: something landed (or hit the ground) here
  mission: BADGE_SVG('<path d="M7.6 16.4V5.6"/><path d="M8.3 6.1h6.4l-1.7 2.3 1.7 2.3H8.3Z" fill="#fff" stroke-width="0.8"/>', 'rgba(255,255,255,0.28)'),
  // the same flag with radio waves and a green ring: it may still be working
  active: BADGE_SVG('<path d="M6.6 16.4V6.6"/><path d="M7.3 7.1h4.6l-1.3 1.8 1.3 1.8H7.3Z" fill="#fff" stroke-width="0.8"/><path d="M13.6 12.4a3 3 0 0 0 0-4.6M15.5 14.2a5.6 5.6 0 0 0 0-8.2"/>', '#6fcf9d'),
  // an empty flag in a dashed ring: planned, not there yet
  planned: svgUrl('<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 22 22">'
    + '<circle cx="11" cy="11" r="10" fill="#151619" fill-opacity="0.86" stroke="#a99ee8" stroke-width="1.2" stroke-dasharray="2.4 2"/>'
    + '<g fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7.6 16.4V5.6"/><path d="M8.3 6.1h6.4l-1.7 2.3 1.7 2.3H8.3Z"/></g></svg>'),
  // water ice: a six-armed crystal. White ring = measured there, cyan = signs seen from orbit, dashed blue = only predicted
  'ice-confirmed': ICE_SVG('#ffffff', '', '#ffffff'),
  'ice-detected': ICE_SVG('#50d2ff', '', '#bfeeff'),
  'ice-predicted': ICE_SVG('#6e96ff', '2.4 2', '#c9d6ff'),
  ice: ICE_SVG('#50d2ff', '', '#bfeeff'),
};
/** A short drop-in when a pin is placed on a new spot: it falls the last few pixels onto it. */
let lastDrop = '';
function dropIn(viewer: Viewer, e: Entity, spot: string) {
  if (spot === lastDrop) return; // the same pin drawn again (e.g. a plan was added): no bounce
  lastDrop = spot;
  const t0 = performance.now();
  const step = () => {
    if (!e.billboard || viewer.isDestroyed()) return;
    const k = Math.min(1, (performance.now() - t0) / 260), ease = 1 - (1 - k) ** 3;
    e.billboard.pixelOffset = new Cartesian2(0, 2 - 12 * (1 - ease)) as never;
    viewer.scene.requestRender();
    if (k < 1) requestAnimationFrame(step);
  };
  step();
}

/** Pictures the ground shader of the surface view reads (lander.ts ensureMaterial: 7, and the Sun shadow map in sunShadow.ts). */
const GROUND_SHADER_TEXTURES = 8;

type Tag = { type: string; name?: MoonName; place?: Place } | undefined;
/** Which kinds of special place show, from the layer switches (`on` = the globe is showing and you are not standing on it). */
function placeFlags(on: boolean, l: Record<string, boolean>): Record<Place['kind'], boolean> {
  return { artemis: on && !!l.artemis, spot: on && !!l.artemis, mission: on && !!l.missions, active: on && !!l.missions, planned: on && l.sitesPlanned !== false, ice: on && !!l.waterice };
}
const tagOf = (id: unknown): Tag => (id as { moonda?: Tag } | undefined)?.moonda;

const WHOLE = { lat: -35, lon: 10, alt: 6_500_000 };

const SCIENCE_SWITCHES = new Set(['psr', 'waterice', 'danger', 'slope', 'height']);
const ALL_SCIENCE_SWITCHES = Object.fromEntries([...SCIENCE_SWITCHES].map(id => [id, true]));
const LAYER_WARM_MS = 5000;

/** Use the same sources and order for visible layers and their hidden preparation. */
function flatLayerOverlays(defs: LayerDef[], layers: Record<string, boolean>, opacity: Record<string, number> = {}): FlatOverlay[] {
  const over: FlatOverlay[] = [];
  if (layers.height) {
    const alpha = opacity.height ?? 0.7;
    over.push({ id: 'height', kind: 'global', layer: HEIGHT_TREK.layer, ext: HEIGHT_TREK.ext, latMin: HEIGHT_TREK.minTrueLat, alpha });
    if (defs.some(d => d.id === 'height')) over.push({ id: 'heightPolar', kind: 'polar', url: './data/layers/height.png', alpha });
  }
  for (const def of defs) if (def.id !== 'height' && layers[def.id]) over.push({ id: def.id, kind: 'polar', url: `./data/layers/${def.id}.png`, alpha: opacity[def.id] ?? 0.7 });
  return over;
}

function switchableProviders(layers: Map<string, ImageryLayer>): ReprojectedImageryProvider[] {
  return [...layers].filter(([id]) => id === 'heightPolar' || SCIENCE_SWITCHES.has(id)).map(([, layer]) => layer.imageryProvider as unknown as ReprojectedImageryProvider);
}

/** A slow remote height map can finish in the background without extending start-up. */
function boundedLayerWarm(job: Promise<boolean>, maxMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), maxMs);
    job.then(ok => { clearTimeout(timer); resolve(ok); }, () => { clearTimeout(timer); resolve(false); });
  });
}
const scienceSources = (def: LayerDef): ScienceRasterSource[] => def.rasterSources ?? [{
  url: `./data/layers/${def.id}.png`, projection: 'polar', pole: 'south', extentM: POLAR_EXTENT_M, clipTrueLatDeg: -80.02,
}];
function prepareScienceLayers(viewer: Viewer, layers: Map<string, ImageryLayer>, defs: LayerDef[]) {
  for (const def of defs) {
    if (!SCIENCE_SWITCHES.has(def.id)) continue;
    const id = def.id === 'height' ? 'heightPolar' : def.id;
    if (layers.has(id)) continue;
    const layer = new ImageryLayer(createScienceRasterProvider({ sources: scienceSources(def), credit: def.source?.name ?? 'NASA', maximumLevel: SHARP_POLAR_LAYERS.has(def.id) ? 10 : 9 }) as never, { show: false });
    viewer.imageryLayers.add(layer);
    layers.set(id, layer);
  }
}

export const MoonMap = forwardRef<MoonMapHandle, Props>(function MoonMap(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const imagery = useRef(new Map<string, ImageryLayer>());
  const heightsRef = useRef<MoonHeights | null>(null);
  const labelsRef = useRef<NameLabels | null>(null);
  const navRef = useRef<Navigation | null>(null);
  const landerRef = useRef<LanderView | null>(null);
  const markersRef = useRef<SkyMarkers | null>(null);
  const skyRef = useRef<SpaceSky | null>(null);
  const selectedEntity = useRef<Entity | null>(null);
  const pinEntities = useRef(new Map<string, Entity>());
  const cb = useRef(props);
  cb.current = props;
  const namesLoaded = useRef<() => void>(() => {});
  const skipPreload = useRef(false);
  const flatRef = useRef<FlatMap | null>(null);
  const modesRef = useRef<MapModes | null>(null);

  useEffect(() => {
    const heights = new MoonHeights(new URL('./data/', document.baseURI).href);
    heightsRef.current = heights;
    const quality = initQuality();
    // Cesium's own answer to a failure is a raw red error box over a black page. The page gives the message itself
    // (onRenderError), both when the map cannot start at all and when drawing stops later.
    const failed = (error: unknown) => cb.current.onRenderError?.(String((error as { message?: unknown } | null)?.message ?? error));
    let viewer: Viewer;
    try {
      viewer = new Viewer(host.current!, {
        globe: new Globe(MOON_ELLIPSOID),
        baseLayer: false, terrainProvider: new EllipsoidTerrainProvider({ ellipsoid: MOON_ELLIPSOID }),
        animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false,
        sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false, infoBox: false,
        selectionIndicator: false, skyAtmosphere: false, scene3DOnly: true,
        requestRenderMode: true, maximumRenderTimeChange: Infinity, showRenderLoopErrors: false,
        useBrowserRecommendedResolution: false, msaaSamples: knobs(quality).msaaSamples,
        // A phone can blend sorted alpha without keeping floating-point translucency buffers.
        ...(isPhoneGraphics(quality) ? { orderIndependentTranslucency: false } : {}),
        creditContainer: document.getElementById('cesium-credits') ?? undefined,
      });
    } catch (error) {
      failed(error);
      return;
    }
    viewer.scene.renderError.addEventListener((_scene: unknown, error: unknown) => failed(error));
    viewerRef.current = viewer;
    const offContextLoss = watchGraphicsContext(viewer.canvas);
    const visible = () => { if (!document.hidden && !viewer.isDestroyed()) viewer.scene.requestRender(); };
    document.addEventListener('visibilitychange', visible);
    // Cesium draws as many map layers per ground tile as the graphics card has texture slots (16 on many), but it
    // does not count the 8 pictures our own ground shader reads (lander.ts: hill shadows, heights, soil scans, rock
    // shadows, the Sun shadow map). With 9 or more layers on one tile the shader then asked for more slots than
    // exist and rendering stopped ("texture image units count exceeds MAX_TEXTURE_IMAGE_UNITS"). Tell Cesium the
    // slots that are really left: it then draws a tile with many layers in two passes instead.
    const limits = (Cesium as unknown as { ContextLimits: { _maximumTextureImageUnits: number } }).ContextLimits;
    if (limits && typeof limits._maximumTextureImageUnits === 'number') limits._maximumTextureImageUnits = Math.max(4, limits._maximumTextureImageUnits - GROUND_SHADER_TEXTURES);
    // Small test/debug hook (used by scripts/drive.mjs): is the map finished loading what is on screen?
    (window as unknown as { __viewer: Viewer }).__viewer = viewer;
    // idle(): start-up loading is over and the map has nothing left to load for what is on screen
    const debugHook: Record<string, unknown> = { viewer };
    debugHook.idle = () => !viewer.isDestroyed() && (debugHook.progress as LoadProgress | undefined)?.done === true && scene.globe.tilesLoaded;
    (window as unknown as { __moonda: unknown }).__moonda = debugHook;
    if (import.meta.env.DEV) void import('cesium').then(m => { (window as unknown as { __moondaCesium: unknown }).__moondaCesium = m; }); // lets test scripts build rays in the page
    const scene = viewer.scene;
    scene.backgroundColor = Color.fromCssColorString('#04050a');
    scene.fog.enabled = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    const globe = scene.globe;
    globe.baseColor = Color.fromCssColorString('#3a3c41');
    globe.showGroundAtmosphere = false;
    globe.dynamicAtmosphereLighting = false;
    globe.lightingFadeOutDistance = 0;
    globe.lightingFadeInDistance = 1;
    // sharpness, drawing size, edge smoothing and tile caching come from the graphics mode (app/quality.ts),
    // and follow it live when the person switches mode (also while the start screen is loading)
    applyQuality(viewer);
    const offQuality = settings.subscribe((s, prev) => { if (s.quality !== prev.quality) applyQuality(viewer, s.quality); });
    globe.depthTestAgainstTerrain = true;
    globe.vertexShadowDarkness = 0.2; // the night side stays dim but readable, like Google Earth at night
    globe.lambertDiffuseMultiplier = 1.15;
    // Redraw only when something changes, but keep drawing while tiles are still arriving.
    let lastPhotoCull = 0;
    let lastPhotoMove = -Infinity;
    let photoCullTimer: ReturnType<typeof setTimeout> | undefined;
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

    heights.ready.then(() => { if (!viewer.isDestroyed() && cb.current.layers.terrain !== false) viewer.terrainProvider = new LolaTerrainProvider(heights) as never; });
    heights.ready.then(() => shareHeights(heights)).catch(() => {}); // the background calculator reuses this download
    setExploreHeights(heights); // the minimap and the trail read the same height maps

    // Photos and optional map layers (all re-projected into the rotated display frame).
    const add = (id: string, layer: ImageryLayer) => { viewer.imageryLayers.add(layer); imagery.current.set(id, layer); };
    // Bottom: a whole-Moon picture stored locally, so the Moon is never blank and works without internet.
    add('base', new ImageryLayer(createBaseMosaicProvider({ url: './data/base/v5/', credit: 'NASA Moon Trek · LRO WAC, LOLA; NASA SVS CGI Moon Kit; LROC WAC polar summer mosaics · NASA/GSFC/ASU' }) as never));
    // Sharper sources are chosen inside this provider, so they use no extra texture slot.
    add('photo', new ImageryLayer(createMoonTrekProvider({ layer: 'LRO_WAC_Mosaic_Global_303ppd_v02', ext: 'jpg', maxSourceLevel: 8, minTrueLat: -81.5, credit: 'NASA/GSFC/ASU · LRO WAC/NAC; ISAS/JAXA · Kaguya TC; Lunar QuickMap · NASA, Intuitive Machines, ACT', overBase: true, sharpPhoto: true }) as never));
    // Where NASA's WAC mosaic is lit from the other side (true lon -180..-90): albedo x hillshade instead, so no seam shows.
    add('photoFix', new ImageryLayer(createSeamFixProvider({ credit: 'NASA Moon Trek · LOLA / SLDEM2015 hillshade; NASA SVS CGI Moon Kit' }) as never));
    add('photoPolar', new ImageryLayer(createPolarRasterProvider({ url: './data/base/southpole4096.jpg', extentM: POLAR_EXTENT_M, credit: 'LROC WAC/NAC · Lunaserv', maximumLevel: 8 }) as never));
    // Sharp south-pole photos: read from the local store first (public/data/polar/t), the remote server only where nothing is stored.
    // The layer names must match the stored set exactly.
    add('polarPhoto', new ImageryLayer(createPolarPyramidProvider({ layers: 'luna_wac_roi_south_summer,luna_nac_pole_control_south', minK: 4, credit: 'LROC NAC south-pole mosaic · NASA/GSFC/ASU' }) as never, { show: false }));
    add('height', new ImageryLayer(createMoonTrekProvider({ ...HEIGHT_TREK, maxSourceLevel: 6, cachePrepared: true, credit: 'NASA Moon Trek · LRO LOLA' }) as never, { show: false, alpha: 0.75 }));

    // After a failed download is retried, draw once so the refilled tiles start loading.
    const offReload = imageryReloaded.addEventListener(() => { if (!viewer.isDestroyed()) scene.requestRender(); });

    // The real sky: Milky Way, stars, planets, a 3D Earth and the Sun, all in their true directions.
    const sky = new SpaceSky(viewer, { heights });
    skyRef.current = sky;
    debugHook.sky = sky;
    // The lander view only adds name tags for the Sun and Earth; the sky draws the bodies themselves.
    // The lander view dims the stars and Milky Way when sunlit ground or the Sun is in view (as a camera would).
    const lander = new LanderView(viewer, heights, { ownBodies: false, onSkyExposure: v => { sky.exposure = v; } });
    landerRef.current = lander;
    debugHook.lander = lander; debugHook.heights = heights;
    // Clicking the Sun or Earth chip glides the camera to a view where that body shows above the Moon's edge.
    markersRef.current = new SkyMarkers(viewer, { onPick: (_body, dir) => { if (!lander.active) void navRef.current?.showBody(dir); } });

    const labels = new NameLabels(viewer);
    labelsRef.current = labels;
    if (import.meta.env.DEV) (window as unknown as { __labels: NameLabels }).__labels = labels;
    heights.ready.then(() => {
      if (viewer.isDestroyed()) return;
      // Artemis regions, famous spots and past landings: icon + name, both placed by the label manager so nothing overlaps
      labels.setPlaces(PLACES, heights, Object.fromEntries(Object.entries(ICON).map(([k, image]) => [k, { image, size: k === 'mission' ? 20 : 22 }])));
      labels.update(); scene.requestRender();
    });
    // Names and icons keep clear of the pins and of the Sun/Earth spots.
    const pinScratchR = new Cartesian3(), pinWinR = new Cartesian2();
    labels.reserved = [
      () => {
        const out: { x0: number; y0: number; x1: number; y1: number }[] = [];
        if (cb.current.lander) return out;
        const list: { lat: number; lon: number }[] = [...cb.current.pins];
        if (cb.current.selectedPin) list.push(cb.current.selectedPin);
        const camPos = viewer.camera.positionWC;
        for (const pin of list) {
          const pos = toCartesian(pin.lat, pin.lon, heights.heightAt(pin.lat, pin.lon, false), pinScratchR);
          const toCam = Cartesian3.subtract(camPos, pos, new Cartesian3());
          if (Cartesian3.dot(toCam, pos) < -0.08 * Cartesian3.magnitude(toCam) * Cartesian3.magnitude(pos)) continue; // well round the far side
          const w = scene.cartesianToCanvasCoordinates(pos, pinWinR);
          if (w) out.push({ x0: w.x - 15, y0: w.y - 37, x1: w.x + 15, y1: w.y + 2 });
        }
        return out;
      },
      () => markersRef.current?.spotBoxes() ?? [],
      // the page's own panels (info panel, Compare drawer, Layers box, map buttons): names are not put underneath them
      () => {
        const out: { x0: number; y0: number; x1: number; y1: number }[] = [];
        const c = scene.canvas.getBoundingClientRect();
        for (const el of document.querySelectorAll<HTMLElement>('.panel, .ibtn.glass')) {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          out.push({ x0: r.left - c.left - 6, y0: r.top - c.top - 4, x1: r.right - c.left + 6, y1: r.bottom - c.top + 4 });
        }
        return out;
      },
    ];
    let lastLabel = 0, settle = 0;
    const readBars = () => {
      const st = getComputedStyle(document.documentElement);
      const dock = parseFloat(st.getPropertyValue('--dock'));
      if (Number.isFinite(dock) && dock > 0) labels.bottom = dock + 8;
    };
    // Pins are drawn on top of everything (never cut by a hill), so hide the ones round the far side by hand.
    const pinFacing = () => {
      const cam = viewer.camera.positionWC;
      const ents = [...pinEntities.current.values()];
      if (selectedEntity.current) ents.push(selectedEntity.current);
      for (const e of ents) {
        const p = e.position?.getValue(undefined as never) as Cartesian3 | undefined;
        if (!p) continue;
        const toCam = Cartesian3.subtract(cam, p, new Cartesian3());
        const show = Cartesian3.dot(toCam, p) > 0.01 * Cartesian3.magnitude(toCam) * Cartesian3.magnitude(p);
        if (e.show !== show) e.show = show;
      }
    };
    debugHook.pinFacing = pinFacing;
    const relabel = () => { readBars(); pinFacing(); labels.update(); scene.requestRender(); };
    const report = () => {
      const hp = cameraHeadingPitch(viewer);
      cameraStore.set({ km: hp.km, heading: lander.active ? lander.headingDeg() : hp.heading, pitch: hp.pitch });
    };
    viewer.camera.changed.addEventListener(() => {
      report();
      const now = performance.now();
      if (now - lastLabel > 90) { lastLabel = now; relabel(); }
      clearTimeout(settle);
      settle = window.setTimeout(relabel, 140);
    });
    viewer.camera.percentageChanged = 0.002;
    // Window or panel resized: names must be re-fitted to the new screen size.
    const resizeObs = new ResizeObserver(() => { clearTimeout(settle); settle = window.setTimeout(relabel, 60); flatRef.current?.resize(); });
    resizeObs.observe(host.current!);
    // A panel opened or closed (info panel, Compare, Layers): re-place the names once it has slid in.
    const appEl = host.current!.closest('.app');
    const panelObs = new MutationObserver(() => { clearTimeout(settle); settle = window.setTimeout(relabel, 260); });
    if (appEl) panelObs.observe(appEl, { childList: true, attributes: true, attributeFilter: ['class'] });

    // What is under the pointer? Screen-space maths only (asking the GPU costs 10-200 ms per question).
    const pickPos = new Cartesian2(), pinScratch = new Cartesian3(), pinWin = new Cartesian2();
    const groundAt = (x: number, y: number) => {
      const ray = viewer.camera.getPickRay(Cartesian2.fromElements(x, y, pickPos));
      const hit = ray && globe.pick(ray, scene);
      if (!hit) return null;
      const t = toTrueLatLon(hit);
      return { lat: t.lat, lon: t.lon };
    };
    const tagAt = (x: number, y: number) => tagOf(labels.hitTest(x, y));
    /** A compare pin (or the selected pin) drawn at this screen position, if any. */
    const pinAt = (x: number, y: number): { lat: number; lon: number } | null => {
      const list: { lat: number; lon: number }[] = [...cb.current.pins];
      if (cb.current.selectedPin) list.push(cb.current.selectedPin);
      for (const pin of list) {
        const w = scene.cartesianToCanvasCoordinates(toCartesian(pin.lat, pin.lon, heights.heightAt(pin.lat, pin.lon, false), pinScratch), pinWin);
        if (w && x >= w.x - 15 && x <= w.x + 15 && y >= w.y - 40 && y <= w.y + 2) return { lat: pin.lat, lon: pin.lon };
      }
      return null;
    };
    let lastHover = 0;
    navRef.current = attachNavigation(viewer, heights, {
      onFovWheel: d => lander.zoomFov(d),
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
        if (tag?.type === 'name' && tag.name) return cb.current.onSelect({ type: 'name', name: tag.name });
        if (tag?.type === 'place' && tag.place) return cb.current.onSelect({ type: 'place', place: tag.place });
        const g = pinAt(x, y) ?? groundAt(x, y);
        if (g) cb.current.onSelect({ type: 'pin', ...g });
      },
      onHoverMove: (x, y) => {
        labels.setHover(labels.hitTest(x, y));
        const now = performance.now();
        if (now - lastHover > 80) { lastHover = now; cb.current.onHover(groundAt(x, y)); }
      },
    });
    debugHook.nav = navRef.current;

    // The flat map (2D) and the move between it and the globe (flatMap.ts, mapMode.ts).
    let flat: FlatMap | null = null;
    try { flat = new FlatMap(host.current!, {
      labels: () => labels.flatEntries(),
      route: () => cb.current.overviewRoute ?? null,
      destination: () => cb.current.routeDestination ?? null,
      choosingDestination: () => !!cb.current.choosingDestination,
      icon: kind => labels.iconOf(kind),
      pins: () => {
        const out: { lat: number; lon: number; image: string }[] = cb.current.pins.map(p => ({ lat: p.lat, lon: p.lon, image: PIN_SVG(p.color, p.letter) }));
        if (cb.current.selectedPin) out.push({ ...cb.current.selectedPin, image: PIN_SVG('') });
        return out;
      },
      panelBoxes: () => {
        const out: { x0: number; y0: number; x1: number; y1: number }[] = [];
        const c = host.current!.getBoundingClientRect();
        for (const el of document.querySelectorAll<HTMLElement>('.panel, .ibtn.glass, .tbar-clock')) {
          const r = el.getBoundingClientRect();
          if (r.width >= 2 && r.height >= 2) out.push({ x0: r.left - c.left - 6, y0: r.top - c.top - 4, x1: r.right - c.left + 6, y1: r.bottom - c.top + 4 });
        }
        return out;
      },
      // fixed margins (the button column, the top bar, the time bar): panels opening later must not shift the map
      insets: () => ({ top: labels.top + 8, bottom: labels.bottom + 34, left: 64, right: 76 }),
      onClickTag: id => {
        const tag = tagOf(id);
        if (tag?.type === 'name' && tag.name) cb.current.onSelect({ type: 'name', name: tag.name });
        else if (tag?.type === 'place' && tag.place) cb.current.onSelect({ type: 'place', place: tag.place });
      },
      onClickGround: (lat, lon) => {
        if (cb.current.choosingDestination) cb.current.onRouteDestination?.(lat, lon);
        else cb.current.onSelect({ type: 'pin', lat, lon });
      },
      onHover: pos => cb.current.onHover(pos),
      // the status line's eye height: the height a camera would need to see what the flat map shows
      onView: km => cameraStore.set({ km, heading: 0, pitch: -90 }),
      // zooming in at the flat map's closest zoom: offer to roll back to the globe right there
      limitText: () => ({ msg: t('map.flatLimit'), go: t('map.flatCloser') }),
      onCloser: (lat, lon) => { void modesRef.current?.toGlobe({ at: { lat, lon, km: 140 } }); },
    }); } catch (error) { console.warn('Flat map unavailable; keeping the globe:', error); }
    flatRef.current = flat;
    if (import.meta.env.DEV) debugHook.flat = flat;
    const modes = flat ? new MapModes(flat, {
      viewer, nav: navRef.current,
      heightAt: (lat, lon) => heights.heightAt(lat, lon, false),
      setGlobeExtras: on => {
        const p = cb.current;
        labels.visible = on && !!p.layers.names && !p.lander;
        labels.placesVisible = placeFlags(on && !p.lander, p.layers);
        labels.update();
        const m = markersRef.current;
        if (m) m.show = on && p.layers.realSun !== false && !p.lander;
        viewer.entities.show = on;
        scene.requestRender();
      },
    }) : null;
    if (modes) modes.onChange = m => cb.current.onMapMode?.(m);
    modesRef.current = modes;
    debugHook.flat = flat; debugHook.modes = modes;

    // Start: whole Moon, tilted so the south pole is visible, true north up.
    const start = poseGlobe(WHOLE.lat, WHOLE.lon, WHOLE.alt);
    viewer.camera.setView({ destination: start.destination, orientation: { direction: start.direction, up: start.up } });
    report();

    // Behind the loading screen: load data and quietly visit the south-pole views so they are instant later.
    const debug = debugHook as { progress?: LoadProgress; skipLoading?: () => void };
    debug.skipLoading = () => { skipPreload.current = true; };
    navRef.current.enabled = false;
    void runPreload(viewer, {
      heightsReady: heights.ready,
      namesReady: new Promise<void>(res => { namesLoaded.current = res; }),
      startView: start,
      skyReady: sky.ready,
      imageryPending: () => imageryPending(false),
      lander: lander as { prewarm?: () => Promise<unknown> },
      // Compact sources, previews and the opening view's projected pixels prepare together.
      layerFiles: async () => [
        // the crater list behind the Craters layer and the route planner (1.4 MB)
        new URL('./data/features/craters.bin', document.baseURI).href, new URL('./data/features/craters-small-south.bin', document.baseURI).href,
      ],
      warmLayers: async onFrac => {
        const began = performance.now(), deadline = began + LAYER_WARM_MS;
        const opening = captureVisibleLayerTiles(viewer);
        const currentDefs = cb.current.scienceLayers.filter(d => SCIENCE_SWITCHES.has(d.id));
        prepareScienceLayers(viewer, imagery.current, currentDefs);
        // Capture and queue this view before preload moves the camera to the pole.
        let visible = warmVisibleLayerTiles(viewer, switchableProviders(imagery.current), LAYER_WARM_MS, opening);
        let overlays = isPhoneGraphics() || !flat ? Promise.resolve(true) : boundedLayerWarm(flat.warmOverlays(flatLayerOverlays(currentDefs, ALL_SCIENCE_SWITCHES)), LAYER_WARM_MS);
        const manifest = await loadManifest();
        const defs = manifest.map(scienceToLayer).filter(d => SCIENCE_SWITCHES.has(d.id));
        if (viewer.isDestroyed()) return false;
        prepareScienceLayers(viewer, imagery.current, defs);
        if (defs.some(d => !currentDefs.some(current => current.id === d.id))) {
          // The manifest can arrive after React's first frame. Its maps still warm the saved view.
          const remaining = Math.max(0, deadline - performance.now());
          const added = warmVisibleLayerTiles(viewer, switchableProviders(imagery.current), remaining, opening);
          visible = Promise.all([visible, added]).then(results => results.every(Boolean));
          const addedOverlays = isPhoneGraphics() || !flat ? Promise.resolve(true) : boundedLayerWarm(flat.warmOverlays(flatLayerOverlays(defs, ALL_SCIENCE_SWITCHES)), remaining);
          overlays = Promise.all([overlays, addedOverlays]).then(results => results.every(Boolean));
        }
        // The small value files also stay available for a new spot after going offline.
        const values = manifest.flatMap(e => e.valueSources ?? []).filter(s => s.packed);
        const bytes = warmScienceRasters([...defs.flatMap(scienceSources), ...values], onFrac);
        const [filesReady, globeReady, flatReady] = await Promise.all([bytes, visible, overlays]);
        debugHook.layerWarm = { ms: Math.round(performance.now() - began), filesReady, globeReady, flatReady };
        return filesReady && globeReady && flatReady;
      },
      warmViews: () => {
        const ridge = { lat: -89.45, lon: -136.7 }; // Shackleton – de Gerlache connecting ridge
        const g = heights.heightAt(ridge.lat, ridge.lon, false);
        return [
          { pose: poseLookingAt(-90, 0, 0, 820_000, 0, -90), label: 'Getting the south pole ready…', maxMs: 6000, warm: () => {
            const heightLayer = imagery.current.get('height');
            if (!heightLayer || viewer.isDestroyed()) return;
            const began = performance.now();
            debugHook.poleHeightWarm = { ms: 0, ready: false, running: true };
            // Only Height colours streams remote tiles here. Reuse this hidden visit without delaying Enter.
            void warmVisibleLayerTiles(viewer, [heightLayer.imageryProvider as unknown as ReprojectedImageryProvider], 20000).then(ready => {
              debugHook.poleHeightWarm = { ms: Math.round(performance.now() - began), ready, running: false };
            }, () => { debugHook.poleHeightWarm = { ms: Math.round(performance.now() - began), ready: false, running: false }; });
          } },
          { pose: poseLookingAt(ridge.lat, ridge.lon, g, 90_000, 20, -38), label: 'Building the 3D mountains…', maxMs: 5000 },
          { pose: poseLookingAt(ridge.lat, ridge.lon, g, 12_000, 60, -18), label: 'Sharpening the landing area…', maxMs: 4000 },
        ];
      },
      onProgress: p => {
        debug.progress = p;
        if (p.done && navRef.current && !lander.active) navRef.current.enabled = true;
        // the flat map's picture and shaders, quietly, once the start-up loading is over (the first switch must not hitch)
        if (p.done && !isPhoneGraphics()) { const go = () => void flat?.prepare(settings.get().quality === 'light').catch(e => console.warn('Flat map not available:', e)); if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 1500 }); else setTimeout(go, 300); }
        cb.current.onLoadProgress?.(p);
      },
      cancelled: () => skipPreload.current,
    });

    return () => { offContextLoss(); document.removeEventListener('visibilitychange', visible); setPhoneSurfaceGraphics(false); releaseScienceLayers(); flat?.destroy(); offQuality(); offReload(); offPhotoCull(); clearTimeout(photoCullTimer); resizeObs.disconnect(); panelObs.disconnect(); clearTimeout(settle); navRef.current?.destroy(); lander.destroy(); markersRef.current?.destroy(); labels.destroy(); sky.destroy(); skyRef.current = null; viewer.destroy(); viewerRef.current = null; };
  }, []);

  // Names
  useEffect(() => {
    const labels = labelsRef.current, heights = heightsRef.current;
    if (!labels || !heights || !props.names) return;
    let live = true;
    Promise.all([document.fonts.load('500 13px "Inter Variable"'), heights.ready]).finally(() => {
      if (!live) return;
      labels.setNames(props.names!, heights);
      labels.update();
      namesLoaded.current();
      viewerRef.current?.scene.requestRender();
    });
    return () => { live = false; };
  }, [props.names]);

  // Layers
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (props.layers.dataDetail && !imagery.current.get('dataDetail')) {
      const layer = createDataDetailLayer();
      viewer.imageryLayers.add(layer);
      imagery.current.set('dataDetail', layer);
    }
    createCraterLayer(viewer, () => flatRef.current,
      (lat, lon) => heightsRef.current?.heightAt(lat, lon, false) ?? 0).show = !!props.layers.craters && !props.lander;
    prepareScienceLayers(viewer, imagery.current, props.scienceLayers);
    setScienceLayersActive(props.scienceLayers.filter(d => SCIENCE_SWITCHES.has(d.id) && props.layers[d.id]).flatMap(scienceSources));
    for (const [id, layer] of imagery.current) {
      layer.show = id === 'photoPolar' || id === 'base' || id === 'photoFix' ? !!props.layers.photo : id === 'heightPolar' ? !!props.layers.height : !!props.layers[id];
      const opKey = id === 'heightPolar' ? 'height' : id === 'base' || id === 'photoFix' ? 'photo' : id;
      layer.alpha = id === 'dataDetail' ? 1 : id === 'craters' ? 1 : props.opacity[opKey] ?? (id === 'photo' || id === 'base' || id === 'photoFix' || id === 'photoPolar' || id === 'polarPhoto' ? 1 : 0.7);
    }
    for (const def of props.scienceLayers) { const l = imagery.current.get(def.id === 'height' ? 'heightPolar' : def.id); if (l) viewer.imageryLayers.raiseToTop(l); }
    const dd = imagery.current.get('dataDetail');
    if (dd) viewer.imageryLayers.raiseToTop(dd);
    const cr = imagery.current.get('craters'); // outlines stay readable over every colour map
    if (cr) viewer.imageryLayers.raiseToTop(cr);
    const labels = labelsRef.current;
    const onGlobe = (modesRef.current?.mode ?? 'globe') === 'globe' && !modesRef.current?.moving;
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
      flat.setOverlays(flatLayerOverlays(props.scienceLayers, props.layers, props.opacity));
      flat.refreshLabels();
    }
    viewer.scene.requestRender();
  }, [props.layers, props.opacity, props.scienceLayers, props.lander]);

  // 3D mountains on/off
  useEffect(() => {
    const viewer = viewerRef.current, heights = heightsRef.current;
    if (!viewer || !heights) return;
    heights.ready.then(() => {
      if (viewer.isDestroyed()) return;
      const want3d = props.layers.terrain !== false;
      const is3d = viewer.terrainProvider instanceof LolaTerrainProvider;
      if (want3d && !is3d) viewer.terrainProvider = new LolaTerrainProvider(heights) as never;
      if (!want3d && is3d) viewer.terrainProvider = new EllipsoidTerrainProvider({ ellipsoid: MOON_ELLIPSOID });
    });
  }, [props.layers.terrain]);

  // A ground polyline uses the terrain's depth, including our rotated lunar tiles.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const scene = viewer.scene;
    let live = true, line: Cesium.GroundPolylinePrimitive | null = null;
    let flag: Entity | null = null;
    const route = props.overviewRoute, dest = props.routeDestination;
    flatRef.current?.request();
    if (dest && !props.lander) {
      flag = viewer.entities.add({
        id: 'overview-route-end', position: toCartesian(dest.lat, dest.lon),
        billboard: {
          image: svgUrl('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="44" viewBox="0 0 40 44"><path d="M10 44V4M11 5h23l-6 8 6 8H11" fill="#acdfff" stroke="#182f43" stroke-width="3" stroke-linejoin="round"/><path d="M10 44V4" stroke="#acdfff" stroke-width="2"/></svg>'),
          width: 27, height: 30, verticalOrigin: VerticalOrigin.BOTTOM,
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          pixelOffset: new Cartesian2(-7, 0), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      });
    }
    const off = scene.preRender.addEventListener(() => {
      if (line) line.show = !cb.current.lander && viewer.entities.show;
    });
    if (route?.ok && route.path.length >= 4 && !props.lander) {
      void Cesium.GroundPolylinePrimitive.initializeTerrainHeights().then(() => {
        if (!live || viewer.isDestroyed()) return;
        const positions: Cartesian3[] = [];
        for (let i = 0; i < route.path.length; i += 2) positions.push(toCartesian(route.path[i], route.path[i + 1]));
        line = new Cesium.GroundPolylinePrimitive({
          geometryInstances: new Cesium.GeometryInstance({ geometry: new Cesium.GroundPolylineGeometry({ positions, width: 5 }) }),
          appearance: new Cesium.PolylineMaterialAppearance({ material: Cesium.Material.fromType('PolylineOutline', {
            color: Color.fromCssColorString('#acdfff').withAlpha(0.94), outlineColor: Color.fromCssColorString('#182f43').withAlpha(0.9), outlineWidth: 1,
          }) }),
          classificationType: Cesium.ClassificationType.TERRAIN, asynchronous: false, allowPicking: false,
        });
        // Cesium ships Earth's height bounds. Some are below the lunar ground, which clips
        // the line away. Only while this synchronous primitive builds its volume, give it
        // a generous lunar envelope; the visible line still clamps to the real terrain.
        const bounds = (Cesium as unknown as { ApproximateTerrainHeights: { _defaultMaxTerrainHeight: number; getMinimumMaximumHeights: (...args: unknown[]) => { minimumTerrainHeight: number; maximumTerrainHeight: number } } }).ApproximateTerrainHeights;
        const updating = line as unknown as { update(frame: unknown): void };
        const update = updating.update.bind(line);
        updating.update = frame => {
          const saved = bounds.getMinimumMaximumHeights;
          const savedMax = bounds._defaultMaxTerrainHeight;
          bounds.getMinimumMaximumHeights = () => ({ minimumTerrainHeight: -15000, maximumTerrainHeight: 15000 });
          bounds._defaultMaxTerrainHeight = 15000;
          try { update(frame); } finally { bounds.getMinimumMaximumHeights = saved; bounds._defaultMaxTerrainHeight = savedMax; }
        };
        scene.groundPrimitives.add(line);
        scene.requestRender();
      }).catch(error => console.warn('Route line could not load:', error));
    }
    scene.requestRender();
    return () => {
      live = false; off();
      if (!viewer.isDestroyed()) {
        if (line) scene.groundPrimitives.remove(line);
        if (flag) viewer.entities.remove(flag);
        scene.requestRender();
      }
    };
  }, [props.overviewRoute, props.routeDestination, props.lander]);

  // Selected pin + compare pins. Placed at the real ground height and drawn over everything:
  // "clamped to ground" pins get partly cut by nearby hills in Cesium, so we do not use that.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const h = heightsRef.current;
    const pinPos = (lat: number, lon: number) => toCartesian(lat, lon, (h?.heightAt(lat, lon, true) ?? 0) + 3);
    if (selectedEntity.current) { viewer.entities.remove(selectedEntity.current); selectedEntity.current = null; }
    if (props.selectedPin && !props.lander) {
      selectedEntity.current = viewer.entities.add({
        position: pinPos(props.selectedPin.lat, props.selectedPin.lon),
        billboard: { image: PIN_SVG(''), width: 38, height: 38, verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, 2), disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
      dropIn(viewer, selectedEntity.current, `${props.selectedPin.lat},${props.selectedPin.lon}`);
    }
    for (const [, e] of pinEntities.current) viewer.entities.remove(e);
    pinEntities.current.clear();
    if (!props.lander) for (const p of props.pins) {
      pinEntities.current.set(p.id, viewer.entities.add({
        position: pinPos(p.lat, p.lon),
        billboard: { image: PIN_SVG(p.color, p.letter), width: 38, height: 38, verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, 2), disableDepthTestDistance: Number.POSITIVE_INFINITY },
      }));
    }
    (viewerRef.current && (window as unknown as { __moonda?: { pinFacing?: () => void } }).__moonda?.pinFacing?.());
    labelsRef.current?.update(); // names step aside for the pins
    flatRef.current?.request();
    viewer.scene.requestRender();
  }, [props.selectedPin, props.pins, props.lander]);

  // Real sunlight at the chosen time: shading of the whole Moon, the Sun/Earth chips and the sky.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const sunOn = props.layers.realSun !== false;
    const s = trueToDisplayVec(props.bodies.sun);
    const d = Cartesian3.normalize(new Cartesian3(s[0], s[1], s[2]), new Cartesian3());
    viewer.scene.light = new DirectionalLight({ direction: Cartesian3.negate(d, d), intensity: 2.0 });
    viewer.scene.globe.enableLighting = sunOn;
    const m = markersRef.current;
    const flat = flatRef.current;
    if (flat) {
      const len = Math.hypot(...props.bodies.sun) || 1, le = Math.hypot(...props.bodies.earth) || 1;
      flat.sun = [props.bodies.sun[0] / len, props.bodies.sun[1] / len, props.bodies.sun[2] / len];
      flat.earth = [props.bodies.earth[0] / le, props.bodies.earth[1] / le, props.bodies.earth[2] / le];
      flat.sunOn = sunOn;
      flat.request();
    }
    const onGlobe = (modesRef.current?.mode ?? 'globe') === 'globe' && !modesRef.current?.moving;
    if (m) { m.show = sunOn && !props.lander && onGlobe; m.spots = props.layers.skymarkers === true; m.update(props.bodies.sun, props.bodies.earth); labelsRef.current?.update(); }
    skyRef.current?.update(props.timeMs ?? Date.now(), props.bodies);
    viewer.scene.requestRender();
  }, [props.layers.realSun, props.layers.skymarkers, props.bodies, props.lander, props.timeMs]);

  // Stars, Milky Way, planets and their name tags follow the layer switches (the Sun and Earth are always drawn).
  useEffect(() => {
    const sky = skyRef.current;
    if (!sky) return;
    const stars = props.layers.stars !== false;
    sky.show = { stars, milkyWay: stars, planets: stars, earth: true, sun: true, names: stars && props.layers.skyNames !== false };
    viewerRef.current?.scene.requestRender();
  }, [props.layers.stars, props.layers.skyNames]);

  // First-person lander view
  const landerKey = props.lander ? `${props.lander.lat},${props.lander.lon},${props.lander.mastM},${!!props.lander.skyline}` : '';
  useEffect(() => {
    const lander = landerRef.current, nav = navRef.current;
    if (!lander || !nav) return;
    if (props.lander && props.sky) {
      const spec = props.lander, sky = props.sky;
      void prefetchMapHeightAt(spec.lat, spec.lon);
      void mapImagery.warmScienceAt(spec.lat, spec.lon, cb.current.scienceLayers);
      const go = () => { setPhoneSurfaceGraphics(true); nav.enabled = false; lander.enter(spec, sky, spec.faceAz); };
      const modes = modesRef.current;
      // from the flat map: first a shortened move back to the globe at that spot
      if (modes && modes.mode === 'flat') void modes.toGlobe({ at: { lat: spec.lat, lon: spec.lon, km: 40 }, fast: true, handOff: go });
      else go();
    } else if (!props.lander && lander.active) {
      setPhoneSurfaceGraphics(false);
      lander.exit(); // first: it puts Cesium's input switch back the way navigation left it
      nav.enabled = true;
    }
  }, [landerKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (props.sky) landerRef.current?.updateSky(props.sky); }, [props.sky]);

  const flatOn = () => modesRef.current?.mode === 'flat' && !modesRef.current.moving ? flatRef.current : null;
  const heldRender = useRef(false);
  useImperativeHandle(ref, () => ({
    captureView() {
      const v = viewerRef.current;
      if (!v || v.isDestroyed()) return null;
      const a = (p: Cartesian3) => [p.x, p.y, p.z];
      const flat = flatOn();
      return { position: a(v.camera.positionWC), direction: a(v.camera.directionWC), up: a(v.camera.upWC), ...(flat ? { flat: { ...flat.view } } : {}) };
    },
    restoreView(saved) {
      const v = viewerRef.current;
      if (!v || ![saved.position, saved.direction, saved.up].every(a => a.length === 3 && a.every(Number.isFinite))) return;
      const p = (a: number[]) => new Cartesian3(a[0], a[1], a[2]);
      v.camera.setView({ destination: p(saved.position), orientation: { direction: p(saved.direction), up: p(saved.up) } });
      if (saved.flat && Object.values(saved.flat).every(Number.isFinite)) {
        const view = saved.flat;
        void modesRef.current?.toFlat().then(() => { const flat = flatRef.current; if (flat) { flat.view = view; flat.request(); } });
      }
      v.scene.requestRender();
    },
    setRenderPaused(paused) {
      const v = viewerRef.current;
      if (!v) return;
      // only take the loop away if it is running (the flat 2D view stops it for itself), and give back only what was taken
      if (paused) { if (v.useDefaultRenderLoop) { heldRender.current = true; v.useDefaultRenderLoop = false; } }
      else if (heldRender.current) { heldRender.current = false; v.useDefaultRenderLoop = true; v.scene.requestRender(); }
    },
    flyTo(lat, lon, heightKm = 60, tilted = false) {
      const v = viewerRef.current;
      if (!v || modesRef.current?.moving) return;
      const flat = flatOn();
      if (flat) { void flat.flyTo(flat.viewAt(lat, lon, Math.max(20, heightKm * 1.15))); return; }
      const ground = heightsRef.current?.heightAt(lat, lon, false) ?? 0;
      const pose = tilted ? poseLookingAt(lat, lon, ground, heightKm * 1600, cameraHeadingPitch(v).heading, -38) : poseLookingAt(lat, lon, ground, heightKm * 1000, 0, -90);
      void navRef.current?.flyTo(pose);
    },
    flyWhole() {
      const flat = flatOn();
      if (flat) { void flat.flyTo(flat.wholeView()); return; }
      const p = poseGlobe(WHOLE.lat, WHOLE.lon, WHOLE.alt);
      void navRef.current?.flyTo(p);
    },
    flyPole() {
      // Straight down on the south pole, nearside (0° longitude) at the top — like NASA's polar maps.
      const p = poseLookingAt(-90, 0, 0, 820_000, 0, -90);
      // the pole is badly stretched on a flat map: go back to the globe and fly there
      if (modesRef.current?.mode === 'flat') { void modesRef.current.toGlobe({ at: { lat: -90, lon: 0, km: 900 }, pose: p }); return; }
      void navRef.current?.flyTo(p);
    },
    zoomBy(f) { const flat = flatOn(); if (flat) flat.zoomBy(f); else navRef.current?.zoomBy(f); },
    resetNorth() { if (!flatOn()) navRef.current?.resetNorth(); },
    setTilt(p) { if (!flatOn()) navRef.current?.setTilt(p); },
    setMapMode(m) {
      const modes = modesRef.current;
      if (!modes || modes.moving || landerRef.current?.active || (window as unknown as { __moonda?: { progress?: LoadProgress } }).__moonda?.progress?.done !== true) return;
      if (m === 'flat') void modes.toFlat(); else void modes.toGlobe();
    },
    look(az, el) { landerRef.current?.look(az, el); },
    warmLayers() {
      const viewer = viewerRef.current;
      if (!viewer || viewer.isDestroyed()) return;
      const defs = cb.current.scienceLayers.filter(d => SCIENCE_SWITCHES.has(d.id));
      prepareScienceLayers(viewer, imagery.current, defs);
      void warmScienceRasters(defs.flatMap(scienceSources));
      void warmVisibleLayerTiles(viewer, switchableProviders(imagery.current), LAYER_WARM_MS);
      void flatRef.current?.warmOverlays(flatLayerOverlays(defs, ALL_SCIENCE_SWITCHES));
    },
  }), []);

  return <div ref={host} className="moon-canvas" />;
});
