/**
 * #45 step 2: cloud op-relay storage (page_ops + page_snapshots). The cloud
 * stores/relays opaque op + snapshot bytes — it never parses them.
 */

import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { CloudStore, OPS_PAGE_LIMIT, SNAPSHOT_KEEP } from '../src/store'

const D = 'doc1'
const P = 'page1'
const op = (s: string) => new TextEncoder().encode(s)

function freshStore(): CloudStore {
    return new CloudStore(join(mkdtempSync(join(tmpdir(), 'weft-ops-')), 't.db'))
}

test('appendOps assigns increasing seqs; opsSince streams them in order', () => {
    const s = freshStore()
    expect(s.latestOpSeq('u', D, P)).toBe(0)

    const r1 = s.appendOps('u', D, P, [op('a'), op('b')], 'authorA')
    expect(r1.lastSeq).toBeGreaterThan(r1.firstSeq - 1)
    const r2 = s.appendOps('u', D, P, [op('c')], 'authorA')
    expect(r2.firstSeq).toBeGreaterThan(r1.lastSeq)
    expect(s.latestOpSeq('u', D, P)).toBe(r2.lastSeq)

    const all = s.opsSince('u', D, P, 0)
    expect(all.map((o) => new TextDecoder().decode(o.op))).toEqual(['a', 'b', 'c'])
    expect(all.map((o) => o.seq)).toEqual([...all.map((o) => o.seq)].sort((x, y) => x - y))
    expect(all[0]!.author).toBe('authorA')

    // resume cursor: nothing new past the last seq
    expect(s.opsSince('u', D, P, r2.lastSeq)).toEqual([])
    // partial: only ops after the first batch
    expect(s.opsSince('u', D, P, r1.lastSeq).map((o) => new TextDecoder().decode(o.op))).toEqual(['c'])
})

test('opsSince pages at OPS_PAGE_LIMIT; the head cursor drives the next page', () => {
    const s = freshStore()
    const n = OPS_PAGE_LIMIT + 1
    s.appendOps(
        'u',
        D,
        P,
        Array.from({ length: n }, (_, i) => op(`op${i}`)),
        null,
    )
    const head = s.latestOpSeq('u', D, P)
    const page1 = s.opsSince('u', D, P, 0)
    expect(page1.length).toBe(OPS_PAGE_LIMIT) // capped
    expect(page1[page1.length - 1]!.seq).toBeLessThan(head) // more remain
    // resume from the last seq of page 1 -> the tail
    const page2 = s.opsSince('u', D, P, page1[page1.length - 1]!.seq)
    expect(page2.length).toBe(1)
    expect(page2[0]!.seq).toBe(head)
})

test('empty appendOps is a no-op that reports the current head', () => {
    const s = freshStore()
    s.appendOps('u', D, P, [op('x')], null)
    const head = s.latestOpSeq('u', D, P)
    const r = s.appendOps('u', D, P, [], null)
    expect(r.lastSeq).toBe(head)
    expect(s.latestOpSeq('u', D, P)).toBe(head)
})

test('ops are isolated per user and per page', () => {
    const s = freshStore()
    s.appendOps('u', D, P, [op('u-op')], null)
    s.appendOps('v', D, P, [op('v-op')], null)
    s.appendOps('u', D, 'page2', [op('u-p2')], null)

    expect(s.opsSince('u', D, P, 0).map((o) => new TextDecoder().decode(o.op))).toEqual(['u-op'])
    expect(s.opsSince('v', D, P, 0).map((o) => new TextDecoder().decode(o.op))).toEqual(['v-op'])
    expect(s.opsSince('u', D, 'page2', 0).map((o) => new TextDecoder().decode(o.op))).toEqual(['u-p2'])
})

test('snapshots prune to the latest SNAPSHOT_KEEP per page', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-snap-'))
    const dbPath = join(dir, 't.db')
    const s = new CloudStore(dbPath)
    const n = SNAPSHOT_KEEP + 3
    let lastSeq = 0
    for (let i = 0; i < n; i++) lastSeq = s.putSnapshot('u', D, P, new Uint8Array([i]))

    const count = (
        new Database(dbPath)
            .query('SELECT COUNT(*) AS c FROM page_snapshots WHERE user_id=? AND doc=? AND page=?')
            .get('u', D, P) as { c: number }
    ).c
    expect(count).toBe(SNAPSHOT_KEEP) // older rows pruned
    expect(s.latestSnapshot('u', D, P)!.seq).toBe(lastSeq) // newest retained
})

test('ops + snapshots count toward per-user usage (and prune refunds it)', () => {
    const s = freshStore()
    const before = s.usageBytes('u', 'created')
    s.appendOps('u', D, P, [op('hello'), op('world')], null) // 10 bytes of op blobs
    expect(s.usageBytes('u', 'created')).toBe(before + 10)

    // a snapshot adds its size; pruning past SNAPSHOT_KEEP refunds older ones
    const usageAfterOps = s.usageBytes('u', 'created')
    for (let i = 0; i < SNAPSHOT_KEEP + 1; i++) s.putSnapshot('u', D, P, new Uint8Array(100))
    // only SNAPSHOT_KEEP snapshots remain -> SNAPSHOT_KEEP*100 counted
    expect(s.usageBytes('u', 'created')).toBe(usageAfterOps + SNAPSHOT_KEEP * 100)
})

test('a snapshot pins the op-log head it folds in (reconstruct cursor)', () => {
    const s = freshStore()
    // no ops yet -> snapshot folds in op_seq 0
    s.putSnapshot('u', D, P, new Uint8Array([0]))
    expect(s.latestSnapshot('u', D, P)!.opSeq).toBe(0)

    // append 3 ops, snapshot -> folds in the current head (3)
    const r = s.appendOps('u', D, P, [op('a'), op('b'), op('c')], null)
    s.putSnapshot('u', D, P, new Uint8Array([1]))
    expect(s.latestSnapshot('u', D, P)!.opSeq).toBe(r.lastSeq)

    // more ops after the snapshot are NOT folded in: reconstruct replays them
    s.appendOps('u', D, P, [op('d')], null)
    expect(s.latestSnapshot('u', D, P)!.opSeq).toBe(r.lastSeq) // unchanged
    expect(s.opsSince('u', D, P, s.latestSnapshot('u', D, P)!.opSeq).map((o) => new TextDecoder().decode(o.op))).toEqual(['d'])
})

test('snapshots round-trip on disk; latest wins', () => {
    const s = freshStore()
    expect(s.latestSnapshot('u', D, P)).toBeNull()

    const seq1 = s.putSnapshot('u', D, P, new Uint8Array([1, 2, 3]))
    const seq2 = s.putSnapshot('u', D, P, new Uint8Array([4, 5, 6, 7]))
    expect(seq2).toBeGreaterThan(seq1)

    const latest = s.latestSnapshot('u', D, P)!
    expect(latest.seq).toBe(seq2)
    expect([...latest.bytes]).toEqual([4, 5, 6, 7])

    // per-user isolation
    expect(s.latestSnapshot('v', D, P)).toBeNull()
})
