/**
 * D8 trailing repair when an erase lands right after a web edit re-projected
 * the text: type "abcd", append "q" (mints a new stroke generation), then
 * the tablet erases the trailing "q" glyph. Expected: repairs to "abcd",
 * still editable, no detach.
 */

import { test, expect, type Page } from '@playwright/test'
import { useCloudMode, CLOUD_ORIGIN, E2E_USER } from './cloud-mode'
import { eraseItemsInRm, type OverlayShapeJson, type ItemRef } from './tablet-erase'

useCloudMode()

const DOC = '22222222-2222-4222-a222-222222222222'
const RACE_PAGE = 'ceceabcd-0000-4000-a000-00000000d804'

const AUTH = { authorization: `Bearer dev:${E2E_USER}` }

async function deviceToken(): Promise<string> {
    const r = await fetch(`${CLOUD_ORIGIN}/api/pair`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'd8-race-tablet' }),
    })
    if (!r.ok) throw new Error(`pair failed: ${r.status}`)
    return ((await r.json()) as { token: string }).token
}

let TABLET_TOKEN: string
test.beforeAll(async () => {
    TABLET_TOKEN = await deviceToken()
})

async function synced(page: Page): Promise<void> {
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30_000 })
}

/** Poll the overlay until the text shape has exactly `glyphCount` glyphs. */
async function textOverlay(page: Page, glyphCount: number): Promise<OverlayShapeJson> {
    let shape: OverlayShapeJson | undefined
    await expect
        .poll(
            async () => {
                const r = await page.request.get(`/api/documents/${DOC}/pages/${RACE_PAGE}/overlay`)
                if (!r.ok()) return -1
                const body = (await r.json()) as { shapes: OverlayShapeJson[] }
                shape = body.shapes.find((s) => s.kind === 'text')
                return shape?.rendered.filter((p) => /^glyph:\d+$/.test(p.partKey)).length ?? -1
            },
            { timeout: 30_000 },
        )
        .toBe(glyphCount)
    return shape!
}

async function tabletErase(page: Page, items: ItemRef[]): Promise<void> {
    const r = await page.request.get(`/api/documents/${DOC}/pages/${RACE_PAGE}/rm`)
    expect(r.ok()).toBe(true)
    const revision = r.headers()['x-rm-revision'] ?? ''
    const erased = await eraseItemsInRm(new Uint8Array(await r.body()), items)
    const put = await fetch(`${CLOUD_ORIGIN}/api/documents/${DOC}/pages/${RACE_PAGE}/rm`, {
        method: 'PUT',
        headers: {
            'content-type': 'application/octet-stream',
            'x-device-token': TABLET_TOKEN,
            'x-base-revision': revision,
        },
        body: erased,
    })
    expect(put.ok).toBe(true)
}

test('erase of the freshly re-projected trailing glyph repairs (edit, then tablet erase)', async ({ page }) => {
    await page.goto(`/app/${DOC}/${RACE_PAGE}`)
    await synced(page)

    // seed "abcd"
    await page.keyboard.press('t')
    const canvas = page.locator('.tl-canvas')
    const box = (await canvas.boundingBox())!
    await page.mouse.click(box.x + box.width / 2 - 60, box.y + 240)
    await page.keyboard.type('abcd', { delay: 40 })
    await page.keyboard.press('Escape')
    await textOverlay(page, 4)

    const textShape = page.locator('.tl-shape[data-shape-type="text"]')
    await expect(textShape).toContainText('abcd')

    // wait for the TipTap editor to take focus: an End pressed before focus
    // is a no-op and "q" lands at the dblclick caret instead of the end
    await textShape.dblclick()
    await expect(page.locator('[contenteditable="true"]').first()).toBeFocused({
        timeout: 10_000,
    })
    await page.keyboard.press('End')
    await page.keyboard.type('q', { delay: 40 })
    await page.keyboard.press('Escape')
    const fresh = await textOverlay(page, 5)
    await expect(textShape).toContainText('abcdq')

    // the tablet erases the trailing "q" glyph of the FRESH generation
    const qItems = fresh.rendered.find((p) => p.partKey === 'glyph:4')!.items
    await tabletErase(page, qItems)

    // live repair: "abcdq" -> "abcd", still editable text, never detached
    await expect(textShape).toContainText('abcd', { timeout: 30_000 })
    await expect(textShape).not.toContainText('abcdq', { timeout: 30_000 })
    await expect(page.getByText('Edited on tablet — shape detached')).toHaveCount(0)
    await expect(page.locator('.tl-shape[data-shape-type="text"]')).toHaveCount(1)
})
