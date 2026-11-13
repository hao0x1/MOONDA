"""Convert the USGS/IAU Gazetteer of Planetary Nomenclature (Moon) into a compact JSON
for the app: app/public/data/names.json

Source: https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MOON_nomenclature_center_pts.zip
(Gazetteer of Planetary Nomenclature, IAU Working Group for Planetary System Nomenclature / USGS)

Run:  ../.venv-data/bin/python -I names.py
"""
import json
import pathlib
import re

import shapefile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "data-raw/usgs-nomenclature/MOON_nomenclature_center_pts.shp"
OUT = ROOT / "app/public/data/names.json"

# Plain-English names for IAU feature types (code -> label).
KIND = {
    "AA": "Crater", "CA": "Crater chain", "DO": "Wrinkle ridge", "LC": "Small dark plain",
    "MA": "Dark plain (sea)", "ME": "Small dark plain", "MO": "Mountain", "OC": "Ocean",
    "PA": "Dark plain (marsh)", "PL": "Plain", "PR": "Cape", "RI": "Channel", "RU": "Cliff",
    "SI": "Bay", "VA": "Valley", "SF": "Small crater", "LF": "Landing-site name",
    "AL": "Bright marking", "TE": "Highland", "FL": "Flow", "CB": "Cliff",
}


def clean(text: str) -> str:
    text = (text or "").strip()
    return re.sub(r"\s+", " ", text)


def main() -> None:
    reader = shapefile.Reader(str(SRC))
    rows = []
    kinds = {}
    for rec in reader.records():
        r = rec.as_dict()
        if "Dropped" in (r["approval"] or "") or "Unapproved" in (r["approval"] or ""):
            continue
        lon = float(r["center_lon"])
        if lon > 180:
            lon -= 360
        code = r["code"] or ""
        kind = KIND.get(code, clean(r["type"]).split(",")[0])
        kinds[code] = kind
        link = r["link"] or ""
        fid = int(link.rsplit("/", 1)[-1]) if link.rsplit("/", 1)[-1].isdigit() else 0
        rows.append([
            clean(r["clean_name"]),            # 0 name
            kind,                              # 1 plain kind
            round(float(r["diameter"] or 0), 2),  # 2 diameter km
            round(float(r["center_lat"]), 4),  # 3 lat
            round(lon, 4),                     # 4 lon (-180..180, east positive)
            clean(r["origin"]),                # 5 named after
            fid,                               # 6 USGS feature id
            1 if code == "SF" else 0,          # 7 satellite feature flag
        ])
    rows.sort(key=lambda x: -x[2])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "source": "Gazetteer of Planetary Nomenclature, IAU WGPSN / USGS Astrogeology",
        "url": "https://planetarynames.wr.usgs.gov/",
        "fields": ["name", "kind", "diameterKm", "lat", "lon", "origin", "usgsId", "satellite"],
        "rows": rows,
    }, ensure_ascii=False, separators=(",", ":")))
    print(len(rows), "names ->", OUT, f"{OUT.stat().st_size/1e6:.2f} MB")
    print(sorted(kinds.items()))


if __name__ == "__main__":
    main()
