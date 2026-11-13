"""Build the whole-Moon pictures that ship with the app (v5: seamless), so the globe is never blank or
blocky at start, still works with no internet, and shows no join anywhere.

Sources (all NASA / NASA-funded, official servers):
  - NASA Moon Trek, LRO WAC global morphologic mosaic (LRO_WAC_Mosaic_Global_303ppd_v02): the photo.
  - NASA Moon Trek, LRO LOLA hillshade (LRO_LOLA_Shade_Global_256ppd_v06, lit from azimuth ~261 deg).
  - NASA SVS CGI Moon Kit 2025 colour map (svs.gsfc.nasa.gov/4720; LROC WAC Hapke-normalised mosaic,
    643/566/415 nm; the red band is used as the albedo, i.e. brightness without shading).
  - LROC WAC South and North Pole Summer mosaics (ASU Lunaserv WMS, layers luna_wac_roi_south_summer and
    luna_wac_roi_north_summer).

Why v5: the WAC global mosaic is lit from the WEST everywhere except true lon -180..-90, which is lit from
the EAST (measured: the photo's fine detail regressed on LOLA slopes gives sun azimuths 250-287 deg
elsewhere and 77-103 deg there; the flips are sharp lines exactly at -90 and 180, at every latitude). In
the app's rotated display frame both lines lie on map-tile edges, so they show as crisp straight lines and
the whole Moon looks like two halves glued together. Here that quadrant is replaced by
    k * albedo^2.2 * exp(0.85 * h_lo + 0.5 * (h - h_lo)),  h = hillshade / 170 - 1, h_lo = h smoothed at 2.7 km
    (the hillshade is lit from the west, like the photo)
with k matching the photo's brightness at a 2 deg scale; the exponent and shading strength come from
regressing the photo's detail on albedo and hillshade where the photo is lit from the west. It cross-fades into the photo over lon -90..-80 and 165..180, where the photo is lit
from the west too, so no east-lit pixel is left and there is no line. Near both poles the evenly lit
summer mosaics are used (only them beyond 64 deg, fading in from 58 deg).

The app draws the Moon in a rotated "display frame" (app/src/moon/frame.ts: display = (x, -z, y) of true
Moon coordinates; the true poles sit on the display equator at 90E / 90W). The pictures made here are
plain longitude/latitude pictures OF THAT DISPLAY FRAME, so the app can cut map tiles straight out of them:

  v5/moon8k.jpg   8192 x 4096  whole Moon, display lon -180..180, lat 90..-90 (display tile levels 0-4, 1.33 km/px)
  v5/moon2k.jpg   2048 x 1024  the same, small (shown while moon8k.jpg decodes). Made with "pole-aware"
                  halving: near the display poles (true 0N 90E and 0N 90W) a display row is a tiny circle, and a
                  plain 2x2 average there blurs only along the radius -> radial streaks. Each pixel here averages
                  a square patch on the sphere instead.
  v5/south6.jpg   6144 x 6144  within 33.75 deg of the true south pole at display level 6 (333 m/px)
  v5/north6.jpg   6144 x 6144  within 33.75 deg of the true north pole at display level 6 (from level-5 sources)
  v5/albedo.jpg   3186 x 4096  TRUE lon 150..290 (= -70), lat 90..-90: the brightness-matched albedo the app
                  multiplies with streamed hillshade tiles when you zoom into the fixed quadrant (same formula)
  v5/base.json    what each file covers, and the fix parameters

Raw downloads go to data-raw/ (resumable; delete them after a successful run if disk is short).
Run: ../.venv-data/bin/python -I base_mosaic.py [--skip-south] [--skip-north]
"""
import argparse
import io
import json
import math
import pathlib
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image
from scipy import ndimage

Image.MAX_IMAGE_PIXELS = None
ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "app/public/data/base/v5"
RAW = ROOT / "data-raw/trek-wac"
LAYER = "LRO_WAC_Mosaic_Global_303ppd_v02"
UA = "MOONDA-student-project/1.0 (NASA Space Apps; base mosaic)"
PARALLEL = 6
T = 256

GLOBAL_Z = 5  # 16384 x 8192 source for the 8192 x 4096 picture (2 x 2 source pixels per output pixel)
GLOBAL_W, GLOBAL_H = 8192, 4096
SOUTH_Z = 6  # same north-south detail as display level 6
SOUTH_LEVEL = 6
SOUTH_HALF_DEG = 33.75  # 6 level-5 display tiles each way from the true pole
SOUTH_PX = int(round(2 * SOUTH_HALF_DEG / (180 / (T * 2 ** SOUTH_LEVEL))))  # 6144
MAX_BYTES_GLOBAL = 8 * 2 ** 20
MAX_BYTES_SOUTH = 10 * 2 ** 20

R_MOON = 1737400.0

# The evenly lit polar summer mosaics (Lunaserv WMS, polar stereographic, 1024 km either way of the pole).
SUMMER_HALF = 1024000.0
SUMMER_BLOCKS = 4  # 4 x 4 requests ...
SUMMER_BLOCK_PX = 2048  # ... of 2048 px each: 8192 px, 250 m per pixel
SUMMER_FULL = 64.0  # beyond this latitude only the summer mosaic
SUMMER_NONE = 58.0  # nearer the equator than this only the global picture
SUMMER_HOSTS = ["wms", "wms1", "wms2", "wms3"]
POLES = {
    # sign = +1 north, -1 south. South: x = rho sin(lon), y = rho cos(lon), rho = 2R tan(pi/4 + lat/2).
    # North: x = rho sin(lon), y = -rho cos(lon), rho = 2R tan(pi/4 - lat/2) (checked against the global mosaic).
    "south": {"sign": -1, "layer": "luna_wac_roi_south_summer", "srs": "IAU2000:30120", "raw": ROOT / "data-raw/lunaserv-summer"},
    "north": {"sign": 1, "layer": "luna_wac_roi_north_summer", "srs": "IAU2000:30118", "raw": ROOT / "data-raw/lunaserv-summer-north"},
}

# The east-lit quadrant fix (see the top of this file).
SHADE_LAYER = "LRO_LOLA_Shade_Global_256ppd_v06"
SHADE_RAW = ROOT / "data-raw/trek-lola-shade"
ALBEDO_TIF = pathlib.Path("/Volumes/CodexWork/Projects/MOONDA/data-raw/source/reference-v2/lroc-color-2025-16k.tif")
FIX_WEST, FIX_EAST = 150.0, 290.0  # true longitudes (east = -70 + 360) where the fix is computed (with margins for the 2 deg match)
BAND_WEST = (-90.0, -80.0)  # synthetic at -90 -> photo at -80
BAND_EAST = (165.0, 180.0)  # photo at 165 -> synthetic at 180
# The photo's log-brightness detail, regressed on log(albedo) and the hillshade where the photo is lit from the
# west (lon 100..155E, 50S..50N): albedo exponent 2.2 (2.6 at the finest scale), shading 0.84-0.89 at 3-27 km
# and 0.5 at 1.3-2.7 km (r2 0.71-0.78 at 3-27 km). So, with h = hillshade / S0 - 1 and h_lo = h smoothed at 2.7 km:
#   synthetic = k * albedo^P * exp(C_LO * h_lo + C * (h - h_lo)) = albedo_scaled * exp(C * h),
#   albedo_scaled = k * albedo^P * exp((C_LO - C) * h_lo)   (smooth, so it fits the app's 1.33 km albedo picture;
# the app's streamed tiles then only need exp(C * h) at any resolution).
ALBEDO_P = 2.2
SHADE_C = 0.5  # finest scales
SHADE_C_LO = 0.85  # 2.7 km and larger
LO_SIGMA_KM = 2.7
SHADE_S0 = 170.0  # hillshade value of flat ground
MATCH_DEG = 2.0  # brightness matched to the photo at this scale (Gaussian sigma)
ALBEDO_PPD = 8192 / 360  # the app's copy: 22.76 px per degree (1.33 km)


def smooth(t):
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def fix_weight(lon_deg):
    """How much of the fixed picture (1) vs the photo (0) is shown at true longitude lon_deg (same as imageryWorker.ts fixWeight)."""
    lon = (np.asarray(lon_deg, np.float64) + 180.0) % 360.0 - 180.0
    w = np.zeros_like(lon)
    w = np.where(lon <= BAND_WEST[0], 1.0, w)
    w = np.where((lon > BAND_WEST[0]) & (lon < BAND_WEST[1]), 1 - smooth((lon - BAND_WEST[0]) / (BAND_WEST[1] - BAND_WEST[0])), w)
    w = np.where(lon >= BAND_EAST[0], smooth((lon - BAND_EAST[0]) / (BAND_EAST[1] - BAND_EAST[0])), w)
    w = np.where(lon >= 180.0 - 1e-12, 1.0, w)
    return w.astype(np.float32)


def shade_factor(s, c=SHADE_C):
    return np.exp(c * (s / SHADE_S0 - 1)).astype(np.float32)


# ---------------------------------------------------------------------------------------------------------
# Downloads

def trek_url(layer, z, x, y, ext):
    return f"https://trek.nasa.gov/tiles/Moon/EQ/{layer}/1.0.0/default/default028mm/{z}/{y}/{x}.{ext}"


def tile_file(z, x, y, raw=RAW, ext="jpg"):
    return raw / str(z) / f"{y}_{x}.{ext}"


def fetch_tile(z, x, y, layer=LAYER, raw=RAW, ext="jpg"):
    """Download one tile unless it is on disk. Returns bytes downloaded, or -1 if it failed for now."""
    path = tile_file(z, x, y, raw, ext)
    if path.exists() and path.stat().st_size > 0:
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(4):
        try:
            req = urllib.request.Request(trek_url(layer, z, x, y, ext), headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=45) as r:
                data = r.read()
            img = Image.open(io.BytesIO(data))
            img.load()
            if img.size != (T, T):
                raise RuntimeError(f"wrong size {img.size}")
            tmp = path.with_suffix(f".{threading.get_ident()}.tmp")
            tmp.write_bytes(data)
            tmp.replace(path)
            return len(data)
        except (urllib.error.URLError, OSError, RuntimeError, ValueError):  # noqa: PERF203
            time.sleep(2 * (attempt + 1))
    return -1


def download(z, tiles, layer=LAYER, raw=RAW, ext="jpg", rounds=12, wait_s=30):
    """Fetch what is missing, retrying failures in later rounds; tiles on disk are never asked for twice."""
    have = lambda t: tile_file(z, *t, raw, ext).exists() and tile_file(z, *t, raw, ext).stat().st_size > 0  # noqa: E731
    todo = [t for t in tiles if not have(t)]
    print(f"{layer} level {z}: {len(tiles)} tiles needed, {len(todo)} to download", flush=True)
    t0, total = time.time(), 0
    for rnd in range(rounds):
        if not todo:
            break
        if rnd:
            print(f"  {len(todo)} tiles failed, trying them again in {wait_s} s (round {rnd + 1}/{rounds})", flush=True)
            time.sleep(wait_s)
        done = 0
        with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
            for n in pool.map(lambda t: fetch_tile(z, *t, layer, raw, ext), todo):
                done += 1
                total += max(n, 0)
                if done % 200 == 0:
                    print(f"  {done}/{len(todo)}  {total / 2**20:.0f} MB  {time.time() - t0:.0f} s", flush=True)
        todo = [t for t in todo if not have(t)]
    if todo:
        raise SystemExit(f"level {z}: {len(todo)} tiles still missing (network?). Run the script again: it continues where it stopped.")
    if total:
        print(f"  downloaded {total / 2**20:.0f} MB in {time.time() - t0:.0f} s", flush=True)


def summer_file(pole, i, j):
    return POLES[pole]["raw"] / f"{i}_{j}.jpg"


def fetch_summer(pole, i, j):
    """One 2048 px block of a summer mosaic (column i from the left, row j from the top). True if it is on disk."""
    path = summer_file(pole, i, j)
    if path.exists() and path.stat().st_size > 0:
        return True
    path.parent.mkdir(parents=True, exist_ok=True)
    p = POLES[pole]
    s = 2 * SUMMER_HALF / SUMMER_BLOCKS
    x0, y1 = -SUMMER_HALF + i * s, SUMMER_HALF - j * s
    url = (f"https://{SUMMER_HOSTS[(i + j) % len(SUMMER_HOSTS)]}.im-ldi.com/?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&STYLES=&LAYERS={p['layer']}"
           f"&SRS={p['srs']}&BBOX={x0},{y1 - s},{x0 + s},{y1}&WIDTH={SUMMER_BLOCK_PX}&HEIGHT={SUMMER_BLOCK_PX}&FORMAT=image/jpeg")
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                ctype, data = r.headers.get("Content-Type", ""), r.read()
            if "jpeg" not in ctype:
                raise RuntimeError(f"not a picture ({ctype})")
            img = Image.open(io.BytesIO(data))
            img.load()
            if img.size != (SUMMER_BLOCK_PX, SUMMER_BLOCK_PX):
                raise RuntimeError(f"wrong size {img.size}")
            tmp = path.with_suffix(f".{threading.get_ident()}.tmp")
            tmp.write_bytes(data)
            tmp.replace(path)
            time.sleep(0.25)
            return True
        except (urllib.error.URLError, OSError, RuntimeError, ValueError):  # noqa: PERF203
            time.sleep(3 * (attempt + 1))
    return False


def load_summer(pole, rounds=10, wait_s=30):
    """A summer mosaic as grey arrays: full size (250 m per pixel) and three half-size copies."""
    todo = [(i, j) for j in range(SUMMER_BLOCKS) for i in range(SUMMER_BLOCKS) if not (summer_file(pole, i, j).exists() and summer_file(pole, i, j).stat().st_size > 0)]
    print(f"{pole}-pole summer mosaic: {SUMMER_BLOCKS ** 2} blocks needed, {len(todo)} to download", flush=True)
    for rnd in range(rounds):
        if not todo:
            break
        if rnd:
            print(f"  {len(todo)} blocks failed, trying them again in {wait_s} s (round {rnd + 1}/{rounds})", flush=True)
            time.sleep(wait_s)
        with ThreadPoolExecutor(max_workers=2) as pool:
            ok = list(pool.map(lambda t: fetch_summer(pole, *t), todo))
        todo = [t for t, good in zip(todo, ok) if not good]
    if todo:
        raise SystemExit(f"{pole} summer mosaic: {len(todo)} blocks still missing (network?). Run the script again: it continues where it stopped.")
    n = SUMMER_BLOCKS * SUMMER_BLOCK_PX
    full = np.zeros((n, n), np.float32)
    for j in range(SUMMER_BLOCKS):
        for i in range(SUMMER_BLOCKS):
            full[j * SUMMER_BLOCK_PX:(j + 1) * SUMMER_BLOCK_PX, i * SUMMER_BLOCK_PX:(i + 1) * SUMMER_BLOCK_PX] = np.asarray(Image.open(summer_file(pole, i, j)).convert("L"))
    out = [full]
    for _ in range(3):
        a = out[-1]
        out.append((a[0::2, 0::2] + a[1::2, 0::2] + a[0::2, 1::2] + a[1::2, 1::2]) * 0.25)
    return out


def summer_blend(value, tlat, tlon, pole, summer, spacing_m):
    """Replace `value` (the global picture sampled at true lat/lon) by a summer mosaic near its pole."""
    sign = POLES[pole]["sign"]
    w = np.clip((sign * tlat - math.radians(SUMMER_NONE)) / math.radians(SUMMER_FULL - SUMMER_NONE), 0.0, 1.0)
    sel = w > 0
    if not sel.any():
        return value
    w = w[sel]
    w = (w * w * (3 - 2 * w)).astype(np.float32)
    px0 = 2 * SUMMER_HALF / summer[0].shape[1]
    m = int(min(len(summer) - 1, max(0, math.floor(math.log2(max(spacing_m / px0, 1.0))))))
    a = summer[m]
    n = a.shape[0]
    rho = 2 * R_MOON * np.tan(np.pi / 4 - sign * tlat[sel] / 2)
    lon = np.broadcast_to(tlon, tlat.shape)[sel]
    x, y = rho * np.sin(lon), -sign * rho * np.cos(lon)
    u = (x + SUMMER_HALF) * (n / (2 * SUMMER_HALF)) - 0.5
    v = (SUMMER_HALF - y) * (n / (2 * SUMMER_HALF)) - 0.5
    c0 = np.clip(np.floor(u).astype(np.int64), 0, n - 2)
    r0 = np.clip(np.floor(v).astype(np.int64), 0, n - 2)
    tx, ty = np.clip(u - c0, 0, 1).astype(np.float32), np.clip(v - r0, 0, 1).astype(np.float32)
    s = (a[r0, c0] * (1 - tx) + a[r0, c0 + 1] * tx) * (1 - ty) + (a[r0 + 1, c0] * (1 - tx) + a[r0 + 1, c0 + 1] * tx) * ty
    out = value.copy()
    out[sel] = value[sel] * (1 - w) + s * w
    return out


# ---------------------------------------------------------------------------------------------------------
# Source pictures (true lon/lat)

def assemble(z, row0, row1, raw=RAW, ext="jpg"):
    """Source rows row0..row1 (tile rows, inclusive) as one grey array, all longitudes."""
    n = 2 ** (z + 1)
    out = np.zeros(((row1 - row0 + 1) * T, n * T), np.uint8)
    for y in range(row0, row1 + 1):
        for x in range(n):
            f = tile_file(z, x, y, raw, ext)
            if f.exists():
                out[(y - row0) * T:(y - row0 + 1) * T, x * T:(x + 1) * T] = np.asarray(Image.open(f).convert("L"))
    return out


def fix_columns(width):
    """Column ranges (two pieces, across 180) of the fix region in a global true lon/lat picture `width` wide."""
    c0 = int(round((FIX_WEST + 180) / 360 * width))
    c1 = int(round((FIX_EAST - 360 + 180) / 360 * width))
    return c0, c1  # region = [c0, width) + [0, c1)


def region(a, c0, c1):
    return np.concatenate([a[:, c0:], a[:, :c1]], 1)


def put_region(a, c0, c1, r):
    n = a.shape[1] - c0
    a[:, c0:] = r[:, :n]
    a[:, :c1] = r[:, n:]


def lowpass(x, sigma_px, f=8):
    """Gaussian low-pass of a big picture: computed f times smaller, then scaled back up."""
    h, w = x.shape
    hh, ww = h // f * f, w // f * f
    small = x[:hh, :ww].reshape(hh // f, f, ww // f, f).mean(axis=(1, 3))
    small = ndimage.gaussian_filter(small, sigma_px / f, mode="nearest")
    big = ndimage.zoom(small, f, order=1, mode="nearest", grid_mode=True)
    out = np.empty_like(x)
    out[:hh, :ww] = big[:hh, :ww]
    if hh < h:
        out[hh:, :] = out[hh - 1:hh, :]
    if ww < w:
        out[:, ww:] = out[:, ww - 1:ww]
    return out


def build_fix(photo):
    """The synthetic picture for the fix region of the level-5 global photo (16384 x 8192, true lon/lat).
    Returns (c0, c1, synthetic, weight, albedo_scaled) on the region grid."""
    import rasterio
    from rasterio.windows import Window
    z = GLOBAL_Z
    width = T * 2 ** (z + 1)
    c0, c1 = fix_columns(width)
    cols = list(range(int(c0 // T), width // T)) + list(range(0, int(math.ceil(c1 / T))))
    download(z, [(x, y) for y in range(2 ** z) for x in cols], SHADE_LAYER, SHADE_RAW, "png")
    shade_all = assemble(z, 0, 2 ** z - 1, SHADE_RAW, "png")
    # NASA's hillshades have a darker first/last pixel column at 180 deg (computed without wrapping): use the neighbours
    shade_all[:, 0] = shade_all[:, 1]
    shade_all[:, -1] = shade_all[:, -2]
    shade = region(shade_all.astype(np.float32), c0, c1)
    del shade_all
    with rasterio.open(ALBEDO_TIF) as d:
        assert d.width == width and d.height == width // 2, "the CGI Moon Kit 16k colour map should be 16384 x 8192"
        alb = np.concatenate([d.read(1, window=Window(c0, 0, width - c0, d.height)), d.read(1, window=Window(0, 0, c1, d.height))], 1).astype(np.float32)
    g = region(photo, c0, c1).astype(np.float32)
    ppd = width / 360
    h = shade / SHADE_S0 - 1
    h_lo = ndimage.gaussian_filter(h, LO_SIGMA_KM * 1000 / (math.radians(1 / ppd) * R_MOON), mode="nearest")
    sh = shade_factor(shade)
    alb = (alb / np.median(alb)) ** ALBEDO_P * np.exp((SHADE_C_LO - SHADE_C) * h_lo)
    del h, h_lo
    syn0 = alb * sh
    k = lowpass(g, MATCH_DEG * ppd) / np.maximum(lowpass(syn0, MATCH_DEG * ppd), 1e-6)
    albedo_scaled = alb * k  # brightness-matched albedo: synthetic = albedo_scaled * shade_factor(hillshade)
    syn = np.clip(albedo_scaled * sh, 0, 255)
    lon = FIX_WEST + (np.arange(syn.shape[1]) + 0.5) / ppd
    w = fix_weight(lon)[None, :]
    q = (slice(int(30 * ppd), int(150 * ppd)), slice(int((190 - FIX_WEST) * ppd), int((260 - FIX_WEST) * ppd)))
    print(f"fix: detail std photo {(g[q] - ndimage.gaussian_filter(g[q], 6)).std():.1f}, synthetic {(syn[q] - ndimage.gaussian_filter(syn[q], 6)).std():.1f}", flush=True)
    return c0, c1, syn, w, albedo_scaled


def apply_fix(photo, fix):
    """Cross-fade the level-5 photo into the synthetic picture (in place)."""
    c0, c1, syn, w, _ = fix
    g = region(photo, c0, c1).astype(np.float32)
    put_region(photo, c0, c1, np.clip(np.rint(g * (1 - w) + syn * w), 0, 255).astype(np.uint8))


def apply_fix_z6(src6, row0, fix):
    """The same cross-fade on level-6 photo rows (row0 = first tile row): the synthetic picture is upsampled 2x."""
    c0, c1, syn, w, _ = fix
    width6 = src6.shape[1]
    d0, d1 = 2 * c0, 2 * c1
    r0 = row0 * T // 2  # level-5 pixel row of the first level-6 row
    nrows5 = src6.shape[0] // 2
    part = syn[r0:r0 + nrows5 + 1]
    up = ndimage.zoom(part, 2, order=1, mode="nearest", grid_mode=True)[:src6.shape[0]]
    wu = np.repeat(w, 2, axis=1)
    g = region(src6, d0, d1).astype(np.float32)
    assert up.shape[1] == g.shape[1] == width6 - d0 + d1
    put_region(src6, d0, d1, np.clip(np.rint(g * (1 - wu) + up * wu), 0, 255).astype(np.uint8))


# ---------------------------------------------------------------------------------------------------------
# Drawing display-frame pictures

def east_west_copies(src, levels):
    """The source averaged east-west by 1, 2, 4, ... (north-south size unchanged)."""
    out = [src.astype(np.float32)]
    for _ in range(levels):
        a = out[-1]
        if a.shape[1] < 8:
            break
        out.append((a[:, 0::2] + a[:, 1::2]) * 0.5)
    return out


def display_to_true(lon, lat):
    """Display lon/lat (radians) -> true lat/lon (radians), as in frame.ts / imageryWorker.ts."""
    cl = np.cos(lat)
    X, Y, Z = cl * np.cos(lon), cl * np.sin(lon), np.sin(lat)
    return np.arcsin(np.clip(-Y, -1, 1)), np.arctan2(Z, X)  # true = (X, Z, -Y)


def sample(copies, z, row0, tlat, tlon, footprint):
    """Read the source at true lat/lon. footprint = east-west size of one sample in source pixels at the equator."""
    full_w = T * 2 ** (z + 1)
    squeeze = footprint / np.maximum(np.cos(tlat), 1e-6)
    m = np.clip(np.rint(np.log2(np.maximum(squeeze, 1.0))), 0, len(copies) - 1).astype(np.int8)
    v = (np.pi / 2 - tlat) * (T * 2 ** z) / np.pi - 0.5 - row0 * T
    out = np.zeros(tlat.shape, np.float32)
    for lvl in np.unique(m):
        a = copies[lvl]
        h, w = a.shape
        sel = m == lvl
        u = (tlon[sel] + np.pi) * (full_w / (2 * np.pi)) / 2 ** int(lvl) - 0.5
        vv = np.clip(v[sel], 0, h - 1)
        c0 = np.floor(u).astype(np.int64)
        r0 = np.minimum(np.floor(vv).astype(np.int64), h - 2) if h > 1 else np.zeros_like(c0)
        tx, ty = (u - c0).astype(np.float32), (vv - r0).astype(np.float32)
        ca, cb = c0 % w, (c0 + 1) % w  # longitude wraps
        r1 = np.minimum(r0 + 1, h - 1)
        out[sel] = (a[r0, ca] * (1 - tx) + a[r0, cb] * tx) * (1 - ty) + (a[r1, ca] * (1 - tx) + a[r1, cb] * tx) * ty
    return out


def render(copies, z, row0, west, north, deg_per_px, width, height, sub, summers=()):
    """A display-frame lon/lat picture: `sub` x `sub` samples averaged per pixel. summers = [(pole, arrays), ...]."""
    spacing_m = math.radians(deg_per_px / sub) * R_MOON
    out = np.zeros((height, width), np.uint8)
    src_px_deg = 360.0 / (T * 2 ** (z + 1))
    footprint = (deg_per_px / sub) / src_px_deg
    offs = [(k + 0.5) / sub for k in range(sub)]
    cols = np.arange(width, dtype=np.float64)
    for j0 in range(0, height, 256):
        j1 = min(height, j0 + 256)
        rows = np.arange(j0, j1, dtype=np.float64)
        acc = np.zeros((j1 - j0, width), np.float32)
        for oy in offs:
            lat = np.radians(north - (rows + oy) * deg_per_px)
            for ox in offs:
                lon = np.radians(west + (cols + ox) * deg_per_px)
                tlat, tlon = display_to_true(lon[None, :], lat[:, None])
                part = sample(copies, z, row0, tlat, tlon, footprint)
                for pole, arrays in summers:
                    part = summer_blend(part, tlat, tlon, pole, arrays, spacing_m)
                acc += part
        out[j0:j1] = np.clip(np.rint(acc / (sub * sub)), 0, 255).astype(np.uint8)
    return out


def halve_pole_aware(a):
    """Halve a whole-globe display lon/lat picture so every output pixel averages a square patch on the
    sphere: rows near the display poles are averaged east-west over 2/cos(lat) pixels (wrapping), not 2.
    (Same rule as halvePoleAware in imageryWorker.ts.)"""
    h, w = a.shape
    lat = np.radians(90 - (np.arange(h // 2) + 0.5) * 180 / (h // 2))
    pair = (a[0::2].astype(np.float64) + a[1::2]) * 0.5
    trip = np.concatenate([pair, pair, pair], 1)
    cs = np.concatenate([np.zeros((h // 2, 1)), np.cumsum(trip, 1)], 1)
    xc = np.arange(w // 2) * 2 + 1.0 + w
    out = np.empty((h // 2, w // 2), np.float32)
    for j in range(h // 2):
        k = min(float(w), 2.0 / max(math.cos(lat[j]), 1e-9))
        lo, hi = xc - k / 2, xc + k / 2
        row = cs[j]
        li, hi_i = np.floor(lo).astype(np.int64), np.floor(hi).astype(np.int64)
        s_lo = row[li] + (lo - li) * (row[li + 1] - row[li])
        s_hi = row[hi_i] + (hi - hi_i) * (row[np.minimum(hi_i + 1, row.size - 1)] - row[hi_i])
        out[j] = (s_hi - s_lo) / k
    return out


def save_jpeg(arr, path, max_bytes, first_quality=90):
    img = Image.fromarray(arr, "L")
    for q in range(first_quality, 59, -2):
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=q, optimize=True)
        if buf.tell() <= max_bytes:
            break
    path.write_bytes(buf.getvalue())
    print(f"saved {path.name}: {arr.shape[1]} x {arr.shape[0]}, quality {q}, {buf.tell() / 2**20:.2f} MB", flush=True)
    return q


def cap_rows(z):
    """Source tile rows a polar picture needs (down to the true latitude of its corners), for the south cap."""
    h = np.radians(SOUTH_HALF_DEG)
    lowest_lat = -np.degrees(np.arccos(np.cos(h) * np.cos(h)))
    rows = 2 ** z
    first = int(np.floor((90 - lowest_lat) / (180 / rows))) - 1
    return max(0, first), rows - 1


def cap_tiles(z, west):
    """Only the Moon Trek tiles a polar picture really reads (its corners reach further from the pole than its sides).
    west = display lon of the picture's left edge (56.25 for the south cap)."""
    row0, row1 = cap_rows(z)
    deg = 2 * SOUTH_HALF_DEG / 768  # a coarse grid is enough to find the tiles
    lon = np.radians(west + (np.arange(769)) * deg)
    lat = np.radians(SOUTH_HALF_DEG - (np.arange(769)) * deg)
    tlat, tlon = display_to_true(lon[None, :], lat[:, None])
    n = 2 ** (z + 1)
    ty = np.clip(np.floor((np.pi / 2 - tlat) / np.pi * 2 ** z).astype(int), 0, 2 ** z - 1)
    need = set()
    for y in range(row0, row1 + 1):
        sel = ty == y
        if not sel.any():
            continue
        lat_mid = np.pi / 2 - (y + 0.5) * np.pi / 2 ** z
        spread = int(np.ceil(1.0 / max(np.cos(lat_mid), 1e-3) / T)) + 1
        tx = np.floor((tlon[sel] + np.pi) / (2 * np.pi) * n).astype(int)
        cols = set()
        for d in range(-spread, spread + 1):
            cols.update(((tx + d) % n).tolist())
        if y >= 2 ** z - 3:
            cols = set(range(n))  # the last rows wrap right round the pole
        need.update((x, y) for x in cols)
    return sorted(need), row0, row1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-south", action="store_true")
    ap.add_argument("--skip-north", action="store_true")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    meta = {
        "about": "Local pictures of the Moon in the app's DISPLAY frame (display = (x, -z, y) of true Moon coordinates): plain lon/lat grids, lon west to east left to right, lat north to south top to bottom. v5: no lighting seams (see data-prep/base_mosaic.py).",
        "source": "NASA Moon Trek LRO WAC global mosaic (LRO_WAC_Mosaic_Global_303ppd_v02) and LOLA hillshade (LRO_LOLA_Shade_Global_256ppd_v06); NASA SVS CGI Moon Kit 2025 colour map (LROC WAC Hapke-normalised); LROC WAC South/North Pole Summer mosaics (ASU Lunaserv). NASA/GSFC/Arizona State University",
        "sourceUrl": "https://trek.nasa.gov/moon/ ; https://svs.gsfc.nasa.gov/4720/ ; https://wms.im-ldi.com/",
        "pictures": {},
    }
    summers = [(p, load_summer(p)) for p in ("south", "north")]
    meta["polar"] = {"source": "LROC WAC South and North Pole Summer mosaics, ASU Lunaserv WMS (luna_wac_roi_south_summer, luna_wac_roi_north_summer)",
                     "onlyBeyondLatDeg": SUMMER_FULL, "noneBelowLatDeg": SUMMER_NONE}

    n = 2 ** (GLOBAL_Z + 1)
    download(GLOBAL_Z, [(x, y) for y in range(2 ** GLOBAL_Z) for x in range(n)])
    t0 = time.time()
    photo5 = assemble(GLOBAL_Z, 0, 2 ** GLOBAL_Z - 1)
    fix = build_fix(photo5)
    apply_fix(photo5, fix)
    print(f"quadrant fix built in {time.time() - t0:.0f} s", flush=True)

    # the app's copy of the brightness-matched albedo (true lon/lat, FIX_WEST..FIX_EAST, 22.76 px/deg)
    albedo = fix[4]
    hh, ww = albedo.shape[0] // 2 * 2, albedo.shape[1] // 2 * 2
    alb2 = albedo[:hh, :ww].reshape(hh // 2, 2, ww // 2, 2).mean(axis=(1, 3))
    scale = float(np.percentile(alb2, 99.95)) / 250.0
    save_jpeg(np.clip(np.rint(alb2 / scale), 0, 255).astype(np.uint8), OUT / "albedo.jpg", 4 * 2 ** 20, 92)
    meta["fix"] = {
        "about": "True lon -180..-90 of the WAC mosaic is lit from the east (everything else from the west). There the app shows albedo x hillshade instead: value = albedo.jpg * scale * exp(C * (hillshade / S0 - 1)); cross-fades: synthetic at -90 -> photo at -80, photo at 165 -> synthetic at 180 (smoothstep).",
        "albedo": {"file": "albedo.jpg", "width": int(alb2.shape[1]), "height": int(alb2.shape[0]), "west": FIX_WEST, "east": FIX_EAST, "north": 90, "south": -90, "scale": round(scale, 6)},
        "hillshade": {"near": "LRO_LrocKaguya_Shade_60N60S_512ppd", "far": SHADE_LAYER, "nearMaxLat": 59.5},
        "C": SHADE_C, "S0": SHADE_S0, "albedoExponent": ALBEDO_P, "cLarge": SHADE_C_LO, "largeFromKm": LO_SIGMA_KM, "bandWest": list(BAND_WEST), "bandEast": list(BAND_EAST),
    }

    t0 = time.time()
    copies = east_west_copies(photo5, 8)
    big = render(copies, GLOBAL_Z, 0, -180.0, 90.0, 360.0 / GLOBAL_W, GLOBAL_W, GLOBAL_H, 2, summers)
    del copies
    print(f"whole-Moon picture drawn in {time.time() - t0:.0f} s", flush=True)
    save_jpeg(big, OUT / "moon8k.jpg", MAX_BYTES_GLOBAL)
    small = halve_pole_aware(halve_pole_aware(big.astype(np.float32)))
    save_jpeg(np.clip(np.rint(small), 0, 255).astype(np.uint8), OUT / "moon2k.jpg", 2 ** 20, 88)
    del big, small
    meta["pictures"]["global"] = {"file": "moon8k.jpg", "width": GLOBAL_W, "height": GLOBAL_H, "west": -180, "east": 180, "north": 90, "south": -90, "level": 4, "poleAware": True}
    meta["pictures"]["quick"] = {"file": "moon2k.jpg", "width": GLOBAL_W // 4, "height": GLOBAL_H // 4, "west": -180, "east": 180, "north": 90, "south": -90, "level": 2, "poleAware": True}
    (OUT / "base.json").write_text(json.dumps(meta, indent=1))

    deg = 180 / (T * 2 ** SOUTH_LEVEL)
    if not a.skip_north:
        # The true north pole is at display (0N, 90W): the picture spans display lon -123.75..-56.25. Drawn from
        # the fixed level-5 photo (Moon Trek level 6 is not stored); beyond 64N it is the summer mosaic anyway.
        t0 = time.time()
        copies = east_west_copies(photo5, 9)
        north = render(copies, GLOBAL_Z, 0, -90 - SOUTH_HALF_DEG, SOUTH_HALF_DEG, deg, SOUTH_PX, SOUTH_PX, 1, summers)
        del copies
        print(f"north picture drawn in {time.time() - t0:.0f} s", flush=True)
        save_jpeg(north, OUT / "north6.jpg", MAX_BYTES_SOUTH, 88)
        meta["pictures"]["north"] = {"file": "north6.jpg", "width": SOUTH_PX, "height": SOUTH_PX, "west": -90 - SOUTH_HALF_DEG, "east": -90 + SOUTH_HALF_DEG,
                                     "north": SOUTH_HALF_DEG, "south": -SOUTH_HALF_DEG, "level": SOUTH_LEVEL}
        (OUT / "base.json").write_text(json.dumps(meta, indent=1))
        del north
    if not a.skip_south:
        tiles, row0, row1 = cap_tiles(SOUTH_Z, 90 - SOUTH_HALF_DEG)
        download(SOUTH_Z, tiles)
        t0 = time.time()
        src6 = assemble(SOUTH_Z, row0, row1)
        apply_fix_z6(src6, row0, fix)
        copies = east_west_copies(src6, 9)
        south = render(copies, SOUTH_Z, row0, 90 - SOUTH_HALF_DEG, SOUTH_HALF_DEG, deg, SOUTH_PX, SOUTH_PX, 1, summers)
        del copies, src6
        print(f"south picture drawn in {time.time() - t0:.0f} s", flush=True)
        save_jpeg(south, OUT / "south6.jpg", MAX_BYTES_SOUTH, 88)
        meta["pictures"]["south"] = {"file": "south6.jpg", "width": SOUTH_PX, "height": SOUTH_PX, "west": 90 - SOUTH_HALF_DEG, "east": 90 + SOUTH_HALF_DEG,
                                     "north": SOUTH_HALF_DEG, "south": -SOUTH_HALF_DEG, "level": SOUTH_LEVEL}
        (OUT / "base.json").write_text(json.dumps(meta, indent=1))
    print("done", flush=True)


if __name__ == "__main__":
    main()
