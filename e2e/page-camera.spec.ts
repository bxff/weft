import { expect, test, type Page } from '@playwright/test'
import type { Editor } from 'tldraw'
import { useCloudMode } from './cloud-mode'
import { devicePut, deviceToken, inkRm } from './device-blob'

useCloudMode()

const doc = '22222222-2222-4222-a222-222222222222'
const notebook = `/app/${doc}/bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb`
const savedView = { x: -91, y: 136, z: 1.25 }

function view(page: Page) {
    return page.evaluate(() => {
        const editor = (window as Window & { __weftEditor?: Editor }).__weftEditor
        if (!editor) return null
        const { x, y, z } = editor.getCamera()
        return { x, y, z }
    })
}

async function moveCamera(page: Page, camera = savedView) {
    await page.evaluate((next) => {
        const editor = (window as Window & { __weftEditor: Editor }).__weftEditor
        editor.setCamera(next, { immediate: true })
    }, camera)
}

async function requestNavigation(page: Page, href: string) {
    await page.evaluate((destination) => {
        const link = document.createElement('a')
        link.href = destination
        document.body.append(link)
        link.click()
        link.remove()
    }, href)
}

async function navigate(page: Page, href: string) {
    await requestNavigation(page, href)
    await expect(page).toHaveURL(new RegExp(`${href}$`))
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
}

test('restores camera across reload and same-notebook page switches', async ({ page }) => {
    const sibling = `/app/${doc}/${crypto.randomUUID()}`
    await page.goto(notebook)
    await expect.poll(async () => (await view(page))?.z).toBeCloseTo(0.6)
    await moveCamera(page)
    expect(await view(page)).toEqual(savedView)

    // Reload before the debounced write is due.
    await page.reload()
    await expect.poll(() => view(page)).toEqual(savedView)

    const updated = { x: -48, y: -31, z: 1.4 }
    await moveCamera(page, updated)
    await navigate(page, sibling)
    await expect.poll(async () => (await view(page))?.z).toBeCloseTo(0.6)
    await navigate(page, notebook)
    await expect.poll(() => view(page)).toEqual(updated)
})

test('a background tablet update leaves the open camera in place', async ({ page }) => {
    const pageId = crypto.randomUUID()
    const token = await deviceToken()
    await devicePut(token, doc, pageId, await inkRm(1))
    await page.goto(`/app/${doc}/${pageId}`)
    await expect.poll(async () => (await view(page))?.z).toBeCloseTo(0.6)
    const shapeCount = () => page.evaluate(() =>
        (window as Window & { __weftEditor: Editor }).__weftEditor.getCurrentPageShapeIds().size,
    )
    await expect.poll(shapeCount).toBe(1)
    await moveCamera(page)

    await devicePut(token, doc, pageId, await inkRm(2))
    await expect.poll(shapeCount).toBe(2)
    expect(await view(page)).toEqual(savedView)
})

test('another account opens the same page at its own camera', async ({ page }) => {
    await page.goto(notebook)
    await expect.poll(async () => (await view(page))?.z).toBeCloseTo(0.6)
    await moveCamera(page)
    await page.reload()
    await expect.poll(() => view(page)).toEqual(savedView)

    // A new tab uses the current local sign-in without the original tab's
    // fixture init script. Both tabs share the same camera storage.
    await page.evaluate(() => localStorage.setItem('weft-dev-user', 'camera-other-account'))
    const other = await page.context().newPage()
    try {
        await other.goto(notebook)
        await expect.poll(async () => (await view(other))?.z).toBeCloseTo(0.6)
    } finally {
        await other.close()
    }
})


test('a relay change pauses page navigation and preserves the original draft and camera scopes', async ({ page, context }) => {
    const source = crypto.randomUUID()
    const id = crypto.randomUUID()
    const sourceHref = `/app/${doc}/${source}`
    const targetHref = `/app/${doc}/${id}`
    const alternate = 'https://another-relay.invalid'
    const shapeId = 'shape:original-relay-draft'
    await page.goto(sourceHref)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await expect.poll(async () => (await view(page))?.z).toBeCloseTo(0.6)
    const oldRelay = new URL(page.url()).origin
    const sourceOps = `/api/documents/${doc}/pages/${source}/ops`
    await page.route(`**${sourceOps}`, route =>
        route.request().method() === 'POST' ? route.abort() : route.continue(),
    )
    const attempted = page.waitForRequest(req => req.url().endsWith(sourceOps) && req.method() === 'POST')
    await page.evaluate(id => {
        const editor = (window as Window & { __weftEditor: Editor }).__weftEditor
        editor.createShape({ id: id as never, type: 'geo', x: 100, y: 100 })
    }, shapeId)
    await attempted

    const targetCamera = { x: -25, y: 58, z: 1.3 }
    const views = [
        { page: JSON.stringify([oldRelay, 'dev:e2e', doc, id]), camera: targetCamera },
        { page: JSON.stringify([alternate, 'dev:e2e', doc, id]), camera: savedView },
        { page: JSON.stringify([oldRelay, 'dev:camera-other-account', doc, id]), camera: savedView },
    ]
    await page.evaluate(views => localStorage.setItem('weft-page-views-v1', JSON.stringify(views)), views)

    const accesses: string[] = []
    const unexpectedOwners: string[] = []
    let sourceRequests = 0
    page.on('request', request => {
        if (request.url().startsWith(alternate) || request.url().includes(`/pages/${id}/`)) {
            accesses.push(request.url())
        }
        if (request.url().includes(`/pages/${source}/`)) {
            sourceRequests++
            if (request.headers().authorization !== 'Bearer dev:e2e') unexpectedOwners.push(request.url())
        }
    })
    await context.route(`${alternate}/**`, route => route.abort())

    let settings = await context.newPage()
    try {
        await settings.goto('/api/health')
        await settings.evaluate(alternate => localStorage.setItem('weft-server-url', alternate), alternate)
        await expect(page.getByRole('status').filter({ hasText: 'Notebook paused' })).toBeVisible()
        await settings.close()
        const openedSettings = context.waitForEvent('page')
        await page.getByRole('link', { name: 'Open Settings in a new tab' }).click()
        settings = await openedSettings
        await expect(settings).toHaveURL(/\/settings$/)
        await requestNavigation(page, targetHref)
        await expect(page).toHaveURL(new RegExp(`${sourceHref}$`))
        await requestNavigation(page, '/library')
        await expect(page).toHaveURL(new RegExp(`${sourceHref}$`))
        await moveCamera(page, { x: 25, y: -20, z: 1.4 })
        expect(await page.evaluate(() => {
            window.dispatchEvent(new PageTransitionEvent('pagehide'))
            return JSON.parse(localStorage.getItem('weft-page-views-v1') ?? '[]')
        })).toEqual(views)
        expect(accesses).toEqual([])

        await settings.evaluate(oldRelay => {
            localStorage.setItem('weft-dev-user', 'camera-other-account')
            localStorage.setItem('weft-server-url', oldRelay)
        }, oldRelay)
        await requestNavigation(page, targetHref)
        await expect(page).toHaveURL(new RegExp(`${sourceHref}$`))
        await expect(page.getByRole('status').filter({ hasText: 'Notebook paused' })).toBeVisible()
        expect(accesses).toEqual([])
        await settings.evaluate(() => localStorage.setItem('weft-dev-user', 'e2e'))
        await expect(page.getByRole('status').filter({ hasText: 'Original connection selected' })).toBeVisible()
        await expect(page).toHaveURL(new RegExp(`${sourceHref}$`))
        const pausedRequests = sourceRequests
        await page.evaluate(() => (window as Window & {
            __weftController: { session: { reconcile(): Promise<void> } }
        }).__weftController.session.reconcile())
        expect(sourceRequests).toBe(pausedRequests)
        await page.unroute(`**${sourceOps}`)
        await navigate(page, targetHref)
        await expect(page.getByRole('status').filter({ hasText: 'Original connection selected' })).toHaveCount(0)
        await expect.poll(() => view(page)).toEqual(targetCamera)
        expect(accesses.some(url => url.startsWith(alternate))).toBe(false)
        await navigate(page, sourceHref)
        await expect.poll(async () => {
            const response = await page.request.get(`/api/documents/${doc}/pages/${source}/overlay`)
            return (await response.json()).shapes.some((shape: { shapeId: string }) => shape.shapeId === shapeId)
        }).toBe(true)
        expect(unexpectedOwners).toEqual([])
    } finally {
        await settings.close()
    }
})
