import { test, expect } from '@playwright/test'
import { useCloudMode } from './cloud-mode'
import { RmDocument } from '../packages/rm-format/src'
useCloudMode()
test.skip(process.env.PUBLIC_GUARDED_SAVES !== '1', 'Requires the guarded build')
const doc = '11111111-1111-4111-a111-111111111111'
const other = '/app/22222222-2222-4222-a222-222222222222/bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb'
const source =
    '/api/documents/88888888-8888-4888-a888-888888888888/pages/99999999-9999-4999-a999-999999999999/assets/ab1e0001-0000-4000-a000-0000000000ab.png'
for (const fault of ['failed write', 'lost reply'] as const) {
    test('native image state survives ' + fault, async ({ page, browser }) => {
        const sheet = crypto.randomUUID()
        const base = '/api/documents/' + doc + '/pages/' + sheet
        const origin = '/app/' + doc + '/' + sheet
        const placements = async () => {
            const res = await page.request.get(base + '/rm')
            expect(res.ok()).toBe(true)
            const raw = RmDocument.parse(new Uint8Array(await res.body()) as never)
            const layers = raw.layers()
            return raw.blocks.flatMap((block) => {
                if (block.type !== 'sceneImageItem' || block.deletedLength !== 0 || !block.image) return []
                const layer = layers.find(
                    (l) => l.nodeId.part1 === block.parentId.part1 && l.nodeId.part2 === block.parentId.part2,
                )
                return [
                    {
                        layer: layer?.label,
                        author: raw.authorTable().get(block.itemId.part1),
                        clock: block.itemId.part2,
                    },
                ]
            })
        }
        const navigate = async (href: string) => {
            await page.evaluate((url) => {
                const a = document.createElement('a')
                a.href = url
                document.body.append(a)
                a.click()
            }, href)
            await expect
                .poll(() =>
                    page.evaluate(() => {
                        const c = (window as any).__weftController
                        return c && '/app/' + c.opts.docId + '/' + c.opts.pageId
                    }),
                )
                .toBe(href)
        }
        await page.goto(origin)
        await expect(page.getByTestId('sync-status')).toHaveText('synced')
        await page.evaluate(async () => {
            const c = (window as any).__weftController
            await c.createLayer('Drop origin')
            await c.createLayer('Other layer')
            c.setActiveLayer(c.listLayers().find((l: any) => l.label === 'Drop origin').ref)
        })
        await expect(page.getByTestId('sync-status')).toHaveText('synced')
        let allow = false
        let confirmed = false
        let assetURL = ''
        const requests: { id: string | undefined; bytes: string | undefined }[] = []
        await page.route('**' + base + '/assets/*', async (route) => {
            if (route.request().method() !== 'PUT') return route.continue()
            const response = await route.fetch()
            expect(response.ok()).toBe(true)
            assetURL = route.request().url()
            await route.fulfill({ response })
        })
        await page.route('**' + base + '/snapshot*', async (route) => {
            if (route.request().method() !== 'POST' || !route.request().url().endsWith('/snapshot-batch'))
                return route.continue()
            requests.push({
                id: route.request().headers()['x-snapshot-publication-id'],
                bytes: route.request().postDataBuffer()?.toString('base64'),
            })
            if (allow) return route.continue()
            if (fault === 'lost reply' && requests.length === 1) {
                const accepted = await route.fetch()
                expect(accepted.ok()).toBe(true)
                confirmed = true
                return route.abort('connectionreset')
            }
            confirmed = true
            return route.fulfill({ status: 503 })
        })
        const dt = await page.evaluateHandle(async (src) => {
            const b = await (await fetch(src)).blob()
            const dt = new DataTransfer()
            dt.items.add(new File([b], 'drop.png', { type: 'image/png' }))
            return dt
        }, source)
        await page.dispatchEvent('.tl-canvas', 'drop', { dataTransfer: dt })
        await expect.poll(() => confirmed).toBe(true)
        expect((await page.request.get(assetURL)).status()).toBe(200)
        // An uploaded asset is not a placement. Check what the actual relay has
        // before revisiting the source, while successful replies are still blocked.
        const before = await placements()
        expect(before.map((p) => p.layer)).toEqual(fault === 'lost reply' ? ['Drop origin'] : [])
        await expect(page.locator('.tl-image')).toHaveCount(1)
        await navigate(other)
        await expect(page.locator('.tl-image')).toHaveCount(0)
        await navigate(origin)
        await page.reload()
        await expect(page.locator('.tl-image')).toHaveCount(1)
        allow = true
        await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 20_000 })
        expect(requests.length).toBeGreaterThanOrEqual(2)
        expect(requests[0]?.id).toBeTruthy()
        expect(requests[0]?.bytes).toBeTruthy()
        for (const request of requests) expect(request).toEqual(requests[0])
        const after = await placements()
        expect(after.map((p) => p.layer)).toEqual(['Drop origin'])
        if (fault === 'lost reply') expect(after).toEqual(before)
        const independent = await browser.newContext()
        try {
            await independent.addInitScript(() => {
                localStorage.setItem('weft-server-url', location.origin)
                localStorage.setItem('weft-dev-user', 'e2e')
                localStorage.setItem('weft-clerk-pk', '')
            })
            const observer = await independent.newPage()
            await observer.goto(page.url())
            await expect(observer.locator('.tl-image')).toHaveCount(1)
        } finally {
            await independent.close()
        }
    })
}
