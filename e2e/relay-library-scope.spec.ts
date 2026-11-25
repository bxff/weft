import { expect, test } from '@playwright/test'

test('the library follows a relay switch in another tab without showing the prior list or cover', async ({
    page, context, baseURL,
}) => {
    const origin = new URL(baseURL!).origin
    const oldRelay = origin + '/relay-a'
    const newRelay = origin + '/relay-b'
    const oldTitle = 'Notebook on first relay'
    const newTitle = 'Notebook on second relay'
    const updatedTitle = 'Live update from second relay'
    const id = 'c0000000-0000-4000-a000-000000000000'
    const pageId = 'c0000000-0000-4000-a000-000000000001'
    const documents = (name: string) => ({
        documents: [{ id, name, parent: '', type: 'notebook', pages: [{ id: pageId }] }],
    })
    const picture = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAwsAAAAASUVORK5CYII=',
        'base64',
    )
    const secondReply = Promise.withResolvers<void>()
    const sendNewEvent = Promise.withResolvers<() => void>()
    const requests: string[] = []
    let currentTitle = newTitle
    await context.route(/\/relay-[ab]\/api\//, async (route) => {
        const url = new URL(route.request().url())
        const first = url.pathname.startsWith('/relay-a/')
        if (url.pathname.endsWith('/api/documents')) {
            requests.push(route.request().headers().authorization ?? '')
            if (!first) await secondReply.promise
            return route.fulfill({ json: documents(first ? oldTitle : currentTitle) })
        }
        if (url.pathname.endsWith('/thumbnail')) {
            return first
                ? route.fulfill({ body: picture, contentType: 'image/png', headers: { etag: 'old-cover' } })
                : route.fulfill({ status: 204 })
        }
        return route.fulfill({ json: {} })
    })
    await page.routeWebSocket(/\/relay-[ab]\/ws/, (socket) => {
        if (new URL(socket.url()).pathname.startsWith('/relay-b/')) {
            sendNewEvent.resolve(() => socket.send(JSON.stringify({ type: 'doc.list.changed' })))
        }
    })
    await page.addInitScript(({ oldRelay, newRelay, oldTitle, id, pageId }) => {
        if (localStorage.getItem('weft-server-url')) return
        localStorage.setItem('weft-server-url', oldRelay)
        localStorage.setItem('weft-clerk-pk', '')
        localStorage.setItem('weft-selfhost-jwt/' + encodeURIComponent(oldRelay), 'test-first')
        localStorage.setItem('weft-selfhost-jwt/' + encodeURIComponent(newRelay), 'test-second')
        localStorage.setItem('weft-docs-cache', JSON.stringify([{
            id, name: oldTitle, parent: '', type: 'notebook', pages: [{ id: pageId }],
        }]))
    }, { oldRelay, newRelay, oldTitle, id, pageId })
    await page.goto('/library')
    const oldNotebook = page.getByRole('link', { name: new RegExp(oldTitle) })
    const newNotebook = page.getByRole('link', { name: new RegExp(newTitle) })
    await expect(oldNotebook).toBeVisible()
    await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve, reject) => {
        const request = indexedDB.open('weft', 1)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
            const db = request.result
            const keys = db.transaction('pages').objectStore('pages').getAllKeys()
            keys.onerror = () => reject(keys.error)
            keys.onsuccess = () => {
                db.close()
                resolve(keys.result.some((key) => typeof key === 'string' && key.startsWith('thumb/')))
            }
        }
    }))).toBe(true)

    const otherTab = await context.newPage()
    await otherTab.goto('/')
    const selectedRequest = page.waitForRequest(newRelay + '/api/documents')
    await otherTab.evaluate((relay) => localStorage.setItem('weft-server-url', relay), newRelay)
    expect((await selectedRequest).headers().authorization).toBe('Bearer test-second')
    await expect(oldNotebook).toHaveCount(0)
    secondReply.resolve()
    await expect(newNotebook).toBeVisible()
    await expect(newNotebook.locator('img')).toHaveCount(0)

    currentTitle = updatedTitle
    const send = await sendNewEvent.promise
    send()
    await expect(page.getByRole('link', { name: new RegExp(updatedTitle) })).toBeVisible()
    expect(requests).toContain('Bearer test-first')
    const switched = requests.indexOf('Bearer test-second')
    expect(switched).toBeGreaterThan(0)
    expect(requests.slice(switched).every((auth) => auth === 'Bearer test-second')).toBe(true)
})
