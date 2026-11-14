"""Build attributed crater outline records. Only writes within assets-codex.

Run with MOONDA/.venv-data/bin/python -I features/scripts/build_craters.py.
No downloaded code is imported or executed.
"""
from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parents[2]
PROJECT = BASE.parent
RAW = PROJECT / "data-raw"
OUT = BASE / "features/out"
DOWNLOADS = BASE / "features/downloads"
CSV = RAW / "usgs-robbins-craters/lunar_crater_database_robbins_2018_bundle/data/lunar_crater_database_robbins_2018.csv"
ROBBINS_URL = "https://astrogeology.usgs.gov/search/map/moon_crater_database_v1_robbins"
ROBBINS_DATA_URL = "https://astrogeology.usgs.gov/ckan/dataset/f89f5478-b69a-486c-b9b5-30d7b0c5ad2b/resource/c4f25cc2-4f8a-4207-a845-5e176da3ac5a/download/lunar_crater_database_robbins_2018"
ROBBINS_CITE = ("Robbins, S. J. (2019). A New Global Database of Lunar Impact Craters >1-2 km: "
                "1. Crater Locations and Sizes, Comparisons With Published Databases, and Global Analysis. "
                "Journal of Geophysical Research: Planets 124(4), 871-892. doi:10.1029/2018JE005592.")
ROBBINS_LICENCE = ("Public-domain NASA PDS numerical data (PDS Geosciences FAQ, https://pds-geosciences.wustl.edu/faq.html); "
                   "no access or use constraints in the product FGDC metadata. No separate Creative Commons licence is asserted. "
                   "Credit Stuart J. Robbins / Southwest Research Institute and USGS Astrogeology Science Center.")
SMALL_CITE = ("Marco Figuera, R., Riedel, C., Pio Rossi, A., and Unnithan, V. (2022). "
              "Depth to Diameter Analysis on Small Simple Craters at the Lunar South Pole - Possible "
              "Implications for Ice Harboring. Remote Sensing 14(3), 450. doi:10.3390/rs14030450. "
              "Dataset: Marco Figuera, R. (2021), South polar small and medium craters, Version 2, "
              "Zenodo, doi:10.5281/zenodo.5779260.")


def dump(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def inventory(path, url):
    h = hashlib.md5()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return {"file": str(path.relative_to(BASE)) if path.is_relative_to(BASE) else "../" + str(path.relative_to(PROJECT)),
            "url": url, "size": path.stat().st_size, "md5": h.hexdigest()}


def write_records(path, rows):
    a = np.asarray(rows, dtype=np.float64)
    a[:, 1] = (a[:, 1] + 180) % 360 - 180
    # Stable ties retain source catalogue order. File LOD counts use encoded values.
    a = a[np.argsort(-a[:, 2], kind="stable")].astype("<f4")
    assert np.isfinite(a).all() and np.all(a[1:, 2] <= a[:-1, 2])
    assert np.all((-90 <= a[:, 0]) & (a[:, 0] <= 90))
    assert np.all((-180 <= a[:, 1]) & (a[:, 1] <= 180))
    a.tofile(path)
    return a


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rows, ids = [], set()
    total = 0
    with CSV.open(newline="") as f:
        for row in csv.DictReader(f):
            total += 1
            lat, lon, diameter = map(float, (row["LAT_CIRC_IMG"], row["LON_CIRC_IMG"], row["DIAM_CIRC_IMG"]))
            if diameter >= 5 or (lat <= -75 and diameter >= 1):
                assert row["CRATER_ID"] not in ids, "Duplicate selected source ID"
                ids.add(row["CRATER_ID"])
                rows.append((lat, lon, diameter))
    a = write_records(OUT / "craters.bin", rows)
    meta = {"count": len(a), "record": ["lat", "lon", "diameterKm"],
            "lod": [{"minKm": t, "count": int(np.count_nonzero(a[:, 2] >= t))}
                    for t in [200, 100, 50, 20, 10, 5, 2, 1]],
            "source": "Robbins global lunar crater database, 2018-08-15 release; circular fits",
            "citation": ROBBINS_CITE, "licence": ROBBINS_LICENCE, "url": ROBBINS_URL}
    files = [inventory(CSV, ROBBINS_DATA_URL),
             inventory(RAW / "usgs-robbins-craters/lunar_crater_database_robbins_2018.zip", ROBBINS_DATA_URL)]

    record_path = DOWNLOADS / "small-craters-zenodo-5779260.json"
    record = json.loads(record_path.read_text())
    # Redistribution is conditional on the authoritative record, not the paper licence.
    assert record["id"] == 5779260
    assert record["metadata"]["license"]["id"] == "cc-by-4.0"
    small_rows = []
    small_counts = {}
    for name in ["craters_psr.csv", "craters_no_psr.csv"]:
        path = RAW / "zenodo-southpolar-small-craters" / name
        info = next(e for e in record["files"] if e["key"] == name)
        inv = inventory(path, f"https://zenodo.org/records/5779260/files/{name}")
        assert inv["size"] == info["size"]
        assert "md5:" + inv["md5"] == info["checksum"]
        files.append(inv)
        n = 0
        with path.open(newline="") as f:
            for row in csv.DictReader(f, skipinitialspace=True):
                # In the archived CSV, x and y are longitude and latitude in degrees.
                small_rows.append((float(row["y"]), float(row["x"]), float(row["Diam_km"])))
                n += 1
        small_counts[name] = n
    small = write_records(OUT / "craters-small-south.bin", small_rows)
    meta["small"] = {"file": "craters-small-south.bin", "count": len(small),
                     "record": ["lat", "lon", "diameterKm"],
                     "source": "South polar small and medium craters, Zenodo 5779260 Version 2; both CSV files",
                     "citation": SMALL_CITE,
                     "licence": "Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/",
                     "url": "https://zenodo.org/records/5779260"}
    dump(OUT / "craters.json", meta)
    dump(OUT / "craters-sources.json", files + [
        inventory(record_path, "https://zenodo.org/api/records/5779260"),
        inventory(DOWNLOADS / "robbins-usgs-metadata.xml", ROBBINS_URL + ".xml")])
    manifest = {"id": "craters", "title": "Crater outlines",
                "shortHelp": "Circles show measured crater sizes. More small craters appear near the south pole.",
                "units": "km", "scale": 1, "offset": 0, "valueMin": 1, "valueMax": float(a[:, 2].max()),
                "legend": [{"value": 1, "color": "#c8c8c8"}, {"value": float(a[:, 2].max()), "color": "#ffffff"}],
                "source": {"name": "Robbins lunar crater database: lunar_crater_database_robbins_2018.csv; optional Zenodo small craters: craters_psr.csv and craters_no_psr.csv",
                           "url": ROBBINS_URL, "citation": ROBBINS_CITE + " " + SMALL_CITE,
                           "version": "Robbins 2018-08-15 PDS4 v1.0; small-crater Zenodo 5779260 v2"},
                "notes": ("VECTOR exception: craters.bin is little-endian Float32 triples [latDeg, lonDeg, diameterKm], "
                          "sorted largest first, not a Uint16 raster. Use craters.json LOD prefix counts. Robbins "
                          "circular-fit columns LAT_CIRC_IMG, LON_CIRC_IMG, DIAM_CIRC_IMG. Keep diameter >=5 km globally "
                          "OR centre latitude <=-75 degrees and diameter >=1 km. Longitude wrapped to [-180,180). "
                          + ROBBINS_LICENCE + " The separate craters-small-south.bin contains both archived CSVs; "
                          "licence CC BY 4.0; credit Marco Figuera et al. (2022) and Zenodo 5779260. It is a limited "
                          "study area, not a complete south-pole survey or a map of ice. All archived small rows retained, "
                          "including rows outside the paper's final 200-1000 m filtered analysis sample.")}
    dump(OUT / "craters-manifest.json", manifest)
    print(json.dumps({"sourceRows": total, "selected": len(a), "bytes": (OUT / "craters.bin").stat().st_size,
                      "lod": meta["lod"], "small": len(small), "smallInputCounts": small_counts,
                      "smallBytes": (OUT / "craters-small-south.bin").stat().st_size,
                      "smallDiameterKm": [float(small[:, 2].min()), float(small[:, 2].max())],
                      "smallLat": [float(small[:, 0].min()), float(small[:, 0].max())]}, indent=2))


if __name__ == "__main__":
    main()
