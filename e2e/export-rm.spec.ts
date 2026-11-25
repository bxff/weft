/**
 * Main menu offers a native reMarkable (.rm) download of the current page,
 * the exact v6 line file the tablet stores.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { useCloudMode } from './cloud-mode'

useCloudMode()

const CENTERED = '22222222-2222-4222-a222-222222222222'
const CENTERED_PAGE = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb'

test('main menu downloads the current page as a native .rm file', async ({ page }) => {
    await page.goto(`/app/${CENTERED}/${CENTERED_PAGE}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30_000 })

    await page.getByTestId('main-menu.button').click()
    const item = page.getByText('Download .rm (reMarkable)')
    await expect(item).toBeVisible()

    const [download] = await Promise.all([page.waitForEvent('download'), item.click()])
    expect(download.suggestedFilename()).toBe(`${CENTERED_PAGE}.rm`)

    const path = await download.path()
    const bytes = new Uint8Array(readFileSync(path))
    // 43-byte v6 format signature
    expect(Buffer.from(bytes.subarray(0, 43)).toString('latin1')).toContain(
        'reMarkable .lines file, version=6',
    )
    expect(bytes.length).toBeGreaterThan(200)
})
