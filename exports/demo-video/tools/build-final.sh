#!/bin/zsh
# Render the whole film, make the sound, mix, and put the results on the Desktop.
set -e
cd "$(dirname "$0")/.."
W=${DEMO_WORK:-/private/tmp/claude-501/-Users-zhihaowu--claude-spares-spare-DGEDYS/5a04221c-0252-414b-ade3-5c32ce93609c/scratchpad/work}
NAME=${1:-MOONDA-demo-film}
echo "=== render picture $(date +%T)"
node tools/render.mjs --out $W/$NAME-picture.mp4 --crf ${CRF:-16}
echo "=== cues + sound $(date +%T)"
node tools/render.mjs --cues $W/cues.json
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 $W/$NAME-picture.mp4)
node tools/sfx.mjs $W/cues.json $W/sfx.wav $DUR
echo "=== mix $(date +%T)"
tools/mix.sh $W/$NAME-picture.mp4 $W/sfx.wav $W/$NAME.mp4
cp $W/$NAME.mp4 ~/Desktop/$NAME.mp4
cp $W/$NAME-picture.mp4 ~/Desktop/$NAME-silent.mp4
echo "=== done $(date +%T): ~/Desktop/$NAME.mp4"
