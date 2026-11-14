#!/usr/bin/env python3
"""Validate MOONDA research artifacts without changing the application."""
import datetime as dt
import json
import math
import re
from collections import Counter
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
TODAY = dt.date(2026, 11, 14)
REQUIRED = {
    'id', 'name', 'status', 'kind', 'operator', 'country', 'date', 'lat', 'lon',
    'precisionKm', 'outcome', 'short', 'detail', 'source', 'coordSource',
    'inQuickMap', 'verify',
}


def nonempty(value, path='root'):
    if isinstance(value, str):
        assert value.strip(), f'Empty string: {path}'
    elif isinstance(value, dict):
        for k, v in value.items():
            nonempty(v, f'{path}.{k}')
    elif isinstance(value, list):
        for i, v in enumerate(value):
            nonempty(v, f'{path}[{i}]')


def validate_sites():
    sites = json.loads((ROOT / 'sites/sites.json').read_text())
    assert isinstance(sites, list) and sites
    assert len({s['id'] for s in sites}) == len(sites), 'Duplicate IDs'
    for s in sites:
        sid = s['id']
        assert REQUIRED <= s.keys(), (sid, REQUIRED - s.keys())
        assert re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', sid), sid
        assert s['status'] in {'past', 'active', 'planned'}, sid
        assert s['kind'] in {'crewed', 'lander', 'rover', 'sample-return', 'impact', 'region'}, sid
        assert s['outcome'] in {'success', 'partial', 'failed', 'planned'}, sid
        assert type(s['lat']) in (int, float) and math.isfinite(s['lat']) and -90 <= s['lat'] <= 90, sid
        assert type(s['lon']) in (int, float) and math.isfinite(s['lon']) and -180 <= s['lon'] <= 180, sid
        assert s['precisionKm'] > 0 and math.isfinite(s['precisionKm']), sid
        assert len(s['short']) <= 90, (sid, len(s['short']))
        assert type(s['verify']) is bool and type(s['inQuickMap']) is bool, sid
        if s['verify']:
            assert s.get('note', '').strip(), f'{sid}: verify requires an explanation'
        if s['status'] == 'planned':
            assert s['outcome'] == 'planned', sid
            assert re.fullmatch(r'\d{4}(?:-\d{2})?', s['date']), sid
            if len(s['date']) == 7:
                dt.date.fromisoformat(s['date'] + '-01')
        else:
            assert s['outcome'] != 'planned', sid
            date = dt.date.fromisoformat(s['date'])
            assert date <= TODAY, sid
        for key in ('source', 'coordSource'):
            assert s[key].get('name') and s[key].get('url'), (sid, key)
            u = urlsplit(s[key]['url'])
            assert u.scheme == 'https' and u.netloc, (sid, key)
            assert not any(k.lower().startswith('utm_') or k.lower() in {'fbclid', 'gclid', 'trk', 'mc_cid', 'mc_eid', 'linkid'} for k in parse_qs(u.query)), (sid, key, 'tracking')
        nonempty(s, sid)
    return sites


def validate_regions():
    data = json.loads((ROOT / 'sites/artemis-regions.geojson').read_text())
    assert data['type'] == 'FeatureCollection' and len(data['features']) == 9
    assert len({f['properties']['name'] for f in data['features']}) == 9
    for f in data['features']:
        assert f['geometry']['type'] == 'Polygon'
        for ring in f['geometry']['coordinates']:
            assert 4 <= len(ring) <= 40 and ring[0] == ring[-1]
            for lon, lat in ring:
                assert -180 <= lon <= 180 and -90 <= lat <= 90
        nonempty(f)


def main():
    sites = validate_sites()
    validate_regions()
    quickmap = json.loads((ROOT / 'quickmap/quickmap.json').read_text())
    assert {'home', 'linkTemplate', 'linkNotes', 'layers', 'psrLayers', 'craterLayers', 'siteLayers', 'credit'} <= quickmap.keys()
    assert set('3314 3122 2868 3928 2867 3570 3489 3927 3998 4034'.split()) <= quickmap['layers'].keys()
    nonempty(quickmap, 'quickmap')
    assert (ROOT / 'libs/libs.md').stat().st_size > 1000
    print(json.dumps({'result': 'PASS', 'sites': len(sites), 'status': dict(Counter(s['status'] for s in sites)), 'verify': [s['id'] for s in sites if s['verify']], 'artemisPolygons': 9}, indent=2))


if __name__ == '__main__':
    main()
