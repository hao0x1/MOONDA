"""Save primary references as data, never code. Run with .venv-data/bin/python -I."""
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
SOURCES = [
    ('ice-north-isro-dfsar', 'chandrayaan-2-one-year.pdf', 'https://www.isro.gov.in/media_isro/pdf/chandrayaan-2_completes_a_year_around_the_moon_.pdf'),
    ('ice-north-mini-rf-lpsc2011', '2086.pdf', 'https://www.lpi.usra.edu/meetings/lpsc2011/pdf/2086.pdf'),
    ('ice-north-mini-rf-spudis2013', '20150000268.pdf', 'https://ntrs.nasa.gov/api/citations/20150000268/downloads/20150000268.pdf'),
    ('ice-north-radar-context', 'nasa.html', 'https://science.nasa.gov/missions/mini-rf/nasa-radar-finds-ice-deposits-at-moons-north-pole/'),
    ('ice-north-rozhdestvenskiy', 'nasa.html', 'https://science.nasa.gov/image-detail/rozhdestvenskiy-x-main-context-580/'),
    ('ice-north-hermite', 'nasa.html', 'https://science.nasa.gov/image-detail/hermite/'),
    ('ice-north-erlanger', 'nasa.html', 'https://science.nasa.gov/photojournal/eternal-darkness-near-the-north-pole/'),
    ('ice-north-nasa-polar-opportunities', '20180008495.pdf', 'https://ntrs.nasa.gov/api/citations/20180008495/downloads/20180008495.pdf'),
]

for folder, filename, url in SOURCES:
    target = ROOT / 'data-raw' / folder / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        with urlopen(Request(url, headers={'User-Agent': 'MOONDA source audit'}), timeout=90) as response:
            target.write_bytes(response.read())
    body = target.read_bytes()
    (target.parent / 'source.json').write_text(json.dumps(dict(url=url, file=filename, bytes=len(body), sha256=hashlib.sha256(body).hexdigest()), indent=2) + '\n')
    print(folder, len(body))
