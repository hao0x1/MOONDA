# MOONDA feature data

Built entirely inside `assets-codex/`. Original project inputs were read only.
Every coloured region comes from a published dataset or a stated calculation
from those data. A cold trap is a prediction of ice survival, not proof of ice.

## App handoff

- `manifest-additions.json` is an array with exactly the existing manifest fields.
- `craters.bin` and `craters-small-south.bin` are **Float32 LE vector triples**,
  `[latDeg, lonDeg, diameterKm]`, diameter descending. They are the exception to
  the raster loader. `craters.json` supplies counts, LOD prefix lengths and licences.
  Keep the small study catalogue separate; it has not been cross-matched with Robbins.
- All other `.bin` files are **2048 square Uint16 LE**; decode
  `raw * scale + offset`, `65535` means no data. Extent is exactly
  `[-304000,+304000]` metres on both axes; top row faces 0 E, right faces 90 E.
- All three overlay PNGs are **4096 square RGBA** on that same extent. Outside
  80 S is transparent. PSR opacity is area-weighted. Water-ice PNG sharpens only
  the shadow footprint, not the underlying thermal model.
- Water-ice classes 1 and 2 are predictions. Class 3 is reserved and empty;
  published region-level M3 detection counts support markers, not a pixel mask.
  Cabeus is the only directly confirmed marker, based on LCROSS plume water.
  A crater-centre marker describes evidence inside the crater, not a measurement
  at its centre. The LCROSS impact position is separately stated in its evidence.
- Use categorical sampling for `waterice` and `danger`, never interpolate class codes.
  Class 0 means no mapped feature/warning, not proven absence of ice or a safe route.
- Do not load `*-manifest.json`, reports, `*.npy`, or `*.npz` as extra app layers.
  They are build fragments, validation evidence and reusable intermediate data.

## Rebuild and validation

Use only `/Volumes/CodexWork/Projects/MOONDA/.venv-data/bin/python -I`.
Run `features/scripts/download_psr.py` if the complete replacement TIFF is missing,
then `build_craters.py`, `build_psr.py`, `build_waterice.py`,
`build_danger.py`, `assemble.py`, `check.py`, `previews.py`, then `assemble.py` again.
Every script resolves its paths from its own location and writes below this folder.
No external application files are changed. No downloaded code is run.

`check-report.json` records sizes, dimensions, class histograms, coordinate checks,
native-source spot checks and overlap with the app's older shadow map.
The 1024 square previews use a derived hillshade and labelled 85 S / 88 S circles.
Hillshade is an artificial light for reading terrain, not actual sunlight.

## Delivery files

| File | Bytes | MD5 |
| --- | ---: | --- |
| `craters.bin` | 1,355,460 | `adc0322645d75fa104ce39bfe378bfca` |
| `craters-small-south.bin` | 39,804 | `eaf5706065d292ffb1699800da29a35f` |
| `craters.json` | 2,067 | `d1c9e97c82925c77e4be86c5f1e35c77` |
| `psr.bin` | 8,388,608 | `46b897f05a61330106555b7e2411348b` |
| `psr.png` | 3,049,780 | `022dcd7aa8f33cf42d0de3c495439844` |
| `waterice.bin` | 8,388,608 | `63b1c9f8a021045c0bbb0580eea09d72` |
| `waterice.png` | 394,463 | `df2b3c50fcc85ad66248ddc36b9b5750` |
| `ice-sites.json` | 14,357 | `def5bbdc571fc3deef20ecd65ebfa568` |
| `danger.bin` | 8,388,608 | `57378d65b97683a291d5dd4d1c27f40c` |
| `danger.png` | 1,959,902 | `1de95207af867767ba51da9567763cb0` |
| `manifest-additions.json` | 11,116 | `4f3b6c00ae96e9604fa348abe89ab408` |

---

## Final checks

PASS

PSR majority-shadow agreement with old ice.bin: 99.298%; PSR intersection-over-union 89.751%. Agreement includes the large unshadowed area, so IoU is also reported.

Class coverage uses each layer's valid cells inside 80 S, not the full square. Water ice preserves 264 cells with missing source temperatures.

```json
{
  "psr": {
    "zero": 2614720,
    "mixed": 505808,
    "full": 173864,
    "meanPercent": 7.173655105403364,
    "percentCellsContainingPsr": 20.631181717294115
  },
  "waterice": {
    "0": {
      "count": 1929876,
      "percent": 58.585337303225614
    },
    "1": {
      "count": 1212884,
      "percent": 36.81957713847185
    },
    "2": {
      "count": 151368,
      "percent": 4.5950855583025305
    },
    "3": {
      "count": 0,
      "percent": 0.0
    }
  },
  "danger": {
    "0": {
      "count": 1359436,
      "percent": 41.265156059145355
    },
    "1": {
      "count": 1038298,
      "percent": 31.517135787119443
    },
    "2": {
      "count": 766656,
      "percent": 23.27154752682741
    },
    "3": {
      "count": 130002,
      "percent": 3.9461606269077873
    }
  }
}
```


---

# Crater source and build notes

## Full drawing catalogue, 14 Nov 2026

The drawing catalogue now keeps **all 1,296,796 Robbins records of at least
1 km**, separate from the existing route-planner catalogue. Build it from the
project root with:

```sh
.venv-data/bin/python -I data-prep/features/scripts/build_crater_drawing.py
```

The builder reads the already archived official PDS CSV as data. It writes only
`app/public/data/features/craters-draw/` and
`data-prep/features/crater-drawing-check.json`. No download was needed for this
change and no downloaded code is run. It does not change `craters.bin`,
`craters-small-south.bin`, their metadata, or any ice data.

The official [USGS product page](https://astrogeology.usgs.gov/search/map/moon_crater_database_v1_robbins)
was checked on 14 Nov 2026. It gives this
[official bundle download](https://astropedia.astrogeology.usgs.gov/download/Moon/Research/Craters/lunar_crater_database_robbins_2018)
and the [NASA PDS archive](https://pdsimage2.wr.usgs.gov/Individual_Investigations/moon_lro.kaguya_multi_craterdatabase_robbins_2018/).
The archived CSV is the full 238,483,500-byte 2018-08-15 release, with SHA256
`39a419e0ca627b792be1a9f761c3fa1372094cdc5bc0db88afd365c07af8ad62`.
The local PDS label declares **planetocentric latitude, positive-east longitude,
0 to 360 degrees, and a 1,737,400 m spherical Moon**. The existing conversion
`(longitude + 180) % 360 - 180` is correct. Longitude direction is therefore not
the cause of the misplaced rings. The numerical fields remain `LAT_CIRC_IMG`,
`LON_CIRC_IMG`, and `DIAM_CIRC_IMG`; catalogue diameters are not radii.

Drawing format:

- `craters-draw/index.json` describes every chunk. Its `chunks[].file` paths
  are relative to `/data/features/`, so they already start with `craters-draw/`.
- Each binary chunk is a headerless little-endian Float32 sequence
  `[trueLatitudeDeg, trueEastLongitudeDeg, diameterKm]`, largest diameter first.
  Keeping Float32 avoids extra coordinate rounding while the full set remains
  comfortably below the 25 MB drawing-data limit.
- One global chunk holds diameters at least 20 km. Smaller records are grouped
  into the size bands 5–20 km, 2–5 km, and 1–2 km, then the 16 by 8 display-frame
  regions at geographic tiling level 3. Each source record belongs to exactly
  one chunk. The separate small south-polar study remains available as before.
- Region bounds in the index are **radians in the rotated display frame**,
  `display = (x, -z, y)` of true coordinates. Chunk records stay in the true
  Moon frame. The `centre` unit vector and `radiusRad` give a conservative
  enclosing cap that includes the largest rim, for view culling without losing
  a circle whose centre lies just outside the view.
- There are 385 chunks, totalling **15,561,552 bytes**, plus a 206,269-byte
  index. The largest individual chunk is **286,404 bytes**. The app can fetch
  large craters first, then only the regions and size bands needed by the view.

`crater-drawing-check.json` records the completed data checks: all 1,296,796
source rows are encoded exactly once; every chunk is sorted; binary read-back
matches; every region cap contains its rims; maximum Float32 centre error is
0.230 m and maximum diameter error is 0.118 m. The SHA256 hashes of the
unchanged route catalogue and small south-polar catalogue are respectively
`ad361a2552e27c2e081f1b958be8cb96b7b8cdaaf8ded561c52d36b7986f0a40` and
`32d3a5c1259e90dcd223965a30fa2bf0e0cba6ba9176ee43ebbd9e02653f6373`.

These are the catalogue's measured circle fits, not exact rim polygons.
Irregular, damaged and overlapping rims can differ from the fitted circle.
The source estimates completeness above about 1–2 km; this change does not
claim that every visible smaller crater has a catalogue entry.

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


---

# Permanent shadow

Barker, M.K., Mazarico, E., Neumann, G.A., Smith, D.E., Zuber, M.T., Head, J.W., Sun, X. (2023). A New View of the Lunar South Pole from the Lunar Orbiter Laser Altimeter (LOLA). The Planetary Science Journal 4, 183. doi:10.3847/PSJ/acf3e1. Data doi:10.60903/gsfcpgda-lola-spole.

NASA-led LRO mission data, CC0 default under https://science.data.nasa.gov/about/license; PGDA requests citation of Barker et al. (2023). Credit NASA/GSFC/LOLA team. No NASA endorsement is implied.

Primary product and usage policy: https://pgda.gsfc.nasa.gov/products/90

Source file LPSR_80S_20MPP_ADJ.TIF. NASA-led LRO mission data, CC0 default under https://science.data.nasa.gov/about/license; PGDA requests citation of Barker et al. (2023). Credit NASA/GSFC/LOLA team. No NASA endorsement is implied. Exact area-weighted averages of native20m pixels (no COG overviews):4096PNG alpha=round(200*fraction), 2048BIN raw=round(10000*fraction), decode raw*0.01 percent. Native source uses the same sphere, pole, axes,20m cell edges and608km extent as the app. Outside80S is nodata65535/transparent. Cell fractions use the full map-plane cell area, with source nodata contributing zero; pixel centres decide the80S mask. This2023 adjusted terrain model differs from the old2016 240m map, especially at small shadows. Majority-shadow agreement with ice.bin=99.298%; PSR intersection-over-union=89.751%.

Source integrity and agreement:
```json
{
  "source": {
    "file": "features/downloads/psr-complete/LPSR_80S_20MPP_ADJ.TIF",
    "url": "https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LPSR_80S_20MPP_ADJ.TIF",
    "size": 154221202,
    "md5": "f480b3e5fa9d1f9c8d8faef51f45156a"
  },
  "grid": {
    "extentM": [
      -304000,
      -304000,
      304000,
      304000
    ],
    "binN": 2048,
    "pngN": 4096
  },
  "nativeValidMinimumInside80S": 1.0,
  "comparison": {
    "rule": "psr.bin >= 50% versus existing ice.bin == 1; inside80S and both valid",
    "cells": 3294392,
    "tp": 202506,
    "fp": 16541,
    "fn": 6585,
    "tn": 3068760,
    "agreementPercent": 99.29801917925978,
    "intersectionOverUnionPercent": 89.75056729541909,
    "recallOfOldPsrPercent": 96.85065354319411
  },
  "coverage": {
    "meanPermanentShadowPercent": 7.173717975616455,
    "cellsWithAnyPsrPercent": 20.631181717294115,
    "majorityPsrCellsPercent": 6.649087297443655
  }
}
```

The read-only supplied TIFF is truncated at4,493,312bytes and fails native tile reads. It was left untouched; a complete primary-source replacement is stored inside assets-codex.


---

## Water ice: predictions, orbital signs, and a direct measurement

`features/scripts/build_waterice.py` builds **both** `waterice.bin` / `waterice.png` and `ice-sites.json`. It reads the published Diviner PRP depth field, the existing app maximum-temperature grid, the new sharp PSR grid, the app's IAU names, and the open Lemelin PSR catalogue. All outputs and its source-keyed thermal cache stay inside `assets-codex/`.

The map is a prediction of where ice could last. It is **not** a map of ice abundance, proven deposits, extractable reserves, or current temperature. The binary is 2048 × 2048 Uint16 little-endian, scale 1, offset 0, top row first, using the project's exact stereographic grid. Pixels outside 80°S are 65535 and transparent. Code 0 means none mapped under the following rules; it does not prove ice is absent.

### Exact classification rules

| Code | Meaning | Exact rule, in priority order |
| --- | --- | --- |
| 3 | Detected from orbit | **Empty.** No openly downloadable, redistributable, geolocated Li et al. (2018) detection point list or raster was found. No points were digitized from a figure and no source PSR polygon was filled as a detection. |
| 2 | Predicted, at the surface | `psr.bin > 0` and `<65535`, and the existing `temp-max.bin * 0.01 < 110 K`, within 80°S. Thus the coarse cell **contains** some permanent shadow and its interpolated annual maximum is below the approximate surface-ice stability threshold. The entire cell is not asserted to be in shadow. |
| 1 | Predicted, just under the surface | Nearest published PRP triangle-centre `ice_depth > 0 and <= 1.0 m`, and existing annual maximum surface temperature `>=110 K`, within 80°S. The shallow stable horizon is modelled, while the surface is too warm under the chosen threshold. |
| 0 | None mapped | All other valid cells. This includes cells where no prediction qualifies, or where the PRP reports its excluded depth value. |

The PRP `DLRE_PRP.FMT` **does contain the needed depth**: column 15 `ice_depth`, START_BYTE 198, BYTES 11. Its physical definition is the depth at which sublimation loss is **1 kg m⁻² per billion years**. A depth of zero denotes surface stability; `-999` means the calculated stable depth exceeds **2.8738 m**. The native excluded values are retained during nearest-centre resampling. They are never removed to interpolate a shallow horizon across otherwise unsuitable ground. This is not a threshold on average temperature, nor an invented depth model.

For depth, a cKDTree selects the closest of the 2,880,000 published PRP triangle centres in the same stereographic coordinates. The maximum centre-to-query distance inside the valid domain is 266.83 m, median 146.33 m. The annual maximum comes from the existing app layer, whose builder linearly interpolates the source PRP `temp_max` field. The PRP is a thermal-model fit to Diviner's first mapping year (2009–2010), on an approximately 0.5 km Kaguya-derived triangular mesh. Fine thermal structures are blurred; the separate depth and temperature resampling can give differences near a class boundary. This rule intentionally rejects shallow-depth predictions where the independently interpolated surface-temperature criterion is not satisfied.

The approximately **110 K** long-term exposed-water-ice threshold follows Paige et al. (2010) and is consistent with Fisher et al.'s (2017) albedo/temperature transition. It is an approximate stability criterion, not a temperature at which ice is detected or a universal sharp phase boundary. Predictions depend on model assumptions, loss criterion, local illumination and terrain history. The 1 m cutoff is MOONDA's requested presentation of the published depth field, not a distinct claim from the paper.

The PNG is 4096 × 4096 RGBA. Class 1 uses `(110,150,255,110)` and class 2 `(80,210,255,170)`; `(255,255,255,230)` is reserved for class 3 and unused. The 2048 thermal masks are nearest-upsampled; class 2 is additionally clipped to **nonzero exact 4096 PSR fraction** from `psr-fraction-4096.npy`, not the rounded alpha image. This retains the sharp shadow boundary without claiming 148 m thermal resolution. A small shadow in a cold coarse cell can qualify as class 2; its unshadowed portion stays transparent in the PNG. Therefore the binary's cell label and the PNG's coloured footprint intentionally have different semantics.

### Exact source files, provenance and rights

The source inventory is `features/out/waterice-sources.json`; the marker download inventory is `features/downloads/waterice-li/source-inventory.json`. They record exact source URLs, byte sizes and MD5s. Key inputs are:

| File | Primary URL | Bytes | MD5 |
| --- | --- | ---: | --- |
| `../data-raw/pds-diviner-prp/dlre_prp_south.zip` | [NASA PDS zipped table](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/extras/prp/dlre_prp_south.zip) | 116583332 | `fd8a182b8cea450328f798be716ec3f4` |
| ZIP member `dlre_prp_south.tab` | [NASA PDS uncompressed table](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_prp/dlre_prp_south.tab) | 604800210 | `80cdfe83592a3419c74b1b55b636711e` |
| `dlre_prp_south.lbl` | [PDS label](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_prp/dlre_prp_south.lbl) | 2167 | `c209edaaa10c7af19d973e252ac589ec` |
| `dlre_prp.fmt` | [PDS field definitions](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/label/dlre_prp.fmt) | 5884 | `2d76ebfb5d4c3396b1fa7e15c43b83d8` |
| `prpds.cat` | [PDS dataset description](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/catalog/prpds.cat) | 5776 | `b98b0b42f32947d835e3c8d0ecc9dff0` |
| `../app/public/data/layers/temp-max.bin` | Derived locally from that PRP table by `../data-prep/layers/build_layers.py` | 8388608 | `1fd50fa1121687431661dbb41a149c85` |
| `../app/public/data/names.json` | [IAU/USGS Gazetteer](https://planetarynames.wr.usgs.gov/) | 1031425 | `6f536f7a50425acef2c8da07180cf47c` |
| `Lemelin_et_al_2021_PSJ_south_pole_volatiles_ROIs_supp.zip` | [Zenodo record 4646092 data ZIP](https://zenodo.org/api/records/4646092/files/Lemelin_et_al_2021_PSJ_south_pole_volatiles_ROIs_supp.zip/content) | 488316 | `1461935ab7273f4e907bed38b2d31a30` |

The sharp-shadow source is the complete NASA PGDA `features/downloads/psr-complete/LPSR_80S_20MPP_ADJ.TIF`, described in the PSR section and inventory. The originally supplied `../data-raw/pgda-lola-spole-psr/LPSR_80S_20MPP_ADJ.TIF` was truncated and was **not** used. The replacement was downloaded as data and the original was untouched.

PRP product: **LRO-L-DLRE-5-PRP-V2.0**, product version 2, created **2018-02-21**, calibration software 4.0. Cite Paige et al. (2010) plus Paige et al. (2018), *LRO DLRE Level 5 PRP V2.0*, NASA PDS. NASA/PDS data are public domain; the [PDS Geosciences FAQ](https://pds-geosciences.wustl.edu/faq.html) states this explicitly and requests appropriate citation. Credit NASA/LRO/Diviner and the Diviner science team. Credit IAU WGPSN/USGS for crater names and positions. PGDA's adjusted PSR product requests Barker et al. (2023), rather than attributing that newer raster only to the old Mazarico product.

The Lemelin database is **CC BY 4.0**, verified in the [Zenodo metadata](https://zenodo.org/records/4646092). Credit Lemelin, Li, Mazarico, Siegler, Kring and Paige (2021), dataset DOI **10.5281/zenodo.4646092**, paper DOI **10.3847/PSJ/abf3c5**. The supplementary ZIP's extracted `.shp` and `.dbf` are the exact polygon/Count_M3 input; all extracted-member hashes are in the inventory. Article text and imagery retain their publishers' terms; they are cited rather than copied into the app. No licence is inferred from a paper's availability.

### Named evidence markers and spatial checks

All marker `lat`, `lon` and `diameterKm` values are read directly from the app's `names.json`. Marker coordinates are the **crater centre**, never the actual ice location or the LCROSS impact coordinate. Status applies to evidence somewhere in the crater, not its entire interior. The direct LCROSS impact site remains the separate test coordinate **−84.675°, −48.725°** supplied in the brief.

Lemelin's dataset contains **169 PSR polygons**, with **820** M3 detection counts in total. It supplies **counts**, not individual detection locations. For regional markers, the builder computes spherical distances from every source polygon vertex to an IAU crater centre. Only polygons wholly inside **0.99 × IAU crater radius** may contribute their published counts. Matching a similar name or one representative point is insufficient. Exact source record IDs, maximum vertex distances and accepted counts are recorded in `ice-sites-association-audit.json`.

Accepted markers and supporting contained-PSR counts: Cabeus (18; status confirmed because of LCROSS), Shackleton (34), Haworth (80), Shoemaker (134), Faustini (34), Nobile (30), de Gerlache (8), Scott (1), Kuhn (4), and Malapert C (2). The latter nine have `detected` status: M3 spectral signs are reported within accepted source PSRs. This does **not** turn any raster pixel into class 3 because the exact detection pixels remain unavailable.

Amundsen, Slater and Wiechert have `predicted` markers because the derived PSR/temperature map contains cold-trap cells in their IAU circles and no M3 detection in the audited 169-PSR catalogue could be assigned by the conservative spatial rule. This means **no assigned detection in this reviewed catalogue**, not a claim that every published observation found no ice. A nondetection is not proof of absence.

Sverdrup and Malapert's named positive-count source PSRs cross the IAU-circle boundaries, so their individual M3 pixels cannot be placed confidently inside the crater from the counts alone; these markers are omitted. The source PSR called “Wiechert J” is roughly 100 km from the actual IAU crater of that name and is not transferred to Wiechert or Wiechert J. `Idel'son L` is not present in the app's IAU names input. No unsupported marker was invented to complete the example list.

### Evidence reviewed before choosing the classes

- **LCROSS — direct water measurement:** Colaprete, A., et al. (2010), *Detection of Water in the LCROSS Ejecta Plume*, **Science 330, 463–468**, DOI [10.1126/science.1186986](https://doi.org/10.1126/science.1186986). Spectrometers measured water vapour and ice in ejecta from one Cabeus impact site; the inferred local abundance was 5.6 ± 2.9 wt%. This supports the Cabeus `confirmed` marker, not a confirmed-ice crater fill.
- **M3 — diagnostic surface spectra:** Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., Hurley, D.M., Elphic, R.C. (2018), *Direct evidence of surface exposed water ice in the lunar polar regions*, **PNAS 115, 8907–8912**, DOI [10.1073/pnas.1802345115](https://doi.org/10.1073/pnas.1802345115). The [paper's associated data](https://pmc.ncbi.nlm.nih.gov/articles/PMC6130389/) provide an SI PDF; the [author's research page](https://www2.hawaii.edu/~shuaili/Research.html) says the Figure 4 ice locations are available upon request. No shippable coordinate list or detection raster was found. The article's CC BY-NC-ND 4.0 terms do not authorize inventing a derivative georeferenced map by tracing its figure. Class 3 stays empty.
- **Published M3 regional counts:** Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021), *Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region of the Moon*, **The Planetary Science Journal 2, 103**, DOI [10.3847/PSJ/abf3c5](https://doi.org/10.3847/PSJ/abf3c5). Its open database supports the regional marker associations above. Its PSR representative positions are not detection points.
- **LAMP — supporting ultraviolet signs:** Hayne, P.O., Hendrix, A., Sefton-Nash, E., Siegler, M.A., Lucey, P.G., Retherford, K.D., Williams, J.-P., Greenhagen, B.T., Paige, D.A. (2015), *Evidence for exposed water ice in the Moon's south polar regions from Lunar Reconnaissance Orbiter ultraviolet albedo and temperature measurements*, **Icarus 255, 58–69**, DOI [10.1016/j.icarus.2015.03.032](https://doi.org/10.1016/j.icarus.2015.03.032). UV albedo combined with low temperature supports frost interpretations; the signatures alone are less specific than diagnostic M3 ice bands and are not converted into new confirmed pixels.
- **LOLA albedo — supporting brightness evidence:** Fisher, E.A., et al. (2017), *Evidence for surface water ice in the lunar polar regions using reflectance measurements from the Lunar Orbiter Laser Altimeter and temperature measurements from the Diviner Lunar Radiometer Experiment*, **Icarus 292, 74–85**, DOI [10.1016/j.icarus.2017.03.023](https://doi.org/10.1016/j.icarus.2017.03.023). A brightness increase below roughly 110 K supports surface-ice interpretations; albedo is not an unambiguous compositional measurement, so no brightness threshold becomes class 3.
- **Neutrons — hydrogen, not a uniquely identified ice mineral:** Feldman, W.C., et al. (1998), *Fluxes of fast and epithermal neutrons from Lunar Prospector: Evidence for water ice at the lunar poles*, **Science 281, 1496–1500**, DOI [10.1126/science.281.5382.1496](https://doi.org/10.1126/science.281.5382.1496); Mitrofanov, I.G., et al. (2010), *Hydrogen Mapping of the Lunar South Pole Using the LRO Neutron Detector Experiment LEND*, **Science 330, 483–486**, DOI [10.1126/science.1185696](https://doi.org/10.1126/science.1185696). These measurements support hydrogen enrichment over broad footprints. They do not locate individual surface-ice exposures, so the supplied LEND/LP hydrogen products are not burned into class 3.
- **Mini-RF — possible ice, with scattering ambiguity:** Patterson, G.W., et al. (2017), *Bistatic Radar Observations of the Moon Using Mini-RF on LRO and the Arecibo Observatory*, **Icarus 283, 2–19**, DOI [10.1016/j.icarus.2016.05.017](https://doi.org/10.1016/j.icarus.2016.05.017). The [NASA primary record](https://ntrs.nasa.gov/citations/20170003185) reports an unusual Cabeus response that may indicate near-surface ice. Radar scattering is also affected by roughness and is not treated as direct water measurement.
- **Thermal predictions:** Paige, D.A., et al. (2010), *Diviner Lunar Radiometer Observations of Cold Traps in the Moon's South Polar Region*, **Science 330, 479–482**, DOI [10.1126/science.1187726](https://doi.org/10.1126/science.1187726), supplies the model basis for classes 1–2. Siegler, M.A., et al. (2016), *Lunar true polar wander inferred from polar hydrogen*, **Nature 531, 480–484**, DOI [10.1038/nature17166](https://doi.org/10.1038/nature17166), shows why present thermal suitability alone does not establish a deposit's history or present content. Schorghofer, N., Williams, J.-P. (2020), *Mapping of Ice Storage Processes on the Moon with Time-dependent Temperatures*, **The Planetary Science Journal 1, 54**, DOI [10.3847/PSJ/abb6ff](https://doi.org/10.3847/PSJ/abb6ff), provides an alternative observationally based stability model. The supplied `polar_south_80_Emax.grd`, `pump.grd`, `zit-1.grd`, `zit-100.grd` were inspected; they come from [Harvard Dataverse DOI 10.7910/DVN/EGOOCL](https://doi.org/10.7910/DVN/EGOOCL), V3, CC0 1.0, `polar_south_24x6` (2009–2020 data). They were not combined with the PRP to create an undocumented hybrid depth model. Their `zit-1` corresponds to the same loss criterion, but can disagree because the input years and modelling methods differ.

The [LPI Lunar South Pole Atlas](https://www.lpi.usra.edu/lunar/lunar-south-pole-atlas/), [LRO Science and Data](https://science.nasa.gov/mission/lro/science-and-data/), and [LROC atlases](https://lroc.im-ldi.com/atlases) were checked as requested. They provide mission/data context, terrain and PSR maps, and explanations of possible volatiles. A PSR outline or an atlas illustration is not an ice-detection raster. The atlas's volatile diagrams explicitly illustrate possible, patchy distributions that need surface investigation. None was digitized into measured ice pixels. The separate [surface-ice source audit](downloads/waterice-li/RESEARCH.md) records the dataset search in more detail.

### Built coverage and checks

On the valid 80°S–90°S grid (3,294,128 cells), code 0 occupies **58.585337%**, predicted buried code 1 **36.819577%**, predicted surface code 2 **4.595086%**, orbital detection code 3 **0%**; 900,176 cells are no-data: 899,912 lie outside the circular domain and 264 lie inside 80°S but have no value in the existing interpolated temperature grid. Those 264 cells remain unknown; they are not forced to class 0. These are grid-cell coverage percentages, not measured ice area or abundance.

The requested Shackleton floor coordinate (−89.67°, 129.2°) is class 2, PSR **100%**, Tmax **87.51 K**. LCROSS (−84.675°, −48.725°) is class 2, PSR **100%**, Tmax **47.83 K**. Malapert massif summit (−85.99°, 2.9°) is class 0, PSR **0%**, Tmax **241.50 K**. The marker for Malapert crater would be a different place from the massif summit; the omitted ambiguous regional marker is not a claim about that summit.


---

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

