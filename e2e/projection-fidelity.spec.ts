/**
 * A shape must reach the daemon as the same thing the web canvas shows.
 * Drives the real editor and parses the synced native .rm.
 *
 * Run against a fresh `apps/web/build` (e2e-serve does not rebuild): `bun run
 * build` in apps/web first.
 */
import { test, expect, type Page } from '@playwright/test'
import { useCloudMode } from './cloud-mode'

useCloudMode()

const DOC = '22222222-2222-4222-a222-222222222222'
// dedicated page (stroke-count assertions race on the shared seeded page)
const PAGE = 'ceceabcd-0000-4000-a000-00000000e203'

type Stroke = { points: { x: number; y: number }[] }
async function liveStrokes(page: Page): Promise<Stroke[]> {
    const { RmDocument } = await import('../packages/rm-format/src/index')
    const resp = await page.request.get(`/api/documents/${DOC}/pages/${PAGE}/rm`)
    if (!resp.ok()) return [] // the dedicated page starts empty (404)
    const body = await resp.body()
    return RmDocument.parse(new Uint8Array(body) as never).blocks
        .filter(
            (b) =>
                b.type === 'sceneLineItem' &&
                (b as { deletedLength: number }).deletedLength === 0,
        )
        .map((b) => ({ points: (b as { line: { points: { x: number; y: number }[] } }).line.points }))
}

/** Wait for the projected stroke set to STOP changing (debounce + sync flush). */
async function settle(page: Page): Promise<Stroke[]> {
    let prev = -1
    let cur: Stroke[] = []
    for (let i = 0; i < 25; i++) {
        cur = await liveStrokes(page)
        if (cur.length === prev) return cur
        prev = cur.length
        await page.waitForTimeout(400)
    }
    return cur
}

const len = (s: Stroke): number => {
    let d = 0
    for (let i = 1; i < s.points.length; i++) {
        d += Math.hypot(s.points[i]!.x - s.points[i - 1]!.x, s.points[i]!.y - s.points[i - 1]!.y)
    }
    return d
}

async function createShape(page: Page, shape: Record<string, unknown>): Promise<void> {
    await page.evaluate((s) => {
        ;(window as unknown as { __weftEditor?: { createShape(s: unknown): void } }).__weftEditor?.createShape(s)
    }, shape)
}

test.beforeEach(async ({ page }) => {
    await page.goto(`/app/${DOC}/${PAGE}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30_000 })
})

test('a dotted line splits into VISIBLE dots (not microscopic), solid stays one stroke', async ({
    page,
}) => {
    const base = (await settle(page)).length
    await createShape(page, {
        type: 'line',
        x: 80,
        y: 80,
        props: { dash: 'solid', points: { a1: { id: 'a1', index: 'a1', x: 0, y: 0 }, a2: { id: 'a2', index: 'a2', x: 400, y: 0 } } },
    })
    const afterSolid = await settle(page)
    expect(afterSolid.length - base).toBeGreaterThanOrEqual(1)

    await createShape(page, {
        type: 'line',
        x: 80,
        y: 160,
        props: { dash: 'dotted', points: { a1: { id: 'a1', index: 'a1', x: 0, y: 0 }, a2: { id: 'a2', index: 'a2', x: 400, y: 0 } } },
    })
    const afterDotted = await settle(page)
    const dots = afterDotted.slice(afterSolid.length)
    expect(dots.length).toBeGreaterThan(3)
    // each dot must be a visible blob (~half the stroke width), not a speck
    const lens = dots.map(len).sort((a, b) => a - b)
    const median = lens[Math.floor(lens.length / 2)]!
    expect(median).toBeGreaterThan(2)
})

test('a dotted FREEHAND (draw) stroke honors dash (not one solid line)', async ({ page }) => {
    const base = (await settle(page)).length
    await page.evaluate(() => {
        ;(window as unknown as { __weftEditor?: { setCurrentTool(id: string): void } }).__weftEditor?.setCurrentTool('draw')
    })
    const box = (await page.locator('.tl-canvas').boundingBox())!
    const y = box.y + box.height * 0.5
    await page.mouse.move(box.x + 100, y)
    await page.mouse.down()
    for (let i = 1; i <= 16; i++) await page.mouse.move(box.x + 100 + i * 22, y)
    await page.mouse.up()
    await page.keyboard.press('Escape')
    const afterSolid = await settle(page)
    expect(afterSolid.length - base).toBeGreaterThanOrEqual(1)

    await page.evaluate(() => {
        const ed = window as unknown as {
            __weftEditor?: {
                getCurrentPageShapeIds(): Set<string>
                updateShape(s: unknown): void
            }
        }
        const ids = [...ed.__weftEditor!.getCurrentPageShapeIds()]
        ed.__weftEditor!.updateShape({ id: ids[ids.length - 1], type: 'draw', props: { dash: 'dotted' } })
    })
    const afterDotted = await settle(page)
    // dotted freehand must break into several dots
    expect(afterDotted.length - afterSolid.length).toBeGreaterThan(2)
})

test('a filled rectangle is hatched (adds an interior fill stroke over the outline)', async ({
    page,
}) => {
    const base = (await settle(page)).length
    await createShape(page, {
        type: 'geo',
        x: 700,
        y: 80,
        props: { geo: 'rectangle', w: 260, h: 200, dash: 'solid', fill: 'none' },
    })
    const afterHollow = await settle(page)
    expect(afterHollow.length - base).toBeGreaterThanOrEqual(1) // outline

    await createShape(page, {
        type: 'geo',
        x: 700,
        y: 340,
        props: { geo: 'rectangle', w: 260, h: 200, dash: 'solid', fill: 'solid' },
    })
    const afterFilled = await settle(page)
    const added = afterFilled.slice(afterHollow.length)
    // outline + at least one interior hatch stroke (hollow added only the outline)
    expect(added.length).toBeGreaterThanOrEqual(2)
    // the hatch is a long serpentine that sweeps the interior
    expect(Math.max(...added.map(len))).toBeGreaterThan(30)
})

test('a rectangle LABEL projects as ink glyphs', async ({ page }) => {
    const base = (await settle(page)).length
    await createShape(page, {
        type: 'geo',
        x: 80,
        y: 420,
        props: { geo: 'rectangle', w: 300, h: 160, dash: 'solid', fill: 'none' },
    })
    const afterPlain = await settle(page)
    const plainDelta = afterPlain.length - base

    await createShape(page, {
        type: 'geo',
        x: 80,
        y: 620,
        props: { geo: 'rectangle', w: 300, h: 160, dash: 'solid', fill: 'none' },
    })
    await settle(page)
    // set the label the deterministic way (the keyboard edit flow is flaky
    // headless); this is the same richText a user's typing produces
    await page.evaluate(() => {
        const ed = window as unknown as {
            __weftEditor?: { getCurrentPageShapeIds(): Set<string>; updateShape(s: unknown): void }
        }
        const ids = [...ed.__weftEditor!.getCurrentPageShapeIds()]
        ed.__weftEditor!.updateShape({
            id: ids[ids.length - 1],
            type: 'geo',
            props: {
                richText: {
                    type: 'doc',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'HELLO' }] }],
                },
            },
        })
    })
    const afterLabeled = await settle(page)
    // HELLO's glyph contours add many strokes beyond a bare outline
    expect(afterLabeled.length - afterPlain.length).toBeGreaterThan(plainDelta + 5)
})

test('moving a FRAME re-projects its children (frame contents follow on the tablet)', async ({ page }) => {
    // a frame is a true clipping container: children are frame-relative, so
    // moving the frame updates ONLY the frame record. Without re-enqueuing the
    // frame's descendants, their strokes never move on the tablet.
    const base = (await settle(page)).length
    const frameId = await page.evaluate(() => {
        const e = (window as unknown as { __weftEditor?: any }).__weftEditor
        e.createShape({ type: 'frame', x: 1200, y: 1000, props: { w: 300, h: 300 } })
        const ids = [...e.getCurrentPageShapeIds()]
        const fid = ids[ids.length - 1]
        e.createShape({ type: 'geo', parentId: fid, x: 1240, y: 1040, props: { geo: 'rectangle', w: 80, h: 80, dash: 'solid' } })
        return fid
    })
    const created = await settle(page)
    const minX = (ss: Stroke[]): number => Math.min(...ss.slice(base).flatMap((s) => s.points.map((p) => p.x)))
    const before = minX(created)
    await page.evaluate((fid) => {
        const e = (window as unknown as { __weftEditor?: any }).__weftEditor
        e.updateShape({ id: fid, type: 'frame', x: e.getShape(fid).x + 400 })
    }, frameId)
    // count unchanged (same child re-projected), so poll for the x shift
    let shifted = 0
    for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(400)
        shifted = minX(await liveStrokes(page)) - before
        if (shifted > 90) break // 400px * 72/226 ≈ 127 RM units
    }
    expect(shifted).toBeGreaterThan(90)
})

test('a sticky NOTE projects (outline + its text), not dropped', async ({ page }) => {
    const base = (await settle(page)).length
    await createShape(page, {
        type: 'note',
        x: 1100,
        y: 120,
        props: {
            richText: {
                type: 'doc',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'NOTE' }] }],
            },
        },
    })
    const after = await settle(page)
    // was ZERO before the fix (note not syncable); now outline + glyph strokes
    expect(after.length - base).toBeGreaterThan(4)
})
