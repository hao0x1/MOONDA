# MOONDA surface-site handoff — 14 November 2026

Use `sites.json` as the canonical array and `artemis-regions.geojson` as the polygon layer. The smaller `*-sites.json` files are research inputs to the merge, not additional data to import. `../app/src/data/places.ts` and every other app file were read only. No dependencies were installed and no downloaded code was executed.

The canonical array contains **85 pins: 65 past records and 20 planned records**, including nine alternative Artemis regions. It is not a count of unique missions or landings: parked rovers are separate visits, VIPER and its carrier share one arrival, and the nine Artemis regions are alternatives for one crewed landing. No surface hardware was labelled `active` without sufficiently current primary confirmation. That does not establish that all existing lunar hardware has stopped.

## Changes Claude should make when integrating

1. **Update the Artemis programme wording.** NASA now plans Artemis III as an Earth-orbit demonstration in 2027; Artemis IV targets the first crewed surface landing in early 2028. Keep “Artemis III” only as the historical 2024 layer name. The current NASA Artemis IV page still identifies nine candidate regions. No selected final touchdown site was confirmed.
2. **Correct IM-2 Athena to -84.7906, 29.19567.** The old -84.81 latitude puts the marker about 590 m south of the measured LROC position. Its brief 2025 mission has ended. The old NASA `/mission/im-1/` and `/mission/im-2/` paths returned 404; the JSON uses working replacement sources.
3. **Correct Chang'e-4 to -45.4562, 177.5886.** The old -45.44 latitude is about 490 m from the supplied LROC position. This fixed pin is the lander site, not the rover's present location.
4. **Preserve UTC dates.** Chang'e-6 landed 1 June 2024 UTC; SLIM 19 January 2024 UTC; Chandrayaan-2 crashed 6 September 2019 UTC; HAKUTO-R M2 crashed 5 June 2025 UTC. Local dates often differ. Apollo 16 landed 21 April 1972 UTC.
5. **Do not automatically display `past` as “mission ended” when `verify` is true.** Chang'e-3 and Chang'e-4/Yutu-2 use that provisional display bucket because the required schema has no unknown state. Their present operation could not be confirmed; their notes explicitly preserve that uncertainty. Show “status needs confirmation” or suppress a finished/active claim.
6. **Use the current future plans.** VIPER is assigned to Blue Origin's second MK1, not Griffin-1. Griffin-1 instead carries FLIP and other rovers. IM-3 is currently planned for 2027; Blue Ghost 2/3/4 for no earlier than 2027/2028/2029. See `planned-notes.md` for dated primary evidence and schedule limits.
7. **Do not pin cancelled or unlocated plans.** `unpinned-plans.json` tracks eight requested/new plans with a different schema. Former ispace APEX/CP-12 was cancelled in July 2026. Chang'e-7 lost its 2026 window and no replacement year was confirmed; a year cannot be invented to fit the required pin schema. PROMISE and several rover/drone plans publish only a broad south-polar destination.

## What changed from the hand-made list

The six Apollo markers were reasonable rounded positions. They now use LROC descent-stage coordinates; parked Apollo 15/16/17 rovers have separate pins. Existing Chandrayaan-3, Chang'e-6, SLIM, IM-1 and Blue Ghost positions are mainly rounded approximations, not major errors. Precision is now explicit rather than implied by decimal places.

**All nine old Artemis markers are inside the supplied region outlines.** Replacing them with calculated centres does not mean the old markers were wrong. The largest centre shift is 25.87 km for the very large Mons Mouton Plateau region. `artemis-coordinate-comparison.json` records old/new points, distance, containment and region radius. The geometry uses the nine-region 2024 file, not the thirteen-region 2022 file.

The old generic LCROSS pin lies near the **Centaur rocket crater**. This handoff separates that accurately mapped water-ice impact from the less certain shepherding-spacecraft impact about four minutes later. GRAIL likewise has two separate impact pins.

Added coverage includes Surveyor 1/3/5/6/7; Luna 2/9/13/16/17/20/21/23/24 and both Lunokhod rovers; Chang'e-3/Yutu and Chang'e-5; MIP and Chandrayaan-2; Beresheet, Luna 25, both HAKUTO-R crashes; Ranger impacts; LADEE, SMART-1, Lunar Prospector, Hiten, Kaguya, Chang'e-1 and Longjiang-2 impacts; selected Apollo rocket/ascent-stage impacts; and the verified **5 August 2026 Falcon 9 upper-stage impact**. The 2022 accidental rocket impact and the 2026 impact both use `failed` for the unplanned surface event; this does not grade the earlier launch missions. The 2022 public name is conservative because the supplied catalogue attributes Chang'e-5-T1 while its linked LROC article uses “mystery rocket.”

The existing Connecting Ridge and Shackleton-rim natural viewpoints remain useful app content. They are outside this mission/status schema; do not delete them when importing the mission pins. Lunar pits, IAU names, the historical Constellation study targets and the Endurance-A concept traverse are also not automatically announced, scheduled missions. Their presence in QuickMap is not sufficient to invent a `planned` mission.

## Coordinate meaning and uncertainty

Hardware locations normally come from the supplied LROC anthropogenic-object GeoJSON. That file's `UNCERTAIN` is **metres**; convert to kilometres and apply an honest display floor. The entries use signed east-positive longitude in the mean-Earth lunar frame. Several historical tracking coordinates lack an established modern frame tie; those carry `verify: true` and large allowances. The radii are display/planning uncertainty, not landing-system accuracy guarantees or uniform statistical confidence intervals.

Planned mission markers generally identify named **regions**, not future spacecraft positions. VIPER uses a published science-area centre; IM-3 uses the published Lunar Vertex target with a 5 km planning allowance. Blue Ghost 3 and polar missions use region centres. Their notes and `precisionKm` must stay visible. `planned-notes.md` lists each centre and its source. For future missions, `date` often represents an advertised launch year or the start of a window because no touchdown date is published. It must not be labelled as a confirmed landing date.

For Artemis, the nine four-corner polygons are copied from the supplied QuickMap file with only exterior ring winding normalized. Pin centres use a south-polar stereographic area centroid; radius covers the farthest corner rounded upward to 10 km. Each polygon has five coordinates including closure, below the 40-point limit. Detailed formula and provenance are in `artemis-region-notes.md`.

`inQuickMap` means the hardware **or the named target place/region used for that marker** occurs in one of the supplied vectors. For a planned spacecraft it does not mean QuickMap already has a spacecraft pin. It is false for objects outside these supplied vectors, even if LROC has separately photographed them. The 2026 Falcon 9 crater uses the later LROC article's refined position, about 88 m from the supplied vector point; the override is documented.

### Records requiring verification

| Place | Limitation |
| --- | --- |
| Luna 2 | Exact crater not identified. NASA gives a reported area 29–31 N and 1 W–1 E; 30 N, 0 E is its centre. LPI gives another nominal latitude, 29.1 N. |
| Ranger 4 | Approximate tracking-based coordinate only; not in the supplied LROC hardware list. |
| Luna 9 | Historical reported coordinate only. NASA warns LROC images do not match Luna 9 panoramas here and the real site is probably at least 10 km away. Unconfirmed 2026 candidate identifications are not used. |
| Luna 13 | Reported landing coordinate, not a confirmed LROC hardware location; 30 km is a conservative display uncertainty, not a published statistical error. |
| Hiten impact | JAXA gives an estimated position; no identified crater or documented ME registration. UTC impact date is April 10, while Japan-local histories say April 11. |
| Lunar Prospector impact | NASA NSSDCA approximate impact coordinate, not a located crater. Planetocentric ME registration of the old estimate is not established. |
| Chandrayaan-1 Moon Impact Probe | Estimated impact point from the final descent pictures, not a crater located in LROC imagery. Authors give near 89.55 S, 122.93 W and say the crater/ejecta has not been found; 2 km is a conservative display uncertainty, not a published error bar. This supersedes widely repeated legacy estimates near 89.76 S, 39.40 W. |
| Chang'e-1 impact | Reported impact point from NASA NSSDCA; not identified as hardware/crater in the supplied QuickMap list and no ME frame tie confirmed. |
| Kaguya impact | Agency tracking estimate, rounded to 0.1 degree; no precise crater or coordinate-frame tie confirmed in this research. |
| LCROSS spacecraft impact | Estimated spacecraft impact coordinate from NASA NSSDCA, not a confirmed crater in the supplied LROC list. Do not confuse it with the accurately mapped Centaur crater. |
| Chang'e-3 | Current operating status could not be confirmed for 2026-11-14. The cited CNSA operations report is from 2016; past is a conservative display fallback, not a claim that the lander has stopped. Yutu is a separate pin. |
| Chang'e-4 / Yutu-2 | Pin is the fixed lander, not Yutu-2's current position. CNSA described continuing record-setting work on 2025-04-25, but operation on 2026-11-14 could not be confirmed. Past is a conservative display fallback, not a claim that the mission ended. QuickMap lists 177.5886 E; the 2020 LROC article gives 177.5885 E and 13 m uncertainty. |
| Luna 25 | Crash and date are confirmed; NASA/LROC describe attribution of this new crater as likely rather than certain. The supplied QuickMap point refines the article's rounded 57.865 S, 61.360 E; 50 m uncertainty conservatively covers the original better-than-40 m location accuracy. |
| Griffin Mission 1 / FLIP | Still upcoming as of 14 November 2026; NASA says late 2026 launch. NASA and Astrobotic name the Nobile region; this marker is the Mons Mouton area west of Nobile identified on NASA's April 2026 delivery-site diagram, not a final touchdown coordinate. VIPER now flies on a separate Blue Origin mission. Coordinate-region association remains approximate. Verify: the final lander coordinates were not confirmed; the west-Nobile/Mons Mouton association comes from a broad NASA planning map and should be checked before detailed terrain comparisons. |

MIP's coordinate comes from the authors' primary LPSC conference abstract on LPI's official `hou.usra.edu` meeting host. It is an image/trajectory inference, not a located crater and not claimed as a peer-reviewed journal result. Its 2 km display allowance is editorial, not a quoted formal error. Other editorial allowances are explicitly labelled in entry notes.

## Validation and supporting evidence

Run `python3 build_sites.py` from `assets-codex/` to reproduce the canonical merge, then `python3 validate_assets.py`. Validation checks JSON parsing, required fields, enums, bounds, finite numbers, unique kebab-case IDs, valid UTC dates, short text length, nonempty strings, verification notes and nine closed polygons of at most 40 points. `validation.json` captures the final result. The source-specific notes and URL logs preserve the separate historical, recent, planned and QuickMap checks. Root `url-checks.json` covers concrete URLs across the final handoff and package metadata; templates are checked through the two concrete QuickMap examples.

QuickMap's camera links respond for Apollo 11 and the exact south pole; visible centring was not browser-verified. Use the supplied camera mathematics, not guessed query parameters. `selectedFeature=3002,20` selects a historical Constellation South Pole feature and should be omitted from generic destination links. The current QuickMap acknowledgement and separate LROC imagery credit are in `../quickmap/quickmap.json`.

## Water-ice marker update

The separate [ice marker notes](ICE-NOTES.md) document the five northern additions,
their instruments, primary sources and limits. Run `build_ice_sites.py` before
`make_sites_ts.py`, using `.venv-data/bin/python -I` from the repository root.
The resulting list has 18 ice markers and preserves all 76 non-ice sites. Only
LCROSS at its mapped Cabeus impact is labelled confirmed. The public marker JSON
is 22,058 bytes. Rebuilding twice produced identical files; marker IDs, statuses,
bounds, source checksums and the bilingual translation draft were checked.
