/**
 * mergeOverlayDocuments: the LWW whole-overlay merge used at snapshot
 * adoption. Pins idempotence, tie behavior (local wins, preserving the
 * client-local detached state), tombstone union, and delete-vs-live ties.
 */

import { describe, expect, test } from 'bun:test'
import { mergeOverlayDocuments } from '../src/ops'
import type { OverlayDocument, OverlayShape } from '../src/types'

function shape(id: string, ts: number, rev = `r${ts}`, state: 'live' | 'detached' = 'live'): OverlayShape {
    return {
        shapeId: id,
        kind: 'draw-native',
        props: {},
        x: 0,
        y: 0,
        rotation: 0,
        rendered: [],
        renderRevision: rev,
        state,
        version: { ts, actor: 'a' },
    }
}
const doc = (shapes: OverlayShape[], tombstones?: Record<string, { ts: number; actor: string }>): OverlayDocument => ({
    shapes,
    ...(tombstones ? { tombstones } : {}),
})

describe('mergeOverlayDocuments', () => {
    test('idempotent: merge(A, A) = A', () => {
        const a = doc([shape('s1', 5)], { dead: { ts: 3, actor: 'a' } })
        const m = mergeOverlayDocuments(a, structuredClone(a))
        expect(m.shapes).toEqual(a.shapes)
        expect(m.tombstones).toEqual(a.tombstones)
    })

    test('newer incoming wins; newer local survives', () => {
        const local = doc([shape('s1', 5), shape('s2', 10)])
        const incoming = doc([shape('s1', 8), shape('s2', 7)])
        const m = mergeOverlayDocuments(local, incoming)
        expect(m.shapes.find((s) => s.shapeId === 's1')!.version.ts).toBe(8)
        expect(m.shapes.find((s) => s.shapeId === 's2')!.version.ts).toBe(10)
    })

    test('equal version keeps LOCAL (detached state preserved)', () => {
        const local = doc([shape('s1', 5, 'r5', 'detached')])
        const incoming = doc([shape('s1', 5, 'r5', 'live')])
        expect(mergeOverlayDocuments(local, incoming).shapes[0]!.state).toBe('detached')
    })

    test('disjoint shapes union', () => {
        const m = mergeOverlayDocuments(doc([shape('a', 1)]), doc([shape('b', 2)]))
        expect(m.shapes.map((s) => s.shapeId).sort()).toEqual(['a', 'b'])
    })

    test('tombstone union keeps the max version; newer-or-equal tombstone deletes a live shape', () => {
        const local = doc([shape('s1', 4)], { s1: { ts: 4, actor: 'a' }, other: { ts: 1, actor: 'a' } })
        const incoming = doc([], { s1: { ts: 6, actor: 'a' }, other: { ts: 2, actor: 'a' } })
        const m = mergeOverlayDocuments(local, incoming)
        expect(m.shapes).toHaveLength(0) // s1@4 loses to tombstone@6
        expect(m.tombstones!.s1.ts).toBe(6)
        expect(m.tombstones!.other.ts).toBe(2)
    })

    test('a live shape NEWER than the tombstone survives and retains the delete boundary', () => {
        const local = doc([shape('s1', 9)])
        const incoming = doc([], { s1: { ts: 6, actor: 'a' } })
        const m = mergeOverlayDocuments(local, incoming)
        expect(m.shapes.map((s) => s.shapeId)).toEqual(['s1'])
        expect(m.tombstones!.s1).toEqual({ ts: 6, actor: 'a' })
    })

    test('tie behavior is orientation-stable for live/tombstone pairs', () => {
        // equal-version live vs tombstone: tombstone wins in BOTH orders
        const withShape = doc([shape('s1', 5)])
        const withTomb = doc([], { s1: { ts: 5, actor: 'a' } })
        expect(mergeOverlayDocuments(withShape, withTomb).shapes).toHaveLength(0)
        expect(mergeOverlayDocuments(withTomb, withShape).shapes).toHaveLength(0)
    })
})
