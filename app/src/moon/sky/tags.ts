// Name tags for planets and bright stars. The words are drawn once into one small picture (an
// "atlas") and the GPU pastes pieces of it next to the stars, so tags cost nothing while the camera
// moves and are hidden by the Moon exactly like the stars they name.

export interface TagSpec { text: string; kind: 'planet' | 'star' }
export interface TagBox {
  /** Corner offsets from the anchor point, CSS pixels (y down). */
  x0: number; y0: number; x1: number; y1: number;
  /** Atlas texture coordinates of the same corners. */
  s0: number; t0: number; s1: number; t1: number;
}
export interface TagAtlas { canvas: HTMLCanvasElement; boxes: TagBox[]; scale: number }

const FONT = '"Google Sans Flex Variable", "Kantumruy Pro Variable", system-ui, -apple-system, sans-serif';
// Planet names are clear but quiet, like a sky atlas; star names are quieter still, and only the
// brightest few get one (the sky is full of stars, a name on each one would be noise).
const STYLE = {
  planet: { font: `500 11.5px ${FONT}`, color: 'rgba(255, 255, 255, 0.86)', gap: 8, spacing: '0.35px' },
  star: { font: `500 10.5px ${FONT}`, color: 'rgba(225, 232, 245, 0.56)', gap: 6, spacing: '0.3px' },
};
const STAR_NAMES = 7; // brightest stars that get a name (the list arrives brightest first)

/** Draw all tags at `scale` device pixels per CSS pixel. */
export function buildTagAtlas(specs: TagSpec[], scale: number): TagAtlas {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const pad = 4;
  let stars = 0;
  // a tag left blank stays in the list (the sky module counts on the order) but draws nothing
  const drawn = specs.map(s => s.kind === 'planet' || stars++ < STAR_NAMES);
  const setFont = (k: TagSpec['kind']) => { ctx.font = STYLE[k].font; (ctx as unknown as { letterSpacing: string }).letterSpacing = STYLE[k].spacing; };
  // measure: the text starts a little right of the anchor so it never covers the planet or star itself
  const sizes = specs.map((s, i) => {
    setFont(s.kind);
    const w = drawn[i] ? Math.ceil(STYLE[s.kind].gap + ctx.measureText(s.text).width + 2 * pad) : 2, h = 16 + 2 * pad;
    return { w, h };
  });
  // pack in rows
  const maxW = 512;
  let x = 0, y = 0, rowH = 0;
  const pos = sizes.map(sz => {
    if (x + sz.w > maxW) { x = 0; y += rowH; rowH = 0; }
    const p = { x, y };
    x += sz.w; rowH = Math.max(rowH, sz.h);
    return p;
  });
  const W = maxW, H = Math.max(1, y + rowH);
  canvas.width = Math.ceil(W * scale); canvas.height = Math.ceil(H * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.textBaseline = 'middle';
  const boxes: TagBox[] = specs.map((s, i) => {
    const sz = sizes[i], p = pos[i];
    const ax = p.x + pad, ay = p.y + sz.h / 2; // the anchor inside the atlas
    if (drawn[i]) {
      setFont(s.kind);
      // a soft dark shadow keeps the words readable over the Milky Way without a hard outline
      ctx.shadowColor = 'rgba(0, 0, 0, 0.9)'; ctx.shadowBlur = 4;
      ctx.fillStyle = STYLE[s.kind].color;
      ctx.fillText(s.text, ax + STYLE[s.kind].gap, ay + 0.5);
      ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
    }
    return {
      x0: p.x - ax, y0: p.y - ay, x1: p.x + sz.w - ax, y1: p.y + sz.h - ay,
      s0: p.x / W, t0: p.y / H, s1: (p.x + sz.w) / W, t1: (p.y + sz.h) / H,
    };
  });
  return { canvas, boxes, scale };
}

/** Six corners (two triangles) per tag: [cornerX, cornerY, s, t] each. */
export function tagBoxVertices(boxes: TagBox[]): Float32Array {
  const out = new Float32Array(boxes.length * 6 * 4);
  boxes.forEach((b, i) => {
    const c = [[b.x0, b.y0, b.s0, b.t0], [b.x1, b.y0, b.s1, b.t0], [b.x1, b.y1, b.s1, b.t1], [b.x0, b.y0, b.s0, b.t0], [b.x1, b.y1, b.s1, b.t1], [b.x0, b.y1, b.s0, b.t1]];
    c.forEach((v, k) => out.set(v, (i * 6 + k) * 4));
  });
  return out;
}
