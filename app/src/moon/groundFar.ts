// The middle and far ground in Stand here (part of lander.ts GROUND_SHADER, pasted in after lvNoiseD).
//
// In Apollo and Chang'e panoramas the ground looks ROUGHER toward the horizon, not smoother: every small crater and
// boulder out there is squeezed by the low view into a thin dark stroke (its shadow, the side toward the Sun) and a
// thin bright one (its far wall, which faces the Sun). The craters themselves are only drawn while they still cover a
// few pixels (lvCraterScale, faded by fpE); this adds what is left of the smaller ones: noise at fixed ground sizes
// (3, 12, 48, 192 m, so nothing slides while you turn), each size kept only while it is still several pixels WIDE
// (fp, the pixel's short side, across the line of sight). Along the line of sight one pixel covers a long strip of
// ground far away, so each screen row picks its own value: that is what makes the strokes thin and flat, as in the
// photos, and never a round dot that sparkles. Dark strokes show when the Sun is not behind you (shadows hide
// behind their own rims at small phase angles), bright ones mostly when you look toward the Sun.

/** lvFarGround(en, fp, sunH, a, tanI) -> x: sunlight factor (strokes), y: brightness factor of the ground itself. */
export const FAR_GROUND_GLSL = `
vec2 lvFarGround(vec2 en, float fp, vec2 sunH, float a, float tanI) {
    float shade = 1.0 - exp(-0.2 * tanI); // the lower the Sun, the more of the ground lies in little shadows
    float kd = shade * smoothstep(4.0, 45.0, a);
    float kb = shade * smoothstep(40.0, 130.0, a);
    // (each size adds its own strokes: a union, not an average, which would blur them into an even brushed grey)
    float dark = 1.0, bright = 1.0, alb = 0.0, sw = 0.0;
    for (int i = 0; i < 4; i++) {
        float S = 3.0 * pow(4.0, float(i));
        float w = 1.0 - smoothstep(0.15 * S, 0.45 * S, fp);
        if (w <= 0.0) continue;
        vec2 q = en / S + float(i) * 5.13;
        // the shadow lies on the Sun's side of each little hollow, the bright wall on the far side
        dark *= 1.0 - w * smoothstep(0.66, 0.86, lvNoiseD(q - sunH * 0.12).x);
        bright *= 1.0 - w * smoothstep(0.7, 0.88, lvNoiseD(q + sunH * 0.2).x);
        // the dust's own patches, larger than the strokes
        alb += w * (lvNoiseD(q * 0.31 + 2.9).x - 0.5);
        sw += w;
    }
    if (sw <= 0.0) return vec2(1.0);
    return vec2(clamp(1.0 - 0.85 * kd * (1.0 - dark) + 0.7 * kb * (1.0 - bright), 0.2, 1.8), 1.0 + 0.16 * alb / max(sw, 1.5));
}
`;
