/**
 * Device bridge core: reconstruct .rm from ops (for the daemon's read) and
 * diff the daemon's .rm write back into ops. Load-bearing property: a full
 * round-trip (web ops -> reconstruct -> xochitl merge+draw -> diff -> ops)
 * surfaces only the new tablet ink, never re-adding web items.
 */

import { describe, expect, test } from 'bun:test'
import { RmDocument, Pen, PenColor, type CrdtId } from '@weft/rm-format'
import { polylineToPoints, type Xy } from '@weft/rm-ink/pure'
import { applyOps } from '../src/apply-ops'
import { reconstructRm, diffToOps, mergeForSnapshot, deviceRemovedTombstones, gateTombstonesByBase, rekeyCloneCollisions } from '../src/bridge'
import { idToOpRef, type Op, applyInkDeltas, type AddItemOp, type TombstoneOp } from '../src/ops'
import type { OverlayDocument } from '../src/types'

const WEB_AUTHOR = 'aaaaaaaa-0000-4000-a000-000000000001'
const TABLET_AUTHOR = 'f73f497f-0000-4000-a000-000000000000'

function liveLines(rm: Uint8Array): number {
    return (RmDocument.parse(rm).blocks as unknown as { type: string; deletedLength: number }[]).filter(
        (b) => b.type === 'sceneLineItem' && b.deletedLength === 0,
    ).length
}

function liveKeys(rm: Uint8Array): string[] {
    const doc = RmDocument.parse(rm)
    return (doc.blocks as unknown as { type: string; itemId: CrdtId; deletedLength: number }[])
        .filter((b) => b.type === 'sceneLineItem' && b.deletedLength === 0)
        .map((b) => {
            const r = idToOpRef(doc, b.itemId)
            return `${r.author ?? 'sys'}:${r.clock}`
        })
        .sort()
}

/** Capture a web edit (one stroke) as ops via the real producer path, minting
 *  against `base` once. (A single stroke per base: distinct strokes must mint
 *  against an evolving doc, see captureStroke.) */
function webStrokeOps(base: Uint8Array, shapeId: string, line: Xy[]): Op[] {
    const doc = RmDocument.parse(base)
    return captureStroke(doc, { shapes: [] }, shapeId, line)
}

/** Apply a stroke to a live doc+overlay (mutating them, so the clock advances
 *  for the next stroke) and return the minted deltas: the real client path. */
function captureStroke(doc: RmDocument, overlay: OverlayDocument, shapeId: string, line: Xy[]): Op[] {
    const { deltas } = applyOps(
        doc,
        overlay,
        [
            {
                type: 'upsert-shape',
                shape: {
                    shapeId,
                    kind: 'draw-native',
                    props: {},
                    x: 0,
                    y: 0,
                    rotation: 0,
                    renderRevision: shapeId,
                    version: { ts: 1, actor: 'test' },
                },
                parts: [{ partKey: 'p0', strokes: [{ points: polylineToPoints(line, { width: 40 }), color: 'black' }] }],
            },
        ],
        { authorUuid: WEB_AUTHOR },
    )
    return deltas
}

/** Simulate xochitl: parse, draw a tablet stroke, normalize, reserialize. */
function tabletDraw(rm: Uint8Array, line: Xy[]): Uint8Array {
    const doc = RmDocument.parse(rm)
    doc.appendLine(
        {
            kind: 'line',
            tool: Pen.BALLPOINT_2,
            color: PenColor.BLACK,
            thicknessScale: 2,
            startingLength: 0,
            timestamp: { part1: 0, part2: 1 },
            moveId: null,
            points: polylineToPoints(line, { width: 8 }),
        },
        { authorUuid: TABLET_AUTHOR },
    )
    doc.normalizeLayout()
    return doc.serialize()
}

describe('reconstructRm', () => {
    test('no snapshot + no ops = a valid empty doc', () => {
        const rm = reconstructRm(null, [], WEB_AUTHOR)
        expect(() => RmDocument.parse(rm)).not.toThrow()
        expect(liveLines(rm)).toBe(0)
    })

    test('replays ink ops over a snapshot to the converged .rm', () => {
        const base = RmDocument.empty(WEB_AUTHOR).serialize()
        const ops = webStrokeOps(base, 'shape:a', [
            { x: 10, y: 10 },
            { x: 90, y: 90 },
        ])
        const rm = reconstructRm(base, ops, WEB_AUTHOR)
        expect(liveLines(rm)).toBe(1)
    })

    test('ignores non-ink (overlay) ops', () => {
        const base = RmDocument.empty(WEB_AUTHOR).serialize()
        const ops: Op[] = [{ op: 'delete-object', id: 'shape:x', version: { ts: 1, actor: 'test' } }]
        const rm = reconstructRm(base, ops, WEB_AUTHOR)
        expect(liveLines(rm)).toBe(0)
    })
})

describe('diffToOps', () => {
    test('a new tablet stroke becomes one addItem op (complete)', () => {
        const before = RmDocument.empty(WEB_AUTHOR).serialize()
        const after = tabletDraw(before, [
            { x: 0, y: 0 },
            { x: 50, y: 50 },
        ])
        const { ops, complete } = diffToOps(before, after)
        expect(ops.filter((o) => o.op === 'add')).toHaveLength(1)
        expect(complete).toBe(true)
    })

    test('an unchanged carry-through produces no ops (idempotent)', () => {
        const base = RmDocument.empty(WEB_AUTHOR).serialize()
        const withInk = tabletDraw(base, [
            { x: 0, y: 0 },
            { x: 5, y: 5 },
        ])
        expect(diffToOps(withInk, withInk)).toEqual({ ops: [], complete: true })
    })

    test('an erased item becomes a tombstone op', () => {
        const base = RmDocument.empty(WEB_AUTHOR).serialize()
        const withInk = tabletDraw(base, [
            { x: 0, y: 0 },
            { x: 5, y: 5 },
        ])
        // erase it (xochitl tombstones in place)
        const doc = RmDocument.parse(withInk)
        const block = doc.blocks.find((b) => b.type === 'sceneLineItem') as unknown as { itemId: CrdtId }
        doc.tombstone(block.itemId)
        const erased = doc.serialize()

        const { ops } = diffToOps(withInk, erased)
        expect(ops.filter((o) => o.op === 'tombstone')).toHaveLength(1)
        expect(ops.filter((o) => o.op === 'add')).toHaveLength(0)
    })

    test('a tablet stroke AND a tablet erase in the same merge', () => {
        const base = RmDocument.empty(WEB_AUTHOR).serialize()
        const withInk = tabletDraw(base, [
            { x: 0, y: 0 },
            { x: 5, y: 5 },
        ])
        // erase the existing stroke and draw a new one
        const doc = RmDocument.parse(withInk)
        const old = doc.blocks.find((b) => b.type === 'sceneLineItem') as unknown as { itemId: CrdtId }
        doc.tombstone(old.itemId)
        const next = tabletDraw(doc.serialize(), [
            { x: 20, y: 20 },
            { x: 40, y: 40 },
        ])
        const { ops } = diffToOps(withInk, next)
        expect(ops.filter((o) => o.op === 'add')).toHaveLength(1)
        expect(ops.filter((o) => o.op === 'tombstone')).toHaveLength(1)
    })

    test('a new tablet GLYPH (typed text) makes the diff incomplete (snapshot fallback)', () => {
        // simulate a glyph item the tablet introduced (raw block, no CRDT API)
        const base = RmDocument.empty(WEB_AUTHOR)
        const baseBytes = base.serialize()
        const doc = RmDocument.parse(baseBytes)
        const author = doc.resolveAuthor(TABLET_AUTHOR)
        const layer = doc.defaultLayerId()!
        doc.blocks.push({
            type: 'sceneGlyphItem',
            version: { min: 0, current: 0 },
            extraData: new Uint8Array(0),
            extraValueData: new Uint8Array(0),
            parentId: layer,
            itemId: { part1: author, part2: doc.maxClock(author) + 1 },
            leftId: { part1: 0, part2: 0 },
            rightId: { part1: 0, part2: 0 },
            deletedLength: 0,
            // minimal glyph value
            glyph: { kind: 'glyph', start: 0, length: 1, color: 0, rectangles: [] },
        } as never)
        const next = doc.serialize()
        const { complete } = diffToOps(baseBytes, next)
        expect(complete).toBe(false)
    })
})

describe('full round-trip: web ops -> reconstruct -> tablet merge+draw -> diff', () => {
    test('the diff surfaces ONLY the new tablet ink, never re-adding web items', () => {
        const base = RmDocument.empty(WEB_AUTHOR).serialize()
        // 1. web draws two strokes -> ops (minted against the evolving doc so
        // the two strokes get distinct ids, as a real client would)
        const webDoc = RmDocument.parse(base)
        const webOverlay: OverlayDocument = { shapes: [] }
        const webOps = [
            ...captureStroke(webDoc, webOverlay, 'shape:a', [
                { x: 10, y: 10 },
                { x: 90, y: 90 },
            ]),
            ...captureStroke(webDoc, webOverlay, 'shape:b', [
                { x: 20, y: 20 },
                { x: 80, y: 80 },
            ]),
        ]
        // 2. cloud reconstructs the .rm for the daemon to push to xochitl
        const reconstructed = reconstructRm(base, webOps, WEB_AUTHOR)
        expect(liveLines(reconstructed)).toBe(2)

        // 3. xochitl merges + the user draws a tablet stroke
        const merged = tabletDraw(reconstructed, [
            { x: 0, y: 0 },
            { x: 30, y: 30 },
        ])
        expect(liveLines(merged)).toBe(3)

        // 4. cloud diffs the daemon's PUT vs the reconstructed current state
        const { ops: tabletOps, complete } = diffToOps(reconstructed, merged)
        // exactly one add (the tablet stroke): the two web items are unchanged
        expect(tabletOps.filter((o) => o.op === 'add')).toHaveLength(1)
        expect(complete).toBe(true)

        // 5. a web peer that had the web ops now applies the tablet op: converges
        const peer = reconstructRm(base, [...webOps, ...tabletOps], WEB_AUTHOR)
        expect(liveKeys(peer)).toEqual(liveKeys(merged))
        expect(liveLines(peer)).toBe(3)
    })

    test('a tablet erase of a web stroke round-trips as a tombstone', () => {
        const base = RmDocument.empty(WEB_AUTHOR).serialize()
        const webOps = webStrokeOps(base, 'shape:a', [
            { x: 10, y: 10 },
            { x: 90, y: 90 },
        ])
        const reconstructed = reconstructRm(base, webOps, WEB_AUTHOR)

        // tablet erases the web stroke
        const doc = RmDocument.parse(reconstructed)
        const block = doc.blocks.find((b) => b.type === 'sceneLineItem') as unknown as { itemId: CrdtId }
        doc.tombstone(block.itemId)
        doc.normalizeLayout()
        const erased = doc.serialize()

        const { ops } = diffToOps(reconstructed, erased)
        expect(ops.filter((o) => o.op === 'tombstone')).toHaveLength(1)

        // the web peer applies it: the stroke dies
        const peer = reconstructRm(base, [...webOps, ...ops], WEB_AUTHOR)
        expect(liveLines(peer)).toBe(0)
    })
})

/**
 * Op bridge convergence: two writers append to a page's op log: web clients
 * (CRDT ops directly) and the device bridge (diffToOps(prev = cloud's current
 * reconstructed .rm, next = daemon's file)). Convergence rests on three facts:
 *
 *   1. diffToOps only iterates `next`, so an item present in `prev` but absent
 *      from `next` is never touched: a stale daemon push can't false-delete it.
 *   2. Every ink item keeps a stable CRDT id across the round-trip (ops ->
 *      reconstruct -> xochitl merge -> diff -> ops), so a carried-through item
 *      matches by id and yields no op: a byte-identical re-push is a no-op
 *      (no feedback loop).
 *   3. xochitl's normalize rewrite doesn't change the live-item id set, so a
 *      normalize-only rewrite diffs to empty.
 *
 * Ops commute and are append-only, so replaying the union of both writers'
 * ops converges to the same live-item id set everywhere. No CAS or LWW on
 * ink: concurrent web and tablet edits both survive (distinct ids). Removal
 * only happens via an explicit tombstone, never by absence.
 */
describe('F5: op bridge convergence (no divergence, no lost edits)', () => {
    test('stale-push-no-false-delete: a daemon PUT missing recent web ops does NOT delete them', () => {
        const base = RmDocument.empty(WEB_AUTHOR).serialize()

        // t0: web draws stroke A; the daemon pulls the reconstructed file.
        const webDoc = RmDocument.parse(base)
        const webOverlay: OverlayDocument = { shapes: [] }
        const opsA = captureStroke(webDoc, webOverlay, 'shape:a', [
            { x: 10, y: 10 },
            { x: 90, y: 90 },
        ])
        const daemonSaw = reconstructRm(base, opsA, WEB_AUTHOR) // what the daemon holds
        expect(liveLines(daemonSaw)).toBe(1)

        // t1: web draws stroke B after the daemon's last pull; the cloud's
        // current reconstructed state now has both A and B.
        const opsB = captureStroke(webDoc, webOverlay, 'shape:b', [
            { x: 20, y: 20 },
            { x: 80, y: 80 },
        ])
        const cloudCurrent = reconstructRm(base, [...opsA, ...opsB], WEB_AUTHOR)
        expect(liveLines(cloudCurrent)).toBe(2)

        // t2: the daemon, still holding only A, saves and PUTs its stale file.
        // applyDevicePut diffs prev=cloudCurrent (A+B) vs next=daemonSaw (A only).
        // B is prev-present/next-absent -> must not tombstone.
        const { ops, complete } = diffToOps(cloudCurrent, daemonSaw)
        expect(complete).toBe(true)
        expect(ops.filter((o) => o.op === 'tombstone')).toHaveLength(0)
        expect(ops).toHaveLength(0) // nothing at all: no false delete, no re-add

        // the reconstructed state still has both strokes after the stale push
        const after = reconstructRm(base, [...opsA, ...opsB, ...ops], WEB_AUTHOR)
        expect(liveKeys(after)).toEqual(liveKeys(cloudCurrent))
        expect(liveLines(after)).toBe(2)
    })

    test('stale push that ALSO adds a tablet stroke: keeps web B and adds the tablet ink', () => {
        // even if the stale daemon PUTs a file that lacks web stroke B and has
        // a fresh tablet stroke, the tablet stroke must be added without deleting B.
        const base = RmDocument.empty(WEB_AUTHOR).serialize()
        const webDoc = RmDocument.parse(base)
        const overlay: OverlayDocument = { shapes: [] }
        const opsA = captureStroke(webDoc, overlay, 'shape:a', [
            { x: 10, y: 10 },
            { x: 90, y: 90 },
        ])
        const daemonSaw = reconstructRm(base, opsA, WEB_AUTHOR)
        const opsB = captureStroke(webDoc, overlay, 'shape:b', [
            { x: 20, y: 20 },
            { x: 80, y: 80 },
        ])
        const cloudCurrent = reconstructRm(base, [...opsA, ...opsB], WEB_AUTHOR)

        // daemon draws a tablet stroke onto its stale file (A + tablet)
        const daemonPut = tabletDraw(daemonSaw, [
            { x: 0, y: 0 },
            { x: 30, y: 30 },
        ])
        const { ops } = diffToOps(cloudCurrent, daemonPut)
        expect(ops.filter((o) => o.op === 'tombstone')).toHaveLength(0) // B survives
        expect(ops.filter((o) => o.op === 'add')).toHaveLength(1) // tablet stroke added

        const after = reconstructRm(base, [...opsA, ...opsB, ...ops], WEB_AUTHOR)
        expect(liveLines(after)).toBe(3) // A + B + tablet
    })

    test('idempotent-repush-zero-ops: re-pushing byte-identical content appends nothing', () => {
        const base = RmDocument.empty(WEB_AUTHOR).serialize()
        const ops = webStrokeOps(base, 'shape:a', [
            { x: 10, y: 10 },
            { x: 90, y: 90 },
        ])
        const current = reconstructRm(base, ops, WEB_AUTHOR)
        // the daemon re-PUTs the exact file it pulled (its own idempotent save)
        for (let i = 0; i < 3; i++) {
            const { ops: diff, complete } = diffToOps(current, current)
            expect(diff).toHaveLength(0) // no growth -> no loop
            expect(complete).toBe(true)
        }
    })

    test('normalize-empty-diff: xochitl re-serializing (normalize only) diffs to empty on a real fixture', () => {
        const { readFileSync } = require('node:fs') as typeof import('node:fs')
        const real = new Uint8Array(
            readFileSync(`${import.meta.dir}/../../../fixtures/ferrari-bridge-real-page.rm`),
        )
        // xochitl merges + rewrites without the user changing anything: parse,
        // normalize layout, reserialize (exactly what a re-open/re-save does).
        const doc = RmDocument.parse(real)
        doc.normalizeLayout()
        const rewritten = doc.serialize()

        const { ops, complete } = diffToOps(real, rewritten)
        expect(ops).toHaveLength(0) // a normalize-only rewrite is not an edit
        expect(complete).toBe(true)
    })
})

// structural incompleteness: text / anchors / groups. Without the
// structureFingerprint check, a tablet text edit could diff to zero ops and
// complete:true, silently reverting the tablet's typing on next reconstruction.

import {
    createRootText as _createRootText,
    insertText as _insertText,
} from '@weft/rm-format'

test('a tablet TEXT edit flags the diff incomplete (snapshot required)', () => {
    const base = RmDocument.empty(TABLET_AUTHOR)
    const before = base.serialize()
    const after = RmDocument.parse(before)
    _createRootText(after)
    _insertText(after, null, 'typed on the device', { authorUuid: TABLET_AUTHOR })
    const { ops, complete } = diffToOps(before, after.serialize())
    expect(ops).toHaveLength(0) // the line diff cannot see text
    expect(complete).toBe(false) // ...so it must demand a snapshot
})

test('editing EXISTING text (insert into a run) also flags incomplete', () => {
    const base = RmDocument.empty(TABLET_AUTHOR)
    _createRootText(base)
    const first = _insertText(base, null, 'hello', { authorUuid: TABLET_AUTHOR })
    const before = base.serialize()
    const after = RmDocument.parse(before)
    _insertText(after, first, 'X', { authorUuid: TABLET_AUTHOR })
    expect(diffToOps(before, after.serialize()).complete).toBe(false)
})

test('an identical rewrite stays complete (no snapshot churn)', () => {
    const base = RmDocument.empty(TABLET_AUTHOR)
    _createRootText(base)
    _insertText(base, null, 'stable text', { authorUuid: TABLET_AUTHOR })
    const bytes = base.serialize()
    const rewrite = RmDocument.parse(bytes).serialize()
    const { ops, complete } = diffToOps(bytes, rewrite)
    expect(ops).toHaveLength(0)
    expect(complete).toBe(true)
})

test('a new anchored GROUP (treeNode with anchor) flags incomplete', () => {
    const base = RmDocument.empty(TABLET_AUTHOR)
    const before = base.serialize()
    const after = RmDocument.parse(before)
    // xochitl wraps text-adjacent ink in an anchored group: fabricate the
    // treeNode + group item the way the device does
    after.blocks.push({
        type: 'treeNode',
        version: { min: 1, current: 2 },
        extraData: new Uint8Array(0),
        nodeId: { part1: 1, part2: 900 },
        label: { timestamp: { part1: 0, part2: 0 }, value: '' },
        visible: { timestamp: { part1: 0, part2: 0 }, value: true },
        anchorId: { timestamp: { part1: 1, part2: 901 }, value: { part1: 0, part2: 281474976710655 } },
        anchorType: { timestamp: { part1: 1, part2: 903 }, value: 2 },
        anchorThreshold: { timestamp: { part1: 1, part2: 904 }, value: 0 },
        anchorOriginX: { timestamp: { part1: 1, part2: 902 }, value: -468 },
    } as never)
    expect(diffToOps(before, after.serialize()).complete).toBe(false)
})

test('mergeForSnapshot does not resurrect a stroke the tablet DELETED (phantom fix)', () => {
    // tablet drew a stroke, undid it (block removed outright), but the
    // cloud's union previously re-added it as a phantom (web-only).
    const empty = RmDocument.empty(TABLET_AUTHOR).serialize()
    const withA = tabletDraw(empty, [{ x: 0, y: 0 }, { x: 5, y: 5 }]) // stroke A
    const aKey = liveKeys(withA)[0]!
    const withAB = tabletDraw(withA, [{ x: 10, y: 10 }, { x: 15, y: 15 }]) // + stroke B
    const bKey = liveKeys(withAB).find((k) => k !== aKey)!
    // cloud == withAB, plus a concurrent web stroke C the tablet never pulled
    const cloudDoc = RmDocument.parse(withAB)
    cloudDoc.appendLine(
        {
            kind: 'line', tool: Pen.MARKER_2, color: PenColor.BLACK, thicknessScale: 2,
            startingLength: 0, timestamp: { part1: 0, part2: 1 }, moveId: null,
            points: polylineToPoints([{ x: 20, y: 20 }, { x: 25, y: 25 }], { width: 8 }),
        },
        { authorUuid: WEB_AUTHOR },
    )
    cloudDoc.normalizeLayout()
    const cloud = cloudDoc.serialize()
    const cKey = liveKeys(cloud).find((k) => k.startsWith(WEB_AUTHOR))!

    // tablet undoes A: remove its block entirely, keeping B (higher clock, same author)
    const td = RmDocument.parse(withAB)
    td.blocks = (td.blocks as unknown as { type: string; itemId: CrdtId }[]).filter(
        (b) => !(b.type === 'sceneLineItem' && liveKeyOf(td, b.itemId) === aKey),
    ) as never
    const tabletAfter = td.serialize()

    const merged = mergeForSnapshot(tabletAfter, cloud)
    const keys = liveKeys(merged)
    expect(keys).not.toContain(aKey) // deleted A not resurrected
    expect(keys).toContain(bKey) // B preserved
    expect(keys).toContain(cKey) // genuine concurrent web edit C still re-added
})

function liveKeyOf(doc: RmDocument, id: CrdtId): string {
    const r = idToOpRef(doc, id)
    return `${r.author ?? 'sys'}:${r.clock}`
}

test('deviceRemovedTombstones converges a device UNDO the diff cannot see', () => {
    // xochitl undo removes a block outright (no tombstone) -> diffToOps emits
    // nothing, so the cloud never converged. This helper propagates it.
    const empty = RmDocument.empty(TABLET_AUTHOR).serialize()
    const withA = tabletDraw(empty, [{ x: 0, y: 0 }, { x: 5, y: 5 }])
    const aKey = liveKeys(withA)[0]!
    const withAB = tabletDraw(withA, [{ x: 10, y: 10 }, { x: 15, y: 15 }])
    // cloud = withAB + a concurrent web stroke C the tablet never pulled
    const cloudDoc = RmDocument.parse(withAB)
    cloudDoc.appendLine(
        {
            kind: 'line', tool: Pen.MARKER_2, color: PenColor.BLACK, thicknessScale: 2,
            startingLength: 0, timestamp: { part1: 0, part2: 1 }, moveId: null,
            points: polylineToPoints([{ x: 20, y: 20 }, { x: 25, y: 25 }], { width: 8 }),
        },
        { authorUuid: WEB_AUTHOR },
    )
    cloudDoc.normalizeLayout()
    const cloud = cloudDoc.serialize()
    // tablet undoes A (removes the block); B remains (higher clock, same author)
    const td = RmDocument.parse(withAB)
    td.blocks = (td.blocks as unknown as { type: string; itemId: CrdtId }[]).filter(
        (b) => !(b.type === 'sceneLineItem' && liveKeyOf(td, b.itemId) === aKey),
    ) as never

    const tombs = deviceRemovedTombstones(cloud, td.serialize())
    const keys = tombs.map((o) => `${o.id.author ?? 'sys'}:${o.id.clock}`)
    expect(keys).toContain(aKey) // A's deletion propagates
    // the concurrent web stroke C is not tombstoned (tablet never saw that author)
    expect(keys.some((k) => k.startsWith(WEB_AUTHOR))).toBe(false)
    // diffToOps alone saw nothing (proves the gap this closes)
    expect(diffToOps(cloud, td.serialize()).ops.filter((o) => o.op === 'tombstone')).toHaveLength(0)
})

test('BYTE EQUALITY: device strokes survive diffToOps -> replay -> serialize sha-exact', () => {
    // The daemon skips its write-back only when cloud-reconstructed bytes
    // sha-match the device file. Any coordinate mutation in the bridge op
    // path (e.g. rounding) breaks that forever: the daemon then rewrites the
    // page under the pen after every stroke, resetting xochitl mid-writing
    // (2026-07-14 incident, user report: "things I write just disappear").
    const empty = RmDocument.empty(TABLET_AUTHOR).serialize()
    // full-precision float coords, like real pen input
    const device = tabletDraw(empty, [
        { x: 331.4285583496094, y: 713.7142944335938 },
        { x: 407.9999694824219, y: 645.7142333984375 },
        { x: 511.42857142857144, y: 700.0000000000001 },
    ])
    const { ops } = diffToOps(empty, device)
    expect(ops.length).toBeGreaterThan(0)
    const replica = RmDocument.parse(empty)
    applyInkDeltas(replica, ops.filter((o): o is AddItemOp | TombstoneOp => o.op === 'add' || o.op === 'tombstone'))
    replica.normalizeLayout()
    const a = Bun.hash(RmDocument.parse(device).serialize())
    const b = Bun.hash(replica.serialize())
    expect(b).toBe(a)
})

test('BYTE EQUALITY: a stroke drawn AND erased between pushes survives, incl. the causal-base gate', () => {
    // xochitl drops the line value on erase, so the stroke arrives as a
    // brand-new VALUELESS dead block. A lone tombstone can't materialize it
    // on a replica, and the gate used to drop the whole pair as
    // "render-identical to absent" — both left the reconstruction one block
    // short of the device file, and the daemon's sha-compare rewrote the
    // page under the pen (2026-07-16 finding, reproduced from a real
    // mid-storm snapshot pair).
    const empty = RmDocument.empty(TABLET_AUTHOR).serialize()
    const prev = tabletDraw(empty, [
        { x: 1.5, y: 1.25 },
        { x: 5.75, y: 5.5 },
    ])
    const d = RmDocument.parse(
        tabletDraw(prev, [
            { x: 10.125, y: 10.5 },
            { x: 20.25, y: 20.75 },
        ]),
    )
    const prevKeys = new Set(
        RmDocument.parse(prev)
            .blocks.filter((b) => b.type === 'sceneLineItem')
            .map((b) => crdtKey((b as { itemId: CrdtId }).itemId)),
    )
    const fresh = d.blocks.find(
        (b) => b.type === 'sceneLineItem' && !prevKeys.has(crdtKey((b as { itemId: CrdtId }).itemId)),
    ) as { itemId: CrdtId; line: unknown }
    d.tombstone(fresh.itemId)
    expect(fresh.line).toBeNull() // value dropped, like xochitl
    const device = d.serialize()
    const { ops, complete } = diffToOps(prev, device)
    expect(complete).toBe(true)
    const want = Bun.hash(RmDocument.parse(device).serialize())
    // ungated (no causal base)
    expect(Bun.hash(reconstructRm(prev, ops, TABLET_AUTHOR))).toBe(want)
    // production path: gated by the device's own previous push as causal base
    const gated = gateTombstonesByBase(ops, prev)
    expect(Bun.hash(reconstructRm(prev, gated, TABLET_AUTHOR))).toBe(want)
    // restore protection intact: a lone tombstone for an id NOT live at the
    // base (old news carried through) is still dropped
    const lone: Op[] = [{ op: 'tombstone', id: idToOpRef(d, fresh.itemId) }]
    expect(gateTombstonesByBase(lone, prev)).toHaveLength(0)
})

function crdtKey(id: CrdtId): string {
    return `${(id as unknown as { part1: number }).part1}:${(id as unknown as { part2: number }).part2}`
}

test('clone-collision predicate tolerates float64 noise within float32 precision', () => {
    // cloud reconstructions may carry float64 values whose float32 store
    // round-trip is identical; those are the SAME stroke, never a clone
    const empty = RmDocument.empty(TABLET_AUTHOR).serialize()
    const device = tabletDraw(empty, [
        { x: 331.4285583496094, y: 713.7142944335938 },
        { x: 407.9999694824219, y: 645.7142333984375 },
    ])
    // cloud copy: parse + reserialize (float32 round-trip, same bits)
    const cloud = RmDocument.parse(device).serialize()
    const { rekeyed } = rekeyCloneCollisions(cloud, device)
    expect(rekeyed).toBe(0)
})

test('portable replay rounds a fractional native v1 width without a false clone collision', () => {
    const base = RmDocument.empty(TABLET_AUTHOR).serialize()
    const doc = RmDocument.parse(base)
    const block = doc.appendLine(
        {
            kind: 'line',
            tool: Pen.BALLPOINT_1,
            color: PenColor.BLACK,
            thicknessScale: 2,
            startingLength: 0,
            timestamp: { part1: 0, part2: 1 },
            moveId: null,
            points: [{ x: 100, y: 200, speed: 0, direction: 0, width: 2.5, pressure: 0 }],
        },
        { authorUuid: TABLET_AUTHOR },
    )
    block.version = { min: 0, current: 1 }
    const device = doc.serialize()
    expect(RmDocument.parse(device).serialize()).toEqual(device)

    const { ops, complete } = diffToOps(base, device)
    expect(complete).toBe(true)
    expect(ops).toHaveLength(1)
    const [op] = ops
    expect(op?.op === 'add' && op.payload.kind === 'line' && op.payload.points[0]?.width).toBe(3)

    const cloud = reconstructRm(base, ops, TABLET_AUTHOR)
    const replayed = RmDocument.parse(cloud).blocks.find((b) => b.type === 'sceneLineItem')
    expect(replayed?.version.current).toBe(2)
    expect(replayed?.line?.points[0]?.width).toBe(3)
    expect(rekeyCloneCollisions(cloud, device)).toEqual({ bytes: device, rekeyed: 0 })
})

test('device erase of a GLYPH/IMAGE item flags incomplete (snapshot fallback)', () => {
    // The key-set check only catches NEW glyph/image ids; a live->dead flip
    // kept complete=true and the tablet's erase silently reverted on the
    // next reconstruction (2026-07-16 audit finding, same class as the
    // root-text hole). The fingerprint now covers item liveness + values.
    const doc = RmDocument.empty(TABLET_AUTHOR)
    doc.appendImage(
        {
            kind: 'image',
            uuid: { timestamp: { part1: 0, part2: 0 }, value: new Uint8Array(16) },
            timestamp: { part1: 0, part2: 0 },
            filename: 'aa.png',
            vertices: [0, 0, 0, 0, 10, 0, 1, 0, 10, 10, 1, 1, 0, 10, 0, 1],
            indices: [0, 1, 2, 2, 3, 0],
        } as never,
        { authorUuid: TABLET_AUTHOR },
    )
    const before = doc.serialize()
    const withImage = RmDocument.parse(before)
    const imgBlock = withImage.blocks.find((b) => b.type === 'sceneImageItem') as { itemId: CrdtId }
    withImage.tombstone(imgBlock.itemId)
    const erased = withImage.serialize()
    expect(diffToOps(before, erased).complete).toBe(false)

    // in-place re-placement (same id, new vertices) must also flag
    const moved = RmDocument.parse(before)
    const mb = moved.blocks.find((b) => b.type === 'sceneImageItem') as {
        image: { vertices: number[] } | null
    }
    mb.image!.vertices = mb.image!.vertices.map((v, i) => (i % 4 < 2 ? v + 50 : v))
    expect(diffToOps(before, moved.serialize()).complete).toBe(false)
})
