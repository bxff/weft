# Projection faces

Weft projects tldraw labels as ink. These faces give the ink parser the same
normal, bold, italic, and bold italic outlines that the browser uses for
Draw, Sans, Serif, and Mono. The browser normally loads the SDK's smaller
original WOFF2s. When a browser face has not loaded, Weft can recover with
the exact same bytes it uses for projection.

These copies use WOFF1 because opentype.js cannot read WOFF2. The derived
faces have different names, including for IBM's reserved font name “Plex”.
The pre-existing `../ShantellSans.ttf` remains the Draw normal face.

Sources: `@tldraw/assets@5.6.1`. IBM Plex is copyright © 2017 IBM Corp.
with Reserved Font Name “Plex”; the source faces also contain the embedded
notice “Copyright 2018 IBM Corp. All rights reserved.” Shantell Sans is
copyright 2022 The Shantell Sans Project Authors. See the
[IBM Plex](../../licenses/ibm-plex.txt) and
[Shantell Sans](../../licenses/shantell-sans.txt) SIL OFL notices.

Regenerate with `scripts/generate-projection-fonts.py` after installing the
pinned dependencies. It checks glyph, mapping and metric equivalence.
[Checksums](./checksums.tsv) identify each input and output asset exactly.
