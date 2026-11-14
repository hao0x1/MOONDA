# QuickMap handoff — checked 14 November 2026

`quickmap.json` contains a working-response 3D camera link template, exact coordinate mathematics, the ten requested layer ids with groups, the selected feature, twelve PSR-related layers, four crater layers, nineteen site-related layers, and credits. `url-checks.json` records HTTP 200 responses for all 34 concrete URLs retained in the JSON. The template is not itself a URL until its computed placeholders are replaced.

The two generated destination links are for Apollo 11 and the exact south pole at 100 km camera height. Both respond with the QuickMap HTML page. The camera construction agrees numerically with a published LROC permalink. The browser host was unavailable, so there is no claim of visual centering verification. The tempting `x/y/z` query form was not supported by primary evidence and is not recommended.

`selectedFeature=3002,20` means the zero-based South Pole feature in the historical Constellation target file, at -89.3 latitude, -130 longitude. Do not carry it into a generic destination link. Likewise, the team's reference stack contains both old (2022) and newer (2024) Artemis region outlines; it should not be copied wholesale.

The PSR collection includes both computed shadow boundaries and pictures of the shadowed ground. A buffered image mosaic includes ground outside permanent shadow. The low-instrument-saturation layer flags unreliable image pixels. These have different meanings and should not share one on/off label in the app. The catalogue's ACT 20 m shadow model is also distinct from the Barker 2023 LOLA dataset.

The current supplied QuickMap catalogue names NASA, Intuitive Machines, and Applied Coherent Technology Corp. in its requested acknowledgement. LROC's separate imagery credit remains NASA/GSFC/Arizona State University. The catalogue's legacy credit hostname failed the response check, so the acknowledgement omits that hostname and the JSON supplies the verified home link separately. No new vectors or other assets were downloaded.

All catalogue paths and labels were read from the supplied inputs before live checks. Source ids and layer ids are different: `stack` uses layer ids. Historical layer names are not evidence that a proposed mission has flown or remains scheduled.
