#!/bin/zsh
# capture every listed shot one after another (one headless Chrome at a time)
cd "$(dirname "$0")/.."
for s in "$@"; do
  echo "=== $s $(date +%H:%M:%S)"
  node tools/capture.mjs "$s" 2>&1 | grep -v "frames (" 
done
echo "=== all done $(date +%H:%M:%S)"
