/**
 * #45 step 3: op + snapshot HTTP wire, end-to-end through HttpTransport against
 * the real cloud relay. Ops/snapshots travel as opaque blobs (base64 in JSON
 * for ops; octet-stream for snapshots).
 */

import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { startCloud, type CloudServer } from '../src/server'
import { HttpTransport } from '@weft/sync-engine'

const DOC = '55555555-5555-4555-a555-555555555555'
const PAGE = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee'
const op = (s: string) => new TextEncoder().encode(s)

let server: CloudServer
let t: HttpTransport

beforeAll(() => {
    process.env.CLOUD_DEV_USER = '1'
    server = startCloud({ port: 0 })
    t = new HttpTransport({ baseUrl: `http://localhost:${server.port}`, getAuthToken: () => 'dev:wireuser' })
})
afterAll(() => {
    t.close()
    server.stop()
})

test('append + stream ops over HTTP, with a resumable head cursor', async () => {
    const r1 = await t.appendOps!(DOC, PAGE, [op('a'), op('b')], 'authorA')
    expect(r1.lastSeq).toBeGreaterThanOrEqual(r1.firstSeq)
    const r2 = await t.appendOps!(DOC, PAGE, [op('c')], 'authorA')
    expect(r2.firstSeq).toBeGreaterThan(r1.lastSeq)

    const all = await t.opsSince!(DOC, PAGE, 0)
    expect(all.map((o) => new TextDecoder().decode(o.op))).toEqual(['a', 'b', 'c'])
    expect(all[0]!.author).toBe('authorA')
    expect(all.map((o) => o.seq)).toEqual([...all.map((o) => o.seq)].sort((x, y) => x - y))

    // resume: nothing past the last seq
    expect(await t.opsSince!(DOC, PAGE, r2.lastSeq)).toEqual([])
})

test('snapshot round-trips over HTTP; absent snapshot is null', async () => {
    expect(await t.getSnapshot!(DOC, 'no-such-page')).toBeNull()

    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255])
    const { seq } = await t.putSnapshot!(DOC, PAGE, bytes)
    expect(seq).toBeGreaterThan(0)
    const got = await t.getSnapshot!(DOC, PAGE)
    expect(got).toBeTruthy()
    expect(got!.seq).toBe(seq)
    expect([...got!.bytes]).toEqual([...bytes])
})

test('conditional snapshot GET: not-newer is a bodiless 304, newer ships bytes', async () => {
    const condDoc = 'a3333333-0000-4000-a000-000000000003'
    const bytes = new Uint8Array([1, 2, 3])
    const { seq } = await t.putSnapshot!(condDoc, PAGE, bytes)
    // the steady-state pull: client already holds seq -> null, no bytes
    expect(await t.getSnapshot!(condDoc, PAGE, seq)).toBeNull()
    // stale client cursor -> full bytes
    const got = await t.getSnapshot!(condDoc, PAGE, seq - 1)
    expect(got!.seq).toBe(seq)
    expect([...got!.bytes]).toEqual([...bytes])
    // a newer publish out-seqs the condition again
    const { seq: seq2 } = await t.putSnapshot!(condDoc, PAGE, new Uint8Array([9, 9]))
    const newer = await t.getSnapshot!(condDoc, PAGE, seq)
    expect(newer!.seq).toBe(seq2)
})

test('snapshot 304 skips the blob read and keeps the checkpoint cursor', async () => {
    const doc = 'a4444444-0000-4000-a000-000000000004'
    const user = 'wireuser'
    const opSeq = (await t.appendOps!(doc, PAGE, [op('checkpoint')], null)).lastSeq
    const bytes = new Uint8Array([0, 42, 255])
    const seq = server.store.putSnapshot(user, doc, PAGE, bytes, true, opSeq)
    await t.appendOps!(doc, PAGE, [op('after checkpoint')], null)

    const url = `http://localhost:${server.port}/api/documents/${doc}/pages/${PAGE}/snapshot`
    const get = (cursor: number) => fetch(url, {
        headers: { authorization: `Bearer dev:${user}`, 'x-if-snapshot-seq-gt': String(cursor) },
    })
    const readFile = spyOn(fs, 'readFileSync')
    try {
        const unchanged = await get(seq)
        expect(unchanged.status).toBe(304)
        expect((await unchanged.arrayBuffer()).byteLength).toBe(0)
        expect(unchanged.headers.get('x-snapshot-seq')).toBe(String(seq))
        expect(unchanged.headers.get('x-snapshot-op-seq')).toBe(String(opSeq))
        expect(unchanged.headers.get('x-snapshot-revert')).toBe('1')
        expect(readFile).not.toHaveBeenCalled()

        const changed = await get(seq - 1)
        expect(changed.status).toBe(200)
        expect(changed.headers.get('content-type')).toBe('application/octet-stream')
        expect(changed.headers.get('x-snapshot-seq')).toBe(String(seq))
        expect(changed.headers.get('x-snapshot-op-seq')).toBe(String(opSeq))
        expect(changed.headers.get('x-snapshot-revert')).toBe('1')
        expect(new Uint8Array(await changed.arrayBuffer())).toEqual(bytes)
        expect(readFile).toHaveBeenCalledTimes(1)
    } finally {
        readFile.mockRestore()
    }
})

test('the snapshot op-seq cursor survives the wire (x-snapshot-op-seq)', async () => {
    const snapDoc = 'a2222222-0000-4000-a000-000000000002'
    await t.appendOps!(snapDoc, PAGE, [op('x'), op('y')], 'a')
    const head = (await t.opsSince!(snapDoc, PAGE, 0)).at(-1)!.seq
    await t.putSnapshot!(snapDoc, PAGE, new Uint8Array([9]))
    const got = await t.getSnapshot!(snapDoc, PAGE)
    expect(got!.opSeq).toBe(head) // reconstruct = these bytes + opsSince(opSeq)
})

test('binary op bytes (all byte values) survive the base64 wire intact', async () => {
    const binDoc = 'b1111111-0000-4000-a000-000000000001'
    const binary = new Uint8Array(256)
    for (let i = 0; i < 256; i++) binary[i] = i
    await t.appendOps!(binDoc, PAGE, [binary], 'a')
    const got = await t.opsSince!(binDoc, PAGE, 0)
    expect(got.length).toBe(1)
    expect([...got[0]!.op]).toEqual([...binary])
})

test('a malformed ops POST is rejected with 400', async () => {
    const base = `http://localhost:${server.port}`
    const auth = { authorization: 'Bearer dev:wireuser', 'content-type': 'application/json' }
    const notArray = await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/ops`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ ops: 'nope' }),
    })
    expect(notArray.status).toBe(400)
    const nonString = await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/ops`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ ops: [123] }),
    })
    expect(nonString.status).toBe(400)
})

test('ops are per-user isolated (a different bearer sees nothing)', async () => {
    await t.appendOps!(DOC, PAGE, [op('mine')], null)
    const other = new HttpTransport({
        baseUrl: `http://localhost:${server.port}`,
        getAuthToken: () => 'dev:otheruser',
    })
    try {
        expect(await other.opsSince!(DOC, PAGE, 0)).toEqual([])
    } finally {
        other.close()
    }
})

test('a snapshot PUT lands in the change feed (the daemon pulls text edits)', async () => {
    // A text-only web edit produces ZERO ops (snapshot fallback). Without a
    // change row the daemon never pulls it and web text edits silently never
    // reach the tablet (owner-reported on weft-cal23).
    const D2 = '66666666-6666-4666-a666-666666666666'
    const P2 = 'ffffffff-ffff-4fff-afff-ffffffffffff'
    const before = await fetch(`http://localhost:${server.port}/api/changes?since=0`, {
        headers: { authorization: 'Bearer dev:wireuser' },
    }).then((r) => r.json() as Promise<{ changes: { doc: string; originClientId: string | null }[] }>)
    await t.putSnapshot!(D2, P2, new TextEncoder().encode('snapbytes'))
    const after = await fetch(`http://localhost:${server.port}/api/changes?since=0`, {
        headers: { authorization: 'Bearer dev:wireuser' },
    }).then((r) => r.json() as Promise<{ changes: { doc: string; originClientId: string | null }[] }>)
    const fresh = after.changes.filter((c) => c.doc === D2)
    expect(fresh.length).toBeGreaterThan(before.changes.filter((c) => c.doc === D2).length)
    // origin must NOT be the daemon's own id, or it would skip the pull
    expect(fresh.at(-1)!.originClientId).not.toBe('rmsyncd')
})
