/**
 * #54: create a new notebook / folder from the web.
 *
 * Integration against a real startCloud server (CLOUD_DEV_USER dev tokens),
 * mirroring the harness in cloud.test.ts / ws-security.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startCloud, type CloudServer } from '../src/server'
import { RmDocument } from '@weft/rm-format'

let server: CloudServer
let base: string

beforeAll(() => {
    process.env.CLOUD_DEV_USER = '1'
    server = startCloud({ port: 0 })
    base = `http://localhost:${server.port}`
})
afterAll(() => server.stop())

const SESSION = { authorization: 'Bearer dev:creator', 'content-type': 'application/json' }

async function listDocs(): Promise<Record<string, unknown>[]> {
    const r = await fetch(`${base}/api/documents`, { headers: { authorization: 'Bearer dev:creator' } })
    const body = (await r.json()) as { documents?: Record<string, unknown>[] }
    return body.documents ?? []
}

describe('POST /api/documents/new (#54)', () => {
    test('creates a notebook: doc-list entry (create+pages), seeded first page, change', async () => {
        const r = await fetch(`${base}/api/documents/new`, {
            method: 'POST',
            headers: SESSION,
            body: JSON.stringify({ name: 'My Notes', kind: 'notebook' }),
        })
        expect(r.status).toBe(200)
        const { id, doc } = (await r.json()) as {
            id: string
            doc: { type: string; name: string; create: boolean; pages: { id: string }[] }
        }
        expect(doc.type).toBe('notebook')
        expect(doc.name).toBe('My Notes')
        expect(doc.create).toBe(true)
        expect(doc.pages).toHaveLength(1)
        const pageId = doc.pages[0]!.id

        // in the doc list, carrying the create marker the daemon materializes on
        const docs = await listDocs()
        const found = docs.find((d) => d.id === id)
        expect(found).toBeTruthy()
        expect(found!.create).toBe(true)
        expect(found!.type).toBe('notebook')

        // the seeded first page is a real, parseable .rm v6
        const pr = await fetch(`${base}/api/documents/${id}/pages/${pageId}/rm`, {
            headers: { authorization: 'Bearer dev:creator' },
        })
        expect(pr.status).toBe(200)
        const bytes = new Uint8Array(await pr.arrayBuffer())
        expect(bytes.length).toBeGreaterThan(0)
        expect(() => RmDocument.parse(bytes)).not.toThrow()

        // a change was recorded (origin web-new, NOT rmsyncd) so the daemon pulls it
        const cr = await fetch(`${base}/api/changes?since=0`, {
            headers: { authorization: 'Bearer dev:creator' },
        })
        const { changes } = (await cr.json()) as {
            changes: { doc: string; page: string; originClientId: string }[]
        }
        const ch = changes.find((c) => c.doc === id && c.page === pageId)
        expect(ch).toBeTruthy()
        expect(ch!.originClientId).toBe('web-new')
    })

    test('creates a folder: CollectionType-ish entry with no pages', async () => {
        const r = await fetch(`${base}/api/documents/new`, {
            method: 'POST',
            headers: SESSION,
            body: JSON.stringify({ name: 'Projects', kind: 'folder' }),
        })
        expect(r.status).toBe(200)
        const { doc } = (await r.json()) as { doc: { type: string; pages: unknown[]; create: boolean } }
        expect(doc.type).toBe('folder')
        expect(doc.pages).toHaveLength(0)
        expect(doc.create).toBe(true)
    })

    test('defaults name + parent, respects parent', async () => {
        const r = await fetch(`${base}/api/documents/new`, {
            method: 'POST',
            headers: SESSION,
            body: JSON.stringify({ kind: 'notebook', parent: 'somefolder' }),
        })
        const { doc } = (await r.json()) as { doc: { name: string; parent: string } }
        expect(doc.name).toBe('Untitled')
        expect(doc.parent).toBe('somefolder')
    })

    test('device/api-key callers are forbidden (containment)', async () => {
        // mint a device token via the session, then try to create with it
        const pr = await fetch(`${base}/api/pair`, {
            method: 'POST',
            headers: SESSION,
            body: JSON.stringify({ label: 'tablet' }),
        })
        const { token } = (await pr.json()) as { token: string }
        const r = await fetch(`${base}/api/documents/new`, {
            method: 'POST',
            headers: { 'x-device-token': token, 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'nope', kind: 'notebook' }),
        })
        expect(r.status).toBe(403)
    })
})

describe('POST /api/documents/import (library .rm drop)', () => {
    const OCTET = { authorization: 'Bearer dev:creator', 'content-type': 'application/octet-stream' }

    test('imported .rm becomes a create-marked notebook; page bytes round-trip exactly', async () => {
        // a real folder to land in — the doc merge clamps dangling parents to root
        const fr = await fetch(`${base}/api/documents/new`, {
            method: 'POST',
            headers: SESSION,
            body: JSON.stringify({ name: 'Imports', kind: 'folder' }),
        })
        const { id: folderId } = (await fr.json()) as { id: string }
        const rmBytes = RmDocument.empty(crypto.randomUUID()).serialize()
        const r = await fetch(`${base}/api/documents/import?name=Dropped%20Page&parent=${folderId}`, {
            method: 'POST',
            headers: OCTET,
            body: rmBytes,
        })
        expect(r.status).toBe(200)
        const { id } = (await r.json()) as { id: string }

        const docs = await listDocs()
        const doc = docs.find((d) => d.id === id) as {
            create: boolean
            type: string
            name: string
            parent: string
            pages: { id: string }[]
        }
        expect(doc).toBeTruthy()
        expect(doc.create).toBe(true)
        expect(doc.type).toBe('notebook')
        expect(doc.name).toBe('Dropped Page')
        expect(doc.parent).toBe(folderId)
        expect(doc.pages).toHaveLength(1)

        // the stored page is the dropped file, byte for byte
        const pr = await fetch(`${base}/api/documents/${id}/pages/${doc.pages[0]!.id}/rm`, {
            headers: { authorization: 'Bearer dev:creator' },
        })
        expect(pr.status).toBe(200)
        const stored = new Uint8Array(await pr.arrayBuffer())
        expect(stored).toEqual(rmBytes)

        // change recorded as web-import so the daemon pulls it to the tablet
        const cr = await fetch(`${base}/api/changes?since=0`, {
            headers: { authorization: 'Bearer dev:creator' },
        })
        const { changes } = (await cr.json()) as {
            changes: { doc: string; originClientId: string }[]
        }
        expect(changes.find((c) => c.doc === id)?.originClientId).toBe('web-import')
    })

    test('rejects bytes that do not parse as .rm v6', async () => {
        const r = await fetch(`${base}/api/documents/import`, {
            method: 'POST',
            headers: OCTET,
            body: new Uint8Array([1, 2, 3, 4, 5]),
        })
        expect(r.status).toBe(422)
    })

    test('device callers are forbidden (containment, same as /new)', async () => {
        const pr = await fetch(`${base}/api/pair`, {
            method: 'POST',
            headers: SESSION,
            body: JSON.stringify({ label: 'tablet2' }),
        })
        const { token } = (await pr.json()) as { token: string }
        const r = await fetch(`${base}/api/documents/import`, {
            method: 'POST',
            headers: { 'x-device-token': token, 'content-type': 'application/octet-stream' },
            body: RmDocument.empty(crypto.randomUUID()).serialize(),
        })
        expect(r.status).toBe(403)
    })
})
