/**
 * Full bidirectional sync scenarios against the fake daemon, no hardware.
 */

import { describe, expect, test } from 'bun:test'
import { PageSession } from './page-session-harness'
import type { LocalOp } from '../src/apply-ops'
import { FakeDaemon } from '../src/fake-daemon'
import type { ViewPatch } from '../src/types'
import { itemRefKey } from '../src/types'
import { RefResolver } from '../src/refs'
import { polylineToPoints } from '@weft/rm-ink/pure'

const DOC = 'doc-1'
const PAGE = 'page-1'
const ENGINE_AUTHOR = 'c8050a7c-0000-4000-a000-000000000001'

function strokes(n: number, offset = 0) {
    return Array.from({ length: n }, (_, i) => ({
        points: polylineToPoints(
            [
                { x: 100 + i * 10 + offset, y: 100 },
                { x: 100 + i * 10 + offset, y: 200 },
            ],
            { width: 40 },
        ),
        color: 'black',
    }))
}

// monotonic wall-clock stamp: each successive edit is strictly newer, so the
// LWW register treats a genuine re-edit as a winner, not a stale no-op
let versionClock = 0
function textShapeOp(shapeId: string, text: string): LocalOp {
    // one part per glyph, one stroke per part (simplified projection)
    return {
        type: 'upsert-shape',
        shape: {
            shapeId,
            kind: 'text',
            props: { text },
            x: 50,
            y: 50,
            rotation: 0,
            renderRevision: `r-${text}`,
            version: { ts: ++versionClock, actor: 'test' },
        },
        parts: [...text].map((_, i) => ({
            partKey: `glyph:${i}`,
            strokes: strokes(1, i * 20),
        })),
    }
}

async function openSession(daemon: FakeDaemon, patches: ViewPatch[]) {
    return PageSession.open(daemon, DOC, PAGE, {
        clientId: 'studio-1',
        authorUuid: ENGINE_AUTHOR,
        onPatch: (p) => patches.push(p),
    })
}

const tick = () => new Promise((r) => setTimeout(r, 10))

describe('PageSession', () => {
    test('local shape write round-trips through daemon with revision advance', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const patches: ViewPatch[] = []
        const session = await openSession(daemon, patches)
        const rev0 = session.currentRevision

        await session.apply([textShapeOp('shape:T1', 'AB')])
        expect(session.currentRevision).not.toBe(rev0)
        expect(session.currentOverlay.shapes).toHaveLength(1)
        expect(session.currentOverlay.shapes[0]!.rendered).toHaveLength(2)
        // our own write produced no view patches (no echo!)
        await tick()
        expect(patches).toHaveLength(0)
        session.close()
    })

    test('tablet ink arrives as ink-added, never echoes back (LESSONS B1)', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const patches: ViewPatch[] = []
        const session = await openSession(daemon, patches)

        daemon.tabletDraw(DOC, PAGE, [
            { x: 500, y: 500 },
            { x: 600, y: 600 },
        ])
        await tick()
        expect(patches).toHaveLength(1)
        expect(patches[0]!.type).toBe('ink-added')

        // a second unrelated tablet stroke produces exactly one more patch
        daemon.tabletDraw(DOC, PAGE, [
            { x: 700, y: 700 },
            { x: 800, y: 800 },
        ])
        await tick()
        expect(patches).toHaveLength(2)
        session.close()
    })

    test('tablet erase of tablet ink emits ink-removed', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const patches: ViewPatch[] = []
        const session = await openSession(daemon, patches)

        const ref = daemon.tabletDraw(DOC, PAGE, [
            { x: 500, y: 500 },
            { x: 600, y: 600 },
        ])
        await tick()
        daemon.tabletErase(DOC, PAGE, [ref])
        await tick()

        expect(patches.map((p) => p.type)).toEqual(['ink-added', 'ink-removed'])
        const removed = patches[1] as Extract<ViewPatch, { type: 'ink-removed' }>
        expect(removed.items.map(itemRefKey)).toEqual([itemRefKey(ref)])
        session.close()
    })

    test('ABCD -> ABC: clean glyph erase repairs the text semantically (§4 case 1)', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const patches: ViewPatch[] = []
        const session = await openSession(daemon, patches)

        await session.apply([textShapeOp('shape:T1', 'ABCD')])
        const shape = session.currentOverlay.shapes[0]!
        const glyphD = shape.rendered.find((p) => p.partKey === 'glyph:3')!

        daemon.tabletErase(DOC, PAGE, glyphD.items)
        await tick()

        const edits = patches.filter((p) => p.type === 'shape-edited')
        expect(edits).toHaveLength(1)
        const edit = edits[0] as Extract<ViewPatch, { type: 'shape-edited' }>
        expect(edit.shapeId).toBe('shape:T1')
        expect(edit.edit).toEqual({ kind: 'text-truncate-glyphs', removedGlyphIndices: [3] })
        // shape stays live (the view re-projects to 'ABC' and re-applies)
        expect(session.currentOverlay.shapes[0]!.state).toBe('live')
        session.close()
    })

    test('MIDDLE glyph erase detaches (no silent reflow) — D8', async () => {
        // erasing a middle glyph leaves a hole ("ab d"); reflowing to "abd" would
        // not match the surviving ink positions, so this must detach, not reflow
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const patches: ViewPatch[] = []
        const session = await openSession(daemon, patches)

        await session.apply([textShapeOp('shape:T1', 'abcd')])
        const shape = session.currentOverlay.shapes[0]!
        const glyphC = shape.rendered.find((p) => p.partKey === 'glyph:2')!

        daemon.tabletErase(DOC, PAGE, glyphC.items)
        await tick()

        // detach, NOT a truncate/reflow
        expect(patches.map((p) => p.type)).toContain('shape-detached')
        expect(patches.map((p) => p.type)).not.toContain('shape-edited')
        expect(session.currentOverlay.shapes[0]!.state).toBe('detached')
        const stored = await daemon.getOverlay(DOC, PAGE)
        expect(stored.shapes[0]!.state).toBe('detached')
        session.close()
    })

    test('partial erase within a glyph detaches the shape (§4 case 2)', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const patches: ViewPatch[] = []
        const session = await openSession(daemon, patches)

        // Two strokes in one glyph part: erase only one of them.
        await session.apply([
            {
                type: 'upsert-shape',
                shape: {
                    shapeId: 'shape:T2',
                    kind: 'text',
                    props: { text: 'X' },
                    x: 0,
                    y: 0,
                    rotation: 0,
                    renderRevision: 'r1',
                    version: { ts: ++versionClock, actor: 'test' },
                },
                parts: [{ partKey: 'glyph:0', strokes: strokes(2) }],
            },
        ])
        const part = session.currentOverlay.shapes[0]!.rendered[0]!
        expect(part.items).toHaveLength(2)

        daemon.tabletErase(DOC, PAGE, [part.items[0]!])
        await tick()

        expect(patches.map((p) => p.type)).toContain('shape-detached')
        expect(session.currentOverlay.shapes[0]!.state).toBe('detached')
        // detached state persisted to the daemon overlay
        const stored = await daemon.getOverlay(DOC, PAGE)
        expect(stored.shapes[0]!.state).toBe('detached')
        session.close()
    })

    test('LIVE tablet move dissolves the shape without reload (BUG #3)', async () => {
        // the live reconcile path must emit shape-removed on a full-item move,
        // not just repair/detach (which would ghost the shape until reload)
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const patches: ViewPatch[] = []
        const session = await openSession(daemon, patches)
        await session.apply([textShapeOp('shape:T1', 'HI')])
        const allItems = session.currentOverlay.shapes[0]!.rendered.flatMap((p) => p.items)

        // the move, with the session still open: erase every rendered item
        daemon.tabletErase(DOC, PAGE, allItems)
        await tick()

        expect(patches.map((p) => p.type)).toContain('shape-removed')
        // no degenerate text-truncate repair removing every glyph
        expect(patches.map((p) => p.type)).not.toContain('shape-edited')
        expect(session.currentOverlay.shapes).toHaveLength(0)
        // healed overlay persisted to the daemon (survives a later reload)
        const stored = await daemon.getOverlay(DOC, PAGE)
        expect(stored.shapes).toHaveLength(0)
        session.close()
    })

    test('shape update re-mints ONLY changed parts (unchanged glyphs keep their strokes)', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const session = await openSession(daemon, [])

        await session.apply([textShapeOp('shape:T1', 'AB')])
        const before = session.currentOverlay.shapes[0]!.rendered.flatMap((p) => p.items)
        await session.apply([textShapeOp('shape:T1', 'ABC')])
        const after = session.currentOverlay.shapes[0]!.rendered.flatMap((p) => p.items)

        expect(after).toHaveLength(3)
        // per-part reuse: unchanged glyph parts keep their minted strokes, only
        // the new glyph mints ink — a one-char edit must not re-add the whole shape
        for (const oldRef of before) {
            expect(after.map(itemRefKey)).toContain(itemRefKey(oldRef))
        }
        expect(after.length - before.length).toBe(1)
        session.close()
    })

    test('409 rebase: concurrent tablet write does not lose either side (LESSONS B2)', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const patches: ViewPatch[] = []
        const session = await openSession(daemon, patches)

        // Interleave: tablet writes land while our PUT is in flight.
        const originalPut = daemon.putPage.bind(daemon)
        let injected = false
        let tabletRef: ReturnType<typeof daemon.tabletDraw> | null = null
        daemon.putPage = async (doc, page, base, bytes, client) => {
            if (!injected) {
                injected = true
                tabletRef = daemon.tabletDraw(DOC, PAGE, [
                    { x: 900, y: 900 },
                    { x: 950, y: 950 },
                ])
            }
            return originalPut(doc, page, base, bytes, client)
        }

        await session.apply([textShapeOp('shape:T1', 'AB')])

        // Both the tablet stroke and our shape must exist in the final doc.
        const final = await daemon.getPage(DOC, PAGE)
        const { RmDocument } = await import('@weft/rm-format')
        const doc = RmDocument.parse(final!.bytes)
        const live = doc.blocks.filter(
            (b) => b.type === 'sceneLineItem' && b.deletedLength === 0,
        )
        expect(live.length).toBe(3) // 2 glyph strokes + 1 tablet stroke
        expect(tabletRef).not.toBeNull()
        session.close()
    })

    test('reload-equivalent: a fresh session sees the same overlay (LESSONS A1/A2)', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const session = await openSession(daemon, [])
        await session.apply([textShapeOp('shape:T1', 'HELLO')])
        session.close()

        // "Reload": brand-new session, same daemon — identity must survive.
        const session2 = await openSession(daemon, [])
        const shape = session2.currentOverlay.shapes[0]!
        expect(shape.shapeId).toBe('shape:T1')
        expect(shape.kind).toBe('text')
        expect((shape.props as { text: string }).text).toBe('HELLO')
        expect(shape.rendered).toHaveLength(5)
        session2.close()
    })
})

test('Z-LAYERING PIN: render order is the TREE WALK (edit order), file order is storage only', async () => {
    // after an xochitl-style rewrite the file is laid out grouped by (author,
    // clock) - a storage convention - while the device renders the scene-tree
    // walk; the web controller must render the walk, never doc.blocks
    const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
    const session = await openSession(daemon, [])
    const { RmDocument } = await import('@weft/rm-format')

    // three browser shapes applied in order (one stroke each, x = 100/200/300
    // via the strokes() offset), then a tablet stroke at x=150
    const shapeOp = (id: string, offset: number): LocalOp => ({
        type: 'upsert-shape',
        shape: {
            shapeId: id,
            kind: 'text',
            props: { text: 'X' },
            x: 0,
            y: 0,
            rotation: 0,
            renderRevision: `r-${id}`,
            version: { ts: ++versionClock, actor: 'test' },
        },
        parts: [{ partKey: 'glyph:0', strokes: strokes(1, offset) }],
    })
    await session.apply([shapeOp('shape:A', 0)])
    await session.apply([shapeOp('shape:B', 100)])
    await session.apply([shapeOp('shape:C', 200)])
    const tabletRef = daemon.tabletDraw(DOC, PAGE, [
        { x: 150, y: 100 },
        { x: 150, y: 200 },
    ])
    await tick()

    type LineBlock = { itemId: object; leftId: object; line?: { points: { x: number }[] } }
    const doc = RmDocument.parse((await daemon.getPage(DOC, PAGE))!.bytes)
    const live = doc.blocks.filter(
        (b) => b.type === 'sceneLineItem' && b.deletedLength === 0,
    ) as unknown as LineBlock[]
    expect(live).toHaveLength(4)
    const resolver = new RefResolver(doc)

    // render order = scene-tree walk = edit order (A, B, C, tablet): most recent on top
    const walk = [...doc.tree().walk()].filter(([, item]) => item.kind === 'line')
    const walkXs = walk.map(([, item]) => (item as never as { points: { x: number }[] }).points[0]!.x)
    expect(walkXs).toEqual([100, 200, 300, 150])
    // the topmost rendered item IS the tablet stroke
    expect(itemRefKey(resolver.toRef(walk[3]![0])!)).toBe(itemRefKey(tabletRef))

    // the tablet stroke's left origin is the real adjacent item (frontier append, never a toposort id)
    const tabletBlock = live.find(
        (b) => itemRefKey(resolver.toRef(b.itemId as never)!) === itemRefKey(tabletRef),
    )!
    const walkIds = walk.map(([id]) => id as object)
    expect(JSON.stringify(tabletBlock.leftId)).toBe(JSON.stringify(walkIds[2])) // C's stroke

    // file order is grouped by (author, clock), not z-order (tripwire for renderers that read doc.blocks)
    const fileXs = live.map((b) => b.line!.points[0]!.x)
    expect(fileXs).toEqual([150, 100, 200, 300])

    // serialize -> reparse: walk order unchanged (layering survives reload)
    const doc2 = RmDocument.parse(doc.serialize())
    const walkXs2 = [...doc2.tree().walk()]
        .filter(([, item]) => item.kind === 'line')
        .map(([, item]) => (item as never as { points: { x: number }[] }).points[0]!.x)
    expect(walkXs2).toEqual(walkXs)
    session.close()
})

describe('overlay audit at open (the duplicate-Hello bug)', () => {
    test('TABLET MOVE while away: ghost shape dissolves on reopen', async () => {
        // moving ink on the tablet: xochitl tombstones every original item and
        // recreates it under its own author, so a reopened overlay must not
        // still point at tombstones and re-render a ghost duplicate
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const s1 = await openSession(daemon, [])
        await s1.apply([textShapeOp('shape:T1', 'HI')])
        const allItems = s1.currentOverlay.shapes[0]!.rendered.flatMap((p) => p.items)
        s1.close()

        // the "move": tablet erases ALL rendered items + draws replacements
        daemon.tabletErase(DOC, PAGE, allItems)
        daemon.tabletDraw(DOC, PAGE, [
            { x: 700, y: 700 },
            { x: 800, y: 800 },
        ])

        const patches: ViewPatch[] = []
        const s2 = await openSession(daemon, patches)
        expect(s2.currentOverlay.shapes).toHaveLength(0)
        expect(patches.map((p) => p.type)).toContain('shape-removed')
        const { RmDocument } = await import('@weft/rm-format')
        const doc = RmDocument.parse((await daemon.getPage(DOC, PAGE))!.bytes)
        const liveEngine = doc.blocks.filter(
            (b) =>
                b.type === 'sceneLineItem' &&
                b.deletedLength === 0 &&
                (b as { itemId: { part1: number } }).itemId.part1 !== 1, // author 1 = tablet
        )
        expect(liveEngine).toHaveLength(0) // NO ghost re-render at engine level
        s2.close()
    })

    test('partial erase while away: shape opens as detached, not live', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const s1 = await openSession(daemon, [])
        await s1.apply([
            {
                type: 'upsert-shape',
                shape: {
                    shapeId: 'shape:T2',
                    kind: 'text',
                    props: { text: 'X' },
                    x: 0,
                    y: 0,
                    rotation: 0,
                    renderRevision: 'r1',
                    version: { ts: ++versionClock, actor: 'test' },
                },
                parts: [{ partKey: 'glyph:0', strokes: strokes(2) }],
            },
        ])
        const part = s1.currentOverlay.shapes[0]!.rendered[0]!
        s1.close()

        daemon.tabletErase(DOC, PAGE, [part.items[0]!])

        const patches: ViewPatch[] = []
        const s2 = await openSession(daemon, patches)
        expect(s2.currentOverlay.shapes[0]!.state).toBe('detached')
        expect(patches.map((p) => p.type)).toContain('shape-detached')
        s2.close()
    })

    test('clean glyph erase while away: text repairs on reopen (ABCD -> ABC)', async () => {
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const s1 = await openSession(daemon, [])
        await s1.apply([textShapeOp('shape:T1', 'ABCD')])
        const glyphD = s1.currentOverlay.shapes[0]!.rendered.find((p) => p.partKey === 'glyph:3')!
        s1.close()

        daemon.tabletErase(DOC, PAGE, glyphD.items)

        const patches: ViewPatch[] = []
        const s2 = await openSession(daemon, patches)
        const edit = patches.find((p) => p.type === 'shape-edited') as
            | Extract<ViewPatch, { type: 'shape-edited' }>
            | undefined
        expect(edit?.edit).toEqual({ kind: 'text-truncate-glyphs', removedGlyphIndices: [3] })
        s2.close()
    })

    test('MIDDLE glyph erase while away: shape opens detached, not reflowed — D8', async () => {
        // auditOverlay (reopen path) mirrors the live reconcile: a hole in the
        // middle of a text shape must open DETACHED, never as a truncate repair.
        const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
        const s1 = await openSession(daemon, [])
        await s1.apply([textShapeOp('shape:T1', 'abcd')])
        const glyphC = s1.currentOverlay.shapes[0]!.rendered.find((p) => p.partKey === 'glyph:2')!
        s1.close()

        daemon.tabletErase(DOC, PAGE, glyphC.items)

        const patches: ViewPatch[] = []
        const s2 = await openSession(daemon, patches)
        expect(s2.currentOverlay.shapes[0]!.state).toBe('detached')
        expect(patches.map((p) => p.type)).toContain('shape-detached')
        expect(patches.map((p) => p.type)).not.toContain('shape-edited')
        s2.close()
    })
})

test('release-shape: overlay forgets the shape, surviving ink stays live', async () => {
    const daemon = FakeDaemon.withBlankPage(DOC, PAGE)
    const session = await openSession(daemon, [])
    await session.apply([textShapeOp('shape:T1', 'AB')])
    const { RmDocument } = await import('@weft/rm-format')
    const liveBefore = RmDocument.parse((await daemon.getPage(DOC, PAGE))!.bytes).blocks.filter(
        (b) => b.type === 'sceneLineItem' && b.deletedLength === 0,
    ).length
    await session.apply([
        { type: 'release-shape', shapeId: 'shape:T1', version: { ts: ++versionClock, actor: 'test' } },
    ])
    expect(session.currentOverlay.shapes).toHaveLength(0)
    const liveAfter = RmDocument.parse((await daemon.getPage(DOC, PAGE))!.bytes).blocks.filter(
        (b) => b.type === 'sceneLineItem' && b.deletedLength === 0,
    ).length
    expect(liveAfter).toBe(liveBefore) // strokes NOT tombstoned
    session.close()
})
