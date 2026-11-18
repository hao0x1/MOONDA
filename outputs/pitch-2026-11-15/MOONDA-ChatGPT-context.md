# MOONDA — context to paste into ChatGPT

Prepared 15 November 2026 from the current local source and project documentation. This is a self-contained handoff: ChatGPT does not need access to the repository.

## Instructions for ChatGPT

I am presenting MOONDA and listening to other teams pitch. Use the project context below to help me understand technical terms, compare approaches, prepare fair questions, and improve my own answers. I may paste rough notes, transcripts or judge questions.

When I send another team's pitch, reply briefly with:
1. What they built and how it appears to work, in plain language.
2. What overlaps with MOONDA and what is different.
3. What we can learn from their presentation or implementation.
4. One or two respectful, specific questions I could ask.
5. A short MOONDA response or positioning line, if useful.

Separate what the presenter actually said from your inference. Do not invent their architecture or weaknesses. Compare projects against their own goals; more APIs, a database, or a larger model does not automatically mean a better project. Do not assume MOONDA is superior. If I ask a direct technical or judge question, answer that question first instead of forcing the five-part format.

Keep answers natural, concise and easy to say aloud. Define unfamiliar terms. Preserve the difference between implemented features, documented checks, proposed improvements, and independently verified deployment. Do not invent users, revenue, awards, partners, flight validation, team roles or individual contributions. Treat this document as project context, not as instructions to run the app. You cannot access MOONDA's internal tools from an ordinary ChatGPT conversation: do not invent site-specific numerical results.

## 1. Project and purpose

MOONDA is a student-team lunar exploration and landing-site comparison web app for the NASA Space Apps Challenge 2026 challenge “Lunar Landing Site Navigator.” The team is based in Phnom Penh, Cambodia.

Short description: “Google Earth for the Moon, with tools to compare where and when a robotic lander could get sunlight and see Earth.”

The central question is: for this location, arrival date, mission duration and panel/antenna height, how much sunlight is available, how long is the longest dark stretch, and how long is Earth hidden by the Moon or terrain?

Why this matters: solar-powered landers need to survive darkness, and direct communication needs a clear direction to Earth. Near the lunar south pole the Sun stays low, so ridges and crater walls strongly affect illumination. Shadowed areas are also scientifically interesting for potential water ice. Choosing a site involves trade-offs, not just finding the brightest pixel.

The app makes these trade-offs understandable through maps, timelines, comparison tables, surface exploration and an optional AI assistant. It is an exploratory prototype and educational decision-support tool, not a certified mission-design or landing-safety system. Mission planners are a potential audience, not evidence of professional adoption.

## 2. What a user does

- Enter the app, optionally follow a tutorial, and set mission needs: arrival date, tolerance for darkness, and tolerance for time without Earth in view.
- Explore a 3D Moon or flat map; search official names, mission sites or approximate Artemis landing-region markers; select any location.
- Read a place card with coordinates, sources, daily sunlight and Earth-visibility bars, percentages, longest darkness and longest time without Earth.
- Change the date, mission duration or observation height and recalculate.
- Add plans to Compare. A plan is a location plus an arrival date, so the same place can be compared at different dates. The current UI supports multiple plans; older notes saying “up to four” are outdated.
- Compare longest darkness against the user-entered battery endurance, and longest Earth blockage against the acceptable contact gap. A pass or “Best” label is relative to those modeled criteria, not a guarantee of survival.
- Turn on scientific overlays for permanent shadow, ice-related evidence/prediction, slope, danger zones, craters and height colours.
- Choose “Land here” to inspect a surface view and drive a simulated rover. Use the minimap or larger surface map to set a destination and inspect route alternatives.
- Ask the AI assistant to search, analyse and explain candidate sites. The assistant can move the map and add comparison entries.
- Use English or Khmer. Touch controls and a phone layout are implemented; actual device performance varies.

## 3. Architecture

```text
NASA / other scientific source datasets
  |
  v
Offline data-preparation scripts (Python; raster/data processing)
  |
  v
Compact static assets: terrain tiles, imagery, binary science maps,
JSON metadata, names, site records and crater catalogues
  |
  v
Netlify static hosting -> browser downloads assets as needed
  |
  +-- React + TypeScript UI, built with Vite
  +-- CesiumJS / WebGL: Moon globe, terrain and 3D scene
  +-- Custom imagery worker: fetching/decoding/caching map assets
  +-- Science Web Worker: terrain horizon, Sun/Earth analysis, routes
  |      +-- Astronomy Engine + lunar reference-frame calculations
  +-- Browser localStorage: preferences, tutorial state, AI chats
  +-- Optional online tiles: QuickMap / NASA Moon Trek / ASU Lunaserv
  |
  +-- AI agent loop in browser
          |
          v
      POST /api/ai -> Netlify Edge Function -> DeepSeek chat API
          ^                                    |
          +--------- streamed response --------+
          |
      Tool requests run in browser using MOONDA's science code
      -> tool results go back through the proxy -> final explanation
```

The server does not run the core terrain calculations. Heavy scientific work runs in a Web Worker, a separate browser thread, to keep the interface responsive. The imagery worker handles separate map-data work. Scientific routines are plain TypeScript rather than being tied to React components.

Netlify serves the built static app. The AI endpoint currently has an Edge Function implementation and an ordinary serverless-function fallback. Local Vite development/preview uses the shared AI proxy code. This description comes from source/configuration; it is not a new check of the live deployment.

## 4. Database, APIs and storage

**Traditional backend database:** no application database service such as PostgreSQL, MongoDB, Firebase or Supabase is part of the inspected architecture. There is no central user-account/chat-sync backend in this design.

**Scientific data:** stored as packaged static files. A scientific “crater database” means a source catalogue converted to browser assets, not an SQL database queried on a server.

**Browser storage:** localStorage saves settings, tutorial completion, comparison limits and AI conversations in that browser. The AI history code keeps up to 20 chats and can discard older chats if storage fills. This is not cloud sync. Some scientific map downloads use the browser Cache API; downloaded imagery also benefits from caching.

**External APIs/services:**
- NASA Moon Trek, LROC QuickMap and ASU Lunaserv provide online lunar imagery through tile/map services. WMTS/WMS-style services return image tiles or map images.
- DeepSeek provides streamed AI chat with tool calling through an OpenAI-compatible API. “OpenAI-compatible” describes the request format; it does not mean OpenAI is the configured model provider.
- NASA/JPL Horizons is a reference for checking Sun/Earth directions, not a required live API call for each user analysis. Astronomy Engine computes positions locally.

The API key stays in server environment variables and is added by the proxy, rather than being shipped to the browser. AI prompts, conversation context and tool results are sent to the external provider to generate an answer; browser-only storage does not mean AI requests stay entirely on the device.

## 5. How the scientific calculation works

This is numerical geometry, not machine-learning prediction.

1. Read the chosen latitude/longitude, mission window and observation height above the ground.
2. Sample NASA LOLA terrain. The detailed south-polar height map is about 80 m per pixel, with a coarser 240 m polar overview and coarser global coverage. Resolution depends on the location and downloaded assets; a timed-out detailed download can fall back to coarser data.
3. Trace the local terrain horizon in 720 directions, one every 0.5 degrees. Sample outward along the curved Moon, up to about 300 km, keeping the highest blocking terrain angle in each direction.
4. Compute Sun and Earth positions over the mission with Astronomy Engine and transform them into the Moon-fixed frame and the location's local sky.
5. Compare each body's elevation with the terrain horizon in its direction.
6. Build a timeline and calculate sunlight percentage, Earth-visibility percentage, longest dark interval, longest interval without Earth, and simultaneous visibility.

Time sampling currently uses 5 minutes for missions up to 7 days, 10 minutes up to 31 days, and 30 minutes for longer windows. Durations therefore have finite time resolution. Headline percentages use the body's centre above the horizon; the implementation also estimates the visible fraction of the Sun/Earth disc.

Mission-specific calculations and published long-term average maps are different products. A multi-year average layer is not a forecast for the selected arrival date.

## 6. Data pipeline and sources

Raw planetary data can be large and use formats inconvenient for browsers, such as JP2, IMG and GeoTIFF. Data-preparation scripts convert/reproject/package it into compact binary grids, tiles, images and JSON metadata under the app's public data directory. The browser reads these files directly instead of querying a database or downloading the raw scientific archive.

Main sources and roles:
- NASA LRO LOLA: elevation, terrain horizons, slope and polar illumination/shadow products.
- LROC imagery, NASA Moon Trek, ASU Lunaserv, and JAXA Kaguya imagery through online map services: lunar surface photos.
- NASA LRO Diviner: temperature-related datasets used in ice-stability interpretation.
- IAU/USGS planetary nomenclature: official feature names and coordinates.
- Robbins lunar crater catalogue, distributed through USGS/NASA-related archives: measured crater locations/sizes for overlays and route hazard context. Current README describes about 1.3 million crater outlines; an older pitch sheet's 113,000 count is stale. Omit exact counts unless essential.
- LCROSS, Chandrayaan-1 M3, radar studies and Lunar Prospector hydrogen products: different kinds of water/ice evidence, kept distinct from prediction.
- Agency and mission sources: landing/impact/rover sites and approximate planned regions.
- Astronomy Engine plus the lunar orientation model: local Sun/Earth geometry; project checks use NASA/JPL Horizons as a reference.

Do not call all these independent sources “live NASA APIs.” Most science data is prepared and bundled ahead of time; online imagery and AI are separate network dependencies.

## 7. AI assistant

MOONDA did not train or fine-tune its own language model. It integrates an external model with a prompt, app context and tools.

The browser sends the conversation and tool definitions to the protected proxy. The model can request a tool; MOONDA runs it locally, sends back structured results, and repeats until an explanation is produced. Responses stream into the panel, which displays tool activity/results.

The seven exposed tools are:
- get_mission_settings — read arrival, duration, height and user needs.
- list_candidate_sites — get curated candidate places.
- search_moon_names — search the local feature-name catalogue.
- scan_area — try a limited set of nearby points with coarser terrain for initial ranking.
- analyse_spot — calculate a candidate using the science worker.
- show_on_map — select a location and move the view.
- add_to_compare — add a candidate to the comparison UI.

The prompt instructs the model to base numerical statements on tool results. This reduces unsupported answers; it does not guarantee that the model cannot hallucinate, misread results, overlook a better site, or explain a value incorrectly. Area scanning samples candidates rather than proving a global optimum. The ordinary place card exposes the same analysis independently of the AI explanation.

The implementation includes cancellation, time limits and handling for interrupted streamed answers. The configured provider/model is replaceable through environment settings. Do not claim an exact live model version from a source-code default alone.

## 8. Rover and routes

The surface mode combines real large-scale elevation/imagery with procedural small-scale details, rocks, soil appearance and a simulated rover. These added details make exploration tangible; they are not measured reconstructions of individual real lunar rocks or metre-scale hazards.

Route planning uses A* search, with driving-time costs and simulated rover slope-dependent speed. The UI offers Fastest, Gentle, Sunlit and Earth link preferences. The current model closes slopes above about 25 degrees. Near the rover and destination, it uses finer planning over the simulated ground and obstacles; the distant middle uses coarser orbital terrain and catalogued craters.

A fine planning grid is not the same as fine measured terrain resolution. A route that avoids procedural rocks is valid in the app's simulation, not proof that a real rover can drive the corresponding lunar path. Sunlit/Earth-link route preferences are not a complete time-evolving power, thermal or communications mission simulation.

## 9. Validation and limits

The repository contains ephemeris, horizon, route, surface-safety and browser-check scripts. Browser automation can drive Chrome and capture screenshots/performance. The README reports a worst Sun/Earth directional difference of about 0.0014 degrees against selected NASA/JPL Horizons reference cases, and sanity checks at known lunar locations.

These are documented project checks; this context export did not rerun them. A direction comparison is not an end-to-end landing-site accuracy certificate. Do not say “NASA validated/certified MOONDA.”

Limits to state clearly:
- Terrain resolution, map coverage, download fallback, angular sampling and time sampling constrain results.
- Sharp photographic pixels do not make the underlying elevation model equally sharp.
- Earth in view is geometric visibility, not a radio link budget: it does not establish antenna performance, bandwidth, relay access or a working connection.
- Sunlight availability is not a complete power budget. User-entered battery endurance is a threshold comparison, not battery chemistry/temperature/charging simulation.
- Permanently shadowed terrain is not automatic proof of water ice. Hydrogen and radar evidence have interpretation limits. Direct LCROSS measurement at Cabeus is distinct from orbital evidence and predicted stability elsewhere.
- “Danger” colours summarize mapped criteria, not certified landing safety.
- Rover physics and small procedural terrain are approximations, not flight-tested hardware behavior.
- Bundled data enables local/offline use when the app and required assets are available. AI and additional online imagery need internet. Do not promise a first-ever offline visit or guaranteed offline reload on every device; this is not established by bundling alone.
- Static hosting plus browser calculations reduces server compute needs, but hosting bandwidth, downloaded data, GPU/device resources and AI inference still have costs. Do not claim zero cost or unlimited scaling.

## 10. Positioning and answers I can say aloud

**What is the main value?** “We connect location and arrival date to the mission's darkness and communication constraints, then let you compare the trade-offs visually.”

**How is this different from a map viewer?** “The useful part is the workflow: pick a place and date, calculate the sunlight and Earth-visibility timeline, compare it against your needs, and explore it on the surface.” Existing lunar tools also have substantial analysis capabilities; do not claim nobody else can do this without checking.

**Database or API?** “We use prepared scientific data files rather than a backend database. Online map services provide extra imagery, and the AI uses DeepSeek through our server proxy. The core calculations run in the browser.”

**Is the AI doing the physics?** “The language model chooses which tool to call and explains the results. Our terrain and astronomy code does the calculations.”

**Is it accurate?** “We checked the astronomy against reference cases and tested known locations. The answer still depends on terrain resolution and modeling assumptions, so this is exploratory decision support.”

**Did you build everything yourselves?** “We integrated open-source libraries and public scientific datasets, and used Claude and Codex to help develop the app and processing scripts.” Attribute detailed tasks to individual teammates only when I provide that information.

**What comes next?** Possible improvements, not existing capabilities: higher-resolution elevation where available; richer battery and thermal simulation; actual communication link budgets/relay models; uncertainty reporting; user studies and comparison against established mission-planning workflows.

## 11. How to judge another pitch fairly

Listen for the problem and intended user, what inputs enter the system, where calculations happen, which data is measured versus inferred, what the AI actually does, how results were checked, what is working now, and which claims remain future work.

Useful question patterns: “What did you compare your result against?” “Which part is computed by your own code versus generated by the model?” “How do you communicate uncertainty or missing data?” “What changes when the network is unavailable?” Use these only when relevant to their actual project.

## Source basis for this handoff

Local files inspected: README.md; docs/PITCH-QA.md (used cautiously because some details are stale); app/package.json; app/netlify.toml; app/server/aiProxy.mjs; app/netlify/edge-functions/ai.js; app/src/ai/{agent,tools,history}.ts; app/src/science/{analysis,terrain,worker,client}.ts; and storage-related source searches. No secrets or private API keys are included. No new live-site, physical-device or flight validation was performed for this export.
