/**
 * RootText linearization pins: per-char id expansion, paragraph anchoring
 * ('\n' ids; first paragraph at END_MARKER), style lookup by anchor id,
 * inline bold/italic codes, deleted runs skipped but ids preserved.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CrdtSequence, crdtId, crdtIdKey, lww, ParagraphStyle, RmDocument, createRootText, insertText, insertFormatCode, deleteText, mergeRootTextInto, setParagraphStyle, writeBlocks, linearizeRootText, rootTextCharPositions, firstParagraphStyleShadows, paragraphStyleShadows } from '../src/index'
import type { Text } from '../src/index'

const E = crdtId(0, 0)

function textOf(
    items: { id: [number, number]; left: [number, number]; right: [number, number]; value: string | number; del?: number }[],
    styles: [[number, number], number][] = [],
): Text {
    return {
        kind: 'text',
        items: new CrdtSequence(
            items.map((i) => ({
                itemId: crdtId(...i.id),
                leftId: crdtId(...i.left),
                rightId: crdtId(...i.right),
                deletedLength: i.del ?? 0,
                value: i.value,
            })),
        ),
        styles: new Map(styles.map(([id, code]) => [crdtIdKey(crdtId(...id)), lww(crdtId(9, 99), code)])),
        posX: -468,
        posY: 234,
        width: 936,
    }
}

describe('linearizeRootText', () => {
    test('single run, no newlines: one paragraph anchored at END_MARKER', () => {
        const text = textOf(
            [{ id: [1, 20], left: [0, 0], right: [0, 0], value: 'Hello' }],
            [[[0, 0], ParagraphStyle.HEADING]],
        )
        const paras = linearizeRootText(text)
        expect(paras).toHaveLength(1)
        expect(paras[0]!.spans.map((s) => s.text).join('')).toBe('Hello')
        expect(paras[0]!.style).toBe(ParagraphStyle.HEADING)
        expect(crdtIdKey(paras[0]!.startId)).toBe('0:0')
    })

    test("newline ids anchor paragraph styles (implicit per-char ids)", () => {
        // 'AB\nCD' as ONE item starting at 1:10 -> '\n' has implicit id 1:12
        const text = textOf(
            [{ id: [1, 10], left: [0, 0], right: [0, 0], value: 'AB\nCD' }],
            [[[1, 12], ParagraphStyle.CHECKBOX]],
        )
        const paras = linearizeRootText(text)
        expect(paras).toHaveLength(2)
        expect(paras[0]!.spans[0]!.text).toBe('AB')
        expect(paras[1]!.spans[0]!.text).toBe('CD')
        expect(crdtIdKey(paras[1]!.startId)).toBe('1:12')
        expect(paras[1]!.style).toBe(ParagraphStyle.CHECKBOX)
        expect(paras[0]!.style).toBe(ParagraphStyle.PLAIN) // default
    })

    test('inline bold/italic codes split spans', () => {
        // 'a' [bold-on] 'b' [italic-on] 'c' [bold-off] 'd'
        const text = textOf([
            { id: [1, 1], left: [0, 0], right: [0, 0], value: 'a' },
            { id: [1, 2], left: [1, 1], right: [0, 0], value: 1 },
            { id: [1, 3], left: [1, 2], right: [0, 0], value: 'b' },
            { id: [1, 4], left: [1, 3], right: [0, 0], value: 3 },
            { id: [1, 5], left: [1, 4], right: [0, 0], value: 'c' },
            { id: [1, 6], left: [1, 5], right: [0, 0], value: 2 },
            { id: [1, 7], left: [1, 6], right: [0, 0], value: 'd' },
        ])
        const spans = linearizeRootText(text)[0]!.spans
        expect(spans).toEqual([
            { text: 'a', bold: false, italic: false },
            { text: 'b', bold: true, italic: false },
            { text: 'c', bold: true, italic: true },
            { text: 'd', bold: false, italic: true },
        ])
    })

    test('deleted runs vanish from text but keep ordering intact', () => {
        // 'AXXB' with 'XX' deleted (run of 2 starting at 1:11)
        const text = textOf([
            { id: [1, 10], left: [0, 0], right: [1, 11], value: 'A' },
            { id: [1, 11], left: [1, 10], right: [1, 13], value: '', del: 2 },
            { id: [1, 13], left: [1, 12], right: [0, 0], value: 'B' },
        ])
        const paras = linearizeRootText(text)
        expect(paras).toHaveLength(1)
        expect(paras[0]!.spans.map((s) => s.text).join('')).toBe('AB')
    })

    test('empty text: no paragraphs', () => {
        expect(linearizeRootText(textOf([]))).toEqual([])
    })

    test('trailing newline creates a final empty paragraph (cursor line)', () => {
        const text = textOf([{ id: [1, 1], left: [0, 0], right: [0, 0], value: 'A\n' }])
        const paras = linearizeRootText(text)
        expect(paras).toHaveLength(2)
        expect(paras[1]!.spans).toEqual([])
    })
})

describe('rootTextCharPositions', () => {
    test('chars report (paragraph, offset); the opening newline reports -1', () => {
        const text = textOf([{ id: [1, 10], left: [0, 0], right: [0, 0], value: 'AB\nCD' }])
        const pos = rootTextCharPositions(text)
        expect(pos.map((p) => [crdtIdKey(p.id), p.paragraphIndex, p.offset])).toEqual([
            ['1:10', 0, 0], // A
            ['1:11', 0, 1], // B
            ['1:12', 1, -1], // the '\n' that OPENS paragraph 1
            ['1:13', 1, 0], // C
            ['1:14', 1, 1], // D
        ])
    })

    test('tombstones keep their position and are flagged (anchors can point at them)', () => {
        const text = textOf([
            { id: [1, 10], left: [0, 0], right: [0, 0], value: 'A' },
            { id: [1, 11], left: [1, 10], right: [1, 13], value: '', del: 2 },
            { id: [1, 13], left: [1, 12], right: [0, 0], value: 'B' },
        ])
        const pos = rootTextCharPositions(text)
        expect(pos).toHaveLength(4)
        expect(pos[1]).toMatchObject({ paragraphIndex: 0, offset: 1, deleted: true })
        expect(pos[2]).toMatchObject({ paragraphIndex: 0, offset: 1, deleted: true })
        expect(pos[3]).toMatchObject({ paragraphIndex: 0, offset: 1 })
        expect(pos[3]!.deleted).toBeUndefined()
    })

    test('paragraph indexes always match linearizeRootText output', () => {
        const text = textOf([{ id: [1, 10], left: [0, 0], right: [0, 0], value: '\nX\n\nY' }])
        const paras = linearizeRootText(text)
        const pos = rootTextCharPositions(text)
        const maxP = Math.max(...pos.map((p) => p.paragraphIndex))
        expect(maxP).toBe(paras.length - 1)
    })
})

test('direct text edits affect the displayed column and preserve earlier native text bytes', () => {
    const authorUuid = '13370000-0000-4000-8000-000000000001'
    const doc = RmDocument.empty(authorUuid)
    createRootText(doc, { width: 100 })
    insertText(doc, null, 'hidden', { authorUuid })
    const earlier = doc.blocks.find((block) => block.type === 'rootText')!
    earlier.extraData = Uint8Array.of(0xca, 0xfe)
    const original = writeBlocks([earlier])
    const visible = RmDocument.empty(authorUuid)
    createRootText(visible, { width: 200 })
    doc.blocks.push(visible.blocks.find((block) => block.type === 'rootText')!)

    const draft = RmDocument.parse(doc.serialize())
    expect(draft.tree().rootText?.width).toBe(200)
    const first = insertText(draft, null, 'AB', { authorUuid })
    deleteText(draft, [first])
    insertFormatCode(draft, first, 1, { authorUuid })
    setParagraphStyle(draft, crdtId(0, 0), ParagraphStyle.HEADING, { authorUuid })

    const loaded = RmDocument.parse(draft.serialize())
    const text = loaded.tree().rootText!
    expect(linearizeRootText(text)[0]?.spans.map((span) => span.text).join('')).toBe('B')
    expect(loaded.rootTextBlock?.text.styles.get('0:0')?.value).toBe(ParagraphStyle.HEADING)
    expect(writeBlocks([loaded.blocks.find((block) => block.type === 'rootText')!])).toEqual(original)
})

test('concurrent edits merge the visible column without changing earlier records', () => {
    const tablet = '13370000-0000-4000-8000-000000000001'
    const browser = '13370000-0000-4000-8000-000000000002'
    const base = RmDocument.empty(tablet)
    createRootText(base, { width: 100 })
    insertText(base, null, 'hidden', { authorUuid: tablet })
    const earlier = base.rootTextBlock!
    earlier.extraData = Uint8Array.of(0xca, 0xfe)
    const earlierBytes = writeBlocks([earlier])
    const displayed = RmDocument.empty(tablet)
    createRootText(displayed, { width: 200 })
    base.blocks.push(displayed.rootTextBlock!)
    const shared = insertText(base, null, 'Visible', { authorUuid: tablet })
    const local = RmDocument.parse(base.serialize())
    const remote = RmDocument.parse(base.serialize())

    insertText(local, shared, ' browser', { authorUuid: browser })
    insertText(remote, shared, ' tablet', { authorUuid: tablet })
    mergeRootTextInto(local, remote)
    const merged = RmDocument.parse(local.serialize())
    const text = linearizeRootText(merged.tree().rootText!).flatMap(p => p.spans.map(s => s.text)).join('')
    expect(text).toContain('browser')
    expect(text).toContain('tablet')
    expect(writeBlocks([merged.blocks.find(block => block.type === 'rootText')!])).toEqual(earlierBytes)
})

test('DEVICE FIXTURE: firmware-2026 rootText (sizes + numbered lists) parses and round-trips', () => {
    // Written by xochitl after on-device edits: style entries carry
    // size/indent property pairs, styles 10/11 are numbered lists, and the
    // block has a trailing subblock the reader must keep.
    const bytes = new Uint8Array(
        readFileSync(join(import.meta.dir, '../../../fixtures/ferrari-text-sizes-numbered.rm')),
    )
    const doc = RmDocument.parse(bytes)
    expect(doc.blocks.filter((b) => b.type === 'raw')).toHaveLength(0)
    const text = doc.tree().rootText!
    const paras = linearizeRootText(text)
    expect(paras.map((p) => p.style)).toEqual([2, 3, 3, 1, 4, 5, 6, 10, 10])
    // paragraph 1 set to size "large" on the device (property 2 = 3)
    expect(paras[1]!.sizeCode).toBe(3)
    expect(paras[5]!.indentLevel).toBe(1)
    expect(paras[7]!.spans.map((s) => s.text).join('')).toBe('Musaab')
    // byte-exact round trip (extras + trailing block data preserved)
    const out = doc.serialize()
    expect(out.length).toBe(bytes.length)
    expect([...out].every((b, i) => b === bytes[i])).toBe(true)
})

describe('leading blank line (#79b)', () => {
    // 'value' as one item at 1:10 -> per-char implicit ids 1:10, 1:11, ...
    const oneItem = (value: string) =>
        textOf([{ id: [1, 10], left: [0, 0], right: [0, 0], value }])

    test('leading \\n is an empty first paragraph, not the first anchor', () => {
        const text = oneItem('\nHello')
        const paras = linearizeRootText(text)
        expect(paras).toHaveLength(2)
        // first paragraph empty, anchored at END_MARKER (not the leading \n)
        expect(paras[0]!.spans).toHaveLength(0)
        expect(crdtIdKey(paras[0]!.startId)).toBe('0:0')
        // second paragraph 'Hello', anchored at the leading \n (id 1:10)
        expect(paras[1]!.spans.map((s) => s.text).join('')).toBe('Hello')
        expect(crdtIdKey(paras[1]!.startId)).toBe('1:10')
    })

    test('N leading blanks render as N empty lines (no collapse)', () => {
        const paras = linearizeRootText(oneItem('\n\nHi'))
        expect(paras.map((p) => p.spans.map((s) => s.text).join(''))).toEqual(['', '', 'Hi'])
    })

    test('linearizer and char-position map agree (the commit guard invariant)', () => {
        for (const value of ['\nHello', '\n\nHi', 'Hello', 'A\nB\nC', '\n']) {
            const text = oneItem(value)
            const current = linearizeRootText(text)
                .map((p) => p.spans.map((s) => s.text).join(''))
                .join('\n')
            const positions = rootTextCharPositions(text).filter((c) => !c.deleted)
            // this equality is exactly what commitDeviceText asserts before it
            // mints edits; a mismatch there drops the edit
            expect(positions.length).toBe([...current].length)
        }
    })
})

describe('firstParagraphStyleShadows', () => {
    // see firstParagraphStyleShadows doc comment for the device rule
    test('returns a tombstoned first-char that carries a stale style', () => {
        // live "Hi" typed after deleting an original first char (1:100) that
        // was styled a CHECKBOX; the heading lives at END_MARKER.
        const text = textOf(
            [
                { id: [1, 100], left: [0, 0], right: [4, 10], value: 'x', del: 1 },
                { id: [4, 10], left: [1, 100], right: [0, 0], value: 'Hi' },
            ],
            [
                [[0, 0], ParagraphStyle.HEADING],
                [[1, 100], ParagraphStyle.CHECKBOX],
            ],
        )
        expect(firstParagraphStyleShadows(text)).toEqual(['1:100'])
    })

    test('excludes END_MARKER and chars with no style entry', () => {
        const text = textOf(
            [{ id: [4, 10], left: [0, 0], right: [0, 0], value: 'Hi' }],
            [[[0, 0], ParagraphStyle.HEADING]],
        )
        // only END_MARKER carries a style -> no shadows
        expect(firstParagraphStyleShadows(text)).toEqual([])
    })

    test('ignores styles that belong to LATER paragraphs', () => {
        // 'A\nB': second paragraph opener 4:11 carries a style; it must NOT be
        // treated as a first-paragraph shadow.
        const text = textOf(
            [{ id: [4, 10], left: [0, 0], right: [0, 0], value: 'A\nB' }],
            [
                [[0, 0], ParagraphStyle.HEADING],
                [[4, 11], ParagraphStyle.CHECKBOX], // the '\n' opening paragraph 2
            ],
        )
        expect(firstParagraphStyleShadows(text)).toEqual([])
    })
})

describe('paragraphStyleShadows (all paragraphs)', () => {
    // see paragraphStyleShadows doc comment for the device rule
    test('a tombstoned \\n before a live opener is the NEXT paragraph shadow', () => {
        // A [dead \n @1:20 = CHECKBOX] [live \n @1:30] B  -> "A\nB"
        // para0 = "A" (END_MARKER heading), para1 = "B"; 1:20 shadows para1.
        const text = textOf(
            [
                { id: [1, 10], left: [0, 0], right: [1, 20], value: 'A' },
                { id: [1, 20], left: [1, 10], right: [1, 30], value: '\n', del: 1 },
                { id: [1, 30], left: [1, 20], right: [1, 40], value: '\n' },
                { id: [1, 40], left: [1, 30], right: [0, 0], value: 'B' },
            ],
            [
                [[0, 0], ParagraphStyle.HEADING],
                [[1, 20], ParagraphStyle.CHECKBOX],
            ],
        )
        const m = paragraphStyleShadows(text)
        expect(m.get(0) ?? []).toEqual([]) // nothing shadows para 0 here
        expect(m.get(1)).toEqual(['1:20']) // the dead '\n' shadows para 1
    })

    test('a tombstoned first-char shadows its OWN (first) paragraph', () => {
        const text = textOf(
            [
                { id: [1, 100], left: [0, 0], right: [4, 10], value: 'x', del: 1 },
                { id: [4, 10], left: [1, 100], right: [0, 0], value: 'Hi' },
            ],
            [
                [[0, 0], ParagraphStyle.HEADING],
                [[1, 100], ParagraphStyle.CHECKBOX],
            ],
        )
        expect(paragraphStyleShadows(text).get(0)).toEqual(['1:100'])
    })
})
