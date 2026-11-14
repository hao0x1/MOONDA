"""Assemble schema-compatible manifest, delivery notes and integrity inventory.

Run after the four independent builders and again after check.py.
"""
from __future__ import annotations
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'features/out'


def main():
    entries=[json.loads((OUT/f'{lid}-manifest.json').read_text()) for lid in ['craters','psr','waterice','danger']]
    (OUT/'manifest-additions.json').write_text(json.dumps(entries,indent=2,ensure_ascii=False)+'\n')
    shipped=['craters.bin','craters-small-south.bin','craters.json','psr.bin','psr.png','waterice.bin','waterice.png','ice-sites.json','danger.bin','danger.png','manifest-additions.json']
    inventory=[]
    for name in shipped:
        p=OUT/name
        h=hashlib.md5(p.read_bytes()).hexdigest()
        inventory.append({'file':name,'bytes':p.stat().st_size,'md5':h})
    (OUT/'delivery-files.json').write_text(json.dumps(inventory,indent=2)+'\n')
    header='''# MOONDA feature data

Built entirely inside `assets-codex/`. Original project inputs were read only.
Every coloured region comes from a published dataset or a stated calculation
from those data. A cold trap is a prediction of ice survival, not proof of ice.

## App handoff

- `manifest-additions.json` is an array with exactly the existing manifest fields.
- `craters.bin` and `craters-small-south.bin` are **Float32 LE vector triples**,
  `[latDeg, lonDeg, diameterKm]`, diameter descending. They are the exception to
  the raster loader. `craters.json` supplies counts, LOD prefix lengths and licences.
  Keep the small study catalogue separate; it has not been cross-matched with Robbins.
- All other `.bin` files are **2048 square Uint16 LE**; decode
  `raw * scale + offset`, `65535` means no data. Extent is exactly
  `[-304000,+304000]` metres on both axes; top row faces 0 E, right faces 90 E.
- All three overlay PNGs are **4096 square RGBA** on that same extent. Outside
  80 S is transparent. PSR opacity is area-weighted. Water-ice PNG sharpens only
  the shadow footprint, not the underlying thermal model.
- Water-ice classes 1 and 2 are predictions. Class 3 is reserved and empty;
  published region-level M3 detection counts support markers, not a pixel mask.
  Cabeus is the only directly confirmed marker, based on LCROSS plume water.
  A crater-centre marker describes evidence inside the crater, not a measurement
  at its centre. The LCROSS impact position is separately stated in its evidence.
- Use categorical sampling for `waterice` and `danger`, never interpolate class codes.
  Class 0 means no mapped feature/warning, not proven absence of ice or a safe route.
- Do not load `*-manifest.json`, reports, `*.npy`, or `*.npz` as extra app layers.
  They are build fragments, validation evidence and reusable intermediate data.

## Rebuild and validation

Use only `/Volumes/CodexWork/Projects/MOONDA/.venv-data/bin/python -I`.
Run `features/scripts/download_psr.py` if the complete replacement TIFF is missing,
then `build_craters.py`, `build_psr.py`, `build_waterice.py`,
`build_danger.py`, `assemble.py`, `check.py`, `previews.py`, then `assemble.py` again.
Every script resolves its paths from its own location and writes below this folder.
No external application files are changed. No downloaded code is run.

`check-report.json` records sizes, dimensions, class histograms, coordinate checks,
native-source spot checks and overlap with the app's older shadow map.
The 1024 square previews use a derived hillshade and labelled 85 S / 88 S circles.
Hillshade is an artificial light for reading terrain, not actual sunlight.

## Delivery files

| File | Bytes | MD5 |
| --- | ---: | --- |
'''
    table='\n'.join(f"| `{r['file']}` | {r['bytes']:,} | `{r['md5']}` |" for r in inventory)
    parts=[header+table]
    report=OUT/'check-report.json'
    if report.exists():
        r=json.loads(report.read_text())
        parts.append('## Final checks\n\n'+('PASS' if r['passed'] else 'FAILED: '+str(r['problems']))+
                     '\n\nPSR majority-shadow agreement with old ice.bin: '+
                     f"{r['psrAgreement']['agreementPercent']:.3f}%; PSR intersection-over-union " +
                     f"{r['psrAgreement']['intersectionOverUnionPercent']:.3f}%. " +
                     'Agreement includes the large unshadowed area, so IoU is also reported.\n\n'+
                     'Class coverage uses each layer\'s valid cells inside 80 S, not the full square. '
                     'Water ice preserves 264 cells with missing source temperatures.\n\n```json\n'+
                     json.dumps(r['histograms'],indent=2)+'\n```\n')
    for lid in ['craters','psr','waterice','danger']:
        parts.append((ROOT/f'features/{lid}-NOTES.md').read_text())
    (ROOT/'features/NOTES.md').write_text('\n\n---\n\n'.join(parts)+'\n')
    print('Delivery files:',len(inventory), 'total bytes:',sum(r['bytes'] for r in inventory))
    for r in inventory:
        print(f"{r['file']}: {r['bytes']:,} bytes")
    if report.exists():
        r=json.loads(report.read_text())
        print('CHECK:', 'PASS' if r['passed'] else 'FAIL', r['problems'])
        print('Water ice valid-cell coverage:', ', '.join(f"class{k}={v['percent']:.3f}%" for k,v in r['histograms']['waterice'].items()))
        print('Danger valid-cell coverage:', ', '.join(f"class{k}={v['percent']:.3f}%" for k,v in r['histograms']['danger'].items()))
        print('PSR agreement: %.3f%%; PSR IoU: %.3f%%' % (r['psrAgreement']['agreementPercent'],r['psrAgreement']['intersectionOverUnionPercent']))
        print('Claude: crater BINs are Float32 triples; other BINs are Uint16 rasters. PNGs are4096. Waterice class3 is empty; use evidence markers separately. See features/NOTES.md.')


if __name__=='__main__':
    main()
