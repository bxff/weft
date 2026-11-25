import { expect, test, type Page } from '@playwright/test'
import type { Editor, IndexKey, TLShapeId } from 'tldraw'

const first = 'shape:order-first' as TLShapeId
const second = 'shape:order-second' as TLShapeId
const middle = 'shape:order-middle' as TLShapeId
const auth = { authorization: 'Bearer dev:e2e' }

async function signIn(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('weft-server-url', location.origin)
        localStorage.setItem('weft-dev-user', 'e2e')
        localStorage.setItem('weft-clerk-pk', '')
    })
}

function order(page: Page, ids = [first, second]) {
    return page.evaluate(ids => {
        const editor = (window as unknown as { __weftEditor?: Editor }).__weftEditor
        return editor?.getCurrentPageShapesSorted().filter(shape => ids.includes(shape.id)).map(shape => shape.id)
    }, ids)
}

test('reordering existing browser shapes survives a peer update and a cold open', async ({ page, browser, baseURL }) => {
    const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
    const url = `/app/${doc}/${sheet}`
    const api = `/api/documents/${doc}/pages/${sheet}`
    await signIn(page)
    await page.goto(url)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await page.evaluate(([a, b]) => {
        const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
        editor.createShapes([
            { id: a, type: 'geo', x: 100, y: 100, props: { color: 'red' } },
            { id: b, type: 'geo', x: 130, y: 130, props: { color: 'blue' } },
        ])
    }, [first, second])
    await expect.poll(async () => {
        const r = await page.request.get(api + '/overlay', { headers: auth })
        return r.ok() ? (await r.json()).shapes.length : 0
    }).toBe(2)
    const before = await (await page.request.get(api + '/rm', { headers: auth })).body()
    const context = await browser.newContext({ baseURL })
    try {
        const peer = await context.newPage()
        await signIn(peer)
        await peer.goto(url)
        await expect.poll(() => order(peer)).toEqual([first, second])
        await peer.evaluate(id => {
            const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
            editor.run(() => editor.updateShape({ id, type: 'geo', isLocked: true }), { history: 'ignore' })
        }, first)
        await page.evaluate(id => {
            const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
            editor.markHistoryStoppingPoint('reorder shapes')
            editor.bringToFront([id])
        }, first)
        await expect.poll(() => order(page)).toEqual([second, first])
        const writerIndex = await page.evaluate(id =>
            (window as unknown as { __weftEditor: Editor }).__weftEditor.getShape(id)?.index, first)
        await expect.poll(async () => {
            const current = await page.request.get(api + '/overlay', { headers: auth })
            return (await current.json()).shapes.find(shape => shape.shapeId === first)?.browserIndex
        }).toBe(writerIndex)
        await expect.poll(() => order(peer)).toEqual([second, first])
        expect(await (await page.request.get(api + '/rm', { headers: auth })).body()).toEqual(before)

        for (const step of ['undo', 'redo'] as const) {
            const expected = step === 'undo' ? [first, second] : [second, first]
            await page.evaluate(action => {
                const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
                editor[action]()
            }, step)
            await expect.poll(() => order(page)).toEqual(expected)
            const index = await page.evaluate(id =>
                (window as unknown as { __weftEditor: Editor }).__weftEditor.getShape(id)?.index, first)
            await expect.poll(async () => {
                const response = await page.request.get(api + '/overlay', { headers: auth })
                return (await response.json()).shapes.find(shape => shape.shapeId === first)?.browserIndex
            }).toBe(index)
            await expect.poll(() => order(peer)).toEqual(expected)
            expect(await (await page.request.get(api + '/rm', { headers: auth })).body()).toEqual(before)
        }
    } finally {
        await context.close()
    }
    const reopened = await browser.newContext({ baseURL })
    try {
        const reader = await reopened.newPage()
        await signIn(reader)
        await reader.goto(url)
        await expect.poll(() => order(reader)).toEqual([second, first])
    } finally {
        await reopened.close()
    }
})

test('two browser writers with the same index converge from opposite local arrival orders', async ({ page, browser, baseURL }) => {
    const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
    const url = `/app/${doc}/${sheet}`
    const api = `/api/documents/${doc}/pages/${sheet}`
    const peerContext = await browser.newContext({ baseURL })
    const readerContext = await browser.newContext({ baseURL })
    try {
        const peer = await peerContext.newPage()
        for (const writer of [page, peer]) {
            await signIn(writer)
            await writer.goto(url)
            await expect(writer.getByTestId('sync-status')).toHaveText('synced')
        }
        let unblock!: () => void
        const gate = new Promise<void>(resolve => { unblock = resolve })
        const publications = []
        for (const [writer, id] of [[page, first], [peer, second]] as const) {
            await writer.route(url => url.pathname.endsWith(api + '/ops'), async route => {
                if (route.request().method() === 'POST') await gate
                await route.continue()
            })
            publications.push(writer.waitForRequest(request =>
                request.method() === 'POST' && new URL(request.url()).pathname === api + '/ops', { timeout: 5_000 }))
            await writer.evaluate(id => {
                const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
                editor.createShape({ id, type: 'geo', x: 120, y: 120, index: 'a3' as IndexKey })
            }, id)
        }
        try {
            await Promise.all(publications)
        } finally {
            unblock()
        }
        const overlay = async () => {
            const response = await page.request.get(api + '/overlay', { headers: auth })
            return (await response.json()).shapes as { shapeId: string; browserIndex?: string }[]
        }
        await expect.poll(async () => (await overlay()).map(shape => shape.browserIndex)).toEqual(['a3', 'a3'])
        for (const writer of [page, peer]) {
            await writer.evaluate(() => (window as unknown as {
                __weftController: { session: { reconcile(): Promise<void> } },
            }).__weftController.session.reconcile())
            await expect.poll(() => order(writer)).toEqual([first, second])
        }
        const reader = await readerContext.newPage()
        await signIn(reader)
        await reader.goto(url)
        await expect.poll(() => order(reader)).toEqual([first, second])
    } finally {
        await peerContext.close()
        await readerContext.close()
    }
})

test('a peer index collision during the local debounce resolves after the local save', async ({ page }) => {
    const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
    const api = `/api/documents/${doc}/pages/${sheet}`
    await signIn(page)
    await page.goto(`/app/${doc}/${sheet}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    type Studio = Window & {
        __weftEditor: Editor
        __weftController: { debounce?: number; pendingShapeIds: Set<string>; flush(): Promise<void> }
    }
    const props = await page.evaluate(id => {
        const { __weftEditor: editor, __weftController: controller } = window as Studio
        editor.createShape({ id, type: 'geo', x: 120, y: 120, index: 'a3' as IndexKey })
        editor.store._flushHistory()
        clearTimeout(controller.debounce)
        if (!controller.pendingShapeIds.has(id)) throw new Error('Expected an unflushed local edit')
        return editor.getShapeUtil('geo').getDefaultProps()
    }, second)
    const actor = 'remote-browser'
    const op = Buffer.from(JSON.stringify({
        op: 'upsert-object', id: first, objType: 'geo', props, rendered: [],
        transform: { x: 120, y: 120, rotation: 0 }, browserIndex: 'a3', version: { ts: Date.now(), actor },
    })).toString('base64')
    const response = await page.request.post(api + '/ops', { headers: auth, data: { ops: [op], author: actor } })
    expect(response.ok()).toBe(true)
    await expect.poll(() => page.evaluate(id => (window as Studio).__weftEditor.getShape(id)?.index, first)).toBe('a3')
    expect(await page.evaluate(id => (window as Studio).__weftController.pendingShapeIds.has(id), second)).toBe(true)
    await page.evaluate(() => (window as Studio).__weftController.flush())
    await expect.poll(() => order(page)).toEqual([first, second])
    await expect.poll(() => page.evaluate(ids => {
        const editor = (window as Studio).__weftEditor
        return new Set(ids.map(id => editor.getShape(id)?.index)).size
    }, [first, second])).toBe(2)
})

for (const edit of ['delete', 'insert'] as const) {
    test(`a local ${edit} after an index tie keeps the same order on reopen`, async ({ page, browser, baseURL }) => {
        const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
        const url = `/app/${doc}/${sheet}`
        const api = `/api/documents/${doc}/pages/${sheet}`
        const actor = 'remote-browser'
        await signIn(page)
        await page.goto(url)
        await expect(page.getByTestId('sync-status')).toHaveText('synced')
        const props = await page.evaluate(() => (window as unknown as {
            __weftEditor: Editor
        }).__weftEditor.getShapeUtil('geo').getDefaultProps())
        const ops = [first, second].map(id => Buffer.from(JSON.stringify({
            op: 'upsert-object', id, objType: 'geo', props, rendered: [],
            transform: { x: 120, y: 120, rotation: 0 }, browserIndex: 'a3', version: { ts: Date.now() - 100, actor },
        })).toString('base64'))
        const response = await page.request.post(api + '/ops', { headers: auth, data: { ops, author: actor } })
        expect(response.ok()).toBe(true)
        const indexOf = (id: TLShapeId) => page.evaluate(shapeId => (window as unknown as {
            __weftEditor: Editor
        }).__weftEditor.getShape(shapeId)?.index, id)
        await expect.poll(() => order(page)).toEqual([first, second])
        await expect.poll(() => indexOf(second)).toMatch(/^a4/)
        await page.evaluate(({ edit, first, middle }) => {
            const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
            editor.markHistoryStoppingPoint(edit)
            if (edit === 'delete') editor.deleteShapes([first])
            else editor.createShape({ id: middle, type: 'geo', x: 120, y: 120, index: 'a3V' as IndexKey })
        }, { edit, first, middle })
        const expected = edit === 'delete' ? [second] : [first, middle, second]
        await expect.poll(() => order(page, [first, second, middle])).toEqual(expected)
        await expect.poll(async () => {
            const result = await page.request.get(api + '/overlay', { headers: auth })
            const { shapes } = await result.json()
            return shapes.some((shape: { shapeId: string }) => shape.shapeId === (edit === 'delete' ? first : middle))
        }).toBe(edit === 'insert')
        const reopened = await browser.newContext({ baseURL })
        try {
            const reader = await reopened.newPage()
            await signIn(reader)
            await reader.goto(url)
            await expect.poll(() => order(reader, [first, second, middle])).toEqual(expected)
            if (edit === 'delete') await expect.poll(() => indexOf(second)).toBe('a3')
        } finally {
            await reopened.close()
        }
    })
}

test('an insertion into a live tie survives a peer tie during debounce, Undo, Redo and reopen', async ({ page, browser, baseURL }) => {
    const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
    const url = `/app/${doc}/${sheet}`
    const api = `/api/documents/${doc}/pages/${sheet}`
    const outsider = 'shape:order-first-peer' as TLShapeId
    const ids = [first, second, middle, outsider]
    const actor = 'remote-browser'
    await signIn(page)
    await page.goto(url)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    type Studio = Window & {
        __weftEditor: Editor
        __weftController: { debounce?: number; flush(): Promise<void> }
    }
    const props = await page.evaluate(() => (window as Studio).__weftEditor.getShapeUtil('geo').getDefaultProps())
    // A remote clock can be ahead of this writer's wall clock.
    const ts = Date.now() + 60_000
    const publishTie = async (ids: TLShapeId[]) => {
        const ops = ids.map(id => Buffer.from(JSON.stringify({
            op: 'upsert-object', id, objType: 'geo', props, rendered: [],
            transform: { x: 100, y: 100, rotation: 0 }, browserIndex: 'a3', version: { ts, actor },
        })).toString('base64'))
        expect((await page.request.post(api + '/ops', { headers: auth, data: { ops, author: actor } })).ok()).toBe(true)
    }
    await publishTie([first, second])
    const expected = [first, outsider, middle, second]
    const context = await browser.newContext({ baseURL })
    try {
        const peer = await context.newPage()
        await signIn(peer)
        await peer.goto(url)
        await expect.poll(() => order(peer, ids)).toEqual([first, second])
        await expect.poll(() => order(page, ids)).toEqual([first, second])
        await page.evaluate(id => {
            const { __weftEditor: editor, __weftController: controller } = window as Studio
            editor.markHistoryStoppingPoint('insert between tied shapes')
            editor.createShape({ id, type: 'geo', x: 100, y: 100, index: 'a3V' as IndexKey })
            editor.store._flushHistory()
            clearTimeout(controller.debounce)
        }, middle)
        await publishTie([outsider])
        await expect.poll(() => order(page, ids)).toEqual(expected)
        await page.evaluate(() => (window as Studio).__weftController.flush())
        await expect.poll(() => order(peer, ids)).toEqual(expected)

        for (const step of ['undo', 'redo'] as const) {
            await page.evaluate(action => (window as Studio).__weftEditor[action](), step)
            const wanted = step === 'undo' ? [first, outsider, second] : expected
            await expect.poll(() => order(page, ids)).toEqual(wanted)
            await expect.poll(() => order(peer, ids)).toEqual(wanted)
        }
        const reader = await context.newPage()
        await signIn(reader)
        await reader.goto(url)
        await expect.poll(() => order(reader, ids)).toEqual(expected)
    } finally {
        await context.close()
    }
})

for (const scenario of ['peer clock ahead', 'legacy projection'] as const) {
    test(`an index-only reorder survives Undo and Redo without reprojecting native ink (${scenario})`, async ({ page, browser, baseURL }) => {
        const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
        const url = `/app/${doc}/${sheet}`
        const api = `/api/documents/${doc}/pages/${sheet}`
        // Keep the independent stale-projection sweep out of this legacy
        // order test. The normal follower still renders and publishes edits.
        const holdCachePrimary = async (writer: Page) => {
            const holder = await writer.context().newPage()
            await holder.goto('/library')
            await holder.evaluate(name => new Promise<void>(resolve => {
                void navigator.locks.request(name, () => {
                    resolve()
                    return new Promise<never>(() => {})
                })
            }), `weft-page:${doc}/${sheet}`)
        }
        if (scenario === 'legacy projection') await holdCachePrimary(page)
        await signIn(page)
        await page.goto(url)
        await expect(page.getByTestId('sync-status')).toHaveText('synced')
        await page.evaluate(([first, second]) => {
            const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
            editor.createShapes([{ id: first, type: 'geo', x: 80, y: 80 },
                { id: second, type: 'geo', x: 120, y: 120 }])
        }, [first, second])
        const accepted = async () =>
            (await (await page.request.get(api + '/overlay', { headers: auth })).json()).shapes
        await expect.poll(async () => (await accepted()).length).toBe(2)
        const seed = (await accepted()).find(shape => shape.shapeId === first)
        expect(seed.rendered.length).toBeGreaterThan(0)
        const version = { ts: scenario === 'peer clock ahead' ? Date.now() + 60_000 : seed.version.ts + 1, actor: 'remote-peer' }
        const source = Buffer.from(JSON.stringify({
            op: 'upsert-object', id: seed.shapeId, objType: seed.kind, props: seed.props, rendered: seed.rendered,
            transform: { x: seed.x, y: seed.y, rotation: seed.rotation }, browserIndex: seed.browserIndex, version,
            renderRevision: scenario === 'legacy projection' ? '' : seed.renderRevision,
        })).toString('base64')
        expect((await page.request.post(api + '/ops', { headers: auth, data: { ops: [source] } })).ok()).toBe(true)
        await expect.poll(() => page.evaluate(id => (window as unknown as {
            __weftController: { session: { currentOverlay: { shapes: { shapeId: string; version: { ts: number } }[] } } }
        }).__weftController.session.currentOverlay.shapes.find(shape => shape.shapeId === id)?.version.ts, first))
            .toBe(version.ts)
        const native = async () => (await page.request.get(api + '/rm', { headers: auth })).body()
        const original = await native()
        const context = await browser.newContext({ baseURL })
        try {
            const peer = await context.newPage()
            if (scenario === 'legacy projection') await holdCachePrimary(peer)
            await signIn(peer)
            await peer.goto(url)
            await expect.poll(() => order(peer)).toEqual([first, second])
            for (const action of ['move', 'undo', 'redo'] as const) {
                await page.evaluate(({ action, first }) => {
                    const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
                    if (action === 'move') {
                        editor.markHistoryStoppingPoint('only reorder')
                        editor.bringToFront([first])
                    } else editor[action]()
                }, { action, first })
                const expected = action === 'undo' ? [first, second] : [second, first]
                await expect.poll(() => order(page)).toEqual(expected)
                await expect.poll(() => order(peer)).toEqual(expected)
                const current = (await accepted()).find(shape => shape.shapeId === first)
                expect(current.version).toEqual(version)
                expect(current.rendered).toEqual(seed.rendered)
                expect(await native()).toEqual(original)
            }
            const reader = await context.newPage()
            await signIn(reader)
            await reader.goto(url)
            await expect.poll(() => order(reader)).toEqual([second, first])
        } finally {
            await context.close()
        }
    })
}

test('a peer root index cannot replace the local index of a grouped browser shape', async ({ page }) => {
    const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
    const api = `/api/documents/${doc}/pages/${sheet}`
    await signIn(page)
    await page.goto(`/app/${doc}/${sheet}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await page.evaluate(id => {
        const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
        editor.createShape({ id, type: 'geo', x: 90, y: 90 })
    }, first)
    const accepted = async () =>
        (await (await page.request.get(api + '/overlay', { headers: auth })).json()).shapes.find(shape => shape.shapeId === first)
    await expect.poll(accepted).toBeDefined()
    const group = 'shape:local-frame' as TLShapeId
    await page.evaluate(({ member, group }) => {
        const { __weftEditor: editor } = window as unknown as { __weftEditor: Editor }
        editor.createShape({ id: group, type: 'frame', props: { w: 300, h: 300 } })
        editor.reparentShapes([member], group)
        editor.store._flushHistory()
    }, { member: first, group })
    await page.evaluate(async () => {
        const session = (window as unknown as { __weftController: { flush(): Promise<void>; session: { reconcile(): Promise<void> } } })
            .__weftController
        await session.flush()
        await session.session.reconcile()
    })
    const read = () => page.evaluate(id => {
        const shape = (window as unknown as { __weftEditor: Editor }).__weftEditor.getShape(id)!
        return { parentId: shape.parentId, index: shape.index }
    }, first)
    const expected = await read()
    expect(expected.parentId).toBe(group)
    const current = await accepted()
    const browserIndex = 'a9'
    expect(expected.index).not.toBe(browserIndex)
    const remote = Buffer.from(JSON.stringify({
        op: 'upsert-object', id: first, objType: current.kind, props: current.props, rendered: current.rendered,
        transform: { x: current.x, y: current.y, rotation: current.rotation }, browserIndex,
        browserIndexVersion: { ts: Date.now() + 60_000, actor: 'remote-peer' }, version: current.version,
        renderRevision: current.renderRevision,
    })).toString('base64')
    expect((await page.request.post(api + '/ops', { headers: auth, data: { ops: [remote] } })).ok()).toBe(true)
    await expect.poll(() => page.evaluate(id => (window as unknown as {
        __weftController: { session: { currentOverlay: { shapes: { shapeId: string; browserIndex?: string }[] } } }
    }).__weftController.session.currentOverlay.shapes.find(shape => shape.shapeId === id)?.browserIndex, first))
        .toBe(browserIndex)
    expect(await read()).toEqual(expected)
})
