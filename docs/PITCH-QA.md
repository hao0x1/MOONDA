# MOONDA — pitch Q&A cheat sheet

## The 10-second pitch
Google Earth for the Moon → drop a pin near the south pole → MOONDA tells you **when a lander there gets sunlight** (power) and **when it can see Earth** (radio), from real NASA terrain + real Sun/Earth positions → compare up to 4 spots → land and drive a rover there.

Challenge: NASA Space Apps 2026, **Lunar Landing Site Navigator**.

---

## 1. How the AI works (the question you WILL get)

```
user types a question ("best sunny spot near Shackleton for 14 days?")
  → browser (agent.ts) bundles: system prompt + chat history + tool list + what's on screen
  → POST /api/ai  (our own server: Netlify Function online, Vite server locally)
  → server adds the secret API key (key never reaches the browser)
  → LLM (DeepSeek, OpenAI-style chat API, streamed)
  → model "thinks" and says: call tool analyse_spot(lat, lon)
  → BROWSER runs that tool with OUR science code (skyline + Sun/Earth maths)
  → real numbers go back to the model
  → loop (max 10 rounds) until the model stops asking for tools
  → final answer streamed in, app adds a results table + flies the map to the pick
```

Key lines to say:
- **"It's an agent loop with tool calling, not a chatbot guessing."** The LLM only decides *what to check* and *how to explain it*. Every number comes from our own code.
- System prompt rule: **"NEVER state a number that did not come from a tool result."** → that's how we limit hallucination.
- 7 tools: `get_mission_settings`, `list_candidate_sites`, `search_moon_names`, `scan_area` (quick ring of points), `analyse_spot` (full calc), `show_on_map`, `add_to_compare`.
- Typical flow: scan_area for a rough look → analyse_spot to confirm the best 1–3 → show_on_map.
- You can watch it: the panel shows the thinking, each tool call and its result (AiTrace).
- Safety rails: Stop button, 45 s silence cut-off, per-tool time limits, 6 min cap per answer, server returns only short error codes.
- Answers in Khmer too (system prompt switches language).

**Q: Why DeepSeek / which model?** → cheap, strong reasoning model, OpenAI-compatible API, so it's one env variable to swap (`DEEPSEEK_MODEL` / base URL). The model is replaceable; the value is the tools.

**Q: Did you train a model?** → No. No training, no fine-tuning. Prompt + tool calling over our own physics. Be honest here.

**Q: What if the AI is wrong?** → It can be wrong in *choice or wording*, not in the numbers: numbers come from tools, and the user can click any spot and see the same calculation in the info panel.

---

## 2. How the "prediction" works (sunlight + Earth)

It's **geometry, not ML.** Say that proudly.

```
pick a spot (lat, lon) + panel height
  → read NASA LOLA laser-altimeter heights (80 m/pixel near pole, 240 m out to ~300 km)
  → walk outward in 720 directions (every 0.5°) along the curved Moon
  → keep the steepest hill angle per direction = the SKYLINE
  → Astronomy Engine gives Sun + Earth positions for every step of the mission
  → rotate into the Moon's frame (IAU rotation model) → local sky of the spot
  → Sun lower than skyline in that direction? → blocked by a hill → dark
  → same for Earth → no radio line
  → output: % sunlight, longest dark, % Earth in view, longest without Earth
```

- Runs in a **Web Worker** (background thread) so the 3D map never stutters. ~15 ms per skyline.
- **Validated:** Sun/Earth directions vs NASA/JPL Horizons → worst error **0.0014°**. Known places check out: Shackleton floor 0% sun (permanent shadow ✓), Connecting Ridge ~80% (published 80–90% ✓), Chang'e-4 far side 0% Earth ✓.
- Why the south pole: Sun sits on the horizon → tiny height differences decide light vs dark → water ice in permanent shadows → Artemis goes there.

**Q: Is it a forecast?** → It's exact orbital geometry, so it's as predictable as an eclipse. What it can't see: things smaller than ~80 m (rocks, small bumps).

**Q: "Earth in view" = working radio?** → No, it's line of sight only. Needed, not sufficient. (We say this in the app.)

---

## 3. Rover route ("predict a bit" part 2)

```
click a destination on the big map
  → A* search on a grid, cost = DRIVING TIME (not distance)
  → speed from rover physics: 2.0 m/s flat, 1.6 up 10°, 2.4 down 10°, >25° = closed
  → near rover (first 600 m) + last 150 m: fine 2 m grid, dodges small craters and rocks
  → far middle: NASA heights + crater catalogue rims
  → modes: Fastest / Gentle / Sunlit / Earth link
```
Honest line: "the middle of a long route only knows what orbit can see, so it's a prediction."

---

## 4. How we built the site

```
NASA raw data (LOLA heights, LROC photos, Diviner temps, IAU names)
  → data-prep/ Python scripts → compact files in app/public/data (~590 MB, 4,224 south-pole photo tiles)
  → React + TypeScript app, Vite build
  → CesiumJS draws the 3D globe (Moon instead of Earth), custom terrain from LOLA
  → science in plain TS (no React) → runs in a Web Worker + Node check scripts
  → deployed static to Netlify + 1 serverless function (/api/ai) for the LLM key
```
- Works **offline** for the whole Moon + south pole; with internet it streams sharper photos (JAXA Kaguya 7.4 m, LROC NAC ~0.5–2 m).
- Real sky: ~8,900 stars, planets, Earth with its true phase.
- Search: 9,087 official IAU names + 9 Artemis regions + 76 landing sites.
- Layers: PSR (permanent shadow), water ice (predicted vs measured, kept separate), danger slopes, 113,000 craters.
- English + Khmer.
- Testing: `drive.mjs` drives a real Chrome (clicks, screenshots, FPS) + maths check scripts.

**Q: Did you use AI to code it?** → Yes, Claude and Codex helped, disclosed in the README. We designed it, chose the data, checked the science against NASA/JPL.

---

## 4b. 0 → 1: how NASA data got into the site (in commit order)

```
1. Research (13 Nov)  read the challenge brief → wrote a spec (docs/V4-SPEC.md) + list of data we need
2. Download           raw NASA files from PDS Geosciences, LROC, Lunaserv, NASA SVS → data-raw/ (not shipped)
3. Convert            Python scripts in data-prep/ (numpy + rasterio) turn huge science files
                      into small browser files → app/public/data/
4. Scaffold (14 Nov)  Vite + React + TypeScript + CesiumJS globe, English/Khmer strings
5. Wire up            app loads those files: heights → 3D terrain + skyline maths,
                      photos → globe imagery, layers → map overlays, names → search
6. Check              scripts compare our numbers to NASA/JPL + known places
7. Ship               npm run build → Netlify (static files + 1 function for the AI)
```

Example, heights (`data-prep/dem.py`):
```
LOLA LDEM_80S_80M.JP2 (PDS, 80 m/pixel, heights stored as number × 0.5 m)
  → read with rasterio → convert to metres
  → cut into 256×256 tiles of raw Int16 (t80/col_row.bin) + a 240 m overview (polar240.bin)
  → dem.json describes the grid (polar stereographic, pole at 0,0)
  → browser fetches only the tiles it needs → skyline + 3D mountains
```

Same pattern for everything else:
| Data | Script | Becomes |
|---|---|---|
| LROC / Moon Trek photos | `base_mosaic.py`, `polar_tiles.py` | whole-Moon photo + 4,224 south-pole tiles |
| IAU names | `names.py` | 9,087 searchable names |
| LOLA illumination, Diviner temps, PSR, ice | `data-prep/layers/` | sunlight / Earth / PSR / ice / slope map layers |
| Robbins crater catalogue | `data-prep/features/` | 113,000 crater outlines |
| Star maps, Blue Marble | `data-prep/space/` | the sky and Earth |

Why convert instead of calling NASA live? → the raw files are GBs in science formats (JP2, IMG, GeoTIFF); browsers need small, simple binary tiles. That's also why the site works offline. Sharper photos are the one thing streamed live (QuickMap / Moon Trek tile servers).

**How to describe the AI's role:** "We designed what to build and picked the NASA datasets; Claude and Codex helped write the conversion scripts and the app; we checked the results against NASA/JPL."

## 5. Likely tough questions → short answers

| They ask | You say |
|---|---|
| What's real vs fake? | Terrain, photos, Sun/Earth, maps = real NASA data. Small rocks, soil and rover driving near you = artist's impression. |
| Is that ice for sure? | No. PSR = cold trap, not proof. Only the LCROSS marker (Cabeus) is a direct measurement. |
| Who is this for? | Mission planners, students, the public: lets anyone ask "where and when should we land?" in a browser. |
| What's new vs NASA QuickMap? | QuickMap shows layers. We answer a *question*: this spot, this date, this mission length → will it survive? Plus compare + AI. |
| Accuracy limits? | 80 m height pixels, Sun's centre used (card also shows partial Sun), long-term maps are averages. |
| Scale / cost? | Static site + one tiny function. All heavy maths runs in the user's browser → near-zero server cost. |
| Next steps? | Sharper heights where available, battery/thermal model, real comms link budget, more poles/regions. |

## 6. If the demo breaks
- AI fails → "the AI is just a layer; the same numbers are in the info panel" → click a spot and show it.
- No internet → app still works offline from stored data.
