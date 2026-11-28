import { expect, test } from '@playwright/test'

test('the old join URL offers open signup without an invitation', async ({ page }) => {
    await page.goto('/join')
    await expect(page.getByText('You don’t need an invitation', { exact: false })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Continue to Weft' })).toHaveAttribute('href', '/')
    await expect(page.getByText('Use an existing invitation instead')).toHaveCount(0)
})

for (const url of ['/join#old-beta', '/join?code=old-beta']) {
    test(`coded join link keeps optional legacy redemption (${url})`, async ({ page }) => {
        const requests: unknown[] = []
        await page.route('**/api/invite', async route => {
            requests.push(route.request().postDataJSON())
            await route.fulfill({ status: 404, json: { error: 'invites are disabled' } })
        })
        await page.goto(url)
        await expect(page.getByRole('link', { name: 'Continue to Weft' })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Use invitation' })).toHaveCount(0)
        await page.getByText('Use an existing invitation instead').click()
        await page.getByRole('textbox', { name: 'Google account email' }).fill('test@example.invalid')
        await page.getByRole('button', { name: 'Use invitation' }).click()
        await expect(page.getByRole('alert')).toHaveText('invites are disabled')
        expect(requests).toEqual([{ code: 'old-beta', email: 'test@example.invalid' }])
        await page.getByRole('link', { name: 'Continue to Weft' }).click()
        await expect(page).toHaveURL(/\/$/)
    })
}
