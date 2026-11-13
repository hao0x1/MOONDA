"""Download one sharp, top-down photo of the whole south polar cap (80°S-90°S) so the
app has a clean polar base map that loads instantly and works offline.

Source: LROC WAC global mosaic + LROC NAC south-pole controlled mosaic, served by
ASU Lunaserv (the WMS server behind LROC QuickMap), in IAU2000:30120 (Moon south
polar stereographic, 1737.4 km sphere) - the same grid as the LOLA height map.

Output: app/public/data/polar/photo4096.jpg  (4096 x 4096, x,y in [-304000, 304000] m, 148 m/px)

Run: ../.venv-data/bin/python -I polar_photo.py
"""
import io
import pathlib
import time
import urllib.parse
import urllib.request

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "app/public/data/polar/photo4096.jpg"
RAW = ROOT / "data-raw/lunaserv-polar"
E = 304000
N = 4  # 4 x 4 pieces of 1024 px
PIECE = 1024


def fetch(x0, y0, x1, y1):
    q = urllib.parse.urlencode({
        "SERVICE": "WMS", "VERSION": "1.1.1", "REQUEST": "GetMap", "STYLES": "",
        "LAYERS": "luna_wac_global,luna_nac_pole_control_south", "SRS": "IAU2000:30120",
        "BBOX": f"{x0},{y0},{x1},{y1}", "WIDTH": PIECE, "HEIGHT": PIECE, "FORMAT": "image/png",
    })
    url = "https://wms.im-ldi.com/?" + q
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "MOONDA-student-project/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
            return Image.open(io.BytesIO(data)).convert("L")
        except Exception as e:  # noqa: BLE001
            print("  retry", attempt + 1, e)
            time.sleep(3)
    raise RuntimeError("failed " + url)


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    mosaic = Image.new("L", (N * PIECE, N * PIECE))
    step = 2 * E / N
    for r in range(N):
        for c in range(N):
            cache = RAW / f"piece_{c}_{r}.png"
            if cache.exists():
                img = Image.open(cache)
            else:
                x0, x1 = -E + c * step, -E + (c + 1) * step
                y1, y0 = E - r * step, E - (r + 1) * step
                print("piece", c, r)
                img = fetch(x0, y0, x1, y1)
                img.save(cache)
            mosaic.paste(img, (c * PIECE, r * PIECE))
    mosaic.save(OUT, quality=88, optimize=True, progressive=True)
    print("saved", OUT, OUT.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
