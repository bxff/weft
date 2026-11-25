/**
 * The snapshot container frames .rm + overlay into one opaque blob (the relay
 * never parses it) and unframes losslessly on bootstrap.
 */

import { describe, expect, test } from 'bun:test'
import { RmDocument } from '@weft/rm-format'
import { encodeSnapshot, decodeSnapshot } from '../src/snapshot'
import type { OverlayDocument } from '../src/types'

const AUTHOR = 'c8050a7c-0000-4000-a000-000000000001'

describe('snapshot container', () => {
    test('round-trips rm bytes + overlay exactly', () => {
        const rm = RmDocument.empty(AUTHOR).serialize()
        const overlay: OverlayDocument = {
            shapes: [
                {
                    shapeId: 'shape:1',
                    kind: 'text',
                    props: { text: 'hello', size: 'm' },
                    x: 1.5,
                    y: 2.5,
                    rotation: 0,
                    rendered: [{ partKey: 'g0', items: [{ authorUuid: AUTHOR, clock: 9 }], contentHash: 'h' }],
                    renderRevision: 'r1',
                    state: 'live',
                    version: { ts: 1000, actor: AUTHOR },
                },
            ],
        }
        const { rm: rm2, overlay: overlay2 } = decodeSnapshot(encodeSnapshot(rm, overlay))
        expect([...rm2]).toEqual([...rm])
        expect(overlay2).toEqual(overlay)
        // the recovered rm still parses
        expect(() => RmDocument.parse(rm2)).not.toThrow()
    })

    test('the LWW tombstones register survives the round-trip (D7 re-bootstrap)', () => {
        // Losing this across a snapshot re-bootstrap would let a stale upsert
        // resurrect a deleted object — the exact failure the register guards.
        const overlay: OverlayDocument = {
            shapes: [],
            tombstones: { 'shape:deleted': { ts: 4200, actor: 'client-A' } },
        }
        const { overlay: back } = decodeSnapshot(encodeSnapshot(new Uint8Array(0), overlay))
        expect(back).toEqual(overlay)
        expect(back.tombstones!['shape:deleted']).toEqual({ ts: 4200, actor: 'client-A' })
    })

    test('handles an empty overlay and empty rm', () => {
        const { rm, overlay } = decodeSnapshot(encodeSnapshot(new Uint8Array(0), { shapes: [] }))
        expect(rm.length).toBe(0)
        expect(overlay).toEqual({ shapes: [] })
    })

    test('rejects a non-container blob (raw .rm has no magic)', () => {
        const rawRm = RmDocument.empty(AUTHOR).serialize()
        expect(() => decodeSnapshot(rawRm)).toThrow()
    })

    test('rejects a truncated header', () => {
        expect(() => decodeSnapshot(new Uint8Array([1, 2, 3]))).toThrow(/truncated/)
    })

    test('rejects a declared rmLen past the buffer end', () => {
        const good = encodeSnapshot(new Uint8Array([1, 2, 3]), { shapes: [] })
        const view = new DataView(good.buffer)
        view.setUint32(8, 0xffffff, true) // rmLen way past the end
        expect(() => decodeSnapshot(good)).toThrow(/exceeds/)
    })
})
