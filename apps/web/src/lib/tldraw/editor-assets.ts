import { iconTypes, type TLUiAssetUrlOverrides } from 'tldraw'
import sprite from '@tldraw/assets/icons/icon/0_merged.svg?url'
import mono from '@tldraw/assets/fonts/IBMPlexMono-Medium.woff2?url'
import monoItalic from '@tldraw/assets/fonts/IBMPlexMono-MediumItalic.woff2?url'
import monoBold from '@tldraw/assets/fonts/IBMPlexMono-Bold.woff2?url'
import monoItalicBold from '@tldraw/assets/fonts/IBMPlexMono-BoldItalic.woff2?url'
import sans from '@tldraw/assets/fonts/IBMPlexSans-Medium.woff2?url'
import sansItalic from '@tldraw/assets/fonts/IBMPlexSans-MediumItalic.woff2?url'
import sansBold from '@tldraw/assets/fonts/IBMPlexSans-Bold.woff2?url'
import sansItalicBold from '@tldraw/assets/fonts/IBMPlexSans-BoldItalic.woff2?url'
import serif from '@tldraw/assets/fonts/IBMPlexSerif-Medium.woff2?url'
import serifItalic from '@tldraw/assets/fonts/IBMPlexSerif-MediumItalic.woff2?url'
import serifBold from '@tldraw/assets/fonts/IBMPlexSerif-Bold.woff2?url'
import serifItalicBold from '@tldraw/assets/fonts/IBMPlexSerif-BoldItalic.woff2?url'
import draw from '@tldraw/assets/fonts/Shantell_Sans-Informal_Regular.woff2?url'
import drawItalic from '@tldraw/assets/fonts/Shantell_Sans-Informal_Regular_Italic.woff2?url'
import drawBold from '@tldraw/assets/fonts/Shantell_Sans-Informal_Bold.woff2?url'
import drawItalicBold from '@tldraw/assets/fonts/Shantell_Sans-Informal_Bold_Italic.woff2?url'

// Serve the SDK toolbar sprite and native text faces with the editor build.
// Vite fingerprints the original files and serves them from the app's origin.
export const editorAssets = {
    icons: Object.fromEntries(iconTypes.map((name) => [name, `${sprite}#${name}`])),
    fonts: {
        tldraw_mono: mono,
        tldraw_mono_italic: monoItalic,
        tldraw_mono_bold: monoBold,
        tldraw_mono_italic_bold: monoItalicBold,
        tldraw_sans: sans,
        tldraw_sans_italic: sansItalic,
        tldraw_sans_bold: sansBold,
        tldraw_sans_italic_bold: sansItalicBold,
        tldraw_serif: serif,
        tldraw_serif_italic: serifItalic,
        tldraw_serif_bold: serifBold,
        tldraw_serif_italic_bold: serifItalicBold,
        tldraw_draw: draw,
        tldraw_draw_italic: drawItalic,
        tldraw_draw_bold: drawBold,
        tldraw_draw_italic_bold: drawItalicBold,
    },
} satisfies TLUiAssetUrlOverrides
