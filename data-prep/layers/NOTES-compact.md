# Compact stored maps

This is an encoding change to the maps already audited in the other notes.
No new observation or scientific classification is introduced. Original
southern planner grids remain unchanged.

Run with the retained environment:

```sh
.venv-data/bin/python -I data-prep/layers/build_compact_layers.py
.venv-data/bin/python -I data-prep/layers/check_compact_layers.py
```

`app/public/data/layers/compact-sources.json` is an overlay keyed by the original
source URL. The assembler merges its `packed`, `preview` and optional `palette`
fields without changing the map's projection or coverage. Original numeric
paths keep their meaning.

## On-disk format

Each `packed` descriptor contains width, height, channels, bit depth, a 512-pixel
tile size, compression and offsets. Its file concatenates independently
zlib-wrapped DEFLATE streams in row-major tile order. Offset zero is zero; the
last offset is the file length. Tile index is `y * ceil(width / 512) + x`.
Edge tiles have their actual remaining width and height, without padding.

For 8-bit sources, bytes are row major and channels are interleaved. Optional
`predictor: sub` stores the first pixel of each row unchanged, then the byte
difference to the pixel on its left for each channel, modulo 256. Restore each
row with a prefix sum for each channel. This reduces download size without
changing any source byte.

For 2-bit class sources, four pixels occupy one byte, high pair first. Pixel
`p` is `(bytes[p >> 2] >> (6 - (p & 3) * 2)) & 3`. Each row is byte aligned.
Every source width, including edge blocks, is divisible by four.

The file names include the first 16 hex digits of the SHA-256 of the actual
compressed bytes. Future data changes cannot reuse an old cache key. The
builder never deletes a differently named old file or overwrites differing
bytes at an existing hashed path.

## Per-map storage

- PSR retains one byte per pixel, including its coverage percentages and
  transparent missing code. It uses its existing colour table at draw time.
- Danger uses two bits per pixel for its existing four classes.
- Predicted water uses two bits per pixel for its existing classes. Render-only
  missing code 255 becomes transparent code zero; both have zero opacity. The
  numeric products preserve code 255 as missing, so this is not a new claim of
  absence of ice.
- Global slope keeps its original one-byte quarter-degree codes. Southern
  slope is drawn from the existing fine numeric grid using quarter-degree
  display codes and the same slope colour table. Maximum display quantisation
  error is 0.120001°, below half a 0.25° step. The original fine numeric grid is
  unchanged, and colours already saturate at 30°.
- Hydrogen keeps its existing one-byte codes and colour table.
- The southern height picture is exact three-channel RGB. Every source alpha
  byte is 255, so dropping the alpha channel loses no information. Colours and
  artificial shading remain unchanged.

The twelve rendered sources would occupy **138,671,232 bytes** if every full
compact base were held at once, before a cache limit. This replaces about
397 MB of decoded sources and colour mipmaps. The worker can instead retain
only decoded 512-pixel blocks needed by the view and a small set of previews.
The worker's measured retention and first-switch results are recorded by the
browser QA; these static byte totals are not a worker-heap measurement.

## Small previews

Each map also has one small RGBA preview, no wider or taller than 512 pixels.
The builder applies the colour table first, then averages premultiplied colour
and coverage over each output cell. It never averages class codes into a new
class. A preview is one DEFLATE stream without block offsets or a predictor.
At distant zooms the worker uses this averaged preview. At finer zooms each
tile request waits for the required compact blocks, decoded off the main
thread, then colours them. It does not keep full RGBA copies or colour mipmaps.

Rendered downloads total **42,261,060 bytes**: 39,305,699 bytes of block streams
and 2,955,361 bytes of previews. This includes the pre-existing southern height
and slope pictures, which were excluded from the prior 30.84 MB added-data
figure. Six separately named numeric sources add 1,151,846 bytes. Startup also
downloads those bytes so new northern spot values work offline, for a combined
**43,412,906 bytes**. None of these maps is decoded at startup. The report lists
the exact file sizes and source hashes.

## Redundant generated inputs

After the compact integration is verified, run:

```sh
.venv-data/bin/python -I data-prep/layers/build_compact_layers.py --archive-only
```

This moves only `slope-global-values.png` and `danger-global-values.png` into
`data-raw/derived-layer-pngs/<sha256>-<name>`, preserving both bytes and hashes.
The script reads that archive when a public original is absent. The packed
descriptors retain the original URL as an identity key; the worker reads the
hashed compact file. The five legacy southern PNGs remain in place for other
map owners. The archive command is explicit, and is not run by a normal rebuild.

The archive step was completed after the before-capture finished. It moved
19,742,964 bytes of global slope PNG and 4,423,979 bytes of global danger PNG,
with their original SHA-256 hashes unchanged. A complete normal rebuild then
read the archived inputs successfully and reproduced all 30 compact files with
identical hashes. `compact-archive-receipt.json` records their locations and
the five legacy images still present.

After that archive, added shipped data files and credits total **50,114,031
bytes**, excluding the manifest difference. Even counting the entire current
102,320-byte manifest gives a conservative **50,216,351 bytes** (50.22 MB),
within the 60 MB added-data target. This is a shipped-file count, separate from
the 43.41 MB of rendered and numeric map data downloaded by the startup row.

`check_compact_layers.py` independently reads every compressed block, checks its
hash and offsets, unpacks its bits or predictor and compares every source
pixel. Its alternative bit-unpacking route checks the MSB-first convention.
No downloaded file is executed, and no package installation is needed.
