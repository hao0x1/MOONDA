"""Fetch NASA's LDEM_64 as checked byte ranges; never execute raw downloads.

The archive can be slow over a single long connection. Bounded workers retry
individual pieces and preserve finished pieces, so an interrupted fetch resumes.
Run with MOONDA/.venv-data/bin/python -I this-file.py [--workers 12].
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import shutil
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / "data-raw/pds-lola-global-ldem64"
BASE = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/"
SIZE = 530841600
CHUNK = 8*1024*1024


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=12)
    opt = parser.parse_args()
    DEST.mkdir(parents=True, exist_ok=True)
    parts = DEST/"ranges"
    parts.mkdir(exist_ok=True)
    label = DEST/"ldem_64.lbl"
    if not label.exists():
        urllib.request.urlretrieve(BASE+label.name, label)
    existing = DEST/"ldem_64.img"
    if existing.exists() and existing.stat().st_size == SIZE:
        print("Already downloaded:", existing, flush=True)
        return
    def fetch(first):
        last = min(SIZE, first+CHUNK)-1
        part = parts/f"{first:012d}-{last:012d}.part"
        length = last-first+1
        if part.exists() and part.stat().st_size == length:
            return part
        for attempt in range(4):
            try:
                req = urllib.request.Request(BASE+"ldem_64.img", headers={"Range":f"bytes={first}-{last}"})
                with urllib.request.urlopen(req, timeout=120) as src:
                    assert src.status == 206, f"Server ignored byte range ({src.status})"
                    assert src.headers["Content-Range"] == f"bytes {first}-{last}/{SIZE}"
                    with part.open("wb") as out:
                        shutil.copyfileobj(src, out, length=128*1024)
                assert part.stat().st_size == length
                return part
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2+attempt)
    starts = list(range(0,SIZE,CHUNK))
    with ThreadPoolExecutor(max_workers=opt.workers) as pool:
        jobs = {pool.submit(fetch, first): first for first in starts}
        for n,job in enumerate(as_completed(jobs),1):
            part = job.result()
            print(time.strftime("%H:%M:%S"),n,"/",len(starts),part.name,flush=True)
    out = DEST/"ldem_64.img"
    with out.open("wb") as f:
        for first in starts:
            last = min(SIZE,first+CHUNK)-1
            with (parts/f"{first:012d}-{last:012d}.part").open("rb") as src:
                shutil.copyfileobj(src,f,length=1024*1024)
    assert out.stat().st_size == SIZE
    print("Saved",out,SIZE,"bytes",flush=True)


if __name__ == "__main__":
    main()
