import { expect, test } from 'bun:test'
import { RmDocument, createRootText, insertText, mergeRootTextInto, linearizeRootText, rootTextCharPositions, crdtIdKey, type CrdtId } from '@weft/rm-format'
import { OfflineSession } from '../src/offline-session'
import { FakeDaemon } from '../src/fake-daemon'
import { MemoryStorage } from '../src/storage'
import { decodePublicationBytes, type BrowserPublication, type BrowserReceipt } from '../src/browser-publication'
import { decodeSnapshot, decodeSnapshotBatch, encodeSnapshot } from '../src/snapshot'
import { applyOps, type LocalOp } from '../src/apply-ops'
import { encodeOp } from '../src/ops'
import type { OverlayDocument, ViewPatch } from '../src/types'
import { polylineToPoints } from '@weft/rm-ink/pure'

const A = 'aaaaaaaa-0000-4000-a000-000000000001'
const B = 'bbbbbbbb-0000-4000-a000-000000000002'
const C = 'cccccccc-0000-4000-a000-000000000003'

function native(author: string, text: string) {
    const doc = RmDocument.empty(author)
    createRootText(doc)
    insertText(doc, null, text, { authorUuid: author })
    return doc
}
function combined() {
    const doc = native(A, 'A')
    mergeRootTextInto(doc, native(B, 'B'))
    return doc
}
function reorder(doc: RmDocument) {
    const copy = RmDocument.parse(doc.serialize())
    const remap = (id: CrdtId): CrdtId => id.part1 > 0 ? { ...id, part1: 3 - id.part1 } : id
    for (const block of copy.blocks) {
        if (block.type === 'authorIds') block.authors = new Map([...block.authors].map(([slot, uuid]) => [3 - slot, uuid]))
        if (block.type === 'rootText') block.textItems = block.textItems.map(item => ({
            ...item, itemId: remap(item.itemId), leftId: remap(item.leftId), rightId: remap(item.rightId),
        }))
    }
    return RmDocument.parse(copy.serialize())
}
function text(doc: RmDocument) {
    return linearizeRootText(doc.tree().rootText!).flatMap(p => p.spans.map(s => s.text)).join('')
}
function firstKey(doc: RmDocument) {
    return crdtIdKey(rootTextCharPositions(doc.tree().rootText!).find(p => !p.deleted)!.id)
}
function seed(daemon: FakeDaemon, doc: RmDocument) {
    return daemon.putSnapshot('d', 'p', encodeSnapshot(doc.serialize(), { shapes: [] }))
}
async function relayText(daemon: FakeDaemon) {
    return text(RmDocument.parse(decodeSnapshot((await daemon.getSnapshot('d', 'p'))!.bytes).rm))
}
function open(daemon: FakeDaemon, storage = new MemoryStorage()) {
    return OfflineSession.open(storage, daemon, 'd', 'p', {
        authorUuid: C, clientId: 'editor', guardedSaves: true, onPatch: () => {},
    })
}

class GuardedDaemon extends FakeDaemon {
    private receipts = new Map<string, BrowserReceipt>()
    accepted: BrowserPublication[] = []
    requests: BrowserPublication[] = []
    afterSave: (() => Promise<void>) | undefined
    beforeSave: (() => Promise<void>) | undefined

    async publishBrowserSave(doc: string, page: string, req: BrowserPublication): Promise<BrowserReceipt> {
        this.requests.push(req)
        const previous = this.receipts.get(req.id)
        if (previous) return previous
        await this.beforeSave?.()
        const head = await this.getSnapshot(doc, page)
        if (head?.seq !== req.baseSeq) return { kind: 'stale' }
        const receipt = req.kind === 'snapshot'
            ? { kind: 'snapshot' as const, ...await this.putSnapshot(doc, page, decodeSnapshotBatch(decodePublicationBytes(req.payload)).snapshot) }
            : await this.acceptOps(doc, page, req.payload)
        this.receipts.set(req.id, receipt)
        this.accepted.push(req)
        await this.afterSave?.()
        return receipt
    }

    private async acceptOps(doc: string, page: string, payload: string) {
        const { batch } = JSON.parse(payload) as { batch: { ops: string[]; author: string } }
        const { lastSeq } = await this.appendOps(doc, page, batch.ops.map(decodePublicationBytes), batch.author)
        return { kind: 'ops' as const, lastSeq }
    }
}

test('offline delete still targets the same native author after first pull reorders the slots', async () => {
    const daemon = new GuardedDaemon()
    const before = combined()
    const after = reorder(before)
    expect(before.authorTable().get(1)).toBe(A)
    expect(after.authorTable().get(1)).toBe(B)
    const target = rootTextCharPositions(before.tree().rootText!).find(p => before.authorTable().get(p.id.part1) === A)!
    // The original file-local key is no longer a valid reference to A.
    expect(rootTextCharPositions(after.tree().rootText!).some(p => crdtIdKey(p.id) === crdtIdKey(target.id)
        && after.authorTable().get(p.id.part1) === A)).toBe(false)
    await seed(daemon, before)
    const session = await open(daemon)
    try {
        await session.reconcile()
        await seed(daemon, after)
        await session.apply([{ type: 'edit-root-text', deleteKeys: [crdtIdKey(target.id)] }])
        await session.reconcile()
        expect(await relayText(daemon)).toBe('B')
    } finally {
        session.dispose()
    }
})

test('a true missing target is never replaced with the current occupant of its numeric slot', async () => {
    const daemon = new GuardedDaemon()
    await seed(daemon, native(A, 'A'))
    const session = await open(daemon)
    try {
        await session.reconcile()
        const key = firstKey(session.document)
        await seed(daemon, native(B, 'B'))
        await session.apply([{ type: 'edit-root-text', deleteKeys: [key] }])
        await session.reconcile()
        expect(await relayText(daemon)).toBe('B')
        expect(daemon.requests).toHaveLength(0)
        expect(session.pendingCount).toBe(1)
        expect(text(session.document)).toBe('B')
    } finally {
        session.dispose()
    }
})

test('an edit dependent on a pending character survives lost reply and reopens after exact replay', async () => {
    const daemon = new GuardedDaemon(), storage = new MemoryStorage()
    await seed(daemon, native(A, 'A'))
    let session = await open(daemon, storage)
    let committed!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { committed = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    try {
        await session.reconcile()
        daemon.afterSave = async () => { committed(); await held; throw new Error('lost response') }
        await session.apply([{ type: 'edit-root-text', inserts: [{ afterKey: firstKey(session.document), text: '😀' }] }])
        await ready
        expect(text(session.document)).toBe('A😀')
        const key = crdtIdKey(rootTextCharPositions(session.document.tree().rootText!).at(-1)!.id)
        await session.apply([{ type: 'edit-root-text', inserts: [{ afterKey: key, text: 'B' }] }])
        await session.disposeAndDrainLocalWrites()
        release()
        daemon.afterSave = undefined
        session = await open(daemon, storage)
        for (let i = 0; i < 4; i++) await session.reconcile()
        expect(await relayText(daemon)).toBe('A😀B')
        expect(session.pendingCount).toBe(0)
        expect(daemon.accepted).toHaveLength(2)
        expect(daemon.requests[1]).toEqual(daemon.requests[0])
    } finally {
        release()
        session.dispose()
    }
})

test('after a stale first attempt, a pending dependent edit follows the reminted character', async () => {
    const daemon = new GuardedDaemon()
    const before = native(A, 'A')
    await seed(daemon, before)
    const session = await open(daemon)
    let attempting!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { attempting = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    try {
        await session.reconcile()
        daemon.beforeSave = async () => { attempting(); await held }
        await session.apply([{ type: 'edit-root-text', inserts: [{ afterKey: firstKey(session.document), text: '😀' }] }])
        await ready
        const key = crdtIdKey(rootTextCharPositions(session.document.tree().rootText!).at(-1)!.id)
        await session.apply([{ type: 'edit-root-text', inserts: [{ afterKey: key, text: 'B' }] }])

        // Head advance invalidates the first save attempt and forces a different CRDT clock.
        insertText(before, null, 'REMOTE ', { authorUuid: B })
        await seed(daemon, before)
        release()
        for (let i = 0; i < 4; i++) await session.reconcile()
        expect(await relayText(daemon)).toBe('REMOTE A😀B')
        expect(session.pendingCount).toBe(0)
        expect(daemon.accepted).toHaveLength(1)
        expect(daemon.requests[1]!.id).not.toBe(daemon.requests[0]!.id)
    } finally {
        release()
        session.dispose()
    }
})


test('an edit captured during another save can be queued after its dependency is acknowledged', async () => {
    const daemon = new GuardedDaemon()
    await seed(daemon, native(A, 'A'))
    const session = await open(daemon)
    let committed!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { committed = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    try {
        await session.reconcile()
        daemon.afterSave = async () => { committed(); await held }
        await session.apply([{ type: 'edit-root-text', inserts: [{ afterKey: firstKey(session.document), text: '😀' }] }])
        await ready
        const key = crdtIdKey(rootTextCharPositions(session.document.tree().rootText!).at(-1)!.id)
        const captured = session.captureRootTextEdit({ type: 'edit-root-text', inserts: [{ afterKey: key, text: 'B' }] })
        release()
        await session.reconcile()
        expect(session.pendingCount).toBe(0)
        await session.apply([captured])
        await session.reconcile()
        expect(await relayText(daemon)).toBe('A😀B')
        expect(session.pendingCount).toBe(0)
    } finally {
        release()
        session.dispose()
    }
})


test('duplicated author slots with overlapping clocks refuse to target either character', async () => {
    const daemon = new GuardedDaemon()
    const before = native(A, 'A')
    const ambiguous = RmDocument.parse(before.serialize())
    const first = ambiguous.rootTextBlock!.textItems[0]!
    for (const block of ambiguous.blocks) if (block.type === 'authorIds') block.authors.set(2, A)
    ambiguous.rootTextBlock!.textItems.push({ ...first, itemId: { ...first.itemId, part1: 2 }, value: 'B' })
    await seed(daemon, before)
    const session = await open(daemon)
    try {
        await session.reconcile()
        await seed(daemon, ambiguous)
        await session.apply([{ type: 'edit-root-text', deleteKeys: [firstKey(session.document)] }])
        await session.reconcile()
        expect((await relayText(daemon)).split('').sort().join('')).toBe('AB')
        expect(session.pendingCount).toBe(1)
        expect(daemon.requests).toHaveLength(0)
    } finally {
        session.dispose()
    }
})

function richPlan(session: OfflineSession) {
    return session.planRootText((doc, add) => {
        add({ type: 'edit-root-text', inserts: [{ afterKey: firstKey(doc), text: 'X' }] })
        add({ type: 'edit-root-text', styles: [['0:0', 2, undefined]] })
        add({ type: 'edit-root-text', inserts: [{ afterKey: firstKey(doc), codes: [1] }] })
    })
}

test('a failed rich plan journal write leaves no partial local or remote changes and can retry', async () => {
    const daemon = new GuardedDaemon()
    await seed(daemon, native(A, 'A'))
    const storage = new MemoryStorage()
    const session = await open(daemon, storage)
    try {
        await session.reconcile()
        const set = storage.set.bind(storage)
        storage.set = async (key, bytes) => {
            if (key.includes('/pending/')) throw new Error('injected write failure')
            await set(key, bytes)
        }
        await expect(session.apply(richPlan(session))).rejects.toThrow('injected write failure')
        expect(session.pendingCount).toBe(0)
        expect(text(session.document)).toBe('A')
        expect(daemon.requests).toHaveLength(0)
        storage.set = set
        await session.apply(richPlan(session))
        await session.reconcile()
        expect(daemon.requests).toHaveLength(1)
        const remote = (await daemon.getSnapshot('d', 'p'))!
        const [first] = linearizeRootText(RmDocument.parse(decodeSnapshot(remote.bytes).rm).rootTextBlock!.text)
        expect(first!.style).toBe(2)
        expect(first!.spans).toEqual([
            { text: 'A', bold: false, italic: false },
            { text: 'X', bold: true, italic: false },
        ])
    } finally {
        session.dispose()
    }
})

test('a same-text replacement with different native identity fences the whole formatted plan after persistence', async () => {
    const daemon = new GuardedDaemon()
    const storage = new MemoryStorage()
    await seed(daemon, native(A, 'A'))
    const session = await open(daemon, storage)
    let writing!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { writing = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    try {
        await session.reconcile()
        const set = storage.set.bind(storage)
        storage.set = async (key, bytes) => {
            if (key.includes('/pending/')) { writing(); await held }
            return set(key, bytes)
        }
        const pending = session.apply(richPlan(session))
        await ready
        expect(session.pendingCount).toBe(0)
        await seed(daemon, native(B, 'A'))
        release()
        await pending
        await session.reconcile()
        expect(session.pendingCount).toBe(3)
        expect(daemon.requests).toHaveLength(0)
        expect(await relayText(daemon)).toBe('A')
    } finally {
        release()
        session.dispose()
    }
})

test('a large existing formatted page is fenced by a fixed digest, not duplicated in the pending journal', async () => {
    const daemon = new GuardedDaemon()
    const storage = new MemoryStorage()
    const privateFixture = 'previous document content is not a pending write'
    await seed(daemon, native(A, privateFixture.repeat(48)))
    const session = await open(daemon, storage)
    try {
        await session.reconcile()
        const set = storage.set.bind(storage)
        let firstQueue: string | undefined
        storage.set = async (key, bytes) => {
            if (!firstQueue && key.includes('/pending/')) firstQueue = new TextDecoder().decode(bytes)
            return set(key, bytes)
        }
        const pending = richPlan(session)
        expect(pending[0]?.expectedTextBasis).toMatch(/^sha256-v1:[0-9a-f]{64}$/)
        await session.apply(pending)
        expect(firstQueue).toBeDefined()
        expect(firstQueue).not.toContain(privateFixture)
        expect(firstQueue!.length).toBeLessThan(1024)
    } finally {
        session.dispose()
    }
})

test('receipt folding failure leaves the journal and previously visible edit intact', async () => {
    const daemon = new GuardedDaemon(), storage = new MemoryStorage()
    daemon.subscribe = () => () => {}
    await seed(daemon, native(A, 'A'))
    const session = await open(daemon, storage)
    try {
        await session.reconcile()
        const internal = session as unknown as {
            runAudit: (...args: unknown[]) => boolean
            lastSnapshotSeq: number
        }
        const beforeSeq = internal.lastSnapshotSeq
        const original = internal.runAudit.bind(session)
        const failed = Promise.withResolvers<void>()
        internal.runAudit = () => {
            internal.runAudit = original
            failed.resolve()
            throw new Error('Synthetic failure folding authoritative text')
        }
        await session.apply([{ type: 'edit-root-text', inserts: [{ afterKey: firstKey(session.document), text: 'B' }] }])
        await failed.promise
        expect(text(session.document)).toBe('AB')
        expect(session.pendingCount).toBe(1)
        expect(internal.lastSnapshotSeq).toBe(beforeSeq)
        expect(await relayText(daemon)).toBe('AB')

        await session.reconcile()
        expect(session.pendingCount).toBe(0)
        expect(daemon.requests[1]).toEqual(daemon.requests[0])
    } finally {
        session.dispose()
    }
})

test('a view observer exception cannot prevent atomic local retirement of an accepted save', async () => {
    const daemon = new GuardedDaemon(), storage = new MemoryStorage()
    daemon.subscribe = () => () => {}
    await seed(daemon, native(A, 'A'))
    let crashes = 0
    let visible = ''
    const reports: string[] = []
    let session = await OfflineSession.open(storage, daemon, 'd', 'p', {
        authorUuid: C, clientId: 'editor', guardedSaves: true,
        onPatch: patch => {
            if (!daemon.accepted.length || patch.type !== 'document-replaced') return
            if (!crashes) {
                crashes++
                throw new Error('Synthetic view failure with note text: AB')
            }
            visible = text(session.document)
        },
        onFailure: report => reports.push(report.message),
    })
    try {
        await session.reconcile()
        await session.apply([{ type: 'edit-root-text', inserts: [{ afterKey: firstKey(session.document), text: 'B' }] }])
        await session.reconcile()
        expect(crashes).toBe(1)
        expect(visible).toBe('AB')
        expect(reports).toEqual(['Guarded view observer failed'])
        expect(daemon.requests).toHaveLength(1)
        expect(session.pendingCount).toBe(0)
        await session.disposeAndDrainLocalWrites()
        daemon.getSnapshot = async () => { throw new Error('offline') }
        session = await open(daemon, storage)
        expect(text(session.document)).toBe('AB')
    } finally {
        session.dispose()
    }
})

for (const replacement of ['none', 'relay', 'optimistic'] as const) {
    test(`guarded receipt resolves glyph repair against the final folded overlay (replacement=${replacement})`, async () => {
        const daemon = new GuardedDaemon()
        daemon.subscribe = () => () => {}
        const id = 'shape:glyphs'
        const base = RmDocument.empty(A)
        const initial: LocalOp = {
            type: 'upsert-shape',
            shape: { shapeId: id, kind: 'text', props: { text: 'ABCD' }, x: 0, y: 0, rotation: 0, renderRevision: 'old', version: { actor: A, ts: 1 } },
            parts: [...'ABCD'].map((_, glyph) => ({
                partKey: `glyph:${glyph}`,
                strokes: [{
                    points: polylineToPoints([{ x: 10 + glyph * 10, y: 20 }, { x: 10 + glyph * 10, y: 30 }], { width: 40 }),
                    color: 'black',
                }],
            })),
        }
        const overlay: OverlayDocument = { shapes: [] }
        applyOps(base, overlay, [initial], { authorUuid: A })
        const shape = overlay.shapes[0]!
        const deleted = shape.rendered[3]!.items[0]!
        await daemon.putSnapshot('d', 'p', encodeSnapshot(base.serialize(), overlay))
        const outgoing = { ...initial, shape: { ...initial.shape, shapeId: 'shape:unrelated', kind: 'geo' }, parts: [] }
        const observations: Array<{ patch: ViewPatch; text: unknown }> = []
        let observedParked = false
        const session = await OfflineSession.open(new MemoryStorage(), daemon, 'd', 'p', {
            authorUuid: C, clientId: 'editor', guardedSaves: true,
            onPatch: patch => {
                if (patch.type !== 'shape-edited') return
                const visible = session.currentOverlay.shapes.find(shape => shape.shapeId === id)
                observations.push({ patch, text: visible?.props })
            },
        })
        try {
            await session.reconcile()
            daemon.afterSave = async () => {
                const blobs = [encodeOp({ op: 'tombstone', id: { author: deleted.authorUuid, clock: deleted.clock } })]
                daemon.afterSave = undefined
                if (replacement === 'relay') blobs.push(encodeOp({
                    op: 'upsert-object', id, objType: 'text', props: { text: 'XBC' },
                    transform: { x: 0, y: 0, rotation: 0 }, rendered: shape.rendered.slice(0, 3),
                    version: { actor: B, ts: 2 }, renderRevision: 'new',
                }))
                await daemon.appendOps('d', 'p', blobs, B)
                if (replacement === 'optimistic') {
                    daemon.beforeSave = async () => {
                        const state = session as unknown as { parkedRepairs: Set<string> }
                        observedParked = state.parkedRepairs.has(id)
                    }
                    await session.apply([{
                        ...initial,
                        shape: { ...initial.shape, props: { text: 'XYZW' }, renderRevision: 'new-local', version: { actor: C, ts: 2 } },
                    }])
                }
            }
            await session.apply([outgoing])
            for (let i = 0; i < 3; i++) await session.reconcile()
            expect(session.pendingCount).toBe(0)
            expect(daemon.accepted[0]?.kind).toBe('ops')
            expect(observedParked).toBe(replacement === 'optimistic')
            expect((session as unknown as { parkedRepairs: Set<string> }).parkedRepairs.size).toBe(0)
            if (replacement !== 'none') {
                expect(observations).toEqual([])
                expect(session.currentOverlay.shapes.find(shape => shape.shapeId === id)?.props).toEqual({
                    text: replacement === 'optimistic' ? 'XYZW' : 'XBC',
                })
            } else {
                expect(observations).toEqual([{
                    patch: { type: 'shape-edited', shapeId: id, edit: { kind: 'text-truncate-glyphs', removedGlyphIndices: [3] } },
                    text: { text: 'ABCD' },
                }])
            }
        } finally {
            session.dispose()
        }
    })
}
