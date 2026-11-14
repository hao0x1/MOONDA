#!/usr/bin/env python3
"""Merge independently researched subsets into the app handoff array."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
parts = ['historical-sites.json', 'recent-sites.json', 'planned-sites.json', 'artemis-sites.json']
sites = []
for part in parts:
    sites.extend(json.loads((ROOT / 'sites' / part).read_text()))
for site in sites:
    site['precisionKm'] = round(site['precisionKm'], 8)
    if site['id'] == 'change-5-t1-rocket-impact':
        site['name'] = 'Rocket-stage impact (2022)'
        site['outcome'] = 'failed'
        site['operator'] = 'CNSA (catalogue attribution)'
        site['note'] = ('The supplied LROC catalogue attributes the rocket to Chang\'e-5-T1; '
                        'the linked LROC image article calls it a mystery rocket. '
                        'The crater location and date are confirmed. Outcome failed describes '
                        'the unplanned surface collision, not the earlier launch mission.')
    if site['id'] == 'chandrayaan-1-mip':
        site['short'] = "India's first Moon impact probe, likely near a south-pole ridge"
sites.sort(key=lambda s: ({'active': 0, 'past': 1, 'planned': 2}[s['status']], s['date'], s['id']))
assert len({s['id'] for s in sites}) == len(sites), 'Duplicate site IDs'
(ROOT / 'sites/sites.json').write_text(json.dumps(sites, indent=2, ensure_ascii=False) + '\n')
print(f'Wrote {len(sites)} sites')
