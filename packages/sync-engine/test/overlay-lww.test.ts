/**
 * Wall-clock LWW versioning for overlay objects: the overlay merge is a
 * per-object-id LWW register keyed by `version = { ts, actor }`. An incoming
 * op wins only if its version is strictly greater than the stored version
 * (compare ts, then actor string). Deletes carry a version and leave a
 * versioned tombstone; different ids never conflict (union-by-id).
 *
 * Proven here: deterministic convergence regardless of apply order; a stale
 * upsert after a delete does not resurrect; a newer upsert after a delete
 * re-creates; the losing upsert survives in the op log; idempotent re-apply
 * is a no-op.
 */

import { describe, expect, test } from 'bun:test'
import {
    applyRemoteOps,
    compareVersion,
    currentObjectVersion,
    decodeOp,
    encodeOp,
    mergeOverlayOp,
    mergeOverlayDocuments,
    type DeleteObjectOp,
    type Op,
    type UpsertObjectOp,
} from '../src/ops'
import { RmDocument } from '@weft/rm-format'
import { applyOps } from '../src/apply-ops'
import type { OpVersion, OverlayDocument } from '../src/types'

const AUTHOR = 'c8050a7c-0000-4000-a000-000000000001'

function upsert(id: string, version: OpVersion, tag = version.ts): UpsertObjectOp {
    return {
        op: 'upsert-object',
        id,
        objType: 'draw-native',
        // a version-distinguishing payload so we can tell which edit won
        props: { tag },
        transform: { x: 0, y: 0, rotation: 0 },
        rendered: [],
        version,
        renderRevision: `rev-${id}-${tag}`,
    }
}

function del(id: string, version: OpVersion): DeleteObjectOp {
    return { op: 'delete-object', id, version }
}

function replay(ops: Op[]): OverlayDocument {
    const doc = RmDocument.empty(AUTHOR)
    const overlay: OverlayDocument = { shapes: [] }
    applyRemoteOps(doc, overlay, ops)
    return overlay
}

/** Every permutation of a small array (for the order-independence proofs). */
function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items]
    const out: T[][] = []
    for (let i = 0; i < items.length; i++) {
        const rest = [...items.slice(0, i), ...items.slice(i + 1)]
        for (const p of permutations(rest)) out.push([items[i]!, ...p])
    }
    return out
}

describe('compareVersion (D7 total order)', () => {
    test('higher ts wins; equal ts -> higher actor; equal -> 0', () => {
        expect(compareVersion({ ts: 2, actor: 'a' }, { ts: 1, actor: 'z' })).toBeGreaterThan(0)
        expect(compareVersion({ ts: 1, actor: 'z' }, { ts: 2, actor: 'a' })).toBeLessThan(0)
        expect(compareVersion({ ts: 5, actor: 'b' }, { ts: 5, actor: 'a' })).toBeGreaterThan(0)
        expect(compareVersion({ ts: 5, actor: 'a' }, { ts: 5, actor: 'b' })).toBeLessThan(0)
        expect(compareVersion({ ts: 5, actor: 'a' }, { ts: 5, actor: 'a' })).toBe(0)
    })
})

describe('deterministic convergence of concurrent same-id upserts', () => {
    test('higher ts wins regardless of apply order', () => {
        const lo = upsert('shape:x', { ts: 100, actor: 'client-A' })
        const hi = upsert('shape:x', { ts: 200, actor: 'client-B' })
        for (const perm of permutations([lo, hi])) {
            const overlay = replay(perm)
            expect(overlay.shapes).toHaveLength(1)
            expect(overlay.shapes[0]!.version).toEqual({ ts: 200, actor: 'client-B' })
            expect((overlay.shapes[0]!.props as { tag: number }).tag).toBe(200)
        }
    })

    test('equal ts -> higher actor string wins regardless of apply order', () => {
        const a = upsert('shape:x', { ts: 500, actor: 'client-A' }, 1)
        const b = upsert('shape:x', { ts: 500, actor: 'client-B' }, 2)
        for (const perm of permutations([a, b])) {
            const overlay = replay(perm)
            expect(overlay.shapes).toHaveLength(1)
            expect(overlay.shapes[0]!.version).toEqual({ ts: 500, actor: 'client-B' })
            expect((overlay.shapes[0]!.props as { tag: number }).tag).toBe(2)
        }
    })

    test('a shuffled batch of many same-id edits converges to the single max', () => {
        const edits = [
            upsert('shape:x', { ts: 10, actor: 'a' }),
            upsert('shape:x', { ts: 30, actor: 'a' }),
            upsert('shape:x', { ts: 20, actor: 'b' }),
            upsert('shape:x', { ts: 30, actor: 'b' }), // ties ts=30, actor b wins
            upsert('shape:x', { ts: 5, actor: 'z' }),
        ]
        const canonical = replay(edits)
        for (const perm of permutations(edits)) {
            expect(replay(perm)).toEqual(canonical)
        }
        expect(canonical.shapes).toHaveLength(1)
        expect(canonical.shapes[0]!.version).toEqual({ ts: 30, actor: 'b' })
    })

    test('different ids never conflict (union-by-id)', () => {
        const ops = [
            upsert('shape:a', { ts: 1, actor: 'a' }),
            upsert('shape:b', { ts: 1, actor: 'b' }),
            upsert('shape:c', { ts: 999, actor: 'a' }),
        ]
        for (const perm of permutations(ops)) {
            const overlay = replay(perm)
            expect(overlay.shapes.map((s) => s.shapeId).sort()).toEqual([
                'shape:a',
                'shape:b',
                'shape:c',
            ])
        }
    })
})

describe('delete vs upsert LWW (versioned tombstone)', () => {
    test('a stale upsert after a delete does NOT resurrect', () => {
        const create = upsert('shape:x', { ts: 100, actor: 'a' })
        const remove = del('shape:x', { ts: 200, actor: 'a' })
        const stale = upsert('shape:x', { ts: 150, actor: 'a' }) // < delete's ts

        expect(replay([create, remove, stale]).shapes).toEqual([])
        // any order: the delete's version dominates the stale upsert
        for (const perm of permutations([create, remove, stale])) {
            const overlay = replay(perm)
            expect(overlay.shapes).toEqual([])
            expect(currentObjectVersion(overlay, 'shape:x')).toEqual({ ts: 200, actor: 'a' })
        }
    })

    test('a newer upsert after a delete re-creates the object', () => {
        const create = upsert('shape:x', { ts: 100, actor: 'a' })
        const remove = del('shape:x', { ts: 200, actor: 'a' })
        const recreate = upsert('shape:x', { ts: 300, actor: 'a' }) // > delete's ts

        for (const perm of permutations([create, remove, recreate])) {
            const overlay = replay(perm)
            expect(overlay.shapes).toHaveLength(1)
            expect(overlay.shapes[0]!.version).toEqual({ ts: 300, actor: 'a' })
            // Keep the delete boundary for late opacity writes.
            expect(overlay.tombstones?.['shape:x']).toEqual(remove.version)
        }
    })

    test('a stale delete cannot remove a newer live shape', () => {
        const staleDelete = del('shape:x', { ts: 100, actor: 'a' })
        const newer = upsert('shape:x', { ts: 200, actor: 'a' })
        for (const perm of permutations([staleDelete, newer])) {
            const overlay = replay(perm)
            expect(overlay.shapes).toHaveLength(1)
            expect(overlay.shapes[0]!.version).toEqual({ ts: 200, actor: 'a' })
        }
    })
})

describe('the losing edit survives in the op log (recoverable history)', () => {
    test('the log still contains the loser even though it lost the merge', () => {
        const loser = upsert('shape:x', { ts: 100, actor: 'client-A' })
        const winner = upsert('shape:x', { ts: 200, actor: 'client-B' })
        const log: Op[] = [loser, winner]

        const overlay = replay(log)
        // merge drops the loser from live state, but it stays in the op log (recoverable)
        expect((overlay.shapes[0]!.props as { tag: number }).tag).toBe(200)
        expect(log).toContain(loser)
        const recovered = log.find(
            (o): o is UpsertObjectOp =>
                o.op === 'upsert-object' &&
                compareVersion(o.version, { ts: 100, actor: 'client-A' }) === 0,
        )
        expect(recovered).toBeDefined()
        expect((recovered!.props as { tag: number }).tag).toBe(100)
    })
})

describe('idempotence', () => {
    test('re-applying the same op batch is a no-op', () => {
        const ops = [
            upsert('shape:a', { ts: 100, actor: 'a' }),
            upsert('shape:b', { ts: 200, actor: 'b' }),
            del('shape:b', { ts: 300, actor: 'b' }),
        ]
        const once = replay(ops)
        const twice = replay([...ops, ...ops])
        const thrice = replay([...ops, ...ops, ...ops])
        expect(twice).toEqual(once)
        expect(thrice).toEqual(once)
    })

    test('re-applying a single winning upsert does not churn (mergeOverlayOp)', () => {
        const overlay: OverlayDocument = { shapes: [] }
        const op = upsert('shape:x', { ts: 100, actor: 'a' })
        expect(mergeOverlayOp(overlay, op).kind).toBe('upsert')
        // an equal version is NOT strictly greater -> dropped as idempotent
        expect(mergeOverlayOp(overlay, op).kind).toBe('none')
        expect(overlay.shapes).toHaveLength(1)
    })

    test('a stale op is dropped as none (never flips state back)', () => {
        const overlay: OverlayDocument = { shapes: [] }
        mergeOverlayOp(overlay, upsert('shape:x', { ts: 200, actor: 'a' }))
        const result = mergeOverlayOp(overlay, upsert('shape:x', { ts: 100, actor: 'a' }))
        expect(result.kind).toBe('none')
        expect(overlay.shapes[0]!.version).toEqual({ ts: 200, actor: 'a' })
    })
})

test('legacy upserts preserve a known opacity only for a continuing shape', () => {
    const id = 'shape:x'
    const faint = { ...upsert(id, { ts: 1, actor: 'new' }), opacity: 0.25 }
    const legacy = upsert(id, { ts: 2, actor: 'old' })
    const overlay = replay([faint, legacy, upsert('shape:other', { ts: 3, actor: 'old' })])
    expect(overlay.shapes.map(shape => shape.opacity)).toEqual([0.25, undefined])
    const legacySnapshot = replay([legacy])
    expect(mergeOverlayDocuments(replay([faint]), legacySnapshot).shapes[0]?.opacity).toBe(0.25)
    expect(mergeOverlayDocuments(legacySnapshot, replay([faint])).shapes[0]?.opacity).toBe(0.25)
    const opaque = { ...upsert(id, { ts: 4, actor: 'new' }), opacity: 1 }
    expect(replay([faint, legacy, opaque]).shapes[0]?.opacity).toBe(1)
    const deleted = del(id, { ts: 2, actor: 'old' })
    const recreated = upsert(id, { ts: 3, actor: 'old' })
    expect(replay([faint, deleted, recreated]).shapes[0]?.opacity).toBeUndefined()
    expect(mergeOverlayDocuments(replay([faint, deleted]), replay([recreated])).shapes[0]?.opacity).toBeUndefined()
    expect(replay([faint, { ...legacy, opacity: 2 }]).shapes[0]?.opacity).toBe(0.25)
    expect(replay([faint, { ...legacy, opacity: 0 }]).shapes[0]?.opacity).toBe(0)
})

test('legacy updates leave the newest explicit opacity writer in control across op and snapshot order', () => {
    const id = 'shape:x'
    const faint = { ...upsert(id, { ts: 1, actor: 'a' }), opacity: 0.25 }
    const reset = { ...upsert(id, { ts: 2, actor: 'b' }), opacity: 1 }
    const legacy = upsert(id, { ts: 3, actor: 'old' })
    expect(replay([legacy, faint]).shapes[0]?.opacity).toBe(0.25)
    for (const order of permutations([faint, reset, legacy])) {
        const shape = replay(order).shapes[0]!
        expect(shape.version).toEqual(legacy.version)
        expect(shape.opacity).toBe(1)
    }
    const carried = replay([faint, legacy])
    const updated = replay([reset])
    for (const [left, right] of [[carried, updated], [updated, carried]] as const) {
        expect(mergeOverlayDocuments(left, right).shapes[0]?.opacity).toBe(1)
    }
})

test('late deletes fence prior opacity without removing a newer recreated shape', () => {
    const id = 'shape:x'
    const faint = { ...upsert(id, { ts: 1, actor: 'a' }), opacity: 0.25 }
    const remove = del(id, { ts: 2, actor: 'a' })
    const recreated = upsert(id, { ts: 3, actor: 'old' })
    for (const order of permutations([faint, remove, recreated])) {
        expect(replay(order).shapes[0]?.opacity).toBeUndefined()
    }
    const previous = replay([faint])
    const current = replay([remove, recreated])
    expect(mergeOverlayDocuments(previous, current).shapes[0]?.opacity).toBeUndefined()
})

test('a rebased local opacity edit ships its original clock without minting native ink', () => {
    const id = 'shape:x'
    const initial = { ...upsert(id, { ts: 1, actor: 'a' }), opacity: 0.25 }
    const legacy = upsert(id, { ts: 3, actor: 'old' })
    const overlay = replay([initial, legacy])
    const version = { ts: 2, actor: 'a' }
    const shape = overlay.shapes[0]!
    const { opacityVersion: _carried, ...withoutClock } = shape
    const native = RmDocument.empty(AUTHOR)
    const before = native.serialize()
    const { deltas } = applyOps(native, overlay, [{
        type: 'upsert-shape', shape: { ...withoutClock, opacity: 1, version }, parts: [],
    }], { authorUuid: AUTHOR })
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({ op: 'upsert-object', version: legacy.version, opacity: 1, opacityVersion: version })
    expect(native.serialize()).toEqual(before)
    expect(replay([initial, legacy, ...deltas.map(op => decodeOp(encodeOp(op)))])).toEqual(overlay)
})

test('a same-value explicit reset fences late opacity while an identical projection remains a no-op', () => {
    const id = 'shape:x'
    const initial = { ...upsert(id, { ts: 1, actor: 'a' }), opacity: 1 }
    const late = { ...upsert(id, { ts: 2, actor: 'b' }), opacity: 0.25 }
    const overlay = replay([initial])
    const { opacity: _opacity, ...shape } = overlay.shapes[0]!
    const version = { ts: 3, actor: 'a' }
    const doc = RmDocument.empty(AUTHOR)
    const before = doc.serialize()
    const project = (opacity?: number) => applyOps(doc, overlay, [{
        type: 'upsert-shape', shape: { ...shape, version, ...(opacity !== undefined && { opacity }) }, parts: [],
    }], { authorUuid: AUTHOR }).deltas

    expect(project()).toEqual([])
    const deltas = project(1)
    expect(deltas).toHaveLength(1)
    expect(replay([initial, ...deltas, late]).shapes[0]?.opacity).toBe(1)
    expect(replay([initial, late, ...deltas]).shapes[0]?.opacity).toBe(1)
    expect(doc.serialize()).toEqual(before)
    expect(project(1)).toEqual([])
})
