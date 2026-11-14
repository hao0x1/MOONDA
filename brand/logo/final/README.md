# MOONDA logo

Made by Claude and Codex together on 14 Nov 2026. Codex wrote the critique, drew round 1 (`../round1/`) and reviewed
round 2 (`../round2/CODEX-REVIEW.md`). Claude worked out the real skyline and built the vector. `sheet.png` shows everything.

## The idea (for the pitch)
The **M** in MOONDA is a lunar skyline: the two hills seen from **de Gerlache Rim 2** (88.39°S, 68.87°W), an Artemis III
candidate site near the south pole. MOONDA's own horizon calculator computed it from NASA LRO LOLA elevation data
(azimuth 141.75°–184.5°), and it is stretched 12.5× upward so the hills read at logo size. The gold **Sun** sits in the
notch between them: at the south pole the Sun never climbs high, it skims along the horizon, and gaps like this one decide
which spots get sunlight. That's the question MOONDA answers.

Careful wording (Codex's advice): "derived from a computed lunar skyline, vertically exaggerated about 12×", not just
"the real skyline".

## Two logos
| Use | File |
| --- | --- |
| **Primary logo** (start screen, slides, posters): the ridge-M *is* the first letter, then "OONDA" | `moonda-logo-on-dark.png`, `moonda-logo-on-light.png` (transparent, 2318 px wide); live version `logo.html` |
| **App icon / favicon**: the M alone | `moonda-icon.svg`, `moonda-icon-512.png`, `apple-touch-icon.png` (180), `favicon.svg` (follows the browser's light/dark theme), `favicon-32.png` |

Mark alone: `moonda-mark.svg` (on dark), `moonda-mark-on-light.svg`, `moonda-mark-mono-white.svg`,
`moonda-mark-mono-black.svg`, and `moonda-mark-tiny-white.svg` for one-colour use under 24 px (Sun dropped, because the gap
around it would be under half a pixel).

## Rules
- Wordmark: Google Sans Flex, weight 720, letter-spacing 0.16em, caps. The mark is 1.3 × cap height, sits on the text
  baseline, with 0.19em before the first O. (`logo.html` has the exact CSS.)
- Colours: `#eeeff1` on dark, `#141519` on light; Sun `#f1c56b` on dark, `#d99a2b` on light. Nothing else.
- Don't add glow, outlines, gradients or a circle behind it. Don't put the mark next to a full "MOONDA" (it reads "M MOONDA").
- The plain word MOONDA in the same font is fine where the mark can't be used (small text, legal lines).

## Rebuild
`node make-mark.mjs` (needs `../real-horizons.json`) writes all SVGs. Arm thickness, V depth and Sun size are parameters
(`TlL`, `TlR`, `tipY`, `sunR`, `sunY`), for example `node make-mark.mjs sunR=12`.
