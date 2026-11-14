"""Add cited north-polar ice-evidence markers without making up ice pixels.

Run from the repository root: .venv-data/bin/python -I data-prep/sites/build_ice_sites.py
Then run make_sites_ts.py with the same interpreter and -I.
The original south-pole evidence list stays read-only in data-prep/features.
"""
import json
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
BASE = ROOT / 'data-prep/features/ice-sites.json'
NAMES = ROOT / 'app/public/data/names.json'


def evidence(instrument, finding, citation, url):
    return dict(instrument=instrument, finding=finding, citation=citation, url=url)


def main():
    markers = json.loads(BASE.read_text())
    names = {r[0]: r for r in json.loads(NAMES.read_text())['rows']}
    # Only this impact measured water on the spot. The crater's centre is not the impact site.
    impact = next(s for s in json.loads((HERE / 'sites.json').read_text()) if s['id'] == 'lcross-centaur')
    cabeus = next(s for s in markers if s['id'] == 'ice-cabeus')
    cabeus.update(lat=impact['lat'], lon=impact['lon'])
    cabeus['positionNote'] = 'Marker at the LCROSS Centaur impact, not the crater centre; the diameter describes Cabeus.'
    north = [
        ('Peary', 'detected', 'Radar signs seen from orbit; ice is possible, not measured here.', [
            evidence('Chandrayaan-2 Dual-frequency Synthetic Aperture Radar (DFSAR)',
                     'Radar found unusual signals in small craters inside Peary that may come from buried ice. Rough ground also changes radar signals; no water was measured on the spot, and this is not a claim about the whole crater.',
                     'ISRO (2020). Chandrayaan-2 completes a year around the Moon, pp. 9–10, Figure 9. See also Bussey, D.B.J., Spudis, P.D., and the Mini-RF Team (2011). New insights into lunar processes and history from global mapping by Mini-RF radar. LPSC 42, abstract 2086.',
                     'https://www.isro.gov.in/media_isro/pdf/chandrayaan-2_completes_a_year_around_the_moon_.pdf'),
            evidence('LRO Mini-RF and Chandrayaan-1 Mini-SAR',
                     'The Mini-RF team described radar signals consistent with possible ice in permanently shaded small craters inside Peary. These are orbital signs with more than one possible cause.',
                     'Bussey, D.B.J., Spudis, P.D., and the Mini-RF Team (2011). New insights into lunar processes and history from global mapping by Mini-RF radar. LPSC 42, abstract 2086.',
                     'https://www.lpi.usra.edu/meetings/lpsc2011/pdf/2086.pdf'),
        ]),
        ('Rozhdestvenskiy', 'detected', 'Radar signs seen from orbit; ice is possible, not measured here.', [
            evidence('LRO Mini-RF and Chandrayaan-1 Mini-SAR',
                     'Radar found unusual signals in small craters inside Rozhdestvenskiy that may come from buried ice. Rough ground can give similar signals; no water was measured on the spot, and this is not a claim about the whole crater.',
                     'NASA/GSFC/JHUAPL. Mini RF Rozhdestvenskiy. Bussey, D.B.J., Spudis, P.D., and the Mini-RF Team (2011). New insights into lunar processes and history from global mapping by Mini-RF radar. LPSC 42, abstract 2086. Spudis et al. (2010), GRL 37, L06204, doi:10.1029/2009GL042259.',
                     'https://science.nasa.gov/image-detail/rozhdestvenskiy-x-main-context-580/'),
            evidence('Radar interpretation limits',
                     'A high radar polarisation ratio can come from rough rock or from ice. The instrument does not directly measure water in the ground.',
                     'NASA (2010). NASA Radar Finds Ice Deposits at Moon’s North Pole, 2 March 2010; the article explains that circular polarisation ratio is not uniquely diagnostic of roughness or ice.',
                     'https://science.nasa.gov/missions/mini-rf/nasa-radar-finds-ice-deposits-at-moons-north-pole/'),
        ]),
        ('Hermite', 'detected', 'Radar signs seen from orbit; ice is possible, not measured here.', [
            evidence('LRO Mini-RF imaging radar',
                     'Mini-RF reported unusual radar signals in small craters on Hermite’s floor. A scattering model favours possible buried ice, but roughness can affect the signal; no water was measured on the spot.',
                     'Spudis, P.D., et al. (2013). Evidence for water ice on the Moon: Results for anomalous polar craters from the LRO Mini-RF imaging radar. JGR Planets 118, 2016–2029, Table 3 and Figure 7. doi:10.1002/jgre.20156.',
                     'https://ntrs.nasa.gov/api/citations/20150000268/downloads/20150000268.pdf'),
            evidence('LRO Diviner temperature measurements and LOLA shadow models',
                     'Diviner measured very cold ground in Hermite, and LOLA models show lasting shadow in part of its south-western floor. Cold and shadow allow possible ice storage; they do not measure water.',
                     'NASA/GSFC/JHUAPL. Hermite Crater; Diviner temperature observations and LOLA long-term illumination modelling. See also NASA LRO, Taking the Moon’s Temperature.',
                     'https://science.nasa.gov/image-detail/hermite/'),
        ]),
        ('Erlanger', 'detected', 'Radar signs seen from orbit; ice is possible, not measured here.', [
            evidence('LRO Mini-RF imaging radar',
                     'Mini-RF reported unusual radar signals inside Erlanger. A scattering model favours possible buried ice, but roughness can affect the signal; no water was measured on the spot.',
                     'Spudis, P.D., et al. (2013). Evidence for water ice on the Moon: Results for anomalous polar craters from the LRO Mini-RF imaging radar. JGR Planets 118, 2016–2029, Table 3. doi:10.1002/jgre.20156.',
                     'https://ntrs.nasa.gov/api/citations/20150000268/downloads/20150000268.pdf'),
            evidence('LRO Narrow Angle Camera (LROC NAC)',
                     'LROC shows that much of Erlanger’s floor stays in permanent shadow. Shadow can help ice last in suitable cold patches; the photograph alone is not an ice detection.',
                     'NASA/GSFC/Arizona State University (2009). Eternal Darkness Near the North Pole, PIA12899. LROC Permanently Shadowed Regions Atlas, Erlanger entry NP_869610_0287570.',
                     'https://science.nasa.gov/photojournal/eternal-darkness-near-the-north-pole/'),
        ]),
        ('Bosch', 'predicted', 'Cold ground could keep ice; this marker is a prediction.', [
            evidence('LRO Diviner temperature measurements',
                     'NASA lists Bosch among the very cold northern craters that could trap water ice. This is a prediction from cold conditions, not a measurement of water at this crater.',
                     'Borowski, S.K., et al. (2018). Robust Exploration and Commercial Missions to the Moon Using Nuclear Thermal Rocket Propulsion and In Situ Propellants Derived from Lunar Polar Ice Deposits. NASA/TM—2018-219937, p. 7 and Figure 4(b).',
                     'https://ntrs.nasa.gov/api/citations/20180008495/downloads/20180008495.pdf'),
        ]),
    ]
    for name, status, short, ev in north:
        row = names[name]
        markers.append(dict(id='ice-' + name.lower(), name=name, lat=row[3], lon=row[4], diameterKm=row[2],
                            status=status, short=short, evidence=ev,
                            positionSource=f'https://planetarynames.wr.usgs.gov/Feature/{row[6]}',
                            positionNote='Marker at the named crater centre for context, not at every possible deposit.'))
    ids = [s['id'] for s in markers]
    assert len(ids) == len(set(ids)), 'Duplicate marker ID'
    assert [s['id'] for s in markers if s['status'] == 'confirmed'] == ['ice-cabeus']
    for marker in markers:
        assert marker['status'] in ('confirmed', 'detected', 'predicted')
        assert -90 <= marker['lat'] <= 90 and -180 <= marker['lon'] <= 180
        assert marker['evidence']
        for ev in marker['evidence']:
            u = urlsplit(ev['url'])
            assert u.scheme == 'https' and not any(k.startswith('utm_') for k in parse_qs(u.query))
    content = json.dumps(markers, indent=2, ensure_ascii=False) + '\n'
    (HERE / 'ice-sites.json').write_text(content)
    (ROOT / 'app/public/data/features/ice-sites.json').write_text(content)
    print(f'{len(markers)} ice markers: one measured on the spot; {len(north)} northern additions')


if __name__ == '__main__':
    main()
