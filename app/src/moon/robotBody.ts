// MOONDA's body clearance for bumping into rocks (walk.ts). Measurements come from the decoded,
// world-space triangles of app/public/lander/rover/rover-moonda.glb, in model metres. Forward is +Z,
// right is -X and height is +Y; walk.ts applies ROBOT_SCALE when it uses these zones.
//
// The old outline borrowed the coarse balls used for shadows. Their radius pushed the underside
// down by several centimetres, so a narrow rock that fitted between the wheels still stopped the
// rover. The real belly is flat at Y = 0.674466 model m (33.72 cm at our half scale). The low wheel
// linkages sit outboard of that clear central passage. Tyres have their own six contacts in walk.ts.

/** A finite part's plan and its lowest height (model m). `round` softens its plan corners. */
export interface BodyZone {
  f0: number; f1: number; r0: number; r1: number; y: number; round: number;
  /** An outer wheel linkage follows that wheel's lift; inner joints stay with the body. */
  wheel?: number;
}

// Triangle-clipped minima of the suspension's six outboard regions. These small rectangles
// conservatively cover each linkage, without turning the space between the wheels into a wall.
// Store positive lateral distances, then emit left and right; right-side wheel numbers add three.
const LINKAGES: readonly BodyZone[] = [
  { f0: -1.32, f1: -0.80, r0: 0.50, r1: 0.80, y: 0.306262, round: 0.02 },
  { f0: -1.32, f1: -0.80, r0: 0.80, r1: 1.18, y: 0.223332, round: 0.02, wheel: 2 },
  { f0: -0.80, f1: 0.40, r0: 0.50, r1: 0.80, y: 0.587778, round: 0.02 },
  { f0: -0.80, f1: 0.40, r0: 0.80, r1: 1.18, y: 0.216704, round: 0.02, wheel: 1 },
  { f0: 0.40, f1: 1.26, r0: 0.50, r1: 0.80, y: 0.298582, round: 0.02 },
  { f0: 0.40, f1: 1.26, r0: 0.80, r1: 1.18, y: 0.223332, round: 0.02, wheel: 0 },
];

export const BODY_ZONES: readonly BodyZone[] = [
  // Main body. Its central 25 cm strip has this same underside all along its length at half scale.
  { f0: -1.178493, f1: 0.902966, r0: -0.773905, r1: 0.773864, y: 0.674466, round: 0.02 },
  // Rear power unit (RTG), rear ground radar (RIMFAX), then the small front-camera cover.
  { f0: -1.736322, f1: -0.762148, r0: -0.574993, r1: 0.574993, y: 0.690471, round: 0.02 },
  { f0: -1.246993, f1: -0.864673, r0: -0.306497, r1: 0.306497, y: 0.676544, round: 0.02 },
  { f0: 0.886766, f1: 0.987597, r0: -0.128720, r1: 0.282717, y: 0.617422, round: 0.02 },
  ...LINKAGES.flatMap(zone => [
    { ...zone, r0: -zone.r1, r1: -zone.r0 },
    { ...zone, wheel: zone.wheel === undefined ? undefined : zone.wheel + 3 },
  ]),
];

/** A broad check only: include every zone and the outer corners of all six tyres (model m). */
export const BODY_REACH = BODY_ZONES.reduce((reach, zone) => Math.max(reach,
  Math.hypot(Math.max(Math.abs(zone.f0), Math.abs(zone.f1)), Math.max(Math.abs(zone.r0), Math.abs(zone.r1))) + zone.round), 1.90);

/** The rock's radius at height y over its ground (m). `pow` is how rounded it is (measured per stone, rockOutline.ts). */
export function rockRadiusAt(r: number, h: number, y: number, pow = 3): number {
  if (y <= 0) return r;
  if (y >= h) return 0;
  return r * Math.pow(1 - Math.pow(y / h, pow), 1 / pow);
}

/** The rock's top (m over its ground) at distance d from its middle (m). */
export function rockTopAt(r: number, h: number, d: number, pow = 3): number {
  if (d >= r) return 0;
  return h * Math.pow(1 - Math.pow(d / r, pow), 1 / pow);
}
