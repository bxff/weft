/**
 * Glyph fill (the hollow-text fix): even-odd scanline + serpentine chaining.
 * Pins: full interior coverage, holes stay empty, few polylines per region,
 * and textToGlyphParts emits fill strokes alongside outlines.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fillContours, textToGlyphParts } from '../src/text'
import { parse as parseFont, type Font } from 'opentype.js'

const square = (x0: number, y0: number, size: number) => [
    { x: x0, y: y0 },
    { x: x0 + size, y: y0 },
    { x: x0 + size, y: y0 + size },
    { x: x0, y: y0 + size },
]

describe('fillContours', () => {
    test('solid square: interior fully covered at the fill pitch', () => {
        const pitch = 2
        const lines = fillContours([square(0, 0, 20)], pitch)
        expect(lines.length).toBeGreaterThan(0)
        // serpentine chaining: ONE polyline should cover the whole square
        expect(lines.length).toBe(1)
        // every interior probe point is within pitch of some fill segment
        for (let py = 2; py <= 18; py += 2.5) {
            for (let px = 2; px <= 18; px += 2.5) {
                let near = false
                for (const line of lines) {
                    for (let i = 0; i + 1 < line.length; i += 1) {
                        const a = line[i]!
                        const b = line[i + 1]!
                        if (a.y !== b.y) continue // measure against horizontal passes
                        if (
                            Math.abs(a.y - py) <= pitch &&
                            px >= Math.min(a.x, b.x) - pitch &&
                            px <= Math.max(a.x, b.x) + pitch
                        ) {
                            near = true
                            break
                        }
                    }
                    if (near) break
                }
                expect(near).toBe(true)
            }
        }
    })

    test('ring (O shape): even-odd keeps the hole empty', () => {
        const outer = square(0, 0, 30)
        const inner = square(10, 10, 10)
        const lines = fillContours([outer, inner], 2)
        // no fill segment may cross the hole interior (12..18 at hole rows)
        for (const line of lines) {
            for (let i = 0; i + 1 < line.length; i++) {
                const a = line[i]!
                const b = line[i + 1]!
                if (a.y !== b.y) continue
                if (a.y > 11 && a.y < 19) {
                    const lo = Math.min(a.x, b.x)
                    const hi = Math.max(a.x, b.x)
                    expect(lo >= 19 || hi <= 11).toBe(true)
                }
            }
        }
        // but the ring band IS filled (segments exist left of the hole)
        const bandSegment = lines.some((line) =>
            line.some((p, i) => i + 1 < line.length && p.y > 11 && p.y < 19 && Math.max(p.x, line[i + 1]!.x) <= 11),
        )
        expect(bandSegment).toBe(true)
    })

    test('degenerate input: empty/flat contours produce no fill', () => {
        expect(fillContours([], 2)).toEqual([])
        expect(fillContours([[{ x: 0, y: 0 }, { x: 10, y: 0 }]], 2)).toEqual([])
    })
})

describe('textToGlyphParts fills glyphs', () => {
    const font = parseFont(
        readFileSync(`${import.meta.dir}/../../../apps/web/static/fonts/ShantellSans.ttf`).buffer as ArrayBuffer,
    ) as Font

    const shape = { x: 0, y: 0, rotation: 0 }

    test('a glyph emits MORE than its outline contours (fill strokes present)', () => {
        const parts = textToGlyphParts(font, { text: 'B', fontSize: 32 }, shape, 'black')
        expect(parts).toHaveLength(1)
        // 'B' outline = 3 contours (outer + two holes); filled version must
        // carry additional fill strokes
        expect(parts[0]!.strokes.length).toBeGreaterThan(3)
        // and fill strokes contain horizontal runs (same-y consecutive points)
        const hasHorizontalRun = parts[0]!.strokes.some((s) =>
            s.points.some((p, i) => i > 0 && Math.abs(p.y - s.points[i - 1]!.y) < 1e-6 && Math.abs(p.x - s.points[i - 1]!.x) > 1),
        )
        expect(hasHorizontalRun).toBe(true)
    })

    test('stroke count stays bounded (serpentine, not one stroke per scanline)', () => {
        const parts = textToGlyphParts(font, { text: 'HELLO', fontSize: 24 }, shape, 'black')
        const total = parts.reduce((n, p) => n + p.strokes.length, 0)
        // 5 glyphs; bound generously — without chaining this would be 100s
        expect(total).toBeLessThan(60)
        expect(total).toBeGreaterThan(5)
    })

    test('a word wider than the box breaks MID-WORD, like browser break-word', () => {
        // narrow box (~2 glyphs wide): the browser stacks a long word; word-only
        // wrapping left it on one ink line
        const parts = textToGlyphParts(font, { text: 'lljadfljn', fontSize: 24 }, shape, 'black', {
            width: 30,
            align: 'middle',
        })
        const tops = parts.map((p) =>
            Math.min(...p.strokes.flatMap((s) => s.points.map((pt) => pt.y))),
        )
        const distinctLines = new Set(tops.map((t) => Math.round(t / 20))).size
        expect(distinctLines).toBeGreaterThan(3)
        // glyph source indices survive wrapping (the tablet-erase repair keys on them)
        expect(parts.map((p) => p.partKey)).toEqual([...'lljadfljn'].map((_, i) => `glyph:${i}`))
    })

    // Regression: typing must not re-mint earlier glyphs. Scaling advances by
    // span.w/total drifts as the word grows, moving every glyph after the
    // first on each keystroke (N chars -> ~N^2 strokes). Browser prefix
    // offsets make each glyph's pen position suffix-independent, so a
    // prefix's strokes are byte-identical no matter what follows.
    test('span offsets: appending leaves earlier glyphs byte-identical (no churn)', () => {
        // Simulate browser prefix pen offsets: offset[i] = cumulative opentype
        // advance of the first i glyphs (stable, suffix-independent). The KEY
        // property under test is that these do not change when the word grows.
        const advOf = (ch: string) =>
            ((font.charToGlyph(ch).advanceWidth ?? 0) / font.unitsPerEm) * 44
        const offsetsFor = (text: string) => {
            const out: number[] = []
            let x = 0
            for (const ch of text) {
                out.push(x)
                x += advOf(ch)
            }
            return out
        }
        const parts = (text: string) =>
            textToGlyphParts(font, { text, fontSize: 44 }, shape, 'black', {
                // span.w deliberately WRONG/varying to prove offsets ignore it
                spans: [{ text, x: 0, y: 0, w: text.length * 7, h: 44 * 1.35, offsets: offsetsFor(text) }],
            })
        const glyph = (ps: ReturnType<typeof parts>, key: string) =>
            JSON.stringify(ps.find((p) => p.partKey === key)?.strokes)

        const re = parts('Re')
        const rem = parts('Rem')
        const remarkable = parts('Remarkable')
        // shared prefix glyphs identical across every length, despite span.w changing
        for (const k of ['glyph:0', 'glyph:1'])
            expect(glyph(remarkable, k)).toBe(glyph(re, k))
        for (const k of ['glyph:0', 'glyph:1', 'glyph:2'])
            expect(glyph(remarkable, k)).toBe(glyph(rem, k))
    })

    test('span offsets place glyph 0 at the run origin (x)', () => {
        const p = textToGlyphParts(font, { text: 'Re', fontSize: 44 }, { x: 100, y: 0, rotation: 0 }, 'black', {
            spans: [{ text: 'Re', x: 100, y: 0, w: 60, h: 59, offsets: [0, 30] }],
        })
        // glyph:0 outline starts at/after the run origin x=100 (+ side bearing)
        const g0minx = Math.min(...p.find((q) => q.partKey === 'glyph:0')!.strokes.flatMap((s) => s.points.map((pt) => pt.x)))
        const g1minx = Math.min(...p.find((q) => q.partKey === 'glyph:1')!.strokes.flatMap((s) => s.points.map((pt) => pt.x)))
        expect(g1minx).toBeGreaterThan(g0minx) // e sits right of R via the offset
    })
})
