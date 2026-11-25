/**
 * Two-class quota (STORAGE-PLAN §1): per-user per-CLASS usage counters
 * (maintained by triggers) + enforcement. Store-level tests prove the
 * counters and class routing; server-level tests prove the class-tagged 507
 * + /api/usage.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRootText, insertText, Pen, PenColor, RmDocument } from '@weft/rm-format'
import { encodeSnapshot, type OverlayDocument } from '@weft/sync-engine'
import { CloudStore, SNAPSHOT_KEEP } from '../src/store'
import { startCloud, type CloudServer } from '../src/server'

const auth = { authorization: 'Bearer dev:quota-user' }

test('usage counters route each table to its class and track overwrites', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-q-'))
    const dbPath = join(dir, 'q.db')
    const store = new CloudStore(dbPath)
    expect(store.usageBytes('u', 'created')).toBe(0)
    expect(store.usageBytes('u', 'sources')).toBe(0)

    // page blob -> created; source file -> sources
    store.putPage('u', 'd', 'p', '', new Uint8Array(100), 'c')
    expect(store.usageBytes('u', 'created')).toBe(100)
    expect(store.usageBytes('u', 'sources')).toBe(0)

    store.putFile('u', 'd', new Uint8Array(50), 'application/pdf')
    expect(store.usageBytes('u', 'sources')).toBe(50)
    expect(store.usageBytes('u', 'created')).toBe(100)
    expect(store.usageTotal('u')).toBe(150)

    // overwrite the page (INSERT OR REPLACE = DELETE+INSERT): net delta only
    store.putPage('u', 'd', 'p', store.getPage('u', 'd', 'p')!.revision, new Uint8Array(40), 'c')
    expect(store.usageBytes('u', 'created')).toBe(40)

    // isolation: another user is independent
    store.putPage('v', 'd', 'p', '', new Uint8Array(10), 'c')
    expect(store.usageBytes('v', 'created')).toBe(10)
    expect(store.usageBytes('u', 'created')).toBe(40)
})

test('per-class overrides set/clear independently', () => {
    const store = new CloudStore()
    expect(store.userQuotaOverride('u', 'sources')).toBe(null)
    store.setUserQuota('u', 'sources', 42)
    expect(store.userQuotaOverride('u', 'sources')).toBe(42)
    expect(store.userQuotaOverride('u', 'created')).toBe(null)
    store.setUserQuota('u', 'created', 0) // 0 = explicitly unlimited
    expect(store.userQuotaOverride('u', 'created')).toBe(0)
    store.setUserQuota('u', 'sources', null)
    expect(store.userQuotaOverride('u', 'sources')).toBe(null)
    expect(store.userQuotaOverride('u', 'created')).toBe(0)
})

// --- server enforcement ---

let server: CloudServer
let base: string
beforeAll(() => {
    process.env.CLOUD_DEV_USER = '1'
    process.env.WEFT_QUOTA_SOURCES_BYTES = '1000'
    process.env.WEFT_QUOTA_CREATED_BYTES = '2000'
    server = startCloud({ port: 0 })
    base = `http://localhost:${server.port}`
})
afterAll(() => {
    server.stop()
    delete process.env.WEFT_QUOTA_SOURCES_BYTES
    delete process.env.WEFT_QUOTA_CREATED_BYTES
})

test('GET /api/usage reports both classes', async () => {
    const r = await fetch(`${base}/api/usage`, { headers: auth })
    expect(r.status).toBe(200)
    const u = (await r.json()) as {
        created: { bytes: number; limit: number }
        sources: { bytes: number; limit: number }
    }
    expect(u.created.limit).toBe(2000)
    expect(u.sources.limit).toBe(1000)
    expect(u.created.bytes).toBe(0)
    expect(u.sources.bytes).toBe(0)
})

test('a source over the sources quota is 507 class=sources; created is untouched', async () => {
    const put = (docId: string, n: number) =>
        fetch(`${base}/api/documents/${docId}/file`, {
            method: 'PUT',
            headers: { ...auth, 'content-type': 'application/pdf' },
            body: new Uint8Array(n) as unknown as BodyInit,
        })

    // 900 < 1000 -> ok
    expect((await put('d1', 900)).status).toBe(200)
    // re-importing the SAME doc REPLACES (nets new-old), so d1 at 900 again is
    // still 900 usage -> stays 200 (a full re-import must not double-count, #81).
    expect((await put('d1', 900)).status).toBe(200)
    // a DIFFERENT doc pushing 900 -> 1800 > 1000, and neither has a lastOpened
    // (never in the doc list) so nothing is evictable -> 507 tagged sources.
    const over = await put('d2', 900)
    expect(over.status).toBe(507)
    const body = (await over.json()) as {
        error: string
        class: string
        limit: number
    }
    expect(body.error).toContain('quota')
    expect(body.class).toBe('sources')
    expect(body.limit).toBe(1000)

    // a full sources budget must NOT block created writes (notes always sync)
    const page = await fetch(`${base}/api/documents/d1/pages/p1/rm`, {
        method: 'PUT',
        headers: { ...auth, 'x-base-revision': '', 'x-client-id': 'test' },
        body: new Uint8Array(500) as unknown as BodyInit,
    })
    expect(page.status).toBe(200)

    const u = (await (await fetch(`${base}/api/usage`, { headers: auth })).json()) as {
        created: { bytes: number }
        sources: { bytes: number }
    }
    expect(u.sources.bytes).toBe(900)
    expect(u.created.bytes).toBeGreaterThanOrEqual(500)
})

test('web opens record + surface via /api/last-opened (monotonic)', async () => {
    const open = (doc: string, page: string) =>
        fetch(`${base}/api/documents/${doc}/open`, {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ page }),
        })
    expect((await open('doc-a', 'page-1')).status).toBe(200)
    expect((await open('doc-a', 'page-2')).status).toBe(200)

    const r = await fetch(`${base}/api/last-opened`, { headers: auth })
    const body = (await r.json()) as {
        docs: Record<string, { page: string; at: number }>
    }
    expect(body.docs['doc-a']!.page).toBe('page-2')
    expect(body.docs['doc-a']!.at).toBeGreaterThan(0)

    // bad body -> 400, nothing recorded
    const bad = await fetch(`${base}/api/documents/doc-b/open`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({}),
    })
    expect(bad.status).toBe(400)
    const after = (await (
        await fetch(`${base}/api/last-opened`, { headers: auth })
    ).json()) as { docs: Record<string, unknown> }
    expect(after.docs['doc-b']).toBeUndefined()
})

test('tablet PUT charges retained data and rolls a quota refusal back', async () => {
    const user = 'tablet-retained-quota'
    const store = server.store
    const author = 'aaaaaaaa-0000-4000-8000-000000000001'
    const peer = 'bbbbbbbb-0000-4000-8000-000000000002'
    const overlay: OverlayDocument = { shapes: [] }
    const empty = RmDocument.empty(author)
    store.putSnapshot(user, 'd', 'p', encodeSnapshot(empty.serialize(), overlay))
    const tabletBase = store.reconstructDevicePage(user, 'd', 'p').revision
    const drawing = RmDocument.parse(empty.serialize())
    for (let x = 1; x < 40; x++) {
        drawing.appendLine({
            kind: 'line', tool: Pen.BALLPOINT_2, color: PenColor.BLACK,
            thicknessScale: 2, startingLength: 0, timestamp: { part1: 0, part2: 1 }, moveId: null,
            points: [
                { x, y: 0, speed: 0, direction: 0, width: 1, pressure: 1 },
                { x, y: 1, speed: 0, direction: 0, width: 1, pressure: 1 },
            ],
        }, { authorUuid: peer })
    }
    drawing.normalizeLayout()
    const original = encodeSnapshot(drawing.serialize(), overlay)
    const originalSeq = store.putSnapshot(user, 'd', 'p', original)
    const prior = store.reconstructDevicePage(user, 'd', 'p')
    const priorUsage = store.usageBytes(user, 'created')
    const priorChanges = store.changesSince(user, 0)
    const native = RmDocument.parse(empty.serialize())
    createRootText(native)
    insertText(native, null, 'New text', { authorUuid: author })
    const nativeBytes = native.serialize()
    const token = store.mintDeviceToken(user, 'tablet')
    const put = (body: Uint8Array, revision: string) => fetch(base + '/api/documents/d/pages/p/rm', {
        method: 'PUT',
        headers: { 'x-device-token': token, 'x-base-revision': revision, 'x-client-id': 'rmsyncd' },
        body: body as unknown as BodyInit,
    })

    store.setUserQuota(user, 'created', priorUsage + 2 * nativeBytes.length)
    const rejected = await put(nativeBytes, tabletBase)
    expect(rejected.status).toBe(507)
    expect(await rejected.json()).toMatchObject({ class: 'created', usage: priorUsage })
    expect(store.usageBytes(user, 'created')).toBe(priorUsage)
    expect(store.reconstructDevicePage(user, 'd', 'p')).toEqual(prior)
    expect(store.getSnapshotBytes(user, 'd', 'p', originalSeq)).toEqual(original)
    expect(store.changesSince(user, 0)).toEqual(priorChanges)

    store.setUserQuota(user, 'created', 0)
    expect((await put(nativeBytes, tabletBase)).status).toBe(200)
    expect(store.usageBytes(user, 'created')).toBeGreaterThan(priorUsage + 2 * nativeBytes.length)
    const accepted = store.reconstructDevicePage(user, 'd', 'p')
    const usage = store.usageBytes(user, 'created')
    store.setUserQuota(user, 'created', usage)
    expect((await put(accepted.bytes, accepted.revision)).status).toBe(200)
    expect(store.usageBytes(user, 'created')).toBe(usage)
})

test('tablet PUT can publish at quota when its checkpoint retires a larger one', async () => {
    const user = 'tablet-checkpoint-refund'
    const store = server.store
    const author = 'aaaaaaaa-0000-4000-8000-000000000001'
    const old = RmDocument.empty(author)
    createRootText(old)
    insertText(old, null, 'Old text '.repeat(1000), { authorUuid: author })
    const retired = store.putSnapshot(user, 'd', 'p', encodeSnapshot(old.serialize(), { shapes: [] }))
    const fresh = RmDocument.empty(author)
    for (let n = 1; n < SNAPSHOT_KEEP; n++) {
        store.putSnapshot(user, 'd', 'p', encodeSnapshot(fresh.serialize(), { shapes: [] }))
    }
    const current = store.reconstructDevicePage(user, 'd', 'p')
    const usage = store.usageBytes(user, 'created')
    store.setUserQuota(user, 'created', usage)
    createRootText(fresh)
    insertText(fresh, null, 'New text', { authorUuid: author })
    const token = store.mintDeviceToken(user, 'tablet')
    const response = await fetch(base + '/api/documents/d/pages/p/rm', {
        method: 'PUT',
        headers: { 'x-device-token': token, 'x-base-revision': current.revision },
        body: fresh.serialize() as unknown as BodyInit,
    })
    expect(response.status).toBe(200)
    expect(store.usageBytes(user, 'created')).toBeLessThan(usage)
    expect(store.getSnapshotBytes(user, 'd', 'p', retired)).toBeNull()
})
