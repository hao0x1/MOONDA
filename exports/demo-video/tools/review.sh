#!/bin/zsh
# review.sh film.mp4 [every_seconds] : contact sheets (4x4, 480 px tiles, time stamp burned in) into <work>/review-NN.jpg
W=${DEMO_WORK:-/private/tmp/claude-501/-Users-zhihaowu--claude-spares-spare-DGEDYS/5a04221c-0252-414b-ade3-5c32ce93609c/scratchpad/work}
EVERY=${2:-3}
rm -f $W/review-*.jpg
ffmpeg -v error -y -i "$1" -vf "fps=1/$EVERY,scale=480:-2,drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text='%{pts\:hms}':x=8:y=8:fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=4x4" $W/review-%02d.jpg
ls $W/review-*.jpg
