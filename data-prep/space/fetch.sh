#!/bin/sh
# Download the raw sky assets (NASA + HYG) into a RAW folder outside the project.
#   sh data-prep/space/fetch.sh /path/to/raw
# Resumable: run it again after a network error. Nothing downloaded here is ever executed.
set -u
RAW="${1:?usage: fetch.sh <raw folder>}"
UA="Mozilla/5.0 (asset-fetch)"
get() { # get <subdir> <url>
  mkdir -p "$RAW/$1"; f="$RAW/$1/$(basename "$2")"
  if [ -f "$f.ok" ]; then echo "have $f"; return 0; fi
  i=0
  while [ $i -lt 12 ]; do
    if curl -sS -f -L -C - --connect-timeout 20 --max-time 1800 -A "$UA" -o "$f" "$2"; then touch "$f.ok"; echo "ok   $f"; return 0; fi
    i=$((i+1)); sleep 3
  done
  echo "FAILED $2"; return 1
}
SVS=https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851
get svs4851 $SVS/milkyway_2020_8k.exr       # Milky Way background, RA/Dec plate carree, 8192x4096
get svs4851 $SVS/starmap_2020_4k.exr        # full star map (only used to verify the layout)
# Earth maps: NASA Earth Observatory files now live on assets.science.nasa.gov (eoimages.gsfc.nasa.gov no longer answers).
EO=https://assets.science.nasa.gov/content/dam/science/esd/eo
get earth $EO/images/bmng/bmng-topography-bathymetry/november/world.topo.bathy.200411.3x5400x2700.jpg   # Blue Marble NG, November, land + sea floor, no clouds
get earth $EO/images/imagerecords/144000/144898/BlackMarble_2016_01deg.jpg                               # Black Marble 2016 night lights, 3600x1800
get earth $EO/content-feature/bluemarble/images/cloud_combined_2048.jpg                                  # Blue Marble (2002) cloud layer, 2048x1024
get hyg https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv
