# Moon science maps

Updated 14 November 2026. Maps have different coverage. Empty space is not proof
that no ice, shadow or danger exists there. Predictions, orbital signs and water
measured on the spot are separate kinds of evidence.

| Map | Coverage and detail | Rebuild and primary-source audit |
| --- | --- | --- |
| PSR | Both poles beyond 65°. South retains the exact 4096-pixel picture from the 20 m source. North uses 240 m, 120 m and 60 m LOLA products, with a 4096-pixel inner picture. | [Polar notes](NOTES-polar-water.md) |
| Water ice: predicted | Diviner thermal models and LOLA shadow at both poles beyond 80°. About 0.5 km thermal mesh; sharper shadow edges do not make the thermal model more detailed. | [Polar notes](NOTES-polar-water.md) |
| Water ice: seen from orbit | Lunar Prospector hydrogen across the Moon, 0.5° bins with a much broader neutron footprint. Hydrogen is not a unique water-ice detection. | [Polar notes](NOTES-polar-water.md) |
| Water ice: markers | LCROSS water measurement at one spot in Cabeus; M3 spectral signs in southern craters; cautious northern radar candidates; predicted-only cold traps. Markers do not fill entire craters with measured ice. | [Marker notes](../sites/ICE-NOTES.md) |
| Slope | Global NASA LDEM_64 heights, a 1.42 km ground stencil; displayed at 8192 × 4096. The original south-pole 80 m source / 240 m stencil remains. | [Global notes](NOTES-global.md) |
| Danger zones | Same slopes, classes 10–15°, 15–25° and over 25°, plus catalogued small crater interiors as caution areas. No warning does not mean safe ground. | [Global notes](NOTES-global.md) |
| Height colours | Existing LOLA colour-height maps, unchanged data. | [Original layer contract](README.md) |
| Sunlight, Earth view and temperature | Existing south-pole products remain for the planner and spot values. Their switches are removed from Layers. | [Original layer contract](README.md) |

Run from the repository root, after the SSD mount check:

```sh
.venv-data/bin/python -I data-prep/layers/download_global_terrain.py
.venv-data/bin/python -I data-prep/layers/build_global_terrain.py
.venv-data/bin/python -I data-prep/layers/download_polar_water.py
.venv-data/bin/python -I data-prep/layers/build_polar_water.py
.venv-data/bin/python -I data-prep/layers/repack_south_terrain.py
.venv-data/bin/python -I data-prep/layers/build_compact_layers.py
.venv-data/bin/python -I data-prep/layers/assemble_manifest.py
.venv-data/bin/python -I data-prep/sites/build_ice_sites.py
.venv-data/bin/python -I data-prep/sites/make_sites_ts.py
```

Downloaders retain each product in its own `data-raw/` folder and check byte
counts and HTTP ranges. Downloaded files are data and are never executed.
The builders use the existing isolated Python environment. No package install,
server, build, commit or deployment is part of these scripts.

Stored display maps use independently compressed 512-pixel blocks: one byte
per pixel for PSR, slope and hydrogen, two bits for danger and predicted-water
classes, and exact RGB for height. Colour tables are applied while drawing a
tile. Startup downloads compressed bytes without decoding maps or delaying
entry for provider preparation. Fine blocks decode in the science worker on
demand; source blocks share 64 MiB and small previews share 12 MiB. Unused
decoded data expires after two minutes, checked every 20 seconds. Prepared
tile bitmaps share 4 MiB; legacy spot grids share 16 MiB. The full format and
rebuild checks are in [NOTES-compact.md](NOTES-compact.md).

Numerical maps use byte codes with a stated scale; 255 means missing, not zero.
The original Uint16 `sunlight.bin`, `earth.bin` and `psr.bin` remain byte-for-byte
in the planner's expected south-pole format.

`assemble_manifest.py` merges the independent builders into `manifest.json`.
Later map sources lie on top. Sharper southern slope/danger maps replace the
global map, including clear pixels, so a coarse warning cannot leak through.
Numerical lookups use valid legacy south-pole values first, then new coverage.

No geolocated north-polar M3 detection raster/point list was located in the
reviewed public release; the author offers the Figure 4 locations on request.
No figure was traced. Public LEND count-rate grids exist, but converting them
to hydrogen or ice requires a detector/background model. Those counts are
documented in the polar notes and are not relabelled as ice detections.

Current memory, first-switch and offline results are recorded in
[QA-memory.md](QA-memory.md). [QA.md](QA.md) preserves the earlier visual and
scientific checks, including the superseded eager-decoding memory figures.

## Requests for other owners

- Session K's Craters startup preparation now meets the switch target. This
  session did not edit `craterLayer.ts` or the crater data.
- `PlaceCard.tsx` gates every science row behind `if (polar)`. Remove that gate
  for Slope, PSR and Water ice and use missing values as a dash, so the new
  `layerValues.ts` answers can appear at Apollo 11 and the north pole. Sunlight
  and Earth still have only the old southern coverage.
- Generalise `ice.detected` in `i18n/en/explore.ts` to **Seen from orbit**, with
  Khmer **ឃើញពីគន្លង**. Radar candidates are not necessarily surface ice.
- The card's instrument/finding text is raw English. Add localisation lookups;
  bilingual marker text is supplied in `data-prep/sites/ice-i18n-additions.json`.
  For water value 3, prefer **Hydrogen seen from orbit;
  ice unconfirmed**, not a claim of measured water.
- `flatMap.ts` only accepts the old southern raster or remote Moon Trek tiles.
  It needs a composite local science-map source to show the new northern and
  global coverage in 2D. This session owns only its MoonMap wiring, so the 3D
  globe uses the new products and the current 2D implementation remains limited.
- Restyle the plain quiet coverage notes if desired. The existing panel look,
  components and tokens are retained.
- The README's old descriptive bullets and any tutorial/help copy still mention
  thirteen switches and southern-only groups. This session changed only the
  permitted source-table rows; the text owner should update those descriptions.
