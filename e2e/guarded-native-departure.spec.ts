import { expect, test, type Page } from '@playwright/test'
import { useCloudMode } from './cloud-mode'

useCloudMode()
test.skip(process.env.PUBLIC_GUARDED_SAVES !== '1', 'Requires the guarded build')

const doc = '11111111-1111-4111-a111-111111111111'
const other = '/app/22222222-2222-4222-a222-222222222222/bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb'
const nativeText = (page: Page) => page.locator('.tl-shape[data-shape-type="device-text"]')
const marker = 'Durable before departure'
const publication = (method: string, url: string, snapshot: string) =>
    (method === 'PUT' && url.endsWith(snapshot)) ||
    (method === 'POST' && url.endsWith(snapshot + '-batch'))

async function navigate(page: Page, href: string) {
    await page.evaluate(href => {
        const anchor = document.createElement('a')
        anchor.href = href
        document.body.append(anchor)
        anchor.click()
    }, href)
    await expect.poll(() => page.evaluate(() => {
        const controller = (window as any).__weftController
        return controller && `/app/${controller.opts.docId}/${controller.opts.pageId}`
    })).toBe(href)
}

for (const fault of ['failed write', 'persisted write with lost reply'] as const) {
    test(`typed native edit survives departure and ${fault}`, async ({ page, browser }) => {
        const sheet = crypto.randomUUID()
        const here = `/app/${doc}/${sheet}`
        const snapshot = `/api/documents/${doc}/pages/${sheet}/snapshot`
        await page.goto(here)
        await expect(page.getByTestId('sync-status')).toHaveText('synced')
        const initialized = page.waitForResponse(r => publication(r.request().method(), r.url(), snapshot) && r.ok())
        await page.evaluate(() => (window as any).__weftController.editRootText({ create: {} }))
        await initialized
        await expect(page.getByTestId('sync-status')).toHaveText('synced')
        await page.evaluate(() => (window as any).__weftEditor.setEditingShape('shape:device-text'))
        await expect(nativeText(page).locator('.ProseMirror')).toBeVisible()
        await page.keyboard.type(marker)

        let hold = true
        const requests: Array<{ id: string | undefined, bytes: string | undefined }> = []
        let injected = false
        await page.route(`**${snapshot}*`, async route => {
            if (!publication(route.request().method(), route.request().url(), snapshot)) return route.continue()
            requests.push({
                id: route.request().headers()['x-snapshot-publication-id'],
                bytes: route.request().postDataBuffer()?.toString('base64'),
            })
            if (!hold) return route.continue()
            if (fault === 'persisted write with lost reply' && requests.length === 1) {
                const accepted = await route.fetch()
                expect(accepted.ok()).toBe(true)
                injected = true
                return route.abort('connectionreset')
            }
            injected = true
            return route.fulfill({ status: 503 })
        })
        await navigate(page, other)
        await navigate(page, here)
        await expect(nativeText(page)).toHaveText(marker)
        await expect.poll(() => injected).toBe(true)
        await page.reload()
        await expect(nativeText(page)).toHaveText(marker)
        hold = false

        // A different browser context has no local notebook replica and can
        // only display data received from the actual synthetic relay.
        const observer = await browser.newContext()
        try {
            await observer.addInitScript(() => {
                localStorage.setItem('weft-server-url', location.origin)
                localStorage.setItem('weft-dev-user', 'e2e')
                localStorage.setItem('weft-clerk-pk', '')
            })
            await expect(page.getByTestId('sync-status')).toHaveText('synced')
            const independent = await observer.newPage()
            await independent.goto(page.url())
            await expect(nativeText(independent)).toHaveText(marker)
            expect(requests.length).toBeGreaterThanOrEqual(2)
            expect(requests[0]?.id).toBeTruthy()
            expect(requests[0]?.bytes).toBeTruthy()
            for (const request of requests) expect(request).toEqual(requests[0])
        } finally {
            await observer.close()
        }
    })
}

test('guarded startup does not read or clear an unattributed legacy browser queue', async ({ page }) => {
    const sheet = crypto.randomUUID()
    const here = `/app/${doc}/${sheet}`
    const oldText = 'Old account draft'
    const before = await page.goto('/')
    expect(before?.ok()).toBe(true)
    const key = `page/${doc}/${sheet}/pending/${crypto.randomUUID()}`
    const legacyBytes = JSON.stringify([{
        type: 'edit-root-text', create: {}, inserts: [{ afterKey: null, text: oldText }],
    }])
    const openLegacy = async (write: boolean) => page.evaluate(({ key, legacyBytes, write }) =>
        new Promise<string | null>((resolve, reject) => {
            const open = indexedDB.open('weft', 1)
            open.onerror = () => reject(open.error)
            open.onupgradeneeded = () => open.result.createObjectStore('pages')
            open.onsuccess = () => {
                const db = open.result
                const txn = db.transaction('pages', write ? 'readwrite' : 'readonly')
                const data = txn.objectStore('pages')
                const request = write ? data.put(new TextEncoder().encode(legacyBytes), key) : data.get(key)
                txn.onabort = () => { db.close(); reject(txn.error) }
                txn.oncomplete = () => {
                    db.close()
                    resolve(!write && request.result ? new TextDecoder().decode(request.result) : null)
                }
            }
        }), { key, legacyBytes, write })
    await openLegacy(true)
    await page.goto(here)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await expect(nativeText(page)).toHaveCount(0)

    await page.evaluate(async () => {
        const controller = (window as any).__weftController
        await controller.editRootText({ create: {}, inserts: [{ afterKey: null, text: 'New owner edit' }] })
        await controller.saveBeforeNavigation()
    })
    await expect(nativeText(page)).toHaveText('New owner edit')
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await page.reload()
    await expect(nativeText(page)).toHaveText('New owner edit')
    expect(await openLegacy(false)).toBe(legacyBytes)
})

test('a temporary paint failure recovers the visible page after a guarded save', async ({ page }) => {
    const here = `/app/${doc}/${crypto.randomUUID()}`
    await page.goto(here)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const expected = 'Repainted without re-saving'
    await page.evaluate(async value => {
        const w = window as any
        const controller = w.__weftController
        const onPatches = controller.onPatches.bind(controller)
        controller.onPatches = (patches: Array<{ type: string }>) => {
            if (patches.some(patch => patch.type === 'document-replaced') && !w.failedReceiptPaint) {
                w.failedReceiptPaint = true
                controller.remote(() => controller.editor.deleteShape('shape:device-text'))
                throw new Error('Synthetic paint stopped midway')
            }
            return onPatches(patches)
        }
        await controller.editRootText({ create: {}, inserts: [{ afterKey: null, text: value }] })
        await controller.saveBeforeNavigation()
    }, expected)
    await expect.poll(() => page.evaluate(() => (window as any).failedReceiptPaint)).toBe(true)
    await expect(nativeText(page)).toHaveText(expected)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await page.reload()
    await expect(nativeText(page)).toHaveText(expected)
})
