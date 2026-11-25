/** CRDT sequence ordering tests, including the numeric (not lexicographic)
 *  clock tie-break fix. */

import { describe, expect, test } from 'bun:test'
import { CrdtSequence, toposortItems, type CrdtSequenceItem } from '../src/crdt-sequence'
import { crdtId, crdtIdKey, END_MARKER } from '../src/crdt-id'

function item<T>(
    id: [number, number],
    left: [number, number],
    right: [number, number],
    value: T,
    deletedLength = 0,
): CrdtSequenceItem<T> {
    return {
        itemId: crdtId(id[0], id[1]),
        leftId: crdtId(left[0], left[1]),
        rightId: crdtId(right[0], right[1]),
        deletedLength,
        value,
    }
}

describe('toposort', () => {
    test('simple chain follows left links', () => {
        const items = [
            item([1, 1], [0, 0], [0, 0], 'a'),
            item([1, 2], [1, 1], [0, 0], 'b'),
            item([1, 3], [1, 2], [0, 0], 'c'),
        ]
        expect(toposortItems(items).map(crdtIdKey)).toEqual(['1:1', '1:2', '1:3'])
    })

    test('DEVICE-PINNED (E27): concurrent tie-break is author-DESC, runs stay contiguous', () => {
        // Two authors insert at the head concurrently. The device emits
        // higher author ids first for concurrent same-origin items, and a
        // just-unlocked successor chain continues before other branches.
        const items = [
            item([2, 9], [0, 0], [0, 0], 'x'),
            item([2, 10], [2, 9], [0, 0], 'y'),
            item([1, 5], [0, 0], [0, 0], 'z'), // concurrent with 2:9 at head
        ]
        const order = toposortItems(items).map(crdtIdKey)
        expect(order).toEqual(['2:9', '2:10', '1:5'])
    })

    test('numeric clock tie-break within one author (not lexicographic, LESSONS C1)', () => {
        // lexicographic string sort would order "2:10" < "2:9"
        const items = [
            item([2, 10], [0, 0], [0, 0], 'b'),
            item([2, 9], [0, 0], [0, 0], 'a'),
        ]
        expect(toposortItems(items).map(crdtIdKey)).toEqual(['2:9', '2:10'])
    })

    test('right links constrain order', () => {
        const items = [
            item([1, 1], [0, 0], [0, 0], 'a'),
            item([1, 3], [1, 1], [0, 0], 'c'),
            item([2, 7], [1, 1], [1, 3], 'b'), // inserted between a and c
        ]
        expect(toposortItems(items).map(crdtIdKey)).toEqual(['1:1', '2:7', '1:3'])
    })

    test('missing neighbors degrade to start/end anchors', () => {
        const items = [item([1, 2], [1, 1], [9, 9], 'only')]
        expect(toposortItems(items).map(crdtIdKey)).toEqual(['1:2'])
    })

    test('deterministic under shuffle', () => {
        const items = [
            item([1, 1], [0, 0], [0, 0], 'a'),
            item([1, 2], [1, 1], [0, 0], 'b'),
            item([2, 1], [1, 1], [1, 2], 'x'),
            item([2, 2], [1, 2], [0, 0], 'y'),
            item([3, 1], [1, 2], [0, 0], 'z'),
        ]
        const reference = toposortItems(items).map(crdtIdKey)
        for (let i = 0; i < 20; i++) {
            const shuffled = [...items].sort(() => Math.random() - 0.5)
            expect(toposortItems(shuffled).map(crdtIdKey)).toEqual(reference)
        }
    })
})

describe('CrdtSequence merge', () => {
    test('values exclude tombstones; merge of deletion sticks', () => {
        const seq = new CrdtSequence<string>([
            item([1, 1], [0, 0], [0, 0], 'a'),
            item([1, 2], [1, 1], [0, 0], 'b'),
        ])
        expect(seq.values()).toEqual(['a', 'b'])
        seq.merge(item([1, 1], [0, 0], [0, 0], null as unknown as string, 1))
        expect(seq.values()).toEqual(['b'])
        // idempotent
        seq.merge(item([1, 1], [0, 0], [0, 0], null as unknown as string, 1))
        expect(seq.values()).toEqual(['b'])
        // re-adding the live value does NOT resurrect it
        seq.merge(item([1, 1], [0, 0], [0, 0], 'a'))
        expect(seq.values()).toEqual(['b'])
    })

    test('merge keeps first value for duplicate ids', () => {
        const seq = new CrdtSequence<string>()
        seq.merge(item([1, 1], [0, 0], [0, 0], 'first'))
        seq.merge(item([1, 1], [0, 0], [0, 0], 'second'))
        expect(seq.get(crdtId(1, 1))).toBe('first')
    })

    test('END_MARKER export sanity', () => {
        expect(crdtIdKey(END_MARKER)).toBe('0:0')
    })

    // A revert can reconstruct a base whose origin graph has a cycle (two
    // items each claiming to precede the other). Z-order is cosmetic, so a
    // cycle must NOT throw and take down buildView/sync — it must recover
    // with a best-effort order that still emits EVERY item exactly once.
    test('cyclic origins recover instead of throwing (all items emitted once)', () => {
        // 1:1 <-> 1:2 form a 2-cycle (each left-refs the other); 1:3 is a
        // normal item after 1:2.
        const items = [
            item([1, 1], [1, 2], [0, 0], 'a'),
            item([1, 2], [1, 1], [0, 0], 'b'),
            item([1, 3], [1, 2], [0, 0], 'c'),
        ]
        let order: ReturnType<typeof toposortItems>
        expect(() => {
            order = toposortItems(items)
        }).not.toThrow()
        const keys = order!.map(crdtIdKey).sort()
        expect(keys).toEqual(['1:1', '1:2', '1:3'])
        expect(new Set(keys).size).toBe(3) // no duplicates, no drops
    })

    test('self-referential origin recovers (item left-refs itself)', () => {
        const items = [
            item([2, 5], [2, 5], [0, 0], 'x'), // self-loop
            item([2, 6], [2, 5], [0, 0], 'y'),
        ]
        let order: ReturnType<typeof toposortItems>
        expect(() => {
            order = toposortItems(items)
        }).not.toThrow()
        expect(order!.map(crdtIdKey).sort()).toEqual(['2:5', '2:6'])
    })

    test('cycle recovery is deterministic (same input, same order)', () => {
        const mk = () => [
            item([1, 1], [1, 2], [0, 0], 'a'),
            item([1, 2], [1, 1], [0, 0], 'b'),
            item([1, 3], [1, 2], [0, 0], 'c'),
        ]
        const a = toposortItems(mk()).map(crdtIdKey)
        const b = toposortItems(mk()).map(crdtIdKey)
        expect(a).toEqual(b)
    })
})
