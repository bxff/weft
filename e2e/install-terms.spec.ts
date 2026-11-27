import { expect, test } from '@playwright/test'

test('first hosted pairing requires explicit agreement with the active terms version', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('weft-dev-user', 'terms-fixture'))
    let accepted = false
    await page.route('**/api/pair', async route => {
        if (route.request().method() === 'GET') {
            await route.fulfill({ json: { termsVersion: '2026-11-27', termsAccepted: accepted } })
            return
        }
        expect(route.request().postDataJSON()).toEqual({ label: 'tablet', acceptedTermsVersion: '2026-11-27' })
        accepted = true
        await route.fulfill({ json: { token: 'fake-pairing-token' } })
    })
    await page.goto('/install')
    const generate = page.getByRole('button', { name: 'Generate my token' })
    await expect(generate).toBeDisabled()
    await expect(page.getByRole('link', { name: 'Read the Hosted Terms' })).toHaveAttribute('href', '/terms')
    await page.getByRole('checkbox', { name: 'I agree to the Hosted Terms.' }).check()
    await generate.click()
    await expect(page.locator('.installer-cmd')).toContainText('fake-pairing-token')
    await page.reload()
    await expect(generate).toBeEnabled()
    await expect(page.getByRole('checkbox', { name: 'I agree to the Hosted Terms.' })).toHaveCount(0)
})

test('install can pair against a relay that predates the terms policy', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('weft-dev-user', 'legacy-terms-fixture'))
    await page.route('**/api/pair', async route => {
        if (route.request().method() === 'GET') {
            await route.fulfill({ status: 404 })
            return
        }
        expect(route.request().postDataJSON()).toEqual({ label: 'tablet' })
        await route.fulfill({ json: { token: 'fake-legacy-token' } })
    })
    await page.goto('/install')
    await page.getByRole('button', { name: 'Generate my token' }).click()
    await expect(page.locator('.installer-cmd')).toContainText('fake-legacy-token')
})
