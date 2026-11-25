import { Database } from 'bun:sqlite'
import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeOp } from '@weft/sync-engine'
import { CloudStore } from '../src/store'

const operation = encodeOp({ op: 'delete-object', id: 'gone', version: { ts: 1, actor: 'test' } })
const bytes = Uint8Array.of(1, 2, 3)
const database = (store: CloudStore) => (store as unknown as { db: Database }).db

test('revision sweep includes each storage mode once and isolates users', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-revision-modes-'))
    const store = new CloudStore(join(dir, 'relay.sqlite'))
    try {
        expect(store.pageRevisions('absent')).toEqual({})
        store.putPage('u', 'doc', 'blob', '', bytes, 'test')
        store.appendOps('u', 'doc', 'ops', [operation], 'test')
        store.putSnapshot('u', 'doc', 'snapshot', bytes)
        store.putPage('u', 'doc', 'mixed', '', bytes, 'test')
        store.appendOps('u', 'doc', 'mixed', [operation, operation], 'test')
        store.putSnapshot('u', 'doc', 'mixed', bytes)
        store.putPage('other', 'doc', 'private', '', bytes, 'test')

        const revisions = store.pageRevisions('u')
        expect(Object.keys(revisions).sort()).toEqual(['doc/blob', 'doc/mixed', 'doc/ops', 'doc/snapshot'])
        expect(revisions['doc/blob']).toMatch(/^[0-9a-f]{64}$/)
        for (const page of ['ops', 'snapshot', 'mixed']) {
            expect(revisions[`doc/${page}`]).toBe(`ops:${store.latestOpSeq('u', 'doc', page)}+${store.latestSnapshotSeq('u', 'doc', page)}`)
        }
    } finally {
        database(store).close()
        rmSync(dir, { recursive: true, force: true })
    }
})

test('revision sweep never mixes heads across a concurrent committed update', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-revisions-'))
    const path = join(dir, 'relay.sqlite')
    const reader = new CloudStore(path), writer = new CloudStore(path)
    const db = database(reader), peer = database(writer)
    for (const page of ['a', 'b']) {
        writer.appendOps('u', 'doc', page, [operation], 'test')
        writer.putSnapshot('u', 'doc', page, bytes)
    }
    const before = reader.pageRevisions('u')
    const query = db.query.bind(db)
    let committed = false
    // Interleave a real second-connection commit after the first completed
    // statement that reads a sequence. A sweep must represent one generation,
    // whether the commit happens before or after that generation was captured.
    const hook = spyOn(db, 'query').mockImplementation((sql: string) => {
        const statement = query(sql)
        if (!/MAX\(seq\)/i.test(sql)) return statement
        return new Proxy(statement, {
            get(target, property, receiver) {
                if (property !== 'get' && property !== 'all') return Reflect.get(target, property, receiver)
                return (...args: unknown[]) => {
                    const result = Reflect.apply(target[property], target, args)
                    if (!committed) {
                        committed = true
                        peer.transaction(() => {
                            for (const page of ['a', 'b']) {
                                writer.appendOps('u', 'doc', page, [operation], 'peer')
                                writer.putSnapshot('u', 'doc', page, bytes)
                            }
                        })()
                    }
                    return result
                }
            },
        })
    })
    try {
        const revisions = reader.pageRevisions('u')
        hook.mockRestore()
        const after = writer.pageRevisions('u')
        expect(committed).toBe(true)
        expect(after).not.toEqual(before)
        expect([before, after]).toContainEqual(revisions)
    } finally {
        hook.mockRestore()
        db.close()
        peer.close()
        rmSync(dir, { recursive: true, force: true })
    }
})
