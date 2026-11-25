import { expect, test } from 'bun:test'
import { RmDocument } from '@weft/rm-format'
import { encodeOp, encodeSnapshot, HttpTransport, MemoryStorage, OfflineSession } from '@weft/sync-engine'
import { startCloud } from '../src/server'

const author = 'aaaaaaaa-0000-4000-a000-000000000001'
const user = 'complete-checkpoint-test'
const doc = 'book', page = 'sheet'
const shape = encodeOp({op: 'upsert-object', id: 'shape:remote', objType: 'geo', props: {value: 5}, rendered: [],
    transform: {x: 1,y: 2,rotation: 0}, version: {actor: author, ts: 1}})

for (const scenario of ['complete', 'tail', 'older relay', 'edit during read', 'edit during install'] as const) {
    test(`page bootstrap at a checkpoint: ${scenario}`, async () => {
        const env = {host: process.env.HOST, dev: process.env.CLOUD_DEV_USER}
        process.env.HOST = '127.0.0.1'
        process.env.CLOUD_DEV_USER = '1'
        const cloud = startCloud({port: 0, db: ':memory:'})
        const origin = 'http://127.0.0.1:' + cloud.port
        const wire = new HttpTransport({baseUrl: origin, getAuthToken: () => 'dev:' + user})
        const blank = RmDocument.empty(author)
        const first = cloud.store.putSnapshot(user, doc, page, encodeSnapshot(blank.serialize(), {shapes: []}))
        if (scenario === 'tail') cloud.store.appendOps(user, doc, page, [shape], 'other')
        const trace: string[] = []
        const snapshot = wire.getSnapshot.bind(wire)
        const range = wire.opsSince.bind(wire)
        const put = wire.putSnapshot.bind(wire)
        const opened = Promise.withResolvers<void>()
        const synced = Promise.withResolvers<void>()
        wire.getSnapshot = async (...args) => {
            await opened.promise
            const s = await snapshot(...args)
            if (s) trace.push('checkpoint ' + s.seq)
            if (s && scenario === 'older relay') delete s.complete
            return s
        }
        wire.opsSince = async (...args) => { trace.push('tail'); return range(...args) }
        wire.putSnapshot = async (...args) => { trace.push('publish'); return put(...args) }
        const connected = Promise.withResolvers<void>()
        const stopWaiting = wire.subscribeDocList(connected.resolve)
        let session: OfflineSession | undefined
        let edit: Promise<void> | undefined
        try {
            await connected.promise
            session = await OfflineSession.open(new MemoryStorage(), wire, doc, page, {
                authorUuid: author, clientId: 'reader', retryIntervalMs: 100000,
                onStatus(status) { if (status.state === 'synced') synced.resolve() },
                onPatch(patch) {
                    if (scenario !== 'edit during install' || edit || patch.type !== 'document-replaced') return
                    const advanced = RmDocument.parse(blank.serialize())
                    advanced.createLayer('tablet', {authorUuid: author})
                    cloud.store.putSnapshot(user, doc, page, encodeSnapshot(advanced.serialize(), {shapes: []}))
                    edit = session!.apply([{type: 'create-layer', label: 'browser'}])
                },
            })
            if (scenario === 'edit during read') {
                await session.apply([{ type: 'create-layer', label: 'browser' }])
            }
            opened.resolve()
            await synced.promise
            if (scenario === 'complete') expect(trace).toEqual(['checkpoint ' + first])
            if (scenario === 'older relay' || scenario === 'tail') expect(trace).toContain('tail')
            if (scenario === 'tail') expect(session.currentOverlay.shapes.map(s => s.shapeId)).toContain('shape:remote')
            if (scenario === 'edit during read') {
                expect(trace.indexOf('tail')).toBeGreaterThan(0)
                expect(trace.indexOf('publish')).toBeGreaterThan(trace.indexOf('tail'))
                expect(session.document.layers().map(l => l.label)).toContain('browser')
            }
            if (scenario === 'edit during install') {
                await edit
                await session.reconcile()
                expect(trace.indexOf('checkpoint ' + (first + 1))).toBeGreaterThan(0)
                expect(trace.indexOf('publish')).toBeGreaterThan(trace.indexOf('checkpoint ' + (first + 1)))
                expect(session.document.layers().map(l => l.label)).toContain('tablet')
                expect(session.document.layers().map(l => l.label)).toContain('browser')
            }
        } finally {
            stopWaiting()
            opened.resolve()
            await session?.dispose()
            wire.close()
            cloud.stop()
            if (env.host === undefined) delete process.env.HOST; else process.env.HOST = env.host
            if (env.dev === undefined) delete process.env.CLOUD_DEV_USER; else process.env.CLOUD_DEV_USER = env.dev
        }
    })
}

test.each([{}, {'x-snapshot-seq': '2'}, {'x-snapshot-seq': '2', 'x-snapshot-op-seq': 'NaN'},
    {'x-snapshot-seq': '-1', 'x-snapshot-op-seq': '0'}])('a complete response needs both valid cursors (%o)', async extra => {
    const headers = new Headers({'x-snapshot-complete': '1'})
    for (const [key, value] of Object.entries(extra)) headers.set(key, value!)
    const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response('invalid metadata', {headers})})
    const wire = new HttpTransport({baseUrl: server.url.origin})
    try {
        await expect(wire.getSnapshot(doc, page)).rejects.toThrow('Invalid checkpoint header')
    } finally { wire.close(); server.stop(true) }
})

test.each(['HTTP fallback', 'HTTP polling', 'late initial connection', 'reconnect'] as const)(
    'a page receives operations with %s', async scenario => {
        const env = { host: process.env.HOST, dev: process.env.CLOUD_DEV_USER }
        process.env.HOST = '127.0.0.1'
        process.env.CLOUD_DEV_USER = '1'
        const cloud = startCloud({ port: 0, db: ':memory:' })
        const origin = 'http://127.0.0.1:' + cloud.port
        const token = 'dev:' + user
        const ticket = Promise.withResolvers<string>()
        let authCalls = 0
        const wire = new HttpTransport({ baseUrl: origin, getAuthToken: () => {
            // The constructor requests its socket ticket before any HTTP reads.
            return authCalls++ === 0 && scenario !== 'reconnect' ? ticket.promise : token
        } })
        const connected = Promise.withResolvers<void>()
        const synced = Promise.withResolvers<void>()
        const painted = Promise.withResolvers<void>()
        const unsubscribe = wire.subscribeDocList(connected.resolve)
        const writes = `/api/documents/${doc}/pages/${page}/ops`
        const append = async () => {
            const resp = await fetch(origin + writes, {
                method: 'POST',
                headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
                body: JSON.stringify({ ops: [Buffer.from(shape).toString('base64')], author: 'peer' }),
            })
            if (!resp.ok) throw new Error('Operation publication failed: ' + resp.status)
        }
        let session: OfflineSession | undefined
        try {
            const blank = RmDocument.empty(author)
            cloud.store.putSnapshot(user, doc, page, encodeSnapshot(blank.serialize(), { shapes: [] }))
            if (scenario === 'reconnect') await connected.promise
            if (scenario === 'HTTP fallback') {
                const getSnapshot = wire.getSnapshot.bind(wire)
                let appended = false
                wire.getSnapshot = async (...args) => {
                    const received = await getSnapshot(...args)
                    if (!appended && received?.complete) {
                        appended = true
                        await append()
                    }
                    return received
                }
            }
            session = await OfflineSession.open(new MemoryStorage(), wire, doc, page, {
                authorUuid: author, clientId: 'reader', retryIntervalMs: scenario === 'HTTP polling' ? 50 : 100_000,
                onStatus: status => { if (status.state === 'synced') synced.resolve() },
                onPatch: patch => {
                    if (patch.type === 'shape-upserted' && patch.shape.shapeId === 'shape:remote') painted.resolve()
                },
            })
            await synced.promise
            const socket = wire.pageEventsConnection
            if (scenario === 'reconnect') {
                if (!socket) throw new Error('Expected an active page event connection')
                const disconnected = new Promise<void>(resolve => socket.addEventListener('close', () => resolve(), { once: true }))
                socket.close()
                await disconnected
                await append()
            } else if (scenario === 'late initial connection' || scenario === 'HTTP polling') {
                expect(socket).toBeUndefined()
                await append()
                if (scenario === 'late initial connection') ticket.resolve(token)
            }
            await expect(Promise.race([painted.promise.then(() => true), Bun.sleep(1800).then(() => false)])).resolves.toBe(true)
            expect(session.currentOverlay.shapes.map(s => s.shapeId)).toEqual(['shape:remote'])
            if (scenario === 'HTTP fallback') expect(wire.pageEventsConnection).toBeUndefined()
        } finally {
            unsubscribe()
            await session?.dispose()
            wire.close()
            ticket.resolve(token)
            cloud.stop()
            if (env.host === undefined) delete process.env.HOST; else process.env.HOST = env.host
            if (env.dev === undefined) delete process.env.CLOUD_DEV_USER; else process.env.CLOUD_DEV_USER = env.dev
        }
    },
)

test('an edit accepted during the first checkpoint read reaches the open page', async () => {
    const env = { host: process.env.HOST, dev: process.env.CLOUD_DEV_USER }
    process.env.HOST = '127.0.0.1'
    process.env.CLOUD_DEV_USER = '1'
    const cloud = startCloud({ port: 0, db: ':memory:' })
    const origin = 'http://127.0.0.1:' + cloud.port
    const authorization = 'Bearer dev:' + user
    const wire = new HttpTransport({ baseUrl: origin, getAuthToken: () => 'dev:' + user })
    const online = Promise.withResolvers<void>()
    const painted = Promise.withResolvers<void>()
    const unsubscribe = wire.subscribeDocList(online.resolve)
    let session: OfflineSession | undefined
    try {
        const blank = RmDocument.empty(author)
        cloud.store.putSnapshot(user, doc, page, encodeSnapshot(blank.serialize(), { shapes: [] }))
        await online.promise
        const getSnapshot = wire.getSnapshot.bind(wire)
        let appended = false
        wire.getSnapshot = async (...args) => {
            const received = await getSnapshot(...args)
            if (!appended && received?.complete) {
                appended = true
                const batch = { ops: [Buffer.from(shape).toString('base64')], author: 'peer' }
                const resp = await fetch(origin + `/api/documents/${doc}/pages/${page}/ops`, {
                    method: 'POST',
                    headers: { authorization, 'content-type': 'application/json' },
                    body: JSON.stringify(batch),
                })
                if (!resp.ok) throw new Error('Operation publication failed: ' + resp.status)
            }
            return received
        }
        session = await OfflineSession.open(new MemoryStorage(), wire, doc, page, {
            authorUuid: author, clientId: 'reader', retryIntervalMs: 100_000,
            onPatch: patch => {
                if (patch.type === 'shape-upserted' && patch.shape.shapeId === 'shape:remote') painted.resolve()
            },
        })
        await expect(Promise.race([painted.promise.then(() => true), Bun.sleep(1200).then(() => false)])).resolves.toBe(true)
        expect(appended).toBe(true)
        expect(session.currentOverlay.shapes.map(s => s.shapeId)).toEqual(['shape:remote'])
    } finally {
        unsubscribe()
        await session?.dispose()
        wire.close()
        cloud.stop()
        if (env.host === undefined) delete process.env.HOST; else process.env.HOST = env.host
        if (env.dev === undefined) delete process.env.CLOUD_DEV_USER; else process.env.CLOUD_DEV_USER = env.dev
    }
})
