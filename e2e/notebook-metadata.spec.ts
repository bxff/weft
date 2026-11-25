import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const auth = (user: string) => ({ authorization: `Bearer dev:${user}` })

async function signIn(context: BrowserContext, origin: string, user: string) {
    await context.addInitScript(({ origin, user }) => {
        localStorage.setItem('weft-server-url', origin)
        localStorage.setItem('weft-clerk-pk', '')
        if (!localStorage.getItem('weft-dev-user')) localStorage.setItem('weft-dev-user', user)
    }, { origin, user })
}

function notebook(request: APIRequestContext) {
    const doc = crypto.randomUUID()
    const first = crypto.randomUUID()
    let modified = Date.now()
    return {
        doc, first,
        async write(user: string, name: string, template = 'Blank', pages = [first]) {
            const response = await request.put('/api/documents', { headers: auth(user), data: { documents: [{
                id: doc, name, type: 'notebook', parent: '', lastModified: ++modified,
                pages: pages.map((id) => ({ id, template })),
            }] } })
            expect(response.ok()).toBe(true)
        },
    }
}


test('account handoff cannot display a prior title or thumbnail for the same notebook IDs', async ({ page, context, request, baseURL }) => {
    const { doc, first, write } = notebook(request)
    const alice = 'metadata-alice-' + doc
    const bob = 'metadata-bob-' + doc
    const bobPng = Buffer.concat([PNG, Buffer.from('bob')])
    const thumb = `/api/documents/${doc}/pages/${first}/thumbnail`
    const card = page.locator(`a[href="/app/${doc}/${first}"]`)
    const priorTitle = page.getByText('Alice private notebook', { exact: true })
    await write(alice, 'Alice private notebook')
    await write(bob, 'Bob notebook')
    expect((await request.put(thumb, { headers: auth(alice), data: PNG })).ok()).toBe(true)
    expect((await request.put(thumb, { headers: auth(bob), data: bobPng })).ok()).toBe(true)
    await signIn(context, baseURL!, alice)
    await page.goto('/library')
    await expect(priorTitle).toBeVisible()
    await expect(card.locator('img')).toBeVisible()

    let releaseList = () => {}
    const listGate = new Promise<void>((resolve) => { releaseList = resolve })
    let releaseThumbnail = () => {}
    const thumbnailGate = new Promise<void>((resolve) => { releaseThumbnail = resolve })
    const staleAlice = Promise.withResolvers<void>()
    const releaseAlice = Promise.withResolvers<void>()
    const bobList = Promise.withResolvers<void>()
    const bobThumbnail = Promise.withResolvers<void>()
    await page.route('**/api/documents', async (route) => {
        if (route.request().headers().authorization === auth(alice).authorization) {
            const response = await route.fetch()
            staleAlice.resolve()
            await releaseAlice.promise
            await route.fulfill({ response }).catch(() => {})
            return
        }
        if (route.request().headers().authorization === auth(bob).authorization) {
            bobList.resolve()
            await listGate
        }
        await route.continue()
    })
    await page.route(`**${thumb}`, async (route) => {
        if (route.request().headers().authorization === auth(bob).authorization) {
            bobThumbnail.resolve()
            await thumbnailGate
        }
        await route.continue()
    })
    try {
        await write(alice, 'Alice stale in-flight title')
        await staleAlice.promise
        await page.evaluate((user) => {
            localStorage.setItem('weft-dev-user', user)
            window.dispatchEvent(new StorageEvent('storage', { key: 'weft-dev-user' }))
        }, bob)
        await bobList.promise
        await expect(priorTitle).toHaveCount(0)
        releaseList()
        await expect(page.getByText('Bob notebook', { exact: true })).toBeVisible()
        await bobThumbnail.promise
        await expect(card.locator('img')).toHaveCount(0)
        releaseAlice.resolve()
        await expect(page.getByText('Bob notebook', { exact: true })).toBeVisible()
        await expect(page.getByText('Alice stale in-flight title', { exact: true })).toHaveCount(0)
        await expect(card.locator('img')).toHaveCount(0)
        releaseThumbnail()
        await expect(card.locator('img')).toBeVisible()
        const bytes = await card.locator('img').evaluate(async (image) => {
            const response = await fetch((image as HTMLImageElement).src)
            return Array.from(new Uint8Array(await response.arrayBuffer()))
        })
        expect(Buffer.from(bytes)).toEqual(bobPng)
    } finally {
        releaseAlice.resolve()
        releaseList()
        releaseThumbnail()
    }
})

test('one notebook list updates the open header, page strip, and canvas without publishing a stale reply', async ({ page, context, request, baseURL }) => {
    const { doc, first, write } = notebook(request)
    const second = crypto.randomUUID()
    const user = 'metadata-live-' + doc
    await write(user, 'Before', 'Blank')
    await signIn(context, baseURL!, user)
    await context.addInitScript(() => {
        const NativeSocket = window.WebSocket
        window.WebSocket = class extends NativeSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols)
                if (new URL(url).pathname === '/ws') (window as Window & { notebookSocket?: WebSocket }).notebookSocket = this
            }
        }
    })
    let pushes = 0
    page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
        if (String(payload).includes('doc.list.changed')) pushes++
    }))
    await page.goto(`/app/${doc}/${first}`)
    const title = page.getByText('Before', { exact: true })
    await expect(title).toBeVisible()
    const names: string[] = []
    await page.exposeFunction('observeNotebookTitle', (value: string) => names.push(value))
    await title.evaluate((element) => new MutationObserver(() => {
        void (window as Window & { observeNotebookTitle(value: string): Promise<void> })
            .observeNotebookTitle(element.textContent ?? '')
    }).observe(element, { subtree: true, childList: true, characterData: true }))
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    let reads = 0
    const captured = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    await page.route('**/api/documents', async (route) => {
        if (++reads !== 1) return route.continue()
        const response = await route.fetch()
        captured.resolve()
        await resume.promise
        await route.fulfill({ response })
    })
    try {
        await write(user, 'Superseded')
        await captured.promise
        const before = pushes
        await write(user, 'Current', 'Grid', [second, first])
        await expect.poll(() => pushes).toBeGreaterThan(before)
        await expect(title).toBeVisible()
        resume.resolve()
        await expect(page.getByText('Current', { exact: true })).toBeVisible()
        await expect(page.getByText('Superseded', { exact: true })).toHaveCount(0)
        await expect(page.getByTestId('page-strip')).toContainText('2 / 2')
        await expect.poll(() => page.evaluate(() => (window as Window & {
            __weftController?: { pageMeta: { template: string } }
        }).__weftController?.pageMeta.template)).toBe('Grid')
        expect(reads).toBe(2)
        expect(names).not.toContain('Superseded')

        await context.setOffline(true)
        await page.evaluate(() => (window as Window & { notebookSocket?: WebSocket }).notebookSocket?.close())
        await write(user, 'Renamed while disconnected', 'Dots')
        await expect(page.getByText('Current', { exact: true })).toBeVisible()
        await context.setOffline(false)
        await expect(page.getByText('Renamed while disconnected', { exact: true })).toBeVisible({ timeout: 15_000 })
        await expect(page.getByTestId('page-strip')).toHaveCount(0)
    } finally {
        resume.resolve()
    }
})

test('an uncached list error offers retry and a transient refresh keeps a good list', async ({ page, context, request, baseURL }) => {
    const { doc, write } = notebook(request)
    const user = 'metadata-retry-' + doc
    await write(user, 'Recovered notebook')
    await signIn(context, baseURL!, user)
    let fail = true
    const socket = Promise.withResolvers<void>()
    await page.route('**/api/ws-ticket', async (route) => {
        await socket.promise
        await route.continue()
    })
    await page.route('**/api/documents', (route) => fail ? route.fulfill({ status: 503 }) : route.continue())
    try {
        await page.goto('/library')
        const retry = page.getByRole('button', { name: 'Retry', exact: true })
        await expect(retry).toBeVisible()
        await expect(page.getByText('Set up your tablet to sync')).toHaveCount(0)
        fail = false
        await retry.click()
        await expect(page.getByText('Recovered notebook', { exact: true })).toBeVisible()
        const connected = page.waitForResponse((response) => response.url().endsWith('/api/documents') && response.ok())
        socket.resolve()
        await connected
        fail = true
        const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/documents') && response.status() === 503)
        await write(user, 'New relay title')
        await refreshed
        await expect(page.getByText('Recovered notebook', { exact: true })).toBeVisible()
        await expect(retry).toHaveCount(0)
    } finally {
        socket.resolve()
    }
})

for (const delayed of [false, true]) {
    test(`a notebook update retries a missing thumbnail without re-entry (delayed 204: ${delayed})`, async ({ page, context, request, baseURL }) => {
        const { doc, first, write } = notebook(request)
        const user = 'metadata-late-thumbnail-' + doc
        const thumb = `/api/documents/${doc}/pages/${first}/thumbnail`
        await write(user, 'Awaiting cover')
        await signIn(context, baseURL!, user)
        const miss = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const delivered = Promise.withResolvers<void>()
        let firstRead = true
        await page.route(`**${thumb}`, async (route) => {
            if (!firstRead) return route.continue()
            firstRead = false
            const response = await route.fetch()
            expect(response.status()).toBe(204)
            miss.resolve()
            if (delayed) await release.promise
            await route.fulfill({ response })
            delivered.resolve()
        })
        try {
            await page.goto('/library')
            await expect(page.getByText('Awaiting cover', { exact: true })).toBeVisible()
            await miss.promise
            if (!delayed) {
                await delivered.promise
                await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
            }
            const image = page.locator(`a[href="/app/${doc}/${first}"] img`)
            await expect(image).toHaveCount(0)
            expect((await request.put(thumb, { headers: auth(user), data: PNG })).ok()).toBe(true)
            await write(user, 'Cover arrived')
            await expect(page.getByText('Cover arrived', { exact: true })).toBeVisible()
            release.resolve()
            await expect(image).toBeVisible()
        } finally {
            release.resolve()
        }
    })
}
