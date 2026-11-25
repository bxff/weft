/**
 * textFromNode: TipTap doc -> the plain text the projection renders.
 * Paragraphs join by '\n' (no trailing newline on the last block), and empty
 * paragraphs (TipTap omits `content`) survive as blank lines.
 */

import { expect, test } from 'bun:test'
import { textFromNode, eraseRichTextGlyphs } from './richtext-plain'

const p = (text?: string) => ({
    type: 'paragraph',
    ...(text ? { content: [{ type: 'text', text }] } : {}),
})
const doc = (...content: object[]) => ({ type: 'doc', content })

test('single paragraph has no trailing newline', () => {
    expect(textFromNode(doc(p('tldraw')))).toBe('tldraw')
})

test('paragraphs join with newline separators', () => {
    expect(textFromNode(doc(p('one'), p('two')))).toBe('one\ntwo')
})

test('empty paragraphs survive as blank lines', () => {
    expect(textFromNode(doc(p('a'), p(), p('b')))).toBe('a\n\nb')
    expect(textFromNode(doc(p('a'), p()))).toBe('a\n')
})

test('headings count as blocks', () => {
    expect(
        textFromNode(doc({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'title' }] }, p('body'))),
    ).toBe('title\nbody')
})

test('list items flatten to their paragraph lines', () => {
    const list = {
        type: 'bulletList',
        content: [
            { type: 'listItem', content: [p('first')] },
            { type: 'listItem', content: [p('second')] },
        ],
    }
    expect(textFromNode(doc(list))).toBe('first\nsecond')
})

test('marked text and hard breaks stay inline', () => {
    const para = {
        type: 'paragraph',
        content: [
            { type: 'text', text: 'bo', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'ld' },
        ],
    }
    expect(textFromNode(doc(para))).toBe('bold')
})

test('glyph erasure preserves rich structure and follows projected Unicode offsets', () => {
    const ignored = { type: 'codeBlock', content: [{ type: 'text', text: 'not projected' }] }
    const title = { type: 'text', text: 'H🖋I', marks: [{ type: 'bold' }] }
    const heading = { type: 'heading', attrs: { level: 2 }, content: [title] }
    const emphasized = { type: 'text', text: 'ab', marks: [{ type: 'italic' }] }
    const hardBreak = { type: 'hardBreak' }
    const body = { type: 'paragraph', content: [emphasized, hardBreak, { type: 'text', text: 'c' }] }
    const blank = p()
    const list = {
        type: 'orderedList', attrs: { start: 5 }, content: [
            { type: 'listItem', content: [body, blank] },
            { type: 'listItem', content: [p('dé')] },
        ],
    }
    const richText = doc(ignored, heading, list)
    expect(textFromNode(richText)).toBe('H🖋I\nab\nc\n\ndé')

    const repaired = eraseRichTextGlyphs(richText, [1, 5, 5, 7, 10, 11])
    expect(repaired).toEqual(doc(
        ignored,
        { ...heading, content: [{ ...title, text: 'HI' }] },
        { ...list, content: [
            { type: 'listItem', content: [{ ...body, content: [{ ...emphasized, text: 'a' }, hardBreak] }, blank] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [] }] },
        ] },
    ))
    expect(textFromNode(repaired)).toBe('HI\na\n\n\n')
    expect(repaired.content[0]).toBe(ignored)

    // Projected separators and hard breaks consume indices but never draw glyphs.
    expect(eraseRichTextGlyphs(richText, [3, 6, 8, 9, -1, 1.5, 100])).toBe(richText)
    expect(eraseRichTextGlyphs(richText, [])).toBe(richText)
})


test('glyph offsets join surrogate pairs across differently marked leaves', () => {
    const high = { type: 'text', text: 'A\uD83D', marks: [{ type: 'bold' }] }
    const low = { type: 'text', text: '\uDD8BD', marks: [{ type: 'italic' }] }
    const richText = doc({ type: 'paragraph', content: [high, low] })
    expect(textFromNode(richText)).toBe('A🖋D')
    const tailRemoved = eraseRichTextGlyphs(richText, [2])
    expect(tailRemoved).toEqual(doc({ type: 'paragraph', content: [high, { ...low, text: '\uDD8B' }] }))
    expect(textFromNode(tailRemoved)).toBe('A🖋')
    const emojiRemoved = eraseRichTextGlyphs(richText, [1])
    expect(emojiRemoved).toEqual(doc({ type: 'paragraph', content: [{ ...high, text: 'A' }, { ...low, text: 'D' }] }))
    expect(textFromNode(emojiRemoved)).toBe('AD')
    expect(textFromNode(richText)).toBe('A🖋D')
})
