import { expect, test } from '@playwright/test'
import type { Editor } from 'tldraw'

const DOC = '11111111-1111-4111-a111-111111111111'
const AUTH = { authorization: 'Bearer dev:e2e' }
const FONT = '/fonts/ShantellSans.ttf'

type ProjectionWindow = Window & {
    __weftEditor: Editor
    __weftController: { flush(): Promise<void>; schedule(): void }
    __projectionReady?: () => void
    __projected?: Promise<void>
}

test('a visited notebook reloads with the whole browser offline and retains its first label', async ({ context, page, request, baseURL }) => {
    const pageId = crypto.randomUUID()
    const url = `/app/${DOC}/${pageId}`
    const endpoint = `/api/documents/${DOC}/pages/${pageId}/overlay`
    await context.addInitScript(({ origin, font }) => {
        localStorage.setItem('weft-server-url', origin)
        localStorage.setItem('weft-dev-user', 'e2e')
        localStorage.setItem('weft-clerk-pk', '')
        if (sessionStorage.getItem('hold-projection-font')) {
            sessionStorage.removeItem('hold-projection-font')
            const fetch = window.fetch.bind(window)
            window.fetch = async (input, init) => {
                if (input === font) await new Promise<void>((resolve) => {
                    (window as ProjectionWindow).__projectionReady = resolve
                })
                return fetch(input, init)
            }
        }
    }, { origin: baseURL!, font: FONT })
    const saved = async () => {
        const response = await request.get(endpoint, { headers: AUTH })
        expect(response.ok()).toBe(true)
        return (await response.json()).shapes as { shapeId: string; rendered: { partKey: string; items: unknown[] }[] }[]
    }
    const visible = () => page.evaluate(() => (window as ProjectionWindow).__weftEditor?.getCurrentPageShapes().length)
    const synced = () => expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30_000 })

    await page.goto(url)
    await synced()
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 5_000 })
    await synced()
    await page.evaluate(() => {
        (window as ProjectionWindow).__weftEditor.createShape({ type: 'geo', x: 80, y: 80 })
    })
    await expect.poll(async () => (await saved()).length).toBe(1)
    await synced()

    await page.evaluate(() => sessionStorage.setItem('hold-projection-font', '1'))
    await context.setOffline(true)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('sync-status')).toHaveText('offline')
    await expect.poll(visible).toBe(1)
    await page.waitForFunction(() => !!(window as ProjectionWindow).__projectionReady)
    await page.evaluate(() => {
        const harness = window as ProjectionWindow
        const { __weftEditor: editor, __weftController: controller } = harness
        controller.schedule = () => {}
        editor.createShape({ type: 'geo', x: 120, y: 120, props: { richText: {
            type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pen' }] }],
        } } })
        editor.store._flushHistory()
        harness.__projected = controller.flush()
    })
    await page.evaluate(async () => {
        const harness = window as ProjectionWindow
        harness.__projectionReady!()
        await harness.__projected
    })
    expect(await saved()).toHaveLength(1)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('sync-status')).toHaveText('offline')
    await expect.poll(visible).toBe(2)

    const cached = await page.evaluate(async () => {
        const keys = (await caches.keys()).filter((key) => key.startsWith('weft-shell:'))
        return (await Promise.all(keys.map(async (key) => (await (await caches.open(key)).keys()).map((r) =>
            new URL(r.url).pathname,
        )))).flat()
    })
    expect(cached).toContain('/app/shell/shell.html')
    expect(cached).toContain(FONT)
    expect(cached.every((path) => path === '/app/shell/shell.html' || path === '/_app/env.js' ||
        path.startsWith('/_app/immutable/') || path.startsWith('/fonts/'))).toBe(true)

    await context.setOffline(false)
    await synced()
    const shapes = await saved()
    expect(shapes).toHaveLength(2)
    expect(shapes.some((shape) => shape.rendered.some((part) => part.partKey.startsWith('label:') && part.items.length))).toBe(true)

    await context.setOffline(true)
    const unused = await context.newPage()
    await unused.goto(`/app/${DOC}/${crypto.randomUUID()}`)
    await expect(unused.getByText('This page is unavailable offline.')).toBeVisible()
    await expect(unused.locator('[inert]').filter({ has: unused.locator('.tl-canvas') })).toHaveCount(1)
    await unused.close()

})


for (const checkpoint of [false, true]) {
    test(`an interrupted first operation tail cannot cache an incomplete page (checkpoint: ${checkpoint})`, async ({ context, page, request, baseURL }) => {
        const pageId = crypto.randomUUID()
        const endpoint = `/api/documents/${DOC}/pages/${pageId}`
        if (checkpoint) {
            const { RmDocument } = await import('../packages/rm-format/src/index')
            const { encodeSnapshot } = await import('../packages/sync-engine/src/snapshot')
            const snapshot = Buffer.from(encodeSnapshot(RmDocument.empty(crypto.randomUUID()).serialize(), { shapes: [] }))
            expect((await request.put(endpoint + '/snapshot', { headers: AUTH, data: snapshot })).ok()).toBe(true)
        }
        const op = {
            op: 'upsert-object', id: 'shape:from-relay', objType: 'geo',
            props: { geo: 'rectangle', w: 150, h: 100 },
            transform: { x: 100, y: 200, rotation: 0 },
            rendered: [], version: { ts: Date.now(), actor: 'peer' },
        }
        expect((await request.post(endpoint + '/ops', {
            headers: AUTH,
            data: {
                ops: (checkpoint ? [op, { ...op, id: 'shape:second-from-relay' }] : [op])
                    .map((entry) => Buffer.from(JSON.stringify(entry)).toString('base64')),
            },
        })).ok()).toBe(true)
        expect((await request.get(endpoint + '/snapshot', { headers: AUTH })).status()).toBe(checkpoint ? 200 : 204)

        await context.addInitScript((origin) => {
            localStorage.setItem('weft-server-url', origin)
            localStorage.setItem('weft-dev-user', 'e2e')
            localStorage.setItem('weft-clerk-pk', '')
        }, baseURL!)
        await page.goto(`/app/${DOC}/${crypto.randomUUID()}`)
        await expect(page.getByTestId('sync-status')).toHaveText('synced')
        await page.waitForFunction(() => !!navigator.serviceWorker.controller)

        const partial = await context.newPage()
        const blockedTail = Promise.withResolvers<void>()
        const failTail = Promise.withResolvers<void>()
        const tail = '**' + endpoint + '/ops?*'
        await partial.route(tail, async (route) => {
            if (checkpoint && new URL(route.request().url()).searchParams.get('since') === '0') {
                const response = await route.fetch()
                const body = await response.json()
                await route.fulfill({ response, json: { ...body, ops: body.ops.slice(0, 1) } })
                return
            }
            blockedTail.resolve()
            await failTail.promise
            await route.abort('connectionfailed')
        })
        const inactiveCanvas = partial.locator('[inert]').filter({ has: partial.locator('.tl-canvas') })
        try {
            await partial.goto(`/app/${DOC}/${pageId}`)
            await blockedTail.promise
            await expect(partial.getByText('Opening this page', { exact: true })).toBeVisible()
            await expect(inactiveCanvas).toHaveCount(1)
        } finally {
            failTail.resolve()
        }
        const unavailable = partial.getByText('This page is unavailable offline.')
        await expect(unavailable).toBeVisible()

        await partial.unroute(tail)
        await context.setOffline(true)
        await partial.reload({ waitUntil: 'domcontentloaded' })
        await expect(unavailable).toBeVisible()
        await expect(inactiveCanvas).toHaveCount(1)

        await context.setOffline(false)
        await partial.evaluate(async () => {
            const controller = (window as Window & {
                __weftController?: { session: { reconcile(): Promise<void> } }
            }).__weftController!
            await controller.session.reconcile()
        })
        await expect(partial.getByTestId('sync-status')).toHaveText('synced')
        await expect(inactiveCanvas).toHaveCount(0)
        const recovered = await partial.evaluate(() =>
            (window as ProjectionWindow).__weftEditor.getCurrentPageShapes().map((shape) => shape.id),
        )
        expect(recovered).toContain(op.id)
        if (checkpoint) expect(recovered).toContain('shape:second-from-relay')
    })
}

test('only visited notebook resources enter the public shell cache', async ({ context, page, request, baseURL }) => {
    const pages = [crypto.randomUUID(), crypto.randomUUID()]
    const paths = pages.map(id => `/app/${DOC}/${id}`)
    const seenAssets = new Set<string>()
    const workerMisses = new Set<string>()
    context.on('request', resource => {
        const url = new URL(resource.url())
        if (url.origin !== baseURL || !/^\/(?:_app\/immutable\/|fonts\/)/.test(url.pathname)) return
        if (resource.serviceWorker()) workerMisses.add(url.pathname)
        else seenAssets.add(url.pathname)
    })
    await context.addInitScript(origin => {
        localStorage.setItem('weft-server-url', origin)
        localStorage.setItem('weft-dev-user', 'e2e')
        localStorage.setItem('weft-clerk-pk', '')
    }, baseURL!)

    await page.goto('/')
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length))
        .toBe(0)

    let releaseFont!: () => void
    const fontReady = new Promise<void>(resolve => { releaseFont = resolve })
    await page.route(`**${FONT}`, async route => {
        await fontReady
        await route.continue()
    })
    let usesWorker = false
    for (const [index, path] of paths.entries()) {
        const shapeId = `shape:visited-${index}` as const
        await page.goto(path)
        await expect(page.getByTestId('sync-status')).toHaveText('synced')
        if (!usesWorker) {
            await page.waitForFunction(() => !!navigator.serviceWorker.controller)
            releaseFont()
            usesWorker = true
        }
        await page.evaluate(id => {
            (window as ProjectionWindow).__weftEditor.createShape({ id, type: 'geo', x: 50, y: 60 })
        }, shapeId)
        await expect.poll(async () => {
            const response = await request.get(`/api/documents/${DOC}/pages/${pages[index]}/overlay`, { headers: AUTH })
            return response.ok() ? (await response.json()).shapes.map((shape: { shapeId: string }) => shape.shapeId) : []
        }).toContain(shapeId)
        await expect(page.getByTestId('sync-status')).toHaveText('synced')
    }
    await page.waitForFunction(() => !!navigator.serviceWorker.controller)

    const forbidden = [
        `/api/documents/${DOC}/pages/${pages[0]}/snapshot`,
        `/api/documents/${DOC}/pages/${pages[0]}/assets/private.png`,
        '/library',
    ]
    await page.evaluate(pathnames => {
        navigator.serviceWorker.controller!.postMessage({ type: 'cache-notebook-assets', paths: pathnames })
    }, forbidden)
    const cachedPaths = () => page.evaluate(async () => {
        const name = (await caches.keys()).find(key => key.startsWith('weft-shell:'))
        if (!name) return []
        return (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)
    })
    await expect.poll(cachedPaths).toContain(FONT)
    const publicPaths = await cachedPaths()
    expect(publicPaths).toContain('/app/shell/shell.html')
    expect(publicPaths.some(path => path.startsWith('/_app/immutable/entry/'))).toBe(true)
    expect(publicPaths.filter(path => /^\/(?:_app\/immutable\/|fonts\/)/.test(path))
        .every(path => seenAssets.has(path))).toBe(true)
    expect([...workerMisses].every(path => seenAssets.has(path))).toBe(true)
    for (const path of forbidden) expect(publicPaths).not.toContain(path)

    // Drop the normal HTTP cache to prove a new offline tab needs only the
    // worker's public assets and the already accepted notebook replicas.
    const protocol = await context.newCDPSession(page)
    await protocol.send('Network.clearBrowserCache')
    await context.setOffline(true)
    for (const [index, path] of paths.entries()) {
        const reopened = await context.newPage()
        await reopened.goto(path + '/')
        await expect(reopened.getByTestId('sync-status')).toHaveText('offline')
        await expect.poll(() => reopened.evaluate(id => {
            const studio = window as ProjectionWindow
            return studio.__weftEditor?.getCurrentPageShapes().some(shape => shape.id === id)
        }, `shape:visited-${index}`)).toBe(true)
        await reopened.close()
    }
})
