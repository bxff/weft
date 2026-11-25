/**
 * reMarkable renders ink (pen strokes) only. Every tldraw shape reducible to
 * strokes (draw, geo outlines, line, arrow, text, highlight) must project;
 * non-ink shapes (notes, frames, fills, embeds) are excluded. Verifies every
 * geo sub-type reaches the daemon as ink in the synced native .rm.
 */
import { test, expect, type Page } from '@playwright/test'
import { useCloudMode } from './cloud-mode'

useCloudMode()

const CENTERED = '22222222-2222-4222-a222-222222222222'
const CENTERED_PAGE = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb'

// tldraw's full geo sub-type set (the `geo` prop values).
const GEO_TYPES = [
    'rectangle', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon',
    'octagon', 'star', 'rhombus', 'rhombus-2', 'oval', 'trapezoid',
    'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down',
    'x-box', 'check-box', 'cloud', 'heart',
]

async function waitForSynced(page: Page): Promise<void> {
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30_000 })
}

test('every geo sub-type projects to ink strokes', async ({ page }) => {
    const { RmDocument } = await import('../packages/rm-format/src/index')
    const liveCount = async () =>
        RmDocument.parse(
            new Uint8Array(
                await (
                    await page.request.get(`/api/documents/${CENTERED}/pages/${CENTERED_PAGE}/rm`)
                ).body(),
            ) as never,
        ).blocks.filter(
            (b) =>
                b.type === 'sceneLineItem' && (b as { deletedLength: number }).deletedLength === 0,
        ).length

    await page.goto(`/app/${CENTERED}/${CENTERED_PAGE}`)
    await waitForSynced(page)

    const failures: string[] = []
    let y = 50
    for (const geo of GEO_TYPES) {
        const before = await liveCount()
        await page.evaluate(
            ({ geo, y }) => {
                const ed = (
                    window as unknown as { __weftEditor?: { createShape(s: unknown): void } }
                ).__weftEditor
                ed?.createShape({ type: 'geo', x: 60, y, props: { geo, w: 160, h: 120, dash: 'solid' } })
            },
            { geo, y },
        )
        y += 40
        try {
            await expect.poll(liveCount, { timeout: 8_000 }).toBeGreaterThan(before)
        } catch {
            failures.push(geo)
        }
    }
    expect(failures, `geo sub-types that did NOT project to ink: ${failures.join(', ')}`).toEqual([])
})

test('the geo shape tools (star etc.) are on the toolbar', async ({ page }) => {
    await page.goto(`/app/${CENTERED}/${CENTERED_PAGE}`)
    await waitForSynced(page)
    // includes shapes in the toolbar overflow ("more"), not just the visible row
    for (const t of ['star', 'triangle', 'hexagon', 'cloud', 'heart', 'diamond']) {
        await expect(page.getByTestId(`tools.${t}`)).toBeAttached({ timeout: 5_000 })
    }
})

test('highlight syncs to the tablet as a highlighter stroke (Pen 18)', async ({ page }) => {
    const { RmDocument } = await import('../packages/rm-format/src/index')
    const highlighterTools = async () =>
        RmDocument.parse(
            new Uint8Array(
                await (
                    await page.request.get(`/api/documents/${CENTERED}/pages/${CENTERED_PAGE}/rm`)
                ).body(),
            ) as never,
        ).blocks.filter(
            (b) =>
                b.type === 'sceneLineItem' &&
                (b as { deletedLength: number }).deletedLength === 0 &&
                (b as { line?: { tool: number } }).line?.tool === 18,
        ).length

    await page.goto(`/app/${CENTERED}/${CENTERED_PAGE}`)
    await waitForSynced(page)
    expect(await highlighterTools()).toBe(0)

    // draw rather than createShape: createShape requires the exact segment schema
    await page.evaluate(() => {
        ;(
            window as unknown as { __weftEditor?: { setCurrentTool(id: string): void } }
        ).__weftEditor?.setCurrentTool('highlight')
    })
    const canvas = page.locator('.tl-canvas')
    const box = (await canvas.boundingBox())!
    const y = box.y + box.height * 0.7
    await page.mouse.move(box.x + 120, y)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 120 + i * 24, y + (i % 2) * 12)
    await page.mouse.up()
    await page.keyboard.press('Escape')
    await expect.poll(highlighterTools, { timeout: 15_000 }).toBeGreaterThan(0)
})
