/** Shared layout for typed text, its hit boxes, and anchored ink. */

import type { TextParagraph } from '@weft/rm-format'
import { RM_SCALE } from '@weft/rm-ink'
import { OPEN_FONT_ADVANCES } from './noto-font-advances'

/** body paragraph baseline->baseline step. */
export const PARA_STRIDE_INK = 69.546875
/** body line stride within a wrapped paragraph. */
export const BODY_LINE_STRIDE_INK = 45.546875
/** legacy CSS margin: paraStep - lineStride. */
export const BODY_MARGIN_TOP_INK = PARA_STRIDE_INK - BODY_LINE_STRIDE_INK // 24

/** device text-frame left pad: plain lines start at posX + 4. */
export const DEVICE_TEXT_LEFT_MARGIN_INK = 4
/** right pad, symmetric. */
export const DEVICE_TEXT_RIGHT_MARGIN_INK = 4

export const BODY_FAMILY = "'RM Noto Sans', sans-serif"
const SERIF_FAMILY = "'RM Noto Serif', serif"

/** body em 32 ink: the device's Qt pixelSize. */
export const BODY_EM_INK = 32
export const BODY_PX = BODY_EM_INK * RM_SCALE

/** marker right-align edge: indent minus this. */
export const MARKER_RIGHT_GAP_INK = 16.8125
/** markers draw this far (ink) below the text baseline. */
export const MARKER_BASELINE_DROP_INK = 0.40625

/** additive paragraph-step model: step(prev,cur) = STEP_D[prev] + STEP_A[cur],
 *  keyed by em, gauged A(32)=0. */
const STEP_D: Record<number, number> = { 32: 69.546875, 64: 70.390625, 36: 63.296875, 46: 66.046875 }
const STEP_A: Record<number, number> = { 32: 0, 64: 93.609375, 36: 19.703125, 46: 44.953125 }
/** first-line baseline from the column top. */
const FIRST_BASELINE: Record<number, number> = { 32: 33.59375, 64: 63.203125, 36: 37.296875, 46: 46.546875 }

export function paraStepInk(prevEm: number, curEm: number): number {
    return (STEP_D[prevEm] ?? STEP_D[32]!) + (STEP_A[curEm] ?? STEP_A[32]!)
}

export interface StyleMetrics {
    /** canvas font string (fallback measurement for uncovered glyphs). */
    font: string
    css: {
        fontFamily: string
        fontSizePx: number
        fontWeight?: number
        textDecoration?: string
    }
    /** em in ink units (the device's Qt pixelSize). */
    emInk: number
    /** Table key for advances from the supplied open font. */
    fontKey: string
    /** wrapped-line stride within the paragraph, ink units. */
    lineStrideInk: number
    /** first-line baseline offset from the line-box top. */
    baselineInk: number
    /** text indent (hanging), ink units from posX. 0 = pad applies. */
    indentInk: number
    /** list/checkbox marker and its x position, ink units from posX. */
    marker?: { glyph: string; xInk: number }
    /** legacy CSS margin (paraStep(self,self) - lineStride). */
    marginTopInk: number
    /** struck through (checked items). */
    strike?: boolean
    /** vector checkbox (device draws it as paths, not a glyph). */
    checkbox?: { xInk: number; checked: boolean }
}

const BODY: StyleMetrics = {
    font: `${BODY_PX}px ${BODY_FAMILY}`,
    css: { fontFamily: BODY_FAMILY, fontSizePx: BODY_PX },
    emInk: 32,
    fontKey: 'sansRegular',
    lineStrideInk: BODY_LINE_STRIDE_INK,
    baselineInk: FIRST_BASELINE[32]!,
    indentInk: 0,
    marginTopInk: BODY_MARGIN_TOP_INK,
}
const HEADING: StyleMetrics = {
    ...BODY,
    font: `${64 * RM_SCALE}px ${SERIF_FAMILY}`,
    css: { fontFamily: SERIF_FAMILY, fontSizePx: 64 * RM_SCALE },
    emInk: 64,
    fontKey: 'serifSmall',
    lineStrideInk: 76,
    baselineInk: FIRST_BASELINE[64]!,
    marginTopInk: 164 - 76,
}
const BOLD_PARA: StyleMetrics = {
    ...BODY,
    font: `500 ${36 * RM_SCALE}px ${BODY_FAMILY}`,
    css: { fontFamily: BODY_FAMILY, fontSizePx: 36 * RM_SCALE, fontWeight: 500 },
    emInk: 36,
    fontKey: 'sansMedium',
    lineStrideInk: 43,
    baselineInk: FIRST_BASELINE[36]!,
    marginTopInk: 83 - 43,
}

/** legacy size property (style-entry property 2): 1 XL serif (= HEADING),
 *  2 medium bold sans (= BOLD_PARA), 3 large serif @46. */
const SIZE3: StyleMetrics = {
    ...HEADING,
    font: `${46 * RM_SCALE}px ${SERIF_FAMILY}`,
    css: { fontFamily: SERIF_FAMILY, fontSizePx: 46 * RM_SCALE },
    emInk: 46,
    lineStrideInk: 55,
    baselineInk: FIRST_BASELINE[46]!,
    marginTopInk: 111 - 55,
}

/** device indent geometry: a plain paragraph with the indent property
 *  (style extra 3) renders as a bullet one depth beyond the styled bullets.
 *  Depth k: text at 52 + 48k, marker at 24 + 48k, glyphs cycling
 *  bullet/hollow/dash. indentLevel L maps to k=L. */
export function indentMetrics(level: number): StyleMetrics {
    const k = Math.max(1, level)
    const glyph = k === 0 ? '•' : k === 1 ? '◦' : '-'
    return {
        ...BODY,
        indentInk: 52 + 48 * k,
        marker: { glyph, xInk: 24 + 48 * k },
    }
}

export function metricsFor(style: number, sizeCode?: number, indentLevel?: number): StyleMetrics {
    if (sizeCode === 1) return HEADING
    if (sizeCode === 2) return BOLD_PARA
    if (sizeCode === 3) return SIZE3
    if (indentLevel && indentLevel >= 1 && (style === 0 || style === 1)) {
        return indentMetrics(indentLevel)
    }
    switch (style) {
        case 2:
            return HEADING
        case 3:
            return BOLD_PARA
        case 4:
            return { ...BODY, indentInk: 52, marker: { glyph: '•', xInk: 24 } }
        case 5:
            return { ...BODY, indentInk: 100, marker: { glyph: '◦', xInk: 72 } }
        case 6:
            return { ...BODY, indentInk: 52, checkbox: { xInk: 10.666667, checked: false } }
        case 7:
            return {
                ...BODY,
                indentInk: 52,
                checkbox: { xInk: 10.666667, checked: true },
                strike: true,
            }
        case 8:
            return { ...BODY, indentInk: 100, checkbox: { xInk: 58.666667, checked: false } }
        case 9:
            return {
                ...BODY,
                indentInk: 100,
                checkbox: { xInk: 58.666667, checked: true },
                strike: true,
            }
        case 10:
            return { ...BODY, indentInk: 52, marker: { glyph: '#', xInk: 24 } }
        case 11:
            return { ...BODY, indentInk: 100, marker: { glyph: '#', xInk: 72 } }
        default:
            return BODY
    }
}

export type MeasureFn = (text: string, font: string) => number

/** canvas measureText fallback for glyphs outside the device tables. */
export function canvasMeasure(): MeasureFn {
    const ctx = document.createElement('canvas').getContext('2d')!
    return (text, font) => {
        ctx.font = font
        return ctx.measureText(text).width
    }
}

export const INK_PER_PX = 1 / RM_SCALE

export interface SpanStyle {
    bold?: boolean
    italic?: boolean
}

/** static-table key for an inline span within a style. The device drops
 *  overlapping bold+italic and renders plain; mirror that. (The write path
 *  sanitizes overlaps to italic-only, so both flags here means a
 *  device-authored crossing.) */
function spanFontKey(m: StyleMetrics, span?: SpanStyle): string {
    if (!span || (!span.bold && !span.italic) || (span.bold && span.italic)) return m.fontKey
    if (m.fontKey === 'sansRegular' || m.fontKey === 'sansMedium') {
        return span.italic ? 'sansItalic' : 'sansBold'
    }
    if (m.fontKey === 'serifSmall' && span.bold) return 'serifSmallBold'
    return m.fontKey // serif italics keep regular metrics
}

/** Glyph advance in ink units using the bundled open typefaces. */
export function glyphAdvanceInk(
    ch: string,
    m: StyleMetrics,
    span?: SpanStyle,
    measure?: MeasureFn,
): number {
    const advance = OPEN_FONT_ADVANCES[spanFontKey(m, span)]?.[ch]
    if (advance !== undefined) return advance * m.emInk
    if (measure) return measure(ch, m.font) * INK_PER_PX
    return 0.55 * m.emInk
}

/** Pen positions for a run: x offset of each glyph (from pen start) plus the
 *  final pen. Uses the same metrics as the wrapping pass. */
export function penPositions(
    text: string,
    m: StyleMetrics,
    span?: SpanStyle,
    measure?: MeasureFn,
): { xs: number[]; end: number } {
    const xs: number[] = []
    let pen = 0
    for (const ch of text) {
        xs.push(pen)
        pen += glyphAdvanceInk(ch, m, span, measure)
    }
    return { xs, end: pen }
}

/** run width in ink (spaces at the END excluded, Qt wrap semantics). */
function runWidthInk(text: string, m: StyleMetrics, measure?: MeasureFn): number {
    return penPositions(text.replace(/ +$/, ''), m, undefined, measure).end
}

export interface ParagraphLayout {
    /** ink-unit top of the paragraph's FIRST line box, relative to text top. */
    topInk: number
    /** first line's alphabetic baseline, relative to text top. */
    firstBaselineInk: number
    /** baseline offset within each line box (baseline - top). */
    baselineOffsetInk: number
    lineStrideInk: number
    /** visible-char offset each wrapped line starts at. */
    lineStarts: number[]
    style: number
}

/** Greedy word wrap with the device pen model. */
function wrapParagraph(
    text: string,
    m: StyleMetrics,
    availInk: number,
    measure?: MeasureFn,
): number[] {
    if (text.length === 0) return [0]
    const starts = [0]
    let lineStart = 0
    let candidate = 0
    for (let i = 0; i < text.length; i++) {
        if (text[i] === ' ') candidate = i + 1
        if (text[i] === ' ') continue // trailing spaces never trigger a break
        const w = runWidthInk(text.slice(lineStart, i + 1), m, measure)
        if (w > availInk && i > lineStart) {
            const breakAt = candidate > lineStart ? candidate : i
            starts.push(breakAt)
            lineStart = breakAt
            candidate = lineStart
        }
        // a hyphen is a break opportunity (break after it), like xochitl and
        // the browser
        if (text[i] === '-' && i + 1 < text.length) candidate = i + 1
    }
    return starts
}

export type LayoutParagraph = Omit<TextParagraph, 'startId'>

/**
 * The one layout: line boxes + baselines in ink units relative to the text
 * top (posY). Anchors, the SVG renderer and hit boxes all consume this.
 */
export function layoutText(
    paragraphs: readonly LayoutParagraph[],
    widthInk: number,
    measure?: MeasureFn,
): { paras: ParagraphLayout[]; lastLineTopInk: number; bottomInk: number } {
    const paras: ParagraphLayout[] = []
    let prevBaseline: number | null = null
    let prevEm = 32
    let lastTop = 0
    let lastStride = BODY_LINE_STRIDE_INK
    for (const p of paragraphs) {
        const m = metricsFor(p.style, p.sizeCode, p.indentLevel)
        const text = p.spans.map((s) => s.text).join('')
        const avail = Math.max(
            1,
            widthInk -
                (m.indentInk > 0 ? m.indentInk : DEVICE_TEXT_LEFT_MARGIN_INK) -
                DEVICE_TEXT_RIGHT_MARGIN_INK,
        )
        const lineStarts = wrapParagraph(text, m, avail, measure)
        const firstBaseline: number =
            prevBaseline === null
                ? m.baselineInk
                : prevBaseline + paraStepInk(prevEm, m.emInk)
        const topInk = firstBaseline - m.baselineInk
        paras.push({
            topInk,
            firstBaselineInk: firstBaseline,
            baselineOffsetInk: m.baselineInk,
            lineStrideInk: m.lineStrideInk,
            lineStarts,
            style: p.style,
        })
        const lastBaseline: number = firstBaseline + (lineStarts.length - 1) * m.lineStrideInk
        lastTop = lastBaseline - m.baselineInk
        lastStride = m.lineStrideInk
        prevBaseline = lastBaseline
        prevEm = m.emInk
    }
    return {
        paras,
        lastLineTopInk: lastTop,
        bottomInk: lastTop + lastStride,
    }
}
