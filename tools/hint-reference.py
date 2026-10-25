"""Python reference of the key-pattern "X 苦手要小心" hint rule (web proposal r1, 2026-10-23), written independently of
docs/js/ui-lib.js patternHints, on the 442 charts of the key-pattern items reference (the one tests/compare_items.mjs uses).

    python tools/hint-reference.py <research repository root> [--ref web-items-r2]
        reads  <root>/data/<ref>/reference-items.json   (read only; default web-items-r2 = the route-A items plus luan_s / qie_s)
        writes tests/fixtures/reference-hints.json

Rule (research repo data/loss-share-hint-r1/RESULTS.md; thresholds and the jack star range decided by the user 2026-10-23):
  * the share read per direction is the loss share s of the item HINT_ITEM names (route A: jack, speed = the 乱/切 total, ln);
    keep it equal to HINT_ITEM in docs/js/ui-lib.js;
  * pct = s rounded to an integer percent, as the result card shows it (JS Math.round = floor(x + 0.5));
  * hint when pct >= threshold: jack 45, speed 90, long notes (ln) 30;
  * jack only: when the total star shown on the card (two decimals) is within [3, 7] inclusive, delta = round(0.722 * pct / 10) / 10
    stars ("in"); above 7 -> "above", below 3 -> "below", no number.
"""
import argparse
import json
import math
from pathlib import Path

THRESHOLDS = {'jack': 45, 'speed': 90, 'ln': 30}
HINT_ITEM = {'jack': 'jack', 'speed': 'speed', 'ln': 'ln'}
JACK_K = 0.722
JACK_STAR = (3.0, 7.0)


def js_round(x):
    return math.floor(x + 0.5)


def shares(items):
    return {key: (items.get(HINT_ITEM[key]) or {}).get('s') for key in THRESHOLDS}


def hints(s_by_key, star):
    out = []
    for key in ('jack', 'speed', 'ln'):
        s = s_by_key.get(key)
        if s is None or not math.isfinite(s):
            continue
        pct = js_round(s * 100)
        if pct < THRESHOLDS[key]:
            continue
        h = {'key': key, 'pct': pct, 'delta': None, 'range': None}
        if key == 'jack':
            shown = float(f'{star:.2f}')
            if JACK_STAR[0] <= shown <= JACK_STAR[1]:
                h['range'] = 'in'
                h['delta'] = js_round(JACK_K * pct / 10) / 10
            elif shown > JACK_STAR[1]:
                h['range'] = 'above'
            else:
                h['range'] = 'below'
        out.append(h)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('root')
    ap.add_argument('--ref', default='web-items-r2')
    a = ap.parse_args()
    src = Path(a.root) / 'data' / a.ref / 'reference-items.json'
    ref = json.loads(src.read_text(encoding='utf-8'))
    charts = []
    for c in ref['charts']:
        s = shares(c['items'])
        charts.append({'i': c['i'], 'source': c['source'], 'member': c['member'], 'star': c['star'], 's': s, 'hints': hints(s, c['star'])})
    n = {k: sum(any(h['key'] == k for h in c['hints']) for c in charts) for k in THRESHOLDS}
    n['jack_with_number'] = sum(any(h['key'] == 'jack' and h['delta'] is not None for h in c['hints']) for c in charts)
    out = {'info': {'source': f'research repo data/{a.ref}/reference-items.json (Python items of tests/compare_items.mjs)',
                    'generator': 'tools/hint-reference.py',
                    'rule': {'thresholds_pct': THRESHOLDS, 'jack_k': JACK_K, 'jack_star': list(JACK_STAR), 'item': HINT_ITEM},
                    'charts': len(charts), 'charts_with_hint': n},
           'charts': charts}
    dst = Path(__file__).resolve().parents[1] / 'tests' / 'fixtures' / 'reference-hints.json'
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps(out['info'], ensure_ascii=False))


if __name__ == '__main__':
    main()
