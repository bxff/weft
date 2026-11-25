/**
 * applyOps captures the CRDT deltas it mints; the consumer twin applyRemoteOps
 * replays them. Load-bearing property: deltas produced by applying a LocalOp
 * over a base, replayed over a fresh copy of that same base, reproduce the
 * producer's exact converged state (ink live/dead set + overlay), and survive
 * the wire codec and any delivery order.
 */

import { describe, expect, spyOn, test } from 'bun:test'
import { crdtId, RmDocument, type CrdtId } from '@weft/rm-format'
import { RESERVED_CLOCK_FLOOR } from '../../rm-format/src/crdt-id'
import { polylineToPoints } from '@weft/rm-ink/pure'
import { applyOps, type LocalOp } from '../src/apply-ops'
import {
    applyRemoteOps,
    idToOpRef,
    lineBlockToAddOp,
    mergeOverlayDocuments,
    type Op,
} from '../src/ops'
import { decodeOps, encodeOps } from './op-batch-helper'
import { RefResolver } from '../src/refs'
import type { ItemRef, OverlayDocument } from '../src/types'

const AUTHOR = 'c8050a7c-0000-4000-a000-000000000001'

function base(): RmDocument {
    return RmDocument.empty(AUTHOR)
}

/** Portable live-ink keys (authorUuid:clock of every non-tombstoned item). */
function liveKeys(doc: RmDocument): string[] {
    const types = new Set(['sceneLineItem', 'sceneGlyphItem', 'sceneImageItem'])
    const out: string[] = []
    for (const b of doc.blocks as unknown as {
        type: string
        itemId: CrdtId
        deletedLength: number
    }[]) {
        if (!types.has(b.type)) continue
        if (b.deletedLength > 0) continue
        const r = idToOpRef(doc, b.itemId)
        out.push(`${r.author ?? 'sys'}:${r.clock}`)
    }
    return out.sort()
}

/** Full CRDT content keyed by portable id: left/right origins + dead flag. Equal
 *  maps across two docs ⇒ identical converged content INCLUDING YATA origins
 *  (not just which items exist). This is the load-bearing replay guarantee. */
function crdtState(doc: RmDocument): Record<string, { left: string; right: string; dead: boolean }> {
    const types = new Set(['sceneLineItem', 'sceneGlyphItem', 'sceneImageItem'])
    const key = (id: CrdtId) => {
        const r = idToOpRef(doc, id)
        return `${r.author ?? 'sys'}:${r.clock}`
    }
    const out: Record<string, { left: string; right: string; dead: boolean }> = {}
    for (const b of doc.blocks as unknown as {
        type: string
        itemId: CrdtId
        leftId: CrdtId
        rightId: CrdtId
        deletedLength: number
    }[]) {
        if (!types.has(b.type)) continue
        out[key(b.itemId)] = { left: key(b.leftId), right: key(b.rightId), dead: b.deletedLength > 0 }
    }
    return out
}

function deadKeys(doc: RmDocument): string[] {
    const types = new Set(['sceneLineItem', 'sceneGlyphItem', 'sceneImageItem'])
    const out: string[] = []
    for (const b of doc.blocks as unknown as {
        type: string
        itemId: CrdtId
        deletedLength: number
    }[]) {
        if (!types.has(b.type)) continue
        if (b.deletedLength === 0) continue
        const r = idToOpRef(doc, b.itemId)
        out.push(`${r.author ?? 'sys'}:${r.clock}`)
    }
    return out.sort()
}

function shapeOp(shapeId: string, parts = 1, strokesPerPart = 1, offset = 0): LocalOp {
    return {
        type: 'upsert-shape',
        shape: {
            shapeId,
            kind: 'draw-native',
            props: { text: shapeId },
            x: 1.5,
            y: 2.5,
            rotation: 0,
            renderRevision: `rev-${shapeId}-${offset}`,
            // deterministic version so producer/replay .toEqual matches
            version: { ts: 1000 + offset, actor: AUTHOR },
        },
        parts: Array.from({ length: parts }, (_, p) => ({
            partKey: `part:${p}`,
            strokes: Array.from({ length: strokesPerPart }, (_, s) => ({
                points: polylineToPoints(
                    [
                        { x: 10 + offset + p * 5 + s, y: 10 },
                        { x: 90 + offset + p * 5 + s, y: 90 },
                    ],
                    { width: 40 },
                ),
                color: 'black',
            })),
        })),
    }
}

/** Apply `ops` to a fresh base; return the converged (doc, overlay, deltas). */
function produce(ops: LocalOp[], seed?: (doc: RmDocument, overlay: OverlayDocument) => void) {
    const doc = base()
    const overlay: OverlayDocument = { shapes: [] }
    if (seed) seed(doc, overlay)
    const result = applyOps(doc, overlay, ops, { authorUuid: AUTHOR })
    return { doc, overlay, ...result }
}

/** Replay `deltas` over a fresh base (+ optional same seed): the consumer. */
function replay(deltas: Op[], seed?: (doc: RmDocument, overlay: OverlayDocument) => void) {
    const doc = base()
    const overlay: OverlayDocument = { shapes: [] }
    if (seed) seed(doc, overlay)
    applyRemoteOps(doc, overlay, deltas)
    return { doc, overlay }
}

describe('producer capture + consumer replay roundtrip', () => {
    test('upsert-shape: deltas replay to the same ink + overlay', () => {
        const op = shapeOp('shape:a', 2, 3)
        const p = produce([op])
        expect(p.complete).toBe(true)
        // 2 parts * 3 strokes = 6 minted lines + 1 upsert-object
        const adds = p.deltas.filter((d) => d.op === 'add')
        expect(adds.length).toBe(6)
        expect(p.deltas.filter((d) => d.op === 'upsert-object').length).toBe(1)

        const r = replay(p.deltas)
        expect(liveKeys(r.doc)).toEqual(liveKeys(p.doc))
        // exact YATA origins reproduced, not merely the same item set
        expect(crdtState(r.doc)).toEqual(crdtState(p.doc))
        expect(r.overlay).toEqual(p.overlay)
    })

    test('an empty op list captures nothing and is complete', () => {
        const p = produce([])
        expect(p.deltas).toEqual([])
        expect(p.complete).toBe(true)
    })

    test('upsert with zero strokes: one upsert-object, no adds', () => {
        const op: LocalOp = {
            type: 'upsert-shape',
            shape: {
                shapeId: 'shape:empty',
                kind: 'text',
                props: {},
                x: 0,
                y: 0,
                rotation: 0,
                renderRevision: 'e',
                version: { ts: 42, actor: AUTHOR },
            },
            parts: [],
        }
        const p = produce([op])
        expect(p.complete).toBe(true)
        expect(p.deltas).toEqual([
            {
                op: 'upsert-object',
                id: 'shape:empty',
                objType: 'text',
                props: {},
                transform: { x: 0, y: 0, rotation: 0 },
                rendered: [],
                version: { ts: 42, actor: AUTHOR },
                renderRevision: 'e',
            },
        ])
        const r = replay(p.deltas)
        expect(r.overlay).toEqual(p.overlay)
    })

    test('minting is deterministic: same base + same op => identical delta ids', () => {
        // crash-window guarantee: re-applying the same pending op to the same
        // unadvanced base mints the same ids, so a re-push is idempotent.
        const op = shapeOp('shape:d', 1, 3)
        const a = produce([op])
        const b = produce([op])
        const ids = (r: typeof a) =>
            r.deltas.filter((d) => d.op === 'add').map((d) => JSON.stringify((d as { id: unknown }).id))
        expect(ids(a)).toEqual(ids(b))
        expect(ids(a).length).toBe(3)
    })

    test('roundtrip survives the wire codec', () => {
        const p = produce([shapeOp('shape:w', 1, 4)])
        const r = replay(decodeOps(encodeOps(p.deltas)))
        expect(liveKeys(r.doc)).toEqual(liveKeys(p.doc))
        expect(r.overlay).toEqual(p.overlay)
    })

    test('renderRevision is preserved through the op channel', () => {
        const p = produce([shapeOp('shape:rr', 1, 1)])
        const upsert = p.deltas.find((d) => d.op === 'upsert-object')!
        expect(upsert.op === 'upsert-object' && upsert.renderRevision).toBe('rev-shape:rr-0')
        const r = replay(p.deltas)
        expect(r.overlay.shapes[0]!.renderRevision).toBe('rev-shape:rr-0')
    })

    test('replay converges under any delivery order (commutative)', () => {
        // two shapes' worth of deltas, shuffled
        const p1 = produce([shapeOp('shape:x', 1, 2)])
        const ordered = [...p1.deltas]
        const shuffled = [ordered[2]!, ordered[0]!, ordered[1]!] // upsert before its adds
        const a = replay(ordered)
        const b = replay(shuffled)
        expect(liveKeys(b.doc)).toEqual(liveKeys(a.doc))
        expect(b.overlay).toEqual(a.overlay)
    })

    test('replay is idempotent (re-delivered deltas change nothing)', () => {
        const p = produce([shapeOp('shape:i', 1, 2)])
        const once = replay(p.deltas)
        const twice = replay([...p.deltas, ...p.deltas])
        expect(liveKeys(twice.doc)).toEqual(liveKeys(once.doc))
        expect(twice.overlay).toEqual(once.overlay)
    })
})

describe('removal ops capture the right deltas', () => {
    // seed both producer and replay with a committed shape so removal has a target
    const seedShape = 'shape:seed'
    function seed(doc: RmDocument, overlay: OverlayDocument) {
        applyOps(doc, overlay, [shapeOp(seedShape, 1, 2)], { authorUuid: AUTHOR })
    }

    test('remove-shape: tombstones every rendered item + delete-object', () => {
        const p = produce([{ type: 'remove-shape', shapeId: seedShape, version: { ts: 2000, actor: AUTHOR } }], seed)
        expect(p.complete).toBe(true)
        expect(p.deltas.filter((d) => d.op === 'tombstone').length).toBe(2)
        expect(p.deltas.filter((d) => d.op === 'delete-object').length).toBe(1)
        expect(p.overlay.shapes).toEqual([])

        const r = replay(p.deltas, seed)
        expect(liveKeys(r.doc)).toEqual(liveKeys(p.doc)) // all dead
        expect(deadKeys(r.doc)).toEqual(deadKeys(p.doc))
        expect(r.overlay.shapes).toEqual([])
    })

    test('release-shape: drops the object but KEEPS the ink (no tombstones)', () => {
        const p = produce([{ type: 'release-shape', shapeId: seedShape, version: { ts: 2000, actor: AUTHOR } }], seed)
        expect(p.complete).toBe(true)
        expect(p.deltas.filter((d) => d.op === 'tombstone').length).toBe(0)
        expect(p.deltas).toEqual([{ op: 'delete-object', id: seedShape, version: { ts: 2000, actor: AUTHOR } }])

        const r = replay(p.deltas, seed)
        expect(liveKeys(r.doc).length).toBe(2) // ink survives
        expect(liveKeys(r.doc)).toEqual(liveKeys(p.doc))
        expect(r.overlay.shapes).toEqual([])
    })

    test('remove-ink: tombstones the named items', () => {
        const seedDoc = base()
        const seedOverlay: OverlayDocument = { shapes: [] }
        seed(seedDoc, seedOverlay)
        const items: ItemRef[] = seedOverlay.shapes[0]!.rendered.flatMap((r) => r.items)

        const p = produce([{ type: 'remove-ink', items }], seed)
        expect(p.complete).toBe(true)
        expect(p.deltas.filter((d) => d.op === 'tombstone').length).toBe(items.length)

        const r = replay(p.deltas, seed)
        expect(deadKeys(r.doc)).toEqual(deadKeys(p.doc))
        expect(liveKeys(r.doc)).toEqual([])
    })

    test('re-edit (upsert over existing): tombstone old + add new + upsert-object', () => {
        const p = produce([shapeOp(seedShape, 1, 1, 100)], seed) // same id, new strokes
        expect(p.complete).toBe(true)
        expect(p.deltas.filter((d) => d.op === 'tombstone').length).toBe(2) // old 2 strokes
        expect(p.deltas.filter((d) => d.op === 'add').length).toBe(1) // new 1 stroke
        expect(p.deltas.filter((d) => d.op === 'upsert-object').length).toBe(1)

        const r = replay(p.deltas, seed)
        expect(liveKeys(r.doc)).toEqual(liveKeys(p.doc))
        expect(deadKeys(r.doc)).toEqual(deadKeys(p.doc))
        expect(crdtState(r.doc)).toEqual(crdtState(p.doc)) // origins survive re-edit
        expect(r.overlay).toEqual(p.overlay)
    })

    test('remove-shape / release-shape on a missing id are harmless no-ops', () => {
        const removed = produce([{ type: 'remove-shape', shapeId: 'shape:ghost', version: { ts: 1, actor: AUTHOR } }])
        expect(removed.complete).toBe(true)
        expect(removed.deltas).toEqual([]) // no target: nothing tombstoned, no object op

        const released = produce([
            { type: 'release-shape', shapeId: 'shape:ghost', version: { ts: 1, actor: AUTHOR } },
        ])
        expect(released.complete).toBe(true)
        // release always emits a delete-object (idempotent no-op on replay)
        expect(released.deltas).toEqual([{ op: 'delete-object', id: 'shape:ghost', version: { ts: 1, actor: AUTHOR } }])
        const r = replay(released.deltas)
        expect(r.overlay.shapes).toEqual([])
    })

    test('move-image on a missing item ref is a no-op (still incomplete)', () => {
        const p = produce([
            {
                type: 'move-image',
                item: { authorUuid: 'dddddddd-0000-4000-a000-0000000000ff', clock: 999 },
                vertices: [0, 0, 0, 0, 1, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0, 1],
            },
        ])
        expect(p.complete).toBe(false)
        expect(p.deltas).toEqual([])
    })
})

describe('completeness signal: ops with no replayable delta force a snapshot', () => {
    test('insert-image -> complete:false, no image add emitted', () => {
        const p = produce([
            {
                type: 'insert-image',
                assetUuid: 'aaaaaaaa-0000-4000-a000-0000000000ff',
                filename: 'aaaaaaaa-0000-4000-a000-0000000000ff.png',
                vertices: [0, 0, 0, 0, 100, 0, 1, 0, 100, 100, 1, 1, 0, 100, 0, 1],
            },
        ])
        expect(p.complete).toBe(false)
        expect(p.deltas.filter((d) => d.op === 'add').length).toBe(0)
    })

    test('move-image -> complete:false', () => {
        const doc = base()
        const overlay: OverlayDocument = { shapes: [] }
        applyOps(
            doc,
            overlay,
            [
                {
                    type: 'insert-image',
                    assetUuid: 'bbbbbbbb-0000-4000-a000-0000000000ff',
                    filename: 'bbbbbbbb-0000-4000-a000-0000000000ff.png',
                    vertices: [0, 0, 0, 0, 100, 0, 1, 0, 100, 100, 1, 1, 0, 100, 0, 1],
                },
            ],
            { authorUuid: AUTHOR },
        )
        const imgBlock = doc.blocks.find((b) => b.type === 'sceneImageItem') as unknown as {
            itemId: CrdtId
        }
        const ref = idToOpRef(doc, imgBlock.itemId)
        const result = applyOps(
            doc,
            overlay,
            [
                {
                    type: 'move-image',
                    item: { authorUuid: ref.author!, clock: ref.clock },
                    vertices: [10, 10, 0, 0, 110, 10, 1, 0, 110, 110, 1, 1, 10, 110, 0, 1],
                },
            ],
            { authorUuid: AUTHOR },
        )
        expect(result.complete).toBe(false)
    })

    test('create-layer / set-layer-visible -> complete:false', () => {
        const a = produce([{ type: 'create-layer', label: 'Layer 2' }])
        expect(a.complete).toBe(false)

        const layerDoc = base()
        const layerId = layerDoc.defaultLayerId()!
        const ref = idToOpRef(layerDoc, layerId)
        const b = applyOps(
            layerDoc,
            { shapes: [] },
            [{ type: 'set-layer-visible', layer: { authorUuid: ref.author, clock: ref.clock }, visible: false }],
            { authorUuid: AUTHOR },
        )
        expect(b.complete).toBe(false)
    })

    test('a mixed batch is incomplete if ANY op is non-replayable', () => {
        const p = produce([
            shapeOp('shape:ok', 1, 1),
            { type: 'create-layer', label: 'L2' },
        ])
        expect(p.complete).toBe(false)
        // the replayable shape's deltas are still captured
        expect(p.deltas.filter((d) => d.op === 'add').length).toBe(1)
        expect(p.deltas.filter((d) => d.op === 'upsert-object').length).toBe(1)
    })
})

describe('pre-versioning (legacy) ops never crash replay', () => {
    // Op log is immutable: pre-versioning ops carry no shape.version and are
    // replayed forever; must not crash (e.g. compareVersion reading undefined .ts).
    function legacyShapeOp(shapeId: string): LocalOp {
        const op = shapeOp(shapeId)
        delete (op as { shape?: { version?: unknown } }).shape!.version
        return op
    }

    test('legacy op applies to an empty overlay, versioned edit then beats it', () => {
        const doc = RmDocument.empty(AUTHOR)
        const overlay = { shapes: [] }
        const a = applyOps(doc, overlay, [legacyShapeOp('shape:legacy')], { authorUuid: AUTHOR })
        expect(a.complete).toBe(true)
        expect(overlay.shapes.map((s) => s.shapeId)).toEqual(['shape:legacy'])

        // a versioned edit to the same id wins over the epoch-versioned one
        const b = applyOps(doc, overlay, [shapeOp('shape:legacy', 1, 1, 7)], { authorUuid: AUTHOR })
        expect(b.complete).toBe(true)
        expect(overlay.shapes[0]!.renderRevision).toBe('rev-shape:legacy-7')
    })

    test('legacy op meeting a stored versioned shape is dropped as stale, not a crash', () => {
        const doc = RmDocument.empty(AUTHOR)
        const overlay = { shapes: [] }
        applyOps(doc, overlay, [shapeOp('shape:x', 1, 1, 3)], { authorUuid: AUTHOR })
        const r = applyOps(doc, overlay, [legacyShapeOp('shape:x')], { authorUuid: AUTHOR })
        expect(r.complete).toBe(true)
        expect(overlay.shapes[0]!.renderRevision).toBe('rev-shape:x-3')
    })

    test('legacy-vs-legacy on the same id is a stable tie (second one dropped)', () => {
        const doc = RmDocument.empty(AUTHOR)
        const overlay = { shapes: [] }
        applyOps(doc, overlay, [legacyShapeOp('shape:t')], { authorUuid: AUTHOR })
        const first = overlay.shapes[0]!.renderRevision
        applyOps(doc, overlay, [legacyShapeOp('shape:t')], { authorUuid: AUTHOR })
        expect(overlay.shapes[0]!.renderRevision).toBe(first)
    })
})

describe('per-part incremental re-mint (the 17k-op-page fix, 2026-07-09)', () => {
    /** A text-like shape whose parts have independent geometry, so single
     *  parts can change without touching the others. */
    function glyphShape(shapeId: string, texts: string[], version: number, color = 'black'): LocalOp {
        return {
            type: 'upsert-shape',
            shape: {
                shapeId,
                kind: 'text',
                props: { text: texts.join('') },
                x: 0,
                y: 0,
                rotation: 0,
                renderRevision: `rev-${texts.join('')}-${color}-${version}`,
                version: { ts: version, actor: AUTHOR },
            },
            parts: texts.map((t, i) => ({
                partKey: `glyph:${i}`,
                strokes: [
                    {
                        points: polylineToPoints(
                            [
                                // geometry derived from the glyph "content"
                                { x: 10 + i * 30 + t.charCodeAt(0), y: 10 },
                                { x: 20 + i * 30 + t.charCodeAt(0), y: 40 },
                            ],
                            { width: 40 },
                        ),
                        color,
                    },
                ],
            })),
        }
    }

    const itemKeys = (overlay: OverlayDocument, id: string, part: string) =>
        overlay.shapes
            .find((s) => s.shapeId === id)!
            .rendered.find((p) => p.partKey === part)!
            .items.map((r) => `${r.authorUuid}:${r.clock}`)

    test('appending a glyph keeps every unchanged part and mints only the new one', () => {
        const doc = base()
        const overlay: OverlayDocument = { shapes: [] }
        applyOps(doc, overlay, [glyphShape('shape:T', ['a', 'b'], 1)], { authorUuid: AUTHOR })
        const a1 = itemKeys(overlay, 'shape:T', 'glyph:0')
        const b1 = itemKeys(overlay, 'shape:T', 'glyph:1')

        const { deltas } = applyOps(doc, overlay, [glyphShape('shape:T', ['a', 'b', 'c'], 2)], {
            authorUuid: AUTHOR,
        })
        // unchanged glyphs keep their exact minted items
        expect(itemKeys(overlay, 'shape:T', 'glyph:0')).toEqual(a1)
        expect(itemKeys(overlay, 'shape:T', 'glyph:1')).toEqual(b1)
        // the edit costs one add + the upsert, not a full re-mint
        expect(deltas.filter((d) => d.op === 'tombstone')).toHaveLength(0)
        expect(deltas.filter((d) => d.op === 'add')).toHaveLength(1)
        // and the doc holds exactly 3 live strokes (no duplicates)
        expect(liveKeys(doc)).toHaveLength(3)
    })

    test('a tombstoned stroke voids reuse from its part ONWARD (D8 provenance + paint order)', () => {
        const doc = base()
        const overlay: OverlayDocument = { shapes: [] }
        applyOps(doc, overlay, [glyphShape('shape:T', ['a', 'b'], 1)], { authorUuid: AUTHOR })
        const b1 = itemKeys(overlay, 'shape:T', 'glyph:1')

        // erase glyph:0's stroke directly on the doc
        const a1 = itemKeys(overlay, 'shape:T', 'glyph:0')
        for (const k of a1) {
            const clock = Number(k.split(':')[1])
            expect(doc.tombstone({ part1: doc.resolveAuthor(AUTHOR), part2: clock } as never)).toBe(true)
        }

        // identical re-upsert must not reuse the dead part; glyph:1 also
        // re-mints (prefix rule: a reused part after a re-minted one would
        // paint underneath it)
        applyOps(doc, overlay, [glyphShape('shape:T', ['a', 'b'], 2)], { authorUuid: AUTHOR })
        expect(itemKeys(overlay, 'shape:T', 'glyph:0')).not.toEqual(a1)
        expect(itemKeys(overlay, 'shape:T', 'glyph:1')).not.toEqual(b1)
        expect(liveKeys(doc)).toHaveLength(2)
    })

    test('paint order survives a partial re-mint: doc file order tracks op.parts order', () => {
        const doc = base()
        const overlay: OverlayDocument = { shapes: [] }
        // fill-then-contour analog: two overlapping parts where order matters
        applyOps(doc, overlay, [glyphShape('shape:T', ['f', 'c'], 1)], { authorUuid: AUTHOR })
        // the first part changes (fill restyle); the second is content-identical
        const restyled: LocalOp = {
            ...glyphShape('shape:T', ['g', 'c'], 2),
        }
        applyOps(doc, overlay, [restyled], { authorUuid: AUTHOR })
        // file order (liveKeys sorts, so walk blocks directly): part0 must
        // come before part1, or a reused part1 at its old position paints
        // under the fresh part0
        const fileOrder: string[] = []
        for (const b of doc.blocks as unknown as {
            type: string
            itemId: import('@weft/rm-format').CrdtId
            deletedLength: number
        }[]) {
            if (b.type !== 'sceneLineItem' || b.deletedLength > 0) continue
            const r = idToOpRef(doc, b.itemId)
            fileOrder.push(`${r.author}:${r.clock}`)
        }
        const p0 = itemKeys(overlay, 'shape:T', 'glyph:0')
        const p1 = itemKeys(overlay, 'shape:T', 'glyph:1')
        expect(fileOrder.indexOf(p0[0]!)).toBeGreaterThanOrEqual(0)
        expect(fileOrder.indexOf(p0[0]!)).toBeLessThan(fileOrder.indexOf(p1[0]!))
    })

    test('a style-only change re-mints (hash covers color)', () => {
        const doc = base()
        const overlay: OverlayDocument = { shapes: [] }
        applyOps(doc, overlay, [glyphShape('shape:T', ['a'], 1, 'black')], { authorUuid: AUTHOR })
        const before = itemKeys(overlay, 'shape:T', 'glyph:0')
        const { deltas } = applyOps(doc, overlay, [glyphShape('shape:T', ['a'], 2, 'red')], {
            authorUuid: AUTHOR,
        })
        expect(itemKeys(overlay, 'shape:T', 'glyph:0')).not.toEqual(before)
        expect(deltas.filter((d) => d.op === 'tombstone')).toHaveLength(1)
        expect(deltas.filter((d) => d.op === 'add')).toHaveLength(1)
        expect(liveKeys(doc)).toHaveLength(1)
    })

    test('reused parts replay identically on a consumer', () => {
        const doc = base()
        const overlay: OverlayDocument = { shapes: [] }
        const r1 = applyOps(doc, overlay, [glyphShape('shape:T', ['a', 'b'], 1)], { authorUuid: AUTHOR })
        const r2 = applyOps(doc, overlay, [glyphShape('shape:T', ['a', 'b', 'c'], 2)], { authorUuid: AUTHOR })
        const consumer = replay([...r1.deltas, ...r2.deltas])
        expect(liveKeys(consumer.doc)).toEqual(liveKeys(doc))
        expect(consumer.overlay.shapes[0]!.rendered).toEqual(overlay.shapes[0]!.rendered)
    })

    test('a DETACHED existing shape never reuses: re-attach re-mints everything and kills the old ink', () => {
        const doc = base()
        const overlay: OverlayDocument = { shapes: [] }
        applyOps(doc, overlay, [glyphShape('shape:T', ['a', 'b'], 1)], { authorUuid: AUTHOR })
        const oldKeys = ['glyph:0', 'glyph:1'].flatMap((k) => itemKeys(overlay, 'shape:T', k))
        overlay.shapes[0]!.state = 'detached'

        // re-attach re-projects identical content (hashes match), but detached
        // forbids reuse: old strokes must die (pruneInkShapes keys on death)
        const { deltas } = applyOps(doc, overlay, [glyphShape('shape:T', ['a', 'b'], 2)], {
            authorUuid: AUTHOR,
        })
        expect(deltas.filter((d) => d.op === 'tombstone')).toHaveLength(2)
        expect(deltas.filter((d) => d.op === 'add')).toHaveLength(2)
        const newKeys = ['glyph:0', 'glyph:1'].flatMap((k) => itemKeys(overlay, 'shape:T', k))
        for (const k of oldKeys) expect(newKeys).not.toContain(k)
        expect(overlay.shapes[0]!.state).toBe('live')
        expect(liveKeys(doc)).toHaveLength(2)
    })
})

describe('transform-ink', () => {
    test('bakes new points as tombstone + re-add with moveId; deltas replay to convergence', () => {
        // seed one stroke via a shape, then release it so it is plain ink
        const seed = (doc: RmDocument, overlay: OverlayDocument) => {
            applyOps(doc, overlay, [shapeOp('shape:s', 1, 1)], { authorUuid: AUTHOR })
            applyOps(
                doc,
                overlay,
                [{ type: 'release-shape', shapeId: 'shape:s', version: { ts: 2000, actor: AUTHOR } }],
                { authorUuid: AUTHOR },
            )
        }
        const doc = base()
        const overlay: OverlayDocument = { shapes: [] }
        seed(doc, overlay)
        const before = liveKeys(doc)
        expect(before).toHaveLength(1)
        const [author, clock] = before[0]!.split(':')
        const line = (doc.blocks as unknown as { type: string; line?: { points: { x: number }[] } }[]).find(
            (b) => b.type === 'sceneLineItem',
        )!
        const newPoints = line.line!.points.map((pt) => ({
            ...(pt as object),
            x: (pt as { x: number }).x * 2,
        }))
        const { deltas } = applyOps(
            doc,
            overlay,
            [
                {
                    type: 'transform-ink',
                    items: [{ ref: { authorUuid: author!, clock: Number(clock) }, points: newPoints as never }],
                },
            ],
            { authorUuid: AUTHOR },
        )
        // old item dead, one new live item carrying moveId -> old id
        const after = liveKeys(doc)
        expect(after).toHaveLength(1)
        expect(after[0]).not.toBe(before[0])
        const live = (doc.blocks as unknown as {
            type: string
            deletedLength: number
            line?: { moveId: CrdtId | null; points: { x: number }[] }
        }[]).find((b) => b.type === 'sceneLineItem' && b.deletedLength === 0)!
        expect(live.line!.moveId).not.toBeNull()
        expect(live.line!.points[0]!.x).toBeCloseTo((newPoints[0] as { x: number }).x, 1)
        // brush identity survives the re-add AND a serialize/parse round-trip
        // (regression: reading block.line after tombstone() dropped tool/
        // thicknessScale, rendering NaN meta that crashed shape validation)
        const src = live as unknown as { line: { tool: number; thicknessScale: number } }
        const reparsed = RmDocument.parse(doc.serialize())
        const rp = (reparsed.blocks as unknown as {
            type: string
            deletedLength: number
            line?: { tool: number; thicknessScale: number; startingLength: number }
        }[]).find((b) => b.type === 'sceneLineItem' && b.deletedLength === 0)!
        expect(rp.line!.tool).toBe(src.line.tool)
        expect(rp.line!.tool).not.toBe(0)
        expect(rp.line!.thicknessScale).toBe(src.line.thicknessScale)
        expect(Number.isFinite(rp.line!.thicknessScale)).toBe(true)
        // deltas: tombstone + add, and they replay to the same converged state
        expect(deltas.map((d) => d.op).sort()).toEqual(['add', 'tombstone'])
        const r = replay(decodeOps(encodeOps(deltas)), seed)
        expect(liveKeys(r.doc)).toEqual(liveKeys(doc))
    })

    test('a transform of a dead/unknown item is a safe no-op', () => {
        const p = produce([
            {
                type: 'transform-ink',
                items: [{ ref: { authorUuid: AUTHOR, clock: 999 }, points: [] }],
            },
        ])
        expect(p.deltas).toHaveLength(0)
        expect(liveKeys(p.doc)).toHaveLength(0)
    })

    test('a batch matches serial allocation across parents, journal entries and deleted ranges', () => {
        const seed = produce([shapeOp('seed', 1, 2)]).doc
        const first = seed.blocks.find((block) => block.type === 'sceneLineItem')
        if (!first?.line) throw new Error('Missing seed ink')
        const secondLayer = seed.createLayer('Second', { authorUuid: AUTHOR })
        const other = seed.appendLine(first.line, { authorUuid: AUTHOR, parentId: secondLayer })
        const dead = seed.appendLine(first.line, { authorUuid: AUTHOR, parentId: first.parentId })
        seed.tombstone(dead.itemId)
        dead.deletedLength = 12
        // An imported duplicate is tombstoned in both places by the serial path.
        seed.blocks.push({ ...first, parentId: secondLayer })

        const actor = '22100000-0000-4000-a000-000000000007'
        const initialClock = seed.maxClock()
        expect(initialClock).toBe(dead.itemId.part2 + 11)
        const item = (authorUuid: string, clock: number) => ({
            ref: { authorUuid, clock },
            points: first.line!.points.map((p) => ({ ...p, x: p.x + 24.125, y: p.y - 11.125 })),
        })
        const ops: LocalOp[] = [
            { type: 'transform-ink', items: [item(AUTHOR, first.itemId.part2), item(actor, initialClock + 1)] },
            { type: 'transform-ink', items: [item(AUTHOR, other.itemId.part2), item(AUTHOR, dead.itemId.part2)] },
            { type: 'transform-ink', items: [item(AUTHOR, first.itemId.part2), item(actor, initialClock + 1)] },
            { type: 'create-layer', label: 'Intervening clock allocation' },
            { type: 'transform-ink', items: [item(actor, initialClock + 2)] },
        ]
        const serial = RmDocument.parse(seed.serialize())
        const expected: Op[] = []
        for (const op of ops) {
            if (op.type !== 'transform-ink') {
                applyOps(serial, { shapes: [] }, [op], { authorUuid: actor })
                continue
            }
            const refs = new RefResolver(serial)
            for (const { ref, points } of op.items) {
                const id = refs.toId(ref)
                const block = id ? serial.findLineItem(id) : null
                if (!id || !block?.line || block.deletedLength > 0) continue
                const line = {
                    ...block.line,
                    points: points.map((p) => ({ ...p, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 })),
                    moveId: id,
                }
                serial.tombstone(id)
                expected.push({ op: 'tombstone', id: idToOpRef(serial, id) })
                expected.push(lineBlockToAddOp(serial, serial.appendLine(line, { authorUuid: actor, parentId: block.parentId })))
            }
        }

        const batched = RmDocument.parse(seed.serialize())
        const clockScans = spyOn(batched, 'maxClock')
        const frontierScans = spyOn(batched, 'appendFrontier')
        const result = applyOps(batched, { shapes: [] }, ops, { authorUuid: actor })
        expect(clockScans).toHaveBeenCalledTimes(3) // two move runs and the new layer
        expect(frontierScans).toHaveBeenCalledTimes(4) // three move lookups and the root layer frontier
        expect(result.complete).toBe(false) // layer changes still need a snapshot
        expect(result.deltas.map((delta) => delta.op)).toEqual([
            'tombstone', 'add', 'tombstone', 'add', 'tombstone', 'add', 'tombstone', 'add',
        ])
        expect(result.deltas).toEqual(expected)
        expect(batched.serialize()).toEqual(serial.serialize())
    })
})

test('a page-level browser reorder changes only guarded overlay order in replay and checkpoints', () => {
    const doc = base()
    const overlay: OverlayDocument = { shapes: [] }
    const shape = shapeOp('shape:reordered')
    if (shape.type !== 'upsert-shape') throw new Error('Expected an upsert')
    shape.shape.version.ts = 1
    shape.shape.browserIndex = 'a1'
    const original = applyOps(doc, overlay, [shape], { authorUuid: AUTHOR })
    const native = doc.serialize()
    const ordered = structuredClone(shape)
    ordered.shape.browserIndex = 'a3'
    ordered.shape.version.ts = 2
    const reorder = applyOps(doc, overlay, [ordered], { authorUuid: AUTHOR })
    expect(reorder.deltas.map(op => op.op)).toEqual(['upsert-object'])
    expect(doc.serialize()).toEqual(native)
    expect(applyOps(doc, overlay, [shape], { authorUuid: AUTHOR }).deltas).toEqual([])

    const peer = base()
    const replayed: OverlayDocument = { shapes: [] }
    const ops = decodeOps(encodeOps([...original.deltas, ...reorder.deltas, ...original.deltas]))
    applyRemoteOps(peer, replayed, ops)
    expect(replayed.shapes).toEqual(overlay.shapes)
    expect(peer.serialize()).toEqual(native)

    const olderWriter = structuredClone(replayed)
    delete olderWriter.shapes[0]!.browserIndex
    olderWriter.shapes[0]!.version.ts = 3
    expect(mergeOverlayDocuments(replayed, olderWriter).shapes[0]?.browserIndex).toBe('a3')
    expect(mergeOverlayDocuments(olderWriter, replayed).shapes[0]?.browserIndex).toBe('a3')
})


test('materializing a split tie preserves concurrent shape content and ignores a deleted sibling', () => {
    const doc = base()
    const overlay: OverlayDocument = { shapes: [] }
    const seed = shapeOp('shape:tied')
    if (seed.type !== 'upsert-shape') throw new Error('Expected an upsert')
    seed.shape.browserIndex = 'a3'
    seed.shape.version = { ts: 1, actor: 'first' }
    const { deltas: initial } = applyOps(doc, overlay, [seed], { authorUuid: AUTHOR })
    const accepted = structuredClone(overlay)
    const native = doc.serialize()
    const normalize: LocalOp = {
        type: 'set-browser-index', shapeId: seed.shape.shapeId, from: 'a3', index: 'a4',
        version: { ts: 2, actor: 'second' },
    }
    const { deltas: normalized } = applyOps(doc, overlay, [normalize], { authorUuid: AUTHOR })
    const legacy = structuredClone(accepted)
    delete legacy.shapes[0]!.browserIndex
    const direct: LocalOp = { type: 'set-browser-index', shapeId: normalize.shapeId,
        index: normalize.index, version: normalize.version }
    expect(applyOps(doc, legacy, [direct], { authorUuid: AUTHOR }).deltas).toEqual(normalized)

    expect(doc.serialize()).toEqual(native)
    const order = normalized[0]
    expect(normalized).toHaveLength(1)
    if (order?.op !== 'upsert-object') throw new Error('Expected a wire upsert')
    expect(order.version).toEqual(seed.shape.version)
    expect(order.rendered).toEqual(accepted.shapes[0]?.rendered)
    expect(applyOps(doc, overlay, [normalize], { authorUuid: AUTHOR }).deltas).toEqual([])

    const edited: Op = {
        ...order,
        version: { ts: 3, actor: 'peer' }, transform: { ...order.transform, x: 180 }, props: { color: 'red' },
    }
    delete edited.browserIndex
    delete edited.browserIndexVersion
    const peer: OverlayDocument = { shapes: [] }
    applyRemoteOps(base(), peer, [...initial, edited])
    for (const updates of [[order, edited], [edited, order]]) {
        const replayed: OverlayDocument = { shapes: [] }
        applyRemoteOps(base(), replayed, [...initial, ...updates])
        expect(replayed.shapes[0]).toMatchObject({ x: 180, props: { color: 'red' },
            browserIndex: 'a4', browserIndexVersion: normalize.version, version: edited.version })
        expect(mergeOverlayDocuments(peer, overlay).shapes).toEqual(replayed.shapes)
        expect(mergeOverlayDocuments(overlay, peer).shapes).toEqual(replayed.shapes)
        applyRemoteOps(base(), replayed, [
            { op: 'delete-object', id: order.id, version: { ts: 4, actor: 'peer' } }, order,
        ])
        expect(replayed.shapes).toEqual([])
    }
})


test.each([false, true])('fresh shape batches match serial allocation (reserved boundary: %s)', (reservedBoundary) => {
    const seed = base()
    if (reservedBoundary) {
        applyOps(seed, { shapes: [] }, [shapeOp('shape:seed')], { authorUuid: AUTHOR })
        const line = seed.blocks.find((block) => block.type === 'sceneLineItem')!
        line.line!.timestamp = crdtId(line.itemId.part1, RESERVED_CLOCK_FLOOR - 3)
    }
    const candidate = RmDocument.parse(seed.serialize())
    const control = RmDocument.parse(seed.serialize())
    const shapes = [shapeOp('shape:a', 1, 2), shapeOp('shape:b', 2, 2), shapeOp('shape:c')]
    const candidateOverlay: OverlayDocument = { shapes: [] }
    const controlOverlay: OverlayDocument = { shapes: [] }
    const opts = { authorUuid: AUTHOR }
    const expected = shapes.flatMap((shape) => applyOps(control, controlOverlay, [shape], opts).deltas)
    const clockScans = spyOn(candidate, 'maxClock')
    const frontierScans = spyOn(candidate, 'appendFrontier')
    const actual = applyOps(candidate, candidateOverlay, shapes, opts)
    if (!reservedBoundary) {
        expect(clockScans).toHaveBeenCalledTimes(1)
        expect(frontierScans).toHaveBeenCalledTimes(1)
    }
    expect(actual.deltas).toEqual(expected)
    expect(candidateOverlay).toEqual(controlOverlay)
    expect(candidate.serialize()).toEqual(control.serialize())
})
