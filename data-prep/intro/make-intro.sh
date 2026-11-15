#!/bin/sh
# Builds the film behind the start screen (app/public/intro/space.mp4 and its still, space.jpg) from six
# visualisations by NASA's Scientific Visualization Studio. NASA's films are in the public domain; the music
# that some of them carry is not, so the film is silent. Sources and credit lines: app/public/intro/CREDITS.md.
#
#   sh data-prep/intro/make-intro.sh <folder with the six downloaded .mp4 files> app/public/intro
#
# Blur and dimming are part of the file (index.html only adds a soft shade under the text), so each scene has its
# own brightness: the bright ones (lunar ground in sunlight, the full Moon) are turned down the most, or the
# loading list in front of them would be hard to read. 960 x 540 at 24 frames a second, like the film it replaces.
set -e
D="$1"; OUT="$2"
X=1.5   # seconds each scene fades into the next
scene() { echo "fps=24,scale=960:540:flags=lanczos,colorchannelmixer=rr=$1:gg=$1:bb=$1,gblur=sigma=3,format=yuv420p,setsar=1,settb=AVTB"; }
ffmpeg -loglevel error -y \
  -ss 20 -t 22 -i "$D/BlackMarble_2016_rotate_720p.mp4" \
  -ss 18 -t 28 -i "$D/earthrise_720p30.mp4" \
  -ss 2  -t 13 -i "$D/waxing_720p30.mp4" \
  -ss 3  -t 24 -i "$D/orientale_720p30.mp4" \
  -ss 0  -t 24 -i "$D/phases_2026_plain_720p30.mp4" \
  -ss 3  -t 22 -i "$D/highlands_720p30.mp4" \
  -filter_complex "\
[0:v]$(scene 1.05)[a];[1:v]$(scene 0.5)[b];[2:v]$(scene 0.9)[c];[3:v]$(scene 0.5)[d];[4:v]$(scene 0.5)[e];[5:v]$(scene 0.45)[g];\
[a][b]xfade=transition=fade:duration=$X:offset=20.5[ab];\
[ab][c]xfade=transition=fade:duration=$X:offset=47[abc];\
[abc][d]xfade=transition=fade:duration=$X:offset=58.5[abcd];\
[abcd][e]xfade=transition=fade:duration=$X:offset=81[abcde];\
[abcde][g]xfade=transition=fade:duration=$X:offset=103.5[all];\
[all]fade=t=in:st=0:d=1.2,fade=t=out:st=124:d=1.5[v]" \
  -map "[v]" -an -c:v libx264 -preset veryslow -crf 25 -profile:v high -pix_fmt yuv420p -g 96 -movflags +faststart "$OUT/space.mp4"
# the still shown until the film can play: a moment into the first scene, after the fade from black
ffmpeg -loglevel error -y -ss 3 -i "$OUT/space.mp4" -frames:v 1 -q:v 6 "$OUT/space.jpg"
