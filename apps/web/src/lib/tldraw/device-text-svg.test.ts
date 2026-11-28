import { describe, expect, test } from 'bun:test'
import {
    crdtId,
    createRootText,
    encodeStyleExtra,
    insertText,
    linearizeRootText,
    RmDocument,
    setParagraphStyle,
} from '@weft/rm-format'
import { paragraphsToRichText } from './device-text-richtext'
import { buildSvgLines } from './device-text-svg'

describe('native imported indentation before editing', () => {
    const authorUuid = 'aaaaaaaa-0000-4000-a000-000000000001'
    const expected = [
        { depth: 1, glyphX: 100, markerX: 72 },
        { depth: 2, glyphX: 148, markerX: 120 },
        { depth: 3, glyphX: 196, markerX: 168 },
    ]

    for (const precedingBullet of [false, true]) {
        for (const { depth, glyphX, markerX } of expected) {
            test(`depth ${depth} ${precedingBullet ? 'following a bullet' : 'without a parent bullet'}`, () => {
                const original = RmDocument.empty(authorUuid)
                createRootText(original, { width: 936 })
                const first = insertText(original, null, 'Reference\nTarget', { authorUuid })
                setParagraphStyle(original, crdtId(0, 0), precedingBullet ? 4 : 1, { authorUuid })
                setParagraphStyle(original, crdtId(first.part1, first.part2 + 'Reference'.length), 1, {
                    authorUuid,
                    extra: encodeStyleExtra({ indent: depth }),
                })
                const root = RmDocument.parse(original.serialize()).tree().rootText!
                const paragraphs = linearizeRootText(root)
                expect(paragraphs[1]).toMatchObject({ style: 1, indentLevel: depth })

                const lines = buildSvgLines(paragraphsToRichText(paragraphs), root.width)
                expect(lines).toHaveLength(2)
                const target = lines[1]!
                // Exact native column-local coordinates; the page origin is applied once by the renderer.
                const pageX = root.posX + target.runs[0]!.xs[0]!
                expect(pageX).toBe(root.posX + glyphX)
                expect(target.marker?.x).toBe(markerX)
            })
        }
    }
})

