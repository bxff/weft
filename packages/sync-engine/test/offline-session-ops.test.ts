/**
 * OfflineSession op-mode (useOps) end-to-end against the FakeDaemon op
 * channel: two clients converge via commutative deltas (no CAS), edits
 * survive offline + restart, and a late joiner bootstraps from snapshot +
 * replay.
 */

import { describe, expect, spyOn, test } from 'bun:test'
import { OfflineSession } from '../src/offline-session'
import { MemoryStorage, type StorageEntry } from '../src/storage'
import { FakeDaemon } from '../src/fake-daemon'
import type { ViewPatch } from '../src/types'
import { applyOps, type LocalOp } from '../src/apply-ops'
import { applyInkDeltas, encodeOp, lineBlockToAddOp } from '../src/ops'
import { RmDocument } from '@weft/rm-format'
import { polylineToPoints } from '@weft/rm-ink/pure'

const DOC = 'doc-1'
const PAGE = 'page-1'
const AUTHOR_A = 'aaaaaaaa-0000-4000-a000-000000000001'
const AUTHOR_B = 'bbbbbbbb-0000-4000-a000-000000000002'

function shapeOp(shapeId: string, offset = 0, actor = 'client-A'): LocalOp {
    return {
        type: 'upsert-shape',
        shape: {
            shapeId,
            kind: 'draw-native',
            props: { id: shapeId },
            x: 0,
            y: 0,
            rotation: 0,
            renderRevision: `r-${shapeId}-${offset}`,
            // wall-clock LWW version: later offset = newer edit
            version: { ts: offset, actor },
        },
        parts: [
            {
                partKey: 'p0',
                strokes: [
                    {
                        points: polylineToPoints(
                            [
                                { x: 10 + offset, y: 10 },
                                { x: 90 + offset, y: 90 },
                            ],
                            { width: 40 },
                        ),
                        color: 'black',
                    },
                ],
            },
        ],
    }
}

function liveLines(doc: import('@weft/rm-format').RmDocument): number {
    return (doc.blocks as unknown as { type: string; deletedLength: number }[]).filter(
        (b) => b.type === 'sceneLineItem' && b.deletedLength === 0,
    ).length
}

function liveImages(doc: import('@weft/rm-format').RmDocument): number {
    return (doc.blocks as unknown as { type: string; deletedLength: number }[]).filter(
        (b) => b.type === 'sceneImageItem' && b.deletedLength === 0,
    ).length
}

const VERTS = [0, 0, 0, 0, 100, 0, 1, 0, 100, 100, 1, 1, 0, 100, 0, 1]

async function openSession(
    daemon: FakeDaemon,
    storage: MemoryStorage,
    clientId: string,
    author: string,
    patches: ViewPatch[] = [],
) {
    return OfflineSession.open(storage, daemon, DOC, PAGE, {
        clientId,
        authorUuid: author,
        useOps: true,
        retryIntervalMs: 100000, // disable the timer; reconcile is driven explicitly
        onPatch: (p) => patches.push(p),
    })
}

// let the chained reconcile (and any it schedules) settle
async function settle(...sessions: OfflineSession[]) {
    for (let i = 0; i < 5; i++) {
        await Promise.all(sessions.map((s) => s.reconcile()))
    }
}

describe('OfflineSession op-mode', () => {
    test('accepted ink replays without parsing the resident page or rewriting its opaque blocks', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        daemon.subscribe = () => () => {}
        const seed = RmDocument.empty(AUTHOR_A)
        seed.blocks.push({
            type: 'raw', blockType: 0xe1, version: { min: 0, current: 1 },
            data: new Uint8Array([0x42, 0x00, 0xff]), extraData: new Uint8Array(), parseError: null,
        })
        const initial = applyOps(seed, { shapes: [] }, [shapeOp('shape:deleted')], { authorUuid: AUTHOR_A })
        const line = seed.blocks.find((block) => block.type === 'sceneLineItem')!
        const lineRef = lineBlockToAddOp(seed, line).id
        const { encodeSnapshot } = await import('../src/snapshot')
        await daemon.putSnapshot(DOC, PAGE, encodeSnapshot(seed.serialize(), initial.overlay))
        const reader = await openSession(daemon, new MemoryStorage(), 'reader', AUTHOR_A)
        try {
            await settle(reader)
            const before = reader.document
            const original = before.serialize()
            const expected = RmDocument.parse(original)
            const { deltas } = applyOps(
                RmDocument.parse(original), { shapes: [] }, [shapeOp('shape:peer')],
                { authorUuid: AUTHOR_B },
            )
            const ink = deltas.filter((op) => op.op === 'add' || op.op === 'tombstone')
            const erase = { op: 'tombstone' as const, id: lineRef }
            applyInkDeltas(expected, [...ink, erase])
            await daemon.appendOps(DOC, PAGE, [...deltas, erase].map(encodeOp), AUTHOR_B)

            const parse = spyOn(RmDocument, 'parse')
            try {
                await reader.reconcile()
                expect(parse).not.toHaveBeenCalled()
            } finally {
                parse.mockRestore()
            }
            expect(reader.document.serialize()).toEqual(expected.serialize())
            expect(before.serialize()).toEqual(original)
            expect(reader.currentOverlay.shapes.map(({ shapeId }) => shapeId)).toEqual(['shape:peer'])
        } finally {
            reader.dispose()
        }
    })

    test('an opt-in observer receives accepted op patches after the batch is installed', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        daemon.subscribe = () => () => {}
        const writer = await openSession(daemon, new MemoryStorage(), 'writer', AUTHOR_A)
        const batches: (readonly ViewPatch[])[] = []
        const singles: ViewPatch[] = []
        let acceptedShapes: string[] = []
        const reader = await OfflineSession.open(new MemoryStorage(), daemon, DOC, PAGE, {
            clientId: 'reader', authorUuid: AUTHOR_B,
            onPatch: patch => singles.push(patch),
            onPatchBatch: patches => {
                batches.push(patches)
                acceptedShapes = reader.currentOverlay.shapes.map(shape => shape.shapeId)
            },
        })
        try {
            await settle(writer, reader)
            singles.length = 0
            batches.length = 0
            await writer.apply([shapeOp('shape:first', 1), shapeOp('shape:second', 2)])
            await settle(writer, reader)
            expect(batches).toHaveLength(1)
            expect(batches[0]?.flatMap(p => p.type === 'shape-upserted' ? [p.shape.shapeId] : []))
                .toEqual(['shape:first', 'shape:second'])
            expect(acceptedShapes).toEqual(['shape:first', 'shape:second'])
            expect(singles).toHaveLength(0)

            const { encodeSnapshot } = await import('../src/snapshot')
            await daemon.putSnapshot(DOC, PAGE, encodeSnapshot(reader.document.serialize(), reader.currentOverlay))
            const { deltas } = applyOps(
                RmDocument.parse(reader.document.serialize()), structuredClone(reader.currentOverlay),
                [shapeOp('shape:tail', 3)], { authorUuid: AUTHOR_A },
            )
            await daemon.appendOps(DOC, PAGE, deltas.map(encodeOp), AUTHOR_A)
            await settle(writer, reader)
            expect(singles).toHaveLength(0)
            expect(batches).toHaveLength(2)
            expect(batches[1]).toEqual([{ type: 'document-replaced' }])
            expect(acceptedShapes).toEqual(['shape:first', 'shape:second', 'shape:tail'])
        } finally {
            writer.dispose()
            reader.dispose()
        }
    })

    test('a local edit ships as deltas and lands on the relay', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A)
        await a.apply([shapeOp('shape:a')])
        await settle(a)

        const ops = await daemon.opsSince(DOC, PAGE, 0)
        expect(ops.length).toBeGreaterThan(0)
        expect(a.pendingCount).toBe(0)
        expect(liveLines(a.document)).toBe(1)
        a.dispose()
    })

    test('two clients converge on the union of their ink (no CAS, no loss)', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A)
        const b = await openSession(daemon, new MemoryStorage(), 'client-B', AUTHOR_B)

        await a.apply([shapeOp('shape:a', 0)])
        await b.apply([shapeOp('shape:b', 1000)])
        await settle(a, b)

        // both shapes' ink exists on both clients
        expect(liveLines(a.document)).toBe(2)
        expect(liveLines(b.document)).toBe(2)
        expect(a.currentOverlay.shapes.map((s) => s.shapeId).sort()).toEqual(['shape:a', 'shape:b'])
        expect(b.currentOverlay.shapes.map((s) => s.shapeId).sort()).toEqual(['shape:a', 'shape:b'])
        a.dispose()
        b.dispose()
    })

    test('a foreign upsert reaches the peer as a shape-upserted patch', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const aPatches: ViewPatch[] = []
        const bPatches: ViewPatch[] = []
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A, aPatches)
        const b = await openSession(daemon, new MemoryStorage(), 'client-B', AUTHOR_B, bPatches)

        await a.apply([shapeOp('shape:a')])
        await settle(a, b)

        // B sees A's new shape; A does NOT get a churn patch for its own shape
        expect(bPatches.some((p) => p.type === 'shape-upserted' && p.shape.shapeId === 'shape:a')).toBe(true)
        expect(aPatches.some((p) => p.type === 'shape-upserted')).toBe(false)
        a.dispose()
        b.dispose()
    })

    test('edits made offline survive a restart and flush when the relay returns', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const storage = new MemoryStorage()
        // unreachable transport: every network call throws DeviceUnreachable
        const offline = new Proxy(daemon, {
            get(target, prop) {
                if (['appendOps', 'opsSince', 'getSnapshot', 'putSnapshot'].includes(prop as string)) {
                    return async () => {
                        throw new (await import('../src/types')).EngineFailure({
                            _tag: 'DeviceUnreachable',
                            cause: 'offline',
                        })
                    }
                }
                const v = (target as unknown as Record<string, unknown>)[prop as string]
                return typeof v === 'function' ? v.bind(target) : v
            },
        }) as unknown as FakeDaemon

        const a1 = await openSession(offline, storage, 'client-A', AUTHOR_A)
        await a1.apply([shapeOp('shape:a')])
        await settle(a1)
        expect(a1.pendingCount).toBe(1) // couldn't ship: still pending
        a1.dispose()

        // pending ops persist under this tab's per-author key, not the shared state blob
        const persisted = JSON.parse(
            new TextDecoder().decode(
                (await storage.get(`page/${DOC}/${PAGE}/pending/${AUTHOR_A}`))!,
            ),
        ) as unknown[]
        expect(persisted).toHaveLength(1)
        expect(await daemon.opsSince(DOC, PAGE, 0)).toEqual([]) // nothing shipped while offline

        // restart against the real (reachable) daemon, same storage -> it flushes
        const a2 = await openSession(daemon, storage, 'client-A', AUTHOR_A)
        await settle(a2)
        expect(a2.pendingCount).toBe(0) // flushed after the relay returned
        expect((await daemon.opsSince(DOC, PAGE, 0)).length).toBeGreaterThan(0)
        expect(liveLines(a2.document)).toBe(1)
        a2.dispose()
    })

    test('a late joiner bootstraps from snapshot + replay', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A)
        await a.apply([shapeOp('shape:a', 0)])
        await settle(a)
        // compaction: publish a snapshot folding in the ops so far
        const snapBytes = (await import('../src/snapshot')).encodeSnapshot(
            a.document.serialize(),
            a.currentOverlay,
        )
        await daemon.putSnapshot(DOC, PAGE, snapBytes)
        // then A draws more (ops after the snapshot)
        await a.apply([shapeOp('shape:a2', 500)])
        await settle(a)

        // C joins fresh: must reconstruct = snapshot + ops-after-snapshot
        const c = await openSession(daemon, new MemoryStorage(), 'client-C', AUTHOR_A)
        await settle(c)
        expect(liveLines(c.document)).toBe(2)
        expect(c.currentOverlay.shapes.map((s) => s.shapeId).sort()).toEqual(['shape:a', 'shape:a2'])
        a.dispose()
        c.dispose()
    })

    test('an incomplete (image) op publishes a snapshot the peer re-bootstraps from', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A)
        const bPatches: ViewPatch[] = []
        const b = await openSession(daemon, new MemoryStorage(), 'client-B', AUTHOR_B, bPatches)

        // some normal ink first, then an image (no replayable delta -> snapshot)
        await a.apply([shapeOp('shape:a')])
        await a.apply([
            {
                type: 'insert-image',
                assetUuid: 'eeeeeeee-0000-4000-a000-0000000000ff',
                filename: 'eeeeeeee-0000-4000-a000-0000000000ff.png',
                vertices: VERTS,
            },
        ])
        await settle(a, b)

        // A holds both; B reconstructs the image from the snapshot (the op
        // log alone can't carry it) via a document-replaced rebuild
        expect(liveImages(a.document)).toBe(1)
        expect(liveImages(b.document)).toBe(1)
        expect(liveLines(b.document)).toBe(1)
        expect(bPatches.some((p) => p.type === 'document-replaced')).toBe(true)
        a.dispose()
        b.dispose()
    })

    test('the pusher does NOT re-bootstrap from its own incomplete-op snapshot', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const aPatches: ViewPatch[] = []
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A, aPatches)
        await a.apply([
            {
                type: 'insert-image',
                assetUuid: 'eeeeeeee-0000-4000-a000-0000000000ff',
                filename: 'eeeeeeee-0000-4000-a000-0000000000ff.png',
                vertices: VERTS,
            },
        ])
        await settle(a)
        // exactly one image, and no document-replaced churn from its own snapshot
        expect(liveImages(a.document)).toBe(1)
        expect(aPatches.filter((p) => p.type === 'document-replaced')).toHaveLength(0)
        a.dispose()
    })

    test('concurrent edits to the SAME shapeId converge (union-by-id LWW)', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A)
        const b = await openSession(daemon, new MemoryStorage(), 'client-B', AUTHOR_B)
        await a.apply([shapeOp('shape:x', 0, 'client-A')])
        await b.apply([shapeOp('shape:x', 7000, 'client-B')])
        await settle(a, b)

        // one shape id on both; both agree on the same survivor since the
        // higher wall-clock ts (7000) wins deterministically on both
        const aShapes = a.currentOverlay.shapes.filter((s) => s.shapeId === 'shape:x')
        const bShapes = b.currentOverlay.shapes.filter((s) => s.shapeId === 'shape:x')
        expect(aShapes).toHaveLength(1)
        expect(bShapes).toHaveLength(1)
        expect(aShapes[0]!.renderRevision).toBe(bShapes[0]!.renderRevision)
        expect(aShapes[0]!.renderRevision).toBe('r-shape:x-7000')
        expect(aShapes[0]!.version).toEqual({ ts: 7000, actor: 'client-B' })
        expect(bShapes[0]!.version).toEqual({ ts: 7000, actor: 'client-B' })
        a.dispose()
        b.dispose()
    })

    test('a STALE local pending upsert does NOT clobber a NEWER already-pulled remote edit', async () => {
        // pull-before-push rebase: pulling the newer remote edit before
        // re-applying a stale local upsert must not let the stale write win
        // or re-propagate to the peer.
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A)
        const b = await openSession(daemon, new MemoryStorage(), 'client-B', AUTHOR_B)

        await b.apply([shapeOp('shape:x', 200, 'client-B')])
        await settle(b)

        // A edits the SAME id OLDER (offline: its clock is behind), then syncs
        await a.apply([shapeOp('shape:x', 100, 'client-A')])
        await settle(a, b)

        const aShapes = a.currentOverlay.shapes.filter((s) => s.shapeId === 'shape:x')
        const bShapes = b.currentOverlay.shapes.filter((s) => s.shapeId === 'shape:x')
        expect(aShapes).toHaveLength(1)
        expect(bShapes).toHaveLength(1)
        // the newer edit wins on both: deterministic convergence, no silent loss
        expect(aShapes[0]!.version).toEqual({ ts: 200, actor: 'client-B' })
        expect(bShapes[0]!.version).toEqual({ ts: 200, actor: 'client-B' })
        expect(aShapes[0]!.renderRevision).toBe('r-shape:x-200')
        expect(bShapes[0]!.renderRevision).toBe('r-shape:x-200')
        expect(aShapes[0]!.renderRevision).toBe(bShapes[0]!.renderRevision)
        a.dispose()
        b.dispose()
    })

    test('a NEWER local pending upsert wins over an already-pulled OLDER remote edit', async () => {
        // symmetric case: A's newer pending edit wins over an already-pulled
        // older remote edit and propagates to B as a delta.
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A)
        const b = await openSession(daemon, new MemoryStorage(), 'client-B', AUTHOR_B)

        await b.apply([shapeOp('shape:x', 100, 'client-B')])
        await settle(b)

        await a.apply([shapeOp('shape:x', 300, 'client-A')])
        await settle(a, b)

        const aShapes = a.currentOverlay.shapes.filter((s) => s.shapeId === 'shape:x')
        const bShapes = b.currentOverlay.shapes.filter((s) => s.shapeId === 'shape:x')
        expect(aShapes).toHaveLength(1)
        expect(bShapes).toHaveLength(1)
        expect(aShapes[0]!.version).toEqual({ ts: 300, actor: 'client-A' })
        expect(bShapes[0]!.version).toEqual({ ts: 300, actor: 'client-A' })
        expect(aShapes[0]!.renderRevision).toBe('r-shape:x-300')
        expect(bShapes[0]!.renderRevision).toBe('r-shape:x-300')
        a.dispose()
        b.dispose()
    })

    test('a STALE local pending upsert cannot resurrect a shape a peer already deleted', async () => {
        // delete-vs-stale-upsert: a versioned tombstone must dominate a stale
        // offline upsert pulled in after it.
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A)
        const b = await openSession(daemon, new MemoryStorage(), 'client-B', AUTHOR_B)

        await b.apply([shapeOp('shape:x', 50, 'client-B')])
        await settle(b)
        await b.apply([{ type: 'remove-shape', shapeId: 'shape:x', version: { ts: 200, actor: 'client-B' } }])
        await settle(b)

        // A's stale (older than the delete) upsert to the same id
        await a.apply([shapeOp('shape:x', 100, 'client-A')])
        await settle(a, b)

        expect(a.currentOverlay.shapes.filter((s) => s.shapeId === 'shape:x')).toEqual([])
        expect(b.currentOverlay.shapes.filter((s) => s.shapeId === 'shape:x')).toEqual([])
        // versioned tombstone dominates on both
        expect(a.currentOverlay.tombstones?.['shape:x']).toEqual({ ts: 200, actor: 'client-B' })
        expect(b.currentOverlay.tombstones?.['shape:x']).toEqual({ ts: 200, actor: 'client-B' })
        a.dispose()
        b.dispose()
    })

    test('an interleaved foreign op (seq below a local push) is not skipped', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A)
        await settle(a) // cursor caught up to head (0)

        // a foreign op lands directly on the relay (another peer), THEN A pushes
        // its own edit. A's cursor was 0; its push does not advance the cursor,
        // so the next pull must still pick up the foreign op.
        const foreign = await openSession(daemon, new MemoryStorage(), 'client-F', AUTHOR_B)
        await foreign.apply([shapeOp('shape:f', 3000)])
        await settle(foreign)

        await a.apply([shapeOp('shape:a', 0)])
        await settle(a)
        expect(liveLines(a.document)).toBe(2) // both the foreign and the local ink
        expect(a.currentOverlay.shapes.map((s) => s.shapeId).sort()).toEqual(['shape:a', 'shape:f'])
        a.dispose()
        foreign.dispose()
    })

    test('duplicate ops in the relay log never duplicate ink (idempotent replay)', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A)
        await a.apply([shapeOp('shape:a')])
        await settle(a)
        // simulate a re-push after a lost response: append the same op blobs again
        const existing = await daemon.opsSince(DOC, PAGE, 0)
        await daemon.appendOps(DOC, PAGE, existing.map((o) => o.op), AUTHOR_A)

        // a fresh client reconstructs from the doubled log: still one line
        const c = await openSession(daemon, new MemoryStorage(), 'client-C', AUTHOR_A)
        await settle(c)
        expect(liveLines(c.document)).toBe(1)
        a.dispose()
        c.dispose()
    })

    test('a lagging client below the truncation floor re-bootstraps; its pending op survives (#52)', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)

        // A's transport is unsubscribed (only syncs when driven) so it can lag;
        // getSnapshot can arm a one-shot compaction+truncation landing between
        // the snapshot fetch and opsSince. Only the /ops gap signal
        // (410/OpsTruncated) catches this interleaving; the snapshot-supersede
        // check alone would let A silently pull a gapped log and diverge.
        let compactOnNextSnapshotFetch: (() => Promise<void>) | null = null
        const laggingTransport = new Proxy(daemon, {
            get(target, prop) {
                if (prop === 'subscribe') return () => () => {}
                if (prop === 'getSnapshot') {
                    return async (doc: string, page: string) => {
                        const snap = await target.getSnapshot(doc, page)
                        if (compactOnNextSnapshotFetch) {
                            const run = compactOnNextSnapshotFetch
                            compactOnNextSnapshotFetch = null
                            await run()
                        }
                        return snap
                    }
                }
                const v = (target as unknown as Record<string, unknown>)[prop as string]
                return typeof v === 'function' ? v.bind(target) : v
            },
        }) as unknown as FakeDaemon
        const { encodeSnapshot } = await import('../src/snapshot')

        // B draws; a snapshot folds the head; A bootstraps from it and settles.
        const b = await openSession(daemon, new MemoryStorage(), 'client-B', AUTHOR_B)
        await b.apply([shapeOp('shape:b1', 100)])
        await settle(b)
        await daemon.putSnapshot(DOC, PAGE, encodeSnapshot(b.document.serialize(), b.currentOverlay))
        const aPatches: ViewPatch[] = []
        const a = await openSession(laggingTransport, new MemoryStorage(), 'client-A', AUTHOR_A, aPatches)
        await settle(a)
        expect(liveLines(a.document)).toBe(1)

        // B keeps editing; A hears nothing (not subscribed) -> A's cursor lags.
        await b.apply([shapeOp('shape:b2', 200)])
        await settle(b)
        const head = (await daemon.opsSince(DOC, PAGE, 0)).at(-1)!.seq

        // Arm the race: as A pulls, compaction publishes a head checkpoint and
        // truncates the whole folded log, leaving A's cursor below the floor.
        compactOnNextSnapshotFetch = async () => {
            await daemon.putSnapshot(
                DOC,
                PAGE,
                encodeSnapshot(b.document.serialize(), b.currentOverlay),
            )
            daemon.truncate(DOC, PAGE, head)
        }
        const replacedBefore = aPatches.filter((p) => p.type === 'document-replaced').length

        // A queues a local op and syncs: the pull hits OpsTruncated, A
        // re-bootstraps from the new snapshot, then the pending op pushes.
        await a.apply([shapeOp('shape:a-pending', 300, 'client-A')])
        await settle(a, b)

        expect(a.pendingCount).toBe(0)
        // the gap forced a re-bootstrap (a document-replaced beyond the initial one)
        expect(aPatches.filter((p) => p.type === 'document-replaced').length).toBeGreaterThan(
            replacedBefore,
        )
        // no loss, no duplication: exactly the three strokes on both peers
        expect(liveLines(a.document)).toBe(3)
        expect(liveLines(b.document)).toBe(3)
        expect(a.currentOverlay.shapes.map((s) => s.shapeId).sort()).toEqual([
            'shape:a-pending',
            'shape:b1',
            'shape:b2',
        ])

        // a fresh client converges to the same content as the re-bootstrapped A
        const c = await openSession(daemon, new MemoryStorage(), 'client-C', AUTHOR_B)
        await settle(c)
        expect(liveLines(c.document)).toBe(3)
        expect(c.currentOverlay.shapes.map((s) => s.shapeId).sort()).toEqual(
            a.currentOverlay.shapes.map((s) => s.shapeId).sort(),
        )
        a.dispose()
        b.dispose()
        c.dispose()
    })

    test('a foreign erase removes the ink on the peer (tombstone delta)', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A)
        const b = await openSession(daemon, new MemoryStorage(), 'client-B', AUTHOR_B)
        await a.apply([shapeOp('shape:a', 1)])
        await settle(a, b)
        expect(liveLines(b.document)).toBe(1)

        // A removes the shape -> tombstone + delete-object deltas (newer version)
        await a.apply([{ type: 'remove-shape', shapeId: 'shape:a', version: { ts: 2, actor: 'client-A' } }])
        await settle(a, b)
        expect(liveLines(a.document)).toBe(0)
        expect(liveLines(b.document)).toBe(0)
        expect(b.currentOverlay.shapes).toEqual([])
        a.dispose()
        b.dispose()
    })
})

    test('QUOTA FULL: pushes refused with 507 never crash or lose ink; edits push after space frees', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        // wrap the transport so appendOps behaves like the cloud at quota:
        // 507 storage refusals (surfaced as an EngineFailure by HttpTransport)
        let full = true
        const quotaTransport = new Proxy(daemon, {
            get(target, prop) {
                if (prop === 'appendOps') {
                    return async (...args: unknown[]) => {
                        if (full) {
                            throw new EngineFailure({
                                _tag: 'DeviceUnreachable',
                                cause: 'POST ops 507',
                            })
                        }
                        return (
                            target.appendOps as unknown as (...a: unknown[]) => Promise<unknown>
                        )(...args)
                    }
                }
                const v = (target as unknown as Record<string, unknown>)[prop as string]
                return typeof v === 'function' ? v.bind(target) : v
            },
        }) as unknown as FakeDaemon

        const statuses: string[] = []
        const s = await OfflineSession.open(new MemoryStorage(), quotaTransport, DOC, PAGE, {
            clientId: 'client-A',
            authorUuid: AUTHOR_A,
            useOps: true,
            retryIntervalMs: 100000,
            onStatus: (st) => statuses.push(st.state),
        })

        // draw twice while "full": nothing crashes, ink stays, ops stay pending
        await s.apply([shapeOp('shape:q1', 100)])
        await settle(s)
        await s.apply([shapeOp('shape:q2', 200)])
        await settle(s)
        expect(s.pendingCount).toBe(2)
        expect(liveLines(s.document)).toBe(2)
        // the user is told: offline-or-error surfaced, never silent
        expect(statuses.some((st) => st === 'offline' || st === 'error')).toBe(true)

        // space frees (quota bump / deletion): the queued edits push untouched
        full = false
        await settle(s)
        expect(s.pendingCount).toBe(0)
        expect((await daemon.opsSince(DOC, PAGE, 0)).length).toBeGreaterThan(0)
        s.dispose()
    })

describe('server-merged snapshot publish (web mirror of weft-cal15)', () => {
    // merged: true from putSnapshot means the stored snapshot is a superset
    // (a concurrent tablet edit was union-merged server-side); recording that
    // seq as our own would hide the tablet content forever since text edits
    // carry zero ops, so lastSnapshotSeq must stay behind to force a
    // re-bootstrap from the merged snapshot.
    test('a merged putSnapshot response triggers a re-bootstrap with the union', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const { RmDocument, createRootText, insertText } = await import('@weft/rm-format')
        const { decodeSnapshot, encodeSnapshot } = await import('../src/snapshot')

        // wrap the relay: simulate the cloud's putSnapshotMerged folding a
        // concurrent tablet text edit into every published snapshot
        const TABLET = 'f73f497f-0000-4000-a000-000000000000'
        const merging = new Proxy(daemon, {
            get(target, prop) {
                if (prop === 'putSnapshot') {
                    return async (doc: string, page: string, bytes: Uint8Array) => {
                        const { rm, overlay } = decodeSnapshot(bytes)
                        const d = RmDocument.parse(rm)
                        if (!d.tree().rootText) createRootText(d)
                        insertText(d, null, 'TABLET-CONCURRENT ', { authorUuid: TABLET })
                        const res = await target.putSnapshot(doc, page, encodeSnapshot(d.serialize(), overlay))
                        return { ...res, merged: true }
                    }
                }
                const v = (target as unknown as Record<string, unknown>)[prop as string]
                return typeof v === 'function' ? v.bind(target) : v
            },
        }) as unknown as FakeDaemon

        const patches: ViewPatch[] = []
        const a = await openSession(merging, new MemoryStorage(), 'client-A', AUTHOR_A, patches)
        await settle(a)
        // a device-text edit: zero ops, snapshot fallback
        await a.apply([
            { type: 'edit-root-text', create: {}, inserts: [{ afterKey: null, text: 'web words' }] },
        ])
        await settle(a)

        // the session re-bootstrapped from the merged snapshot: it now holds
        // both its own edit and the concurrent tablet text
        const rt = a.document.tree().rootText
        expect(rt).toBeTruthy()
        const { linearizeRootText } = await import('@weft/rm-format')
        const text = linearizeRootText(rt!)
            .map((p) => p.spans.map((s) => s.text).join(''))
            .join('\n')
        expect(text).toContain('web words')
        expect(text).toContain('TABLET-CONCURRENT')
        expect(patches.some((p) => p.type === 'document-replaced')).toBe(true)
        a.dispose()
    })

    test('an unmerged putSnapshot response does NOT re-bootstrap (no churn)', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const patches: ViewPatch[] = []
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A, patches)
        await settle(a)
        await a.apply([
            { type: 'edit-root-text', create: {}, inserts: [{ afterKey: null, text: 'solo' }] },
        ])
        await settle(a)
        // no foreign content -> our own snapshot must not bounce back as a
        // document-replaced (that would churn the canvas on every text edit)
        expect(patches.some((p) => p.type === 'document-replaced')).toBe(false)
        a.dispose()
    })
})

describe('multi-tab editing (#99: per-tab authors, partitioned pending)', () => {
    async function openTab(
        daemon: FakeDaemon,
        storage: MemoryStorage,
        author: string,
        opts: {
            cachePrimary?: boolean
            adoptOrphanAuthor?: (a: string, fn: () => Promise<void>) => Promise<boolean>
        } = {},
        patches: ViewPatch[] = [],
    ) {
        return OfflineSession.open(storage, daemon, DOC, PAGE, {
            clientId: `client-${author.slice(0, 4)}`,
            authorUuid: author,
            useOps: true,
            retryIntervalMs: 100000,
            onPatch: (p) => patches.push(p),
            ...opts,
        })
    }

    test('two tabs on ONE storage both edit and converge (no collisions)', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const storage = new MemoryStorage()
        const a = await openTab(daemon, storage, AUTHOR_A, { cachePrimary: true })
        const b = await openTab(daemon, storage, AUTHOR_B, { cachePrimary: false })
        await a.apply([shapeOp('shape:tabA', 0, 'client-A')])
        await b.apply([shapeOp('shape:tabB', 1000, 'client-B')])
        await settle(a, b)
        expect(liveLines(a.document)).toBe(2)
        expect(liveLines(b.document)).toBe(2)
        a.dispose()
        b.dispose()
    })

    test('pending queues are per author: tabs never clobber each other offline', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const storage = new MemoryStorage()
        const offline = new Proxy(daemon, {
            get(target, prop) {
                if (['appendOps', 'opsSince', 'getSnapshot', 'putSnapshot'].includes(prop as string)) {
                    return async () => {
                        throw new (await import('../src/types')).EngineFailure({
                            _tag: 'DeviceUnreachable',
                            cause: 'offline',
                        })
                    }
                }
                const v = (target as unknown as Record<string, unknown>)[prop as string]
                return typeof v === 'function' ? v.bind(target) : v
            },
        }) as unknown as FakeDaemon
        // both tabs queue offline; each persists under its own author key
        const a1 = await openTab(offline, storage, AUTHOR_A, { cachePrimary: true })
        const b1 = await openTab(offline, storage, AUTHOR_B, { cachePrimary: false })
        await a1.apply([shapeOp('shape:a', 0, 'client-A')])
        await b1.apply([shapeOp('shape:b', 500, 'client-B')])
        await settle(a1, b1)
        a1.dispose()
        b1.dispose()
        expect((await storage.keys(`page/${DOC}/${PAGE}/pending/`)).sort()).toEqual([
            `page/${DOC}/${PAGE}/pending/${AUTHOR_A}`,
            `page/${DOC}/${PAGE}/pending/${AUTHOR_B}`,
        ])
        // both tabs reopen online: each flushes its own queue, nothing lost
        const a2 = await openTab(daemon, storage, AUTHOR_A, { cachePrimary: true })
        const b2 = await openTab(daemon, storage, AUTHOR_B, { cachePrimary: false })
        await settle(a2, b2)
        expect(liveLines(a2.document)).toBe(2)
        expect(await storage.keys(`page/${DOC}/${PAGE}/pending/`)).toEqual([])
        a2.dispose()
        b2.dispose()
    })

    test('the cache primary adopts a queue orphaned by a CLOSED tab', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const storage = new MemoryStorage()
        const offline = new Proxy(daemon, {
            get(target, prop) {
                if (['appendOps', 'opsSince', 'getSnapshot', 'putSnapshot'].includes(prop as string)) {
                    return async () => {
                        throw new (await import('../src/types')).EngineFailure({
                            _tag: 'DeviceUnreachable',
                            cause: 'offline',
                        })
                    }
                }
                const v = (target as unknown as Record<string, unknown>)[prop as string]
                return typeof v === 'function' ? v.bind(target) : v
            },
        }) as unknown as FakeDaemon
        // tab B queues offline and closes (its author never comes back)
        const b = await openTab(offline, storage, AUTHOR_B, { cachePrimary: false })
        await b.apply([shapeOp('shape:orphan', 0, 'client-B')])
        await settle(b)
        b.dispose()
        // tab A opens online as primary; B's author is not active anywhere
        const a = await openTab(daemon, storage, AUTHOR_A, {
            cachePrimary: true,
            // lock free (tab gone): run the adopt under the "held" lock
            adoptOrphanAuthor: async (_author, fn) => {
                await fn()
                return true
            },
        })
        await settle(a)
        expect(liveLines(a.document)).toBe(1) // the orphan op was flushed
        expect(await storage.keys(`page/${DOC}/${PAGE}/pending/`)).toEqual([])
        a.dispose()
    })

    test('a failed adoption leaves the orphan available to adopt once after restart', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const pendingPrefix = `page/${DOC}/${PAGE}/pending/`
        const source = pendingPrefix + AUTHOR_B
        const destination = pendingPrefix + AUTHOR_A
        const failure = new Error('pending destination unavailable')
        class FailingStorage extends MemoryStorage {
            fail = true

            async set(key: string, value: Uint8Array): Promise<void> {
                if (this.fail && key === destination) throw failure
                await super.set(key, value)
            }

            async setAndDelete(key: string, value: Uint8Array, deleteKey: string): Promise<void> {
                if (this.fail && key === destination) throw failure
                await super.setAndDelete(key, value, deleteKey)
            }
        }
        const storage = new FailingStorage()
        const bytes = new TextEncoder().encode(JSON.stringify([shapeOp('shape:orphan')]))
        await storage.set(source, bytes)
        const opts = {
            adoptOrphanAuthor: async (_author: string, fn: () => Promise<void>) => {
                await fn()
                return true
            },
        }

        await expect(openTab(daemon, storage, AUTHOR_A, opts)).rejects.toBe(failure)
        expect(await storage.get(source)).toEqual(bytes)
        expect(await storage.get(destination)).toBeNull()

        storage.fail = false
        const getSnapshot = daemon.getSnapshot.bind(daemon)
        daemon.getSnapshot = async () => {
            throw failure
        }
        const first = await openTab(daemon, storage, AUTHOR_A, opts)
        try {
            await settle(first)
            expect(first.pendingCount).toBe(1)
            expect(await storage.get(source)).toBeNull()
            expect(await storage.get(destination)).toEqual(bytes)
        } finally {
            first.dispose()
            daemon.getSnapshot = getSnapshot
        }

        const reopened = await openTab(daemon, storage, AUTHOR_A, opts)
        await settle(reopened)
        expect(liveLines(reopened.document)).toBe(1)
        expect(await storage.keys(pendingPrefix)).toEqual([])
        reopened.dispose()
    })

    test('promotion preserves edits and acknowledgements while a transfer waits to commit', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const appendStarted = Promise.withResolvers<void>()
        const releaseAppend = Promise.withResolvers<void>()
        const append = daemon.appendOps.bind(daemon)
        daemon.appendOps = async (...args) => {
            appendStarted.resolve()
            await releaseAppend.promise
            return append(...args)
        }
        const transferStarted = Promise.withResolvers<void>()
        const releaseTransfer = Promise.withResolvers<void>()
        class PausedStorage extends MemoryStorage {
            async setAndDelete(key: string, value: Uint8Array, deleteKey: string): Promise<void> {
                transferStarted.resolve()
                await releaseTransfer.promise
                await super.setAndDelete(key, value, deleteKey)
            }
        }
        const storage = new PausedStorage()
        const pendingPrefix = `page/${DOC}/${PAGE}/pending/`
        await storage.set(
            pendingPrefix + AUTHOR_B,
            new TextEncoder().encode(JSON.stringify([shapeOp('shape:orphan')])),
        )
        const a = await openTab(daemon, storage, AUTHOR_A, {
            cachePrimary: false,
            adoptOrphanAuthor: async (_author, fn) => {
                await fn()
                return true
            },
        })
        try {
            await a.apply([shapeOp('shape:first')])
            await appendStarted.promise
            const promotion = a.promoteToCachePrimary()
            await transferStarted.promise
            expect(a.pendingCount).toBe(1)
            const edit = a.apply([shapeOp('shape:concurrent')])
            releaseAppend.resolve()
            releaseTransfer.resolve()
            await Promise.all([promotion, edit])
            await settle(a)
            expect(liveLines(a.document)).toBe(3)
            expect(await storage.keys(pendingPrefix)).toEqual([])
        } finally {
            releaseAppend.resolve()
            releaseTransfer.resolve()
            a.dispose()
        }
    })

    test('a page departure save cannot overwrite a pending transfer with stale bytes', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        daemon.getSnapshot = async () => {
            throw new Error('offline during page departure')
        }
        const prefix = `page/${DOC}/${PAGE}/pending/`
        const destination = prefix + AUTHOR_A
        const source = prefix + AUTHOR_B
        const local = shapeOp('shape:local')
        const orphan = shapeOp('shape:orphan')
        const encode = (ops: LocalOp[]) => new TextEncoder().encode(JSON.stringify(ops))
        const transferStarted = Promise.withResolvers<void>()
        const releaseTransfer = Promise.withResolvers<void>()
        const releaseSave = Promise.withResolvers<void>()
        class PausedStorage extends MemoryStorage {
            pauseSave = false

            async set(key: string, value: Uint8Array): Promise<void> {
                if (this.pauseSave && key === destination) await releaseSave.promise
                await super.set(key, value)
            }

            async setAndDelete(key: string, value: Uint8Array, deleteKey: string): Promise<void> {
                transferStarted.resolve()
                await releaseTransfer.promise
                await super.setAndDelete(key, value, deleteKey)
            }
        }
        const storage = new PausedStorage()
        await storage.set(source, encode([orphan]))
        const a = await openTab(daemon, storage, AUTHOR_A, {
            cachePrimary: false,
            adoptOrphanAuthor: async (_author, fn) => {
                await fn()
                return true
            },
        })
        try {
            await a.apply([local])
            const promotion = a.promoteToCachePrimary()
            await transferStarted.promise
            storage.pauseSave = true
            const save = a.savePending()
            releaseTransfer.resolve()
            await promotion
            releaseSave.resolve()
            await save

            expect(a.pendingCount).toBe(2)
            expect(await storage.get(source)).toBeNull()
            const saved = await storage.get(destination)
            expect(JSON.parse(new TextDecoder().decode(saved!))).toEqual([local, orphan])
        } finally {
            releaseTransfer.resolve()
            releaseSave.resolve()
            a.dispose()
        }
    })

    test('watchdog replacement cannot drop orphan behind acknowledged prefix', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const appendStarted = Promise.withResolvers<void>()
        const releaseAppend = Promise.withResolvers<void>()
        const append = daemon.appendOps.bind(daemon)
        daemon.appendOps = async (...args) => {
            appendStarted.resolve()
            await releaseAppend.promise
            return append(...args)
        }
        const transferStarted = Promise.withResolvers<void>()
        const releaseTransfer = Promise.withResolvers<void>()
        class PausedStorage extends MemoryStorage {
            async setAndDelete(key: string, value: Uint8Array, deleteKey: string): Promise<void> {
                transferStarted.resolve()
                await releaseTransfer.promise
                await super.setAndDelete(key, value, deleteKey)
            }
        }
        const storage = new PausedStorage()
        await storage.set(
            `page/${DOC}/${PAGE}/pending/${AUTHOR_B}`,
            new TextEncoder().encode(JSON.stringify([shapeOp('shape:orphan')])),
        )
        const a = await OfflineSession.open(storage, daemon, DOC, PAGE, {
            clientId: 'A',
            authorUuid: AUTHOR_A,
            cachePrimary: false,
            reconcileWatchdogMs: 20,
            retryIntervalMs: 100000,
            onPatch() {},
            adoptOrphanAuthor: async (_author, fn) => {
                await fn()
                return true
            },
        })
        try {
            await a.apply([shapeOp('shape:first')])
            await appendStarted.promise
            const promotion = a.promoteToCachePrimary()
            await transferStarted.promise
            releaseAppend.resolve()
            await Bun.sleep(30)
            const replacement = a.reconcile()
            await Bun.sleep(5)
            releaseTransfer.resolve()
            await Promise.all([promotion, replacement])
            await settle(a)
            expect(liveLines(a.document)).toBe(2)
        } finally {
            releaseAppend.resolve()
            releaseTransfer.resolve()
            a.dispose()
        }
    })

    for (const oldAckFirst of [true, false]) {
        const order = oldAckFirst ? 'old acknowledgement first' : 'replacement acknowledgement first'
        test(`a watchdog replacement keeps peer edits with ${order}`, async () => {
            const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
            const storage = new MemoryStorage()
            const oldStarted = Promise.withResolvers<void>()
            const newStarted = Promise.withResolvers<void>()
            const oldRelease = Promise.withResolvers<void>()
            const newRelease = Promise.withResolvers<void>()
            const append = daemon.appendOps.bind(daemon)
            let attempts = 0
            daemon.appendOps = async (...args) => {
                if (args[3] === AUTHOR_A) {
                    if (++attempts === 1) {
                        oldStarted.resolve()
                        await oldRelease.promise
                    } else if (attempts === 2) {
                        newStarted.resolve()
                        await newRelease.promise
                    }
                }
                return append(...args)
            }
            const openPrimary = () => OfflineSession.open(storage, daemon, DOC, PAGE, {
                clientId: 'A',
                authorUuid: AUTHOR_A,
                cachePrimary: true,
                reconcileWatchdogMs: 30,
                retryIntervalMs: 100000,
                onPatch() {},
            })
            const a = await openPrimary()
            const b = await openTab(daemon, storage, AUTHOR_B, { cachePrimary: false })
            try {
                await a.apply([shapeOp('shape:first')])
                await oldStarted.promise
                const old = a.reconcile()
                await b.apply([shapeOp('shape:foreign')])
                await settle(b)
                await Bun.sleep(40)
                const replacement = a.reconcile()
                await newStarted.promise

                if (oldAckFirst) {
                    oldRelease.resolve()
                    await old
                    newRelease.resolve()
                    await replacement
                } else {
                    newRelease.resolve()
                    await replacement
                    oldRelease.resolve()
                    await old
                }

                await settle(a, b)
                const shapeIds = (session: OfflineSession) =>
                    session.currentOverlay.shapes.map((shape) => shape.shapeId).sort()
                const expected = ['shape:first', 'shape:foreign']
                expect(shapeIds(a)).toEqual(expected)
                expect(shapeIds(b)).toEqual(expected)
                a.dispose()
                const reopened = await openPrimary()
                try {
                    expect(shapeIds(reopened)).toEqual(expected)
                } finally {
                    reopened.dispose()
                }
            } finally {
                oldRelease.resolve()
                newRelease.resolve()
                a.dispose()
                b.dispose()
            }
        })
    }

    test('an orphan queue containing a null entry stays untouched', async () => {
        const storage = new MemoryStorage()
        const source = `page/${DOC}/${PAGE}/pending/${AUTHOR_B}`
        const malformed = new TextEncoder().encode('[null]')
        await storage.set(source, malformed)

        const a = await openTab(FakeDaemon.withBlankPage(DOC, PAGE), storage, AUTHOR_A, {
            adoptOrphanAuthor: async (_author, fn) => {
                await fn()
                return true
            },
        })
        try {
            expect(a.pendingCount).toBe(0)
            expect(await storage.get(source)).toEqual(malformed)
        } finally {
            a.dispose()
        }
    })

    test('a LIVE author is never adopted (its own tab will flush)', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const storage = new MemoryStorage()
        await storage.set(
            `page/${DOC}/${PAGE}/pending/${AUTHOR_B}`,
            new TextEncoder().encode(JSON.stringify([shapeOp('shape:live', 0, 'client-B')])),
        )
        const a = await openTab(daemon, storage, AUTHOR_A, {
            cachePrimary: true,
            adoptOrphanAuthor: async () => false, // B's lock is held: tab alive
        })
        await settle(a)
        expect(liveLines(a.document)).toBe(0) // not adopted, not flushed here
        expect(await storage.keys(`page/${DOC}/${PAGE}/pending/`)).toHaveLength(1)
        a.dispose()
    })

    test('legacy state.pendingOps migrate once, by the primary only', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const storage = new MemoryStorage()
        // fabricate a pre-multi-tab replica: pending ops inside the state blob
        const seed = await openTab(daemon, storage, AUTHOR_A, { cachePrimary: true })
        await settle(seed)
        seed.dispose()
        const stateRaw = (await storage.get(`page/${DOC}/${PAGE}/state`))!
        const state = JSON.parse(new TextDecoder().decode(stateRaw))
        state.pendingOps = [shapeOp('shape:legacy', 0, 'client-A')]
        await storage.set(`page/${DOC}/${PAGE}/state`, new TextEncoder().encode(JSON.stringify(state)))
        // a NON-primary tab must not adopt them...
        const b = await openTab(daemon, storage, AUTHOR_B, { cachePrimary: false })
        await settle(b)
        expect(liveLines(b.document)).toBe(0)
        b.dispose()
        // ...the primary adopts + flushes them exactly once
        const a = await openTab(daemon, storage, AUTHOR_A, { cachePrimary: true })
        await settle(a)
        expect(liveLines(a.document)).toBe(1)
        const after = JSON.parse(new TextDecoder().decode((await storage.get(`page/${DOC}/${PAGE}/state`))!))
        expect(after.pendingOps ?? []).toEqual([]) // migrated out of the blob
        a.dispose()
    })

    test('only the cache primary writes the shared base/state cache', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const storage = new MemoryStorage()
        const a = await openTab(daemon, storage, AUTHOR_A, { cachePrimary: true })
        await a.apply([shapeOp('shape:a', 0, 'client-A')])
        await settle(a)
        const before = await storage.get(`page/${DOC}/${PAGE}/state`)
        const b = await openTab(daemon, storage, AUTHOR_B, { cachePrimary: false })
        await b.apply([shapeOp('shape:b', 900, 'client-B')])
        await settle(a, b)
        // B's activity flushed through the relay but never rewrote the cache
        const after = await storage.get(`page/${DOC}/${PAGE}/state`)
        // the primary may have refreshed it (its own reconciles); the point is
        // B's session id never wrote: delete the primary and verify stability
        a.dispose()
        const snapshotAfterA = await storage.get(`page/${DOC}/${PAGE}/state`)
        await b.apply([shapeOp('shape:b2', 950, 'client-B')])
        await settle(b)
        const afterB = await storage.get(`page/${DOC}/${PAGE}/state`)
        expect(new TextDecoder().decode(afterB!)).toBe(new TextDecoder().decode(snapshotAfterA!))
        expect(before).toBeTruthy()
        expect(after).toBeTruthy()
        b.dispose()
    })
})

describe('hung-transport resilience (the frozen-tab incident)', () => {
    test('one permanently-hung pull cannot brick later reconciles', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        let hangNext = false
        const flaky = new Proxy(daemon, {
            get(target, prop) {
                if (prop === 'getSnapshot' && hangNext) {
                    hangNext = false
                    return () => new Promise(() => {}) // hangs forever
                }
                const v = (target as unknown as Record<string, unknown>)[prop as string]
                return typeof v === 'function' ? v.bind(target) : v
            },
        }) as unknown as FakeDaemon
        const a = await openSession(flaky, new MemoryStorage(), 'client-A', AUTHOR_A)
        await settle(a)
        // a peer draws; the next reconcile hangs on its pull
        const b = await openSession(daemon, new MemoryStorage(), 'client-B', AUTHOR_B)
        await b.apply([shapeOp('shape:live', 0, 'client-B')])
        await settle(b)
        hangNext = true
        void a.reconcile() // this one never settles on its own
        await new Promise((r) => setTimeout(r, 30))
        // without the watchdog, every later reconcile chains behind a hung one
        // forever; the watchdog (shortened here) abandons the chain instead.
        ;(a as unknown as { opts: { reconcileWatchdogMs: number } }).opts.reconcileWatchdogMs = 10
        await a.reconcile()
        await settle(a)
        expect(liveLines(a.document)).toBe(1) // the peer's stroke arrived
        a.dispose()
        b.dispose()
    })
})

describe('snapshot adoption audits the overlay (2026-07-09: tablet erase buried by a head-stamped snapshot)', () => {
    /** A text shape with one stroke per glyph part, pushed to the relay. */
    function textShapeOp(glyphs: number): LocalOp {
        return {
            type: 'upsert-shape',
            shape: {
                shapeId: 'shape:txt',
                kind: 'text',
                props: { plain: 'abc' },
                x: 0,
                y: 0,
                rotation: 0,
                renderRevision: 'r-txt-1',
                version: { ts: 1, actor: 'client-A' },
            },
            parts: Array.from({ length: glyphs }, (_, i) => ({
                partKey: `glyph:${i}`,
                strokes: [
                    {
                        points: polylineToPoints(
                            [
                                { x: 10 + i * 30, y: 10 },
                                { x: 25 + i * 30, y: 40 },
                            ],
                            { width: 40 },
                        ),
                        color: 'black' as const,
                    },
                ],
            })),
        }
    }

    /** Publishes what a device push produces: tombstone ops for the trailing
     *  glyph appended to the log, then a snapshot of the erased rm with the
     *  overlay untouched, stamped at the new head, so an adopter's cursor
     *  jumps past the tombstone ops. */
    async function publishInconsistentSnapshot(daemon: FakeDaemon, from: OfflineSession) {
        const { RmDocument, crdtId } = await import('@weft/rm-format')
        const { encodeSnapshot } = await import('../src/snapshot')
        const { encodeOp } = await import('../src/ops')
        const doc = RmDocument.parse(from.document.serialize())
        const overlay = structuredClone(from.currentOverlay)
        const shape = overlay.shapes.find((s) => s.shapeId === 'shape:txt')!
        const lastPart = shape.rendered[shape.rendered.length - 1]!
        const tombs: Uint8Array[] = []
        for (const ref of lastPart.items) {
            const ok = doc.tombstone(crdtId(doc.resolveAuthor(ref.authorUuid), ref.clock))
            expect(ok).toBe(true)
            tombs.push(encodeOp({ op: 'tombstone', id: { author: ref.authorUuid, clock: ref.clock } }))
        }
        await daemon.appendOps(DOC, PAGE, tombs, null)
        await daemon.putSnapshot(DOC, PAGE, encodeSnapshot(doc.serialize(), overlay))
    }

    test('a FRESH client bootstrapping from the snapshot emits the D8 trailing repair', async () => {
        const daemon = new FakeDaemon()
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A)
        await a.apply([textShapeOp(3)])
        await settle(a)
        await publishInconsistentSnapshot(daemon, a)

        const patches: ViewPatch[] = []
        const b = await openSession(daemon, new MemoryStorage(), 'client-B', AUTHOR_B, patches)
        await settle(b)
        const repair = patches.find((p) => p.type === 'shape-edited')
        expect(repair).toBeTruthy()
        expect((repair as { edit: { kind: string; removedGlyphIndices: number[] } }).edit).toEqual({
            kind: 'text-truncate-glyphs',
            removedGlyphIndices: [2],
        })
        a.dispose()
        b.dispose()
    })

    test('a LIVE client adopting the superseding snapshot emits the repair too', async () => {
        const daemon = new FakeDaemon()
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A)
        await a.apply([textShapeOp(3)])
        await settle(a)

        const patches: ViewPatch[] = []
        const b = await openSession(daemon, new MemoryStorage(), 'client-B', AUTHOR_B, patches)
        await settle(b)
        patches.length = 0

        await publishInconsistentSnapshot(daemon, a)
        await settle(b)
        const repair = patches.find((p) => p.type === 'shape-edited')
        expect(repair).toBeTruthy()
        expect((repair as { edit: { kind: string; removedGlyphIndices: number[] } }).edit).toEqual({
            kind: 'text-truncate-glyphs',
            removedGlyphIndices: [2],
        })
        a.dispose()
        b.dispose()
    })
})

describe('snapshot adoption LWW-merges the overlay (churn fix, 2026-07-09)', () => {
    test('adoption never regresses a shape edited after the snapshot was composed', async () => {
        const daemon = new FakeDaemon()
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A)
        await a.apply([shapeOp('shape:S', 0, 'client-A')])
        await settle(a)

        // a device echo folds the current (v1) world into a snapshot, stamped
        // at the current head: the realistic composition invariant
        const { encodeSnapshot } = await import('../src/snapshot')
        await daemon.putSnapshot(
            DOC,
            PAGE,
            encodeSnapshot(a.document.serialize(), structuredClone(a.currentOverlay)),
        )

        // the shape is edited after the snapshot's composition; the next
        // reconcile adopts the snapshot and applies the newer edit
        const patches: ViewPatch[] = []
        ;(a as unknown as { opts: { onPatch: (p: ViewPatch) => void } }).opts.onPatch = (p) =>
            patches.push(p)
        await a.apply([shapeOp('shape:S', 50, 'client-A')])
        await settle(a)

        // the newer local edit survives adoption (no regression), and the
        // audit never removed or detached the shape mid-flight
        const shape = a.currentOverlay.shapes.find((s) => s.shapeId === 'shape:S')!
        expect(shape.renderRevision).toBe('r-shape:S-50')
        expect(patches.map((p) => p.type)).not.toContain('shape-removed')
        expect(patches.map((p) => p.type)).not.toContain('shape-detached')
        a.dispose()
    })

    test('a snapshot-only erase (ZERO ops appended) still repairs on adoption', async () => {
        const daemon = new FakeDaemon()
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A)
        await a.apply([
            {
                type: 'upsert-shape',
                shape: {
                    shapeId: 'shape:txt',
                    kind: 'text',
                    props: { plain: 'ab' },
                    x: 0,
                    y: 0,
                    rotation: 0,
                    renderRevision: 'r-z1',
                    version: { ts: 1, actor: 'client-A' },
                },
                parts: [0, 1].map((i) => ({
                    partKey: `glyph:${i}`,
                    strokes: [
                        {
                            points: polylineToPoints(
                                [
                                    { x: 10 + i * 30, y: 10 },
                                    { x: 25 + i * 30, y: 40 },
                                ],
                                { width: 40 },
                            ),
                            color: 'black' as const,
                        },
                    ],
                })),
            },
        ])
        await settle(a)

        // the device's erase arrives as a snapshot with no tombstone ops
        // (causally gated server-side): rm has the trailing glyph dead, the
        // overlay untouched, opSeq == the client's own cursor.
        const { RmDocument, crdtId } = await import('@weft/rm-format')
        const { encodeSnapshot } = await import('../src/snapshot')
        const doc = RmDocument.parse(a.document.serialize())
        const overlay = structuredClone(a.currentOverlay)
        const shape = overlay.shapes.find((s) => s.shapeId === 'shape:txt')!
        const lastPart = shape.rendered[shape.rendered.length - 1]!
        for (const ref of lastPart.items) {
            expect(doc.tombstone(crdtId(doc.resolveAuthor(ref.authorUuid), ref.clock))).toBe(true)
        }
        const patches: ViewPatch[] = []
        ;(a as unknown as { opts: { onPatch: (p: ViewPatch) => void } }).opts.onPatch = (p) =>
            patches.push(p)
        await daemon.putSnapshot(DOC, PAGE, encodeSnapshot(doc.serialize(), overlay))
        await settle(a)

        const repair = patches.find((p) => p.type === 'shape-edited')
        expect(repair).toBeTruthy()
        expect((repair as { edit: { removedGlyphIndices: number[] } }).edit.removedGlyphIndices).toEqual([1])
        a.dispose()
    })
})

describe('snapshot ⊇ reused items (per-part reuse coupling)', () => {
    test('a fresh client bootstrapping from a snapshot with reuse-era overlay keeps the shape', async () => {
        const daemon = new FakeDaemon()
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A)
        const mk = (texts: string[], v: number) => ({
            type: 'upsert-shape' as const,
            shape: {
                shapeId: 'shape:txt',
                kind: 'text' as const,
                props: { plain: texts.join('') },
                x: 0,
                y: 0,
                rotation: 0,
                renderRevision: `r-${v}`,
                version: { ts: v, actor: 'client-A' },
            },
            parts: texts.map((t, i) => ({
                partKey: `glyph:${i}`,
                strokes: [
                    {
                        points: polylineToPoints(
                            [
                                { x: 10 + i * 30, y: 10 },
                                { x: 25 + i * 30, y: 40 },
                            ],
                            { width: 40 },
                        ),
                        color: 'black' as const,
                    },
                ],
            })),
        })
        await a.apply([mk(['a', 'b'], 1)])
        await settle(a)
        // second edit reuses a+b (prefix) and mints only c: the overlay's
        // rendered now references items minted in the first batch
        await a.apply([mk(['a', 'b', 'c'], 2)])
        await settle(a)

        // a snapshot published at the head must contain the reused items
        // (store.ts pins op_seq to the composition head for this reason)
        const { encodeSnapshot } = await import('../src/snapshot')
        await daemon.putSnapshot(
            DOC,
            PAGE,
            encodeSnapshot(a.document.serialize(), structuredClone(a.currentOverlay)),
        )

        const patches: ViewPatch[] = []
        const b = await openSession(daemon, new MemoryStorage(), 'client-B', AUTHOR_B, patches)
        await settle(b)
        // the shape survives the boot audit: every reused item resolves live
        expect(patches.map((p) => p.type)).not.toContain('shape-removed')
        expect(patches.map((p) => p.type)).not.toContain('shape-detached')
        expect(b.currentOverlay.shapes.find((s) => s.shapeId === 'shape:txt')?.state).toBe('live')
        a.dispose()
        b.dispose()
    })
})

describe('REVERT snapshots adopt verbatim (the LWW merge must not defeat a rewind)', () => {
    test('a client that saw the post-revert-target edit still lands on the reverted state', async () => {
        const daemon = new FakeDaemon()
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A)
        // v1 state: the revert target
        await a.apply([shapeOp('shape:S', 0, 'client-A')])
        await settle(a)
        const { encodeSnapshot } = await import('../src/snapshot')
        const targetRm = a.document.serialize()
        const targetOverlay = structuredClone(a.currentOverlay)
        const targetHead = (await daemon.getSnapshot(DOC, PAGE))?.opSeq ?? 0

        // the shape is edited to v2 after the target (this client saw the edit)
        await a.apply([shapeOp('shape:S', 50, 'client-A')])
        await settle(a)
        expect(a.currentOverlay.shapes[0]!.renderRevision).toBe('r-shape:S-50')

        // the server reverts to the target: a snapshot whose rm/overlay are
        // the past state, pinned at the new head (ops in between are retained
        // but superseded), matching store.revertTo's shape
        const head = ((): number => {
            // the fake daemon's op head after the v2 push
            return (daemon as unknown as { opState(k: string): { head: number } }).opState(
                `${DOC}/${PAGE}`,
            ).head
        })()
        expect(head).toBeGreaterThan(targetHead)
        const patches: ViewPatch[] = []
        ;(a as unknown as { opts: { onPatch: (p: ViewPatch) => void } }).opts.onPatch = (p) =>
            patches.push(p)
        daemon.putRevertSnapshot(DOC, PAGE, encodeSnapshot(targetRm, targetOverlay), head)
        await settle(a)

        // the revert wins: the shape is back at v1, live, not removed/detached
        const shape = a.currentOverlay.shapes.find((s) => s.shapeId === 'shape:S')
        expect(shape).toBeTruthy()
        expect(shape!.state).toBe('live')
        expect(shape!.renderRevision).toBe('r-shape:S-0')
        expect(patches.map((p) => p.type)).not.toContain('shape-removed')
        expect(patches.map((p) => p.type)).not.toContain('shape-detached')
        a.dispose()
    })

    test('the pending view stays correct as ops accumulate (incremental slow path)', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A)
        // reading the view between applies primes the incremental working copy;
        // each later read must apply exactly the tail (no reapply, no misses)
        await a.apply([shapeOp('shape:a')])
        expect(liveLines(a.document)).toBe(1)
        expect(a.currentOverlay.shapes.length).toBe(1)
        await a.apply([shapeOp('shape:b')])
        expect(liveLines(a.document)).toBe(2)
        expect(liveLines(a.document)).toBe(2) // cache-hit re-read is stable
        await a.apply([shapeOp('shape:c')])
        expect(liveLines(a.document)).toBe(3)
        expect(a.currentOverlay.shapes.length).toBe(3)
        // a re-projection of an existing shape while still pending: LWW
        // replace (tombstone + re-mint), never a duplicate
        await a.apply([shapeOp('shape:a', 7)])
        expect(a.currentOverlay.shapes.length).toBe(3)
        expect(liveLines(a.document)).toBe(3)
        expect(a.currentOverlay.shapes.find((s) => s.shapeId === 'shape:a')!.renderRevision).toBe(
            'r-shape:a-7',
        )
        // push adopts the applied state; the settled view matches what the
        // incremental path showed, and a fresh client reconstructs the same
        await settle(a)
        expect(liveLines(a.document)).toBe(3)
        expect(a.currentOverlay.shapes.length).toBe(3)
        const b = await openSession(daemon, new MemoryStorage(), 'client-B', AUTHOR_B)
        await settle(b)
        expect(liveLines(b.document)).toBe(3)
        expect(b.currentOverlay.shapes.length).toBe(3)
        a.dispose()
        b.dispose()
    })

    test('a failed push retries on a short fuse, not the 15s tick', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        let online = false
        const flaky = new Proxy(daemon, {
            get(target, prop) {
                if (prop === 'appendOps' && !online) {
                    return async () => {
                        throw new (await import('../src/types')).EngineFailure({
                            _tag: 'DeviceUnreachable',
                            cause: 'blip',
                        })
                    }
                }
                const v = (target as unknown as Record<string, unknown>)[prop as string]
                return typeof v === 'function' ? (v as CallableFunction).bind(target) : v
            },
        }) as unknown as FakeDaemon
        // retryIntervalMs is 100s (openSession): only the quick retry can push
        const a = await openSession(flaky, new MemoryStorage(), 'client-A', AUTHOR_A)
        await a.apply([shapeOp('shape:a')])
        // every push fails while offline: the op stays pending
        await new Promise((r) => setTimeout(r, 500))
        expect((await daemon.opsSince(DOC, PAGE, 0)).length).toBe(0)
        expect(a.pendingCount).toBe(1)
        // link recovers: with no manual reconcile and the interval tick 100s
        // away, only the quick-retry fuse (1s, doubling) can deliver this
        online = true
        const deadline = Date.now() + 8_000
        while (Date.now() < deadline) {
            if ((await daemon.opsSince(DOC, PAGE, 0)).length > 0) break
            await new Promise((r) => setTimeout(r, 100))
        }
        expect((await daemon.opsSince(DOC, PAGE, 0)).length).toBeGreaterThan(0)
        expect(a.pendingCount).toBe(0)
        a.dispose()
    })

    test('stroke add ops ship 2dp coordinates (wire size)', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const a = await openSession(daemon, new MemoryStorage(), 'client-A', AUTHOR_A)
        const op = shapeOp('shape:a')
        // poison the projected points with float noise like a real projection
        const part = (op as { parts: { strokes: { points: { x: number; y: number }[] }[] }[] })
            .parts[0]!
        for (const p of part.strokes[0]!.points) {
            p.x += 0.123456789012345
            p.y += 0.987654321098765
        }
        await a.apply([op])
        await settle(a)
        const records = await daemon.opsSince(DOC, PAGE, 0)
        const { decodeOp } = await import('../src/ops')
        const adds = records
            .map((r) => decodeOp(r.op))
            .filter((o): o is import('../src/ops').AddItemOp => o.op === 'add')
        expect(adds.length).toBeGreaterThan(0)
        for (const add of adds) {
            if (add.payload.kind !== 'line') continue
            for (const p of add.payload.points) {
                expect(p.x).toBe(Math.round(p.x * 100) / 100)
                expect(p.y).toBe(Math.round(p.y * 100) / 100)
            }
        }
        a.dispose()
    })
})

test('a failed accepted tail write retries when the next fetch has no new records', async () => {
    class FailOneCheckpointWrite extends MemoryStorage {
        fail = false

        override async setPair(first: StorageEntry, second: StorageEntry, mayWrite?: () => boolean) {
            if (this.fail) {
                this.fail = false
                throw new Error('test: accepted-tail cache write refused')
            }
            await super.setPair(first, second, mayWrite)
        }
    }
    const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
    daemon.subscribe = () => () => {}
    const storage = new FailOneCheckpointWrite()
    const writer = await openSession(daemon, new MemoryStorage(), 'writer', AUTHOR_A)
    const reader = await openSession(daemon, storage, 'reader', AUTHOR_B)
    try {
        await settle(writer, reader)
        await writer.apply([shapeOp('shape:peer', 1)])
        await settle(writer)
        const previous = await storage.get(`page/${DOC}/${PAGE}/state`)
        storage.fail = true
        await reader.reconcile()
        expect(storage.fail).toBe(false)
        expect(liveLines(reader.document)).toBe(1)
        expect(await storage.get(`page/${DOC}/${PAGE}/state`)).toEqual(previous)
        await reader.reconcile()
        expect(await storage.get(`page/${DOC}/${PAGE}/state`)).not.toEqual(previous)
        reader.dispose()
        const reopened = await openSession(daemon, storage, 'reader', AUTHOR_B)
        try {
            expect(liveLines(reopened.document)).toBe(1)
        } finally {
            reopened.dispose()
        }
    } finally {
        writer.dispose()
        reader.dispose()
    }
})

for (const replacementFails of [false, true]) {
    test(`an abandoned checkpoint write stays dirty after replacement succeeds: ${!replacementFails}`, async () => {
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        class InterruptCheckpointStorage extends MemoryStorage {
            pauseNext = false
            failNext = false

            override async setPair(first: StorageEntry, second: StorageEntry, mayWrite?: () => boolean) {
                if (this.pauseNext) {
                    this.pauseNext = false
                    entered.resolve()
                    await release.promise
                } else if (this.failNext) {
                    this.failNext = false
                    throw new Error('test: replacement checkpoint write refused')
                }
                await super.setPair(first, second, mayWrite)
            }
        }
        const { RmDocument } = await import('@weft/rm-format')
        const storage = new InterruptCheckpointStorage()
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        daemon.subscribe = () => () => {}
        const writer = await openSession(daemon, new MemoryStorage(), 'writer', AUTHOR_A)
        const reader = await OfflineSession.open(storage, daemon, DOC, PAGE, {
            clientId: 'reader',
            authorUuid: AUTHOR_B,
            useOps: true,
            retryIntervalMs: 100000,
            reconcileWatchdogMs: 10,
            onPatch: () => {},
        })
        try {
            await settle(writer, reader)
            await writer.apply([shapeOp('shape:first', 1)])
            await settle(writer)
            storage.pauseNext = true
            const abandoned = reader.reconcile()
            await entered.promise
            await writer.apply([shapeOp('shape:second', 2)])
            await settle(writer)
            storage.failNext = replacementFails
            await Bun.sleep(25)
            await reader.reconcile()
            expect(storage.failNext).toBe(false)
            expect(liveLines(reader.document)).toBe(2)
            release.resolve()
            await abandoned
            await reader.reconcile()
            const [durable, saved] = await storage.getPair(
                `page/${DOC}/${PAGE}/base`, `page/${DOC}/${PAGE}/state`,
            )
            expect(liveLines(RmDocument.parse(durable!))).toBe(2)
            expect(JSON.parse(new TextDecoder().decode(saved!)).opCursor).toBe(
                (await daemon.opsSince(DOC, PAGE, 0)).at(-1)!.seq,
            )
        } finally {
            release.resolve()
            reader.dispose()
            writer.dispose()
        }
    })
}

test('snapshot adoption caches the downloaded native bytes until a later edit changes them', async () => {
    const { RmDocument } = await import('@weft/rm-format')
    const { encodeSnapshot } = await import('../src/snapshot')
    const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
    const storage = new MemoryStorage()
    const base = RmDocument.empty(AUTHOR_A).serialize()
    // A readable trailing byte distinguishes the wire data from a re-encoding.
    const native = new Uint8Array(base.length + 1)
    native.set(base)
    await daemon.putSnapshot(DOC, PAGE, encodeSnapshot(native, { shapes: [] }))
    const reader = await openSession(daemon, storage, 'reader', AUTHOR_B)
    try {
        await settle(reader)
        const cached = () => storage.get(`page/${DOC}/${PAGE}/base`)
        expect(await cached()).toEqual(native)
        const next = new Uint8Array(base.length + 2)
        next.set(base)
        await daemon.putSnapshot(DOC, PAGE, encodeSnapshot(next, { shapes: [] }))
        await settle(reader)
        expect(await cached()).toEqual(next)
        await reader.apply([shapeOp('shape:after-open')])
        await settle(reader)
        expect(liveLines(RmDocument.parse((await cached())!))).toBe(1)
    } finally {
        reader.dispose()
    }
})

test('an individual subscriber sees both loose ink and a browser shape from the checkpoint tail', async () => {
    const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
    const native = RmDocument.empty(AUTHOR_A)
    const { encodeSnapshot } = await import('../src/snapshot')
    await daemon.putSnapshot(DOC, PAGE, encodeSnapshot(native.serialize(), { shapes: [] }))
    const { deltas } = applyOps(native, { shapes: [] }, [shapeOp('shape:peer')], { authorUuid: AUTHOR_B })
    const extra = applyOps(native, { shapes: [] }, [shapeOp('shape:loose', 20)], { authorUuid: AUTHOR_B })
    const ink = extra.deltas.filter(op => op.op === 'add')
    await daemon.appendOps(DOC, PAGE, [...deltas, ...ink].map(encodeOp), AUTHOR_B)
    const patches: ViewPatch[] = []
    const session = await openSession(daemon, new MemoryStorage(), 'viewer', AUTHOR_A, patches)
    try {
        await settle(session)
        expect(patches.filter(p => p.type === 'shape-upserted').map(p => p.shape.shapeId)).toEqual(['shape:peer'])
        expect(patches.filter(p => p.type === 'ink-added').flatMap(p => p.items)).toHaveLength(1)
        expect(patches.filter(p => p.type === 'document-replaced')).toHaveLength(1)
        expect(liveLines(session.document)).toBe(2)
    } finally {
        session.dispose()
    }
})

test('deferred projection is transferred only for its exact durable generation', async () => {
    const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
    const storage = new MemoryStorage()
    const openScoped = (transport: FakeDaemon, replicaScope = 'account-a@relay-a') =>
        OfflineSession.open(storage, transport, DOC, PAGE, {
            clientId: 'client-A', authorUuid: AUTHOR_A, replicaScope, onPatch: () => {},
        })
    const client = await openScoped(daemon)
    await settle(client)
    const draft = client.deferredDraftStorageKey('shape')
    const old = new Uint8Array([1])
    const latest = new Uint8Array([2])
    await storage.set(draft, latest)
    expect(await client.applyDeferredDraft([draft, old], [shapeOp('shape', 1)], () => true)).toBe(false)
    expect(await client.applyDeferredDraft([draft, latest], [shapeOp('shape', 2)], () => false)).toBe(false)
    expect(client.pendingCount).toBe(0)
    expect(await storage.get(draft)).toEqual(latest)

    const failCommit = spyOn(storage, 'consume').mockRejectedValueOnce(new Error('transaction aborted'))
    await expect(client.applyDeferredDraft([draft, latest], [shapeOp('shape', 2)], () => true))
        .rejects.toThrow('transaction aborted')
    expect(client.pendingCount).toBe(0)
    expect(await storage.get(draft)).toEqual(latest)
    expect(client.currentOverlay.shapes).toHaveLength(0)
    failCommit.mockRestore()
    await client.disposeAndDrainLocalWrites()

    const offline = new Proxy(daemon, {
        get(target, key) {
            if (key === 'appendOps' || key === 'putSnapshot') return async () => { throw new Error('offline') }
            const value = Reflect.get(target, key)
            return typeof value === 'function' ? value.bind(target) : value
        },
    })
    const reopened = await openScoped(offline)
    await settle(reopened)
    expect(await reopened.applyDeferredDraft([draft, latest], [shapeOp('shape', 2)], () => true)).toBe(true)
    expect(await storage.get(draft)).toBeNull()
    expect(await reopened.applyDeferredDraft([draft, latest], [shapeOp('shape', 2)], () => true)).toBe(false)
    expect(reopened.pendingCount).toBe(1)
    await reopened.disposeAndDrainLocalWrites()
    const otherRelay = FakeDaemon.withBlankPage(DOC, PAGE)
    for (const changedScope of ['account-b@relay-a', 'account-a@relay-b']) {
        const other = await openScoped(otherRelay, changedScope)
        await settle(other)
        expect(other.pendingCount).toBe(0)
        expect(other.currentOverlay.shapes).toHaveLength(0)
        expect(await other.applyDeferredDraft([draft, latest], [shapeOp('shape', 2)], () => true)).toBe(false)
        await other.disposeAndDrainLocalWrites()
    }
    expect(await otherRelay.opsSince(DOC, PAGE, 0)).toEqual([])
    const reconnected = await openScoped(daemon)
    await settle(reconnected)
    const peer = await openSession(daemon, new MemoryStorage(), 'client-B', AUTHOR_B)
    await settle(peer)
    expect(peer.currentOverlay.shapes.map(s => s.shapeId)).toEqual(['shape'])
    expect(liveLines(peer.document)).toBe(1)
    await reconnected.disposeAndDrainLocalWrites()
    await peer.disposeAndDrainLocalWrites()
})
