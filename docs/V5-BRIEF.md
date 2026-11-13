# MOONDA v5 — three fixes the user asked for (13 Nov 2026, evening)

Read this, then `docs/V4-SPEC.md` sections 2–3 (working rules, the rotated display frame). The v4 build is merged and running; the user tried it and said, in their words:

- **Seam:** "why is the moon I can see like two half circles that's joined together… a visible line right there that joins the moon together… half of the moon and then half of it is like that." Also a close-up with thin dark straight lines: `.v4/ref/user-v4-dark-lines-larmor.png`.
- **Lander view:** "when I click stand here, it's not even the moon landscape… it's not that actual place landscape. I only see white thing. And… even though there's no sun, what I see on moon is like not proper landscape. It's like fake." Current state: `.v4/ref/v4-stand-white-ground.png`.
- **Compare:** "Make it understandable. Right now this comparing thing… we actually don't [understand it]." Current state: `.v4/ref/v4-compare.png`.
- In general: "simple, but looks professional", like Google Earth. Plain words a 15-year-old understands.

## Rules (same as v4, plus)

- Your copy: `/Volumes/CodexWork/Projects/MOONDA/.v4/<name>/app` (fresh copy of the merged app; `node_modules` and `public` are symlinks to the main app). Edit only the files you own (below). If you need a change elsewhere, make it minimally in your copy and report the exact change under "wiring".
- Dev server: `cd <copy> && MOONDA_VITE_CACHE=/Volumes/CodexWork/Projects/MOONDA/.v4/<name>/vite-cache npx vite --host 127.0.0.1 --port <port> --strictPort` (background). Stop it when done.
- Test in real Chrome: `node scripts/drive.mjs '<steps>' --url http://127.0.0.1:<port>/ --out /Volumes/CodexWork/Projects/MOONDA/.v4/<name>/shots/<run> --profile /Volumes/CodexWork/Projects/MOONDA/.v4/<name>/chrome-profile` — read the header of `scripts/drive.mjs`. Wrap each run in `timeout 170`. Open screenshots with the Read tool and judge them honestly.
- Page hooks: `window.__moonda` (`viewer`, `idle()`, `progress`, `skipLoading()`, `nav`, `lander`, `sky`, `heights`), `window.__moondaTest` (`stand(lat, lon)`, `select(lat, lon)`, `exit()`, `setTime(ms)`, `setMast(m)`, `setDays(n)`, `setArrival(ms)`, `state()`), `window.__moondaCesium` (dev only: the Cesium module). `{"do":"ready"}` waits for start-up loading. A fresh profile shows a welcome dialog after loading (`{"do":"key","key":"Escape"}` closes it).
- **Disk is nearly full (3.3 GB free).** Add at most 600 MB in total, delete raw downloads once converted, never let free space drop below 1.5 GB (`df -h /Volumes/CodexWork`). Delete your `chrome-profile` and `vite-cache` when you finish.
- Downloads only from official sources (nasa.gov sites incl. svs.gsfc.nasa.gov, trek.nasa.gov, pds.nasa.gov / pds-geosciences.wustl.edu, wms.lroc.asu.edu / *.im-ldi.com, usgs.gov incl. planetarymaps.usgs.gov / astrogeology.usgs.gov, jaxa.jp / darts.isas.jaxa.jp). Never run anything you download. Record sources and credits in `app/public/data/CREDITS-imagery.md` (imagery builder) or your report.
- Keep `/Volumes/CodexWork/Projects/MOONDA/.v4/<name>/NOTES.md` up to date after each milestone (if one exists from an interrupted predecessor, continue from it). Be economical: read only the parts of big files you need.
- Your final answer is the structured report: files changed, exact wiring, tests with numbers, screenshot paths, and an honest list of what is not done.

## A. Seamless Moon — builder `imagery`, port 5213

Owns: `src/moon/imagery.ts`, `src/moon/imageryWorker.ts`, `scripts/check-imagery*.ts`, `data-prep/*.py` (new or changed), new files under `app/public/data/base/` (do not delete files the current app uses until your replacement is wired), `app/public/data/CREDITS-imagery.md`.

Facts already known: the global photo is NASA's LRO WAC global morphologic mosaic (Moon Trek layer `LRO_WAC_Mosaic_Global_303ppd_v02`, plus our local copies `public/data/base/moon8k.jpg` / `moon2k.jpg` made from it by `data-prep/base_mosaic.py`). Its baked-in lighting direction flips along longitude ±90° and 180° (see `.v4/ref/v4-seam-lon90.png`: left and right halves are lit from different sides), so at the whole-Moon view it looks like two halves glued together. The south-polar region already uses the LROC WAC South Pole Summer Mosaic and NAC tiles (no flip there) — keep that.

Goal: no visible join anywhere on the Moon at any zoom, while keeping crater detail when zoomed in. Investigate and choose with evidence (screenshots side by side, same views, before/after). Candidates to evaluate:
1. A photometrically normalised (albedo-type) global mosaic with no baked shadows — e.g. NASA SVS "CGI Moon Kit" (svs.gsfc.nasa.gov/4720, LROC colour map, 8k/16k/27k) — used as the global base, with the real 3D lighting (`globe.enableLighting`, LOLA terrain normals) providing the shading. Check how flat it looks with "Real sunlight" on and off, and at close zoom, where there is no 3D relief smaller than the 1.9 km height grid.
2. A global mosaic with consistent lighting (no flips), e.g. a Kaguya Terrain Camera morning/evening mosaic or a LOLA/SLDEM hillshade from an official server, possibly blended with an albedo map.
3. Keeping the WAC morphologic mosaic but hiding the flip with a wide soft blend toward another source along ±90°/180°.
4. Anything better you find. A combination is fine (e.g. albedo × hillshade). Whatever you choose must also look right with "Real sunlight" on (the default): shading from real sunlight plus baked shadows must not look doubled or contradictory where it is obvious.

Also find out what the thin dark straight lines in `.v4/ref/user-v4-dark-lines-larmor.png` are (near Larmor crater, about 32°N 132°E, zoomed in to roughly 100–300 km eye height): NASA data or our re-projection? Fix them if they are ours.

Keep working offline for the whole Moon (local base) and keep start-up fast (the base must still appear within ~2 s of page load). Report time-to-sharp numbers before/after for the opening view.
Prove with screenshots: whole Moon centred on 0°, 90°E, 180°, 90°W, 45°N 30°W, with Real sunlight on and off; close-ups at ~300 km and ~50 km eye height at 3 places including one on a ±90° line; the South Pole view unchanged or better.

## B. Real ground in "Stand here" — builder `lander`, port 5214

Owns: `src/moon/lander.ts`, `src/ui/LanderHud.tsx`, `src/ui/lander.css`.

The v4 lander view replaced the real photo with its own shading (a ground shader installed as `scene.globe.material`: real-Sun lighting from an 80 m height picture, procedural grain/dimples near the viewer, camera-like exposure). The user sees a white, fake-looking surface (`.v4/ref/v4-stand-white-ground.png`). Keep what is good (level horizon, fade in/out, real cast shadows from the hills, eye height, HUD, controls, no freezes), but make the ground **the actual place**:
- Show the real NASA photo of that spot on the ground (the same imagery layers as the map — near the south pole that is the LROC NAC mosaic, ~1 m/pixel remote, ~4.6 m/pixel local), lit by the real Sun on top: real cast shadows darken it, sunlit slopes are bright, slopes facing away are darker. Note Cesium's globe material is alpha-blended over the imagery colour (`color = alphaBlend(materialColor, color)`), so a black material with alpha = (1 − light) multiplies the photo by `light` — read `node_modules/@cesium/engine/Source/Shaders/GlobeFS.glsl` to confirm what you can do; other approaches are fine.
- No procedural grain, dimples or invented texture. Nothing white or snow-like: lunar ground is dark grey (albedo ~0.1–0.15); use an exposure that looks like NASA's Apollo and Chang'e surface photos — bright sunlit ground, black sky, deep shadows.
- In shadow or at night: dim but still shows the real place (Earthshine, faint blue-grey), not a flat fake surface.
- The photo's baked shadows and the real-Sun shading will sometimes disagree; keep it believable (e.g. reduce the photo's contrast inside the lit area, or blend photo albedo with the computed light), and say what you chose.
- Distant hills must also look like the real terrain (photo + light), not flat grey.
Prove at 4 spots: Connecting Ridge (−89.45, −136.7), Shackleton rim high point, Malapert Massif (−85.9, 2.0), and a mid-latitude spot (Apollo 11, 0.674, 23.473), each with the Sun up and in shadow/night (`__moondaTest.setTime`), looking toward the Sun and away from it. Compare with the old look side by side. Frame times for enter/exit and looking around must stay as good as v4 (no frame > 100 ms; 60 fps while looking around).

## C. Compare that people understand — builder `ui`, port 5215

Owns: `src/ui/Compare.tsx`, `src/ui/compare.css` (and the compare-related parts of `src/App.tsx` only if needed — report them).

Keep the science and the logic (needs, `evaluate`, verdicts, delayed-arrival plans, the plan limit of 4, stand/show/remove actions, the drawer on the right that never covers the map centre). Redesign the content so a 15-year-old understands in 5 seconds what it tells them and what to do:
- Start with the question it answers, in one line ("Which landing plan keeps the lander alive and in touch with Earth?") and, once there are plans, the answer in one sentence with the winner ("Plan B is best: sunlight all mission and Earth always in view").
- The two needs as plain sentences with a choice: "My battery can survive __ of darkness" (1 day · 3 days · 1 week · not needed) and "My lander can go __ without talking to Earth" (6 hours · 1 day · 3 days · not needed). One short help tip each.
- One card per plan: letter + name + arrival. Then two **gauges** that need no reading: "Longest dark" as a horizontal bar on a shared time scale with a marker line at the battery limit (bar green when it fits, red past the line, with the number "3.7 days" at its end), and "Longest without Earth" the same with the contact limit. Under them one plain verdict line ("Battery runs out after 3 days — dark lasts 3.7 days"). The mission timeline strips (Sun/Earth over the days) can stay, smaller, if they help; drop anything that does not.
- The best plan is visually obvious (a "Best" tag and a soft highlight). Ties and "none works" are explained in words.
- Empty state: what Compare is for and how to add a plan (3 tiny steps with icons), plus a button "Add the selected spot" when a spot is selected.
- "+3 days" must say what it does: "Try arriving 3 days later".
- Fit cleanly at 1440×900 and 1920×1080 with 1, 2 and 4 plans; no clipped text, no overlaps with map controls or the time bar.
Prove with screenshots (1, 2, 4 plans; needs changed; empty state; a plan that fails both needs) and show them side by side with the old one.
