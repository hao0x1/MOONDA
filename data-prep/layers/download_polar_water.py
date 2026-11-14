"""Download data only; do not execute anything from an archive.

Run with .venv-data/bin/python -I. Each product has its own data-raw folder.
The large PDS ZIP uses checked HTTP ranges because a single connection is slow.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import argparse
import hashlib
import json
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / 'data-raw'
PGDA = 'https://pgda.gsfc.nasa.gov/data/MoonIllumination/'
PRP = 'https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/'
SOURCES = [
    ('pgda-lola-north-psr', f'LPSR_{band}_201608.TIF', PGDA + f'LPSR_{band}_201608.TIF', size)
    for band, size in [('65N_240M', 613892), ('75N_120M', 1105159), ('85N_060M', 824237)]
] + [
    ('pgda-lola-south-wide-psr', 'LPSR_65S_240M_201608.TIF', PGDA + 'LPSR_65S_240M_201608.TIF', 582074),
    ('pds-lunar-prospector-hydrogen', 'hydrogenhd.dat',
     'https://pds-geosciences.wustl.edu/missions/lunarp/reduced/hydrogenhd.dat', 518400),
    ('pds-diviner-prp-north', 'dlre_prp_north.zip', PRP + 'extras/prp/dlre_prp_north.zip', 115880233),
]

def download(folder, name, url, expected):
    out = RAW / folder / name
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists() and out.stat().st_size == expected:
        print('Already complete:', name, flush=True)
        return out
    chunks = out.parent / (name + '.parts')
    chunks.mkdir(exist_ok=True)
    step = 2 * 1024 * 1024
    parts = [(start, min(start+step, expected)) for start in range(0, expected, step)]
    def fetch(part):
        start, end = part
        p = chunks / f'{start:010d}.part'
        if p.exists() and p.stat().st_size == end-start:
            return p
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, headers={'Range': f'bytes={start}-{end-1}', 'Accept-Encoding': 'identity'})
                with urllib.request.urlopen(req, timeout=150) as response:
                    content_range = response.headers.get('Content-Range')
                    if response.status != 206 or content_range != f'bytes {start}-{end-1}/{expected}':
                        raise ValueError(f'Wrong range response: {response.status}, {content_range}')
                    body = response.read()
                if len(body) != end-start:
                    raise ValueError('Truncated range')
                p.write_bytes(body)
                print(f'{name}: {end}/{expected}', flush=True)
                return p
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2 * (attempt+1))
    with ThreadPoolExecutor(max_workers=8) as pool:
        paths = list(pool.map(fetch, parts))
    assembling = out.with_name(out.name + '.assembling')
    with assembling.open('wb') as destination:
        for p in paths:
            destination.write(p.read_bytes())
    assembling.replace(out)
    assert out.stat().st_size == expected
    return out

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--north-prp-only', action='store_true')
    args = parser.parse_args()
    inventory = []
    for folder, name, url, size in SOURCES:
        if args.north_prp_only and name != 'dlre_prp_north.zip':
            continue
        path = download(folder, name, url, size)
        inventory.append({'path': str(path.relative_to(ROOT)), 'url': url, 'bytes': size,
                          'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    (ROOT / 'data-prep/layers/polar-downloads.json').write_text(json.dumps(inventory, indent=2) + '\n')

if __name__ == '__main__':
    main()
