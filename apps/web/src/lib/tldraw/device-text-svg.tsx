/**
 * Static typed-text renderer. Positions glyphs with the shared layout metrics.
 * SVG user units are ink units;
 * baselines are unrounded. Editing swaps to the TipTap DOM (isEditing).
 */

import { useMemo } from 'react'

/** Content bounds (ink) of the rendered lines, including empty lines'
 *  vertical extent. What the selection indicator hugs. */
export function svgContentBounds(
    lines: { top: number; bottom: number; startX: number; endX: number }[],
): { x0: number; y0: number; x1: number; y1: number } | null {
    if (!lines.length) return null
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const l of lines) {
        if (l.top < y0) y0 = l.top
        if (l.bottom > y1) y1 = l.bottom
        if (l.startX < x0) x0 = l.startX
        if (l.endX > x1) x1 = l.endX
    }
    if (x1 <= x0) x1 = x0 + 1
    return { x0, y0, x1, y1 }
}
import type { TLRichText } from 'tldraw'
import {
    canvasMeasure,
    DEVICE_TEXT_LEFT_MARGIN_INK,
    MARKER_BASELINE_DROP_INK,
    MARKER_RIGHT_GAP_INK,
    graphemePaintSpans,
    layoutText,
    type LayoutParagraph,
    metricsFor,
    penPositions,
} from './text-metrics'
import { isNativeIndentedPlain, richTextToLines, styleForNodeKind, type RichLine } from './device-text-richtext'

interface SvgRun {
    /** One x per single-unit glyph, or one x for an entire shaped cluster. */
    xs: number[]
    text: string
    bold: boolean
    italic: boolean
}

interface SvgLine {
    /** alphabetic baseline, ink units from the text top (exact, unrounded). */
    y: number
    /** line box top/bottom (ink), including empty lines. */
    top: number
    bottom: number
    /** pen x where the line's trimmed text starts / ends (ink). */
    startX: number
    endX: number
    emInk: number
    weight: number
    family: string
    runs: SvgRun[]
    /** strike line from x0 to x1 at the device offset, if checked. */
    strike?: { x0: number; x1: number }
    /** text marker (bullets, numbers) at its device position. */
    marker?: { text: string; x: number }
    /** vector checkbox at its device position. */
    checkbox?: { x: number; checked: boolean }
}

/** device checkbox geometry (relative to marker x / baseline):
 *  26.667-ink square from baseline-24.917 to baseline+1.75. */
const CHECKBOX_SIZE_INK = 26.666667
const CHECKBOX_TOP_INK = -24.916667
const CHECKBOX_STROKE_INK = 1.59375
/** strike line: 1.59375 wide, 9.864583 above the baseline. */
const STRIKE_RISE_INK = 9.864583
const STRIKE_WIDTH_INK = 1.59375

/** Resolve the effective style code (paragraph kinds carry it in deviceStyle). */
function effectiveStyle(line: RichLine): number {
    if (line.deviceStyle !== null && (line.kind === 'paragraph' ||
        (line.kind === 'bullet2' && isNativeIndentedPlain(line.deviceStyle, line.indentLevel)))) {
        return line.deviceStyle
    }
    return styleForNodeKind(line.kind, line.deviceStyle).value
}

/** Heading size codes: h2 = 3 (large serif), h3 = 2 (medium bold sans);
 *  h1 = legacy HEADING style, no size code. */
function effectiveSizeCode(line: RichLine): number | undefined {
    if (line.kind === 'heading2') return 3
    if (line.kind === 'heading3') return 2
    return undefined
}

function toParagraph(line: RichLine): LayoutParagraph {
    return {
        style: effectiveStyle(line),
        sizeCode: effectiveSizeCode(line),
        indentLevel: line.indentLevel,
        spans: line.segments,
    }
}

function markerText(
    style: number,
    counters: { l1: number; l2: number },
    markerGlyph?: string,
): string | undefined {
    if (markerGlyph && style !== 10 && style !== 11) return markerGlyph
    if (style === 4) return '•'
    if (style === 5) return '◦'
    if (style === 10) {
        counters.l1 += 1
        counters.l2 = 0
        return `${counters.l1}.`
    }
    if (style === 11) {
        counters.l2 += 1
        return `${String.fromCharCode(96 + Math.min(counters.l2, 26))}.`
    }
    return undefined
}

export function buildSvgLines(richText: TLRichText, widthInk: number): SvgLine[] {
    const lines = richTextToLines(richText)
    const paragraphs = lines.map(toParagraph)
    const measure = canvasMeasure()
    const layout = layoutText(paragraphs, widthInk, measure)
    const out: SvgLine[] = []
    const counters = { l1: 0, l2: 0 }
    lines.forEach((line, i) => {
        const para = layout.paras[i]
        if (!para) return
        const { style, sizeCode, indentLevel, spans } = paragraphs[i]!
        const m = metricsFor(style, sizeCode, indentLevel)
        const xStart = m.indentInk > 0 ? m.indentInk : DEVICE_TEXT_LEFT_MARGIN_INK
        const full = line.text
        const marker = markerText(style, counters, m.marker?.glyph)
        const paintSpans = graphemePaintSpans(spans)
        para.lineStarts.forEach((start, li) => {
            const end =
                li + 1 < para.lineStarts.length ? para.lineStarts[li + 1]! : full.length
            const y = para.firstBaselineInk + li * para.lineStrideInk
            // slice segments to this wrapped line, laying pens continuously
            const runs: SvgRun[] = []
            let pen = xStart
            let pos = 0
            for (const seg of paintSpans) {
                const s0 = pos
                const s1 = pos + seg.text.length
                pos = s1
                const a = Math.max(start, s0)
                const b = Math.min(end, s1)
                if (b <= a) continue
                const text = seg.text.slice(a - s0, b - s0)
                const span = { bold: seg.bold, italic: seg.italic }
                const pp = penPositions(text, m, span, measure)
                let plain: SvgRun | undefined
                pp.units.forEach((unit, j) => {
                    const x = pen + pp.xs[j]!
                    // An SVG position inside a cluster (including surrogate
                    // pairs) can break shaping or position following glyphs
                    // incorrectly. Give the cluster a separate text chunk.
                    if (unit.length > 1) {
                        runs.push({ ...span, text: unit, xs: [x] })
                        plain = undefined
                    } else {
                        if (!plain) {
                            plain = { ...span, text: '', xs: [] }
                            runs.push(plain)
                        }
                        plain.text += unit
                        plain.xs.push(x)
                    }
                })
                pen += pp.end
            }
            const lastGlyphEnd = xStart + para.lineWidthsInk[li]!
            const sl: SvgLine = {
                y,
                top: y - para.baselineOffsetInk,
                bottom: y - para.baselineOffsetInk + para.lineStrideInk,
                startX: m.checkbox?.xInk ?? m.marker?.xInk ?? xStart,
                endX: Math.max(lastGlyphEnd, xStart),
                emInk: m.emInk,
                weight: m.css.fontWeight ?? 400,
                family: m.css.fontFamily,
                runs,
            }
            if (li === 0) {
                if (m.checkbox) sl.checkbox = { x: m.checkbox.xInk, checked: m.checkbox.checked }
                else if (marker && m.marker) {
                    if (style !== 10 && style !== 11) {
                        // bullets/indent markers are start-anchored
                        sl.marker = { text: marker, x: m.marker.xInk }
                    } else {
                        // numbered: right-aligned at indent - MARKER_RIGHT_GAP, x rounded to integer ink
                        const w = penPositions(marker, m, undefined, measure).end
                        sl.marker = {
                            text: marker,
                            x: Math.round(m.indentInk - MARKER_RIGHT_GAP_INK - w),
                        }
                    }
                }
            }
            if (m.strike && lastGlyphEnd > xStart) {
                sl.strike = { x0: xStart, x1: lastGlyphEnd }
            }
            out.push(sl)
        })
    })
    return out
}

const INK_COLOR = '#1a1a18'

function Checkbox({ x, y, checked }: { x: number; y: number; checked: boolean }) {
    const top = y + CHECKBOX_TOP_INK
    if (!checked) {
        return (
            <rect
                x={x}
                y={top}
                width={CHECKBOX_SIZE_INK}
                height={CHECKBOX_SIZE_INK}
                fill="none"
                stroke={INK_COLOR}
                strokeWidth={CHECKBOX_STROKE_INK}
            />
        )
    }
    // filled box + white check (device geometry, path from its own PDF)
    const cx = x + CHECKBOX_SIZE_INK / 2
    const cy = top + CHECKBOX_SIZE_INK / 2
    return (
        <g>
            <rect x={x} y={top} width={CHECKBOX_SIZE_INK} height={CHECKBOX_SIZE_INK} fill={INK_COLOR} />
            <path
                d={`M ${cx - 5.9} ${cy + 0.6} L ${cx - 1.9} ${cy + 4.6} L ${cx + 6.1} ${cy - 4.4}`}
                fill="none"
                stroke="#ffffff"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </g>
    )
}

/** Inner SVG content in ink units. Mount inside an <svg> or, scaled by
 *  RM_SCALE, inside tldraw's SVGContainer. Must share the ink strokes' SVG
 *  pipeline: on a separate layer, pixel snapping shifts text against ink
 *  during camera motion. */
export function DeviceTextSvgContent({
    richText,
    widthInk,
    layoutGen,
}: {
    richText: TLRichText
    widthInk: number
    layoutGen: number
}) {
    const lines = useMemo(() => buildSvgLines(richText, widthInk), [richText, widthInk, layoutGen])
    return (
        // geometricPrecision: glyph outlines must scale like the ink paths.
        // The default hint-snaps glyphs to the device-pixel grid, re-quantizing
        // at every zoom step so text jitters against ink while zooming.
        <g textRendering="geometricPrecision">
            {lines.map((l, i) => (
                <g key={i}>
                    {l.marker && (
                        <text
                            x={l.marker.x}
                            y={l.y + MARKER_BASELINE_DROP_INK}
                            fontSize={l.emInk}
                            fontFamily={l.family}
                            fill={INK_COLOR}
                        >
                            {l.marker.text}
                        </text>
                    )}
                    {l.checkbox && <Checkbox x={l.checkbox.x} y={l.y} checked={l.checkbox.checked} />}
                    {l.runs.map((r, j) =>
                        r.text ? (
                            <text
                                key={j}
                                x={r.xs.join(' ')}
                                y={l.y}
                                fontSize={l.emInk}
                                fontFamily={l.family}
                                // device renders overlapping bold+italic as plain
                                fontWeight={r.bold && !r.italic ? 700 : l.weight}
                                fontStyle={r.italic && !r.bold ? 'italic' : undefined}
                                fill={INK_COLOR}
                                // x-list is per glyph: collapsing whitespace
                                // would shift every later glyph one slot left
                                xmlSpace="preserve"
                                style={{ whiteSpace: 'pre' }}
                            >
                                {r.text}
                            </text>
                        ) : null,
                    )}
                    {l.strike && (
                        <line
                            x1={l.strike.x0}
                            y1={l.y - STRIKE_RISE_INK}
                            x2={l.strike.x1}
                            y2={l.y - STRIKE_RISE_INK}
                            stroke={INK_COLOR}
                            strokeWidth={STRIKE_WIDTH_INK}
                        />
                    )}
                </g>
            ))}
        </g>
    )
}
