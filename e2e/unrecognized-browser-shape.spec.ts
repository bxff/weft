import { expect, test } from '@playwright/test'
import type { Editor, TLShapeId } from 'tldraw'
import { readFile } from 'node:fs/promises'
import { RmDocument } from '../packages/rm-format/src/index'
import { encodeSnapshot } from '../packages/sync-engine/src/snapshot'
import { inkRm } from './device-blob'
import { useCloudMode } from './cloud-mode'

useCloudMode()

const futureId = 'shape:unrecognized-editor-kind' as TLShapeId
const knownId = 'shape:readable-editor-kind' as TLShapeId
type StudioWindow = Window & {
    __weftEditor?: Editor
    __weftController?: { session: { reconcile(): Promise<void> } }
}

test('a future browser shape does not prevent reading and exporting the rest of the page', async ({ page }) => {
    const doc = crypto.randomUUID()
    const sheet = crypto.randomUUID()
    await page.goto(`/app/${doc}/${crypto.randomUUID()}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const props = await page.evaluate(() => (window as StudioWindow).__weftEditor!.getShapeUtil('geo').getDefaultProps())
    const futureProps = { example: 'retained source data' }
    const rows = [
        { id: futureId, type: 'future-editor-kind', props: futureProps },
        { id: knownId, type: 'geo', props },
    ].map(({ id, type, props }, i) => ({
        seq: i + 1,
        ts: 1,
        author: 'web',
        op: Buffer.from(JSON.stringify({
            op: 'upsert-object', id, objType: type, props,
            transform: { x: 50 + i * 100, y: 60, rotation: 0 },
            rendered: [], version: { ts: 1, actor: 'fixture-writer' },
        })).toString('base64'),
    }))
    await page.route(url => url.pathname.endsWith(`/${sheet}/ops`), route => {
        const since = Number(new URL(route.request().url()).searchParams.get('since') ?? 0)
        return route.fulfill({ json: { head: rows.length, ops: rows.filter(row => row.seq > since) } })
    })

    const shapeTypes = () => page.evaluate(([known, future]) => {
        const editor = (window as StudioWindow).__weftEditor
        return [editor?.getShape(known)?.type ?? null, editor?.getShape(future)?.type ?? null]
    }, [knownId, futureId] as const)
    await page.goto(`/app/${doc}/${sheet}`)
    await expect.poll(shapeTypes).toEqual(['geo', null])
    const status = page.getByTestId('sync-status')
    await expect(status).toHaveText('synced')
    await status.click()
    const [download] = await Promise.all([
        page.waitForEvent('download'), page.getByRole('button', { name: 'Download shape records' }).click(),
    ])
    const payload = JSON.parse(await readFile((await download.path())!, 'utf8'))
    expect(payload).toEqual({ shapes: [{
        shapeId: futureId, kind: 'future-editor-kind', props: futureProps,
        x: 50, y: 60, rotation: 0, rendered: [], renderRevision: '', state: 'live',
        version: { ts: 1, actor: 'fixture-writer' },
    }] })
    await page.reload()
    await expect.poll(shapeTypes).toEqual(['geo', null])
})


test('a live unsupported replacement removes a locked overlay and displays its tablet ink', async ({ page }) => {
    const doc = crypto.randomUUID()
    const sheet = crypto.randomUUID()
    await page.goto(`/app/${doc}/${crypto.randomUUID()}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const props = await page.evaluate(() => (window as StudioWindow).__weftEditor!.getShapeUtil('geo').getDefaultProps())
    const bytes = await inkRm(1)
    const drawing = RmDocument.parse(bytes)
    const line = drawing.blocks.find(block => block.type === 'sceneLineItem' && block.line)
    if (!line || line.type !== 'sceneLineItem') throw new Error('Missing source stroke')
    const authorUuid = drawing.authorTable().get(line.itemId.part1)!
    const rendered = [{ partKey: 'whole', items: [{ authorUuid, clock: line.itemId.part2 }] }]
    const checkpoint = encodeSnapshot(bytes, { shapes: [{
        shapeId: knownId, kind: 'geo', props, x: 50, y: 60, rotation: 0, rendered,
        version: { ts: 1, actor: 'fixture-writer' }, state: 'live', renderRevision: '',
    }] })
    await page.route(url => url.pathname.endsWith(`/${sheet}/snapshot`), route => {
        if (route.request().headers()['x-if-snapshot-seq-gt'] === '1') return route.fulfill({ status: 304 })
        return route.fulfill({
            contentType: 'application/octet-stream', headers: { 'x-snapshot-seq': '1', 'x-snapshot-op-seq': '1' },
            body: Buffer.from(checkpoint),
        })
    })
    const rows: { seq: number; ts: number; op: string; author: string }[] = []
    const publish = (type: string, shapeProps: unknown) => {
        const seq = rows.length + 2
        const op = {
            op: 'upsert-object', id: knownId, objType: type, props: shapeProps,
            transform: { x: 50, y: 60, rotation: 0 }, rendered, version: { ts: seq, actor: 'fixture-writer' },
        }
        rows.push({ seq, ts: seq, author: 'web', op: Buffer.from(JSON.stringify(op)).toString('base64') })
    }
    await page.route(url => url.pathname.endsWith(`/${sheet}/ops`), route => {
        const since = Number(new URL(route.request().url()).searchParams.get('since') ?? 0)
        return route.fulfill({ json: { head: rows.length + 1, ops: rows.filter(row => row.seq > since) } })
    })
    await page.goto(`/app/${doc}/${sheet}`)
    const visible = () => page.evaluate(id => {
        const editor = (window as StudioWindow).__weftEditor
        return [
            editor?.getShape(id)?.type ?? null,
            editor?.getCurrentPageShapes().filter(shape => shape.meta.rmBrush).length ?? 0,
        ]
    }, knownId)
    await expect.poll(visible).toEqual(['geo', 0])
    await page.evaluate(id => {
        const editor = (window as StudioWindow).__weftEditor!
        editor.store.mergeRemoteChanges(() => editor.updateShape({ id, type: 'geo', isLocked: true }))
    }, knownId)
    const reconcile = () => page.evaluate(() => (window as StudioWindow).__weftController!.session.reconcile())
    publish('future-editor-kind', { example: 'new source' })
    await reconcile()
    await expect.poll(visible).toEqual([null, 1])
    await page.reload()
    await expect.poll(visible).toEqual([null, 1])
    publish('geo', props)
    await reconcile()
    await expect.poll(visible).toEqual(['geo', 0])
})

test('an incompatible saved shape leaves neighboring shapes readable and editable', async ({ page, request }) => {
    const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
    await page.goto(`/app/${doc}/${crypto.randomUUID()}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const props = await page.evaluate(() => {
        const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
        return editor.getShapeUtil('geo').getDefaultProps()
    })
    const author = 'aaaaaaaa-0000-4000-a000-000000000001'
    const rm = RmDocument.empty(author).serialize()
    const base = { x: 100, y: 140, rotation: 0, version: { ts: 1, actor: author }, state: 'live' as const,
        rendered: [], renderRevision: '' }
    const valid = { ...base, shapeId: 'shape:valid-neighbor', kind: 'geo' as const, props }
    const invalid = { ...base, shapeId: 'shape:unreadable-geo', kind: 'geo' as const, props: { ...props, w: 'invalid' } }
    const endpoint = `/api/documents/${doc}/pages/${sheet}`
    const publish = (shapes: Parameters<typeof encodeSnapshot>[1]['shapes']) =>
        request.put(`${endpoint}/snapshot`, {
            headers: { 'content-type': 'application/octet-stream' },
            data: Buffer.from(encodeSnapshot(rm, { shapes })),
        })
    expect((await publish([invalid, valid])).ok()).toBe(true)
    const path = `/app/${doc}/${sheet}`
    await page.goto(path)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await expect.poll(() => page.evaluate(ids => {
        const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
        return ids.map(id => editor.getShape(id as TLShapeId)?.type ?? null)
    }, [invalid.shapeId, valid.shapeId])).toEqual([null, 'geo'])
    await page.getByTestId('sync-status').click()
    const [download] = await Promise.all([
        page.waitForEvent('download'), page.getByRole('button', { name: 'Download shape records' }).click(),
    ])
    const data = JSON.parse(await readFile((await download.path())!, 'utf8'))
    expect(data).toEqual({ shapes: [invalid] })
    await page.evaluate(id => {
        (window as StudioWindow).__weftEditor!.updateShape({ id: id as TLShapeId, type: 'geo', x: 415 })
    }, valid.shapeId)
    const readShapes = async () => {
        const response = await request.get(`${endpoint}/overlay`)
        expect(response.ok()).toBe(true)
        return (await response.json() as { shapes: (typeof valid)[] }).shapes
    }
    await expect.poll(async () => (await readShapes()).find(shape => shape.shapeId === valid.shapeId)?.x).toBe(415)
    expect((await readShapes()).filter(shape => shape.shapeId !== valid.shapeId)).toEqual([invalid])
    await page.reload()
    await expect.poll(() => page.evaluate(id =>
        (window as StudioWindow).__weftEditor?.getShape(id as TLShapeId)?.x, valid.shapeId)).toBe(415)
})

test('a non-string saved shape ID does not prevent opening the notebook', async ({ page, request }) => {
    const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
    await page.goto(`/app/${doc}/${crypto.randomUUID()}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const props = await page.evaluate(() => (window as StudioWindow).__weftEditor!.getShapeUtil('geo').getDefaultProps())
    const common = { x: 50, y: 60, rotation: 0, props, kind: 'geo' as const, rendered: [], renderRevision: '',
        state: 'live' as const, version: { ts: 1, actor: 'fixture-writer' } }
    const bad = { ...common, shapeId: 123 }
    const snapshot = encodeSnapshot(await inkRm(1), {
        shapes: [bad as unknown as typeof common & { shapeId: string }, { ...common, shapeId: knownId }],
    })
    const endpoint = `/api/documents/${doc}/pages/${sheet}`
    expect((await request.put(endpoint + '/snapshot', {
        headers: { 'content-type': 'application/octet-stream' }, data: Buffer.from(snapshot),
    })).ok()).toBe(true)
    await page.goto(`/app/${doc}/${sheet}`)
    await expect.poll(() => page.evaluate(id => (window as StudioWindow).__weftEditor?.getShape(id)?.type, knownId)).toBe('geo')
})

test('a live unreadable overlay cannot remove the tablet text column', async ({ page, request }) => {
    const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
    const { createRootText, insertText } = await import('../packages/rm-format/src/index')
    const drawing = RmDocument.parse(await inkRm(1))
    createRootText(drawing, {})
    insertText(drawing, null, 'Tablet text', { authorUuid: 'aaaaaaaa-0000-4000-a000-000000000001' })
    const endpoint = `/api/documents/${doc}/pages/${sheet}`
    expect((await request.put(endpoint + '/snapshot', {
        headers: { 'content-type': 'application/octet-stream' },
        data: Buffer.from(encodeSnapshot(drawing.serialize(), { shapes: [] })),
    })).ok()).toBe(true)
    await page.goto(`/app/${doc}/${sheet}`)
    const id = 'shape:device-text' as TLShapeId
    const kind = () => page.evaluate(id => (window as StudioWindow).__weftEditor?.getShape(id)?.type, id)
    await expect.poll(kind).toBe('device-text')
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await page.evaluate(id => {
        const studio = window as StudioWindow & { textDeletes: number }
        studio.textDeletes = 0
        studio.__weftEditor!.sideEffects.registerBeforeDeleteHandler('shape', shape => {
            if (shape.id === id) studio.textDeletes++
        })
    }, id)
    const op = Buffer.from(JSON.stringify({
        op: 'upsert-object', id, objType: 'geo', props: { w: 'bad' },
        transform: { x: 10, y: 20, rotation: 0 }, rendered: [],
        version: { ts: Date.now(), actor: 'fixture-writer' },
    })).toString('base64')
    expect((await request.post(endpoint + '/ops', { data: { ops: [op], author: 'fixture-writer' } })).ok()).toBe(true)
    await page.evaluate(() => (window as StudioWindow).__weftController!.session.reconcile())
    expect(await kind()).toBe('device-text')
    expect(await page.evaluate(() => (window as Window & { textDeletes: number }).textDeletes)).toBe(0)
})
