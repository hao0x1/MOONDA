"""Build evidence-separated water-ice classes; all writes remain in assets-codex.

Run with the project's .venv-data/bin/python -I.  --thermal-only prepares the
native-PRP nearest-centre depth cache while the sharp PSR product is downloading.
No outside builder is run, and bytecode writes are disabled before imports.
"""
from __future__ import annotations

import sys
sys.dont_write_bytecode = True
import hashlib
import json
from pathlib import Path
import zipfile

import numpy as np
import shapefile
from PIL import Image
from scipy.spatial import cKDTree

HERE = Path(__file__).resolve().parents[2]
PROJECT = HERE.parent
OUT = HERE / "features/out"
RAW = PROJECT / "data-raw"
sys.path.insert(0, str(PROJECT / "data-prep/layers"))
from common import R_MOON, N, HALF, RES, latlon_to_xy, grid_centers, xy_to_latlon

PRP_URL = "https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_prp/dlre_prp_south.tab"
ZIP_URL = "https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/extras/prp/dlre_prp_south.zip"
PAIGE = ("Paige, D.A., et al. (2010). Diviner Lunar Radiometer observations of cold traps in "
         "the Moon's south polar region. Science 330, 479-482. doi:10.1126/science.1187726. "
         "Dataset: Paige et al. (2018), LRO DLRE Level 5 PRP V2.0, NASA PDS, LRO-L-DLRE-5-PRP-V2.0.")
MAZARICO = ("Mazarico, E., Neumann, G.A., Smith, D.E., Zuber, M.T., Torrence, M.H. (2011). "
            "Illumination conditions of the lunar polar regions using LOLA topography. "
            "Icarus 211, 1066-1081. doi:10.1016/j.icarus.2010.10.030.")
BARKER = ("Barker, M.K., Mazarico, E., Neumann, G.A., Smith, D.E., Zuber, M.T., Head, J.W., "
          "Sun, X. (2023). A New View of the Lunar South Pole from the Lunar Orbiter Laser "
          "Altimeter (LOLA). The Planetary Science Journal 4, 183. doi:10.3847/PSJ/acf3e1. "
          "Data doi:10.60903/gsfcpgda-lola-spole.")
LCROSS = ("Colaprete, A., et al. (2010). Detection of water in the LCROSS ejecta plume. "
          "Science 330, 463-468. doi:10.1126/science.1186986.")
LI = ("Li, S., Lucey, P.G., Milliken, R.E., Hayne, P.O., Fisher, E., Williams, J.-P., "
      "Hurley, D.M., Elphic, R.C. (2018). Direct evidence of surface exposed water ice in the "
      "lunar polar regions. PNAS 115, 8907-8912. doi:10.1073/pnas.1802345115.")
LEMELIN = ("Lemelin, M., Li, S., Mazarico, E., Siegler, M.A., Kring, D.A., Paige, D.A. (2021). "
           "Framework for Coordinated Efforts in the Exploration of Volatiles in the South Polar Region "
           "of the Moon. The Planetary Science Journal 2, 103. "
           "doi:10.3847/PSJ/abf3c5. Data: doi:10.5281/zenodo.4646092.")


def save_json(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def md5(path):
    h = hashlib.md5()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def prepare_thermal():
    """Nearest triangle CENTRE, with invalid depths retained as invalid.

    The source label defines ice_depth exactly.  In particular -999 must never
    be thrown out before interpolation, because it means no stability in the
    source model's upper 2.8738 m, not a missing sample to bridge over.
    """
    cache = OUT / "waterice-thermal.npz"
    source = RAW / "pds-diviner-prp/dlre_prp_south.zip"
    source_hash = md5(source)
    if cache.exists():
        with np.load(cache) as z:
            if str(z["source_md5"]) == source_hash:
                print("Using exact-source thermal cache", flush=True)
                return z["depth"], z["distance_m"]
    print("Reading exact PRP ice_depth field", flush=True)
    with zipfile.ZipFile(source) as z:
        body = z.read("dlre_prp_south.tab")
    a = np.frombuffer(body, np.uint8)[210:].reshape(-1, 210)
    assert a.shape == (2880000, 210)

    def col(start, width):
        return np.ascontiguousarray(a[:, start-1:start-1+width]).view(f"S{width}").ravel().astype(np.float64)

    lon, lat, depth = col(127, 15), col(144, 15), col(198, 11)
    x, y = latlon_to_xy(lat, lon)
    tree = cKDTree(np.column_stack((x, y)))
    del body, a, lon, lat, x, y
    gx, gy = grid_centers()
    result = np.empty((N, N), np.float32)
    distances = np.empty((N, N), np.float32)
    for r0 in range(0, N, 128):
        r1 = min(r0 + 128, N)
        q = np.column_stack((gx[r0:r1].ravel(), gy[r0:r1].ravel()))
        d, ix = tree.query(q, workers=4)
        result[r0:r1] = depth[ix].reshape(r1-r0, N)
        distances[r0:r1] = d.reshape(r1-r0, N)
    # Source square is the same polar domain; reject accidental extrapolation.
    result[distances > 1000] = np.nan
    np.savez_compressed(cache, depth=result, distance_m=distances, source_md5=source_hash)
    print("Thermal cache ready", flush=True)
    return result, distances


def build_sites(classes):
    """Attribute detections only if the ENTIRE source PSR lies in an IAU circle.

    This is deliberately more conservative than matching a PSR name/centroid:
    some named PSRs cross crater rims, and the source's 'Wiechert J' PSR is
    roughly 100 km from the IAU crater of that name.  We cannot locate individual
    M3 pixels inside partly overlapping polygons, so no such match is accepted.
    """
    names = json.loads((PROJECT / "app/public/data/names.json").read_text())
    by_name = {r[0]: dict(zip(names["fields"], r)) for r in names["rows"]}
    shp = HERE / ("features/downloads/waterice-li/lemelin-4646092/"
                  "Lemelin_et_al_2021_PSJ_south_pole_volatiles_ROIs_supp.shp")
    polygons = []
    for i, sr in enumerate(shapefile.Reader(str(shp)).iterShapeRecords()):
        data = sr.record.as_dict()
        xy = np.asarray(sr.shape.points, dtype=np.float64)
        lat, lon = xy_to_latlon(xy[:, 0], xy[:, 1])
        la, lo = np.radians(lat), np.radians(lon)
        vec = np.column_stack((np.cos(la)*np.cos(lo), np.cos(la)*np.sin(lo), np.sin(la)))
        polygons.append((i, data, vec))
    wanted = ["Cabeus", "Shackleton", "Haworth", "Shoemaker", "Faustini", "Nobile",
              "de Gerlache", "Scott", "Kuhn", "Malapert C", "Amundsen", "Slater", "Wiechert"]
    gx, gy = grid_centers()
    glat, glon = xy_to_latlon(gx, gy)
    glat, glon = np.radians(glat), np.radians(glon)
    markers, audit = [], []
    for name in wanted:
        feature = by_name[name]
        la, lo = np.radians([feature["lat"], feature["lon"]])
        v = np.array([np.cos(la)*np.cos(lo), np.cos(la)*np.sin(lo), np.sin(la)])
        radius_m = feature["diameterKm"] * 500
        contained = []
        for i, data, vec in polygons:
            dist = R_MOON * np.arccos(np.clip(vec @ v, -1, 1))
            if dist.max() < .99*radius_m and data["Count_M3"] > 0:
                contained.append({"record_zero_based": i, "psr_name": data["Name"],
                                  "M3_count": int(data["Count_M3"]),
                                  "farthest_vertex_km": round(float(dist.max()/1000), 4)})
        count = sum(p["M3_count"] for p in contained)
        great_circle = R_MOON * np.arccos(np.clip(np.sin(glat)*np.sin(la) +
                             np.cos(glat)*np.cos(la)*np.cos(glon-lo), -1, 1))
        cold_count = int(((great_circle < .99*radius_m) & (classes == 2)).sum())
        status = "confirmed" if name == "Cabeus" else ("detected" if count else "predicted")
        if status == "predicted" and cold_count == 0:
            continue
        ev = []
        if status == "confirmed":
            ev.append({"instrument": "LCROSS near-infrared and ultraviolet spectrometers",
                       "finding": "LCROSS measured water in debris blasted from one impact site in Cabeus; this does not confirm ice across the crater.",
                       "citation": LCROSS, "url": "https://doi.org/10.1126/science.1186986"})
        if count:
            ev.append({"instrument": "Chandrayaan-1 Moon Mineralogy Mapper (M3)",
                       "finding": "M3 reported signs of surface ice in small permanently shaded patches inside this crater.",
                       "citation": LI + " " + LEMELIN,
                       "url": "https://zenodo.org/records/4646092"})
        if status == "predicted":
            ev.append({"instrument": "LRO Diviner thermal model and LOLA shadow model",
                       "finding": "Temperature and shadow maps predict cold traps here, but the reviewed map of reported ice signals has no detection assigned to this crater.",
                       "citation": PAIGE + " " + BARKER,
                       "url": PRP_URL})
        short = ("Water measured in the LCROSS impact plume at one spot." if status == "confirmed" else
                 "M3 reported signs of surface ice in small patches here." if status == "detected" else
                 "Cold traps are predicted here; no detection is mapped here.")
        assert len(short) <= 90
        markers.append({"id": "ice-" + name.lower().replace(" ", "-"), "name": name,
                        "lat": feature["lat"], "lon": feature["lon"],
                        "diameterKm": feature["diameterKm"], "status": status,
                        "short": short, "evidence": ev})
        audit.append({"name": name, "status": status, "M3_count": count,
                      "fully_contained_PSRs": contained, "predicted_surface_grid_cells": cold_count})
    save_json(OUT / "ice-sites.json", markers)
    save_json(OUT / "ice-sites-association-audit.json", {
        "rule": "All source polygon vertices at spherical distance <0.99 IAU radius; no name-only attribution.",
        "warning": "Markers indicate regional evidence, not exact ice pixels; predicted means no detection assigned in this audited catalogue.",
        "omitted_named_region_associations": "Sverdrup and Malapert positive-count PSRs cross IAU-circle boundaries; individual M3 pixel positions cannot be located. Source Wiechert J PSR is far from IAU Wiechert J.",
        "sites": audit})
    return markers


def build():
    OUT.mkdir(parents=True, exist_ok=True)
    depth, distances = prepare_thermal()
    if "--thermal-only" in sys.argv:
        return
    psr = np.fromfile(OUT / "psr.bin", dtype="<u2").reshape(N, N)
    t_raw = np.fromfile(PROJECT / "app/public/data/layers/temp-max.bin", dtype="<u2").reshape(N, N)
    tmax = t_raw.astype(np.float32) * .01
    gx, gy = grid_centers()
    lat, _ = xy_to_latlon(gx, gy)
    valid = (lat <= -80) & (t_raw != 65535) & (psr != 65535)
    surface = valid & (psr > 0) & (tmax < 110.0)
    buried = valid & (depth > 0) & (depth <= 1.0) & (tmax >= 110.0)
    classes = np.zeros((N, N), np.uint16)
    classes[buried] = 1
    classes[surface] = 2
    # No class 3 pixels: no redistributable, geolocated Li detection list found.
    classes[~valid] = 65535
    classes.astype("<u2").tofile(OUT / "waterice.bin")

    # 4096 image: source PSR alpha supplies finer shadow boundaries; the thermal
    # criterion and buried-depth footprint remain nearest-upsampled 2048 cells.
    # Transparent unclassified space is deliberate; this is not ice abundance.
    n4 = 4096
    sharp = np.load(OUT / "psr-fraction-4096.npy", mmap_mode="r")
    assert sharp.shape == (n4, n4)
    rgba = np.zeros((n4, n4, 4), np.uint8)
    b4 = np.repeat(np.repeat(buried, 2, axis=0), 2, axis=1)
    s4 = np.repeat(np.repeat(surface, 2, axis=0), 2, axis=1)
    rgba[b4] = (110, 150, 255, 110)
    # User requests fixed alpha 170 for class 2.  Keep sharp boundary pixels
    # whose 20m source fraction is nonzero, without inventing subpixel ice.
    s4 &= sharp > 0
    rgba[s4] = (80, 210, 255, 170)
    # Mask pixel centres at the exact circle, independently at 4096 resolution.
    c4 = -HALF + (np.arange(n4, dtype=np.float64) + .5) * (2*HALF/n4)
    rho80 = 2*R_MOON*np.tan(np.radians(5))
    outside = c4[None,:]**2 + c4[::-1,None]**2 > rho80**2
    rgba[outside] = 0
    Image.fromarray(rgba).save(OUT / "waterice.png", optimize=True)

    manifest = {
        "id": "waterice", "title": "Where water ice may be",
        "shortHelp": "Blue: ice predicted just under the ground. Cyan: predicted surface cold traps. "
                     "White is for measured signs from orbit, but no white pixels are available. "
                     "Only the Cabeus marker shows a direct water measurement.",
        "units": "class: 0 none mapped; 1 predicted buried; 2 predicted surface; 3 orbital detection",
        "scale": 1, "offset": 0, "valueMin": 0, "valueMax": 3,
        "legend": [{"value": 0, "color": "#00000000"},
                   {"value": 1, "color": "#6e96ff"},
                   {"value": 2, "color": "#50d2ff"},
                   {"value": 3, "color": "#ffffff"}],
        "source": {"name": "Diviner DLRE_PRP_SOUTH.TAB ice_depth and temp_max; LOLA LPSR_80S_20MPP_ADJ.TIF",
                   "url": PRP_URL, "citation": PAIGE + " " + BARKER,
                   "version": "PRP V2.0 (2018-02-21), existing MOONDA temp-max linear grid; PGDA LOLA 20m PSR"},
        "notes": "Prediction, not an inventory or proof of ice. Class 1: nearest PRP triangle-centre "
                 "ice_depth >0 and <=1 m, and existing annual maximum surface temperature >=110 K. "
                 "The PRP depth corresponds to 1 kg/m²/Ga sublimation loss; invalid -999 depths are "
                 "retained and never interpolated away. Class 2: the cell contains >0% 20m-source "
                 "permanent shadow and annual maximum surface temperature <110 K (Paige2010 approximate "
                 "long-term stability threshold). A class-2 cell can contain unshadowed ground; only "
                 "its mapped PSR portion is coloured in the 4096 PNG. Class 3 is reserved and empty: "
                 "Li2018 point coordinates are available upon request, and the public Lemelin2021 "
                 "polygons give counts rather than detection coordinates. Do not fill those polygons "
                 "or crater circles with detected ice. No direct-confirmation raster class exists; "
                 "Cabeus LCROSS confirmation is a marker restricted to its measured impact plume. "
                 "0 means none mapped under these rules, not proven absence. Source thermal model "
                 "is about 0.5km and not sharpened by 4096 display. Sources: data-raw/pds-diviner-prp/"
                 "dlre_prp_south.zip member dlre_prp_south.tab; dlre_prp.fmt; app/public/data/layers/"
                 "temp-max.bin; features/downloads/psr-complete/LPSR_80S_20MPP_ADJ.TIF. Licence: NASA/PDS public "
                 "domain, credit NASA/LRO/Diviner/LOLA teams; marker M3 counts CC BY4.0 Lemelin et al. "
                 "See features/NOTES.md for exact source URLs, checksums and full evidence review."
    }
    save_json(OUT / "waterice-manifest.json", manifest)
    markers = build_sites(classes)
    report = {"grid": {"binary": [N,N], "png": [n4,n4], "threshold_kelvin": 110},
              "valid_pixels": int(valid.sum()),
              "class_counts": {str(k): int((classes == k).sum()) for k in range(4)},
              "class_percent_of_valid": {str(k): round(float((classes == k).sum()/valid.sum()*100),6) for k in range(4)},
              "nodata_pixels": int((classes == 65535).sum()),
              "outside_circle_pixels": int((lat > -80).sum()),
              "inside_circle_nodata_pixels": int(((lat <= -80) & ~valid).sum()),
              "markers_by_status": {s: sum(m["status"] == s for m in markers) for s in ("confirmed", "detected", "predicted")},
              "nearest_PRP_centre_distance_m": {"max": float(distances[valid].max()),
                  "median": float(np.median(distances[valid]))},
              "class3_reason": "Li Fig4 geolocations available upon request; public PSR counts are not geolocated detections."}
    save_json(OUT / "waterice-report.json", report)
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    build()
