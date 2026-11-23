import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RmDocument } from '@weft/rm-format'
import { encodeOp } from '@weft/sync-engine'
import { startCloud } from '../src/server'

const USER = 'op-publisher'
const DOC = 'doc'
const PAGE = 'page'
const KEY = [USER, DOC, PAGE] as const
const op = encodeOp({ op: 'delete-object', id: 'shape:gone', version: { ts: 1, actor: 'web' } })
const encoded = Buffer.from(op).toString('base64')
const body = JSON.stringify({ ops: [encoded, encoded], author: 'Web editor' })

function relay() {
    const dir = mkdtempSync(join(tmpdir(), 'weft-op-batch-'))
    const dbPath = join(dir, 'relay.sqlite')
    process.env.CLOUD_DEV_USER = '1'
    let server = startCloud({ port: 0, db: dbPath })
    return {
        get store() { return server.store },
        restart() {
            server.stop()
            server = startCloud({ port: 0, db: dbPath })
        },
        inspect() { return new Database(dbPath) },
        request(endpoint: string, wireBody: string, id?: string, [user, doc, page]: readonly string[] = KEY) {
            return fetch(`http://localhost:${server.port}/api/documents/${doc}/pages/${page}/${endpoint}`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer dev:${user}`,
                    'content-type': 'application/json',
                    ...(id ? { 'x-op-batch-id': id } : {}),
                },
                body: wireBody,
            })
        },
        close() {
            server.stop()
            rmSync(dir, { recursive: true, force: true })
        },
    }
}

test('guarded op receipts deduplicate concurrent requests and survive compaction and restart', async () => {
    const cloud = relay()
    const id = crypto.randomUUID()
    const publish = (data = body) => cloud.request('ops-batch', data, id)
    try {
        const responses = await Promise.all(Array.from({ length: 6 }, () => publish()))
        expect(responses.map(({ status }) => status)).toEqual(Array(6).fill(200))
        const receipts = await Promise.all(responses.map((response) => response.json()))
        expect(receipts).toEqual(Array(6).fill({ firstSeq: 1, lastSeq: 2 }))
        expect(cloud.store.latestSnapshot(...KEY)).toBeNull()
        expect(cloud.store.opsSince(...KEY, 0).map(({ author }) => author)).toEqual(['Web editor', 'Web editor'])
        expect(cloud.store.changesSince(USER, 0)).toHaveLength(1)

        // Raw /ops retains the original unguarded behavior, even with the new header.
        for (let i = 0; i < 2; i++) expect((await cloud.request('ops', body, id)).status).toBe(200)
        const clear = await cloud.request('clear-history', '')
        expect(clear.status).toBe(200)
        expect(cloud.store.truncationFloor(...KEY)).toBeGreaterThan(2)
        expect(cloud.store.opsSince(...KEY, 0).map(({ seq }) => seq)).toEqual([6])
        cloud.restart()

        const lastSeq = cloud.store.latestOpSeq(...KEY)
        const changes = cloud.store.changesSince(USER, 0)
        const usage = cloud.store.usageBytes(USER, 'created')
        cloud.store.setUserQuota(USER, 'created', usage)
        const retry = await publish()
        expect(retry.status).toBe(200)
        expect(await retry.json()).toEqual(receipts[0]!)
        for (const changed of [body + ' ', body.replace('Web editor', 'another editor'), 'not json']) {
            const conflict = await publish(changed)
            expect(conflict.status).toBe(409)
            expect(await conflict.json()).toMatchObject({ reason: 'batch-id-reused' })
        }
        expect((await cloud.request('ops-batch', body, crypto.randomUUID())).status).toBe(507)
        expect(cloud.store.latestOpSeq(...KEY)).toBe(lastSeq)
        expect(cloud.store.changesSince(USER, 0)).toEqual(changes)
        expect(cloud.store.usageBytes(USER, 'created')).toBe(usage)
    } finally {
        cloud.close()
    }
})

test('op batch IDs are scoped to the authenticated user, document, and page', async () => {
    const cloud = relay()
    const id = crypto.randomUUID()
    try {
        expect((await cloud.request('ops-batch', body, id)).status).toBe(200)
        const elsewhere = [
            ['another-user', DOC, PAGE],
            [USER, 'another-doc', PAGE],
            [USER, DOC, 'another-page'],
        ] as const
        for (const scope of elsewhere) {
            expect((await cloud.request('ops-batch', body.replace('Web editor', 'another editor'), id, scope)).status).toBe(200)
            expect(cloud.store.opsSince(...scope, 0).map(({ author }) => author)).toEqual(['another editor', 'another editor'])
        }
        expect(cloud.store.opsSince(...KEY, 0).map(({ author }) => author)).toEqual(['Web editor', 'Web editor'])
    } finally {
        cloud.close()
    }
})

test('op batch receipts expire only when the entire page stream is removed', async () => {
    const cloud = relay()
    const id = crypto.randomUUID()
    const inspect = cloud.inspect()
    const receipts = () => inspect.query('SELECT batch_id FROM page_op_batch_receipts').all()
    try {
        for (const first of ['page_ops', 'page_snapshots'] as const) {
            expect((await cloud.request('ops-batch', body, id)).status).toBe(200)
            cloud.store.compact(...KEY)
            expect(receipts()).toEqual([{ batch_id: id }])
            inspect.run(`DELETE FROM ${first} WHERE user_id=? AND doc=? AND page=?`, KEY)
            expect(receipts()).toEqual([{ batch_id: id }])
            const last = first === 'page_ops' ? 'page_snapshots' : 'page_ops'
            inspect.run(`DELETE FROM ${last} WHERE user_id=? AND doc=? AND page=?`, KEY)
            expect(receipts()).toEqual([])
        }
    } finally {
        inspect.close()
        cloud.close()
    }
})

test('invalid or oversized guarded op requests create no receipts or page state', async () => {
    const cloud = relay()
    const id = crypto.randomUUID()
    const inspect = cloud.inspect()
    try {
        expect((await cloud.request('ops-batch', body)).status).toBe(400)
        expect((await cloud.request('ops-batch', body, 'invalid')).status).toBe(400)
        for (const invalid of [
            'null',
            JSON.stringify({ author: 42, ops: [encoded] }),
            JSON.stringify({ author: null, ops: [] }),
            JSON.stringify({ author: null, ops: [42] }),
            JSON.stringify({ author: null, ops: ['invalid!'] }),
            JSON.stringify({ author: null, ops: Array(1001).fill(encoded) }),
        ]) expect((await cloud.request('ops-batch', invalid, id)).status).toBe(400)
        expect((await cloud.request('ops-batch', ' '.repeat(32 * 1024 * 1024 + 1), id)).status).toBe(413)
        expect(inspect.query('SELECT * FROM page_op_batch_receipts').all()).toEqual([])
        expect(cloud.store.opsSince(...KEY, 0)).toEqual([])
        expect(cloud.store.latestSnapshot(...KEY)).toBeNull()
        expect(cloud.store.changesSince(USER, 0)).toEqual([])
        expect(cloud.store.usageBytes(USER, 'created')).toBe(0)
    } finally {
        inspect.close()
        cloud.close()
    }
})

test('quota refusal and receipt failure roll back a guarded append and any lazy base seed', async () => {
    const cloud = relay()
    const inspect = cloud.inspect()
    const id = crypto.randomUUID()
    try {
        const stored = cloud.store.putPage(...KEY, '', RmDocument.empty(id).serialize(), 'setup')
        expect('conflict' in stored).toBe(false)
        const before = {
            usage: cloud.store.usageBytes(USER, 'created'),
            changes: cloud.store.changesSince(USER, 0),
        }
        const assertUnchanged = () => {
            expect(cloud.store.latestOpSeq(...KEY)).toBe(0)
            expect(cloud.store.latestSnapshot(...KEY)).toBeNull()
            expect(cloud.store.usageBytes(USER, 'created')).toBe(before.usage)
            expect(cloud.store.changesSince(USER, 0)).toEqual(before.changes)
            expect(inspect.query('SELECT * FROM page_op_batch_receipts').all()).toEqual([])
        }

        // The legacy bytes and ops alone fit. The migration snapshot makes the write exceed quota.
        cloud.store.setUserQuota(USER, 'created', before.usage + 2 * op.length)
        expect((await cloud.request('ops-batch', body, id)).status).toBe(507)
        assertUnchanged()
        cloud.store.setUserQuota(USER, 'created', null)

        inspect.run(`CREATE TRIGGER reject_op_receipt BEFORE INSERT ON page_op_batch_receipts BEGIN
            SELECT RAISE(ABORT, 'injected receipt failure'); END`)
        expect((await cloud.request('ops-batch', body, id)).status).toBe(500)
        assertUnchanged()
        inspect.run('DROP TRIGGER reject_op_receipt')
        expect((await cloud.request('ops-batch', body, id)).status).toBe(200)
        expect(cloud.store.opsSince(...KEY, 0)).toHaveLength(2)
        expect(cloud.store.changesSince(USER, 0)).toHaveLength(before.changes.length + 1)
    } finally {
        inspect.close()
        cloud.close()
    }
})
