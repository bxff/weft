/**
 * Clerk-path verification without Clerk keys. Test 1 drives the full flow
 * (UI branch, session token into REST + pairing, sign-out) via a mock of the
 * ClerkLike seam and forwards that fixture's JWT as the relay's dev credential.
 * Test 2 loads the
 * real @clerk/clerk-js with a valid key for an intercepted domain to prove
 * lazy-load, FAPI-origin derivation from the key, and graceful degradation to
 * signed-out when Clerk is down.
 */

import { test, expect, type Page } from '@playwright/test'
import { startTestRelay } from './test-relay'

const USER = 'clerk-e2e'
const AUTH = { authorization: `Bearer dev:${USER}` }
const DOC = '77777777-7777-4777-a777-777777777777'

// base64('clerk.example.com$'): well-formed pk for a domain we intercept
const FAKE_PK = 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k'

let relay: Awaited<ReturnType<typeof startTestRelay>>

test.beforeAll(async () => {
    relay = await startTestRelay()
    const r = await fetch(`${relay.origin}/api/documents`, {
        method: 'PUT',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({
            documents: [
                {
                    id: DOC,
                    name: 'Clerk Notebook',
                    parent: '',
                    type: 'notebook',
                    pages: [{ id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }],
                    lastModified: 1_750_000_000_000,
                },
            ],
        }),
    })
    expect(r.ok).toBe(true)
})

test.afterAll(() => {
    relay?.stop()
})

async function enterClerkCloudMode(page: Page, opts: { mock: boolean }): Promise<void> {
    if (opts.mock) {
        const claims = { sub: 'user_mock', iss: 'https://clerk.example.com', exp: Date.now() / 1000 + 3600 }
        const token = 'fixture.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature'
        await page.route(`${relay.origin}/api/**`, (route) => {
            const headers = route.request().headers()
            if (headers.authorization !== `Bearer ${token}`) return route.continue()
            return route.continue({ headers: { ...headers, ...AUTH } })
        })
        // injected before app code on every navigation; sign-in state persists
        // via localStorage (standing in for a Clerk session cookie)
        await page.addInitScript(`
            const listeners = []
            const signedIn = () => localStorage.getItem('mock-clerk-session') === '1'
            window.__WEFT_CLERK_MOCK__ = {
                get user() {
                    return signedIn()
                        ? {
                              id: 'user_mock',
                              username: 'clerk-e2e',
                              primaryEmailAddress: { emailAddress: 'clerk@example.com' },
                          }
                        : null
                },
                get session() {
                    return signedIn() ? { getToken: async () => ${JSON.stringify(token)} } : null
                },
                openSignIn() {
                    localStorage.setItem('mock-clerk-session', '1')
                    listeners.forEach((l) => l())
                },
                async signOut() {
                    localStorage.removeItem('mock-clerk-session')
                    listeners.forEach((l) => l())
                },
                addListener(l) { listeners.push(l) },
            }
        `)
    }
    await page.goto('/')
    await page.evaluate(
        ([url, pk]) => {
            localStorage.setItem('weft-server-url', url!)
            localStorage.setItem('weft-clerk-pk', pk!)
            localStorage.removeItem('weft-dev-user')
            localStorage.removeItem('weft-docs-cache')
        },
        [relay.origin, opts.mock ? 'pk_test_mock' : FAKE_PK],
    )
    await page.reload()
}

test('clerk path end-to-end: sign-in -> session token -> docs + pairing -> sign-out', async ({
    page,
}) => {
    await enterClerkCloudMode(page, { mock: true })

    // signed out: grid shows the sign-in gate
    await page.goto('/library')
    await expect(page.getByText('Sign in to see your notebooks')).toBeVisible()

    // settings shows the Clerk account section (not the dev-user input)
    await page.goto('/settings')
    await expect(page.getByTestId('dev-user')).toHaveCount(0)
    const signInButton = page.getByRole('button', {
        // copy carries a trailing arrow ornament; match the label only
        name: /Sign in with Google/,
    })
    await expect(signInButton).toBeVisible()

    // sign in; the listener-driven label refresh must show the identity
    await signInButton.click()
    await expect(page.getByText('Signed in as clerk@example.com')).toBeVisible()

    // the session token now authenticates the grid
    await page.goto('/library')
    await expect(page.getByText('clerk@example.com', { exact: true })).toBeVisible()
    await expect(page.getByText('Clerk Notebook')).toBeVisible()

    // pairing uses the same session token; minted token must work as a device
    // (the pair flow lives on /install: generate fills the setup command)
    await page.goto('/install')
    await page.getByTestId('generate-setup').click()
    await expect(page.locator('.installer-cmd')).toContainText('--token chd_', {
        timeout: 10_000,
    })
    const command = await page.locator('.installer-cmd').textContent()
    const token = /--token (chd_[a-f0-9]+)/.exec(command!)![1]!
    const viaDevice = await fetch(`${relay.origin}/api/documents`, {
        headers: { 'x-device-token': token },
    })
    expect(viaDevice.ok).toBe(true)
    const body = (await viaDevice.json()) as { documents: { name: string }[] }
    expect(body.documents.some((d) => d.name === 'Clerk Notebook')).toBe(true)

    // sign out (from settings, where the account controls live) -> back to the gate
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0)
    await page.goto('/library')
    await expect(page.getByText('Sign in to see your notebooks')).toBeVisible()
})

test('real @clerk/clerk-js lazy-loads from the key and degrades when Clerk is down', async ({
    page,
}) => {
    let fapiHit = false
    await page.route('**://clerk.example.com/**', (route) => {
        fapiHit = true
        void route.fulfill({ status: 500, body: 'nope' })
    })

    await enterClerkCloudMode(page, { mock: false })

    // signed-out gate, not a crash
    await page.goto('/library')
    await expect(page.getByText('Sign in to see your notebooks')).toBeVisible({
        timeout: 20_000,
    })

    // the real library was imported and called the FAPI origin encoded in the
    // publishable key: the key plumbing reached clerk-js itself
    await expect.poll(() => fapiHit, { timeout: 20_000 }).toBe(true)

    // settings still renders the Clerk account branch
    await page.goto('/settings')
    await expect(
        page.getByRole('button', { name: /Sign in with Google/ }),
    ).toBeVisible({ timeout: 20_000 })
})
