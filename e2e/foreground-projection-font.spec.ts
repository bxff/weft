import { expect, test, type Page } from '@playwright/test'
import { inkRm } from './device-blob'
import { eraseItemsInRm, type OverlayShapeJson } from './tablet-erase'
import type { Editor, TLShapeId } from 'tldraw'

const auth = { authorization: 'Bearer dev:e2e' }
const font = '/fonts/ShantellSans.ttf'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('weft-server-url', location.origin)
        localStorage.setItem('weft-clerk-pk', '')
        localStorage.setItem('weft-dev-user', 'e2e')
    })
})

function ids() {
    const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
    return { app: `/app/${doc}/${sheet}`, api: `/api/documents/${doc}/pages/${sheet}` }
}

async function typeLabel(page: Page): Promise<void> {
    await page.keyboard.press('t')
    const box = (await page.locator('.tl-canvas').boundingBox())!
    await page.mouse.click(box.x + box.width / 2 - 50, box.y + 260)
    await page.keyboard.type('ABCD')
    await page.keyboard.press('Escape')
}

async function reconcile(page: Page): Promise<void> {
    await page.evaluate(async () => {
        const controller = (window as unknown as {
            __weftController: { session: { reconcile(): Promise<void> } }
        }).__weftController
        await controller.session.reconcile()
    })
}

test('cold checkpoint starts before the projection font and the warm page stays editable offline', async ({ page, request }) => {
    const { encodeSnapshot } = await import('../packages/sync-engine/src/snapshot')
    const { app, api } = ids()
    expect((await request.put(api + '/snapshot', {
        headers: { ...auth, 'content-type': 'application/octet-stream' },
        data: Buffer.from(encodeSnapshot(await inkRm(1), { shapes: [] })),
    })).ok()).toBe(true)
    const starts: string[] = []
    page.on('request', req => {
        const path = new URL(req.url()).pathname
        if (path === font) starts.push('projection font')
        if (path === api + '/snapshot' && req.method() === 'GET' && !req.headers()['x-if-snapshot-seq-gt']) {
            starts.push('cold checkpoint')
        }
    })
    await page.goto(app)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await expect(page.locator('.tl-shape[data-shape-type="draw"]')).toHaveCount(1)
    expect(starts).toEqual(['cold checkpoint', 'projection font'])

    starts.length = 0
    const pattern = `**${api}/snapshot**`
    const failRead = (route: import('@playwright/test').Route) => route.request().method() === 'GET'
        ? route.abort('internetdisconnected')
        : route.continue()
    await page.route(pattern, failRead)
    await page.reload()
    await expect(page.getByTestId('sync-status')).toHaveText('offline')
    await expect(page.locator('.tl-shape[data-shape-type="draw"]')).toHaveCount(1)
    expect(starts).not.toContain('cold checkpoint')
    await typeLabel(page)
    await expect(page.locator('.tl-shape[data-shape-type="text"]')).toContainText('ABCD')

    await page.unroute(pattern, failRead)
    await reconcile(page)
    await expect.poll(async () => {
        const overlay = await (await request.get(api + '/overlay', { headers: auth })).json() as {
            shapes: { kind: string; rendered: { partKey: string }[] }[]
        }
        return overlay.shapes.find(shape => shape.kind === 'text')?.rendered.map(part => part.partKey)
    }).toEqual(['glyph:0', 'glyph:1', 'glyph:2', 'glyph:3'])
})

test('a failed first checkpoint can recover to an editable empty page and project its first label', async ({ page, request }) => {
    const { app, api } = ids()
    const pattern = `**${api}/snapshot**`
    let requestedFont = false
    page.on('request', request => {
        if (new URL(request.url()).pathname === font) requestedFont = true
    })
    const fail = (route: import('@playwright/test').Route) => route.abort('internetdisconnected')
    await page.route(pattern, fail)
    await page.goto(app)
    await expect(page.getByTestId('sync-status')).toHaveText('offline')
    expect(requestedFont).toBe(false)
    await page.unroute(pattern, fail)
    await reconcile(page)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    expect(requestedFont).toBe(true)
    await typeLabel(page)
    await expect.poll(async () => {
        const response = await request.get(api + '/overlay', { headers: auth })
        if (!response.ok()) return []
        const overlay = await response.json() as { shapes: { kind: string; rendered: unknown[] }[] }
        return overlay.shapes.find(shape => shape.kind === 'text')?.rendered ?? []
    }).toHaveLength(4)
})

for (const editAfterRepair of [false, true]) {
    test(`a delayed tablet repair preserves the current text (later edit: ${editAfterRepair})`, async ({ page, request }) => {
        const { app, api } = ids()
        const readLabel = async (): Promise<OverlayShapeJson | undefined> => {
            const response = await request.get(api + '/overlay', { headers: auth })
            if (!response.ok()) return undefined
            const overlay = await response.json() as { shapes: OverlayShapeJson[] }
            return overlay.shapes.find(shape => shape.kind === 'text')
        }
        await page.goto(app)
        await expect(page.getByTestId('sync-status')).toHaveText('synced')
        await typeLabel(page)
        await expect.poll(async () => (await readLabel())?.rendered.length).toBe(4)
        const label = (await readLabel())!
        const tail = label.rendered.find(part => part.partKey === 'glyph:3')!
        const pair = await request.post('/api/pair', { headers: auth, data: { label: 'font repair test' } })
        expect(pair.ok()).toBe(true)
        const { token } = await pair.json() as { token: string }

        let releaseFont!: () => void
        const fontGate = new Promise<void>(resolve => { releaseFont = resolve })
        await page.route(`**${font}`, async route => {
            await fontGate
            await route.continue()
        })
        try {
            const pending = page.waitForRequest(req => new URL(req.url()).pathname === font)
            await page.reload()
            await pending
            const shape = page.locator('.tl-shape[data-shape-type="text"]')
            await expect(shape).toContainText('ABCD')
            const head = await request.get(api + '/rm', { headers: auth })
            expect(head.ok()).toBe(true)
            const erased = await eraseItemsInRm(new Uint8Array(await head.body()), tail.items)
            expect((await request.put(api + '/rm', {
                headers: {
                    'x-device-token': token,
                    'x-base-revision': head.headers()['x-rm-revision']!,
                    'content-type': 'application/octet-stream',
                },
                data: Buffer.from(erased),
            })).ok()).toBe(true)
            await expect(shape).toContainText('ABC')
            await expect(shape).not.toContainText('ABCD')
            if (editAfterRepair) {
                await page.evaluate((id) => {
                    const editor = (window as unknown as {__weftEditor: Editor}).__weftEditor
                    editor.updateShape({
                        id: id as TLShapeId,
                        type: 'text',
                        props: { richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ABCXY' }] }] } },
                    })
                }, label.shapeId)
                await expect(shape).toContainText('ABCXY')
            }
            releaseFont()
            await expect.poll(async () => (await readLabel())?.rendered.length).toBe(editAfterRepair ? 5 : 3)
            await expect(shape).toHaveText(editAfterRepair ? 'ABCXY' : 'ABC')
        } finally {
            releaseFont()
        }
    })
}

test('an immediate reattach can wait for the projection font', async ({ page, request }) => {
    const { app, api } = ids()
    const readLabel = async (): Promise<OverlayShapeJson | undefined> => {
        const response = await request.get(api + '/overlay', { headers: auth })
        if (!response.ok()) return undefined
        return ((await response.json()) as { shapes: OverlayShapeJson[] }).shapes.find(shape => shape.kind === 'text')
    }
    await page.goto(app)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await typeLabel(page)
    await expect.poll(async () => (await readLabel())?.rendered.length).toBe(4)
    const label = (await readLabel())!
    const glyph = label.rendered.find(part => part.partKey === 'glyph:1')!
    const pair = await request.post('/api/pair', { headers: auth, data: { label: 'font reattach test' } })
    expect(pair.ok()).toBe(true)
    const { token } = await pair.json() as { token: string }
    const head = await request.get(api + '/rm', { headers: auth })
    expect(head.ok()).toBe(true)
    const erased = await eraseItemsInRm(new Uint8Array(await head.body()), glyph.items)
    expect((await request.put(api + '/rm', {
        headers: {
            'x-device-token': token,
            'x-base-revision': head.headers()['x-rm-revision']!,
            'content-type': 'application/octet-stream',
        },
        data: Buffer.from(erased),
    })).ok()).toBe(true)

    let releaseFont!: () => void
    const fontGate = new Promise<void>(resolve => { releaseFont = resolve })
    await page.route(`**${font}`, async route => {
        await fontGate
        await route.continue()
    })
    try {
        const pendingFont = page.waitForRequest(req => new URL(req.url()).pathname === font)
        await page.reload()
        await pendingFont
        await page.waitForFunction(id => {
            const editor = (window as unknown as { __weftEditor?: Editor }).__weftEditor
            return editor?.getShape(id as TLShapeId)?.meta.detached === true
        }, label.shapeId)
        await page.evaluate(id => {
            const live = window as unknown as {
                __weftController: { reattachShape(id: string): Promise<void> }
                testReattach?: Promise<void>
            }
            live.testReattach = live.__weftController.reattachShape(id)
        }, label.shapeId)
        releaseFont()
        await page.evaluate(() => (window as unknown as { testReattach: Promise<void> }).testReattach)
        await page.waitForFunction(id => {
            const editor = (window as unknown as { __weftEditor?: Editor }).__weftEditor
            return editor?.getShape(id as TLShapeId)?.meta.detached === false
        }, label.shapeId)
        await expect.poll(async () => (await readLabel())?.rendered.length).toBe(4)
    } finally {
        releaseFont()
    }
})
