import { expect, test, type BrowserContext, type Page } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

async function setup(context: BrowserContext, baseURL: string) {
    const user = 'sweep-' + crypto.randomUUID()
    const doc = crypto.randomUUID()
    const sheet = crypto.randomUUID()
    const active = `${doc}/${sheet}`
    const name = `weft-page:${active}`
    await context.addInitScript(({ url, user }) => {
        localStorage.setItem('weft-server-url', url!)
        localStorage.setItem('weft-dev-user', user)
        localStorage.setItem('weft-clerk-pk', '')
    }, { url: baseURL, user })
    return { active, name }
}

async function seedPressure(page: Page, active: string) {
    await page.evaluate(async active => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const open = indexedDB.open('weft')
            open.onsuccess = () => resolve(open.result)
            open.onerror = () => reject(open.error)
        })
        const tx = db.transaction('pages', 'readwrite')
        const store = tx.objectStore('pages')
        const enc = new TextEncoder()
        // Deliberately overstate the two sizes to exercise LRU without a 200MB fixture.
        for (const key of [active, 'idle/page']) {
            store.put(new Uint8Array(), 'page/' + key + '/base')
            store.put(enc.encode('{}'), 'page/' + key + '/state')
        }
        store.put(enc.encode(JSON.stringify({ [active]: { at: 1, bytes: 220e6 },
            'idle/page': { at: 2, bytes: 100e6 } })), 'meta/replica-index')
        await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error) })
        db.close()
    }, active)
}

async function checkpointPresence(page: Page, active: string) {
    return page.evaluate(async active => {
        const db = await new Promise<IDBDatabase>(resolve => {
            const open = indexedDB.open('weft')
            open.onsuccess = () => resolve(open.result)
        })
        const rows = await new Promise<IDBValidKey[]>(resolve => {
            const keys = db.transaction('pages').objectStore('pages').getAllKeys()
            keys.onsuccess = () => resolve(keys.result)
        })
        db.close()
        return [active, 'idle/page'].map(key => ['base', 'state'].map(kind =>
            rows.includes('page/' + key + '/' + kind)))
    }, active)
}

test('an editor waits for a sweep to release its page', async ({ context, page, baseURL }) => {
    const { active, name } = await setup(context, baseURL!)
    await page.goto('/api/health')
    // Simulate a sweep already holding admission while the actual editor opens.
    await page.evaluate(name => new Promise<void>(acquired => {
        void navigator.locks.request(name + '/use', () => new Promise<void>(release => {
            window.addEventListener('release-admission', () => release(), { once: true })
            acquired()
        }))
    }), name)
    const editor = await context.newPage()
    await editor.goto(`/app/${active}`)
    await expect.poll(() => page.evaluate(async name =>
        (await navigator.locks.query()).pending?.some(lock => lock.name === name + '/use' && lock.mode === 'shared'),
        name,
    )).toBe(true)
    expect(await page.evaluate(async name =>
        (await navigator.locks.query()).held?.some(lock => lock.name === name), name)).toBe(false)
    await page.evaluate(() => window.dispatchEvent(new Event('release-admission')))
    await expect.poll(() => page.evaluate(async name =>
        (await navigator.locks.query()).held?.some(lock => lock.name === name), name)).toBe(true)
})

test('a second tab sweeps idle replicas and keeps an open page checkpoint', async ({ context, page, baseURL }) => {
    const { active, name } = await setup(context, baseURL!)
    await page.goto('/api/health')
    const editor = await context.newPage()
    await editor.goto(`/app/${active}`)
    await expect.poll(() => page.evaluate(async name =>
        (await navigator.locks.query()).held?.some(lock => lock.name === name), name)).toBe(true)

    await seedPressure(page, active)
    await page.goto('/library')
    const remaining = () => checkpointPresence(page, active)
    await expect.poll(remaining).toEqual([[true, true], [false, false]])
    await editor.close()
    await page.reload()
    await expect.poll(remaining).toEqual([[false, false], [false, false]])
})

test('two editors share use while the follower waits for cache-primary promotion', async ({ context, page, baseURL }) => {
    const { active, name } = await setup(context, baseURL!)
    await page.goto(`/app/${active}`)
    const topology = (tab: Page) => tab.evaluate(async name => {
        const { held = [], pending = [] } = await navigator.locks.query()
        return {
            primary: held.filter(lock => lock.name === name).length,
            followers: pending.filter(lock => lock.name === name).length,
            editors: held.filter(lock => lock.name === name + '/use' && lock.mode === 'shared').length,
        }
    }, name)
    await expect.poll(() => topology(page)).toEqual({ primary: 1, followers: 0, editors: 2 })
    const follower = await context.newPage()
    await follower.goto(`/app/${active}`)
    await expect.poll(() => topology(page)).toEqual({ primary: 1, followers: 1, editors: 4 })
    await page.close()
    await expect.poll(() => topology(follower)).toEqual({ primary: 1, followers: 0, editors: 2 })
})

test('a cold editor protects its checkpoint while the SDK is downloading', async ({ context, page, baseURL }) => {
    const { active, name } = await setup(context, baseURL!)
    await page.goto(`/app/${active.split('/')[0]}/${crypto.randomUUID()}`)
    await expect(page.locator('.tl-canvas')).toBeVisible()
    const sdk = await page.evaluate(() => performance.getEntriesByType('resource')
        .map(entry => entry as PerformanceResourceTiming)
        .filter(entry => entry.name.endsWith('.js'))
        .sort((a, b) => b.decodedBodySize - a.decodedBodySize)[0]!.name)
    await page.goto('/api/health')
    await seedPressure(page, active)

    const editor = await context.newPage()
    let downloading!: () => void
    let resume!: () => void
    const started = new Promise<void>(resolve => { downloading = resolve })
    const gate = new Promise<void>(resolve => { resume = resolve })
    await editor.route(sdk, async route => {
        downloading()
        await gate
        await route.continue().catch(() => {})
    })
    try {
        await editor.goto(`/app/${active}`, { waitUntil: 'domcontentloaded' })
        await started
        await page.goto('/library')
        await expect.poll(async () => (await checkpointPresence(page, active)).flat().filter(Boolean).length)
            .toBe(2)
        expect(await checkpointPresence(page, active)).toEqual([[true, true], [false, false]])
        expect(await editor.evaluate(() => '__weftEditor' in window)).toBe(false)
        await editor.getByRole('link', { name: /Files/ }).click()
        await editor.waitForURL('**/library')
        await expect.poll(() => page.evaluate(async name =>
            (await navigator.locks.query()).held?.some(lock => lock.name === name + '/use'), name)).toBe(false)
    } finally {
        resume()
    }
})

test('a follower adopts pending work when promoted before its session opens', async ({ context, page, baseURL }) => {
    const { active, name } = await setup(context, baseURL!)
    await page.goto(`/app/${active}`)
    await expect(page.locator('.tl-canvas')).toBeVisible()
    await page.waitForFunction(() => Boolean((window as typeof window & {
        __weftController?: { session?: unknown }
    }).__weftController?.session))
    const pendingPrefix = 'page/' + active + '/pending/'
    const orphanKey = pendingPrefix + crypto.randomUUID()
    const label = 'Orphan pending proof'
    const scopedKeys = (tab: Page, seed = false) =>
        tab.evaluate(async ({ pendingPrefix, orphanKey, label, seed }) => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const open = indexedDB.open('weft')
                open.onsuccess = () => resolve(open.result)
                open.onerror = () => reject(open.error)
            })
            const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
                const tx = db.transaction('pages', seed ? 'readwrite' : 'readonly')
                const store = tx.objectStore('pages')
                if (seed) {
                    const bytes = new TextEncoder().encode(JSON.stringify([{ type: 'create-layer', label }]))
                    store.put(bytes, orphanKey)
                }
                const req = store.getAllKeys(IDBKeyRange.bound(pendingPrefix, pendingPrefix + '\uffff'))
                tx.oncomplete = () => resolve(req.result)
                tx.onabort = () => reject(tx.error)
            })
            db.close()
            return keys
        }, { pendingPrefix, orphanKey, label, seed })
    expect(await scopedKeys(page, true)).toEqual([orphanKey])

    const follower = await context.newPage()
    await follower.route('**/api/**', route => route.abort('connectionfailed'))
    await follower.addInitScript(name => {
        const request = navigator.locks.request.bind(navigator.locks)
        const gate = new Promise<void>((resolve) => Object.assign(window, { releaseAuthor: resolve }))
        Object.defineProperty(navigator.locks, 'request', {
            value(key: string, options: LockOptions, callback: LockGrantedCallback) {
                return request(key, options, async lock => {
                    if (key.startsWith('weft-author:')) await gate
                    if (key === name && !options.ifAvailable && lock) {
                        Object.assign(window, { followerPrimaryGranted: true })
                    }
                    return callback(lock)
                })
            },
        })
    }, name)
    await follower.goto(`/app/${active}`)
    await expect.poll(() => page.evaluate(async name =>
        (await navigator.locks.query()).pending?.some(lock => lock.name === name), name)).toBe(true)
    await page.close()
    await follower.waitForFunction(() => 'followerPrimaryGranted' in window)
    await follower.evaluate(() => (window as typeof window & { releaseAuthor(): void }).releaseAuthor())
    await expect.poll(async () => {
        const keys = await scopedKeys(follower)
        return keys.length === 1 && keys[0] !== orphanKey
    }).toBe(true)
    expect(await follower.evaluate(label => (window as typeof window & {
        __weftController: { listLayers(): { label: string }[] }
    }).__weftController.listLayers().some(layer => layer.label === label), label)).toBe(true)
})

test('a browser without cross-tab locks keeps its persistent cache', async ({ context, page, baseURL }) => {
    const { active } = await setup(context, baseURL!)
    await context.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }))
    await page.goto('/library')
    await page.waitForFunction(async () => (await indexedDB.databases()).some(db => db.name === 'weft'))
    await seedPressure(page, active)
    await page.reload()
    await expect(page.getByRole('heading').first()).toBeVisible()
    expect(await checkpointPresence(page, active)).toEqual([[true, true], [true, true]])
})
