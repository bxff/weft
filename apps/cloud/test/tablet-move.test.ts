/**
 * #90: a tablet MOVE (xochitl lasso-move rewrites the stroke: the old item is
 * tombstoned and a NEW item with fresh ids + moveId carries the geometry)
 * must reach a live web session as remove+add patches — no reload. Runs the
 * real chain: cloud server over HTTP, device PUTs on the daemon route, a real
 * OfflineSession pulling through HttpTransport.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { startCloud, type CloudServer } from '../src/server'
import { HttpTransport, OfflineSession, MemoryStorage, type ViewPatch } from '@weft/sync-engine'
import { RmDocument, Pen, PenColor, crdtId } from '@weft/rm-format'
import { polylineToPoints } from '@weft/rm-ink/pure'

const DOC = '90909090-9090-4090-a090-909090909090'
const PAGE = 'abcdabcd-abcd-4bcd-abcd-abcdabcdabcd'
const TABLET = 'f73f497f-0000-4000-a000-000000000000'
const WEB = 'aaaaaaaa-0000-4000-a000-000000000001'

let server: CloudServer
let t: HttpTransport
let base: string

beforeAll(() => {
    process.env.CLOUD_DEV_USER = '1'
    server = startCloud({ port: 0 })
    base = `http://localhost:${server.port}`
    t = new HttpTransport({ baseUrl: base, getAuthToken: () => 'dev:movetester' })
})
afterAll(() => server.stop())

const auth = { authorization: 'Bearer dev:movetester' }

async function devicePut(bytes: Uint8Array, baseRev: string): Promise<void> {
    const r = await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/rm`, {
        method: 'PUT',
        headers: { ...auth, 'x-base-revision': baseRev, 'x-client-id': 'rmsyncd' },
        body: bytes as unknown as BodyInit,
    })
    expect(r.status).toBe(200)
}

async function deviceGet(): Promise<{ bytes: Uint8Array; revision: string }> {
    const r = await fetch(`${base}/api/documents/${DOC}/pages/${PAGE}/rm`, { headers: auth })
    expect(r.status).toBe(200)
    return {
        bytes: new Uint8Array(await r.arrayBuffer()),
        revision: r.headers.get('x-rm-revision') ?? '',
    }
}

function stroke(doc: RmDocument, seg: [number, number, number, number], moveId: ReturnType<typeof crdtId> | null = null) {
    return doc.appendLine(
        {
            kind: 'line',
            tool: Pen.MARKER_2,
            color: PenColor.BLACK,
            thicknessScale: 2,
            startingLength: 0,
            timestamp: crdtId(0, 1),
            moveId,
            points: polylineToPoints(
                [
                    { x: seg[0], y: seg[1] },
                    { x: seg[2], y: seg[3] },
                ],
                { width: 40 },
            ),
        },
        { authorUuid: TABLET },
    )
}

function liveLines(doc: RmDocument): { id: string; x: number }[] {
    return (doc.blocks as never as { type: string; deletedLength: number; itemId: { part1: number; part2: number }; line?: { points: { x: number }[] } }[])
        .filter((b) => b.type === 'sceneLineItem' && b.deletedLength === 0)
        .map((b) => ({ id: `${b.itemId.part1}:${b.itemId.part2}`, x: b.line?.points[0]?.x ?? 0 }))
}

test('a tablet move lands on a LIVE web session as remove+add (no reload)', async () => {
    // page is op-mode from the start (a web ink op seeds it), like real pages
    const seed = RmDocument.empty(TABLET)
    stroke(seed, [10, 10, 90, 90])
    stroke(seed, [200, 200, 300, 300])
    await devicePut(seed.serialize(), '')

    const patches: ViewPatch[] = []
    const session = await OfflineSession.open(new MemoryStorage(), t, DOC, PAGE, {
        clientId: 'web-live',
        authorUuid: WEB,
        useOps: true,
        retryIntervalMs: 100000,
        onPatch: (p) => patches.push(p),
    })
    await session.reconcile()
    await session.reconcile()
    expect(liveLines(session.document)).toHaveLength(2)

    // the tablet MOVES stroke 1: tombstone the old item, add a rewritten item
    // (fresh id, moveId = the old id) at the new position — xochitl's shape
    const { bytes, revision } = await deviceGet()
    const moved = RmDocument.parse(bytes)
    const victim = (moved.blocks as never as { type: string; deletedLength: number; itemId: { part1: number; part2: number } }[])
        .filter((b) => b.type === 'sceneLineItem' && b.deletedLength === 0)
        .find((b) => true)!
    const oldId = { ...victim.itemId }
    moved.tombstone(victim.itemId as never)
    stroke(moved, [510, 510, 590, 590], crdtId(oldId.part1, oldId.part2))
    await devicePut(moved.serialize(), revision)

    patches.length = 0
    await session.reconcile()
    await session.reconcile()

    const after = liveLines(session.document)
    expect(after).toHaveLength(2) // still two strokes...
    expect(after.some((l) => l.x === 510)).toBe(true) // ...one at the new spot
    expect(after.some((l) => l.id === `${oldId.part1}:${oldId.part2}`)).toBe(false) // old id gone
    // and the session emitted LIVE patches for both sides of the move
    expect(patches.some((p) => p.type === 'ink-added')).toBe(true)
    expect(patches.some((p) => p.type === 'ink-removed')).toBe(true)
    session.dispose()
})
