import { expect, test } from '@playwright/test'
import { inkRm } from './device-blob'

test.skip(process.env.PUBLIC_GUARDED_SAVES !== '1', 'Requires the guarded build')
for (const fault of ['lost acknowledgement', 'IndexedDB write abort'] as const) {
    test(`a guarded follower survives ${fault} and reopens offline`, async ({ page, context, request }) => {
        const user = crypto.randomUUID()
        const doc = crypto.randomUUID()
        const sheet = crypto.randomUUID()
        const api = `/api/documents/${doc}/pages/${sheet}`
        const path = `/app/${doc}/${sheet}`
        const web = { authorization: `Bearer dev:${user}` }
        const pairing = await request.post('/api/pair', { headers: web, data: { label: 'follower replica test' } })
        expect(pairing.ok()).toBe(true)
        const tablet = { 'x-device-token': (await pairing.json()).token }
        expect((await request.put('/api/documents', { headers: tablet, data: { documents: [{
            id: doc, name: 'Shared notebook', parent: '', type: 'notebook',
            pages: [{ id: sheet }], lastModified: 1, createdTime: 1,
        }] } })).ok()).toBe(true)
        expect((await request.put(`${api}/rm`, { headers: tablet, data: Buffer.from(await inkRm(1)) })).ok()).toBe(true)
        await context.addInitScript(user => {
            localStorage.setItem('weft-server-url', location.origin)
            localStorage.setItem('weft-dev-user', user)
            localStorage.setItem('weft-clerk-pk', '')
        }, user)
        await page.goto(path)
        await expect(page.getByTestId('sync-status')).toHaveText('synced')
        await page.route(`**${api}/**`, route => route.abort('connectionfailed'))

        const second = await context.newPage()
        await second.goto(path)
        const status = second.getByTestId('sync-status')
        await expect(status).toHaveText('synced')
        await expect.poll(() => second.evaluate(sheet => navigator.locks.query().then(({ pending }) =>
            pending?.some(lock => lock.name?.startsWith('weft-page:') && lock.name.endsWith(`/${sheet}`)),
        ), sheet)).toBe(true)
        if (fault === 'IndexedDB write abort') {
            await second.evaluate(key => {
                const put = IDBObjectStore.prototype.put
                IDBObjectStore.prototype.put = function (value, writeKey) {
                    if (writeKey === key) {
                        IDBObjectStore.prototype.put = put
                        ;(window as any).__guardedDiskFault = true
                        throw new DOMException('Synthetic checkpoint write abort', 'QuotaExceededError')
                    }
                    return put.call(this, value, writeKey)
                }
            }, `page/${doc}/${sheet}/state`)
        }
        const publicationIds: string[] = []
        await second.route(`**${api}/**`, async route => {
            const headers = route.request().headers()
            const id = headers['x-snapshot-publication-id'] ?? headers['x-op-batch-id']
            if (!id) return route.continue()
            publicationIds.push(id)
            if (fault === 'lost acknowledgement' && publicationIds.length === 1) {
                const accepted = await route.fetch()
                expect(accepted.ok()).toBe(true)
                return route.abort('connectionreset')
            }
            return route.continue()
        })
        await second.evaluate(async () => {
            const w = window as any
            await w.__weftController.editRootText({
                create: {}, inserts: [{ afterKey: null, text: 'Follower revision survived' }],
            })
            await w.__weftController.saveBeforeNavigation()
        })
        await expect.poll(() => publicationIds.length).toBeGreaterThanOrEqual(2)
        expect(new Set(publicationIds).size).toBe(1)
        if (fault === 'IndexedDB write abort') {
            expect(await second.evaluate(() => (window as any).__guardedDiskFault)).toBe(true)
        }
        await expect(status).toHaveText('synced')
        const nativeText = second.locator('.tl-shape[data-shape-type="device-text"]')
        await expect(nativeText).toContainText('Follower revision survived')
        await expect(page.locator('.tl-shape[data-shape-type="device-text"]')).toHaveCount(0)
        await second.close()
        await page.close()

        const reopened = await context.newPage()
        await reopened.route('**/api/**', route => route.abort('connectionfailed'))
        await reopened.goto(path)
        await expect(reopened.locator('.tl-shape[data-shape-type="device-text"]')).toContainText('Follower revision survived')
    })
}
