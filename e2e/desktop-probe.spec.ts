// Desktop visual-review screenshots (authenticated, real fixtures).
import { test, expect } from '@playwright/test'
import { useCloudMode } from './cloud-mode'

useCloudMode()
// 1600 wide: at 1280 the tldraw toolbar's overflow "More" button lands on
// top of the weft dock under CI's fallback fonts (wider text metrics) and
// intercepts the panel-toggle clicks
test.use({ viewport: { width: 1600, height: 900 } })

test('tablet-width guides show mid-drag', async ({ page }) => {
    await page.goto('/app/22222222-2222-4222-a222-222222222222/bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb')
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30000 })
    // drag from the center of the FLATTEST stroke (a near-horizontal line's
    // box center is guaranteed to sit ON the ink; a tall X-shape's isn't)
    await page.keyboard.press('v')
    const shapes = page.locator('.tl-shape')
    const n = await shapes.count()
    let best: { x: number; y: number; h: number } | null = null
    for (let i = 0; i < n; i++) {
        const b = await shapes.nth(i).boundingBox()
        if (b && b.width > 40 && (best === null || b.height < best.h)) {
            best = { x: b.x + b.width / 2, y: b.y + b.height / 2, h: b.height }
        }
    }
    await page.mouse.move(best!.x, best!.y)
    await page.mouse.down()
    await page.mouse.move(best!.x + 80, best!.y + 40, { steps: 8 })
    await expect(page.getByTestId('tablet-width-guide').first()).toBeVisible()
    await page.screenshot({ path: 'e2e/artifacts/drag-guides.png' })
    await page.mouse.up()
    await expect(page.getByTestId('tablet-width-guide')).toHaveCount(0)
})

test('tablet-width guides show while ZOOMING (camera trigger)', async ({ page }) => {
    // guides must appear on any camera move (getCameraState()==='moving'), not just shape drags
    await page.goto('/app/22222222-2222-4222-a222-222222222222/bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb')
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30000 })
    await expect(page.getByTestId('tablet-width-guide')).toHaveCount(0)
    const canvas = page.locator('.tl-canvas')
    const box = (await canvas.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    // ctrl+wheel = zoom in tldraw; a burst keeps the camera in 'moving'
    await page.keyboard.down('Control')
    // Observe the guide during the gesture. Once the final wheel event settles
    // the SDK can already have returned to idle on a busy browser.
    await Promise.all([
        page.getByTestId('tablet-width-guide').first().waitFor({ state: 'visible' })
            .then(() => page.screenshot({ path: 'e2e/artifacts/zoom-guides.png' })),
        (async () => {
            for (let i = 0; i < 6; i++) {
                await page.mouse.wheel(0, -40)
                await page.waitForTimeout(30)
            }
        })(),
    ])
    await page.keyboard.up('Control')
    await expect(page.getByTestId('tablet-width-guide')).toHaveCount(0)
})

test('move dialog screenshot (visual review)', async ({ page }) => {
    await page.goto('/library')
    await expect(page.getByText('Dev Notebook')).toBeVisible({ timeout: 20000 })
    const card = page.getByText('Dev Notebook').locator('..').locator('..')
    await card.hover()
    await page.getByTestId('move-open-11111111-1111-4111-a111-111111111111').click()
    await expect(page.getByTestId('move-dialog')).toBeVisible()
    await page.screenshot({ path: 'e2e/artifacts/move-dialog.png' })
    await page.getByText('Cancel').click()
    await expect(page.getByTestId('move-dialog')).not.toBeVisible()
})

test('panel consistency screenshots (visual review)', async ({ page }) => {
    await page.goto('/app/11111111-1111-4111-a111-111111111111/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa')
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30000 })
    await page.getByTestId('layers-toggle').click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: 'e2e/artifacts/panel-layers.png' })
    await page.getByTestId('history-toggle').click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: 'e2e/artifacts/panel-history.png' })
    await page.getByTestId('sync-status').click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: 'e2e/artifacts/panel-sync.png' })
    await page.getByTestId('template-toggle').click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: 'e2e/artifacts/panel-template.png' })
})
