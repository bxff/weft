import { expect, test } from 'bun:test'
import type { Font } from 'opentype.js'
import { RM_SCALE } from '../src/pen'
import { textToGlyphParts, type GlyphPart, type MeasuredSpan } from '../src/text'

function font(advance: number, top: number, paths: { text: string; x: number; y: number }[] = []): Font {
    return {
        unitsPerEm: 1000, ascender: top, descender: -200,
        tables: { post: { underlinePosition: -100, underlineThickness: 50 },
            os2: { yStrikeoutPosition: 350, yStrikeoutSize: 60 } },
        charToGlyph: (text: string) => ({
            advanceWidth: advance,
            getPath: (x: number, y: number, size: number) => {
                paths.push({ text, x, y })
                const w = advance * size / 1300
                return { commands: /\s/.test(text) ? [] : [
                    { type: 'M', x, y },
                    { type: 'L', x: x + w, y },
                    { type: 'L', x: x + w, y: y - top * size / 1000 },
                    { type: 'L', x, y: y - top * size / 1000 },
                    { type: 'Z' },
                ] }
            },
        }),
    } as unknown as Font
}
const shape = { x: 0, y: 0, rotation: 0 }
const make = (f: Font, text: string, spans: MeasuredSpan[], transform = shape) =>
    textToGlyphParts(f, { text, fontSize: 20 }, transform, 'black', { spans })
const approx = (part: GlyphPart) => part.strokes.at(-1)!.points.map(({ x, y }) =>
    [Math.round(x * RM_SCALE * 100) / 100, Math.round(y * RM_SCALE * 100) / 100])

test('a measured styled span uses its supplied face, baseline and pen positions', () => {
    const plain: { text: string; x: number; y: number }[] = []
    const alternate: typeof plain = []
    const regular = font(450, 800, plain)
    const styled = font(750, 700, alternate)
    const parts = make(regular, 'ABCD', [
        { text: 'A', x: 0, y: 1, w: 8, h: 26 },
        { text: 'BC', x: 8, y: 1, w: 22, h: 26, font: styled, baseline: 19.35, offsets: [0, 10.25] },
        { text: 'D', x: 30, y: 1, w: 8, h: 26 },
    ])
    expect(parts.map(p => p.partKey)).toEqual(['glyph:0', 'glyph:1', 'glyph:2', 'glyph:3'])
    expect(plain.map(p => p.text)).toEqual(['A', 'D'])
    expect(alternate).toEqual([{ text: 'B', x: 8, y: 19.35 }, { text: 'C', x: 18.25, y: 19.35 }])
})

test('underlining follows measured positions, marked spaces and wraps without consuming a fake spacer', () => {
    const regular = font(650, 800)
    const parts = make(regular, 'A B\nC', [
        { text: 'A B', x: 3.25, y: 2, w: 25.5, h: 24, baseline: 19.5, offsets: [0, 9.75, 15.5],
            decorations: { underline: true } },
        { text: ' ', x: 11, y: 27, w: 5, h: 24, baseline: 40, decorations: { underline: true } },
        { text: 'C', x: 3.25, y: 51, w: 10, h: 24, baseline: 68, decorations: { underline: true } },
    ])
    expect(parts.map(p => p.partKey)).toEqual(['glyph:0', 'glyph:1', 'glyph:2', 'glyph:4'])
    expect(parts[1]?.strokes).toHaveLength(1)
    expect(parts.map(approx)).toEqual([
        [[3.25, 21.5], [13, 21.5]], [[13, 21.5], [18.75, 21.5]], [[18.75, 21.5], [28.75, 21.5]],
        [[3.25, 70], [13.25, 70]],
    ])
})

test('a rotated struck and underlined span retains both native strokes under the glyph key', () => {
    const f = font(650, 800)
    const span = { text: 'X', x: 2, y: 3, w: 9, h: 22, baseline: 20 }
    const [plain] = make(f, 'X', [span], { x: 100, y: 55, rotation: Math.PI / 2 })
    const [marked] = make(f, 'X', [{ ...span, decorations: { underline: true, strike: true } }],
        { x: 100, y: 55, rotation: Math.PI / 2 })
    expect(marked?.partKey).toBe('glyph:0')
    expect(marked?.strokes.slice(0, -2)).toEqual(plain?.strokes)
    const coords = marked!.strokes.slice(-2).map(stroke => approx({ partKey: 'glyph:0', strokes: [stroke] }))
    expect(coords).toEqual([[[78, 57], [78, 66]], [[87, 57], [87, 66]]])
})

test('empty decorations and the default face do not change projected ink', () => {
    const f = font(575, 800)
    const span = { text: 'x y', x: 0.125, y: 1, w: 25.75, h: 27.125, offsets: [0, 10.5, 14.25] }
    expect(make(f, 'x y', [{ ...span, font: f, decorations: {} }])).toEqual(make(f, 'x y', [span]))
})
