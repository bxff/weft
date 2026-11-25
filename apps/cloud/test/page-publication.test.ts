import { Database } from 'bun:sqlite'
import { expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRootText, crdtId, insertText, Pen, PenColor, RmDocument } from '@weft/rm-format'
import { encodeOp, encodeSnapshot } from '@weft/sync-engine'
import { startCloud } from '../src/server'
import { CloudStore, COMPACT_EVERY_N_OPS, SNAPSHOT_KEEP } from '../src/store'

const USER = 'publisher'
const DOC = '55555555-5555-4555-a555-555555555555'
const PAGE = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee'
const PAGE_KEY = [USER, DOC, PAGE] as const
const AUTHOR = 'aaaaaaaa-0000-4000-a000-000000000001'
const TOKEN = 'dev:publisher'
const blank = RmDocument.empty(AUTHOR).serialize()
const overlay = { shapes: [] }
const operation = encodeOp({ op: 'delete-object', id: 'shape:gone', version: { ts: 1, actor: 'web' } })

function tabletFile() {
    const doc = RmDocument.parse(blank)
    doc.appendLine({
        kind: 'line', tool: Pen.BALLPOINT_1, color: PenColor.BLACK, thicknessScale: 2,
        startingLength: 0, timestamp: crdtId(0, 0), moveId: null,
        points: [{ x: 100, y: 200, width: 8, speed: 0, direction: 0, pressure: 127 }],
    }, { authorUuid: AUTHOR })
    createRootText(doc)
    insertText(doc, null, 'tablet text', { authorUuid: AUTHOR })
    return doc.serialize()
}

test('a tablet download uses one checkpoint, operation tail and revision when a peer publishes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-tablet-read-'))
    const dbPath = join(dir, 'relay.sqlite')
    const reader = new CloudStore(dbPath), peer = new CloudStore(dbPath)
    try {
        reader.putSnapshot(...PAGE_KEY, encodeSnapshot(blank, overlay))
        reader.appendOps(...PAGE_KEY, [operation], 'setup')
        const before = reader.reconstructDevicePage(...PAGE_KEY)
        const readHead = reader.latestOpSeq.bind(reader)
        spyOn(reader, 'latestOpSeq').mockImplementationOnce((...args) => {
            peer.putSnapshot(...PAGE_KEY, encodeSnapshot(tabletFile(), overlay))
            peer.appendOps(...PAGE_KEY, [operation], 'peer')
            return readHead(...args)
        })

        expect(reader.reconstructDevicePage(...PAGE_KEY)).toEqual(before)
        const after = peer.reconstructDevicePage(...PAGE_KEY)
        expect(after.revision).not.toBe(before.revision)
        expect(after.bytes).not.toEqual(before.bytes)
        expect(reader.reconstructDevicePage(...PAGE_KEY)).toEqual(after)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test.each(['pruned', 'cleared', 'retained', 'retained with an active writer'] as const)('a tablet download whose selected checkpoint file disappears (%s)', (disposition) => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-tablet-read-'))
    const dbPath = join(dir, 'relay.sqlite')
    const reader = new CloudStore(dbPath), peer = new CloudStore(dbPath)
    const writer = new Database(dbPath)
    const files = join(dbPath + '-files', 'snapshots')
    const retained = disposition === 'retained' || disposition === 'retained with an active writer'
    try {
        reader.putSnapshot(...PAGE_KEY, encodeSnapshot(blank, overlay))
        const selected = join(files, readdirSync(files)[0]!)
        const readHead = reader.latestOpSeq.bind(reader)
        spyOn(reader, 'latestOpSeq').mockImplementationOnce((...args) => {
            if (disposition === 'cleared') {
                peer.appendOps(...PAGE_KEY, [operation, operation], 'peer')
                expect(peer.clearPageHistory(...PAGE_KEY).snapshotsDeleted).toBeGreaterThan(0)
            } else {
                const count = disposition === 'pruned' ? SNAPSHOT_KEEP : 1
                for (let i = 0; i < count; i++) {
                    peer.putSnapshot(...PAGE_KEY, encodeSnapshot(tabletFile(), overlay))
                }
            }
            if (retained) rmSync(selected)
            if (disposition === 'retained with an active writer') writer.run('BEGIN IMMEDIATE')
            expect(existsSync(selected)).toBe(false)
            return readHead(...args)
        })

        if (retained) {
            expect(() => reader.reconstructDevicePage(...PAGE_KEY)).toThrow(/ENOENT/)
        } else {
            expect(reader.reconstructDevicePage(...PAGE_KEY)).toEqual(peer.reconstructDevicePage(...PAGE_KEY))
        }
    } finally {
        writer.close()
        rmSync(dir, { recursive: true, force: true })
    }
})

test('clear history keeps a checkpoint file readable if deleting its row fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-tablet-read-'))
    const dbPath = join(dir, 'relay.sqlite')
    const store = new CloudStore(dbPath)
    const inspector = new Database(dbPath)
    try {
        const original = encodeSnapshot(blank, overlay)
        const seq = store.putSnapshot(...PAGE_KEY, original)
        store.appendOps(...PAGE_KEY, [operation, operation], 'setup')
        inspector.run(`CREATE TRIGGER refuse_checkpoint_delete BEFORE DELETE ON page_snapshots
            WHEN OLD.seq = ${seq} BEGIN SELECT RAISE(ABORT, 'checkpoint kept'); END`)

        expect(() => store.clearPageHistory(...PAGE_KEY)).toThrow(/checkpoint kept/)
        expect(inspector.query('SELECT seq FROM page_snapshots WHERE seq=?').get(seq)).toEqual({ seq })
        expect(store.getSnapshotBytes(...PAGE_KEY, seq)).toEqual(original)
    } finally {
        inspector.close()
        rmSync(dir, { recursive: true, force: true })
    }
})

test('a missing retained snapshot does not route a tablet download to a stale legacy blob', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-tablet-read-'))
    const dbPath = join(dir, 'relay.sqlite')
    process.env.CLOUD_DEV_USER = '1'
    const server = startCloud({ port: 0, db: dbPath })
    try {
        server.store.putPage(...PAGE_KEY, '', blank, 'setup')
        server.store.putSnapshot(...PAGE_KEY, encodeSnapshot(tabletFile(), overlay))
        const endpoint = `http://localhost:${server.port}/api/documents/${DOC}/pages/${PAGE}/rm`
        const headers = { authorization: `Bearer ${TOKEN}` }
        const before = await fetch(endpoint, { headers })
        expect(before.status).toBe(200)
        expect(before.headers.get('x-rm-revision')).toBe('ops:0+1')
        await before.arrayBuffer()

        const files = join(dbPath + '-files', 'snapshots')
        rmSync(join(files, readdirSync(files)[0]!))
        const missing = await fetch(endpoint, { headers })
        expect(missing.status).toBe(500)
        expect(missing.headers.has('x-rm-revision')).toBe(false)
        await missing.text()
    } finally {
        server.stop()
        rmSync(dir, { recursive: true, force: true })
    }
})

const cases = [
    ['legacy RM', 'rm', 'PUT', 'page.changed'],
    ['first ops batch', 'ops', 'POST', 'ops.appended'],
    ['web snapshot', 'snapshot', 'PUT', 'page.changed'],
    ['restore op', 'revert', 'POST', 'page.changed'],
    ['restore snapshot', 'revert', 'POST', 'page.changed'],
    ['device ops and fallback snapshot', 'rm', 'PUT', 'page.changed'],
] as const

test.each(cases)('%s rolls back its entire publication on a delivery failure', async (name, endpoint, method, eventType) => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-publication-'))
    const dbPath = join(dir, 'relay.sqlite')
    process.env.CLOUD_DEV_USER = '1'
    const server = startCloud({ port: 0, db: dbPath })
    const { store } = server
    const inspect = new Database(dbPath)
    const base = `http://localhost:${server.port}`
    const ws = new WebSocket(`ws://localhost:${server.port}/ws?token=${encodeURIComponent(TOKEN)}`)
    const events: { type: string; page?: string }[] = []
    const snapshotDir = join(dbPath + '-files', 'snapshots')
    const files = () => existsSync(snapshotDir)
        ? readdirSync(snapshotDir).sort().map((file) => [file, readFileSync(join(snapshotDir, file))])
        : []
    try {
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve()
            ws.onerror = () => reject(new Error('could not connect publication observer'))
        })
        const notificationBarrier = new Promise<void>((resolve) => {
            ws.onmessage = (message) => {
                const event = JSON.parse(String(message.data))
                events.push(event)
                if (event.type === 'doc.list.changed') resolve()
            }
        })
        let body: Uint8Array | string = tabletFile()
        let baseRevision = ''
        if (name === 'legacy RM' || name === 'first ops batch') {
            const saved = store.putPage(...PAGE_KEY, '', blank, 'setup')
            if ('conflict' in saved) throw new Error('unexpected setup conflict')
            baseRevision = saved.revision
            store.putOverlay(...PAGE_KEY, JSON.stringify(overlay))
        } else {
            // A full retention window ensures a failed checkpoint cannot prune an older file.
            for (let i = 0; i < SNAPSHOT_KEEP; i++) store.putSnapshot(...PAGE_KEY, encodeSnapshot(blank, overlay))
            store.appendOps(...PAGE_KEY, [operation], 'setup')
            baseRevision = store.deviceRevision(...PAGE_KEY)
            if (name === 'web snapshot') body = encodeSnapshot(tabletFile(), overlay)
            if (name === 'restore op') body = JSON.stringify({ toSeq: 0 })
            if (name === 'restore snapshot') {
                body = JSON.stringify({ toSnapshot: store.latestSnapshotSeq(...PAGE_KEY) })
            }
        }
        if (name === 'first ops batch') body = JSON.stringify({ ops: [Buffer.from(operation).toString('base64')] })

        const readState = () => ({
            blob: store.getPage(...PAGE_KEY),
            sidecar: store.getOverlay(...PAGE_KEY),
            snapshot: store.latestSnapshot(...PAGE_KEY),
            ops: store.opsSince(...PAGE_KEY, 0),
            history: store.historyPoints(...PAGE_KEY),
            changes: store.changesSince(USER, 0),
            usage: store.usageBytes(USER, 'created'),
            native: store.reconstructDevicePage(...PAGE_KEY),
            overlay: store.overlayAtHead(...PAGE_KEY),
            files: files(),
        })
        const before = readState()
        inspect.run(`CREATE TRIGGER reject_delivery BEFORE INSERT ON changes BEGIN
            SELECT RAISE(ABORT, 'injected delivery failure'); END`)
        const publish = () => fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/${endpoint}`, {
            method,
            headers: { authorization: `Bearer ${TOKEN}`, 'x-base-revision': baseRevision },
            body,
        })
        expect((await publish()).status).toBe(500)
        expect(readState()).toEqual(before)

        inspect.run('DROP TRIGGER reject_delivery')
        const response = await publish()
        expect(response.status).toBe(200)
        // WebSocket delivery is ordered. This event drains any notifications
        // from both attempts before we count them.
        expect((await fetch(`${base}/api/documents`, {
            method: 'PUT',
            headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
            body: '{"documents":[]}',
        })).status).toBe(200)
        await notificationBarrier
        expect(events.filter((event) => event.type === eventType && event.page === PAGE)).toHaveLength(1)
        const after = readState()
        expect(after.changes).toHaveLength(before.changes.length + 1)
        expect(after.changes.at(-1)?.revision).toBe(
            name === 'legacy RM' ? after.blob?.revision : after.native.revision,
        )
        if (name === 'legacy RM') expect(after.blob?.bytes).toEqual(body)
        if (name === 'first ops batch') expect(after.overlay).toMatchObject({ tombstones: { 'shape:gone': { ts: 1 } } })
        if (name === 'web snapshot' || name === 'device ops and fallback snapshot') {
            expect(RmDocument.parse(after.native.bytes).tree().rootText).toBeTruthy()
            expect(after.snapshot?.opSeq).toBe(after.ops.at(-1)?.seq)
        }
        if (name.startsWith('restore')) expect(after.snapshot?.revert).toBe(true)
        if (name === 'first ops batch' || name === 'device ops and fallback snapshot') {
            expect(after.ops.length).toBeGreaterThan(before.ops.length)
            expect(after.snapshot?.seq).toBeGreaterThan(before.snapshot?.seq ?? 0)
        }
    } finally {
        ws.close()
        inspect.close()
        server.stop()
        rmSync(dir, { recursive: true, force: true })
    }
})

test.each(['ABORT', 'ROLLBACK'] as const)('automatic checkpoint failure with SQLite %s respects the transaction boundary', async (action) => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-publication-'))
    const dbPath = join(dir, 'relay.sqlite')
    process.env.CLOUD_DEV_USER = '1'
    const server = startCloud({ port: 0, db: dbPath })
    const inspect = new Database(dbPath)
    try {
        if (action === 'ROLLBACK') server.store.putPage(...PAGE_KEY, '', blank, 'setup')
        const changes = server.store.changesSince(USER, 0)
        inspect.run(`CREATE TRIGGER reject_checkpoint BEFORE INSERT ON page_snapshots
            WHEN NEW.op_seq > 0 BEGIN
            SELECT RAISE(${action}, 'injected checkpoint failure'); END`)
        const op = Buffer.from(operation).toString('base64')
        const result = await fetch(`http://localhost:${server.port}/api/documents/${DOC}/pages/${PAGE}/ops`, {
            method: 'POST',
            headers: { authorization: `Bearer ${TOKEN}` },
            body: JSON.stringify({ ops: Array(COMPACT_EVERY_N_OPS).fill(op) }),
        })
        expect(server.store.latestSnapshot(...PAGE_KEY)).toBeNull()
        expect(readdirSync(join(dbPath + '-files', 'snapshots'))).toEqual([])
        if (action === 'ROLLBACK') {
            expect(result.status).toBe(500)
            expect(server.store.latestOpSeq(...PAGE_KEY)).toBe(0)
            expect(server.store.changesSince(USER, 0)).toEqual(changes)
            expect(server.store.getPage(...PAGE_KEY)?.bytes).toEqual(blank)
            return
        }
        expect(result.status).toBe(200)
        expect(server.store.latestOpSeq(...PAGE_KEY)).toBe(COMPACT_EVERY_N_OPS)
        expect(server.store.changesSince(USER, 0).map((change) => change.revision)).toEqual([
            server.store.deviceRevision(...PAGE_KEY),
        ])
    } finally {
        inspect.close()
        server.stop()
        rmSync(dir, { recursive: true, force: true })
    }
})

test.each(['legacy seed refresh', 'device fallback'] as const)('%s failure rolls back writes made before its checkpoint', (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-publication-'))
    const dbPath = join(dir, 'relay.sqlite')
    const store = new CloudStore(dbPath)
    const inspect = new Database(dbPath)
    try {
        const saved = store.putPage(...PAGE_KEY, '', blank, 'setup')
        if ('conflict' in saved) throw new Error('unexpected setup conflict')
        store.seedSnapshotFromBlob(...PAGE_KEY)
        const snapshots = join(dbPath + '-files', 'snapshots')
        const files = readdirSync(snapshots)
        const read = () => ({
            blob: store.getPage(...PAGE_KEY),
            native: store.reconstructDevicePage(...PAGE_KEY),
            checkpoint: store.latestSnapshot(...PAGE_KEY),
            changes: store.changesSince(USER, 0),
            ops: store.opsSince(...PAGE_KEY, 0),
        })
        const before = read()
        inspect.run(`CREATE TRIGGER reject_checkpoint BEFORE INSERT ON page_snapshots BEGIN
            SELECT RAISE(ABORT, 'injected checkpoint failure'); END`)
        const bytes = tabletFile()
        const edit = () => mode === 'legacy seed refresh'
            ? store.putPage(...PAGE_KEY, saved.revision, bytes, 'tablet')
            : store.applyDevicePut(...PAGE_KEY, bytes, before.native.revision)
        expect(edit).toThrow('injected checkpoint failure')
        expect(read()).toEqual(before)
        expect(readdirSync(snapshots)).toEqual(files)
    } finally {
        inspect.close()
        rmSync(dir, { recursive: true, force: true })
    }
})

test.each(['ABORT', 'ROLLBACK'] as const)('a refused history clear (%s) preserves the cursor and checkpoint files', (action) => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-rollback-'))
    const path = join(dir, 'live.db')
    const store = new CloudStore(path)
    const db = new Database(path)
    try {
        const page = ['u', 'doc', 'page'] as const
        const rm = RmDocument.empty('a0000000-0000-4000-8000-000000000001').serialize()
        const checkpoint = encodeSnapshot(rm, { shapes: [] })
        const seq = store.putSnapshot(...page, checkpoint)
        const operations = [1, 2, 3].map(clock => encodeOp({
            op: 'tombstone', id: { author: null, clock },
        }))
        store.appendOps(...page, operations, 'browser')
        const before = store.deviceRevision(...page)
        const files = readdirSync(path + '-files/snapshots').sort()
        db.run(`CREATE TRIGGER refuse_history_clear BEFORE DELETE ON page_snapshots
            BEGIN SELECT RAISE(${action}, 'refused'); END`)
        expect(() => store.clearPageHistory(...page)).toThrow('refused')
        expect(store.getSnapshotBytes(...page, seq)).toEqual(checkpoint)
        expect(store.deviceRevision(...page)).toBe(before)
        expect(store.truncationFloor(...page)).toBe(0)
        expect(readdirSync(path + '-files/snapshots').sort()).toEqual(files)
        db.run('DROP TRIGGER refuse_history_clear')
        expect(store.clearPageHistory(...page).snapshotsDeleted).toBeGreaterThan(0)
        expect(store.opsSince(...page, store.truncationFloor(...page))).toHaveLength(1)
        expect(store.getSnapshotBytes(...page, seq)).toBeNull()
        const cleared = store.deviceRevision(...page)
        const kept = readdirSync(path + '-files/snapshots').sort()
        expect(store.clearPageHistory(...page)).toEqual({ opsDeleted: 0, snapshotsDeleted: 0, floor: 2 })
        expect(store.deviceRevision(...page)).toBe(cleared)
        expect(readdirSync(path + '-files/snapshots').sort()).toEqual(kept)
    } finally {
        db.close()
        rmSync(dir, { recursive: true, force: true })
    }
})


test('an enclosing publication rollback keeps the history files retired by a nested clear', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-nested-clear-'))
    const path = join(dir, 'relay.db')
    const store = new CloudStore(path)
    try {
        const original = encodeSnapshot(blank, overlay)
        const seq = store.putSnapshot(...PAGE_KEY, original)
        store.appendOps(...PAGE_KEY, [operation, operation, operation], 'setup')
        const revision = store.deviceRevision(...PAGE_KEY)
        const files = readdirSync(path + '-files/snapshots').sort()
        expect(() => store.publishPage(...PAGE_KEY, () => {
            store.clearPageHistory(...PAGE_KEY)
            throw new Error('later publication failed')
        })).toThrow('later publication failed')
        expect(store.getSnapshotBytes(...PAGE_KEY, seq)).toEqual(original)
        expect(store.deviceRevision(...PAGE_KEY)).toBe(revision)
        expect(store.truncationFloor(...PAGE_KEY)).toBe(0)
        expect(store.opsSince(...PAGE_KEY, 0)).toHaveLength(3)
        expect(readdirSync(path + '-files/snapshots').sort()).toEqual(files)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
