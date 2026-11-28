import { expect, test } from '@playwright/test'

test.skip(process.env.PUBLIC_GUARDED_SAVES !== '1', 'Requires the guarded build')

test('a mounted guarded Clerk notebook waits for verified selection and revokes on same-tab rollover', async ({
    page, context, baseURL,
}) => {
    const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
    const path = `/app/${doc}/${sheet}`
    const api = `/api/documents/${doc}/pages/${sheet}`
    const original = 'weft-clerk-original', replacement = 'weft-clerk-replacement'
    const issuer = 'https://clerk-fixture.invalid'
    const calls: [string, string][] = []
    let acceptedId: string | undefined
    await context.route('**/api/**', async (route) => {
        const headers = route.request().headers()
        if (!headers.authorization?.startsWith('Bearer fixture.')) return route.continue()
        const owner = JSON.parse(Buffer.from(headers.authorization.split('.')[1]!, 'base64').toString()).sub as string
        const url = route.request().url()
        calls.push([owner, url])
        const authorization = 'Bearer dev:' + owner
        if (url.endsWith(api + '/snapshot-batch') && headers['x-snapshot-publication-id']) {
            if (!acceptedId) {
                const result = await route.fetch({ headers: { ...headers, authorization } })
                expect(result.ok()).toBe(true)
                acceptedId = headers['x-snapshot-publication-id']
                await result.dispose()
            }
            return route.abort('connectionreset')
        }
        return route.continue({ headers: { ...headers, authorization } })
    })
    await context.addInitScript(({ relay, original, issuer }) => {
        const w = window as any
        localStorage.setItem('weft-server-url', relay)
        localStorage.setItem('weft-clerk-pk', 'fixture-publishable-key')
        let owner = localStorage.getItem('fixture-clerk-owner') ?? original
        let release!: () => void
        const initial = new Promise<void>(resolve => { release = resolve })
        w.releaseFixtureToken = release
        w.fixtureTokenRequested = false
        const listeners = new Set<() => void>()
        w.fixtureOwner = (next: string) => {
            owner = next
            localStorage.setItem('fixture-clerk-owner', next)
            listeners.forEach(listener => listener())
        }
        w.__WEFT_CLERK_MOCK__ = {
            get user() { return owner ? { id: owner } : null },
            get session() {
                if (!owner) return null
                const sub = owner
                return { id: 'session_' + sub, async getToken() {
                    w.fixtureTokenRequested = true
                    if (location.search !== '?reopen') await initial
                    const claims = { sub, iss: issuer, exp: Date.now() / 1000 + 3600 }
                    return 'fixture.' + btoa(JSON.stringify(claims)) + '.signature'
                } }
            },
            openSignIn() {},
            async signOut() { w.fixtureOwner('') },
            addListener(listener: () => void) {
                listeners.add(listener)
                return () => listeners.delete(listener)
            },
        }
    }, { relay: baseURL!, original, issuer })
    await page.goto(path)
    await page.waitForFunction(() => (window as any).fixtureTokenRequested)
    await expect(page.locator('.tl-canvas')).toHaveCount(0)
    await page.evaluate(() => (window as any).releaseFixtureToken())
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await page.waitForFunction(() => !!(window as any).__weftController.opts.transport.pageEventsConnection)
    const nativeText = page.locator('.tl-shape[data-shape-type="device-text"]')

    await page.evaluate(async () => {
        const w = window as any
        w.oldGuardedTransport = w.__weftController.opts.transport
        await w.__weftController.editRootText({
            create: {}, inserts: [{ afterKey: null, text: 'Original owner pending words' }],
        })
        await w.__weftController.saveBeforeNavigation()
    })
    await expect(nativeText).toHaveText('Original owner pending words')
    await expect.poll(() => acceptedId).toBeTruthy()
    await page.evaluate(owner => (window as any).fixtureOwner(owner), replacement)
    await expect(page.getByRole('button', { name: 'Reload to reopen' })).toBeVisible()
    await expect(nativeText).toBeHidden()
    await page.waitForFunction(() => !(window as any).oldGuardedTransport.pageEventsConnection)
    // No cross-tab storage event or page navigation was needed to fence the old transport.
    await page.evaluate(owner => (window as any).fixtureOwner(owner), original)
    const witness = await page.evaluate(async () => {
        const old = (window as any).oldGuardedTransport
        return old.listDocuments().then(() => 'sent', () => 'revoked')
    })
    expect(witness).toBe('revoked')
    await expect(nativeText).toBeHidden()
    expect(calls.filter(([owner, url]) => owner === replacement && url.includes(api))).toEqual([])
    await page.close()

    // Original owner can reopen offline, preserving the independently scoped
    // journal even though the accepted response never reached this browser.
    const reopened = await context.newPage()
    await reopened.route('**/api/**', route => route.abort('connectionfailed'))
    await reopened.goto(path + '?reopen')
    await expect(reopened.locator('.tl-shape[data-shape-type="device-text"]')).toHaveText('Original owner pending words')
})
