# Imagery credits (map photos of the Moon)

All pictures are NASA or NASA-funded data from official servers. Made into the app's files by
`data-prep/base_mosaic.py` (whole-Moon pictures, `data/base/v5/`) and `data-prep/polar_tiles.py`
(sharp south-pole squares, `data/polar/t/`).

| What the app shows | Source | Where from | Credit |
|---|---|---|---|
| The photo of the Moon (local whole-Moon pictures and the detail streamed when you zoom in) | LRO Wide Angle Camera (WAC) global morphologic mosaic, 100 m/pixel (`LRO_WAC_Mosaic_Global_303ppd_v02`) | NASA Moon Trek, https://trek.nasa.gov/moon/ | NASA / GSFC / Arizona State University |
| Shading in the part of the far side where NASA's photo is lit from the other side (true longitude 180°W to 90°W, fading in from 80°W and 165°E) | LRO LOLA hillshade (`LRO_LOLA_Shade_Global_256ppd_v06`) and SLDEM2015 LOLA + Kaguya hillshade (`LRO_LrocKaguya_Shade_60N60S_512ppd`) | NASA Moon Trek, https://trek.nasa.gov/moon/ | NASA / GSFC LOLA team; JAXA SELENE (Kaguya) Terrain Camera |
| Brightness (albedo) in that same part | CGI Moon Kit 2025 colour map (from the LROC WAC Hapke-normalised mosaic, 643 nm band used) | NASA Scientific Visualization Studio, https://svs.gsfc.nasa.gov/4720/ | NASA's Scientific Visualization Studio; LROC: NASA / GSFC / Arizona State University |
| Around both poles (beyond 64°, fading in from 58°) | LROC WAC South Pole Summer Mosaic and North Pole Summer Mosaic (`luna_wac_roi_south_summer`, `luna_wac_roi_north_summer`) | ASU Lunaserv WMS (the server behind LROC QuickMap), https://wms.im-ldi.com/ | NASA / GSFC / Arizona State University |
| Sharp south-pole photos | LROC NAC south-pole controlled mosaic + WAC south summer mosaic (`luna_nac_pole_control_south`) | ASU Lunaserv WMS, https://wms.im-ldi.com/ | NASA / GSFC / Arizona State University |

Why the far-side part is shaded from heights instead of shown as a photo: NASA's global WAC mosaic was
built from pictures lit from the west everywhere except 180°W–90°W, which is lit from the east, so it
shows two straight joins (at 90°W and 180°). There the app draws the LROC albedo times a hillshade lit
from the west (same side as the rest of the photo), with the brightness matched to the photo.
