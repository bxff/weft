/**
 * #38 durability: point-in-time backups. A backup is a VACUUM-INTO DB snapshot
 * plus a copy of the on-disk blob tree; pruning keeps the most recent N.
 */

import { expect, setSystemTime, test } from 'bun:test'
import { cpSync, mkdtempSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Database } from 'bun:sqlite'
import { RmDocument } from '@weft/rm-format'
import { encodeSnapshot } from '@weft/sync-engine'
import { CloudStore, SNAPSHOT_KEEP } from '../src/store'

const body = new Uint8Array(64).fill(9)
const author = 'aaaaaaaa-0000-4000-a000-000000000001'

function restoreBackup(archive: string, dir: string): CloudStore {
    mkdirSync(dir)
    cpSync(join(archive, 'weft.db'), join(dir, 'restored.db'))
    cpSync(join(archive, 'files'), join(dir, 'restored.db-files'), { recursive: true })
    return new CloudStore(join(dir, 'restored.db'))
}

test('backup snapshots the DB + blob tree; data is recoverable', () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'weft-db-'))
    const store = new CloudStore(join(dbDir, 'live.db'))
    store.putDocuments('u', JSON.stringify({ documents: [{ id: 'd1', name: 'Doc One' }] }))
    store.putPage('u', 'd1', 'p1', '', new Uint8Array([1, 2, 3, 4]), 'c')
    store.putFile('u', 'd1', body, 'application/pdf')

    const dest = mkdtempSync(join(tmpdir(), 'weft-bak-'))
    const dir = store.backup(dest)

    // DB snapshot opens and carries the rows
    expect(existsSync(join(dir, 'weft.db'))).toBe(true)
    const bdb = new Database(join(dir, 'weft.db'), { readonly: true })
    const page = bdb
        .query<{ revision: string }, [string]>('SELECT revision FROM pages WHERE user_id=?')
        .get('u')
    expect(page).toBeTruthy()
    const fileRow = bdb.query('SELECT path, size FROM files WHERE user_id=?').get('u') as {
        size: number
    } | null
    expect(fileRow?.size).toBe(64)
    bdb.close()

    // blob tree copied alongside
    expect(existsSync(join(dir, 'files'))).toBe(true)
})

test('pruneBackups keeps only the most recent N', () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'weft-db-'))
    const store = new CloudStore(join(dbDir, 'live.db'))
    store.putFile('u', 'd1', body, 'application/pdf')

    const dest = mkdtempSync(join(tmpdir(), 'weft-bak-'))
    const a = store.backup(dest)
    const b = store.backup(dest)
    const c = store.backup(dest)
    expect(readdirSync(dest).length).toBe(3)

    store.pruneBackups(dest, 2)
    expect(existsSync(a)).toBe(false) // oldest pruned
    expect(existsSync(b)).toBe(true)
    expect(existsSync(c)).toBe(true)
    expect(readdirSync(dest).length).toBe(2)
})

test('pruneBackups is a no-op when under the keep count', () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'weft-db-'))
    const store = new CloudStore(join(dbDir, 'live.db'))
    const dest = mkdtempSync(join(tmpdir(), 'weft-bak-'))
    store.backup(dest)
    store.pruneBackups(dest, 10)
    expect(readdirSync(dest).length).toBe(1)
})

test.each([['present'], ['removed']] as const)('restored relay reads its copied blobs with the original volume %s', (originalVolume) => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-restore-'))
    try {
        const live = new CloudStore(join(dir, 'live.db'))
        const liveFiles = join(dir, 'live.db-files')
        live.putFile('u', 'd1', body)
        const sourceName = basename(live.getFileRef('u', 'd1')!.path)
        const rm = RmDocument.empty(author).serialize()
        const snapshot = encodeSnapshot(rm, { shapes: [] })
        const seq = live.putSnapshot('u', 'd1', 'p1', snapshot)
        const [snapshotName] = readdirSync(join(liveFiles, 'snapshots'))
        const archive = live.backup(join(dir, 'archive'))

        if (originalVolume === 'present') {
            live.putFile('u', 'd1', new Uint8Array([1, 2, 3]))
            writeFileSync(join(liveFiles, 'snapshots', snapshotName!), new Uint8Array([4, 5, 6]))
        } else {
            rmSync(liveFiles, { recursive: true })
        }

        const restoredDir = join(dir, 'restored')
        const restored = restoreBackup(archive, restoredDir)
        expect(restored.getFileRef('u', 'd1')).toMatchObject({
            path: join(restoredDir, 'restored.db-files', sourceName),
            size: body.length,
        })
        expect(restored.getFile('u', 'd1')).toEqual(body)
        expect(restored.latestSnapshot('u', 'd1', 'p1')?.bytes).toEqual(snapshot)
        expect(restored.getSnapshotBytes('u', 'd1', 'p1', seq)).toEqual(snapshot)
        expect(restored.stateAt('u', 'd1', 'p1', 0).rm).toEqual(rm)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('restored relay deletes source and snapshot blobs only from its copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-restore-cleanup-'))
    try {
        const live = new CloudStore(join(dir, 'live.db'))
        const liveSnapshots = join(dir, 'live.db-files', 'snapshots')
        const rm = RmDocument.empty(author).serialize()
        const snapshot = encodeSnapshot(rm, { shapes: [] })
        live.putFile('u', 'd1', body)
        const liveSource = live.getFileRef('u', 'd1')!.path
        const pruneSeq = live.putSnapshot('u', 'd1', 'prune', snapshot)
        const [pruneName] = readdirSync(liveSnapshots)
        const clearSeq = live.putSnapshot('u', 'd1', 'clear', snapshot, true)
        const clearName = readdirSync(liveSnapshots).find((name) => name !== pruneName)!
        const noop = new TextEncoder().encode('{"op":"test-noop"}')
        live.appendOps('u', 'd1', 'clear', [noop, noop, noop], author)

        const restoredDir = join(dir, 'restored')
        const restored = restoreBackup(live.backup(join(dir, 'archive')), restoredDir)
        const restoredFiles = join(restoredDir, 'restored.db-files')
        expect(restored.deleteFile('u', 'd1')).toBe(body.length)
        expect(readFileSync(liveSource)).toEqual(Buffer.from(body))
        expect(existsSync(join(restoredFiles, basename(liveSource)))).toBe(false)

        for (let i = 0; i < SNAPSHOT_KEEP; i++) restored.putSnapshot('u', 'd1', 'prune', snapshot)
        expect(restored.getSnapshotBytes('u', 'd1', 'prune', pruneSeq)).toBeNull()
        expect(existsSync(join(restoredFiles, 'snapshots', pruneName!))).toBe(false)
        expect(live.getSnapshotBytes('u', 'd1', 'prune', pruneSeq)).toEqual(snapshot)

        expect(restored.clearPageHistory('u', 'd1', 'clear').snapshotsDeleted).toBeGreaterThan(0)
        expect(restored.getSnapshotBytes('u', 'd1', 'clear', clearSeq)).toBeNull()
        expect(existsSync(join(restoredFiles, 'snapshots', clearName))).toBe(false)
        expect(live.getSnapshotBytes('u', 'd1', 'clear', clearSeq)).toEqual(snapshot)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('stored blob paths cannot direct reads or cleanup to an unrelated file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-restore-path-'))
    try {
        const dbPath = join(dir, 'weft.db')
        const store = new CloudStore(dbPath)
        const outside = join(dir, 'unrelated-file')
        writeFileSync(outside, body)
        store.putFile('u', 'd1', body)
        const seq = store.putSnapshot('u', 'd1', 'p1', body)
        const db = new Database(dbPath)
        try {
            db.run('UPDATE files SET path = ?', [outside])
            db.run('UPDATE page_snapshots SET path = ?', [outside])
        } finally {
            db.close()
        }

        expect(store.getFile('u', 'd1')).toBeNull()
        expect(store.getSnapshotBytes('u', 'd1', 'p1', seq)).toBeNull()
        expect(store.deleteFile('u', 'd1')).toBe(0)
        for (let i = 0; i < SNAPSHOT_KEEP; i++) store.putSnapshot('u', 'd1', 'p1', body)
        expect(existsSync(outside)).toBe(true)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('published archive opens with the existing database and blob layout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-backup-restore-'))
    try {
        const live = join(dir, 'live')
        mkdirSync(live)
        const dbPath = join(live, 'weft.db')
        const store = new CloudStore(dbPath)
        const snapshot = new Uint8Array([1, 2, 3])
        store.putFile('u', 'd1', body)
        const seq = store.putSnapshot('u', 'd1', 'p1', snapshot)

        const archive = store.backup(join(dir, "server's backups"))
        // Restore in place after taking the original database and blobs offline.
        renameSync(live, join(dir, 'previous-volume'))
        mkdirSync(live)
        cpSync(join(archive, 'weft.db'), dbPath)
        cpSync(join(archive, 'files'), join(live, 'weft.db-files'), { recursive: true })
        const restored = new CloudStore(dbPath)
        expect(restored.getFile('u', 'd1')).toEqual(body)
        expect(restored.getSnapshotBytes('u', 'd1', 'p1', seq)).toEqual(snapshot)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test.each([
    ['missing referenced snapshot', 'snapshot', (path: string) => rmSync(path)],
    ['wrong size snapshot', 'snapshot', (path: string) => writeFileSync(path, new Uint8Array(1))],
    ['same size changed source', 'source', (path: string) => writeFileSync(path, new Uint8Array(body.length))],
    ['directory in place of a source', 'source', (path: string) => {
        rmSync(path)
        mkdirSync(path)
    }],
] as const)('backup rejects %s and preserves the last complete archive', (_case, kind, change) => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-backup-failed-'))
    try {
        const store = new CloudStore(join(dir, 'live.db'))
        const dest = join(dir, 'archives')
        const snapshot = new Uint8Array([1, 2, 3])
        store.putFile('u', 'd1', body)
        const sourcePath = store.getFileRef('u', 'd1')!.path
        store.putSnapshot('u', 'd1', 'p1', snapshot)
        const snapshotDir = join(dir, 'live.db-files', 'snapshots')
        const [snapshotName] = readdirSync(snapshotDir)
        const complete = store.backup(dest)

        change(kind === 'snapshot' ? join(snapshotDir, snapshotName!) : sourcePath)
        expect(() => store.backup(dest)).toThrow()
        expect(readdirSync(dest)).toEqual([basename(complete)])
        expect(readFileSync(join(complete, 'files', basename(sourcePath)))).toEqual(Buffer.from(body))
        expect(readFileSync(join(complete, 'files', 'snapshots', snapshotName!))).toEqual(Buffer.from(snapshot))
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('two stores publishing in the same millisecond keep distinct completed archives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-backup-collision-'))
    setSystemTime(new Date('2026-11-20T00:00:00.000Z'))
    try {
        const first = new CloudStore(join(dir, 'first.db'))
        const second = new CloudStore(join(dir, 'second.db'))
        const dest = join(dir, 'archives')
        const a = first.backup(dest)
        const b = second.backup(dest)
        expect(a).not.toBe(b)
        expect(readdirSync(dest).sort()).toEqual([basename(a), basename(b)])
        second.pruneBackups(dest, 1)
        expect(readdirSync(dest)).toEqual([basename(b)])
        const c = first.backup(dest)
        first.pruneBackups(dest, 1)
        expect(readdirSync(dest)).toEqual([basename(c)])
    } finally {
        setSystemTime()
        rmSync(dir, { recursive: true, force: true })
    }
})
