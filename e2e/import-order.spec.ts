import { readFile } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import type { Editor, TLShapeId } from 'tldraw'
import { useCloudMode } from './cloud-mode'
import { devicePut, deviceToken, inkRm } from './device-blob'

useCloudMode()

const DOC = '11111111-1111-4111-a111-111111111111'
const AUTHOR = 'aaaaaaaa-0000-4000-a000-000000000001'

async function nativeStack(page: Page) {
    const { RM_SCALE } = await import('../packages/rm-ink/src/pen')
    return page.evaluate((scale) => {
        const { __weftEditor: editor } = window as unknown as { __weftEditor?: Editor }
        return editor?.getCurrentPageShapesSorted().filter(shape => shape.meta.rmBrush)
            .map(({ id, type, x, index, opacity, parentId }) => ({ id, type, x: Math.round(x / scale), index, opacity, parentId })) ?? []
    }, RM_SCALE)
}

async function mixedScene(request: APIRequestContext, sheet: string) {
    const { RmDocument, crdtId, lww, uuidToBytesLE } = await import('../packages/rm-format/src/index')
    const uuid = crypto.randomUUID()
    const filename = `${uuid}.png`
    const endpoint = `/api/documents/${DOC}/pages/${sheet}`
    const seed = RmDocument.parse(await inkRm(1) as never)
    const first = seed.blocks.find(block => block.type === 'sceneLineItem')!
    seed.blocks.push({
        type: 'sceneImageInfo', version: { min: 3, current: 3 }, extraData: new Uint8Array(),
        images: [{ uuid, filename: lww(crdtId(1, 50), filename), flags: lww(crdtId(1, 51), new Uint8Array([17, 0])) }],
    })
    seed.appendImage({
        kind: 'image', uuid: lww(crdtId(1, 52), uuidToBytesLE(uuid)), timestamp: crdtId(0, 0),
        vertices: [20, 20, 0, 0, 120, 20, 1, 0, 120, 120, 1, 1, 20, 120, 0, 1],
        indices: [0, 1, 2, 2, 3, 0], filename: null,
    }, { authorUuid: AUTHOR })
    const line = first.line!
    seed.appendLine({ ...line, points: line.points.map(point => ({ ...point, x: point.x + 20 })) }, { authorUuid: AUTHOR })
    expect((await request.put(`${endpoint}/assets/${filename}`, { data: await readFile('fixtures/test-photo.png') })).ok()).toBe(true)
    return seed
}

test('opening a mixed native scene paints the photo between its two strokes', async ({ page, request }) => {
    const sheet = crypto.randomUUID()
    const seed = await mixedScene(request, sheet)
    await devicePut(await deviceToken(), DOC, sheet, seed.serialize())
    await page.goto(`/app/${DOC}/${sheet}`)
    const paintOrder = async () => (await nativeStack(page)).map(({ type, x }) => [type, x])
    const expected = [['draw', 10], ['image', 20], ['draw', 30]]
    await expect.poll(paintOrder).toEqual(expected)
    await page.reload()
    await expect.poll(paintOrder).toEqual(expected)
})

test('a live lower-layer stroke keeps the existing visible stack and indices', async ({ page, request }) => {
    const { RmDocument } = await import('../packages/rm-format/src/index')
    const sheet = crypto.randomUUID()
    const endpoint = `/api/documents/${DOC}/pages/${sheet}/rm`
    const seed = RmDocument.parse(await inkRm(1) as never)
    const lower = seed.layers()[0]!.nodeId
    seed.setLayerVisible(lower, false, { authorUuid: AUTHOR })
    const upper = seed.createLayer('Above', { authorUuid: AUTHOR })
    const line = seed.blocks.find(block => block.type === 'sceneLineItem')!.line!
    seed.appendLine({ ...line, points: line.points.map(point => ({ ...point, x: point.x + 30 })) }, { authorUuid: AUTHOR, parentId: upper })
    const token = await deviceToken()
    await devicePut(token, DOC, sheet, seed.serialize())
    await page.goto(`/app/${DOC}/${sheet}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const [bottom, top] = await nativeStack(page)
    expect([bottom?.x, top?.x]).toEqual([10, 40])
    expect(bottom?.opacity).toBe(0)

    const overlayId = 'shape:000-overlay' as TLShapeId
    await page.evaluate((overlayId) => {
        const { __weftEditor: editor } = window as unknown as { __weftEditor: Editor }
        editor.createShape({ id: overlayId, type: 'geo', x: 20, y: 100, props: { w: 100, h: 100 } })
    }, overlayId)
    await expect.poll(async () => {
        const response = await request.get(`/api/documents/${DOC}/pages/${sheet}/overlay`)
        return (await response.json()).shapes.some((shape: { shapeId: string }) => shape.shapeId === overlayId)
    }).toBe(true)
    await page.evaluate(({ overlayId, top }) => {
        const { __weftEditor: editor } = window as unknown as { __weftEditor: Editor }
        editor.store.mergeRemoteChanges(() => {
            editor.updateShape({ id: overlayId, type: 'geo', index: top.index })
            editor.createShape({ type: 'frame', x: 0, y: 0, props: { w: 150, h: 150 } })
        })
        editor.select(top.id)
    }, { overlayId, top: top! })

    const response = await request.get(endpoint)
    const current = RmDocument.parse(new Uint8Array(await response.body()) as never)
    current.appendLine({ ...line, points: line.points.map(point => ({ ...point, x: point.x + 10 })) }, { authorUuid: AUTHOR, parentId: lower })
    await devicePut(token, DOC, sheet, current.serialize(), response.headers()['x-rm-revision'])

    await expect.poll(async () => (await nativeStack(page)).map(s => s.x)).toEqual([10, 20, 40])
    const [existingBottom, added, existingTop] = await nativeStack(page)
    expect(existingBottom).toEqual(bottom)
    expect(existingTop).toEqual(top)
    expect(added!.opacity).toBe(0)
    expect(added!.parentId).toBe(top!.parentId)
    const state = await page.evaluate(overlayId => {
        const { __weftEditor: editor } = window as unknown as { __weftEditor: Editor }
        return { overlayIndex: editor.getShape(overlayId)?.index, selected: editor.getSelectedShapeIds() }
    }, overlayId)
    expect(state).toEqual({ overlayIndex: top!.index, selected: [top!.id] })
})

test('a full page still admits photos that fit and retries skipped imports when room opens', async ({ page, request }) => {
    const { RmDocument, crdtId, lww, uuidToBytesLE } = await import('../packages/rm-format/src/index')
    const sheet = crypto.randomUUID()
    const endpoint = `/api/documents/${DOC}/pages/${sheet}/rm`
    const seed = await mixedScene(request, sheet)
    const photo = seed.blocks.find(block => block.type === 'sceneImageItem')!.image!
    const skippedUuid = crypto.randomUUID()
    const skippedFilename = `${skippedUuid}.png`
    const info = seed.blocks.find(block => block.type === 'sceneImageInfo')!
    info.images.push({ ...info.images[0]!, uuid: skippedUuid, filename: lww(crdtId(1, 1000), skippedFilename) })
    seed.appendImage({ ...photo, uuid: lww(crdtId(1, 1001), uuidToBytesLE(skippedUuid)), vertices: photo.vertices.map((v, i) => i % 4 === 0 ? v + 20 : v) }, { authorUuid: AUTHOR })
    expect((await request.put(`/api/documents/${DOC}/pages/${sheet}/assets/${skippedFilename}`, { data: await readFile('fixtures/test-photo.png') })).ok()).toBe(true)
    let skippedPhotoRequests = 0
    await page.route(`**/assets/${skippedFilename}`, route => {
        skippedPhotoRequests++
        return route.continue()
    })
    const token = await deviceToken()
    await devicePut(token, DOC, sheet, RmDocument.empty(AUTHOR).serialize())
    await page.goto(`/app/${DOC}/${sheet}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const filler = Array.from({ length: 4 }, (_, i) => `shape:filler-${i}` as TLShapeId)
    await page.evaluate(filler => {
        const { __weftEditor: editor } = window as unknown as { __weftEditor: Editor }
        Object.defineProperty(editor.options, 'maxShapesPerPage', { value: 5 })
        editor.store.mergeRemoteChanges(() => editor.createShapes(filler.map(id => ({ id, type: 'geo' }))))
    }, filler)
    const revision = async () => (await request.get(endpoint)).headers()['x-rm-revision']
    await devicePut(token, DOC, sheet, seed.serialize(), await revision())
    const paintOrder = async () => (await nativeStack(page)).map(({ type, x }) => [type, x])
    await expect.poll(paintOrder).toEqual([['image', 20]])
    const firstPhoto = (await nativeStack(page))[0]!
    expect(skippedPhotoRequests).toBe(0)

    await page.evaluate(filler => {
        const { __weftEditor: editor } = window as unknown as { __weftEditor: Editor }
        editor.store.mergeRemoteChanges(() => editor.deleteShapes(filler))
    }, filler)
    const line = seed.blocks.find(block => block.type === 'sceneLineItem')!.line!
    seed.appendLine({ ...line, points: line.points.map(point => ({ ...point, x: point.x + 40 })) }, { authorUuid: AUTHOR })
    await devicePut(token, DOC, sheet, seed.serialize(), await revision())
    await expect.poll(paintOrder).toEqual([['draw', 10], ['image', 20], ['draw', 30], ['image', 40], ['draw', 50]])
    expect((await nativeStack(page))[1]).toEqual(firstPhoto)
    await expect.poll(() => skippedPhotoRequests).toBe(1)
})
