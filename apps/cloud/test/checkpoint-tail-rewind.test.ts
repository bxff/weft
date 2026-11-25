import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, spyOn, test } from 'bun:test'
import { RmDocument } from '@weft/rm-format'
import { encodeOp, encodeSnapshot, HttpTransport, MemoryStorage, OfflineSession } from '@weft/sync-engine'
import { startCloud } from '../src/server'
import { CloudStore } from '../src/store'

const author = 'aaaaaaaa-0000-4000-a000-000000000001'
const scope = ['checkpoint-tail-reader', 'book', 'sheet'] as const
const [, doc, page] = scope
const shape = (id: string) => ({
    shapeId: id, kind: 'geo' as const, props: {}, x: 10, y: 20, rotation: 0,
    rendered: [], renderRevision: '', state: 'live' as const, version: { actor: author, ts: 1 },
})
const op = (id: string) => encodeOp({
    op: 'upsert-object', id, objType: 'geo', props: {}, rendered: [],
    transform: { x: 10, y: 20, rotation: 0 }, version: { actor: author, ts: 1 },
})

for (const startup of ['cold', 'warm'] as const) {
    test(`a ${startup} session never installs a checkpoint with a tail from after a rewind`, async () => {
        const previous = process.env.CLOUD_DEV_USER
        process.env.CLOUD_DEV_USER = '1'
        const cloud = startCloud({ port: 0, db: ':memory:' })
        const wire = new HttpTransport({
            baseUrl: 'http://127.0.0.1:' + cloud.port, getAuthToken: () => 'dev:' + scope[0],
        })
        wire.subscribe = () => () => {}
        const seed = RmDocument.empty(author).serialize()
        const blankCheckpoint = cloud.store.putSnapshot(...scope, encodeSnapshot(seed, { shapes: [] }))
        const checkpoint = () => {
            cloud.store.putSnapshot(...scope, encodeSnapshot(seed, { shapes: [shape('shape:rewound')] }))
            cloud.store.appendOps(...scope, [op('shape:old-tail')], 'peer')
        }
        const storage = new MemoryStorage()
        const writes: string[][] = [], paints: string[][] = []
        const pair = storage.setPair.bind(storage)
        storage.setPair = async (first, second) => {
            const state = JSON.parse(new TextDecoder().decode(second[1]))
            writes.push(state.overlay.shapes.map((item: { shapeId: string }) => item.shapeId))
            return pair(first, second)
        }
        const read = wire.opsSince.bind(wire)
        let rewind = startup === 'cold'
        wire.opsSince = async (...args) => {
            if (rewind) {
                rewind = false
                cloud.store.revertToSnapshot(...scope, blankCheckpoint)
                cloud.store.appendOps(...scope, [op('shape:after-rewind')], 'peer')
            }
            return read(...args)
        }
        let session: OfflineSession | undefined
        try {
            if (startup === 'cold') checkpoint()
            session = await OfflineSession.open(storage, wire, doc, page, {
                clientId: 'reader', authorUuid: author, retryIntervalMs: 100000,
                onPatch: () => { if (session) paints.push(session.currentOverlay.shapes.map(item => item.shapeId)) },
            })
            if (startup === 'warm') {
                await session.reconcile()
                checkpoint()
                rewind = true
            }
            writes.length = 0
            paints.length = 0
            await session.reconcile()
            const visible = ['shape:after-rewind']
            expect(session.currentOverlay.shapes.map(item => item.shapeId)).toEqual(visible)
            expect(paints).toContainEqual(visible)
            expect(paints.every(ids => ids.every(id => visible.includes(id)))).toBe(true)
            expect(writes).toContainEqual(visible)
            expect(writes.every(ids => ids.every(id => visible.includes(id)))).toBe(true)
        } finally {
            await session?.dispose()
            wire.close()
            cloud.stop()
            if (previous === undefined) delete process.env.CLOUD_DEV_USER
            else process.env.CLOUD_DEV_USER = previous
        }
    })
}

test('an operation page reports rows and generation from the same SQLite read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-operation-page-'))
    const db = join(dir, 'relay.sqlite')
    const dev = process.env.CLOUD_DEV_USER
    process.env.CLOUD_DEV_USER = '1'
    const cloud = startCloud({ port: 0, db })
    const peer = new CloudStore(db)
    try {
        const seed = encodeSnapshot(RmDocument.empty(author).serialize(), { shapes: [] })
        const checkpoint = cloud.store.putSnapshot(...scope, seed)
        const initial = cloud.store.appendOps(...scope, [op('shape:initial')], 'peer').lastSeq
        const read = cloud.store.opsSince.bind(cloud.store)
        spyOn(cloud.store, 'opsSince').mockImplementationOnce((...args) => {
            const rows = read(...args)
            peer.revertToSnapshot(...scope, checkpoint)
            peer.appendOps(...scope, [op('shape:after-rewind')], 'peer')
            return rows
        })
        const get = () => fetch(`http://127.0.0.1:${cloud.port}/api/documents/${doc}/pages/${page}/ops?since=0`, {
            headers: { authorization: 'Bearer dev:' + scope[0] },
        }).then(response => response.json() as Promise<{ snapshotSeq: number; head: number; ops: { seq: number }[] }>)
        const prior = await get()
        expect(prior.snapshotSeq).toBe(checkpoint)
        expect(prior.head).toBe(initial)
        expect(prior.ops.map(({ seq }) => seq)).toEqual([initial])
        const latest = await get()
        expect(latest.snapshotSeq).toBeGreaterThan(checkpoint)
        expect(latest.head).toBeGreaterThan(initial)
        expect(latest.ops.at(-1)?.seq).toBe(latest.head)
    } finally {
        cloud.stop()
        if (dev === undefined) delete process.env.CLOUD_DEV_USER
        else process.env.CLOUD_DEV_USER = dev
        rmSync(dir, { recursive: true, force: true })
    }
})
