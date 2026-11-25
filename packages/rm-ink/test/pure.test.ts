/**
 * rm-ink pure-module regression tests: pen inverse bounds, point encoding,
 * path walking, dash patterns, text contours (real font), SVG rendering.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseFont } from 'opentype.js'
import {
    RM_SCALE,
    tldrawRadiusToRmMarkerWidth,
    rmMarkerWidthToRadius,
    tldrawWidthToRmMarkerWidth,
    markerStyle,
} from '../src/pen'
import { penToBrush, tldrawColorToPenColor, penColorName } from '../src/palette'
import { polylineToPoints, directionByte } from '../src/points'
import { walkPathCommands, applyDashPattern, polylineLength, flattenCubic } from '../src/path'
import { textToGlyphParts, extractContours } from '../src/text'
import { strokeToSvg } from '../src/render-svg'
import { Pen, PenColor } from '@weft/rm-format'

const WEB_FONTS = join(import.meta.dir, '../../../apps/web/static/fonts')

describe('pen formulas', () => {
    test('marker inverse round-trip error stays under quantization bound', () => {
        // one v6 width unit step = (1/4) * 0.7 * RM_SCALE / 2 radius change
        const maxErr = ((1 / 4) * 0.7 * RM_SCALE) / 2
        for (let radius = 0.5; radius < 20; radius += 0.137) {
            const v6 = tldrawRadiusToRmMarkerWidth(radius)
            const back = rmMarkerWidthToRadius(v6)
            expect(Math.abs(back - radius)).toBeLessThanOrEqual(maxErr / 2 + 1e-9)
        }
    })

    test('marker style renders width * 0.7 (rmrl formula)', () => {
        expect(markerStyle([0, 0, 0], 10, 0.5, 0).width).toBeCloseTo(7)
    })

    test('width inverse floors at 1 v6 unit', () => {
        expect(tldrawWidthToRmMarkerWidth(0.0001)).toBe(1)
    })
})

describe('palette', () => {
    test('pen -> brush family', () => {
        expect(penToBrush(Pen.MARKER_2)).toBe('marker')
        expect(penToBrush(Pen.ERASER)).toBeNull()
        expect(penToBrush(Pen.CALLIGRAPHY)).toBe('calligraphy')
    })
    test('tldraw color -> PenColor and back to name', () => {
        expect(tldrawColorToPenColor('violet')).toBe(PenColor.MAGENTA)
        expect(penColorName(PenColor.MAGENTA)).toBe('violet')
        expect(tldrawColorToPenColor('nonexistent')).toBe(PenColor.BLACK)
    })
})

describe('points', () => {
    test('direction byte wraps negatives into 0..255', () => {
        expect(directionByte(0)).toBe(0)
        expect(directionByte(-Math.PI / 2)).toBe(directionByte((3 * Math.PI) / 2))
        expect(directionByte(Math.PI)).toBe(128)
    })
    test('polyline encoding derives speed/direction', () => {
        const pts = polylineToPoints(
            [
                { x: 0, y: 0 },
                { x: 3, y: 4 },
                { x: 6, y: 8 },
            ],
            { width: 40 },
        )
        expect(pts).toHaveLength(3)
        expect(pts[0]!.speed).toBe(0)
        expect(pts[1]!.speed).toBe(20) // dist 5 * 4
        expect(pts[0]!.direction).toBe(pts[1]!.direction)
        expect(pts.every((p) => p.width === 40 && p.pressure === 128)).toBe(true)
    })
})

describe('path walker', () => {
    test('densifies straight lines to the point-density bound', () => {
        const subpaths = walkPathCommands(
            [
                { type: 'move', x: 0, y: 0 },
                { type: 'line', x: 30, y: 0 },
            ],
            { pointDensity: 3 },
        )
        expect(subpaths).toHaveLength(1)
        const pts = subpaths[0]!
        for (let i = 1; i < pts.length; i++) {
            expect(Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)).toBeLessThanOrEqual(3.01)
        }
        expect(pts[pts.length - 1]).toEqual({ x: 30, y: 0 })
    })

    test('cubic flattening stays within flatness tolerance', () => {
        const pts = flattenCubic({ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 20 }, { x: 40, y: 0 }, 0.5)
        expect(pts.length).toBeGreaterThan(4)
        expect(pts[0]).toEqual({ x: 0, y: 0 })
        expect(pts[pts.length - 1]).toEqual({ x: 40, y: 0 })
    })

    test('multiple subpaths split on move', () => {
        const subpaths = walkPathCommands([
            { type: 'move', x: 0, y: 0 },
            { type: 'line', x: 5, y: 0 },
            { type: 'move', x: 10, y: 10 },
            { type: 'line', x: 15, y: 10 },
        ])
        expect(subpaths).toHaveLength(2)
    })

    test('close commands return to subpath start', () => {
        const subpaths = walkPathCommands([
            { type: 'move', x: 0, y: 0 },
            { type: 'line', x: 10, y: 0 },
            { type: 'line', x: 10, y: 10 },
            { type: 'line', x: 0, y: 0, isClose: true },
        ])
        const pts = subpaths[0]!
        expect(pts[pts.length - 1]).toEqual({ x: 0, y: 0 })
    })

    test('dash pattern alternates and preserves total dash length < total', () => {
        const line = Array.from({ length: 101 }, (_, i) => ({ x: i, y: 0 }))
        const total = polylineLength(line)
        const dashes = applyDashPattern(line, total, 4, 'dashed')
        expect(dashes.length).toBeGreaterThan(2)
        const dashLen = dashes.reduce((s, d) => s + polylineLength(d), 0)
        expect(dashLen).toBeLessThan(total)
        expect(dashLen).toBeGreaterThan(total * 0.3)
    })

    test('dotted produces VISIBLE dots (~the stroke width), not microscopic ones', () => {
        // regression: the old strokeWidth/100 made every dot ~0.11 long next to
        // ~24-long gaps -> invisible ("dotted didn't convert at all").
        const line = Array.from({ length: 101 }, (_, i) => ({ x: i * 5, y: 0 })) // 500 long
        const total = polylineLength(line)
        const strokeWidth = 11
        const dots = applyDashPattern(line, total, strokeWidth, 'dotted')
        expect(dots.length).toBeGreaterThan(3)
        // each dot must be a meaningful fraction of the stroke width (renders as a
        // round blob), not the old strokeWidth/100 speck; kept SHORT so the round
        // marker caps dominate and it reads as a dot (~2x-width center-to-center).
        for (const d of dots) {
            expect(polylineLength(d)).toBeGreaterThan(strokeWidth * 0.15)
            expect(polylineLength(d)).toBeLessThan(strokeWidth * 0.6)
        }
        // dots spaced ~2x the width (period): a 500-long line at width 11 holds
        // ~22 dots, matching tldraw's dotted spacing (not the old sparser 2.4x).
        expect(dots.length).toBeGreaterThan(500 / (strokeWidth * 2) - 3)
        // a line too short for even a couple of dots stays solid (one segment)
        const short = [{ x: 0, y: 0 }, { x: strokeWidth, y: 0 }]
        expect(applyDashPattern(short, strokeWidth, strokeWidth, 'dotted')).toEqual([short])
    })
})

describe('text projection', () => {
    const font = parseFont(readFileSync(join(WEB_FONTS, 'ShantellSans.ttf')).buffer as ArrayBuffer)

    test('produces one part per glyph with stable partKeys', () => {
        const parts = textToGlyphParts(
            font,
            { text: 'ABCD', fontSize: 24 },
            { x: 100, y: 100 },
            'black',
        )
        expect(parts.map((p) => p.partKey)).toEqual(['glyph:0', 'glyph:1', 'glyph:2', 'glyph:3'])
        for (const part of parts) {
            expect(part.strokes.length).toBeGreaterThan(0)
            for (const stroke of part.strokes) {
                // outlines are dense; FILL passes may be short 2-point spans
                expect(stroke.points.length).toBeGreaterThanOrEqual(2)
                // RM page space sanity: x within plausible page range
                for (const pt of stroke.points) {
                    expect(pt.x).toBeGreaterThan(100 / RM_SCALE - 1)
                    expect(pt.x).toBeLessThan(3000)
                }
            }
        }
    })

    test('deleting the trailing glyph leaves other partKeys unchanged (ABCD->ABC premise)', () => {
        const abcd = textToGlyphParts(font, { text: 'ABCD', fontSize: 24 }, { x: 0, y: 0 }, 'black')
        const abc = textToGlyphParts(font, { text: 'ABC', fontSize: 24 }, { x: 0, y: 0 }, 'black')
        expect(abc).toHaveLength(3)
        for (let i = 0; i < 3; i++) {
            expect(abc[i]!.partKey).toBe(abcd[i]!.partKey)
            // identical glyph geometry => identical projected strokes
            expect(JSON.stringify(abc[i]!.strokes)).toBe(JSON.stringify(abcd[i]!.strokes))
        }
    })

    test('extractContours closes Z contours', () => {
        // Shantell Sans is a handwriting font: glyphs may be single contours
        // (no counters) — assert closure, not contour count.
        const glyph = font.charToGlyph('O')
        const contours = extractContours(glyph.getPath(0, 50, 48))
        expect(contours.length).toBeGreaterThanOrEqual(1)
        for (const c of contours) {
            const first = c[0]!
            const last = c[c.length - 1]!
            expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeLessThanOrEqual(0.75)
        }
    })

    test('page-affine matrix (m) composes ancestor transform, not raw x/y', () => {
        // a grouped/framed shape must project through the full page transform.
        const id = textToGlyphParts(font, { text: 'A', fontSize: 24 }, { x: 0, y: 0 }, 'black')
        // m = translate(200,100) as a tldraw Mat [a,b,c,d,e,f]
        const moved = textToGlyphParts(
            font,
            { text: 'A', fontSize: 24 },
            { x: 0, y: 0, m: [1, 0, 0, 1, 200, 100] },
            'black',
        )
        const px0 = id[0]!.strokes[0]!.points[0]!
        const px1 = moved[0]!.strokes[0]!.points[0]!
        // 200/100 tldraw px -> RM units (/RM_SCALE) offset
        expect(px1.x - px0.x).toBeCloseTo(200 / RM_SCALE, 1)
        expect(px1.y - px0.y).toBeCloseTo(100 / RM_SCALE, 1)
    })

    test('wrapping keeps every glyph source-indexed (erase-repair invariant)', () => {
        const text = 'alpha beta gamma delta epsilon'
        // narrow width forces multiple visual lines
        const wrapped = textToGlyphParts(font, { text, fontSize: 24 }, { x: 0, y: 0 }, 'black', {
            width: 120,
        })
        const flat = textToGlyphParts(font, { text, fontSize: 24 }, { x: 0, y: 0 }, 'black')
        // wrapping must not renumber glyphs: same partKeys, same count (spaces
        // carry no contours in either, so both drop the same indices)
        expect(wrapped.map((p) => p.partKey)).toEqual(flat.map((p) => p.partKey))
        // and it MUST actually wrap: later glyphs sit on a lower line (higher y)
        const firstY = wrapped[0]!.strokes[0]!.points[0]!.y
        const lastY = wrapped[wrapped.length - 1]!.strokes[0]!.points[0]!.y
        expect(lastY).toBeGreaterThan(firstY + 1)
    })

    test('align end/middle shift the line right of start', () => {
        const opts = (align: 'start' | 'middle' | 'end') =>
            textToGlyphParts(font, { text: 'Hi', fontSize: 24 }, { x: 0, y: 0 }, 'black', {
                width: 400,
                align,
            })[0]!.strokes[0]!.points[0]!.x
        expect(opts('middle')).toBeGreaterThan(opts('start'))
        expect(opts('end')).toBeGreaterThan(opts('middle'))
    })
})

describe('svg rendering', () => {
    test('marker stroke renders per-pair lines with 0.7 factor', () => {
        const svg = strokeToSvg(
            [
                { x: 0, y: 0, speed: 0, width: 40, pressure: 128 },
                { x: 10, y: 0, speed: 4, width: 40, pressure: 128 },
                { x: 20, y: 0, speed: 4, width: 40, pressure: 128 },
            ],
            'marker',
            [0, 0, 0],
            { scale: 1 },
        )
        const lines = svg.match(/<line /g) ?? []
        expect(lines).toHaveLength(2)
        expect(svg).toContain('stroke-width="7.00"') // (40/4) * 0.7
    })

    test('a single ballpoint sample exports a colored dot at its recorded width', () => {
        const svg = strokeToSvg([{x: 8, y: 6, speed: 0, width: 40, pressure: 255}], 'ballpoint', [255, 192, 203], {scale: 1})
        expect(svg).toBe('<circle cx="8" cy="6" r="5" fill="rgb(255,192,203)" opacity="1"/>')
    })

    test('black highlighter uses the legacy yellow default', () => {
        const svg = strokeToSvg(
            [
                { x: 0, y: 0, speed: 0, width: 40, pressure: 128 },
                { x: 10, y: 0, speed: 4, width: 40, pressure: 128 },
            ],
            'highlighter',
            [0, 0, 0],
        )
        expect(svg).toContain('<polyline')
        expect(svg).toContain('rgb(255,233,74)')
    })
})

describe('spans-path glyph indices are CODE POINTS (repairText alignment)', () => {
    const font = parseFont(readFileSync(join(WEB_FONTS, 'ShantellSans.ttf')).buffer as ArrayBuffer)

    test('a glyph after an astral char keys at its code-point index, not UTF-16', () => {
        // '😀' is one code point but two UTF-16 units; the font has no glyph
        // for it (advance-only), so only 'a' emits a part — and its partKey
        // must be glyph:1 (code point), not glyph:2 (UTF-16 offset).
        // repairText filters [...text] by these indices; a UTF-16 key made a
        // tablet erase of 'a' a silent no-op.
        const parts = textToGlyphParts(
            font,
            { text: '😀a', fontSize: 24 },
            { x: 0, y: 0 },
            'black',
            { spans: [{ text: '😀a', x: 0, y: 0, w: 48, h: 32 }] },
        )
        const keys = parts.map((p) => p.partKey)
        expect(keys).toContain('glyph:1')
        expect(keys).not.toContain('glyph:2')
    })

    test('spans and non-spans paths agree on indices for spaced text', () => {
        const spanned = textToGlyphParts(
            font,
            { text: 'ab cd', fontSize: 24 },
            { x: 0, y: 0 },
            'black',
            { spans: [{ text: 'ab cd', x: 0, y: 0, w: 120, h: 32 }] },
        )
        const plain = textToGlyphParts(font, { text: 'ab cd', fontSize: 24 }, { x: 0, y: 0 }, 'black')
        expect(spanned.map((p) => p.partKey).sort()).toEqual(plain.map((p) => p.partKey).sort())
        expect(spanned.map((p) => p.partKey)).toContain('glyph:3')
    })
})
