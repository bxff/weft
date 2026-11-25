/** Color + pen mappings between tldraw and reMarkable: single copy. */

import { Pen, PenColor } from '@weft/rm-format'
import type { Rgb, RmBrush } from './pen'

/** RM palette as rendered by rmrl/xochitl. */
export const RM_COLORS: Record<string, Rgb> = {
    black: [0, 0, 0],
    grey: [144, 144, 144],
    white: [255, 255, 255],
    yellow: [251, 247, 25],
    green: [0, 255, 0],
    red: [179, 62, 57],
    blue: [78, 105, 201],
    'light-green': [161, 216, 125],
    'light-blue': [139, 208, 229],
    violet: [183, 130, 205],
    pink: [255, 192, 203],
    'grey-overlap': [125, 125, 125],
    highlight: [255, 255, 0],
    'yellow-2': [247, 232, 81],
}

const PEN_COLOR_NAME: Record<number, string> = {
    [PenColor.BLACK]: 'black',
    [PenColor.GRAY]: 'grey',
    [PenColor.WHITE]: 'white',
    [PenColor.YELLOW]: 'yellow',
    [PenColor.GREEN]: 'green',
    [PenColor.PINK]: 'pink',
    [PenColor.BLUE]: 'blue',
    [PenColor.RED]: 'red',
    [PenColor.GRAY_OVERLAP]: 'grey-overlap',
    [PenColor.HIGHLIGHT]: 'highlight',
    [PenColor.GREEN_2]: 'light-green',
    [PenColor.CYAN]: 'light-blue',
    [PenColor.MAGENTA]: 'violet',
    [PenColor.YELLOW_2]: 'yellow-2',
}

export function penColorName(color: PenColor): string {
    return PEN_COLOR_NAME[color] ?? 'black'
}

export function penColorRgb(color: PenColor): Rgb {
    return RM_COLORS[penColorName(color)] ?? [0, 0, 0]
}

/** tldraw color prop -> RM PenColor (writing direction). */
const TLDRAW_TO_PENCOLOR: Record<string, PenColor> = {
    black: PenColor.BLACK,
    grey: PenColor.GRAY,
    white: PenColor.WHITE,
    yellow: PenColor.YELLOW,
    green: PenColor.GREEN,
    blue: PenColor.BLUE,
    red: PenColor.RED,
    violet: PenColor.MAGENTA,
    orange: PenColor.RED,
    'light-red': PenColor.PINK,
    'light-green': PenColor.GREEN_2,
    'light-blue': PenColor.CYAN,
    'light-violet': PenColor.MAGENTA,
}

export function tldrawColorToPenColor(color: string): PenColor {
    return TLDRAW_TO_PENCOLOR[color] ?? PenColor.BLACK
}

/** RM pen tool -> brush family used by the renderer. */
export function penToBrush(pen: Pen): RmBrush | null {
    switch (pen) {
        case Pen.PAINTBRUSH_1:
        case Pen.PAINTBRUSH_2:
            return 'brush'
        case Pen.PENCIL_1:
        case Pen.PENCIL_2:
            return 'pencil'
        case Pen.BALLPOINT_1:
        case Pen.BALLPOINT_2:
            return 'ballpoint'
        case Pen.MARKER_1:
        case Pen.MARKER_2:
            return 'marker'
        case Pen.FINELINER_1:
        case Pen.FINELINER_2:
            return 'fineliner'
        case Pen.HIGHLIGHTER_1:
        case Pen.HIGHLIGHTER_2:
            return 'highlighter'
        case Pen.MECHANICAL_PENCIL_1:
        case Pen.MECHANICAL_PENCIL_2:
            return 'mechanicalPencil'
        case Pen.CALLIGRAPHY:
            return 'calligraphy'
        case Pen.SHADER:
            return 'shader'
        case Pen.ERASER:
        case Pen.ERASER_AREA:
            return null
        default:
            return 'ballpoint'
    }
}
