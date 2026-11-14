#!/bin/zsh
# Mix music + synthesized effects under the rendered film and write the final MP4.
#   tools/mix.sh <silent-film.mp4> <sfx.wav> <out.mp4> [musicStartSeconds]
# Music: "Cylinder Five" by Chris Zabriskie (CC BY 4.0), gently slowed so its natural ending lands on the film's end.
set -e
VID=$1; SFX=$2; OUT=$3; MS=${4:-9.4}
MUSIC=/Volumes/CodexWork/Projects/MOONDA/app/public/audio/cylinder-five.m4a
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VID")
MLEN=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$MUSIC")
# tempo so the music (start MS) ends 0.6 s after the picture
TEMPO=$(python3 -c "print(max(0.80, min(1.0, $MLEN / ($DUR - $MS + 0.6))))")
FO=$(python3 -c "print($DUR - 4.0)")
DMS=$(python3 -c "print(int($MS*1000))")
echo "film $DUR s, music tempo $TEMPO, music from $MS s"
ffmpeg -v error -y -i "$VID" -i "$MUSIC" -i "$SFX" -filter_complex "
  [1:a]aresample=48000,atempo=$TEMPO,adelay=${DMS}|${DMS},afade=t=in:st=$MS:d=2.5,afade=t=out:st=$FO:d=4,volume=0.95[m];
  [2:a]aresample=48000,volume=0.62[s];
  [m][s]amix=inputs=2:normalize=0:duration=longest,atrim=0:$DUR,loudnorm=I=-15:TP=-1.5:LRA=13,aresample=48000[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 320k -ar 48000 -movflags +faststart -shortest "$OUT"
echo "wrote $OUT"
ffprobe -v error -show_entries format=duration,size -of compact "$OUT"
