#!/usr/bin/env python3
"""Earth maps for the 3D Earth in the sky (NASA Blue Marble / Black Marble).

    python3 -I data-prep/space/earth.py <raw>/earth app/public/space

All three outputs are plate carree, longitude -180 at the left edge, Greenwich in the centre, north up:
    earth_day_4k.jpg     4096x2048  Blue Marble Next Generation, November, land + sea floor, no clouds
    earth_night_4k.jpg   4096x2048  grey: ONLY the city lights of Black Marble 2016 (the blue-tinted land/ice
                                     background is removed: lights are warm (red > blue), the background is blue)
    earth_clouds_2k.jpg  2048x1024  grey: Blue Marble (2002) cloud layer
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def main() -> None:
    raw, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)

    day = Image.open(raw / 'world.topo.bathy.200411.3x5400x2700.jpg').convert('RGB').resize((4096, 2048), Image.LANCZOS)
    day.save(out / 'earth_day_4k.jpg', quality=90, optimize=True)

    night = np.asarray(Image.open(raw / 'BlackMarble_2016_01deg.jpg').convert('RGB')).astype(np.float32) / 255.0
    r, g, b = night[..., 0], night[..., 1], night[..., 2]
    lights = np.clip((0.6 * r + 0.6 * g - 1.15 * b) * 2.2, 0.0, 1.0) ** 0.8  # warm minus blue background
    Image.fromarray(np.round(lights * 255).astype(np.uint8), 'L').resize((4096, 2048), Image.LANCZOS).save(out / 'earth_night_4k.jpg', quality=88, optimize=True)

    clouds = Image.open(raw / 'cloud_combined_2048.jpg').convert('L')
    clouds.save(out / 'earth_clouds_2k.jpg', quality=88, optimize=True)

    for n in ('earth_day_4k.jpg', 'earth_night_4k.jpg', 'earth_clouds_2k.jpg'):
        print(n, (out / n).stat().st_size // 1024, 'KB')


if __name__ == '__main__':
    main()
