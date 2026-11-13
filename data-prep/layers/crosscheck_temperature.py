"""Independent cross-check of the temp-max / temp-avg layers (Diviner PRP, model
fit to 2009-2010 data) against Schorghofer & Williams' Diviner-observation maps
(Harvard Dataverse doi:10.7910/DVN/EGOOCL, polar_south_24x6, Jul 2009 - Mar 2020).
These grids are NOT used in the app; this only reports agreement.

  /Volumes/CodexWork/Projects/MOONDA/.venv-data/bin/python -I \
      /Volumes/CodexWork/Projects/MOONDA/data-prep/layers/crosscheck_temperature.py
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np  # noqa: E402
import rasterio  # noqa: E402
from rasterio.transform import Affine  # noqa: E402
from rasterio.warp import Resampling  # noqa: E402

from common import (DST_CRS, OUT, RAW, R_MOON, decode_u16, read_bin,  # noqa: E402
                    reproject_to_grid)
from check_layers import SITES, at  # noqa: E402

DV = os.path.join(RAW, "dataverse-schorghofer-williams")
XN = 0.17497729  # half-width normalised by R (from the authors' GMT script)


def load_grd(name):
    with rasterio.open(os.path.join(DV, name)) as ds:
        a = ds.read(1).astype(np.float32)
        nod = ds.nodata
    a[(a == nod) | ~np.isfinite(a) | (a > 1e30)] = np.nan
    n = a.shape[0]
    half = XN * R_MOON
    tr = Affine(2 * half / n, 0, -half, 0, -2 * half / n, half)
    return a, tr


def main():
    man = {e["id"]: e for e in json.load(open(os.path.join(OUT, "manifest.json")))}
    ours = {k: decode_u16(read_bin(os.path.join(OUT, k + ".bin")), man[k]["scale"], man[k]["offset"])
            for k in ("temp-max", "temp-avg")}
    res = {}
    for k, fname in (("temp-max", "polar_south_24x6_Tmax.grd"), ("temp-avg", "polar_south_24x6_Tmean.grd")):
        a, tr = load_grd(fname)
        best = None
        for tag, arr in (("as-read", a), ("flipud", a[::-1]), ("fliplr", a[:, ::-1]),
                         ("rot180", a[::-1, ::-1]), ("transpose", a.T)):
            g = reproject_to_grid(np.ascontiguousarray(arr), tr, DST_CRS, Resampling.bilinear)
            m = np.isfinite(g) & np.isfinite(ours[k])
            r = float(np.corrcoef(g[m], ours[k][m])[0, 1])
            print(f"{k} vs {fname} [{tag}]: r = {r:.3f}")
            if best is None or r > best[0]:
                best = (r, tag, g)
        r, tag, g = best
        m = np.isfinite(g) & np.isfinite(ours[k])
        diff = ours[k][m] - g[m]
        print(f"  best orientation {tag}: r={r:.3f}, ours-minus-theirs median {np.median(diff):.1f} K, "
              f"MAD {np.median(np.abs(diff - np.median(diff))):.1f} K")
        site_vals = {}
        for name, lat, lon, _ in SITES:
            site_vals[name] = (round(at(ours[k], lat, lon), 1), round(at(g, lat, lon), 1))
            print(f"    {name:18s} ours {site_vals[name][0]:6.1f} K   S&W {site_vals[name][1]:6.1f} K")
        res[k] = {"file": fname, "orientation": tag, "r": round(r, 3),
                  "median_diff_K": round(float(np.median(diff)), 2), "sites_ours_vs_SW": site_vals}
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "previews",
                           "temperature_crosscheck.json"), "w") as f:
        json.dump(res, f, indent=2)


if __name__ == "__main__":
    main()
