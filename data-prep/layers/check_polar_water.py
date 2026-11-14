"""Check geographic orientation and scientific class rules against the inputs.

Run with .venv-data/bin/python -I after build_polar_water.py.
"""
from pathlib import Path
import json
import math

import numpy as np
from PIL import Image
import rasterio

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'app/public/data/layers'
PREP = ROOT / 'data-prep/layers'
R = 1737400.0

def read(name):
    im = Image.open(OUT / name)
    assert im.mode == 'L', f'{name}: not an 8-bit greyscale PNG'
    return np.array(im)

def pixel(lat, lon, half, n):
    rho = 2 * R * math.tan(math.radians((90 - abs(lat)) / 2))
    x = rho * math.sin(math.radians(lon))
    y = (-1 if lat > 0 else 1) * rho * math.cos(math.radians(lon))
    return int((half - y) / (2 * half) * n), int((x + half) / (2 * half) * n)

def main():
    report = {}
    metadata = json.loads((PREP / 'polar-products.json').read_text())
    for p in metadata['psr']:
        a = read(Path(p['url']).name)
        assert a.shape == (4096, 4096)
        assert len(p['palette']) == 256
        assert p['palette'][255] == '#00000000'
        report[Path(p['url']).name] = {'bytes': (OUT / Path(p['url']).name).stat().st_size,
                                     'colouredCells': int(((a > 0) & (a != 255)).sum())}
    # South precision and appearance are exactly the retained map, not a new mask.
    alpha = np.array(Image.open(OUT / 'psr.png').getchannel('A'))
    repacked = read('psr-south-sharp.png')
    valid = repacked != 255
    assert np.array_equal(alpha[valid], repacked[valid])

    # Independent coordinate samples ensure north was not accidentally mirrored.
    samples = []
    source = ROOT / 'data-raw/pgda-lola-north-psr/LPSR_85N_060M_201608.TIF'
    with rasterio.open(source) as dataset:
        for lat, lon in [(88.5, 30), (87.2, -40), (86.5, 120), (89.1, -170)]:
            rho = 2 * R * math.tan(math.radians((90-lat)/2))
            x, y = rho*math.sin(math.radians(lon)), -rho*math.cos(math.radians(lon))
            row, col = dataset.index(x, y)
            # A neighbourhood's source fraction, rather than its centre's binary flag,
            # should agree with the area average in the coarser app pixel.
            rr, cc = pixel(lat, lon, 304000, 4096)
            app = int(read('psr-north-sharp.png')[rr, cc])
            raw = int(dataset.read(1, window=((row, row+1), (col, col+1)))[0, 0])
            samples.append({'lat': lat, 'lon': lon, 'sourceDN': raw, 'appPsrPercent': app})
        shadow = np.argwhere(dataset.read(1) == 20000)
        picture = read('psr-north-sharp.png')
        checked_shadows = 0
        for ix in np.linspace(0, len(shadow)-1, 12, dtype=int):
            row, col = shadow[ix]
            x, y = dataset.xy(int(row), int(col))
            lat = 90 - math.degrees(2*math.atan(math.hypot(x, y)/(2*R)))
            lon = math.degrees(math.atan2(x, -y))
            if lat < 85:
                continue
            rr, cc = pixel(lat, lon, 304000, 4096)
            assert 0 < picture[rr, cc] < 255, f'North shadow misplaced at {lat}, {lon}'
            checked_shadows += 1
        assert checked_shadows >= 3
        report['nativeNorthShadowLocationsChecked'] = checked_shadows
    report['northOrientationSamples'] = samples

    # The global abundance map must preserve both longitude and latitude orientation.
    raw = np.fromfile(ROOT / 'data-raw/pds-lunar-prospector-hydrogen/hydrogenhd.dat', dtype='>i2').reshape(360, 720)
    packed = read('hydrogen-global-values.png')
    assert packed.shape == (360, 720)
    physical = raw[::-1].astype(float) / 10
    assert np.max(np.abs(packed[physical >= 0].astype(float)*2 - physical[physical >= 0])) <= 1.0001
    assert np.all(packed[physical < 0] == 0)
    assert np.array_equal(read('hydrogen-global.png'), packed)
    report['hydrogen'] = {'maxPositiveQuantisationErrorPpm': float(np.max(np.abs(packed[physical >= 0]*2.0 - physical[physical >= 0]))),
                          'negativeFitsClipped': int((physical < 0).sum()), 'southPoleFirstCellPpm': float(physical[-1, 0])}

    south = np.fromfile(OUT / 'waterice.bin', dtype='<u2').reshape(2048, 2048)
    assert np.array_equal(read('waterice-south-values.png'), np.where(south == 65535, 255, south).astype(np.uint8))
    for pole in ['north', 'south']:
        small = read(f'waterice-{pole}-values.png')
        display = read(f'waterice-{pole}.png')
        assert small.shape == (2048, 2048) and display.shape == (4096, 4096)
        assert np.all(np.isin(small, [0, 1, 2, 255]))
        assert np.all(np.isin(display, [0, 1, 2, 255]))
        assert not np.any(display == 3), 'Detection class without detection coordinates'
        report[f'waterice{pole.title()}'] = {str(c): int((small == c).sum()) for c in [0, 1, 2, 255]}
    save = PREP / 'polar-validation.json'
    save.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    print('Polar and water data checks passed')

if __name__ == '__main__':
    main()
