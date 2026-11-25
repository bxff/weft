// Drag-latency probe: select-all + scripted drag on the seeded 175-stroke
// page; reports main-thread long tasks and wall time.
import { test, expect } from '@playwright/test'
import { useCloudMode } from './cloud-mode'

useCloudMode()

test('drag latency on the 175-stroke page', async ({ page }) => {
    await page.addInitScript(() => {
        ;(window as unknown as { __long: number[] }).__long = []
        try {
            new PerformanceObserver((list) => {
                for (const e of list.getEntries())
                    (window as unknown as { __long: number[] }).__long.push(e.duration)
            }).observe({ entryTypes: ['longtask'] })
        } catch {
            // longtask unsupported: wall time still reported
        }
    })
    await page.goto('/app/11111111-1111-4111-a111-111111111111/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa')
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30000 })
    await page.waitForTimeout(1500)

    const canvas = page.locator('.tl-canvas')
    const box = (await canvas.boundingBox())!
    await page.keyboard.press('Control+a')
    await page.waitForTimeout(300)
    const baseline = await page.evaluate(() => (window as unknown as { __long: number[] }).__long.length)

    const t0 = Date.now()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    for (let i = 1; i <= 60; i++) {
        await page.mouse.move(box.x + box.width / 2 + i * 3, box.y + box.height / 2 + Math.sin(i / 5) * 40)
    }
    await page.mouse.up()
    const dragMs = Date.now() - t0
    await page.waitForTimeout(1200)
    const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long)
    const during = long.slice(baseline)
    console.log(
        `DRAG: ${dragMs}ms for 60 steps | longtasks during+after: ${during.length} totaling ${Math.round(during.reduce((a, b) => a + b, 0))}ms | worst ${Math.round(Math.max(0, ...during))}ms`,
    )
    expect(dragMs).toBeGreaterThan(0)
})
