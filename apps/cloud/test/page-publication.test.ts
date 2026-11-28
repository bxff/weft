import { Database } from 'bun:sqlite'
import { expect, spyOn, test } from 'bun:test'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
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
    ['guarded first ops batch', 'ops-batch', 'POST', 'ops.appended'],
    ['web snapshot', 'snapshot', 'PUT', 'page.changed'],
    ['versioned snapshot', 'snapshot', 'POST', 'page.changed'],
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
        const opAppend = endpoint === 'ops' || endpoint === 'ops-batch'
        if (name === 'legacy RM' || opAppend) {
            const saved = store.putPage(...PAGE_KEY, '', blank, 'setup')
            if ('conflict' in saved) throw new Error('unexpected setup conflict')
            baseRevision = saved.revision
            store.putOverlay(...PAGE_KEY, JSON.stringify(overlay))
        } else {
            // A full retention window ensures a failed checkpoint cannot prune an older file.
            for (let i = 0; i < SNAPSHOT_KEEP; i++) store.putSnapshot(...PAGE_KEY, encodeSnapshot(blank, overlay))
            store.appendOps(...PAGE_KEY, [operation], 'setup')
            baseRevision = store.deviceRevision(...PAGE_KEY)
            if (endpoint === 'snapshot') body = encodeSnapshot(tabletFile(), overlay)
            if (name === 'restore op') body = JSON.stringify({ toSeq: 0 })
            if (name === 'restore snapshot') {
                body = JSON.stringify({ toSnapshot: store.latestSnapshotSeq(...PAGE_KEY) })
            }
        }
        if (opAppend) {
            const batch = { ops: [Buffer.from(operation).toString('base64')], author: null }
            body = JSON.stringify(endpoint === 'ops-batch' ? { baseSeq: 0, batch } : batch)
        }

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
            receipts: inspect.query('SELECT * FROM page_snapshot_receipts').all(),
            opReceipts: inspect.query('SELECT * FROM page_op_batch_receipts').all(),
        })
        const before = readState()
        inspect.run(`CREATE TRIGGER reject_delivery BEFORE INSERT ON changes BEGIN
            SELECT RAISE(ABORT, 'injected delivery failure'); END`)
        const headers: Record<string, string> = {
            authorization: `Bearer ${TOKEN}`,
            'x-base-revision': baseRevision,
        }
        if (endpoint === 'ops-batch') headers['x-op-batch-id'] = crypto.randomUUID()
        if (name === 'versioned snapshot') {
            headers['x-snapshot-publication-id'] = crypto.randomUUID()
            headers['x-snapshot-base-seq'] = String(store.latestSnapshotSeq(...PAGE_KEY))
        }
        const publish = () => fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/${endpoint}`, {
            method, headers, body,
        })
        expect((await publish()).status).toBe(500)
        expect(readState()).toEqual(before)

        inspect.run('DROP TRIGGER reject_delivery')
        const response = await publish()
        expect(response.status).toBe(200)
        if (name === 'versioned snapshot' || endpoint === 'ops-batch') {
            const duplicate = await publish()
            expect(duplicate.status).toBe(200)
            expect(await duplicate.json()).toEqual(await response.json())
        }
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
        expect(after.receipts).toHaveLength(name === 'versioned snapshot' ? 1 : 0)
        expect(after.opReceipts).toHaveLength(endpoint === 'ops-batch' ? 1 : 0)
        expect(after.changes.at(-1)?.revision).toBe(
            name === 'legacy RM' ? after.blob?.revision : after.native.revision,
        )
        if (name === 'legacy RM') expect(after.blob?.bytes).toEqual(body)
        if (opAppend) expect(after.overlay).toMatchObject({ tombstones: { 'shape:gone': { ts: 1 } } })
        if (endpoint === 'snapshot' || name === 'device ops and fallback snapshot') {
            expect(RmDocument.parse(after.native.bytes).tree().rootText).toBeTruthy()
            expect(after.snapshot?.opSeq).toBe(after.ops.at(-1)?.seq)
        }
        if (name.startsWith('restore')) expect(after.snapshot?.revert).toBe(true)
        if (opAppend || name === 'device ops and fallback snapshot') {
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

test('accepted snapshot retries survive pruning and cannot rewrite subsequent publications', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-snapshot-receipt-'))
    const db = join(dir, 'relay.sqlite')
    process.env.CLOUD_DEV_USER = '1'
    let server = startCloud({ port: 0, db })
    const id = crypto.randomUUID()
    const local = RmDocument.parse(blank)
    local.createLayer('Local', { authorUuid: AUTHOR })
    const localBytes = encodeSnapshot(local.serialize(), overlay)
    const publish = (bytes: Uint8Array, publicationId: string, baseSeq: number) =>
        fetch(`http://localhost:${server.port}/api/documents/${DOC}/pages/${PAGE}/snapshot`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${TOKEN}`,
                'x-snapshot-publication-id': publicationId,
                'x-snapshot-base-seq': String(baseSeq),
            },
            body: bytes,
        })
    try {
        const initial = await publish(localBytes, id, 0)
        expect(initial.status).toBe(200)
        const acknowledgement = await initial.json() as { seq: number; merged: boolean }

        const peer = RmDocument.parse(server.store.reconstructDevicePage(...PAGE_KEY).bytes)
        peer.createLayer('Peer', { authorUuid: 'bbbbbbbb-0000-4000-a000-000000000002' })
        const peerBytes = encodeSnapshot(peer.serialize(), overlay)
        const next = await publish(peerBytes, crypto.randomUUID(), acknowledgement.seq)
        expect(next.status).toBe(200)
        for (let i = 0; i < SNAPSHOT_KEEP; i++) server.store.putSnapshot(...PAGE_KEY, peerBytes)
        const inspect = new Database(db)
        try {
            expect(inspect.query('SELECT seq FROM page_snapshots WHERE seq=?').get(acknowledgement.seq)).toBeNull()
        } finally {
            inspect.close()
        }

        const archive = server.store.backup(join(dir, 'archive'))
        const restoredDb = join(dir, 'restored.sqlite')
        cpSync(join(archive, 'weft.db'), restoredDb)
        cpSync(join(archive, 'files'), restoredDb + '-files', { recursive: true })
        server.stop()
        server = startCloud({ port: 0, db: restoredDb })
        const latest = server.store.latestSnapshotSeq(...PAGE_KEY)
        const changes = server.store.changesSince(USER, 0)
        const usage = server.store.usageBytes(USER, 'created')

        const stale = await publish(localBytes, crypto.randomUUID(), 0)
        expect(stale.status).toBe(409)
        expect(await stale.json()).toMatchObject({ reason: 'snapshot-base', currentSeq: latest })
        for (const [bytes, baseSeq] of [[peerBytes, 0], [localBytes, latest]] as const) {
            const reused = await publish(bytes, id, baseSeq)
            expect(reused.status).toBe(409)
            expect(await reused.json()).toMatchObject({ reason: 'publication-id-reused' })
        }

        server.store.setUserQuota(USER, 'created', 1)
        const retried = await publish(localBytes, id, 0)
        expect(retried.status).toBe(200)
        expect(await retried.json()).toEqual(acknowledgement)
        expect(server.store.latestSnapshotSeq(...PAGE_KEY)).toBe(latest)
        expect(server.store.changesSince(USER, 0)).toEqual(changes)
        expect(server.store.usageBytes(USER, 'created')).toBe(usage)
        expect(RmDocument.parse(server.store.reconstructDevicePage(...PAGE_KEY).bytes).layers()
            .map(({ label }) => label)).toEqual(['Layer 1', 'Local', 'Peer'])

        const restored = new Database(restoredDb)
        try {
            // A full purge can remove a page, unlike normal checkpoint pruning.
            restored.run('DELETE FROM page_snapshots WHERE user_id=? AND doc=? AND page=?', PAGE_KEY)
            expect(restored.query('SELECT * FROM page_snapshot_receipts').all()).toEqual([])
        } finally {
            restored.close()
        }
        server.store.setUserQuota(USER, 'created', null)
        const recreated = await publish(peerBytes, crypto.randomUUID(), 0)
        expect(recreated.status).toBe(200)
        const expired = await publish(localBytes, id, 0)
        expect(expired.status).toBe(409)
        expect(await expired.json()).toMatchObject({ reason: 'snapshot-base' })
    } finally {
        server.stop()
        rmSync(dir, { recursive: true, force: true })
    }
})

test('guarded snapshot publications require both headers and validate the base cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-snapshot-headers-'))
    process.env.CLOUD_DEV_USER = '1'
    const server = startCloud({ port: 0, db: join(dir, 'relay.sqlite') })
    const id = crypto.randomUUID()
    const snapshot = encodeSnapshot(blank, overlay)
    const put = (headers: Record<string, string>, body = snapshot) =>
        fetch(`http://localhost:${server.port}/api/documents/${DOC}/pages/${PAGE}/snapshot`, {
            method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, ...headers }, body,
        })
    try {
        expect((await put({})).status).toBe(400)
        expect((await put({ 'x-snapshot-base-seq': '0' })).status).toBe(400)
        expect((await put({ 'x-snapshot-publication-id': id })).status).toBe(400)
        expect((await put({ 'x-snapshot-publication-id': 'invalid', 'x-snapshot-base-seq': '0' })).status).toBe(400)
        for (const base of ['', '-1', '1.5', '2e1', '9007199254740992']) {
            expect((await put({ 'x-snapshot-publication-id': id, 'x-snapshot-base-seq': base })).status).toBe(400)
        }
        expect(server.store.latestSnapshot(...PAGE_KEY)).toBeNull()
        expect(server.store.changesSince(USER, 0)).toEqual([])
        const first = { 'x-snapshot-publication-id': id, 'x-snapshot-base-seq': '0' }
        expect((await put(first, Uint8Array.of(1, 2, 3))).status).toBe(500)
        expect(server.store.latestSnapshot(...PAGE_KEY)).toBeNull()
        expect(server.store.changesSince(USER, 0)).toEqual([])
        expect((await put(first)).status).toBe(200)
        expect(server.store.latestSnapshot(...PAGE_KEY)?.bytes).toEqual(snapshot)

        const base = server.store.latestSnapshotSeq(...PAGE_KEY)
        const next = { 'x-snapshot-publication-id': crypto.randomUUID(), 'x-snapshot-base-seq': String(base) }
        const failedRead = spyOn(server.store, 'reconstructDevicePage').mockImplementationOnce(() => {
            throw new Error('injected snapshot reconstruction failure')
        })
        try {
            expect((await put(next)).status).toBe(500)
            expect(server.store.latestSnapshotSeq(...PAGE_KEY)).toBe(base)
            expect(server.store.changesSince(USER, 0)).toHaveLength(1)
        } finally {
            failedRead.mockRestore()
        }
        expect((await put(next)).status).toBe(200)
        expect(server.store.changesSince(USER, 0)).toHaveLength(2)
    } finally {
        server.stop()
        rmSync(dir, { recursive: true, force: true })
    }
})

test('a guarded mixed snapshot accepts or rejects its history deltas with the snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-mixed-snapshot-receipt-'))
    const db = join(dir, 'relay.sqlite')
    process.env.CLOUD_DEV_USER = '1'
    const server = startCloud({ port: 0, db })
    const inspect = new Database(db)
    const endpoint = `http://localhost:${server.port}/api/documents/${DOC}/pages/${PAGE}/snapshot-batch`
    const id = crypto.randomUUID()
    const snapshot = encodeSnapshot(tabletFile(), overlay)
    const { encodeSnapshotBatch, SNAPSHOT_BATCH_CONTENT_TYPE } = await import('@weft/sync-engine')
    const bytes = encodeSnapshotBatch({ snapshot, deltas: [operation], author: 'web history' })
    const publish = (
        baseSeq: number, contentType = SNAPSHOT_BATCH_CONTENT_TYPE, body = bytes, endpointOverride = endpoint,
    ) => fetch(endpointOverride, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': contentType,
            'x-snapshot-publication-id': id,
            'x-snapshot-base-seq': String(baseSeq),
        },
        body,
    })
    try {
        const before = server.store.putSnapshot(...PAGE_KEY, encodeSnapshot(blank, overlay))
        const truncated = bytes.slice(0, 5)
        expect((await publish(before, SNAPSHOT_BATCH_CONTENT_TYPE, truncated)).status).toBe(400)
        const tooManyOps = encodeSnapshotBatch({
            snapshot, deltas: Array(1001).fill(operation), author: 'web history',
        })
        expect((await publish(before, SNAPSHOT_BATCH_CONTENT_TYPE, tooManyOps)).status).toBe(413)
        expect(server.store.latestSnapshotSeq(...PAGE_KEY)).toBe(before)
        expect((await publish(0)).status).toBe(409)
        expect(server.store.opsSince(...PAGE_KEY, 0)).toEqual([])
        expect(server.store.changesSince(USER, 0)).toEqual([])

        // A valid request must not get a receipt when the relay cannot
        // reconstruct the existing page for the merge. Retrying after
        // recovery must publish both layers, not return a phantom receipt.
        const brokenMerge = spyOn(server.store, 'reconstructDevicePage').mockImplementationOnce(() => {
            throw new Error('injected snapshot reconstruction failure')
        })
        try {
            expect((await publish(before)).status).toBe(500)
            expect(server.store.latestSnapshotSeq(...PAGE_KEY)).toBe(before)
            expect(server.store.opsSince(...PAGE_KEY, 0)).toEqual([])
            expect(server.store.changesSince(USER, 0)).toEqual([])
            expect(inspect.query('SELECT count(*) AS count FROM page_snapshot_receipts').get())
                .toEqual({ count: 0 })
        } finally {
            brokenMerge.mockRestore()
        }

        inspect.run(`CREATE TRIGGER reject_mixed_delivery BEFORE INSERT ON changes BEGIN
            SELECT RAISE(ABORT, 'injected mixed delivery failure'); END`)
        expect((await publish(before)).status).toBe(500)
        expect(server.store.latestSnapshotSeq(...PAGE_KEY)).toBe(before)
        expect(server.store.opsSince(...PAGE_KEY, 0)).toEqual([])
        inspect.run('DROP TRIGGER reject_mixed_delivery')

        const response = await publish(before)
        expect(response.status).toBe(200)
        const accepted = await response.json() as { seq: number; merged: boolean }
        const ops = server.store.opsSince(...PAGE_KEY, 0)
        expect(ops).toHaveLength(1)
        expect(ops[0]).toMatchObject({ op: operation, author: 'web history' })
        expect(server.store.latestSnapshot(...PAGE_KEY)?.opSeq).toBe(ops[0]!.seq)
        expect(server.store.changesSince(USER, 0)).toHaveLength(1)

        const duplicate = await publish(before)
        expect(duplicate.status).toBe(200)
        expect(await duplicate.json()).toEqual(accepted)
        const differentMode = await publish(before, 'application/octet-stream', bytes, endpoint.replace(/-batch$/, ''))
        expect(differentMode.status).toBe(409)
        expect(await differentMode.json()).toMatchObject({ reason: 'publication-id-reused' })
        expect(server.store.opsSince(...PAGE_KEY, 0)).toEqual(ops)
        expect(server.store.changesSince(USER, 0)).toHaveLength(1)
    } finally {
        inspect.close()
        server.stop()
        rmSync(dir, { recursive: true, force: true })
    }
})

test('a snapshot receipt reports overlay-only changes folded in by the relay', () => {
    const store = new CloudStore(':memory:')
    const base = encodeSnapshot(blank, overlay)
    const seq = store.putSnapshot(...PAGE_KEY, base)
    store.appendOps(...PAGE_KEY, [operation], 'peer')
    const publication = { id: crypto.randomUUID(), baseSeq: seq }
    const accepted = store.publishSnapshot(...PAGE_KEY, base, publication, () => null)
    expect(accepted).toMatchObject({ kind: 'accepted', merged: true, duplicate: false })
    expect(store.overlayAtHead(...PAGE_KEY)).toMatchObject({ tombstones: { 'shape:gone': { ts: 1 } } })
    expect(store.publishSnapshot(...PAGE_KEY, base, publication, () => null))
        .toMatchObject({ kind: 'accepted', merged: true, duplicate: true })
    const current = store.latestSnapshot(...PAGE_KEY)!
    expect(store.publishSnapshot(...PAGE_KEY, current.bytes, { id: crypto.randomUUID(), baseSeq: current.seq }, () => null))
        .toMatchObject({ kind: 'accepted', merged: false })
})


test.each(['missing', 'truncated'] as const)(
    'file-backed relay refuses a receipt and a read when the live checkpoint is %s', async (fault) => {
        const dir = mkdtempSync(join(tmpdir(), 'weft-receipt-restart-'))
        const db = join(dir, 'relay.sqlite')
        const start = async () => {
            const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/server.ts'),
                '--port', '0', '--db', db], {
                env: { ...process.env, CLOUD_DEV_USER: '1' },
                stdout: 'pipe', stderr: 'inherit',
            })
            const reader = child.stdout.getReader()
            const stop = async () => {
                child.kill('SIGKILL')
                await child.exited
            }
            const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
            try {
                let output = ''
                for (;;) {
                    const { done, value } = await reader.read()
                    if (done) throw new Error('Relay did not start: ' + output)
                    output += new TextDecoder().decode(value)
                    const port = /listening on :(\d+)/.exec(output)?.[1]
                    if (port) return { stop, url: `http://localhost:${port}/api/documents/${DOC}/pages/${PAGE}` }
                }
            } catch (error) {
                await stop()
                throw error
            } finally {
                clearTimeout(timer)
                reader.releaseLock()
            }
        }
        let relay: Awaited<ReturnType<typeof start>> | undefined
        try {
            relay = await start()
            const auth = { authorization: `Bearer ${TOKEN}` }
            const checkpoint = encodeSnapshot(tabletFile(), overlay)
            const id = crypto.randomUUID()
            const publish = () => fetch(relay!.url + '/snapshot', {
                method: 'POST', body: checkpoint, headers: {
                    ...auth, 'x-snapshot-publication-id': id, 'x-snapshot-base-seq': '0',
                },
            })
            const snapshot = () => fetch(relay!.url + '/snapshot', { headers: auth })
            const initial = await publish()
            expect(initial.status).toBe(200)
            const received = await initial.json() as { seq: number; merged: boolean }
            const opsId = crypto.randomUUID()
            const append = () => fetch(relay!.url + '/ops-batch', {
                method: 'POST',
                body: JSON.stringify({
                    baseSeq: received.seq,
                    batch: { author: AUTHOR, ops: [Buffer.from(operation).toString('base64')] },
                }),
                headers: { ...auth, 'x-op-batch-id': opsId },
            })
            const appended = await append()
            expect(appended.status).toBe(200)
            const range = await appended.json()
            await relay.stop()
            relay = await start()

            // Replay the original requests, as if their replies had been lost.
            expect(await (await publish()).json()).toEqual(received)
            expect(await (await append()).json()).toEqual(range)
            const fresh = await snapshot()
            expect(fresh.status).toBe(200)
            expect(new Uint8Array(await fresh.arrayBuffer())).toEqual(checkpoint)

            const snapshots = db + '-files/snapshots'
            const files = readdirSync(snapshots)
            expect(files).toHaveLength(1)
            const path = join(snapshots, files[0]!)
            if (fault === 'missing') rmSync(path)
            else truncateSync(path, 0)

            for (const action of [publish, append, snapshot]) {
                const response = await action()
                expect(response.status).toBe(503)
                expect(await response.json()).toMatchObject({ error: 'Current page checkpoint is unavailable' })
            }

            // Repair from the known good file. It is the same publication,
            // not a license to re-append the operation or create a new head.
            writeFileSync(path, checkpoint)
            expect(await (await publish()).json()).toEqual(received)
            expect(await (await append()).json()).toEqual(range)
        } finally {
            await relay?.stop()
            rmSync(dir, { recursive: true, force: true })
        }
    },
    20_000,
)

test('a missing current checkpoint cannot re-seed an obsolete legacy page', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-receipt-legacy-'))
    const db = join(dir, 'relay.sqlite')
    const store = new CloudStore(db)
    const inspect = new Database(db)
    try {
        const seq = store.putSnapshot(...PAGE_KEY, encodeSnapshot(tabletFile(), overlay))
        inspect.run('INSERT INTO pages (user_id, doc, page, bytes, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
            [...PAGE_KEY, blank, 'obsolete-legacy-page', 0])
        const { path } = inspect.query<{ path: string }, [number]>('SELECT path FROM page_snapshots WHERE seq=?').get(seq)!
        rmSync(path)
        expect(store.seedSnapshotFromBlob(...PAGE_KEY)).toBe(false)
        expect(store.latestSnapshotSeq(...PAGE_KEY)).toBe(seq)
        expect(store.getSnapshotBytes(...PAGE_KEY, seq)).toBeNull()
    } finally {
        inspect.close()
        rmSync(dir, { recursive: true, force: true })
    }
})

test.each(['checkpoint file', 'checkpoint directory'] as const)(
    'a guarded snapshot never acknowledges before syncing its %s',
    async fault => {
        process.env.CLOUD_DEV_USER = '1'
        const dir = mkdtempSync(join(tmpdir(), 'weft-guarded-receipt-sync-'))
        const db = join(dir, 'relay.sqlite')
        const files = join(db + '-files', 'snapshots')
        let cloud = startCloud({ port: 0, db })
        const baseSeq = cloud.store.putSnapshot(...PAGE_KEY, encodeSnapshot(blank, overlay))
        const publication = crypto.randomUUID()
        const bytes = encodeSnapshot(tabletFile(), overlay)
        const publish = () => fetch(`http://localhost:${cloud.port}/api/documents/${DOC}/pages/${PAGE}/snapshot`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${TOKEN}`,
                'x-snapshot-publication-id': publication,
                'x-snapshot-base-seq': String(baseSeq),
            },
            body: Buffer.from(bytes),
        })
        const store = cloud.store as unknown as { syncPath(path: string): void }
        const sync = store.syncPath.bind(store)
        const before = readdirSync(files)
        let triggered = false
        store.syncPath = path => {
            if ((fault === 'checkpoint directory' && path === files) ||
                (fault === 'checkpoint file' && path.startsWith(files + '/'))) {
                triggered = true
                throw new Error('injected guarded receipt fsync failure')
            }
            sync(path)
        }
        const inspect = () => {
            using dbInspect = new Database(db, { readonly: true })
            return dbInspect.query<{ seq: number }, []>('SELECT seq FROM page_snapshot_receipts').all()
        }
        try {
            let failed = false
            try { failed = !(await publish()).ok } catch { failed = true }
            expect(triggered).toBe(true)
            expect(failed).toBe(true)
            expect(inspect()).toEqual([])
            expect(readdirSync(files)).toEqual(before)
            expect(cloud.store.latestSnapshot(...PAGE_KEY)?.seq).toBe(baseSeq)

            cloud.stop()
            cloud = startCloud({ port: 0, db })
            expect(inspect()).toEqual([])
            // Simulate losing this successful response: retry the same wire
            // bytes and ID after another independent store restart.
            expect((await publish()).ok).toBe(true)
            const saved = inspect()
            expect(saved).toHaveLength(1)
            expect(saved[0]!.seq).toBeGreaterThan(baseSeq)
            cloud.stop()
            cloud = startCloud({ port: 0, db })
            const retry = await publish()
            expect(retry.ok).toBe(true)
            expect((await retry.json() as { seq: number }).seq).toBe(saved[0]!.seq)
            expect(inspect()).toEqual(saved)
            expect(cloud.store.latestSnapshot(...PAGE_KEY)?.seq).toBe(saved[0]!.seq)
        } finally {
            cloud.stop()
            rmSync(dir, { recursive: true, force: true })
        }
    },
)
