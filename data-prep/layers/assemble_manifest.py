"""Join the rerunnable map builders into the app manifest, retaining planner grids.

Run with python -I after build_global_terrain.py and build_polar_water.py.
The source products and their limits are recorded in NOTES.md.
"""
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'app/public/data/layers'
manifest = json.loads((OUT / 'manifest.json').read_text())
entries = {e['id']: e for e in manifest}
polar = json.loads((Path(__file__).parent / 'polar-products.json').read_text())


def raster(s):
    keep = ('url', 'projection', 'pole', 'extentM', 'clipTrueLatDeg',
            'maximumTrueLatDeg', 'encoding', 'palette', 'replace')
    result = {k: v for k, v in s.items() if k in keep}
    if result['projection'] == 'geographic':
        result['projection'] = 'global'
    if result.get('pole') == 'south':
        result['clipTrueLatDeg'] = -abs(result.get('clipTrueLatDeg', 80))
    return result


def values(s):
    result = raster(s['values'])
    result.update({k: s['values'][k] for k in ('width', 'height', 'scale', 'offset')})
    result.update(format='png-u8', noData=s['values'].get('nodata', 255))
    return result


entries['psr']['rasterSources'] = [raster(s) for s in polar['psr']]
entries['psr']['valueSources'] = [values(s) for s in polar['psr'] if s['values'].get('encoding') == 'gray8']
entries['psr']['coverage'] = 'Near both poles'
entries['psr']['source'].update(name='NASA LOLA permanent-shadow models, both poles; adjusted 20 m south-pole map', url='https://pgda.gsfc.nasa.gov/products/69')
entries['psr']['notes'] = ('LOLA permanent-shadow models poleward of 65 degrees at both poles. '
    'The north uses 240 m data, 120 m above 80 N and 60 m above 85 N. '
    'The south keeps its 20 m source in the same 4096-pixel picture, with 240 m coverage out to 65 S. '
    'Shadow is not a detection of ice.')

water = [polar['hydrogen'], polar['watericeSouth']]
if 'watericeNorth' in polar:
    water.append(polar['watericeNorth'])
entries['waterice']['rasterSources'] = [raster(s) for s in water]
hydrogen_value = values(polar['hydrogen'])
hydrogen_value.update(presenceClass=3, minimumCode=50)
entries['waterice']['valueSources'] = [hydrogen_value, *[values(s) for s in water[1:]]]
entries['waterice']['coverage'] = 'Polar predictions; hydrogen across the Moon'
entries['waterice']['source'].update(name='NASA Diviner / LOLA cold-trap predictions; Lunar Prospector orbital hydrogen; crater-specific instrument evidence', url='https://pds-geosciences.wustl.edu/missions/lunarp/reduced_special.html')
entries['waterice']['shortHelp'] = 'Purple shows hydrogen seen from orbit, not proven ice. Blue and cyan predict where ice could last. Only the white LCROSS ring marks water measured on the spot.'
entries['waterice']['notes'] = ('Purple is Lunar Prospector neutron-spectrometer hydrogen, in 0.5-degree bins with a much broader footprint; '
    'hydrogen can have causes other than ice. The spot value flags estimates of at least 100 ppm only as orbital signs, not ice. '
    'That threshold is a display choice. Blue and cyan are Diviner/LOLA cold-trap predictions, not detections. '
    'Only LCROSS measured water on the spot. Radar markers are candidates and can also be explained by rough ground.')

terrain_path = OUT / 'global-terrain.json'
if terrain_path.exists():
    terrain = json.loads(terrain_path.read_text())
    for name in ('slope', 'danger'):
        s = terrain[name]
        source = {'url': './data/layers/' + s['url'], 'projection': 'global', 'encoding': 'gray8', 'palette': s['palette']}
        south = {'url': f'./data/layers/{name}.png', 'projection': 'polar', 'pole': 'south', 'extentM': 304000, 'clipTrueLatDeg': -80.02, 'replace': True}
        packed_path = OUT / 'south-terrain.json'
        if packed_path.exists():
            packed = json.loads(packed_path.read_text()).get('products', {}).get(name)
            if packed:
                south = raster(packed)
        entries[name]['rasterSources'] = [source, south]
        entries[name]['valueSources'] = [{**source, 'format': 'png-u8', 'width': 8192, 'height': 4096, 'scale': s['scale'], 'offset': s.get('offset', 0), 'noData': s.get('nodata', 255)}]
        entries[name].pop('coverage', None)
        entries[name]['source'].update(name='NASA LOLA LDEM_64 global heights and LDEM_80S_80M south-pole heights', url=terrain['source']['url'])
        entries[name]['shortHelp'] = ('Slopes across the Moon, over about 1.4 km of ground; the south-pole map uses about 240 m.' if name == 'slope' else 'Slope classes and measured small crater bowls across the Moon, with sharper data south of 80 degrees S.')
        entries[name]['notes'] = ('Global slopes use NASA LOLA LDEM_64 heights and a local 3 by 3 ground stencil, about 1.42 km across. '
            'The south-pole map keeps the 80 m heights and about 240 m stencil. The 8192 by 4096 map is a resampling, not new detail. '
            'Small rocks and many driving hazards are unresolved.' + (' Colours mark 10 to 15, 15 to 25 and over 25 degrees, plus measured small crater bowls.' if name == 'danger' else ''))

compact_path = OUT / 'compact-sources.json'
if compact_path.exists():
    compact = json.loads(compact_path.read_text())
    # Height keeps its original colours, but no longer needs an RGBA image in memory.
    entries['height']['rasterSources'] = [{'url': './data/layers/height.png', 'projection': 'polar', 'pole': 'south', 'extentM': 304000, 'clipTrueLatDeg': -80.02}]
    for entry in manifest:
        for field in ('rasterSources', 'valueSources'):
            for source in entry.get(field, []):
                extra = compact.get(source['url'])
                if extra:
                    source.update(extra)

(OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + '\n')
print('Updated layer sources; existing .bin grids were not changed.')
