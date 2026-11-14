# Historical surface sites research

Checked 14 November 2026. `historical-sites.json` contains 48 records for merging into the final array. Every source/coordinate URL returned HTTP 200 on an HTTP GET with redirects followed; `historical-url-checks.json` records the results. Only the first response byte was read for this check. No downloaded executable, package or other downloaded file was run.

## Coordinate provenance and precision

For 38 objects, positions are copied from the supplied `anthropogenic_objects_180.elevation.geojson`, using its `LATITUDE` and signed `LONGITUDE` fields. The coordinate source is the [LROC anthropogenic-product metadata page](https://data.lroc.im-ldi.com/lroc/view_rdr/SHAPEFILE_ANTHROPOGENIC_OBJECTS), updated 14 August 2026. The metadata defines `UNCERTAIN` in **metres**, not kilometres. LROC's coordinate work uses the lunar mean Earth/polar axis frame. The metadata labels the distributed shapefile IAU Moon 2000 geographic coordinates.

`precisionKm` is `max(0.01, UNCERTAIN / 1000)` for these catalogue objects. The 10 m display floor is conservative for this app and is not a claim that the original laser-ranging estimates are only accurate to 10 m. In particular, the catalogue's zero uncertainty for laser-ranging points must not become a zero-radius error circle.

SMART-1 is independently located in an LROC image and published by ESA, but is absent from the supplied anthropogenic GeoJSON. Its 0.1 km uncertainty is conservative because ESA's linked image article does not give a formal error estimate. `inQuickMap` means present in a supplied vector, not merely visible in imagery or listed on an LROC website.

The following markers remain estimates; `verify: true` and their notes make that explicit:

| ID | Limitation |
| --- | --- |
| luna-2 | NASA gives an unidentified impact area of 29–31 N, 1 W–1 E. The marker is the area's centre, with a conservative 50 km radius. |
| luna-9 | The historical 7.13 N, 64.37 W position does not match the lander's panoramas. NASA warns the real location is probably at least 10 km away. The 50 km radius is a display allowance. |
| luna-13 | Historical reported point only; lander has not been confirmed here in supplied LROC data. 30 km is a conservative display allowance. |
| ranger-4 | Tracking-based far-side impact estimate, no located crater. |
| lcross-spacecraft | Estimated shepherding-spacecraft impact from NASA's table, separate from the Centaur crater. 1 km is a display allowance. |
| lunar-prospector-impact | Rounded, tracking-based Shoemaker crater impact estimate. |
| hiten-impact | JAXA's estimate; no located crater or documented tie to the modern ME frame confirmed. |
| kaguya-impact | Rounded JAXA tracking estimate, not a confirmed precise crater position in this research. |
| change-1-impact | Historical reported impact point; no located crater or modern frame tie confirmed. |

These are approximate search locations, not metre-accurate surface landmarks. A primary source giving a historical coordinate does not confirm that hardware lies at that point.

Recent 2026 reports have proposed candidate Luna 9 locations. The supplied LROC catalogue still excludes it, and no agency-confirmed identification was found in this research, so the historical uncertainty is retained. Do not substitute a candidate coordinate as confirmed hardware.

## Details Claude must preserve

- All records here are `past`. A still-useful passive laser reflector is not an operating powered rover or lander.
- Apollo 15/16/17 rover pins and Lunokhod 1/2 pins use **final parked positions**. Their `date` is arrival aboard the parent lander, not the date they reached the parked point. Lunokhod 2 rolled off Luna 21 on 16 January 1973, after its 15 January landing.
- Apollo 16 landed on **21 April 1972 UTC**; US-local histories can say April 20. The JSON uses UTC throughout.
- Apollo 13's crew never landed. Its separate pin is a deliberately impacted Saturn V third stage, which did reach the lunar surface. The other Apollo rocket-impact pins have the same meaning.
- The supplied QuickMap record `LCROSS` is the **Centaur** impact crater identified using ShadowCam. It is not the LCROSS shepherding spacecraft, which hit roughly four minutes later. The supplied Centaur position is -84.6780, -48.6937; this is a small refinement of the longitude -48.6926 published in the 2024 crater-identification paper.
- The 2022 rocket-stage impact is located, but its attribution needs care: the supplied catalogue names Chang'e-5 T1, while the linked LROC article calls it a mystery rocket. The public name and note make the catalogue attribution visible; the actual impact date/site are confirmed.
- Longjiang-2's crater attribution is described by LROC as very likely, supported by the predicted position, crater size and before/after imaging. The note preserves that wording.
- Luna 23 reached the surface but failed to collect a sample, so it is `sample-return` / `partial`, rather than a successful sample return.

## Differences from the app's hand-made list

The existing six Apollo positions are sensible rounded values, not major location errors. This data replaces them with the LROC module coordinates and separates the three parked rovers. The existing generic `LCROSS impact` pin already lies near the Centaur crater, but should be named specifically so users do not confuse the two impacts.

The original file has none of the Surveyor or Luna landings, the Lunokhod parked positions, the Ranger impacts, the two GRAIL craters, the LADEE/SMART-1/Hiten/Kaguya/Lunar Prospector end-of-mission sites, or the selected Apollo impact craters included here. The historical subset also adds Chang'e-1, Longjiang-2 and the catalogue-attributed Chang'e-5 T1 rocket-stage crater.

This catalogue is a set of meaningful visits, not an inventory of every discarded instrument or rocket part. It deliberately avoids duplicating Apollo seismometers and reflectors as separate mission pins. Sites with no known impact date or defensible location, such as many lost orbiters, cannot be honestly represented by this required point-and-date schema.
