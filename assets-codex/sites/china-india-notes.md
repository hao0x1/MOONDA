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
