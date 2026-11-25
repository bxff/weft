/**
 * Device MOVE awareness: xochitl moves ink as tombstone + re-add with moveId.
 * The reconciler must rewrite overlay refs to the successors instead of
 * classifying the move as an erase (text truncation / spurious detach).
 */

import { describe, expect, test } from 'bun:test'
import { RmDocument, Pen, PenColor, crdtId } from '@weft/rm-format'
import { polylineToPoints } from '@weft/rm-ink/pure'
import { applyMoveRewrites, auditOverlay } from '../src/reconciler'
import { itemRefKey, type OverlayDocument } from '../src/types'
import { RefResolver } from '../src/refs'
import { FakeDaemon } from '../src/fake-daemon'
import { OfflineSession } from '../src/offline-session'
import { encodeOp, idToOpRef, lineBlockToAddOp } from '../src/ops'
import { encodeSnapshot } from '../src/snapshot'
import { MemoryStorage } from '../src/storage'
import type { ViewPatch } from '../src/types'

const WEB = 'aaaaaaaa-0000-4000-a000-000000000001'
const TABLET = 'f73f497f-0000-4000-a000-000000000000'

function line(points: { x: number; y: number }[]) {
    return {
        kind: 'line' as const,
        tool: Pen.MARKER_2,
        color: PenColor.BLACK,
        thicknessScale: 2,
        startingLength: 0,
        timestamp: crdtId(0, 1),
        moveId: null,
        points: polylineToPoints(points, { width: 40 }),
    }
}

/** doc with two web strokes owned by one overlay shape; returns refs. */
function seed() {
    const doc = RmDocument.empty(WEB)
    const a = doc.appendLine(line([{ x: 0, y: 0 }, { x: 10, y: 10 }]), { authorUuid: WEB })
    const b = doc.appendLine(line([{ x: 20, y: 0 }, { x: 30, y: 10 }]), { authorUuid: WEB })
    const resolver = new RefResolver(doc)
    const refA = resolver.toRef(a.itemId)!
    const refB = resolver.toRef(b.itemId)!
    const overlay: OverlayDocument = {
        shapes: [
            {
                shapeId: 'shape:S',
                kind: 'text',
                props: {},
                x: 100,
                y: 200,
                rotation: 0,
                renderRevision: 'r1',
                state: 'live',
                version: { ts: 1, actor: 'web' },
                rendered: [
                    { partKey: 'glyph:0', items: [refA] },
                    { partKey: 'glyph:1', items: [refB] },
                ],
            },
        ],
    }
    return { doc, overlay, refA, refB }
}

/** tablet-move an item on `doc`: tombstone + re-add shifted with moveId. */
function deviceMove(doc: RmDocument, ref: { authorUuid: string; clock: number }, dx: number, dy: number) {
    const resolver = new RefResolver(doc)
    const id = resolver.toId(ref)!
    const block = doc.findLineItem(id)!
    const moved = {
        ...block.line!,
        moveId: block.line!.moveId ?? id,
        points: block.line!.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })),
    }
    const parentId = block.parentId
    doc.tombstone(id)
    return doc.appendLine(moved, { authorUuid: TABLET, parentId })
}

describe('applyMoveRewrites', () => {
    test('block move: refs rewritten to successors, uniform delta reported, transform shifted', () => {
        const { doc, overlay, refA, refB } = seed()
        const prev = RmDocument.parse(doc.serialize())
        deviceMove(doc, refA, 50, 25)
        deviceMove(doc, refB, 50, 25)
        const { changed, moved } = applyMoveRewrites(prev, doc, overlay)
        expect(changed).toBe(true)
        const d = moved.get('shape:S')
        expect(d).toBeTruthy()
        expect(d!.dx).toBeCloseTo(50, 1)
        expect(d!.dy).toBeCloseTo(25, 1)
        const shape = overlay.shapes[0]!
        expect(shape.x).toBeGreaterThan(100) // shifted by dx * RM_SCALE
        // rewritten refs are the live successors: audit stays quiet
        expect(auditOverlay(doc, overlay)).toHaveLength(0)
        expect(itemRefKey(shape.rendered[0]!.items[0]!)).not.toBe(itemRefKey(refA))
    })

    test('mixed move + erase leaves the shape to the erase classifier', () => {
        const { doc, overlay, refA, refB } = seed()
        const prev = RmDocument.parse(doc.serialize())
        deviceMove(doc, refA, 50, 25)
        const resolver = new RefResolver(doc)
        doc.tombstone(resolver.toId(refB)!) // plain erase, no successor
        const { changed } = applyMoveRewrites(prev, doc, overlay)
        expect(changed).toBe(false)
        expect(itemRefKey(overlay.shapes[0]!.rendered[0]!.items[0]!)).toBe(itemRefKey(refA))
    })

    test('a torn move detaches the shape and retains its successors without moving it', () => {
        const { doc, overlay, refA, refB } = seed()
        const prev = RmDocument.parse(doc.serialize())
        deviceMove(doc, refA, 50, 25)
        deviceMove(doc, refB, -80, 90)
        const { changed, detached, moved } = applyMoveRewrites(prev, doc, overlay)
        expect(changed).toBe(true)
        expect(detached).toEqual(['shape:S'])
        expect(moved.size).toBe(0)
    })

    test('audit path (no prev): refs rewritten, shape stays attached, no delta', () => {
        const { doc, overlay, refA, refB } = seed()
        deviceMove(doc, refA, 50, 25)
        deviceMove(doc, refB, 50, 25)
        const { changed, moved } = applyMoveRewrites(null, doc, overlay)
        expect(changed).toBe(true)
        expect(moved.size).toBe(0)
        expect(overlay.shapes[0]!.x).toBe(100) // transform untouched without prev
        expect(auditOverlay(doc, overlay)).toHaveLength(0)
    })

    test('repeated move (every generation carries the ORIGINAL id, like xochitl) resolves to the live one', () => {
        // a tombstoned intermediate loses its line value, so chains through
        // dead hops are not followable from doc state; xochitl stamps each
        // re-add with the ORIGINAL id, which is what this pins
        const { doc, overlay, refA, refB } = seed()
        const prev = RmDocument.parse(doc.serialize())
        const mid = deviceMove(doc, refA, 10, 0)
        // second generation: tombstone the intermediate, re-add pointing at
        // the ORIGINAL refA (device behavior, prod ops 31443/31444)
        const resolver = new RefResolver(doc)
        const midBlock = doc.findLineItem(mid.itemId)!
        const secondGen = {
            ...midBlock.line!,
            moveId: resolver.toId(refA)!,
            points: midBlock.line!.points.map((p) => ({ ...p, x: p.x + 10 })),
        }
        const parentId = midBlock.parentId
        doc.tombstone(mid.itemId)
        doc.appendLine(secondGen, { authorUuid: TABLET, parentId })
        deviceMove(doc, refB, 20, 0)
        const { changed, moved } = applyMoveRewrites(prev, doc, overlay)
        expect(changed).toBe(true)
        expect(moved.get('shape:S')!.dx).toBeCloseTo(20, 1)
        expect(auditOverlay(doc, overlay)).toHaveLength(0)
    })
})

describe('partial tablet move reconciliation', () => {
    test.each(['op replay', 'snapshot adoption'])(
        'moving one glyph detaches the text through %s',
        async (delivery) => {
            const { doc, overlay, refB } = seed()
            const daemon = new FakeDaemon()
            await daemon.putSnapshot('doc', 'page', encodeSnapshot(doc.serialize(), overlay))
            const patches: ViewPatch[] = []
            const session = await OfflineSession.open(new MemoryStorage(), daemon, 'doc', 'page', {
                clientId: 'reader',
                authorUuid: WEB,
                retryIntervalMs: 100_000,
                onPatch: (patch) => patches.push(patch),
            })

            try {
                const moved = deviceMove(doc, refB, 50, 25)
                if (delivery === 'op replay') {
                    await daemon.appendOps(
                        'doc',
                        'page',
                        [
                            encodeOp({
                                op: 'tombstone',
                                id: idToOpRef(doc, new RefResolver(doc).toId(refB)!),
                            }),
                            encodeOp(lineBlockToAddOp(doc, moved)),
                        ],
                        null,
                    )
                } else {
                    await daemon.putSnapshot(
                        'doc',
                        'page',
                        encodeSnapshot(doc.serialize(), overlay),
                    )
                }

                await session.reconcile()
                expect(patches).toContainEqual({
                    type: 'shape-detached',
                    shapeId: 'shape:S',
                })
                expect(
                    patches.some(
                        (patch) => patch.type === 'shape-moved' || patch.type === 'shape-edited',
                    ),
                ).toBe(false)
                expect(session.currentOverlay.shapes[0]).toMatchObject({
                    state: 'detached',
                    x: 100,
                    y: 200,
                })
                const successor = new RefResolver(doc).toRef(moved.itemId)!
                expect(session.currentOverlay.shapes[0]!.rendered[1]!.items).toEqual([successor])

                await daemon.appendOps('doc', 'page', [
                    encodeOp({ op: 'tombstone', id: idToOpRef(doc, moved.itemId) }),
                ], null)
                await session.reconcile()
                expect(patches).toContainEqual({ type: 'ink-removed', items: [successor] })
            } finally {
                session.dispose()
            }
        },
    )
})


test.each(['coordinates', 'point count', 'width', 'thickness scale'] as const)(
    'operation replay detaches a tablet move that alters %s',
    async (change) => {
        const { doc, overlay, refA, refB } = seed()
        const daemon = new FakeDaemon()
        await daemon.putSnapshot('doc', 'page', encodeSnapshot(doc.serialize(), overlay))
        const patches: ViewPatch[] = []
        const session = await OfflineSession.open(new MemoryStorage(), daemon, 'doc', 'page', {
            clientId: 'reader', authorUuid: WEB, retryIntervalMs: 100_000,
            onPatch: patch => patches.push(patch),
        })
        try {
            await session.reconcile()
            const movedA = deviceMove(doc, refA, 50, 25)
            const movedB = deviceMove(doc, refB, 50, 25)
            const stroke = movedA.line!
            if (change === 'coordinates') stroke.points[1]!.x += 20
            if (change === 'point count') stroke.points.pop()
            if (change === 'width') stroke.points[1]!.width *= 2
            if (change === 'thickness scale') stroke.thicknessScale *= 2
            const resolver = new RefResolver(doc)
            await daemon.appendOps('doc', 'page', [
                ...[refA, refB].map(ref => encodeOp({
                    op: 'tombstone', id: idToOpRef(doc, resolver.toId(ref)!),
                })),
                ...[movedA, movedB].map(block => encodeOp(lineBlockToAddOp(doc, block))),
            ], null)
            await session.reconcile()
            const shape = session.currentOverlay.shapes[0]!
            expect(shape).toMatchObject({ state: 'detached', x: 100, y: 200 })
            expect(shape.rendered.flatMap(part => part.items)).toEqual([
                resolver.toRef(movedA.itemId), resolver.toRef(movedB.itemId),
            ])
            expect(patches.some(patch => patch.type === 'shape-moved')).toBe(false)
            expect(patches).toContainEqual({ type: 'shape-detached', shapeId: 'shape:S' })
        } finally {
            session.dispose()
        }
    },
)

test.each(['translation', 'deformation', 'translation with tail'] as const)(
    'a warm snapshot applies %s before the replacement paint',
    async (change) => {
        const { doc, overlay, refA, refB } = seed()
        const daemon = new FakeDaemon()
        await daemon.putSnapshot('doc', 'page', encodeSnapshot(doc.serialize(), overlay))
        const seen: { patches: readonly ViewPatch[]; x: number | undefined; state: string | undefined }[] = []
        let opened: OfflineSession | undefined
        const session = await OfflineSession.open(new MemoryStorage(), daemon, 'doc', 'page', {
            clientId: 'reader', authorUuid: WEB, retryIntervalMs: 100_000,
            onPatch: () => {},
            onPatchBatch: patches => {
                const shape = opened?.currentOverlay.shapes[0]
                seen.push({ patches, x: shape?.x, state: shape?.state })
            },
        })
        opened = session
        try {
            await session.reconcile()
            seen.length = 0
            const movedA = deviceMove(doc, refA, 50, 25)
            deviceMove(doc, refB, 50, 25)
            if (change === 'deformation') movedA.line!.points[1]!.x += 20
            await daemon.putSnapshot('doc', 'page', encodeSnapshot(doc.serialize(), overlay))
            if (change === 'translation with tail') {
                const extra = doc.appendLine(line([{ x: 400, y: 500 }]), { authorUuid: TABLET })
                await daemon.appendOps('doc', 'page', [encodeOp(lineBlockToAddOp(doc, extra))], null)
            }
            await session.reconcile()
            const replacements = seen.filter(view => view.patches.some(patch => patch.type === 'document-replaced'))
            expect(replacements).toHaveLength(1)
            const [paint] = replacements
            expect(paint?.patches).toEqual([{ type: 'document-replaced' }])
            if (change === 'deformation') {
                expect(paint).toMatchObject({ state: 'detached', x: 100 })
            } else {
                expect(paint?.state).toBe('live')
                expect(paint?.x).toBeGreaterThan(100)
            }
        } finally {
            session.dispose()
        }
    },
)

describe('repeated tablet moves across separate pulls', () => {
    test.each(['op replay', 'snapshot adoption', 'cached reopen'])(
        'follows the final successor through %s',
        async (delivery) => {
            const { doc, overlay, refA, refB } = seed()
            const daemon = new FakeDaemon()
            const storage = new MemoryStorage()
            const patches: ViewPatch[] = []
            const open = () => OfflineSession.open(storage, daemon, 'doc', 'page', {
                clientId: 'reader',
                authorUuid: WEB,
                retryIntervalMs: 100_000,
                onPatch: (patch) => patches.push(patch),
            })
            await daemon.putSnapshot('doc', 'page', encodeSnapshot(doc.serialize(), overlay))
            let session = await open()

            const publishMove = async (sources: typeof refA[], dx: number) => {
                const resolver = new RefResolver(doc)
                const replacements = sources.map((source) => deviceMove(doc, source, dx, 0))
                if (delivery === 'op replay') {
                    await daemon.appendOps('doc', 'page', [
                        ...sources.map((source) => encodeOp({
                            op: 'tombstone',
                            id: idToOpRef(doc, resolver.toId(source)!),
                        })),
                        ...replacements.map((replacement) => encodeOp(lineBlockToAddOp(doc, replacement))),
                    ], null)
                } else {
                    await daemon.putSnapshot('doc', 'page', encodeSnapshot(doc.serialize(), overlay))
                }
                const latest = new RefResolver(doc)
                return replacements.map((replacement) => latest.toRef(replacement.itemId)!)
            }
            const receiveMove = async (expected: typeof refA[]) => {
                await session.reconcile()
                const shape = session.currentOverlay.shapes[0]
                expect(shape?.state).toBe('live')
                expect(shape?.rendered.flatMap((part) => part.items)).toEqual(expected)
            }

            try {
                await session.reconcile()
                const intermediate = await publishMove([refA, refB], 10)
                await receiveMove(intermediate)
                if (delivery === 'cached reopen') {
                    session.dispose()
                }
                const final = await publishMove(intermediate, 20)
                if (delivery === 'cached reopen') session = await open()
                await receiveMove(final)
                expect(auditOverlay(session.document, session.currentOverlay)).toEqual([])
                expect(patches.filter((patch) => patch.type === 'shape-moved').map((patch) => patch.dx))
                    .toEqual([10, 20])

                await daemon.appendOps('doc', 'page', final.map((ref) => encodeOp({
                    op: 'tombstone',
                    id: { author: ref.authorUuid, clock: ref.clock },
                })), null)
                await session.reconcile()
                expect(patches).toContainEqual({ type: 'shape-removed', shapeId: 'shape:S' })
                expect(session.currentOverlay.shapes).toEqual([])
            } finally {
                session.dispose()
            }
        },
    )

    test('repeated moves of detached ink still allow the shape to replace its latest strokes', async () => {
        const { doc, overlay, refA, refB } = seed()
        const daemon = new FakeDaemon()
        await daemon.putSnapshot('doc', 'page', encodeSnapshot(doc.serialize(), overlay))
        const patches: ViewPatch[] = []
        const session = await OfflineSession.open(new MemoryStorage(), daemon, 'doc', 'page', {
            clientId: 'reader',
            authorUuid: WEB,
            retryIntervalMs: 100_000,
            onPatch: (patch) => patches.push(patch),
        })
        try {
            await session.reconcile()
            const first = deviceMove(doc, refB, 10, 0)
            await daemon.putSnapshot('doc', 'page', encodeSnapshot(doc.serialize(), overlay))
            await session.reconcile()
            expect(session.currentOverlay.shapes[0]?.state).toBe('detached')

            const intermediate = new RefResolver(doc).toRef(first.itemId)!
            const second = deviceMove(doc, intermediate, 20, 0)
            await daemon.putSnapshot('doc', 'page', encodeSnapshot(doc.serialize(), overlay))
            await session.reconcile()
            const replacement = new RefResolver(doc).toRef(second.itemId)!
            const detached = session.currentOverlay.shapes[0]!
            expect(detached).toMatchObject({ state: 'detached', x: 100, y: 200 })
            expect(detached.rendered.flatMap((part) => part.items)).toEqual([refA, replacement])
            expect(patches.filter((patch) => patch.type === 'shape-moved')).toEqual([])

            await session.apply([{
                type: 'upsert-shape',
                shape: {
                    ...detached,
                    renderRevision: 'reattached',
                    version: { ts: detached.version.ts + 1, actor: 'reader' },
                },
                parts: detached.rendered.map((part) => ({
                    partKey: part.partKey,
                    strokes: [{ points: line([{ x: 0, y: 0 }, { x: 5, y: 5 }]).points, color: 'black' }],
                })),
            }])
            await session.reconcile()
            const attached = session.currentOverlay.shapes[0]!
            expect(attached.state).toBe('live')
            const resolver = new RefResolver(session.document)
            const liveRefs = session.document.blocks.flatMap((block) => {
                if (block.type !== 'sceneLineItem' || block.deletedLength > 0) return []
                return [resolver.toRef(block.itemId)]
            })
            expect(liveRefs).toEqual(attached.rendered.flatMap((part) => part.items))
        } finally {
            session.dispose()
        }
    })
})

describe('native move lineage identity', () => {
    function repeatFixture(authoredLayer = false) {
        const { doc, overlay, refA } = seed()
        overlay.shapes[0]!.rendered.pop()
        if (authoredLayer) {
            const source = doc.findLineItem(new RefResolver(doc).toId(refA)!)!
            source.parentId = doc.createLayer('Layer with an author', { authorUuid: WEB })
        }
        const initial = RmDocument.parse(doc.serialize())
        const first = deviceMove(doc, refA, 10, 0)
        applyMoveRewrites(initial, doc, overlay)
        const previous = RmDocument.parse(doc.serialize())
        const intermediate = new RefResolver(doc).toRef(first.itemId)!
        const second = deviceMove(doc, intermediate, 20, 0)
        return { doc, overlay, previous, second, intermediate }
    }

    test('an explicit first move can cross layers when its source is unique', () => {
        const { doc, overlay, refA } = seed()
        overlay.shapes[0]!.rendered.pop()
        const previous = RmDocument.parse(doc.serialize())
        const replacement = deviceMove(doc, refA, 10, 0)
        replacement.parentId = doc.createLayer('Another layer', { authorUuid: TABLET })
        expect(applyMoveRewrites(previous, doc, overlay).moved.get('shape:S')?.dx).toBe(10)
        expect(overlay.shapes[0]!.rendered[0]!.items).toEqual([
            new RefResolver(doc).toRef(replacement.itemId),
        ])
    })

    test('an explicit move cannot resolve which of two aliased tombstones it replaced', () => {
        const { doc, overlay, refA } = seed()
        overlay.shapes[0]!.rendered.pop()
        const previous = RmDocument.parse(doc.serialize())
        deviceMove(doc, refA, 10, 0)
        const source = doc.findLineItem(new RefResolver(doc).toId(refA)!)!
        const authors = doc.blocks.find((block) => block.type === 'authorIds')!
        authors.authors.set(9, WEB)
        doc.blocks.push({ ...source, itemId: crdtId(9, source.itemId.part2) })
        expect(applyMoveRewrites(previous, doc, overlay).changed).toBe(false)
        expect(overlay.shapes[0]!.rendered[0]!.items).toEqual([refA])
    })

    test('the same original stroke can be encoded under another author slot', () => {
        const { doc, overlay, previous, second } = repeatFixture()
        const authors = doc.blocks.find((block) => block.type === 'authorIds')!
        authors.authors.set(9, WEB)
        second.line!.moveId = crdtId(9, second.line!.moveId!.part2)
        expect(applyMoveRewrites(previous, doc, overlay).moved.get('shape:S')?.dx).toBe(20)
        expect(overlay.shapes[0]!.rendered[0]!.items).toEqual([
            new RefResolver(doc).toRef(second.itemId),
        ])
    })

    test('an origin match in a different layer cannot rebind the shape', () => {
        const { doc, overlay, previous, second, intermediate } = repeatFixture()
        second.parentId = doc.createLayer('Another layer', { authorUuid: TABLET })
        expect(applyMoveRewrites(previous, doc, overlay).changed).toBe(false)
        expect(overlay.shapes[0]!.rendered[0]!.items).toEqual([intermediate])
    })

    test.each(['tree declarations', 'group links'])('aliased %s cannot prove a layer match', (records) => {
        const { doc, overlay, previous, second, intermediate } = repeatFixture(true)
        const group = doc.blocks.find((block) => block.type === 'sceneTree' &&
            block.treeId.part1 === second.parentId.part1 && block.treeId.part2 === second.parentId.part2)
        if (!group || group.type !== 'sceneTree') throw new Error('fixture layer is missing')
        const authors = doc.blocks.find((block) => block.type === 'authorIds')!
        authors.authors.set(9, WEB)
        const alias = crdtId(9, group.treeId.part2)
        if (records === 'tree declarations') doc.blocks.push({ ...group, treeId: alias })
        else group.treeId = alias // the old group is still identified by its node and link
        second.parentId = alias
        expect(applyMoveRewrites(previous, doc, overlay).changed).toBe(false)
        expect(overlay.shapes[0]!.rendered[0]!.items).toEqual([intermediate])
    })

    test('ambiguous tombstones in the immediate predecessor block older lineage evidence', () => {
        const { doc, overlay, previous, intermediate } = repeatFixture()
        const immediate = RmDocument.parse(doc.serialize())
        const old = immediate.findLineItem(new RefResolver(immediate).toId(intermediate)!)!
        const authors = immediate.blocks.find((block) => block.type === 'authorIds')!
        authors.authors.set(9, TABLET)
        immediate.blocks.push({ ...old, itemId: crdtId(9, old.itemId.part2) })
        expect(applyMoveRewrites(immediate, doc, overlay, previous).changed).toBe(false)
        expect(overlay.shapes[0]!.rendered[0]!.items).toEqual([intermediate])
    })

    test('a tombstone in another layer contradicts older lineage evidence', () => {
        const { doc, overlay, previous, intermediate } = repeatFixture()
        const immediate = RmDocument.parse(doc.serialize())
        const old = immediate.findLineItem(new RefResolver(immediate).toId(intermediate)!)!
        old.parentId = immediate.createLayer('Unrelated layer', { authorUuid: TABLET })
        expect(applyMoveRewrites(immediate, doc, overlay, previous).changed).toBe(false)
        expect(overlay.shapes[0]!.rendered[0]!.items).toEqual([intermediate])
    })

    test('claims from different snapshots cannot give two shapes the same successor', () => {
        const { doc, overlay, previous, second } = repeatFixture()
        const immediate = RmDocument.parse(doc.serialize())
        const secondRef = new RefResolver(doc).toRef(second.itemId)!
        const other = { ...structuredClone(overlay.shapes[0]!), shapeId: 'shape:T' }
        other.rendered[0]!.items = [secondRef]
        overlay.shapes.push(other)
        deviceMove(doc, secondRef, 30, 0)
        expect(applyMoveRewrites(immediate, doc, overlay, previous).changed).toBe(false)
    })

    test('multiple live successors in the current layer leave lineage unresolved', () => {
        const { doc, overlay, previous, second, intermediate } = repeatFixture()
        doc.appendLine(second.line!, { authorUuid: TABLET, parentId: second.parentId })
        expect(applyMoveRewrites(previous, doc, overlay).changed).toBe(false)
        expect(overlay.shapes[0]!.rendered[0]!.items).toEqual([intermediate])
    })

    test('a previously shared origin cannot establish which rendition moved again', () => {
        const { doc, overlay, previous, intermediate } = repeatFixture()
        const current = previous.findLineItem(new RefResolver(previous).toId(intermediate)!)!
        previous.appendLine(current.line!, { authorUuid: TABLET, parentId: current.parentId })
        expect(applyMoveRewrites(previous, doc, overlay).changed).toBe(false)
        expect(overlay.shapes[0]!.rendered[0]!.items).toEqual([intermediate])
    })

    test('a successor whose portable reference collides across layers stays unowned', () => {
        const { doc, overlay, previous, second, intermediate } = repeatFixture()
        const otherLayer = doc.createLayer('Another layer', { authorUuid: TABLET })
        const authors = doc.blocks.find((block) => block.type === 'authorIds')!
        authors.authors.set(9, TABLET)
        doc.blocks.push({
            ...second,
            itemId: crdtId(9, second.itemId.part2),
            parentId: otherLayer,
            line: { ...second.line!, moveId: null },
        })
        expect(applyMoveRewrites(previous, doc, overlay).changed).toBe(false)
        expect(overlay.shapes[0]!.rendered[0]!.items).toEqual([intermediate])
    })
})

test('an erase can detach a shape while preserving its proven move successor', async () => {
    const { doc, overlay, refA, refB } = seed()
    const extra = doc.appendLine(line([{ x: 40, y: 10 }]), { authorUuid: WEB })
    const refC = new RefResolver(doc).toRef(extra.itemId)!
    overlay.shapes[0]!.rendered.push({ partKey: 'glyph:2', items: [refC], contentHash: 'sample' })
    const daemon = new FakeDaemon()
    await daemon.putSnapshot('doc', 'page', encodeSnapshot(doc.serialize(), overlay))
    const session = await OfflineSession.open(new MemoryStorage(), daemon, 'doc', 'page', {
        clientId: 'reader', authorUuid: WEB, retryIntervalMs: 100_000, onPatch: () => {},
    })
    try {
        await session.reconcile()
        const resolver = new RefResolver(doc)
        const moved = deviceMove(doc, refA, 10, 0)
        await daemon.appendOps('doc', 'page', [
            ...[refA, refB].map((ref) => encodeOp({
                op: 'tombstone', id: idToOpRef(doc, resolver.toId(ref)!),
            })),
            encodeOp(lineBlockToAddOp(doc, moved)),
        ], null)
        await session.reconcile()
        const shape = session.currentOverlay.shapes[0]!
        expect(shape.state).toBe('detached')
        expect(shape.rendered.flatMap((part) => part.items)).toEqual([
            new RefResolver(doc).toRef(moved.itemId), refB, refC,
        ])
    } finally {
        session.dispose()
    }
})
