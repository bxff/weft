import { expect, test, type Page } from '@playwright/test'
import type { Editor, TLShapeId } from 'tldraw'
import type { OverlayShape } from '../packages/sync-engine/src/types'
import type { LayerRef } from '../packages/sync-engine/src/apply-ops'

const arrow = 'shape:opacity-arrow' as TLShapeId
const label = 'shape:opacity-text' as TLShapeId
const auth = { authorization: 'Bearer dev:e2e' }

async function signIn(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('weft-server-url', location.origin)
        localStorage.setItem('weft-dev-user', 'e2e')
        localStorage.setItem('weft-clerk-pk', '')
    })
}

function opacities(page: Page) {
    return page.evaluate(ids => {
        const editor = (window as unknown as { __weftEditor?: Editor }).__weftEditor
        return ids.map(id => editor?.getShape(id)?.opacity)
    }, [arrow, label])
}

test('tldraw arrow and text opacity survive accepted and offline reopen', async ({ page, browser, baseURL }) => {
    const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
    const url = `/app/${doc}/${sheet}`
    const api = `/api/documents/${doc}/pages/${sheet}`
    await signIn(page)
    await page.goto(url)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await page.evaluate(([arrow, label]) => {
        const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
        editor.createShapes([
            { id: arrow, type: 'arrow', opacity: 0.25, x: 100, y: 100, props: { end: { x: 140, y: 80 } } },
            { id: label, type: 'text', opacity: 0.25, x: 100, y: 200, props: {
                richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Opacity' }] }] },
            } },
        ])
    }, [arrow, label])
    const saved = async (): Promise<OverlayShape[]> => {
        const response = await page.request.get(api + '/overlay', { headers: auth })
        return response.ok() ? (await response.json()).shapes : []
    }
    await expect.poll(async () => (await saved()).length).toBe(2)
    const originalArrow = (await saved()).find(shape => shape.shapeId === arrow)!
    await page.evaluate(id => {
        const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
        editor.updateShape({ id, type: 'arrow', x: 128 })
    }, arrow)
    await expect.poll(async () => (await saved()).find(shape => shape.shapeId === arrow)?.x).toBe(128)
    const movedArrow = (await saved()).find(shape => shape.shapeId === arrow)!
    expect(movedArrow.opacity).toBe(0.25)
    expect(movedArrow.opacityVersion ?? movedArrow.version).toEqual(originalArrow.opacityVersion ?? originalArrow.version)

    // Two user updates can return to the accepted value before the projection debounce.
    await page.evaluate(id => {
        const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
        editor.updateShape({ id, type: 'arrow', opacity: 0.5 })
        editor.store._flushHistory()
        editor.updateShape({ id, type: 'arrow', opacity: 0.25 })
        editor.store._flushHistory()
    }, arrow)
    await expect.poll(async () => {
        const current = (await saved()).find(shape => shape.shapeId === arrow)!
        return (current.opacityVersion ?? current.version).ts
    }).toBeGreaterThan((movedArrow.opacityVersion ?? movedArrow.version).ts)
    expect((await saved()).find(shape => shape.shapeId === arrow)?.opacity).toBe(0.25)

    const actor = 'legacy-browser'
    const beforeLegacyUpdate = (await saved()).find(shape => shape.shapeId === arrow)!
    const version = { ts: beforeLegacyUpdate.version.ts + 1, actor }
    const legacy = Buffer.from(JSON.stringify({
        op: 'upsert-object', id: arrow, objType: beforeLegacyUpdate.kind, props: beforeLegacyUpdate.props,
        transform: { x: beforeLegacyUpdate.x, y: beforeLegacyUpdate.y, rotation: beforeLegacyUpdate.rotation },
        rendered: beforeLegacyUpdate.rendered, renderRevision: beforeLegacyUpdate.renderRevision, version,
    })).toString('base64')
    expect((await page.request.post(api + '/ops', { headers: auth, data: { ops: [legacy], author: actor } })).ok()).toBe(true)
    await expect.poll(async () => (await saved()).find(shape => shape.shapeId === arrow)?.version).toEqual(version)

    const context = await browser.newContext({ baseURL })
    try {
        const reader = await context.newPage()
        await signIn(reader)
        await reader.goto(url)
        await expect.poll(() => opacities(reader)).toEqual([0.25, 0.25])
        await expect.poll(() => opacities(page)).toEqual([0.25, 0.25])

        const nativeBefore = await (await page.request.get(api + '/rm', { headers: auth })).body()
        await page.evaluate(id => {
            const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
            editor.updateShape({ id, type: 'arrow', opacity: 1 })
        }, arrow)
        await expect.poll(async () => (await saved()).find(shape => shape.shapeId === arrow)?.opacity).toBe(1)
        await expect.poll(() => opacities(reader)).toEqual([1, 0.25])
        expect(await (await page.request.get(api + '/rm', { headers: auth })).body()).toEqual(nativeBefore)

        // The app shell can still load. Block this tab's data requests to
        // force the edit and reopened page through the local outbox.
        await context.route('**/api/**', route => route.abort('connectionfailed'))
        await reader.evaluate(id => {
            const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
            editor.updateShape({ id, type: 'text', opacity: 0.5 })
        }, label)
        await expect(reader.getByTestId('sync-status')).toHaveText('offline')
        await reader.reload()
        await expect.poll(() => opacities(reader)).toEqual([1, 0.5])
        await context.unroute('**/api/**')
        await expect.poll(async () => (await saved()).find(shape => shape.shapeId === label)?.opacity).toBe(0.5)

        const storedText = (await saved()).find(shape => shape.shapeId === label)!
        const erase = storedText.rendered.find(part => part.partKey === 'glyph:1')!.items.map(ref =>
            Buffer.from(JSON.stringify({ op: 'tombstone', id: { author: ref.authorUuid, clock: ref.clock } })).toString('base64'))
        expect((await page.request.post(api + '/ops', { headers: auth, data: { ops: erase, author: actor } })).ok()).toBe(true)
        await expect.poll(() => opacities(reader)).toEqual([1, 0.125])
        await reader.evaluate(id => (window as unknown as {
            __weftController: { reattachShape(id: string): Promise<void> },
        }).__weftController.reattachShape(id), label)
        await expect.poll(() => opacities(reader)).toEqual([1, 0.5])
        await expect.poll(async () => (await saved()).find(shape => shape.shapeId === label)?.opacity).toBe(0.5)
    } finally {
        await context.close()
    }
})

test('an unrelated peer update cannot overwrite a pending opacity edit', async ({ page, browser, baseURL }) => {
    const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
    const url = `/app/${doc}/${sheet}`
    const api = `/api/documents/${doc}/pages/${sheet}`
    await signIn(page)
    await page.goto(url)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const ref = await page.evaluate(async id => {
        const { __weftEditor: editor, __weftController: controller } = window as unknown as {
            __weftEditor: Editor
            __weftController: {
                createLayer(label: string): Promise<void>
                listLayers(): { label: string; ref: LayerRef }[]
                setActiveLayer(ref: LayerRef): void
            }
        }
        await controller.createLayer('Opacity test')
        const layer = controller.listLayers().find(layer => layer.label === 'Opacity test')!
        controller.setActiveLayer(layer.ref)
        editor.createShape({ id, type: 'arrow', opacity: 0.25, props: { end: { x: 140, y: 80 } } })
        return layer.ref
    }, arrow)
    const context = await browser.newContext({ baseURL })
    try {
        const peer = await context.newPage()
        await signIn(peer)
        await peer.goto(url)
        await expect.poll(async () => (await opacities(peer))[0]).toBe(0.25)
        await page.evaluate(id => {
            const { __weftEditor: editor, __weftController: controller } = window as unknown as {
                __weftEditor: Editor
                __weftController: { debounce?: number; pendingShapeIds: Set<string> }
            }
            editor.updateShape({ id, type: 'arrow', opacity: 0.5 })
            editor.store._flushHistory()
            clearTimeout(controller.debounce)
            if (!controller.pendingShapeIds.has(id)) throw new Error('expected an unflushed opacity edit')
        }, arrow)
        const other = 'shape:opacity-peer' as TLShapeId
        await peer.evaluate(id => {
            const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
            editor.createShape({ id, type: 'geo', x: 180, y: 100 })
        }, other)
        await expect.poll(() => page.evaluate(id =>
            !!(window as unknown as { __weftEditor: Editor }).__weftEditor.getShape(id), other)).toBe(true)
        expect((await opacities(page))[0]).toBe(0.5)
        const visible = (show: boolean) => page.evaluate(({ ref, show }) => (window as unknown as {
            __weftController: { setLayerVisible(ref: LayerRef, visible: boolean): Promise<void> },
        }).__weftController.setLayerVisible(ref, show), { ref, show })
        await visible(false)
        expect((await opacities(page))[0]).toBe(0)
        await visible(true)
        expect((await opacities(page))[0]).toBe(0.5)
        await visible(false)
        await page.evaluate(() => (window as unknown as {
            __weftController: { flush(): Promise<void> },
        }).__weftController.flush())
        await expect.poll(async () => {
            const response = await page.request.get(api + '/overlay', { headers: auth })
            return ((await response.json()).shapes as OverlayShape[]).find(shape => shape.shapeId === arrow)?.opacity
        }).toBe(0.5)
        expect((await opacities(page))[0]).toBe(0)
        await visible(true)
        expect((await opacities(page))[0]).toBe(0.5)
    } finally {
        await context.close()
    }
})

for (const scenario of ['opacity', 'geometry', 'snapshot'] as const) {
    test(`deferred peer opacity repaints after a local ${scenario} conflict`, async ({ page, browser, baseURL }) => {
        const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
        const url = `/app/${doc}/${sheet}`
        const api = `/api/documents/${doc}/pages/${sheet}`
        await signIn(page)
        await page.goto(url)
        await expect(page.getByTestId('sync-status')).toHaveText('synced')
        await page.evaluate(id => {
            const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
            editor.createShape({ id, type: 'arrow', x: 90, opacity: 0.25, props: { end: { x: 140, y: 80 } } })
        }, arrow)
        const context = await browser.newContext({ baseURL })
        try {
            const peer = await context.newPage()
            await signIn(peer)
            await peer.goto(url)
            await expect.poll(async () => (await opacities(peer))[0]).toBe(0.25)
            const editOpacity = scenario === 'opacity'
            await page.evaluate(({ id, editOpacity }) => {
                const { __weftEditor: editor, __weftController: controller } = window as unknown as {
                    __weftEditor: Editor
                    __weftController: { debounce?: number; pendingShapeIds: Set<string> }
                }
                editor.clearHistory()
                editor.markHistoryStoppingPoint('local edit')
                editor.updateShape({ id, type: 'arrow', ...(editOpacity ? { opacity: 0.5 } : { x: 128 }) })
                editor.store._flushHistory()
                clearTimeout(controller.debounce)
                if (!controller.pendingShapeIds.has(id)) throw new Error('expected an unflushed edit')
            }, { id: arrow, editOpacity })
            if (scenario === 'snapshot') await page.route('**/api/**', route => route.abort('connectionfailed'))
            await peer.evaluate(id => {
                const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
                editor.updateShape({ id, type: 'arrow', opacity: 0.75 })
            }, arrow)
            if (scenario === 'snapshot') {
                await expect.poll(async () => {
                    const response = await peer.request.get(api + '/overlay', { headers: auth })
                    return ((await response.json()).shapes as OverlayShape[]).find(shape => shape.shapeId === arrow)?.opacity
                }).toBe(0.75)
                const snapshot = peer.waitForResponse(response => response.url().includes(api + '/snapshot') &&
                    response.request().method() === 'PUT' && response.ok())
                await peer.evaluate(() => (window as unknown as {
                    __weftController: { editRootText(edit: { create: object }): Promise<void> },
                }).__weftController.editRootText({ create: {} }))
                await snapshot
                await page.unroute('**/api/**')
                await page.evaluate(() => (window as unknown as {
                    __weftController: { session: { reconcile(): Promise<void> } },
                }).__weftController.session.reconcile())
                await expect(page.locator('.tl-shape[data-shape-type="device-text"]')).toBeVisible()
            }
            const accepted = () => page.evaluate(id => (window as unknown as {
                __weftController: { session: { currentOverlay: { shapes: OverlayShape[] } } },
            }).__weftController.session.currentOverlay.shapes.find(shape => shape.shapeId === id)?.opacity, arrow)
            await expect.poll(accepted).toBe(0.75)
            expect((await opacities(page))[0]).toBe(editOpacity ? 0.5 : 0.25)
            const publications: string[] = []
            page.on('request', request => {
                if (request.method() === 'POST' && /\/(ops|snapshot)$/.test(new URL(request.url()).pathname)) {
                    publications.push(request.url())
                }
            })
            await page.evaluate(() => (window as unknown as {
                __weftController: { flush(): Promise<void> },
            }).__weftController.flush())
            await expect(page.getByTestId('sync-status')).toHaveText('synced')
            expect(await accepted()).toBe(0.75)
            await expect.poll(async () => (await opacities(page))[0]).toBe(0.75)
            if (editOpacity) expect(publications).toEqual([])
            expect(await page.evaluate(({ id, editOpacity }) => {
                const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
                const x = editor.getShape(id)?.x
                editor.undo()
                const undone = editor.getShape(id)
                return [x, editOpacity ? undone?.opacity : undone?.x]
            }, { id: arrow, editOpacity })).toEqual(editOpacity ? [90, 0.25] : [128, 90])
        } finally {
            await context.close()
        }
    })
}
