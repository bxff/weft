#!/usr/bin/env python3
"""Repack the pinned tldraw IBM faces for the ink parser; not a build dependency.

Run from the repo root after bun install, with Python fonttools and brotli.
The output uses distinct names under IBM's SIL OFL reserved-name condition.
"""
import json
from pathlib import Path

from fontTools.ttLib import TTFont

root = Path(__file__).resolve().parent.parent
package = root / 'apps/web/node_modules/@tldraw/assets'
if json.loads((package / 'package.json').read_text())['version'] != '5.6.1':
    raise SystemExit('Review the normal font faces and update the provenance for the new SDK first.')

out = root / 'apps/web/static/fonts/projection'
for style in ('Sans', 'Serif', 'Mono'):
    source = package / f'fonts/IBMPlex{style}-Medium.woff2'
    font = TTFont(source, recalcTimestamp=False)
    family = f'Weft Overlay {style}'
    new_names = {
        1: family, 2: 'Regular', 3: f'{family} 1.0', 4: family,
        6: family.replace(' ', ''), 16: family, 17: 'Regular',
    }
    for entry in font['name'].names:
        if entry.nameID in new_names:
            entry.string = new_names[entry.nameID]
    font.flavor = 'woff'
    font.save(out / (family.replace(' ', '') + '.woff'))
