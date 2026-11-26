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
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
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
