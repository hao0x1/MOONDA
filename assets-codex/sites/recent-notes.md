# Recent surface missions — checked 14 November 2026

This is the research handoff for `recent-sites.json`, 17 pins. Read the `verify` field and `note` together: Chang'e-3 and Chang'e-4 / Yutu-2 have unresolved present operations, MIP has an inferred impact point, and Luna 25 has a likely crater attribution. The schema has no unknown-status category, so the Chinese landers' `past` value is explicitly a display fallback and does not assert that their hardware has stopped.

The supplied LROC QuickMap anthropogenic-objects file was read before web research. Every recent pin except MIP exists in that file. Hardware points use the catalogue values except Falcon 9 2026, where the later primary LROC article gives a refined position; that override is documented. No app files were changed.

## Integration corrections at a glance

- Replace IM-2 latitude **-84.81** with **-84.7906**, about 0.59 km north of the existing marker. Longitude is **29.19567**.
- Replace Chang'e-4 **-45.44, 177.59** with **-45.4562, 177.5886**, about 0.49 km away.
- Keep **1 June 2024 UTC** for Chang'e-6 and **19 January 2024 UTC** for SLIM.
- Hakuto-R M2 / RESILIENCE crashed **5 June 2025 UTC**; the Japanese release date/time uses 6 June.
- Add Blue Ghost Mission 1, Hakuto-R M1/M2, SLIM, Beresheet, Luna 25, Falcon 9's checked 2026 impact, Chang'e-3/Yutu, Chang'e-5, MIP and Chandrayaan-2 if absent.
- `active` means powered surface operations, so passive reflectors do not keep an otherwise finished mission active.

Each subsection below preserves the researcher's provenance and limitations. URL audits cover all 30 distinct recent source/coordinate URLs; the China/India and own-source logs are stored alongside this file, and the commercial subsection records its successful checks.

---

# China and India mission research, checked 14 November 2026

The eight entries in `china-india-fragment.json` are ready to merge. Coordinates come from the supplied LROC QuickMap anthropogenic-objects catalogue whenever that catalogue has a row; linked LROC articles provide public provenance. `china-india-url-checks.json` records live HTTP checks. No executable downloads or package installation were used.

## Status limitations for integration

- **Chang'e-3 lander:** `past`, `verify: true` is a conservative display fallback because this schema has no `unknown` status. It must **not** be presented as proof that the lander has stopped. The [CNSA report](https://www.cnsa.gov.cn/english/n6465652/n6465653/c6480404/content.html) confirms operation in 2016, not in November 2026. No current primary operations update was found.
- **Yutu:** separate `past` rover pin. A [CNSA retrospective](https://www.cnsa.gov.cn/n6758823/n6758844/n6760445/n6760446/c6841528/content.html) explicitly confirms it stopped on 31 July 2016. Date is arrival aboard Chang'e-3, not the later drive down the ramp.
- **Chang'e-4 / Yutu-2:** `past`, `verify: true` has the same fallback meaning. [CNSA's April 2025 article](https://www.cnsa.gov.cn/n6758968/n6758973/c10666020/content.html) describes continued record-setting work, but a primary confirmation of operation on 14 November 2026 was not found. Do not infer cessation, or label it `active` without a current operations check. The fixed pin is the lander; it is not Yutu-2's current location.
- **Chandrayaan-3:** classified as a completed surface science mission. [ISRO's mission updates](https://www.isro.gov.in/Chandrayaan3.html) record sleep in September 2023 and attempted communication afterward, with no confirmed resumption found. A passive laser reflector remains scientifically useful but is not powered surface operation.

## Coordinates and dates

- **Moon Impact Probe:** the supplied QuickMap catalogue has no MIP row. [Stooke, Ahmed and Subramanian, LPSC 2021 abstract 1013](https://www.hou.usra.edu/meetings/lpsc2021/pdf/1013.pdf) matches the last descent pictures to LROC imagery and estimates impact near **89.55 S, 122.93 W**, on the Earth-facing slope below Connecting Ridge. They explicitly say the crater or ejecta has not been found. `verify: true` flags the inferred position. The **2 km uncertainty is an editorial conservative display radius, not a published statistical error**. It is preferable to silently plotting the old 89.76 S, 39.40 W estimate as exact.
- **Chang'e-6:** landed **1 June 2024 UTC**, not 2 June UTC. China local date was 2 June. The supplied QuickMap point (-41.6383, -153.9857) differs by roughly 13 m from the initial LROC report (-41.6385, -153.9852); use the supplied catalogue point with a 30 m uncertainty.
- **Chang'e-4:** supplied catalogue point is (-45.4562, 177.5886). [LROC's refined report](https://lroc.im-ldi.com/images/1168) says (-45.4562, 177.5885), 13 m horizontal uncertainty. A 20 m radius covers the tiny difference.
- **Chandrayaan-2 Vikram:** impact was **6 September 2019 UTC**, although it was already 7 September in India. This entry is the destroyed lander, not the ongoing orbiter mission.
- **Chang'e-5 and Chang'e-6:** only the landers that remain on the Moon are pinned. Earth-return capsules and orbiters are outside this surface dataset.

## Differences from app/src/data/places.ts

- Chang'e-3, Yutu, Chang'e-5, MIP and Chandrayaan-2 Vikram are missing there.
- Its Chang'e-4 position (-45.44, 177.59) is about **0.49 km** from the supplied LROC catalogue point; this is more than normal rounding of the catalogue latitude. Replace it with the LROC point.
- Its Chandrayaan-3 position is rounded by about **0.12 km**, so it should not imply 10 m certainty.
- Its Chang'e-6 point is a rounded approximation, about **0.11 km** from the catalogue point. The existing **1 June 2024** UTC date is correct.
- A single lander/rover pin does not track a rover's movement. Chang'e-4 / Yutu-2 and Chandrayaan-3 / Pragyan pins explicitly mean the lander site.


---

# Commercial landers: checked 14 November 2026

`commercial2025-fragment.json` contains five visited surface sites. All coordinates are copied directly from the supplied LROC QuickMap anthropogenic-object file, using its mean-Earth, east-positive -180..180 values; `precisionKm: 0.02` is a conservative 20 m display uncertainty. These are resting/impact positions, not planned target points. All ten source/coordinate URLs in the fragment returned HTTP 200 using a GET request on this research run.

- **IM-1 Odysseus:** powered operations are over. The company’s 23 March 2024 official mission update confirmed no revival after the lunar night; its original website currently has a redirect loop in direct HTTP, so the pin cites the accessible NASA mission-end article, which says the instruments ceased operating seven days after landing. `partial` describes the tipped landing, not a claim that it returned no science.
- **IM-2 Athena:** NASA explicitly reports mission end on 7 March 2025 after some science data returned. The supplied measured latitude is **-84.7906**, versus **-84.81** in `places.ts` (about **590 m** farther south in the old pin); longitude **29.19567** versus 29.20 differs by about 12 m at that latitude. The existing NASA mission-specific link is dead; the replacement source is an accessible NASA news release.
- **Blue Ghost Mission 1:** successful; powered mission ended on 16 March 2025. Its passive reflector does not make the lander a continuing powered mission. Keep the supplied QuickMap point (18.5622, 61.8102); the linked LROC text rounds a few metres differently to (18.5623, 61.8103).
- **HAKUTO-R M1 and M2:** both failed at landing. UTC impact dates are **2023-04-25** and **2025-06-05**, even though the operator’s Japanese releases say 26 April and 6 June. Rashid and TENACIOUS were never deployed; their parent crash pins cover their locations without pretending a separate rover traverse exists.

The old IM-1 and IM-2 NASA mission-specific pages returned 404. Firefly’s main website and the IM investor release were readable through search but returned 403 in direct HTTP, so the fragment uses accessible NASA alternatives. The ispace releases and LROC pages responded normally. No tracking parameters were written.

## Other recent surface arrivals

No additional 2026 commercial landing was confirmed in the checked official material. This does **not** convert old advertised 2026 dates into completed missions. NASA’s [CLPS delivery list](https://science.nasa.gov/lunar-science/clps-deliveries/) (updated 23 October 2026) still presents IM-3, Griffin, Blue Ghost 2/3 and MK1 deliveries in the future. The [August 2026 cargo update](https://www.nasa.gov/missions/moon-base/nasa-provides-updates-on-moon-base-cargo-landers-tech-demonstrations/) and current [Moon Base Phases](https://www.nasa.gov/moonbase-phases/) page likewise describe preparation for upcoming cargo missions. Their schedules need the separate planned-sites research. These three links returned HTTP 200.


---

# Other recent surface sites — checked 14 November 2026

- SLIM is **past**, with **success**: JAXA explicitly ended lunar operations on 23 August 2024 and says the mission exceeded initial goals. Landing date is **19 January 2024 UTC**, not 20 January JST. Its LEV-1 / LEV-2 robots are described within the lander entry; their exact individual resting positions were not confirmed.
- Beresheet uses the supplied QuickMap point. Original LROC coordinates differ by about 9 m; a conservative 30 m uncertainty covers that difference and the quoted confidence interval.
- Luna 25 uses the supplied QuickMap point. NASA/LROC still call the crater attribution **likely**, so `verify: true` preserves that uncertainty. The location is not the originally planned 69.545 S, 43.544 E landing site.
- The Falcon 9 upper-stage impact is a **checked 2026 event**, on **5 August 2026 at 06:35 UTC**. Primary LROC reporting published 18 August gives a more precise position than supplied QuickMap; adopted point is about 88 m north of the file point. The 0.1 km marker uncertainty is a conservative editorial allowance, not a quoted formal error. The mission outcome enum has no accidental-impact category; `failed` describes that surface event only.

## Primary sources

- [JAXA SLIM conclusion](https://global.jaxa.jp/press/2024/08/20240826-1_e.html)
- [LROC SLIM landing](https://lroc.im-ldi.com/images/1358)
- [LROC Beresheet scar](https://lroc.im-ldi.com/images/1101)
- [NASA Luna 25 likely crater](https://www.nasa.gov/humans-in-space/nasas-lro-observes-crater-likely-from-luna-25-impact/)
- [LROC Luna 25 likely crater](https://lroc.im-ldi.com/images/1311)
- [LROC Falcon 9 impact](https://www.lroc.im-ldi.com/images/1499)

All listed sources responded through the web reader during this check.
