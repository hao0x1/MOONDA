"""Small round pictures of the real Sun and Earth for the interface (public/ui/sun.webp, earth.webp).

Sun:   NASA Solar Dynamics Observatory, HMI intensitygram (colourised), cropped to the disc.
Earth: NASA Blue Marble (public/space/earth_day_4k.jpg), drawn as a globe with South-East Asia facing us.

Run:  .venv-data/bin/python data-prep/ui_glyphs.py <path to SDO latest_512_HMIIC.jpg>
"""
import sys
import numpy as np
from PIL import Image, ImageFilter

ROOT = '/Volumes/CodexWork/Projects/MOONDA/app/public'
N = 192          # output size (shown at 12-64 px)
SS = 3           # supersampling

def disc_alpha(n, feather=1.2):
    y, x = np.mgrid[0:n, 0:n]
    r = np.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2)
    return np.clip((n / 2 - 0.5 - r) / feather + 0.5, 0, 1)

def sun(src):
    im = Image.open(src).convert('RGB')
    w = im.width
    d = w / 1.094                      # the disc is about 91% of the frame in SDO "latest" images
    box = ((w - d) / 2, (w - d) / 2, (w + d) / 2, (w + d) / 2)
    im = im.crop(tuple(int(round(v)) for v in box)).resize((N, N), Image.LANCZOS)
    a = np.asarray(im).astype(np.float32) / 255
    a = np.clip(a * 1.12 + 0.02, 0, 1)                      # a touch brighter for small sizes
    out = np.dstack([a, disc_alpha(N)[..., None]])
    Image.fromarray((out * 255).astype(np.uint8), 'RGBA').save(f'{ROOT}/ui/sun.webp', quality=92)

def earth(sub_lat=12.0, sub_lon=104.0, sun_lat=16.0, sun_lon=126.0):
    tex = np.asarray(Image.open(f'{ROOT}/space/earth_day_4k.jpg').convert('RGB')).astype(np.float32) / 255
    th, tw, _ = tex.shape
    n = N * SS
    D = np.pi / 180
    vec = lambda lat, lon: np.array([np.cos(lat * D) * np.cos(lon * D), np.cos(lat * D) * np.sin(lon * D), np.sin(lat * D)])
    f = vec(sub_lat, sub_lon)
    rgt = np.cross([0, 0, 1], f); rgt /= np.linalg.norm(rgt)
    up = np.cross(f, rgt)
    s = vec(sun_lat, sun_lon)
    y, x = np.mgrid[0:n, 0:n]
    R = n / 2 - SS
    dx = (x + 0.5 - n / 2) / R
    dy = (n / 2 - y - 0.5) / R
    d2 = dx * dx + dy * dy
    dz = np.sqrt(np.clip(1 - d2, 0, 1))
    p = dx[..., None] * rgt + dy[..., None] * up + dz[..., None] * f
    lat = np.arcsin(np.clip(p[..., 2], -1, 1)); lon = np.arctan2(p[..., 1], p[..., 0])
    tx = np.clip(((lon / (2 * np.pi) + 0.5) * tw).astype(int), 0, tw - 1)
    ty = np.clip(((0.5 - lat / np.pi) * th).astype(int), 0, th - 1)
    c = tex[ty, tx]
    cos_sun = p @ s
    day = np.clip((cos_sun + 0.10) / 0.30, 0, 1)
    lit = 0.16 + 0.84 * day * (0.70 + 0.30 * np.clip(cos_sun, 0, 1))
    limb = 0.74 + 0.26 * dz
    haze = ((1 - dz) ** 2.2 * 0.55 * day)[..., None] * np.array([0.42, 0.66, 1.0])
    c = np.clip(c ** 0.80 * 1.55 * (lit * limb)[..., None] + haze, 0, 1)
    alpha = np.clip((1.0 - np.sqrt(d2)) * R / SS + 0.5, 0, 1)
    out = np.dstack([c, alpha[..., None]])
    im = Image.fromarray((out * 255).astype(np.uint8), 'RGBA').resize((N, N), Image.LANCZOS)
    im.save(f'{ROOT}/ui/earth.webp', quality=92)

if __name__ == '__main__':
    sun(sys.argv[1])
    earth()
    print('wrote', f'{ROOT}/ui/sun.webp', f'{ROOT}/ui/earth.webp')
