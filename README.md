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
sharpens the rest of the Moon from Lunar QuickMap (JAXA Kaguya and LROC photos), NASA Moon Trek and ASU Lunaserv. Names, NASA science maps, the height
map, the sky and all calculations are local.

On first open there is a short loading screen (about 5–10 s): it loads the height map, photos and the
sky, and quietly prepares the south-pole views so that everything is smooth afterwards.

## What changed on 14 Nov 2026 (v7): driving, routes, hazard maps and the new look

- **"Stand here" is now "Land here".** Same view, new name everywhere (English and Khmer).
- **A hands-on tutorial.** The start screen offers **Enter with a short tutorial** (first visit) or **Just enter**; later visits get **Enter** and **Show the tutorial**. The tour is one banner at the top of the page with six small objectives: move the Moon, pick a spot, land on it, drive the rover, compare spots, switch on a map. It watches what you really do, in any order, ticks each one off and shows the next, with a ring on the control to use; it follows you onto the surface and back (`app/src/ui/Tutorial.tsx`, `tutorialStore.ts`; remembered in `localStorage` as `moonda.tutorial.v1`). The **Tutorial** button in the top bar runs it again.
- **"While you wait".** A moment after loading begins, a small board drops in on two ropes beside the loading list, bounces and settles, and asks three quick things: when your lander arrives, how long its battery lasts in the dark, how long it can go without seeing Earth. Each has two ready answers and a box to type your own number of days. The answers set the arrival date on the time bar and the two limits in Compare (`app/src/ui/WaitQuestions.tsx`).
- **The rover stays on top of the ground.** The camera is never left under the drawn ground (the landing curtain waits for the fine ground round the rover, and a floor check runs every frame after the frame's ground tiles are chosen), the wheels sit on the ground that is drawn, and a rock that fits between the wheels and under the belly (about 25 cm) is driven over instead of stopping the rover; a taller one still blocks, and reversing frees it (`app/src/moon/lander.ts`, `walk.ts`, `robotBody.ts`, `lolaTerrain.ts`; checks in `app/scripts/check-surface-safety.mjs`, `check-rock-clearance.ts`, `check-rock-browser.mjs`). The wheel tracks read the camera when they are drawn, not earlier in the frame: with the late camera correction they were otherwise drawn metres off, as huge dark slabs in front of the lens (`wheelTracks.ts`).
- **No holes in the far ground, and a second landing always opens.** Two faults found by driving at one place, going back to the map and landing at another. (1) When fine ground replaced a coarse tile, the tiles cut from it were given a fresh record that kept the old bounding box but a horizon point of (0, 0, 0); Cesium reads that as "behind the Moon", hides the tile, and a hidden tile is never loaded, so whole tiles of far ground stayed missing and the stars showed through (black bands across Tycho's floor seen from its wall). The box is no longer carried over, so Cesium works both out again (`resetOldCuts` in `lolaTerrain.ts`). (2) The eye was seated on "the ground as drawn" even when that was the far view's coarse mesh, which can lie hundreds of metres under the real surface (950 m on the Shackleton rim when arriving from Tycho); the real tiles were then above the eye, never in view, never drawn, and the landing curtain waited for ever. Until fine ground is proven under the eye it is now never lower than the exact NASA height (`setEyeHeight` in `lander.ts`).
- **MOONDA AI no longer breaks a chat.** Netlify ends any single answer partway (after 30 s in an ordinary function, 60 s at the edge; both measured), and the page used to store that half answer as if it were whole. The model then refused every later message in that chat ("The AI service had a problem with this request"). Now `/api/ai` is answered by an edge function (`app/netlify/edge-functions/ai.js`, 60 s instead of 30 s), and the page (`app/src/ai/agent.ts`) never stores a half step: if an answer is cut while the model is still thinking it asks once more without the long thinking, if it is cut partway through the text it has the model carry on from the last word, and saved chats are cleaned of broken turns before anything is sent. The panel is darker and nearly solid, and on a short window it is scaled like the other panels, so the map buttons sit beside it instead of under it.
- **Short windows.** On a window under 860 px tall (a laptop with the browser's bars showing) the side panels, the Layers box and the bottom row are drawn a little smaller, so everything fits without zooming the browser out; the Moon itself is never scaled (`--z` in `app/src/styles.css`, set in `main.tsx`).
- **Info panel from the team's mock** (`app/src/ui/PlaceCard.tsx`, `DayBars.tsx`): the kind of place, the name with its coordinates and copy button beside it, one plain line, the source. Then **Mission timeline**: two bar charts, **Sunlight presence** and **Earth signal**, one bar per mission day (hover a bar for that day's share; click it to move the time bar there), and a **Summary** of four numbers: sunlight, longest dark, Earth in view, longest without Earth. The ground values are below the fold.
- **Compare from the team's mock**: "Robot information" with two rulers in **days** that you drag (quarter days, Shift for whole days, or type any number up to 365; the ruler grows past 7 days and keeps whole-number labels; clear the box to skip a check), then one table: location, longest dark, longest without Earth, a tick or a cross against your limits, and a **Best** tag. As many plans as you like (letters go on past Z, the table scrolls). A row's menu has **Compare another landing date** (a calendar with 1, 3, 7 and 14 days later one click away, or any typed date) and **Change this plan's landing date**.
- **Rover physics.** Gravity now acts along the slope (`app/src/moon/walk.ts`, `DRIVE`): downhill MOONDA runs faster than on the flat (2.4 m/s on 10°, 2.8 on 20°), uphill it is slower, and with the keys released it rolls on down anything steeper than about 9° until you brake with S. Parked, its brakes hold. Speeds are along the ground.
- **Small craters are real ground now.** The craters of about 1 to 50 m near the rover used to be shading only; they are now dips in the terrain itself (`app/src/moon/craterField.ts`, built into the terrain tiles in `lolaTerrain.ts`), so the rover pitches down into them and climbs out, and they stay where they are however far you drive. They are an artist's impression at sizes NASA's 80 m heights cannot show.
- **Rocks.** A rock up to three quarters of a wheel high (19.7 cm) is driven over, as a rocker-bogie rover does; only bigger ones stop it. Rock sizes for bumping come from the stones' real meshes (`rockOutline.ts`, `ROCK_SHAPE`), and the rocks you can bump into follow the rover, not the camera. "A rock is in the way" shows only when a rock really holds the rover.
- **Free camera while driving.** Behind the rover you can look anywhere, also up: the camera sits on a boom that shortens when a crest is in the way. The view is only eased back behind the rover after 5 s without a touch, and a glide between views never passes through a hill.
- **You always see the rover (15 Nov).** Arriving, the view turns to the rover and tips down to it, so it stands in the middle of the picture; it used to open level, with the rover at the bottom edge behind the buttons, and out of the picture where the ground fell away (`faceRover` in `app/src/moon/lander.ts`; it is parked 8 m away instead of 6, and a place in plain sight is looked for all round the landing spot). Driving down a steep hill, the camera now swings up over the rover and looks down along its boom instead of being pulled in until the rover filled the picture (`armTilt` in `chaseEye`): on a 35° wall of Shackleton the camera keeps its full 5 m and the rover stays in the middle. A view you tipped yourself with the mouse is left alone.
- **No track standing upright behind the rover (15 Nov).** On a slow connection the rover is set down again when finer ground arrives, straight up or down by a metre or more. That used to count as driving, so a new piece of track was laid and joined to the old one: two strips of track standing on end behind the parked rover. Only travel along the ground lays track now, and the old prints follow the ground at once (`step` in `app/src/moon/wheelTracks.ts`).
- **Round minimap** (top right in Land here, `app/src/explore/Minimap.tsx`, `MapEngine.ts`): the real NASA photo of the ground under the rover, turning with the camera, with the rover's arrow, its trail and the pins. Scroll over it (or use its + and − buttons) to zoom smoothly from about 60 m to 300 km across.
- **The big map** (click the round map, or press **M**; `app/src/explore/SurfaceMap.tsx`): a large map in the middle of the window over a blurred page. Drag to move, scroll to zoom fast and smoothly, all the way out to a flat map of the whole Moon and all the way in to the sharpest photo. When real sunlight is on it shows day and night for the time on the time bar. The 3D view is held still while the map is open, so the map runs at full frame rate. Since 15 Nov: it carries the **official place names** (bigger and more important features first, seas in spaced capitals, never one name over another or under a button; `drawNames` in `MapEngine.ts`); it **repeats sideways**, so you can keep scrolling right round the Moon, and farthest out the Moon fills the card from pole to pole; and a **Layers** button beside the place name opens the very same Layers box as on the overview (`ui/LayersPanel.tsx`), with its colour keys and strength sliders, in place of the row of small buttons. Its **Craters** switch now draws the measured rims here too (the switch was there before but drew nothing; `drawCraters` in `MapEngine.ts`, the 400 biggest that look at least 9 pixels across). What you switch on down here belongs to this visit: it starts from the overview's switches and no longer follows you back up (Water ice turned on in the map used to leave its colour key on the overview).
- **A route by tapping the map.** Click anywhere on the big map: a flag drops there and the route is worked out at once; click somewhere else or drag the flag to change it. On the overview the **route card** beside the place panel shows the distance, the driving time and the steepest slope in large figures, the four kinds of route as buttons with their own small pictures (**Fastest**, Gentle, Sunlit, Earth link) and one line about the kind that is chosen (`app/src/ui/RouteCard.tsx`). In the big map the same route is a **bar along the bottom** (`app/src/explore/RoutePanel.tsx`): the figures on the left, the four kinds in the middle (the chosen one is the white one; a kind chosen before there is a destination is kept), and on the right an arrow for the climb, descent, sunlight and Earth view, and a cross to clear it. The route also shows on the round map and as a guide ahead of the rover.
- **A route on the Moon itself.** On the overview (globe or flat 2D view), select a spot, press the route button in the column of map buttons, then click where you want to go: the route is drawn lying on the ground, and the same route card appears beside the place panel. **Land here** then carries it onto the surface as your destination (`app/src/ui/RouteTool.tsx`).
- **The flat 2D view** picks exactly the point you click, zooms faster, and now uses the sharp photos down to about 5 km across.
- **A route the rover can follow** (`app/src/science/route.ts`, `routeFine.ts`, `routeCraters.ts`, `routeRocks.ts`, `routeSpeed.ts`): "Fastest" is the least driving time, with speeds taken from the rover's own physics (2.0 m/s on the flat, 1.6 up 10°, 2.4 down 10°; ground over 25° is closed). The first 600 m from the rover and the last 150 m are planned on a 2 m grid over the exact ground the rover drives on, so the line goes round the small crater bowls and the rocks it cannot climb; further out it follows NASA's heights and goes round the rims of catalogued craters the heights are too coarse to show. Check it with `node app/scripts/check-route.ts`. It is still a prediction: the middle of a long route knows only what the orbital data shows.
- **Waypoints over the view.** The landing spot, the destination and the Compare pins are drawn over the 3D view, through any hill, with their distance, and marked on the compass tape.
- **Reset rover** (the round arrow in the Drive bar): back to where it first stood. Nothing is saved when you leave the surface, and nothing asks.
- **A sharper Moon** (`app/src/moon/imagery.ts`, `imageryWorker.ts`): with internet the photo now sharpens to JAXA's Kaguya Terrain Camera mosaic (7.4 m per pixel) over the whole Moon, to LROC NAC photos (about 0.5 to 2 m) round the Apollo sites, Tycho and the recent landings, and to the 1 m NAC mosaic north of 84° N. The south pole keeps its stored 1.2 m photos. Without internet the stored photos are used as before. Exact layers, services and terms: `app/public/data/CREDITS-imagery.md`.
- **Layers box**: PSR, Water ice, Danger zones, Slope, Craters, Height colours, then names and markers. Stars, the Milky Way and 3D mountains are always on. Every map is downloaded on the start screen and paints within about a tenth of a second of its switch.
  - **PSR** (permanently shadowed regions, as NASA calls them): both poles, from NASA's LOLA maps, filled blue.
  - **Water ice**, three honest parts under one switch: where ice could last (predicted from temperature and shadow, both poles), hydrogen seen from orbit over the whole Moon (a sign of water, not proven ice), and a marker per crater: white ring = water measured there (LCROSS in Cabeus, the only direct measurement), cyan ring = signs seen from orbit, dashed ring = predicted only. Each marker lists its evidence with the paper.
  - **Slope** and **Danger zones**: the whole Moon from NASA's LOLA heights (yellow 10–15°, orange 15–25°, red over 25°), with the sharp 80 m map near the south pole.
  - **Craters**: outlines of all 1.3 million measured craters of 1 km and more (Robbins 2019), drawn as true circles on the Moon, more as you zoom in (`app/src/moon/craterLayer.ts`).
  - Sources, products and limits: `data-prep/layers/NOTES.md` and `app/public/data/CREDITS-layers.md`.
- **Landing sites.** 76 places with a source each: every landing, rover, sample return and impact, two that may still be working (Chang'e-3, Chang'e-4), and 11 planned landings (dashed ring). Any of them can be pinned, compared and landed on. Researched 14 Nov 2026: `data-prep/sites/NOTES.md`.
- **Tooltips** on every button, kept to one short sentence, and a short "half real" note in Land here.
- **Loading.** The new maps and the crater list are fetched on the start screen with the other layers, so a switch shows its map at once.
- **Colour keys can be closed.** Each key on the overview has a small cross that switches its own map off: the key is often the only sign that a map is on at all (PSR and Water ice have nothing to show away from the poles).
- **A crash fixed.** With many layers on, the surface view could stop with "texture image units count exceeds MAX_TEXTURE_IMAGE_UNITS(16)": Cesium did not count the ground shader's own eight textures. The map now leaves room for them (`MoonMap.tsx`, `GROUND_SHADER_TEXTURES`).

**New data and its sources** (built by `data-prep/features/scripts/`, notes in `data-prep/features/NOTES.md`):

| What | Source |
| --- | --- |
| Crater outlines | Robbins (2019), *A New Global Database of Lunar Impact Craters >1–2 km*, JGR Planets 124, doi:10.1029/2018JE005592 · USGS Astrogeology / NASA PDS. Small south-polar craters: Marco Figuera et al. (CC BY 4.0) |
| PSR (permanently shadowed regions) | NASA LOLA [polar illumination archive](https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/extras/illumination/), both poles out to 65° (240 m; north 120 m above 80° and 60 m above 85°). South retains `LPSR_80S_20MPP_ADJ`, Barker et al. (2023), doi:10.3847/PSJ/acf3e1. See the [LROC atlases](https://lroc.im-ldi.com/atlases). |
| Water ice, predicted | [LRO Diviner Polar Resource Product](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_prp/), thermal models with LOLA shadow maps; predictions are distinct from detections. [LRO science and data](https://science.nasa.gov/mission/lro/science-and-data/) |
| Water ice, evidence | LCROSS direct measurement at one spot in Cabeus; M3 south-polar surface-ice signs; north-polar Mini-SAR/Mini-RF radar candidates, which can also be rough ground. Global [Lunar Prospector hydrogen estimates](https://pds-geosciences.wustl.edu/missions/lunarp/reduced/hydrogenhd.dat) are orbital hydrogen, not proven ice. Citations and limits: `app/public/data/CREDITS-layers.md`; [LPI Lunar South Pole Atlas](https://www.lpi.usra.edu/lunar/lunar-south-pole-atlas/) |
| Slope and danger zones | Global [NASA LOLA LDEM_64](https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_64.img) heights, local 3 × 3 slope stencil about 1.42 km across, displayed at 8192 × 4096. South keeps the 80 m DEM / about 240 m stencil. Danger classes also mark catalogued small crater bowls. |
| Landing and impact sites | LROC list of human-made objects (NASA/GSFC/Arizona State University), NASA NSSDCA, ISRO, JAXA, CNSA and the lander companies' pages |
| Reference | [NASA / ASU LROC QuickMap](https://quickmap.im-ldi.com/) (NASA, Intuitive Machines & Applied Coherent Technology) |

**Said out loud:** a permanently shadowed region is a cold trap, not confirmed ice; only the LCROSS marker is a direct measurement. Hazards smaller than about 80 m are not on any of these maps. The rover's rocks, soil and driving are an artist's impression. "May still be working" means the last word from the makers, not a confirmed status today.

## What changed on 13–14 Nov 2026 (v6)

- **New look**: Google Sans Flex type, calm panels without boxes inside boxes, one toolbar at the top right, big numbers in the info panel, and the Sun and Earth shown as real NASA photos everywhere (`app/public/ui/`, made by `data-prep/ui_glyphs.py`).
- **Start screen**: loads everything first (Moon photo, mountains, sky, calculator, south-pole views, the Land here view, music), then "Enter". Two graphics modes: **Full detail** and **Smooth** (`app/src/app/quality.ts`). Add `?start` to the address to keep the start screen up in test runs.
- **Arrival date**: type it ("2008-07-01 14:30", "1 Jul 2008", "2040", "now", "+3d") or pick month and year directly (`app/src/ui/DateTimePicker.tsx`, years 1900–2100).
- **Moving the Moon**: it keeps turning after a flick and slows down smoothly, like Google Earth (`app/src/moon/navigation.ts`, constants at the top).
- **Land here**: compass tape with degrees, Neil Armstrong's Apollo 11 gloves as first-person hands (Smithsonian 3D scans, CC0), low-gravity walking and hopping, a helmet lamp and real stars at night, Sun/Earth tags that sit on the skyline when the body is below it. The dotted skyline is off by default.
- **MOONDA AI**: a saved chat can no longer show a fake endless "Working…"; there is a Stop button, a stall cut-off and a "Run again" for interrupted runs.
- **Compare**: one table, four plans visible at once.
- **Khmer**: the "ខ្មែរ / English" switch in the top bar and on the start screen (`app/src/i18n/`, English in `en/`, Khmer in `km/`; a missing Khmer line falls back to English).
- **Music**: "Cylinder Five" by Chris Zabriskie (CC BY 4.0, see `app/public/audio/CREDITS.md`); the speaker button turns it off.
- **Start-screen film (replaced 15 Nov)**: the film behind the loading list is now cut from six NASA visualisations, all public domain: Earth at night, Earthrise over the Moon, a crescent Moon, sunrise over Orientale, a month of Moon phases and the far side (NASA's Scientific Visualization Studio and NASA's Goddard Space Flight Center; every source with its link in `app/public/intro/CREDITS.md`, built by `data-prep/intro/make-intro.sh`). It replaces a montage from YouTube whose licence was unknown, and is a third of the size (1.2 MB instead of 3.6 MB). Silent; credited in the app under "?" with the other sources.
- **Later on 13 Nov (from the team's own mockup)**: the boxed time bar became a borderless bottom row (menus left, ruler timeline centre, big "Projecting time" clock right); the map buttons are a column at the right edge; the info panel is one small table; the date picker is slimmer; the fling after a drag is capped lower.
- **MOONDA the robot** replaced the gloves in Land here:
  - NASA's Perseverance model (public domain) at half size. Its size is one number: `ROBOT_SCALE` in `app/src/moon/walk.ts`.
  - Six wheels that spin and sit on springs, so it rocks, dips and bounces over bumps in the low Moon gravity; it bumps into rocks instead of driving through them.
  - A solar panel that turns to follow the Sun (and folds flat at night), dust thrown up by the wheels, headlights at night.
  - Wheel tracks: two darker lines of pressed soil behind it, with tread marks up close, kept for a few hundred metres (`app/src/moon/wheelTracks.ts`).
  - Real Sun shadows for the robot and the rocks near it (shadow settings: `SUN_SHADOW` in `app/src/moon/sunShadow.ts`).
  - Its own sounds (`app/src/audio/rover.ts`) and a camera head that looks where you look.
  - Keys: W A S D drive, Shift fast, V camera (Lander / Behind / Mast), L lights.
- **Flat 2D map**: press **M** (or the 2D button) and the globe unrolls into a flat map; press again and it rolls back up. With "reduce motion" switched on in the computer's settings it simply fades instead. The flat map is drawn from the photo stored with the app (1.3 km per pixel; sharper polar photos between about 56° and 76°), so its closest zoom is about 250 km across. Zoom in again at that point and a small note offers "Go closer on the globe", which rolls the map back up at that place (`app/src/moon/flatMap.ts`, `mapMode.ts`).
- **Looking far in Land here** (evening of 13 Nov): the ground shading costs about a third less, so turning and driving hold 60 frames per second on a Retina laptop (Full detail draws Land here at up to 3.9 million pixels; a small governor in `app/src/moon/groundLod.ts` sheds fine detail only while the view moves and the graphics card is behind). Distant ground keeps small dark and bright strokes instead of going smooth (`groundFar.ts`), far stones are no longer drawn black and now cast shadows, and wheel dust is the colour of the ground and dark inside the robot's own shadow.
- **"Data detail" layer**: colours the map by how sharp the NASA data is in each part (south pole sharpest, the rest about 2 km heights and 100 m photos, one region rebuilt from a NASA brightness map). Nothing on the map is guessed or made up by AI; only the small rocks and soil near you in Land here are an artist's impression.
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
| **Land here** (in the info panel) | Land on the Moon next to MOONDA the robot: drag to look around, scroll to zoom the lens, Esc or **Back to map** to leave |
| In Land here: `W` `A` `S` `D` · `Shift` · `V` · `L` | Drive · drive fast · camera (Lander / Behind / Mast) · lights on/off |

## What's on screen

| Part | What it does |
| --- | --- |
| 3D Moon | CesiumJS globe with real 3D mountains from NASA LOLA heights (80 m near the south pole, ~1.9 km elsewhere), lit by the Sun where it really is at the time on the time bar. The night side stays dim but readable. |
| Sky | The real sky around the Moon: the Milky Way, about 8,900 stars, the planets, a 3D Earth with its true phase and the side that really faces the Moon, and the Sun. All move when the time changes. |
| Info panel (left) | Click anything (or anywhere). Same layout for every kind of place: what it is, its coordinates and source, **Land here / Compare / Zoom in**, the mission timeline (sunlight and Earth signal, one bar per day), a summary (% sunlight, longest dark, % Earth view, longest without Earth), then lander height and NASA map values under the spot. |
| Lander view | Land on the real terrain at any spot: NASA's photo of that place on the ground, lit by the real Sun with real hill shadows, level horizon, the Sun and Earth in their true places, a compass strip, and plain-word status. The dotted line is the skyline our numbers use. Press play to watch the Sun move. |
| Compare (right drawer) | Any number of plans (spot + arrival). Set battery life and the longest time without Earth with the rulers (they grow past 7 days), or type the days in their boxes. Defaults are 3 days on battery and 1 day without Earth; clearing a box skips that check. Each plan shows its longest dark and longest time without Earth against those limits, and a Best tag when one plan is better. "Compare another landing date" adds the same spot landing on any date you pick. |
| Time bar | One row: play, date (UTC + Cambodia time), the Sun/Earth track, then menus for arrival, mission length and speed, and **Now**. |
| Layers | Thirteen switches in three groups: South Pole maps (sunlight, Earth in view, PSR, water ice, danger zones ...), Whole Moon (craters, height colours ...), Names and markers (place names, Artemis regions, landing sites). |
| Search | 9,087 official IAU names + NASA's 9 Artemis regions + past landings + famous spots. |
| Names on the map | Google-Earth-style: only names big enough for the current zoom, most important first, never overlapping, fading in and out. |

Compare keeps these limits in `moonda.compare.needs.v2` as `{ batteryH, contactH }` (stored in hours although the rulers show days, or `null`
to skip a check). On first read it migrates the preset indexes in the old `moonda.compare.needs` value.

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
| Sharper photos (with internet) | JAXA Kaguya Terrain Camera evening mosaic, 7.4 m per pixel (ISAS/JAXA/SELENE), LROC NAC mosaics near landing sites and the LROC NAC north-pole controlled mosaic, 1 m per pixel (NASA/GSFC/Arizona State University), streamed from [Lunar QuickMap](https://quickmap.im-ldi.com/) (NASA, Intuitive Machines & Applied Coherent Technology Corp.) with NASA Moon Trek as fallback. Layers, measured resolutions and terms: `app/public/data/CREDITS-imagery.md` |
| South-pole photos | LROC WAC South Pole Summer Mosaic and LROC NAC south-pole controlled mosaic via ASU Lunaserv (QuickMap's server); stored locally by `data-prep/polar_tiles.py` |
| Sky | NASA SVS Deep Star Maps 2020, HYG star database, NASA Blue Marble / Black Marble (Earth) — see `app/public/space/CREDITS.md` |
| Heights | NASA LRO LOLA `LDEM_80S_80M` (PDS Geosciences) — `data-prep/dem.py` |
| Sunlight and Earth view (planner and spot values) | LOLA illumination products (Mazarico et al. 2011, Icarus 211). Their south-pole grids are retained; these have no switch in Layers. `data-prep/layers/` |
| PSR, water ice, slope and danger zones | NASA LOLA, Diviner, Lunar Prospector, LCROSS and Chandrayaan-1 sources with coverage and limits in `app/public/data/CREDITS-layers.md`; rerunnable scripts in `data-prep/layers/NOTES.md`. Predictions, orbital signs and direct measurements have separate keys. |
| Temperature | LRO Diviner Polar Resource Product (Paige et al. 2010, Science 330) — `data-prep/layers/` |
| Names | IAU Gazetteer of Planetary Nomenclature (USGS) — `data-prep/names.py` |
| Artemis regions | NASA, Oct 2024 update (approximate markers) |
| Sun/Earth positions | Astronomy Engine (MIT licence), checked against JPL Horizons |
| 3D engine | CesiumJS (Apache 2.0) |
| Start-screen film | Six NASA visualisations, public domain: Black Marble 2016 (NASA's Goddard Space Flight Center), Earthrise in 4K, Moonlight (Clair de Lune) and Moon Phase and Libration 2026 (NASA's Scientific Visualization Studio). Links and what was changed: `app/public/intro/CREDITS.md` |

Not an official NASA product. NASA data is public; credit the sources above.

MOONDA's own code is under the MIT licence (`LICENSE`). Third-party data, models, fonts and music keep their own terms.

## Folders

- `app/` — the website (React + TypeScript + CesiumJS). Science code is in `app/src/science/`.
- `data-prep/` — scripts that turned NASA downloads into app files (rerunnable).
- `data-raw/` — original downloads (not needed to run the app).
- `app/public/data/` — the Moon photo, height map and 4,224 south-pole squares the app loads (about 590 MB). Kept out of git because of its size: `data-prep/` rebuilds it, and the built site on Netlify already has it.
- `docs/V4-SPEC.md` — what the first big redesign set out to do.

## Deploying

`cd app && npm run build`, test `app/dist` on the preview server, then
`npx netlify-cli deploy --no-build --dir dist --functions netlify/functions --prod --site <site id>`.
Without `--no-build` the tool builds again before it uploads, so what goes live is whatever the source files
hold at that moment, not what was tested. Afterwards check that the live page loads the same
`assets/index-….js` as `app/dist/assets`.

## Testing like a user

`app/scripts/drive.mjs` drives the page in a hidden Chrome on the real graphics card: it clicks, drags, scrolls,
takes screenshots and measures frame rates. Example (with `npm run dev` running):

```bash
cd app && node scripts/drive.mjs '[{"do":"ready"},{"do":"click","text":"South Pole"},{"do":"wait","ms":3000},{"do":"shot","name":"pole"}]' --out /tmp/moonda-shots
```

A second dev server that never reloads an open page when a file changes (so a timed test is not destroyed by
somebody else's edit) is `app/vite.steady.config.ts`, port 5194, launch configuration "moonda-steady".

Maths checks: `node scripts/check-frame.ts`, `check-ephemeris.ts`, `check-sky.ts`, `check-imagery.ts`,
`check-terrain.ts`, and `check-horizon.ts` (needs the dev server).

## Built with AI help

Claude and Codex, 13–14 Nov 2026. Disclose this wherever the rules ask.
