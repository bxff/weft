/**
 * Text end-to-end in a real browser: typed text projects to glyph strokes on
 * the daemon, survives reload as EDITABLE TEXT (the original PoC failure),
 * and the ABCD->ABC repair path works when "the tablet" erases a glyph.
 */

import { test, expect, type Page } from '@playwright/test'
import { useCloudMode } from './cloud-mode'

useCloudMode()

const DOC = '22222222-2222-4222-a222-222222222222'
// dedicated page: shape-fidelity/projection-fidelity write to the shared
// seeded page concurrently, which races this spec's whole-page assertions
const PAGE = 'ceceabcd-0000-4000-a000-00000000e201'
const URL = `/app/${DOC}/${PAGE}`

async function synced(page: Page): Promise<void> {
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30_000 })
}

test('text stays text across reload and projects glyph parts', async ({ page }) => {
    await page.goto(URL)
    await synced(page)
    const revBefore = (await page.request.get(`/api/documents/${DOC}/pages/${PAGE}/rm`)).headers()[
        'x-rm-revision'
    ]

    await page.keyboard.press('t')
    const canvas = page.locator('.tl-canvas')
    const box = (await canvas.boundingBox())!
    await page.mouse.click(box.x + box.width / 2 - 50, box.y + 260)
    await page.keyboard.type('ABCD', { delay: 40 })
    await page.keyboard.press('Escape')

    await expect
        .poll(
            async () =>
                (await page.request.get(`/api/documents/${DOC}/pages/${PAGE}/rm`)).headers()[
                    'x-rm-revision'
                ],
            { timeout: 20_000 },
        )
        .not.toBe(revBefore)

    // overlay must carry per-glyph parts (the repair substrate)
    const overlay = (await (
        await page.request.get(`/api/documents/${DOC}/pages/${PAGE}/overlay`)
    ).json()) as { shapes: { kind: string; rendered: { partKey: string }[] }[] }
    const textShape = overlay.shapes.find((s) => s.kind === 'text')
    expect(textShape).toBeDefined()
    expect(textShape!.rendered.map((p) => p.partKey)).toEqual([
        'glyph:0',
        'glyph:1',
        'glyph:2',
        'glyph:3',
    ])

    // reload: text must come back as an editable text shape
    await page.reload()
    await synced(page)
    const textShapes = page.locator('.tl-shape[data-shape-type="text"]')
    await expect.poll(async () => textShapes.count(), { timeout: 20_000 }).toBe(1)
    await expect(page.locator('.tl-shape[data-shape-type="text"]')).toContainText('ABCD')

    // glyph ink on the device must sit where the browser draws the text:
    // compare the DOM glyph rect with the .rm ink bbox, both in page coords
    // (baseline must be CSS half-leading+ascent, not the line-box bottom)
    const rm = await (await page.request.get(`/api/documents/${DOC}/pages/${PAGE}/rm`)).body()
    const { RmDocument } = await import('../packages/rm-format/src/index')
    const doc = RmDocument.parse(new Uint8Array(rm) as never)
    // scope the bbox to this shape's items: the dev page accumulates strokes
    // across runs (author uuid -> file-local index, as tablet-erase.ts)
    const byUuid = new Map<string, number>()
    for (const [index, uuid] of doc.authorTable()) byUuid.set(uuid.toLowerCase(), index)
    const after = (await (
        await page.request.get(`/api/documents/${DOC}/pages/${PAGE}/overlay`)
    ).json()) as {
        shapes: { kind: string; rendered: { items: { authorUuid: string; clock: number }[] }[] }[]
    }
    const glyphKeys = new Set<string>()
    for (const p of after.shapes.find((s) => s.kind === 'text')!.rendered) {
        for (const i of p.items) glyphKeys.add(`${byUuid.get(i.authorUuid.toLowerCase())}:${i.clock}`)
    }
    let inkTop = Infinity
    let inkBottom = -Infinity
    for (const b of doc.blocks) {
        if (b.type !== 'sceneLineItem') continue
        const x = b as unknown as {
            itemId: { part1: number; part2: number }
            line?: { points: { y: number }[] }
        }
        if (!x.line || !glyphKeys.has(`${x.itemId.part1}:${x.itemId.part2}`)) continue
        for (const p of x.line.points) {
            if (p.y < inkTop) inkTop = p.y
            if (p.y > inkBottom) inkBottom = p.y
        }
    }
    const RM_SCALE = 144 / 226 // keep in lockstep with packages/rm-ink/src/pen.ts
    const dom = await page.evaluate(() => {
        const el = document.querySelector('.tl-shape[data-shape-type="text"]')!
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        let node: Node | null
        let rect: DOMRect | null = null
        while ((node = walker.nextNode())) {
            if (!node.textContent?.trim()) continue
            const range = document.createRange()
            range.selectNodeContents(node)
            rect = range.getBoundingClientRect()
            break
        }
        const ed = (
            window as unknown as {
                __weftController: {
                    editor: {
                        screenToPage: (p: { x: number; y: number }) => { x: number; y: number }
                    }
                }
            }
        ).__weftController.editor
        return {
            top: ed.screenToPage({ x: rect!.x, y: rect!.top }).y,
            bottom: ed.screenToPage({ x: rect!.x, y: rect!.bottom }).y,
        }
    })
    // DOM range rect spans the line box; ink spans the glyph outlines (cap
    // height, no descenders for ABCD), so ink must sit inside the box with
    // bounded gaps on both sides.
    const inkTopPx = inkTop * RM_SCALE
    const inkBottomPx = inkBottom * RM_SCALE
    const boxH = dom.bottom - dom.top
    expect(inkTopPx).toBeGreaterThan(dom.top - 1)
    expect(inkBottomPx).toBeLessThan(dom.bottom + 1)
    expect(inkTopPx - dom.top).toBeLessThan(boxH * 0.45)
    expect(dom.bottom - inkBottomPx).toBeLessThan(boxH * 0.45)
})
