import { expect, test } from 'bun:test'
import { RmDocument, createRootText, insertText, mergeRootTextInto, linearizeRootText, rootTextCharPositions, crdtIdKey, type CrdtId } from '@weft/rm-format'
import { OfflineSession } from '../src/offline-session'
import { FakeDaemon } from '../src/fake-daemon'
import { MemoryStorage } from '../src/storage'
import { decodePublicationBytes, type BrowserPublication, type BrowserReceipt } from '../src/browser-publication'
import { decodeSnapshot, decodeSnapshotBatch, encodeSnapshot } from '../src/snapshot'

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
        if (req.kind !== 'snapshot') throw new Error('expected a native text snapshot')
        await this.beforeSave?.()
        const head = await this.getSnapshot(doc, page)
        if (head?.seq !== req.baseSeq) return { kind: 'stale' }
        const receipt = { kind: 'snapshot' as const, ...await this.putSnapshot(doc, page, decodeSnapshotBatch(decodePublicationBytes(req.payload)).snapshot) }
        this.receipts.set(req.id, receipt)
        this.accepted.push(req)
        await this.afterSave?.()
        return receipt
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
