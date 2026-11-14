# Planned mission research — checked 14 November 2026

`planned-sites.json` contains 11 pins for missions with an announced target region and a usable published year. `unpinned-plans.json` deliberately uses a separate schema that can express a missing date, a cancelled mission, and a missing longitude. These records must not be imported as confirmed surface pins. No future launch has been reclassified as landed merely because an old schedule date passed.

The planned dates are schedule years or the start of a stated window, usually launch windows, not promises of touchdown in that calendar year. Each entry explains that distinction. All are `planned`; none is hardware operating on the surface.

## Changes that Claude must preserve

- NASA's current [Artemis IV mission page](https://www.nasa.gov/mission/artemis-iv/) gives the first Artemis surface landing as early 2028 and still links the nine candidate regions. [NASA's October 2026 Artemis III description](https://www.nasa.gov/missions/artemis/nasas-artemis-iii-mission-to-test-future-moon-lander-operations/) describes a 2027 Earth-orbit test. Keep the historical QuickMap layer name “Artemis III” as source metadata, but do not describe Artemis III as the current next surface landing. This supersedes the program assumption in the app's existing hand-made list.
- The requested APEX 1.0/CP-12 pin is obsolete. The [operator's 15 July 2026 announcement](https://www.ispace-inc.com/2026/07/15/ispace-u-s-update-on-contract-with-draper/) and the [current NASA DMEN page](https://www.nasa.gov/stmd-flight-opportunities/transitions-of-flight-tested-technologies/the-dmen-chronicles-flight-testing-vision-aided-navigation/) confirm termination. The earlier March “ULTRA, U.S. mission 2030” plan is superseded. The [13 November 2026 operator report](https://www.ispace-inc.com/2026/11/13/ispace-announces-fy2027-q2-financial-results/) confirms a different Japanese ULTRA mission planned for 2028, without a confirmed public target site in the sources checked.
- VIPER's delivery is now Blue Origin's **second MK1**, targeted for late 2027, separate from Griffin-1. The VIPER rover pin and its MK1 carrier pin represent **one planned landing**. NASA's [20 October rover update](https://www.nasa.gov/missions/moon-base/nasa-provides-progress-update-on-moon-base-rovers/) reconfirms the 2027 mission. Griffin-1 instead carries FLIP and smaller rovers.
- IM-3 remains planned: [NASA's current launch schedule](https://www.nasa.gov/event/clps-flight-intuitive-machines-im-3/) says early 2027; the operator's 12 November release narrows launch to March-April 2027. The JSON uses the [published Lunar Vertex science target](https://www.frontiersin.org/journals/astronomy-and-space-sciences/articles/10.3389/fspas.2022.926018/full), 7.585 N, 58.725 W, with a conservative 5 km planning allowance. This is not a measured landing ellipse.
- Firefly's live pages now say Blue Ghost 2 no earlier than 2027 (Nassau), Blue Ghost 3 no earlier than 2028 (Gruithuisen Domes), and Blue Ghost 4 no earlier than 2029 (Haworth rim). Older NASA overview charts still show older dates; use the current operator pages in the JSON.

## Coordinate honesty

All coordinates are planetocentric, east-positive, and normalized to -180..180. QuickMap region centres use the average of unit Cartesian vectors at polygon vertices, converted back to latitude/longitude, so polar longitude convergence does not distort the calculation. This is a reproducible **marker within a named region**, not a selected landing point. The centres were calculated from the supplied read-only vectors.

| Entries | Coordinate meaning | Allowance |
| --- | --- | --- |
| VIPER and its MK1 carrier | Published mission-area centre on Mons Mouton, Heldmann et al. 2026, section 3.1.2 | 10 km, conservative planning allowance; not landing accuracy |
| Chang'e-8 | Centre of QuickMap's older “Leibnitz Beta Plateau” polygon, a named target in CNSA's April 2025 announcement | 25 km |
| LUPEX | Centre of the broader QuickMap “Connecting Ridge” polygon | 25 km; candidate only |
| Griffin-1 | Mons Mouton marker west of Nobile, matching the broad NASA delivery-map target | 40 km; verify flag set because final coordinates and this association remain unconfirmed |
| IM-3 | Published Lunar Vertex science landing target, Waller et al. 2022, Figure 3 | 5 km, planning allowance |
| IM-4 | QuickMap nine-region “Mons Mouton” centre | 25 km |
| Blue Ghost 2 | [USGS Nassau crater centre](https://planetarynames.wr.usgs.gov/Feature/4159), diameter 75.8 km | 40 km |
| Blue Ghost 3 | QuickMap Constellation “Gruithuisen” centre | 40 km |
| Blue Ghost 4 | QuickMap nine-region “Haworth” centre; Firefly targets the rim | 50 km |
| MK1 Endurance | QuickMap older “Connecting Ridge” region centre | 15 km |

`inQuickMap: true` on planned pins means the **target place/region** occurs in a supplied vector, not that QuickMap contains a marker for the future spacecraft. In particular, Constellation sites are historical exploration regions, not selected contemporary landing ellipses. The QuickMap links in `coordSource` identify the relevant layer; the exact supplied filename is in the source name. The [Constellation product metadata](https://data.lroc.im-ldi.com/lroc/view_rdr/SHAPEFILE_CX_TARGETS) is the primary provenance of that region list.

LUPEX's candidate-region association comes from [ISRO Space Research 2022-2023, page 117](https://www.isro.gov.in/media_isro/pdf/Publications/Space_Research_2022_2023_040625.pdf), which compares Connecting Ridge 1, Connecting Ridge 2 and Shackleton Ridge and identifies CR1 as most suitable. This is a candidate study, not a final landing-site announcement. The [JAXA page launched 6 November 2026](https://humans-in-space.jaxa.jp/future/lupex/) gives FY 2028 launch and only a south-polar landing region. FY 2028 runs April 2028-March 2029; JSON date 2028 is its start.

## Tracked without invented pins

Chang'e-7 is not known to have landed. CNSA's news index records its 23 August 2026 withdrawal of the 2026 launch window; no replacement year was confirmed in the allowed primary sources. The [original payload opportunity](https://www.cnsa.gov.cn/n6758823/n6758838/c6840869/part/6797908.pdf) describes a broad region south of 85 degrees. Because the requested pin schema requires a year, it is tracked with `date:null` in `unpinned-plans.json`. Do not silently reuse 2026 or assign 2027 from press expectations.

The [7 November NASA award](https://www.nasa.gov/news-release/nasa-awards-moon-base-transportation-technology-science-projects/) makes PROMISE a planned late-2028 mission on MK1, but publishes no bounded site beyond the south polar region. The same problem applies to CLV-1, Pegasus and MoonFall. A geographic-pole coordinate with longitude 0 would be a fabricated destination. They remain in the unpinned file. New CLPS 2 vendor awards alone are not assigned surface missions.

The planned pins are all missing from the existing `places.ts`; no existing historical mission coordinate was modified by this research. Root research provides the historical coordinate comparison and the nine Artemis polygons.

## URL checks

All URLs written here are primary and tracking-free. HTTP response checking is in `planned-url-checks.json`; the DOI resolves to the publisher's bot-protection page in a direct automated request, although the peer-reviewed article text and exact mission-area coordinates were indexed and readable via search. The DOI is retained as the canonical citation. No binary document was downloaded locally, installed, opened, or executed.
