import { expect, test } from '@playwright/test'

for (const signedIn of [false, true]) {
    test(`homepage waits for hosted identity (signed in: ${signedIn})`, async ({ page }) => {
        await page.addInitScript((signedIn) => {
            localStorage.setItem('weft-clerk-pk', 'pk_test_homepage')
            Object.assign(window, {
                __WEFT_CLERK_MOCK__: new Promise((resolve) => {
                    window.addEventListener('weft-test-auth-ready', () => {
                        resolve({ user: signedIn ? { id: 'fixture-user' } : null })
                    }, { once: true })
                }),
            })
        }, signedIn)
        await page.goto('/')
        await expect(page.getByRole('link', { name: 'Read the docs' })).toBeVisible()
        await expect(page.getByRole('link', { name: 'Open notes', exact: true })).toHaveCount(0)
        await expect(page.getByRole('link', { name: 'Open your notes', exact: true })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Sign in or join the waitlist' })).toHaveCount(0)
        await page.evaluate(() => window.dispatchEvent(new Event('weft-test-auth-ready')))
        if (signedIn) {
            await expect(page.getByRole('link', { name: 'Open notes', exact: true })).toBeVisible()
            await expect(page.getByRole('link', { name: 'Open your notes', exact: true })).toBeVisible()
        } else {
            await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
            await expect(page.getByRole('button', { name: 'Sign in or join the waitlist' })).toBeVisible()
            await expect(page.getByRole('link', { name: 'Open your notes', exact: true })).toHaveCount(0)
        }
    })
}

test('self-hosted homepage opens notes without hosted auth', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('weft-clerk-pk', ''))
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Open notes', exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open your notes', exact: true })).toBeVisible()
})
