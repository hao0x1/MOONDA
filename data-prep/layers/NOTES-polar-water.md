# Polar shadow and water maps

Updated 14 November 2026. These files extend the existing south-pole maps. They do not change the planner's `sunlight.bin`, `earth.bin`, `psr.bin` or their formats.

## Rebuild

From the repository root, with the SSD mounted:

```sh
.venv-data/bin/python -I data-prep/layers/download_polar_water.py
.venv-data/bin/python -I data-prep/layers/build_polar_water.py
```

The downloader saves every product under its own folder in `data-raw/`, checks the HTTP byte ranges and final lengths, and records SHA-256 hashes in `polar-downloads.json`. The builder reads downloads as data. It does not execute archive contents. It uses the retained data environment; no packages are downloaded or installed.

`polar-products.json` lists the image URLs, projection, pole, extent, palette and numerical sampling file. The app's manifest assembler translates these descriptors into its own manifest format. Every added science picture is an 8-bit greyscale PNG whose byte selects an RGBA palette entry. They are not floating-point rasters. The smaller numerical PNGs are also 8-bit. Index 255 means no data, rather than zero.

## PSR at both poles

PSR means permanently shadowed region. A PSR is a cold trap candidate, not a water measurement. The LOLA team models sunlight over a complete lunar nutation cycle of about 18.6 years, using the shape of the ground. The maps describe long-term conditions, rather than the shadow on one chosen day.

Primary product page: [NASA GSFC, Lunar Polar Illumination](https://pgda.gsfc.nasa.gov/products/69). The [PDS archive listing](https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/extras/illumination/img/) publishes **both** north and south products at 65 degrees / 240 m, 75 degrees / 120 m and 85 degrees / 60 m. The newer adjusted 20 m product is published for the **south** pole only on the [NASA GSFC south-pole product page](https://pgda.gsfc.nasa.gov/products/90).

| Input | Address | Source sampling and use |
| --- | --- | --- |
| North, 65 degrees | [LPSR_65N_240M_201608.TIF](https://pgda.gsfc.nasa.gov/data/MoonIllumination/LPSR_65N_240M_201608.TIF) | 240 m, used from 65 to 80 degrees N |
| North, 75 degrees | [LPSR_75N_120M_201608.TIF](https://pgda.gsfc.nasa.gov/data/MoonIllumination/LPSR_75N_120M_201608.TIF) | 120 m, used from 80 to 85 degrees N |
| North, 85 degrees | [LPSR_85N_060M_201608.TIF](https://pgda.gsfc.nasa.gov/data/MoonIllumination/LPSR_85N_060M_201608.TIF) | 60 m, used poleward of 85 degrees N |
| South, 65 degrees | [LPSR_65S_240M_201608.TIF](https://pgda.gsfc.nasa.gov/data/MoonIllumination/LPSR_65S_240M_201608.TIF) | 240 m, used from 65 to 80 degrees S |
| South, 80 degrees, retained | [LPSR_80S_20MPP_ADJ.TIF](https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LPSR_80S_20MPP_ADJ.TIF) | 20 m native adjusted map. Existing `psr.png` and `psr.bin` stay unchanged. `psr-south-sharp.png` repacks the exact existing alpha bytes. |

The four newer PGDA TIF files are the team's 2025 format conversions of its 2016 illumination products. Native DN +20000 is shadow, -20000 is lit. A native zero cell has neither published binary flag and is left unknown. Native base pixels are read explicitly, rather than the averaged COG overview images.

All projections use a 1,737,400 m sphere and true scale at the pole. North: `x = rho sin(lon)`, `y = -rho cos(lon)`; south: `x = rho sin(lon)`, `y = rho cos(lon)`, where `rho = 2 R tan((90 - abs(lat))/2)`. Row zero is the top of the image.

| Output | Extent and sampling | Encoding |
| --- | --- | --- |
| `psr-north.png`, `psr-south-wide.png` | 4096 square, x/y +/-770,400 m; 376.171875 m display cells. Only 65 to 80 degrees is drawn. | Native binary shadow averaged by overlapping cell area, rounded to whole percent 0..100. Palette blue opacity is twice the percentage. |
| Corresponding `-values.png` | 2048 square over the same extent; 752.34375 m cells. | Whole percent of the cell in mapped permanent shadow. |
| `psr-north-sharp.png` | 4096 square, x/y +/-304,000 m; 148.4375 m cells. Poleward of 80 degrees. | Same percentage encoding; source switches from 120 m to 60 m at 85 degrees. |
| `psr-north-sharp-values.png` | 2048 square; 296.875 m cells. | Whole percent of mapped permanent shadow. |
| `psr-south-sharp.png` | Same 4096 picture and extent as the existing south-pole PSR. | Greyscale byte is the exact existing alpha 0..200. Palette restores the original RGB (72,140,220) and alpha. The existing Uint16 numerical grid keeps 0.01 percent precision. |

The wide products are transparent inside 80 degrees, so the sharper products do not get drawn twice. Outside 65 degrees there is no PSR coverage from these products. Empty map space is not proof that no smaller shadow exists. Source height errors and unresolved small terrain affect all shadow predictions.

Cite Mazarico, E., Neumann, G.A., Smith, D.E., Zuber, M.T. and Torrence, M.H. (2011), *Illumination conditions of the lunar polar regions using LOLA topography*, Icarus 211, 1066–1081, [doi:10.1016/j.icarus.2010.10.030](https://doi.org/10.1016/j.icarus.2010.10.030). For the adjusted south-pole source, cite Barker et al. (2023), *A New View of the Lunar South Pole from the Lunar Orbiter Laser Altimeter (LOLA)*, PSJ 4, 183, [doi:10.3847/PSJ/acf3e1](https://doi.org/10.3847/PSJ/acf3e1), data [doi:10.60903/gsfcpgda-lola-spole](https://doi.org/10.60903/gsfcpgda-lola-spole).

## Predicted water stability at both poles

The [NASA PDS Diviner Polar Resource Product collection](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_prp/) publishes north and south tables. The north data are openly downloadable; no invented northern model is needed.

North source: [dlre_prp_north.tab](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_prp/dlre_prp_north.tab), with the identical compressed table in [dlre_prp_north.zip](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/extras/prp/dlre_prp_north.zip). Source label: [dlre_prp_north.lbl](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_prp/dlre_prp_north.lbl). Field definitions: [dlre_prp.fmt](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/label/dlre_prp.fmt).

The PRP is a thermal model fitted to Diviner measurements, on an approximately 0.5 km triangular mesh built from Kaguya laser heights. `temp_max` is the annual maximum surface temperature. `ice_depth` is the modelled depth where the sublimation loss is 1 kg per square metre per billion years. Depth zero means stable at the surface. The value -999 means the stable depth exceeds 2.8738 m; it is **not** a missing value that may be interpolated away.

North processing uses the nearest source triangle centre for both fields. It retains -999 and rejects queries farther than 1,000 m from a triangle centre. It does not infer a fine thermal map from the sharper shadow picture.

| Code | Meaning | Rule |
| --- | --- | --- |
| 0 | No prediction under these rules | Does not prove ice is absent. |
| 1 | Predicted stable just under the surface | Published stable depth >0 and <=1 m, annual maximum surface temperature >=110 K. |
| 2 | Predicted surface cold trap | Cell contains mapped permanent shadow and annual maximum surface temperature <110 K. Only the shadowed portion of the display cell is coloured. |
| 255 | No data | Outside 80 degrees N, or beyond the distance limit. |

`waterice-north-values.png` is 2048 square over x/y +/-304 km (296.875 m cells). `waterice-north.png` is 4096 square (148.4375 m). The smaller thermal classes are enlarged without interpolating class codes. The 60/120 m PSR boundary clips surface predictions; this sharpens only the shadow boundary. The thermal source remains about 0.5 km.

`waterice-south-values.png` repacks the existing `waterice.bin` without changing its classes. `waterice-south.png` draws those classes at 4096 square, clipping class 2 to the existing sharp PSR alpha. This preserves the existing southern temperature/depth prediction. Its original rules, downloads and audit are in [the feature-data notes](../features/NOTES.md).

Both use cyan `(80,210,255,170)` for predicted surface stability and blue `(110,150,255,110)` for predicted shallow stability. Neither is an ice detection. There is no confirmed-ice raster class. The LCROSS measured plume is represented by its marker only.

Cite Paige et al. (2018), *LRO DLRE Level 5 Polar Resource Product V2.0*, NASA PDS, LRO-L-DLRE-5-PRP-V2.0, product version 2, created 21 February 2018; Paige et al. (2010), *Diviner Lunar Radiometer observations of cold traps in the Moon's south polar region*, Science 330, 479–482, [doi:10.1126/science.1187726](https://doi.org/10.1126/science.1187726).

## Hydrogen seen from orbit, across the Moon

The Lunar Prospector neutron spectrometer team provides a global hydrogen abundance map through the [NASA PDS special-products page](https://pds-geosciences.wustl.edu/missions/lunarp/reduced_special.html). Source: [hydrogenhd.dat](https://pds-geosciences.wustl.edu/missions/lunarp/reduced/hydrogenhd.dat); an [ASCII copy](https://pds-geosciences.wustl.edu/missions/lunarp/reduced/hydrogenhd.txt) and descriptions are published on that same page. The archived binary is 720 by 360, signed MSB-first 16-bit, in tenths of a part per million by weight. It starts at the south pole and longitude -180; the builder flips rows for the app's north-first convention.

This is the team's January 2002 half-degree map. The half-degree grid spacing (about 15.2 km at the equator) **does not mean** that a 15 km deposit was measured independently. Orbital neutron measurements have a broad, tens-of-kilometres footprint. Hydrogen is not a unique identification of water, and it does not establish ice. The team's warning says estimates in regions rich in thorium and rare-earth elements may be unreliable. PDS also states these are special products, **not a PDS peer-reviewed archive**. Those limits are retained here.

`hydrogen-global.png` and `hydrogen-global-values.png` are 720 by 360, equirectangular, longitude -180 to 180 and latitude 90 to -90. Code is `round(max(H,0)/2)`; decoding gives 2 ppm per code. The source estimates range from -56.1 to 195.5 ppm. 4,149 negative fit values are clipped to zero for display; these are noisy model estimates, not physical negative hydrogen and not evidence of absence. Positive quantisation error is at most 1 ppm.

The map is **purple**, separate from blue/cyan predictions. Opacity rises from zero at 25 ppm to 145/255 at 175 ppm, a display scale only. If a card uses 100 ppm to distinguish stronger enrichment, that is a display threshold, **not a published ice boundary**. Every such card must say hydrogen was seen from orbit and ice remains unconfirmed. No code means confirmed ice.

Cite Feldman et al. (2001), *Evidence for water ice near the lunar poles*, JGR Planets 106(E10), 23231–23251, [doi:10.1029/2000JE001444](https://doi.org/10.1029/2000JE001444), and the NASA PDS/Los Alamos Lunar Prospector spectrometer team.

## Products researched but not turned into ice pixels

- **M3 surface ice:** Li et al. (2018) mapped spectral ice signatures at **both** poles. [NASA JPL's account](https://www.jpl.nasa.gov/news/ice-confirmed-at-the-moons-poles/) and [the paper](https://doi.org/10.1073/pnas.1802345115) show the polar maps. The published material reviewed here does not supply a downloadable geolocated raster or point list; the [author's research page](https://www2.hawaii.edu/~shuaili/Research.html) makes the Figure 4 locations available upon request. The existing south-pole review found region-level M3 counts in Lemelin et al. (2021), rather than detection coordinates. Those support carefully sourced crater markers, not filled detection pixels. No figure is traced and no predicted shadow is relabelled as an M3 detection.
- **LEND:** [NASA PDS LEND](https://pds-geosciences.wustl.edu/missions/lro/lend.htm) publishes [averaged science products](https://pds-geosciences.wustl.edu/lro/lro-l-lend-2-edr-v1/lrolen_0xxx/data/collection_data_science_averaged_inventory.csv). The latest listed ALD set has an epoch of 11 December 2011 and integrates to 14 September 2016. [North label](https://pds-geosciences.wustl.edu/lro/lro-l-lend-2-edr-v1/lrolen_0xxx/data/2011/20111211/lend_rdr_aldn_20111211.lbl), [north binary](https://pds-geosciences.wustl.edu/lro/lro-l-lend-2-edr-v1/lrolen_0xxx/data/2011/20111211/lend_rdr_aldn_20111211.dat), [south binary](https://pds-geosciences.wustl.edu/lro/lro-l-lend-2-edr-v1/lrolen_0xxx/data/2011/20111211/lend_rdr_alds_20111211.dat), [nonpolar binary](https://pds-geosciences.wustl.edu/lro/lro-l-lend-2-edr-v1/lrolen_0xxx/data/2011/20111211/lend_rdr_alde_20111211.dat). These are public **normalised neutron count rates with uncertainty**, gridded at 0.5 degrees poleward of 80 and 1 degree elsewhere. They are not a hydrogen-abundance or ice-detection product. Conversion requires detector response and background modelling; this work does not invent that conversion or paint low counts as proven ice. The [dataset description](https://pds-geosciences.wustl.edu/lro/lro-l-lend-2-edr-v1/lrolen_0xxx/catalog/rdr_ds.cat) explains the distinction. Lunar Prospector's already published hydrogen map is the orbital abundance picture shipped in this round.
- **Whole-Moon ice stability:** the PRP only supplies polar thermal coverage. No whole-Moon stable-ice prediction is invented. The global orbital hydrogen picture is explicitly a different kind of evidence.

The requested [LPI Lunar South Pole Atlas](https://www.lpi.usra.edu/lunar/lunar-south-pole-atlas/), [NASA LRO science and data](https://science.nasa.gov/mission/lro/science-and-data/) and [LROC atlases](https://lroc.im-ldi.com/atlases) remain useful primary starting points. Their shadow and volatile illustrations do not substitute for geolocated ice detections.

## Credit and licence

Credit NASA/GSFC/MIT and the LOLA team; NASA/LRO/Diviner and the Diviner team; Los Alamos and the Lunar Prospector spectrometer team; and the authors cited above. [PDS Geosciences' FAQ](https://pds-geosciences.wustl.edu/faq.html) describes its data as public domain and asks for citation. PGDA requests the product's paper citation. NASA's [science-data licence policy](https://science.data.nasa.gov/about/license) gives its default CC0/public-domain policy. No NASA endorsement is implied. Paper text, figures and third-party marker catalogues retain their own terms; they are cited rather than copied into an invented detection map.
