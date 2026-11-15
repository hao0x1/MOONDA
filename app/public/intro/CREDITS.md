# The film behind the start screen

`space.mp4` (and its still, `space.jpg`) is a silent two-minute film cut from six visualisations by NASA.
NASA's Scientific Visualization Studio says of its work: "All of our content is in the public domain (unless
otherwise noted)", free to download, use and redistribute (https://svs.gsfc.nasa.gov/help/). The music that
some of these films carry is not in the public domain, so none of it is used. NASA asks to be named as the
source and must not be shown as endorsing anything (https://www.nasa.gov/nasa-brand-center/images-and-media/).

Credit line: **Start-screen film: NASA's Scientific Visualization Studio and NASA's Goddard Space Flight Center.**

| Scene | NASA visualisation | File used | Credit asked for on its page |
| --- | --- | --- | --- |
| Earth at night, turning | Black Marble 2016 (Rotating Globe), https://svs.gsfc.nasa.gov/30878 | `BlackMarble_2016_rotate_720p.mp4` | NASA's Goddard Space Flight Center (scientist Miguel Román, NASA/GSFC; image processing and animation Joshua Stevens, SSAI) |
| Earth rising over the Moon | Earthrise in 4K, https://svs.gsfc.nasa.gov/4593 (telephoto view, from https://svs.gsfc.nasa.gov/4129) | `earthrise_720p30.mp4` | NASA's Scientific Visualization Studio |
| Crescent Moon | Moonlight (Clair de Lune), https://svs.gsfc.nasa.gov/4655, scene 1 | `waxing_720p30.mp4` | NASA's Scientific Visualization Studio |
| Sunrise over Orientale basin | Moonlight (Clair de Lune), scene 6 | `orientale_720p30.mp4` | NASA's Scientific Visualization Studio |
| A month of Moon phases | Moon Phase and Libration, 2026, https://svs.gsfc.nasa.gov/5587 (plain view) | `phases_2026_plain_720p30.mp4` | NASA's Scientific Visualization Studio (visualiser Ernie Wright) |
| The far side | Moonlight (Clair de Lune), scene 8 | `highlands_720p30.mp4` | NASA's Scientific Visualization Studio |

What was changed: each clip was trimmed, scaled to 960 x 540 at 24 frames a second, blurred and dimmed so the
loading list stays readable in front of it, joined with short cross-fades, and saved without sound.
Rebuild it with `data-prep/intro/make-intro.sh` (the six files come from the pages above).

This film replaced, on 15 Nov 2026, a montage taken from YouTube whose origin and licence were not known.
