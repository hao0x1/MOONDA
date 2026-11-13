# Sky pictures and star data used by MOONDA (`public/space/`)

Everything here was downloaded as plain data (pictures and one table) from NASA sites and the HYG star
database, then resized / re-encoded by the scripts in `data-prep/space/` (`fetch.sh` downloads, the three
`.py` files convert). Nothing downloaded is ever executed. Total size: about 16 MB.

| File | What it is | Made by |
|---|---|---|
| `milkyway_8k.jpg` (8192×4096), `milkyway_4k.jpg` (4096×2048) | The glow of the Milky Way with the bright stars removed | `milkyway.py` |
| `stars.json` | 8,920 stars a person can see without a telescope (magnitude ≤ 6.5) | `stars.py` |
| `earth_day_4k.jpg` (4096×2048) | Earth by day, no clouds | `earth.py` |
| `earth_night_4k.jpg` (4096×2048, grey) | City lights at night | `earth.py` |
| `earth_clouds_2k.jpg` (2048×1024, grey) | A layer of clouds | `earth.py` |

The Sun has no picture: its disc and camera-like glare are drawn by a small shader (`src/moon/sky/shaders.ts`).

## Milky Way — NASA "Deep Star Maps 2020"

- Source page: https://svs.gsfc.nasa.gov/4851 (NASA Scientific Visualization Studio, id 4851, released 9 Sep 2020)
- Direct file: https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/milkyway_2020_8k.exr
  ("The Milky Way background in celestial coordinates. This is a version of the star map that omits the bright
  (Hipparcos and Tycho) stars.") The 4k full star map `starmap_2020_4k.exr` from the same page was only used to
  check the layout.
- Credit line: **NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC.**
  Visualization by Ernie Wright. The map plots 1.7 billion stars from the Hipparcos-2, Tycho-2 and Gaia DR2 catalogues.
- Layout (checked against Sirius, Canopus, Vega, Capella and Alpha Centauri in the full star map): plate carrée
  in J2000 right ascension / declination; **RA 0h is in the centre of the picture and RA increases to the LEFT**
  (`u = 0.5 − RA/360`), RA 12h is at both side edges; north is up (`v = (90° − Dec)/180°`).
- Encoding of our JPGs: `jpg = clip(linear × 4, 0, 1) ^ (1/2.2)`; the shader undoes this and does its own tone-mapping.

## Stars — HYG database v4.1

- Source page: https://github.com/astronexus/HYG-Database (David Nash, "HYG Stellar database")
- Direct file: https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv
- Licence / credit: **HYG Database v4.1 by David Nash (astronexus), CC BY-SA 4.0.** It combines the Hipparcos,
  Yale Bright Star and Gliese catalogues. `stars.json` is a reduced copy and is shared under the same licence.
- Layout: JSON array, brightest first. `[raDeg, decDeg, magnitude, B−V colour, name | null]`, plus
  `constellation, lightYears` for stars that have a proper name. Positions are J2000 (ICRS) degrees, moved to
  epoch 2027.0 with each star's proper motion.

## Earth by day — NASA Blue Marble: Next Generation

- Source pages: https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/ and
  https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry/
- Direct file: https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography-bathymetry/november/world.topo.bathy.200411.3x5400x2700.jpg
  (November 2004, land with shaded relief and sea floor, no clouds)
- Credit line: **NASA Earth Observatory** — "Blue Marble: Next Generation was produced by Reto Stöckli, NASA Earth
  Observatory (NASA Goddard Space Flight Center)."

## Earth at night — NASA Black Marble 2016

- Source page: https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps/
- Direct file: https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144898/BlackMarble_2016_01deg.jpg
  (2016 colour, global, 3600×1800)
- Credit line: **NASA Earth Observatory images by Joshua Stevens, using Suomi NPP VIIRS data from Miguel Román,
  NASA Goddard Space Flight Center.**
- Our file keeps only the city lights (the blue-tinted land and ice background of the original is removed).

## Clouds — NASA Blue Marble (2002)

- Source page: https://science.nasa.gov/earth/earth-observatory/history-of-the-blue-marble/ (the 2002 Blue Marble)
- Direct file: https://assets.science.nasa.gov/content/dam/science/esd/eo/content-feature/bluemarble/images/cloud_combined_2048.jpg
- Credit line: **NASA Goddard Space Flight Center image by Reto Stöckli (land surface, shallow water, clouds);
  enhancements by Robert Simmon. Data: MODIS, NASA Terra.**
- One fixed, typical cloud pattern — not the weather of the day shown on the time bar.

## Layout shared by the three Earth maps

Plate carrée, longitude −180° at the left edge, Greenwich in the centre, north up.

## Notes

- NASA material is generally free to use with credit (https://www.nasa.gov/nasa-brand-center/images-and-media/);
  it must not suggest that NASA endorses the app.
- The NASA Earth Observatory files moved from `eoimages.gsfc.nasa.gov` to `assets.science.nasa.gov` (still NASA).
