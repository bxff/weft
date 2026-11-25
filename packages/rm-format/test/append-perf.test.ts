/**
 * appendLines correctness and the O(n^2)->O(n) page-build fix: appendLine
 * used to deep-scan the whole doc for maxClock + frontier per call, making a
 * P-stroke page O(P^2). appendLines computes both once per batch.
 */
import { describe, expect, test } from 'bun:test'
import { RmDocument, crdtId, crdtIdKey, Pen, PenColor, isLine } from '../src/index'
import { RESERVED_CLOCK_FLOOR } from '../src/crdt-id'
import { polylineToPoints } from '../../rm-ink/src/points'

const A = 'c8050a7c-0000-4000-a000-000000000001'
const mkLine = (x: number) => ({
    kind: 'line' as const, tool: Pen.MARKER_2, color: PenColor.BLACK, thicknessScale: 2,
    startingLength: 0, timestamp: crdtId(0, 1), moveId: null,
    points: polylineToPoints([{ x, y: 0 }, { x, y: 10 }], { width: 40 }),
})

describe('appendLines', () => {
    test('sequential global-Lamport ids, each chained onto the previous (E10)', () => {
        const doc = RmDocument.empty(A)
        const before = doc.maxClock()
        const blocks = doc.appendLines([mkLine(1), mkLine(2), mkLine(3)], { authorUuid: A })
        // clocks strictly ascending and all > prior global max (E-clock)
        const clocks = blocks.map((b) => b.itemId.part2)
        expect(clocks).toEqual([before + 1, before + 2, before + 3])
        // each leftId is the previous item (frontier advances), first = frontier
        expect(crdtIdKey(blocks[1]!.leftId)).toBe(crdtIdKey(blocks[0]!.itemId))
        expect(crdtIdKey(blocks[2]!.leftId)).toBe(crdtIdKey(blocks[1]!.itemId))
        // render order matches insert order
        const xs = [...doc.tree().walk()].filter(([, i]) => isLine(i)).map(([, i]) => (i as never as { points: { x: number }[] }).points[0]!.x)
        expect(xs).toEqual([1, 2, 3])
        // byte-exact round trip
        const { readBlocks, writeBlocks } = require('../src/index') as typeof import('../src/index')
        const bytes = doc.serialize()
        expect(writeBlocks([...readBlocks(bytes)])).toEqual(bytes)
    })

    test('equivalent to N appendLine calls (same ids/order)', () => {
        const a = RmDocument.empty(A)
        a.appendLines([mkLine(1), mkLine(2)], { authorUuid: A })
        const b = RmDocument.empty(A)
        b.appendLine(mkLine(1), { authorUuid: A })
        b.appendLine(mkLine(2), { authorUuid: A })
        expect(a.serialize()).toEqual(b.serialize())
    })

    test('scoped stroke allocation matches serial calls at the reserved clock boundary', () => {
        const seed = RmDocument.empty(A)
        const stroke = seed.appendLine(mkLine(1), { authorUuid: A })
        stroke.line!.timestamp = crdtId(stroke.itemId.part1, RESERVED_CLOCK_FLOOR - 1)
        const serial = RmDocument.parse(seed.serialize())
        const batched = RmDocument.parse(seed.serialize())
        expect(serial.maxClock()).toBe(RESERVED_CLOCK_FLOOR - 1)
        const lines = [mkLine(2), mkLine(3)]
        for (const line of lines) serial.appendLine(line, { authorUuid: A })
        batched.withLineAppender(A, (append) => {
            for (const line of lines) append(line, stroke.parentId)
        })
        expect(batched.serialize()).toEqual(serial.serialize())
    })

    test.each([false, true])('the scoped appender expires when its callback exits (throw=%s)', (throws) => {
        const doc = RmDocument.empty(A)
        const parent = doc.defaultLayerId()!
        let escaped!: () => unknown
        const write = () => doc.withLineAppender(A, (append) => {
            append(mkLine(1), parent)
            escaped = () => append(mkLine(3), parent)
            if (throws) throw new Error('stop writing')
        })
        if (throws) expect(write).toThrow('stop writing')
        else write()
        doc.appendLine(mkLine(2), { authorUuid: A })
        const saved = doc.serialize()
        expect(escaped).toThrow('stroke append scope has ended')
        expect(doc.serialize()).toEqual(saved)
    })

    test('an async continuation cannot append after the synchronous scope', async () => {
        const doc = RmDocument.empty(A)
        const parent = doc.defaultLayerId()!
        let continuation!: Promise<unknown>
        doc.withLineAppender(A, (append) => {
            append(mkLine(1), parent)
            continuation = Promise.resolve().then(() => append(mkLine(3), parent))
            return continuation
        })
        doc.appendLine(mkLine(2), { authorUuid: A })
        const saved = doc.serialize()
        await expect(continuation).rejects.toThrow('stroke append scope has ended')
        expect(doc.serialize()).toEqual(saved)
    })

    test('PERF: 2000 strokes build well under a quadratic budget', () => {
        const doc = RmDocument.empty(A)
        const t0 = performance.now()
        // simulate the apply-ops hot path: many small batches
        for (let i = 0; i < 200; i++) {
            doc.appendLines(
                Array.from({ length: 10 }, (_, j) => mkLine(i * 10 + j)),
                { authorUuid: A },
            )
        }
        const ms = performance.now() - t0
        const live = doc.blocks.filter((bl) => bl.type === 'sceneLineItem').length
        expect(live).toBe(2000)
        // generous bound: O(n^2) on 2000 strokes was seconds; O(n) is tens of ms
        expect(ms).toBeLessThan(1500)
    })
})
