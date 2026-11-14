"""Build exact area-weighted PSR fractions from the native 20 m base pixels.

Run with MOONDA/.venv-data/bin/python -I; all generated files stay in assets-codex.
No GDAL overviews are used: every base-resolution pixel is read in strips.
"""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True
import numpy as np
import rasterio
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT.parent
OUT = ROOT / "features/out"
URL = "https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LPSR_80S_20MPP_ADJ.TIF"
SOURCE = ROOT / "features/downloads/psr-complete/LPSR_80S_20MPP_ADJ.TIF"
CITATION = ("Barker, M.K., Mazarico, E., Neumann, G.A., Smith, D.E., Zuber, M.T., "
            "Head, J.W., Sun, X. (2023). A New View of the Lunar South Pole from the "
            "Lunar Orbiter Laser Altimeter (LOLA). The Planetary Science Journal 4, 183. "
            "doi:10.3847/PSJ/acf3e1. Data doi:10.60903/gsfcpgda-lola-spole.")
LICENCE = ("NASA-led LRO mission data, CC0 default under https://science.data.nasa.gov/about/license; "
           "PGDA requests citation of Barker et al. (2023). Credit NASA/GSFC/LOLA team. "
           "No NASA endorsement is implied.")


def save_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def inside(n):
    res = 608000.0 / n
    x = -304000.0 + (np.arange(n) + .5) * res
    rho80 = 2 * 1737400.0 * np.tan(np.radians(5))
    return x[None, :]**2 + x[::-1, None]**2 <= rho80**2


def base_pixel_average(path, n=4096):
    """Exact planar overlap, treating the published 0/1 pixels as constant cells.

    Horizontal cumulative integrals are evaluated at fractional target edges.
    Each source row is split between at most two target rows. NaN source cells
    count as zero for the full-cell fraction, and validity is tracked separately.
    """
    total = np.zeros((n, n), dtype=np.float64)
    valid = np.zeros_like(total)
    with rasterio.open(path) as ds:
        assert (ds.width, ds.height) == (30400, 30400)
        assert tuple(ds.transform)[:6] == (20., 0., -304000., 0., -20., 304000.)
        assert abs(ds.crs.ellipsoid.semi_major_metre - 1737400.) < 1e-6 if hasattr(ds.crs, 'ellipsoid') else True
        wkt = ds.crs.to_wkt()
        assert '1737400' in wkt and 'Polar_Stereographic' in wkt
        ratio = ds.width / n
        edges = np.arange(n + 1, dtype=np.float64) * ratio
        ix = np.minimum(np.floor(edges).astype(int), ds.width - 1)
        frac = edges - ix
        # At right edge ix=width-1, fraction=1 exactly.
        for top in range(0, ds.height, 128):
            a = ds.read(1, window=((top, min(top + 128, ds.height)), (0, ds.width)))
            good = np.isfinite(a)
            if np.any(good & (a != 0) & (a != 1)):
                raise ValueError("Native PSR base pixels must be 0, 1, or NaN")
            a = np.where(good, a, 0)
            for src, dst in ((a, total), (good, valid)):
                cum = np.empty((a.shape[0], ds.width + 1), dtype=np.float64)
                cum[:, 0] = 0
                np.cumsum(src, axis=1, dtype=np.float64, out=cum[:, 1:])
                at_edges = cum[:, ix] + src[:, ix] * frac
                horizontal = np.diff(at_edges, axis=1)
                for local, row in enumerate(range(top, top + a.shape[0])):
                    target = int(row / ratio)
                    split = min(row + 1., (target + 1) * ratio)
                    dst[target] += horizontal[local] * (split - row)
                    if split < row + 1.:
                        dst[target + 1] += horizontal[local] * (row + 1. - split)
            if top % 2048 == 0:
                print(f"20 m base pixels: rows {top}..{top+a.shape[0]}", flush=True)
    return (total / ratio**2).astype(np.float32), (valid / ratio**2).astype(np.float32)


def main():
    OUT.mkdir(exist_ok=True, parents=True)
    if not SOURCE.exists():
        raise SystemExit("Run features/scripts/download_psr.py first: complete native TIFF required")
    p4096, valid4096 = base_pixel_average(SOURCE)
    assert np.all((p4096 >= 0) & (p4096 <= 1))
    m4096 = inside(4096)
    p2048 = p4096.reshape(2048, 2, 2048, 2).mean(axis=(1, 3))
    valid2048 = valid4096.reshape(2048, 2, 2048, 2).mean(axis=(1, 3))
    m2048 = inside(2048)
    rgba = np.zeros((4096, 4096, 4), dtype=np.uint8)
    rgba[..., :3] = (72, 140, 220)
    rgba[..., 3] = np.where(m4096, np.rint(200 * p4096), 0).astype(np.uint8)
    rgba[rgba[..., 3] == 0, :3] = 0
    Image.fromarray(rgba).save(OUT / "psr.png", optimize=True)
    raw = np.where(m2048, np.rint(p2048 * 10000), 65535).astype('<u2')
    raw.tofile(OUT / "psr.bin")
    # Retain exact fractions for native-resolution water-ice rendering and checks.
    np.save(OUT / "psr-fraction-4096.npy", p4096, allow_pickle=False)
    old = np.fromfile(PROJECT / "app/public/data/layers/ice.bin", '<u2').reshape(2048, 2048)
    mask = m2048 & (old != 65535)
    old_on, new_on = old == 1, raw >= 5000
    new_on &= raw != 65535
    tp = int(np.sum(mask & old_on & new_on))
    fp = int(np.sum(mask & ~old_on & new_on))
    fn = int(np.sum(mask & old_on & ~new_on))
    tn = int(np.sum(mask & ~old_on & ~new_on))
    md5 = hashlib.md5()
    with SOURCE.open('rb') as f:
        for b in iter(lambda: f.read(8*1024*1024), b''):
            md5.update(b)
    report = {
        "source": {"file": str(SOURCE.relative_to(ROOT)), "url": URL,
                   "size": SOURCE.stat().st_size, "md5": md5.hexdigest()},
        "grid": {"extentM": [-304000, -304000, 304000, 304000], "binN": 2048, "pngN": 4096},
        "nativeValidMinimumInside80S": float(valid2048[m2048].min()),
        "comparison": {"rule": "psr.bin >= 50% versus existing ice.bin == 1; inside80S and both valid",
                       "cells": int(mask.sum()), "tp": tp, "fp": fp, "fn": fn, "tn": tn,
                       "agreementPercent": 100*(tp+tn)/mask.sum(),
                       "intersectionOverUnionPercent": 100*tp/(tp+fp+fn),
                       "recallOfOldPsrPercent": 100*tp/(tp+fn)},
        "coverage": {"meanPermanentShadowPercent": float(p2048[m2048].mean()*100),
                     "cellsWithAnyPsrPercent": float(np.mean(raw[m2048]>0)*100),
                     "majorityPsrCellsPercent": float(np.mean(raw[m2048]>=5000)*100)}}
    save_json(OUT / "psr-build-report.json", report)
    manifest = {"id": "psr", "title": "Permanent shadow", "shortHelp":
        "Blue patches never get direct sunlight. Darker blue means more of that square is in shadow. "
        "These are cold traps where ice could last; this is not a map of measured ice.",
        "units": "%", "scale": .01, "offset": 0, "valueMin": 0, "valueMax": 100,
        "legend": [{"value": 0, "color": "#488cdc00"}, {"value": 100, "color": "#488cdcc8"}],
        "source": {"name": "NASA GSFC LOLA LPSR_80S_20MPP_ADJ.TIF, 20 m permanent-shadow map",
                   "url": URL, "citation": CITATION,
                   "version": "PGDA product90; data DOI10.60903/gsfcpgda-lola-spole; primary TIFF Last-Modified2023-06-03"},
        "notes": "Source file LPSR_80S_20MPP_ADJ.TIF. " + LICENCE +
        " Exact area-weighted averages of native20m pixels (no COG overviews):4096PNG alpha=round(200*fraction), "
        "2048BIN raw=round(10000*fraction), decode raw*0.01 percent. Native source uses the same sphere, "
        "pole, axes,20m cell edges and608km extent as the app. Outside80S is nodata65535/transparent. "
        "Cell fractions use the full map-plane cell area, with source nodata contributing zero; "
        "pixel centres decide the80S mask. This2023 adjusted terrain model differs from the old2016 "
        "240m map, especially at small shadows. " +
        f"Majority-shadow agreement with ice.bin={report['comparison']['agreementPercent']:.3f}%; "
        f"PSR intersection-over-union={report['comparison']['intersectionOverUnionPercent']:.3f}%."}
    save_json(OUT / "psr-manifest.json", manifest)
    (ROOT / 'features/psr-NOTES.md').write_text(
        '# Permanent shadow\n\n' + CITATION + '\n\n' + LICENCE + '\n\n' +
        'Primary product and usage policy: https://pgda.gsfc.nasa.gov/products/90\n\n' +
        manifest['notes'] + '\n\nSource integrity and agreement:\n```json\n' +
        json.dumps(report, indent=2) + '\n```\n\n' +
        'The read-only supplied TIFF is truncated at4,493,312bytes and fails native tile reads. '
        'It was left untouched; a complete primary-source replacement is stored inside assets-codex.\n')
    print(json.dumps(report, indent=2), flush=True)


if __name__ == '__main__':
    main()
