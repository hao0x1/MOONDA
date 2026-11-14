# Water-ice markers

Updated 14 November 2026. These are evidence markers, not an ice-abundance grid or
a claim that a whole crater contains ice. The markers sit at named crater centres
for context, except Cabeus: its white marker now sits at the mapped LCROSS Centaur
impact from `sites.json` (84.678° S, 48.6937° W). Its diameter still describes Cabeus.

Rebuild from the repository root:

```sh
.venv-data/bin/python -I data-prep/sites/download_ice_marker_sources.py
.venv-data/bin/python -I data-prep/sites/build_ice_sites.py
.venv-data/bin/python -I data-prep/sites/make_sites_ts.py
```

The first command saves primary articles in separate `data-raw/ice-north-*`
folders, with their real URL, byte count and SHA-256. Downloads are only read as
data. No downloaded scripts are run. The marker builder reads the existing
south-polar list in `data-prep/features/ice-sites.json` without changing it, adds
the northern records below, and writes `data-prep/sites/ice-sites.json` and
`app/public/data/features/ice-sites.json`. The last command regenerates
`app/src/data/sites.ts`; its landing and impact site rules are unchanged.

## What the rings mean

- **Confirmed:** water measured in material excavated at one spot by LCROSS in
  Cabeus. This is the only directly measured ice marker in this list.
- **Seen from orbit:** an orbital instrument reported signs consistent with
  possible ice. Southern M3 markers refer to spectral surface-ice signs. The new
  northern radar markers refer to possible buried ice, with roughness ambiguity
  stated in each card. A radar signal is not a direct water measurement.
- **Predicted:** cold or shadow evidence indicates a possible place to store ice.
  It is not a detection. Absence of a marker is not proof that ice is absent.

`detected` remains the stored key for the cyan ring so the existing renderer keeps
working. Its visible label must be **Seen from orbit**, rather than **Signs of
surface ice**, because a radar candidate and a surface spectrum are different.

## Northern records and primary sources

| Crater | Instrument and finding | Primary source | Limits |
| --- | --- | --- | --- |
| Peary | Chandrayaan-2 DFSAR found anomalous radar scattering in small craters on its floor; Mini-SAR/Mini-RF also reported candidate patches. | [ISRO one-year report](https://www.isro.gov.in/media_isro/pdf/chandrayaan-2_completes_a_year_around_the_moon_.pdf), pp. 9–10, Figure 9; [Bussey and Spudis 2011](https://www.lpi.usra.edu/meetings/lpsc2011/pdf/2086.pdf) | Possible buried ice; roughness also affects radar. The marker describes small craters inside Peary, not the entire parent crater. |
| Rozhdestvenskiy | Mini-SAR/Mini-RF saw anomalous radar returns in small craters inside it. | [NASA/GSFC/JHUAPL image record](https://science.nasa.gov/image-detail/rozhdestvenskiy-x-main-context-580/); [NASA Mini-SAR explanation](https://science.nasa.gov/missions/mini-rf/nasa-radar-finds-ice-deposits-at-moons-north-pole/); [Bussey and Spudis 2011](https://www.lpi.usra.edu/meetings/lpsc2011/pdf/2086.pdf) | Possible buried ice; the parent crater is not filled with measured ice. |
| Hermite | Mini-RF candidate small craters on its floor; Diviner measured very cold ground and LOLA models show long-lived shadow. | [Spudis et al. 2013](https://ntrs.nasa.gov/api/citations/20150000268/downloads/20150000268.pdf), Table 3 and Figure 7, doi:10.1002/jgre.20156; [NASA Hermite record](https://science.nasa.gov/image-detail/hermite/) | Radar interpretation is model dependent; thermal evidence only shows storage conditions. |
| Erlanger | Mini-RF candidate radar response, in a crater whose floor is largely shadowed. | [Spudis et al. 2013](https://ntrs.nasa.gov/api/citations/20150000268/downloads/20150000268.pdf), Table 3; [NASA LROC image PIA12899](https://science.nasa.gov/photojournal/eternal-darkness-near-the-north-pole/) | Possible buried ice, not a water measurement. The visible photograph alone does not detect ice. |
| Bosch | Diviner cold conditions cited as a possible polar-ice resource. | [NASA/TM—2018-219937](https://ntrs.nasa.gov/api/citations/20180008495/downloads/20180008495.pdf), p. 7, Figure 4(b) | Predicted storage conditions only; no water detection is claimed. |

Coordinates and diameters use the IAU/USGS names already stored in
`app/public/data/names.json`: [Peary](https://planetarynames.wr.usgs.gov/Feature/4627),
[Rozhdestvenskiy](https://planetarynames.wr.usgs.gov/Feature/5207),
[Hermite](https://planetarynames.wr.usgs.gov/Feature/2471),
[Erlanger](https://planetarynames.wr.usgs.gov/Feature/14525),
[Bosch](https://planetarynames.wr.usgs.gov/Feature/14524). These named-centre markers
have no pixel resolution: they are references to studies, not measured footprints.
The original radar observations vary by instrument/product; Mini-RF's cited
2011 report lists 30 m zoom and 150 m baseline modes, not a uniform ice-map pixel.

No north-polar M3 detections were digitised from a figure or invented. The reviewed
Li et al. 2018 release does not provide a public coordinate table in this checkout;
see the existing surface-ice audit in `data-prep/features/NOTES.md`. The southern
M3 crater associations remain as researched there. No extra ice grid is inferred
from these markers.

## Requests for other owners

In `app/src/i18n/en/explore.ts`, change `ice.detected` to `Seen from orbit`.
In its Khmer twin, use `ឃើញពីគន្លង`.

`PlaceCard.tsx` currently renders evidence instruments and findings as raw English.
It needs localisation lookup keys to show their Khmer twins. The new short/detail
translations are drafted in `ice-i18n-additions.json` for the owner of the places
translations. This marker-only session does not own either file.
