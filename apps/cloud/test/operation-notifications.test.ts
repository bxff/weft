import { expect, test } from 'bun:test'
import { RmDocument } from '@weft/rm-format'
import {
    encodeOp, encodeSnapshot, HttpTransport, MemoryStorage, OfflineSession,
} from '@weft/sync-engine'
import { startCloud } from '../src/server'

async function until(ready: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000
    while (!ready() && Date.now() < deadline) await Bun.sleep(10)
    expect(ready()).toBe(true)
}

test('accepted edits reach the open page through WebSocket without polling', async () => {
    const previous = process.env.CLOUD_DEV_USER
    process.env.CLOUD_DEV_USER = '1'
    const server = startCloud({ port: 0 })
    const transport = new HttpTransport({
        baseUrl: `http://localhost:${server.port}`,
        getAuthToken: () => 'dev:notifications',
    })
    const sessions: OfflineSession[] = []
    try {
        // The transport announces the initial WS connection to doc-list subscribers.
        let connected = false
        const unsubscribe = transport.subscribeDocList(() => { connected = true })
        await until(() => connected)
        unsubscribe()
        const notifications: string[] = []
        transport.subscribe(event => notifications.push(event.type))
        const snapshot = encodeSnapshot(RmDocument.empty('bbbbbbbb-0000-4000-a000-000000000002').serialize(), { shapes: [] })
        await transport.putSnapshot('doc', 'page', snapshot)
        await until(() => notifications.includes('page.changed'))
        notifications.length = 0
        const receiver = await OfflineSession.open(new MemoryStorage(), transport, 'doc', 'page', {
            clientId: 'receiver', authorUuid: 'aaaaaaaa-0000-4000-a000-000000000001',
            onPatch: () => {}, useOps: true, retryIntervalMs: 60 * 60 * 1_000,
        })
        sessions.push(receiver)
        await receiver.reconcile() // drain bootstrap before producing any edit
        const op = encodeOp({
            op: 'upsert-object', id: 'shape:remote', objType: 'geo', props: { label: 'hello' },
            transform: { x: 10, y: 20, rotation: 0 }, rendered: [],
            version: { ts: 1, actor: 'sender' },
        })
        // Wrong document and wrong page must not wake this session.
        let reads = 0
        const opsSince = transport.opsSince.bind(transport)
        transport.opsSince = async (...args) => { reads++; return opsSince(...args) }
        await transport.appendOps('other-doc', 'page', [op], 'sender')
        await transport.appendOps('doc', 'other-page', [op], 'sender')
        await until(() => notifications.length === 2)
        expect(reads).toBe(0)
        expect(receiver.currentOverlay.shapes).toHaveLength(0)

        // No snapshot publication, timer, or explicit reconcile can deliver this.
        await transport.appendOps('doc', 'page', [op], 'sender')
        await until(() => receiver.currentOverlay.shapes.length === 1)
        expect(receiver.currentOverlay.shapes[0]!.props).toEqual({ label: 'hello' })
        expect(notifications).toEqual(['ops.appended', 'ops.appended', 'ops.appended'])
        expect(reads).toBeGreaterThan(0)

        // Existing whole-page notifications still reach the same subscriber.
        await transport.putSnapshot('doc', 'page', snapshot)
        await until(() => notifications.includes('page.changed'))
    } finally {
        for (const session of sessions) session.dispose()
        transport.close()
        server.stop()
        if (previous === undefined) delete process.env.CLOUD_DEV_USER
        else process.env.CLOUD_DEV_USER = previous
    }
})
