/**
 * #39: document source files live on disk (not as SQLite BLOBs), and GET /file
 * supports HTTP Range so pdf.js streams only the bytes it needs. Also covers
 * the legacy (bytes-in-DB) -> disk migration.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { startCloud, type CloudServer } from '../src/server'
import { CloudStore } from '../src/store'

let server: CloudServer
let base: string
const auth = { authorization: 'Bearer dev:filetester' }
const DOC = '33333333-3333-4333-a333-333333333333'

// a recognizable 1000-byte body
const body = new Uint8Array(1000)
for (let i = 0; i < body.length; i++) body[i] = i % 256

beforeAll(async () => {
    process.env.CLOUD_DEV_USER = '1'
    server = startCloud({ port: 0 })
    base = `http://localhost:${server.port}`
    const put = await fetch(`${base}/api/documents/${DOC}/file`, {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/pdf' },
        body: body as unknown as BodyInit,
    })
    expect(put.status).toBe(200)
})
afterAll(() => server.stop())

test('GET /file returns the whole file with Accept-Ranges', async () => {
    const r = await fetch(`${base}/api/documents/${DOC}/file`, { headers: auth })
    expect(r.status).toBe(200)
    expect(r.headers.get('accept-ranges')).toBe('bytes')
    expect(r.headers.get('content-type')).toBe('application/pdf')
    const got = new Uint8Array(await r.arrayBuffer())
    expect(got.length).toBe(1000)
    expect(got[0]).toBe(0)
    expect(got[999]).toBe(231) // 999 % 256
})

test('GET /file with a byte range returns 206 + exactly those bytes', async () => {
    const r = await fetch(`${base}/api/documents/${DOC}/file`, {
        headers: { ...auth, range: 'bytes=100-199' },
    })
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 100-199/1000')
    const got = new Uint8Array(await r.arrayBuffer())
    expect(got.length).toBe(100)
    expect(got[0]).toBe(100)
    expect(got[99]).toBe(199)
})

test('GET /file suffix + open ranges', async () => {
    const suffix = await fetch(`${base}/api/documents/${DOC}/file`, {
        headers: { ...auth, range: 'bytes=-50' },
    })
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get('content-range')).toBe('bytes 950-999/1000')
    expect(new Uint8Array(await suffix.arrayBuffer()).length).toBe(50)

    const open = await fetch(`${base}/api/documents/${DOC}/file`, {
        headers: { ...auth, range: 'bytes=900-' },
    })
    expect(open.status).toBe(206)
    expect(open.headers.get('content-range')).toBe('bytes 900-999/1000')
    expect(new Uint8Array(await open.arrayBuffer()).length).toBe(100)
})

test('GET /file with an unsatisfiable range returns 416', async () => {
    const r = await fetch(`${base}/api/documents/${DOC}/file`, {
        headers: { ...auth, range: 'bytes=5000-6000' },
    })
    expect(r.status).toBe(416)
    expect(r.headers.get('content-range')).toBe('bytes */1000')
})

test('GET /file single-byte range (0-0)', async () => {
    const r = await fetch(`${base}/api/documents/${DOC}/file`, {
        headers: { ...auth, range: 'bytes=0-0' },
    })
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 0-0/1000')
    const got = new Uint8Array(await r.arrayBuffer())
    expect(got.length).toBe(1)
    expect(got[0]).toBe(0)
})

test('GET /file rejects a multi-range request (416, not partial)', async () => {
    const r = await fetch(`${base}/api/documents/${DOC}/file`, {
        headers: { ...auth, range: 'bytes=0-1,4-5' },
    })
    expect(r.status).toBe(416)
})

test('GET /file answers 204 for a document with no resident source (tablet-only is a normal state)', async () => {
    const r = await fetch(`${base}/api/documents/99999999-9999-4999-a999-999999999999/file`, {
        headers: auth,
    })
    expect(r.status).toBe(204)
})

test('GET /file carries the revision etag; If-None-Match answers 304; a re-import changes it', async () => {
    const first = await fetch(`${base}/api/documents/${DOC}/file`, { headers: auth })
    const etag = first.headers.get('etag')!
    expect(etag).toBeTruthy()
    // fresh cache: conditional GET revalidates for free
    const cond = await fetch(`${base}/api/documents/${DOC}/file`, {
        headers: { ...auth, 'if-none-match': etag },
    })
    expect(cond.status).toBe(304)
    // even combined with a probing Range (the client's one-request revalidate)
    const condRange = await fetch(`${base}/api/documents/${DOC}/file`, {
        headers: { ...auth, 'if-none-match': etag, range: 'bytes=0-0' },
    })
    expect(condRange.status).toBe(304)
    // a range WITHOUT a matching etag still serves 206 and exposes the etag
    const range = await fetch(`${base}/api/documents/${DOC}/file`, {
        headers: { ...auth, range: 'bytes=0-0' },
    })
    expect(range.status).toBe(206)
    expect(range.headers.get('etag')).toBe(etag)
    // re-import = new revision = new etag; the old etag no longer validates
    await fetch(`${base}/api/documents/${DOC}/file`, {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/pdf' },
        body: new Uint8Array(999).fill(9) as unknown as BodyInit,
    })
    const after = await fetch(`${base}/api/documents/${DOC}/file`, {
        headers: { ...auth, 'if-none-match': etag },
    })
    expect(after.status).toBe(200)
    expect(after.headers.get('etag')).not.toBe(etag)
    // restore the original body for the tests that follow
    await fetch(`${base}/api/documents/${DOC}/file`, {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/pdf' },
        body: body as unknown as BodyInit,
    })
})

test('PUT /file overwrites and preserves a non-PDF mime', async () => {
    const small = new Uint8Array([1, 2, 3, 4, 5])
    const put = await fetch(`${base}/api/documents/${DOC}-epub/file`, {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/epub+zip' },
        body: small as unknown as BodyInit,
    })
    expect(put.status).toBe(200)
    let r = await fetch(`${base}/api/documents/${DOC}-epub/file`, { headers: auth })
    expect(r.headers.get('content-type')).toBe('application/epub+zip')
    expect(new Uint8Array(await r.arrayBuffer()).length).toBe(5)

    // overwrite with a larger body; size + bytes update
    const bigger = new Uint8Array(20).fill(7)
    await fetch(`${base}/api/documents/${DOC}-epub/file`, {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/epub+zip' },
        body: bigger as unknown as BodyInit,
    })
    r = await fetch(`${base}/api/documents/${DOC}-epub/file`, { headers: auth })
    const got = new Uint8Array(await r.arrayBuffer())
    expect(got.length).toBe(20)
    expect(got[0]).toBe(7)
})

test('getFileRef returns null when the on-disk file vanished (stale row)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-stale-'))
    const store = new CloudStore(join(dir, 'test.db'))
    store.putFile('u2', 'docB', body, 'application/pdf')
    const ref = store.getFileRef('u2', 'docB')!
    rmSync(ref.path)
    expect(store.getFileRef('u2', 'docB')).toBeNull()
    expect(store.getFile('u2', 'docB')).toBeNull()
})

test('file bytes live on disk, not in the SQLite files table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-store-'))
    const store = new CloudStore(join(dir, 'test.db'))
    store.putFile('u1', 'docA', body, 'application/pdf')

    // round-trips
    expect(store.getFile('u1', 'docA')).toEqual(body)
    const ref = store.getFileRef('u1', 'docA')!
    expect(ref).toBeTruthy()
    expect(ref.size).toBe(1000)
    expect(ref.mime).toBe('application/pdf')
    expect(existsSync(ref.path)).toBe(true)

    // the DB holds a path ref, never the blob
    const cols = new Database(join(dir, 'test.db'))
        .query('PRAGMA table_info(files)')
        .all() as { name: string }[]
    const names = cols.map((c) => c.name)
    expect(names).toContain('path')
    expect(names).toContain('size')
    expect(names).not.toContain('bytes')
})

test('re-pushing a source does NOT inflate the sources usage counter (drift bug)', () => {
  const store = new CloudStore(':memory:');
  const U = 'driftuser';
  const D = 'doc-drift';
  const a = new Uint8Array(1000).fill(1);
  const b = new Uint8Array(1500).fill(2);
  store.putFile(U, D, a);
  expect(store.usageBytes(U, 'sources')).toBe(1000);
  // the daemon re-pushes the SAME doc repeatedly (INSERT OR REPLACE). Without
  // recursive_triggers the AFTER DELETE never fired and this grew 1000 each time.
  store.putFile(U, D, a);
  store.putFile(U, D, a);
  expect(store.usageBytes(U, 'sources')).toBe(1000); // still one file's worth
  // a genuine size change nets the delta, not the sum
  store.putFile(U, D, b);
  expect(store.usageBytes(U, 'sources')).toBe(1500);
  // deleting frees it
  store.deleteFile(U, D);
  expect(store.usageBytes(U, 'sources')).toBe(0);
})

test('recomputeUsage heals a drifted counter on startup', () => {
  const store = new CloudStore(':memory:');
  const U = 'healuser';
  store.putFile(U, 'x', new Uint8Array(2000).fill(9));
  // simulate historical drift: the counter over-counts (the old bug)
  // @ts-expect-error reach into the private db for the test
  store.db.run("UPDATE user_usage SET bytes = 999999 WHERE user_id=? AND class='sources'", [U]);
  expect(store.usageBytes(U, 'sources')).toBe(999999);
  // @ts-expect-error private
  store.recomputeUsage();
  expect(store.usageBytes(U, 'sources')).toBe(2000); // back to the real total
})

test('a canvas asset replaced under the same filename has a different validator', async () => {
    const url = `${base}/api/documents/${DOC}/pages/canvas/assets/photo.png`
    const put = (bytes: Uint8Array) => fetch(url, {
        method: 'PUT', headers: auth, body: bytes as BodyInit,
    })
    expect((await put(Uint8Array.of(12))).ok).toBe(true)
    const before = await fetch(url, { headers: auth })
    expect(before.headers.get('cache-control')).toBe('private, no-store')
    expect(before.headers.get('vary')).toBe('Authorization')
    const old = before.headers.get('etag')!
    expect(old).toMatch(/^"[0-9a-f]{64}"$/)
    expect((await fetch(url, { headers: { ...auth, 'if-none-match': old } })).status).toBe(304)

    expect((await put(Uint8Array.of(34))).ok).toBe(true)
    const after = await fetch(url, { headers: { ...auth, 'if-none-match': old } })
    expect(after.status).toBe(200)
    expect(after.headers.get('etag')).not.toBe(old)
    expect(new Uint8Array(await after.arrayBuffer())).toEqual(Uint8Array.of(34))
})
