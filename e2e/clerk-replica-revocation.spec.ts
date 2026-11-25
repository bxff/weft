import { expect, test } from '@playwright/test'

test('a stale Clerk tab cannot use its earlier account after another tab signs in', async ({ page, context, baseURL }) => {
    const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
    const url = `/app/${doc}/${sheet}`
    const first = 'clerk-first', second = 'clerk-second'
    await context.addInitScript(({ relay, fallback }) => {
        localStorage.setItem('weft-server-url', relay)
        localStorage.setItem('weft-clerk-pk', 'fixture-publishable-key')
        const subject = localStorage.getItem('test-clerk-subject') ?? fallback
        const claims = { sub: subject, iss: 'https://fixture-issuer.test', exp: Date.now() / 1000 + 3600 }
        const bearer = `fixture.${btoa(JSON.stringify(claims))}.signature`
        let signedIn = location.search !== '?choose'
        const listeners: (() => void)[] = []
        Object.assign(window, { __WEFT_CLERK_MOCK__: {
            get user() { return signedIn ? { id: subject } : null },
            get session() { return signedIn ? { getToken: async () => bearer } : null },
            openSignIn() {
                signedIn = true
                listeners.forEach((fn) => fn())
            },
            async signOut() {},
            addListener(fn: () => void) { listeners.push(fn) },
        }, testRefreshClerk: () => listeners.forEach((fn) => fn()) })
    }, { relay: baseURL!, fallback: first })
    await context.route('**/api/**', (route) => {
        const headers = route.request().headers()
        const bearer = headers.authorization
        if (!bearer?.startsWith('Bearer fixture.')) return route.continue()
        const claims = JSON.parse(Buffer.from(bearer.split('.')[1]!, 'base64').toString())
        return route.continue({ headers: { ...headers, authorization: 'Bearer dev:' + claims.sub } })
    })
    await page.goto(url)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await page.evaluate((subject) => {
        const tab = window as any
        tab.oldTransport = tab.__weftController.opts.transport
        localStorage.setItem('test-clerk-subject', subject)
    }, second)
    const replacement = await context.newPage()
    await replacement.goto('/settings?choose')
    await replacement.getByRole('button', { name: /Sign in with Google/ }).click()
    await expect(replacement.getByText(`Signed in as ${second}`)).toBeVisible()
    await replacement.goto(url)
    await expect(replacement.getByTestId('sync-status')).toHaveText('synced')

    const old = await page.evaluate(async () => {
        const tab = window as any
        tab.testRefreshClerk()
        return tab.oldTransport.listDocuments().then(() => 'sent', () => 'revoked')
    })
    expect(old).toBe('revoked')
    await expect(page.locator('.tl-canvas')).toBeHidden()
    await expect(replacement.locator('.tl-canvas')).toBeVisible()
})

test('a stale SDK identity without any cached bearer must not overwrite the selected account', async ({ page, context, baseURL }) => {
    const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
    const url = `/app/${doc}/${sheet}`
    const first = 'clerk-first', second = 'clerk-second'
    await context.addInitScript(({ relay, first, second }) => {
        localStorage.setItem('weft-server-url', relay)
        localStorage.setItem('weft-clerk-pk', 'fixture-publishable-key')
        const query = new URLSearchParams(location.search)
        const subject = query.has('stale') ? first : second
        const claims = { sub: subject, iss: 'https://fixture-issuer.test', exp: Date.now() / 1000 + 3600 }
        const bearer = `fixture.${btoa(JSON.stringify(claims))}.signature`
        const w = window as any
        w.tokensReady = subject === second || query.has('ready')
        w.__WEFT_CLERK_MOCK__ = {
            user: { id: subject },
            session: { getToken: async () => { if (!w.tokensReady) return null; w.tokenReturned = true; return bearer } },
            openSignIn() {}, async signOut() {}, addListener() {},
        }
    }, { relay: baseURL!, first, second })
    const observed: string[] = []
    await context.route('**/api/**', (route) => {
        const headers = route.request().headers()
        const bearer = headers.authorization
        if (!bearer?.startsWith('Bearer fixture.')) return route.continue()
        const claims = JSON.parse(Buffer.from(bearer.split('.')[1]!, 'base64').toString())
        observed.push(claims.sub)
        return route.continue({ headers: { ...headers, authorization: 'Bearer dev:' + claims.sub } })
    })
    await page.goto(url + '?stale')
    await expect(page.getByText(/Unauthorized/).first()).toBeVisible()
    expect(await page.evaluate(() => sessionStorage.getItem('weft-clerk-token'))).toBeNull()
    const replacement = await context.newPage()
    await replacement.goto(url)
    await expect(replacement.getByTestId('sync-status')).toHaveText('synced')
    await page.goto(`/app/${doc}/${crypto.randomUUID()}?stale&ready`)
    await page.waitForFunction(() => (window as any).tokenReturned)
    const read = () => replacement.evaluate(() => Object.entries(localStorage)
        .find(([key]) => key.startsWith('weft-clerk-active/'))?.[1])
    await expect.poll(async () => {
        if (observed.includes(first)) return 'old bearer sent'
        if (await page.getByText(/Unauthorized/).count()) return 'refused'
        return 'opening'
    }).toBe('refused')
    expect(await read()).toContain(second)
    expect(observed).not.toContain(first)
})

test('signing out through a tab without a bearer still revokes the selected account', async ({ page, context, baseURL }) => {
    await context.addInitScript(relay => {
        localStorage.setItem('weft-server-url', relay)
        localStorage.setItem('weft-clerk-pk', 'fixture-publishable-key')
        const subject = location.search === '?different' ? 'clerk-different' : 'clerk-account'
        const claims = { sub: subject, iss: 'https://fixture-issuer.test', exp: Date.now() / 1000 + 3600 }
        const bearer = `fixture.${btoa(JSON.stringify(claims))}.signature`
        const w = window as any
        w.__WEFT_CLERK_MOCK__ = {
            user: { id: subject },
            session: { getToken: async () => location.pathname === '/settings' ? null : bearer },
            openSignIn() {}, async signOut() { w.__WEFT_CLERK_MOCK__.user = null; w.didSignOut = true }, addListener() {},
        }
    }, baseURL!)
    await context.route('**/api/**', (route) => {
        const headers = route.request().headers()
        if (!headers.authorization?.startsWith('Bearer fixture.')) return route.continue()
        return route.continue({ headers: { ...headers, authorization: 'Bearer dev:clerk-account' } })
    })
    await page.goto(`/app/${crypto.randomUUID()}/${crypto.randomUUID()}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const settings = await context.newPage()
    await settings.goto('/settings?different')
    await settings.getByRole('button', { name: 'Sign out' }).click()
    await settings.waitForFunction(() => (window as any).didSignOut)
    await expect(page.locator('.tl-canvas')).toBeVisible()
    const selected = () => page.evaluate(() => Object.entries(localStorage)
        .find(([key]) => key.startsWith('weft-clerk-active/') && !key.endsWith('/sign-in'))?.[1])
    expect(await selected()).toContain('clerk-account')

    await settings.goto('/settings')
    await expect(settings.getByRole('button', { name: 'Sign out' })).toBeVisible()
    expect(await settings.evaluate(() => sessionStorage.getItem('weft-clerk-token'))).toBeNull()
    await settings.getByRole('button', { name: 'Sign out' }).click()
    await settings.waitForFunction(() => (window as any).didSignOut)
    expect(await selected()).toBe('')
    await expect(page.locator('.tl-canvas')).toBeHidden()
})
