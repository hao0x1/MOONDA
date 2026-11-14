"""Build the MOONDA conservative terrain-hazard overlay without touching app data.

Run with MOONDA/.venv-data/bin/python -I features/scripts/build_danger.py.
All writes are below assets-codex/features/. No downloaded code is used.
"""
from __future__ import annotations

import csv
import hashlib
import json
import math
from pathlib import Path
import sys
import time

sys.dont_write_bytecode = True

import numpy as np
import rasterio
from PIL import Image

HERE = Path(__file__).resolve().parents[2]
PROJECT = HERE.parent
RAW = PROJECT / "data-raw"
OUT = HERE / "features/out"
DEM = RAW / "source/terrain-raw/LDEM_80S_80M.JP2"
LABEL = RAW / "pds-lola-ldem/ldem_80s_80m_jp2.lbl"
CRATERS = RAW / "usgs-robbins-craters/lunar_crater_database_robbins_2018_bundle/data/lunar_crater_database_robbins_2018.csv"
R = 1737400.0
HALF = 304000.0
N4 = 4096
DEM_URL = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/jp2/ldem_80s_80m.jp2"
SMITH = ("Smith, D.E., et al. (2010). The Lunar Orbiter Laser Altimeter investigation on the "
         "Lunar Reconnaissance Orbiter mission. Space Science Reviews 150, 209-241. "
         "doi:10.1007/s11214-009-9512-y. NASA PDS LRO-L-LOLA-4-GDR-V1.0, LDEM_80S_80M.")
ROBBINS = ("Robbins, S.J. (2019). A New Global Database of Lunar Impact Craters >1-2 km: "
           "1. Crater Locations and Sizes, Comparisons With Published Databases, and Global "
           "Analysis. Journal of Geophysical Research: Planets 124, 871-892. "
           "doi:10.1029/2018JE005592.")
SMALL = ("Marco Figuera, R., Riedel, C., Pio Rossi, A., and Unnithan, V. (2022). "
         "Depth to Diameter Analysis on Small Simple Craters at the Lunar South Pole - Possible "
         "Implications for Ice Harboring. Remote Sensing 14(3), 450. doi:10.3390/rs14030450. "
         "Dataset: Marco Figuera, R. (2021), South polar small and medium craters, Version 2, "
         "Zenodo, doi:10.5281/zenodo.5779260, CC BY 4.0.")
SMALL_FILES = [RAW / "zenodo-southpolar-small-craters" / name
               for name in ("craters_psr.csv", "craters_no_psr.csv")]


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def md5(path):
    h = hashlib.md5()
    with path.open("rb") as f:
        while block := f.read(1024 * 1024):
            h.update(block)
    return h.hexdigest()


def polar_mask(n):
    step = 2 * HALF / n
    axis = -HALF + (np.arange(n) + 0.5) * step
    radius = 2 * R * np.tan(np.deg2rad(5.0))
    return axis[:, None] ** 2 + axis[None, :] ** 2 <= radius ** 2


def horn_chunk(z, transform, first_row, last_row):
    """Identical arithmetic to existing horn_slope_deg, limited to output rows.

    `z` is the entire native DEM in physical metres. Edge padding is identical
    to the established builder. Strip processing keeps concurrent builds small.
    """
    nr, nc = z.shape
    rows = np.clip(np.arange(first_row - 1, last_row + 1), 0, nr - 1)
    zp = np.pad(z[rows, :].astype(np.float64), ((0, 0), (1, 1)), mode="edge")
    a, b, c = zp[:-2, :-2], zp[:-2, 1:-1], zp[:-2, 2:]
    d, f = zp[1:-1, :-2], zp[1:-1, 2:]
    g, h, i = zp[2:, :-2], zp[2:, 1:-1], zp[2:, 2:]
    dx = transform.a
    dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8.0 * dx)
    dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8.0 * dx)
    xs = transform.c + (np.arange(nc) + 0.5) * transform.a
    ys = transform.f + (np.arange(first_row, last_row) + 0.5) * transform.e
    k = 1.0 + (xs[None, :] ** 2 + ys[:, None] ** 2) / (2.0 * R) ** 2
    return np.degrees(np.arctan(k * np.hypot(dzdx, dzdy))).astype(np.float32)


def classify(s):
    # Exactly 25 degrees is class 2; only values greater than 25 are class 3.
    return np.where(s > 25, 3, np.where(s >= 15, 2, np.where(s >= 10, 1, 0))).astype(np.uint8)


def max_overlap(src, n):
    """Exact max over all source-cell rectangles with positive-area overlap.

    Source and destination have identical bounds and orientation. Integer ratio
    arithmetic avoids floating-point boundary errors. Unlike bilinear sampling,
    a steep source cell cannot be averaged away or skipped between centres.
    """
    nr, nc = src.shape
    cx0 = np.arange(n, dtype=np.int64) * nc // n
    cx1 = ((np.arange(n, dtype=np.int64) + 1) * nc + n - 1) // n
    ry0 = np.arange(n, dtype=np.int64) * nr // n
    ry1 = ((np.arange(n, dtype=np.int64) + 1) * nr + n - 1) // n
    width = int(np.max(cx1 - cx0))
    dst = np.empty((n, n), src.dtype)
    for row in range(n):
        strip = np.max(src[ry0[row]:ry1[row]], axis=0)
        vals = strip[cx0].copy()
        for shift in range(1, width):
            idx = cx0 + shift
            ok = idx < cx1
            vals[ok] = np.maximum(vals[ok], strip[idx[ok]])
        dst[row] = vals
    return dst


def crater_circle(lat, lon, diameter):
    """Exact stereographic image of a spherical geodesic small circle.

    The catalogued diameter is treated as a surface distance on the same lunar
    reference sphere. This is a circle approximation to a crater's rim, not a
    newly measured rim polygon or a claim that every crater is an intact bowl.
    """
    phi, lam = math.radians(lat), math.radians(lon)
    alpha = diameter * 1000.0 / (2.0 * R)
    denom = math.cos(alpha) - math.sin(phi)
    center_factor = 2.0 * R * math.cos(phi) / denom
    return (center_factor * math.sin(lam), center_factor * math.cos(lam),
            2.0 * R * math.sin(alpha) / denom)


def add_small_craters(dst):
    """Raise every target cell intersecting a catalogued 1-3 km crater to >=1."""
    n = dst.shape[0]
    step = 2 * HALF / n
    counts = {"robbins": 0, "marco_figuera": 0}
    mask = np.zeros(dst.shape, bool)
    def records():
        with CRATERS.open(newline="") as f:
            for row in csv.DictReader(f):
                yield ("robbins", float(row["LAT_CIRC_IMG"]),
                       float(row["LON_CIRC_IMG"]), float(row["DIAM_CIRC_IMG"]))
        # The saved Zenodo metadata establishes redistribution rights for both
        # CSVs. Work from the exact decimal source values, not encoded Float32.
        record = json.loads((HERE / "features/downloads/small-craters-zenodo-5779260.json").read_text())
        assert record["id"] == 5779260 and record["metadata"]["license"]["id"] == "cc-by-4.0"
        for path in SMALL_FILES:
            info = next(f for f in record["files"] if f["key"] == path.name)
            assert "md5:" + md5(path) == info["checksum"]
            with path.open(newline="") as f:
                for row in csv.DictReader(f, skipinitialspace=True):
                    yield ("marco_figuera", float(row["y"]), float(row["x"]), float(row["Diam_km"]))
    for catalogue, lat, lon, diameter in records():
            if not (1 <= diameter <= 3 and lat <= -79.9):
                continue
            x, y, radius = crater_circle(lat, lon, diameter)
            c0 = max(0, int(math.floor((x - radius + HALF) / step)))
            c1 = min(n, int(math.floor((x + radius + HALF) / step)) + 1)
            r0 = max(0, int(math.floor((HALF - y - radius) / step)))
            r1 = min(n, int(math.floor((HALF - y + radius) / step)) + 1)
            if c1 <= c0 or r1 <= r0:
                continue
            xs = -HALF + (np.arange(c0, c1) + 0.5) * step
            ys = HALF - (np.arange(r0, r1) + 0.5) * step
            # Minimum distance from a circle centre to each closed cell box.
            dx = np.maximum(np.abs(xs - x) - step / 2, 0)
            dy = np.maximum(np.abs(ys - y) - step / 2, 0)
            inside = dx[None, :] ** 2 + dy[:, None] ** 2 <= radius ** 2
            mask[r0:r1, c0:c1] |= inside
            counts[catalogue] += 1
    raised = mask & (dst == 0)
    dst[mask] = np.maximum(dst[mask], 1)
    return counts, mask, raised


def validate_math():
    # Verify our strip optimization is bit-identical to the existing method.
    sys.path.insert(0, str(PROJECT / "data-prep/layers"))
    from build_layers import horn_slope_deg
    from rasterio.transform import Affine
    rng = np.random.default_rng(153)
    z = rng.normal(0, 1000, (17, 19)).astype(np.float32)
    tr = Affine(80, 0, -304000, 0, -80, 304000)
    whole = horn_slope_deg(z, tr)
    strips = np.vstack([horn_chunk(z, tr, row, min(row + 4, z.shape[0]))
                        for row in range(0, z.shape[0], 4)])
    assert np.array_equal(whole, strips), "Horn strip math differs from established builder"
    # Verify conservative overlap on an incommensurate small source/destination.
    test = rng.integers(0, 4, (13, 13), dtype=np.uint8)
    got = max_overlap(test, 7)
    want = np.empty((7, 7), np.uint8)
    for r in range(7):
        for c in range(7):
            vals = [test[sr, sc] for sr in range(13) for sc in range(13)
                    if min((r+1)*13/7, sr+1) > max(r*13/7, sr)
                    and min((c+1)*13/7, sc+1) > max(c*13/7, sc)]
            want[r, c] = max(vals)
    assert np.array_equal(got, want), "Worst-overlap aggregation failed brute-force check"
    assert classify(np.array([9.999, 10, 14.999, 15, 25, 25.001])).tolist() == [0, 1, 1, 2, 2, 3]
    return {"horn_bit_identical_to_existing_builder": True,
            "max_overlap_matches_bruteforce": True, "threshold_boundaries_pass": True}


def manifest():
    return {
        "id": "danger", "title": "Steep ground",
        "shortHelp": "Yellow means take care, orange is steep, and red is over 25 degrees. Small crater bowls also get a warning. This cannot show every driving hazard.",
        "units": "0 = no mapped warning; 1 = caution; 2 = steep; 3 = too steep to drive",
        "scale": 1, "offset": 0, "valueMin": 0, "valueMax": 3,
        "legend": [{"value": 0, "color": "#00000000"},
                   {"value": 1, "color": "#f5c83c"},
                   {"value": 2, "color": "#f58228"},
                   {"value": 3, "color": "#e63232"}],
        "source": {"name": "LRO LOLA LDEM_80S_80M.JP2; Robbins lunar_crater_database_robbins_2018.csv; Marco Figuera craters_psr.csv and craters_no_psr.csv",
                   "url": DEM_URL, "citation": SMITH + " " + ROBBINS + " " + SMALL,
                   "version": "LOLA JP2 V2.1, 2017-06-15, 80 m/pixel; Robbins PDS4 2018 release; Marco Figuera Zenodo 5779260 v2. LOLA/Robbins NASA PDS public-domain data; small catalogue CC BY 4.0."},
        "notes": "Source files: data-raw/source/terrain-raw/LDEM_80S_80M.JP2 (height DN x 0.5 m), data-raw/usgs-robbins-craters/lunar_crater_database_robbins_2018_bundle/data/lunar_crater_database_robbins_2018.csv (LAT_CIRC_IMG, LON_CIRC_IMG, DIAM_CIRC_IMG), and data-raw/zenodo-southpolar-small-craters/craters_psr.csv and craters_no_psr.csv (y latitude, x longitude, Diam_km). Horn 3x3 slope at native 80 m, corrected by k=1+(rho/(2*1737400))^2 exactly as the existing builder. Worst class among all native source-cell footprints overlapping each target cell; 10 <= slope < 15 deg is class 1, 15 <= slope <= 25 is class 2, >25 is class 3. Every cell intersecting a catalogued 1-3 km circular crater interior is at least class 1, a conservative bowl warning without a measured slope claim. PNG is 4096; BIN is 2048, Uint16 LE, worst of each 2x2 PNG-grid class block, 65535 outside 80 S. Classification is a project display rule, not a rover-specific mobility limit or a safe-route certification: class 0 only means no mapped warning. Horn's ~240 m baseline smooths local slopes; boulders, small craters and hazards smaller than about 80 m are unresolved. Credits: NASA/GSFC/MIT LOLA team, NASA PDS, Stuart J. Robbins / SwRI / USGS Astrogeology, Marco Figuera et al. Licence evidence: https://pds-geosciences.wustl.edu/faq.html (public domain), https://science.data.nasa.gov/about/license (NASA science data policy), https://zenodo.org/records/5779260 (CC BY 4.0, https://creativecommons.org/licenses/by/4.0/). Robbins product https://astrogeology.usgs.gov/search/map/moon_crater_database_v1_robbins ; detailed source sizes/MD5 are in features/NOTES.md."}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    tests = validate_math()
    log("Danger math checks passed")
    with rasterio.open(DEM) as ds:
        assert ds.shape == (7600, 7600)
        assert tuple(ds.transform)[:6] == (80.0, 0.0, -HALF, 0.0, -80.0, HALF)
        tr = ds.transform
        z = ds.read(1).astype(np.float32) * np.float32(0.5)
    native = np.empty(z.shape, np.uint8)
    slope_min, slope_max = float("inf"), -float("inf")
    for row in range(0, z.shape[0], 256):
        end = min(z.shape[0], row + 256)
        slopes = horn_chunk(z, tr, row, end)
        native[row:end] = classify(slopes)
        slope_min = min(slope_min, float(slopes.min()))
        slope_max = max(slope_max, float(slopes.max()))
    del z, slopes
    log("Native Horn slope range", slope_min, slope_max)
    d4 = max_overlap(native, N4)
    del native
    count, crater_mask, raised = add_small_craters(d4)
    valid4 = polar_mask(N4)
    before_masked = int(np.count_nonzero(raised & valid4))
    crater_area = int(np.count_nonzero(crater_mask & valid4))
    del crater_mask, raised
    d2 = d4.reshape(2048, 2, 2048, 2).max(axis=(1, 3)).astype("<u2")
    valid2 = polar_mask(2048)
    d2[~valid2] = 65535
    d2.tofile(OUT / "danger.bin")
    colors = np.array([[0, 0, 0, 0], [245, 200, 60, 120],
                       [245, 130, 40, 150], [230, 50, 50, 175]], np.uint8)
    rgba = colors[d4]
    rgba[~valid4] = 0
    Image.fromarray(rgba).save(OUT / "danger.png", optimize=True, compress_level=9)
    entry = manifest()
    (OUT / "danger-manifest.json").write_text(json.dumps(entry, indent=2) + "\n")
    histogram = {str(v): {"count": int(np.count_nonzero(d2 == v)),
                          "percent_valid": float(np.count_nonzero(d2 == v) / np.count_nonzero(valid2) * 100)}
                 for v in range(4)}
    urls = [DEM_URL, DEM_URL.replace(".jp2", ".lbl"),
            "https://astrogeology.usgs.gov/ckan/dataset/f89f5478-b69a-486c-b9b5-30d7b0c5ad2b/resource/c4f25cc2-4f8a-4207-a845-5e176da3ac5a/download/lunar_crater_database_robbins_2018",
            "https://zenodo.org/records/5779260/files/craters_psr.csv",
            "https://zenodo.org/records/5779260/files/craters_no_psr.csv"]
    source_files = [{"path": str(p.relative_to(PROJECT)), "url": url,
                     "bytes": p.stat().st_size, "md5": md5(p)}
                    for p, url in zip((DEM, LABEL, CRATERS, *SMALL_FILES), urls)]
    report = {"math_checks": tests, "native_slope_range_deg": [slope_min, slope_max],
              "native_shape": [7600, 7600], "native_pixel_m": 80,
              "craters_1_to_3_km_considered_in_map_square": count,
              "crater_warning_pixels_4096_inside80S": crater_area,
              "pixels_4096_raised_from0_to1_inside80S": before_masked,
              "histogram2048": histogram, "sources": source_files,
              "output_bytes": {p.name: p.stat().st_size for p in [OUT / "danger.bin", OUT / "danger.png"]}}
    (OUT / "danger-build-report.json").write_text(json.dumps(report, indent=2) + "\n")
    log(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
