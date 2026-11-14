#!/bin/bash
# sheet.sh t1 t2 ... : 3x3 contact sheet of rendered stills (work/stills/tNNNN.NN.png) -> work/stills-sheet.jpg
W=/private/tmp/claude-501/-Users-zhihaowu--claude-spares-spare-DGEDYS/5a04221c-0252-414b-ade3-5c32ce93609c/scratchpad/work
args=(); f=""; n=0; ins=""
for t in "$@"; do p=$(printf "%s/stills/t%07.2f.png" $W $t); args+=(-i $p); f="$f[$n]scale=640:-2[s$n];"; n=$((n+1)); done
L="0_0|w0_0|w0+w1_0|0_h0|w0_h0|w0+w1_h0|0_h0+h1|w0_h0+h1|w0+w1_h0+h1"
for i in $(seq 0 $((n-1))); do ins="$ins[s$i]"; done
ffmpeg -v error -y "${args[@]}" -filter_complex "$f${ins}xstack=inputs=$n:layout=$(echo $L | cut -d"|" -f1-$n)" $W/stills-sheet.jpg && echo ok
