import { expect, test } from '@playwright/test'

test('a new signed-in hosted account can generate a pairing token after agreeing to the terms', async ({ page }) => {
    const fixture = { sub: 'new-beta-account', iss: 'https://fixture.clerk.example', exp: Math.floor(Date.now() / 1000) + 300 }
    const bearer = `fixture.${Buffer.from(JSON.stringify(fixture)).toString('base64url')}.signature`
    await page.addInitScript(({ sub, bearer }) => {
        localStorage.setItem('weft-clerk-pk', 'pk_test_open_beta')
        localStorage.setItem('weft-server-url', 'https://api.weft.page')
        Object.assign(window, { __WEFT_CLERK_MOCK__: Promise.resolve({
            user: { id: sub },
            session: { id: 'fixture-session', getToken: async () => bearer },
        }) })
    }, { sub: fixture.sub, bearer })
    let requests = 0
    await page.route('https://api.weft.page/api/pair', async route => {
        expect(route.request().method()).toBe('POST')
        expect(route.request().headers().authorization).toBe(`Bearer ${bearer}`)
        expect(route.request().postDataJSON()).toEqual({ label: 'tablet' })
        requests++
        await route.fulfill({
            headers: { 'access-control-allow-origin': '*' },
            json: { token: 'fake-pairing-token' },
        })
    })
    await page.goto('/install')
    const generate = page.getByRole('button', { name: 'Generate my token' })
    await expect(generate).toBeDisabled()
    expect(requests).toBe(0)
    await expect(page.getByRole('link', { name: 'Read the Hosted Terms' })).toHaveAttribute('href', '/terms')
    await page.getByRole('checkbox', { name: 'I agree to the Hosted Terms.' }).check()
    await generate.click()
    await expect(page.locator('.installer-cmd')).toContainText('fake-pairing-token')
    expect(requests).toBe(1)
})

test('self-hosted install pairs without accepting the hosted terms', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('weft-dev-user', 'self-hosted-fixture'))
    await page.route('**/api/pair', async route => {
        expect(route.request().method()).toBe('POST')
        expect(route.request().postDataJSON()).toEqual({ label: 'tablet' })
        await route.fulfill({ json: { token: 'fake-self-hosted-token' } })
    })
    await page.goto('/install')
    await expect(page.getByRole('checkbox', { name: 'I agree to the Hosted Terms.' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Generate my token' }).click()
    await expect(page.locator('.installer-cmd')).toContainText('fake-self-hosted-token')
})
