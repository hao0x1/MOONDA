# Asset job for MOONDA (a "Google Earth for the Moon" web app, CesiumJS + React)

You are the asset teammate. Work ONLY inside this folder (assets-codex/). Do not touch any other folder.
Do not run or open anything you download. Download ONLY from these official sources:
nasa.gov (svs.gsfc.nasa.gov, science.nasa.gov, eoimages.gsfc.nasa.gov, visibleearth.nasa.gov, solarsystem.nasa.gov, nasa3d.arc.nasa.gov, images.nasa.gov),
github.com/nasa (NASA-3D-Resources), usgs.gov, esa.int, github.com/astronexus (HYG star database), cdsarc.cds.unistra.fr or tdc-www.harvard.edu (Yale Bright Star Catalog).
If something is not available from these, say so in the manifest instead of using another site.

## A. Find and download (keep files reasonably small; prefer JPG/PNG/WebP/GLB; total under ~250 MB)
1. Milky Way / deep star map panorama in celestial (equatorial RA/Dec) coordinates: NASA SVS "Deep Star Maps 2020" (SVS id 4851).
   Get the 8k equirectangular star map (starmap_2020_8k) AND the Milky-Way-only map if offered (milkyway_2020_8k or 4k), as JPG if offered, otherwise EXR/TIF (then also convert to a high-quality JPG with any tool available, e.g. python + OpenEXR/imageio/Pillow, sips or ImageMagick; tone-map sensibly so stars are visible but the background stays black).
   Record exactly how the image is laid out (which RA is at the centre, which way RA increases, north up).
2. A bright-star catalogue with RA, Dec, visual magnitude, colour (B-V) and proper names: HYG database (hygdata_v3 or v4 CSV) or Yale BSC5. Produce `stars/bright-stars.json`: an array of [raDeg, decDeg, mag, bv, name|null] for all stars with mag <= 6.5 (about 9000), names only for the ~300 brightest/named.
3. Earth textures (NASA Blue Marble Next Generation / Visible Earth): a day map (land+ocean, no clouds, about 8192x4096 or 5400x2700), night city lights (Black Marble 2016, about 3600x1800 or larger), a cloud map (about 2048x1024 or larger). Equirectangular, longitude -180..180 left to right, north up. Save as JPG in `earth/`.
4. Textures for the Sun's disc (NASA SDO or SVS) and for Mercury, Venus, Mars, Jupiter, Saturn (plus Saturn's ring strip if available), equirectangular 2k, from NASA SVS / NASA Science 3D resources. Save in `planets/`.
5. NASA 3D models in GLB format if they exist on NASA sites: Earth, the Sun, and a robotic Moon lander (for example a CLPS-type lander, Surveyor, or the Apollo Lunar Module if nothing else exists). Save in `models/`. Note each file's size.
6. The SVS "CGI Moon Kit" (SVS id 4720) colour map of the Moon at 8k if a JPG/TIF is offered (lroc_color_poles_8k). Save in `moon/` (convert TIF to JPG quality 92).

## B. Generate images (use your image generation tool; if it is not available, say so in the manifest)
1. `generated/sun-glare.png` — 1024x1024, a photographic Sun as seen from space: small intensely bright white core, soft warm glow, subtle long diffraction spikes, pure black background (it will be drawn with additive blending). No text, no planets.
2. `generated/logo-moonda.png` (1024x1024, transparent or black background) — a clean, modern app mark for "MOONDA": a crescent Moon with a small location-pin shape, flat, white/silver on dark, no text.
3. `generated/welcome-hero.jpg` (1920x1080) — a realistic view of the Moon's south pole seen from low lunar orbit with long shadows, Earth small above the horizon, stars. Photographic, no text.

## C. Vector icons (write the SVG code yourself, 24x24 viewBox, 1.75 stroke, rounded caps, single colour `currentColor`, consistent style like Phosphor/Lucide)
`icons/pin.svg`, `icons/lander.svg` (a small robotic lander with legs), `icons/artemis-region.svg` (target ring), `icons/past-landing.svg` (flag), `icons/famous-spot.svg` (star/peak), `icons/sun.svg`, `icons/earth.svg`, `icons/moon.svg`, `icons/battery.svg`, `icons/antenna.svg`, `icons/compass.svg`, `icons/eye-level.svg` (person/eye at ground level looking at the horizon).

## D. Write `manifest.json`
For every file: path, what it is, source page URL, direct download URL, licence/credit line (NASA media are generally public domain — give the exact credit NASA asks for), pixel size, file size, and any layout notes (projection, which longitude/RA is at the left edge and centre). List anything you could not get and why.
Finish by printing a short summary.
