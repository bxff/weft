/**
 * Device text layout + anchor line resolution. Strides pinned to device
 * constants (read from xochitl's own PDF exports): body wrapped lines
 * 45.546875 ink apart, paragraph steps 69.546875, heading stride 76 with
 * step(32->64) = 163.15625.
 */
import { expect, test } from 'bun:test'
import { layoutText, metricsFor, penPositions, PARA_STRIDE_INK, type MeasureFn } from './text-metrics'
import { paragraphsToRichText } from './device-text-richtext'
import { buildSvgLines } from './device-text-svg'
import { computeAnchorOffsets, lineTopOf } from './text-anchor-layout'
import {
    ANCHOR_TEXT_START,
    ANCHOR_TEXT_END,
    RmDocument,
    createRootText,
    insertText,
    setParagraphStyle,
    crdtId,
    crdtIdKey,
    lww,
    type TextParagraph,
} from '@weft/rm-format'

// deterministic metrics: every char 10px wide
const measure: MeasureFn = (text) => text.length * 10

const para = (text: string, style = 1): TextParagraph => ({
    startId: { part1: 0, part2: 0 },
    style,
    spans: text ? [{ text, bold: false, italic: false }] : [],
})

test('empty paragraphs stack one PARA_STRIDE each', () => {
    const { paras, lastLineTopInk } = layoutText(
        Array.from({ length: 20 }, () => para('')),
        936,
        measure,
    )
    expect(paras[9]!.topInk).toBeCloseTo(9 * PARA_STRIDE_INK, 3)
    expect(lastLineTopInk).toBeCloseTo(19 * PARA_STRIDE_INK, 3)
})

test('wrapped lines stride 45.546875; the paragraph break costs 69.546875', () => {
    const { paras } = layoutText([para('word '.repeat(30).trim()), para('x')], 936, measure)
    const lines = paras[0]!.lineStarts.length
    expect(lines).toBeGreaterThan(1)
    expect(paras[0]!.lineStrideInk).toBe(45.546875)
    // next paragraph starts one PARA_STRIDE below the previous LAST line top
    expect(paras[1]!.topInk).toBeCloseTo((lines - 1) * 45.546875 + PARA_STRIDE_INK, 3)
})

test('headings stride 76 with the PDF-exact 32->64 step above', () => {
    const { paras } = layoutText([para('body'), para('heading text', 2)], 936, measure)
    expect(paras[1]!.lineStrideInk).toBe(76)
    // heading first baseline = body baseline 33.59375 + step(32->64)
    // 163.15625; line-box top = baseline - 63.203125
    expect(paras[1]!.topInk).toBeCloseTo(33.59375 + 163.15625 - 63.203125, 3)
})

test('a char offset resolves to its wrapped line top', () => {
    const { paras } = layoutText([para('aaaa bbbb cccc dddd')], 160, measure)
    const l = paras[0]!
    expect(l.lineStarts.length).toBeGreaterThanOrEqual(2)
    expect(lineTopOf(paras, 0, 0, -1)).toBeCloseTo(l.topInk, 3)
    const secondLineChar = l.lineStarts[1]!
    expect(lineTopOf(paras, 0, secondLineChar, -1)).toBeCloseTo(l.topInk + 45.546875, 3)
    // the '\n' opening the paragraph resolves to the paragraph top
    expect(lineTopOf(paras, 0, -1, -1)).toBeCloseTo(l.topInk, 3)
    // unknown paragraph falls back
    expect(lineTopOf(paras, 5, 0, 1234)).toBe(1234)
})

test('first paragraph line box sits at the column top for every size', () => {
    // no margin above the first paragraph, whatever its size
    for (const style of [1, 2]) {
        const { paras } = layoutText([para('first para', style)], 936, measure)
        expect(paras[0]!.topInk).toBe(0)
    }
})

function sentinelDocument(anchor = ANCHOR_TEXT_START, firstStyle = 2, text = '\n') {
    const author = 'aaaa0000-0000-4000-a000-000000000001'
    const doc = RmDocument.empty(author)
    createRootText(doc)
    insertText(doc, null, text, { authorUuid: author })
    setParagraphStyle(doc, crdtId(0, 0), firstStyle, { authorUuid: author })
    const group = doc.blocks.find((b) => b.type === 'treeNode' && b.nodeId.part2 === 11)!
    if (group.type !== 'treeNode') throw new Error('missing layer')
    const ts = crdtId(1, 1000)
    group.anchorId = lww(ts, anchor)
    group.anchorType = lww(ts, 2)
    group.anchorThreshold = lww(ts, 35.74803161621094)
    group.anchorOriginX = lww(ts, -464)
    return RmDocument.parse(doc.serialize())
}

test('Mako START regression: heading/body empty paragraphs anchor at y=334, not 367.59375', () => {
    // Reconstruct only the relevant metadata; no private handwriting fixture.
    const doc = sentinelDocument()
    const bytes = doc.serialize()
    const group = doc.anchoredGroups()[0]!
    expect(group.anchorType).toBe(2)
    expect(computeAnchorOffsets(doc, measure).get(crdtIdKey(group.nodeId))).toEqual({
        dx: -464,
        dy: 334,
    })
    expect(doc.serialize()).toEqual(bytes)
})

test('body/body START follows the second paragraph top without adding its baseline', () => {
    const doc = sentinelDocument(ANCHOR_TEXT_START, 1)
    expect(computeAnchorOffsets(doc, measure).get('0:11')?.dy).toBe(303.546875)
})

test('type-2 END still uses the line top for a trailing empty paragraph', () => {
    const doc = sentinelDocument(ANCHOR_TEXT_END)
    expect(doc.anchoredGroups()[0]!.anchorType).toBe(2)
    expect(computeAnchorOffsets(doc, measure).get('0:11')?.dy).toBe(334)
})

test('single-paragraph START retains its existing fallback', () => {
    const doc = sentinelDocument(ANCHOR_TEXT_START, 1, 'body')
    expect(computeAnchorOffsets(doc, measure).get('0:11')?.dy).toBe(337.140625)
})

test('type-2 END below one visible heading follows the heading baseline', () => {
    const doc = sentinelDocument(ANCHOR_TEXT_END, 2, 'A sample heading')
    const original = doc.serialize()
    expect(computeAnchorOffsets(doc, measure).get('0:11')).toEqual({
        dx: -464,
        dy: 297.203125,
    })
    expect(doc.serialize()).toEqual(original)
})

test('legacy END without anchor type retains line-top placement on visible text', () => {
    const doc = sentinelDocument(ANCHOR_TEXT_END, 2, 'A sample heading')
    const group = doc.blocks.find((block) => block.type === 'treeNode' && block.anchorId)
    if (group?.type !== 'treeNode') throw new Error('missing anchored group')
    group.anchorType = null
    expect(computeAnchorOffsets(doc, measure).get('0:11')?.dy).toBe(234)
})

test('styled text wraps using the painted advances', () => {
    const text = 'heading heading'
    const normal = para(text)
    const strong = { ...normal, spans: [{ text, bold: true, italic: false }] }
    const m = metricsFor(1)
    const advance = penPositions(text, m).end
    const boldAdvance = penPositions(text, m, strong.spans[0]!).end
    expect(boldAdvance).toBeGreaterThan(advance)
    const width = 8 + (advance + boldAdvance) / 2
    expect(layoutText([normal], width).paras[0]!.lineStarts).toEqual([0])
    expect(layoutText([strong], width).paras[0]!.lineStarts).toEqual([0, 8])
})

test('wrapping never splits a surrogate pair or combining cluster, even when oversized', () => {
    const text = '🙂e\u0301🙂'
    const p = para(text)
    // Make the fallback advance greater than the frame's usable width.
    const starts = layoutText([p], 10, measure).paras[0]!.lineStarts
    expect(starts).toEqual([0, 2, 4])
})


test('mixed styled runs share their wraps and painted widths with the SVG', () => {
    const normal = para('heading heading')
    const p = { ...normal, spans: [
        { text: 'heading ', bold: false, italic: false },
        { text: 'heading', bold: true, italic: false },
    ] }
    const m = metricsFor(1)
    const normalWidth = penPositions(normal.spans[0]!.text, m).end
    const before = penPositions(p.spans[0]!.text, m).end
    const after = penPositions(p.spans[1]!.text, m, p.spans[1]).end
    const width = 8 + (normalWidth + before + after) / 2
    const parsed = layoutText([p], width).paras[0]!
    expect(parsed.lineStarts).toEqual([0, 8])
    const lines = buildSvgLines(paragraphsToRichText([p]), width)
    expect(lines.map((line) => line.runs.map((run) => run.text).join(''))).toEqual([
        'heading ',
        'heading',
    ])
    lines.forEach((line, i) =>
        expect(line.endX - line.startX).toBeCloseTo(parsed.lineWidthsInk[i]!, 10),
    )
})

test('ordinary whitespace and hyphen breaks keep UTF-16 positions', () => {
    const m = metricsFor(1)
    const width = 8 + Math.max(penPositions('hello-', m).end, penPositions('world', m).end) + 0.1
    expect(layoutText([para('hello-world    ')], width).paras[0]!.lineStarts).toEqual([0, 6])
    const withSpaces = layoutText([para('hello    ')], width).paras[0]!
    expect(withSpaces.lineStarts).toEqual([0])
    expect(withSpaces.lineWidthsInk).toEqual([penPositions('hello', m).end])
    expect(layoutText([para('     ')], width).paras[0]!.lineWidthsInk).toEqual([0])
})

test('older browsers without Segmenter keep a Unicode paragraph intact', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')!
    try {
        Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: undefined })
        expect(layoutText([para('🙂e\u0301🙂')], 10, measure).paras[0]!.lineStarts).toEqual([0])
        expect(layoutText([para('abc')], 10, measure).paras[0]!.lineStarts).toEqual([0, 1, 2])
    } finally {
        Object.defineProperty(Intl, 'Segmenter', descriptor)
    }
})

test('unsupported glyph geometry stays deterministic without a browser canvas', () => {
    const p = para('🙂🙂')
    const width = 36
    const layout = layoutText([p], width).paras[0]!
    const svg = buildSvgLines(paragraphsToRichText([p]), width)
    expect(svg.map((line) => line.runs.map((run) => run.text).join(''))).toEqual(['🙂', '🙂'])
    svg.forEach((line, i) =>
        expect(line.endX - line.startX).toBeCloseTo(layout.lineWidthsInk[i]!, 10),
    )
})
