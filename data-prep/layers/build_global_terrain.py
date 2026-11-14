"""Make compact whole-Moon slope and danger maps from NASA LOLA LDEM_64.

Run from any directory with MOONDA/.venv-data/bin/python -I this-file.py.
Use --download to fetch the source into its own data-raw folder first.
Downloaded files are read as data; none are imported or executed.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
import time
import urllib.request

import numpy as np
from PIL import Image

PROJECT = Path(__file__).resolve().parents[2]
RAW = PROJECT / "data-raw/pds-lola-global-ldem64"
OUT = PROJECT / "app/public/data/layers"
BASE_URL = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/"
CRATERS = PROJECT / "data-raw/usgs-robbins-craters/lunar_crater_database_robbins_2018_bundle/data/lunar_crater_database_robbins_2018.csv"
R = 1737400.0
PPD = 64
NW, NH = 23040, 11520
W, H = 8192, 4096
STEP = math.pi * R / (180 * PPD)
SLOPE_STOPS = [(0, "#1a9850"), (5, "#66bd63"), (10, "#a6d96a"),
               (15, "#fee08b"), (20, "#fdae61"), (25, "#f46d43"), (30, "#d73027")]


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        while block := f.read(1024 * 1024):
            h.update(block)
    return h.hexdigest()


def classify(s):
    # 25 degrees belongs to orange; red starts above 25 degrees.
    return np.where(s > 25, 3, np.where(s >= 15, 2, np.where(s >= 10, 1, 0))).astype(np.uint8)


def sample(z, latitude, longitude):
    """Bilinear native DEM heights, with periodic longitude and polar edge rows."""
    rr = np.clip((90 - np.rad2deg(latitude)) * PPD - 0.5, 0, NH - 1)
    cc = ((np.rad2deg(longitude) % 360) * PPD - 0.5) % NW
    r0 = np.floor(rr).astype(np.int32)
    c0 = np.floor(cc).astype(np.int32)
    r1, c1 = np.minimum(r0 + 1, NH - 1), (c0 + 1) % NW
    dr, dc = rr - r0, cc - c0
    # DN units are half a metre. The reference sphere cancels in differences.
    return ((z[r0, c0] * (1-dc) + z[r0, c1] * dc) * (1-dr)
            + (z[r1, c0] * (1-dc) + z[r1, c1] * dc) * dr) * 0.5


def horn_strip(z, first, last):
    """Horn's 3x3 stencil sampled in local ground directions on the sphere.

    An ordinary equirectangular 3x3 stencil collapses east/west near a pole.
    These great-circle offsets keep both ground baselines 2*STEP metres long.
    Source heights are still the real interpolated LDEM_64, not new detail.
    """
    phi = np.deg2rad(90 - (np.arange(first, last)[:, None] + 0.5) / PPD)
    lam = np.deg2rad((np.arange(NW)[None, :] + 0.5) / PPD)
    sp, cp = np.sin(phi), np.cos(phi)
    def at(east, north):
        q = math.hypot(east, north)
        delta = STEP * q / R
        sd, cd = math.sin(delta), math.cos(delta)
        p = np.arcsin(np.clip(cd * sp + sd * north / q * cp, -1, 1))
        dl = np.arctan2(sd * east / q, cd * cp - sd * north / q * sp)
        return sample(z, p, lam + dl)
    a, b, c = at(-1, 1), at(0, 1), at(1, 1)
    d, f = at(-1, 0), at(1, 0)
    g, h, i = at(-1, -1), at(0, -1), at(1, -1)
    dx = ((c + 2*f + i) - (a + 2*d + g)) / (8*STEP)
    dy = ((a + 2*b + c) - (g + 2*h + i)) / (8*STEP)
    return np.rad2deg(np.arctan(np.hypot(dx, dy))).astype(np.float32)


def worst_overlap(src):
    """Keep the worst class of every native cell touching an output cell."""
    c0 = np.arange(W, dtype=np.int64) * NW // W
    c1 = ((np.arange(W, dtype=np.int64) + 1) * NW + W - 1) // W
    r0 = np.arange(H, dtype=np.int64) * NH // H
    r1 = ((np.arange(H, dtype=np.int64) + 1) * NH + H - 1) // H
    result = np.empty((H, W), np.uint8)
    for row in range(H):
        strip = np.max(src[r0[row]:r1[row]], axis=0)
        best = strip[c0].copy()
        for shift in range(1, int(np.max(c1-c0))):
            idx = c0 + shift
            ok = idx < c1
            best[ok] = np.maximum(best[ok], strip[idx[ok]])
        result[row] = best
    return result


def add_crater_bowls(dst):
    """At least yellow in cells intersecting measured 1-3 km circular interiors.

    This is a conservative warning, not a claim about a crater's exact shape,
    present-day condition or slope. Only the source's circular-fit diameters
    are used. A spherical circle/latitude-longitude cell intersection avoids
    painting a full ellipse at the date line or poles.
    """
    count, raised = 0, 0
    with CRATERS.open(newline="") as f:
        for rec in csv.DictReader(f):
            diameter = float(rec["DIAM_CIRC_IMG"])
            if not 1 <= diameter <= 3:
                continue
            lat = float(rec["LAT_CIRC_IMG"])
            lon = (float(rec["LON_CIRC_IMG"]) + 180) % 360 - 180
            phi = math.radians(lat)
            alpha = diameter * 1000 / (2*R)
            dlat = math.degrees(alpha)
            if abs(phi) + alpha >= math.pi/2:
                dlon = 180
            else:
                dlon = math.degrees(math.asin(min(1, math.sin(alpha)/math.cos(phi))))
            row0 = max(0, math.floor((90 - min(90, lat+dlat)) * H/180))
            row1 = min(H, math.floor((90 - max(-90, lat-dlat)) * H/180) + 1)
            col0 = math.floor((lon-dlon+180) * W/360)
            col1 = math.floor((lon+dlon+180) * W/360) + 1
            cols = np.arange(col0, min(col1, col0+W), dtype=np.int64)
            rows = np.arange(row0, row1, dtype=np.int64)
            if not len(rows) or not len(cols):
                continue
            # Closest longitude within each cell to the crater centre.
            cl = -180 + cols * 360/W
            dl = np.deg2rad(np.maximum(np.maximum(cl-lon, lon-(cl+360/W)), 0))
            cosdl = np.cos(dl)
            optimum = np.arctan2(math.sin(phi), math.cos(phi)*cosdl)
            top = np.deg2rad(90 - rows * 180/H)
            bottom = top - math.pi/H
            closest = np.clip(optimum[None, :], bottom[:, None], top[:, None])
            dot = (math.sin(phi)*np.sin(closest)
                   + math.cos(phi)*np.cos(closest)*cosdl[None, :])
            inside = dot >= math.cos(alpha)
            rr, cc = np.nonzero(inside)
            rr, cc = rows[rr], cols[cc] % W
            raised += int(np.count_nonzero(dst[rr, cc] == 0))
            dst[rr, cc] = np.maximum(dst[rr, cc], 1)
            count += 1
    return count, raised


def crater_mask():
    """Reuse the measured-crater raster while retrying a slow DEM download."""
    RAW.mkdir(parents=True, exist_ok=True)
    path, info = RAW/"crater-bowl-codes.u8", RAW/"crater-bowl-codes.json"
    signature = {"sourceSha256":digest(CRATERS), "width":W, "height":H, "radiusM":R,
                 "method":"spherical-circle-cell-intersection-v1", "minDiameterKm":1, "maxDiameterKm":3}
    if path.exists() and path.stat().st_size == W*H and info.exists():
        saved = json.loads(info.read_text())
        if all(saved.get(k) == v for k,v in signature.items()):
            return np.memmap(path, mode="r", dtype=np.uint8, shape=(H,W)), saved["craterCount"]
    mask = np.memmap(path, mode="w+", dtype=np.uint8, shape=(H,W))
    mask[:] = 0
    count, _ = add_crater_bowls(mask)
    mask.flush()
    info.write_text(json.dumps({**signature,"craterCount":count},indent=2)+"\n")
    return mask, count


def palette():
    values = np.arange(256) / 4
    x = [v for v, _ in SLOPE_STOPS]
    rgb = np.array([[int(c[i:i+2], 16) for i in (1,3,5)] for _, c in SLOPE_STOPS])
    colors = np.column_stack([np.rint(np.interp(values, x, rgb[:, ch])).astype(np.uint8) for ch in range(3)])
    p = ["#" + "".join(f"{v:02x}" for v in c) + "ff" for c in colors]
    p[255] = "#00000000"
    return p


def check_math():
    assert classify(np.array([9.999,10,14.999,15,25,25.001])).tolist() == [0,1,1,2,2,3]
    # A constant-height sphere has zero slope, including at the poles and seam.
    class Constant:
        def __getitem__(self, ix):
            return np.zeros(np.broadcast_shapes(ix[0].shape, ix[1].shape), np.int16)
    for row in (0, NH//2, NH-1):
        assert np.count_nonzero(horn_strip(Constant(), row, row+1)) == 0
    # z = R*sin(latitude) has a known local northward gradient cos(latitude).
    # This catches an incorrect half-metre DN scale or stencil denominator.
    class LatitudeRamp:
        def __getitem__(self, ix):
            phi = np.deg2rad(90 - (ix[0] + 0.5)/PPD)
            return np.broadcast_to(2*R*np.sin(phi), np.broadcast_shapes(ix[0].shape, ix[1].shape))
    for row in (NH//2, NH//6):
        phi = math.radians(90-(row+0.5)/PPD)
        expected = math.degrees(math.atan(math.cos(phi)))
        assert np.max(np.abs(horn_strip(LatitudeRamp(),row,row+1)-expected)) < 0.01
    return {"class_thresholds": True, "constant_sphere_including_poles": True,
            "analytic_latitude_ramp": True}


def main():
    args = argparse.ArgumentParser()
    args.add_argument("--download", action="store_true")
    opt = args.parse_args()
    RAW.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    if opt.download:
        for name in ("ldem_64.lbl", "ldem_64.img"):
            dest = RAW/name
            if not dest.exists():
                log("Downloading", name)
                urllib.request.urlretrieve(BASE_URL+name, dest)
    image = RAW/"ldem_64.img"
    assert image.stat().st_size == NW*NH*2, "LDEM_64 has an unexpected byte count"
    label = (RAW/"ldem_64.lbl").read_text()
    for needle in ('"LDEM_64"', '"V3.1"', 'SCALING_FACTOR        = 0.5'):
        assert needle in label, f"Unexpected PDS label: missing {needle}"
    checks = check_math()
    dem = np.memmap(image, mode="r", dtype="<i2", shape=(NH,NW))
    height_codes = [int(dem.min()), int(dem.max())]
    # The registered IMG's extrema lie slightly inside the label's bounds.
    # Keep both in the report; do not silently treat metadata as pixel values.
    assert -18251 <= height_codes[0] < height_codes[1] <= 21546, "Height codes exceed the V3.1 PDS label's range"
    checks["height_range_within_pds_label_bounds"] = True
    codes = np.memmap(RAW/"slope-native-codes.u8", mode="w+", dtype=np.uint8, shape=(NH,NW))
    dangers = np.memmap(RAW/"danger-native-codes.u8", mode="w+", dtype=np.uint8, shape=(NH,NW))
    low, high, clipped = 90.0, 0.0, 0
    for first in range(0, NH, 32):
        last = min(first+32, NH)
        slopes = horn_strip(dem, first, last)
        codes[first:last] = np.minimum(np.rint(slopes*4), 254).astype(np.uint8)
        dangers[first:last] = classify(slopes)
        low, high = min(low,float(slopes.min())), max(high,float(slopes.max()))
        clipped += int(np.count_nonzero(slopes > 63.5))
        if first % 1024 == 0:
            log("Native slopes", first, "/", NH)
    codes.flush()
    dangers.flush()
    # BOX averages native raster cells overlapping each output raster pixel.
    # This is a regional slope picture, not the steepest subpixel ground.
    slope = Image.fromarray(codes).resize((W,H), Image.Resampling.BOX)
    slope = np.roll(np.asarray(slope), W//2, axis=1).copy()
    danger = np.roll(worst_overlap(dangers), W//2, axis=1).copy()
    log("Adding measured small-crater interiors")
    bowls, crater_count = crater_mask()
    raised = int(np.count_nonzero((bowls > 0) & (danger == 0)))
    np.maximum(danger, bowls, out=danger)
    Image.fromarray(slope).save(OUT/"slope-global-values.png", optimize=True, compress_level=9)
    Image.fromarray(danger).save(OUT/"danger-global-values.png", optimize=True, compress_level=9)
    meta = {
        "projection": "global", "width": W, "height": H,
        "west": -180, "east": 180, "north": 90, "south": -90,
        "source": {"name": "NASA LRO LOLA LDEM_64 V3.1", "url": BASE_URL+"ldem_64.img",
                   "labelUrl": BASE_URL+"ldem_64.lbl", "nativeWidth": NW, "nativeHeight": NH,
                   "nativePixelLatitudeM": STEP, "date": "2019-03-15"},
        "slope": {"url": "slope-global-values.png", "scale": 0.25, "offset": 0,
                  "nodata": 255, "clippedAboveDeg": 63.5, "palette": palette(),
                  "baselineOuterCentresM": 2*STEP, "stencilFootprintM": 3*STEP,
                  "resampling": "Mean of native quarter-degree slope codes in each output raster cell"},
        "danger": {"url": "danger-global-values.png", "scale": 1, "offset": 0, "nodata": 255,
                   "palette": ["#00000000", "#f5c83c78", "#f5822896", "#e63232af"] + ["#00000000"]*252,
                   "classes": {"0": "No mapped warning", "1": "10 to under 15 degrees, or a catalogued 1 to 3 km crater bowl",
                               "2": "15 to 25 degrees", "3": "Over 25 degrees"},
                   "resampling": "Worst class of every native cell with positive-area overlap"},
        "limits": "Regional slopes from interpolated orbital heights; not wheel-scale slopes. The 8192 by 4096 picture has about 1.33 km pixels in latitude, shrinking east/west with latitude. The north pole remains coarser than the retained sharp 80 m south-polar product. Crater interiors are circular-fit caution areas, not measured bowl outlines. No warning does not mean safe ground.",
    }
    (OUT/"global-terrain.json").write_text(json.dumps(meta, indent=2)+"\n")
    spots = {}
    for name,lat,lon in [("Apollo 11",0.674,23.473),("Tycho",-43.31,-11.36),("North pole",89.9,0),("South pole",-89.9,0)]:
        rr = min(H-1,max(0,int((90-lat)*H/180)))
        cc = int((lon+180)*W/360)%W
        spots[name] = {"lat":lat,"lon":lon,"slopeDeg":float(slope[rr,cc])*0.25,"danger":int(danger[rr,cc])}
    report = {"checks": checks, "nativeHeightCodeRange": height_codes,
              "pdsLabelHeightCodeBounds": [-18251, 21546],
              "nativeSlopeRangeDeg": [low,high], "nativeClippedPixels":clipped,
              "craters1to3Km":crater_count,"outputPixelsRaisedByCraterWarnings":raised,
              "spots":spots,"histograms":{"slopeCodes":np.bincount(slope.ravel(),minlength=256).tolist(),
                                           "dangerCodes":np.bincount(danger.ravel(),minlength=4).tolist()},
              "sources":[{"path":str(p.relative_to(PROJECT)),"bytes":p.stat().st_size,"sha256":digest(p)}
                         for p in (image,RAW/"ldem_64.lbl",CRATERS)],
              "outputs":{p.name:{"bytes":p.stat().st_size,"sha256":digest(p)}
                         for p in (OUT/"slope-global-values.png",OUT/"danger-global-values.png",OUT/"global-terrain.json")}}
    (OUT/"global-terrain-report.json").write_text(json.dumps(report,indent=2)+"\n")
    log(json.dumps({"spots":spots,"craters":crater_count,"outputs":report["outputs"]},indent=2))


if __name__ == "__main__":
    main()
