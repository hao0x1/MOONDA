# MOONDA science layers (south pole, 80°S–90°S)

This folder holds the scripts that turn published NASA lunar datasets into the map overlays the
MOONDA app loads from `app/public/data/layers/`. Nothing here is invented: each layer is either a
published product reprojected onto the app grid, or (slope and height only) computed directly
from the LOLA elevation model.

## Output contract

Every layer uses the same grid:

- South polar stereographic on a 1,737,400 m sphere, pole at the centre, latitude of true scale
  −90°, central meridian 0°. CRS string:
  `+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +k=1 +x_0=0 +y_0=0 +R=1737400 +units=m +no_defs`
- `x = ρ·sin(lon)` (toward 90°E, image right) and `y = ρ·cos(lon)` (toward 0°, image up), where
  `ρ = 2R·tan(45° + lat/2)` and lat is negative.
- x and y run from −304000 to +304000 m. The raster is 2048 × 2048 at 296.875 m per pixel, and
  row 0 is the top (y = +304000). Pixel (col, row) has its centre at
  `x = −304000 + (col + 0.5)·296.875` and `y = 304000 − (row + 0.5)·296.875`.

Each layer `<id>` produces three things:

- `<id>.png`: an RGBA colour overlay, transparent where there is no data. For `ice` it is also
  transparent wherever the pixel is not in permanent shadow.
- `<id>.bin`: Uint16 little-endian values, 2048 × 2048, row-major from top to bottom. Decode with
  `v = raw·scale + offset`. A raw value of 65535 means no data.
- An entry in `manifest.json`, which is an array of objects with these fields: `id`, `title`,
  `shortHelp`, `units`, `scale`, `offset`, `valueMin`, `valueMax`, `legend[{value, color}]`,
  `source{name, url, citation, version}` and `notes`. `valueMin` and `valueMax` are the ends of
  the colour scale. Values outside that range are clamped in the PNG only; the `.bin` file keeps
  the true value.

## Layers and sources

| id | What it is | Source product (exact file) | Resampling | Encoding |
|---|---|---|---|---|
| `sunlight` | Average % of time any part of the Sun is above the local horizon | LOLA `AVGVISIB_65S_240M_201608.IMG` (240 m), from [PDS Geosciences LOLA EXTRAS](https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/extras/illumination/img/avgvisib_65s_240m_201608.img). The label gives PRODUCT_VERSION_ID V1.05, created 2016-09-15. The data are DN × 0.00004, so 25000 = 1. | bilinear | % · scale 0.01 |
| `earth` | Average % of time any part of Earth is above the horizon (direct-to-Earth visibility) | LOLA `AVGVISIB_65S_240M_201608_EARTH.IMG`, [PDS](https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/extras/illumination/img/avgvisib_65s_240m_201608_earth.img), same release | bilinear | % · 0.01 |
| `ice` | Permanently shadowed regions (PSRs): 1 = PSR, 0 = not | LOLA `LPSR_65S_240M_201608.IMG`, [PDS](https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/extras/illumination/img/lpsr_65s_240m_201608.img). DN +20000 = PSR and −20000 = not. This is the published map, not derived from `sunlight`. | nearest | flag · 1 |
| `temp-max` | Annual maximum surface temperature (K) | Diviner Polar Resource Product `DLRE_PRP_SOUTH.TAB`, column `temp_max`, from [PDS](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_prp/dlre_prp_south.tab). We downloaded it as the identical zipped copy `extras/prp/dlre_prp_south.zip`. Dataset LRO-L-DLRE-5-PRP-V2.0, created 2018-02-21. | linear interpolation of triangle centres (scipy Delaunay) | K · 0.01 |
| `temp-avg` | Annual average temperature at 2 cm depth (K) | Same PRP table, column `temp_avg` | same | K · 0.01 |
| `slope` | Slope in degrees | Computed by us from LOLA `LDEM_80S_80M.JP2` (80 m), [PDS](https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/jp2/ldem_80s_80m.jp2). JP2 label V2.1, created 2017-06-15, LOLA data 2009-07-13 to 2017-02-02. Horn 3×3 slope is computed at 80 m and corrected by the stereographic scale factor k = 1 + (ρ/2R)². | bilinear (80 m → 297 m) | ° · 0.01 |
| `height` | Elevation relative to the 1737.4 km sphere (m) | Same DEM. height = DN × 0.5 m, checked against `polar-far-80m.tif` (max abs difference 0). The PNG is a hypsometric colour ramp multiplied by a hillshade (light from the upper left, 2× vertical exaggeration). | bilinear | m · scale 0.5, offset −10000 |

### Citations

- **Illumination, Earth visibility and PSRs:** Mazarico, E., Neumann, G.A., Smith, D.E., Zuber,
  M.T., Torrence, M.H. (2011). Illumination conditions of the lunar polar regions using LOLA
  topography. *Icarus* 211, 1066–1081. doi:10.1016/j.icarus.2010.10.030. This is the citation that
  [NASA PGDA product 69](https://pgda.gsfc.nasa.gov/products/69) requests. The simulation uses
  hourly steps over about 18.6 years (one lunar nutation cycle), with the LOLA LDEM_65S_240M
  terrain.
- **Temperatures:** Paige, D.A., et al. (2010). Diviner Lunar Radiometer observations of cold
  traps in the Moon's south polar region. *Science* 330, 479–482. doi:10.1126/science.1187726.
  Dataset: Paige et al., LRO DLRE Level 5 PRP V2.0, NASA PDS, LRO-L-DLRE-5-PRP-V2.0 (2018).
- **DEM:** Smith, D.E., et al. (2010). The Lunar Orbiter Laser Altimeter investigation on the
  Lunar Reconnaissance Orbiter mission. *Space Sci. Rev.* 150, 209–241.
  doi:10.1007/s11214-009-9512-y. Dataset: LRO-L-LOLA-4-GDR-V1.0, product LDEM_80S_80M.

## Not available, and caveats

- **Annual minimum temperature:** we found no published south-polar Tmin raster in a reasonable
  download size, so the app gets `temp-avg` instead of `temp-min`. The Diviner Polar Cumulative
  Products (Williams et al. 2019, JGR Planets 124, 2505–2521; PDS `data_derived_pcp`) could
  produce one. They contain binned Tbol tables by local time and season, but they come as 192
  files of about 213 MB each (about 40 GB), so we skipped them. The UCLA raster mirror
  (luna1.diviner.ucla.edu) fails TLS certificate verification, so we did not use it.
- **PRP model limits:** the PRP values are thermal-model fits to Diviner's first mapping year
  (2009–2010). They are computed on a mesh of about 0.5 km triangles built from Kaguya laser
  altimetry, so anything smaller than about 1 km is blurred. Clicked values are model values, not
  live temperatures.
- **Temperature cross-check:** we compared our temperatures with Schorghofer & Williams' maps on
  Harvard Dataverse (doi:10.7910/DVN/EGOOCL, `polar_south_24x6`). Those maps use Diviner
  observations from 2009-07 to 2020-03, at 240 m. They are not used in the app. Correlation was
  r = 0.894 for Tmax and r = 0.965 for Tmean. The median difference (ours minus theirs) was
  +3.6 K for Tmax and +6.4 K for Tmean. The PRP is somewhat colder than the observation maps on
  some small crater floors, for example Shackleton Tmax 82 K vs 97 K.
  `crosscheck_temperature.py` reproduces this. The observation-based maps would be a reasonable
  upgrade if a team member prefers them, but they have no Tmin either.
- **Peak sunlight is smoothed:** the source pixels are 240 m and the app grid uses 297 m pixels.
  At the connecting ridge, the 240 m product gives 93.5%, while the 297 m layer shows 79.9%.
  Narrow ridge crests are always underestimated at this grid size.
- **Earth visibility counts any sliver of Earth's disc.** It also ignores which ground station on
  Earth is facing the Moon, so real link time is lower.
- **PSRs are cold traps, not confirmed ice.** Nearest-neighbour resampling can drop PSRs smaller
  than about 300 m.
- **Slope uses about a 240 m baseline.** Hazards at lander scale (boulders, small craters) are
  not resolved.

## How to rerun

```zsh
PY=/Volumes/CodexWork/Projects/MOONDA/.venv-data/bin/python
L=/Volumes/CodexWork/Projects/MOONDA/data-prep/layers
zsh $L/download_sources.sh                 # ~400 MB into data-raw/ (skip if already present)
$PY -I $L/build_layers.py                  # all layers + manifest (~40 s)
$PY -I $L/build_layers.py sunlight ice     # or just some layers (manifest entries are merged)
$PY -I $L/check_layers.py                  # validation, spot checks, orientation test, previews/
$PY -I $L/crosscheck_temperature.py        # optional temperature cross-check
```

Files:

- `common.py`: grid, CRS, lat/lon ↔ x/y, encoding, colormaps and writers.
- `build_layers.py`: one function per source.
- `check_layers.py`: validation, spot checks and previews. It writes `previews/*.png` and
  `previews/spotcheck.json`.
- `crosscheck_temperature.py`: temperature cross-check. It writes
  `previews/temperature_crosscheck.json`.

### Raw inputs (data-raw/, MD5)

```
pds-lola-illumination/avgvisib_65s_240m_201608.img        8a68530bdd912d5a5035c2655f1fdbe8
pds-lola-illumination/avgvisib_65s_240m_201608_earth.img  63ff0feab8c1f924b0a626b6c25c0e32
pds-lola-illumination/lpsr_65s_240m_201608.img            95f77c347263707a975815a0a842ab60
pds-diviner-prp/dlre_prp_south.zip                        fd8a182b8cea450328f798be716ec3f4
dataverse-schorghofer-williams/polar_south_24x6_Tmax.grd  87a44fa30fbb0b2daa257f3fe3fe3b01
dataverse-schorghofer-williams/polar_south_24x6_Tmean.grd 53a3963363afbb8b769604e032686f7c
```

## Checks (latest run)

Orientation: inside six named crater floors (IAU centres), every layer gives the expected value
at the true position and not at mirrored positions. The PSR fraction is 0.80 as-is versus about
0.19 mirrored. Tmax is 94 K as-is versus about 205 K mirrored. Height is −2959 m as-is versus
about −1000 m mirrored. The previews also put 0° up and 90°E right: Malapert is above the pole,
Haworth is up and slightly left, Amundsen is to the right, and the Earth-visible nearside is at
the top.

Spot values are the pixel value on the 2048 grid, with the 240 m source value in brackets:

| Site | Sun % | Earth % | PSR | Tmax K | Tavg K | Slope ° | Height m |
|---|---|---|---|---|---|---|---|
| Shackleton floor (89.67°S, 129.78°E) | 0.0 (0.0) | 0.0 | 1 | 81.8 | 50.0 | 2.0 | −2785 |
| Connecting ridge (89.45°S, 222.7°E) | 79.9 (93.5) | 56.8 | 0 | 222.0 | 125.3 | 2.4 | 1953 |
| Malapert summit (86.0°S, 2.9°E) | 44.8 (38.5) | 67.8 (max 100 within 600 m) | 0 | 223.3 | 129.5 | 5.8 | 5127 |
| Haworth floor (87.45°S, 5.17°W) | 0.0 | 5.7 | 1 | 60.4 | 36.1 | 5.3 | −3306 |
| Faustini floor (87.18°S, 84.31°E) | 0.0 | 1.8 | 1 | 65.5 | 44.1 | 6.5 | −2760 |
