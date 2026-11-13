# MOONDA — round 1 art direction

Brief read in full before image generation. The supplied start screen is the visual context: a quiet, nearly black interface, not a space-game identity.

## Critique of Claude's seeds

- **A — Sun and Earth in OO.** The two questions map neatly to the two O's and the plain wordmark could stay elegant. Thin edge crescents disappear at 16 px, though, and merging both into one disk loses the name's cleverness. Blue earthshine is also a metaphor, not a literal depiction of Earth visibility. Needs thick, separable shapes and a monochrome test; otherwise it is another generic phase-Moon icon.
- **B — Real horizon.** Strongest product-specific story: terrain determines power and communication. But ridge + Sun + Earth + enclosing circle is too much at 16 px. Use a filled lunar disk with a broad negative-space ridge cut, one low gold Sun and a substantial blue Earth. The ridge must have at most two major peaks. At favicon size, the silhouette must carry the identity when the dots disappear. This round's ridge is illustrative, NOT measured Shackleton data.
- **C — OO looking glass.** The name offers a natural paired form and symmetry helps recognition. Surface pictures inside lenses will become mud at 16 px; bridges and handles would read as binocular clip art. Keep the paired O geometry, remove the pictures, and give the two apertures one strong shared horizon. It still needs testing against an infinity-sign reading.

## Two proposed directions

- **D — M / Polar pass.** Draw MOONDA's M as one broad, continuous folded ridge: vertical outer legs, two shoulders, a deep central valley. A flat, open-bottom silhouette; no circle, orbit, or decorative stroke. The M is both the first letter and the terrain that controls a landing site. White only. It must remain recognizably an M rather than a generic mountain badge.
- **E — OO / Common horizon.** Evolve C into two bold O apertures fused along a short central vertical web, with one straight horizontal negative-space slot through their lower third. The OO are two observations from the same place, and the slot is their common horizon. No lens illustrations, bridge, handle, infinity crossover, or accent dots. A compact, monochrome name-derived instrument mark. This deliberately develops C rather than pretending paired lenses are a wholly unrelated invention.

## Three selected concepts

1. **OO / Common horizon** — the most direct use of the name, with one reproducible, bold monochrome construction.
2. **M / Polar pass** — the strongest small-size candidate and the cleanest alternative to another circular space logo.
3. **Real horizon (B, reduced)** — the most specific explanation of what MOONDA actually computes, worth testing against the simpler letter marks.

## Generation plan and record

Built-in image generation; six final raster assets only. Lockups: approximately 3:2, flat #05060a, horizontal mark + exactly MOONDA in a geometric semibold sans with wide tracking. Icons: 1:1, #0b0c10 rounded tile with approximately 22% radius on #16171b; symbol approximately 60% of tile width. Main shapes #eeeff1; gold #f1c56b only for sunlight; blue #7fb5ee only for Earth. No tagline, mockup, glow, texture, 3D, or decorative gradients.

Planned filenames:
- `1-oo-horizon-lockup.png`
- `1-oo-horizon-icon.png`
- `2-polar-m-lockup.png`
- `2-polar-m-icon.png`
- `3-real-horizon-lockup.png`
- `3-real-horizon-icon.png`

Notes saved before the first generation call. Image review, final selection, source paths, and SVG corrections follow below as work proceeds.

### Pair 1 review

Generated and visually inspected both OO assets. Wordmark spells MOONDA correctly, with six intact letters. The shared slot is clear and the two apertures remain distinct. The icon preserves the lockup geometry. Concern: it can read as paired lowercase e's, and the slot will need pixel-size optical adjustment. The generated type is heavier and less widely tracked than the intended final semibold wordmark. Accepted as round-one direction art; no regeneration yet.

### Pair 2 review

Generated and visually inspected the M lockup and icon. MOONDA is spelled correctly and the letters are intact. The pointed shoulders and central valley read as M and terrain without extra symbols. The icon preserves the silhouette. Current front-runner for small-size clarity, although an M alone is less ownable than the OO idea and needs a later similarity review. Type is still heavier than specified; use the real Google Sans Flex face in the SVG build.

### Pair 3 review

Generated and visually inspected the horizon lockup and icon. MOONDA is spelled correctly, without warped letters. Gold belongs only to the partly hidden Sun; blue belongs only to Earth. Two broad terrain shoulders replace the busy jagged skyline, and the icon follows the same construction. The broad upper cap makes the mark slightly face-like; this is a weakness, not a feature to amplify. The lockup symbol is too large relative to the wordmark for final production.

## Final delivery and checks

All six PNGs copied into this folder from the built-in generated-images folder. All six were visually inspected at full size. A temporary comparison also downsampled the complete icon canvases to 16 and 32 px using Lanczos, then enlarged those samples with nearest-neighbour for inspection; the QA sheet was removed afterward.

| File | Dimensions | Result |
| --- | --- | --- |
| `1-oo-horizon-lockup.png` | 1536 × 1024 | Correct MOONDA; bold paired apertures |
| `1-oo-horizon-icon.png` | 1254 × 1254 | Clear at 32 px; at 16 px the slot weakens and OO approaches infinity |
| `2-polar-m-lockup.png` | 1536 × 1024 | Correct MOONDA; clear M/ridge silhouette |
| `2-polar-m-icon.png` | 1254 × 1254 | Strongest at both 16 and 32 px |
| `3-real-horizon-lockup.png` | 1536 × 1024 | Correct MOONDA; both accent meanings legible |
| `3-real-horizon-icon.png` | 1254 × 1254 | Reads at 32 px; Sun/Earth distinction becomes unreliable at 16 px |

Six generation calls, one per final asset; no regeneration or extra final variations. These are raster direction studies, not mathematically exact vector masters. Inspection found slight tonal variation in nominally flat fills and small deviations from the requested hex values. Do not sample these rasters to define the brand palette.

## If shipping tonight

**Choose 2 — M / Polar pass.** It is the only one whose central idea survives the complete 16 px icon reduction clearly, and it fits the restrained start screen. The OO has the stronger name-specific story but needs optical work; the horizon has the stronger product story but needs a separate favicon simplification.

## SVG redraw instructions

- Rebuild from geometry, not autotrace. Use exact solid fills: #05060a lockup background, #16171b icon surround, #0b0c10 tile, #eeeff1 primary, #f1c56b Sun, #7fb5ee Earth. Remove all raster tonal variation.
- Typeset the actual Google Sans Flex at semibold with approximately 0.32em tracking, then optically kern. Preserve exactly M-O-O-N-D-A. The generated wordmarks are too heavy. Keep wordmark-only use possible.
- Standardize mark-to-type scale and gap across concepts. Reduce concept 3's oversized symbol. Center the icon marks optically; normalize their widths to approximately 60% of tile width and set tile radius to 22% precisely. The generated OO is a little larger than target.
- **M:** equalize stroke weight at diagonal joins; keep the central valley and underside cutouts open at 16 px. Preserve the two pointed shoulders. Check similarity before adopting as a permanent identity; this round does not establish trademark clearance.
- **OO:** construct equal circles and counters; make the central join and horizon slot consistent. A dedicated 16 px version will need a wider slot and larger apertures. Test whether the lowercase-e/infinity reading is acceptable.
- **Horizon:** replace the illustrative ridge with a simplified, documented horizon from an actual chosen site before calling it “real.” Preserve the low Sun contact with the ridge, keep Earth separate, and test a one-colour version where both celestial disks become white. At 16 px, use an optically simplified silhouette; do not depend on the accent colours. Avoid the face-like arrangement in further refinement.

## Prompt set and provenance

Mode: built-in `image_gen`, not CLI/API fallback. Common prompt constraints are recorded in the generation plan above. The three lockup prompts specified these constructions; each icon prompt used its corresponding generated lockup as the exact symbol reference, removed all lettering, and applied the square tile specification:

1. **OO lockup:** two heavy circular O apertures joined by a short central web; one straight negative-space slot through both at the lower third; no pictures, handles, crossover or accent dots. Geometric semibold MOONDA at right. **Icon:** preserve that exact paired-O silhouette and slot.
2. **M lockup:** one connected heavy M polygon, two equally high pointed shoulders, deep central V, vertical legs, flat bottoms and open underside cutouts; no enclosing circle or accents. Geometric semibold MOONDA at right. **Icon:** preserve that exact M silhouette.
3. **Horizon lockup:** circular white upper cap and white lower terrain segment separated by a broad dark ridge band; two major terrain shoulders; low gold Sun partly hidden on the left; separate blue Earth in the right-hand gap; no fine terrain, stars or texture. Geometric semibold MOONDA at right. **Icon:** preserve that exact circular terrain composition and celestial positions.

Each of the six drafts was produced at 1024 x 1024; only the icon and lockup crops in this folder are kept.
