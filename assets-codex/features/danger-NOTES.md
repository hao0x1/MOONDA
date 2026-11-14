## Steep ground (`danger`)

This is a conservative display of resolved steep terrain and small crater interiors. It is not a rover-specific mobility assessment: class 0 means no warning mapped by these rules, not a safe route. The 10, 15 and 25 degree thresholds are the MOONDA task's display rules, not mobility limits published by NASA.

Inputs are read-only. No new elevation or crater measurements were invented, and no downloaded code was run.

### Sources and rights

- `../data-raw/source/terrain-raw/LDEM_80S_80M.JP2`, NASA PDS LOLA DEM, 7600 × 7600, 80 m/pixel, extent −304000 to +304000 m in both axes; label `../data-raw/pds-lola-ldem/ldem_80s_80m_jp2.lbl`. JP2 product version V2.1, created 2017-06-15, LOLA data 2009-07-13 to 2017-02-02. Height relative to the 1,737,400 m sphere is DN × 0.5 m. [Exact JP2](https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/jp2/ldem_80s_80m.jp2), [label](https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/jp2/ldem_80s_80m.lbl).
- `../data-raw/usgs-robbins-craters/lunar_crater_database_robbins_2018_bundle/data/lunar_crater_database_robbins_2018.csv`. Only circular-fit `LAT_CIRC_IMG`, `LON_CIRC_IMG`, `DIAM_CIRC_IMG` are used. [USGS product](https://astrogeology.usgs.gov/search/map/moon_crater_database_v1_robbins), [source bundle](https://astrogeology.usgs.gov/ckan/dataset/f89f5478-b69a-486c-b9b5-30d7b0c5ad2b/resource/c4f25cc2-4f8a-4207-a845-5e176da3ac5a/download/lunar_crater_database_robbins_2018). The ZIP link is the containing bundle, not a standalone CSV.
- `../data-raw/zenodo-southpolar-small-craters/craters_psr.csv` and `craters_no_psr.csv`, Zenodo 5779260 Version 2. [Record](https://zenodo.org/records/5779260), [PSR CSV](https://zenodo.org/records/5779260/files/craters_psr.csv), [non-PSR CSV](https://zenodo.org/records/5779260/files/craters_no_psr.csv). Columns `y` and `x` are latitude and longitude in degrees, and `Diam_km` is diameter in km. The archived CC BY 4.0 record and MD5s are checked before using its 14 entries with diameter 1–3 km.

LOLA and Robbins are public-domain NASA PDS numerical data; the [PDS Geosciences FAQ](https://pds-geosciences.wustl.edu/faq.html) states the archive's public-domain status. The [NASA Science Data Portal policy](https://science.data.nasa.gov/about/license) also states a CC0 default for unmarked NASA-led mission data. No separate Creative Commons licence is asserted for Robbins. Its [USGS metadata](https://astrogeology.usgs.gov/search/map/moon_crater_database_v1_robbins.xml) specifies no access/use constraints. The Marco Figuera catalogue is [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), as explicitly stated by its Zenodo record. Credit NASA/GSFC/MIT LOLA team and NASA PDS; Stuart J. Robbins / Southwest Research Institute and USGS Astrogeology Science Center; and Marco Figuera et al.

| Exact input | Bytes | MD5 |
| --- | ---: | --- |
| `LDEM_80S_80M.JP2` | 29,837,992 | `ed1cba35baef40824822e5a48a3c2aa4` |
| `ldem_80s_80m_jp2.lbl` | 6,354 | `4cc0bdfb155dc456c3a964ffc0ad9f3e` |
| `lunar_crater_database_robbins_2018.csv` | 238,483,500 | `13f2f9df2e71d7049e966ee405c7f014` |
| `craters_psr.csv` | 128,335 | `a896376aa2a7e55477b3148f2d3ddfb7` |
| `craters_no_psr.csv` | 131,789 | `6bad9a4d920b7e56a5ef05cf0969e9ae` |

### Exact rules

1. Calculate Horn 3 × 3 slope at every native DEM pixel, using physical elevations and 80 m spacing. With the usual row-major neighbourhood `a b c / d e f / g h i`, `dzdx = ((c+2f+i)-(a+2d+g))/(8*80)` and `dzdy = ((g+2h+i)-(a+2b+c))/(8*80)`. Apply the same polar stereographic correction as `../data-prep/layers/build_layers.py`: `slope = degrees(atan(k*hypot(dzdx,dzdy)))`, `k = 1+(x²+y²)/(2*1737400)²`. Edge padding repeats border pixels, as in the existing builder. The strip implementation is checked for bit-identical Float32 output against the established function.
2. Class 0: slope < 10°. Class 1: 10° ≤ slope < 15°. Class 2: 15° ≤ slope ≤ 25°. Class 3: slope > 25°. Thus exactly 25° is class 2.
3. Each 4096 cell takes the maximum class from **every native source-cell footprint having positive-area overlap** with it. This is exact rectangular overlap for these aligned grids, with integer arithmetic for boundaries. Source pixels are never bilinearly averaged. A brute-force synthetic overlap check is included.
4. Raise to at least class 1 every target cell intersecting a catalogued circular crater interior with source diameter 1–3 km inclusive. This includes 12,261 Robbins craters considered in the square and the 14 eligible Marco Figuera entries; overlap between catalogues is harmless because this is a maximum mask. The circle is an approximation to the published rim, not a new rim measurement or a statement that every degraded crater remains a complete bowl. The source latitude cut −79.9° only excludes craters too far beyond the 80°S disk to intersect it (a 1.5 km radius spans under 0.05° latitude).
5. Circle geometry uses exact stereographic images of spherical small circles. For centre `(φ, λ)` and angular radius `α = diameterKm*1000/(2R)`, projected centre is `2R*cosφ/(cosα-sinφ) * (sinλ, cosλ)`, radius `2R*sinα/(cosα-sinφ)`. A cell rectangle intersects the circle if the minimum distance from that rectangle to the circle centre is no greater than the circle radius. No coarse polygon rasterization is used.
6. `danger.png` is RGBA 4096 × 4096: class 0 transparent; class 1 `(245,200,60,120)`; class 2 `(245,130,40,150)`; class 3 `(230,50,50,175)`. Pixels whose centres lie outside 80°S are transparent. `danger.bin` is little-endian Uint16 2048 × 2048, scale 1, offset 0, and takes the maximum of each 2 × 2 4096 block. Outside-80°S cell centres are 65535. Both products retain exactly the app's extent and top-row orientation.

### Citations and limits

- Smith, D. E., et al. (2010). The Lunar Orbiter Laser Altimeter investigation on the Lunar Reconnaissance Orbiter mission. *Space Science Reviews* 150, 209–241. DOI: [10.1007/s11214-009-9512-y](https://doi.org/10.1007/s11214-009-9512-y). Dataset: NASA PDS LRO-L-LOLA-4-GDR-V1.0, `LDEM_80S_80M`.
- Horn, B. K. P. (1981). Hill shading and the reflectance map. *Proceedings of the IEEE* 69(1), 14–47. DOI: [10.1109/PROC.1981.11918](https://doi.org/10.1109/PROC.1981.11918). This is the slope-gradient method citation; the layer does not reuse the paper's copyrighted illustrations.
- Robbins, S. J. (2019). A New Global Database of Lunar Impact Craters >1–2 km: 1. Crater Locations and Sizes, Comparisons With Published Databases, and Global Analysis. *Journal of Geophysical Research: Planets* 124, 871–892. DOI: [10.1029/2018JE005592](https://doi.org/10.1029/2018JE005592).
- Marco Figuera, R., Riedel, C., Pio Rossi, A., and Unnithan, V. (2022). Depth to Diameter Analysis on Small Simple Craters at the Lunar South Pole – Possible Implications for Ice Harboring. *Remote Sensing* 14(3), 450. DOI: [10.3390/rs14030450](https://doi.org/10.3390/rs14030450). Dataset: Marco Figuera, R. (2021), *South polar small and medium craters*, Version 2, Zenodo. DOI: [10.5281/zenodo.5779260](https://doi.org/10.5281/zenodo.5779260).

Native DEM pixels are 80 m, but Horn's 3 × 3 neighbourhood spans about 240 m and smooths local slopes. Boulders, small craters and hazards smaller than about 80 m are unresolved. Interpolation in the published DEM, track coverage, and a circular rim fit limit accuracy. Upsampling does not create sharper terrain measurements. Conservative maximum aggregation can colour a whole target cell for a steep sliver of terrain at its edge.

The build's synthetic checks cover Horn equivalence, worst-overlap aggregation and threshold boundaries. Native slopes range 0–63.055°. The Shackleton wall annulus contains abundant class 3 cells; one is at **−89.4081569342°, 110.8333701570° E** (2048 row 1045, column 1080). A class 0 open-plain example is **−84.6893665609°, 39.3933783509° E** (row 604, column 1368), with 66.21% long-term sunlight in the existing LOLA sunlight layer. These are checks at genuine grid positions, not edited values.

`features/out/danger-build-report.json` records exact source sizes/MD5, output sizes, native range, checks and histogram. Final valid-disk coverage on the 2048 grid is class 0 **41.265156%**, class 1 **31.517136%**, class 2 **23.271548%**, class 3 **3.946161%**. `danger.bin` is 8,388,608 bytes; `danger.png` is 1,959,902 bytes.
