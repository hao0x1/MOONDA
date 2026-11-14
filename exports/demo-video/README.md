# MOONDA demo film

A ~3-minute pitch film for MOONDA (NASA Space Apps 2026, Lunar Landing Site Navigator), built with GSAP and real footage of the app.

## Where the finished video is

- `~/Desktop/MOONDA-demo-film.mp4`: 1920×1080, 60 fps, with sound (play this one at the pitch).
- `~/Desktop/MOONDA-demo-film-silent.mp4`: the same film without sound, if you want to talk over it.
- `~/Desktop/MOONDA-demo-film-720p-share.mp4`: a small copy (52 MB) for sending to the team on Telegram/Messenger.

They are on the Desktop because the CodexWork drive is almost full (about 1 GB free).

## What is in it (chapters)

| Time | Scene |
|---|---|
| 0:00 | Cold open: warp through the stars, "The Moon's south pole…", the Moon's edge rises |
| 0:10 | The problem: the Sun skims the horizon; a hill blocks the Sun (no power), a crater rim hides Earth (no radio) |
| 0:26 | Same spot, two landing days (illustration): plan B runs out of power |
| 0:33 | Logo: dots gather into a printed Moon, then "MOONDA — Lunar Landing Site Navigator" |
| 0:40 | "Pick a spot. Pick a day." The app rises from the Moon (real recording: drag, fling, fly to the south pole) |
| 0:53 | 01 Find: search Malapert, the card shows sunlight / Earth numbers |
| 1:04 | 02 Time: 14 days of real sunlight sweeping across the south pole |
| 1:15 | 03 Stand: on the ground at Malapert, the Sun low in the east, turn to Earth |
| 1:30 | 04 Drive: MOONDA the robot, tracks and dust |
| 1:41 | 05 Compare: Connecting Ridge loses Earth for 44 h; 3 days later is worse; Malapert works |
| 1:58 | 06 Ask: MOONDA AI answers a plain question with a table |
| 2:13 | Globe ↔ flat map, English ↔ Khmer |
| 2:20 | How it works: five NASA data layers fan out in 3D |
| 2:30 | The skyline in 720 directions, the Sun's path, blocked or not (example spot) |
| 2:41 | Checked against places we know (Shackleton floor 0% sun, Connecting Ridge ≈80%, Malapert 100% Earth, Chang'e-4 0% Earth) |
| 2:47 | Numbers: 9,087 names, 4,224 polar photo tiles, 8,900 stars, works offline |
| 2:54 | Team MOONDA, six names and roles |
| 3:02 | End card: "MOONDA — Know before you land." + site address, credits |

Total length 3:12.

## How it was made

- `tools/capture.mjs` records the real app (production build on http://127.0.0.1:5191) in headless Chrome on the GPU. The page's clock is frozen and stepped exactly 1/60 s per frame (`tools/vt-harness.js`), so every app clip is perfectly smooth. Shot scripts are in `tools/shots/`.
- `film/` is the film itself: `engine.js` (WebGL Moon with the NASA texture, warp stars, halftone-dot logo, grain, frame-exact video seeking) and `scenes.js` (the GSAP timeline: SplitText blur-ins, DrawSVG drawings, ScrambleText, CustomEase).
- `tools/render.mjs` steps the GSAP timeline frame by frame and pipes the frames into ffmpeg. `--stills 12.5,40` renders single frames for checking.
- `tools/sfx.mjs` synthesizes all sound effects (warp, risers, impacts, whooshes, ticks) from the cue points in the timeline; `tools/mix.sh` mixes them with the music and loudness-normalizes.

The recorded app clips are kept in `~/Movies/MOONDA-demo-footage/` (`film/footage` points there).

Re-render (about 12 min): `DEMO_WORK=<any folder on the internal disk> tools/build-final.sh`, or step by step: `node tools/render.mjs --out <silent.mp4>`, then `node tools/render.mjs --cues cues.json`, `node tools/sfx.mjs cues.json sfx.wav`, `tools/mix.sh <silent.mp4> sfx.wav <final.mp4>`. Heavy files go to the scratchpad folder set in `WORK` / `DEMO_WORK`.

## Credits shown in the film

Data: NASA LRO (LOLA, LROC, Diviner), IAU/USGS names, JPL. Music: "Cylinder Five" by Chris Zabriskie (CC BY 4.0). The A/B power chart is an illustration (the team's teaching example), labelled as such; everything else on screen is real app output.
