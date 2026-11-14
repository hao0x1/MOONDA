// Real space around the Moon: the Milky Way, about 9,000 stars and the bright planets in their true
// places, a lit 3D Earth (right phase, right side facing the Moon) and the Sun with a camera-like
// glare — all for the time on the time bar.
//
// How it is drawn: Cesium asks `scene.skyBox` for one "command" per frame and runs it before the
// Moon and before any depth sorting (that is how its own star box works). We hand it our own
// command, which paints: Milky Way -> stars -> planets -> Sun -> Earth -> name tags. The Moon is
// painted afterwards, so hills and the Moon's edge hide exactly what is behind them, nothing is
// ever clipped by the near/far planes, and globe lighting cannot touch the sky.
//
// Directions: stars and planets are infinitely far (direction only). The Sun and the Earth are
// aimed from the CAMERA's real position, so the Earth shifts by up to 3.7° as you fly around the
// Moon, exactly as it would.

import { Cartesian3, Cartesian4, Matrix3, type Scene, type Viewer } from 'cesium';
import type { Vec3 } from '../../science/ephemeris.ts';
import { earthToMoonFixed, mat3Identity, mat3MulVec, moonFromJ2000, planetSky, type Mat3, type PlanetSky } from '../../science/skyMath.ts';
import { trueToDisplayVec, type V3 } from '../frame.ts';
import { distanceWords, parseStars, PLANET_STYLE, starNote, taggedStars, type NamedStar, type StarCatalog } from './catalog.ts';
import { knobs } from '../../app/quality.ts';
import { aimFrom, angularRadius, behindBall, discVisible, EARTH_RADIUS_M, SUN_RADIUS_M, type GroundFn } from './geometry.ts';
import { createDrawable, createMesh, createTexture, destroyDrawable, limits, loadBitmap, type Drawable, type GlContext, type GlTexture, type UniformMap } from './gl.ts';
import { EARTH_FS, EARTH_VS, MILKY_FS, MILKY_VS, STAR_FS, STAR_VS, SUN_FS, SUN_VS, TAG_FS, TAG_VS } from './shaders.ts';
import { buildTagAtlas, tagBoxVertices, type TagSpec } from './tags.ts';

export interface SkyBodies { sun: V3; earth: V3 } // TRUE frame, metres from the Moon's centre
export interface SkyShow { stars: boolean; milkyWay: boolean; earth: boolean; sun: boolean; planets: boolean; names: boolean }
export interface SkyScreen { x: number; y: number; onScreen: boolean; behindMoon: boolean; sizePx: number }
export interface SkyPick { kind: 'earth' | 'sun' | 'planet' | 'star'; name: string; note: string }

/** Anything that can say how high the ground is (the app's MoonHeights fits). Used to know when hills hide the Sun. */
export interface GroundSource { ready: Promise<unknown>; heightAtUnit(ux: number, uy: number, uz: number, detail?: boolean): number }
export interface SkyOptions { base?: string; heights?: GroundSource }

const DEG = Math.PI / 180;
const PLANET_REFRESH_MS = 5 * 60_000; // planets creep: recomputing every 5 minutes of bar time keeps them within 0.01°

interface FrameStateLike { passes: { render: boolean }; context: GlContext }
type Part = 'milky' | 'stars' | 'planets' | 'sun' | 'earth' | 'tags';

export class SpaceSky {
  /** Catalogue and pictures loaded (or given up on). Never rejects. */
  readonly ready: Promise<void>;
  private exposureValue = 1;

  private scene: Scene;
  private base: string;
  private dead = false;
  private broken = false; // something failed while drawing: stay off, but still clean up in destroy()
  private shown: SkyShow = { stars: true, milkyWay: true, earth: true, sun: true, planets: true, names: true };
  private parts: Record<Part, Drawable | null> = { milky: null, stars: null, planets: null, sun: null, earth: null, tags: null };
  private textures: GlTexture[] = [];
  private milkyTex: GlTexture | null = null;
  private earthTex: { day: GlTexture; night: GlTexture; clouds: GlTexture } | null = null;
  private atlasTex: GlTexture | null = null;
  private atlasScale = 0;
  private ground: GroundFn | null = null;
  private hook: object;
  private composite: object;

  // time-dependent state (set by update)
  private timeMs = NaN;
  private hasBodies = false;
  private sunD: V3 = [1.5e11, 0, 0];
  private earthD: V3 = [0, 3.8e8, 0];
  private moonFromSky: Mat3 = mat3Identity();
  private planets: PlanetSky[] = [];
  private planetT = NaN;
  private planetData = new Float32Array(5 * 4);
  private catalog: StarCatalog | null = null;
  private tagStars: NamedStar[] = [];
  private tagDirs: Float32Array | null = null;

  // per-frame state (set by prepare) — all preallocated, nothing is created while drawing
  private cam: V3 = [0, 0, 0];
  private sunDir: V3 = [1, 0, 0];
  private earthDir: V3 = [0, 1, 0];
  private sunDist = 1.5e11;
  private earthDist = 3.8e8;
  private sunVis = 1;
  private visKey = new Float64Array(6);
  private visAt = 0;
  private uRot = new Matrix3();
  private uEarthFromWorld = new Matrix3();
  private uSunCenter = new Cartesian3(1, 0, 0);
  private uSunRight = new Cartesian3(0, 1, 0);
  private uSunUp = new Cartesian3(0, 0, 1);
  private uSun = new Cartesian4(0.05, 1, 1, 0.26);
  private uSunTan = 0.1;
  private uEarthCenter = new Cartesian3(0, 1, 0);
  private uEarthRight = new Cartesian3(1, 0, 0);
  private uEarthUp = new Cartesian3(0, 0, 1);
  private uEarthSun = new Cartesian3(1, 0, 0);
  private uEarth = new Cartesian3(60, 1, 1);
  private uEarthTan = 0.02;
  private uTone = new Cartesian4(0.0022, 2.7, 1.2, 0.28);
  private uStar = new Cartesian3(1, 1, 1);
  private uPlanetStar = new Cartesian3(1, 1, 1);
  private pixelRatio = 1;
  private tagAlpha = 1;
  /** How long each start-up step took on the main thread, ms (for the loading screen / tests). */
  private timings: Record<string, number> = {};
  private born = performance.now();

  constructor(viewer: Viewer, opts: SkyOptions = {}) {
    this.scene = viewer.scene;
    this.base = opts.base ?? './space/';
    if (opts.heights) {
      const h = opts.heights;
      // display -> true is (x, z, -y)
      void h.ready.then(() => { this.ground = (ux, uy, uz, detail) => h.heightAtUnit(ux, uz, -uy, detail); this.visKey[0] = NaN; this.scene.requestRender(); }, () => {});
    }
    const order: Part[] = ['milky', 'stars', 'planets', 'sun', 'earth', 'tags'];
    this.composite = {
      // what Scene.executeCommand looks at before calling execute()
      derivedCommands: {}, debugShowBoundingVolume: false, receiveShadows: false, castShadows: false, boundingVolume: undefined,
      execute: (context: GlContext, passState: unknown) => {
        for (const p of order) {
          const d = this.parts[p];
          if (!d || !this.partOn(p)) continue;
          // a sky problem must never stop the map from drawing: switch the broken part off and carry on
          try { d.command.execute(context, passState); } catch (e) { console.warn(`[sky] ${p} failed while drawing and is switched off:`, e); this.parts[p] = null; }
        }
      },
    };
    this.hook = {
      show: true,
      update: (frameState: FrameStateLike) => {
        if (this.dead || this.broken || !frameState.passes.render || !this.hasBodies) return undefined;
        try { this.prepare(); } catch (e) { console.warn('[sky] switched off:', e); this.broken = true; return undefined; }
        return this.composite;
      },
      isDestroyed: () => this.dead,
      destroy: () => { this.destroy(); return undefined; },
    };
    (this.scene as unknown as { skyBox: unknown }).skyBox = this.hook;
    this.ready = this.load().catch(e => { console.warn('[sky] could not load everything', e); }).then(() => { this.timings.readyAfter = Math.round(performance.now() - this.born); if (!this.dead) this.scene.requestRender(); });
  }

  /** Star and Milky Way brightness, 0..1.5 (1 = normal). */
  get exposure(): number { return this.exposureValue; }
  set exposure(v: number) { this.exposureValue = Math.max(0, Math.min(1.5, Number.isFinite(v) ? v : 1)); if (!this.dead) this.scene.requestRender(); }

  /** What to draw. Assign a new object to change it. */
  get show(): SkyShow { return this.shown; }
  set show(v: SkyShow) { this.shown = { ...v }; if (!this.dead) this.scene.requestRender(); }

  /** Call when the time on the time bar changes. `bodies`: Sun and Earth, TRUE frame, metres from the Moon's centre. */
  update(timeMs: number, bodies: SkyBodies) {
    if (this.dead) return;
    this.timeMs = timeMs;
    this.hasBodies = true;
    const s = trueToDisplayVec(bodies.sun), e = trueToDisplayVec(bodies.earth);
    this.sunD[0] = s[0]; this.sunD[1] = s[1]; this.sunD[2] = s[2];
    this.earthD[0] = e[0]; this.earthD[1] = e[1]; this.earthD[2] = e[2];
    // J2000 sky -> Moon TRUE -> display (x, -z, y): rows (r0, -r2, r1). Cesium's Matrix3 stores columns.
    const m = moonFromJ2000(timeMs, this.moonFromSky), u = this.uRot as unknown as number[];
    for (let j = 0; j < 3; j++) { u[3 * j] = m[j]; u[3 * j + 1] = -m[6 + j]; u[3 * j + 2] = m[3 + j]; }
    // Earth map frame -> display, stored transposed (= display -> Earth map), which in column order is the row-major original
    const em = earthToMoonFixed(timeMs, scratchM), w = this.uEarthFromWorld as unknown as number[];
    for (let j = 0; j < 3; j++) { w[j] = em[j]; w[3 + j] = -em[6 + j]; w[6 + j] = em[3 + j]; }
    // light on the Earth comes from the Sun as seen from the Earth
    const lx = s[0] - e[0], ly = s[1] - e[1], lz = s[2] - e[2], ll = Math.hypot(lx, ly, lz);
    Cartesian3.fromElements(lx / ll, ly / ll, lz / ll, this.uEarthSun);
    if (!(Math.abs(timeMs - this.planetT) < PLANET_REFRESH_MS)) this.refreshPlanets();
    this.scene.requestRender();
  }

  /** Where the Sun or the Earth is on the screen right now (CSS pixels), or null before the first update. */
  screenOf(body: 'sun' | 'earth'): SkyScreen | null {
    if (this.dead || !this.hasBodies) return null;
    const camera = this.scene.camera, canvas = this.scene.canvas;
    const p = camera.positionWC;
    scratchCam[0] = p.x; scratchCam[1] = p.y; scratchCam[2] = p.z;
    const dist = aimFrom(body === 'sun' ? this.sunD : this.earthD, scratchCam, scratchDir);
    const rho = angularRadius(body === 'sun' ? SUN_RADIUS_M : EARTH_RADIUS_M, dist);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const focal = H / 2 / Math.tan((camera.frustum as unknown as { fovy: number }).fovy / 2);
    const r = camera.rightWC, u = camera.upWC, d = camera.directionWC;
    const cx = scratchDir[0] * r.x + scratchDir[1] * r.y + scratchDir[2] * r.z;
    const cy = scratchDir[0] * u.x + scratchDir[1] * u.y + scratchDir[2] * u.z;
    const cz = scratchDir[0] * d.x + scratchDir[1] * d.y + scratchDir[2] * d.z;
    const front = cz > 1e-6;
    // behind the camera there is no screen position: give a far-away point in the direction to turn to (handy for edge arrows)
    const far = 1e5 / (Math.hypot(cx, cy) || 1);
    const x = front ? W / 2 + (cx / cz) * focal : W / 2 + cx * far, y = front ? H / 2 - (cy / cz) * focal : H / 2 - cy * far;
    const sizePx = 2 * Math.tan(rho) * focal;
    const visible = discVisible(scratchCam, scratchDir, rho, this.ground);
    return { x, y, onScreen: front && x >= -sizePx / 2 && x <= W + sizePx / 2 && y >= -sizePx / 2 && y <= H + sizePx / 2, behindMoon: visible < 0.02, sizePx };
  }

  /** What sky object is at this screen point (CSS pixels)? Screen-space maths only. */
  pick(x: number, y: number): SkyPick | null {
    if (this.dead || !this.hasBodies) return null;
    const camera = this.scene.camera, canvas = this.scene.canvas;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const focal = H / 2 / Math.tan((camera.frustum as unknown as { fovy: number }).fovy / 2);
    const r = camera.rightWC, u = camera.upWC, d = camera.directionWC, p = camera.positionWC;
    scratchCam[0] = p.x; scratchCam[1] = p.y; scratchCam[2] = p.z;
    // the Moon itself is under the pointer -> nothing in the sky can be picked there
    const kx = (x - W / 2) / focal, ky = -(y - H / 2) / focal;
    let vx = d.x + r.x * kx + u.x * ky, vy = d.y + r.y * kx + u.y * ky, vz = d.z + r.z * kx + u.z * ky;
    const vl = Math.hypot(vx, vy, vz); vx /= vl; vy /= vl; vz /= vl;
    if (behindBall(scratchCam, vx, vy, vz)) return null;
    const pxFrom = (dir: V3) => { // distance in pixels between the pointer and a sky direction
      const cz = dir[0] * d.x + dir[1] * d.y + dir[2] * d.z;
      if (cz <= 1e-6) return Infinity;
      const sx = W / 2 + ((dir[0] * r.x + dir[1] * r.y + dir[2] * r.z) / cz) * focal, sy = H / 2 - ((dir[0] * u.x + dir[1] * u.y + dir[2] * u.z) / cz) * focal;
      return Math.hypot(sx - x, sy - y);
    };
    if (this.shown.earth) {
      const dist = aimFrom(this.earthD, scratchCam, scratchDir);
      if (pxFrom(scratchDir) < Math.max(10, Math.tan(angularRadius(EARTH_RADIUS_M, dist)) * focal)) {
        return { kind: 'earth', name: 'Earth', note: `Home. ${distanceWords(dist)} away right now — a radio call takes ${(dist / 299_792_458).toFixed(1)} seconds to get there.` };
      }
    }
    if (this.shown.sun) {
      const dist = aimFrom(this.sunD, scratchCam, scratchDir);
      if (pxFrom(scratchDir) < Math.max(14, Math.tan(angularRadius(SUN_RADIUS_M, dist)) * focal)) {
        return { kind: 'sun', name: 'The Sun', note: `${distanceWords(dist)} away. Its light takes about ${Math.round(dist / 299_792_458 / 60)} minutes to reach the Moon.` };
      }
    }
    const m = this.moonFromSky;
    const toDisplay = (j: Vec3) => { mat3MulVec(m, j, scratchT); scratchDir[0] = scratchT[0]; scratchDir[1] = -scratchT[2]; scratchDir[2] = scratchT[1]; return scratchDir; };
    if (this.shown.planets) {
      for (const pl of this.planets) {
        if (pxFrom(toDisplay(pl.j2000)) < 12) return { kind: 'planet', name: pl.name, note: `${PLANET_STYLE[pl.name].about}. ${distanceWords(pl.distM)} away right now.` };
      }
    }
    if (this.shown.stars && this.catalog) {
      let best: NamedStar | null = null, bestPx = 9;
      for (const s of this.catalog.named) {
        if (s.mag > 4) break; // brightest first
        const px = pxFrom(toDisplay(s.j2000));
        if (px < bestPx) { bestPx = px; best = s; }
      }
      if (best) return { kind: 'star', name: best.name, note: starNote(best) };
    }
    return null;
  }

  /** For tests: the directions and numbers used for the last drawn frame. */
  debug() {
    return {
      timeMs: this.timeMs, sunDir: [...this.sunDir], earthDir: [...this.earthDir], sunVisible: this.sunVis,
      sunDistM: this.sunDist, earthDistM: this.earthDist, hasGround: !!this.ground,
      parts: Object.fromEntries(Object.entries(this.parts).map(([k, v]) => [k, !!v])), stars: this.catalog?.count ?? 0,
      milkyWayPx: this.milkyTex?.width ?? 0, timings: { ...this.timings }, planets: this.planets.map(p => ({ name: p.name, mag: +p.mag.toFixed(2) })),
    };
  }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    const sc = this.scene as unknown as { skyBox: unknown; isDestroyed(): boolean };
    if (sc.skyBox === this.hook) sc.skyBox = undefined;
    for (const k of Object.keys(this.parts) as Part[]) { destroyDrawable(this.parts[k]); this.parts[k] = null; }
    for (const t of this.textures) t.destroy();
    this.textures = [];
  }

  // ---- inside ---------------------------------------------------------------------------------

  private partOn(p: Part): boolean {
    const s = this.shown;
    switch (p) {
      case 'milky': return s.milkyWay && this.exposure > 0.01;
      case 'stars': return s.stars && this.exposure > 0.01;
      case 'planets': return s.planets;
      case 'sun': return s.sun;
      case 'earth': return s.earth;
      case 'tags': return s.names && (s.planets || s.stars) && this.tagAlpha > 0.01;
    }
  }

  /** Once per drawn frame, just before drawing: everything that depends on where the camera is. */
  private prepare() {
    const scene = this.scene, camera = scene.camera, canvas = scene.canvas;
    const p = camera.positionWC, cam = this.cam;
    cam[0] = p.x; cam[1] = p.y; cam[2] = p.z;
    const fovy = (camera.frustum as unknown as { fovy: number }).fovy || 0.7;
    const H = canvas.clientHeight || 1;
    const focal = H / 2 / Math.tan(fovy / 2); // CSS pixels per unit of tan(angle)
    const pr = this.pixelRatio = (scene as unknown as { pixelRatio: number }).pixelRatio || 1;
    const up = camera.upWC, right = camera.rightWC;

    // Sun: true disc, plus glare sized like a camera would give (a share of the screen, not of the sky)
    this.sunDist = aimFrom(this.sunD, cam, this.sunDir);
    const rhoS = angularRadius(SUN_RADIUS_M, this.sunDist);
    const glareTan = Math.max(Math.min(260, Math.max(110, 0.2 * H)) / focal, 12 * Math.tan(rhoS));
    card(this.sunDir, up, right, this.uSunCenter, this.uSunRight, this.uSunUp);
    this.uSunTan = glareTan;
    this.uSun.x = Math.tan(rhoS) / glareTan;
    const now = performance.now();
    if (changed(this.visKey, cam, this.sunDir) || now - this.visAt > 1000) { this.visAt = now; this.sunVis = discVisible(cam, this.sunDir, rhoS, this.ground); }
    this.uSun.y = this.sunVis;

    // Earth: true size and direction from where the camera really is
    this.earthDist = aimFrom(this.earthD, cam, this.earthDir);
    const rhoE = angularRadius(EARTH_RADIUS_M, this.earthDist);
    card(this.earthDir, up, right, this.uEarthCenter, this.uEarthRight, this.uEarthUp);
    this.uEarthTan = Math.tan(rhoE) * 1.14; // room for the thin rim of air
    this.uEarth.x = this.earthDist / EARTH_RADIUS_M;

    // stars: a narrow lens gathers more light (like binoculars), a wide one less
    const lens = Math.min(2.2, Math.max(0.85, Math.sqrt(0.364 / Math.tan(fovy / 2))));
    const ex = this.exposureValue;
    this.uStar.x = ex; this.uStar.y = lens; this.uStar.z = pr;
    this.uPlanetStar.x = 0.55 + 0.45 * Math.min(1, ex); this.uPlanetStar.y = lens; this.uPlanetStar.z = pr;
    this.uTone.y = 2.7 * ex;
    // Drawn much larger than its own pixels the Milky Way picture shows blotches: keep the fine grain only near 1:1.
    const texelPx = (focal * pr * 2 * Math.PI) / (this.milkyTex?.width ?? 8192);
    this.uTone.w = 0.28 * Math.min(1, Math.max(0, (2.6 / texelPx - 0.12) / 0.88));
    if (this.atlasTex && Math.ceil(pr) !== this.atlasScale && this.parts.tags) this.rebuildTags();
    const tags = this.parts.tags;
    if (tags) { // the first 5 tags are the planets, the rest are stars (6 corners each)
      const first = this.shown.planets ? 0 : 30, last = this.shown.stars ? (5 + this.tagStars.length) * 6 : 30;
      tags.command.offset = first; tags.command.count = Math.max(0, last - first);
    }
  }

  private refreshPlanets() {
    this.planetT = this.timeMs;
    try { this.planets = planetSky(this.timeMs); } catch { this.planets = []; }
    const d = this.planetData;
    this.planets.forEach((pl, i) => { d[4 * i] = pl.j2000[0]; d[4 * i + 1] = pl.j2000[1]; d[4 * i + 2] = pl.j2000[2]; d[4 * i + 3] = pl.mag; });
    this.parts.planets?.mesh.buffers[0].copyFromArrayView(d);
    this.writeTagDirs();
  }

  /** Tag anchors: planets first (they move), then the named stars. Six corners each. */
  private writeTagDirs() {
    const tags = this.parts.tags, dirs = this.tagDirs;
    if (!tags || !dirs) return;
    const put = (i: number, v: Vec3) => { for (let k = 0; k < 6; k++) dirs.set(v, (i * 6 + k) * 3); };
    this.planets.forEach((pl, i) => put(i, pl.j2000));
    this.tagStars.forEach((s, i) => put(5 + i, s.j2000));
    tags.mesh.buffers[0].copyFromArrayView(dirs);
  }

  private tagSpecs(): TagSpec[] {
    return [...['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'].map(text => ({ text, kind: 'planet' as const })), ...this.tagStars.map(s => ({ text: s.name, kind: 'star' as const }))];
  }

  private rebuildTags() {
    const context = this.context(), old = this.atlasTex;
    const atlas = buildTagAtlas(this.tagSpecs(), Math.min(3, Math.max(1, Math.ceil(this.pixelRatio))));
    this.atlasTex = this.keep(createTexture({ context, source: atlas.canvas, alpha: true, premultiply: true, mipmaps: false }));
    this.atlasScale = atlas.scale;
    if (old) { old.destroy(); this.textures = this.textures.filter(t => t !== old); }
    this.parts.tags?.mesh.buffers[1].copyFromArrayView(tagBoxVertices(atlas.boxes));
  }

  private context(): GlContext { return (this.scene as unknown as { context: GlContext }).context; }
  private keep<T extends GlTexture>(t: T): T { this.textures.push(t); return t; }
  /** Run one start-up step and note how long it held the main thread. */
  private timed<T>(name: string, work: () => T): T { const t0 = performance.now(); const out = work(); this.timings[name] = +(performance.now() - t0).toFixed(1); return out; }

  /** Build one part; a failure (a shader that will not compile on this GPU, a missing file) only switches that part off. */
  private tryPart(name: Part, make: () => Drawable) {
    if (this.dead) return;
    try { this.parts[name] = make(); } catch (e) { console.warn(`[sky] ${name} is switched off:`, e); this.parts[name] = null; }
    this.scene.requestRender();
  }

  private async load() {
    const context = this.context();
    const rot: UniformMap = { u_rot: () => this.uRot };

    // The Sun needs no files: draw it at once.
    this.tryPart('sun', () => createDrawable({
      context, owner: this, blend: 'add', vertex: SUN_VS, fragment: SUN_FS,
      mesh: createMesh(context, [{ name: 'a_corner', data: new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), size: 2 }]),
      uniforms: { u_center: () => this.uSunCenter, u_right: () => this.uSunRight, u_up: () => this.uSunUp, u_tanHalf: () => this.uSunTan, u_sun: () => this.uSun },
    }));

    const starsJob = (async () => {
      const res = await fetch(this.base + 'stars.json');
      if (!res.ok) throw new Error(`stars.json: ${res.status}`);
      const rows = await res.json();
      const cat = this.timed('stars', () => parseStars(rows));
      if (this.dead) return;
      this.catalog = cat;
      this.tagStars = taggedStars(cat, 7);
      this.tryPart('stars', () => createDrawable({
        context, owner: this, blend: 'add', points: true, vertex: STAR_VS, fragment: STAR_FS,
        mesh: createMesh(context, [{ name: 'a_dirMag', data: cat.dirMag, size: 4 }, { name: 'a_color', data: cat.color, size: 4, normalize: true }]),
        uniforms: { ...rot, u_star: () => this.uStar },
      }));
      const planetColor = new Uint8Array(5 * 4);
      ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'].forEach((n, i) => planetColor.set([...PLANET_STYLE[n].rgb, 255], 4 * i));
      this.tryPart('planets', () => createDrawable({
        context, owner: this, blend: 'add', points: true, vertex: STAR_VS, fragment: STAR_FS,
        mesh: createMesh(context, [{ name: 'a_dirMag', data: this.planetData, size: 4, dynamic: true }, { name: 'a_color', data: planetColor, size: 4, normalize: true }]),
        uniforms: { ...rot, u_star: () => this.uPlanetStar },
      }));
      // name tags need the page font; do not wait for it forever
      await Promise.race([document.fonts.load('500 11px "Google Sans Flex Variable"').catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
      if (this.dead) return;
      const count = 5 + this.tagStars.length;
      this.tagDirs = new Float32Array(count * 6 * 3);
      this.pixelRatio = (this.scene as unknown as { pixelRatio: number }).pixelRatio || 1;
      this.tryPart('tags', () => {
        const atlas = buildTagAtlas(this.tagSpecs(), Math.min(3, Math.max(1, Math.ceil(this.pixelRatio))));
        this.atlasTex = this.keep(createTexture({ context, source: atlas.canvas, alpha: true, premultiply: true, mipmaps: false }));
        this.atlasScale = atlas.scale;
        return createDrawable({
          context, owner: this, blend: 'over', vertex: TAG_VS, fragment: TAG_FS,
          mesh: createMesh(context, [{ name: 'a_dir', data: this.tagDirs!, size: 3, dynamic: true }, { name: 'a_box', data: tagBoxVertices(atlas.boxes), size: 4, dynamic: true }]),
          uniforms: { ...rot, u_atlas: () => this.atlasTex, u_tagScale: () => this.pixelRatio, u_tagAlpha: () => this.tagAlpha },
        });
      });
      if (Number.isFinite(this.timeMs)) this.refreshPlanets(); else this.writeTagDirs();
    })().catch(e => console.warn('[sky] no stars:', e));

    const milkyJob = (async () => {
      // small picture first (fast), then the sharp one if this GPU takes it
      const small = await loadBitmap(this.base + 'milkyway_4k.jpg');
      if (this.dead) return;
      this.milkyTex = this.keep(this.timed('milkyWay4k', () => createTexture({ context, source: small, repeatX: true })));
      small.close();
      this.tryPart('milky', () => createDrawable({
        context, owner: this, blend: 'none', vertex: MILKY_VS, fragment: MILKY_FS, mesh: skyBall(context),
        uniforms: { ...rot, u_tex: () => this.milkyTex, u_tone: () => this.uTone },
      }));
      // the sharp 8k picture only in "Full detail" (app/quality.ts), and only if this GPU takes it
      if (!knobs().milkyWay8k || limits().maximumTextureSize < 8192 || ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) < 4) return;
      const big = await loadBitmap(this.base + 'milkyway_8k.jpg');
      if (this.dead) { big.close(); return; }
      const old = this.milkyTex;
      this.milkyTex = this.keep(this.timed('milkyWay8k', () => createTexture({ context, source: big, repeatX: true })));
      big.close();
      old.destroy(); this.textures = this.textures.filter(t => t !== old);
      this.scene.requestRender();
    })().catch(e => console.warn('[sky] no Milky Way:', e));

    const earthJob = (async () => {
      const blank = () => { const c = document.createElement('canvas'); c.width = c.height = 2; c.getContext('2d')!.fillRect(0, 0, 2, 2); return c; };
      const [day, night, clouds] = await Promise.all([
        loadBitmap(this.base + 'earth_day_4k.jpg'),
        loadBitmap(this.base + 'earth_night_4k.jpg').catch(() => null),
        loadBitmap(this.base + 'earth_clouds_2k.jpg').catch(() => null),
      ]);
      if (this.dead) return;
      this.earthTex = this.timed('earth', () => ({
        day: this.keep(createTexture({ context, source: day, repeatX: true })),
        night: this.keep(createTexture({ context, source: night ?? blank(), grey: true, repeatX: true })),
        clouds: this.keep(createTexture({ context, source: clouds ?? blank(), grey: true, repeatX: true })),
      }));
      day.close(); night?.close(); clouds?.close();
      this.tryPart('earth', () => createDrawable({
        context, owner: this, blend: 'over', vertex: EARTH_VS, fragment: EARTH_FS,
        mesh: createMesh(context, [{ name: 'a_corner', data: new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), size: 2 }]),
        uniforms: {
          u_center: () => this.uEarthCenter, u_right: () => this.uEarthRight, u_up: () => this.uEarthUp, u_tanHalf: () => this.uEarthTan,
          u_sunDir: () => this.uEarthSun, u_earth: () => this.uEarth, u_earthFromWorld: () => this.uEarthFromWorld,
          u_day: () => this.earthTex!.day, u_night: () => this.earthTex!.night, u_clouds: () => this.earthTex!.clouds,
        },
      }));
    })().catch(e => console.warn('[sky] no Earth:', e));

    await Promise.all([starsJob, milkyJob, earthJob]);
  }
}

const scratchM: Mat3 = mat3Identity();
const scratchCam: V3 = [0, 0, 0], scratchDir: V3 = [0, 0, 0], scratchT: Vec3 = [0, 0, 0];

/** Has the camera or the direction moved enough to re-check what the ground hides? Remembers the new values if so. */
function changed(key: Float64Array, cam: V3, dir: V3): boolean {
  if (Math.abs(key[0] - cam[0]) < 0.5 && Math.abs(key[1] - cam[1]) < 0.5 && Math.abs(key[2] - cam[2]) < 0.5
    && Math.abs(key[3] - dir[0]) < 2e-5 && Math.abs(key[4] - dir[1]) < 2e-5 && Math.abs(key[5] - dir[2]) < 2e-5) return false;
  key[0] = cam[0]; key[1] = cam[1]; key[2] = cam[2]; key[3] = dir[0]; key[4] = dir[1]; key[5] = dir[2];
  return true;
}

/** Axes of a card that faces the eye, centred on `dir`, upright like the camera. */
function card(dir: V3, camUp: Cartesian3, camRight: Cartesian3, center: Cartesian3, right: Cartesian3, up: Cartesian3) {
  center.x = dir[0]; center.y = dir[1]; center.z = dir[2];
  let rx = dir[1] * camUp.z - dir[2] * camUp.y, ry = dir[2] * camUp.x - dir[0] * camUp.z, rz = dir[0] * camUp.y - dir[1] * camUp.x;
  let rl = Math.hypot(rx, ry, rz);
  if (rl < 1e-4) { rx = camRight.x; ry = camRight.y; rz = camRight.z; rl = 1; }
  right.x = rx / rl; right.y = ry / rl; right.z = rz / rl;
  const ux = right.y * dir[2] - right.z * dir[1], uy = right.z * dir[0] - right.x * dir[2], uz = right.x * dir[1] - right.y * dir[0];
  const ul = Math.hypot(ux, uy, uz) || 1;
  up.x = ux / ul; up.y = uy / ul; up.z = uz / ul;
}

/** A ball of J2000 directions with the Milky Way picture's coordinates: u = 0.5 - RA/360, v = (90° - Dec)/180°. */
function skyBall(context: GlContext) {
  const nx = 96, ny = 48;
  const dir = new Float32Array((nx + 1) * (ny + 1) * 3), st = new Float32Array((nx + 1) * (ny + 1) * 2);
  for (let j = 0; j <= ny; j++) {
    const dec = (90 - (180 * j) / ny) * DEG, cd = Math.cos(dec), sd = Math.sin(dec);
    for (let i = 0; i <= nx; i++) {
      const ra = ((360 * i) / nx) * DEG, k = j * (nx + 1) + i;
      dir[3 * k] = cd * Math.cos(ra); dir[3 * k + 1] = cd * Math.sin(ra); dir[3 * k + 2] = sd;
      st[2 * k] = 0.5 - i / nx; st[2 * k + 1] = j / ny; // the texture repeats sideways, so u may run below 0
    }
  }
  const idx = new Uint16Array(nx * ny * 6);
  let n = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    idx[n++] = a; idx[n++] = c; idx[n++] = b; idx[n++] = b; idx[n++] = c; idx[n++] = d;
  }
  return createMesh(context, [{ name: 'a_dir', data: dir, size: 3 }, { name: 'a_st', data: st, size: 2 }], idx);
}
