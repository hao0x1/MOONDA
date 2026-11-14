# Independent data audit

The audit read the project README and the existing layer README, common.py,
build_layers.py and check_layers.py before inspecting the new builders. It did
not run the existing builders or write outside assets-codex.

- `build_craters.py` uses Robbins circular-fit latitude, longitude and diameter,
  the requested union of filters, descending stable diameter sorting and
  little-endian Float32 triples. The produced files contain 112,955 Robbins
  records and 3,317 archived small-catalogue records. Neither file has duplicate
  encoded triples. The optional catalogue's licence is verified against its
  Zenodo record and the local CSVs against the record's MD5 and byte sizes.
- `build_danger.py` matches the established Horn arithmetic and stereographic
  scale correction. Its strip computation is checked against the established
  function; its worst-overlap resampling is checked against brute-force pixel
  intersections. The spherical-circle projection and rectangle intersection
  are conservative at crater edges. The optional catalogue contains 14 craters
  between 1 and 3 km; the danger builder was asked to include these too.
- `build_psr.py` reads native 20 m base pixels in strips, rather than resampling
  a COG overview. Its cumulative-integral method splits source pixel area at
  destination edges in both dimensions. It preserves the established extent,
  orientation and 80 S mask. A complete replacement download is needed because
  the supplied TIFF is truncated; the supplied file is not modified.
- The Diviner PRP format explicitly defines `ice_depth` in metres at a loss of
  1 kg/m2 per billion years. Zero means surface stability; -999 means the
  calculated stability depth exceeds 2.8738 m. Retaining invalid cells during
  nearest-centre sampling avoids interpolation across unsuitable terrain.

## Corrections raised during the build

- The 20 m adjusted PSR source requires Barker et al. (2023), PSJ 4, 183,
  DOI 10.3847/PSJ/acf3e1, rather than only the older Mazarico illumination paper.
- The Lemelin paper is *Framework for Coordinated Efforts in the Exploration of
  Volatiles in the South Polar Region of the Moon*, PSJ 2, 103,
  DOI 10.3847/PSJ/abf3c5; author and title placeholders were flagged.
- The exact 4096 PSR fraction should determine whether a display pixel contains
  shadow, instead of testing a rounded 8-bit alpha value.
- Lemelin PSR names cannot be matched blindly to IAU crater names. The polygon
  named Wiechert J has its centroid about 103.6 km from the IAU Wiechert J centre,
  whose radius is only 17.445 km. Only Sverdrup 1 has its centroid inside the IAU
  Sverdrup circle; numbered Sverdrup 2-6 are outside. These associations were
  sent to the ice builder for spatial verification or omission. Other reviewed
  named PSR centroids are inside the matching IAU circles, but counts still
  locate detections only within a PSR, not at its centroid or throughout it.

## Final water-ice inspection

The final builder uses the true PRP depth field, preserves -999 depth cells,
uses the existing maximum-temperature grid and assigns the published approximate
110 K threshold explicitly. Class 3 remains empty because the available
redistributable polygons contain counts, not individual detection coordinates.
The sharp PNG now tests the exact saved PSR fractions. Barker and Lemelin
citations were corrected.

The marker builder now requires every vertex of a positive-count source PSR to
be within 0.99 of the IAU crater radius before assigning its detections to that
crater. This rejects the mismatched Wiechert J association and boundary-crossing
Sverdrup/Malapert associations. The 13 markers use exact names.json centres and
diameters: one confirmed LCROSS region, nine orbital-evidence regions, and three
thermal-prediction regions. The source polygon indices/counts are retained in
ice-sites-association-audit.json.

There are 264 water-ice no-data cells inside the 80 S disk because the existing
temperature grid lacks data at those edge positions. These should remain
65535 and transparent, rather than be filled to make the disk appear complete.
Coverage percentages correctly use the valid water-ice-cell denominator.

This audit complements the final check.py numeric and visual checks; it is not
a rover safety certification or independent remeasurement of source products.
