#!/usr/bin/env python3
"""Repack the pinned tldraw faces for the ink parser; not a build dependency.

Run from the repo root after bun install, with Python fonttools and brotli.
The IBM copies use distinct names under the SIL OFL reserved-name condition.
"""
import hashlib
import json
from pathlib import Path

from fontTools.ttLib import TTFont

root = Path(__file__).resolve().parent.parent
package = root / 'apps/web/node_modules/@tldraw/assets'
if json.loads((package / 'package.json').read_text())['version'] != '5.6.1':
    raise SystemExit('Review the font faces and update provenance for the new SDK first.')

out = root / 'apps/web/static/fonts/projection'
styles = {
    '': ('Medium', 'Regular'),
    'Italic': ('MediumItalic', 'Regular_Italic'),
    'Bold': ('Bold', 'Bold'),
    'BoldItalic': ('BoldItalic', 'Bold_Italic'),
}


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_tables(source, output):
    input_font = TTFont(source, recalcTimestamp=False)
    output_font = TTFont(output, recalcTimestamp=False)
    assert input_font.keys() == output_font.keys()
    assert input_font.getGlyphOrder() == output_font.getGlyphOrder()
    for table in input_font.keys():
        if table not in ('GlyphOrder', 'head', 'name'):
            assert input_font.getTableData(table) == output_font.getTableData(table), table


rows = []
for family in ('Draw', 'Sans', 'Serif', 'Mono'):
    for style, (plex_style, shantell_style) in styles.items():
        if family == 'Draw':
            source = package / f'fonts/Shantell_Sans-Informal_{shantell_style}.woff2'
            if not style:
                # Our pre-existing uncompressed normal draw face is already
                # served on the critical warm-edit path. Verify its contours
                # and advances against the pinned SDK without replacing it.
                output = out.parent / 'ShantellSans.ttf'
                a, b = TTFont(source), TTFont(output)
                assert a['hmtx'].metrics == b['hmtx'].metrics
                assert a.getBestCmap() == b.getBestCmap()
                for glyph in a.getGlyphOrder():
                    assert a['glyf'][glyph] == b['glyf'][glyph], glyph
                rows.append((source.name, '../' + output.name, sha256(source), sha256(output)))
                continue
        else:
            source = package / f'fonts/IBMPlex{family}-{plex_style}.woff2'

        font = TTFont(source, recalcTimestamp=False)
        name = f'Weft Overlay {family}'
        style_name = {'': 'Regular', 'BoldItalic': 'Bold Italic'}.get(style, style)
        fullname = name + (' ' + style_name if style else '')
        new_names = {
            1: name, 2: style_name, 3: f'{fullname} 1.0', 4: fullname,
            6: fullname.replace(' ', ''), 16: name, 17: style_name,
        }
        for entry in font['name'].names:
            if entry.nameID in new_names:
                entry.string = new_names[entry.nameID]
        font.flavor = 'woff'
        output = out / f'WeftOverlay{family}{style}.woff'
        font.save(output)
        verify_tables(source, output)
        rows.append((source.name, output.name, sha256(source), sha256(output)))

with (out / 'checksums.tsv').open('w') as manifest:
    manifest.write('sdk-asset\tprojection-asset\tsdk-sha256\tprojection-sha256\n')
    for row in rows:
        manifest.write('\t'.join(row) + '\n')
