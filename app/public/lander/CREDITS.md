# Lander view ("Stand here") — third-party assets

Everything here is used only for the ground right around the viewer, where no orbiter has data
(the best NASA photos and heights stop at about 1 m and 5 m). Hills, shadows from hills, and how bright
the ground is all still come from NASA data (see the map credits).

All assets below are **CC0 1.0 (public domain)** from Poly Haven (https://polyhaven.com/license).
No attribution is required; we credit them anyway.

## Regolith textures (`regolith_a.webp`, `regolith_b.webp`, `regolith_c.webp`)

Photo-scanned regolith-like soil, 2K versions. Packed by `.v4/lander/tools/pack_regolith.py`:
R, G = OpenGL normal map x, y; B = height (displacement), lossless WebP.

| file | source asset | URL | authors (per Poly Haven) |
|---|---|---|---|
| regolith_a.webp | Moon 02 | https://polyhaven.com/a/moon_02 | Greg Zaal, Rico Cilliers, Jenelle van Heerden (photography), Dario Barresi (processing) |
| regolith_b.webp | Moon Meteor 01 | https://polyhaven.com/a/moon_meteor_01 | Greg Zaal, Rico Cilliers (photography), Jenelle van Heerden (processing) |
| regolith_c.webp | Moon Meteor 02 | https://polyhaven.com/a/moon_meteor_02 | Greg Zaal, Rico Cilliers (photography), Jenelle van Heerden (processing) |

Downloaded from `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/<asset>/<asset>_{nor_gl,disp}_2k.jpg`.

## Rocks (`rocks/moon_rock_01` … `rocks/moon_rock_07`)

Photo-scanned rock models, glTF with 1K textures. Packed by `.v4/lander/tools/pack_rocks.py`
(kept only the finest level of detail and the colour + normal textures).

| folder | source asset | URL |
|---|---|---|
| rocks/moon_rock_01 … 07 | Moon Rock 01 … 07 | https://polyhaven.com/a/moon_rock_01 … https://polyhaven.com/a/moon_rock_07 |

Authors (per Poly Haven): Greg Zaal, Rico Cilliers (photography), Jenelle van Heerden, Dario Barresi (processing).
Downloaded from `https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/<asset>/` and
`https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/<asset>/`.

Note: these are scans of real rocks and soil prepared to look lunar; they are not samples of the
actual spot. The app places them the way rocks and small craters are spread on the Moon (many small,
few large), the same way every time for the same spot, and says so in the "What am I looking at?" help.

## Not used (checked for the first-person hands, Nov 2026)

- NASA 3D Resources "Astronaut Glove" (github.com/nasa/NASA-3D-Resources, `3D Models/Astronaut Glove`, public domain):
  a very low-poly glove (octagonal fingertips) that looked fake next to the scanned ground, so no hands are drawn.
- NASA 3D Resources "Z2 Spacesuit" (public domain, 17 MB): a detailed suit, but posed with the arms hanging down and
  not rigged, so its forearms cannot be brought up in front of the eyes without remodelling. A possible later option:
  draw the whole suit around the camera so you see your own arms and boots when you look down.
- The craters added to the far ground in "Stand here" are made in the shader from crater statistics (no asset).

## Gloves (`gloves/right.glb`, `gloves/left.glb`)

Smithsonian National Air and Space Museum, "Gloves, Extravehicular, A7-L, Apollo 11, Armstrong" 3D scans,
**CC0** (Smithsonian Open Access, https://3d.si.edu). The 1024-texture glTF downloads, unchanged
(Draco-compressed). Shown as your own hands while walking in "Stand here".
(Since 13 Nov 2026 the gloves are no longer loaded or shown: "Stand here" uses the rover below.)

## Rover "MOONDA" (`rover/rover.glb`)

MOONDA's rover in "Stand here" is drawn with NASA's **Mars 2020 Perseverance Rover** 3D model from
NASA 3D Resources (https://github.com/nasa/NASA-3D-Resources, folder `3D Models/Mars 2020 Perseverance Rover`;
web interface https://nasa3d.arc.nasa.gov). The repository says: "These assets are free and without copyright."
Usage guidelines: https://www.nasa.gov/nasa-brand-center/images-and-media. Credit: NASA/JPL-Caltech.
The GLB is used unchanged (Draco-compressed, WebP textures at most 1024 px, 5.0 MB), at its true size (about 3 m long).
"MOONDA" (like the app) is our team's name for it; it is not an official NASA name, and the real
Perseverance works on Mars, not the Moon.

Checked and not available (13 Nov 2026): NASA's VIPER lunar rover and the Apollo Lunar Roving Vehicle are not
published as downloadable models on NASA 3D Resources. The Opportunity (MER-B) GLB there is very low-poly.
