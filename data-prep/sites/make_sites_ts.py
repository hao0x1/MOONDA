"""Turn the researched site list and ice-evidence list into app/src/data/sites.ts.
Run build_ice_sites.py first, then: .venv-data/bin/python -I data-prep/sites/make_sites_ts.py
"""
import json, os
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sites = json.load(open(os.path.join(ROOT, 'data-prep/sites/sites.json')))
ice = json.load(open(os.path.join(ROOT, 'data-prep/sites/ice-sites.json')))
MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
# ids the app already used (their Khmer texts are keyed by them)
OLD = {'chandrayaan-3': 'm-chandrayaan3', 'im-1-odysseus': 'm-im1', 'im-2-athena': 'm-im2', 'lcross-centaur': 'm-lcross', 'change-4-yutu-2': 'm-change4',
       'change-6': 'm-change6', 'slim': 'm-slim', 'blue-ghost-mission-1': 'm-blueghost', 'apollo-11': 'm-apollo11', 'apollo-12': 'm-apollo12',
       'apollo-14': 'm-apollo14', 'apollo-15': 'm-apollo15', 'apollo-16': 'm-apollo16', 'apollo-17': 'm-apollo17'}
# hardware whose makers last reported it working, with no later word either way (NOTES.md): shown as "may still be working"
MAYBE_ACTIVE = {'change-3', 'change-4-yutu-2'}

def date(d):
    p = str(d).split('-')
    if len(p) == 3: return f"{int(p[2])} {MONTHS[int(p[1]) - 1]} {p[0]}"
    if len(p) == 2: return f"{MONTHS[int(p[1]) - 1]} {p[0]}"
    return p[0]

out = []
for s in sites:
    if s['id'].startswith('artemis-'): continue  # the app keeps its own nine example points inside NASA's regions
    kind = 'planned' if s['status'] == 'planned' else 'active' if s['id'] in MAYBE_ACTIVE else 'mission'
    e = {'id': OLD.get(s['id'], s['id']), 'kind': kind, 'name': s['name'], 'lat': round(s['lat'], 5), 'lon': round(s['lon'], 5), 'short': s['short'].rstrip('.'),
         'detail': s['detail'], 'date': date(s['date']), 'source': s['source'], 'what': s['kind'], 'operator': s['operator'], 'outcome': s['outcome'], 'precisionKm': s['precisionKm']}
    if s.get('verify'): e['verify'] = True
    if s.get('note'): e['note'] = s['note']
    out.append(e)
for s in ice:
    ev = s['evidence']
    e = {'id': 'ice-' + s['id'], 'kind': 'ice', 'name': s['name'], 'lat': round(s['lat'], 5), 'lon': round(s['lon'], 5), 'short': s['short'].rstrip('.'),
         'detail': ' '.join(x['finding'] for x in ev), 'source': {'name': ev[0]['citation'], 'url': ev[0]['url']}, 'ice': s['status'],
         'evidence': [{'instrument': x['instrument'], 'finding': x['finding'], 'citation': x['citation'], 'url': x['url']} for x in ev]}
    if s.get('diameterKm'): e['diameterKm'] = s['diameterKm']
    out.append(e)

head = '''// Landing sites, impact sites, planned landings and places with signs of water ice.
// MADE BY data-prep/sites/make_sites_ts.py from data-prep/sites/sites.json (researched on 14 Nov 2026 from NASA, LROC,
// ISRO, JAXA, CNSA and the lander companies' own pages; see data-prep/sites/NOTES.md) and data-prep/sites/ice-sites.json
// (see data-prep/sites/ICE-NOTES.md). Do not edit by hand: change the source and run the scripts again.
//
//   mission   finished: landers, rovers, sample returns and impact sites
//   active    last reported working by its makers, with no later word either way (shown as "may still be working")
//   planned   announced landings with a published target place; the marker is a region centre, not a touchdown point,
//             and the year is the earliest announced, not a confirmed landing date
//   ice       craters with evidence about water ice: 'confirmed' = water measured there (LCROSS at Cabeus), 'detected' =
//             an instrument in orbit reported signs of possible ice, 'predicted' = possible ice storage from cold/shadow evidence
import type { Place } from './places';

export const SITES: Place[] = '''
path = os.path.join(ROOT, 'app/src/data/sites.ts')
open(path, 'w').write(head + json.dumps(out, indent=1, ensure_ascii=False) + ';\n')
from collections import Counter
print(len(out), Counter(e['kind'] for e in out), os.path.getsize(path))
