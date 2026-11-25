/**
 * trailingGlyphErase: glyph partKeys carry source-text indices (whitespace
 * yields no part but still advances the numbering), so "trailing" must be
 * judged against the indices actually present, not the part count.
 */

import { describe, expect, test } from 'bun:test'
import { trailingGlyphErase } from '../src/reconciler'
import type { OverlayShape } from '../src/types'

function textShape(glyphIndices: number[]): OverlayShape {
    return {
        shapeId: 'shape:t',
        kind: 'text',
        props: {},
        x: 0,
        y: 0,
        rotation: 0,
        rendered: glyphIndices.map((i) => ({
            partKey: `glyph:${i}`,
            items: [{ authorUuid: 'a', clock: 100 + i }],
        })),
        renderRevision: 'r',
        state: 'live',
        version: { ts: 1, actor: 'a' },
    }
}

describe('trailingGlyphErase', () => {
    test('contiguous tail repairs', () => {
        expect(trailingGlyphErase(textShape([0, 1, 2, 3]), ['glyph:3'])).toEqual([3])
        expect(trailingGlyphErase(textShape([0, 1, 2, 3]), ['glyph:2', 'glyph:3'])).toEqual([2, 3])
    })

    test('middle hole detaches', () => {
        expect(trailingGlyphErase(textShape([0, 1, 2, 3]), ['glyph:1'])).toBeNull()
        expect(trailingGlyphErase(textShape([0, 1, 2, 3]), ['glyph:1', 'glyph:3'])).toBeNull()
    })

    test('SPACED text: "ab cd" (parts 0,1,3,4) tail erase repairs', () => {
        // erase 'd' (source index 4): trailing despite the index gap at 2
        expect(trailingGlyphErase(textShape([0, 1, 3, 4]), ['glyph:4'])).toEqual([4])
        // erase 'cd' (3,4): trailing run across the space boundary
        expect(trailingGlyphErase(textShape([0, 1, 3, 4]), ['glyph:3', 'glyph:4'])).toEqual([3, 4])
        // erase 'b' (source index 1): a middle glyph, detaches
        expect(trailingGlyphErase(textShape([0, 1, 3, 4]), ['glyph:1'])).toBeNull()
    })

    test('non-glyph part in the erased set detaches', () => {
        expect(trailingGlyphErase(textShape([0, 1]), ['glyph:1', 'label:0'])).toBeNull()
    })

    test('non-text shapes never repair', () => {
        const s = { ...textShape([0]), kind: 'draw-native' as const }
        expect(trailingGlyphErase(s, ['glyph:0'])).toBeNull()
    })
})
