#!/usr/bin/env python3
"""Milky Way background for the sky (NASA SVS "Deep Star Maps 2020", id 4851).

    python3 -I data-prep/space/milkyway.py <raw>/svs4851/milkyway_2020_8k.exr app/public/space

Input: the Milky-Way-only map (bright Hipparcos/Tycho stars removed), 8192x4096 OpenEXR, linear light,
plate carree in J2000 right ascension / declination:
    column u = 0.5 - RA/360 (mod 1)   -> RA 0h in the centre, RA grows to the LEFT, RA 12h at both edges
    row    v = (90 - Dec)/180         -> north at the top
(checked: Sirius, Canopus, Vega, Capella, Alpha Centauri land on those pixels in starmap_2020_4k.exr).

Output: milkyway_8k.jpg and milkyway_4k.jpg, same layout, encoded as
    jpg = clip(linear * GAIN, 0, 1) ** (1 / 2.2)
so the shader gets the original linear value back with  linear = jpg ** 2.2 / GAIN  and does the
tone-mapping itself (black point, exposure).  ffmpeg decodes the EXR; numpy + Pillow do the rest.
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

GAIN = 4.0
FFMPEG = '/opt/homebrew/bin/ffmpeg'


def read_exr(path: str, w: int, h: int) -> np.ndarray:
    raw = subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-i', path, '-pix_fmt', 'gbrpf32le', '-f', 'rawvideo', '-'],
                         check=True, capture_output=True).stdout
    g, b, r = np.frombuffer(raw, dtype='<f4').reshape(3, h, w)
    return np.stack([r, g, b], axis=-1)


def encode(lin: np.ndarray) -> Image.Image:
    v = np.clip(lin * GAIN, 0.0, 1.0) ** (1 / 2.2)
    return Image.fromarray(np.round(v * 255).astype(np.uint8), 'RGB')


def main() -> None:
    src, out = sys.argv[1], Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    lin = read_exr(src, 8192, 4096)
    print('clipped pixels: %.4f %%' % (100 * float((lin.max(axis=-1) * GAIN > 1).mean())))
    encode(lin).save(out / 'milkyway_8k.jpg', quality=int(sys.argv[3]) if len(sys.argv) > 3 else 86, optimize=True)
    half = lin.reshape(2048, 2, 4096, 2, 3).mean(axis=(1, 3))  # 2x2 box filter in linear light
    encode(half).save(out / 'milkyway_4k.jpg', quality=88, optimize=True)
    for n in ('milkyway_8k.jpg', 'milkyway_4k.jpg'):
        print(n, (out / n).stat().st_size // 1024, 'KB')


if __name__ == '__main__':
    main()
