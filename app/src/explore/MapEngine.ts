// The surface maps share one renderer. A flat photo plane carries the close view into a true
// longitude/latitude map; far frames are ordinary image blits. Rover updates stay outside React.
import { roverLink, SpotFrame, type Waypoint } from '../moon/roverLink';
import type { Vec3 } from '../science/ephemeris';
import type { RouteResult } from '../science/route';
import type { LayerDef } from '../moon/layers';
import type { MoonName } from '../data/names';
import { cratersNear, craterSizeOpacity } from '../moon/craterLayer';
import { exploreHeights } from './context';
import { SurfaceProjection } from './surfaceProjection';
import { BASE_PICTURES, MAP_DETAIL_SOURCES, MAP_R, POLAR_HALF, TREK_MAX_LEVEL, detailUrl, cropMapPhoto, getPhotoPreview, mapImagery, polarLatLon, polarXY, trekUrl, scienceTileRect, scienceHeightParts } from './mapImagery';
import { drawingPixelRatio, isPhoneGraphics } from '../app/quality';
import { watchGraphicsContext } from '../ui/RenderStopped';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const ROUTE = '#85dcf0';
const TRAIL = '#edbd83';
const FONT = '"Google Sans Flex Variable",system-ui,sans-serif';
type XY = [number, number];
/** Once round the Moon. The flat map repeats sideways at this distance, like a printed world map joined at its ends. */
const WORLD = MAP_R * TAU;
/** The same distance east or west, taken the short way round. */
const wrapWorld = (d: number) => d - WORLD * Math.round(d / WORLD);
export interface MapPoint { lat: number; lon: number; heightM: number }
export interface MapScale { metres: number; widthPx: number; label: string }
export interface MapHover { kind: 'trail' | 'route'; lat: number; lon: number; sunPct?: number; earthPct?: number }
export interface MapEngineOptions { round: boolean; follow?: boolean; acrossM?: number; onChange?: () => void }
export interface MapEngineUpdate { layers?: Record<string,boolean>; opacity?: Record<string,number>; layerDefs?: LayerDef[]; realSun?: boolean; route?: RouteResult | null; bodies?: { sun: Vec3; earth: Vec3 }; overlays?: string[]; dimmed?: boolean; destination?: { lat: number; lon: number } | null; names?: MoonName[] | null;
  /** Rectangles on the card (CSS px: left, top, right, bottom) covered by floating controls: no name is placed under them. */
  keepClear?: number[][] }
interface RoundPhoto {
  canvas: HTMLCanvasElement;
  cx: number; cy: number;
  width: number; height: number; across: number; dpr: number;
  keys: Set<string>;
  fading: boolean;
}

/** A canvas map, with no DOM reads in its drawing loop. All positions are true Moon lat/lon. */
export class MapEngine {
  private static readonly views = new Set<MapEngine>();
  private readonly canvas: HTMLCanvasElement;
  private readonly options: MapEngineOptions;
  private readonly off: (() => void)[];
  private width = 196;
  private height = 196;
  private dpr = 1;
  private across: number;
  private cx = 0;
  private cy = 0;
  private rotation = 0;
  private anchor: SpotFrame | null = null;
  private polar = false;
  private projection: FlatMapProjection | null = null;
  private projectionRevision = -1;
  private route: RouteResult | null = null;
  private overlays: string[] = [];
  private layers: Record<string,boolean> = {};
  private opacity: Record<string,number> = {};
  private layerDefs: LayerDef[] = [];
  private realSun = false;
  private layerSignature = '';
  private dimmed = false;
  private sun: Vec3 | null = null;
  private zoomTarget: number | null = null;
  private zoomAnchor: XY = [0, 0];
  private zoomGround: XY = [0, 0];
  private zoomClock = 0;
  private zoomVelocity = 0;
  private destination: { lat: number; lon: number } | null = null;
  private fading = false;
  private active = true;
  private covered = false;
  private alive = true;
  private raf = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastDraw = -Infinity;
  private lastPose = '';
  private trailRef: number[] | null = null;
  private trailXY: number[] = [];
  private routeRef: RouteResult | null = null;
  private routeXY: number[] = [];
  private photoKeys = new Set<string>();
  private roundPhoto: RoundPhoto | null = null;
  private polarBatch = false;
  private photoDirty = true;
  private sourceLayer: HTMLCanvasElement | null = null;
  private sourceCoverage: HTMLCanvasElement | null = null;
  private sourceMask: HTMLCanvasElement | null = null;
  private basePlane: BasePlane | null = null;
  private cameraDeg = NaN;
  private roverDeg = NaN;
  private bearingClock = 0;
  private turning = false;
  private wheelInput: WheelEvent | null = null;
  private interactiveUntil = 0;
  private reducedMotion = false;
  private wheelTimer: ReturnType<typeof setTimeout> | undefined;
  private names: MoonName[] | null = null;
  /** Each name's direction from the Moon's centre (x, y, z), so far-away names are skipped without any trigonometry. */
  private nameUnits: Float32Array | null = null;
  private nameWidths = new Map<string, number>();
  /** Names on screen or fading: how visible each is (0 to 1) and whether it is wanted in this frame. */
  private nameShown = new Map<number, { alpha: number; on: boolean; x: number; y: number }>();
  private nameClock = 0;
  private keepClear: number[][] = [];
  /** The crater rims chosen for the view they were chosen in (lat, lon, km in threes): see drawCraters. */
  private craterPick: { rings: Float32Array; across: number; centre: [number, number, number]; revision: number } | null = null;

  constructor(canvas: HTMLCanvasElement, options: MapEngineOptions) {
    this.canvas = canvas;
    this.options = options;
    this.across = options.acrossM ?? (options.round ? 180 : 10000);
    MapEngine.views.add(this);
    if(options.round)this.covered=[...MapEngine.views].some(view=>!view.options.round);
    else for(const view of MapEngine.views)if(view.options.round)view.cover(true);
    this.off = [roverLink.subscribe(() => this.poseChanged()), roverLink.onTrail(() => this.requestDraw()),
      roverLink.onWaypoints(() => this.requestDraw()), mapImagery.subscribe(key => {
        if (key === undefined || !this.roundPhoto || this.roundPhoto.keys.has(key)) this.photoDirty = true;
        this.requestDraw();
      })];
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motionChanged = () => { this.reducedMotion = motionQuery.matches; };
    motionChanged(); motionQuery.addEventListener('change', motionChanged);
    this.off.push(() => motionQuery.removeEventListener('change', motionChanged));
    let densityQuery: MediaQueryList | null = null;
    const densityChanged = () => {
      this.resize(this.width, this.height);
      watchDensity();
    };
    const watchDensity = () => {
      densityQuery?.removeEventListener('change', densityChanged);
      densityQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      densityQuery.addEventListener('change', densityChanged);
    };
    // A monitor change can change pixel density without changing the map's CSS size.
    watchDensity();
    this.off.push(() => densityQuery?.removeEventListener('change', densityChanged));
    // Views keep their existing wheel callbacks. Capture the original units before they turn
    // a wheel into a factor, so pinch input can track the fingers without an easing delay.
    const rememberWheel = (event: WheelEvent) => {
      this.wheelInput = event;
      clearTimeout(this.wheelTimer);
      this.wheelTimer = setTimeout(() => { if (this.wheelInput === event) this.wheelInput = null; }, 0);
    };
    canvas.addEventListener('wheel', rememberWheel, { capture: true, passive: true });
    this.off.push(() => canvas.removeEventListener('wheel', rememberWheel, true));
    // The map draws only when something changes. A browser short of graphics memory, or one that put the tab
    // aside, can hand the canvas back empty: nothing has changed then, so ask for the picture again ourselves.
    const repaint = () => { if (!document.hidden) { this.photoDirty = true; this.requestDraw(); } };
    canvas.addEventListener('contextrestored', repaint); document.addEventListener('visibilitychange', repaint);
    this.off.push(() => { canvas.removeEventListener('contextrestored', repaint); document.removeEventListener('visibilitychange', repaint); });
    try { this.basePlane = new BasePlane(() => { this.photoDirty = true; this.requestDraw(); }); } catch { /* Canvas fallback still works without another GPU context. */ }
    this.syncAnchor();
    this.centre();
  }

  resize(width: number, height: number) {
    if (width <= 0 || height <= 0) return;
    this.width = width; this.height = height;
    const ratio = Math.min(isPhoneGraphics() ? 1 : 2.5, window.devicePixelRatio || 1);
    this.dpr = this.basePlane?.pixelRatio(width, height, ratio) ?? ratio;
    // Setting a canvas's size wipes its picture, even to the size it already has. The page sends "resize" for
    // other reasons too (a language switch does), and a wiped map then stood empty until it was next drawn.
    const pixelWidth = Math.round(width * this.dpr), pixelHeight = Math.round(height * this.dpr);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) { this.canvas.width = pixelWidth; this.canvas.height = pixelHeight; }
    if (!this.options.round) {
      const limits = this.getZoomLimits();
      this.across = Math.max(limits.min, Math.min(limits.max, this.across));
      if (this.zoomTarget !== null) this.zoomTarget = Math.max(limits.min, Math.min(limits.max, this.zoomTarget));
      this.projection?.setAcross(this.across, false); this.clampView();
    }
    this.options.onChange?.();
    this.requestDraw();
  }

  update(value: MapEngineUpdate) {
    if(value.layers)this.layers=value.layers;
    if(value.opacity)this.opacity=value.opacity;
    if(value.layerDefs)this.layerDefs=value.layerDefs;
    if(value.realSun!==undefined)this.realSun=value.realSun;
    if(value.layers||value.opacity||value.layerDefs){
      const signature=JSON.stringify(this.layerDefs.map(def=>[def.id,!!this.layers[def.id],this.opacity[def.id]??.7,def.rasterSources]));
      if(signature!==this.layerSignature){this.layerSignature=signature;this.photoDirty=true;}
    }
    if ('route' in value) this.route = value.route ?? null;
    if ('destination' in value) this.destination = value.destination ?? null;
    if (value.overlays) this.overlays = value.overlays;
    if (value.dimmed !== undefined) this.dimmed = value.dimmed;
    if (value.bodies) this.sun = value.bodies.sun;
    if (value.keepClear) this.keepClear = value.keepClear;
    if ('names' in value && value.names !== this.names) {
      this.names = value.names ?? null; this.nameShown.clear();
      this.nameUnits = this.names ? new Float32Array(this.names.length * 3) : null;
      this.names?.forEach((n, i) => {
        const p = n.lat * DEG, l = n.lon * DEG, c = Math.cos(p);
        this.nameUnits![i * 3] = c * Math.cos(l); this.nameUnits![i * 3 + 1] = c * Math.sin(l); this.nameUnits![i * 3 + 2] = Math.sin(p);
      });
    }
    this.requestDraw();
  }

  getAcross() { return this.across; }
  getDiagnostics() { return { layers:Object.keys(this.layers).filter(id=>this.layers[id]), opacity:this.opacity, layerDefs:this.layerDefs.map(d=>d.id),realSun:this.realSun,covered:this.covered, drawing:{width:this.canvas.width,height:this.canvas.height,pixelRatio:this.dpr}, projection: 'flat', blend: this.projection?.blend ?? 0, imagery: mapImagery.getStats(), gpu: this.basePlane?.getStats() }; }
  /** A small, on-demand check of the retained data tiles; never reads pixels in the draw loop. */
  getRasterDiagnostics() {
    const canvas=new OffscreenCanvas(128,128),g=canvas.getContext('2d',{willReadFrequently:true})!;
    const layers:Record<string,{tiles:number;nonzeroAlphaSamples:number;alphaSum:number}>={};
    for(const key of this.photoKeys){
      if(!key.startsWith('science:'))continue;
      const image=mapImagery.get(key);if(!image)continue;
      const id=key.split(':')[1],entry=layers[id]??={tiles:0,nonzeroAlphaSamples:0,alphaSum:0};
      g.clearRect(0,0,128,128);g.drawImage(image,0,0,128,128);const pixels=g.getImageData(0,0,128,128).data;entry.tiles++;
      for(let i=3;i<pixels.length;i+=4){if(pixels[i])entry.nonzeroAlphaSamples++;entry.alphaSum+=pixels[i];}
    }
    return layers;
  }
  /** A short scale for the shared glass read-out; its length is in CSS pixels. */
  getScale(): MapScale {
    const ppm = this.width / this.across, limit = Math.min(100, this.width * .2) / ppm;
    const power = 10 ** Math.floor(Math.log10(limit));
    const metres = (limit / power >= 5 ? 5 : limit / power >= 2 ? 2 : 1) * power;
    return { metres, widthPx: metres * ppm, label: metres >= 1000 ? `${metres / 1000} km` : `${metres} m` };
  }
  /** Farthest out, the Moon fills the card from pole to pole (and at most once round, on a very wide card). */
  getZoomLimits() { return { min: this.minAcross(), max: this.options.round ? 300000 : Math.min(WORLD, MAP_R * Math.PI * this.width / Math.max(1, this.height)) }; }

  /** Initial place/index sizing is immediate; user gestures always use the eased target. */
  setAcross(acrossM: number) {
    const limits = this.getZoomLimits();
    this.stopMotion(); this.across = Math.max(limits.min, Math.min(limits.max, acrossM));
    this.projection?.setAcross(this.across, this.options.round);
    this.clampView();
    this.options.onChange?.(); this.requestDraw();
  }

  screenAt(lat: number, lon: number): { x: number; y: number } | null {
    if (!this.projection || (!this.options.round && !this.projection.visible(lat, lon))) return null;
    const p = this.project(lat, lon), screen = this.screen(p[0], p[1]);
    return Number.isFinite(screen[0] + screen[1]) ? { x: screen[0], y: screen[1] } : null;
  }

  /** Picking a destination uses exactly the ground currently on screen, without a zoom still running. */
  stopMotion() { this.zoomTarget = null; this.zoomVelocity = 0; }

  setActive(on: boolean) {
    this.active = on;
    if (on) { this.photoDirty = true; this.requestDraw(); }
    else {
      if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; clearTimeout(this.timer); this.timer = undefined;
      this.basePlane?.cancelPendingGlobal(true);
      mapImagery.release(this);
    }
  }

  private cover(on:boolean) {
    this.covered=on;
    if(!on){this.photoDirty=true;this.requestDraw();return;}
    // The expanded picture covers the dial. Its hidden canvas and tile queue need no frames.
    if(this.raf)cancelAnimationFrame(this.raf);this.raf=0;clearTimeout(this.timer);this.timer=undefined;
    this.basePlane?.cancelPendingGlobal(true);mapImagery.release(this);
    if (isPhoneGraphics()) { this.basePlane?.releasePhotos(); this.roundPhoto = null; }
  }

  centre() {
    this.stopMotion(); this.syncAnchor();
    const p = roverLink.pose, spot = roverLink.spot;
    this.projection?.reset(p.on ? p.lat : spot?.lat ?? 0, p.on ? p.lon : spot?.lon ?? 0);
    this.projection?.setAcross(this.across, this.options.round);
    this.polar = (this.projection?.lat ?? 0) < -79.5;
    const at = this.project(p.on ? p.lat : spot?.lat ?? 0, p.on ? p.lon : spot?.lon ?? 0);
    this.cx = at[0]; this.cy = at[1]; this.clampView(); this.photoDirty = true;
    this.requestDraw();
  }

  /** Drag distance in CSS pixels; the ground follows the pointer. */
  pan(dx: number, dy: number) {
    this.interactiveUntil = performance.now() + 140;
    this.moveView(dx, dy, false); this.requestDraw();
  }

  private moveView(dx: number, dy: number, keepZoomAnchor: boolean) {
    // Keep the map's meridian fixed. Recentring a projection while crossing a pole would
    // flip longitude by 180 degrees; offsets pan the same flat frame continuously instead.
    const a = this.rotation, c = Math.cos(a), s = Math.sin(a), ppm = this.width / this.across;
    this.cx -= (dx * c + dy * s) / ppm; this.cy -= (dx * s - dy * c) / ppm;
    this.clampView();
    const at = this.unproject(this.cx, this.cy);
    this.polar = at[0] < -79.5;
    if (!keepZoomAnchor && this.zoomTarget !== null) {
      const at = this.pointAt(this.zoomAnchor[0], this.zoomAnchor[1]);
      if (Number.isFinite(at.lat + at.lon)) this.zoomGround = [at.lat, at.lon];
    }
  }

  /** factor > 1 moves closer; preserve the ground under the pointer. */
  zoomAt(factor: number, x = this.width / 2, y = this.height / 2) {
    this.interactiveUntil = performance.now() + 140;
    const wheel = this.wheelInput;
    this.wheelInput = null;
    if (wheel) {
      // A view may finish its opening transform during the same input event. Use the canvas's
      // current rectangle, rather than a React view's older cached bounds.
      const bounds = this.canvas.getBoundingClientRect();
      x = (wheel.clientX - bounds.left) * this.width / bounds.width;
      y = (wheel.clientY - bounds.top) * this.height / bounds.height;
      const delta = wheel.deltaY * (wheel.deltaMode === 1 ? 40 : wheel.deltaMode === 2 ? this.height : 1);
      factor = Math.exp(-Math.max(-1600, Math.min(1600, delta)) * (wheel.ctrlKey ? .01 : Math.log(1.6) / 120));
    }
    if (!(factor > 0) || !Number.isFinite(factor)) return;
    const limits = this.getZoomLimits();
    const target = Math.max(limits.min, Math.min(limits.max, (wheel?.ctrlKey ? this.across : this.zoomTarget ?? this.across) / factor));
    const at = this.pointAt(x, y);
    if (this.zoomTarget === null) { this.zoomClock = performance.now(); this.zoomVelocity = 0; }
    const valid = Number.isFinite(at.lat + at.lon);
    this.zoomAnchor = valid ? [x, y] : [this.width / 2, this.height / 2];
    this.zoomGround = valid ? [at.lat, at.lon] : [this.projection?.lat ?? 0, this.projection?.lon ?? 0];
    if (wheel?.ctrlKey || this.reducedMotion) {
      this.stopMotion(); this.across = target;
      this.projection?.setAcross(this.across, this.options.round);
      this.keepPointerGround();
      this.options.onChange?.(); this.requestDraw(); return;
    }
    this.zoomTarget = target;
    this.options.onChange?.(); this.requestDraw();
  }

  private clampView() {
    if (this.options.round || !this.projection) return;
    // Sideways the map goes round the Moon and comes back to where it started, so the view is never stopped
    // there: its centre is only kept inside one turn. (It used to stop at an edge half way round from the rover.)
    this.cx = wrapWorld(this.cx);
    const reachY = Math.max(0, MAP_R * Math.PI / 2 - this.across * this.height / this.width / 2);
    const middleY = -this.projection.offsetN();
    this.cy = Math.max(middleY - reachY, Math.min(middleY + reachY, this.cy));
  }

  private keepPointerGround() {
    const p = this.project(this.zoomGround[0], this.zoomGround[1]);
    const dx = this.zoomAnchor[0] - this.width / 2, dy = this.zoomAnchor[1] - this.height / 2;
    const c = Math.cos(this.rotation), s = Math.sin(this.rotation), ppm = this.width / this.across;
    this.cx = p[0] - (dx * c + dy * s) / ppm;
    this.cy = p[1] - (dx * s - dy * c) / ppm;
    this.clampView();
    this.polar = this.unproject(this.cx, this.cy)[0] < -79.5;
  }

  pointAt(x: number, y: number): MapPoint {
    const xy = this.screenWorld(x, y), ll = this.unproject(xy[0], xy[1]);
    return { lat: ll[0], lon: ll[1], heightM: Number.isFinite(ll[0] + ll[1]) ? exploreHeights()?.heightAt(ll[0], ll[1], true) ?? NaN : NaN };
  }

  hoverAt(x: number, y: number): MapHover | null {
    this.syncPaths();
    let best = 11 * 11, answer: MapHover | null = null;
    const scan = (xy: number[], values: ArrayLike<number>, stride: number, kind: 'trail' | 'route') => {
      const breaks = kind === 'trail' ? new Set(roverLink.breaks) : null;
      for (let i = 0; i < xy.length; i += 2) {
        const index = i / 2;
        if (!this.options.round && !this.projection?.visible(values[index * stride], values[index * stride + 1])) continue;
        const a = this.screen(xy[i], xy[i + 1]);
        let fraction = 0, dist: number;
        if (i && !breaks?.has(i / 2)) {
          const b = this.screen(xy[i - 2], xy[i - 1]), dx = a[0] - b[0], dy = a[1] - b[1];
          fraction = Math.max(0, Math.min(1, ((x - b[0]) * dx + (y - b[1]) * dy) / Math.max(1e-8, dx * dx + dy * dy)));
          dist = (b[0] + dx * fraction - x) ** 2 + (b[1] + dy * fraction - y) ** 2;
        } else dist = (a[0] - x) ** 2 + (a[1] - y) ** 2;
        if (dist >= best) continue;
        best = dist;
        const p = i / 2, q = i ? p - 1 : p, mix = (k: number) => values[q * stride + k] * (1 - fraction) + values[p * stride + k] * fraction;
        const lonA = values[q * stride + 1], lonB = values[p * stride + 1];
        const lon = lonA + ((((lonB - lonA) + 540) % 360) - 180) * fraction;
        answer = { kind, lat: mix(0), lon: ((lon + 540) % 360) - 180 };
        if (kind === 'route' && this.route) { answer.sunPct = this.route.sunPct[p]; answer.earthPct = this.route.earthPct[p]; }
      }
    };
    scan(this.trailXY, roverLink.trail, 3, 'trail');
    if (this.route?.ok) scan(this.routeXY, this.route.path, 2, 'route');
    return answer;
  }

  destroy() {
    this.alive = false;
    this.off.forEach(off => off());
    if (this.raf) cancelAnimationFrame(this.raf);
    clearTimeout(this.timer); clearTimeout(this.wheelTimer);
    this.basePlane?.destroy();
    mapImagery.release(this);
    MapEngine.views.delete(this);
    if(!this.options.round&&![...MapEngine.views].some(view=>!view.options.round))for(const view of MapEngine.views)if(view.options.round)view.cover(false);
  }

  private minAcross() { return 60; }

  /** Bearings used by the actual drawing, also exposed for the browser check. */
  getBearings() {
    const p = roverLink.pose, camera = this.mapBearing(this.cameraDeg), rover = this.mapBearing(this.roverDeg);
    return { cameraDeg: this.cameraDeg, roverDeg: this.roverDeg, targetCameraDeg: p.camAz,
      targetRoverDeg: p.headingDeg, rotationDeg: this.rotation / DEG,
      cameraMapDeg: camera, roverMapDeg: rover,
      coneScreenDeg: wrapBearing(camera + this.rotation / DEG),
      arrowScreenDeg: wrapBearing(rover + this.rotation / DEG) };
  }

  private mapBearing(degrees: number): number {
    if (!Number.isFinite(degrees) || !this.anchor) return 0;
    const p = roverLink.pose, lat = p.lat * DEG, lon = p.lon * DEG;
    const u = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    const a = this.anchor.lat * DEG, l = this.anchor.lon * DEG;
    const n0 = [-Math.sin(a) * Math.cos(l), -Math.sin(a) * Math.sin(l), Math.cos(a)];
    const along = n0[0] * u[0] + n0[1] * u[1] + n0[2] * u[2];
    const north = n0.map((v, i) => v - along * u[i]), length = Math.hypot(...north);
    for (let i = 0; i < 3; i++) north[i] /= length;
    const east = [north[1] * u[2] - north[2] * u[1], north[2] * u[0] - north[0] * u[2], north[0] * u[1] - north[1] * u[0]];
    const az = degrees * DEG, v = u.map((c, i) => c + (east[i] * Math.sin(az) + north[i] * Math.cos(az)) * 10 / MAP_R);
    const r = Math.hypot(...v), tip = this.project(Math.asin(v[2] / r) / DEG, Math.atan2(v[1], v[0]) / DEG);
    const here = this.project(p.lat, p.lon);
    return wrapBearing(Math.atan2(tip[0] - here[0], tip[1] - here[1]) / DEG);
  }

  private smoothBearings(now: number) {
    const p = roverLink.pose, dt = Math.min(.1, Math.max(0, (now - this.bearingClock) / 1000));
    this.bearingClock = now;
    if (!Number.isFinite(this.cameraDeg + this.roverDeg)) { this.cameraDeg = p.camAz; this.roverDeg = p.headingDeg; }
    const k = this.reducedMotion ? 1 : 1 - Math.exp(-dt / .045);
    const cameraGap = angleGap(p.camAz, this.cameraDeg), roverGap = angleGap(p.headingDeg, this.roverDeg);
    this.cameraDeg = wrapBearing(this.cameraDeg + cameraGap * k);
    this.roverDeg = wrapBearing(this.roverDeg + roverGap * k);
    this.turning = !this.reducedMotion && Math.abs(cameraGap) + Math.abs(roverGap) > .015;
    if (!this.turning) { this.cameraDeg = p.camAz; this.roverDeg = p.headingDeg; }
    this.rotation = this.options.round ? -this.mapBearing(this.cameraDeg) * DEG : 0;
  }

  private syncAnchor() {
    const s = roverLink.spot;
    if (!s || (this.anchor?.lat === s.lat && this.anchor.lon === s.lon)) return;
    this.anchor = new SpotFrame(s.lat, s.lon); this.polar = s.lat < -79.5;
    this.projection = new FlatMapProjection(s.lat, s.lon);
    this.cameraDeg = NaN; this.roverDeg = NaN;
    this.projection.setAcross(this.across, this.options.round);
    this.cx = 0; this.cy = 0; this.roundPhoto = null; this.photoDirty = true;
    this.trailRef = null; this.trailXY = []; this.routeRef = null;
  }

  private project(lat: number, lon: number): XY { return this.projection?.project(lat, lon) ?? [0, 0]; }
  private unproject(e: number, n: number): XY { return this.projection?.unproject(e, n) ?? [0, 0]; }

  private screen(e: number, n: number): XY {
    // (of the repeating copies of a place, the one nearest the middle of the view)
    const ppm = this.width / this.across, x = wrapWorld(e - this.cx) * ppm, y = -(n - this.cy) * ppm;
    const c = Math.cos(this.rotation), s = Math.sin(this.rotation);
    return [this.width / 2 + x * c - y * s, this.height / 2 + x * s + y * c];
  }

  private screenWorld(x: number, y: number): XY {
    const ppm = this.width / this.across, dx = x - this.width / 2, dy = y - this.height / 2;
    const c = Math.cos(this.rotation), s = Math.sin(this.rotation);
    return [this.cx + (dx * c + dy * s) / ppm, this.cy + (dx * s - dy * c) / ppm];
  }

  private poseChanged() {
    const p = roverLink.pose, key = `${p.on},${p.lat},${p.lon},${p.headingDeg},${p.camAz}`;
    if (key === this.lastPose) return;
    const moved = !this.lastPose.startsWith(`${p.on},${p.lat},${p.lon},`);
    this.lastPose = key;
    if (moved && (this.options.round || this.options.follow)) { const at = this.project(p.lat, p.lon); this.cx = at[0]; this.cy = at[1]; }
    this.requestDraw();
  }

  private requestDraw() {
    if (!this.alive || !this.active || this.covered || this.raf || this.timer !== undefined) return;
    const now = performance.now();
    const delay = this.zoomTarget !== null || this.turning || now < this.interactiveUntil ? 0 : 1000 / 30 - (now - this.lastDraw);
    if (delay > 0) this.timer = setTimeout(() => { this.timer = undefined; this.requestDraw(); }, delay);
    else this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  private syncPaths() {
    this.syncAnchor();
    if (this.projectionRevision !== this.projection?.revision) {
      this.projectionRevision = this.projection?.revision ?? -1;
      this.trailRef = null; this.routeRef = null; this.trailXY = []; this.routeXY = [];
    }
    const trail = roverLink.trail;
    if (this.trailRef !== trail || this.trailXY.length / 2 > trail.length / 3) { this.trailRef = trail; this.trailXY = []; }
    for (let i = this.trailXY.length / 2; i < trail.length / 3; i++) this.trailXY.push(...this.project(trail[i * 3], trail[i * 3 + 1]));
    if (this.routeRef !== this.route) {
      this.routeRef = this.route; this.routeXY = [];
      if (this.route?.ok) for (let i = 0; i < this.route.path.length; i += 2) this.routeXY.push(...this.project(this.route.path[i], this.route.path[i + 1]));
    }
  }

  private draw() {
    if (!this.alive || !this.active || this.covered) return;
    this.lastDraw = performance.now();
    if (this.basePlane?.lost) { this.basePlane.destroy(); this.basePlane = null; this.photoDirty = true; }
    this.basePlane?.beginFrame();
    this.smoothBearings(this.lastDraw);
    this.fading = false;
    if (this.zoomTarget !== null) {
      const now = performance.now(), dt = Math.max(.001, Math.min(.05, (now - this.zoomClock) / 1000)), omega = 1 / .08;
      this.zoomClock = now;
      const x = Math.log(this.across), target = Math.log(this.zoomTarget), gap = x - target, j = this.zoomVelocity + omega * gap, decay = Math.exp(-omega * dt);
      const next = target + (gap + j * dt) * decay;
      this.zoomVelocity = Math.max(-.24 / dt, Math.min(.24 / dt, (this.zoomVelocity - omega * j * dt) * decay));
      // Large swipes stay continuous without making a journey across the Moon take several seconds.
      let step = Math.max(-.24, Math.min(.24, next - x));
      if ((target - x) * (target - x - step) < 0) { step = target - x; this.zoomVelocity = 0; }
      this.across = Math.exp(x + step);
      if (Math.abs(Math.log(this.across / this.zoomTarget)) < .0002 && Math.abs(this.zoomVelocity) < .002) { this.across = this.zoomTarget; this.stopMotion(); }
      this.projection?.setAcross(this.across, this.options.round);
      this.keepPointerGround();
      if (this.zoomTarget !== null) this.requestDraw();
      this.options.onChange?.();
    }
    this.syncPaths();
    const g = this.canvas.getContext('2d');
    if (!g) return;
    const w = this.width, h = this.height, radius = Math.min(w, h) / 2;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, w, h); g.save();
    if (this.options.round) { g.beginPath(); g.arc(w / 2, h / 2, radius - 2, 0, TAU); g.clip(); }
    g.fillStyle = '#10171c'; g.fillRect(0, 0, w, h);
    const limb = (this.projection?.limbRadius ?? Infinity) * w / this.across;
    if (!this.options.round && limb < Math.hypot(w, h)) { g.beginPath(); g.arc(w / 2, h / 2, limb, 0, TAU); g.clip(); }
    if (this.projection?.blend !== 1) { g.fillStyle = '#35393a'; g.fillRect(0, 0, w, h); }
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    this.photoKeys = new Set<string>();
    if (this.options.round) this.drawRoundPhoto(g);
    else { this.drawBase(g); if (this.across < 800000) { if (this.polar) this.drawPolar(g); else this.drawTrek(g); } }
    if(!this.options.round)this.drawScienceLayers(g);
    if(this.realSun&&this.sun)this.drawSunlight(g);
    if(this.dimmed){g.fillStyle='rgba(5,12,18,.24)';g.fillRect(0,0,w,h);}
    mapImagery.retain(this, this.photoKeys);
    if (!this.options.round) { this.drawCraters(g); this.drawNames(g); }
    this.drawRocks(g);
    this.drawLine(g, this.routeXY, ROUTE, false);
    this.drawLine(g, this.trailXY, TRAIL, true);
    this.drawWaypoints(g);
    this.drawRover(g);
    if (this.options.round) {
      const shade = g.createRadialGradient(w / 2, h / 2, radius * .56, w / 2, h / 2, radius);
      shade.addColorStop(0, 'rgba(3,9,14,0)'); shade.addColorStop(1, 'rgba(3,9,14,.47)');
      g.fillStyle = shade; g.fillRect(0, 0, w, h);
    }
    g.restore();
    if (this.options.round) this.drawRing(g);
    if (this.fading || this.turning) this.requestDraw();
  }

  private picture(key: string, urls: string[], priority = 0) {
    this.photoKeys.add(key);
    return mapImagery.request(key, urls, priority);
  }

  private tileFade(key: string) {
    const alpha = mapImagery.fade(key);
    if (alpha < 1) this.fading = true;
    return alpha;
  }

  private drawRoundPhoto(g: CanvasRenderingContext2D) {
    let photo = this.roundPhoto;
    const w = this.width, h = this.height, across = this.across;
    const moved = photo && Math.hypot(this.cx - photo.cx, this.cy - photo.cy) > across * .3;
    const ratio = photo ? photo.across / across : 1;
    const changedScale = !photo || ratio > 1.5 || ratio < .8 || (this.zoomTarget === null && photo.across !== across);
    if (!photo || this.photoDirty || photo.fading || moved || photo.width !== w || photo.height !== h || changedScale || photo.dpr !== this.dpr) {
      const canvas = photo?.canvas ?? document.createElement('canvas');
      const width = Math.round(w * 2 * this.dpr), height = Math.round(h * 2 * this.dpr);
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const image = canvas.getContext('2d');
      if (!image) return;
      image.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      image.fillStyle = '#35393a'; image.fillRect(0, 0, w * 2, h * 2);
      image.imageSmoothingEnabled = true; image.imageSmoothingQuality = 'high';
      const rotation = this.rotation;
      const keys = new Set<string>();
      // Cache twice the visible ground, north up, at exactly the display's pixel density.
      // Camera turns then cost one image draw; requests and tile meshes only run on a real change.
      this.width = w * 2; this.height = h * 2; this.across = across * 2; this.rotation = 0; this.photoKeys = keys;
      try { this.drawBase(image); if (this.polar) this.drawPolar(image); else this.drawTrek(image); this.drawScienceLayers(image); }
      finally { this.width = w; this.height = h; this.across = across; this.rotation = rotation; }
      photo = { canvas, cx: this.cx, cy: this.cy, width: w, height: h, across, dpr: this.dpr, keys, fading: this.fading };
      this.roundPhoto = photo; this.photoDirty = false;
    }
    this.photoKeys = new Set(photo.keys);
    const ppm = w / across, scale = photo.across / across;
    g.save(); g.translate(w / 2, h / 2); g.rotate(this.rotation);
    g.drawImage(photo.canvas, (photo.cx - this.cx) * ppm - w * scale, -(photo.cy - this.cy) * ppm - h * scale, w * 2 * scale, h * 2 * scale);
    g.restore();
  }

  private drawBase(g: CanvasRenderingContext2D) {
    this.photoKeys.add('base-flat');
    const flat = mapImagery.requestFlatBase();
    if (flat && this.projection?.blend === 1) { this.basePlane?.cancelPendingGlobal(); this.drawFlat(g, flat); return; }
    const quick = BASE_PICTURES[0];
    const low = this.picture('base-quick', [quick.url], -100);
    // Close source tiles still refine the phone map without keeping a decoded 128 MiB overview.
    const high = isPhoneGraphics() || this.polar && this.across < 300000 ? null : this.picture('base-global', [BASE_PICTURES[1].url], -80);
    if(low)this.drawBasePicture(g,low);
    if(high){this.drawBasePicture(g,high);if(this.basePlane?.tiledFading)this.fading=true;}

  }

  private drawBasePicture(g: CanvasRenderingContext2D, image: ImageBitmap) {
    if (!this.anchor || !this.projection) return;
    if (this.basePlane) {
      try {
        const photo = this.basePlane.draw(image, this.projection, this.width, this.height, this.dpr, this.across, this.cx, this.cy, this.rotation);
        if (photo) g.drawImage(photo, 0, 0, this.width, this.height); return;
      } catch { /* The small canvas mesh remains available when GPU contexts are limited. */ }
    }
    this.drawBaseMesh(g, image, 8);
  }

  /** The whole Moon is a flat 2:1 rectangle. Splitting at the longitude seam needs two blits. */
  private drawFlat(g: CanvasRenderingContext2D, image: ImageBitmap) {
    const projection = this.projection;
    if (!projection) return;
    const ppm = this.width / this.across, circumference = MAP_R * TAU;
    const centreU = ((projection.lon + 180) / 360 % 1 + 1) % 1;
    const westU = ((centreU - .5) % 1 + 1) % 1, first = 1 - westU;
    const top = this.height / 2 - MAP_R * Math.PI * ppm / 2 + this.cy * ppm;
    // the rectangle repeats to the left and right, so scrolling sideways never reaches an end
    for (const turn of [-1, 0, 1]) {
      const left = this.width / 2 - circumference * ppm / 2 - this.cx * ppm + turn * circumference * ppm;
      if (left >= this.width || left + circumference * ppm <= 0) continue;
      g.drawImage(image, westU * image.width, 0, first * image.width, image.height,
        left, top, first * circumference * ppm, MAP_R * Math.PI * ppm);
      if (westU > 1e-9) g.drawImage(image, 0, 0, westU * image.width, image.height,
        left + first * circumference * ppm, top, westU * circumference * ppm, MAP_R * Math.PI * ppm);
    }
  }

  private drawBaseMesh(g: CanvasRenderingContext2D, image: ImageBitmap, farCells: number) {
    const far = this.across > 400000;
    const cols = far ? farCells : this.options.round ? 2 : 8, rows = far ? farCells : this.options.round ? 2 : 6;
    const limit = this.projection?.limbRadius ?? Infinity;
    const poles = far ? [{ point: this.screenAt(0, 90), v: 0 }, { point: this.screenAt(0, -90), v: image.height }].filter(p => p.point !== null) : [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const dest: XY[] = [[i / cols * this.width, j / rows * this.height], [(i + 1) / cols * this.width, j / rows * this.height],
        [(i + 1) / cols * this.width, (j + 1) / rows * this.height], [i / cols * this.width, (j + 1) / rows * this.height]];
      const source = dest.map(([x, y]): XY => {
        const xy = this.screenWorld(x, y), radius = Math.hypot(xy[0], xy[1]);
        if (radius >= limit) { xy[0] *= (limit - .001) / radius; xy[1] *= (limit - .001) / radius; }
        const ll = this.unproject(xy[0], xy[1]), p = ll[0] * DEG, l = ll[1] * DEG;
        const X = Math.cos(p) * Math.cos(l), Y = -Math.sin(p), Z = Math.cos(p) * Math.sin(l);
        return [(Math.atan2(Y, X) / TAU + .5) * image.width, (.5 - Math.asin(Math.max(-1, Math.min(1, Z))) / Math.PI) * image.height];
      });
      for (let k = 1; k < source.length; k++) {
        while (source[k][0] - source[0][0] > image.width / 2) source[k][0] -= image.width;
        while (source[k][0] - source[0][0] < -image.width / 2) source[k][0] += image.width;
      }
      // A source-texture pole needs a fan, rather than one quad stretched across every longitude.
      const pole = poles.find(p => p.point!.x >= dest[0][0] && p.point!.x < dest[2][0] && p.point!.y >= dest[0][1] && p.point!.y < dest[2][1]);
      if (pole) {
        for (let edge = 0; edge < 4; edge++) {
          const a: XY = [...source[edge]], b: XY = [...source[(edge + 1) % 4]];
          while (b[0] - a[0] > image.width / 2) b[0] -= image.width;
          while (b[0] - a[0] < -image.width / 2) b[0] += image.width;
          for (const offset of [-image.width, 0, image.width]) textureTriangle(g, image,
            [[a[0] + offset, a[1]], [b[0] + offset, b[1]], [(a[0] + b[0]) / 2 + offset, pole.v]],
            [dest[edge], dest[(edge + 1) % 4], [pole.point!.x, pole.point!.y]]);
        }
        continue;
      }
      for (const offset of [-image.width, 0, image.width]) {
        const src = source.map(([x, y]): XY => [x + offset, y]);
        if (Math.max(...src.map(s => s[0])) < 0 || Math.min(...src.map(s => s[0])) > image.width) continue;
        textureTriangle(g, image, [src[0], src[1], src[2]], [dest[0], dest[1], dest[2]]);
        textureTriangle(g, image, [src[0], src[2], src[3]], [dest[0], dest[2], dest[3]]);
      }
    }
  }

  private drawPolar(g: CanvasRenderingContext2D) {
    const corners = [[0, 0], [this.width, 0], [this.width, this.height], [0, this.height]].map(([x, y]) => {
      const en = this.screenWorld(x, y);
      const ll = this.unproject(en[0], en[1]); return polarXY(ll[0], ll[1]);
    });
    const minX = Math.min(...corners.map(p => p[0])), maxX = Math.max(...corners.map(p => p[0]));
    const minY = Math.min(...corners.map(p => p[1])), maxY = Math.max(...corners.map(p => p[1]));
    const ll = this.unproject(this.cx, this.cy), top = ll[0] < -84 ? 10 : 4;
    const kMax = Math.max(0, Math.min(top, Math.ceil(Math.log2(608000 / (512 * this.across / (this.width * this.dpr))))));
    this.polarBatch = !!this.basePlane && (this.projection?.blend ?? 0) > 0;
    if(this.polarBatch)this.basePlane!.beginBatch(this.width,this.height,this.dpr);
    const loaded = new Map<string, ImageBitmap>();
    for (let k = 0; k <= kMax; k++) {
      const count = 2 ** k, span = 608000 / count;
      const i0 = Math.max(0, Math.floor((minX + POLAR_HALF) / span)), i1 = Math.min(count - 1, Math.floor((maxX + POLAR_HALF) / span));
      const j0 = Math.max(0, Math.floor((POLAR_HALF - maxY) / span)), j1 = Math.min(count - 1, Math.floor((POLAR_HALF - minY) / span));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const image = this.picture(`polar-${k}-${i}-${j}`, mapImagery.polarUrls(k, i, j), -60 + k);
        if (image) { if(this.polarBatch)this.basePlane!.prepare(image,true);loaded.set(`${k}-${i}-${j}`, image); }
      }
    }
    // Draw each visible leaf once, using its sharpest loaded ancestor. Painting all ten
    // full-size parent levels underneath it would fill the Retina canvas ten times a frame.
    const count = 2 ** kMax, span = 608000 / count;
    const i0 = Math.max(0, Math.floor((minX + POLAR_HALF) / span)), i1 = Math.min(count - 1, Math.floor((maxX + POLAR_HALF) / span));
    const j0 = Math.max(0, Math.floor((POLAR_HALF - maxY) / span)), j1 = Math.min(count - 1, Math.floor((POLAR_HALF - minY) / span));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const chain: { image: ImageBitmap; factor: number; ai: number; aj: number; alpha: number }[] = [];
      for (let k = 0; k <= kMax; k++) {
        const factor = 2 ** (kMax - k), ai = Math.floor(i / factor), aj = Math.floor(j / factor), image = loaded.get(`${k}-${ai}-${aj}`);
        if (!image) continue;
        if(this.polarBatch&&!this.basePlane!.isReady(image)){this.fading=true;continue;}
        const alpha = k === 0 ? 1 : Math.min(this.tileFade(`polar-${k}-${ai}-${aj}`),this.polarBatch?this.basePlane!.fade(image):1);
        if(alpha<1)this.fading=true;
        if (alpha >= 1) chain.length = 0;
        chain.push({ image, factor, ai, aj, alpha });
      }
      for (const { image, factor, ai, aj, alpha } of chain) {
        const sw = image.width / factor, sh = image.height / factor;
        g.save(); g.globalAlpha *= alpha;
        this.drawPolarImage(g, image, -POLAR_HALF + i * span, POLAR_HALF - j * span, span, [(i - ai * factor) * sw, (j - aj * factor) * sh, sw, sh]);
        g.restore();
      }
    }
    if(this.polarBatch){this.basePlane!.endBatch();g.drawImage(this.basePlane!.canvas,0,0,this.width,this.height);this.polarBatch=false;}

  }

  private drawPolarImage(g: CanvasRenderingContext2D, image: ImageBitmap, x: number, y: number, span: number, crop?: [number, number, number, number]) {
    if (this.basePlane && this.projection && this.projection.blend > 0) {
      const sample=getPhotoPreview(image)??image,original=crop??[0,0,image.width,image.height];
      const source = { x,y,span,crop:[original[0]*sample.width/image.width,original[1]*sample.height/image.height,original[2]*sample.width/image.width,original[3]*sample.height/image.height] as [number,number,number,number] };
      const photo = this.basePlane.draw(sample, this.projection, this.width, this.height, this.dpr, this.across, this.cx, this.cy, this.rotation, source, this.polarBatch ? g.globalAlpha : 1);
      if(this.polarBatch)return;
      if (photo) {
        const alpha=this.basePlane.fade(sample);if(alpha<1)this.fading=true;
        const r=this.basePlane.rect;
        if(r.width>0&&r.height>0){g.save();g.globalAlpha*=alpha;
          g.drawImage(photo,r.x*this.dpr,r.y*this.dpr,r.width*this.dpr,r.height*this.dpr,r.x,r.y,r.width,r.height);g.restore();}
      }
      return;
    }
    if ((this.projection?.blend ?? 0) === 0 && this.across < 500000) {
      const corner = (px: number, py: number) => { const ll = polarLatLon(px, py), p = this.project(ll[0], ll[1]); return this.screen(p[0], p[1]); };
      const a = corner(x, y), b = corner(x + span, y), c = corner(x, y - span);
      const rect = crop ?? [0, 0, image.width, image.height];
      g.save(); g.transform(b[0]-a[0], b[1]-a[1], c[0]-a[0], c[1]-a[1], a[0], a[1]);
      g.drawImage(image, rect[0], rect[1], rect[2], rect[3], 0, 0, 1, 1); g.restore(); return;
    }
    const steps = this.across < 30000 ? 1 : this.across < 300000 ? 2 : 6;
    const rect = crop ?? [0, 0, image.width, image.height];
    for (let j = 0; j < steps; j++) for (let i = 0; i < steps; i++) {
      const uv = [[i / steps, j / steps], [(i + 1) / steps, j / steps], [(i + 1) / steps, (j + 1) / steps], [i / steps, (j + 1) / steps]];
      const ll = uv.map(([u, v]) => polarLatLon(x + u * span, y - v * span));
      if (ll.every(at => !this.projection?.visible(at[0], at[1]))) continue;
      const src = uv.map(([u, v]): XY => [rect[0] + u * rect[2], rect[1] + v * rect[3]]);
      this.drawSurfaceTriangle(g, image, [src[0], src[1], src[2]], [ll[0], ll[1], ll[2]]);
      this.drawSurfaceTriangle(g, image, [src[0], src[2], src[3]], [ll[0], ll[2], ll[3]]);
    }
  }

  private drawTrek(g: CanvasRenderingContext2D) {
    const centre = this.unproject(this.cx, this.cy);
    const samples: XY[] = [];
    for (let j = 0; j <= 3; j++) for (let i = 0; i <= 3; i++) {
      const en = this.screenWorld(i / 3 * this.width, j / 3 * this.height), ll = this.unproject(en[0], en[1]);
      ll[1] = centre[1] + ((ll[1] - centre[1] + 540) % 360) - 180; samples.push(ll);
    }
    const south = Math.max(-90, Math.min(...samples.map(s => s[0]))), north = Math.min(90, Math.max(...samples.map(s => s[0])));
    const west = Math.min(...samples.map(s => s[1])), east = Math.max(...samples.map(s => s[1]));
    const mpp = this.across / (this.width * this.dpr);
    const desired = Math.max(0, Math.ceil(Math.log2(Math.PI * MAP_R / (256 * mpp))));
    const bounds: [number, number, number, number] = [west, east, south, north];
    this.drawGeographicSource(g, 'trek', Math.min(TREK_MAX_LEVEL, desired), bounds, trekUrl, 10);
    // Kaguya fills in the whole Moon at 20.8 m. NAC is much sharper, but only ask for its
    // published small footprints; neither source can turn an unknown part into invented detail.
    for (const source of MAP_DETAIL_SOURCES) {
      if (desired <= 8 || (source.maxZ > 10 && desired <= 10)) continue;
      for (const shift of [-360, 0, 360]) {
        const clipped: [number, number, number, number] = [Math.max(west, source.west + shift), Math.min(east, source.east + shift),
          Math.max(south, source.south), Math.min(north, source.north)];
        if (clipped[0] >= clipped[1] || clipped[2] >= clipped[3]) continue;
        this.drawFeatheredSource(g, `detail-${source.layer}`, Math.min(source.maxZ, desired), clipped,
          (z, x, y) => detailUrl(source, z, x, y), source.maxZ > 10 ? 30 : 20);
      }
    }
  }

  private drawFeatheredSource(g: CanvasRenderingContext2D, key: string, top: number, visible: [number, number, number, number], url: (z: number, x: number, y: number) => string, priority: number) {
    const canvas = this.sourceLayer ??= document.createElement('canvas');
    const width = Math.round(this.width * this.dpr), height = Math.round(this.height * this.dpr);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const layer = canvas.getContext('2d');
    if (!layer) return;
    layer.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    layer.globalCompositeOperation = 'source-over'; layer.globalAlpha = 1;
    layer.clearRect(0, 0, this.width, this.height);
    layer.imageSmoothingEnabled = true; layer.imageSmoothingQuality = 'high';
    this.drawGeographicSource(layer, key, top, visible, url, priority);
    this.featherCoverage(layer, canvas);
    g.drawImage(canvas, 0, 0, this.width, this.height);
  }

  /** Source bounds include empty pixels. Fade their actual joined coverage, including tiles still arriving. */
  private featherCoverage(g: CanvasRenderingContext2D, photo: HTMLCanvasElement) {
    const coverage = this.sourceCoverage ??= document.createElement('canvas');
    const mask = this.sourceMask ??= document.createElement('canvas');
    const w = this.width, h = this.height, pad = 32, inset = 12, diagonal = inset / Math.SQRT2;
    // The mask needs CSS resolution only. No photo pixels are read back to the CPU.
    const width = Math.ceil(w) + pad * 2, height = Math.ceil(h) + pad * 2;
    for (const canvas of [coverage, mask]) {
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    }
    const alpha = coverage.getContext('2d'), eroded = mask.getContext('2d');
    if (!alpha || !eroded) return;
    alpha.globalCompositeOperation = 'source-over'; alpha.filter = 'none';
    alpha.clearRect(0, 0, width, height);
    alpha.drawImage(photo, pad, pad, w, h);
    // Sample inside the antialiased crop edge. Padding also covers that edge in the mask only;
    // the untouched photo still clips the result, so a fully covered viewport never fades into its base.
    const edge = 2, reach = pad + edge;
    const sx = Math.min(photo.width - 1, Math.ceil(edge * photo.width / w));
    const sy = Math.min(photo.height - 1, Math.ceil(edge * photo.height / h));
    alpha.drawImage(photo, sx, 0, 1, photo.height, 0, pad, reach, h);
    alpha.drawImage(photo, photo.width - 1 - sx, 0, 1, photo.height, pad + w - edge, pad, reach, h);
    alpha.drawImage(photo, 0, sy, photo.width, 1, pad, 0, w, reach);
    alpha.drawImage(photo, 0, photo.height - 1 - sy, photo.width, 1, pad, pad + h - edge, w, reach);
    for (const [px, py, dx, dy] of [[sx, sy, 0, 0], [photo.width - 1 - sx, sy, pad + w - edge, 0],
      [sx, photo.height - 1 - sy, 0, pad + h - edge], [photo.width - 1 - sx, photo.height - 1 - sy, pad + w - edge, pad + h - edge]]) {
      alpha.drawImage(photo, px, py, 1, 1, dx, dy, reach, reach);
    }
    eroded.globalCompositeOperation = 'source-over'; eroded.filter = 'none';
    eroded.clearRect(0, 0, width, height); eroded.drawImage(coverage, 0, 0);
    eroded.globalCompositeOperation = 'destination-in';
    for (const [dx, dy] of [[-inset, 0], [inset, 0], [0, -inset], [0, inset],
      [-diagonal, -diagonal], [diagonal, -diagonal], [-diagonal, diagonal], [diagonal, diagonal]]) {
      eroded.drawImage(coverage, dx, dy);
    }
    // Moving the mask inward first leaves almost no opacity at a sharp edge after the blur.
    alpha.clearRect(0, 0, width, height); alpha.filter = 'blur(4px)';
    alpha.drawImage(mask, 0, 0); alpha.filter = 'none';
    g.save(); g.globalCompositeOperation = 'destination-in';
    g.drawImage(coverage, pad, pad, w, h, 0, 0, w, h); g.restore();
  }

  private drawGeographicSource(g: CanvasRenderingContext2D, key: string, top: number, bounds: [number, number, number, number], url: (z: number, x: number, y: number) => string, priority: number) {
    const [west, east, south, north] = bounds;
    // A longitude grid narrows to nothing at a pole. Coarsen there instead of queuing a whole ring of tiny tiles.
    while (top > 0) {
      const degrees = 180 / 2 ** top;
      const columns = Math.floor((east + 180) / degrees) - Math.floor((west + 180) / degrees) + 1;
      const rows = Math.floor((90 - south) / degrees) - Math.floor((90 - north) / degrees) + 1;
      if (columns * rows <= 96) break;
      top--;
    }
    const first = Math.max(0, top - 2), loaded = new Map<string, ImageBitmap>();
    // Request only three useful levels, but keep any older, coarser parents already in memory.
    // A fast zoom then enlarges the same ground while sharper tiles arrive.
    for (let z = 0; z <= top; z++) {
      const rows = 2 ** z, cols = rows * 2, degrees = 180 / rows;
      const x0 = Math.floor((west + 180) / degrees), x1 = Math.floor((east + 180) / degrees);
      const y0 = Math.max(0, Math.floor((90 - north) / degrees)), y1 = Math.min(rows - 1, Math.floor((90 - south) / degrees));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const wrapped = ((x % cols) + cols) % cols;
        const tileKey = `${key}-${z}-${wrapped}-${y}`;
        const image = z < first ? mapImagery.get(tileKey) : this.picture(tileKey, [url(z, wrapped, y)], priority + z - first);
        if (image) this.photoKeys.add(tileKey);
        if (image) loaded.set(`${z}-${x}-${y}`, image);
      }
    }
    const rows = 2 ** top, degrees = 180 / rows;
    const x0 = Math.floor((west + 180) / degrees), x1 = Math.floor((east + 180) / degrees);
    const y0 = Math.max(0, Math.floor((90 - north) / degrees)), y1 = Math.min(rows - 1, Math.floor((90 - south) / degrees));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const leafBounds: [number, number, number, number] = [Math.max(west, x * degrees - 180), Math.min(east, (x + 1) * degrees - 180),
        Math.max(south, 90 - (y + 1) * degrees), Math.min(north, 90 - y * degrees)];
      const chain: { image: ImageBitmap; ax: number; ay: number; degrees: number; alpha: number }[] = [];
      for (let z = 0; z <= top; z++) {
        const factor = 2 ** (top - z), ax = Math.floor(x / factor), ay = Math.floor(y / factor), image = loaded.get(`${z}-${ax}-${ay}`);
        if (!image) continue;
        const wrapped = ((ax % (2 ** z * 2)) + (2 ** z * 2)) % (2 ** z * 2), alpha = this.tileFade(`${key}-${z}-${wrapped}-${ay}`);
        if (alpha >= 1) chain.length = 0;
        chain.push({ image, ax, ay, degrees: 180 / 2 ** z, alpha });
      }
      for (const piece of chain) {
        g.save(); g.globalAlpha *= piece.alpha;
        this.drawLonLatTile(g, piece.image, piece.ax * piece.degrees - 180, 90 - piece.ay * piece.degrees, piece.degrees, leafBounds);
        g.restore();
      }
    }
  }

  private drawLonLatTile(g: CanvasRenderingContext2D, image: ImageBitmap, west: number, north: number, degrees: number, bounds: [number, number, number, number]) {
    // Crop a large parent tile to the visible true region before warping it. Otherwise the
    // opposite side of the Moon can fold into the local tangent plane at the coarsest levels.
    const u0 = Math.max(0, (bounds[0] - west) / degrees), u2 = Math.min(1, (bounds[1] - west) / degrees);
    const v0 = Math.max(0, (north - bounds[3]) / degrees), v2 = Math.min(1, (north - bounds[2]) / degrees);
    const steps = degrees < 1 && Math.abs(this.anchor?.lat ?? 0) < 60 ? 1 : this.options.round ? 2 : 4;
    for (let j = 0; j < steps; j++) for (let i = 0; i < steps; i++) {
      const u = u0 + (u2 - u0) * i / steps, v = v0 + (v2 - v0) * j / steps;
      const u1 = u0 + (u2 - u0) * (i + 1) / steps, v1 = v0 + (v2 - v0) * (j + 1) / steps;
      const uv = [[u, v], [u1, v], [u1, v1], [u, v1]];
      const ll = uv.map(([a, b]): XY => [north - b * degrees, west + a * degrees]);
      const dest = ll.map(([lat, lon]) => { const xy = this.project(lat, lon); return this.screen(xy[0], xy[1]); });
      if (Math.max(...dest.map(p => p[0])) < -1 || Math.min(...dest.map(p => p[0])) > this.width + 1 || Math.max(...dest.map(p => p[1])) < -1 || Math.min(...dest.map(p => p[1])) > this.height + 1) continue;
      const src = uv.map(([a, b]): XY => [a * image.width, b * image.height]);
      this.drawSurfaceTriangle(g, image, [src[0], src[1], src[2]], [ll[0], ll[1], ll[2]]);
      this.drawSurfaceTriangle(g, image, [src[0], src[2], src[3]], [ll[0], ll[2], ll[3]]);
    }
  }

  /** Clip texture polygons at the real limb; reflecting a hidden triangle would show the far side. */
  private drawSurfaceTriangle(g: CanvasRenderingContext2D, image: ImageBitmap, source: [XY, XY, XY], places: [XY, XY, XY]) {
    if (!this.projection) return;
    type Vertex = { source: XY; place: XY; depth: number };
    let polygon: Vertex[] = places.map((place, i) => ({ source: source[i], place, depth: this.projection!.depth(place[0], place[1]) }));
    if (polygon.some(p => p.depth < 0)) {
      const clipped: Vertex[] = [];
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length];
        if (a.depth >= 0) clipped.push(a);
        if ((a.depth >= 0) === (b.depth >= 0)) continue;
        const t = a.depth / (a.depth - b.depth);
        const toUnit = (ll: XY): [number, number, number] => { const p = ll[0] * DEG, l = ll[1] * DEG, cp = Math.cos(p); return [cp * Math.cos(l), cp * Math.sin(l), Math.sin(p)]; };
        const u = toUnit(a.place), v = toUnit(b.place), mix = u.map((n, k) => n + (v[k] - n) * t), length = Math.hypot(...mix);
        const place: XY = [Math.asin(Math.max(-1, Math.min(1, mix[2] / length))) / DEG, Math.atan2(mix[1], mix[0]) / DEG];
        clipped.push({ source: [a.source[0] + (b.source[0] - a.source[0]) * t, a.source[1] + (b.source[1] - a.source[1]) * t], place, depth: 0 });
      }
      polygon = clipped;
    }
    if (polygon.length < 3) return;
    const screen = polygon.map(p => { const xy = this.project(p.place[0], p.place[1]); return this.screen(xy[0], xy[1]); });
    for (let i = 1; i < polygon.length - 1; i++) textureTriangle(g, image,
      [polygon[0].source, polygon[i].source, polygon[i + 1].source], [screen[0], screen[i], screen[i + 1]]);
  }

  /** A shared DISPLAY-grid pyramid: compact blocks and palettes are decoded by the globe's worker. */
  private drawScienceLayers(g:CanvasRenderingContext2D) {
    if(!this.basePlane||!this.projection)return;
    const enabled=this.layerDefs.length?this.layers:Object.fromEntries(this.overlays.map(id=>[id,true]));
    const byId=new Map(this.layerDefs.map(def=>[def.id,def]));
    const height=byId.get('height'),parts=height?scienceHeightParts(height):null;
    const order: {def:LayerDef;opacity:number}[]=[];
    const add=(def:LayerDef|undefined,id=def?.id)=>{if(def&&id&&enabled[id])order.push({def,opacity:this.opacity[id]??.7});};
    // This is the globe's order: global height first, then slope and sharper southern height.
    add(parts?.global,'height');add(byId.get('slope'));add(parts?.polar,'height');
    for(const id of ['psr','waterice','danger'])add(byId.get(id));
    if(!order.length)return;
    const visible=this.displayBounds();
    if(!visible)return;
    const tileLimit=Math.min(32,Math.max(4,Math.floor(64/order.length)));
    let level=Math.max(0,Math.min(9,Math.ceil(Math.log2(Math.PI*MAP_R/(256*this.across/(this.width*this.dpr))))));
    const range=(z:number)=>{const n=2**z;return {x0:Math.max(0,Math.floor(visible.u0*n*2)),x1:Math.min(n*2-1,Math.floor(visible.u1*n*2)),y0:Math.max(0,Math.floor(visible.v0*n)),y1:Math.min(n-1,Math.floor(visible.v1*n))};};
    while(level>0){const r=range(level);if((r.x1-r.x0+1)*(r.y1-r.y0+1)<=tileLimit)break;level--;}
    const leaves=range(level);
    const bounds=new Map<string,TileDraw>();
    for(let y=leaves.y0;y<=leaves.y1;y++)for(let x=leaves.x0;x<=leaves.x1;x++){
      const r=scienceTileRect(level,x,y),u=(r.west/TAU+.5),v=.5-r.north/Math.PI,uw=(r.east-r.west)/TAU,vh=(r.north-r.south)/Math.PI;
      bounds.set(`${x}/${y}`,{sample:[u,v,uw,vh],clip:[u,v,uw,vh],rect:this.displayRect(u,v,uw,vh)});
    }
    for(const layer of order){
      const loaded=new Map<string,ImageBitmap>();
      for(let z=0;z<=level;z++){
        const r=range(z);
        for(let y=r.y0;y<=r.y1;y++)for(let x=r.x0;x<=r.x1;x++){
          const key=mapImagery.scienceTileKey(layer.def,z,x,y);
          const image=(z===0||z>=level-1)?mapImagery.requestScienceTile(layer.def,z,x,y,40+z):mapImagery.get(key);
          if(image){this.photoKeys.add(key);loaded.set(`${z}/${x}/${y}`,image);}else if(z===0||z>=level-1)this.photoKeys.add(key);
        }
      }
      this.basePlane.beginBatch(this.width,this.height,this.dpr);
      for(let y=leaves.y0;y<=leaves.y1;y++)for(let x=leaves.x0;x<=leaves.x1;x++){
        const leaf=bounds.get(`${x}/${y}`)!;if(!leaf.rect.width||!leaf.rect.height)continue;
        for(let z=level;z>=0;z--){
          const factor=2**(level-z),ax=Math.floor(x/factor),ay=Math.floor(y/factor),image=loaded.get(`${z}/${ax}/${ay}`);
          if(!image||!this.basePlane.prepare(image))continue;
          const r=scienceTileRect(z,ax,ay),frame:TileDraw={sample:[r.west/TAU+.5,.5-r.north/Math.PI,(r.east-r.west)/TAU,(r.north-r.south)/Math.PI],clip:leaf.clip,rect:leaf.rect};
          this.basePlane.draw(image,this.projection,this.width,this.height,this.dpr,this.across,this.cx,this.cy,this.rotation,undefined,1,frame);break;
        }
      }
      this.basePlane.endBatch();g.save();g.globalAlpha=layer.opacity;g.drawImage(this.basePlane.canvas,0,0,this.width,this.height);g.restore();
    }
  }

  private displayBounds():{u0:number;u1:number;v0:number;v1:number}|null {
    const uv:XY[]=[];
    for(let j=0;j<=4;j++)for(let i=0;i<=4;i++){
      const xy=this.screenWorld(this.width*i/4,this.height*j/4),ll=this.unproject(xy[0],xy[1]);
      if(!Number.isFinite(ll[0]+ll[1]))continue;
      const p=ll[0]*DEG,l=ll[1]*DEG;
      uv.push([Math.atan2(-Math.sin(p),Math.cos(p)*Math.cos(l))/TAU+.5,.5-Math.asin(Math.max(-1,Math.min(1,Math.cos(p)*Math.sin(l))))/Math.PI]);
    }
    if(!uv.length)return null;
    let u0=Math.min(...uv.map(p=>p[0])),u1=Math.max(...uv.map(p=>p[0])),v0=Math.min(...uv.map(p=>p[1])),v1=Math.max(...uv.map(p=>p[1]));
    for(const lon of [-90,90]){const at=this.screenAt(0,lon);if(at&&at.x>=0&&at.x<=this.width&&at.y>=0&&at.y<=this.height){u0=0;u1=1;if(lon>0)v0=0;else v1=1;}}
    return {u0,u1,v0,v1};
  }

  private displayRect(u:number,v:number,uw:number,vh:number):{x:number;y:number;width:number;height:number} {
    const points:XY[]=[];
    for(let j=0;j<=4;j++)for(let i=0;i<=4;i++){
      const lon=(u+uw*i/4-.5)*TAU,lat=(.5-v-vh*j/4)*Math.PI;
      const p=this.project(Math.asin(Math.max(-1,Math.min(1,-Math.cos(lat)*Math.sin(lon))))/DEG,Math.atan2(Math.sin(lat),Math.cos(lat)*Math.cos(lon))/DEG);
      points.push(this.screen(p[0],p[1]));
    }
    // A geographic pole has every longitude. Sampling just the grid corners misses its
    // spread along the flat picture's edge and cuts little wedges out of the data there.
    for(const [poleU,lat] of [[.25,89.999999],[.75,-89.999999]])if(u<=poleU+1e-10&&u+uw>=poleU-1e-10&&v<=.5+1e-10&&v+vh>=.5-1e-10){
      for(let lon=-180;lon<=180;lon+=15){const p=this.project(lat,lon);points.push(this.screen(p[0],p[1]));}
    }
    const x=Math.max(0,Math.floor(Math.min(...points.map(p=>p[0]))-8)),right=Math.min(this.width,Math.ceil(Math.max(...points.map(p=>p[0]))+8));
    const y=Math.max(0,Math.floor(Math.min(...points.map(p=>p[1]))-8)),bottom=Math.min(this.height,Math.ceil(Math.max(...points.map(p=>p[1]))+8));
    return {x,y,width:Math.max(0,right-x),height:Math.max(0,bottom-y)};
  }

  private drawSunlight(g:CanvasRenderingContext2D) {
    if(!this.basePlane||!this.projection||!this.sun)return;
    if(this.options.round){
      // At this scale the terminator is almost straight. Keep it in the existing 2D canvas:
      // shrinking the photo's twice-wide GPU backing for a second mask stalls Retina frames.
      const dot=(x:number,y:number)=>{
        const xy=this.screenWorld(x,y),ll=this.unproject(xy[0],xy[1]),p=ll[0]*DEG,l=ll[1]*DEG;
        return (Math.cos(p)*Math.cos(l)*this.sun![0]+Math.cos(p)*Math.sin(l)*this.sun![1]+Math.sin(p)*this.sun![2])/(Math.hypot(...this.sun!)||1);
      };
      const middle=dot(this.width/2,this.height/2),dx=(dot(this.width,this.height/2)-dot(0,this.height/2))/this.width,dy=(dot(this.width/2,this.height)-dot(this.width/2,0))/this.height;
      const gradient=Math.hypot(dx,dy),shade=(value:number)=>{const t=Math.max(0,Math.min(1,(value+.052336)/.104672));return .78*(1-t*t*(3-2*t));};
      if(gradient<1e-10){g.fillStyle=`rgba(0,0,0,${shade(middle)})`;}
      else{
        const reach=Math.hypot(this.width,this.height)/2,ux=dx/gradient,uy=dy/gradient;
        const fill=g.createLinearGradient(this.width/2-ux*reach,this.height/2-uy*reach,this.width/2+ux*reach,this.height/2+uy*reach);
        for(let i=0;i<=16;i++)fill.addColorStop(i/16,`rgba(0,0,0,${shade(middle+(i/8-1)*reach*gradient)})`);
        g.fillStyle=fill;
      }
      g.fillRect(0,0,this.width,this.height);return;
    }
    const mask=this.basePlane.sunlight(this.projection,this.width,this.height,this.dpr,this.across,this.cx,this.cy,this.rotation,this.sun);
    g.drawImage(mask,0,0,this.width,this.height);
  }

  /**
   * Measured crater rims (the Craters switch), as on the overview: thin pale rings, the 400 biggest that look at
   * least 9 pixels across. This map had the switch but never drew anything for it. The choice among the
   * catalogue's 1.3 million craters is made again only when the view has moved or zoomed enough to change it;
   * in between, the same rings are simply put where their ground now is.
   */
  private drawCraters(g: CanvasRenderingContext2D) {
    if (!this.layers.craters || !this.projection) { this.craterPick = null; return; }
    const w = this.width, h = this.height, ppm = w / this.across, mid = this.unproject(this.cx, this.cy);
    if (!Number.isFinite(mid[0] + mid[1])) return;
    const minKm = Math.max(.03, CRATER_MIN_PX / ppm / 1000);
    const reach = Math.min(Math.PI, Math.hypot(this.across, this.across * h / w) / 2 / MAP_R * 1.25 + .01);
    const found = cratersNear(mid[0], mid[1], reach, minKm);
    const p = mid[0] * DEG, l = mid[1] * DEG, centre: [number, number, number] = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
    let pick = this.craterPick;
    if (!pick || pick.revision !== found.revision || Math.abs(Math.log(this.across / pick.across)) > .12
      || pick.centre[0] * centre[0] + pick.centre[1] * centre[1] + pick.centre[2] * centre[2] < Math.cos(.1 * this.across / MAP_R)) {
      // (a rim much wider than the card is only a stray arc across it)
      const largest = Math.max(w, h) * 1.3 / ppm / 1000, near = reach >= Math.PI / 2 ? -2 : Math.cos(reach);
      const all: number[] = [];
      // (each array has its biggest craters first, so the scan of one stops at the first that is too small)
      found.arrays.forEach((a, which) => {
        for (let i = 0; i < a.length; i += 3) {
          const km = a[i + 2];
          if (km < minKm) break;
          if (km > largest) continue;
          const cp = a[i] * DEG, cl = a[i + 1] * DEG, c = Math.cos(cp);
          if (c * Math.cos(cl) * centre[0] + c * Math.sin(cl) * centre[1] + Math.sin(cp) * centre[2] >= near) all.push(i, which);
        }
      });
      const order = Array.from({ length: all.length / 2 }, (_, k) => k).sort((x, y) => found.arrays[all[y * 2 + 1]][all[y * 2] + 2] - found.arrays[all[x * 2 + 1]][all[x * 2] + 2]).slice(0, CRATER_MAX);
      const rings = new Float32Array(order.length * 3);
      order.forEach((k, n) => { const a = found.arrays[all[k * 2 + 1]], i = all[k * 2]; rings[n * 3] = a[i]; rings[n * 3 + 1] = a[i + 1]; rings[n * 3 + 2] = a[i + 2]; });
      pick = this.craterPick = { rings, across: this.across, centre, revision: found.revision };
    }
    const lift = this.projection.offsetN(), longest = Math.max(w, h), rings = pick.rings;
    g.save(); g.strokeStyle = 'rgba(235,241,247,.7)'; g.lineWidth = 1.25;
    for (let i = 0; i < rings.length; i += 3) {
      const en = this.project(rings[i], rings[i + 1]), at = this.screen(en[0], en[1]), r = rings[i + 2] * 500 * ppm;
      // away from the middle line of this flat map everything is drawn wider, a round rim included
      const wide = r / Math.max(.08, Math.cos((en[1] + lift) / MAP_R));
      if (at[0] + wide < 0 || at[0] - wide > w || at[1] + r < 0 || at[1] - r > h) continue;
      const alpha = craterSizeOpacity(2 * r, longest);
      if (alpha <= 0) continue;
      g.globalAlpha = alpha; g.beginPath(); g.ellipse(at[0], at[1], wide, r, 0, 0, TAU); g.stroke();
    }
    g.restore();
    if (found.pending) this.fading = true; // more of the catalogue is on its way: look again next frame
  }

  /**
   * Official place names, behaving as on the overview: a name appears once its feature looks big enough on the
   * card, the bigger and more important features first, seas in spaced capitals, never one name over another,
   * and names fade in and out instead of popping. Because the map repeats sideways, so do the names.
   */
  private drawNames(g: CanvasRenderingContext2D) {
    const names = this.names, units = this.nameUnits;
    const now = performance.now(), dt = Math.min(.1, Math.max(0, (now - this.nameClock) / 1000));
    this.nameClock = now;
    for (const entry of this.nameShown.values()) entry.on = false;
    const w = this.width, h = this.height;
    if (names && units && this.projection && this.layers.names !== false) {
      const ppm = w / this.across, smallest = NAME_MIN_PX / ppm, largest = Math.max(w, h) * 2.2 / ppm;
      // Only names within sight of the middle of the card are worth placing: one multiplication each rules out the rest.
      const mid = this.unproject(this.cx, this.cy), reach = Math.hypot(this.across, this.across * h / w) / 2 / MAP_R * 1.3;
      const p = mid[0] * DEG, l = mid[1] * DEG, ux = Math.cos(p) * Math.cos(l), uy = Math.cos(p) * Math.sin(l), uz = Math.sin(p);
      const near = !Number.isFinite(ux + uy + uz) || reach >= Math.PI / 2 ? -2 : Math.cos(reach);
      const found: { i: number; x: number; y: number; score: number }[] = [];
      for (let i = 0; i < names.length; i++) {
        const size = names[i].diameterKm * 1000;
        if (size < smallest || size > largest) continue;
        if (units[i * 3] * ux + units[i * 3 + 1] * uy + units[i * 3 + 2] * uz < near) continue;
        const at = this.screenAt(names[i].lat, names[i].lon);
        if (!at || at.x < 0 || at.x > w || at.y < 0 || at.y > h) continue;
        // (a name already on screen gets a small bonus, so a little movement does not swap it for its neighbour)
        const weight = (NAME_WEIGHT[names[i].kind] ?? .8) * (names[i].satellite ? .5 : 1) * (this.nameShown.has(i) ? 1.25 : 1);
        found.push({ i, x: at.x, y: at.y, score: size * weight });
      }
      found.sort((a, b) => b.score - a.score || a.i - b.i);
      // the rover, the destination and the other markers keep the ground under them clear of words
      const taken = this.keepClear.map(b => [b[0], b[1], b[2], b[3]] as [number, number, number, number]);
      const keepClear = (lat: number, lon: number, r: number) => { const at = this.screenAt(lat, lon); if (at) taken.push([at.x - r, at.y - r, at.x + r, at.y + r]); };
      if (roverLink.pose.on) keepClear(roverLink.pose.lat, roverLink.pose.lon, 22);
      if (this.destination) keepClear(this.destination.lat, this.destination.lon, 16);
      for (const wp of roverLink.waypoints) if (wp.kind !== 'next') keepClear(wp.lat, wp.lon, 14);
      const most = Math.round(Math.min(48, Math.max(10, w * h / 26000)));
      let placed = 0;
      for (const f of found) {
        if (placed >= most) break;
        const style = nameStyle(names[f.i]), half = this.nameWidth(g, style) / 2 + 5, tall = style.size / 2 + 4;
        const box: [number, number, number, number] = [f.x - half, f.y - tall, f.x + half, f.y + tall];
        if (box[0] < 4 || box[2] > w - 4 || box[1] < 4 || box[3] > h - 4) continue;
        if (taken.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
        taken.push(box); placed++;
        const entry = this.nameShown.get(f.i);
        if (entry) { entry.on = true; entry.x = f.x; entry.y = f.y; } else this.nameShown.set(f.i, { alpha: 0, on: true, x: f.x, y: f.y });
      }
    }
    if (!this.nameShown.size) return;
    const step = this.reducedMotion ? 1 : dt / .18, spaced = g as unknown as { letterSpacing: string };
    g.save(); g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    for (const [i, entry] of this.nameShown) {
      const name = names?.[i];
      entry.alpha = Math.max(0, Math.min(1, entry.alpha + (entry.on ? step : -step)));
      if (!name || (!entry.on && entry.alpha <= 0)) { this.nameShown.delete(i); continue; }
      if (!entry.on) {
        // a name on its way out still rides on its own ground
        const at = this.screenAt(name.lat, name.lon);
        if (!at) { this.nameShown.delete(i); continue; }
        entry.x = at.x; entry.y = at.y;
      }
      if (entry.alpha < 1 || !entry.on) this.fading = true;
      const style = nameStyle(name);
      g.font = style.font; spaced.letterSpacing = style.spacing; g.globalAlpha = entry.alpha;
      g.lineWidth = 3.4; g.strokeStyle = 'rgba(5,7,11,.7)'; g.strokeText(style.text, entry.x, entry.y + .5);
      g.fillStyle = style.colour; g.fillText(style.text, entry.x, entry.y + .5);
    }
    spaced.letterSpacing = '0px'; g.restore();
  }

  private nameWidth(g: CanvasRenderingContext2D, style: NameStyle) {
    let width = this.nameWidths.get(style.text + style.font);
    if (width === undefined) {
      const spaced = g as unknown as { letterSpacing: string };
      g.save(); g.font = style.font; spaced.letterSpacing = style.spacing;
      width = g.measureText(style.text).width; spaced.letterSpacing = '0px'; g.restore();
      // Before the app's own typeface has arrived the widths belong to the stand-in font: do not keep those.
      if (document.fonts?.check?.(style.font) !== false) this.nameWidths.set(style.text + style.font, width);
    }
    return width;
  }

  private drawRocks(g: CanvasRenderingContext2D) {
    if (!this.options.round || this.across > 160 || !this.anchor) return;
    const ppm = this.width / this.across;
    g.fillStyle = 'rgba(13,19,23,.7)';
    for (const rock of roverLink.rocks()) {
      const ll = this.anchor.toLatLon(rock.e, rock.n), xy = this.project(ll[0], ll[1]), p = this.screen(xy[0], xy[1]);
      if (p[0] < -3 || p[0] > this.width + 3 || p[1] < -3 || p[1] > this.height + 3) continue;
      g.beginPath(); g.arc(p[0], p[1], Math.max(.65, rock.d * ppm / 2), 0, TAU); g.fill();
    }
  }

  private drawLine(g: CanvasRenderingContext2D, xy: number[], colour: string, trail: boolean) {
    if (xy.length < 2) return;
    const breaks = trail ? new Set(roverLink.breaks) : null;
    g.beginPath();
    let pen = false, lastX = 0;
    const values = trail ? roverLink.trail : this.route?.path, stride = trail ? 3 : 2;
    for (let i = 0; i < xy.length; i += 2) {
      const index = i / 2;
      if (!this.options.round && values && !this.projection?.visible(values[index * stride], values[index * stride + 1])) { pen = false; continue; }
      const p = this.screen(xy[i], xy[i + 1]);
      // (half a turn apart on screen means the two ends are on different copies of the map)
      if (pen && !this.options.round && Math.abs(p[0] - lastX) > WORLD * this.width / this.across / 2) pen = false;
      if (!pen || breaks?.has(index)) g.moveTo(p[0], p[1]); else g.lineTo(p[0], p[1]);
      pen = true; lastX = p[0];
    }
    if (trail && roverLink.pose.on && (this.options.round || this.projection?.visible(roverLink.pose.lat, roverLink.pose.lon))) {
      const en = this.project(roverLink.pose.lat, roverLink.pose.lon), p = this.screen(en[0], en[1]); g.lineTo(p[0], p[1]);
    }
    g.lineJoin = 'round'; g.lineCap = 'round'; g.strokeStyle = 'rgba(6,16,21,.78)'; g.lineWidth = trail ? 4.5 : 5; g.stroke();
    g.strokeStyle = colour; g.lineWidth = trail ? 2.3 : 2.6; g.stroke();
    if (trail && this.options.round) this.drawRecentTrail(g, xy);
  }

  /** Keep the last thirty metres readable even at the wider opening scale. */
  private drawRecentTrail(g: CanvasRenderingContext2D, xy: number[]) {
    if (!roverLink.pose.on || xy.length < 2) return;
    const pose = this.project(roverLink.pose.lat, roverLink.pose.lon), n = xy.length / 2;
    if (Math.hypot(pose[0] - xy[xy.length - 2], pose[1] - xy[xy.length - 1]) > 5) return;
    const breaks = new Set(roverLink.breaks);
    const points: XY[] = [pose];
    let run = 0;
    for (let i = n - 1; i >= 0; i--) {
      if (i < n - 1 && breaks.has(i + 1)) break;
      const last = points[points.length - 1], next: XY = [xy[i * 2], xy[i * 2 + 1]];
      const distance = Math.hypot(next[0] - last[0], next[1] - last[1]);
      if (run + distance > 30) {
        const share = (30 - run) / Math.max(.0001, distance);
        points.push([last[0] + (next[0] - last[0]) * share, last[1] + (next[1] - last[1]) * share]); break;
      }
      points.push(next); run += distance;
    }
    g.save(); g.beginPath();
    points.forEach((point, i) => { const p = this.screen(point[0], point[1]); if (i === 0) g.moveTo(p[0], p[1]); else g.lineTo(p[0], p[1]); });
    g.lineJoin = 'round'; g.lineCap = 'round'; g.lineWidth = 3.2; g.strokeStyle = TRAIL;
    g.shadowColor = 'rgba(255,195,116,.65)'; g.shadowBlur = 7; g.stroke(); g.restore();
  }

  private drawWaypoints(g: CanvasRenderingContext2D) {
    const all = this.destination ? [...roverLink.waypoints.filter(wp => wp.kind !== 'dest'), { id: 'map-destination', kind: 'dest' as const, label: '', ...this.destination }] : roverLink.waypoints;
    for (const wp of all) {
      if (wp.kind === 'next') continue;
      const point = this.screenAt(wp.lat, wp.lon);
      if (!point) continue;
      const p: XY = [point.x, point.y];
      let x = p[0], y = p[1], edge = false;
      if (this.options.round) {
        const dx = x - this.width / 2, dy = y - this.height / 2, reach = Math.min(this.width, this.height) / 2 - 14, d = Math.hypot(dx, dy);
        if (d > reach) { x = this.width / 2 + dx / d * reach; y = this.height / 2 + dy / d * reach; edge = true; }
      } else if (x < -20 || y < -20 || x > this.width + 20 || y > this.height + 20) continue;
      drawWaypoint(g, wp, x, y, edge ? Math.atan2(p[1] - this.height / 2, p[0] - this.width / 2) : undefined);
    }
  }

  private drawRover(g: CanvasRenderingContext2D) {
    const p = roverLink.pose;
    if (!p.on) return;
    const point = this.screenAt(p.lat, p.lon);
    if (!point) return;
    g.save(); g.translate(point.x, point.y);
    const cam = this.mapBearing(this.cameraDeg) * DEG + this.rotation;
    g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, 49, cam - Math.PI / 2 - .44, cam - Math.PI / 2 + .44); g.closePath();
    const wedge = g.createRadialGradient(0, 0, 4, 0, 0, 49); wedge.addColorStop(0, 'rgba(214,243,249,.30)'); wedge.addColorStop(1, 'rgba(214,243,249,0)');
    g.fillStyle = wedge; g.fill();
    g.rotate(this.mapBearing(this.roverDeg) * DEG + this.rotation);
    g.beginPath(); g.moveTo(0, -10); g.lineTo(7.2, 8); g.lineTo(0, 4.8); g.lineTo(-7.2, 8); g.closePath();
    g.strokeStyle = '#102630'; g.lineWidth = 4.5; g.lineJoin = 'round'; g.stroke(); g.fillStyle = '#f5fcfd'; g.fill();
    g.restore();
  }

  private drawRing(g: CanvasRenderingContext2D) {
    const x = this.width / 2, y = this.height / 2, r = Math.min(x, y) - 2;
    g.strokeStyle = 'rgba(232,243,245,.72)'; g.lineWidth = 1; g.beginPath(); g.arc(x, y, r, 0, TAU); g.stroke();
    for (let degrees = 0; degrees < 360; degrees += 30) {
      const a = degrees * DEG - Math.PI / 2 + this.rotation;
      g.beginPath(); g.moveTo(x + Math.cos(a) * (r - 3), y + Math.sin(a) * (r - 3)); g.lineTo(x + Math.cos(a) * (r - 7), y + Math.sin(a) * (r - 7));
      g.strokeStyle = 'rgba(244,250,251,.75)'; g.stroke();
    }
    const a = -Math.PI / 2 + this.rotation, nr = r - 12, nx = x + Math.cos(a) * nr, ny = y + Math.sin(a) * nr;
    g.beginPath(); g.arc(nx, ny, 9, 0, TAU); g.fillStyle = 'rgba(12,22,28,.84)'; g.fill();
    g.font = `650 11px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#ff887d'; g.fillText('N', nx, ny + .5);
  }


}

/** A rim must look at least this wide to be drawn, and at most this many are drawn (the overview's numbers: moon/craterLayer.ts). */
const CRATER_MIN_PX = 9, CRATER_MAX = 400;
/** A feature must look at least this wide on the card before it gets its name (the overview uses 30). */
const NAME_MIN_PX = 26;
/** How much each kind of feature counts when two names want the same room (the same order as the overview: moon/labels.ts). */
const NAME_WEIGHT: Record<string, number> = {
  'Dark plain (sea)': 2.4, Ocean: 2.6, 'Dark plain (marsh)': 2.0, Bay: 2.0, 'Small dark plain': 1.6,
  Mountain: 1.5, Crater: 1.0, 'Small crater': 0.45,
};
interface NameStyle { text: string; font: string; spacing: string; colour: string; size: number }
/** Seas are written in widely spaced capitals, like on a printed map; lettered side craters a little quieter. */
function nameStyle(name: MoonName): NameStyle {
  if (/^(Dark plain|Ocean|Bay|Small dark plain)/.test(name.kind)) return { text: name.name.toUpperCase(), font: `600 11px ${FONT}`, spacing: '1.7px', colour: 'rgba(233,238,244,.94)', size: 11 };
  if (name.satellite || name.kind === 'Small crater') return { text: name.name, font: `500 11.5px ${FONT}`, spacing: '0px', colour: 'rgba(226,231,236,.86)', size: 11.5 };
  return { text: name.name, font: `500 12.5px ${FONT}`, spacing: '0px', colour: '#f3f5f7', size: 12.5 };
}

function drawWaypoint(g: CanvasRenderingContext2D, wp: Waypoint, x: number, y: number, direction?: number) {
  const colour = wp.color ?? (wp.kind === 'dest' ? ROUTE : '#e9dcc7');
  if (direction !== undefined) {
    g.save(); g.translate(x, y); g.rotate(direction); g.beginPath(); g.moveTo(12, 0); g.lineTo(8, -3); g.lineTo(8, 3); g.closePath(); g.fillStyle = colour; g.fill(); g.restore();
  }
  g.beginPath(); g.arc(x, y, wp.kind === 'pin' ? 10 : 9, 0, TAU); g.fillStyle = 'rgba(9,21,28,.84)'; g.fill(); g.strokeStyle = colour; g.lineWidth = 1.5; g.stroke();
  if (wp.letter) { g.font = `650 11px ${FONT}`; g.fillStyle = '#f5f9fb'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(wp.letter, x, y + .5); }
  else if (wp.kind === 'dest') {
    g.strokeStyle = '#e3f8fb'; g.lineWidth = 1.3; g.beginPath(); g.moveTo(x - 2, y + 4); g.lineTo(x - 2, y - 5); g.stroke();
    g.beginPath(); g.moveTo(x - 1, y - 5); g.lineTo(x + 5, y - 3); g.lineTo(x - 1, y); g.closePath(); g.fillStyle = ROUTE; g.fill();
  } else {
    g.fillStyle = colour; g.beginPath(); g.moveTo(x, y - 4); g.lineTo(x + 4, y); g.lineTo(x, y + 4); g.lineTo(x - 4, y); g.closePath(); g.fill();
  }
}

/** Map one texture triangle onto the canvas, clipping before the affine image transform. */
function textureTriangle(g: CanvasRenderingContext2D, image: ImageBitmap, s: [XY, XY, XY], d: [XY, XY, XY]) {
  const sx1 = s[1][0] - s[0][0], sy1 = s[1][1] - s[0][1], sx2 = s[2][0] - s[0][0], sy2 = s[2][1] - s[0][1];
  const det = sx1 * sy2 - sx2 * sy1;
  if (![...s.flat(), ...d.flat()].every(Number.isFinite)) return;
  if (Math.abs(det) < 1e-10) return;
  const dx1 = d[1][0] - d[0][0], dy1 = d[1][1] - d[0][1], dx2 = d[2][0] - d[0][0], dy2 = d[2][1] - d[0][1];
  const a = (dx1 * sy2 - dx2 * sy1) / det, b = (dy1 * sy2 - dy2 * sy1) / det;
  const c = (dx2 * sx1 - dx1 * sx2) / det, e = (dy2 * sx1 - dy1 * sx2) / det;
  // A subpixel overlap keeps canvas antialiasing from leaving hairlines between mesh triangles.
  const mid: XY = [(d[0][0] + d[1][0] + d[2][0]) / 3, (d[0][1] + d[1][1] + d[2][1]) / 3];
  const clip = d.map(([x, y]): XY => { const length = Math.hypot(x - mid[0], y - mid[1]); return [x + (x - mid[0]) / Math.max(1, length) * .6, y + (y - mid[1]) / Math.max(1, length) * .6]; });
  g.save(); g.beginPath(); g.moveTo(clip[0][0], clip[0][1]); g.lineTo(clip[1][0], clip[1][1]); g.lineTo(clip[2][0], clip[2][1]); g.closePath(); g.clip();
  g.transform(a, b, c, e, d[0][0] - a * s[0][0] - c * s[0][1], d[0][1] - b * s[0][0] - e * s[0][1]);
  const x0 = Math.max(0, Math.floor(Math.min(...s.map(p => p[0]))) - 1), y0 = Math.max(0, Math.floor(Math.min(...s.map(p => p[1]))) - 1);
  const x1 = Math.min(image.width, Math.ceil(Math.max(...s.map(p => p[0]))) + 1), y1 = Math.min(image.height, Math.ceil(Math.max(...s.map(p => p[1]))) + 1);
  if (x1 > x0 && y1 > y0) g.drawImage(image, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  g.restore();
}

const wrapBearing = (d: number) => ((d % 360) + 360) % 360;
const angleGap = (to: number, from: number) => ((to - from + 540) % 360) - 180;

interface BaseTile { x:number;y:number;width:number;height:number;bitmap:ImageBitmap|null;pending:boolean }
interface TileDraw { sample:[number,number,number,number];clip:[number,number,number,number];rect:{x:number;y:number;width:number;height:number} }
interface PlaneTexture { texture: WebGLTexture; ready: boolean; row: number; raf: number; disposed: boolean; cropping: boolean; readyAt: number }

/** A single GPU photo plane. The inverse is just a rotated geographic grid, never a CPU tile warp. */
class BasePlane {
  readonly canvas = document.createElement('canvas');
  rect = { x:0,y:0,width:0,height:0 };
  private readonly gl: WebGL2RenderingContext;
  private readonly maxTextureSize: number;
  private readonly program: WebGLProgram;
  private readonly vertices: WebGLBuffer;
  private readonly vertexCount: number;
  private readonly vao: WebGLVertexArrayObject;
  private readonly textures = new Map<ImageBitmap, PlaneTexture>();
  private maxSmallUploadMs = 0;
  private disposed = false;
  private batching = false;
  private uploadBytesLeft = 4194304;
  private readonly baseTiles=new Map<string,BaseTile>();
  private tilePending=0;
  private baseRegionReady=false;
  tiledFading=false;
  private readonly warmTexture: WebGLTexture;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();
  private readonly invalidate: () => void;
  private readonly offContextLoss: () => void;
  /** The browser took this context back (phones do under memory pressure): MapEngine drops this plane. */
  lost = false;

  constructor(invalidate: () => void) {
    this.invalidate = invalidate;
    const gl = this.canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('Map photo acceleration unavailable');
    this.gl = gl;
    // (if the phone takes this context back, the map draws on with its plain canvas path: see MapEngine.draw)
    this.offContextLoss = watchGraphicsContext(this.canvas, () => { this.lost = true; invalidate(); return true; });
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const program = gl.createProgram()!;
    for (const [type, source] of [[gl.VERTEX_SHADER, `#version 300 es
      in vec2 p;
      uniform vec3 up,east,north,sun;
      out float sunDot;
      uniform vec4 view,frame;
      uniform vec2 size;
      out vec3 sourceVector;
      out vec2 mapAngles;
      const float R=1737400.0;
      void main() {
        vec2 pixel=vec2(p.x,-p.y)*size*0.5;
        float c=cos(frame.z),s=sin(frame.z),ppm=size.x/view.x;
        vec2 world=frame.xy+vec2(pixel.x*c+pixel.y*s,pixel.x*s-pixel.y*c)/ppm;
        float lon=world.x/R,lat=(world.y+view.z)/R;
        mapAngles=vec2(lon,lat);
        sourceVector=up*(cos(lat)*cos(lon))+east*(cos(lat)*sin(lon))+north*sin(lat);
        sunDot=dot(sourceVector,sun);
        gl_Position=vec4(p,0.0,1.0);
      }`], [gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      uniform sampler2D photo;
      uniform vec4 frame;
      in vec3 sourceVector;
      in float sunDot;
      in vec2 mapAngles;
      uniform vec4 tile, crop;
      uniform vec4 sourceWindow,clipWindow;
      uniform float opacity;
      out vec4 colour;
      const float R=1737400.0, PI=3.141592653589793;
      void main() {
        // (no limit east or west: the cosines repeat by themselves, which is the map repeating sideways)
        if(abs(mapAngles.y)>PI*0.5) { colour=vec4(0.0); return; }
        if(frame.w>1.5){float night=.78*(1.0-smoothstep(-0.052336,0.052336,sunDot));colour=vec4(0.0,0.0,0.0,night);return;}
        vec3 n=normalize(sourceVector);
        vec2 uv;
        if(frame.w>0.5) {
          float radial=length(n.xy), rho=2.0*R*sqrt(max(0.0,(1.0+n.z)/max(1e-12,1.0-n.z)));
          vec2 polar=rho*vec2(n.y,n.x)/max(1e-12,radial);
          vec2 at=vec2(polar.x-tile.x,tile.y-polar.y)/tile.z;
          if(any(lessThan(at,vec2(0.0))) || any(greaterThan(at,vec2(1.0)))) { colour=vec4(0.0); return; }
          uv=crop.xy+at*crop.zw;
        } else uv=vec2(atan(-n.z,n.x)/(2.0*PI)+0.5,0.5-asin(clamp(n.y,-1.0,1.0))/PI);
        if(any(lessThan(uv,clipWindow.xy))||any(greaterThanEqual(uv,clipWindow.xy+clipWindow.zw)))discard;
        vec4 sampleColour=texture(photo,(uv-sourceWindow.xy)/sourceWindow.zw);
        colour=vec4(sampleColour.rgb*sampleColour.a*opacity,sampleColour.a*opacity);
      }`]] as const) {
      const shader=gl.createShader(type)!; gl.shaderSource(shader,source); gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)??'Map photo shader');
      gl.attachShader(program,shader); gl.deleteShader(shader);
    }
    gl.bindAttribLocation(program,0,'p'); gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program)??'Map photo shader');
    this.program=program;
    for(const name of ['photo','up','east','north','sun','view','frame','size','tile','crop','opacity','sourceWindow','clipWindow']) this.uniforms.set(name,gl.getUniformLocation(program,name));
    this.vertices=gl.createBuffer()!; this.vao=gl.createVertexArray()!; this.warmTexture=gl.createTexture()!;
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER,this.vertices);
    // Unit-vector interpolation keeps the photo continuous at its texture poles and seam.
    // Only these few vertices do the geographic trigonometry, instead of every Retina pixel.
    const mesh:number[]=[];
    for(let y=0;y<24;y++)for(let x=0;x<32;x++){
      const a=x/16-1,b=(x+1)/16-1,c=y/12-1,d=(y+1)/12-1;
      mesh.push(a,c,b,c,b,d,a,c,b,d,a,d);
    }
    this.vertexCount=mesh.length/2;
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(mesh),gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    gl.bindTexture(gl.TEXTURE_2D,this.warmTexture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    // Compile the driver pipeline during setup, before the first wheel gesture.
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([53,57,58,255]));
    gl.useProgram(program); gl.uniform1i(this.uniforms.get('photo')!,0);
    gl.uniform4f(this.uniforms.get('view')!,1000,1,0,0); gl.uniform2f(this.uniforms.get('size')!,1,1);
    gl.drawArrays(gl.TRIANGLES,0,this.vertexCount); gl.finish();
  }

  draw(image: ImageBitmap,projection: FlatMapProjection,width: number,height: number,dpr: number,across: number,cx: number,cy: number,rotation: number, polar?: { x: number; y: number; span: number; crop: [number, number, number, number] }, opacity=1, tileDraw?:TileDraw) {
    dpr=this.pixelRatio(width,height,dpr);
    if(image.width>Math.min(4096,this.maxTextureSize)&&!polar&&!tileDraw)return this.drawTiledBase(image,projection,width,height,dpr,across,cx,cy,rotation);
    const gl=this.gl,pixelWidth=Math.round(width*dpr),pixelHeight=Math.round(height*dpr);
    if(this.canvas.width!==pixelWidth || this.canvas.height!==pixelHeight) { this.canvas.width=pixelWidth; this.canvas.height=pixelHeight; }
    gl.viewport(0,0,pixelWidth,pixelHeight);
    if(!this.batching){gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);}
    gl.useProgram(this.program); gl.bindVertexArray(this.vao); gl.activeTexture(gl.TEXTURE0);
    if(!this.prepare(image,!!polar)) return null;
    gl.bindTexture(gl.TEXTURE_2D,this.textures.get(image)!.texture);
    const loc=(name:string)=>this.uniforms.get(name)!,basis=projection.basis();
    gl.uniform3fv(loc('up'),basis.up); gl.uniform3fv(loc('east'),basis.east); gl.uniform3fv(loc('north'),basis.north);
    gl.uniform4f(loc('view'),across,dpr,projection.offsetN(),0);
    gl.uniform4fv(loc('sourceWindow'),tileDraw?.sample??[0,0,1,1]);gl.uniform4fv(loc('clipWindow'),tileDraw?.clip??[0,0,1.000001,1.000001]);
    gl.uniform4f(loc('frame'),cx,cy,rotation,polar?1:0);gl.uniform1f(loc('opacity'),opacity);gl.uniform2f(loc('size'),width,height);
    if(polar) {
      gl.uniform4f(loc('tile'),polar.x,polar.y,polar.span,0);
      gl.uniform4f(loc('crop'),polar.crop[0]/image.width,polar.crop[1]/image.height,polar.crop[2]/image.width,polar.crop[3]/image.height);
    }
    let rect=tileDraw?.rect??{x:0,y:0,width,height};
    if(polar) {
      const points:XY[]=[],ppm=width/across,c=Math.cos(rotation),s=Math.sin(rotation);
      for(let j=0;j<=4;j++)for(let i=0;i<=4;i++){
        const ll=polarLatLon(polar.x+polar.span*i/4,polar.y-polar.span*j/4),p=projection.project(ll[0],ll[1]);
        const x=wrapWorld(p[0]-cx)*ppm,y=-(p[1]-cy)*ppm;
        points.push([width/2+x*c-y*s,height/2+x*s+y*c]);
      }
      let x0=Math.max(0,Math.floor(Math.min(...points.map(p=>p[0]))-4)),x1=Math.min(width,Math.ceil(Math.max(...points.map(p=>p[0]))+4));
      let y0=Math.max(0,Math.floor(Math.min(...points.map(p=>p[1]))-4)),y1=Math.min(height,Math.ceil(Math.max(...points.map(p=>p[1]))+4));
      // A cylindrical pole is a complete edge, rather than one longitude. Include that edge
      // when a polar square contains it, including while the geographic grid is unfolding.
      const north=projection.basis().north;
      for(const sign of [-1,1]) {
        const ll:XY=[Math.asin(Math.max(-1,Math.min(1,sign*north[2])))/DEG,Math.atan2(sign*north[1],sign*north[0])/DEG];
        const at=polarXY(ll[0],ll[1]);
        if(at[0]<polar.x||at[0]>polar.x+polar.span||at[1]>polar.y||at[1]<polar.y-polar.span)continue;
        x0=0;x1=width;
        const edge=height/2-(sign*MAP_R*Math.PI/2-projection.offsetN()-cy)*ppm;
        if(sign<0)y1=Math.min(height,Math.max(y1,Math.ceil(edge+4)));
        else y0=Math.max(0,Math.min(y0,Math.floor(edge-4)));
      }
      rect={x:x0,y:y0,width:Math.max(0,x1-x0),height:Math.max(0,y1-y0)};
      gl.enable(gl.SCISSOR_TEST);gl.scissor(Math.floor(x0*dpr),Math.floor((height-y1)*dpr),Math.ceil(rect.width*dpr),Math.ceil(rect.height*dpr));
    }
    if(tileDraw){gl.enable(gl.SCISSOR_TEST);gl.scissor(Math.floor(rect.x*dpr),Math.floor((height-rect.y-rect.height)*dpr),Math.ceil(rect.width*dpr),Math.ceil(rect.height*dpr));}
    this.rect=rect;
    if(rect.width>0&&rect.height>0)gl.drawArrays(gl.TRIANGLES,0,this.vertexCount);
    gl.disable(gl.SCISSOR_TEST);return this.canvas;
  }

  sunlight(projection:FlatMapProjection,width:number,height:number,dpr:number,across:number,cx:number,cy:number,rotation:number,sun:Vec3) {
    dpr=this.pixelRatio(width,height,dpr);
    const gl=this.gl,w=Math.round(width*dpr),h=Math.round(height*dpr);
    if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
    gl.disable(gl.SCISSOR_TEST);gl.disable(gl.BLEND);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(0,0,w,h);gl.useProgram(this.program);gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.warmTexture);
    const loc=(name:string)=>this.uniforms.get(name)!,basis=projection.basis(),length=Math.hypot(...sun)||1;
    gl.uniform3fv(loc('up'),basis.up);gl.uniform3fv(loc('east'),basis.east);gl.uniform3fv(loc('north'),basis.north);
    gl.uniform3f(loc('sun'),sun[0]/length,sun[1]/length,sun[2]/length);
    gl.uniform4f(loc('view'),across,dpr,projection.offsetN(),0);gl.uniform4f(loc('frame'),cx,cy,rotation,2);gl.uniform2f(loc('size'),width,height);
    gl.drawArrays(gl.TRIANGLES,0,this.vertexCount);return this.canvas;
  }

  private drawTiledBase(image:ImageBitmap,projection:FlatMapProjection,width:number,height:number,dpr:number,across:number,cx:number,cy:number,rotation:number):HTMLCanvasElement|null {
    const ppm=width/across,c=Math.cos(rotation),s=Math.sin(rotation),uv:XY[]=[];
    const screen=(lat:number,lon:number):XY=>{const p=projection.project(lat,lon),x=wrapWorld(p[0]-cx)*ppm,y=-(p[1]-cy)*ppm;return [width/2+x*c-y*s,height/2+x*s+y*c];};
    for(let j=0;j<=4;j++)for(let i=0;i<=4;i++){
      const x=width*(i/4-.5),y=height*(j/4-.5),ll=projection.unproject(cx+(x*c+y*s)/ppm,cy+(x*s-y*c)/ppm);
      if(!Number.isFinite(ll[0]+ll[1]))continue;
      const p=ll[0]*DEG,l=ll[1]*DEG;
      uv.push([Math.atan2(-Math.sin(p),Math.cos(p)*Math.cos(l))/TAU+.5,.5-Math.asin(Math.max(-1,Math.min(1,Math.cos(p)*Math.sin(l))))/Math.PI]);
    }
    if(!uv.length)return null;
    let u0=Math.min(...uv.map(p=>p[0])),u1=Math.max(...uv.map(p=>p[0]));
    let v0=Math.min(...uv.map(p=>p[1])),v1=Math.max(...uv.map(p=>p[1]));
    for(const lon of [-90,90]){const at=screen(0,lon);if(at[0]>=0&&at[0]<=width&&at[1]>=0&&at[1]<=height){u0=0;u1=1;if(lon>0)v0=0;else v1=1;}}
    const size=512,x0=Math.max(0,Math.floor(u0*image.width/size)),x1=Math.min(image.width/size-1,Math.floor(u1*image.width/size));
    const y0=Math.max(0,Math.floor(v0*image.height/size)),y1=Math.min(image.height/size-1,Math.floor(v1*image.height/size));
    this.beginBatch(width,height,dpr);this.tiledFading=false;
    let drew=false,complete=true;
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
      const points:XY[]=[];
      for(let j=0;j<=4;j++)for(let i=0;i<=4;i++){
        const lon=((x+i/4)*size/image.width-.5)*TAU,lat=(.5-(y+j/4)*size/image.height)*Math.PI;
        points.push(screen(Math.asin(Math.max(-1,Math.min(1,-Math.cos(lat)*Math.sin(lon))))/DEG,Math.atan2(Math.sin(lat),Math.cos(lat)*Math.cos(lon))/DEG));
      }
      const left=Math.max(0,Math.floor(Math.min(...points.map(p=>p[0]))-4)),right=Math.min(width,Math.ceil(Math.max(...points.map(p=>p[0]))+4));
      const top=Math.max(0,Math.floor(Math.min(...points.map(p=>p[1]))-4)),bottom=Math.min(height,Math.ceil(Math.max(...points.map(p=>p[1]))+4));
      if(right<=left||bottom<=top)continue;
      const key=`${x}-${y}`;
      let tile=this.baseTiles.get(key);
      if(!tile){tile={x:Math.max(0,x*size-1),y:Math.max(0,y*size-1),width:0,height:0,bitmap:null,pending:false};tile.width=Math.min(image.width-tile.x,size+2);tile.height=Math.min(image.height-tile.y,size+2);this.baseTiles.set(key,tile);}
      if(!tile.bitmap){
        complete=false;
        if(!tile.pending&&this.tilePending<4){
          const item=tile;item.pending=true;this.tilePending++;
          void cropMapPhoto(image,item.x,item.y,item.width,item.height).then(bitmap=>{
            item.pending=false;this.tilePending--;if(this.disposed||(isPhoneGraphics()&&this.baseTiles.get(key)!==item)){bitmap.close();return;}item.bitmap=bitmap;this.invalidate();
          }).catch(()=>{item.pending=false;this.tilePending--;});
        }
        continue;
      }
      this.baseTiles.delete(key);this.baseTiles.set(key,tile);
      if(!this.prepare(tile.bitmap)){complete=false;continue;}
      const alpha=this.fade(tile.bitmap);if(alpha<1)this.tiledFading=true;
      const frame:TileDraw={sample:[tile.x/image.width,tile.y/image.height,tile.width/image.width,tile.height/image.height],clip:[x*size/image.width,y*size/image.height,size/image.width,size/image.height],rect:{x:left,y:top,width:right-left,height:bottom-top}};
      this.draw(tile.bitmap,projection,width,height,dpr,across,cx,cy,rotation,undefined,alpha,frame);drew=true;
    }
    this.baseRegionReady=complete&&drew;
    this.endBatch();
    while(this.baseTiles.size>(isPhoneGraphics()?40:160)){const key=this.baseTiles.keys().next().value!,tile=this.baseTiles.get(key)!;if(tile.pending)break;tile.bitmap?.close();this.baseTiles.delete(key);}
    return drew?this.canvas:null;
  }

  beginBatch(width:number,height:number,dpr:number) {
    dpr=this.pixelRatio(width,height,dpr);
    const w=Math.round(width*dpr),h=Math.round(height*dpr),gl=this.gl;
    if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
    gl.disable(gl.SCISSOR_TEST);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);this.batching=true;
  }

  endBatch() { this.batching=false;this.gl.disable(this.gl.BLEND); }

  pixelRatio(width:number,height:number,ratio:number) { return drawingPixelRatio(this.gl,width,height,ratio); }

  getStats() { return { backgroundCpuMs:0,maxUploadMs:this.maxSmallUploadMs,uploads:this.textures.size,
    pending:[...this.textures.values()].filter(v=>!v.ready).length,readyLarge:this.baseRegionReady?1:0,tileCrops:this.baseTiles.size,tilePending:this.tilePending,maxSmallUploadMs:this.maxSmallUploadMs }; }

  beginFrame() { this.uploadBytesLeft=4194304;for(const [image,entry] of this.textures) if(!image.width){this.drop(entry);this.textures.delete(image);} }

  isReady(image: ImageBitmap) { return this.textures.get(image)?.ready ?? false; }

  cancelPendingGlobal(all=false) {
    for(const [image,entry] of this.textures) if(!image.width||(!entry.ready&&(all||image.width>4096))) { this.drop(entry);this.textures.delete(image); }
  }

  fade(image: ImageBitmap) { const entry=this.textures.get(image); return entry?.ready?Math.min(1,(performance.now()-entry.readyAt)/120):0; }

  prepare(image: ImageBitmap,polar=false): boolean {
    let entry=this.textures.get(image);
    if(entry) { this.textures.delete(image);this.textures.set(image,entry);return entry.ready; }
    const bytes=image.width*image.height*4;
    if(image.width>this.maxTextureSize||image.height>this.maxTextureSize)return false;
    if(bytes>8388608)return false;
    // A warm CPU tile cache can still be cold on this GPU. Refine at most four megabytes
    // per draw; loaded parents remain underneath until each sharper tile is ready.
    if(bytes<=8388608&&image.width<2048&&bytes>this.uploadBytesLeft){this.invalidate();return false;}
    if(bytes<=8388608)this.uploadBytesLeft=Math.max(0,this.uploadBytesLeft-bytes);
    const gl=this.gl,texture=gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,polar?gl.CLAMP_TO_EDGE:gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
    entry={texture,ready:false,row:0,raf:0,disposed:false,cropping:false,readyAt:0};
    this.textures.set(image,entry);
    if(image.width*image.height<=2097152) {
      const start=performance.now();gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
      this.maxSmallUploadMs=Math.max(this.maxSmallUploadMs,performance.now()-start);
      entry.ready=true;entry.readyAt=performance.now()-(image.width>=2048?120:0);
    }
    if(this.textures.size>(isPhoneGraphics()?48:192)) { const key=this.textures.keys().next().value!;this.drop(this.textures.get(key)!);this.textures.delete(key); }
    return entry.ready;
  }

  private drop(entry:PlaneTexture) { entry.disposed=true;cancelAnimationFrame(entry.raf);this.gl.deleteTexture(entry.texture); }

  releasePhotos() {
    for (const entry of this.textures.values()) this.drop(entry);
    this.textures.clear();
    for (const tile of this.baseTiles.values()) tile.bitmap?.close();
    this.baseTiles.clear(); this.baseRegionReady = false;
    this.canvas.width = this.canvas.height = 1;
  }

  destroy() {
    this.offContextLoss();
    this.disposed=true;for(const tile of this.baseTiles.values())tile.bitmap?.close();this.baseTiles.clear();this.gl.deleteTexture(this.warmTexture);
    for(const entry of this.textures.values())this.drop(entry);
    this.textures.clear();this.gl.deleteBuffer(this.vertices);this.gl.deleteVertexArray(this.vao);this.gl.deleteProgram(this.program);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();this.canvas.width=1;this.canvas.height=1;
  }
}

// Insert beside MapEngine: uses existing SurfaceProjection, MAP_R, DEG and XY.
// Rotating a cylindrical frame stays one-to-one. The close seam is behind the view;
// far away the frame becomes true lat/lon and the whole Moon is a 2:1 rectangle.
type FlatBasis = { up: [number, number, number]; east: [number, number, number]; north: [number, number, number] };
type FlatQuaternion = [number, number, number, number];
class FlatMapProjection {
  lat = 0;
  lon = 0;
  blend = 0;
  revision = 0;
  private readonly local: SurfaceProjection;
  private start: FlatQuaternion = [0, 0, 0, 1];
  private end: FlatQuaternion = [0, 0, 0, 1];
  private frame: FlatBasis = { up: [1, 0, 0], east: [0, 1, 0], north: [0, 0, 1] };
  private offset = 0;

  constructor(lat: number, lon: number) {
    this.local = new SurfaceProjection(lat, lon);
    this.reset(lat, lon);
  }

  reset(lat: number, lon: number) {
    if (!Number.isFinite(lat + lon)) return;
    this.lat = Math.max(-90, Math.min(90, lat)); this.lon = this.wrap(lon);
    this.local.reset(this.lat, this.lon); this.local.setAcross(60, true);
    this.refreshEnds(); this.refreshFrame(); this.revision++;
  }

  moveCentre(lat: number, lon: number) {
    if (!Number.isFinite(lat + lon)) return;
    this.lat = Math.max(-90, Math.min(90, lat)); this.lon = this.wrap(lon);
    this.local.moveCentre(this.lat, this.lon);
    this.refreshEnds(); this.refreshFrame(); this.revision++;
  }

  setAcross(across: number, round: boolean) {
    this.local.setAcross(across, true);
    const t = round ? 0 : Math.max(0, Math.min(1, Math.log(Math.max(1, across) / 500000) / Math.log(4500000 / 500000)));
    const next = t * t * (3 - 2 * t);
    if (next !== this.blend) { this.blend = next; this.refreshFrame(); this.revision++; }
  }

  /** These arrays can also be the photo shader's uniforms. */
  basis() { return this.frame; }
  /** Subtract this from R * asin(dot(unit, basis.north)) in the shader. */
  offsetN() { return this.offset; }

  // This projection has no hidden hemisphere. Far ground falls outside a close viewport.
  depth(_lat: number, _lon: number) { return 1; }
  visible(lat: number, lon: number) { return Number.isFinite(lat + lon) && Math.abs(lat) <= 90 + 1e-9; }

  project(lat: number, lon: number): XY {
    const p = this.unit(lat, lon), f = this.frame;
    return [MAP_R * Math.atan2(this.dot(p, f.east), this.dot(p, f.up)),
      MAP_R * Math.asin(Math.max(-1, Math.min(1, this.dot(p, f.north)))) - this.offset];
  }

  unproject(e: number, n: number): XY {
    // East and west the map repeats, so any distance that way is a real place; only north and south have an end.
    const longitude = e / MAP_R, latitude = (n + this.offset) / MAP_R;
    if (!Number.isFinite(longitude + latitude) || Math.abs(latitude) > Math.PI / 2 + 1e-10) return [NaN, NaN];
    const p = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, latitude)), cp = Math.cos(p), a = cp * Math.cos(longitude), b = cp * Math.sin(longitude), c = Math.sin(p), f = this.frame;
    const x = f.up[0] * a + f.east[0] * b + f.north[0] * c;
    const y = f.up[1] * a + f.east[1] * b + f.north[1] * c;
    const z = f.up[2] * a + f.east[2] * b + f.north[2] * c;
    return [Math.asin(Math.max(-1, Math.min(1, z))) / DEG, Math.atan2(y, x) / DEG];
  }

  get limbRadius() { return Infinity; }

  private refreshEnds() {
    this.start = this.toQuaternion(this.readLocalBasis());
    const l = this.lon * DEG;
    this.end = this.toQuaternion({ up: [Math.cos(l), Math.sin(l), 0], east: [-Math.sin(l), Math.cos(l), 0], north: [0, 0, 1] });
  }

  private refreshFrame() {
    const a = this.start, t = this.blend;
    let b = this.end, dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    if (dot < 0) { b = [-b[0], -b[1], -b[2], -b[3]]; dot = -dot; }
    let u = 1 - t, v = t;
    if (dot < .9995) {
      const angle = Math.acos(Math.max(-1, Math.min(1, dot))), denominator = Math.sin(angle);
      u = Math.sin((1 - t) * angle) / denominator; v = Math.sin(t * angle) / denominator;
    }
    const q = a.map((value, i) => value * u + b[i] * v), length = Math.hypot(...q);
    const x = q[0] / length, y = q[1] / length, z = q[2] / length, w = q[3] / length;
    this.frame = {
      up: [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
      east: [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
      north: [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
    };
    const latitude = Math.asin(Math.max(-1, Math.min(1, this.dot(this.unit(this.lat, this.lon), this.frame.north))));
    this.offset = MAP_R * latitude * (1 - this.blend);
  }

  private toQuaternion(f: FlatBasis): FlatQuaternion {
    const m00 = f.up[0], m01 = f.east[0], m02 = f.north[0];
    const m10 = f.up[1], m11 = f.east[1], m12 = f.north[1];
    const m20 = f.up[2], m21 = f.east[2], m22 = f.north[2], trace = m00 + m11 + m22;
    let q: FlatQuaternion;
    if (trace > 0) {
      const s = Math.sqrt(trace + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
    } else if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
    } else if (m11 > m22) {
      const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
    } else {
      const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
    }
    const length = Math.hypot(...q); return q.map(value => value / length) as FlatQuaternion;
  }

  private wrap(lon: number) { return ((lon + 540) % 360 + 360) % 360 - 180; }
  private dot(a: [number, number, number], b: [number, number, number]) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  private unit(lat: number, lon: number): [number, number, number] {
    const p = lat * DEG, l = lon * DEG, cp = Math.cos(p);
    return [cp * Math.cos(l), cp * Math.sin(l), Math.sin(p)];
  }

  private readLocalBasis(): FlatBasis {
    const p = this.lat * DEG, l = this.lon * DEG, cp = Math.cos(p), sp = Math.sin(p), cl = Math.cos(l), sl = Math.sin(l);
    const up: [number, number, number] = [cp * cl, cp * sl, sp];
    const east0: [number, number, number] = [-sl, cl, 0], north0: [number, number, number] = [-sp * cl, -sp * sl, cp];
    const sample = (direction: [number, number, number]) => {
      const angle = .00001, c = Math.cos(angle), s = Math.sin(angle), v = up.map((value, i) => value * c + direction[i] * s);
      return this.local.project(Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG, Math.atan2(v[1], v[0]) / DEG);
    };
    const a = sample(east0), b = sample(north0), distance = 2 * MAP_R * Math.tan(.00001 / 2);
    let east = east0.map((v, i) => (v * a[0] + north0[i] * b[0]) / distance) as [number, number, number];
    const leak = this.dot(east, up); east = east.map((v, i) => v - leak * up[i]) as [number, number, number];
    const length = Math.hypot(...east); east = east.map(v => v / length) as [number, number, number];
    const north: [number, number, number] = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];
    return { up, east, north };
  }
}
