# Whole-Moon slope and danger maps

These maps extend the coverage outside the sharp south-polar maps. They do not
replace `slope.bin`, `slope.png`, `danger.bin` or `danger.png`. The south-polar
80 m height source and its sharper overlays remain in use where they exist.

## Rebuild

From the repository root, using the retained data environment:

```sh
.venv-data/bin/python -I data-prep/layers/download_global_terrain.py
.venv-data/bin/python -I data-prep/layers/build_global_terrain.py
```

The downloader reads NASA's PDS archive in checked HTTP byte ranges. It keeps
finished pieces under `data-raw/pds-lola-global-ldem64/ranges/`, so interrupted
downloads can resume. Every range must return HTTP 206 and its exact requested
`Content-Range`. The assembled file must contain 530,841,600 bytes. Downloads
are data only: no downloaded file is imported or executed. The builder runs in
isolated Python mode and uses the project's existing NumPy and Pillow packages.

## The height source

- Product: NASA LRO LOLA `LDEM_64`, PDS `LRO-L-LOLA-4-GDR-V1.0`, version 3.1,
  created 15 March 2019, based on measurements through 29 November 2016.
- Data: <https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_64.img>
- Label: <https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_64.lbl>
- Archive description: <https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/document/rdrsis.htm>
- Grid: 23,040 by 11,520, 64 pixels per degree, pixel registered, longitude
  0–360° east, latitude 90° N to 90° S, Moon mean Earth/polar axis frame of DE421.
- Heights: signed little-endian 16-bit integers, 0.5 m per code, relative to a
  1,737,400 m reference sphere. Latitude pixel spacing is about 473.8 m;
  longitude spacing shrinks towards the poles.
- Credit: NASA/GSFC/MIT LOLA team and NASA PDS Geosciences Node. Smith et al.
  (2010), *The Lunar Orbiter Laser Altimeter investigation on the Lunar
  Reconnaissance Orbiter mission*, Space Science Reviews 150, 209–241,
  <https://doi.org/10.1007/s11214-009-9512-y>.
- Terms: NASA PDS public-domain numerical data, as described at
  <https://pds-geosciences.wustl.edu/faq.html>.

The published label warns that the heights are interpolated between tracks and
can have artefacts at the 45° latitude band boundaries. Resolution is not the
same as accuracy. We do not claim a measured height for every point between
laser shots.

## Slope method and baseline

Slope depends on the length over which it is measured. The global map uses a
Horn 3 by 3 height stencil. Its samples are offset in local north/east ground
directions by one native latitude spacing, about 473.8 m, using great-circle
positions on the reference sphere. Native heights at those positions are
bilinearly interpolated. This avoids the east/west baseline collapsing to
almost zero near the poles, which would happen with a plain 3 by 3 longitude
stencil.

The span between opposite outer sample centres is about **947.6 m** in each
ground direction. Including the source-cell footprints gives a nominal
**1.42 km footprint**. The map is a regional slope picture; it cannot show
wheel-scale bumps. The retained south-polar slope map uses the native 80 m
heights, a 160 m outer-centre span and a nominal 240 m stencil footprint, so its
values need not match the global map at the boundary.

The native slopes are rounded to quarters of a degree, then averaged over the
native raster cells in each output raster pixel. The output is 8,192 by 4,096,
about 1.33 km per pixel in latitude; east/west pixels shrink towards the poles.
An output pixel is not a new measurement at 1.33 km resolution.

`slope-global-values.png` is a single-channel 8-bit greyscale PNG. Its code is
`round(slope in degrees * 4)`, code 254 caps values above 63.5°, and code 255 is
reserved for no data. The picture is also the compact value grid: the browser
applies the palette in `global-terrain.json` when it draws tiles. This avoids
shipping a second full-sized colour picture or a float grid.

In this build, 19 of the 265,420,800 native stencil values exceeded the 63.5°
encoding ceiling (the largest was 67.68°). They are capped before the regional
average; their danger class remains red because it is made before encoding.
The full count and range are recorded in `global-terrain-report.json`.

## Danger classes and crater bowls

The same native slope calculation supplies the classes, before rounding:

| Code | Meaning |
| --- | --- |
| 0 | No mapped warning |
| 1 | 10° to under 15°, or a catalogued 1–3 km crater interior |
| 2 | 15° to 25°, including exactly 25° |
| 3 | Over 25° |
| 255 | No data (reserved) |

Every native slope cell with positive-area overlap is considered: the worst
class wins in each output pixel. Slopes are never averaged before the danger
classes are made. This preserves a steep patch which an averaged regional
slope colour could hide.

For crater warnings, the builder reads the already archived Robbins catalogue:

- Product page: <https://astrogeology.usgs.gov/search/map/moon_crater_database_v1_robbins>
- Data: <https://astrogeology.usgs.gov/ckan/dataset/f89f5478-b69a-486c-b9b5-30d7b0c5ad2b/resource/c4f25cc2-4f8a-4207-a845-5e176da3ac5a/download/lunar_crater_database_robbins_2018>
- Local source:
  `data-raw/usgs-robbins-craters/lunar_crater_database_robbins_2018_bundle/data/lunar_crater_database_robbins_2018.csv`.
- Fields: `LAT_CIRC_IMG`, `LON_CIRC_IMG`, `DIAM_CIRC_IMG`, using only measured
  circular-fit diameters from 1 to 3 km, as the existing south-polar warning does.
- Credit: Stuart J. Robbins / Southwest Research Institute / USGS Astrogeology.
  Robbins (2019), *A New Global Database of Lunar Impact Craters >1–2 km*,
  JGR Planets 124, 871–892, <https://doi.org/10.1029/2018JE005592>.
- Terms: public-domain NASA PDS numerical data; no separate Creative Commons
  licence is claimed.

A pixel which intersects a circular-fit crater interior is at least yellow.
Intersections are checked on the lunar sphere, including at the longitude seam
and poles. These circles are caution areas, not measured bowl outlines. A
catalogued crater can be worn down, partly filled or crossed by later craters.
The warning does not assign an invented slope to it. Features below the
catalogue's completeness limit can be absent.

`danger-global-values.png` uses the same 8,192 by 4,096 lon/lat grid. It is an
8-bit greyscale class grid; the browser colours only classes 1–3 and leaves
class 0 clear. Its palette matches the existing south-polar danger map.

## Checks and limits

The builder checks threshold boundaries (10°, 15°, 25°), zero slope on a
constant-height sphere including both poles, known slopes on an analytic
latitude ramp, source dimensions and byte count, that all height codes stay
within the PDS label's bounds, and the source label's version and scale. The
downloaded pixel-registered IMG has extrema -18,229 and 21,514 DN; the label
lists the slightly wider bounds -18,251 and 21,546. Both are retained in the
report instead of treating the metadata bounds as measured pixel values.
`global-terrain-report.json` records
SHA-256 hashes, source sizes, class counts, crater counts and spot checks,
including Apollo 11. `global-terrain.json` holds the projection, value scales,
palettes and baseline so both map drawing and point values use the same files.

These are display warnings, not rover-specific mobility limits or route safety
certification. Boulders, small craters and local slopes below the source
footprint are unresolved. No mapped warning never means safe ground.

The NASA team also publishes a truly global slope product derived from
SLDEM2015/LOLA: <https://pgda.gsfc.nasa.gov/products/67>, with data at
<https://imbrium.mit.edu/DATA/SLDEM2015_SLOPE/GLOBAL/>. We verified its availability
while researching this change. It is not silently mixed into this output:
this reproducible build uses `LDEM_64` throughout, with its stated baseline.
