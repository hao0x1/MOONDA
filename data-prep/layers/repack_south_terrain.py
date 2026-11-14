"""Losslessly repack existing south-pole RGBA maps into byte codes and a palette.

Run with .venv-data/bin/python -I data-prep/layers/repack_south_terrain.py.
Only images with at most 256 exact RGBA colours qualify. No quantisation, class
inference or resampling is allowed: every reconstructed RGBA byte must match.
The original pictures and planner grids are never written.
"""
from __future__ import annotations

import hashlib
from io import BytesIO
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'app/public/data/layers'


def digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def write_new_or_identical(path: Path, body: bytes) -> None:
    # A rerun may confirm an existing result, but cannot silently replace another product.
    if path.exists():
        if path.read_bytes() != body:
            raise ValueError(f'{path}: existing file differs; no file was overwritten')
        return
    path.write_bytes(body)


def repack(name: str) -> tuple[dict | None, str | None]:
    source = OUT / f'{name}.png'
    original = source.read_bytes()
    with Image.open(BytesIO(original)) as image:
        rgba = image.convert('RGBA')
        colours = rgba.getcolors(maxcolors=256)
        if colours is None:
            message = 'More than 256 unique RGBA colours; original retained without quantisation.'
            print(f'{name}: skipped. {message}', flush=True)
            return None, message
        # Transparent first, then increasing alpha: the current danger image keeps
        # codes 0 clear, 1 caution, 2 steep and 3 over 25 degrees. The palette is authoritative.
        palette = sorted((colour for _, colour in colours), key=lambda c: (c[3], *c[:3]))
        full = np.array(rgba, dtype=np.uint8)
        width, height = rgba.size
    codes = np.empty((height, width), dtype=np.uint8)
    for code, colour in enumerate(palette):
        matches = np.all(full == np.array(colour, dtype=np.uint8), axis=2)
        codes[matches] = code
    table = np.asarray(palette, dtype=np.uint8)
    assert np.array_equal(table[codes], full), 'Palette reconstruction changed source pixels'
    rgba_hash = digest(full.tobytes())
    encoded = BytesIO()
    Image.fromarray(codes, mode='L').save(encoded, format='PNG', optimize=True)
    body = encoded.getvalue()
    target = OUT / f'{name}-south-codes.png'
    # Check the saved PNG as the browser will read it, not just the array before encoding.
    with Image.open(BytesIO(body)) as saved:
        assert saved.mode == 'L' and saved.size == (width, height)
        assert np.array_equal(table[np.array(saved)], full)
    assert source.read_bytes() == original, 'Source changed during repack'
    write_new_or_identical(target, body)
    descriptor = {
        'url': f'./data/layers/{target.name}', 'projection': 'polar', 'pole': 'south',
        'extentM': 304000, 'clipTrueLatDeg': -80.02, 'encoding': 'gray8',
        'palette': ['#' + ''.join(f'{v:02x}' for v in c) for c in palette],
        'replace': True, 'width': width, 'height': height, 'source': source.name,
        'sourceSha256': digest(original), 'rgbaSha256': rgba_hash,
        'bytes': len(body), 'uniqueColours': len(palette),
    }
    print(f'{name}: {len(palette)} exact colours, {width} × {height}; {len(original):,} → {len(body):,} bytes; RGBA reconstruction identical', flush=True)
    return descriptor, None


def main() -> None:
    products, skipped = {}, {}
    for name in ('danger', 'slope'):
        descriptor, reason = repack(name)
        if descriptor is not None:
            products[name] = descriptor
        else:
            skipped[name] = reason
    if not products:
        print('No exact repacks available; no descriptor written.', flush=True)
        return
    result = dict(version=1, products=products, skipped=skipped)
    write_new_or_identical(OUT / 'south-terrain.json', (json.dumps(result, indent=2) + '\n').encode())


if __name__ == '__main__':
    main()
