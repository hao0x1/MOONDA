// Globe <-> Flat map: the choreographed move between the Cesium globe and the flat map (flatMap.ts).
//
// To the map (about 2.4 s): names, markers and pins fade out while the camera eases back to frame the
// whole Moon, north up; our own sphere takes over from Cesium's (same camera, so nothing moves), swells
// into a cylinder and unrolls into the map while the starry sky fades to a quiet dark backdrop; the
// map settles into the space between the panels; names and markers fade back in.
// Back to the globe: the reverse, ending above the place the map was centred on.
// Reduced motion: a quick cross-fade. Input is ignored while it runs.

import { Cartesian3, type Viewer } from 'cesium';
import { MOON_R, toTrueLatLon } from './frame';
import { FlatMap, tween, ease, easeOut } from './flatMap';
import { poseGlobe, poseLookingAt, type CameraPose, type Navigation } from './navigation';

export type MapMode = 'globe' | 'flat';

export interface GlobeSide {
  viewer: Viewer;
  nav: Navigation;
  /** names, place icons, pins and the Sun / Earth chips of the globe on (true) or faded away (false) */
  setGlobeExtras(on: boolean): void;
  heightAt(lat: number, lon: number): number;
}

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
const nextFrames = (n = 2) => new Promise<void>(res => { const f = () => (--n <= 0 ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });

export class MapModes {
  mode: MapMode = 'globe';
  moving = false;
  private flat: FlatMap;
  private g: GlobeSide;
  onChange: (m: MapMode) => void = () => {};

  constructor(flat: FlatMap, globe: GlobeSide) { this.flat = flat; this.g = globe; }

  /** The camera distance (Moon radii) at which the whole Moon fills about 72 % of the screen height. */
  private wholeD() {
    const fovy = (this.g.viewer.camera.frustum as unknown as { fovy: number }).fovy;
    return 1 / Math.sin(Math.atan(0.72 * Math.tan(fovy / 2)));
  }
  /** What the globe camera looks at (true lat/lon), or the point under the camera. */
  private globeCentre() {
    const v = this.g.viewer, c = v.canvas;
    const ray = v.camera.getPickRay({ x: c.clientWidth / 2, y: c.clientHeight / 2 } as never);
    const hit = ray && v.scene.globe.pick(ray, v.scene);
    const t = toTrueLatLon(hit ?? v.camera.positionWC);
    const hKm = Cartesian3.magnitude(v.camera.positionWC) / 1000 - MOON_R / 1000;
    return { lat: t.lat, lon: t.lon, hKm };
  }

  async toFlat(): Promise<void> {
    if (this.mode === 'flat' || this.moving) return;
    const { viewer, nav } = this.g, flat = this.flat, scene = viewer.scene;
    this.moving = true; flat.busy = true; flat.frameLog = [];
    nav.enabled = false;
    try {
      await flat.prepare(false);
      flat.resize();
      const c = this.globeCentre();
      const D = this.wholeD();
      flat.camD = D;
      flat.fovy = (viewer.camera.frustum as unknown as { fovy: number }).fovy;
      flat.view = flat.wholeView(c.lon);
      this.g.setGlobeExtras(false);
      if (reduced()) {
        flat.morphA = 1; flat.morphB = 1; flat.backdrop = 1; flat.overlayAlpha = 1;
        flat.request();
        flat.setShown(true, 0);
        await tween(260, e => flat.setShown(true, e));
      } else {
        // 1. the camera eases back to the whole Moon, north up, over the centre's longitude (names fade meanwhile)
        const whole = poseGlobe(0, c.lon, (D - 1) * MOON_R);
        await nav.flyTo(whole, { duration: c.hKm > 4000 ? 0.75 : 0.95 });
        // 2. our sphere takes over (it is drawn exactly where Cesium's is)
        flat.morphA = 0; flat.morphB = 0; flat.backdrop = 0; flat.overlayAlpha = 0;
        flat.draw();
        flat.setShown(true, 0);
        await tween(140, e => flat.setShown(true, e), t => t);
        scene.globe.show = false;
        scene.requestRender();
        // 3. swell, unroll, settle; the sky fades to the backdrop
        flat.request();
        await tween(1350, (_e, t) => {
          flat.morphA = ease(Math.min(1, t / 0.55));
          flat.morphB = ease(Math.max(0, (t - 0.3) / 0.7));
          flat.backdrop = easeOut(Math.min(1, t / 0.8));
          flat.request();
        }, t => t);
        flat.morphA = 1; flat.morphB = 1; flat.backdrop = 1;
        // 4. names and markers fade in
        await tween(220, e => { flat.overlayAlpha = e; flat.request(); });
      }
      flat.overlayAlpha = 1;
      viewer.useDefaultRenderLoop = false; // the globe is fully covered: stop drawing it
      this.mode = 'flat';
      flat.active = true;
      flat.refreshLabels();
    } finally {
      flat.busy = false;
      flat.setShown(this.mode === 'flat');
      this.moving = false;
      if (this.mode !== 'flat') { scene.globe.show = true; this.g.setGlobeExtras(true); nav.enabled = true; }
      this.onChange(this.mode);
    }
  }

  /**
   * Back to the globe. `at` (true lat/lon + view size in km): where the globe should end up (default: what the
   * map was centred on). `fast`: a shortened move (Stand here). `pose`: fly the globe to this instead.
   */
  async toGlobe(o: { at?: { lat: number; lon: number; km: number }; fast?: boolean; pose?: CameraPose; handOff?: () => void } = {}): Promise<void> {
    if (this.mode === 'globe' || this.moving) return;
    const { viewer, nav } = this.g, flat = this.flat, scene = viewer.scene;
    this.moving = true; flat.busy = true; flat.frameLog = [];
    flat.stop();
    try {
      const fr = flat.free();
      const v = flat.view;
      const at = o.at ?? { lat: v.latC, lon: v.lonC, km: (fr.w / v.s) * 30.32 };
      const D = this.wholeD();
      flat.camD = D;
      flat.fovy = (viewer.camera.frustum as unknown as { fovy: number }).fovy;
      const ground = this.g.heightAt(at.lat, at.lon);
      const zoomedOut = at.km > 2600;
      const target: CameraPose = o.pose ?? (zoomedOut ? poseGlobe(at.lat, at.lon, 6_500_000) : poseLookingAt(at.lat, at.lon, ground, at.km * 1000 * 0.9, 0, -90));
      viewer.useDefaultRenderLoop = true;
      if (reduced()) {
        viewer.camera.setView({ destination: target.destination, orientation: { direction: target.direction, up: target.up } });
        scene.globe.show = true; this.g.setGlobeExtras(true);
        scene.requestRender();
        await nextFrames(2);
        await tween(260, e => flat.setShown(false, 1 - e));
      } else {
        const sp = o.fast ? 0.6 : 1;
        // 1. names fade out while the map pans / zooms out to the whole Moon
        flat.busy = false; // let flyTo clamp the view
        const fade = tween(200 * sp, e => { flat.overlayAlpha = 1 - e; flat.request(); });
        await flat.flyTo(flat.wholeView(at.lon), (v.s / flat.fitScale() > 1.3 ? 0.8 : 0.35) * sp);
        await fade;
        flat.busy = true;
        // the globe is set up hidden, behind the map, at the matching whole-Moon pose
        const whole = poseGlobe(0, at.lon, (D - 1) * MOON_R);
        viewer.camera.setView({ destination: whole.destination, orientation: { direction: whole.direction, up: whole.up } });
        scene.requestRender();
        // 2. roll the map back up into the globe, the sky returns
        flat.request();
        await tween(1300 * sp, (_e, t) => {
          flat.morphB = 1 - ease(Math.min(1, t / 0.7));
          flat.morphA = 1 - ease(Math.max(0, (t - 0.45) / 0.55));
          flat.backdrop = 1 - easeOut(Math.max(0, (t - 0.15) / 0.85));
          flat.request();
        }, t => t);
        flat.morphA = 0; flat.morphB = 0; flat.backdrop = 0; flat.request();
        // 3. Cesium's globe takes over again (wait until its tiles are on screen, at most 0.5 s)
        scene.globe.show = true;
        scene.requestRender();
        const t0 = performance.now();
        while (!scene.globe.tilesLoaded && performance.now() - t0 < 500) { scene.requestRender(); await nextFrames(1); }
        await nextFrames(2);
        await tween(160, e => flat.setShown(false, 1 - e), t => t);
        this.g.setGlobeExtras(true);
        // 4. down to where the map was centred
        if (!o.handOff) await nav.flyTo(target, { duration: 1.0 * sp });
      }
      this.mode = 'globe';
      flat.active = false;
    } finally {
      flat.busy = false;
      this.moving = false;
      flat.setShown(this.mode === 'flat');
      if (this.mode === 'globe') { scene.globe.show = true; viewer.useDefaultRenderLoop = true; nav.enabled = !o.handOff; }
      this.onChange(this.mode);
      if (this.mode === 'globe') o.handOff?.();
    }
  }
}
