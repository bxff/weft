import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import type { Editor, TLShapeId } from 'tldraw'

const DOC = '11111111-1111-4111-a111-111111111111'
const ID = 'shape:edit-clock' as TLShapeId
const AUTH = { authorization: 'Bearer dev:e2e' }

type EditController = {
    editor: Editor
    font: object | null
    fontLoad: Promise<object | null> | null
    ensureFont(): Promise<object | null>
    flush(): Promise<void>
    schedule(): void
    saveBeforeNavigation(): Promise<void>
    session: { reconcile(): Promise<void> }
}

async function signIn(context: BrowserContext, origin: string) {
    await context.addInitScript((url) => {
        localStorage.setItem('weft-server-url', url)
        localStorage.setItem('weft-dev-user', 'e2e')
        localStorage.setItem('weft-clerk-pk', '')
    }, origin)
}

function edit(page: Page, timestamp: number, x: number | null, hold = false, shapeId = ID, type: 'geo' | 'text' = 'geo') {
    return page.evaluate(async ({ id, timestamp, x, hold, type }) => {
        const controller = (window as Window & { __weftController?: EditController }).__weftController!
        const now = Date.now
        Date.now = () => timestamp
        try {
            controller.schedule = () => {}
            const { editor } = controller
            if (x === null) editor.deleteShapes([id])
            else if (editor.getShape(id)) editor.updateShape({ id, type, x })
            else if (type === 'text') editor.createShape({
                id, type, x, y: 10, props: {
                    richText: { type: 'doc', content: [{
                        type: 'paragraph', content: [{ type: 'text', text: 'Legacy text' }],
                    }] },
                },
            })
            else editor.createShape({ id, type, x, y: 10 })
            editor.store._flushHistory()
            if (!hold) await controller.flush()
        } finally {
            Date.now = now
        }
    }, { id: shapeId, timestamp, x, hold, type })
}

function reconcile(page: Page) {
    return page.evaluate(async () => {
        const controller = (window as Window & { __weftController?: EditController }).__weftController!
        await controller.session.reconcile()
    })
}

function visibleX(page: Page, shapeId = ID) {
    return page.evaluate((id) => {
        const controller = (window as Window & { __weftController?: EditController }).__weftController
        return controller?.editor.getShape(id)?.x
    }, shapeId)
}

for (const situation of ['initial shape', 'live shape', 'initial deletion', 'live deletion', 'hidden edit', 'local clock'] as const) {
    test(`browser edit versions preserve order: ${situation}`, async ({ page, context, browser, request, baseURL }) => {
        const pageId = crypto.randomUUID()
        const endpoint = `/api/documents/${DOC}/pages/${pageId}`
        const position = async () => {
            const response = await request.get(`${endpoint}/overlay`, { headers: AUTH })
            expect(response.ok()).toBe(true)
            const { shapes } = await response.json() as { shapes: { shapeId: string; x: number }[] }
            return shapes.find((shape) => shape.shapeId === ID)?.x
        }
        const open = async (target: Page) => {
            await target.goto(`/app/${DOC}/${pageId}`)
            await expect(target.getByTestId('sync-status')).toHaveText('synced')
        }
        const now = Date.now()
        const future = now + 10_000
        await signIn(context, baseURL!)
        await open(page)
        if (situation === 'local clock') {
            await edit(page, now, 100)
            await expect.poll(position).toBe(100)
            await edit(page, now, 200)
            await expect.poll(position).toBe(200)
            await edit(page, now - 10_000, 300)
            await expect.poll(position).toBe(300)
            await edit(page, now - 10_000, null, true)
            await edit(page, now - 10_000, 400)
            await expect.poll(position).toBe(400)
            return
        }

        const peerContext = await browser.newContext()
        try {
            await signIn(peerContext, baseURL!)
            const peer = await peerContext.newPage()
            if (situation.startsWith('live')) await open(peer)
            await edit(page, future, 100)
            await expect.poll(position).toBe(100)
            if (situation.startsWith('live')) await reconcile(peer)
            if (situation === 'live deletion') await expect.poll(() => visibleX(peer)).toBe(100)
            if (situation.endsWith('deletion')) {
                await edit(page, future + 10, null)
                await expect.poll(position).toBeUndefined()
                if (situation === 'live deletion') await reconcile(peer)
            }
            if (!situation.startsWith('live')) await open(peer)
            if (situation.endsWith('deletion')) await expect.poll(() => visibleX(peer)).toBeUndefined()
            else await expect.poll(() => visibleX(peer)).toBe(100)
            if (situation !== 'hidden edit') {
                await edit(peer, now, 200)
                await expect.poll(position).toBe(200)
                return
            }

            await edit(peer, now, 200, true)
            await edit(page, future + 10, 300)
            await expect.poll(position).toBe(300)
            await reconcile(peer)
            expect(await visibleX(peer)).toBe(200)
            await peer.evaluate(async (timestamp) => {
                const controller = (window as Window & { __weftController?: EditController }).__weftController!
                const now = Date.now
                Date.now = () => timestamp
                try {
                    await controller.flush()
                    await controller.session.reconcile()
                } finally {
                    Date.now = now
                }
            }, future + 20)
            expect(await position()).toBe(300)
            await expect.poll(() => visibleX(peer)).toBe(300)
        } finally {
            await peerContext.close()
        }
    })
}
