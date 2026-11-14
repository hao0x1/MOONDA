# Crater source and build notes

## Robbins outline vectors

Outputs: `out/craters.bin` (112,955 records; 1,355,460 bytes), `out/craters.json` and the standard-field entry `out/craters-manifest.json`. Rebuild with `/Volumes/CodexWork/Projects/MOONDA/.venv-data/bin/python -I features/scripts/build_craters.py` from assets-codex. All paths written by the builder are inside assets-codex.

Exact input: `../data-raw/usgs-robbins-craters/lunar_crater_database_robbins_2018_bundle/data/lunar_crater_database_robbins_2018.csv`. This contains 1,296,796 rows. It is the CSV in the read-only `lunar_crater_database_robbins_2018.zip` PDS4 bundle, v1.0, release 2018-08-15. [USGS product](https://astrogeology.usgs.gov/search/map/moon_crater_database_v1_robbins). The numerical source columns are `LAT_CIRC_IMG`, `LON_CIRC_IMG`, `DIAM_CIRC_IMG`, preserving the published circular fits; the elliptical-fit values are not used.

Rule: retain each source row once if `DIAM_CIRC_IMG >= 5` OR (`LAT_CIRC_IMG <= -75` AND `DIAM_CIRC_IMG >= 1`). Sort by diameter descending (stable ties); wrap east longitude by `(lon + 180) % 360 - 180`. Store consecutive little-endian Float32 triples `[latDeg, lonDeg, diameterKm]`, without a header. No projection or raster grid applies to this vector file. No named-crater locations, detections or diameters were invented.

LOD prefix counts for 200, 100, 50, 20, 10, 5, 2 and 1 km are respectively 61, 314, 1,562, 6,973, 24,412, 83,061, 92,716 and 112,955. Counts refer to the leading records with encoded diameter at least the threshold. There are no repeated selected source IDs and no duplicate encoded triples. There are 26,298 selected southern craters between 1 and 3 km inclusive, available to the danger-layer builder.

Citation: Robbins, S. J. (2019). A New Global Database of Lunar Impact Craters >1–2 km: 1. Crater Locations and Sizes, Comparisons With Published Databases, and Global Analysis. *Journal of Geophysical Research: Planets*, 124(4), 871–892. DOI: [10.1029/2018JE005592](https://doi.org/10.1029/2018JE005592).

Licence/credit: public-domain NASA PDS numerical data. The [PDS Geosciences FAQ](https://pds-geosciences.wustl.edu/faq.html) states that PDS archives are public domain and requests citation. The product's downloaded FGDC XML has empty access/use constraints. This is not an assertion that the paper or the source imagery has a Creative Commons licence. Credit Stuart J. Robbins / Southwest Research Institute and USGS Astrogeology Science Center.

Limits: circular fits are convenient outline approximations and are not exact rim polygons. The source estimates completeness only above about 1–2 km, with spatial variation and uncertainty. A catalogue entry does not establish freshness, a particular hazard, or ice. Source IDs and detailed fit uncertainties are not carried into these compact triples.

## Small south-pole outline vectors

Output: `out/craters-small-south.bin`, 3,317 records and 39,804 bytes, with the same triple layout and descending diameter sort. Metadata is under `small` in `out/craters.json`.

Exact inputs: `../data-raw/zenodo-southpolar-small-craters/craters_psr.csv` (1,432 rows) and `craters_no_psr.csv` (1,885 rows). The authoritative [Zenodo record 5779260](https://zenodo.org/records/5779260), Version 2, published 2021-12-13, identifies Ramiro Marco Figuera as creator, explicitly declares **CC BY 4.0**, and lists both CSV checksums. The local inputs match those checksums exactly. Record metadata is retained as `features/downloads/small-craters-zenodo-5779260.json`; no downloaded Python is imported, downloaded, or run.

Source mapping: `y` is latitude in degrees, `x` is east longitude in degrees, `Diam_km` is diameter in km. Concatenate both input tables and preserve every archived row. Longitude conversion, float encoding and sorting are as above. All 3,317 encoded triples are distinct. The archive spans approximately 0.0467–4.5159 km in diameter and 88.8746–89.9878°S. It is a restricted study area, not a full survey of the lunar south pole. The paper's final scientific sample used slope <25° and diameters 200–1000 m (753 craters); this deliverable is explicitly the full archived catalogue, including rows excluded from that final analysis. Its PSR/non-PSR grouping does not confirm water ice. Do not merge this catalogue with Robbins without a spatial cross-match: some larger entries may describe the same real craters across catalogues.

Paper citation: Marco Figuera, R., Riedel, C., Pio Rossi, A., and Unnithan, V. (2022). Depth to Diameter Analysis on Small Simple Craters at the Lunar South Pole—Possible Implications for Ice Harboring. *Remote Sensing*, 14(3), 450. DOI: [10.3390/rs14030450](https://doi.org/10.3390/rs14030450). The paper's Data Availability Statement links this exact Zenodo record.

Dataset citation: Marco Figuera, R. (2021). *South polar small and medium craters* (Version 2), Zenodo. DOI: [10.5281/zenodo.5779260](https://doi.org/10.5281/zenodo.5779260). Licence: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). Credit the dataset creator and the paper authors; state that MOONDA converted coordinates to Float32 triples and sorted them.

## Source inventory

Exact URLs, sizes and MD5 hashes for the source bundle, extracted CSVs and downloaded primary metadata are in `features/out/craters-sources.json`. No tracking parameters are used.

| Source file | Bytes | MD5 |
| --- | ---: | --- |
| Robbins source CSV | 238483500 | `13f2f9df2e71d7049e966ee405c7f014` |
| Robbins source zip | 96227201 | `0d4a8667e0a92d4c1962e4112b2002b0` |
| `craters_psr.csv` | 128335 | `a896376aa2a7e55477b3148f2d3ddfb7` |
| `craters_no_psr.csv` | 131789 | `6bad9a4d920b7e56a5ef05cf0969e9ae` |
| Zenodo metadata JSON | 4358 | `28eebe42ac2de412578cc3026a9023e0` |
| USGS FGDC XML | 15479 | `2a9340ef4ebc32b3939e178a17812cfd` |

URLs: Robbins zip via `https://astrogeology.usgs.gov/ckan/dataset/f89f5478-b69a-486c-b9b5-30d7b0c5ad2b/resource/c4f25cc2-4f8a-4207-a845-5e176da3ac5a/download/lunar_crater_database_robbins_2018`; extracted CSV is contained in that bundle. Small tables via `https://zenodo.org/records/5779260/files/craters_psr.csv` and `https://zenodo.org/records/5779260/files/craters_no_psr.csv`. Metadata via `https://zenodo.org/api/records/5779260` and `https://astrogeology.usgs.gov/search/map/moon_crater_database_v1_robbins.xml`.
