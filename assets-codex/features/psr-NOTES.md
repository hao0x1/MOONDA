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
