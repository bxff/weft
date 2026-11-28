import { expect, test, type Page } from '@playwright/test'
import { RmDocument } from '../packages/rm-format/src'
import { decodeOp } from '../packages/sync-engine/src/ops'
import { decodeSnapshot, decodeSnapshotBatch } from '../packages/sync-engine/src/snapshot'
import { E2E_USER, useCloudMode } from './cloud-mode'

useCloudMode()
test.skip(process.env.PUBLIC_GUARDED_SAVES !== '1', 'Requires the guarded build')
const auth = { authorization: 'Bearer dev:' + E2E_USER }
const doc = '11111111-1111-4111-a111-111111111111'

function native(bytes: Uint8Array) {
    const rm = RmDocument.parse(bytes as never)
    const layers = rm.layers()
    const lines: Array<{ points: unknown[] }> = [], images: unknown[] = []
    for (const b of rm.blocks) {
        if (b.type !== 'sceneLineItem' && b.type !== 'sceneImageItem') continue
        if (b.deletedLength !== 0) continue
        const id = {
            layer: layers.find(l => l.nodeId.part1 === b.parentId.part1 && l.nodeId.part2 === b.parentId.part2)?.label,
            author: rm.authorTable().get(b.itemId.part1),
            clock: b.itemId.part2,
        }
        if (b.type === 'sceneLineItem' && b.line) lines.push({ ...id, ...b.line })
        if (b.type === 'sceneImageItem' && b.image) images.push({ ...id, ...b.image })
    }
    return { lines, images }
}

async function relayState(page: Page, base: string) {
    const r = await page.request.get(base + '/rm', { headers: auth })
    expect(r.status()).toBe(200)
    const bytes = await r.body()
    return { bytes: bytes.toString('base64'), ...native(bytes) }
}

function queue(page: Page) {
    return page.evaluate(async () => {
        const s = (window as any).__weftController.session
        const prefix = s.pendingKey().replace(/[^/]+$/, '')
        const keys = await s.storage.keys(prefix)
        return await Promise.all(keys.map(async (key: string) => [
            key, JSON.parse(new TextDecoder().decode(await s.storage.get(key))),
        ]))
    })
}

for (const fault of ['rejected write', 'committed with lost reply']) {
    test('one mixed native pen and image save survives ' + fault, async ({ page, browser, baseURL }) => {
        const sheet = crypto.randomUUID()
        const base = `/api/documents/${doc}/pages/${sheet}`
        const href = `/app/${doc}/${sheet}`
        const sync = page.getByTestId('sync-status')
        let armPull = false, pullReached = false, releasePull!: () => void
        const pullHold = new Promise<void>(resolve => { releasePull = resolve })
        let armed = false, allow = false, firstFault = false, assetURL = ''
        let expected: ReturnType<typeof native> | undefined
        const requests: { id?: string; baseSeq?: string; body: string }[] = []
        const replies: number[] = []
        const unexpectedPageWrites: string[] = []
        page.on('request', request => {
            const path = new URL(request.url()).pathname
            if (armed && path.startsWith(base) && request.method() !== 'GET' &&
                /\/(?:snapshot|ops(?:-batch)?)$/.test(path)) unexpectedPageWrites.push(path)
        })
        await page.route('**' + base + '/assets/*', async route => {
            if (route.request().method() === 'PUT') assetURL = route.request().url()
            await route.continue()
        })
        await page.route('**' + base + '/snapshot', async route => {
            if (armPull && !pullReached && route.request().method() === 'GET') {
                pullReached = true
                await pullHold
            }
            await route.continue()
        })
        await page.route('**' + base + '/snapshot-batch', async route => {
            if (!armed) return route.continue()
            const request = route.request()
            const body = request.postDataBuffer()!
            requests.push({
                id: request.headers()['x-snapshot-publication-id'],
                baseSeq: request.headers()['x-snapshot-base-seq'],
                body: body.toString('base64'),
            })
            if (requests.length === 1) {
                const batch = decodeSnapshotBatch(body)
                expected = native(decodeSnapshot(batch.snapshot).rm)
                // Prove the fault target contains *both* real UI edits before
                // either rejection or delivery to the actual relay.
                expect(expected.lines).toEqual([expect.objectContaining({
                    layer: 'Drop origin', author: expect.any(String), clock: expect.any(Number),
                    points: expect.arrayContaining([expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) })]),
                })])
                expect(expected.lines[0].points.length).toBeGreaterThan(2)
                expect(expected.images).toEqual([expect.objectContaining({
                    layer: 'Drop origin', author: expect.any(String), clock: expect.any(Number),
                })])
                expect(batch.deltas.map(delta => decodeOp(delta).op)).toEqual(['add', 'upsert-object'])
                if (fault === 'committed with lost reply') {
                    const accepted = await route.fetch()
                    expect(accepted.status()).toBe(200)
                    await route.abort('connectionreset')
                } else {
                    await route.fulfill({ status: 503 })
                }
                firstFault = true
                return
            }
            if (!allow) return route.fulfill({ status: 503 })
            const response = await route.fetch()
            replies.push(response.status())
            return route.fulfill({ response })
        })

        await page.goto(href)
        await expect(sync).toHaveText('synced')
        await page.evaluate(async () => {
            const c = (window as any).__weftController
            await c.createLayer('Drop origin')
            await c.createLayer('Other layer')
            c.setActiveLayer(c.listLayers().find((l: any) => l.label === 'Drop origin').ref)
        })
        await expect(sync).toHaveText('synced')
        const before = await relayState(page, base)
        expect(before.lines).toEqual([])
        expect(before.images).toEqual([])
        armPull = armed = true
        await page.evaluate(() => { void (window as any).__weftController.session.reconcile() })
        await expect.poll(() => pullReached).toBe(true)
        try {
            const data = await page.evaluateHandle(async () => {
                const canvas = document.createElement('canvas')
                canvas.width = canvas.height = 4
                canvas.getContext('2d')!.fillRect(0, 0, 4, 4)
                const blob = await new Promise<Blob>(resolve => canvas.toBlob(result => resolve(result!), 'image/png'))
                const dt = new DataTransfer()
                dt.items.add(new File([blob], 'fixture.png', { type: 'image/png' }))
                return dt
            })
            await page.dispatchEvent('.tl-canvas', 'drop', { dataTransfer: data })
            await expect(page.locator('.tl-image')).toHaveCount(1)
            await page.keyboard.press('d')
            const box = (await page.locator('.tl-canvas').boundingBox())!
            await page.mouse.move(box.x + 220, box.y + 220)
            await page.mouse.down()
            await page.mouse.move(box.x + 280, box.y + 246, { steps: 8 })
            await page.mouse.move(box.x + 320, box.y + 220, { steps: 6 })
            await page.mouse.up()
            await expect.poll(async () => (await queue(page)).map(([, data]) => (Array.isArray(data) ? data : data.ops).map((o: any) => o.type)))
                .toEqual([['insert-image', 'upsert-shape']])
            await expect(sync).not.toHaveText('synced')
            expect(assetURL).not.toBe('')
            expect((await page.request.get(assetURL, { headers: auth })).status()).toBe(200)
            expect(await relayState(page, base)).toEqual(before)
            expect(requests).toEqual([])
        } finally {
            releasePull()
        }
        await expect.poll(() => firstFault).toBe(true)
        const mid = await relayState(page, base)
        if (fault === 'rejected write') expect(mid).toEqual(before)
        else expect({ lines: mid.lines, images: mid.images }).toEqual(expected)
        await expect(sync).not.toHaveText('synced')
        const frozen = await queue(page)
        expect(frozen).toHaveLength(1)
        expect(frozen[0][1]).toMatchObject({
            version: 1,
            publication: { id: requests[0].id, count: 2, payload: requests[0].body },
        })
        await page.reload()
        await expect.poll(() => requests.length).toBeGreaterThanOrEqual(2)
        await expect(sync).not.toHaveText('synced')
        await expect.poll(() => page.evaluate(() => !!(window as any).__weftController?.session)).toBe(true)
        expect(await queue(page)).toEqual(frozen)
        allow = true
        await expect(sync).toHaveText('synced', { timeout: 20_000 })
        expect(replies).toContain(200)
        expect(requests[0].id).toBeTruthy()
        expect(requests[0].baseSeq).toMatch(/^\d+$/)
        for (const req of requests) expect(req).toEqual(requests[0])
        expect(unexpectedPageWrites).toEqual([])
        expect(await queue(page)).toEqual([])
        const independent = await browser.newContext()
        try {
            const observer = await independent.newPage()
            await observer.addInitScript(([origin, user]) => {
                localStorage.setItem('weft-server-url', origin!)
                localStorage.setItem('weft-dev-user', user!)
                localStorage.setItem('weft-clerk-pk', '')
            }, [baseURL, E2E_USER])
            await observer.goto(baseURL! + href)
            await expect(observer.locator('.tl-image')).toHaveCount(1)
            const ink = observer.locator('.tl-shape[data-shape-type="draw"]')
            await expect(ink).toHaveCount(1)
            await expect(ink).toBeVisible()
            const final = await relayState(observer, base)
            expect({ lines: final.lines, images: final.images }).toEqual(expected)
            if (fault === 'committed with lost reply') expect(final).toEqual(mid)
        } finally {
            await independent.close()
        }
    })
}
