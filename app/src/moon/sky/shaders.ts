// The small GPU programs that paint the sky. Shared ideas:
//
// - Everything is a DIRECTION from the eye, never a distance: `czm_viewRotation` turns a world
//   direction into the eye's frame, `czm_projection` puts it on the screen, and depth is forced
//   to 0 so nothing is ever cut off by the near or far plane. Sizes are real angles, so they stay
//   true at any field of view (map view 60°, lander lens 20°–90°).
// - The sky is painted before the Moon, with no depth test: the Moon then paints over it, which
//   hides exactly what is behind the ground.
// - `u_rot` turns a J2000 star-catalogue direction into the scene's (display) frame for the time
//   on the time bar. Stars, Milky Way, planets and name tags share it.

const TO_SCREEN = `
vec4 skyToScreen(vec3 worldDir) {
  vec4 clip = czm_projection * vec4(czm_viewRotation * worldDir, 1.0);
  clip.z = 0.0;
  return clip;
}
`;

// ---- Milky Way: a soft panorama on a big ball around the eye -----------------------------------
export const MILKY_VS = `
in vec3 a_dir;
in vec2 a_st;
uniform mat3 u_rot;
out vec2 v_st;
${TO_SCREEN}
void main() {
  gl_Position = skyToScreen(u_rot * a_dir);
  v_st = a_st;
}
`;
export const MILKY_FS = `
uniform sampler2D u_tex;
uniform vec4 u_tone; // x: black point, y: gain, z: colour strength, w: how much fine star-dust grain to keep (0..1)
in vec2 v_st;
vec3 decode(vec3 c) { return pow(c, vec3(2.2)) * 0.25; } // undo the file's encoding (data-prep/space/milkyway.py)
void main() {
  // The map is made of millions of faint stars; drawn 1:1 it looks like camera noise. Read it blurred
  // (a soft glow with the dust lanes intact) and add back only a little of the fine grain.
  vec2 texel = v_st * vec2(textureSize(u_tex, 0));
  float lod = max(0.5 * log2(max(dot(dFdx(texel), dFdx(texel)), dot(dFdy(texel), dFdy(texel)))), 0.0);
  vec3 soft = decode(textureLod(u_tex, v_st, lod + 2.6).rgb); // always at least 2.6 levels blurred, also when zoomed in
  vec3 fine = decode(texture(u_tex, v_st).rgb);
  vec3 lin = mix(soft, fine, u_tone.w);
  lin = max(lin - u_tone.x, 0.0);                // the sky between the stars goes to black
  float lum = dot(lin, vec3(0.2126, 0.7152, 0.0722));
  lin *= u_tone.y * pow(max(lum, 1e-6) / 0.03, 0.45); // more contrast: the bright band stands out, the faint outskirts stay dim
  float l = dot(lin, vec3(0.2126, 0.7152, 0.0722));
  lin = max(mix(vec3(l), lin, u_tone.z), 0.0);
  lin = 1.0 - exp(-lin);                         // soft shoulder: the bright centre of the galaxy never burns out
  out_FragColor = vec4(pow(lin, vec3(1.0 / 2.2)) + vec3(0.008, 0.010, 0.018), 1.0);
}
`;

// ---- Stars and planets: crisp round points, size and brightness from magnitude ------------------
export const STAR_VS = `
in vec4 a_dirMag;  // xyz: J2000 direction, w: magnitude (smaller = brighter)
in vec4 a_color;
uniform mat3 u_rot;
uniform vec3 u_star; // x: brightness, y: lens boost (a narrow lens shows fainter stars), z: device pixels per CSS pixel
out vec4 v_color;
out float v_big;
${TO_SCREEN}
void main() {
  gl_Position = skyToScreen(u_rot * a_dirMag.xyz);
  float e = pow(10.0, -0.2 * a_dirMag.w) * u_star.x * u_star.y; // square root of the light: mag 0 -> 1, mag 5 -> 0.1
  float size = 3.0 + 10.5 * min(e, 2.2);                       // sprite width in CSS pixels: faint 3.5, Vega 13, Sirius 23
  gl_PointSize = size * u_star.z;
  v_big = smoothstep(3.5, 12.0, size);
  v_color = vec4(a_color.rgb * min(1.0, 0.30 * min(1.0, u_star.x * 3.0) + 2.0 * e), 1.0);
}
`;
export const STAR_FS = `
in vec4 v_color;
in float v_big;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  float core = exp(-r2 * mix(4.0, 9.0, v_big));    // a tight point…
  float halo = v_big * 0.30 * exp(-r2 * 2.6);      // …and, for bright stars, a soft glow in the star's colour
  vec3 c = v_color.rgb * (core + halo) + vec3(0.55 * v_big) * core * core; // white-hot centre
  out_FragColor = vec4(c * (1.0 - smoothstep(0.7, 1.0, r2)), 1.0);
}
`;

// ---- A flat card that always faces the eye, centred on a direction (Sun, Earth) -------------------
const CARD_VS = `
in vec2 a_corner;
uniform vec3 u_center; // unit direction to the body (world)
uniform vec3 u_right;
uniform vec3 u_up;
uniform float u_tanHalf; // half-size of the card as tan(angle)
out vec2 v_uv;
${TO_SCREEN}
void main() {
  gl_Position = skyToScreen(u_center + (a_corner.x * u_right + a_corner.y * u_up) * u_tanHalf);
  v_uv = a_corner;
}
`;

// ---- Sun: true-size white disc + the glare a camera (or an eye) adds around it -------------------
export const SUN_VS = CARD_VS;
export const SUN_FS = `
in vec2 v_uv;
uniform vec4 u_sun; // x: disc radius as a fraction of the card, y: visible part of the disc 0..1, z: glare strength, w: spin of the rays
void main() {
  float r = length(v_uv);
  float d = r / u_sun.x;                          // distance from the centre in Sun radii
  float px = fwidth(d);
  float disc = 1.0 - smoothstep(1.0 - px, 1.0 + px, d);
  float x = max(d - 1.0, 0.0);                    // Sun radii beyond the edge of the disc
  float edge = 1.0 - smoothstep(0.5, 1.0, r);     // everything fades out before the card ends
  // what a camera adds: light spilling around the disc (hot and tight, then a wide soft glow)…
  float bloom = 0.9 * exp(-0.8 * x) + 0.5 * exp(-0.22 * x) + 0.30 / (1.0 + x * x / 48.0);
  // …and thin rays from the lens: six long ones, six short ones in between
  float a = atan(v_uv.y, v_uv.x) + u_sun.w;
  float rays = pow(abs(cos(3.0 * a)), 220.0) * exp(-3.4 * r) + 0.4 * pow(abs(sin(3.0 * a)), 500.0) * exp(-7.0 * r);
  rays *= 0.6 * smoothstep(0.0, 3.0, x);
  vec3 glare = vec3(1.0, 0.94, 0.82) * bloom + vec3(1.0, 0.95, 0.86) * rays;
  vec3 c = vec3(1.0, 0.995, 0.96) * disc + glare * edge * u_sun.y * u_sun.z;
  out_FragColor = vec4(c, 1.0);
}
`;

// ---- Earth: a real lit ball, ray-traced on a card ---------------------------------------------------
export const EARTH_VS = CARD_VS;
export const EARTH_FS = `
in vec2 v_uv;
uniform vec3 u_center;
uniform vec3 u_right;
uniform vec3 u_up;
uniform float u_tanHalf;
uniform vec3 u_sunDir;         // from the Earth towards the Sun (world, unit)
uniform vec3 u_earth;          // x: distance in Earth radii, y: strength of the city lights, z: cloud amount
uniform mat3 u_earthFromWorld; // world direction -> Earth's own map frame (x through Greenwich, z through the north pole)
uniform sampler2D u_day;
uniform sampler2D u_night;
uniform sampler2D u_clouds;

const float PI = 3.141592653589793;
const vec3 AIR = vec3(0.10, 0.30, 1.0);

void main() {
  float D = u_earth.x;
  vec2 q = v_uv * u_tanHalf * D;                   // where this sight line crosses the plane through Earth's centre (Earth radii)
  vec3 rd = normalize(vec3(q, -D));                // sight line; the eye is at (0, 0, D), x = right, y = up, z = towards the eye
  float along = -D * rd.z;                         // distance along the line to the point closest to Earth's centre
  float miss2 = max(D * D - along * along, 0.0);   // (closest distance)^2
  float miss = sqrt(miss2);
  float aa = max(fwidth(miss), 1e-5);
  float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, miss);

  // the point of the ball we see (for sight lines just outside: the nearest point of the limb)
  vec3 p = vec3(0.0, 0.0, D) + rd * (along - sqrt(max(1.0 - miss2, 0.0)));
  vec3 toEye = -u_center;
  vec3 n = normalize(u_right * p.x + u_up * p.y + toEye * p.z);

  // latitude / longitude on the Earth, then the three maps (two look-ups each, so the 180° seam never shows)
  vec3 ne = u_earthFromWorld * n;
  float lat = asin(clamp(ne.z, -1.0, 1.0));
  float v = 0.5 - lat / PI;
  float u1 = atan(ne.y, ne.x) / (2.0 * PI) + 0.5;
  float u2 = fract(u1 + 0.5) - 0.5;
  bool first = fwidth(u1) <= fwidth(u2);
  vec3 dayA = texture(u_day, vec2(u1, v)).rgb, dayB = texture(u_day, vec2(u2, v)).rgb;
  float nightA = texture(u_night, vec2(u1, v)).r, nightB = texture(u_night, vec2(u2, v)).r;
  float cloudA = texture(u_clouds, vec2(u1, v)).r, cloudB = texture(u_clouds, vec2(u2, v)).r;
  vec3 day = first ? dayA : dayB;
  float lights = first ? nightA : nightB;
  float cloud = smoothstep(0.06, 0.85, first ? cloudA : cloudB) * u_earth.z;

  float mu = dot(n, u_sunDir);                      // 1 = Sun overhead there, 0 = sunrise/sunset line
  float dayAmt = smoothstep(-0.12, 0.20, mu);       // soft edge between day and night (the air scatters light past it)
  float light = 0.92 * max(mu, 0.0) + 0.08 * smoothstep(-0.10, 0.12, mu); // brightest under the Sun, fading to a thin twilight
  vec3 albedo = pow(day, vec3(2.2));
  float water = smoothstep(1.2, 1.9, day.b / (day.r + 0.02));
  float facing = clamp(dot(n, toEye), 0.0, 1.0);
  float rim = pow(1.0 - facing, 2.5);

  vec3 surf = albedo * light * 1.25;
  vec3 halfway = normalize(u_sunDir + toEye);
  surf += vec3(1.0, 0.93, 0.78) * pow(max(dot(n, halfway), 0.0), 110.0) * water * (1.0 - cloud) * 0.5 * dayAmt; // Sun glint on the sea
  surf = mix(surf, vec3(0.97) * (light * 1.05), cloud * 0.93);
  surf += AIR * (0.07 + 0.55 * rim) * light;         // blue air, thicker towards the edge
  surf *= mix(vec3(1.0), vec3(1.0, 0.70, 0.46), dayAmt * (1.0 - smoothstep(0.0, 0.32, mu)) * 0.55); // warm sunrise/sunset band
  float nightAmt = 1.0 - smoothstep(-0.20, 0.0, mu);
  surf += vec3(1.0, 0.76, 0.42) * pow(lights, 1.25) * nightAmt * (1.0 - 0.8 * cloud) * u_earth.y;
  surf += AIR * 0.0035;                              // the night side is not pure black: a ball, not a hole
  vec3 ball = pow(1.0 - exp(-surf * 2.3), vec3(1.0 / 2.2));

  // thin glowing rim of air just outside the edge, only where the Sun lights it
  vec2 qn = q / max(length(q), 1e-6);
  float limbDay = smoothstep(-0.30, 0.25, dot(u_right * qn.x + u_up * qn.y, u_sunDir));
  float halo = exp(-max(miss - 1.0, 0.0) / 0.016) * limbDay * (1.0 - disc);
  vec3 haloColor = vec3(0.36, 0.60, 1.0);
  float edge = 1.0 - smoothstep(0.92, 1.0, max(abs(v_uv.x), abs(v_uv.y)));
  out_FragColor = vec4(ball * disc + haloColor * halo * 0.85 * edge, disc + (1.0 - disc) * halo * 0.6 * edge);
}
`;

// ---- Name tags: small pictures of text, stuck to a sky direction, snapped to whole pixels ------------
export const TAG_VS = `
in vec3 a_dir;     // J2000 direction of the thing the tag names
in vec4 a_box;     // xy: corner offset from the anchor in CSS pixels (y down), zw: atlas coordinates
uniform mat3 u_rot;
uniform float u_tagScale; // device pixels per CSS pixel
out vec2 v_st;
${TO_SCREEN}
void main() {
  vec4 clip = skyToScreen(u_rot * a_dir);
  if (clip.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); v_st = vec2(0.0); return; }
  vec2 size = czm_viewport.zw;
  vec2 win = floor((clip.xy / clip.w * 0.5 + 0.5) * size) + vec2(a_box.x, -a_box.y) * u_tagScale;
  gl_Position = vec4(win / size * 2.0 - 1.0, 0.0, 1.0);
  v_st = a_box.zw;
}
`;
export const TAG_FS = `
uniform sampler2D u_atlas;
uniform float u_tagAlpha;
in vec2 v_st;
void main() {
  out_FragColor = texture(u_atlas, v_st) * u_tagAlpha; // the atlas is already multiplied by its alpha
}
`;
