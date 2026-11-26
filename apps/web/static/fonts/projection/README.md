# Projection faces

These faces provide outlines for synthesizing reMarkable ink from ordinary
(non-bold, non-italic) tldraw labels. The browser still uses the original SDK
WOFF2 fonts. These copies change the container to WOFF1 for opentype.js and
rename the derived faces as required for IBM's reserved font name “Plex”.
All glyph outline, character mapping, advance, shaping, and hint tables were
verified byte-for-byte against the SDK files.

Source: `@tldraw/assets@5.6.1` as pinned by the web app. Copyright © 2017 IBM
Corp. with Reserved Font Name “Plex”; the source faces also contain the
embedded notice “Copyright 2018 IBM Corp. All rights reserved.” These files
are distributed under the [IBM Plex SIL OFL notice](../../licenses/ibm-plex.txt).

Regenerate with `scripts/generate-projection-fonts.py` after installing the
pinned dependencies. SHA-256 of the source then projected copy:

| Family | SDK WOFF2 | Projection WOFF |
| --- | --- | --- |
| Sans | `5660f8a658f8bb50dbc005232f885eadffd2bc1c235c4f6fbb63469d1f9cde6d` | `a082eb2d3121be3a1d7f38f4ff9339d513f26acc6de9d286604b52a7c9fb3c93` |
| Serif | `2eb75e035155ea1d0805fafaa012f7083e5034f935f17cfcc650b17bdf530c2d` | `478c09b900c4e789f57f921811263e2c9b10883c7e4c096331396cf157d96622` |
| Mono | `8c2c290cbd998fa1f647e4572aca6ebbd72589551b0f3f9f8bb8628fbb8219d5` | `75f480b9a2a874d1f0f66ee7c096bc7aadaa731bf8fd57a32848c4f5c3bb45a1` |
