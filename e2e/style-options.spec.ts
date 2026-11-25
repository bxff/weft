/**
 * The style panel only offers what reMarkable can express: opacity is hidden
 * because RM ink is fully opaque (a faded shape would sync as solid ink).
 */
import { test, expect, type Page } from '@playwright/test'
import { useCloudMode } from './cloud-mode'

useCloudMode()

const CENTERED = '22222222-2222-4222-a222-222222222222'
const CENTERED_PAGE = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb'

async function waitForSynced(page: Page): Promise<void> {
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30_000 })
}

test('style panel hides the opacity slider (RM ink is opaque)', async ({ page }) => {
    await page.goto(`/app/${CENTERED}/${CENTERED_PAGE}`)
    await waitForSynced(page)
    await page.keyboard.press('v')
    await page.keyboard.press('Control+a')
    await expect(page.locator('.tlui-style-panel')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('style.opacity')).toBeHidden()
})

test('the active SDK theme uses tablet palette aliases in both color modes', async ({ page }) => {
    await page.goto(`/app/${CENTERED}/${CENTERED_PAGE}`)
    await waitForSynced(page)
    const colors = await page.evaluate(() => {
        const editor = (window as unknown as { __weftEditor: import('tldraw').Editor }).__weftEditor
        return editor.getCurrentTheme().colors
    })
    for (const mode of ['dark', 'light'] as const) {
        expect(colors[mode].orange).toEqual(colors[mode].red)
        expect(colors[mode]['light-violet']).toEqual(colors[mode].violet)
    }
})
