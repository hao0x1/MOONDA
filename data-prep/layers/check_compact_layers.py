"""Read shipped compact files back and compare every stored code to its input."""
from pathlib import Path
import hashlib
import json
import zlib

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'app/public/data/layers'
ARCHIVE = ROOT / 'data-raw/derived-layer-pngs'


def original_path(url):
    p = OUT / Path(url).name
    if p.exists():
        return p
    entry = json.loads((ARCHIVE / 'index.json').read_text())[p.name]
    archived = ARCHIVE / entry['file']
    assert hashlib.sha256(archived.read_bytes()).hexdigest() == entry['sha256']
    return archived


def check():
    sources = json.loads((OUT / 'compact-sources.json').read_text())
    report = json.loads((ROOT / 'data-prep/layers/compact-report.json').read_text())
    checked = 0
    for url, source in sources.items():
        d = source['packed']
        path = OUT / 'compact' / Path(d['url']).name
        body = path.read_bytes()
        assert hashlib.sha256(body).hexdigest()[:16] in path.name
        h, w, channels, bits = d['height'], d['width'], d['channels'], d['bits']
        original = np.array(Image.open(original_path(url)))
        if Path(url).name == 'slope.png':
            code = np.fromfile(OUT / 'slope.bin', dtype='<u2').reshape(h, w)
            original = np.minimum(np.rint(code.astype(np.float32) * .04), 254).astype(np.uint8)
            original[code == 65535] = 255
        elif channels == 3:
            assert np.all(original[..., 3] == 255)
            original = original[..., :3]
        elif bits == 2:
            original[original == 255] = 0
        offsets = d['offsets']
        assert offsets[0] == 0 and offsets[-1] == len(body)
        ncols = (w + 511) // 512
        assert len(offsets) == ncols * ((h + 511) // 512) + 1
        for i in range(len(offsets) - 1):
            assert offsets[i] < offsets[i + 1]
            x, y = i % ncols * 512, i // ncols * 512
            th, tw = min(512, h - y), min(512, w - x)
            raw = np.frombuffer(zlib.decompress(body[offsets[i]:offsets[i + 1]]), np.uint8)
            if bits == 2:
                # A separate unpacking route verifies the bit order and edge widths.
                bitpairs = np.unpackbits(raw, bitorder='big').reshape(th, tw, 2)
                tile = bitpairs[..., 0] * 2 + bitpairs[..., 1]
            else:
                tile = raw.reshape((th, tw, channels) if channels > 1 else (th, tw))
                if d.get('predictor') == 'sub':
                    tile = np.cumsum(tile, axis=1, dtype=np.uint32).astype(np.uint8)
            assert np.array_equal(tile, original[y:y+th, x:x+tw]), (url, i)
            checked += 1
        if 'preview' in source:
            p = source['preview']
            preview_path = OUT / 'compact' / Path(p['url']).name
            preview_body = preview_path.read_bytes()
            assert hashlib.sha256(preview_body).hexdigest()[:16] in preview_path.name
            rgba = np.frombuffer(zlib.decompress(preview_body), np.uint8).reshape(p['height'], p['width'], 4)
            assert p['width'] <= 512 and p['height'] <= 512
            assert np.any(rgba[..., 3] > 0)
        assert hashlib.sha256(original_path(url).read_bytes()).hexdigest() == report['products'][url]['sourceSha256']
    print(f'All {len(sources)} products and {checked} independent blocks match their source codes; hashes and preview dimensions pass.')


if __name__ == '__main__':
    check()
