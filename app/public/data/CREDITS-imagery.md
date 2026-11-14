# Imagery credits (map photos of the Moon)

Moon photos come from NASA Moon Trek, JAXA's Kaguya mission and LROC's public map services.
The existing offline pictures were made by `data-prep/base_mosaic.py` (whole-Moon pictures,
`data/base/v5/`) and `data-prep/polar_tiles.py` (sharp south-pole squares, `data/polar/t/`).
The sharper sources below are streamed when the view needs them; no new photos are stored with
the site. Services and terms were checked live on 14 November 2026.

| What the app shows | Source | Where from | Credit |
|---|---|---|---|
| The photo of the Moon (local whole-Moon pictures and the first streamed detail) | LRO Wide Angle Camera (WAC) global morphologic mosaic, 100 m/pixel (`LRO_WAC_Mosaic_Global_303ppd_v02`) | [NASA Moon Trek](https://trek.nasa.gov/moon/) | NASA / GSFC / Arizona State University |
| Finer global detail | Kaguya Terrain Camera evening mosaic (`kag_tc_e_7m`), **native 7.4 m/pixel**; QuickMap level 12 delivers it on a 5.2 m grid, without adding native detail | [Lunar QuickMap](https://quickmap.im-ldi.com/); [JAXA source dataset](https://data.darts.isas.jaxa.jp/pub/pds3/sln-l-tc-5-evening-map-v4.0/) | ISAS/JAXA/SELENE; Lunar QuickMap — NASA, Intuitive Machines & Applied Coherent Technology Corp.; display adjustments by MOONDA |
| Detail within nearly black evening TC areas, only when needed | Kaguya TC morning mosaic (`kag_tc_m_7m`), native 7.4 m/pixel, feathered into the evening view; WAC stays visible where neither source supplies usable detail | [Lunar QuickMap](https://quickmap.im-ldi.com/); [JAXA morning dataset](https://data.darts.isas.jaxa.jp/pub/pds3/sln-l-tc-5-morning-map-v4.0/) | ISAS/JAXA/SELENE; Lunar QuickMap — NASA, Intuitive Machines & Applied Coherent Technology Corp.; mixed lighting and display adjustments by MOONDA |
| Global fallback if the finer service fails | Kaguya TC ortho mosaic (`Kaguya_TCortho_Mosaic_Global_4096ppd`): native mosaic 7.4 m/pixel, but this live WMTS stops at level 10, about **20.8 m/pixel** | [Moon Trek WMTS capabilities](https://trek.nasa.gov/tiles/Moon/EQ/Kaguya_TCortho_Mosaic_Global_4096ppd/1.0.0/WMTSCapabilities.xml) | ISAS/JAXA/SELENE; served by NASA Moon Trek; display adjustments by MOONDA |
| Landing regions and Tycho | LROC Narrow Angle Camera (NAC) mosaics listed below; roughly 0.3–2.6 m tile spacing, with actual detail limited by each source | [NASA Moon Trek](https://trek.nasa.gov/moon/) | NASA / GSFC / Arizona State University |
| Near Chang'e-3/5/6, Chandrayaan-2/3, Beresheet and HAKUTO-R M1/M2 | Lunar QuickMap's `wac_nac_nacroi` composite: NAC images and ROI mosaics over WAC; NAC source detail varies, generally 0.5–2 m/pixel | [Lunar QuickMap](https://quickmap.im-ldi.com/) | NASA / GSFC / Arizona State University; Lunar QuickMap — NASA, Intuitive Machines & Applied Coherent Technology Corp. |
| Shading in the part of the far side where NASA's photo is lit from the other side (true longitude 180°W to 90°W, fading in from 80°W and 165°E) | LRO LOLA hillshade (`LRO_LOLA_Shade_Global_256ppd_v06`) and SLDEM2015 LOLA + Kaguya hillshade (`LRO_LrocKaguya_Shade_60N60S_512ppd`) | NASA Moon Trek, https://trek.nasa.gov/moon/ | NASA / GSFC LOLA team; JAXA SELENE (Kaguya) Terrain Camera |
| Brightness (albedo) in that same part | CGI Moon Kit 2025 colour map (from the LROC WAC Hapke-normalised mosaic, 643 nm band used) | NASA Scientific Visualization Studio, https://svs.gsfc.nasa.gov/4720/ | NASA's Scientific Visualization Studio; LROC: NASA / GSFC / Arizona State University |
| Around both poles (beyond 64°, fading in from 58°) | LROC WAC South Pole Summer Mosaic and North Pole Summer Mosaic (`luna_wac_roi_south_summer`, `luna_wac_roi_north_summer`) | ASU Lunaserv WMS (the server behind LROC QuickMap), https://wms.im-ldi.com/ | NASA / GSFC / Arizona State University |
| Sharp south-pole photos | LROC NAC south-pole controlled mosaic + WAC south summer mosaic (`luna_nac_pole_control_south`) | ASU Lunaserv WMS, https://wms.im-ldi.com/ | NASA / GSFC / Arizona State University |
| Sharp north-pole photos, 84–90° N | LROC NAC Polar Average Controlled Mosaic (`lnpole_avg`), native 1 m/pixel; QuickMap polar tiles through level 12, 0.888 m grid spacing | [Lunar QuickMap](https://quickmap.im-ldi.com/); [LROC product](https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_POLE_NORTH_CM_AVG) | NASA / GSFC / Arizona State University; controlled by USGS; Lunar QuickMap — NASA, Intuitive Machines & Applied Coherent Technology Corp. |

Why the far-side part is shaded from heights instead of shown as a photo: NASA's global WAC mosaic was
built from pictures lit from the west everywhere except 180°W–90°W, which is lit from the east, so it
shows two straight joins (at 90°W and 180°). There the app keeps the LROC albedo times a hillshade lit
from the west as the brightness reference at close zoom. Finer photos are exposure-matched to
that reference. Evening TC is the primary global source. Morning TC supplies detail only within
nearly black evening areas, with a soft edge; this is explicitly a composite of different Sun
directions, not a single uniformly lit observation.

## Sharper regional sources

These are the actual Moon Trek layer names and deepest live WMTS levels. Tile spacing is measured
north–south on the Moon; east–west spacing is smaller by the cosine of latitude. Finer tile spacing
does not make a source image sharper than its native resolution. Mosaics have irregular edges and
do not cover all the surroundings of a landing site.

| Region | Layer | Deepest level | Tile spacing / source note |
|---|---|---:|---|
| Apollo 11 | `LRO_NAC_Apollo11_Mosaic_p` | 15 | 0.65 m |
| Apollo 12 | `LRO_NAC_Apollo12_Mosaic_p` | 16 | 0.33 m |
| Apollo 14 | `LRO_NAC_Apollo14_Mosaic_p` | 15 | 0.65 m |
| Apollo 15 | `LRO_NAC_Apollo15_Mosaic_p` | 16 | 0.33 m |
| Apollo 16 | `LRO_NAC_Apollo16_Mosaic_p` | 14 | 1.30 m |
| Apollo 17 | `NAC_DTM_APOLLO17_MOSAIC_120CM` | 14 | 1.30 m; native 1.2 m |
| Tycho central peak | `LRO_NAC_Mosaic_43S349E_50cmp` | 14 | 1.30 m; native 0.5 m |
| Chang'e-4 / Von Kármán | `LRO_NAC_Mosaic_50cmpp_VonKarman_v2` | 15 | 0.65 m; native 0.5 m |
| SLIM / Shioli | `LRO_NAC_Mosaic_0_82mpp_Shioli` | 15 | 0.65 m; native 0.82 m |
| Blue Ghost vicinity | `LRO_NAC_ortho_horseshoeV2` | 15 | 0.65 m grid; native resolution not stated in the layer title |
| IM-1 | `LRO_NAC_Post_Landing_OrthoMosaic_1mpp_IM_1_LandingSite` | 13 | 2.60 m; native 1 m |

The app only asks for a Trek regional source where its published bounds meet the visible tile.
Around Chang'e-3/5/6, Chandrayaan-2/3, Beresheet and HAKUTO-R M1/RESILIENCE (M2), it requests
QuickMap within a small box around each site and blends the box's edge into the global image.
QuickMap includes WAC where no NAC exists, so a successful tile response does not by itself prove
that the whole box has NAC detail. These samples establish NAC coverage, not that each site has a
controlled orthomosaic.

## Endpoints and live checks

The primary global source is QuickMap's Kaguya TC evening mosaic:

```text
https://lroc-tiles.quickmap.io/tiles/kag_tc_e_7m/lunar-fulleqc/{z}/{x}/{y}.png?d_val=0,5000&d_opt=wcolut0
```

Its live catalogue describes 30 × 30° mosaics assembled from the original 3 × 3° evening products,
at native 7.4 m/pixel. The 512 × 512 square geographic grid is the same `lunar-fulleqc` grid described
below. The app stops at level 12: delivery pixels are 5.2 m north–south, but the real source remains
7.4 m. Apollo 11, Tycho and 20° N, 150° E samples returned HTTP 200, `image/png`, CORS `*`, and
64,620 / 61,314 / 145,225 bytes in 3.95 / 1.65 / 2.15 seconds. Each was visually checked for real TC
crater detail. Coarse level-8 and level-10 controls also returned valid CORS-enabled images.

The fixed 0–5000 stretch preserves bright highlands. A narrower 0–2500 stretch clipped 4.67% of
Tycho's sample and 1.75% of the far-side sample to white; 0–5000 reduced those to 0% and 0.014%.
The worker matches exposure towards WAC continuously, with a gain limited to 0.25–4. The fixed
level-8 source reference uses the same stretch at every zoom. Non-black source shading is retained;
the nearly black TC treatment is described below. NAC replaces TC inside its feathered footprint, with its own level-8 exposure
reference, so the two photos' different shadows and fine detail are not added together. Coarse
NAC levels appear from level 9, so its lighting is settled before a close landing. QuickMap
landing-region requests stay within about 2.4 km north–south of each verified site centre.

Morning TC is fetched only when a visible evening tile has a sizeable nearly black area. Its
verified endpoint uses the same grid and fixed stretch:

```text
https://lroc-tiles.quickmap.io/tiles/kag_tc_m_7m/lunar-fulleqc/{z}/{x}/{y}.png?d_val=0,5000&d_opt=wcolut0
```

The mask is made before reprojection or exposure matching from decoded source grey values at or
below 2 (DN on the 8-bit served image, not the original science values). Its edge feathers across
six source pixels: about 31 m north–south at level 12, or 62 m at level 11. Morning receives the
same validity mask and exposure reference. Evening remains above it wherever it has useful detail;
WAC remains underneath where both photos are nearly black. Textured shaded terrain above that
threshold is kept. No detail is inferred from a dark pixel.

Live morning/evening pairs at the far-side test spot, Copernicus, Aristarchus and 65° N, 0° E all
returned HTTP 200, `image/png`, 512 × 512 RGBA and CORS `*`. Morning samples were 151–285 kB and
took 1.33–4.62 seconds. The far-side evening sample had 16.95% nearly black pixels; morning had
usable values in about 80.38% of that area. Both remained nearly black in 3.31% of the whole tile.
These source statistics describe potential fill, not a guarantee that every dark area is resolved.
The live catalogue and [JAXA morning archive](https://data.darts.isas.jaxa.jp/pub/pds3/sln-l-tc-5-morning-map-v4.0/)
also returned HTTP 200. Morning shares the normal source cache, request limits, cancellation and
backoff rules, and adds no new imagery layer or stored photo.

Moon Trek uses 256 × 256 geographic tiles, with two columns and one row at level 0:

```text
https://trek.nasa.gov/tiles/Moon/EQ/{layer}/1.0.0/default/default028mm/{z}/{y}/{x}.png
https://trek.nasa.gov/tiles/Moon/EQ/{layer}/1.0.0/WMTSCapabilities.xml
```

The fallback Kaguya TC ortho layer returned HTTP 200, `image/png` and `Access-Control-Allow-Origin: *` at Apollo 11,
Tycho and 20° N, 150° E at level 10 (24,260, 61,683 and 43,050 bytes). Levels 11 and 12 returned
404 at all three places. The fallback therefore stops at level 10; it cannot deliver the catalogue's
7.4 m native mosaic through this endpoint. Each regional source above also returned a valid maximum-level PNG with CORS
enabled; samples were 23,677–59,329 bytes. Apollo 11's sample showed small craters and the descent
stage. The catalogue warns that the Kaguya control network differs from LOLA, so exact registration
between photos and terrain is not guaranteed.

The NASA fallback has missing strips, including directly at 20° N, 150° E; the selected evening
source's sample there has no such stripe. Zero-valued NASA fallback pixels conservatively leave
WAC visible, avoiding opaque black no-data joins. Nearly black blobs in the selected evening
source are real cast shadows in its opaque PNG, not missing downloaded tiles. Their conditional
morning fill changes the lighting shown. NAC source shadows are retained. Coverage, lighting and
registration vary; no source provides new visible detail at every pixel or within every deep shadow.

Some Tycho NAC exposure patches are already present in the original NASA mosaic. Direct, unaltered
level-12/13/14 source PNGs contain the same rectangular and angled joins, inside source tiles as
well as across them. They are not introduced by Cesium tile boundaries or the app's reprojection.
The app retains these source features; the fixed exposure reference does not remove original
joins between observations taken under different light.

The live [QuickMap catalogue](https://quickmap.im-ldi.com/maps/lroc) selects `wac_nac_nacroi` by
default: NAC ROI mosaics over NAC images with 55–80° incidence, over WAC. Its current public tile
endpoint is:

```text
https://lroc-tiles.quickmap.io/tiles/wac_nac_nacroi/lunar-fulleqc/{z}/{x}/{y}.jpg
```

These are 512 × 512 geographic tiles. The Moon occupies the top half of the square root grid:
`x = floor((longitude + 180) / 360 * 2^z)`, `y = floor((90 - latitude) / 360 * 2^z)`.
At level 15 the grid spacing is 0.65 m. Real Chang'e-3/5/6 samples returned HTTP 200, `image/jpeg`,
CORS `*`, and 29,677 / 41,225 / 15,536 bytes. All three showed NAC terrain detail; some source strip
joins remain visible. This is the public map tile service, not an assumed legacy WMS layer name.

Additional level-15 samples returned 200 JPEG, CORS `*`, with real NAC detail: Chandrayaan-3
24,542 bytes, Chandrayaan-2 37,788 bytes, Beresheet 48,229 bytes, HAKUTO-R M1 25,901 bytes and
RESILIENCE (M2) 47,922 bytes. High-latitude geographic resampling and individual source strip joins
can still limit their appearance.

For the north pole the selected endpoint is QuickMap's cached, controlled 1 m mosaic:

```text
https://lroc-tiles.quickmap.io/tiles/lnpole_avg/lunar-sterenp/{z}/{x}/{y}.png?d_val=0,0.5&d_opt=wcolut0
```

It uses 512 × 512 north-polar stereographic tiles, SRS `IAU2000:30118`, within the square
`[-931070, -931070, 931070, 931070]` metres. Tile span is `1862140 / 2^z` metres; level 12 has
0.888 m pixels, close to the source's native 1 m detail. The parameters apply the catalogue's
default grey range and palette. At 89.7° N, 0° E, tile `12/2048/2068` returned HTTP 200,
`image/png`, 195,234 bytes, CORS `*`, in 3.20 seconds. A coarser tile, `4/8/8`, returned 315,635
bytes in 3.32 seconds. Both were real RGBA lunar images; the root tile confirmed the transparent
84–90° N cap and projection. The stored north-pole picture supplies the broad brightness, avoiding
remote WAC longitude rings. Sharp and coarser polar tiles add detail within the same photo layer.
QuickMap downloads share a four-request queue and use the normal 20-second timeout. Transparent
source gaps leave the parent visible.

If a cached north tile fails, the worker now tries `luna_nac_np_mosaic` through
`https://wms.im-ldi.com/`, WMS 1.1.1, `SRS=IAU2000:30118`, on the same polar square.
This uncontrolled 1 m product covers 85.5–90° N; empty outer pixels retain the stored broad
photo. A second live check on 14 November 2026 returned HTTP 200, `image/jpeg`, 89,870 bytes,
CORS `*`, in 7.31 s. This slower service is a fallback only, never requested alongside a
successful cached tile. Credit: NASA / GSFC / Arizona State University, via Lunar QuickMap.

The [Lunaserv capabilities](https://wms.im-ldi.com/?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetCapabilities)
returned HTTP 200, WMS XML, 640,090 bytes and CORS `*`. An alternative north mosaic was tested with
`SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&STYLES=&LAYERS=luna_nac_np_mosaic&SRS=IAU2000:30118&BBOX=-4096,-4096,4096,4096&WIDTH=512&HEIGHT=512&FORMAT=image/png&TRANSPARENT=TRUE`:
HTTP 200, `image/png`, 257,380 bytes and CORS `*`. This uncontrolled 85.5–90° N mosaic was rejected:
the constituent images were not registered to each other, and a cold close-up WMS request took
20.8 seconds. The selected cached controlled mosaic improves registration and loading. The guessed
WMS layer `luna_nac_pole_control_north` returned an XML service error and is not used. The existing
south-pole WMS source and its 4,224 stored tiles remain unchanged.

## Display adjustments and terms

MOONDA reprojects, resamples and adjusts these photos for display. Fixed source and WAC references
match the exposure across the fine TC and NAC photos; the albedo × hillshade seam fix supplies
that reference in the corrected quadrant. The polar and NASA fallback photos add fine detail to
the existing broad picture. This avoids a separate mean adjustment per output tile. Source
edges are feathered. The conditional morning fill combines observations from different Sun
directions within the evening TC view. These are modified map views, not unaltered science products,
a uniformly lit observation, a reflectance map or new terrain measurements. No imagery is generated
by AI.

Kaguya TC credit: **ISAS/JAXA/SELENE; served through Lunar QuickMap (NASA, Intuitive Machines &
Applied Coherent Technology Corp.), with NASA Moon Trek as fallback; reprojected, brightness-matched
and conditionally combined from morning/evening observations by MOONDA**.
The [ISAS Data Policy](https://www.isas.jaxa.jp/en/researchers/data-policy/) permits copying,
forwarding and modifying open data for commercial and non-commercial use with origin credit and
a description of changes; its terms are compatible with CC BY 4.0. The
[Kaguya FAQ](https://darts.isas.jaxa.jp/missions/kaguya/faq.html) confirms that observation-data use
needs no separate procedure, except for HDTV imagery, which this app does not use.

LROC credit: **NASA/GSFC/Arizona State University**. The
[LROC terms and citation policy](https://www.lroc.im-ldi.com/about/terms) distinguish public-domain
PDS archive data from copyrighted website/non-PDS images. They permit credited educational use
without prior permission; commercial use of non-PDS images requires permission. This educational
project does not claim that every streamed mosaic is unconditionally public domain. QuickMap's
own live catalogue describes its map data as public domain and asks that published maps name and
link **[Lunar QuickMap](https://quickmap.im-ldi.com/)**, with collaboration credit to NASA,
Intuitive Machines & Applied Coherent Technology Corp.

For research using Lunaserv, the LROC policy additionally requests Estes et al. (2013), *Lunaserv
Web Map Service: History, Implementation Details, Development, and Uses*, LPSC 44, 2609; and
Robinson et al. (2010), *Lunar Reconnaissance Orbiter Camera (LROC) Instrument Overview*, Space
Science Reviews 150, 81–124. The selected north-pole product reference is Archinal et al. (2023),
*[Controlled High-Resolution LROC NAC Polar Mosaics](https://www.hou.usra.edu/meetings/lpsc2023/pdf/2333.pdf)*,
LPSC 54, 2333.
