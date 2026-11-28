import { expect, test } from '@playwright/test'

for (const signedIn of [false, true]) {
    test(`homepage waits for hosted identity (signed in: ${signedIn})`, async ({ page }) => {
        await page.addInitScript((signedIn) => {
            localStorage.setItem('weft-clerk-pk', 'pk_test_homepage')
            Object.assign(window, {
                __WEFT_CLERK_MOCK__: new Promise((resolve) => {
                    window.addEventListener('weft-test-auth-ready', () => {
                        resolve({
                            user: signedIn ? { id: 'fixture-user' } : null,
                            redirectToSignIn: (opts: { signInForceRedirectUrl: string; signUpForceRedirectUrl: string }) => {
                                window.dispatchEvent(new CustomEvent('weft-test-sign-in', { detail: opts }))
                            },
                        })
                    }, { once: true })
                }),
            })
        }, signedIn)
        await page.goto('/')
        await expect(page.getByRole('link', { name: 'Read the docs' })).toBeVisible()
        await expect(page.getByRole('link', { name: 'Open notes', exact: true })).toHaveCount(0)
        await expect(page.getByRole('link', { name: 'Open your notes', exact: true })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Sign in or sign up' })).toHaveCount(0)
        await page.evaluate(() => window.dispatchEvent(new Event('weft-test-auth-ready')))
        if (signedIn) {
            await expect(page.getByRole('link', { name: 'Open notes', exact: true })).toBeVisible()
            await expect(page.getByRole('link', { name: 'Open your notes', exact: true })).toBeVisible()
        } else {
            await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
            await expect(page.getByRole('button', { name: 'Sign in or sign up' })).toBeVisible()
            await expect(page.getByRole('link', { name: 'Open your notes', exact: true })).toHaveCount(0)
            await expect(page.getByText(/waitlist/i)).toHaveCount(0)
            const directSignIns: Array<[string, string]> = []
            await page.exposeFunction('recordDirectSignIn', (urls: [string, string]) => directSignIns.push(urls))
            await page.evaluate(() => {
                window.addEventListener('weft-test-sign-in', (event) => {
                    const detail = (event as CustomEvent).detail
                    void (window as unknown as { recordDirectSignIn(urls: [string, string]): Promise<void> }).recordDirectSignIn([detail.signInForceRedirectUrl, detail.signUpForceRedirectUrl])
                })
            })
            for (const name of ['Sign in or sign up', 'Sign in']) {
                await page.getByRole('button', { name, exact: true }).click()
            }
            await expect.poll(() => directSignIns).toEqual([[page.url(), page.url()], [page.url(), page.url()]])
        }
    })
}

test('self-hosted homepage opens notes without hosted auth', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('weft-clerk-pk', ''))
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Open notes', exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open your notes', exact: true })).toBeVisible()
})
