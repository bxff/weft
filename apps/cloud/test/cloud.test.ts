/**
 * Cloud server tests: CAS semantics identical to rmsyncd, auth boundaries,
 * pairing, change feed, per-user isolation — and the full sync-engine
 * OfflineSession scenario running against the real server.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startCloud, type CloudServer } from '../src/server'
import { OfflineSession, MemoryStorage, EngineFailure } from '@weft/sync-engine'
import type { Transport, PageChangedEvent, DocumentInfo } from '@weft/sync-engine'
import type { OverlayDocument } from '@weft/sync-engine'
import { polylineToPoints } from '@weft/rm-ink/pure'

let server: CloudServer
let base: string

beforeAll(() => {
    process.env.CLOUD_DEV_USER = '1'
    server = startCloud({ port: 0 })
    base = `http://localhost:${server.port}`
})
afterAll(() => server.stop())

function authed(token: string) {
    return { authorization: `Bearer ${token}` }
}

describe('auth boundaries', () => {
    test('rejects anonymous and bad tokens', async () => {
        expect((await fetch(`${base}/api/documents`)).status).toBe(401)
        expect(
            (await fetch(`${base}/api/documents`, { headers: { authorization: 'Bearer junk' } }))
                .status,
        ).toBe(401)
    })
    test('health is public', async () => {
        expect((await fetch(`${base}/api/health`)).status).toBe(200)
    })
    test('?token= authenticates /ws only (browser WS path), never REST', async () => {
        // REST with a query token stays 401 (tokens must not ride logged URLs)
        expect((await fetch(`${base}/api/documents?token=dev:alice`)).status).toBe(401)

        // a header-free WS with ?token= connects and receives the user's events
        const ws = new WebSocket(
            `${base.replace('http', 'ws')}/ws?token=${encodeURIComponent('dev:wsuser')}`,
        )
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve()
            ws.onerror = () => reject(new Error('ws with valid query token failed'))
        })
        const event = new Promise<{ type: string }>((resolve) => {
            ws.onmessage = (e) => resolve(JSON.parse(String(e.data)) as { type: string })
        })
        await fetch(`${base}/api/documents`, {
            method: 'PUT',
            headers: { ...authed('dev:wsuser'), 'content-type': 'application/json' },
            body: '{"documents":[]}',
        })
        expect((await event).type).toBe('doc.list.changed')
        ws.close()

        // bad query token cannot upgrade
        const bad = new WebSocket(`${base.replace('http', 'ws')}/ws?token=junk`)
        const failed = await new Promise<boolean>((resolve) => {
            bad.onerror = () => resolve(true)
            bad.onopen = () => resolve(false)
        })
        expect(failed).toBe(true)
    })
})

describe('CAS + isolation', () => {
    test('rmsyncd-identical CAS: 404 -> create with empty base -> 409 on stale', async () => {
        const headers = { ...authed('dev:alice'), 'x-client-id': 'c1' }
        const url = `${base}/api/documents/d1/pages/p1/rm`
        expect((await fetch(url, { headers })).status).toBe(404)

        const bytes = new Uint8Array([1, 2, 3])
        const created = await fetch(url, {
            method: 'PUT',
            headers: { ...headers, 'x-base-revision': '' },
            body: bytes,
        })
        expect(created.status).toBe(200)
        const { revision } = (await created.json()) as { revision: string }

        // stale base
        const stale = await fetch(url, {
            method: 'PUT',
            headers: { ...headers, 'x-base-revision': 'wrong' },
            body: new Uint8Array([9]),
        })
        expect(stale.status).toBe(409)
        expect(((await stale.json()) as { currentRevision: string }).currentRevision).toBe(revision)

        // correct base
        const ok = await fetch(url, {
            method: 'PUT',
            headers: { ...headers, 'x-base-revision': revision },
            body: new Uint8Array([4, 5]),
        })
        expect(ok.status).toBe(200)
    })

    test('users are isolated', async () => {
        const url = `${base}/api/documents/d1/pages/p1/rm`
        expect((await fetch(url, { headers: authed('dev:bob') })).status).toBe(404)
    })

    test('pairing mints a device token bound to the user', async () => {
        const pair = await fetch(`${base}/api/pair`, {
            method: 'POST',
            headers: authed('dev:alice'),
            body: '{}',
        })
        const { token } = (await pair.json()) as { token: string }
        expect(token.startsWith('chd_')).toBe(true)
        // the device token reads alice's data
        const viaDevice = await fetch(`${base}/api/documents/d1/pages/p1/rm`, {
            headers: { 'x-device-token': token },
        })
        expect(viaDevice.status).toBe(200)
    })

    test('change feed advances per write', async () => {
        const first = (await (
            await fetch(`${base}/api/changes?since=0`, { headers: authed('dev:alice') })
        ).json()) as { changes: { seq: number }[] }
        expect(first.changes.length).toBeGreaterThan(0)
        const last = first.changes[first.changes.length - 1]!.seq
        const after = (await (
            await fetch(`${base}/api/changes?since=${last}`, { headers: authed('dev:alice') })
        ).json()) as { changes: unknown[] }
        expect(after.changes).toHaveLength(0)
    })
})

describe('body limits + JSON validation', () => {
    const h = (extra: Record<string, string> = {}) => ({
        ...authed('dev:limits'),
        'content-type': 'application/json',
        ...extra,
    })

    test('invalid JSON on overlay PUT is rejected (400)', async () => {
        const r = await fetch(`${base}/api/documents/d/pages/p/overlay`, {
            method: 'PUT',
            headers: h(),
            body: '{ not json',
        })
        expect(r.status).toBe(400)
    })

    test('invalid JSON on documents PUT is rejected (400)', async () => {
        const r = await fetch(`${base}/api/documents`, {
            method: 'PUT',
            headers: h(),
            body: 'definitely not json',
        })
        expect(r.status).toBe(400)
    })

    test('valid overlay JSON still accepted (200)', async () => {
        const r = await fetch(`${base}/api/documents/d/pages/p/overlay`, {
            method: 'PUT',
            headers: h(),
            body: '{"shapes":[]}',
        })
        expect(r.status).toBe(200)
    })

    // Last: the early header-based 413 leaves the oversized body undrained on
    // the socket (correct DoS behavior — we don't read 33MB to reject it), so
    // run it after the keep-alive-sensitive cases above.
    test('oversized .rm page is rejected (413)', async () => {
        const r = await fetch(`${base}/api/documents/d/pages/p/rm`, {
            method: 'PUT',
            headers: { ...authed('dev:limits'), 'x-base-revision': '', connection: 'close' },
            body: new Uint8Array(33 * 1024 * 1024), // > MAX_RM (32MB)
        })
        expect(r.status).toBe(413)
    })
})

describe('telemetry: opt-in failure reports, per-user isolated', () => {
    const post = (token: string, body: unknown) =>
        fetch(`${base}/api/telemetry/failures`, {
            method: 'POST',
            headers: { ...authed(token), 'content-type': 'application/json' },
            body: JSON.stringify(body),
        })

    test('requires auth', async () => {
        expect((await fetch(`${base}/api/telemetry/failures`, { method: 'POST', body: '{}' })).status).toBe(401)
    })

    test('stores a report and the user can read it back', async () => {
        const r = await post('dev:tele', {
            id: 'rep-1',
            kind: 'engine',
            tag: 'StaleRevision',
            message: 'rebase failed',
            appVersion: '0.1.0',
            source: 'web',
            docHash: 'h-doc',
            pageHash: 'h-page',
            context: { pendingOps: 3 },
            occurredAt: 1700000000000,
        })
        expect(r.status).toBe(200)
        const list = (await (
            await fetch(`${base}/api/telemetry/failures`, { headers: authed('dev:tele') })
        ).json()) as { reports: { id: string; tag: string }[] }
        expect(list.reports.some((x) => x.id === 'rep-1' && x.tag === 'StaleRevision')).toBe(true)
    })

    test('idempotent on id (a retry does not duplicate)', async () => {
        const body = { id: 'rep-dup', kind: 'codec', tag: 'ParseError', message: 'x', appVersion: '0.1.0' }
        await post('dev:tele2', body)
        await post('dev:tele2', body)
        const list = (await (
            await fetch(`${base}/api/telemetry/failures`, { headers: authed('dev:tele2') })
        ).json()) as { reports: { id: string }[] }
        expect(list.reports.filter((x) => x.id === 'rep-dup')).toHaveLength(1)
    })

    test('another user cannot read the first user reports (isolation)', async () => {
        const list = (await (
            await fetch(`${base}/api/telemetry/failures`, { headers: authed('dev:nosy') })
        ).json()) as { reports: unknown[] }
        expect(list.reports).toHaveLength(0)
    })

    test('rejects non-object body and clamps hostile fields', async () => {
        expect((await post('dev:tele', 'not-an-object')).status).toBe(400)
        // oversized message is clamped (stored, not rejected); no note content leaks through
        await post('dev:tele3', { id: 'rep-big', kind: 'engine', tag: 'T', message: 'A'.repeat(5000) })
        const list = (await (
            await fetch(`${base}/api/telemetry/failures`, { headers: authed('dev:tele3') })
        ).json()) as { reports: { id: string; message: string }[] }
        const stored = list.reports.find((x) => x.id === 'rep-big')!
        expect(stored.message.length).toBeLessThanOrEqual(500)
    })

    test('user can clear their own reports', async () => {
        await post('dev:tele4', { id: 'rep-c', kind: 'engine', tag: 'T', message: 'm' })
        const del = await fetch(`${base}/api/telemetry/failures`, {
            method: 'DELETE',
            headers: authed('dev:tele4'),
        })
        expect(del.status).toBe(200)
        const list = (await (
            await fetch(`${base}/api/telemetry/failures`, { headers: authed('dev:tele4') })
        ).json()) as { reports: unknown[] }
        expect(list.reports).toHaveLength(0)
    })
})

/** Transport over the cloud HTTP API (mirrors HttpTransport, test-local). */
function cloudTransport(token: string): Transport {
    const headers = { authorization: `Bearer ${token}` }
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, {
        // @ts-expect-error bun supports headers on client WS
        headers,
    })
    const handlers = new Set<(e: PageChangedEvent) => void>()
    ws.onmessage = (e) => {
        const event = JSON.parse(String(e.data)) as PageChangedEvent
        if (event.type === 'page.changed') for (const h of handlers) h(event)
    }
    return {
        async health() {
            return (await (await fetch(`${base}/api/health`)).json()) as never
        },
        async listDocuments() {
            const r = await fetch(`${base}/api/documents`, { headers })
            return ((await r.json()) as { documents: DocumentInfo[] }).documents
        },
        async getPage(doc, page) {
            const r = await fetch(`${base}/api/documents/${doc}/pages/${page}/rm`, { headers })
            if (r.status === 404) return null
            return {
                bytes: new Uint8Array(await r.arrayBuffer()),
                revision: r.headers.get('x-rm-revision') ?? '',
            }
        },
        async putPage(doc, page, baseRev, bytes, clientId) {
            const r = await fetch(`${base}/api/documents/${doc}/pages/${page}/rm`, {
                method: 'PUT',
                headers: { ...headers, 'x-base-revision': baseRev, 'x-client-id': clientId },
                body: bytes as unknown as BodyInit,
            })
            if (r.status === 409) {
                const body = (await r.json()) as { currentRevision: string }
                throw new EngineFailure({ _tag: 'StaleRevision', currentRevision: body.currentRevision })
            }
            return (await r.json()) as { revision: string }
        },
        async getOverlay(doc, page) {
            const r = await fetch(`${base}/api/documents/${doc}/pages/${page}/overlay`, { headers })
            return (await r.json()) as OverlayDocument
        },
        async putAsset(doc: string, page: string, filename: string, bytes: Uint8Array) {
            await fetch(`${base}/api/documents/${doc}/pages/${page}/assets/${filename}`, {
                method: 'PUT',
                headers,
                body: bytes,
            })
        },
        async putOverlay(doc, page, overlay) {
            await fetch(`${base}/api/documents/${doc}/pages/${page}/overlay`, {
                method: 'PUT',
                headers,
                body: JSON.stringify(overlay),
            })
        },
        // op channel (the sole sync path since the blob-CAS kill-switch was
        // removed): the OfflineSession reconciles via appendOps/opsSince +
        // snapshots, so this end-to-end transport must speak it.
        async appendOps(doc, page, ops, author) {
            const r = await fetch(`${base}/api/documents/${doc}/pages/${page}/ops`, {
                method: 'POST',
                headers: { ...headers, 'content-type': 'application/json' },
                body: JSON.stringify({
                    ops: ops.map((o) => Buffer.from(o).toString('base64')),
                    author,
                }),
            })
            return (await r.json()) as { firstSeq: number; lastSeq: number }
        },
        async opsSince(doc, page, sinceSeq) {
            const r = await fetch(
                `${base}/api/documents/${doc}/pages/${page}/ops?since=${sinceSeq}`,
                { headers },
            )
            const body = (await r.json()) as {
                ops: { seq: number; op: string; author: string | null; ts: number }[]
            }
            return body.ops.map((o) => ({
                seq: o.seq,
                op: new Uint8Array(Buffer.from(o.op, 'base64')),
                author: o.author,
                ts: o.ts,
            }))
        },
        async getSnapshot(doc, page) {
            const r = await fetch(`${base}/api/documents/${doc}/pages/${page}/snapshot`, { headers })
            if (r.status === 204) return null
            return {
                seq: Number(r.headers.get('x-snapshot-seq') ?? 0),
                opSeq: Number(r.headers.get('x-snapshot-op-seq') ?? 0),
                bytes: new Uint8Array(await r.arrayBuffer()),
            }
        },
        async putSnapshot(doc, page, bytes) {
            const r = await fetch(`${base}/api/documents/${doc}/pages/${page}/snapshot`, {
                method: 'PUT',
                headers: { ...headers, 'content-type': 'application/octet-stream' },
                body: bytes as unknown as BodyInit,
            })
            return (await r.json()) as { seq: number }
        },
        subscribe(handler) {
            handlers.add(handler)
            return () => handlers.delete(handler)
        },
    }
}

describe('full engine against the cloud', () => {
    test('OfflineSession edits sync through the cloud and to a second client', async () => {
        const t1 = cloudTransport('dev:carol')
        const storage = new MemoryStorage()
        const session = await OfflineSession.open(storage, t1, 'cdoc', 'cpage', {
            clientId: 'web-1',
            authorUuid: 'c8050a7c-0000-4000-a000-000000000001',
            onPatch: () => {},
            retryIntervalMs: 60_000,
        })
        await session.apply([
            {
                type: 'upsert-shape',
                shape: {
                    shapeId: 'shape:C1',
                    kind: 'draw-native',
                    props: {},
                    x: 0,
                    y: 0,
                    rotation: 0,
                    renderRevision: 'r1',
                    version: { ts: 1, actor: 'test' },
                },
                parts: [
                    {
                        partKey: 'whole',
                        strokes: [
                            {
                                points: polylineToPoints(
                                    [
                                        { x: 10, y: 10 },
                                        { x: 60, y: 60 },
                                    ],
                                    { width: 40 },
                                ),
                                color: 'black',
                            },
                        ],
                    },
                ],
            },
        ])
        await session.reconcile()
        expect(session.pendingCount).toBe(0)

        // second client sees the shape via the cloud
        const t2 = cloudTransport('dev:carol')
        const session2 = await OfflineSession.open(new MemoryStorage(), t2, 'cdoc', 'cpage', {
            clientId: 'web-2',
            authorUuid: 'c8050a7c-0000-4000-a000-000000000001',
            onPatch: () => {},
            retryIntervalMs: 60_000,
        })
        // op-mode bootstrap+pull runs in the background on open; await a
        // reconcile so the foreign shape is deterministically present.
        await session2.reconcile()
        expect(session2.currentOverlay.shapes.map((s) => s.shapeId)).toEqual(['shape:C1'])
        session.dispose()
        session2.dispose()
    })
})

describe('API keys: per-user, sign-in-gated, isolated', () => {
    test('mint -> use on own notes -> cannot manage with the key -> revoke', async () => {
        // alice has a page already (from earlier tests in this file)
        const mint = await fetch(`${base}/api/keys`, {
            method: 'POST',
            headers: { ...authed('dev:alice'), 'content-type': 'application/json' },
            body: JSON.stringify({ label: 'my app' }),
        })
        expect(mint.status).toBe(200)
        const { id, key } = (await mint.json()) as { id: string; key: string }
        expect(key.startsWith('chk_')).toBe(true)

        // the key reads alice's documents (x-api-key)
        const viaKey = await fetch(`${base}/api/documents`, { headers: { 'x-api-key': key } })
        expect(viaKey.status).toBe(200)
        // and via Bearer chk_
        const viaBearer = await fetch(`${base}/api/documents`, {
            headers: { authorization: `Bearer ${key}` },
        })
        expect(viaBearer.status).toBe(200)

        // the key CANNOT read another user's data (isolation): bob has none
        const bobKeyMint = await fetch(`${base}/api/keys`, {
            method: 'POST',
            headers: { ...authed('dev:bob'), 'content-type': 'application/json' },
            body: '{}',
        })
        const bobKey = ((await bobKeyMint.json()) as { key: string }).key
        const bobSeesNothing = await fetch(`${base}/api/documents/d1/pages/p1/rm`, {
            headers: { 'x-api-key': bobKey },
        })
        expect(bobSeesNothing.status).toBe(404) // d1/p1 is alice's

        // an API key cannot manage keys (containment)
        expect((await fetch(`${base}/api/keys`, { headers: { 'x-api-key': key } })).status).toBe(403)

        // list shows the key without the secret
        const list = (await (
            await fetch(`${base}/api/keys`, { headers: authed('dev:alice') })
        ).json()) as { keys: { id: string; preview: string }[] }
        expect(list.keys.some((k) => k.id === id && !k.preview.includes(key.slice(12, 20)))).toBe(true)

        // revoke -> the key stops working
        const del = await fetch(`${base}/api/keys/${id}`, {
            method: 'DELETE',
            headers: authed('dev:alice'),
        })
        expect(del.status).toBe(200)
        expect((await fetch(`${base}/api/documents`, { headers: { 'x-api-key': key } })).status).toBe(401)

        // alice cannot revoke bob's key (cross-user)
        const bobId = ((await (await fetch(`${base}/api/keys`, { headers: authed('dev:bob') })).json()) as { keys: { id: string }[] }).keys[0]!.id
        const crossDel = await fetch(`${base}/api/keys/${bobId}`, {
            method: 'DELETE',
            headers: authed('dev:alice'),
        })
        expect(crossDel.status).toBe(404) // not found in alice's namespace
    })
})

test("#63 pruneChanges drops old rows, keeps the window + the ETag validator", () => {
  const { CloudStore } = require("../src/store") as typeof import("../src/store");
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const s = new CloudStore(join(mkdtempSync(join(tmpdir(), "weft-prune-")), "t.db"));
  const U = "prune-user";
  // three change rows; backdate the first two beyond retention
  s.putPage(U, "d", "p1", "", new Uint8Array([1]), "web");
  s.putPage(U, "d", "p2", "", new Uint8Array([2]), "web");
  s.putPage(U, "d", "p3", "", new Uint8Array([3]), "web");
  const head = s.latestChangeSeq(U);
  (s as unknown as { db: { run: (q: string, a: unknown[]) => void } }).db.run(
    "UPDATE changes SET created_at = ? WHERE user_id=? AND seq < ?",
    [Date.now() - 90 * 24 * 60 * 60_000, U, head],
  );
  const removed = s.pruneChanges(30 * 24 * 60 * 60_000);
  expect(removed).toBe(2);
  // the newest row survives: the sweep validator and the feed head are intact
  expect(s.latestChangeSeq(U)).toBe(head);
  expect(s.changesSince(U, 0).map((c) => c.seq)).toEqual([head]);
});
