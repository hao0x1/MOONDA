"""Download the sharp south-pole photo squares the app shows when you zoom in near the pole, so
they load from disk at once instead of waiting 4-8 s per square for the remote server.

Source: LROC WAC South Pole Summer Mosaic (100 m/pixel, evenly lit, no seams) with the LROC NAC
south-pole controlled mosaic (about 1 m/pixel, south of 84 deg S) on top, served by ASU Lunaserv
(the WMS server behind LROC QuickMap), in IAU2000:30120 (Moon south polar stereographic,
1737.4 km sphere). This is exactly what the app would otherwise ask for one square at a time
(see pyramidUrl in app/src/moon/imageryWorker.ts): level k = the 608 km square around the pole
split into 2^k x 2^k squares of 512 px.

(The first version used the WAC *global* mosaic under the NAC mosaic. That one has straight
lighting seams along longitude +-90 and 180 deg near the pole, so it was replaced: run once with
--replace-wac to forget the stored squares that show anything outside the NAC mosaic and fetch
them again. Squares wholly inside the NAC mosaic are the same pictures either way and are kept.)

To be kind to the server we ask for 2048 px blocks (4 x 4 squares in one request: the server
needs ~10 s for that instead of 16 x 5 s) and cut them up here. The squares are stored with the
server's own JPEG tables, so they are practically the same bytes it would have sent (max
difference 2 grey levels) and local and remote squares look identical side by side.

Output: app/public/data/polar/t/{k}/{col}_{row}.jpg  and  app/public/data/polar/t/index.json
        app/public/data/base/southpole4096.jpg  (level 3 put together: the whole 608 km square in
        one 4096 px picture, 148 m/pixel, for the app's polar photo layer)
Coverage (in this order, until the time or size budget runs out):
  k 0-5   the whole 608 km square (inside the 80 deg S circle the app draws)
  k 6     the inner 304 km        k 7  the inner 152 km        k 8  the inner 76 km
  k 6-8   blocks around the Artemis regions and the famous sunny spots

Resumable: squares already on disk are skipped, and the index is rewritten from what is really on
disk at the start and the end of every run. At most 4 requests at a time, retries with back-off,
a short pause between requests, and blocks that failed are tried again in later passes.

Run: ../.venv-data/bin/python -I polar_tiles.py [--max-minutes 25] [--max-mb 350] [--index-only] [--replace-wac] [--max-k 8]
"""
import argparse
import io
import json
import math
import os
import pathlib
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "app/public/data/polar/t"
LAYERS = "luna_wac_roi_south_summer,luna_nac_pole_control_south"
OVERVIEW = ROOT / "app/public/data/base/southpole4096.jpg"
HALF = 304000.0  # the square is x, y in [-304000, 304000] m
SPAN = 2 * HALF
PX = 512
R = 1737400.0
POLAR_LIMIT_DEG = -80.0  # the app draws polar photos only south of this (imageryWorker.ts)
HOSTS = ["wms", "wms1", "wms2", "wms3", "wms4", "wms5", "wms6", "wms7"]
BLOCK = 4  # squares per side in one request (2048 px)
PARALLEL = 4
UA = "MOONDA-student-project/1.0 (NASA Space Apps; polar tile cache)"

# True lat/lon of the places people will zoom into (app/src/data/places.ts).
SITES = [
    ("Connecting Ridge", -89.45, -137.3),
    ("Shackleton rim", -89.79, -154.3),
    ("de Gerlache Rim 2", -88.39, -68.87),
    ("Slater Plain", -87.48, 124.52),
    ("Haworth", -86.77, -20.51),
    ("Malapert Massif", -85.94, -0.94),
    ("Mons Mouton", -85.42, 31.85),
    ("Nobile Rim 1", -85.30, 36.92),
    ("Mons Mouton Plateau", -85.11, 26.71),
    ("IM-2 Athena", -84.81, 29.20),
    ("LCROSS impact", -84.68, -48.69),
    ("Nobile Rim 2", -84.05, 56.48),
    ("Peak near Cabeus B", -83.76, -69.98),
]
SITE_HALF_M = 10000.0  # cover +-10 km around each site


def rho(lat_deg):
    return 2 * R * math.tan(math.pi / 4 + math.radians(lat_deg) / 2)


RHO_CLIP = rho(POLAR_LIMIT_DEG) + 1000.0
# The sharp NAC mosaic only exists south of 84 deg S (measured: a WMS request for
# luna_nac_pole_control_south alone is transparent beyond 182 km from the pole). Further out the
# server only has the 100 m/pixel WAC mosaic, which level 4 (74 m/pixel) already shows in full, so
# finer squares there would be blown-up copies: never fetched or stored. The app uses the same
# limit (PYRAMID_NAC_LAT_DEG in imageryWorker.ts).
NAC_LIMIT_DEG = -84.0
RHO_NAC = rho(NAC_LIMIT_DEG) + 1000.0
RHO_NAC_SURE = RHO_NAC - 5000.0  # closer to the pole than this every pixel comes from the NAC mosaic
WAC_MAX_K = 4


def polar_xy(lat, lon):
    r = rho(lat)
    return r * math.sin(math.radians(lon)), r * math.cos(math.radians(lon))


def tile_box(k, i, j):
    s = SPAN / 2 ** k
    x0, y1 = -HALF + i * s, HALF - j * s
    return x0, y1 - s, x0 + s, y1


def tile_drawn(k, i, j):
    """False for squares the app never draws: wholly outside the 80 deg S circle, or (finer than
    level 4) wholly outside the sharp NAC mosaic."""
    x0, y0, x1, y1 = tile_box(k, i, j)
    nx = 0.0 if x0 <= 0 <= x1 else min(abs(x0), abs(x1))
    ny = 0.0 if y0 <= 0 <= y1 else min(abs(y0), abs(y1))
    return math.hypot(nx, ny) < (RHO_CLIP if k <= WAC_MAX_K else RHO_NAC)


INNER_M = {6: 304000.0, 7: 152000.0, 8: 76000.0}  # side of the square around the pole stored at each fine level


def tile_wanted(k, i, j):
    """Squares worth storing: everything up to level 5; finer ones inside the inner square of their
    level or within SITE_HALF_M of a site (the rest of a downloaded block is not kept)."""
    if k not in INNER_M:
        return k < 6
    n = 2 ** k
    a = int(round((HALF - INNER_M[k] / 2) / SPAN * n))
    if a <= i < n - a and a <= j < n - a:
        return True
    x0, y0, x1, y1 = tile_box(k, i, j)
    for _name, lat, lon in SITES:
        x, y = polar_xy(lat, lon)
        if x0 - SITE_HALF_M <= x <= x1 + SITE_HALF_M and y0 - SITE_HALF_M <= y <= y1 + SITE_HALF_M:
            return True
    return False


def tile_all_nac(k, i, j):
    """True for squares that lie wholly inside the NAC mosaic (the WAC mosaic underneath never shows)."""
    x0, y0, x1, y1 = tile_box(k, i, j)
    return math.hypot(max(abs(x0), abs(x1)), max(abs(y0), abs(y1))) < RHO_NAC_SURE


def tile_path(k, i, j):
    return OUT / str(k) / f"{i}_{j}.jpg"


def blocks_for(k, i0, j0, i1, j1):
    """Blocks (k, bi, bj, n) covering squares i0..i1, j0..j1 (inclusive)."""
    n = min(BLOCK, 2 ** k)
    out = []
    for bj in range(j0 // n, j1 // n + 1):
        for bi in range(i0 // n, i1 // n + 1):
            out.append((k, bi * n, bj * n, n))
    return out


def centre_dist(block):
    k, i, j, n = block
    s = SPAN / 2 ** k
    return math.hypot(-HALF + (i + n / 2) * s, HALF - (j + n / 2) * s)


def plan():
    """Every block to fetch, most useful first."""
    todo, seen = [], set()

    def add(blocks):
        for b in sorted(blocks, key=centre_dist):
            if b not in seen and block_tiles(b):
                seen.add(b)
                todo.append(b)

    for k in range(0, 6):
        add(blocks_for(k, 0, 0, 2 ** k - 1, 2 ** k - 1))
    for k, inner in INNER_M.items():
        n = 2 ** k
        a = int(round((HALF - inner / 2) / SPAN * n))
        add(blocks_for(k, a, a, n - a - 1, n - a - 1))
    for k in (6, 7, 8):
        for _name, lat, lon in SITES:
            x, y = polar_xy(lat, lon)
            n, s = 2 ** k, SPAN / 2 ** k
            i0 = max(0, int((x - SITE_HALF_M + HALF) // s))
            i1 = min(n - 1, int((x + SITE_HALF_M + HALF) // s))
            j0 = max(0, int((HALF - (y + SITE_HALF_M)) // s))
            j1 = min(n - 1, int((HALF - (y - SITE_HALF_M)) // s))
            add(blocks_for(k, i0, j0, i1, j1))
    return todo


def block_tiles(block):
    k, i, j, n = block
    return [(k, i + di, j + dj) for dj in range(n) for di in range(n) if tile_drawn(k, i + di, j + dj) and tile_wanted(k, i + di, j + dj)]


def block_url(block):
    k, i, j, n = block
    s = SPAN / 2 ** k
    x0, y1 = -HALF + i * s, HALF - j * s
    host = HOSTS[(i // n + (j // n) * 3 + k) % len(HOSTS)]
    return (f"https://{host}.im-ldi.com/?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&STYLES=&LAYERS={LAYERS}"
            f"&SRS=IAU2000:30120&BBOX={x0},{y1 - n * s},{x0 + n * s},{y1}&WIDTH={n * PX}&HEIGHT={n * PX}&FORMAT=image/jpeg")


def fetch_block(block):
    """Download one block and write its squares. Returns bytes written."""
    k, i, j, n = block
    url = block_url(block)
    last = None
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                ctype = r.headers.get("Content-Type", "")
                data = r.read()
            if "jpeg" not in ctype:
                raise RuntimeError(f"not a picture ({ctype}): {data[:120]!r}")
            img = Image.open(io.BytesIO(data))
            img.load()
            if img.size != (n * PX, n * PX):
                raise RuntimeError(f"wrong size {img.size}")
            tables = img.quantization
            if img.mode != "L":
                img, tables = img.convert("L"), None
            written = 0
            for (_k, ti, tj) in block_tiles(block):
                path = tile_path(k, ti, tj)
                if path.exists() and path.stat().st_size > 0:
                    continue
                path.parent.mkdir(parents=True, exist_ok=True)
                piece = img.crop(((ti - i) * PX, (tj - j) * PX, (ti - i + 1) * PX, (tj - j + 1) * PX))
                tmp = path.with_suffix(f".{threading.get_ident()}.tmp")
                if tables:
                    piece.save(tmp, "JPEG", qtables=tables, optimize=True)
                else:
                    piece.save(tmp, "JPEG", quality=90, optimize=True)
                os.replace(tmp, path)
                written += path.stat().st_size
            time.sleep(0.25)  # a short breath between requests
            return written
        except (urllib.error.URLError, OSError, RuntimeError, ValueError) as e:  # noqa: PERF203
            last = e
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"gave up on block k={k} i={i} j={j}: {last}")


def write_index():
    """Describe what is on disk: per level, runs [row, firstCol, lastCol] of squares that exist."""
    levels, count, total = {}, 0, 0
    for d in sorted((p for p in OUT.iterdir() if p.is_dir() and p.name.isdigit()), key=lambda p: int(p.name)) if OUT.exists() else []:
        have = {}
        for f in d.glob("*.jpg"):
            try:
                c, r = f.stem.split("_")
                size = f.stat().st_size
            except (ValueError, OSError):
                continue
            if size <= 0:
                continue
            have.setdefault(int(r), []).append(int(c))
            count += 1
            total += size
        runs = []
        for r in sorted(have):
            cols = sorted(have[r])
            start = prev = cols[0]
            for c in cols[1:]:
                if c != prev + 1:
                    runs.append([r, start, prev])
                    start = c
                prev = c
            runs.append([r, start, prev])
        if runs:
            k = int(d.name)
            levels[str(k)] = {"squaresPerSide": 2 ** k, "metresPerPixel": round(SPAN / 2 ** k / PX, 3),
                              "count": sum(len(v) for v in have.values()), "runs": runs}
    index = {
        "about": "South-pole photo squares stored with the app. Level k = the 608 km square around the pole split into 2^k x 2^k squares of 512 px. runs = [row, firstColumn, lastColumn] of squares that exist (row 0 = top = +y, column 0 = left = -x).",
        "source": "LROC WAC global mosaic + LROC NAC south-pole controlled mosaic, ASU Lunaserv WMS (https://wms.im-ldi.com), NASA/GSFC/Arizona State University",
        "layers": LAYERS,
        "srs": "IAU2000:30120",
        "halfM": HALF,
        "tilePx": PX,
        "path": "{k}/{col}_{row}.jpg",
        "count": count,
        "bytes": total,
        "levels": levels,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = OUT / "index.json.tmp"
    tmp.write_text(json.dumps(index, separators=(",", ":")))
    os.replace(tmp, OUT / "index.json")
    return count, total


def write_overview():
    """The whole 608 km square as one 4096 px picture, put together from the level-3 squares."""
    k, n = 3, 8
    need = [(i, j) for j in range(n) for i in range(n) if tile_drawn(k, i, j)]
    if any(not tile_path(k, i, j).exists() for i, j in need):
        return False
    big = Image.new("L", (n * PX, n * PX))
    for j in range(4):  # behind: level 2 blown up, for the four corner squares the app never draws
        for i in range(4):
            if tile_path(2, i, j).exists():
                big.paste(Image.open(tile_path(2, i, j)).convert("L").resize((2 * PX, 2 * PX), Image.BILINEAR), (i * 2 * PX, j * 2 * PX))
    for i, j in need:
        big.paste(Image.open(tile_path(k, i, j)).convert("L"), (i * PX, j * PX))
    OVERVIEW.parent.mkdir(parents=True, exist_ok=True)
    tmp = OVERVIEW.with_suffix(".tmp")
    big.save(tmp, "JPEG", quality=90, optimize=True)
    os.replace(tmp, OVERVIEW)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-minutes", type=float, default=25)
    ap.add_argument("--max-mb", type=float, default=350)
    ap.add_argument("--index-only", action="store_true")
    ap.add_argument("--replace-wac", action="store_true", help="one-time: forget stored squares that show the old WAC mosaic")
    ap.add_argument("--max-k", type=int, default=8, help="fetch nothing finer than this level in this run")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    if a.replace_wac:
        gone = 0
        for d in (p for p in OUT.iterdir() if p.is_dir() and p.name.isdigit()):
            for f in d.glob("*.jpg"):
                c, r = (int(v) for v in f.stem.split("_"))
                if not tile_all_nac(int(d.name), c, r):
                    f.unlink()
                    gone += 1
        print(f"forgot {gone} squares that showed the old WAC mosaic", flush=True)
    count, total = write_index()
    if a.index_only:
        print(f"index: {count} squares, {total / 2**20:.1f} MB; overview {'written' if write_overview() else 'not written (level 3 incomplete)'}")
        return
    todo = [b for b in plan() if b[0] <= a.max_k and any(not tile_path(*t).exists() for t in block_tiles(b))]
    print(f"{len(plan())} blocks planned, {len(todo)} still to fetch; {count} squares ({total / 2**20:.1f} MB) on disk", flush=True)
    t0, deadline, budget = time.time(), time.time() + a.max_minutes * 60, a.max_mb * 2 ** 20
    lock, state = threading.Lock(), {"bytes": total, "done": 0, "failed": 0, "stop": ""}

    def work(block):
        with lock:
            if state["stop"]:
                return
            if time.time() > deadline:
                state["stop"] = "time budget used up"
                return
            if state["bytes"] > budget:
                state["stop"] = "size budget used up"
                return
        try:
            n = fetch_block(block)
        except RuntimeError as e:
            with lock:
                state["failed"] += 1
            print("  FAILED", e, flush=True)
            return
        with lock:
            state["bytes"] += n
            state["done"] += 1
            d = state["done"]
        if d % 10 == 0:
            print(f"  {d}/{len(todo)} blocks, {state['bytes'] / 2**20:.0f} MB, {time.time() - t0:.0f} s (now k={block[0]})", flush=True)
        if d % 40 == 0:
            with lock:
                write_index()

    # The network here drops now and then: blocks that failed are tried again in later passes
    # (after a pause) while the budgets last. Squares on disk are never asked for twice.
    for attempt in range(4):
        if attempt:
            todo = [b for b in todo if any(not tile_path(*t).exists() for t in block_tiles(b))]
            if not todo or state["stop"]:
                break
            print(f"  pass {attempt + 1}: {len(todo)} blocks to try again in 30 s", flush=True)
            time.sleep(30)
        with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
            for f in as_completed([pool.submit(work, b) for b in todo]):
                f.result()
        if not state["failed"]:
            break
        state["failed"] = 0
    count, total = write_index()
    print("overview picture " + ("written: " + str(OVERVIEW) if write_overview() else "NOT written (level 3 incomplete)"), flush=True)
    left = [b for b in plan() if any(not tile_path(*t).exists() for t in block_tiles(b))]
    print(f"done: {count} squares, {total / 2**20:.1f} MB, {time.time() - t0:.0f} s; {state['failed']} blocks failed, {len(left)} blocks still missing"
          + (f" ({state['stop']})" if state["stop"] else ""), flush=True)


if __name__ == "__main__":
    main()
