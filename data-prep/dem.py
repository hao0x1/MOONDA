"""Prepare the NASA LOLA south-polar height map for the in-browser horizon calculator.

Source: LRO LOLA LDEM_80S_80M (PDS, polar stereographic, 80 m/pixel, 80°S-90°S),
already downloaded to MOONDA/data-raw/source/terrain-raw/LDEM_80S_80M.JP2.
Heights: DN * 0.5 m above a 1,737,400 m sphere (PDS label SCALING_FACTOR = 0.5).

Outputs (app/public/data/dem/):
  polar240.bin   Int16 LE metres, 2530 x 2530, 240 m pixels, x,y in [-303600, 303600]
  t80/<col>_<row>.bin  Int16 LE metres, 256 x 256 tiles of the 80 m grid (30 x 30 tiles)
  dem.json       grid description

Grid convention (same as LOLA): south polar stereographic, pole at (0,0),
x = rho*sin(lon), y = rho*cos(lon), rho = 2R*tan(pi/4 + lat/2), row 0 = top (y max).

Run: ../.venv-data/bin/python -I dem.py
"""
import json
import pathlib

import numpy as np
import rasterio

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = pathlib.Path("/Volumes/CodexWork/Projects/MOONDA/data-raw/source/terrain-raw/LDEM_80S_80M.JP2")
OUT = ROOT / "app/public/data/dem"
R = 1737400.0


def main() -> None:
    with rasterio.open(SRC) as ds:
        dn = ds.read(1)
        bounds = ds.bounds
        res = ds.res[0]
    assert dn.shape == (7600, 7600) and res == 80.0 and bounds.left == -304000.0
    h = dn.astype(np.float32) * 0.5  # metres above 1737.4 km

    # Sanity: compare with the float GeoTIFF exported earlier from the same product.
    alt = pathlib.Path("/Volumes/CodexWork/Projects/MOONDA/data-raw/source/terrain-raw/polar-far-80m.tif")
    if alt.exists():
        with rasterio.open(alt) as ds2:
            win = ds2.read(1, window=((3700, 3900), (3700, 3900)))
        diff = np.nanmax(np.abs(win - h[3700:3900, 3700:3900]))
        print("max diff vs polar-far-80m.tif in a 200x200 window:", diff)

    def to_xy(lat, lon):
        rho = 2 * R * np.tan(np.pi / 4 + np.radians(lat) / 2)
        return rho * np.sin(np.radians(lon)), rho * np.cos(np.radians(lon))

    def sample(lat, lon):
        x, y = to_xy(lat, lon)
        col = int((x - bounds.left) / res)
        row = int((bounds.top - y) / res)
        return h[row, col]

    # Orientation spot checks: Shackleton floor should be ~4 km below its rim.
    print("Shackleton centre (-89.67, 129.78):", sample(-89.67, 129.78))
    print("Shackleton rim approx (-89.45, 137):", sample(-89.45, 137.0))
    print("Mons Malapert summit approx (-85.98, -1.67):", sample(-85.98, -1.67))

    OUT.mkdir(parents=True, exist_ok=True)
    hi = np.clip(np.round(h), -32000, 32000).astype("<i2")

    # 240 m overview: crop 5 px each side (7590 px), 3x3 block mean -> 2530 x 2530.
    c = h[5:-5, 5:-5].reshape(2530, 3, 2530, 3).mean(axis=(1, 3))
    np.clip(np.round(c), -32000, 32000).astype("<i2").tofile(OUT / "polar240.bin")

    # 80 m tiles, 256 x 256 (pad edge tiles with the nearest edge values).
    tiles_dir = OUT / "t80"
    tiles_dir.mkdir(exist_ok=True)
    n = 30
    padded = np.pad(hi, ((0, n * 256 - 7600), (0, n * 256 - 7600)), mode="edge")
    for tr in range(n):
        for tc in range(n):
            padded[tr * 256:(tr + 1) * 256, tc * 256:(tc + 1) * 256].tofile(tiles_dir / f"{tc}_{tr}.bin")

    meta = {
        "source": "NASA LRO LOLA LDEM_80S_80M (PDS Geosciences Node), heights above 1737.4 km sphere",
        "url": "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/",
        "radius": R,
        "overview": {"file": "polar240.bin", "size": 2530, "res": 240.0, "min": -303600.0, "max": 303600.0},
        "tiles": {"dir": "t80", "tileSize": 256, "count": n, "res": 80.0, "min": -304000.0, "max": 304000.0},
        "projection": "south polar stereographic, x = rho*sin(lon), y = rho*cos(lon), rho = 2R*tan(pi/4 + lat/2), row 0 = max y",
    }
    (OUT / "dem.json").write_text(json.dumps(meta, indent=2))
    print("done", OUT)


if __name__ == "__main__":
    main()
