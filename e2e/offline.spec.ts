/**
 * Core scenario: edit on the PC with the tablet away; edits persist locally
 * across reloads; everything syncs when the tablet reconnects.
 */

import { test, expect, type Page } from '@playwright/test'
import { useCloudMode } from './cloud-mode'

useCloudMode()

const DOC = '44444444-4444-4444-a444-444444444444'
const PAGE = 'dddddddd-dddd-4ddd-addd-dddddddddddd'
const URL = `/app/${DOC}/${PAGE}`

async function draw(page: Page, ox: number, oy: number): Promise<void> {
    await page.keyboard.press('d')
    const canvas = page.locator('.tl-canvas')
    const box = (await canvas.boundingBox())!
    await page.mouse.move(box.x + ox, box.y + oy)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) {
        await page.mouse.move(box.x + ox + i * 8, box.y + oy + i * 4)
    }
    await page.mouse.up()
}

/** Block all daemon API traffic for this page (the tablet "goes away"). */
async function goOffline(page: Page): Promise<void> {
    await page.route('**/api/**', (route) => route.abort('connectionfailed'))
}

test('offline edits persist across reload and sync on reconnect', async ({ page }) => {
    await page.goto(URL)
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30_000 })
    const revBefore = (await page.request.get(`/api/documents/${DOC}/pages/${PAGE}/rm`)).headers()[
        'x-rm-revision'
    ]
    const shapesBefore = await page.locator('.tl-shape').count()

    await goOffline(page)
    await draw(page, 150, 150)
    await draw(page, 250, 150)
    await expect(page.getByTestId('sync-status')).toContainText('offline', { timeout: 15_000 })
    await expect(page.getByTestId('sync-status')).toHaveText('offline')

    const revStillOffline = (
        await page.request.get(`/api/documents/${DOC}/pages/${PAGE}/rm`)
    ).headers()['x-rm-revision']
    expect(revStillOffline).toBe(revBefore)

    // reload while still offline: edits must come back from IndexedDB
    await goOffline(page) // route() doesn't survive reload; re-arm
    await page.reload()
    await goOffline(page)
    await expect
        .poll(async () => page.locator('.tl-shape').count(), { timeout: 30_000 })
        .toBeGreaterThanOrEqual(shapesBefore + 2)

    await page.unroute('**/api/**')
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30_000 })
    const revAfter = (await page.request.get(`/api/documents/${DOC}/pages/${PAGE}/rm`)).headers()[
        'x-rm-revision'
    ]
    expect(revAfter).not.toBe(revBefore)
})

test('offline drawing at the bottom edge keeps growing the page', async ({ page }) => {
    await page.goto(URL)
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30_000 })
    await goOffline(page)

    const heightOf = () =>
        page.evaluate(() => {
            const sheets = [...document.querySelectorAll('div')].filter(
                (d) => d.style.background === 'white' && d.style.borderTop,
            )
            return sheets[0] ? parseFloat(sheets[0].style.height) : 0
        })
    const before = await heightOf()
    expect(before).toBeGreaterThan(0)

    const canvas = page.locator('.tl-canvas')
    const box = (await canvas.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 2500)
    await page.waitForTimeout(300)
    await page.keyboard.press('d')
    const drawX = box.x + box.width / 2 + 120
    const drawY = box.y + box.height / 2
    await page.mouse.move(drawX, drawY)
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) {
        await page.mouse.move(drawX + i * 6, drawY + i)
    }
    await page.mouse.up()

    await expect.poll(heightOf, { timeout: 15_000 }).toBeGreaterThan(before + 10)
})
