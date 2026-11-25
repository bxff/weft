/**
 * FakeDaemon implements the op + snapshot channel like the cloud relay
 * (opaque blobs, monotonic per-page seq, snapshot pins its op head).
 */

import { describe, expect, test } from 'bun:test'
import { FakeDaemon } from '../src/fake-daemon'
import { EngineFailure } from '../src/types'
import type { PageChangedEvent } from '../src/transport'

const DOC = 'doc-1'
const PAGE = 'page-1'
const op = (s: string) => new TextEncoder().encode(s)

describe('FakeDaemon op channel', () => {
    test('appendOps assigns increasing seqs; opsSince streams in order from a cursor', async () => {
        const d = FakeDaemon.withBlankPage(DOC, PAGE)
        const r1 = await d.appendOps(DOC, PAGE, [op('a'), op('b')], 'authorA')
        const r2 = await d.appendOps(DOC, PAGE, [op('c')], 'authorB')
        expect(r2.firstSeq).toBe(r1.lastSeq + 1)

        const all = await d.opsSince(DOC, PAGE, 0)
        expect(all.map((o) => new TextDecoder().decode(o.op))).toEqual(['a', 'b', 'c'])
        expect(all[0]!.author).toBe('authorA')
        expect(all[2]!.author).toBe('authorB')
        // resume cursor
        expect(await d.opsSince(DOC, PAGE, r1.lastSeq)).toHaveLength(1)
        expect(await d.opsSince(DOC, PAGE, r2.lastSeq)).toEqual([])
    })

    test('empty appendOps reports the current head without notifying', async () => {
        const d = FakeDaemon.withBlankPage(DOC, PAGE)
        await d.appendOps(DOC, PAGE, [op('x')], null)
        let events = 0
        d.subscribe(() => events++)
        const r = await d.appendOps(DOC, PAGE, [], null)
        expect(r.lastSeq).toBe(1)
        expect(events).toBe(0)
    })

    test('appendOps notifies subscribers with an ops revision marker', async () => {
        const d = FakeDaemon.withBlankPage(DOC, PAGE)
        const seen: PageChangedEvent[] = []
        d.subscribe((e) => seen.push(e))
        await d.appendOps(DOC, PAGE, [op('a'), op('b')], 'authorA')
        expect(seen).toHaveLength(1)
        expect(seen[0]!.revision).toBe('ops:2')
        expect(seen[0]!.origin).toBe('client')
    })

    test('snapshot pins the op head it folds in; reconstruct cursor is opsSince(opSeq)', async () => {
        const d = FakeDaemon.withBlankPage(DOC, PAGE)
        expect(await d.getSnapshot(DOC, PAGE)).toBeNull()

        await d.appendOps(DOC, PAGE, [op('a'), op('b')], null)
        await d.putSnapshot(DOC, PAGE, new Uint8Array([1, 2, 3]))
        const snap = (await d.getSnapshot(DOC, PAGE))!
        expect(snap.opSeq).toBe(2)
        expect([...snap.bytes]).toEqual([1, 2, 3])

        await d.appendOps(DOC, PAGE, [op('c')], null)
        const tail = await d.opsSince(DOC, PAGE, snap.opSeq)
        expect(tail.map((o) => new TextDecoder().decode(o.op))).toEqual(['c'])
    })

    test('op logs are isolated per page', async () => {
        const d = FakeDaemon.withBlankPage(DOC, PAGE)
        await d.appendOps(DOC, PAGE, [op('p1')], null)
        await d.appendOps(DOC, 'page-2', [op('p2')], null)
        expect((await d.opsSince(DOC, PAGE, 0)).map((o) => new TextDecoder().decode(o.op))).toEqual(['p1'])
        expect((await d.opsSince(DOC, 'page-2', 0)).map((o) => new TextDecoder().decode(o.op))).toEqual(['p2'])
    })

    test('truncate raises the floor; opsSince below it fails with OpsTruncated (the 410-equivalent, #52)', async () => {
        const d = FakeDaemon.withBlankPage(DOC, PAGE)
        await d.appendOps(DOC, PAGE, [op('a'), op('b'), op('c'), op('d')], 'authorA')
        d.truncate(DOC, PAGE, 2)

        // ops <= 2 are gone; the retained tail streams normally from the floor
        expect((await d.opsSince(DOC, PAGE, 2)).map((o) => new TextDecoder().decode(o.op))).toEqual([
            'c',
            'd',
        ])
        // a cursor below the floor predates the retained log -> typed failure
        // (the cloud's HTTP 410), never a silently gapped 200
        let err: unknown = null
        try {
            await d.opsSince(DOC, PAGE, 0)
        } catch (e) {
            err = e
        }
        expect(err).toBeInstanceOf(EngineFailure)
        expect((err as EngineFailure).error).toEqual({ _tag: 'OpsTruncated', floorSeq: 2 })

        // truncating below the existing floor is a no-op (floor is monotonic)
        d.truncate(DOC, PAGE, 1)
        err = null
        try {
            await d.opsSince(DOC, PAGE, 1)
        } catch (e) {
            err = e
        }
        expect((err as EngineFailure).error).toEqual({ _tag: 'OpsTruncated', floorSeq: 2 })

        // seq allocation is not reset by truncation (mirrors AUTOINCREMENT):
        // the next append lands above the floor, never below it
        const r = await d.appendOps(DOC, PAGE, [op('e')], 'authorA')
        expect(r.firstSeq).toBe(5)

        // pages without truncation keep floor 0 semantics: since=0 streams all
        await d.appendOps(DOC, 'page-2', [op('x')], null)
        expect(await d.opsSince(DOC, 'page-2', 0)).toHaveLength(1)
    })
})
