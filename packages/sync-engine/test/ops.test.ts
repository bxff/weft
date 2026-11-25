/**
 * Op model: codec round-trip, mint->op->apply fidelity, idempotence, and
 * commutativity (any permutation of a delta set, including a tombstone
 * delivered before its add, converges to the same CRDT state).
 */

import { expect, test, describe } from 'bun:test'
import { RmDocument, crdtIdKey, type CrdtId } from '@weft/rm-format'
import {
    type Op,
    type AddItemOp,
    type TombstoneOp,
    OP_END,
    encodeOp,
    decodeOp,
    idToOpRef,
    lineBlockToAddOp,
    applyInkDeltas,
    InkDeltaApplier,
} from '../src/ops'
import { decodeOps, encodeOps } from './op-batch-helper'

const AUTHOR = 'aaaaaaaa-0000-4000-a000-000000000001'
const A = 'a1111111-0000-4000-a000-000000000001'
const B = 'b2222222-0000-4000-a000-000000000002'

const pt = (x: number, y: number) => ({ x, y, speed: 1, direction: 2, width: 3, pressure: 4 })

/** Keyed by the portable id (authorUuid:clock), not the file-local author
 *  index (which is assignment-order and can differ between docs). Equal maps
 *  across two docs means identical converged content (items + YATA origins).
 *  Does not assert render z-order: xochitl tie-breaks concurrent same-origin
 *  items on the file-local author index, which can differ across peers. */
function refKey(doc: RmDocument, id: CrdtId): string {
    const r = idToOpRef(doc, id)
    return `${r.author ?? 'sys'}:${r.clock}`
}
function crdtState(doc: RmDocument): Record<string, { left: string; right: string; dead: boolean }> {
    // items only — structural groups (layers) are not part of this check
    const types = new Set(['sceneLineItem', 'sceneGlyphItem', 'sceneImageItem'])
    const out: Record<string, { left: string; right: string; dead: boolean }> = {}
    for (const b of doc.blocks as unknown as {
        type: string
        itemId: CrdtId
        leftId: CrdtId
        rightId: CrdtId
        deletedLength: number
    }[]) {
        if (!types.has(b.type)) continue
        out[refKey(doc, b.itemId)] = {
            left: refKey(doc, b.leftId),
            right: refKey(doc, b.rightId),
            dead: b.deletedLength > 0,
        }
    }
    return out
}

function liveKeys(doc: RmDocument): string[] {
    return Object.entries(crdtState(doc))
        .filter(([, v]) => !v.dead)
        .map(([k]) => k)
        .sort()
}

describe('codec', () => {
    test('round-trips every op kind', () => {
        const ops: Op[] = [
            {
                op: 'add',
                id: { author: A, clock: 10 },
                parent: { author: null, clock: 5 },
                left: OP_END,
                right: OP_END,
                payload: {
                    kind: 'line',
                    tool: 2,
                    color: 0,
                    thicknessScale: 2,
                    startingLength: 0,
                    moveId: null,
                    points: [pt(-700, 200), pt(700, 1800)],
                },
            },
            { op: 'tombstone', id: { author: A, clock: 10 } },
            {
                op: 'upsert-object',
                id: 'shape:abc',
                objType: 'weft.text',
                props: { text: 'hi', size: 'm' },
                transform: { x: 1.5, y: 2.5, rotation: 0 },
                rendered: [{ partKey: 'glyph:0', items: [{ authorUuid: A, clock: 10 }], contentHash: 'h' }],
            },
            { op: 'delete-object', id: 'shape:abc' },
        ]
        for (const op of ops) expect(decodeOp(encodeOp(op))).toEqual(op)
        expect(decodeOps(encodeOps(ops))).toEqual(ops)
    })
})

describe('mint -> op -> apply fidelity', () => {
    test('a minted line round-trips through an addItem onto a fresh doc', () => {
        const src = RmDocument.empty(AUTHOR)
        const block = src.appendLine(
            {
                kind: 'line',
                tool: 2,
                color: 0,
                points: [pt(-300, 300), pt(300, 900)],
                thicknessScale: 2,
                startingLength: 0,
                timestamp: { part1: 0, part2: 1 },
                moveId: null,
            },
            { authorUuid: AUTHOR },
        )
        const addOp = lineBlockToAddOp(src, block)
        const dst = RmDocument.parse(src.serialize())
        dst.tombstone(block.itemId)
        const fresh = RmDocument.empty(AUTHOR)
        applyInkDeltas(fresh, [decodeOp(encodeOp(addOp)) as AddItemOp])

        const applied = (fresh.blocks as unknown as { type: string; itemId: CrdtId; line: unknown }[]).find(
            (b) => b.type === 'sceneLineItem' && crdtIdKey(b.itemId) === crdtIdKey(block.itemId),
        )
        expect(applied).toBeTruthy()
        const line = (applied as unknown as { line: { points: unknown[]; tool: number; color: number } }).line
        expect(line.tool).toBe(2)
        expect(line.color).toBe(0)
        expect(line.points.length).toBe(2)
        expect(idToOpRef(fresh, (applied as unknown as { itemId: CrdtId }).itemId)).toEqual(
            idToOpRef(src, block.itemId),
        )
    })
})

describe('commutativity + idempotence', () => {
    // delta set: peer A adds a1 then a2 (chained), peer B adds b1 concurrently, a1 tombstoned
    const base = RmDocument.empty(AUTHOR)
    const layer = idToOpRef(base, base.defaultLayerId()!)
    const line = (n: number) => ({
        kind: 'line' as const,
        tool: 2,
        color: 0,
        thicknessScale: 2,
        startingLength: 0,
        moveId: null,
        points: [pt(n, n), pt(n + 10, n + 10)],
    })
    const a1: AddItemOp = { op: 'add', id: { author: A, clock: 10 }, parent: layer, left: OP_END, right: OP_END, payload: line(1) }
    const a2: AddItemOp = { op: 'add', id: { author: A, clock: 11 }, parent: layer, left: { author: A, clock: 10 }, right: OP_END, payload: line(2) }
    const b1: AddItemOp = { op: 'add', id: { author: B, clock: 10 }, parent: layer, left: OP_END, right: OP_END, payload: line(3) }
    const tomb: TombstoneOp = { op: 'tombstone', id: { author: A, clock: 10 } }

    function applyTo(ops: (AddItemOp | TombstoneOp)[]): RmDocument {
        const doc = RmDocument.parse(base.serialize())
        applyInkDeltas(doc, ops)
        return doc
    }

    test('any permutation converges to the same CRDT state', () => {
        const perms: (AddItemOp | TombstoneOp)[][] = [
            [a1, a2, b1, tomb],
            [tomb, b1, a2, a1], // tombstone + chained-add BEFORE their targets exist
            [b1, a1, tomb, a2],
            [a2, tomb, a1, b1],
        ]
        const states = perms.map((p) => crdtState(applyTo(p)))
        for (const s of states) expect(s).toEqual(states[0]!)
        // and the converged live set is exactly {a2, b1} (a1 tombstoned)
        expect(liveKeys(applyTo(perms[0]!))).toEqual(liveKeys(applyTo(perms[1]!)))
        expect(liveKeys(applyTo(perms[0]!)).length).toBe(2)
    })

    test('idempotent: re-applying the same deltas changes nothing', () => {
        const once = crdtState(applyTo([a1, a2, b1, tomb]))
        const twice = crdtState(applyTo([a1, a2, b1, tomb, a1, a2, b1, tomb]))
        expect(twice).toEqual(once)
    })

    test('tombstone before add does not resurrect the item', () => {
        const doc = RmDocument.parse(base.serialize())
        const applier = new InkDeltaApplier(doc)
        applier.apply(tomb) // a1 not present yet
        applier.apply(a1) // must land already-dead
        expect(liveKeys(doc)).not.toContain(`${A}:10`)
        expect(liveKeys(doc)).toEqual([]) // only a1 was added, and it's dead
    })

    test('applying an empty delta list is a no-op', () => {
        const doc = RmDocument.parse(base.serialize())
        const before = crdtState(doc)
        applyInkDeltas(doc, [])
        expect(crdtState(doc)).toEqual(before)
    })
})

describe('apply edge cases', () => {
    const base = RmDocument.empty(AUTHOR)
    const layer = idToOpRef(base, base.defaultLayerId()!)

    test('image addItem is rejected (not silently dropped) until its sub-step lands', () => {
        const doc = RmDocument.parse(base.serialize())
        const imageAdd: AddItemOp = {
            op: 'add',
            id: { author: A, clock: 10 },
            parent: layer,
            left: OP_END,
            right: OP_END,
            payload: { kind: 'image', assetUuid: 'x', vertices: [0, 0, 0, 0], filename: null },
        }
        expect(() => applyInkDeltas(doc, [imageAdd])).toThrow()
    })

    test('an addItem whose parent references a brand-new author resolves (out-of-order safe)', () => {
        const doc = RmDocument.parse(base.serialize())
        const newParent = { author: 'cccccccc-0000-4000-a000-000000000003', clock: 7 }
        const add: AddItemOp = {
            op: 'add',
            id: { author: A, clock: 20 },
            parent: newParent,
            left: OP_END,
            right: OP_END,
            payload: {
                kind: 'line',
                tool: 2,
                color: 0,
                thicknessScale: 2,
                startingLength: 0,
                moveId: null,
                points: [pt(0, 0), pt(1, 1)],
            },
        }
        applyInkDeltas(doc, [add])
        const block = (doc.blocks as unknown as { type: string; itemId: CrdtId; parentId: CrdtId }[]).find(
            (b) => b.type === 'sceneLineItem' && idToOpRef(doc, b.itemId).author === A,
        )!
        expect(block).toBeTruthy()
        // the new parent author was registered and the parent ref round-trips
        expect(idToOpRef(doc, block.parentId)).toEqual(newParent)
    })
})
