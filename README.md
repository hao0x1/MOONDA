# MOONDA — Moon landing site explorer

NASA Space Apps Challenge 2026 · **Lunar Landing Site Navigator** · Team MOONDA (Phnom Penh)

Explore the Moon like Google Maps, then drop a pin near the south pole to see **when a lander there
would get sunlight and when it could see Earth**, using NASA terrain data. Compare up to four spots,
or the same spot arriving 3 days later.

## Run it

Needs Node.js 20.19+ (you have v25).

```bash
cd app
npm install        # first time only
npm run dev        # opens on http://127.0.0.1:5190
```

Or double-click `start-local.command` (builds once, then serves the fast production version on
http://127.0.0.1:5191). For the event: `npm run build`, then serve `app/dist/` from any static host.

The app works without internet for the whole Moon and for the south-pole region (a whole-Moon photo
and 4,224 sharp south-pole photo squares are stored in `app/public/data/`). With internet it also
sharpens other regions from NASA Moon Trek and ASU Lunaserv. Names, NASA science maps, the height
map, the sky and all calculations are local.

On first open there is a short loading screen (about 5–10 s): it loads the height map, photos and the
sky, and quietly prepares the south-pole views so that everything is smooth afterwards.

## What changed on 13–14 Nov 2026 (v6)

- **New look**: Google Sans Flex type, calm panels without boxes inside boxes, one toolbar at the top right, big numbers in the info panel, and the Sun and Earth shown as real NASA photos everywhere (`app/public/ui/`, made by `data-prep/ui_glyphs.py`).
- **Start screen**: loads everything first (Moon photo, mountains, sky, calculator, south-pole views, the Stand-here view, music), then "Enter". Two graphics modes: **Full detail** and **Smooth** (`app/src/app/quality.ts`). Add `?start` to the address to keep the start screen up in test runs.
- **Arrival date**: type it ("2008-07-01 14:30", "1 Jul 2008", "2040", "now", "+3d") or pick month and year directly (`app/src/ui/DateTimePicker.tsx`, years 1900–2100).
- **Moving the Moon**: it keeps turning after a flick and slows down smoothly, like Google Earth (`app/src/moon/navigation.ts`, constants at the top).
- **Stand here**: compass tape with degrees, Neil Armstrong's Apollo 11 gloves as first-person hands (Smithsonian 3D scans, CC0), low-gravity walking and hopping, a helmet lamp and real stars at night, Sun/Earth tags that sit on the skyline when the body is below it. The dotted skyline is off by default.
- **MOONDA AI**: a saved chat can no longer show a fake endless "Working…"; there is a Stop button, a stall cut-off and a "Run again" for interrupted runs.
- **Compare**: one table, four plans visible at once.
- **Khmer**: the "ខ្មែរ / English" switch in the top bar and on the start screen (`app/src/i18n/`, English in `en/`, Khmer in `km/`; a missing Khmer line falls back to English).
- **Music**: "Cylinder Five" by Chris Zabriskie (CC BY 4.0, see `app/public/audio/CREDITS.md`); the speaker button turns it off.
- **Later on 13 Nov (from the team's own mockup)**: the boxed time bar became a borderless bottom row (menus left, ruler timeline centre, big "Projecting time" clock right); the map buttons are a column at the right edge; the info panel is one small table; the date picker is slimmer; the fling after a drag is capped lower.
- **MOONDA the robot** replaced the gloves in Stand here:
  - NASA's Perseverance model (public domain) at half size. Its size is one number: `ROBOT_SCALE` in `app/src/moon/walk.ts`.
  - Six wheels that spin and sit on springs, so it rocks, dips and bounces over bumps in the low Moon gravity; it bumps into rocks instead of driving through them.
  - A solar panel that turns to follow the Sun (and folds flat at night), dust thrown up by the wheels, headlights at night.
  - Wheel tracks: two darker lines of pressed soil behind it, with tread marks up close, kept for a few hundred metres (`app/src/moon/wheelTracks.ts`).
  - Real Sun shadows for the robot and the rocks near it (shadow settings: `SUN_SHADOW` in `app/src/moon/sunShadow.ts`).
  - Its own sounds (`app/src/audio/rover.ts`) and a camera head that looks where you look.
  - Keys: W A S D drive, Shift fast, V camera (Lander / Behind / Mast), L lights.
- **Flat 2D map**: press **M** (or the 2D button) and the globe unrolls into a flat map; press again and it rolls back up. With "reduce motion" switched on in the computer's settings it simply fades instead. The flat map is drawn from the photo stored with the app (1.3 km per pixel; sharper polar photos between about 56° and 76°), so its closest zoom is about 250 km across. Zoom in again at that point and a small note offers "Go closer on the globe", which rolls the map back up at that place (`app/src/moon/flatMap.ts`, `mapMode.ts`).
- **Looking far in Stand here** (evening of 13 Nov): the ground shading costs about a third less, so turning and driving hold 60 frames per second on a Retina laptop (Full detail draws Stand here at up to 3.9 million pixels; a small governor in `app/src/moon/groundLod.ts` sheds fine detail only while the view moves and the graphics card is behind). Distant ground keeps small dark and bright strokes instead of going smooth (`groundFar.ts`), far stones are no longer drawn black and now cast shadows, and wheel dust is the colour of the ground and dark inside the robot's own shadow.
- **"Data detail" layer**: colours the map by how sharp the NASA data is in each part (south pole sharpest, the rest about 2 km heights and 100 m photos, one region rebuilt from a NASA brightness map). Nothing on the map is guessed or made up by AI; only the small rocks and soil near you in Stand here are an artist's impression.
- **Bottom row from the mockup**: menus on the left, the ruler timeline in the middle, the big "Projecting time" clock on the right, and the map buttons as one column at the right edge.
- **Where the knobs are**: robot size `ROBOT_SCALE` in `app/src/moon/walk.ts`; shadows `SUN_SHADOW` in `app/src/moon/sunShadow.ts`; Full detail / Smooth settings in `app/src/app/quality.ts`; wheel tracks `TRACKS` in `app/src/moon/wheelTracks.ts`.

## How to move around (like Google Earth)

| Do this | What happens |
| --- | --- |
| Drag | Grab the Moon: the spot under the cursor stays under the cursor (a ring shows around the hand); flick and let go and it keeps turning, then slows down |
| Scroll wheel, two-finger scroll, or trackpad pinch | Smooth zoom toward the cursor |
| Double-click | A small circle marks the spot and the view glides in ×3 (right double-click or Shift + double-click: out) |
| Right-drag, middle-drag, or Ctrl/⌘/Shift + drag | Turn (left/right) and tilt (up/down) around the grabbed spot |
| Arrow keys · `+` `-` · `N` · `U` | Pan · zoom · north up · look straight down (Shift + arrows turn/tilt) |
| Compass button | North up · **2D** button: flat map · Sun button: real sunlight on/off |
| Click | Select a name or marker, or drop a pin on the ground |
| Click the **Sun** or **Earth** chip | Glide to a view where it shows above the Moon's edge |
| `M` or the **2D** button | Switch between the globe and the flat map |
| **Stand here** (in the info panel) | Stand on the Moon next to MOONDA the robot: drag to look around, scroll to zoom the lens, Esc or **Back to map** to leave |
| In Stand here: `W` `A` `S` `D` · `Shift` · `V` · `L` | Drive · drive fast · camera (Lander / Behind / Mast) · lights on/off |

## What's on screen

| Part | What it does |
| --- | --- |
| 3D Moon | CesiumJS globe with real 3D mountains from NASA LOLA heights (80 m near the south pole, ~1.9 km elsewhere), lit by the Sun where it really is at the time on the time bar. The night side stays dim but readable. |
| Sky | The real sky around the Moon: the Milky Way, about 8,900 stars, the planets, a 3D Earth with its true phase and the side that really faces the Moon, and the Sun. All move when the time changes. |
| Info panel (left) | Click anything (or anywhere). Same layout for every kind of place: what it is, **Stand here / Compare / Zoom in**, "Right now" in plain words, the mission numbers (% sunlight, longest dark, % Earth view, longest without Earth), lander height, NASA map values under the spot, and where the data comes from. |
| Lander view | Stand on the real terrain at any spot: NASA's photo of that place on the ground, lit by the real Sun with real hill shadows, level horizon, the Sun and Earth in their true places, a compass strip, and plain-word status. The dotted line is the skyline our numbers use. Press play to watch the Sun move. |
| Compare (right drawer) | Up to 4 plans (spot + arrival). Say what the lander needs ("my battery can survive 3 days of darkness", "it can go 1 day without talking to Earth") and it answers in one sentence which plan works. Each plan shows two bars — longest dark and longest without Earth — against your limit. "Try arriving 3 days later" adds the same spot with a later landing. |
| Time bar | One row: play, date (UTC + Cambodia time), the Sun/Earth track, then menus for arrival, mission length and speed, and **Now**. |
| Layers | Photo, sharp south-pole photo, 3D mountains, height colours, real sunlight, Sun and Earth markers, stars and Milky Way, planet and star names, place names, Artemis regions, past landings, and NASA polar maps (sunlight, Earth in view, permanent shadow, temperature, slope). |
| Search | 9,087 official IAU names + NASA's 9 Artemis regions + past landings + famous spots. |
| Names on the map | Google-Earth-style: only names big enough for the current zoom, most important first, never overlapping, fading in and out. |

## How the science works (plain words)

1. **Hills** — NASA's Lunar Orbiter Laser Altimeter (LOLA) measured the height of the ground. We use the
   80 m-per-pixel south-polar map near the spot and a 240 m version out to ~300 km.
2. **Skyline** — from the spot (plus panel height), we walk outward in 720 compass directions along the
   curved Moon surface and keep the steepest hill angle. That's the skyline. (~15 ms per spot.)
3. **Sun and Earth** — Astronomy Engine gives their positions; we rotate them into the Moon's own
   latitude/longitude frame (IAU rotation model) and into the local sky of the spot.
4. **Blocked or not** — if the Sun (or Earth) is lower than the skyline in its direction, a hill blocks it.

**Checks** (run them yourself):

- `node app/scripts/check-ephemeris.ts` — our Sun/Earth directions vs NASA/JPL Horizons: worst
  difference **0.0014°**.
- `node app/scripts/check-horizon.ts` (with `npm run dev` running) — known places over 2026:
  Shackleton floor 0% sun (permanent shadow ✓), Connecting Ridge ~80% sun (published ~80–90% ✓),
  Malapert summit 100% Earth view ✓, Haworth and Faustini floors 0% ✓, Apollo 11 ~51% sun with a
  ~15-day night and Earth 100% ✓, Chang'e-4 (far side) Earth 0% ✓.

**Limits we say out loud:** "Earth in view" is geometry — it's needed for direct radio contact but
doesn't prove a working link. Results use the Sun's centre (the card also shows partial Sun). Height
map pixels are 80 m, so very small rocks and bumps are not included. Long-term maps are multi-year
averages, not forecasts. Artemis markers are approximate points inside NASA's regions.

## Data sources

| What | Source |
| --- | --- |
| Moon photo | NASA Moon Trek — LRO WAC global mosaic. Where that mosaic is lit from the other side (90°W–180°), NASA's albedo map (SVS CGI Moon Kit) × LOLA/SLDEM2015 hillshade is used instead so there is no seam. Local copies are made by `data-prep/base_mosaic.py`; credits in `app/public/data/CREDITS-imagery.md` |
| South-pole photos | LROC WAC South Pole Summer Mosaic and LROC NAC south-pole controlled mosaic via ASU Lunaserv (QuickMap's server); stored locally by `data-prep/polar_tiles.py` |
| Sky | NASA SVS Deep Star Maps 2020, HYG star database, NASA Blue Marble / Black Marble (Earth) — see `app/public/space/CREDITS.md` |
| Heights | NASA LRO LOLA `LDEM_80S_80M` (PDS Geosciences) — `data-prep/dem.py` |
| Sunlight, Earth view, permanent shadow | LOLA illumination products (Mazarico et al. 2011, Icarus 211) — `data-prep/layers/` |
| Temperature | LRO Diviner Polar Resource Product (Paige et al. 2010, Science 330) — `data-prep/layers/` |
| Names | IAU Gazetteer of Planetary Nomenclature (USGS) — `data-prep/names.py` |
| Artemis regions | NASA, Oct 2024 update (approximate markers) |
| Sun/Earth positions | Astronomy Engine (MIT licence), checked against JPL Horizons |
| 3D engine | CesiumJS (Apache 2.0) |

Not an official NASA product. NASA data is public; credit the sources above.

MOONDA's own code is under the MIT licence (`LICENSE`). Third-party data, models, fonts and music keep their own terms.

## Folders

- `app/` — the website (React + TypeScript + CesiumJS). Science code is in `app/src/science/`.
- `data-prep/` — scripts that turned NASA downloads into app files (rerunnable).
- `data-raw/` — original downloads (not needed to run the app).
- `app/public/data/` — the Moon photo, height map and 4,224 south-pole squares the app loads (about 590 MB). Kept out of git because of its size: `data-prep/` rebuilds it, and the built site on Netlify already has it.
- `docs/V4-SPEC.md` — what the first big redesign set out to do.

## Testing like a user

`app/scripts/drive.mjs` drives the page in a hidden Chrome on the real graphics card: it clicks, drags, scrolls,
takes screenshots and measures frame rates. Example (with `npm run dev` running):

```bash
cd app && node scripts/drive.mjs '[{"do":"ready"},{"do":"click","text":"South Pole"},{"do":"wait","ms":3000},{"do":"shot","name":"pole"}]' --out /tmp/moonda-shots
```

Maths checks: `node scripts/check-frame.ts`, `check-ephemeris.ts`, `check-sky.ts`, `check-imagery.ts`,
`check-terrain.ts`, and `check-horizon.ts` (needs the dev server).

## Built with AI help

Claude and Codex, 13–14 Nov 2026. Disclose this wherever the rules ask.
