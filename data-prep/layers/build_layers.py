"""Build MOONDA south-polar science layers (PNG overlay + Uint16 .bin + manifest).

Run (from anywhere):
  /Volumes/CodexWork/Projects/MOONDA/.venv-data/bin/python -I \
      /Volumes/CodexWork/Projects/MOONDA/data-prep/layers/build_layers.py [layer ...]

With no arguments every layer is rebuilt. Raw inputs are read from
/Volumes/CodexWork/Projects/MOONDA/data-raw/ (see download_sources.sh) and the
local LOLA LDEM_80S_80M.JP2. Outputs go to app/public/data/layers/.
"""
from __future__ import annotations

import os
import sys
import time
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np  # noqa: E402
import rasterio  # noqa: E402
from rasterio.warp import Resampling  # noqa: E402
from rasterio.windows import from_bounds  # noqa: E402

from common import (  # noqa: E402
    DEM_PATH, HALF, N, OUT, RAW, RES, colorize, encode_u16, grid_centers,
    hillshade, latlon_to_xy, legend_from_stops, reproject_to_grid, save_json,
    write_bin, write_png,
)

LOLA_ILLUM_DIR = os.path.join(RAW, "pds-lola-illumination")
PRP_ZIP = os.path.join(RAW, "pds-diviner-prp", "dlre_prp_south.zip")

PDS_ILLUM_URL = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/extras/illumination/img/"
MAZARICO_2011 = (
    "Mazarico, E., Neumann, G.A., Smith, D.E., Zuber, M.T., Torrence, M.H. (2011). "
    "Illumination conditions of the lunar polar regions using LOLA topography. "
    "Icarus 211(2), 1066-1081. doi:10.1016/j.icarus.2010.10.030"
)
PAIGE_2010 = (
    "Paige, D.A., et al. (2010). Diviner Lunar Radiometer observations of cold traps in the "
    "Moon's south polar region. Science 330(6003), 479-482. doi:10.1126/science.1187726. "
    "Dataset: Paige, D.A., LRO DLRE Level 5 Polar Resource Product V2.0, NASA Planetary Data "
    "System, LRO-L-DLRE-5-PRP-V2.0 (2018)."
)
LOLA_DEM_CITATION = (
    "Smith, D.E., et al. (2010). The Lunar Orbiter Laser Altimeter investigation on the Lunar "
    "Reconnaissance Orbiter mission. Space Science Reviews 150, 209-241. "
    "doi:10.1007/s11214-009-9512-y. Dataset: LRO LOLA Gridded Data Record, NASA Planetary Data "
    "System, LRO-L-LOLA-4-GDR-V1.0, product LDEM_80S_80M."
)

# ---------------------------------------------------------------- colormaps
SUN_STOPS = [(0, "#0a0a10"), (10, "#2b1d0e"), (25, "#5c3a0b"), (50, "#a8650b"),
             (75, "#e89b1c"), (90, "#ffc93c"), (100, "#fff2a8")]
EARTH_STOPS = [(0, "#070b14"), (10, "#0d1d3a"), (25, "#12346b"), (50, "#1f5fae"),
               (75, "#4b9be0"), (90, "#8cc8f2"), (100, "#dff3ff")]
_RDYLBU_R = ["#313695", "#4575b4", "#74add1", "#abd9e9", "#e0f3f8", "#ffffbf",
             "#fee090", "#fdae61", "#f46d43", "#d73027", "#a50026"]


def temp_stops(vmin, vmax):
    n = len(_RDYLBU_R) - 1
    return [(round(vmin + (vmax - vmin) * i / n, 2), c) for i, c in enumerate(_RDYLBU_R)]


SLOPE_STOPS = [(0, "#1a9850"), (5, "#66bd63"), (10, "#a6d96a"), (15, "#fee08b"),
               (20, "#fdae61"), (25, "#f46d43"), (30, "#d73027")]
HEIGHT_STOPS = [(-6000, "#2b1b6b"), (-4000, "#2f5fb3"), (-2000, "#3fa7c9"), (0, "#7ccf7a"),
                (1500, "#e6e36a"), (3000, "#e3a14a"), (4500, "#b5653a"), (6000, "#f2efe9")]
ICE_RGB = "#00e5ff"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def stats(name, v):
    ok = np.isfinite(v)
    if ok.any():
        log(f"  {name}: valid {ok.mean()*100:.2f}%  min {np.nanmin(v):.3f}  "
            f"p50 {np.nanmedian(v):.3f}  max {np.nanmax(v):.3f}")
    else:
        log(f"  {name}: no valid data")


def write_layer(layer_id, values, rgba, scale, offset):
    os.makedirs(OUT, exist_ok=True)
    write_png(os.path.join(OUT, f"{layer_id}.png"), rgba)
    write_bin(os.path.join(OUT, f"{layer_id}.bin"), encode_u16(values, scale, offset))
    log(f"  wrote {layer_id}.png / {layer_id}.bin")


# ---------------------------------------------------------------- LOLA illumination
def read_lola_crop(stem):
    """Read a LOLA polar IMG (via its PDS3 label) cropped to the output extent
    plus a margin. Returns (array float32 with NaN nodata, transform, crs, profile)."""
    lbl = os.path.join(LOLA_ILLUM_DIR, stem + ".lbl")
    with rasterio.open(lbl) as ds:
        m = 10 * ds.res[0]
        win = from_bounds(-HALF - m, -HALF - m, HALF + m, HALF + m, ds.transform)
        win = win.round_offsets().round_lengths()
        dn = ds.read(1, window=win).astype(np.float32)
        nod = ds.nodata
        scale = ds.scales[0]
        offset = ds.offsets[0]
        tr = ds.window_transform(win)
        crs = ds.crs
    bad = dn == nod if nod is not None else np.zeros(dn.shape, bool)
    phys = dn * np.float32(scale) + np.float32(offset)
    phys[bad] = np.nan
    return phys, dn, tr, crs


def build_visibility(layer_id):
    stem = {"sunlight": "avgvisib_65s_240m_201608",
            "earth": "avgvisib_65s_240m_201608_earth"}[layer_id]
    log(f"[{layer_id}] reading {stem}")
    frac, _, tr, crs = read_lola_crop(stem)
    pct = frac * 100.0
    out = reproject_to_grid(pct, tr, crs, Resampling.bilinear)
    out = np.clip(out, 0.0, 100.0)
    stats(layer_id, out)
    stops = SUN_STOPS if layer_id == "sunlight" else EARTH_STOPS
    write_layer(layer_id, out, colorize(out, stops), 0.01, 0.0)
    src = {
        "name": ("LRO LOLA average solar illumination, south pole (AVGVISIB_65S_240M_201608)"
                 if layer_id == "sunlight" else
                 "LRO LOLA average Earth visibility, south pole (AVGVISIB_65S_240M_201608_EARTH)"),
        "url": PDS_ILLUM_URL + stem + ".img",
        "citation": MAZARICO_2011,
        "version": "201608 release (PDS label PRODUCT_VERSION_ID V1.05, created 2016-09-15), "
                   "PDS dataset LRO-L-LOLA-4-GDR-V1.0 EXTRAS; 240 m/pixel",
    }
    if layer_id == "sunlight":
        return {
            "id": "sunlight", "title": "Sunlight",
            "shortHelp": "How much of the time the Sun is above the horizon here, averaged over many "
                         "years - more sunlight means more solar power and warmer equipment.",
            "units": "%", "scale": 0.01, "offset": 0.0, "valueMin": 0, "valueMax": 100,
            "legend": legend_from_stops(SUN_STOPS), "source": src,
            "notes": "Percent of hourly time steps in which any part of the Sun's disc is above the "
                     "local horizon, simulated over ~18.6 years (one lunar nutation cycle) using LOLA "
                     "240 m topography (Mazarico et al. 2011, 2016 release). It is a long-term average, "
                     "not a forecast for any date. Computed at ground level: a mast a few meters tall "
                     "sees more Sun. Source pixels are 240 m, bilinearly resampled to ~297 m, so narrow "
                     "ridge crests are smoothed and their peak values are underestimated. 0% = permanent "
                     "shadow. Some faint linear artifacts come from the underlying DEM.",
        }
    return {
        "id": "earth", "title": "Earth in view",
        "shortHelp": "How much of the time Earth can be seen in the sky from here, which is when a "
                     "lander could radio Earth directly.",
        "units": "%", "scale": 0.01, "offset": 0.0, "valueMin": 0, "valueMax": 100,
        "legend": legend_from_stops(EARTH_STOPS), "source": src,
        "notes": "Percent of hourly time steps in which any part of Earth's disc is above the local "
                 "horizon, simulated over ~18.6 years from LOLA 240 m topography (same method and "
                 "release as the Sunlight layer). Counting any sliver of Earth as 'visible' is a little "
                 "optimistic, and it ignores which ground station on Earth is facing the Moon, so real "
                 "direct-to-Earth contact time is lower. Long-term average at ground level, not a "
                 "forecast; 240 m source resampled to ~297 m.",
    }


def build_ice():
    stem = "lpsr_65s_240m_201608"
    log(f"[ice] reading {stem}")
    flag, dn, tr, crs = read_lola_crop(stem)
    # PERMANENT_SHADOW = DN*0.000025 + 0.5  ->  DN=+20000 -> 1 (PSR), DN=-20000 -> 0
    psr = np.where(np.isfinite(flag), (flag > 0.5).astype(np.float32), np.nan)
    out = reproject_to_grid(psr, tr, crs, Resampling.nearest)
    stats("ice", out)
    rgba = np.zeros((N, N, 4), np.uint8)
    on = out == 1
    r, g, b = (int(ICE_RGB[i:i + 2], 16) for i in (1, 3, 5))
    rgba[on] = (r, g, b, 255)
    area_km2 = on.sum() * (RES / 1000.0) ** 2  # map-plane area (approx.)
    log(f"  PSR map-plane area in grid: {area_km2:.0f} km^2")
    write_layer("ice", out, rgba, 1.0, 0.0)
    return {
        "id": "ice", "title": "Permanent shadow (possible ice)",
        "shortHelp": "Cyan places never get direct sunlight, so they stay cold enough that water ice "
                     "could survive there for billions of years.",
        "units": "1 = permanently shadowed, 0 = not", "scale": 1.0, "offset": 0.0,
        "valueMin": 0, "valueMax": 1,
        "legend": [{"value": 0.0, "color": "#00000000"}, {"value": 1.0, "color": ICE_RGB}],
        "source": {
            "name": "LRO LOLA permanently shadowed regions, south pole (LPSR_65S_240M_201608)",
            "url": PDS_ILLUM_URL + stem + ".img",
            "citation": MAZARICO_2011,
            "version": "201608 release (PDS label PRODUCT_VERSION_ID V1.05, created 2016-09-15), "
                       "PDS dataset LRO-L-LOLA-4-GDR-V1.0 EXTRAS; 240 m/pixel",
        },
        "notes": "Published LOLA permanent-shadow map (never sunlit during the ~18.6-year simulation, "
                 "Mazarico et al. 2011, 2016 release) - not derived by us. A permanently shadowed region "
                 "is a cold trap where ice CAN be stable; this map does not prove ice is there (orbital "
                 "evidence for surface ice is patchy). Nearest-neighbour resampled from 240 m to ~297 m, "
                 "so shadows smaller than ~300 m can be missing or slightly misplaced.",
    }


# ---------------------------------------------------------------- Diviner PRP
def load_prp():
    log("[temp] parsing DLRE_PRP_SOUTH.TAB from zip")
    with zipfile.ZipFile(PRP_ZIP) as z:
        raw = z.read("dlre_prp_south.tab")
    rec = 210
    a = np.frombuffer(raw, dtype=np.uint8)[rec:]  # skip 1 header record
    a = a[: (a.size // rec) * rec].reshape(-1, rec)

    def col(start, nbytes):  # PDS START_BYTE is 1-based
        return np.ascontiguousarray(a[:, start - 1:start - 1 + nbytes]).view(
            f"S{nbytes}").ravel().astype(np.float64)

    d = {"clon": col(127, 15), "clat": col(144, 15), "tavg": col(178, 8),
         "tmax": col(188, 8)}
    log(f"  {a.shape[0]} triangles")
    return d


def build_temperature(layers):
    from scipy.interpolate import LinearNDInterpolator
    from scipy.spatial import Delaunay

    d = load_prp()
    px, py = latlon_to_xy(d["clat"], d["clon"])
    log("  Delaunay triangulation of triangle centres ...")
    tri = Delaunay(np.column_stack([px, py]))
    gx, gy = grid_centers()
    q = np.column_stack([gx.ravel(), gy.ravel()])
    entries = []
    src = {
        "name": "LRO Diviner Polar Resource Product, south pole (DLRE_PRP_SOUTH)",
        "url": "https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/"
               "data_derived_prp/dlre_prp_south.tab",
        "citation": PAIGE_2010,
        "version": "LRO-L-DLRE-5-PRP-V2.0 (product version 2, created 2018-02-21; "
                   "calibration software 4.0)",
    }
    common_note = ("From a thermal model fitted to Diviner observations from LRO's first mapping year "
                   "(2009-2010), computed on a ~0.5 km triangular mesh built from Kaguya laser "
                   "altimetry (Paige et al. 2010). Linearly interpolated from triangle centres onto the "
                   "~297 m grid, so features smaller than ~1 km are blurred. Long-term model values, "
                   "not today's temperature. Water ice can stay frozen for billions of years where it "
                   "stays below about 110 K.")
    if "temp-max" in layers:
        log("  interpolating temp_max")
        v = LinearNDInterpolator(tri, d["tmax"])(q).reshape(N, N).astype(np.float32)
        stats("temp-max", v)
        stops = temp_stops(25, 350)
        write_layer("temp-max", v, colorize(v, stops), 0.01, 0.0)
        entries.append({
            "id": "temp-max", "title": "Hottest temperature",
            "shortHelp": "The hottest the ground gets here during a year, in kelvin (0 °C = 273 K); "
                         "places that never get warmer than about 110 K can keep water ice right at "
                         "the surface.",
            "units": "K", "scale": 0.01, "offset": 0.0, "valueMin": 25, "valueMax": 350,
            "legend": legend_from_stops(stops), "source": dict(src),
            "notes": "Annual MAXIMUM surface temperature (PRP column temp_max). " + common_note,
        })
    if "temp-avg" in layers:
        log("  interpolating temp_avg")
        v = LinearNDInterpolator(tri, d["tavg"])(q).reshape(N, N).astype(np.float32)
        stats("temp-avg", v)
        stops = temp_stops(25, 225)
        write_layer("temp-avg", v, colorize(v, stops), 0.01, 0.0)
        entries.append({
            "id": "temp-avg", "title": "Average temperature",
            "shortHelp": "The year-round average temperature just under the ground (2 cm deep), in "
                         "kelvin (0 C = 273 K).",
            "units": "K", "scale": 0.01, "offset": 0.0, "valueMin": 25, "valueMax": 225,
            "legend": legend_from_stops(stops), "source": dict(src),
            "notes": "Annual AVERAGE temperature at 2 cm depth (PRP column temp_avg). An annual MINIMUM "
                     "map is not published in this product, so we show the average instead. Where the "
                     "average is below ~110 K, ice buried a little below the surface can be stable even "
                     "if the surface gets warmer in summer. " + common_note,
        })
    return entries


# ---------------------------------------------------------------- DEM layers
def read_dem():
    with rasterio.open(DEM_PATH) as ds:
        dn = ds.read(1)
        tr, crs = ds.transform, ds.crs
    z = dn.astype(np.float32) * np.float32(0.5)  # LOLA LDEM: height_m = DN * 0.5 (vs 1737.4 km)
    return z, tr, crs


def horn_slope_deg(z, tr):
    """Slope (degrees) by Horn's 3x3 method, with the polar stereographic scale
    factor k = 1 + (rho / 2R)^2 converting map metres to true ground metres."""
    zp = np.pad(z.astype(np.float64), 1, mode="edge")
    a, b, c = zp[:-2, :-2], zp[:-2, 1:-1], zp[:-2, 2:]
    d_, f = zp[1:-1, :-2], zp[1:-1, 2:]
    g, h, i = zp[2:, :-2], zp[2:, 1:-1], zp[2:, 2:]
    dx = tr.a
    dzdx = ((c + 2 * f + i) - (a + 2 * d_ + g)) / (8.0 * dx)
    dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8.0 * dx)
    nr, nc = z.shape
    xs = tr.c + (np.arange(nc) + 0.5) * tr.a
    ys = tr.f + (np.arange(nr) + 0.5) * tr.e
    k = 1.0 + (xs[None, :] ** 2 + ys[:, None] ** 2) / (2.0 * 1737400.0) ** 2
    return np.degrees(np.arctan(k * np.hypot(dzdx, dzdy))).astype(np.float32)


DEM_SOURCE = {
    "name": "LRO LOLA polar digital elevation model LDEM_80S_80M (80 m/pixel)",
    "url": "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/"
           "polar/jp2/ldem_80s_80m.jp2",
    "citation": LOLA_DEM_CITATION,
    "version": "JP2 label PRODUCT_VERSION_ID V2.1 (IMG V2.0), created 2017-06-15; LOLA data "
               "2009-07-13 to 2017-02-02",
}


def build_dem_layers(layers):
    log("[dem] reading LDEM_80S_80M")
    z, tr, crs = read_dem()
    entries = []
    if "slope" in layers:
        log("  computing 80 m Horn slope")
        s80 = horn_slope_deg(z, tr)
        s = reproject_to_grid(s80, tr, crs, Resampling.bilinear)
        stats("slope", s)
        write_layer("slope", s, colorize(s, SLOPE_STOPS), 0.01, 0.0)
        entries.append({
            "id": "slope", "title": "Slope",
            "shortHelp": "How steep the ground is, in degrees - landers and rovers need fairly flat ground.",
            "units": "°", "scale": 0.01, "offset": 0.0, "valueMin": 0, "valueMax": 30,
            "legend": legend_from_stops(SLOPE_STOPS), "source": dict(DEM_SOURCE),
            "notes": "Computed by us from the LOLA 80 m DEM (Horn 3x3 method, i.e. a ~240 m baseline, "
                     "corrected for map scale), then bilinearly resampled to ~297 m pixels. Colours "
                     "saturate at 30 deg; click values go to 90 deg. Real slopes under a lander's feet "
                     "can be steeper: boulders and craters smaller than ~100 m are not resolved.",
        })
    if "height" in layers:
        hgt = reproject_to_grid(z, tr, crs, Resampling.bilinear)
        stats("height", hgt)
        color = colorize(hgt, HEIGHT_STOPS).astype(np.float32)
        hs = hillshade(hgt, RES, azimuth_deg=315.0, altitude_deg=40.0, zfactor=2.0)
        shade = 0.30 + 0.85 * hs  # >1 brightens sunlit slopes slightly
        color[..., :3] = np.clip(color[..., :3] * shade[..., None], 0, 255)
        rgba = color.astype(np.uint8)
        rgba[..., 3] = np.where(np.isfinite(hgt), 255, 0)
        write_layer("height", hgt, rgba, 0.5, -10000.0)
        entries.append({
            "id": "height", "title": "Height",
            "shortHelp": "How high or low the ground is, in meters, compared with the Moon's average "
                         "radius of 1737.4 km.",
            "units": "m", "scale": 0.5, "offset": -10000.0, "valueMin": -6000, "valueMax": 6000,
            "legend": legend_from_stops(HEIGHT_STOPS), "source": dict(DEM_SOURCE),
            "notes": "LOLA elevation relative to a 1737.4 km sphere (DN x 0.5 m), bilinearly resampled "
                     "from 80 m to ~297 m pixels. The picture is coloured by height and shaded with an "
                     "artificial light from the upper left (2x vertical exaggeration) - the shading is "
                     "not real sunlight. Colours saturate at -6000 / +6000 m; click values give the true "
                     "height.",
        })
    return entries


# ---------------------------------------------------------------- main
ORDER = ["sunlight", "earth", "ice", "temp-max", "temp-avg", "slope", "height"]


def main(argv):
    want = argv or ORDER
    unknown = set(want) - set(ORDER)
    if unknown:
        raise SystemExit(f"unknown layers: {sorted(unknown)}; choose from {ORDER}")
    os.makedirs(OUT, exist_ok=True)
    manifest_path = os.path.join(OUT, "manifest.json")
    entries = {}
    if os.path.exists(manifest_path):
        import json
        with open(manifest_path) as f:
            for e in json.load(f):
                entries[e["id"]] = e
    for lid in ("sunlight", "earth"):
        if lid in want:
            entries[lid] = build_visibility(lid)
    if "ice" in want:
        entries["ice"] = build_ice()
    tl = [l for l in ("temp-max", "temp-avg") if l in want]
    if tl:
        for e in build_temperature(tl):
            entries[e["id"]] = e
    dl = [l for l in ("slope", "height") if l in want]
    if dl:
        for e in build_dem_layers(dl):
            entries[e["id"]] = e
    manifest = [entries[i] for i in ORDER if i in entries]
    save_json(manifest_path, manifest)
    log(f"manifest: {[e['id'] for e in manifest]}")


if __name__ == "__main__":
    main(sys.argv[1:])
