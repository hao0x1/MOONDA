"""Build compact, evidence-separated polar and orbital maps.

Run with .venv-data/bin/python -I data-prep/layers/build_polar_water.py.
Downloaded files are read as data. Nothing in data-raw is executed.
No existing planner grid or image is overwritten.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import zipfile

import numpy as np
from PIL import Image
import rasterio
from rasterio.crs import CRS
from rasterio.transform import Affine
from rasterio.warp import Resampling, reproject
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / 'data-raw'
OUT = ROOT / 'app/public/data/layers'
PREP = ROOT / 'data-prep/layers'
R = 1737400.0
WIDE_HALF = 770400.0
HALF = 304000.0
PGDA = 'https://pgda.gsfc.nasa.gov/data/MoonIllumination/'
PRP = 'https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/'
LP = 'https://pds-geosciences.wustl.edu/missions/lunarp/reduced/hydrogenhd.dat'

def png(name, array):
    Image.fromarray(np.asarray(array, np.uint8), mode='L').save(OUT / name, optimize=True)

def save_json(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')

def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for part in iter(lambda: f.read(8 * 1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()

def transform(half, n):
    return Affine(2 * half / n, 0, -half, 0, -2 * half / n, half)

def crs(pole):
    latitude = 90 if pole == 'north' else -90
    return CRS.from_string(f'+proj=stere +lat_0={latitude} +lat_ts={latitude} +lon_0=0 +R={R} +units=m +no_defs')

def latitude_grid(half, n):
    x = -half + (np.arange(n) + .5) * (2 * half / n)
    rho = np.hypot(x[None, :], x[::-1, None])
    return 90 - np.degrees(2 * np.arctan(rho / (2 * R)))

def psr_fraction(path, pole, half, n):
    """Average native binary cells; never read a prebuilt COG overview."""
    with rasterio.open(path) as source:
        raw = source.read(1)
        finite = raw != source.nodata
        assert np.all((raw[finite] == -20000) | (raw[finite] == 0) | (raw[finite] == 20000))
        # One north-pole source cell is DN=0, neither published binary flag.
        # Leave it unknown rather than interpret it as half-shadowed terrain.
        valid = (raw == -20000) | (raw == 20000)
        a = (raw == 20000).astype(np.float32)
        a[~valid] = np.nan
        out = np.full((n, n), np.nan, np.float32)
        reproject(a, out, src_transform=source.transform, src_crs=source.crs, src_nodata=np.nan,
                  dst_transform=transform(half, n), dst_crs=crs(pole), dst_nodata=np.nan,
                  resampling=Resampling.average, num_threads=2)
    return out

def mask_codes(fraction, lat, minimum, maximum=90):
    a = np.rint(np.nan_to_num(fraction) * 100).clip(0, 100).astype(np.uint8)
    a[(lat < minimum) | (lat >= maximum) | ~np.isfinite(fraction)] = 255
    return a

def percent_palette():
    return [f'#488cdc{round(min(i, 100)*2):02x}' if i <= 100 else '#00000000' for i in range(256)]

def code_palette(colours):
    return [colours.get(i, '#00000000') for i in range(256)]

def product(name, pole, half, minimum, maximum=90, palette=None):
    result = {'url': f'./data/layers/{name}.png', 'projection': 'polar', 'pole': pole,
              'extentM': half, 'clipTrueLatDeg': minimum, 'maximumTrueLatDeg': maximum,
              'encoding': 'gray8', 'palette': palette or percent_palette(),
              'values': {'url': f'./data/layers/{name}-values.png', 'width': 2048, 'height': 2048,
                         'encoding': 'gray8', 'scale': 1, 'offset': 0, 'nodata': 255,
                         'projection': 'polar', 'pole': pole, 'extentM': half,
                         'clipTrueLatDeg': minimum, 'maximumTrueLatDeg': maximum}}
    return result

def build_psr():
    print('Building both-pole PSR maps from native base pixels', flush=True)
    products = []
    for pole, folder, band in [('north', 'pgda-lola-north-psr', '65N_240M'),
                               ('south', 'pgda-lola-south-wide-psr', '65S_240M')]:
        name = 'psr-north' if pole == 'north' else 'psr-south-wide'
        source = RAW / folder / f'LPSR_{band}_201608.TIF'
        fraction = psr_fraction(source, pole, WIDE_HALF, 4096)
        png(name + '.png', mask_codes(fraction, latitude_grid(WIDE_HALF, 4096), 65, 80))
        small = fraction.reshape(2048, 2, 2048, 2).mean(axis=(1, 3))
        png(name + '-values.png', mask_codes(small, latitude_grid(WIDE_HALF, 2048), 65, 80))
        products.append(product(name, pole, WIDE_HALF, 65, 80))
        del fraction, small

    n = 4096
    lat = latitude_grid(HALF, n)
    near = psr_fraction(RAW / 'pgda-lola-north-psr/LPSR_75N_120M_201608.TIF', 'north', HALF, n)
    closest = psr_fraction(RAW / 'pgda-lola-north-psr/LPSR_85N_060M_201608.TIF', 'north', HALF, n)
    near[lat >= 85] = closest[lat >= 85]
    png('psr-north-sharp.png', mask_codes(near, lat, 80, 90.01))
    small = near.reshape(2048, 2, 2048, 2).mean(axis=(1, 3))
    png('psr-north-sharp-values.png', mask_codes(small, latitude_grid(HALF, 2048), 80, 90.01))
    # The unrounded mask is retained locally so water predictions do not lose small shadows.
    np.savez_compressed(PREP / 'north-psr-fractions.npz', fraction=near)
    products.insert(1, product('psr-north-sharp', 'north', HALF, 80, 90.01))

    # This is an exact repack of the current picture, not a new scientific product.
    alpha = np.array(Image.open(OUT / 'psr.png').getchannel('A'))
    assert alpha.shape == (4096, 4096)
    alpha[latitude_grid(HALF, 4096) < 80] = 255
    png('psr-south-sharp.png', alpha)
    palette = [f'#488cdc{i:02x}' if i <= 200 else '#00000000' for i in range(256)]
    south = product('psr-south-sharp', 'south', HALF, 80, 90.01, palette)
    south['values'] = {'url': './data/layers/psr.bin', 'width': 2048, 'height': 2048,
                       'encoding': 'uint16le', 'scale': .01, 'offset': 0, 'nodata': 65535,
                       'projection': 'polar', 'pole': 'south', 'extentM': HALF,
                       'clipTrueLatDeg': 80}
    products.append(south)
    return products

def build_hydrogen():
    print('Building orbital hydrogen abundance map', flush=True)
    source = RAW / 'pds-lunar-prospector-hydrogen/hydrogenhd.dat'
    # PDS: signed MSB-first integers, tenth ppm, row zero is the south pole.
    h = np.fromfile(source, dtype='>i2').reshape(360, 720)[::-1].astype(np.float32) / 10
    assert float(h.min()) == np.float32(-56.1) and float(h.max()) == np.float32(195.5)
    codes = np.rint(np.maximum(h, 0) / 2).clip(0, 254).astype(np.uint8)
    png('hydrogen-global.png', codes)
    png('hydrogen-global-values.png', codes)
    palette = []
    for i in range(256):
        # Stronger abundance gets a stronger purple. Blue remains the prediction key.
        alpha = round(np.clip((i * 2 - 25) / 150, 0, 1) * 145) if i < 255 else 0
        palette.append(f'#a36cdb{alpha:02x}')
    return {'url': './data/layers/hydrogen-global.png', 'projection': 'geographic',
            'west': -180, 'north': 90, 'east': 180, 'south': -90, 'encoding': 'gray8',
            'palette': palette, 'values': {'url': './data/layers/hydrogen-global-values.png',
            'width': 720, 'height': 360, 'encoding': 'gray8', 'scale': 2, 'offset': 0, 'nodata': 255,
            'projection': 'geographic', 'west': -180, 'north': 90, 'east': 180, 'south': -90},
            'sourceUrl': LP, 'negativeFitCount': int((h < 0).sum()),
            'limits': 'Orbital hydrogen estimates, not water-ice detections. Negative model estimates are clipped to zero for display. High thorium and rare-earth element regions can be unreliable. Half-degree bins are not the neutron spatial footprint. Stronger than 100 ppm is a display choice, not an ice boundary.'}

def repack_south_water():
    """Keep the existing prediction grid, with the current sharp PSR boundary."""
    classes = np.fromfile(OUT / 'waterice.bin', dtype='<u2').reshape(2048, 2048)
    assert np.all(np.isin(classes, [0, 1, 2, 65535]))
    small = np.where(classes == 65535, 255, classes).astype(np.uint8)
    png('waterice-south-values.png', small)
    display = small.repeat(2, axis=0).repeat(2, axis=1)
    shadow = np.array(Image.open(OUT / 'psr.png').getchannel('A'))
    display[(display == 2) & (shadow == 0)] = 0
    png('waterice-south.png', display)
    return product('waterice-south', 'south', HALF, 80, 90.01,
                   code_palette({1: '#6e96ff6e', 2: '#50d2ffaa'}))

def build_water():
    print('Reading north Diviner PRP temperature and stability-depth fields', flush=True)
    source = RAW / 'pds-diviner-prp-north/dlre_prp_north.zip'
    with zipfile.ZipFile(source) as archive:
        assert archive.testzip() is None
        body = archive.read('dlre_prp_north.tab')
    a = np.frombuffer(body, np.uint8)[210:].reshape(-1, 210)
    assert a.shape == (2880000, 210)
    def col(start, width):
        return np.ascontiguousarray(a[:, start-1:start-1+width]).view(f'S{width}').ravel().astype(np.float64)
    lon, lat, tmax, depth = col(127, 15), col(144, 15), col(188, 8), col(198, 11)
    assert np.nanmin(lat) > 70
    rho = 2 * R * np.tan(np.pi / 4 - np.radians(lat) / 2)
    x, y = rho * np.sin(np.radians(lon)), -rho * np.cos(np.radians(lon))
    tree = cKDTree(np.column_stack((x, y)))
    del a, body, lon, lat, x, y, rho
    n = 2048
    c = -HALF + (np.arange(n) + .5) * (2 * HALF / n)
    depth_out = np.empty((n, n), np.float32)
    temp_out = np.empty((n, n), np.float32)
    valid = np.empty((n, n), bool)
    for r0 in range(0, n, 128):
        r1 = min(n, r0 + 128)
        q = np.column_stack((np.broadcast_to(c, (r1-r0, n)).ravel(),
                             np.broadcast_to(c[::-1, None][r0:r1], (r1-r0, n)).ravel()))
        distance, ix = tree.query(q, workers=2)
        depth_out[r0:r1] = depth[ix].reshape(r1-r0, n)
        temp_out[r0:r1] = tmax[ix].reshape(r1-r0, n)
        valid[r0:r1] = distance.reshape(r1-r0, n) <= 1000
    del tree, tmax, depth
    with np.load(PREP / 'north-psr-fractions.npz') as cache:
        psr = cache['fraction']
    small_psr = psr.reshape(2048, 2, 2048, 2).mean(axis=(1, 3))
    classes = np.zeros((n, n), np.uint8)
    classes[(depth_out > 0) & (depth_out <= 1) & (temp_out >= 110)] = 1
    classes[(small_psr > 0) & (temp_out < 110)] = 2
    classes[(latitude_grid(HALF, n) < 80) | ~valid] = 255
    png('waterice-north-values.png', classes)
    display = classes.repeat(2, axis=0).repeat(2, axis=1)
    display[(display == 2) & ~(psr > 0)] = 0
    png('waterice-north.png', display)
    report = {'classCounts': {str(i): int((classes == i).sum()) for i in [0, 1, 2, 255]},
              'northPrpZipSha256': sha256(source),
              'class0': 'No prediction under these rules, not proof of no ice.',
              'class1': 'Predicted stable depth >0 and <=1m with annual maximum surface temperature >=110K.',
              'class2': 'Predicted surface cold trap: mapped permanent shadow and annual maximum surface temperature <110K.',
              'class255': 'Outside 80N or over 1000m from source triangle centre.',
              'resolution': 'Approximate 0.5km source mesh; nearest triangle centre. Image 148.4375m pixels sharpen shadow boundary only.',
              'source': PRP + 'data_derived_prp/dlre_prp_north.tab'}
    save_json(PREP / 'north-water-report.json', report)
    palette = code_palette({1: '#6e96ff6e', 2: '#50d2ffaa'})
    out = product('waterice-north', 'north', HALF, 80, 90.01, palette)
    return out

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--without-water', action='store_true')
    parser.add_argument('--water-only', action='store_true')
    args = parser.parse_args()
    metadata_file = PREP / 'polar-products.json'
    if args.water_only:
        products = json.loads(metadata_file.read_text())
    else:
        products = {'psr': build_psr(), 'hydrogen': build_hydrogen(), 'watericeSouth': repack_south_water()}
    if not args.without_water:
        products['watericeNorth'] = build_water()
    save_json(metadata_file, products)
    files = sorted({Path(p['url']).name for p in products['psr']} |
                   {Path(p['values']['url']).name for p in products['psr'] if not p['values']['url'].endswith('.bin')} |
                   {'hydrogen-global.png', 'hydrogen-global-values.png', 'waterice-south.png', 'waterice-south-values.png'} |
                   ({'waterice-north.png', 'waterice-north-values.png'} if 'watericeNorth' in products else set()))
    print('New shipped data:', sum((OUT / f).stat().st_size for f in files), 'bytes', flush=True)

if __name__ == '__main__':
    main()
