"""Global Moon height map for 3D terrain and the skyline check outside the polar map.

Source: NASA SVS CGI Moon Kit ldem_16.tif (LRO LOLA, 16 pixels/degree ~1.9 km, float km
relative to 1737.4 km, centred on 0° longitude, row 0 = 90°N, column 0 = 180°W).
https://svs.gsfc.nasa.gov/4720/  (already downloaded to MOONDA/data-raw/source/reference-v2)

Output: app/public/data/dem/global16.bin  Int16 LE metres, 5760 x 2880.
Run: ../.venv-data/bin/python -I global_dem.py
"""
import json
import pathlib
import warnings

import numpy as np
import rasterio

warnings.filterwarnings("ignore")
ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = pathlib.Path("/Volumes/CodexWork/Projects/MOONDA/data-raw/source/reference-v2/ldem-16-float.tif")
OUT = ROOT / "app/public/data/dem/global16.bin"

with rasterio.open(SRC) as d:
    km = d.read(1)
assert km.shape == (2880, 5760)
m = np.clip(np.round(km * 1000), -32000, 32000).astype("<i2")
m.tofile(OUT)

def h(lat, lon):
    r = int((90 - lat) * 16); c = int((lon + 180) * 16) % 5760
    return int(m[r, c])

print("Tycho centre (-43.3, -11.2):", h(-43.3, -11.2), " rim (-43.3, -10.0):", h(-43.3, -9.8))
print("Copernicus centre (9.62, -20.08):", h(9.62, -20.08), " rim:", h(9.62, -19.3))
print("Mons Malapert (-85.98, -1.67):", h(-85.98, -1.67), "(polar 80 m map says ~4900)")
meta_p = ROOT / "app/public/data/dem/dem.json"
meta = json.loads(meta_p.read_text())
meta["global"] = {"file": "global16.bin", "width": 5760, "height": 2880, "ppd": 16,
                  "source": "NASA SVS CGI Moon Kit ldem_16 (LRO LOLA), https://svs.gsfc.nasa.gov/4720/",
                  "layout": "row 0 = 90N, column 0 = 180W, pixel centres at (i+0.5)/16 deg"}
meta_p.write_text(json.dumps(meta, indent=2))
print("saved", OUT, OUT.stat().st_size // 1e6, "MB")
