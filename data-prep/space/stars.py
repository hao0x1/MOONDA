#!/usr/bin/env python3
"""Bright-star catalogue for the sky, from the HYG database v4.1 (github.com/astronexus/HYG-Database, CC BY-SA 4.0).

    python3 -I data-prep/space/stars.py <raw>/hyg/hygdata_v41.csv app/public/space/stars.json

Output: a JSON array, brightest first, one entry per star with magnitude <= 6.5 (what a person can see):
    [raDeg, decDeg, mag, bv, name | null]            for most stars
    [raDeg, decDeg, mag, bv, name, constellation, lightYears]   for stars that have a proper name
raDeg/decDeg are J2000 (ICRS) right ascension / declination in degrees, moved from the catalogue epoch 2000.0
to 2027.0 with each star's own proper motion (only matters for a few near stars: Alpha Centauri moves 0.03 deg).
bv is the B-V colour index (blue < 0 < white 0.3 < Sun 0.65 < orange 1.2 < red 1.8); 0.65 where unknown.
"""
import csv
import json
import math
import sys

EPOCH_YEARS = 27.0
MAG_LIMIT = 6.5


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    out = []
    with open(src, encoding='utf8', newline='') as f:
        for r in csv.DictReader(f):
            if r['proper'] == 'Sol' or not r['mag']:
                continue
            mag = float(r['mag'])
            if mag > MAG_LIMIT:
                continue
            ra, dec = float(r['ra']) * 15.0, float(r['dec'])
            pmra, pmdec = float(r['pmra'] or 0), float(r['pmdec'] or 0)  # milli-arcseconds per year; pmra already has cos(dec)
            dec2 = dec + pmdec * EPOCH_YEARS / 3.6e6
            ra2 = (ra + pmra * EPOCH_YEARS / 3.6e6 / max(0.01, math.cos(math.radians(dec)))) % 360.0
            bv = float(r['ci']) if r['ci'] else 0.65
            row = [round(ra2, 4), round(dec2, 4), round(mag, 2), round(bv, 2), r['proper'] or None]
            if r['proper']:
                dist_pc = float(r['dist'] or 0)
                ly = dist_pc * 3.26156
                row += [r['con'] or None, round(ly, 1) if 0 < ly < 100 else round(ly) if 0 < dist_pc < 99999 else None]
            out.append(row)
    out.sort(key=lambda s: s[2])
    with open(dst, 'w', encoding='utf8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(len(out), 'stars,', sum(1 for s in out if s[4]), 'named ->', dst)


if __name__ == '__main__':
    main()
