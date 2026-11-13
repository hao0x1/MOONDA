# MOONDA logo brief (from Claude, for Codex)

## What MOONDA is
A website for NASA Space Apps 2026, challenge "Lunar Landing Site Navigator", built by a 6-person student team from Cambodia.
It is "Google Earth for the Moon": you fly around a real 3D Moon (NASA imagery and elevation), drop a pin anywhere near the
lunar south pole, pick a date, and MOONDA tells you two things about that spot:

1. **Sunlight** – is the Sun above the local horizon (solar power)? At the south pole the Sun never climbs high; it skims
   along the horizon, so mountains decide everything.
2. **Earth in view** – is Earth above the horizon (direct radio link home)?

It computes this from the real horizon (the jagged mountain skyline) seen from that spot, using NASA LOLA elevation data.
Tagline on the start screen: "Explore the Moon. Find a place to land."

## The app's look (match it)
- Near-black space background `#05060a`, panels `#151619`, text `#eeeff1`, secondary text `#b3b5bc`.
- Two accent colours with fixed meanings across the app: **Sun gold `#f1c56b`** (sunlight / solar power) and
  **Earth blue `#7fb5ee`** (Earth / radio link). Everything else is greyscale. Monochrome by default.
- Font: Google Sans Flex. The current wordmark is "MOONDA" in caps, semibold, very wide letter-spacing (0.32em).
- Real NASA photos for the Sun and Earth glyphs; no cartoon drawings.
- See `start-screen-now.webp` (attached): the current placeholder mark is a grey circle with grey crater dots. It looks like
  a generic emoji. That is what we are replacing.

## What the team lead likes and hates
- Wants it to "look like a big company": think the restraint of NASA's worm, SpaceX, Apple, Google Earth, Linear, Arc.
- Hates "AI slop": icons sitting inside glowing circles, rainbow gradients, neon glow, bevels, generic line icons,
  clip-art rockets, cartoon astronauts, a smiling moon, everything-in-a-box. No stock "swoosh".
- Wants it authentic and clever: use the NAME. Ideas he floated: the "OO" could be a glass / lenses; or play with the M, or
  the "DA".

## Deliverables (two logos, as he said)
1. **Primary logo** – mark + "MOONDA" wordmark, horizontal lockup, for the start screen, slides, pitch deck. Must also work
   as wordmark only.
2. **App icon / favicon** – the mark alone, readable at 16×16 and 32×32 px in a browser tab, and as a rounded-square app
   icon at 512 px. One or two shapes, no thin details.
Both must work in one colour (white on black) too.

## Claude's three seed concepts (critique these, then add your own)

**A. "Sun and Earth" in the OO.** The two O's are the Moon drawn twice. The first O has a thin crescent of gold sunlight
(`#f1c56b`) on its left edge; the second O has a thin crescent of blue earthshine (`#7fb5ee`) on its right edge. Those are
literally the two questions MOONDA answers for every landing spot. The rest of the word stays plain white. Icon: one circle
with the gold crescent on one side and the blue on the other – a Moon caught between the Sun and the Earth.

**B. "The real horizon".** The mark is a circle (a view window / the O). Its lower part is a jagged mountain skyline – in the
final vector version we will draw it from the actual horizon our tool computes at a real south-pole candidate site (e.g. the
rim of Shackleton crater). A gold Sun sits half-hidden right on the ridge (the polar Sun always skims the horizon), and a tiny
blue Earth dot hangs above. Story for the pitch: "the ridge in our logo is the real horizon seen from the south pole."

**C. "OO as a looking glass".** Following the team lead's idea: the OO become a pair of lenses (binocular / telescope
eyepieces) – the left lens shows the lit Moon surface, the right shows the horizon with the Sun. Risk: binoculars can look
childish; only good if it is very geometric and restrained.

## How we work together
Round 1 (now): you critique A–C honestly, propose up to two concepts of your own that use the name more cleverly, and pick the
three strongest overall. Write that to `round1/CODEX-NOTES.md`. Then generate the images for those three (see the prompt).
Round 2: Claude reviews the images, the team lead picks, and the winner gets redrawn as a clean SVG for the app.
