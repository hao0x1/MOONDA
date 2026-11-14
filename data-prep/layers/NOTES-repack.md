# Exact south-pole terrain repack

`repack_south_terrain.py` preserves the existing scientific pictures. It does not
calculate new slopes, move boundaries or infer classes from a grid. Run it from
the repository root with `.venv-data/bin/python -I`.

The existing `danger.png` has exactly four RGBA colours. Every source pixel is
stored as one byte in `danger-south-codes.png` (4096 × 4096, greyscale PNG), with
the exact colours in `south-terrain.json`, under `products.danger.palette`:

| Code | Exact RGBA colour | Existing meaning |
| --- | --- | --- |
| 0 | `#00000000` | Clear |
| 1 | `#f5c83c78` | Take care: 10–15°, or a mapped small crater bowl |
| 2 | `#f5822896` | 15–25° |
| 3 | `#e63232af` | Over 25° |

The descriptor uses the same south-polar projection, ±304,000 m extent and
−80.02° display clip as the original provider. `replace: true` lets it replace
the coarse global warning map, including cells marked clear by the sharper map.
The original `danger.png`, `danger.bin`, `slope.png` and `slope.bin` are untouched.
Source and reconstructed RGBA SHA-256 hashes are recorded in the descriptor.

The PNG is 1,154,319 bytes, versus 1,959,902 bytes for the original RGBA PNG.
Its full decoded source uses 16 MiB rather than 64 MiB. The provider can retain
the same RGBA smaller copies while saving 48 MiB for the full source.

`slope.png` has more than 256 exact RGBA colours. It is deliberately skipped;
quantising colours or using the smaller value grid would change the picture.
The skip is recorded in `south-terrain.json`.

The script checks equality before and after encoding. An independent read of
the saved PNG plus JSON palette reconstructed all original RGBA bytes exactly.
A second run produced identical files. Differing existing output files cause a
clear error instead of being overwritten.

The scientific sources and limits remain those of the original south-polar
products in `data-prep/features/NOTES.md`; this is only a lossless storage change.
