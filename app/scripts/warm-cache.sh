#!/bin/bash
# Pre-load files into Cloudflare's cache for moonda.us, so the first visitor after a deploy (or after
# a quiet spell) gets them from a nearby Cloudflare copy instead of waiting while Cloudflare fetches
# each one from Netlify. With Smart Tiered Cache on, a warm-up from any one place also fills the
# shared upper tier that every other Cloudflare city falls back to.
#
#   scripts/warm-cache.sh <paths.txt> [https://moonda.us] [parallel]
#
# paths.txt: one site path per line (scripts/startup-files.mjs writes the start screen's list).
# The app's code files change name with every build, so they are always read from the live page
# (index.html and the main script) instead of the list. Prints HIT/MISS counts per run.
set -u
CURL="curl ${WARM_CURL_OPTS:-}"   # e.g. WARM_CURL_OPTS=-4 to stay on IPv4
LIST=$1; BASE=${2:-https://moonda.us}; PAR=${3:-8}
AE='gzip, deflate, br, zstd'   # what a browser sends; Cloudflare keeps one copy per compression
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 moonda-warm-cache'
tmp=$(mktemp -d); start=$(date +%s)
$CURL -sS -A "$UA" "$BASE/" -o "$tmp/index.html"
grep -oE 'assets/[A-Za-z0-9_.-]+\.(js|css|wasm)' "$tmp/index.html" | sort -u > "$tmp/a1"
while read -r a; do $CURL -sS -A "$UA" "$BASE/$a" | grep -oE 'assets/[A-Za-z0-9_.-]+\.(js|css|wasm|json)' ; done < "$tmp/a1" | sort -u > "$tmp/a2"
{ sed 's#^#/#' "$tmp/a1" "$tmp/a2"; grep -v '^/assets/' "$LIST"; } | grep -v '^\s*$' | sort -u > "$tmp/paths"
xargs -P "$PAR" -I{} $CURL -sS -o /dev/null -H "Accept-Encoding: $AE" -A "$UA" \
  -w '%{http_code} %header{cf-cache-status} %{size_download} {}\n' "$BASE{}" < "$tmp/paths" > "$tmp/out" 2>&1
awk -v s="$start" -v e="$(date +%s)" -v d="$(date -u +%FT%TZ)" '
  { n++; st[$2]++; mb += $3/1e6; if ($1 != 200) { nb++; if (nb <= 5) bad = bad "\n  " $0 } }
  END { printf "%s %d files, %.0f MB in %d s;", d, n, mb, e-s; for (k in st) printf " %s=%d", (k==""?"no-cf":k), st[k]; if (nb) printf "; %d not 200:%s", nb, bad; print "" }' "$tmp/out"
rm -rf "$tmp"
