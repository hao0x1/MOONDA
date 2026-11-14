#!/usr/bin/env python3
"""Check concrete URLs in the deliverables; save only a JSON status log."""
import concurrent.futures
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FILES = [
    'sites/sites.json', 'sites/artemis-regions.geojson', 'sites/NOTES.md',
    'sites/unpinned-plans.json', 'quickmap/quickmap.json', 'quickmap/NOTES.md',
    'libs/libs.md', 'libs/npm-metadata.json',
]


def collect():
    urls = {}
    for name in FILES:
        path = ROOT / name
        if not path.exists():
            continue
        for url in re.findall(r'https?://[^\s<>"\]\)]+', path.read_text()):
            url = url.rstrip('.,;')
            if any(c in url for c in '{}'):
                continue  # Templates have concrete tests in quickmap.json.
            urls.setdefault(url, []).append(name)
    return urls


def check(url):
    start = time.monotonic()
    try:
        request = urllib.request.Request(url, headers={'User-Agent': 'MOONDA-research-URL-check/1.0'})
        with urllib.request.urlopen(request, timeout=30) as response:
            result = {'url': url, 'status': response.status, 'finalUrl': response.url,
                      'contentType': response.headers.get('Content-Type', 'unknown')}
            # Closing immediately avoids saving a page, tarball, or executable.
    except urllib.error.HTTPError as exc:
        result = {'url': url, 'status': exc.code, 'error': str(exc)}
    except Exception as exc:
        result = {'url': url, 'status': None, 'error': str(exc)}
    result['seconds'] = round(time.monotonic() - start, 2)
    return result


def main():
    urls = collect()
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        checks = list(pool.map(check, sorted(urls)))
    for row in checks:
        row['files'] = sorted(set(urls[row['url']]))
    result = {'checkedOn': '2026-11-14',
              'method': 'HTTP GET headers and redirect chain only; bodies not saved or executed',
              'checks': checks}
    (ROOT / 'url-checks.json').write_text(json.dumps(result, indent=2) + '\n')
    failed = [c for c in checks if c['status'] is None or not 200 <= c['status'] < 300]
    print(json.dumps({'checked': len(checks), 'failed': failed}, indent=2))


if __name__ == '__main__':
    main()
