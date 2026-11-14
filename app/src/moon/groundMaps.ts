// Small helpers for the ground shader's maps (see lander.ts, GROUND_SHADER). Kept apart so the shader's
// inputs can change without touching the rest of the Stand-here view.

/** float -> IEEE half (bits), round to nearest. */
function toHalf(v: number): number {
  const f = new Float32Array([v]), i = new Uint32Array(f.buffer)[0];
  const s = (i >>> 16) & 0x8000, e = ((i >>> 23) & 0xff) - 127 + 15, m = i & 0x7fffff;
  if (e <= 0) return s; // tiny: zero (slopes this small do not show)
  if (e >= 31) return s | 0x7bff; // huge: the largest half
  return s | (e << 10) | ((m + 0x1000) >> 13);
}

/**
 * The ground's slope (east, north; metres per metre) at every cell of a north-aligned height grid, as a half-float
 * RGBA picture the GPU can blend. One blended read of it gives exactly what four blended height reads 80 m apart
 * gave before (sixteen fetches): the slope of a bilinear height field over +-1 cell is the bilinear blend of the
 * per-cell central differences. Missing heights (<= -1e6) are clamped to the range of the valid ones.
 */
export function slopePicture(grid: Float32Array | Float64Array, size: number, cellM: number): Uint16Array | null {
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < grid.length; k++) { const z = grid[k]; if (z > -1e6) { if (z < lo) lo = z; if (z > hi) hi = z; } }
  if (!(hi >= lo)) return null;
  const h = (r: number, c: number) => {
    const z = grid[Math.min(size - 1, Math.max(0, r)) * size + Math.min(size - 1, Math.max(0, c))];
    return z < lo ? lo : z > hi ? hi : z;
  };
  const out = new Uint16Array(size * size * 4), one = toHalf(1), k2 = 1 / (2 * cellM);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const o = 4 * (r * size + c);
      out[o] = toHalf((h(r, c + 1) - h(r, c - 1)) * k2);
      out[o + 1] = toHalf((h(r + 1, c) - h(r - 1, c)) * k2);
      out[o + 3] = one;
    }
  }
  return out;
}
