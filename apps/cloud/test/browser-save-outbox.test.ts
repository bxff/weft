import { expect, test } from 'bun:test'
import { linearizeRootText, RmDocument } from '@weft/rm-format'
import { encodeSnapshot, HttpTransport, MemoryStorage, OfflineSession } from '@weft/sync-engine'
import { startCloud } from '../src/server'

const DOC = 'save-doc'
const PAGE = 'save-page'
const USER = 'save-tester'
const AUTHOR = 'aaaaaaaa-0000-4000-a000-000000000001'
const PEER = 'bbbbbbbb-0000-4000-a000-000000000002'
const text = 'Saved before departure'

function visible(session: OfflineSession) {
    const root = session.document.tree().rootText
    return root ? linearizeRootText(root).flatMap(paragraph => paragraph.spans.map(span => span.text)).join('') : ''
}

test.each(['reject', 'accepted-response-lost', 'local-commit-rejected', 'accepted-op-response-lost'] as const)(
    'guarded save retries the same publication through a reopened author (%s)', async (failure) => {
        process.env.CLOUD_DEV_USER = '1'
        const server = startCloud({ port: 0, db: ':memory:' })
        const key = [USER, DOC, PAGE] as const
        const blank = RmDocument.empty(AUTHOR).serialize()
        server.store.putSnapshot(...key, encodeSnapshot(blank, { shapes: [] }))
        const transport = new HttpTransport({
            baseUrl: `http://localhost:${server.port}`,
            getAuthToken: () => `dev:${USER}`,
        })
        transport.subscribe = () => () => {}
        const attempts: Parameters<HttpTransport['publishBrowserSave']>[2][] = []
        const publish = transport.publishBrowserSave.bind(transport)
        const opsOnly = failure === 'accepted-op-response-lost'
        const expectedText = opsOnly ? '' : text
        let inject = true
        transport.publishBrowserSave = async (doc, page, staged) => {
            attempts.push(staged)
            if (inject && failure === 'reject') throw new Error('upload blocked')
            const receipt = await publish(doc, page, staged)
            if (inject && (failure === 'accepted-response-lost' || opsOnly)) throw new Error('response lost')
            return receipt
        }
        class Disk extends MemoryStorage {
            override async commitSave(...args: Parameters<MemoryStorage['commitSave']>) {
                if (inject && failure === 'local-commit-rejected') throw new Error('transaction aborted')
                return super.commitSave(...args)
            }
        }
        const storage = new Disk()
        const sessions: OfflineSession[] = []
        const open = async (disk: MemoryStorage, author: string, adopt = false) => {
            const session = await OfflineSession.open(disk, transport, DOC, PAGE, {
                authorUuid: author, clientId: author, guardedSaves: true,
                ...(adopt ? { adoptOrphanAuthor: async (_id, run) => { await run(); return true } } : {}),
                onPatch: () => {}, retryIntervalMs: 100_000,
            })
            sessions.push(session)
            await session.reconcile()
            return session
        }
        try {
            const first = await open(storage, AUTHOR)
            await first.apply([
                ...(opsOnly ? [] : [{ type: 'edit-root-text' as const, create: {}, inserts: [{ afterKey: null, text }] }]),
                {
                    type: 'upsert-shape',
                    shape: {
                        shapeId: 'shape:alongside', kind: 'draw-native', props: {}, x: 0, y: 0, rotation: 0,
                        version: { ts: 1, actor: AUTHOR }, renderRevision: 'alongside',
                    },
                    parts: [],
                },
            ])
            await first.reconcile()
            expect(first.pendingCount).toBe(opsOnly ? 1 : 2)
            expect(attempts.length).toBeGreaterThan(0)
            expect(attempts[0]?.kind).toBe(opsOnly ? 'ops' : 'snapshot')
            const before = server.store.latestOpSeq(...key)
            await first.disposeAndDrainLocalWrites()

            inject = false
            const recovered = await open(storage, PEER, true)
            expect(recovered.pendingCount).toBe(0)
            expect(visible(recovered)).toBe(expectedText)
            expect(attempts.every(staged => staged.id === attempts[0]?.id && staged.payload === attempts[0]?.payload)).toBe(true)
            expect(await storage.keys(`page/${DOC}/${PAGE}/pending/`)).toEqual([])
            expect(server.store.opsSince(...key, 0)).toHaveLength(1)
            if (failure !== 'reject') expect(server.store.latestOpSeq(...key)).toBe(before)
            const fresh = await open(new MemoryStorage(), AUTHOR)
            expect(visible(fresh)).toBe(expectedText)
            expect(fresh.currentOverlay.shapes.map(shape => shape.shapeId)).toEqual(['shape:alongside'])
        } finally {
            for (const session of sessions) await session.disposeAndDrainLocalWrites()
            server.stop()
        }
    },
)

test('a confirmed stale receipt only rebuilds a save after pulling the new head', async () => {
    process.env.CLOUD_DEV_USER = '1'
    const server = startCloud({ port: 0, db: ':memory:' })
    const key = [USER, DOC, PAGE] as const
    const blank = RmDocument.empty(AUTHOR).serialize()
    server.store.putSnapshot(...key, encodeSnapshot(blank, { shapes: [] }))
    const transport = new HttpTransport({
        baseUrl: `http://localhost:${server.port}`,
        getAuthToken: () => `dev:${USER}`,
    })
    transport.subscribe = () => () => {}
    const publish = transport.publishBrowserSave.bind(transport)
    const attempts: Parameters<HttpTransport['publishBrowserSave']>[2][] = []
    transport.publishBrowserSave = async (doc, page, save) => {
        if (attempts.length === 0) {
            const peer = RmDocument.parse(blank)
            peer.createLayer('Concurrent tablet layer', { authorUuid: PEER })
            server.store.putSnapshot(...key, encodeSnapshot(peer.serialize(), { shapes: [] }))
        }
        attempts.push(save)
        return publish(doc, page, save)
    }
    const session = await OfflineSession.open(new MemoryStorage(), transport, DOC, PAGE, {
        authorUuid: AUTHOR, clientId: AUTHOR, guardedSaves: true, onPatch: () => {}, retryIntervalMs: 100_000,
    })
    try {
        await session.reconcile()
        await session.apply([{ type: 'edit-root-text', create: {}, inserts: [{ afterKey: null, text }] }])
        for (let i = 0; i < 3; i++) await session.reconcile()
        expect(session.pendingCount).toBe(0)
        expect(attempts).toHaveLength(2)
        expect(attempts[1]!.id).not.toBe(attempts[0]!.id)
        expect(attempts[1]!.baseSeq).toBeGreaterThan(attempts[0]!.baseSeq)
        expect(visible(session)).toBe(text)
        expect(JSON.stringify(session.document.blocks)).toContain('Concurrent tablet layer')
    } finally {
        await session.disposeAndDrainLocalWrites()
        server.stop()
    }
})
