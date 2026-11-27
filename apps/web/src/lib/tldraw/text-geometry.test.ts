import { expect, test } from 'bun:test'
import {
    RmDocument,
    createRootText,
    crdtId,
    insertText,
    lww,
    rootTextCharPositions,
} from '@weft/rm-format'
import { paragraphsToRichText } from './device-text-richtext'
import { buildSvgLines } from './device-text-svg'
import { computeAnchorOffsets } from './text-anchor-layout'
import { INK_PER_PX, layoutText, type LayoutParagraph } from './text-metrics'

const span = (text: string, bold = false, italic = false) => ({
    text,
    bold,
    italic,
})
const para = (text: string, style = 1): LayoutParagraph => ({
    style,
    spans: [span(text)],
})
const svg = (ps: LayoutParagraph[], width: number) =>
    buildSvgLines(paragraphsToRichText(ps.map((p) => ({ ...p, startId: crdtId(0, 0) }))), width)

// Synthetic fixtures pinned to the bundled open font profile. Keep a narrower
// tolerance than 1/64 ink so accumulating even a tiny error fails near EOL.
function expectInk(actual: number, expected: number) {
    expect(Math.abs(actual - expected)).toBeLessThan(1 / 128)
}

test('absolute glyph origins and end of line stay stable across a long mixed-style run', () => {
    const p = {
        style: 1,
        spans: [
            span('Ai'.repeat(256)),
            span('Ai'.repeat(256), true),
            span('Ai'.repeat(256), false, true),
        ],
    }
    const width = 30_000
    const [line] = svg([p], width)
    const [layout] = layoutText([p], width).paras
    expect(layout!.lineStarts).toEqual([0])
    expectInk(layout!.lineWidthsInk[0]!, 22_216)
    expectInk(line!.runs[0]!.xs[511]!, 7_343.75)
    expectInk(line!.runs[1]!.xs[0]!, 7_352)
    expectInk(line!.runs[1]!.xs[511]!, 15_494.234375)
    expectInk(line!.runs[2]!.xs[0]!, 15_504)
    expectInk(line!.runs[2]!.xs[511]!, 22_211.75)
    expectInk(line!.endX, 22_220)
})

test('exact mixed-style wraps respect heading sizes, list indents, and absolute vertical geometry', () => {
    const body = {
        style: 1,
        spans: [span('Ai '), span('Ai ', true), span('Ai', false, true)],
    }
    const ps = [
        para('AA', 2),
        body,
        para('i i i i', 4),
        para('i i i i', 5),
        para('i', 7),
        { ...para('A'), sizeCode: 2 },
        { ...para('A'), sizeCode: 3 },
    ]
    const layout = layoutText(ps, 120)
    const lines = svg(ps, 120)

    expect(layout.paras.map((p) => p.lineStarts)).toEqual([
        [0],
        [0],
        [0],
        [0, 2, 4, 6],
        [0],
        [0],
        [0],
    ])
    expect(lines.map((l) => l.runs.map((r) => r.text).join(''))).toEqual([
        'AA',
        'Ai Ai Ai',
        'i i i i',
        'i ',
        'i ',
        'i ',
        'i',
        'i',
        'A',
        'A',
    ])
    const baselines = [
        63.203125, 133.59375, 203.140625, 272.6875, 318.234375, 363.78125, 409.328125, 478.875,
        568.125, 676.375,
    ]
    lines.forEach((line, i) => expectInk(line.y, baselines[i]!))
    expect(lines[2]!.marker).toEqual({ text: '•', x: 24 })
    expect(lines[3]!.marker).toEqual({ text: '◦', x: 72 })
    expect(lines.slice(4, 7).map((l) => l.marker)).toEqual([undefined, undefined, undefined])
    expect(lines[7]!.checkbox?.checked).toBe(true)
    expect(lines[7]!.strike).toEqual({ x0: 52, x1: 60.25 })
    expectInk(layout.bottomInk, 684.828125)
})

test('styled wrap changes at the measured edge and avoids splitting Unicode fallback', () => {
    const p = { style: 1, spans: [span('Ai '), span('Ai', true)] }
    // 8 margins + 28.703125 regular Ai + 8.3125 space + 31.84375 bold Ai
    const edge = 76.859375
    expect(layoutText([p], edge).paras[0]!.lineStarts).toEqual([0])
    expect(layoutText([p], edge - 1 / 64).paras[0]!.lineStarts).toEqual([0, 3])

    const seen: string[] = []
    const unicode = {
        style: 1,
        spans: [span('😀', true), span('e\u0301😀', false, true)],
    }
    const [result] = layoutText([unicode], 30, (ch, font) => {
        seen.push(ch)
        return (font.startsWith('700 ') ? 32 : 24) / INK_PER_PX
    }).paras
    expect(seen).toEqual(['😀', '😀'])
    expect(result!.lineStarts).toEqual([0, 2, 4])
    expectInk(result!.lineWidthsInk[0]!, 32)
    expectInk(result!.lineWidthsInk[2]!, 24)
})

test.each([
    ['A i A', 28, [0, 2, 4]],
    ['😀i A', 31.5, [0, 2, 4]],
] as const)(
    'a serialized anchor after wrapping %s keeps the absolute baseline',
    (text, width, starts) => {
        const author = 'aaaa0000-0000-4000-a000-000000000001'
        const doc = RmDocument.empty(author)
        createRootText(doc, { posX: -419, posY: 271.25, width })
        insertText(doc, null, text, { authorUuid: author })
        const lastChar = rootTextCharPositions(doc.rootTextBlock!.text).at(-1)!
        const group = doc.blocks.find((b) => b.type === 'treeNode' && b.nodeId.part2 === 11)
        if (group?.type !== 'treeNode') throw new Error('missing layer')
        const ts = crdtId(1, 1000)
        group.anchorId = lww(ts, lastChar.id)
        group.anchorType = lww(ts, 2)
        group.anchorOriginX = lww(ts, -419)
        group.anchorThreshold = lww(ts, 0)
        const restored = RmDocument.parse(doc.serialize())
        const offset = computeAnchorOffsets(restored).get('0:11')
        expect(layoutText([para(text)], width).paras[0]!.lineStarts).toEqual([...starts])
        expect(offset).toEqual({ dx: -419, dy: 395.9375 })
        expect(rootTextCharPositions(restored.rootTextBlock!.text).at(-1)?.offset).toBe(4)
    },
)
