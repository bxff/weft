import { expect, test } from '@playwright/test'
import { useCloudMode } from './cloud-mode'

useCloudMode()

test('leaving a notebook releases its editor handles and reopening installs live ones', async ({ page }) => {
    await page.goto('/app/22222222-2222-4222-a222-222222222222/bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb')
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const handles = () => page.evaluate(() => {
        const live = window as unknown as { __weftEditor?: unknown; __weftController?: unknown }
        return [!!live.__weftEditor, !!live.__weftController]
    })
    expect(await handles()).toEqual([true, true])
    await page.getByRole('link', { name: '← Files', exact: true }).click()
    await expect(page).toHaveURL(/\/library(?:\?|$)/)
    await expect.poll(handles).toEqual([false, false])
    await page.getByText('Centered Notes', { exact: true }).click()
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await expect.poll(handles).toEqual([true, true])
    await expect.poll(() => page.locator('.tl-shape').count()).toBeGreaterThanOrEqual(3)
})
