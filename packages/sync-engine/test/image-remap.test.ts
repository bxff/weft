/**
 * A move tombstones+re-appends an image, reordering the file's image blocks.
 * Rebinding by order swaps placements on multi-image pages; rebinding by uuid
 * stays correct.
 */

import { describe, expect, test } from 'bun:test'
import { remapImagesByUuid, type LiveImage } from '../src/image-remap'

describe('remapImagesByUuid', () => {
    const stale = new Map<string, string>([
        ['uuid-a', 'shape:A'],
        ['uuid-b', 'shape:B'],
    ])

    test('rebinds each image to ITS shape even when file order flipped', () => {
        // image B was moved -> its block now sorts before A's: order is [B, A]
        const live: LiveImage[] = [
            { uuid: 'uuid-b', refKey: 'ref-b-new' },
            { uuid: 'uuid-a', refKey: 'ref-a' },
        ]
        const out = remapImagesByUuid(live, stale)
        // no swap: B's new ref -> shape:B, A's ref -> shape:A
        expect(out.get('ref-b-new')).toBe('shape:B')
        expect(out.get('ref-a')).toBe('shape:A')
    })

    test('uuid match is case-insensitive', () => {
        const out = remapImagesByUuid([{ uuid: 'UUID-A', refKey: 'r' }], stale)
        expect(out.get('r')).toBe('shape:A')
    })

    test('unknown uuids (e.g. tablet-inserted images) are left unbound', () => {
        const out = remapImagesByUuid([{ uuid: 'uuid-z', refKey: 'r' }], stale)
        expect(out.size).toBe(0)
    })

    test('single-image page still binds correctly', () => {
        const out = remapImagesByUuid([{ uuid: 'uuid-a', refKey: 'ref-a2' }], stale)
        expect(out.get('ref-a2')).toBe('shape:A')
    })
})
