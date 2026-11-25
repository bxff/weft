/**
 * Device bridge against a real xochitl-authored page (fixtures/ferrari-bridge-real-page.rm).
 * Synthetic strokes can't prove the bridge survives xochitl's actual file layout:
 *   - real .rm parses
 *   - diffToOps(real, real) is empty and complete (no-loop guarantee on the
 *     daemon's idempotent re-PUT, on real device bytes)
 *   - reconstructRm replays the real lines back to the identical live set
 */

import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { RmDocument, type SceneLineItemBlock } from '@weft/rm-format'
import { lineBlockToAddOp } from '../src/ops'
import { reconstructRm, diffToOps } from '../src/bridge'

const real = new Uint8Array(
    readFileSync(`${import.meta.dir}/../../../fixtures/ferrari-bridge-real-page.rm`),
)

function liveLines(rm: Uint8Array): number {
    return (rm && (RmDocument.parse(rm).blocks as unknown as { type: string; deletedLength: number }[]))
        .filter((b) => b.type === 'sceneLineItem' && b.deletedLength === 0).length
}

test('a real xochitl page parses', () => {
    const doc = RmDocument.parse(real)
    expect(doc.blocks.length).toBeGreaterThan(0)
    expect(liveLines(real)).toBeGreaterThan(0)
})

test('diffToOps(real, real) is empty + complete (no-loop on real device bytes)', () => {
    const { ops, complete } = diffToOps(real, real)
    expect(ops.length).toBe(0)
    expect(complete).toBe(true)
})

test('reconstructRm replays the real lines back to the identical live set', () => {
    const doc = RmDocument.parse(real)
    const ops = (doc.blocks as unknown as (SceneLineItemBlock & { deletedLength: number })[])
        .filter((b) => b.type === 'sceneLineItem' && b.deletedLength === 0 && b.line)
        .map((b) => lineBlockToAddOp(doc, b))
    const rebuilt = reconstructRm(null, ops, 'c10d0000-0000-4000-a000-000000000001')
    expect(liveLines(rebuilt)).toBe(liveLines(real))
})
