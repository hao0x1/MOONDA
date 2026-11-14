"""Render scientific QA previews from the finished data, without altering app files.

Run with MOONDA/.venv-data/bin/python -I features/scripts/previews.py.
Missing layer PNGs are skipped so a partial build can be inspected and rerun.
All artwork is a rendering of source data; no generated terrain or detections.
"""
from __future__ import annotations

import sys
sys.dont_write_bytecode = True
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parents[2]
PROJECT = HERE.parent
OUT = HERE / "features/out"
PREVIEWS = OUT / "previews"
sys.path.insert(0, str(PROJECT / "data-prep/layers"))
from common import hillshade, latlon_to_xy, R_MOON, RES

SIZE = 1024
FONT = Path("/System/Library/Fonts/Supplemental/Arial.ttf")


def font(size):
    return ImageFont.truetype(str(FONT), size) if FONT.exists() else ImageFont.load_default(size=size)


def to_px(lat, lon):
    x, y = latlon_to_xy(lat, lon)
    return (float(x) + 304000) / 608000 * SIZE, (304000 - float(y)) / 608000 * SIZE


def text(draw, xy, label, size=16, color=(255, 255, 255, 255), anchor=None):
    draw.text(xy, label, font=font(size), fill=color, stroke_width=2,
              stroke_fill=(12, 15, 19, 255), anchor=anchor)


def names():
    data = json.loads((PROJECT / "app/public/data/names.json").read_text())
    return {row[0]: dict(zip(data["fields"], row)) for row in data["rows"]}


def hillshade_base():
    raw = np.fromfile(PROJECT / "app/public/data/layers/height.bin", "<u2").reshape(2048, 2048)
    height = raw.astype(np.float64) * .5 - 10000
    height[raw == 65535] = np.nan
    shade = hillshade(height, RES, azimuth_deg=315, altitude_deg=40, zfactor=2)
    gray = (38 + 195 * shade).astype(np.uint8)
    image = Image.fromarray(gray).convert("RGBA").resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    a = np.asarray(image).copy()
    axis = (np.arange(SIZE) + .5) * 608000 / SIZE - 304000
    rho80 = 2 * R_MOON * np.tan(np.radians(5))
    outside = axis[:, None] ** 2 + axis[None, :] ** 2 > rho80**2
    a[outside] = (15, 19, 25, 255)
    return Image.fromarray(a)


def graticule(image, iau):
    draw = ImageDraw.Draw(image)
    for lat in (-80, -85, -88):
        pts = [to_px(lat, lon) for lon in np.arange(0, 360.5, .5)]
        draw.line(pts, fill=(210, 219, 230, 130), width=1)
    for lon in (0, 90, 180, 270):
        draw.line([to_px(-90, lon), to_px(-80, lon)], fill=(220, 226, 235, 75), width=1)
    text(draw, (514, 87), "0° E", anchor="mt", color=(230, 235, 255, 255))
    text(draw, (953, 516), "90° E", anchor="mm", color=(230, 235, 255, 255))
    text(draw, (512, 846), "180°", anchor="mt", color=(230, 235, 255, 255))
    text(draw, (69, 516), "90° W", anchor="mm", color=(230, 235, 255, 255))
    for lat, lon in ((-85, 220), (-88, 200)):
        x, y = to_px(lat, lon)
        text(draw, (x-6, y), f"{abs(lat)}° S", anchor="rm", size=15)
    # Exact IAU centres; offsets only move label text, with explicit leader lines.
    anchors = {"Cabeus": (241, 287), "Haworth": (448, 329),
               "Shoemaker": (647, 380), "Faustini": (748, 474),
               "de Gerlache": (294, 548), "Shackleton": (606, 593),
               "Amundsen": (866, 415)}
    for name, (tx, ty) in anchors.items():
        row = iau[name]
        x, y = to_px(row["lat"], row["lon"])
        draw.line([(x, y), (tx, ty+7)], fill=(245, 248, 255, 205), width=1)
        draw.ellipse((x-2.5, y-2.5, x+2.5, y+2.5), fill=(255, 255, 255, 255),
                     outline=(0, 0, 0, 255), width=1)
        text(draw, (tx, ty), name, size=16)
    return image


def captions(image, title, subtitle, entries, caveat):
    draw = ImageDraw.Draw(image, "RGBA")
    draw.rounded_rectangle((18, 17, 1006, 78), 8, fill=(9, 13, 20, 224))
    draw.text((32, 23), title, font=font(24), fill=(255, 255, 255, 255))
    draw.text((33, 54), subtitle, font=font(14), fill=(218, 226, 237, 255))
    rows = len(entries)
    bottom = 1007
    top = bottom - 32 - rows * 23 - 27
    draw.rounded_rectangle((18, top, 1006, bottom), 8, fill=(9, 13, 20, 230))
    for i, (color, label) in enumerate(entries):
        y = top + 13 + 23*i
        draw.rectangle((32, y, 48, y+13), fill=color, outline=(200, 207, 218, 220))
        draw.text((59, y-2), label, font=font(16), fill=(244, 246, 250, 255))
    draw.text((32, bottom-27), caveat, font=font(13), fill=(203, 211, 222, 255))
    return image


def crater_overlay():
    # Four times supersampling makes the sub-pixel small-crater outlines honest.
    scale = 4
    overlay = Image.new("RGBA", (SIZE*scale, SIZE*scale))
    draw = ImageDraw.Draw(overlay)
    for filename, color in (("craters.bin", (225, 236, 250, 185)),
                            ("craters-small-south.bin", (126, 240, 166, 220))):
        path = OUT / filename
        if not path.exists():
            continue
        records = np.fromfile(path, "<f4").reshape(-1, 3)
        records = records[records[:, 0] <= -74]
        for lat, lon, diameter in records:
            # Exact projected image of the catalogued spherical circular rim.
            phi, lam = math.radians(float(lat)), math.radians(float(lon))
            alpha = float(diameter)*1000/(2*R_MOON)
            denominator = math.cos(alpha) - math.sin(phi)
            factor = 2*R_MOON*math.cos(phi)/denominator
            x, y = factor*math.sin(lam), factor*math.cos(lam)
            radius = 2*R_MOON*math.sin(alpha)/denominator
            cx = (x+304000)/608000*SIZE*scale
            cy = (304000-y)/608000*SIZE*scale
            rp = radius/608000*SIZE*scale
            if cx+rp < 0 or cx-rp > SIZE*scale or cy+rp < 0 or cy-rp > SIZE*scale:
                continue
            # A line is an outline, never a filled invented crater footprint.
            draw.ellipse((cx-rp, cy-rp, cx+rp, cy+rp), outline=color, width=2)
    overlay = overlay.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    a = np.asarray(overlay).copy()
    axis = (np.arange(SIZE)+.5)*608000/SIZE-304000
    rho80 = 2*R_MOON*np.tan(np.radians(5))
    a[axis[:, None]**2 + axis[None, :]**2 > rho80**2] = 0
    return Image.fromarray(a)


def main():
    PREVIEWS.mkdir(parents=True, exist_ok=True)
    iau = names()
    base = hillshade_base()
    finished = []
    image = graticule(base.copy(), iau)
    captions(image, "South pole — terrain reference", "Same 608 km square as every layer · image up is toward 0° E",
             [((166, 174, 185, 255), "LOLA heights with artificial light from the upper left")],
             "Hillshade is a drawing of terrain, not real sunlight. Labels mark IAU crater centres.")
    image.convert("RGB").save(PREVIEWS / "dem-hillshade.png", optimize=True)
    finished.append("dem-hillshade.png")
    image = Image.alpha_composite(base, crater_overlay())
    graticule(image, iau)
    captions(image, "Measured crater outlines", "Circular-fit catalogue sizes; real crater rims are not perfect circles",
             [((225, 236, 250, 255), "Robbins global catalogue; smaller craters included near the south pole"),
              ((126, 240, 166, 255), "Separate small-crater study (CC BY 4.0); only its study area")],
             "Centres and diameters are published measurements. This full-pole preview cannot show the finest outlines.")
    image.convert("RGB").save(PREVIEWS / "craters.png", optimize=True)
    finished.append("craters.png")
    labels = {
        "psr": ("Permanent shadow — sharp 20 m source", "Blue shows the part of each map square that never gets direct sunlight",
                [((72, 140, 220, 255), "More blue = a larger fraction in permanent shadow")],
                "A cold trap is a place where ice could last. This layer does not show measured water."),
        "danger": ("Steep ground and small crater bowls", "Worst 80 m terrain slope touching each output square; small crater bowls get at least yellow",
                   [((245, 200, 60, 255), "Caution: 10–15° slopes, or a catalogued 1–3 km crater bowl"),
                    ((245, 130, 40, 255), "Steep: 15–25°"),
                    ((230, 50, 50, 255), "Too steep to drive in this display: over 25°")],
                   "No colour means no mapped warning. Boulders and hazards smaller than about 80 m are unresolved."),
        "waterice": ("Water ice — predictions and measurements", "Blue colours are thermal predictions. The LCROSS marker is a direct water measurement.",
                     [((110, 150, 255, 255), "Predicted: ice could last within the top metre, below a warm surface"),
                      ((80, 210, 255, 255), "Predicted: permanent shadow cold enough for surface ice to last"),
                      ((255, 220, 80, 255), "LCROSS impact: water measured in the plume at Cabeus")],
                     "A prediction does not prove ice is present. White orbital pixels appear only if a shippable detection map exists.")
    }
    for layer, args in labels.items():
        path = OUT / f"{layer}.png"
        if not path.exists():
            print(f"Skipping missing {path.name}; rerun after its build", flush=True)
            continue
        with Image.open(path) as source:
            overlay = source.convert("RGBA").resize((SIZE, SIZE), Image.Resampling.LANCZOS)
        image = Image.alpha_composite(base, overlay)
        graticule(image, iau)
        if layer == "waterice":
            x, y = to_px(-84.675, -48.725)
            draw = ImageDraw.Draw(image)
            draw.polygon(((x, y-7), (x+7, y), (x, y+7), (x-7, y)),
                         fill=(255, 220, 80, 255), outline=(12, 15, 19, 255), width=2)
            text(draw, (211, 365), "LCROSS", size=16, color=(255, 230, 120, 255), anchor="mm")
            draw.line(((246, 360), (x-5, y+5)), fill=(255, 220, 80, 255), width=1)
        captions(image, *args)
        image.convert("RGB").save(PREVIEWS / f"{layer}.png", optimize=True)
        finished.append(f"{layer}.png")
    layer_files = [f"{layer}.png" for layer in ("craters", "psr", "waterice", "danger")]
    if all(filename in finished for filename in layer_files):
        sheet = Image.new("RGB", (SIZE, SIZE), (9, 13, 20))
        for index, filename in enumerate(layer_files):
            with Image.open(PREVIEWS / filename) as image:
                thumb = image.resize((SIZE//2, SIZE//2), Image.Resampling.LANCZOS)
                sheet.paste(thumb, (index % 2 * (SIZE//2), index // 2 * (SIZE//2)))
        sheet.save(PREVIEWS / "contact-sheet.png", optimize=True)
        finished.append("contact-sheet.png")
    report = {"size": [SIZE, SIZE], "extentM": [-304000, -304000, 304000, 304000],
              "terrainSource": "app/public/data/layers/height.bin (LOLA; raw*0.5-10000 metres)",
              "namesSource": "app/public/data/names.json (IAU/USGS Gazetteer)",
              "circles": ["80S", "85S", "88S"], "files": finished,
              "notes": "Scientific QA previews only. Artificial 2x vertical hillshade. RGBA overlays downsampled then alpha-composited over the 1024-pixel terrain reference; no source data values changed."}
    (PREVIEWS / "preview-info.json").write_text(json.dumps(report, indent=2) + "\n")
    print("Rendered:", ", ".join(finished), flush=True)


if __name__ == "__main__":
    main()
