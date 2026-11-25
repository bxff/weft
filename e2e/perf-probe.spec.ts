// Open-time breakdown probe: prints the weft:open laps for a real page.
import { test, expect } from '@playwright/test'
import { useCloudMode } from './cloud-mode'

useCloudMode()

test('open-time laps for the real 175-stroke page', async ({ page }) => {
    const laps: string[] = []
    page.on('console', (m) => {
        if (m.text().includes('weft:open')) laps.push(m.text())
    })
    const nav0 = Date.now()
    await page.goto('/app/11111111-1111-4111-a111-111111111111/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa')
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30000 })
    const total = Date.now() - nav0
    console.log(`TOTAL nav->saved: ${total}ms`)
    for (const l of laps) console.log(l)
    expect(laps.length).toBeGreaterThan(0)
})
