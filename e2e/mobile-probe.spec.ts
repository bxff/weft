// Screenshot probe at a phone viewport. Not a regression test.
import { test, expect } from '@playwright/test'
import { useCloudMode } from './cloud-mode'

useCloudMode()
test.use({ viewport: { width: 390, height: 844 } })

test('mobile: library + editor screenshots', async ({ page }) => {
    await page.goto('/library')
    await expect(page.getByText('Dev Notebook')).toBeVisible({ timeout: 20000 })
    await page.screenshot({ path: 'e2e/artifacts/mobile-library.png' })
    await page.goto('/app/11111111-1111-4111-a111-111111111111/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa')
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30000 })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: 'e2e/artifacts/mobile-editor.png' })
})
