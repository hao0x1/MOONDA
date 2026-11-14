// Crater outlines still tell us where a bowl is when LOLA has only two or three height pixels across it.
// This is a conservative shape estimate, not a new height measurement. Keep it separate from LOLA so
// a crater that the 80 m map already resolves never gets its depth counted a second time.

export interface CatalogueFrame {
  toUV(lat: number, lon: number): [number, number];
  /** Ground metres per map metre. */
  scale(u: number, v: number): number;
}

export interface CatalogueBounds { u0: number; v0: number; u1: number; v1: number }

export interface CatalogueCrater {
  u: number; v: number;
  /** Radius in map metres, and rim-to-floor depth in ground metres. */
  radius: number; depthM: number;
  /** A pin is already in this bowl: its outline must not shut that pin off from the world. */
  endpointInside: boolean;
  groundScale: number;
}

export interface CatalogueSample {
  /** Estimated offset below the rim (m). Do not add this to already resolved LOLA heights. */
  heightM: number;
  /** Estimated gradient in ground metres per ground metre along the map's two axes. */
  gU: number; gV: number;
  /** With both pins outside, stay round the rim rather than invent a traversable breach in its wall. */
  blocked: boolean;
}

// Chappelow (2017), LPSC 1695, pp. 1-2, measured fresh simple mare craters and fitted hyperbolic
// profiles. For D=2.5..7 km the radial term is sqrt(1 + 56.794 r²/D²).
// https://www.hou.usra.edu/meetings/lpsc2017/pdf/1695.pdf
// We use that published SHAPE, normalised to the familiar d/D=0.20 fresh simple-crater envelope
// (Pike 1976; Bray et al. 2013, https://www.lpi.usra.edu/meetings/lpsc2013/pdf/2782.pdf).
// Its wall just below the rim is atan(0.4 * (1 + 1/sqrt(1 + 56.794/4))) = 26.7 degrees.
// An outline does not tell us its age, local slides or the position of a safe entry ramp. If a pin
// is inside, return the estimated height/gradient but let the measured terrain decide hard closure.
const HYPERBOLA_A = 56.794 / 4;
const HYPERBOLA_RIM = Math.sqrt(1 + HYPERBOLA_A);
const HYPERBOLA_SPAN = HYPERBOLA_RIM - 1;

/** Find only bowls whose shape is missing from the height grid; the list is biggest first. */
export async function buildCatalogueCraters(
  craters: Float32Array | null,
  frame: CatalogueFrame,
  bounds: CatalogueBounds,
  cellM: number,
  dataResM: number,
  fromUV: readonly [number, number],
  toUV: readonly [number, number],
  pause: () => Promise<void> = async () => {},
): Promise<CatalogueCrater[]> {
  const out: CatalogueCrater[] = [];
  if (!craters) return out;
  let slice = performance.now();
  // Six measured pixels across a bowl resolve its broad walls. A coarser route grid must not erase
  // that information either, so its cells also count in this test. Complex basins are not simple bowls.
  const unresolvedBelowM = 6 * Math.max(dataResM, cellM);
  for (let i = 0; i + 2 < craters.length; i += 3) {
    if (i % 1536 === 0 && performance.now() - slice >= 20) { await pause(); slice = performance.now(); }
    const diameterM = craters[i + 2] * 1000;
    if (diameterM < cellM * 1.5) break;
    if (diameterM >= unresolvedBelowM || diameterM > 15000) continue;
    const [u, v] = frame.toUV(craters[i], craters[i + 1]);
    const groundScale = frame.scale(u, v), radius = diameterM * 0.5 / groundScale;
    if (u + radius < bounds.u0 || u - radius > bounds.u1 || v + radius < bounds.v0 || v - radius > bounds.v1) continue;
    const endpointInside = Math.hypot(fromUV[0] - u, fromUV[1] - v) < radius
      || Math.hypot(toUV[0] - u, toUV[1] - v) < radius;
    out.push({ u, v, radius, depthM: diameterM * 0.2, endpointInside, groundScale });
  }
  return out;
}

/** Analytic bowl shape at a point. The deepest overlapping estimate wins rather than adding bowls. */
export function catalogueAt(craters: readonly CatalogueCrater[], u: number, v: number): CatalogueSample {
  let heightM = 0, gU = 0, gV = 0, blocked = false;
  for (const c of craters) {
    const du = u - c.u, dv = v - c.v, r2 = du * du + dv * dv;
    if (r2 >= c.radius * c.radius) continue;
    if (!c.endpointInside) blocked = true;
    const x2 = r2 / (c.radius * c.radius), root = Math.sqrt(1 + HYPERBOLA_A * x2);
    const h = -c.depthM * (HYPERBOLA_RIM - root) / HYPERBOLA_SPAN;
    if (h < heightM) {
      heightM = h;
      const factor = c.depthM * HYPERBOLA_A / (c.radius * c.radius * root * HYPERBOLA_SPAN * c.groundScale);
      gU = du * factor; gV = dv * factor;
    }
  }
  return { heightM, gU, gV, blocked };
}
