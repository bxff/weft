import { expect, test } from '@playwright/test'
import { inkRm } from './device-blob'

test.skip(process.env.PUBLIC_GUARDED_SAVES !== '1', 'Requires the guarded build')
for (const fault of ['lost acknowledgement', 'IndexedDB write abort', 'account switch after lost acknowledgement'] as const) {
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
            if (!localStorage.getItem('weft-dev-user')) localStorage.setItem('weft-dev-user', user)
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
        let accepted = false
        const switchesWithPending = fault === 'account switch after lost acknowledgement'
        await second.route(`**${api}/**`, async route => {
            const headers = route.request().headers()
            const id = headers['x-snapshot-publication-id'] ?? headers['x-op-batch-id']
            if (!id) return route.continue()
            publicationIds.push(id)
            if (fault !== 'IndexedDB write abort' && publicationIds.length === 1) {
                const response = await route.fetch()
                expect(response.ok()).toBe(true)
                accepted = true
                return route.abort('connectionreset')
            }
            return switchesWithPending ? route.abort('connectionfailed') : route.continue()
        })
        await second.evaluate(async () => {
            const w = window as any
            await w.__weftController.editRootText({
                create: {}, inserts: [{ afterKey: null, text: 'Follower revision survived' }],
            })
            await w.__weftController.saveBeforeNavigation()
        })
        if (switchesWithPending) {
            await expect.poll(() => accepted).toBe(true)
            // The original owner still has a real frozen queue, not merely
            // an already-retired edit in its local bootstrap.
            const scopes = await second.evaluate(async ({ relay, user, doc, sheet }) => {
                const ownerDb = `weft-guarded-v1/${encodeURIComponent(JSON.stringify([relay, '', `dev:${user}`]))}`
                const count = (dbName: string) => new Promise<number>((resolve, reject) => {
                    const request = indexedDB.open(dbName)
                    request.onerror = () => reject(request.error)
                    request.onsuccess = () => {
                        const db = request.result
                        const lookup = db.transaction('pages').objectStore('pages').getAllKeys()
                        lookup.onerror = () => { db.close(); reject(lookup.error) }
                        lookup.onsuccess = () => {
                            const keys = lookup.result.filter(key => String(key).startsWith(`page/${doc}/${sheet}/pending/`))
                            db.close()
                            resolve(keys.length)
                        }
                    }
                })
                return [await count(ownerDb), await count('weft')]
            }, { relay: new URL(second.url()).origin, user, doc, sheet })
            expect(scopes).toEqual([1, 0])
        } else {
            await expect.poll(() => publicationIds.length).toBeGreaterThanOrEqual(2)
            expect(new Set(publicationIds).size).toBe(1)
            if (fault === 'IndexedDB write abort') {
                expect(await second.evaluate(() => (window as any).__guardedDiskFault)).toBe(true)
            }
            await expect(status).toHaveText('synced')
        }
        const nativeText = second.locator('.tl-shape[data-shape-type="device-text"]')
        await expect(nativeText).toContainText('Follower revision survived')
        await expect(page.locator('.tl-shape[data-shape-type="device-text"]')).toHaveCount(0)
        const switchOwner = async (owner: string) => {
            const switcher = await context.newPage()
            await switcher.goto('/')
            await switcher.evaluate(owner => localStorage.setItem('weft-dev-user', owner), owner)
            await switcher.close()
        }
        if (switchesWithPending) {
            const other = crypto.randomUUID()
            await switchOwner(other)
            await expect(second.getByRole('button', { name: 'Reload to reopen' })).toBeVisible()
            await expect(nativeText).not.toBeVisible()
            const wrongOwner = await context.newPage()
            const writes: string[] = []
            await wrongOwner.route('**/api/**', route => {
                if (route.request().method() === 'POST') writes.push(route.request().url())
                return route.abort('connectionfailed')
            })
            await wrongOwner.goto(path)
            await expect(wrongOwner.getByTestId('sync-status')).not.toHaveText('connecting')
            await expect(wrongOwner.locator('.tl-shape[data-shape-type="device-text"]')).toHaveCount(0)
            expect(writes.filter(url => url.endsWith('/snapshot') || url.endsWith('/ops'))).toEqual([])
            const scope = encodeURIComponent(JSON.stringify([new URL(wrongOwner.url()).origin, '', `dev:${other}`]))
            const databases = await wrongOwner.evaluate(() => indexedDB.databases())
            expect(databases.map(db => db.name)).toContain(`weft-guarded-v1/${scope}`)
            await wrongOwner.close()
            await switchOwner(user)
            // Returning the original owner is not permission to re-use the
            // pre-switch editor instance while callbacks could still be alive.
            await expect(second.getByRole('button', { name: 'Reload to reopen' })).toBeVisible()
            await expect(nativeText).not.toBeVisible()
        }
        await second.close()
        await page.close()

        const reopened = await context.newPage()
        await reopened.route('**/api/**', route => route.abort('connectionfailed'))
        await reopened.goto(path)
        await expect(reopened.locator('.tl-shape[data-shape-type="device-text"]')).toHaveText('Follower revision survived')
    })
}
