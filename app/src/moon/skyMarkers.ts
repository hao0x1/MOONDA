// Helpers on the map view:
// - the name of the real Sun and Earth, as quiet text under the body (they are drawn in 3D by ./sky);
//   when one of them is off screen or behind the Moon it becomes a small chip (real photo + name + a
//   fine arrow pointing the true way) at the edge of the free part of the screen.
//   Clicking a chip glides the camera to a view where that body shows above the Moon's edge.
// - optional (layer "Sun-overhead and Earth-overhead spots"): the spot on the Moon where the Sun is
//   straight up (noon point) and where Earth is straight up. Handy to check the lighting: the bright
//   side of the Moon is centred on "Sun overhead".

import { Cartesian2, Cartesian3, Color, LabelStyle, VerticalOrigin, type Entity, type Viewer } from 'cesium';
import { onLangChange, t } from '../i18n';
import { EARTH_URL, SUN_URL } from '../ui/glyphs';
import { MOON_R, toTrueLatLon, trueToDisplayVec, type V3 } from './frame';
import './sky/markers.css';

// A fine arrow pointing up; it is turned to point the true way to the body.
const ARROW_SVG = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M6 10.4V1.8M2.6 5.2 6 1.8l3.4 3.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// Page parts the edge chips must keep clear of (anything hugging a screen edge counts).
const OBSTACLES = '.topbar > *, .panel, .map-controls, .timebar, .time-bar, .legend-float';
const CHIP_H = 28;

type State = 'visible' | 'behind' | 'edge' | 'off';
interface Chip { el: HTMLDivElement; arrow: HTMLSpanElement; text: HTMLSpanElement; body: 'sun' | 'earth'; pos: Cartesian3; radius: number; state: State; label: string; x: number; y: number; ang: number; w: number }

const scratchV = new Cartesian3(), scratchM = new Cartesian3(), scratchW = new Cartesian2();

export class SkyMarkers {
  private viewer: Viewer;
  private sunPoint: Entity;
  private earthPoint: Entity;
  private layer: HTMLDivElement;
  private chips: Chip[];
  private removePost: () => void;
  private visible = true;
  private spotsOn = false;
  private onPick: ((body: 'sun' | 'earth', dir: Cartesian3) => void) | null;
  private free = { top: 92, left: 64, right: 1e4, bottom: 1e4 };
  private freeRead = -1e9;
  private offLang: () => void;

  constructor(viewer: Viewer, opts: { onPick?: (body: 'sun' | 'earth', dir: Cartesian3) => void } = {}) {
    this.viewer = viewer;
    this.onPick = opts.onPick ?? null;
    // Drawn on top of everything (no depth test) and hidden by hand when the spot is on the far side,
    // so a label is never half cut off by the Moon's edge.
    const label = (text: string) => ({
      text, font: '500 12px "Google Sans Flex Variable", system-ui, sans-serif', fillColor: Color.WHITE.withAlpha(0.86), outlineColor: Color.fromCssColorString('#05060a').withAlpha(0.8), outlineWidth: 3,
      style: LabelStyle.FILL_AND_OUTLINE, verticalOrigin: VerticalOrigin.TOP, pixelOffset: new Cartesian2(0, 14),
      disableDepthTestDistance: Number.POSITIVE_INFINITY, show: false,
    });
    // the spot is marked with the real photo of the body, small, like everywhere else in the app
    const spot = (image: string, text: string) => viewer.entities.add({
      position: Cartesian3.UNIT_X, show: false,
      billboard: { image, width: 18, height: 18, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: label(text),
    });
    this.sunPoint = spot(SUN_URL, t('markers.sunOverhead'));
    this.earthPoint = spot(EARTH_URL, t('markers.earthOverhead'));

    this.layer = document.createElement('div');
    this.layer.className = 'skym-layer';
    const mk = (body: 'sun' | 'earth'): Chip => {
      const el = document.createElement('div'); el.className = `skym skym-${body}`; el.dataset.state = 'off';
      el.addEventListener('click', () => {
        const c = this.chips.find(k => k.el === el);
        if (c && c.radius) this.onPick?.(body, Cartesian3.normalize(c.pos, new Cartesian3()));
      });
      const arrow = document.createElement('span'); arrow.className = 'skym-arrow'; arrow.innerHTML = ARROW_SVG;
      const img = document.createElement('img'); img.className = 'skym-photo'; img.src = body === 'sun' ? SUN_URL : EARTH_URL; img.alt = ''; img.draggable = false;
      const text = document.createElement('span'); text.className = 'skym-text';
      el.append(arrow, img, text); this.layer.append(el);
      return { el, arrow, text, body, pos: new Cartesian3(), radius: 0, state: 'off', label: '', x: NaN, y: NaN, ang: NaN, w: 0 };
    };
    this.chips = [mk('sun'), mk('earth')];
    const words = () => {
      for (const c of this.chips) { c.el.title = t(c.body === 'sun' ? 'markers.showSun' : 'markers.showEarth'); c.label = ''; }
      this.sunPoint.label!.text = t('markers.sunOverhead') as never;
      this.earthPoint.label!.text = t('markers.earthOverhead') as never;
      this.viewer.scene.requestRender();
    };
    words();
    this.offLang = onLangChange(words);
    (viewer.container as HTMLElement).append(this.layer);
    this.removePost = viewer.scene.postRender.addEventListener(() => this.place());
    // panels open and close while the map stands still (no frames drawn): look again once a second
    this.timer = window.setInterval(() => { this.freeRead = -1e9; this.place(); }, 1000);
  }
  private timer: number;

  /** The Sun and Earth chips (and arrows). */
  get show() { return this.visible; }
  set show(v: boolean) {
    this.visible = v;
    this.layer.style.display = v ? '' : 'none';
    this.placeSpots();
    this.viewer.scene.requestRender();
  }

  /** The optional "Sun overhead" / "Earth overhead" spots on the ground. */
  get spots() { return this.spotsOn; }
  set spots(v: boolean) { this.spotsOn = v; this.placeSpots(); this.viewer.scene.requestRender(); }

  /** Screen boxes of the overhead spots now on screen (so place names can keep clear of them). */
  spotBoxes(): { x0: number; y0: number; x1: number; y1: number }[] {
    const out: { x0: number; y0: number; x1: number; y1: number }[] = [];
    if (!this.visible) return out;
    // the Sun / Earth chips themselves
    for (const c of this.chips) {
      if (c.state === 'off' || !Number.isFinite(c.x)) continue;
      const w = c.w || 80, h = c.state === 'visible' ? 18 : CHIP_H;
      const y0 = c.state === 'visible' ? c.y : c.y - h / 2;
      out.push({ x0: c.x - w / 2 - 4, y0: y0 - 3, x1: c.x + w / 2 + 4, y1: y0 + h + 3 });
    }
    if (!this.spotsOn) return out;
    for (const e of [this.sunPoint, this.earthPoint]) {
      if (!e.show) continue;
      const p = (e.position as unknown as { getValue(t?: unknown): Cartesian3 }).getValue();
      const w = this.viewer.scene.cartesianToCanvasCoordinates(p, scratchW);
      if (w) out.push({ x0: w.x - 46, y0: w.y - 15, x1: w.x + 46, y1: w.y + 32 });
    }
    return out;
  }

  /** Show a spot only while it faces the camera (we draw it over everything, so the far side must be hidden by hand). */
  private placeSpots() {
    const cam = this.viewer.camera.positionWC;
    for (const e of [this.sunPoint, this.earthPoint]) {
      const p = (e.position as unknown as { getValue(t?: unknown): Cartesian3 }).getValue();
      const facing = Cartesian3.dot(Cartesian3.subtract(cam, p, scratchM), p) > 0;
      const show = this.visible && this.spotsOn && facing;
      if (e.show !== show) e.show = show;
    }
  }

  /** sunTrue / earthTrue: positions from the Moon's centre in the TRUE Moon frame (metres). */
  update(sunTrue: V3, earthTrue: V3) {
    const s = trueToDisplayVec(sunTrue), e = trueToDisplayVec(earthTrue);
    const sun = new Cartesian3(s[0], s[1], s[2]), earth = new Cartesian3(e[0], e[1], e[2]);
    const sHat = Cartesian3.normalize(sun, new Cartesian3()), eHat = Cartesian3.normalize(earth, new Cartesian3());
    (this.sunPoint.position as unknown as { setValue(p: Cartesian3): void }).setValue(Cartesian3.multiplyByScalar(sHat, MOON_R, new Cartesian3()));
    (this.earthPoint.position as unknown as { setValue(p: Cartesian3): void }).setValue(Cartesian3.multiplyByScalar(eHat, MOON_R, new Cartesian3()));
    Cartesian3.clone(sun, this.chips[0].pos); this.chips[0].radius = 695700e3;
    Cartesian3.clone(earth, this.chips[1].pos); this.chips[1].radius = 6371e3;
    this.place();
    this.viewer.scene.requestRender();
  }

  /** The part of the map not covered by the page's bars and panels (canvas CSS pixels). Read twice a
   *  second, not every frame: asking the page for sizes is slow. */
  private freeArea(W: number, H: number) {
    const now = performance.now();
    if (now - this.freeRead < 500) return this.free;
    this.freeRead = now;
    const box = this.viewer.scene.canvas.getBoundingClientRect();
    const f = { top: 12, left: 12, right: W - 12, bottom: H - 12 };
    for (const el of document.querySelectorAll<HTMLElement>(OBSTACLES)) {
      if (this.layer.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const x0 = r.left - box.left, y0 = r.top - box.top, x1 = r.right - box.left, y1 = r.bottom - box.top;
      // push in the screen edge this thing hugs; things floating in the middle (pop-ups) do not count
      const gaps = [y0, x0, W - x1, H - y1];
      const near = Math.min(...gaps);
      // the column of map buttons always counts, also when it has moved left of an open panel
      const buttons = el.classList.contains('map-controls');
      if (near > 40 && !buttons) continue;
      // a wide bar belongs to the top or bottom, a tall one to a side, anything else to its nearest edge
      const side = buttons ? 2 : r.width > W / 2 ? (gaps[0] < gaps[3] ? 0 : 3) : r.height > H / 2 ? (gaps[1] < gaps[2] ? 1 : 2) : gaps.indexOf(near);
      if (side === 0) f.top = Math.max(f.top, y1 + 8);
      else if (side === 1) f.left = Math.max(f.left, x1 + 8);
      else if (side === 2) f.right = Math.min(f.right, x0 - 8);
      else f.bottom = Math.min(f.bottom, y0 - 8);
    }
    // never squeeze the free area to nothing (a very small window)
    if (f.right - f.left < 200) { f.left = 12; f.right = W - 12; }
    if (f.bottom - f.top < 120) { f.top = 12; f.bottom = H - 12; }
    this.free = f;
    return f;
  }

  /** After every drawn frame: put the two chips where the Sun and the Earth are (screen-space maths only). */
  private place() {
    this.placeSpots();
    if (!this.visible) return;
    const cam = this.viewer.camera, canvas = this.viewer.scene.canvas;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const focal = (H / 2) / Math.tan((cam.frustum as unknown as { fovy: number }).fovy / 2);
    const camPos = cam.positionWC;
    const { top, bottom, left, right } = this.freeArea(W, H);
    for (const c of this.chips) {
      if (!c.radius) continue;
      const v = Cartesian3.subtract(c.pos, camPos, scratchV);
      const dist = Cartesian3.magnitude(v);
      const cx = Cartesian3.dot(v, cam.rightWC), cy = Cartesian3.dot(v, cam.upWC), cz = Cartesian3.dot(v, cam.directionWC);
      // hidden behind the Moon? (the line of sight passes through the Moon's ball)
      const toMoon = Cartesian3.negate(camPos, scratchM);
      const along = Cartesian3.dot(toMoon, v) / dist;
      const closest = Math.sqrt(Math.max(0, Cartesian3.magnitudeSquared(toMoon) - along * along));
      const behindMoon = along > 0 && closest < MOON_R * 0.998;
      let x = W / 2 + (cx / cz) * focal, y = H / 2 - (cy / cz) * focal;
      const radiusPx = Math.asin(Math.min(1, c.radius / dist)) * focal;
      const onScreen = cz > 0 && x > left && x < right && y > top && y + radiusPx + 24 < bottom;
      const name = t(c.body === 'sun' ? 'markers.sun' : 'markers.earth');
      let state: State, label = name, ang = 0;
      if (onScreen && !behindMoon) {
        state = 'visible';
        y += Math.max(radiusPx, 5) + 6; // the name hangs just under the body
      } else {
        // a chip with an arrow, on the edge of the free area, on the line from the middle towards the body
        state = onScreen ? 'behind' : 'edge';
        if (behindMoon) label = t('markers.behind', { name });
        ang = Math.atan2(-cy, cx);
        if (state === 'edge') {
          const hw = (c.w || 90) / 2 + 2, hh = CHIP_H / 2 + 2;
          const mx = (left + right) / 2, my = (top + bottom) / 2, rx = Math.max(10, (right - left) / 2 - hw), ry = Math.max(10, (bottom - top) / 2 - hh);
          const k = Math.min(Math.abs(rx / Math.cos(ang)) || Infinity, Math.abs(ry / Math.sin(ang)) || Infinity);
          x = mx + Math.cos(ang) * k; y = my + Math.sin(ang) * k;
        }
      }
      if (c.label !== label) { c.label = label; c.text.textContent = label; c.w = 0; }
      if (c.state !== state) { c.state = state; c.el.dataset.state = state; c.w = 0; }
      if (!c.w) c.w = c.el.offsetWidth; // only after the words or the look changed
      // touch the page only when something really changed
      if (!(Math.abs(c.x - x) < 0.05 && Math.abs(c.y - y) < 0.05) || c.el.dataset.placed !== state) {
        c.x = x; c.y = y; c.el.dataset.placed = state;
        c.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, ${state === 'visible' ? '0' : '-50%'})`;
      }
      if (state !== 'visible' && !(Math.abs(c.ang - ang) < 0.002)) { c.ang = ang; c.arrow.style.transform = `rotate(${(ang + Math.PI / 2).toFixed(3)}rad)`; }
    }
  }

  /** For debugging/tests: the true lat/lon of the noon point. */
  subSolarTrue(): { lat: number; lon: number } {
    const p = (this.sunPoint.position as unknown as { getValue(t?: unknown): Cartesian3 }).getValue();
    return toTrueLatLon(p);
  }

  destroy() {
    this.removePost();
    this.offLang();
    clearInterval(this.timer);
    this.layer.remove();
    for (const e of [this.sunPoint, this.earthPoint]) this.viewer.entities.remove(e);
  }
}
