"""Validate MOONDA layer outputs, spot-check known sites, test orientation and
render previews into data-prep/layers/previews/.

  /Volumes/CodexWork/Projects/MOONDA/.venv-data/bin/python -I \
      /Volumes/CodexWork/Projects/MOONDA/data-prep/layers/check_layers.py
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np  # noqa: E402
import rasterio  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from common import (  # noqa: E402
    N, NODATA_U16, OUT, PREVIEWS, RAW, RES, decode_u16, hillshade, latlon_to_xy,
    read_bin, save_json, xy_to_pixel,
)

SITES = [
    # name, lat, lon(E), expectation. Crater centres = IAU/USGS Gazetteer
    # (MOON_nomenclature_center_pts); ridge and Malapert summit from the brief.
    ("Shackleton floor", -89.67, 129.78, "~0% sun, PSR, very cold"),
    ("Connecting ridge", -89.45, 222.7, "highly lit (~70-90%)"),
    ("Malapert summit", -86.0, 2.9, "Earth visible most of the time"),
    ("Haworth floor", -87.45, -5.17, "PSR, cold; up, slightly left"),
    ("Amundsen floor", -84.44, 83.07, "right of pole"),
    ("Faustini floor", -87.18, 84.31, "PSR, cold"),
    ("Shoemaker floor", -88.14, 45.91, "PSR, cold"),
    ("Cabeus floor", -85.33, -42.13, "partly PSR (LCROSS impact crater)"),
    ("de Gerlache floor", -88.48, -88.34, "PSR"),
]
CRATERS = [("Shackleton", -89.67, 129.78, 20.9e3), ("Haworth", -87.45, -5.17, 51.4e3),
           ("Faustini", -87.18, 84.31, 42.5e3), ("Shoemaker", -88.14, 45.91, 51.8e3),
           ("Cabeus", -85.33, -42.13, 100.6e3), ("de Gerlache", -88.48, -88.34, 32.7e3)]


def load(manifest):
    vals = {}
    for e in manifest:
        u = read_bin(os.path.join(OUT, e["id"] + ".bin"))
        vals[e["id"]] = decode_u16(u, e["scale"], e["offset"])
    return vals


def at(v, lat, lon, half=0):
    x, y = latlon_to_xy(lat, lon)
    c, r = xy_to_pixel(x, y)
    c, r = int(round(float(c))), int(round(float(r)))
    if half == 0:
        return float(v[r, c])
    w = v[r - half:r + half + 1, c - half:c + half + 1]
    return float(np.nanmin(w)), float(np.nanmax(w))


def source_sample(stem, lat, lon, radius_m=0.0):
    """Value at the native 240 m LOLA product (fraction*100), plus max within radius."""
    lbl = os.path.join(RAW, "pds-lola-illumination", stem + ".lbl")
    x, y = latlon_to_xy(lat, lon)
    with rasterio.open(lbl) as ds:
        r, c = ds.index(float(x), float(y))
        h = int(np.ceil(radius_m / ds.res[0]))
        w = ds.read(1, window=((r - h, r + h + 1), (c - h, c + h + 1))).astype(float)
        sc = ds.scales[0] * 100
        return float(w[h, h] * sc), float(w.max() * sc)


def validate(manifest):
    problems = []
    need = ["id", "title", "shortHelp", "units", "scale", "offset", "valueMin", "valueMax",
            "legend", "source", "notes"]
    for e in manifest:
        for k in need:
            if k not in e:
                problems.append(f"{e.get('id')}: missing {k}")
        for k in ("name", "url", "citation", "version"):
            if k not in e.get("source", {}):
                problems.append(f"{e['id']}: source missing {k}")
        png = os.path.join(OUT, e["id"] + ".png")
        b = os.path.join(OUT, e["id"] + ".bin")
        im = Image.open(png)
        if im.size != (N, N) or im.mode != "RGBA":
            problems.append(f"{e['id']}.png is {im.size} {im.mode}")
        if os.path.getsize(b) != N * N * 2:
            problems.append(f"{e['id']}.bin has size {os.path.getsize(b)}")
        # PNG transparency must match the .bin no-data mask (ice: transparent where not PSR)
        a = np.asarray(im)[..., 3]
        u = read_bin(b)
        if e["id"] == "ice":
            mism = ((a > 0) != (u == 1)).sum()
        else:
            mism = ((a > 0) != (u != NODATA_U16)).sum()
        if mism:
            problems.append(f"{e['id']}: {mism} pixels where PNG alpha disagrees with .bin")
    return problems


def orientation(vals):
    """Crater floors should be PSR / cold / low at their true positions and not
    at mirrored positions. Reports mean value inside 0.3 x radius."""
    gx = (np.arange(N) + 0.5) * RES - 304000.0
    gy = 304000.0 - (np.arange(N) + 0.5) * RES
    X, Y = np.meshgrid(gx, gy)
    out = {}
    for lid in ("ice", "temp-max", "height", "sunlight"):
        v = vals[lid]
        row = {}
        for tag, sx, sy in (("as-is", 1, 1), ("mirror-x", -1, 1), ("mirror-y", 1, -1), ("rot180", -1, -1)):
            acc = []
            for _, lat, lon, d in CRATERS:
                x, y = latlon_to_xy(lat, lon)
                m = np.hypot(X - sx * x, Y - sy * y) < 0.3 * d / 2
                acc.append(np.nanmean(v[m]))
            row[tag] = round(float(np.mean(acc)), 3)
        out[lid] = row
    return out


# ------------------------------------------------------------------ previews
def to_px(lat, lon, size):
    x, y = latlon_to_xy(lat, lon)
    c, r = xy_to_pixel(x, y)
    s = size / N
    return (float(c) + 0.5) * s, (float(r) + 0.5) * s


def draw_overlays(img, size):
    d = ImageDraw.Draw(img)
    # graticule: 85S and 88S circles, meridians every 30 deg
    for lat in (-80.0, -85.0, -88.0):
        pts = [to_px(lat, lo, size) for lo in np.arange(0, 361, 2)]
        d.line(pts, fill=(255, 255, 255, 110), width=1)
    for lo in range(0, 360, 30):
        d.line([to_px(-90, lo, size), to_px(-75.8, lo, size)], fill=(255, 255, 255, 70), width=1)
    for name, lat, lon, _ in SITES:
        px, py = to_px(lat, lon, size)
        d.ellipse([px - 4, py - 4, px + 4, py + 4], outline=(255, 0, 255, 255), width=2)
        d.text((px + 6, py - 6), name.split(" ")[0], fill=(255, 255, 255, 255),
               stroke_width=2, stroke_fill=(0, 0, 0, 255))
    d.text((size / 2 - 8, 6), "0 E", fill=(255, 255, 0, 255), stroke_width=2, stroke_fill=(0, 0, 0, 255))
    d.text((size - 40, size / 2 - 6), "90 E", fill=(255, 255, 0, 255), stroke_width=2,
           stroke_fill=(0, 0, 0, 255))
    d.text((size / 2 - 12, size - 18), "180", fill=(255, 255, 0, 255), stroke_width=2,
           stroke_fill=(0, 0, 0, 255))
    d.text((6, size / 2 - 6), "270 E", fill=(255, 255, 0, 255), stroke_width=2,
           stroke_fill=(0, 0, 0, 255))


def previews(manifest, vals, size=1024):
    os.makedirs(PREVIEWS, exist_ok=True)
    hs = hillshade(vals["height"], RES, zfactor=2.0)
    base = Image.fromarray((40 + 200 * hs).astype(np.uint8), "L").convert("RGBA")
    base_s = base.resize((size, size), Image.LANCZOS)
    hs_img = base_s.copy()
    draw_overlays(hs_img, size)
    hs_img.convert("RGB").save(os.path.join(PREVIEWS, "dem-hillshade.png"))
    for e in manifest:
        ov = Image.open(os.path.join(OUT, e["id"] + ".png")).convert("RGBA").resize((size, size), Image.LANCZOS)
        if e["id"] not in ("ice", "height"):
            a = np.asarray(ov).copy()
            a[..., 3] = (a[..., 3].astype(np.float32) * 0.85).astype(np.uint8)
            ov = Image.fromarray(a, "RGBA")
        comp = Image.alpha_composite(base_s, ov)
        draw_overlays(comp, size)
        # legend strip
        d = ImageDraw.Draw(comp)
        lg = e["legend"]
        x0, y0, w, h = 20, size - 60, 300, 14
        vmin, vmax = lg[0]["value"], lg[-1]["value"]
        for i in range(w):
            v = vmin + (vmax - vmin) * i / (w - 1)
            vs = [s["value"] for s in lg]
            cs = [s["color"][1:7] for s in lg]
            rgb = [int(np.interp(v, vs, [int(c[k:k + 2], 16) for c in cs])) for k in (0, 2, 4)]
            d.line([(x0 + i, y0), (x0 + i, y0 + h)], fill=tuple(rgb) + (255,))
        d.text((x0, y0 - 16), f"{e['title']}  {vmin:g} .. {vmax:g} {e['units']}", fill=(255, 255, 255, 255),
               stroke_width=2, stroke_fill=(0, 0, 0, 255))
        comp.convert("RGB").save(os.path.join(PREVIEWS, e["id"] + ".png"))


def main():
    with open(os.path.join(OUT, "manifest.json")) as f:
        manifest = json.load(f)
    problems = validate(manifest)
    print("VALIDATION:", "OK" if not problems else problems)
    vals = load(manifest)
    report = {"sites": [], "orientation": orientation(vals), "files": {}}
    ids = [e["id"] for e in manifest]
    print("\nSPOT CHECKS (pixel value on 2048 grid; [min..max] within +/-2 px = +/-0.6 km)")
    for name, lat, lon, expect in SITES:
        row = {"site": name, "lat": lat, "lon": lon, "expect": expect}
        parts = []
        for lid in ids:
            v = at(vals[lid], lat, lon)
            lo, hi = at(vals[lid], lat, lon, half=2)
            row[lid] = {"value": round(v, 2), "min5x5": round(lo, 2), "max5x5": round(hi, 2)}
            parts.append(f"{lid}={v:.1f}[{lo:.1f}..{hi:.1f}]")
        s0, smax = source_sample("avgvisib_65s_240m_201608", lat, lon, 600)
        e0, emax = source_sample("avgvisib_65s_240m_201608_earth", lat, lon, 600)
        row["source240m"] = {"sun": round(s0, 2), "sunMax600m": round(smax, 2),
                             "earth": round(e0, 2), "earthMax600m": round(emax, 2)}
        report["sites"].append(row)
        print(f"- {name} ({lat}, {lon}E) expect: {expect}\n    " + "  ".join(parts)
              + f"\n    240m source: sun {s0:.1f}% (max within 600 m {smax:.1f}%), "
                f"earth {e0:.1f}% (max {emax:.1f}%)")
    print("\nORIENTATION (mean inside crater floors at true vs mirrored positions):")
    for lid, row in report["orientation"].items():
        print(f"  {lid:9s} {row}")
    for e in manifest:
        for ext in ("png", "bin"):
            p = os.path.join(OUT, f"{e['id']}.{ext}")
            report["files"][os.path.basename(p)] = os.path.getsize(p)
    report["files"]["manifest.json"] = os.path.getsize(os.path.join(OUT, "manifest.json"))
    print("\nFILES:", json.dumps(report["files"], indent=1))
    save_json(os.path.join(PREVIEWS, "spotcheck.json"), report)
    previews(manifest, vals)
    print("previews written to", PREVIEWS)


if __name__ == "__main__":
    main()
