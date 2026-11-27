import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import type { Editor, TLShapeId } from 'tldraw'
import { eraseItemsInRm, type OverlayShapeJson } from './tablet-erase'

test.use({ serviceWorkers: 'block' })
const headers = { authorization: 'Bearer dev:e2e' }
const paragraph = (content: unknown[]) => ({ type: 'paragraph', content })
const word = (text: string, ...marks: string[]) => ({
    type: 'text', text,
    ...(marks.length ? { marks: marks.map((type) => type === 'link'
        ? { type, attrs: { href: 'https://example.com' } } : { type }) } : {}),
})

async function open(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('weft-server-url', location.origin)
        localStorage.setItem('weft-clerk-pk', '')
        localStorage.setItem('weft-dev-user', 'e2e')
    })
    const doc = crypto.randomUUID()
    const sheet = crypto.randomUUID()
    await page.goto(`/app/${doc}/${sheet}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 15_000 })
    return `/api/documents/${doc}/pages/${sheet}`
}

async function shapes(request: APIRequestContext, api: string) {
    const response = await request.get(api + '/overlay', { headers })
    if (!response.ok()) return []
    return ((await response.json()) as { shapes: OverlayShapeJson[] }).shapes
}

async function create(page: Page, shape: { id: string; type: string; props: object }) {
    await page.evaluate((data) => {
        const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
        editor.createShape({ ...data, id: data.id as TLShapeId, x: 85, y: 65 })
    }, shape)
}

test('mixed marks, headings, lists and wrapped spans reach native .rm as ink', async ({ page, request }) => {
    const api = await open(page)
    const richText = { type: 'doc', content: [
        { type: 'heading', attrs: { level: 2 }, content: [word('Title')] },
        paragraph([word('B', 'bold'), word('I', 'italic'), word('U', 'underline'), word('S', 'strike'),
            word('M', 'bold', 'italic', 'underline'), word('www', 'link'), word('C', 'code'), word('bold ink', 'highlight')]),
        { type: 'orderedList', attrs: { start: 3 }, content: [
            { type: 'listItem', content: [paragraph([word('Item')])] },
        ] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph([word('Last')])] }] },
    ] }
    await create(page, {
        id: 'shape:rich', type: 'text',
        props: { richText, font: 'serif', size: 'l', w: 145, autoSize: false },
    })
    await expect(page.locator('.tl-text-content strong').first()).toHaveText('B')
    await expect(page.locator('.tl-text-content a')).toHaveAttribute('href', 'https://example.com')
    const rendered = async () => (await shapes(request, api)).find((item) => item.shapeId === 'shape:rich')?.rendered ?? []
    await expect.poll(async () => (await rendered()).map((part) => part.partKey)).toContain('glyph:31')
    const parts = await rendered()
    expect(parts.filter((part) => part.partKey.startsWith('marker:'))).toHaveLength(2)
    expect(parts.filter((part) => part.partKey.startsWith('highlight:')).length).toBeGreaterThan(0)
    const { RmDocument, Pen, PenColor, crdtIdKey, crdtId } = await import('../packages/rm-format/src/index')
    const read = async () => {
        const response = await request.get(api + '/rm', { headers })
        expect(response.ok()).toBeTruthy()
        return RmDocument.parse(new Uint8Array(await response.body()))
    }
    const doc = await read()
    const table = new Map(Array.from(doc.authorTable(), ([index, uuid]) => [uuid, index]))
    const ink = (key: string) => {
        const ids = new Set(parts.find((item) => item.partKey === key)!.items.map((ref) =>
            crdtIdKey(crdtId(table.get(ref.authorUuid)!, ref.clock))))
        return doc.blocks.flatMap((b) => b.type === 'sceneLineItem' && ids.has(crdtIdKey(b.itemId)) ? [b.line] : [])
    }
    for (const key of ['glyph:8', 'glyph:9', 'glyph:10']) {
        expect(ink(key).some((line) => line?.points.length === 2 &&
            Math.abs(line.points[1]!.y - line.points[0]!.y) < 0.001)).toBeTruthy()
    }
    expect(ink('glyph:11').every((line) => line?.color === PenColor.BLUE)).toBeTruthy()
    const highlight = parts.find((part) => part.partKey.startsWith('highlight:'))!
    expect(ink(highlight.partKey)[0]?.tool).toBe(Pen.HIGHLIGHTER_2)
    await page.reload()
    await expect(page.locator('.tl-text-content mark')).toHaveText('bold ink')
    expect(await rendered()).toEqual(parts)
})

test('styled geometry labels sync; a missing face cannot commit a fallback', async ({ page, request }) => {
    const api = await open(page)
    const path = '**/fonts/projection/WeftOverlayMonoBoldItalic.woff'
    let attempted = 0
    await page.route(path, (route) => {
        attempted++
        return route.fulfill({ status: 503 })
    })
    const richText = { type: 'doc', content: [paragraph([word('R', 'bold', 'italic', 'underline')])] }
    await create(page, {
        id: 'shape:label', type: 'geo',
        props: { richText, geo: 'rectangle', w: 200, h: 110, font: 'mono', size: 'm' },
    })
    await expect(page.locator('.tl-text-content u')).toHaveText('R')
    await expect.poll(() => attempted).toBeGreaterThan(0)
    expect((await shapes(request, api)).find((item) => item.shapeId === 'shape:label')).toBeUndefined()
    await page.unroute(path)
    await expect.poll(async () => (await shapes(request, api)).find((item) => item.shapeId === 'shape:label')?.rendered.map((r) => r.partKey))
        .toContain('label:glyph:0')
})

async function localProjectionDraft(page: Page, id: string): Promise<string | null> {
    return page.evaluate(shapeId => new Promise<string | null>((resolve, reject) => {
        const openDb = indexedDB.open('weft', 1)
        openDb.onerror = () => reject(openDb.error)
        openDb.onsuccess = () => {
            const db = openDb.result
            const transaction = db.transaction('pages', 'readonly')
            let result: string | null = null
            const request = transaction.objectStore('pages').openCursor()
            request.onsuccess = () => {
                const cursor = request.result
                if (!cursor) return
                if (String(cursor.key).includes('/deferred/') &&
                    String(cursor.key).endsWith('/' + encodeURIComponent(shapeId))) {
                    result = new TextDecoder().decode(cursor.value)
                } else cursor.continue()
            }
            transaction.oncomplete = () => { db.close(); resolve(result) }
            transaction.onabort = () => { db.close(); reject(transaction.error) }
        }
    }), id)
}

test('styled native projection keeps an edit across reload with its face unavailable', async ({ page, request }) => {
    test.skip(process.env.WEFT_PROJECTION_JOURNAL_PROOF !== '1', 'requires the loopback-only projection-journal-test build')
    const api = await open(page)
    const path = '**/fonts/projection/WeftOverlayMonoBoldItalic.woff'
    let attempted = 0
    await page.route(path, route => {
        attempted++
        return route.fulfill({ status: 503 })
    })
    await create(page, {
        id: 'shape:pending-label', type: 'geo', props: {
            richText: { type: 'doc', content: [paragraph([word('draft', 'bold', 'italic', 'underline')])] },
            geo: 'rectangle', w: 200, h: 110, font: 'mono', size: 'm',
        },
    })
    await expect.poll(() => attempted).toBeGreaterThan(0)
    await page.evaluate(richText => {
        const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
        editor.updateShape({ id: 'shape:pending-label' as TLShapeId, type: 'geo', props: { richText } })
        editor.store._flushHistory()
    }, { type: 'doc', content: [paragraph([word('latest draft', 'bold', 'italic', 'underline')])] })
    await expect(page.locator('.tl-text-content u')).toHaveText('latest draft')
    await expect.poll(() => localProjectionDraft(page, 'shape:pending-label')).toContain('latest draft')
    const serverShape = async () => (await shapes(request, api)).find((item) => item.shapeId === 'shape:pending-label')
    expect(await serverShape()).toBeUndefined()
    await page.reload()
    await expect(page.locator('.tl-text-content u')).toHaveText('latest draft')
    expect(await serverShape()).toBeUndefined()
    await page.unroute(path)
    await expect.poll(async () => (await serverShape())?.rendered.map((part) => part.partKey))
        .toContain('label:glyph:0')
    expect(await localProjectionDraft(page, 'shape:pending-label')).toBeNull()
    await page.reload()
    await expect(page.locator('.tl-text-content u')).toHaveText('latest draft')
})

test('a peer winner prevents delayed native projection from publishing a stale draft', async ({ page, request, browser }) => {
    test.skip(process.env.WEFT_PROJECTION_JOURNAL_PROOF !== '1', 'requires the loopback-only projection-journal-test build')
    const api = await open(page)
    const path = '**/fonts/projection/WeftOverlayMonoBoldItalic.woff'
    let attempted = 0
    let releaseFont!: () => void
    const fontGate = new Promise<void>(resolve => { releaseFont = resolve })
    await page.route(path, async route => {
        attempted++
        await fontGate
        return route.continue()
    })
    const label = (text: string, marks: string[] = []) => ({
        id: 'shape:conflicting-label', type: 'geo', props: {
            richText: { type: 'doc', content: [paragraph([word(text, ...marks)])] },
            geo: 'rectangle', w: 200, h: 110, font: 'mono', size: 'm',
        },
    })
    await create(page, label('stale draft', ['bold', 'italic', 'underline']))
    await expect.poll(() => attempted).toBeGreaterThan(0)
    const serverShape = async () => (await shapes(request, api)).find(item => item.shapeId === 'shape:conflicting-label')
    expect(await serverShape()).toBeUndefined()

    const peer = await browser.newPage({ serviceWorkers: 'block' })
    try {
        await peer.addInitScript(() => {
            localStorage.setItem('weft-server-url', location.origin)
            localStorage.setItem('weft-clerk-pk', '')
            localStorage.setItem('weft-dev-user', 'e2e')
        })
        await peer.goto(page.url())
        await expect(peer.getByTestId('sync-status')).toHaveText('synced', { timeout: 15_000 })
        await create(peer, label('peer winner'))
        await expect.poll(async () => (await serverShape())?.rendered.length ?? 0).toBeGreaterThan(0)
        const before = await serverShape()
        await create(peer, { ...label('peer update reached writer'), id: 'shape:peer-marker' })
        await expect(page.getByTestId('canvas').getByText('peer update reached writer', { exact: true })).toBeVisible()
        // The peer state is known, but the original unprojected draft still
        // owns its editor record. Another keystroke must not rebase that record
        // on top of the peer winner.
        await expect(page.getByTestId('canvas').getByText('stale draft', { exact: true })).toBeVisible()
        await page.evaluate(({ id, props }) => {
            const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
            editor.updateShape({ id: id as TLShapeId, type: 'geo', props })
            editor.store._flushHistory()
        }, label('stale draft after peer', ['bold', 'italic', 'underline']))
        await expect.poll(() => localProjectionDraft(page, 'shape:conflicting-label')).toContain('stale draft after peer')
        releaseFont()
        await expect(page.getByTestId('canvas').getByText('peer winner', { exact: true })).toBeVisible()
        expect(await serverShape()).toEqual(before)
        await expect(page.getByTestId('sync-status')).toHaveText('sync problem')
        await page.getByTestId('sync-status').click()
        const downloaded = page.waitForEvent('download')
        await page.getByRole('button', { name: 'Download text draft' }).click()
        const saved = await downloaded
        const path = await saved.path()
        expect(path).not.toBeNull()
        const { readFile } = await import('node:fs/promises')
        const json = await readFile(path!, 'utf8')
        expect(json).toContain('stale draft after peer')
        expect(json).not.toContain('peer winner')
    } finally {
        releaseFont()
        await peer.close()
    }
})

test('a scoped editor preserves unowned legacy queue bytes without taking them over', async ({ page, request }) => {
    test.skip(process.env.WEFT_PROJECTION_JOURNAL_PROOF !== '1', 'requires the loopback-only projection-journal-test build')
    const doc = crypto.randomUUID()
    const sheet = crypto.randomUUID()
    const key = `page/${doc}/${sheet}/pending/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa`
    await page.addInitScript(() => {
        localStorage.setItem('weft-server-url', location.origin)
        localStorage.setItem('weft-clerk-pk', '')
        localStorage.setItem('weft-dev-user', 'e2e')
    })
    await page.goto('/')
    const legacy = (mode: 'set' | 'get') => page.evaluate(({ key, mode }) => new Promise<string>((resolve, reject) => {
        const open = indexedDB.open('weft', 1)
        open.onupgradeneeded = () => open.result.createObjectStore('pages')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
            const db = open.result
            const tx = db.transaction('pages', mode === 'set' ? 'readwrite' : 'readonly')
            const store = tx.objectStore('pages')
            const pending = mode === 'set'
                ? store.put(new TextEncoder().encode('unattributed legacy payload'), key) : store.get(key)
            tx.onabort = () => { db.close(); reject(tx.error) }
            tx.oncomplete = () => { db.close(); resolve(mode === 'set' ? '' : new TextDecoder().decode(pending.result)) }
        }
    }), { key, mode })
    await legacy('set')
    await page.goto(`/app/${doc}/${sheet}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 15_000 })
    await page.getByTestId('sync-status').click()
    await expect(page.getByTestId('sync-panel')).toContainText("couldn’t verify their account")
    expect(await legacy('get')).toEqual('unattributed legacy payload')
    expect(await shapes(request, `/api/documents/${doc}/pages/${sheet}`)).toEqual([])
})

test('sticky-note and arrow labels keep their styled ink on the shape after reload', async ({ page, request }) => {
    const api = await open(page)
    const richText = { type: 'doc', content: [paragraph([word('AB', 'bold'), word('CD', 'italic', 'underline')])] }
    await create(page, {
        id: 'shape:styled-note', type: 'note', props: { richText, font: 'draw', size: 'm' },
    })
    await create(page, {
        id: 'shape:styled-arrow', type: 'arrow', props: {
            richText, font: 'sans', size: 'm', start: { x: 5, y: 260 }, end: { x: 366, y: 292 },
        },
    })
    const labelParts = async () => {
        const overlay = await shapes(request, api)
        return ['shape:styled-note', 'shape:styled-arrow'].map((id) =>
            overlay.find((shape) => shape.shapeId === id)?.rendered.filter((part) => part.partKey.startsWith('label:')) ?? [])
    }
    await expect.poll(async () => (await labelParts()).map((parts) => parts.map((part) => part.partKey)))
        .toEqual(Array.from({ length: 2 }, () => ['label:glyph:0', 'label:glyph:1', 'label:glyph:2', 'label:glyph:3']))
    const before = await labelParts()
    await page.reload()
    await expect(page.locator('.tl-text-content u')).toHaveCount(2)
    expect(await labelParts()).toEqual(before)
})

test('a genuine sole hard break does not shift the tablet erase target', async ({ page, request }) => {
    const api = await open(page)
    await create(page, {
        id: 'shape:breaks', type: 'text', props: {
            richText: { type: 'doc', content: [paragraph([]), paragraph([{ type: 'hardBreak' }]),
                paragraph([word('BC', 'bold')])] },
            size: 'l', font: 'sans',
        },
    })
    const find = async () => (await shapes(request, api)).find((item) => item.shapeId === 'shape:breaks')
    await expect.poll(async () => (await find())?.rendered.map((item) => item.partKey)).toEqual(['glyph:3', 'glyph:4'])
    const tail = (await find())!.rendered[1]!
    const pair = await request.post('/api/pair', { headers, data: { label: 'rich text erase test' } })
    const { token } = await pair.json() as { token: string }
    const current = await request.get(api + '/rm', { headers })
    const bytes = await eraseItemsInRm(new Uint8Array(await current.body()), tail.items)
    const erased = await request.put(api + '/rm', {
        headers: { 'x-device-token': token, 'x-base-revision': current.headers()['x-rm-revision']!,
            'content-type': 'application/octet-stream' },
        data: Buffer.from(bytes),
    })
    expect(erased.ok()).toBeTruthy()
    await expect(page.locator('.tl-text-content strong')).toHaveText('B')
    await expect.poll(async () => (await find())?.rendered.map((item) => item.partKey)).toEqual(['glyph:3'])
})

test('a transient layout failure holds the whole labelled shape until it can retry', async ({ page, request }) => {
    const api = await open(page)
    await page.evaluate(() => {
        const proto = HTMLCanvasElement.prototype
        const original = proto.getContext
        const w = window as unknown as { restoreProjectionContext: () => void; layoutAttempts: number }
        w.layoutAttempts = 0
        proto.getContext = function(...args: Parameters<typeof original>) {
            if (args[0] === '2d' && !this.isConnected) {
                w.layoutAttempts++
                return null
            }
            return Reflect.apply(original, this, args)
        } as typeof original
        w.restoreProjectionContext = () => { proto.getContext = original }
    })
    await create(page, {
        id: 'shape:layout-retry', type: 'geo', props: { w: 240, h: 140,
            richText: { type: 'doc', content: [paragraph([word('R', 'underline')])] } },
    })
    await expect.poll(() => page.evaluate(() => (window as unknown as { layoutAttempts: number }).layoutAttempts))
        .toBeGreaterThan(0)
    const find = async () => (await shapes(request, api)).find((item) => item.shapeId === 'shape:layout-retry')
    expect(await find()).toBeUndefined()
    await page.evaluate(() => (window as unknown as { restoreProjectionContext: () => void }).restoreProjectionContext())
    await expect.poll(async () => (await find())?.rendered.map((item) => item.partKey)).toContain('label:glyph:0')
})
