/**
 * Device paragraphs <-> TipTap doc mapping: structure (heading/bullets with
 * nesting), inline marks, and deviceStyle attr preservation for styles the
 * editor has no node for (BOLD/CHECKBOX/CHECKED).
 */
import { describe, expect, test } from 'bun:test'
import type { TextParagraph } from '@weft/rm-format'
import {
    nodeKindForStyle,
    paragraphsToRichText,
    richTextToLines,
    styleForNodeKind,
} from './device-text-richtext'

const para = (style: number, text: string): TextParagraph =>
    ({
        startId: { part1: 0, part2: 0 },
        style,
        spans: text ? [{ text, bold: false, italic: false }] : [],
    }) as unknown as TextParagraph

describe('paragraphsToRichText / richTextToLines round-trip', () => {
    test('plain, heading, bullets and empty lines', () => {
        const rt = paragraphsToRichText([
            para(2, 'Title'),
            para(1, 'Body'),
            para(1, ''),
            para(4, 'first'),
            para(4, 'second'),
            para(1, 'after'),
        ])
        const lines = richTextToLines(rt)
        expect(lines.map((l) => [l.kind, l.text])).toEqual([
            ['heading1', 'Title'],
            ['paragraph', 'Body'],
            ['paragraph', ''],
            ['bullet', 'first'],
            ['bullet', 'second'],
            ['paragraph', 'after'],
        ])
    })

    test('BULLET2 nests under the previous bullet and flattens back', () => {
        const rt = paragraphsToRichText([
            para(4, 'parent'),
            para(5, 'child a'),
            para(5, 'child b'),
            para(4, 'sibling'),
        ])
        const doc = rt as unknown as { content: { type: string; content?: unknown[] }[] }
        expect(doc.content).toHaveLength(1) // one bulletList
        const lines = richTextToLines(rt)
        expect(lines.map((l) => [l.kind, l.text])).toEqual([
            ['bullet', 'parent'],
            ['bullet2', 'child a'],
            ['bullet2', 'child b'],
            ['bullet', 'sibling'],
        ])
    })

    test('orphan BULLET2 stays bullet2 via the deviceStyle attr', () => {
        const lines = richTextToLines(paragraphsToRichText([para(5, 'deep first')]))
        expect(lines[0]!.kind).toBe('bullet2')
        expect(styleForNodeKind(lines[0]!.kind, lines[0]!.deviceStyle).value).toBe(5)
    })

    test('inline marks become segments', () => {
        const p = {
            startId: { part1: 0, part2: 0 },
            style: 1,
            spans: [
                { text: 'plain ', bold: false, italic: false },
                { text: 'bold', bold: true, italic: false },
                { text: ' both', bold: true, italic: true },
            ],
        } as unknown as TextParagraph
        const lines = richTextToLines(paragraphsToRichText([p]))
        expect(lines[0]!.text).toBe('plain bold both')
        expect(lines[0]!.segments).toEqual([
            { text: 'plain ', bold: false, italic: false },
            { text: 'bold', bold: true, italic: false },
            { text: ' both', bold: true, italic: true },
        ])
    })

    test('BOLD/CHECKBOX/CHECKED styles ride the attr and survive kind-stable edits', () => {
        for (const style of [3, 6, 7]) {
            const lines = richTextToLines(paragraphsToRichText([para(style, 'x')]))
            expect(lines[0]!.kind).toBe('paragraph')
            expect(lines[0]!.deviceStyle).toBe(style)
            // the commit rule: kind unchanged -> style unchanged
            expect(styleForNodeKind('paragraph', lines[0]!.deviceStyle).value).toBe(style)
            // kind changed to heading -> heading style
            expect(styleForNodeKind('heading1', lines[0]!.deviceStyle).value).toBe(2)
        }
    })

    test('kinds map to canonical styles for NEW paragraphs', () => {
        expect(styleForNodeKind('paragraph', null).value).toBe(1)
        expect(styleForNodeKind('heading1', null).value).toBe(2)
        expect(styleForNodeKind('bullet', null).value).toBe(4)
        expect(styleForNodeKind('bullet2', null).value).toBe(5)
        expect(styleForNodeKind('ordered', null).value).toBe(10)
        expect(styleForNodeKind('ordered2', null).value).toBe(11)
        expect(nodeKindForStyle(5)).toBe('bullet2')
        expect(nodeKindForStyle(10)).toBe('ordered')
        // sized headings write PLAIN + the size property pair on the wire
        const h2 = styleForNodeKind('heading2', null)
        expect(h2.value).toBe(1)
        expect([...h2.extra!]).toEqual([0x21, 2, 0x34, 3, 0, 0, 0])
        const h3 = styleForNodeKind('heading3', null)
        expect([...h3.extra!]).toEqual([0x21, 2, 0x34, 2, 0, 0, 0])
    })

    test('NUMBERED styles round-trip as ordered lists with nesting', () => {
        const rt = paragraphsToRichText([
            para(10, 'first'),
            para(10, 'second'),
            para(11, 'nested'),
            para(1, 'after'),
        ])
        const lines = richTextToLines(rt)
        expect(lines.map((l) => [l.kind, l.text])).toEqual([
            ['ordered', 'first'],
            ['ordered', 'second'],
            ['ordered2', 'nested'],
            ['paragraph', 'after'],
        ])
    })

    test('device SIZES map to heading levels and back', () => {
        const sized = (sizeCode: number): TextParagraph =>
            ({ ...para(1, 'sized'), sizeCode }) as unknown as TextParagraph
        for (const [size, kind] of [
            [1, 'heading1'],
            [3, 'heading2'],
            [2, 'heading3'],
        ] as const) {
            const lines = richTextToLines(paragraphsToRichText([sized(size)]))
            expect(lines[0]!.kind).toBe(kind)
        }
        // adjacent checkbox levels ride the attr (8/9 render via CSS)
        for (const style of [8, 9]) {
            const lines = richTextToLines(paragraphsToRichText([para(style, 'x')]))
            expect(lines[0]!.kind).toBe('paragraph')
            expect(lines[0]!.deviceStyle).toBe(style)
        }
    })

    test('empty doc renders one empty paragraph', () => {
        const lines = richTextToLines(paragraphsToRichText([]))
        expect(lines).toEqual([
            { text: '', kind: 'paragraph', segments: [], deviceStyle: 1 },
        ])
    })
})
