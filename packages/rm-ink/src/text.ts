/**
 * Text -> glyph contour strokes, with per-glyph sub-parts.
 *
 * Each glyph cluster gets a `partKey` so the sync engine can repair partial
 * tablet erases semantically (e.g. "ABCD" -> "ABC"). Pure except for
 * opentype.js; fonts are passed in (no fetching here).
 */

import type { Font, Path } from 'opentype.js'
import type { Xy } from './points'
import { polylineToPoints, type InkStroke } from './points'
import { tldrawWidthToRmMarkerWidth, rmMarkerWidthToRadius, RM_SCALE } from './pen'
import { insetGlyphFill } from './glyph-fill'
import { mapToRmSpace, type ShapeTransform } from './transform'

export interface TextLayout {
    text: string
    fontSize: number
    lineHeight?: number
}

export interface GlyphPart {
    /** Stable sub-part key: glyph index within the whole text run. */
    partKey: string
    strokes: InkStroke[]
}

function isFiniteNum(v: number): boolean {
    return typeof v === 'number' && Number.isFinite(v)
}

/** Extract closed contours from an opentype glyph path. */
export function extractContours(path: Path): Xy[][] {
    const contours: Xy[][] = []
    let current: Xy[] = []
    for (const cmd of path.commands) {
        switch (cmd.type) {
            case 'M':
                if (current.length >= 2) contours.push(current)
                current = []
                if (isFiniteNum(cmd.x) && isFiniteNum(cmd.y)) current.push({ x: cmd.x, y: cmd.y })
                break
            case 'L':
                if (isFiniteNum(cmd.x) && isFiniteNum(cmd.y)) current.push({ x: cmd.x, y: cmd.y })
                break
            case 'Q': {
                const prev = current[current.length - 1]
                if (!prev || !isFiniteNum(cmd.x) || !isFiniteNum(cmd.x1)) break
                for (let t = 1; t <= 8; t++) {
                    const u = t / 8
                    const inv = 1 - u
                    current.push({
                        x: inv * inv * prev.x + 2 * inv * u * cmd.x1 + u * u * cmd.x,
                        y: inv * inv * prev.y + 2 * inv * u * cmd.y1 + u * u * cmd.y,
                    })
                }
                break
            }
            case 'C': {
                const prev = current[current.length - 1]
                if (!prev || !isFiniteNum(cmd.x) || !isFiniteNum(cmd.x1) || !isFiniteNum(cmd.x2)) break
                for (let t = 1; t <= 10; t++) {
                    const u = t / 10
                    const inv = 1 - u
                    current.push({
                        x:
                            inv * inv * inv * prev.x +
                            3 * inv * inv * u * cmd.x1 +
                            3 * inv * u * u * cmd.x2 +
                            u * u * u * cmd.x,
                        y:
                            inv * inv * inv * prev.y +
                            3 * inv * inv * u * cmd.y1 +
                            3 * inv * u * u * cmd.y2 +
                            u * u * u * cmd.y,
                    })
                }
                break
            }
            case 'Z':
                if (current.length >= 2) {
                    const first = current[0]!
                    const last = current[current.length - 1]!
                    if (Math.abs(first.x - last.x) > 0.5 || Math.abs(first.y - last.y) > 0.5) {
                        current.push({ x: first.x, y: first.y })
                    }
                    contours.push(current)
                }
                current = []
                break
        }
    }
    if (current.length >= 2) contours.push(current)
    return contours
}

/**
 * Even-odd scanline fill of closed contours -> serpentine fill polylines.
 *
 * The plotter-classic approach: intersect each horizontal scanline with all
 * contour edges, sort crossings, fill alternate spans (even-odd keeps glyph
 * holes like 'O' empty), then chain vertically-adjacent spans into
 * boustrophedon polylines so a glyph fills with a handful of strokes
 * instead of one per scanline.
 */
export function fillContours(contours: Xy[][], pitch: number): Xy[][] {
    if (contours.length === 0 || !(pitch > 0)) return []
    let minY = Infinity
    let maxY = -Infinity
    for (const c of contours) {
        for (const p of c) {
            if (p.y < minY) minY = p.y
            if (p.y > maxY) maxY = p.y
        }
    }
    if (!Number.isFinite(minY) || maxY - minY < pitch * 0.5) return []

    type Span = { x0: number; x1: number }
    const rows: { y: number; spans: Span[] }[] = []
    // half-pitch inset so the fill stays inside the stroked outline
    for (let y = minY + pitch * 0.5; y <= maxY - pitch * 0.25; y += pitch) {
        const xs: number[] = []
        for (const c of contours) {
            for (let i = 0; i < c.length; i++) {
                const a = c[i]!
                const b = c[(i + 1) % c.length]!
                // half-open rule avoids double-counting shared vertices
                if (a.y <= y === b.y <= y) continue
                xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x))
            }
        }
        xs.sort((p, q) => p - q)
        const spans: Span[] = []
        for (let i = 0; i + 1 < xs.length; i += 2) {
            if (xs[i + 1]! - xs[i]! > pitch * 0.3) spans.push({ x0: xs[i]!, x1: xs[i + 1]! })
        }
        if (spans.length > 0) rows.push({ y, spans })
    }

    // chain spans across adjacent rows into serpentine polylines
    const out: Xy[][] = []
    const used = rows.map((r) => r.spans.map(() => false))
    for (let r0 = 0; r0 < rows.length; r0++) {
        for (let s0 = 0; s0 < rows[r0]!.spans.length; s0++) {
            if (used[r0]![s0]) continue
            let r = r0
            let s = s0
            let leftToRight = true
            const line: Xy[] = []
            for (;;) {
                used[r]![s] = true
                const { y } = rows[r]!
                const span = rows[r]!.spans[s]!
                if (leftToRight) {
                    line.push({ x: span.x0, y }, { x: span.x1, y })
                } else {
                    line.push({ x: span.x1, y }, { x: span.x0, y })
                }
                // continue into an overlapping unused span on the NEXT row
                const next = rows[r + 1]
                if (!next || Math.abs(next.y - rows[r]!.y) > pitch * 1.5) break
                let found = -1
                for (let i = 0; i < next.spans.length; i++) {
                    const cand = next.spans[i]!
                    if (!used[r + 1]![i] && cand.x0 < span.x1 && cand.x1 > span.x0) {
                        found = i
                        break
                    }
                }
                if (found < 0) break
                r += 1
                s = found
                leftToRight = !leftToRight
            }
            if (line.length >= 2) out.push(line)
        }
    }
    return out
}

/**
 * Project a text run to contour strokes, one GlyphPart per glyph.
 * Coordinates are produced in RM page space using `shape`'s transform.
 * Glyph interiors are filled with inset marker strokes, rather than thickening
 * the letter by tracing a marker centered on its outer and inner boundaries.
 */
export interface TextBox {
    /** Wrap width in the SAME units as fontSize (shape-local px, scale folded
     *  in). Omit / non-finite for autoSize text: only explicit '\n' break. */
    width?: number
    /** Horizontal alignment of each visual line within `width`. Needs width. */
    align?: 'start' | 'middle' | 'end'
    /** BROWSER-measured spans (tldraw's TextManager.measureTextSpans): the
     *  exact word runs and rects the DOM rendered, shape-local px, scale
     *  folded in. When present they REPLACE the internal wrap/align — the
     *  re-implemented wrap always drifts from the browser's (letter-spacing,
     *  break-word, font hinting), which read as "a different render path"
     *  on the device. Span concatenation must cover the source text in
     *  order (tldraw guarantees this; empty lines gain one space). */
    spans?: MeasuredSpan[]
}

/** One measured word/whitespace run from the browser's own text layout. */
export interface MeasuredSpan {
    text: string
    x: number
    y: number
    w: number
    /** Range-rect height = the CSS line box (fontSize * lineHeight). */
    h: number
    /** Optional browser-measured pen offset (shape-local px, scale folded) of
     *  each code point relative to `x`; offsets[0] === 0. Suffix-independent,
     *  so a growing word never moves earlier glyphs (no re-mint churn). One per
     *  code point of `text`; when absent or length-mismatched, glyphs fall back
     *  to opentype advances scaled to `w`. */
    offsets?: number[]
}

/** Greedy word-wrap that PRESERVES every source character (concatenation of
 *  the returned lines === `para`), so a glyph's source index is unchanged by
 *  wrapping: the tablet-erase repair keys on that index. */
function wrapParagraph(para: string, maxW: number, advanceOf: (ch: string) => number): string[] {
    if (!(maxW > 0) || !Number.isFinite(maxW)) return [para]
    const tokens = para.match(/(\s+|\S+)/g)
    if (!tokens) return ['']
    const widthOf = (s: string): number => {
        let w = 0
        for (const ch of s) w += advanceOf(ch)
        return w
    }
    const lines: string[] = []
    let cur = ''
    let curW = 0
    for (const tok of tokens) {
        const tw = widthOf(tok)
        // break BEFORE a word that overflows (never before whitespace, so the
        // breaking space trails the previous line and is trimmed for measure)
        if (cur !== '' && /\S/.test(tok) && curW + tw > maxW) {
            lines.push(cur)
            cur = ''
            curW = 0
        }
        // a word WIDER than the box breaks mid-word, like the overflow-wrap:
        // break-word tldraw labels render with — word-only wrapping left the
        // whole word on one ink line while the browser stacked it.
        if (/\S/.test(tok) && tw > maxW) {
            for (const ch of tok) {
                const cw = advanceOf(ch)
                if (cur !== '' && curW + cw > maxW) {
                    lines.push(cur)
                    cur = ''
                    curW = 0
                }
                cur += ch
                curW += cw
            }
            continue
        }
        cur += tok
        curW += tw
    }
    lines.push(cur)
    return lines
}

/** Match placement and wrap calculation, including the missing-glyph fallback. */
function glyphAdvance(font: Font, fontSize: number, ch: string): number {
    try {
        const glyph = font.charToGlyph(ch)
        return ((glyph.advanceWidth ?? 0) / font.unitsPerEm) * fontSize
    } catch {
        return fontSize * 0.5
    }
}

export function textToGlyphParts(
    font: Font,
    layout: TextLayout,
    shape: ShapeTransform,
    rmColor: string,
    box: TextBox = {},
): GlyphPart[] {
    const lineHeight = layout.lineHeight ?? 1.35
    const fontSize = layout.fontSize
    // CSS inline layout: the browser centers the font's ascent+descent in the
    // line box and puts the baseline at half-leading + ascent, not at the
    // box bottom. A naive `(n+1)*fontSize*lineHeight` baseline sits visibly
    // too low relative to the tldraw text.
    const asc = (font.ascender / font.unitsPerEm) * fontSize
    const desc = (Math.abs(font.descender) / font.unitsPerEm) * fontSize
    const lineBox = fontSize * lineHeight
    const baselineOf = (line: number) => line * lineBox + (lineBox - (asc + desc)) / 2 + asc
    const strokeWidth = Math.max(0.3, fontSize * 0.04)
    const width = tldrawWidthToRmMarkerWidth(strokeWidth)
    const widths = [...new Set([width, Math.max(1, Math.floor(width / 2)), 1])]
    const radii = widths.map(rmMarkerWidthToRadius)
    const advanceOf = (ch: string) => glyphAdvance(font, fontSize, ch)
    const wrapW = box.width && box.width > 0 ? box.width : Infinity
    const align = box.align ?? 'start'

    const parts: GlyphPart[] = []
    const emitGlyph = (ch: string, x: number, baseline: number, srcIdx: number): void => {
        const strokes: InkStroke[] = []
        try {
            const glyph = font.charToGlyph(ch)
            const path = glyph.getPath(x, baseline, fontSize)
            const contours = extractContours(path).filter((c) => c.length >= 4)
            for (const { paths, widthIndex } of insetGlyphFill(contours, radii)) {
                for (const path of paths) {
                    strokes.push({
                        points: polylineToPoints(mapToRmSpace(path, shape), { width: widths[widthIndex]! }),
                        color: rmColor,
                    })
                }
            }
        } catch {
            // unknown glyph: advance only
        }
        if (strokes.length > 0) parts.push({ partKey: `glyph:${srcIdx}`, strokes })
    }

    // Browser-measured spans: place glyphs exactly where the DOM put them.
    if (box.spans?.length) {
        // CODE-POINT cursor, never raw string indexing: partKey indices are
        // consumed by repairText's [...text] filter (code points), and raw
        // source[i]/indexOf are UTF-16 offsets — one emoji before a glyph
        // desynced every later index and silently broke tail-erase repair.
        const source = [...layout.text]
        let src = 0 // lockstep cursor over the SOURCE code points (partKey indices)
        for (const span of box.spans) {
            const chars = [...span.text]
            // Per-glyph x-positions. PREFER browser-measured cumulative offsets
            // (span.offsets: the DOM pen position of each glyph, suffix-
            // independent, so appending a letter never moves the earlier ones).
            // FALL BACK to opentype advances scaled to the run width when the
            // measurer can't give per-glyph offsets (tests / no DOM).
            //
            // Why offsets and not `advance * (span.w/total)`: that whole-word
            // ratio drifts as the word grows, since span.w carries a roughly
            // constant measurement overhead so span.w/total decays. Because it
            // scales every glyph, each edit moves every glyph after the first,
            // changing its contentHash and re-minting the entire word (N chars
            // -> ~N^2/2 strokes). Prefix offsets are overhead-free and stable.
            const advances = chars.map(advanceOf)
            const total = advances.reduce((a, b) => a + b, 0)
            const fit = total > 0 && span.w > 0 && Number.isFinite(span.w) ? span.w / total : 1
            const offsets = span.offsets
            const xOf = (i: number): number =>
                offsets && offsets.length === chars.length
                    ? span.x + offsets[i]!
                    : span.x + advances.slice(0, i).reduce((a, b) => a + b, 0) * fit
            const baseline = span.y + (span.h - (asc + desc)) / 2 + asc
            let ci = 0
            for (const ch of span.text) {
                let srcIdx: number | null = null
                if (source[src] === ch) {
                    srcIdx = src
                    src++
                } else if (!/\s/.test(ch)) {
                    // defensive resync (normalization only touches whitespace)
                    const at = source.indexOf(ch, src)
                    if (at >= 0) {
                        srcIdx = at
                        src = at + 1
                    }
                }
                // whitespace mismatches are normalizeTextForDom artifacts
                // (an empty line renders as one space): no glyph, no advance
                if (!/\s/.test(ch)) emitGlyph(ch, xOf(ci), baseline, srcIdx ?? src)
                ci++
            }
        }
        return parts
    }

    const paragraphs = layout.text.replace(/\n$/, '').split('\n')
    let sourceIdx = 0 // source code-point index (newlines counted), the partKey base
    let visualLine = 0 // running VISUAL line (wraps advance it, source '\n's too)

    for (const para of paragraphs) {
        const lines = wrapParagraph(para, wrapW, advanceOf)
        let idxInPara = 0
        for (const lineStr of lines) {
            const baseline = baselineOf(visualLine)
            // trailing wrap-whitespace must not shift a middle/end aligned line
            let lineW = 0
            for (const ch of lineStr.replace(/\s+$/, '')) lineW += advanceOf(ch)
            let xCursor =
                align === 'middle'
                    ? (wrapW - lineW) / 2
                    : align === 'end'
                      ? wrapW - lineW
                      : 0
            if (!Number.isFinite(xCursor)) xCursor = 0 // no width -> left align
            for (const ch of lineStr) {
                emitGlyph(ch, xCursor, baseline, sourceIdx + idxInPara)
                idxInPara++
                xCursor += advanceOf(ch)
            }
            visualLine++
        }
        sourceIdx += [...para].length + 1 // + the '\n' that separated paragraphs
    }
    return parts
}

/** Visual line count after wrapping to `width` (Infinity/omitted = no wrap,
 *  only explicit '\n'). Lets a caller vertically center a wrapped label. */
export function wrappedLineCount(font: Font, layout: TextLayout, width?: number): number {
    const fontSize = layout.fontSize
    const advanceOf = (ch: string) => glyphAdvance(font, fontSize, ch)
    const wrapW = width && width > 0 ? width : Infinity
    let n = 0
    for (const para of layout.text.replace(/\n$/, '').split('\n')) {
        n += wrapParagraph(para, wrapW, advanceOf).length
    }
    return n
}

/** Approximate rendered text width in tldraw px (for layout checks). */
export function measureText(font: Font, layout: TextLayout): { width: number; height: number } {
    const lineHeight = layout.lineHeight ?? 1.35
    const lines = layout.text.replace(/\n$/, '').split('\n')
    let width = 0
    for (const line of lines) {
        let w = 0
        for (const ch of line) {
            const glyph = font.charToGlyph(ch)
            w += ((glyph.advanceWidth ?? 0) / font.unitsPerEm) * layout.fontSize
        }
        width = Math.max(width, w)
    }
    return { width, height: lines.length * layout.fontSize * lineHeight }
}

export { RM_SCALE }
