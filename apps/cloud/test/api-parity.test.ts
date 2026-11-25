/**
 * API contract / parity test. The hosted cloud MUST implement every
 * browser-facing route the app (and any third-party client) depends on. This
 * existed because the cloud was a partial reimplementation of the on-device
 * daemon's API and silently lagged it (missing thumbnail/file/templates routes),
 * which surfaced as blank thumbnails and PDFs only once local mode was removed.
 *
 * Each route is round-tripped (PUT then GET, or GET) so a missing route fails
 * loudly here instead of in production. If you add a route the browser needs,
 * add it here too.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { startCloud, type CloudServer } from '../src/server'

let server: CloudServer
let base: string
const TOK = 'dev:parity'
const h = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${TOK}`, ...extra })

beforeAll(() => {
    process.env.CLOUD_DEV_USER = '1'
    server = startCloud({ port: 0 })
    base = `http://localhost:${server.port}`
})
afterAll(() => server.stop())

const DOC = 'doc-parity'
const PAGE = 'page-parity'

test('documents: PUT + GET round-trip', async () => {
    const body = JSON.stringify({ documents: [{ id: DOC, name: 'P', type: 'notebook', pages: [{ id: PAGE }] }] })
    expect((await fetch(`${base}/api/documents`, { method: 'PUT', headers: h({ 'content-type': 'application/json' }), body })).status).toBe(200)
    const r = await fetch(`${base}/api/documents`, { headers: h() })
    expect(r.status).toBe(200)
    expect((await r.json()).documents[0].id).toBe(DOC)
})

test('changes: GET', async () => {
    const r = await fetch(`${base}/api/changes?since=0`, { headers: h() })
    expect(r.status).toBe(200)
    expect(Array.isArray((await r.json()).changes)).toBe(true)
})

test('page rm: PUT (new) + GET round-trip', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const put = await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/rm`, {
        method: 'PUT',
        headers: h({ 'x-base-revision': '', 'x-client-id': 'parity' }),
        body: bytes,
    })
    expect(put.status).toBe(200)
    const get = await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/rm`, { headers: h() })
    expect(get.status).toBe(200)
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes)
})

test('overlay: PUT + GET round-trip', async () => {
    const body = JSON.stringify({ shapes: [{ id: 'x' }] })
    expect((await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/overlay`, { method: 'PUT', headers: h({ 'content-type': 'application/json' }), body })).status).toBe(200)
    const r = await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/overlay`, { headers: h() })
    expect(r.status).toBe(200)
    expect((await r.json()).shapes).toHaveLength(1)
})

test('assets: PUT + list + GET round-trip', async () => {
    const png = new Uint8Array([137, 80, 78, 71])
    expect((await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/assets/a.png`, { method: 'PUT', headers: h(), body: png })).status).toBe(200)
    const list = await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/assets`, { headers: h() })
    expect(list.status).toBe(200)
    expect((await list.json()).files).toContain('a.png')
    const get = await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/assets/a.png`, { headers: h() })
    expect(get.status).toBe(200)
    expect(get.headers.get('content-type')).toBe('image/png')
})

test('thumbnail: PUT + GET round-trip, etag revalidation', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 9])
    expect((await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/thumbnail`, { method: 'PUT', headers: h(), body: png })).status).toBe(200)
    const get = await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/thumbnail`, { headers: h() })
    expect(get.status).toBe(200)
    expect(get.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(png)
    // SWR cache: unchanged thumbnail revalidates as a free 304
    const etag = get.headers.get('etag')!
    expect(etag).toBeTruthy()
    const cond = await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/thumbnail`, {
        headers: h({ 'if-none-match': etag }),
    })
    expect(cond.status).toBe(304)
    // a re-pushed (changed) thumbnail invalidates the old etag
    const png2 = new Uint8Array([137, 80, 78, 71, 10])
    await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/thumbnail`, { method: 'PUT', headers: h(), body: png2 })
    const after = await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/thumbnail`, {
        headers: h({ 'if-none-match': etag }),
    })
    expect(after.status).toBe(200)
    expect(new Uint8Array(await after.arrayBuffer())).toEqual(png2)
})

test('file (PDF underlay): PUT + GET round-trip', async () => {
    const pdf = new Uint8Array([37, 80, 68, 70]) // %PDF
    expect((await fetch(`${base}/api/documents/${DOC}/file`, { method: 'PUT', headers: h(), body: pdf })).status).toBe(200)
    const get = await fetch(`${base}/api/documents/${DOC}/file`, { headers: h() })
    expect(get.status).toBe(200)
    expect(get.headers.get('content-type')).toBe('application/pdf')
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(pdf)
})

test('templates: PUT + GET round-trip preserves mime', async () => {
    const svg = new TextEncoder().encode('<svg/>')
    expect((await fetch(`${base}/api/templates/P%20Lines%20medium`, { method: 'PUT', headers: h({ 'content-type': 'image/svg+xml' }), body: svg })).status).toBe(200)
    const get = await fetch(`${base}/api/templates/P%20Lines%20medium`, { headers: h() })
    expect(get.status).toBe(200)
    expect(get.headers.get('content-type')).toBe('image/svg+xml')
})

test('unknown route is 404 (sanity, distinguishes missing routes above)', async () => {
    expect((await fetch(`${base}/api/does-not-exist`, { headers: h() })).status).toBe(404)
})
