// Place-name labels that behave like Google Earth:
// - only names big enough to matter at the current zoom are considered
// - more important names win (seas > mountains > craters > small features); special places always win
// - names never overlap and must fit fully on screen
// - a name already on screen keeps a bonus so it doesn't flicker when you move a little
// - names FADE in and out (about a quarter of a second) instead of popping
// - names on the far side of the Moon are hidden by a simple "is it facing me?" test

import { BillboardCollection, Cartesian2, Cartesian3, Color, HorizontalOrigin, LabelCollection, LabelStyle, SceneTransforms, VerticalOrigin, type Billboard, type Label, type Viewer } from 'cesium';
import type { MoonName } from '../data/names';
import type { Place } from '../data/places';
import type { MoonHeights } from '../science/heights';
import { toCartesian } from './frame';

interface Item {
  /** The drawn label. It only exists while the name is visible or fading: the Moon has 9,000 names, and keeping
   *  them all in the graphics buffer made every fade re-send the whole buffer to the graphics card. */
  label: Label | null;
  text: string; font: string; isPlace: boolean; id: unknown;
  pos: Cartesian3;
  unit: Cartesian3;
  sizeM: number; // real size of the feature in metres
  weight: number; // importance multiplier
  fixed: number; // >0: special place (2 = past mission, 3 = Artemis region / famous spot)
  kindOfPlace: Place['kind'] | null;
  w: number; h: number; // approx. label box in px
  fill: Color; outline: Color; // full-opacity colours
  alpha: number; // current opacity 0..1
  target: number; // where the fade is heading (0 or 1)
  // special places also have an icon, which can be shown without its name (it is hidden only if it would cover a more important one)
  icon: Billboard | null; iconAlpha: number; iconTarget: number; iconR: number;
  lat: number; lon: number; color: string; // true position and colour, for the flat map (flatMap.ts)
}

/** A name or place as the flat map needs it (it draws its own names: the Cesium labels live on the globe). */
export interface FlatLabel {
  text: string; font: string; color: string; lat: number; lon: number; sizeM: number; weight: number; fixed: number;
  kind: Place['kind'] | null; iconR: number; w: number; h: number; id: unknown;
}

/** What a special place looks like on the map: a picture and its size in CSS pixels. */
export interface PlaceIcon { image: string; size: number }
/** A screen rectangle (canvas CSS pixels) that names and icons must keep clear of. */
export interface Box { x0: number; y0: number; x1: number; y1: number }

const WEIGHT: Record<string, number> = {
  'Dark plain (sea)': 2.4, Ocean: 2.6, 'Dark plain (marsh)': 2.0, Bay: 2.0, 'Small dark plain': 1.6,
  Mountain: 1.5, Crater: 1.0, 'Small crater': 0.45,
};
export const MIN_PX = 30; // a feature must look at least this big on screen to get a name
export const MAX_LABELS = 60;
const FADE_S = 0.25;
const OUTLINE = Color.fromCssColorString('#05060a');
const HALO = 0.78; // the dark edge is a little see-through: it reads as a soft halo, not a hard outline
// The app's own typeface; it must be loaded before the first name is drawn, or the map keeps the stand-in font's letters.
const FONT = '"Google Sans Flex Variable", "Kantumruy Pro Variable", system-ui, sans-serif';
const HAIR = '\u200A';
/** Seas are written in widely spaced capitals, like on a printed map (labels here cannot set letter spacing). */
const tracked = (s: string) => [...s.toUpperCase()].join(HAIR).replace(new RegExp(`${HAIR} ${HAIR}`, 'g'), `${HAIR}  ${HAIR}`);
const HOVER = Color.fromCssColorString('#8ab4f8'); // Google-Earth blue when the pointer is over a name

export class NameLabels {
  private viewer: Viewer;
  private lc: LabelCollection;
  private bc: BillboardCollection;
  private icons: Partial<Record<Place['kind'], PlaceIcon>> = {};
  private items: Item[] = [];
  private fading = new Set<Item>();
  private iconFading = new Set<Item>();
  /** Things drawn by others (pins, Sun/Earth spots) that names and icons must not cover; asked on every update. */
  reserved: (() => Box[])[] = [];
  /** Screen margins (CSS px) covered by the page's top bar and time bar: nothing is placed there. */
  top = 64;
  bottom = 110;
  private lastTick = 0;
  private scratch = new Cartesian3();
  private win = new Cartesian2();
  private boxes = new Float64Array(4 * (MAX_LABELS + 120));
  /** What is clickable on screen right now (name boxes and place icons), newest placement last. */
  private hits: { x0: number; y0: number; x1: number; y1: number; id: unknown }[] = [];
  private removeTick: () => void;
  visible = true;
  private hovered: Item | null = null;
  placesVisible: Record<Place['kind'], boolean> = { artemis: true, mission: true, spot: true };

  constructor(viewer: Viewer) {
    this.viewer = viewer;
    this.bc = new BillboardCollection({ scene: viewer.scene });
    viewer.scene.primitives.add(this.bc);
    this.lc = new LabelCollection({ scene: viewer.scene });
    viewer.scene.primitives.add(this.lc);
    this.removeTick = viewer.scene.preRender.addEventListener(() => this.tick());
    // wait (at most 2 s) for the typeface, then place the names
    const fonts = ['500 12px', '600 13px'].map(w => document.fonts.load(`${w} "Google Sans Flex Variable"`).catch(() => {}));
    Promise.race([Promise.all(fonts), new Promise(r => setTimeout(r, 2000))]).then(() => {
      this.fontReady = true;
      if (!viewer.isDestroyed()) { this.update(); viewer.scene.requestRender(); }
    });
  }
  private fontReady = false;

  private add(text: string, lat: number, lon: number, heightM: number, sizeM: number, weight: number, fixed: number, kindOfPlace: Place['kind'] | null,
    style: { size: number; weight: number; color: string }, id: unknown) {
    const pos = toCartesian(lat, lon, heightM + 150);
    const fill = Color.fromCssColorString(style.color);
    const isPlace = kindOfPlace !== null;
    this.items.push({
      label: null, text, font: `${style.weight} ${style.size}px ${FONT}`, isPlace, id,
      pos, unit: Cartesian3.normalize(pos, new Cartesian3()), sizeM, weight, fixed, kindOfPlace,
      w: text.replaceAll(HAIR, '').length * style.size * (text.includes(HAIR) ? 0.8 : 0.6) + 10, h: style.size + 8, fill, outline: OUTLINE, alpha: 0, target: 0,
      icon: null, iconAlpha: 0, iconTarget: 0, iconR: 0, lat, lon, color: style.color,
    });
  }

  /** Create the drawn label for a name that is about to fade in. */
  private materialise(it: Item): Label {
    const label = this.lc.add({
      position: it.pos, text: it.text, show: false, font: it.font,
      fillColor: it.fill.withAlpha(0), outlineColor: OUTLINE.withAlpha(0), outlineWidth: 3,
      style: LabelStyle.FILL_AND_OUTLINE, horizontalOrigin: it.isPlace ? HorizontalOrigin.LEFT : HorizontalOrigin.CENTER,
      verticalOrigin: VerticalOrigin.CENTER, pixelOffset: it.isPlace ? new Cartesian2(it.iconR + 5, 0) : Cartesian2.ZERO,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    (label as unknown as { id: unknown }).id = it.id;
    it.label = label;
    return label;
  }

  setNames(names: MoonName[], heights: MoonHeights) {
    for (const n of names) {
      const weight = WEIGHT[n.kind] ?? (n.satellite ? 0.45 : 0.4); // channels, ridges, chains, valleys…
      const big = weight >= 1.6;
      // three clear steps: seas (spaced capitals) > big craters and mountains > small features
      const style = big ? { size: 13, weight: 500, color: '#dde4ee' } : weight >= 1 ? { size: 13, weight: 600, color: '#ffffff' } : { size: 12, weight: 500, color: '#d9dce2' };
      this.add(big ? tracked(n.name) : n.name, n.lat, n.lon, heights.heightAt(n.lat, n.lon, false), Math.max(1500, n.diameterKm * 1000), weight, 0, null,
        style, { moonda: { type: 'name', name: n } });
    }
  }

  setPlaces(places: Place[], heights: MoonHeights, icons: Partial<Record<Place['kind'], PlaceIcon>> = {}) {
    this.icons = icons;
    for (const p of places) {
      this.add(p.name, p.lat, p.lon, heights.heightAt(p.lat, p.lon, false), 0, 1, p.kind === 'mission' ? 2 : 3, p.kind,
        { size: 12, weight: 500, color: '#e9ebef' }, { moonda: { type: 'place', place: p } });
      const it = this.items[this.items.length - 1];
      it.iconR = (icons[p.kind]?.size ?? 24) / 2;
    }
  }

  /** Decide which names and icons should be visible for the current camera (they then fade in/out).
   *  Order of importance: pins and spots drawn by others > icons of special places > their names > crater names.
   *  Nothing is ever drawn on top of something more important. */
  update() {
    if (!this.fontReady) return;
    const scene = this.viewer.scene;
    const cam = this.viewer.camera;
    const camPos = cam.positionWC;
    const W = scene.canvas.clientWidth, H = scene.canvas.clientHeight;
    const fovy = (cam.frustum as unknown as { fovy?: number }).fovy ?? 1;
    const pxPerRad = H / fovy;
    const cand: { it: Item; score: number }[] = [];
    const iconCand: { it: Item; score: number }[] = [];
    for (const it of this.items) {
      let want = true, wantIcon = false;
      if (it.kindOfPlace === null) want = this.visible;
      else want = this.placesVisible[it.kindOfPlace];
      if (want) {
        const d = Cartesian3.subtract(camPos, it.pos, this.scratch);
        // far side of the Moon (with a small margin so things right on the edge do not flicker)
        if (Cartesian3.dot(d, it.unit) <= 0.02 * Cartesian3.magnitude(d)) want = false;
        else {
          const dist = Cartesian3.magnitude(d);
          if (it.fixed) {
            // icons: past landings from anywhere; the crowded south-pole regions only from closer than 3,200 km
            wantIcon = it.fixed === 2 || dist < 3.2e6;
            if (wantIcon) iconCand.push({ it, score: 1e6 * it.fixed - dist / 1000 + (it.iconTarget === 1 ? 5e5 : 0) });
            if ((it.fixed === 2 && dist > 4.5e6) || (it.fixed === 3 && dist > 1.4e6)) want = false;
            else cand.push({ it, score: 1e6 * it.fixed - dist / 1000 });
          } else {
            const score = (it.sizeM / dist) * pxPerRad * it.weight;
            if (score < MIN_PX) want = false;
            else cand.push({ it, score: score * (it.target === 1 ? 1.35 : 1) }); // hysteresis: keep what's shown
          }
        }
      }
      if (!want) this.setTarget(it, 0);
      if (!wantIcon) this.setIconTarget(it, 0);
    }
    let n = 0, placed = 0;
    this.hits.length = 0;
    const free = (x0: number, y0: number, x1: number, y1: number) => {
      for (let k = 0; k < n; k += 4) {
        if (x0 < this.boxes[k + 2] && x1 > this.boxes[k] && y0 < this.boxes[k + 3] && y1 > this.boxes[k + 1]) return false;
      }
      return true;
    };
    const take = (x0: number, y0: number, x1: number, y1: number) => {
      if (n + 4 > this.boxes.length) return;
      this.boxes[n] = x0; this.boxes[n + 1] = y0; this.boxes[n + 2] = x1; this.boxes[n + 3] = y1; n += 4;
    };
    // 1. pins and the Sun/Earth spots: always drawn, so everything else keeps clear of them
    for (const get of this.reserved) for (const b of get()) take(b.x0, b.y0, b.x1, b.y1);
    // 2. icons of special places, most important first; one that would cover another is hidden (with its name)
    iconCand.sort((a, b) => b.score - a.score);
    const iconOn = new Set<Item>();
    for (const { it } of iconCand) {
      const w = SceneTransforms.worldToWindowCoordinates(scene, it.pos, this.win);
      let ok = false;
      if (w && w.x > 0 && w.y > this.top - 10 && w.x < W && w.y < H - this.bottom + 10) {
        const r = it.iconR + 1;
        if (free(w.x - r, w.y - r, w.x + r, w.y + r)) {
          ok = true;
          take(w.x - r, w.y - r, w.x + r, w.y + r);
          iconOn.add(it);
          this.hits.push({ x0: w.x - r - 2, y0: w.y - r - 2, x1: w.x + r + 2, y1: w.y + r + 2, id: it.id });
        }
      }
      this.setIconTarget(it, ok ? 1 : 0);
    }
    // 3. names: special places (only next to a visible icon) first, then the rest by importance
    cand.sort((a, b) => b.score - a.score);
    for (const { it } of cand) {
      let ok = false;
      if ((placed < MAX_LABELS || it.fixed) && (!it.fixed || iconOn.has(it) || !this.icons[it.kindOfPlace!])) {
        const w = SceneTransforms.worldToWindowCoordinates(scene, it.pos, this.win);
        if (w) {
          const isPlace = it.kindOfPlace !== null;
          const x0 = isPlace ? w.x + it.iconR + 5 : w.x - it.w / 2, y0 = w.y - it.h / 2;
          const padL = isPlace ? 0 : 4; // a place's name starts right after its own icon
          if (x0 >= 4 && y0 >= this.top && x0 + it.w <= W - 4 && y0 + it.h <= H - this.bottom && free(x0 - padL, y0 - 2, x0 + it.w + 4, y0 + it.h + 2)) {
            ok = true;
            take(x0 - 4, y0 - 2, x0 + it.w + 4, y0 + it.h + 2);
            placed++;
            this.hits.push({ x0, y0, x1: x0 + it.w, y1: y0 + it.h, id: it.id });
          }
        }
      }
      this.setTarget(it, ok ? 1 : 0);
    }
    if (this.fading.size || this.iconFading.size) scene.requestRender();
  }

  /** Every name and place that the current switches allow (names on/off, place kinds), for the flat map. */
  flatEntries(): FlatLabel[] {
    const out: FlatLabel[] = [];
    for (const it of this.items) {
      if (it.kindOfPlace === null ? !this.flatNames : !this.flatPlaces[it.kindOfPlace]) continue;
      out.push({ text: it.text, font: it.font, color: it.color, lat: it.lat, lon: it.lon, sizeM: it.sizeM, weight: it.weight, fixed: it.fixed,
        kind: it.kindOfPlace, iconR: it.iconR, w: it.w, h: it.h, id: it.id });
    }
    return out;
  }
  /** The icon picture of a kind of place (the flat map draws the same ones). */
  iconOf(kind: Place['kind']): PlaceIcon | undefined { return this.icons[kind]; }
  /** What the switches say, kept apart from `visible` / `placesVisible` (those are turned off on the globe while the flat map shows). */
  flatNames = true;
  flatPlaces: Record<Place['kind'], boolean> = { artemis: true, mission: true, spot: true };

  /** The name or place under a screen position (canvas CSS pixels), or undefined. Pure maths: no GPU read-back. */
  hitTest(x: number, y: number): unknown {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) return h.id;
    }
    return undefined;
  }

  /** Pointer over a name or place (its id from hitTest), or null: that name turns blue, like Google Earth. */
  setHover(id: unknown) {
    const it = id === undefined || id === null ? null : this.items.find(i => i.id === id) ?? null;
    if (it === this.hovered) return;
    const old = this.hovered;
    this.hovered = it;
    for (const x of [old, it]) {
      if (x?.label) {
        const a = x.alpha * x.alpha * (3 - 2 * x.alpha);
        x.label.fillColor = Color.fromAlpha(x === it ? HOVER : x.fill, a);
      }
    }
    this.viewer.scene.requestRender();
  }

  private setTarget(it: Item, t: number) {
    if (it.target === t) return;
    it.target = t;
    if (it.alpha !== t) this.fading.add(it);
  }

  private setIconTarget(it: Item, t: number) {
    if (it.iconTarget === t) return;
    it.iconTarget = t;
    if (it.iconAlpha !== t) this.iconFading.add(it);
  }

  /** Runs before each frame: move every fading label a step closer to its target opacity. */
  private tick() {
    const now = performance.now();
    const dt = this.lastTick ? Math.min(0.1, (now - this.lastTick) / 1000) : 0.016;
    this.lastTick = now;
    if (!this.fading.size && !this.iconFading.size) return;
    const step = dt / FADE_S;
    for (const it of this.iconFading) {
      it.iconAlpha = it.iconTarget > it.iconAlpha ? Math.min(it.iconTarget, it.iconAlpha + step) : Math.max(it.iconTarget, it.iconAlpha - step);
      const a = it.iconAlpha * it.iconAlpha * (3 - 2 * it.iconAlpha);
      if (it.iconAlpha <= 0.001 && it.iconTarget === 0) {
        if (it.icon) { this.bc.remove(it.icon); it.icon = null; }
        it.iconAlpha = 0; this.iconFading.delete(it); continue;
      }
      if (!it.icon) {
        const look = this.icons[it.kindOfPlace!];
        if (!look) { this.iconFading.delete(it); continue; }
        it.icon = this.bc.add({ position: it.pos, image: look.image, width: look.size, height: look.size, disableDepthTestDistance: Number.POSITIVE_INFINITY, color: Color.WHITE.withAlpha(0) });
        (it.icon as unknown as { id: unknown }).id = it.id;
      }
      it.icon.color = Color.WHITE.withAlpha(a);
      if (it.iconAlpha === it.iconTarget) this.iconFading.delete(it);
    }
    for (const it of this.fading) {
      it.alpha = it.target > it.alpha ? Math.min(it.target, it.alpha + step) : Math.max(it.target, it.alpha - step);
      const a = it.alpha * it.alpha * (3 - 2 * it.alpha); // smoothstep easing
      if (it.alpha <= 0.001 && it.target === 0) { // fully faded out: take it out of the graphics buffer
        if (it.label) { this.lc.remove(it.label); it.label = null; }
        it.alpha = 0;
        this.fading.delete(it);
        continue;
      }
      const label = it.label ?? this.materialise(it);
      // new Color objects: Cesium only notices a change if the value it holds is replaced
      label.fillColor = Color.fromAlpha(it === this.hovered ? HOVER : it.fill, a);
      label.outlineColor = Color.fromAlpha(it.outline, a * HALO);
      label.show = true;
      if (it.alpha === it.target) this.fading.delete(it);
    }
    this.viewer.scene.requestRender(); // keep animating until every fade is finished
  }

  destroy() { this.removeTick(); this.viewer.scene.primitives.remove(this.lc); this.viewer.scene.primitives.remove(this.bc); }
}
