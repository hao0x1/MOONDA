# Crater motion check

**Result: pass.** The final run has no empty frame, no camera-key mismatch and no unexplained count drop above 15% across slow/fast wheel zoom in both directions, panning and turning. One fast-zoom count drop is the permitted completion of genuine outgoing fades; details below.

The cause was the old clear-and-rebuild path: every camera move erased the
canvas, and another move cancelled the asynchronous replacement before it could
finish. The baseline reproduced this with zero chunk evictions, so cache eviction
was not the cause of those flashes.

The renderer now holds rim samples in world coordinates, then projects and paints
all held rings synchronously after each photo frame. Background selection and
chunk loads cannot clear that picture. New rings fade in and outgoing rings fade
out over 200 ms. Existing rings use a 7 px leaving threshold and new ones an 11 px
entry threshold. Edge motion starts outgoing fades before the ring crosses the
viewport. The 400-ring limit, basin size fade, warm start and 40 MiB managed budget
remain in place. Resident rim samples stay owned even if their data chunk is evicted.

Changed code: `app/src/moon/craterLayer.ts`, `app/scripts/check-crater-layer.ts`,
and `data-prep/features/scripts/check_crater_motion.mjs`. No data binary or shared
MoonMap block was changed in this round. No UI wording was added.

`npx tsc -b`, all mathematical/fade/selection/edge-prediction checks, and
`git diff --check` passed. The code is local; it was not built or deployed.

## Before and after

| Motion | Empty RAF frames before | Empty frames after | Largest unfaded count drop after | Minimum prior-ring retention after | Visible count after |
| --- | ---: | ---: | ---: | ---: | ---: |
| slow zoom in | 393 / 838 | 0 / 836 | 1.79% | 89.23% | 55–340 |
| slow zoom out | 396 / 838 | 0 / 841 | 0.00% | 98.25% | 56–343 |
| fast zoom in | 87 / 183 | 0 / 181 | 14.02% | 64.00% | 48–341 |
| fast zoom out | 65 / 185 | 0 / 169 | 0.00% | 92.38% | 56–343 |
| pan | 69 / 284 | 0 / 285 | 1.18% | 98.82% | 319–342 |
| turn | 127 / 284 | 0 / 283 | 1.92% | 97.81% | 277–376 |

Every before motion had a 100% worst count drop and 0% minimum prior-ring retention. Final mean previous-ring retention was 99.34%, 99.89%, 97.39%, 99.46%, 99.91% and 99.81% respectively. Both the final RAF and postRender streams have zero empty output and zero current-versus-painted camera mismatches.

The slow and fast sweeps use real mouse-wheel input, from 800 km to 59.1 km (60 km target) and back to 800.0 km. Slow input is 80 events spaced 100 ms; fast input is 16 events spaced 20 ms. Pan and turn use real left/right pointer drags. Wheel gain is calibrated per run: at device scale 2, Chrome delivered half the requested wheel delta. The original 221 km preliminary sweep is not used.

The before browser served the saved old module (SHA256 `144d119139c2ac4830d78e6680b282e94552dcd99124d88d451a5ddab45acf5a`) with diagnostics instrumentation only; rendering behaviour was unchanged. The after browser served the updated source. Vite hot updates were ignored inside each test page so another owner could keep editing without resetting a test.

## Fade exception

Fast inward zoom had one 75 → 48 count drop (36%) near 64.8 → 64.2 km. All 27 departing prior IDs were already marked as outgoing fades; their previous alpha was only 0.1–0.7%. The retiring pool was 29. This is the end of the 200 ms fade, not a sudden disappearance. The largest drop involving any previously non-fading ring was 14.02%, below 15%.

## Frame evidence

Each frame records actual painted ring IDs, alpha, outgoing-fade status, count, previous count, retained count, retention share, height, actual canvas-alpha probe, camera-key agreement and painted time. Hidden active-pool and retiring-pool counts are stored separately. The primary table uses browser RAF samples; separate Cesium postRender samples remain in the trace.

Six consecutive compositor frames from the middle of the slow zoom are below. Their timestamps span 83.3 ms; they are distinct 1440 × 900 PNGs. All six were opened and inspected: Firmicus and neighbouring rings stay on their photographed rims, with no empty or partially drawn layer.

- [Frame 1](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/motion-after-final/zoom-mid-01.png)
- [Frame 2](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/motion-after-final/zoom-mid-02.png)
- [Frame 3](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/motion-after-final/zoom-mid-03.png)
- [Frame 4](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/motion-after-final/zoom-mid-04.png)
- [Frame 5](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/motion-after-final/zoom-mid-05.png)
- [Frame 6](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/motion-after-final/zoom-mid-06.png)

Raw [before trace](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/motion-before-final/result.json), [final trace](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/motion-after-final/result.json), and [machine comparison with screenshot hashes](/private/tmp/claude-501/-Volumes-CodexWork-Projects-MOONDA/4ec40458-1a1b-4580-bbfb-7871a2a20abe/scratchpad/codex2/K/motion-after-final/comparison.json).

Final diagnostics: 400 resident limit, 376 painted rings at the last turn,324,480 bytes cached geometry,31,308,212 managed bytes including reserves, below the41,943,040 byte (40 MiB) cap. Warm start remained ready; its download was 329,749 bytes. No page errors in before or final after. Both browsers closed and released the single-browser lease. No server, build or package install was started by this QA script.
