"""Fetch NASA PGDA's PSR DATA file using verified resumable HTTP ranges.

No downloaded code is executed. All writes are below assets-codex/features/.
"""
from __future__ import annotations

import concurrent.futures
import hashlib
import json
from pathlib import Path
import time
import urllib.request

BASE = Path(__file__).resolve().parents[1]
URL = "https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LPSR_80S_20MPP_ADJ.TIF"
SIZE = 154221202
PART_SIZE = 2 * 1024 * 1024
PARTS = BASE / "downloads" / "psr-parts"
OUT = BASE / "downloads" / "psr-complete" / "LPSR_80S_20MPP_ADJ.TIF"


def get_part(i: int) -> Path:
    lo = i * PART_SIZE
    hi = min(SIZE, lo + PART_SIZE) - 1
    dest = PARTS / f"{i:04d}.part"
    if dest.exists() and dest.stat().st_size == hi - lo + 1:
        return dest
    for retry in range(6):
        try:
            req = urllib.request.Request(URL, headers={"Range": f"bytes={lo}-{hi}",
                                                      "User-Agent": "MOONDA science data preparation"})
            with urllib.request.urlopen(req, timeout=90) as response:
                expected = f"bytes {lo}-{hi}/{SIZE}"
                if response.status != 206 or response.headers.get("Content-Range") != expected:
                    raise ValueError(f"Unexpected HTTP range response: {response.status} {response.headers}")
                data = response.read(hi - lo + 2)
            if len(data) != hi - lo + 1:
                raise ValueError(f"Part{i} is short: {len(data)}")
            tmp = dest.with_suffix(".tmp")
            tmp.write_bytes(data)
            tmp.replace(dest)
            return dest
        except Exception as error:
            print(f"retry part {i} ({retry + 1}/6): {error}", flush=True)
            if retry == 5:
                raise
            time.sleep(min(8, retry + 1))
    raise AssertionError("unreachable")


def main():
    PARTS.mkdir(parents=True, exist_ok=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    count = (SIZE + PART_SIZE - 1) // PART_SIZE
    start = time.monotonic()
    if not OUT.exists() or OUT.stat().st_size != SIZE:
        with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool:
            futures = [pool.submit(get_part, i) for i in range(count)]
            for n, f in enumerate(concurrent.futures.as_completed(futures), 1):
                p = f.result()
                print(f"parts {n}/{count}; {p.name}; elapsed {time.monotonic()-start:.1f}s", flush=True)
        with OUT.with_suffix(".tmp").open("wb") as target:
            for i in range(count):
                target.write((PARTS / f"{i:04d}.part").read_bytes())
        OUT.with_suffix(".tmp").replace(OUT)
    assert OUT.stat().st_size == SIZE
    md5 = hashlib.md5()
    with OUT.open("rb") as stream:
        while chunk := stream.read(8 * 1024 * 1024):
            md5.update(chunk)
    import rasterio
    import numpy as np
    counts = {}
    with rasterio.open(OUT) as src:
        for _, win in src.block_windows(1):
            vals, nums = np.unique(src.read(1, window=win), return_counts=True)
            for val, num in zip(vals, nums):
                k = "nan" if np.isnan(val) else str(float(val))
                counts[k] = counts.get(k, 0) + int(num)
        info = {"width": src.width, "height": src.height,
                "transform": list(src.transform)[:6], "crs": src.crs.to_wkt(),
                "dtype": src.dtypes[0], "nodata": "nan", "native_counts": counts,
                "every_native_tile_read": True}
    metadata = {"url": URL, "path": str(OUT.relative_to(BASE)), "size": SIZE,
                "md5": md5.hexdigest(), "last_modified": "2023-06-03T00:59:02Z", **info}
    (OUT.parent / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    # Parts are our own temporary download fragments; retain only the verified source.
    for i in range(count):
        (PARTS / f"{i:04d}.part").unlink(missing_ok=True)
    PARTS.rmdir()
    print(json.dumps(metadata, indent=2), flush=True)


if __name__ == "__main__":
    main()
