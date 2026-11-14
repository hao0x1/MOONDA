"""Build small, local drawing chunks from the official Robbins PDS catalogue.

Run from the project with .venv-data/bin/python -I
data-prep/features/scripts/build_crater_drawing.py. Downloaded files are read
as data; none of their code, XML schemas or scripts is run.
"""
from __future__ import annotations

import csv
import hashlib
import json
import math
from pathlib import Path

import numpy as np

PROJECT = Path(__file__).resolve().parents[3]
FEATURES = PROJECT / "app/public/data/features"
OUT = FEATURES / "craters-draw"
REPORT = PROJECT / "data-prep/features/crater-drawing-check.json"
RAW = PROJECT / "data-raw/usgs-robbins-craters"
CSV = RAW / "lunar_crater_database_robbins_2018_bundle/data/lunar_crater_database_robbins_2018.csv"
SOURCE_URL = "https://astrogeology.usgs.gov/search/map/moon_crater_database_v1_robbins"
DOWNLOAD_URL = "https://astropedia.astrogeology.usgs.gov/download/Moon/Research/Craters/lunar_crater_database_robbins_2018"
PDS_URL = "https://pdsimage2.wr.usgs.gov/Individual_Investigations/moon_lro.kaguya_multi_craterdatabase_robbins_2018/"
R_KM = 1737.4
LEVEL = 3
NX, NY = 2 << LEVEL, 1 << LEVEL


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n")


def main() -> None:
    # These still serve the route planner and the separate polar study area.
    retained = {f: sha256(FEATURES / f)
                for f in ("craters.bin", "craters-small-south.bin")}
    with CSV.open(newline="") as f:
        rows = np.asarray([(float(r["LAT_CIRC_IMG"]),
                            (float(r["LON_CIRC_IMG"]) + 180) % 360 - 180,
                            float(r["DIAM_CIRC_IMG"]))
                           for r in csv.DictReader(f)], dtype=np.float64)
    assert rows.shape == (1296796, 3), "Unexpected source release or missing rows"
    assert np.isfinite(rows).all() and (rows[:, 2] >= 1).all()
    assert ((rows[:, 0] >= -90) & (rows[:, 0] <= 90)).all()
    assert ((rows[:, 1] >= -180) & (rows[:, 1] < 180)).all()

    lat, lon = np.deg2rad(rows[:, 0]), np.deg2rad(rows[:, 1])
    # Same rigid rotation as frame.ts and the photos: display = (x, -z, y).
    centres = np.column_stack((np.cos(lat) * np.cos(lon),
                               -np.sin(lat), np.cos(lat) * np.sin(lon)))
    dlat = np.arcsin(np.clip(centres[:, 2], -1, 1))
    dlon = np.arctan2(centres[:, 1], centres[:, 0])
    tile_x = np.minimum(NX - 1, np.floor((dlon + math.pi) / (2 * math.pi) * NX).astype(int))
    tile_y = np.minimum(NY - 1, np.floor((math.pi / 2 - dlat) / math.pi * NY).astype(int))
    assert (tile_x >= 0).all() and (tile_y >= 0).all()

    OUT.mkdir(parents=True, exist_ok=True)
    chunks = []
    assigned = np.zeros(len(rows), dtype=np.uint8)
    max_centre_error_m = 0.0
    max_diameter_error_m = 0.0
    max_cap_excess = -math.pi

    def save(name: str, indices: np.ndarray, band_min: float, band_max: float | None,
             bounds: dict | None = None) -> None:
        nonlocal max_centre_error_m, max_diameter_error_m, max_cap_excess
        if not len(indices):
            return
        indices = indices[np.argsort(-rows[indices, 2], kind="stable")]
        assigned[indices] += 1
        encoded = rows[indices].astype("<f4")
        assert (encoded[:-1, 2] >= encoded[1:, 2]).all()
        path = OUT / name
        encoded.tofile(path)
        assert path.stat().st_size == 12 * len(indices)
        decoded = np.fromfile(path, dtype="<f4").reshape(-1, 3)
        assert np.array_equal(decoded, encoded)
        min_km, max_km = float(decoded[:, 2].min()), float(decoded[:, 2].max())
        if bounds is None:
            centre, radius = [1, 0, 0], math.pi
        else:
            mid_lon = (bounds["west"] + bounds["east"]) / 2
            mid_lat = (bounds["north"] + bounds["south"]) / 2
            centre = [math.cos(mid_lat) * math.cos(mid_lon),
                      math.cos(mid_lat) * math.sin(mid_lon), math.sin(mid_lat)]
            # Deliberately wider than the region. Include rims whose centres
            # are outside the view, so a boundary never loses half a circle.
            radius = min(math.pi, .72 * math.hypot(bounds["east"] - bounds["west"],
                                                  bounds["north"] - bounds["south"])
                         + max_km / (2 * R_KM))
        actual_reach = np.arccos(np.clip(centres[indices] @ np.asarray(centre), -1, 1)) + rows[indices, 2] / (2 * R_KM)
        max_cap_excess = max(max_cap_excess, float(np.max(actual_reach - radius)))
        assert (actual_reach <= radius + 1e-6).all() or bounds is None
        # Arc distance is stable via atan2 of the cross and dot products.
        elat, elon = np.deg2rad(decoded[:, 0].astype(float)), np.deg2rad(decoded[:, 1].astype(float))
        eu = np.column_stack((np.cos(elat) * np.cos(elon), -np.sin(elat), np.cos(elat) * np.sin(elon)))
        centre_errors = np.arctan2(np.linalg.norm(np.cross(centres[indices], eu), axis=1),
                                   np.einsum("ij,ij->i", centres[indices], eu)) * R_KM * 1000
        max_centre_error_m = max(max_centre_error_m, float(centre_errors.max()))
        max_diameter_error_m = max(max_diameter_error_m, float(np.max(np.abs(rows[indices, 2] - decoded[:, 2]))) * 1000)
        chunks.append({"file": "craters-draw/" + name, "count": len(indices),
                       "bytes": path.stat().st_size, "minKm": min_km, "maxKm": max_km,
                       "bandMinKm": band_min, "bandMaxKm": band_max,
                       "centre": centre, "radiusRad": radius, "bounds": bounds})

    save("global-20.bin", np.flatnonzero(rows[:, 2] >= 20), 20, None)
    # Bigger classes first makes a near view useful before its tiny craters arrive.
    for band_min, band_max in [(5, 20), (2, 5), (1, 2)]:
        in_band = (rows[:, 2] >= band_min) & (rows[:, 2] < band_max)
        for y in range(NY):
            for x in range(NX):
                bounds = {"west": -math.pi + x * 2 * math.pi / NX,
                          "east": -math.pi + (x + 1) * 2 * math.pi / NX,
                          "north": math.pi / 2 - y * math.pi / NY,
                          "south": math.pi / 2 - (y + 1) * math.pi / NY}
                save(f"l3-{x}-{y}-{band_min}-{band_max}.bin",
                     np.flatnonzero(in_band & (tile_x == x) & (tile_y == y)),
                     band_min, band_max, bounds)
    assert (assigned == 1).all(), "A source row was lost or repeated"
    assert retained == {f: sha256(FEATURES / f) for f in retained}, "Existing vectors changed"
    total_bytes = sum(c["bytes"] for c in chunks)
    assert total_bytes < 25_000_000
    manifest = {"version": 1, "count": len(rows), "bytes": total_bytes,
                "record": ["latDeg", "lonDeg", "diameterKm"],
                "encoding": "Float32 little-endian, no header; diameter descending within each chunk",
                "longitude": "East-positive, wrapped to [-180,180)",
                "regionFrame": "display = (x, -z, y) of true Moon frame",
                "regionLevel": LEVEL, "moonRadiusKm": R_KM,
                "source": {"title": "Robbins (2019) lunar crater database, 2018-08-15 PDS4 v1.0",
                           "url": SOURCE_URL, "download": DOWNLOAD_URL, "archive": PDS_URL,
                           "doi": "https://doi.org/10.1029/2018JE005592",
                           "columns": ["LAT_CIRC_IMG", "LON_CIRC_IMG", "DIAM_CIRC_IMG"],
                           "sha256": sha256(CSV)},
                "licence": "Public-domain NASA PDS numerical data; credit Stuart J. Robbins / Southwest Research Institute and USGS Astrogeology Science Center",
                "chunks": chunks}
    write_json(OUT / "index.json", manifest)
    report = {"sourceRows": len(rows), "drawingRows": int(assigned.sum()),
              "everySourceRowExactlyOnce": bool((assigned == 1).all()),
              "chunks": len(chunks), "recordBytes": total_bytes,
              "indexBytes": (OUT / "index.json").stat().st_size,
              "largestChunkBytes": max(c["bytes"] for c in chunks),
              "maxFloat32CentreErrorM": max_centre_error_m,
              "maxFloat32DiameterErrorM": max_diameter_error_m,
              "allRegionalCapsContainTheirRims": max_cap_excess <= 1e-6,
              "retainedFileSha256": retained,
              "sourceCsvSha256": manifest["source"]["sha256"]}
    write_json(REPORT, report)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
