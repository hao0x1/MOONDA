"""Pack the existing science maps into small independently deflated blocks.

Run with the retained environment, from the repository root:
  .venv-data/bin/python -I data-prep/layers/build_compact_layers.py

The original pictures, numeric grids and manifest are not overwritten. The
manifest assembler may merge compact-sources.json by the original source URL.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import time
import zlib

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'app/public/data/layers'
PACKED = OUT / 'compact'
TILE = 512
ARCHIVE = ROOT / 'data-raw/derived-layer-pngs'
ARCHIVE_NAMES = ['slope-global-values.png', 'danger-global-values.png']


def digest(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def source_path(url: str) -> Path:
    name = Path(url).name
    direct = OUT / name
    if direct.exists():
        return direct
    index_path = ARCHIVE / 'index.json'
    if index_path.exists():
        index = json.loads(index_path.read_text())
        if name in index:
            archived = ARCHIVE / index[name]['file']
            assert archived.exists() and digest(archived.read_bytes()) == index[name]['sha256']
            return archived
    raise FileNotFoundError(f'No public or archived source for {url}')


def archive_global_pngs():
    """Keep redundant generated inputs off the shipped site, without deleting them."""
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    index_path = ARCHIVE / 'index.json'
    index = json.loads(index_path.read_text()) if index_path.exists() else {}
    for name in ARCHIVE_NAMES:
        direct = OUT / name
        if not direct.exists():
            source_path(name)  # An archived source must still be verified.
            continue
        data = direct.read_bytes()
        sha = digest(data)
        archived = ARCHIVE / f'{sha}-{name}'
        if archived.exists():
            assert archived.read_bytes() == data
            direct.unlink()
        else:
            direct.rename(archived)
        assert digest(archived.read_bytes()) == sha
        index[name] = {'file': archived.name, 'sha256': sha, 'bytes': len(data)}
        index_path.write_text(json.dumps(index, indent=1) + '\n')
        print(f'Archived {name} unchanged ({len(data):,} bytes)', flush=True)


def write_hashed(stem: str, data: bytes) -> str:
    name = f'{stem}-{digest(data)[:16]}.deflate'
    path = PACKED / name
    if path.exists():
        assert path.read_bytes() == data, f'Existing hashed file differs: {path}'
    else:
        path.write_bytes(data)
    return f'./data/layers/compact/{name}'


def pack_two(a: np.ndarray) -> np.ndarray:
    """Four pixels in one byte, high pair first; rows are byte aligned."""
    assert a.dtype == np.uint8 and a.ndim == 2 and a.shape[1] % 4 == 0
    assert a.max() <= 3
    return ((a[:, 0::4] << 6) | (a[:, 1::4] << 4)
            | (a[:, 2::4] << 2) | a[:, 3::4])


def restore_two(a: np.ndarray, width: int) -> np.ndarray:
    out = np.empty((a.shape[0], width), np.uint8)
    for shift, start in [(6, 0), (4, 1), (2, 2), (0, 3)]:
        out[:, start::4] = (a >> shift) & 3
    return out


def sub_filter(a: np.ndarray) -> np.ndarray:
    # Delta to the pixel on the left, independently for each colour channel.
    out = a.copy()
    out[:, 1:] -= a[:, :-1]
    return out


def restore_sub(a: np.ndarray) -> np.ndarray:
    return np.cumsum(a, axis=1, dtype=np.uint32).astype(np.uint8)


def palette_rgba(colours: list[str]) -> np.ndarray:
    p = np.zeros((256, 4), np.uint8)
    for i, colour in enumerate(colours[:256]):
        s = colour.removeprefix('#')
        assert len(s) in [6, 8]
        p[i] = [int(s[j:j+2], 16) for j in (0, 2, 4)] + [int(s[6:8], 16) if len(s) == 8 else 255]
    return p


def preview_rgba(a: np.ndarray, palette: np.ndarray | None) -> np.ndarray:
    """Area-average real colours and coverage, never numeric class codes."""
    h, w = a.shape[:2]
    # Every source has a common integer reduction factor, including hydrogen.
    factor = 1
    while w // factor > 512 or h // factor > 512:
        factor *= 2
    assert h % factor == 0 and w % factor == 0
    oh, ow = h // factor, w // factor
    out = np.empty((oh, ow, 4), np.uint8)
    for y in range(oh):
        rows = a[y * factor:(y + 1) * factor]
        if palette is not None:
            rgba = palette[rows]
        else:
            assert rows.ndim == 3 and rows.shape[2] == 3
            rgba = np.empty((*rows.shape[:2], 4), np.uint8)
            rgba[..., :3] = rows
            rgba[..., 3] = 255
        block = rgba.reshape(factor, ow, factor, 4).astype(np.uint32)
        alpha = block[..., 3]
        summed_alpha = alpha.sum(axis=(0, 2), dtype=np.uint32)
        for c in range(3):
            numerator = (block[..., c] * alpha).sum(axis=(0, 2), dtype=np.uint32)
            out[y, :, c] = np.rint(numerator / np.maximum(summed_alpha, 1)).astype(np.uint8)
        out[y, :, 3] = np.rint(summed_alpha / (factor * factor)).astype(np.uint8)
    return out


def compress_blocks(a: np.ndarray, bits: int, predictor: str | None) -> tuple[bytes, list[int]]:
    h, w = a.shape[:2]
    blocks: list[bytes] = []
    offsets = [0]
    for y in range(0, h, TILE):
        for x in range(0, w, TILE):
            tile = np.ascontiguousarray(a[y:y+TILE, x:x+TILE])
            if bits == 2:
                raw = pack_two(tile)
            else:
                raw = sub_filter(tile) if predictor == 'sub' else tile
            blob = zlib.compress(raw.tobytes(), 6)
            # Prove each independent block before it reaches the browser.
            restored = np.frombuffer(zlib.decompress(blob), np.uint8).reshape(raw.shape)
            restored = restore_two(restored, tile.shape[1]) if bits == 2 else restore_sub(restored) if predictor == 'sub' else restored
            assert np.array_equal(restored, tile)
            blocks.append(blob)
            offsets.append(offsets[-1] + len(blob))
    return b''.join(blocks), offsets


def make_product(url: str, source: dict, array: np.ndarray, bits: int, report: dict,
                 preview: bool, palette_override: list[str] | None = None) -> dict:
    stem = Path(url).stem
    channels = array.shape[2] if array.ndim == 3 else 1
    raw, offsets = compress_blocks(array, bits, None)
    predictor = None
    if bits == 8:
        delta, delta_offsets = compress_blocks(array, bits, 'sub')
        if len(delta) < len(raw):
            raw, offsets, predictor = delta, delta_offsets, 'sub'
    h, w = array.shape[:2]
    packed = {'url': write_hashed(stem, raw), 'width': w, 'height': h,
              'channels': channels, 'bits': bits, 'compression': 'deflate',
              'tileSize': TILE, 'offsets': offsets}
    if predictor:
        packed['predictor'] = predictor
    result = {'packed': packed}
    if palette_override is not None:
        result['palette'] = palette_override
    palette = palette_rgba(palette_override or source['palette']) if source.get('palette') or palette_override else None
    preview_bytes = 0
    if preview:
        rgba = preview_rgba(array, palette)
        b = zlib.compress(rgba.tobytes(), 6)
        assert np.array_equal(np.frombuffer(zlib.decompress(b), np.uint8).reshape(rgba.shape), rgba)
        result['preview'] = {'url': write_hashed(stem + '-preview', b), 'width': rgba.shape[1],
                             'height': rgba.shape[0], 'channels': 4, 'bits': 8, 'compression': 'deflate'}
        preview_bytes = len(b)
    original = source_path(url)
    report[url] = {'sourceBytes': original.stat().st_size,
                   'sourceSha256': digest(original.read_bytes()),
                   'packedBytes': len(raw), 'previewBytes': preview_bytes,
                   'retainedPackedBytes': (w * h * channels * bits + 7) // 8,
                   'width': w, 'height': h, 'channels': channels, 'bits': bits,
                   'predictor': predictor, 'blocks': len(offsets) - 1,
                   'allBlocksReconstructedExactly': True}
    print(url, f'{len(raw):,} packed + {preview_bytes:,} preview bytes', flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive-global-pngs', action='store_true', help='Archive two redundant generated global PNGs after packing')
    parser.add_argument('--archive-only', action='store_true', help='Only archive those two inputs; existing compact files must already exist')
    opt = parser.parse_args()
    if opt.archive_only:
        assert (OUT / 'compact-sources.json').exists(), 'Generate compact files first'
        archive_global_pngs()
        return
    PACKED.mkdir(exist_ok=True)
    manifest = json.loads((OUT / 'manifest.json').read_text())
    maps: dict[str, dict] = {}
    values: dict[str, dict] = {}
    for entry in manifest:
        if entry['id'] not in ['psr', 'waterice', 'slope', 'danger', 'height']:
            continue
        for s in entry.get('rasterSources', []):
            maps[s['url']] = s
        for s in entry.get('valueSources', []):
            if s['url'].endswith('.png'):
                values[s['url']] = s
    # Height colours retains its existing exact RGB picture, even when the
    # manifest does not need an explicit rasterSources entry for that fallback.
    maps.setdefault('./data/layers/height.png', {})
    result: dict[str, dict] = {}
    report: dict[str, dict] = {}
    terrain = json.loads((OUT / 'global-terrain.json').read_text())
    for url, source in maps.items():
        a = np.array(Image.open(source_path(url)))
        bits = 8
        override = None
        if Path(url).name == 'slope.png':
            codes = np.fromfile(OUT / 'slope.bin', dtype='<u2').reshape(a.shape[:2])
            # Display-only quarter-degree codes, matching the global map. The
            # original fine numeric grid remains unchanged for the spot panel.
            degrees = codes.astype(np.float32) * 0.01
            a = np.minimum(np.rint(degrees * 4), 254).astype(np.uint8)
            a[codes == 65535] = 255
            valid = (codes != 65535) & (degrees <= 63.5)
            error = float(np.max(np.abs(a[valid].astype(np.float32) * 0.25 - degrees[valid])))
            assert error <= 0.12501
            override = terrain['slope']['palette']
        elif a.ndim == 3:
            assert a.shape[2] == 4 and np.all(a[..., 3] == 255)
            a = np.ascontiguousarray(a[..., :3])
        elif Path(url).name.startswith(('danger-', 'waterice-')):
            if np.any(a == 255):
                p = palette_rgba(source['palette'])
                assert p[0, 3] == 0 and p[255, 3] == 0
                a[a == 255] = 0  # Render-only transparent cells; numeric maps keep 255.
            assert a.max() <= 3
            bits = 2
        result[url] = make_product(url, source, a, bits, report, True, override)
        if Path(url).name == 'slope.png':
            report[url]['displayQuantisationMaxDeg'] = error
            report[url]['numericGridUnchanged'] = True
        if bits == 2:
            report[url]['transparentNoDataRemappedForRenderingOnly'] = Path(url).name.startswith('waterice-')
    for url, source in values.items():
        if url in result:
            continue
        a = np.array(Image.open(source_path(url)))
        assert a.ndim == 2 and a.dtype == np.uint8
        result[url] = make_product(url, {}, a, 8, report, False)
    (OUT / 'compact-sources.json').write_text(json.dumps(result, indent=1) + '\n')
    rendered = [report[url] for url in maps]
    report_path = ROOT / 'data-prep/layers/compact-report.json'
    summary = {'version': 1, 'tileSize': TILE,
               'renderDownloadBytes': sum(r['packedBytes'] + r['previewBytes'] for r in rendered),
               'renderDecodedBaseBytesIfAllHeld': sum(r['retainedPackedBytes'] for r in rendered),
               'numericDownloadBytes': sum(report[url]['packedBytes'] for url in values if url not in maps),
               'products': report}
    report_path.write_text(json.dumps(summary, indent=1) + '\n')
    print(json.dumps({k: v for k, v in summary.items() if k != 'products'}, indent=1), flush=True)
    if opt.archive_global_pngs:
        archive_global_pngs()


if __name__ == '__main__':
    start = time.monotonic()
    main()
    print(f'Completed in {time.monotonic()-start:.1f} seconds', flush=True)
