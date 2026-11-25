/**
 * MULTI-TABLET doc-list authority: a device may only delete docs it
 * previously REPORTED having (its manifest), deletions are LWW tombstones
 * (never row removals), and sibling-tablet docs get create-annotated so
 * daemons materialize them. The old single-tablet reading ("absent from my
 * authoritative tree = deleted") let a second tablet's first push wipe the
 * first tablet's library.
 */
import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CloudStore } from '../src/store'

const U = 'u'
const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)

function freshStore(): CloudStore {
    return new CloudStore(join(mkdtempSync(join(tmpdir(), 'weft-mdev-')), 't.db'))
}

const doc = (id: string, name: string, lm: number, extra: object = {}) => ({
    id,
    name,
    parent: '',
    type: 'notebook',
    pages: [{ id: `${id}-p1` }],
    lastModified: lm,
    ...extra,
})

const push = (s: CloudStore, key: string | null, docs: object[]) =>
    s.mergeDocuments(U, JSON.stringify({ documents: docs }), key)

const stored = (s: CloudStore): Map<string, { deleted?: boolean; name?: string; lastModified?: number }> => {
    const parsed = JSON.parse(s.getDocuments(U)) as { documents: { id: string }[] }
    return new Map(parsed.documents.map((d) => [d.id, d as never]))
}

test("a second tablet's first push does NOT delete the first tablet's docs", () => {
    const s = freshStore()
    push(s, KEY_A, [doc('x', 'X', 100), doc('y', 'Y', 100)])
    // THE old catastrophe: B's authoritative push lacks x and y entirely
    push(s, KEY_B, [doc('z', 'Z', 200)])
    const m = stored(s)
    expect(m.get('x')?.deleted).toBeUndefined()
    expect(m.get('y')?.deleted).toBeUndefined()
    expect(m.has('z')).toBe(true)
})

test('a device deletes ONLY docs from its own manifest, as tombstones', () => {
    const s = freshStore()
    push(s, KEY_A, [doc('x', 'X', 100), doc('y', 'Y', 100)])
    push(s, KEY_B, [doc('z', 'Z', 100)])
    // A trashed x on-device: absent from its next push, still in its manifest
    push(s, KEY_A, [doc('y', 'Y', 100)])
    const m = stored(s)
    expect(m.get('x')?.deleted).toBe(true) // tombstone, not a removed row
    expect(m.get('y')?.deleted).toBeUndefined()
    expect(m.get('z')?.deleted).toBeUndefined() // NOT A's to delete
})

test('a stale sibling cannot resurrect a tombstoned doc (LWW)', () => {
    const s = freshStore()
    push(s, KEY_A, [doc('x', 'X', 100)])
    push(s, KEY_B, [doc('x', 'X', 100)]) // B synced x too
    push(s, KEY_A, []) // empty-push guard: deletes nothing
    expect(stored(s).get('x')?.deleted).toBeUndefined()
    push(s, KEY_A, [doc('other', 'O', 150)]) // x absent -> tombstoned
    expect(stored(s).get('x')?.deleted).toBe(true)
    const tombLm = stored(s).get('x')!.lastModified!
    // B (offline during the delete) pushes its STALE copy of x
    push(s, KEY_B, [doc('x', 'X', 100), doc('other', 'O', 150)])
    expect(stored(s).get('x')?.deleted).toBe(true) // tombstone survived
    expect(stored(s).get('x')?.lastModified).toBe(tombLm)
})

test('an edit NEWER than the tombstone revives the doc (edit beats delete)', () => {
    const s = freshStore()
    push(s, KEY_A, [doc('x', 'X', 100)])
    push(s, KEY_A, [doc('other', 'O', 150)]) // tombstones x
    const tombLm = stored(s).get('x')!.lastModified!
    push(s, KEY_B, [doc('x', 'X renamed', tombLm + 10), doc('other', 'O', 150)])
    expect(stored(s).get('x')?.deleted).toBeUndefined()
    expect(stored(s).get('x')?.name).toBe('X renamed')
})

test('web writers still have no deletion authority (null deviceKey)', () => {
    const s = freshStore()
    push(s, KEY_A, [doc('x', 'X', 100)])
    push(s, null, [doc('w', 'W', 200)]) // web merge omits x
    expect(stored(s).get('x')?.deleted).toBeUndefined()
})

test('create:true (web-created, unmaterialized) stays protected from absence', () => {
    const s = freshStore()
    push(s, KEY_A, [doc('x', 'X', 100)])
    push(s, null, [doc('newdoc', 'New', 200, { create: true })])
    push(s, KEY_A, [doc('x', 'X', 100)]) // daemon list lacks newdoc
    const m = stored(s)
    expect(m.has('newdoc')).toBe(true)
    expect(m.get('newdoc')?.deleted).toBeUndefined()
})

test('deviceManifest reflects the latest push', () => {
    const s = freshStore()
    push(s, KEY_A, [doc('x', 'X', 100), doc('y', 'Y', 100)])
    expect([...s.deviceManifest(U, KEY_A)].sort()).toEqual(['x', 'y'])
    push(s, KEY_A, [doc('y', 'Y', 100)])
    expect([...s.deviceManifest(U, KEY_A)]).toEqual(['y'])
    expect(s.deviceManifest(U, KEY_B).size).toBe(0)
})

test('an EXCLUDED doc absent from the push is hidden, never tombstoned', () => {
    const s = freshStore()
    push(s, KEY_A, [doc('x', 'X', 100), doc('y', 'Y', 100)])
    s.setSyncExclusions(U, ['x'])
    // the daemon filters excluded docs from its next push
    push(s, KEY_A, [doc('y', 'Y', 100)])
    const m = stored(s)
    expect(m.has('x')).toBe(false) // row dropped (hidden), no deleted:true
    expect(m.get('y')?.deleted).toBeUndefined()
    // re-inclusion: the daemon pushes it again and it simply returns
    s.setSyncExclusions(U, [])
    push(s, KEY_A, [doc('x', 'X', 100), doc('y', 'Y', 100)])
    expect(stored(s).get('x')?.deleted).toBeUndefined()
})

test('UPGRADE: a fresh manifest deletes NOTHING and legacy docs never re-materialize', () => {
    const s = freshStore()
    // pre-manifest era: docs exist in the cloud with NO manifest rows
    push(s, null, [doc('x', 'X', 100), doc('y', 'Y', 100)])
    // the tablet deleted x during the upgrade window; its first post-upgrade
    // push lacks x. NO seeding (the re-audit proved a full-tree seed could
    // tombstone a sibling's docs via the startup push): x lingers VISIBLY
    // instead of being guessed-deleted...
    push(s, KEY_A, [doc('y', 'Y', 100)])
    expect(stored(s).get('x')?.deleted).toBeUndefined()
    // ...and, backed by no device manifest, it may never auto-materialize
    // (the create annotation requires docKnownToSomeDevice)
    expect(s.docKnownToSomeDevice(U, 'x')).toBe(false)
    expect(s.docKnownToSomeDevice(U, 'y')).toBe(true)
    // a true second tablet still deletes nothing on its first push
    push(s, KEY_B, [doc('z', 'Z', 100)])
    expect(stored(s).get('y')?.deleted).toBeUndefined()
})

test('TEMPLATE register: a web pick survives a device echo with a newer whole-doc lm', () => {
    const s = freshStore()
    push(s, KEY_A, [doc('x', 'X', 100)])
    // web picks a template (server stamps the per-page register)
    s.setPageTemplate(U, 'x', 'x-p1', 'P Grid large')
    // the tablet edits CONTENT (lm bumps far ahead) and echoes the doc; its
    // pages carry the template it has - after applying the pick, the SAME
    // value (carry-through: claims nothing)
    push(s, KEY_A, [
        { ...doc('x', 'X', Date.now() + 60_000), pages: [{ id: 'x-p1', template: 'P Grid large' }] },
    ])
    const pages = (stored(s).get('x') as unknown as { pages: { id: string; template?: string }[] }).pages
    expect(pages.find((p) => p.id === 'x-p1')?.template).toBe('P Grid large')
    // but a REAL tablet-side template change (different value, newer lm) wins
    push(s, KEY_A, [
        { ...doc('x', 'X', Date.now() + 120_000), pages: [{ id: 'x-p1', template: 'P Lines small' }] },
    ])
    const pages2 = (stored(s).get('x') as unknown as { pages: { id: string; template?: string }[] }).pages
    expect(pages2.find((p) => p.id === 'x-p1')?.template).toBe('P Lines small')
})

test('GHOST exclusion: deleted-on-tablet-while-excluded rows prune; held docs stay', () => {
    const s = freshStore()
    push(s, KEY_A, [doc('q', 'Quran', 100), doc('y', 'Y', 100)])
    s.setSyncExclusions(U, ['q'])
    // the daemon's next push FILTERS q (dropping it from the manifest) and
    // its sidecar reports q as still-present -> row survives
    push(s, KEY_A, [doc('y', 'Y', 100)])
    s.reconcileExcludedPresence(U, KEY_A, ['q'])
    expect(s.getSyncExclusions(U)).toEqual(['q'])
    // user deletes q ON the tablet: next sidecar omits it -> ghost pruned
    s.reconcileExcludedPresence(U, KEY_A, [])
    expect(s.getSyncExclusions(U)).toEqual([])
})

test('GHOST exclusion: a SIBLING device still holding the doc keeps the row', () => {
    const s = freshStore()
    push(s, KEY_A, [doc('q', 'Quran', 100), doc('other', 'O', 100)])
    push(s, KEY_B, [doc('q', 'Quran', 100), doc('other', 'O', 100)])
    s.setSyncExclusions(U, ['q'])
    // both daemons push filtered lists (q leaves both manifests; the pushes
    // stay non-empty - a zero-doc push never updates a manifest by design)
    push(s, KEY_A, [doc('other', 'O', 100)])
    push(s, KEY_B, [doc('other', 'O', 100)])
    s.reconcileExcludedPresence(U, KEY_A, ['q'])
    s.reconcileExcludedPresence(U, KEY_B, ['q'])
    // A deletes it; B still has it -> exclusion row must stay
    s.reconcileExcludedPresence(U, KEY_A, [])
    expect(s.getSyncExclusions(U)).toEqual(['q'])
    // B deletes it too -> now it is a ghost everywhere -> pruned
    s.reconcileExcludedPresence(U, KEY_B, [])
    expect(s.getSyncExclusions(U)).toEqual([])
})

test('a LIVE child of a tombstoned folder clamps to root (stays reachable)', () => {
    const s = freshStore()
    push(s, KEY_A, [
        { ...doc('f', 'Folder', 100), type: 'folder' },
        { ...doc('c', 'Child', 100), parent: 'f' },
    ])
    // B synced only the folder; deleting it on B tombstones f while c
    // (not in B's manifest) stays live with parent=f
    push(s, KEY_B, [{ ...doc('f', 'Folder', 100), type: 'folder' }, doc('z', 'Z', 100)])
    push(s, KEY_B, [doc('z', 'Z', 100)])
    const m = stored(s)
    expect(m.get('f')?.deleted).toBe(true)
    expect(m.get('c')?.deleted).toBeUndefined()
    expect((m.get('c') as unknown as { parent: string }).parent).toBe('') // clamped: visible at root
})
