"""Shared grid definition, coordinate helpers, colormaps and writers for the
MOONDA south-polar science layers.

Output grid contract (the app depends on this exactly):
  * South polar stereographic on a 1,737,400 m sphere, pole at the centre,
    latitude of true scale -90 deg, central meridian 0 deg.
  * x = rho * sin(lon) (toward 90E), y = rho * cos(lon) (toward 0E),
    rho = 2 R tan(pi/4 + lat/2) with lat negative (south).
  * x, y in [-304000, +304000] m, 2048 x 2048 pixels, row 0 = top (y = +304000).
"""
from __future__ import annotations

import json
import math
import os

import numpy as np
from PIL import Image
from rasterio.crs import CRS
from rasterio.transform import Affine
from rasterio.warp import Resampling, reproject

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------
PROJECT = "/Volumes/CodexWork/Projects/MOONDA"
RAW = os.path.join(PROJECT, "data-raw")
PREP = os.path.join(PROJECT, "data-prep", "layers")
OUT = os.path.join(PROJECT, "app", "public", "data", "layers")
PREVIEWS = os.path.join(PREP, "previews")

# Local copy of PDS LOLA LDEM_80S_80M.JP2 (read-only; do not modify).
DEM_PATH = "/Volumes/CodexWork/Projects/MOONDA/data-raw/source/terrain-raw/LDEM_80S_80M.JP2"
DEM_CHECK_PATH = "/Volumes/CodexWork/Projects/MOONDA/data-raw/source/terrain-raw/polar-far-80m.tif"

# --------------------------------------------------------------------------
# Grid
# --------------------------------------------------------------------------
R_MOON = 1737400.0
N = 2048
HALF = 304000.0
RES = 2.0 * HALF / N  # 296.875 m
DST_CRS = CRS.from_string(
    "+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +k=1 +x_0=0 +y_0=0 "
    "+R=1737400 +units=m +no_defs +type=crs"
)
DST_TRANSFORM = Affine(RES, 0.0, -HALF, 0.0, -RES, HALF)
NODATA_U16 = 65535


def latlon_to_xy(lat_deg, lon_deg):
    """South polar stereographic (true scale at pole) map coordinates in m."""
    lat = np.radians(np.asarray(lat_deg, dtype=np.float64))
    lon = np.radians(np.asarray(lon_deg, dtype=np.float64))
    rho = 2.0 * R_MOON * np.tan(np.pi / 4.0 + lat / 2.0)
    return rho * np.sin(lon), rho * np.cos(lon)


def xy_to_latlon(x, y):
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    rho = np.hypot(x, y)
    lat = -90.0 + np.degrees(2.0 * np.arctan(rho / (2.0 * R_MOON)))
    lon = np.degrees(np.arctan2(x, y)) % 360.0
    return lat, lon


def xy_to_pixel(x, y):
    """Fractional (col, row) on the output grid; pixel centres are integers."""
    col = (np.asarray(x) + HALF) / RES - 0.5
    row = (HALF - np.asarray(y)) / RES - 0.5
    return col, row


def grid_centers():
    """2-D arrays (x, y) of output pixel centres, row 0 = top."""
    c = -HALF + (np.arange(N) + 0.5) * RES
    x = np.broadcast_to(c[None, :], (N, N))
    y = np.broadcast_to(c[::-1][:, None], (N, N))
    return x, y


def scale_factor(x, y):
    """Polar stereographic point scale factor k (true scale at pole)."""
    rho = np.hypot(x, y)
    return 1.0 + (rho / (2.0 * R_MOON)) ** 2


def reproject_to_grid(src, src_transform, src_crs, resampling, src_nodata=np.nan):
    """Reproject a 2-D float array onto the common grid. NaN = no data."""
    src = np.asarray(src, dtype=np.float32)
    dst = np.full((N, N), np.nan, dtype=np.float32)
    reproject(
        source=src,
        destination=dst,
        src_transform=src_transform,
        src_crs=src_crs,
        src_nodata=src_nodata,
        dst_transform=DST_TRANSFORM,
        dst_crs=DST_CRS,
        dst_nodata=np.nan,
        resampling=resampling,
        num_threads=4,
    )
    return dst


# --------------------------------------------------------------------------
# Encoding / writing
# --------------------------------------------------------------------------
def encode_u16(values, scale, offset):
    """value = round((v - offset) / scale); NaN -> 65535; clipped to 0..65534."""
    v = np.asarray(values, dtype=np.float64)
    out = np.full(v.shape, NODATA_U16, dtype=np.uint16)
    ok = np.isfinite(v)
    q = np.rint((v[ok] - offset) / scale)
    out[ok] = np.clip(q, 0, NODATA_U16 - 1).astype(np.uint16)
    return out


def decode_u16(u16, scale, offset):
    v = u16.astype(np.float64) * scale + offset
    v[u16 == NODATA_U16] = np.nan
    return v


def write_bin(path, u16):
    assert u16.shape == (N, N) and u16.dtype == np.uint16
    u16.astype("<u2").tofile(path)


def read_bin(path):
    return np.fromfile(path, dtype="<u2").reshape(N, N)


def hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def colorize(values, stops, alpha=255):
    """Piecewise-linear colormap. stops = [(value, '#rrggbb'), ...] ascending.
    Values outside the stop range are clamped; NaN -> fully transparent."""
    v = np.asarray(values, dtype=np.float64)
    sv = np.array([s[0] for s in stops], dtype=np.float64)
    rgb = np.array([hex_to_rgb(s[1]) for s in stops], dtype=np.float64)
    ok = np.isfinite(v)
    vc = np.clip(np.where(ok, v, sv[0]), sv[0], sv[-1])
    out = np.zeros(v.shape + (4,), dtype=np.uint8)
    for ch in range(3):
        out[..., ch] = np.rint(np.interp(vc, sv, rgb[:, ch])).astype(np.uint8)
    out[..., 3] = np.where(ok, alpha, 0).astype(np.uint8)
    return out


def write_png(path, rgba):
    Image.fromarray(rgba, mode="RGBA").save(path, optimize=True, compress_level=9)


def legend_from_stops(stops):
    return [{"value": float(v), "color": c} for v, c in stops]


def hillshade(z, dx, azimuth_deg=315.0, altitude_deg=45.0, zfactor=1.0):
    """Standard hillshade (0..1) for an array with row 0 = top (north-up in
    image sense). dx = pixel size in the same units as z."""
    zz = np.asarray(z, dtype=np.float64) * zfactor
    zz = np.where(np.isfinite(zz), zz, np.nanmean(zz))
    g_row, g_col = np.gradient(zz, dx)
    dzdx = g_col  # +x = image right
    dzdy = -g_row  # +y = image up
    norm = np.sqrt(dzdx**2 + dzdy**2 + 1.0)
    a = math.radians(azimuth_deg)  # clockwise from image-up
    h = math.radians(altitude_deg)
    lx, ly, lz = math.sin(a) * math.cos(h), math.cos(a) * math.cos(h), math.sin(h)
    hs = (-dzdx * lx - dzdy * ly + lz) / norm
    return np.clip(hs, 0.0, 1.0)


def save_json(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f, indent=2)
        f.write("\n")
