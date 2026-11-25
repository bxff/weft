import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import type { Editor, TLDrawShape, TLShapeId } from 'tldraw'
import type { StudioController } from '../apps/web/src/lib/tldraw/controller'
import { useCloudMode } from './cloud-mode'
import { anchoredReflowPushes } from './device-blob'

useCloudMode()

const DOC = '11111111-1111-4111-a111-111111111111'
const DRAFT = 'shape:draft' as TLShapeId
const DEVICE_AUTHOR = 'aaaaaaaa-0000-4000-a000-000000000001'

declare global {
    interface Window {
        releaseDeviceFonts(): void
        textLayoutProbe: {
            before: TLDrawShape
            counts: { created: number; deleted: number; updated: number }
            elapsed: number
        }
    }
}

async function delayDeviceFonts(page: Page, changeGlyphWidth = false) {
    await page.addInitScript((changeGlyphWidth) => {
        const fonts = document.fonts
        const check = fonts.check.bind(fonts)
        const load = fonts.load.bind(fonts)
        let release!: () => void
        const wait = new Promise<void>((resolve) => { release = resolve })
        let settled = false
        window.releaseDeviceFonts = () => {
            settled = true
            release()
        }
        if (changeGlyphWidth) {
            const measureText = CanvasRenderingContext2D.prototype.measureText
            CanvasRenderingContext2D.prototype.measureText = function (text) {
                const metrics = measureText.call(this, text)
                if (text === '漢' && this.font.includes('RM Noto Sans')) {
                    Object.defineProperty(metrics, 'width', { value: settled ? 320 : 5 })
                }
                return metrics
            }
        }
        fonts.check = (font, text) => !font.includes("'RM ") && check(font, text)
        fonts.load = async (font, text) => {
            if (!font.includes("'RM ")) return load(font, text)
            await wait
            return [] // deterministic, including CI without device font files
        }
    }, changeGlyphWidth)
}

async function appendToDeviceText(page: Page, text: string) {
    await page.evaluate(async (text) => {
        const { __weftController: controller } = window as unknown as {
            __weftController: StudioController
        }
        const last = controller.rootTextPositions().at(-1)!
        await controller.editRootText({ inserts: [{ afterKey: last.key, text }] })
    }, text)
}

test('font completion keeps the dense ink scene, selection and unfinished stroke', async ({ page, request }) => {
    const id = crypto.randomUUID()
    const bytes = await readFile('fixtures/mako-p1.rm')
    const uploaded = await request.put(`/api/documents/${DOC}/pages/${id}/rm`, { data: bytes })
    expect(uploaded.ok()).toBe(true)
    await delayDeviceFonts(page)
    await page.goto(`/app/${DOC}/${id}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30_000 })

    await page.evaluate((draftId) => {
        const { __weftEditor: ed, __weftController: controller } = window as unknown as {
            __weftEditor: Editor
            __weftController: { layoutGen: number }
        }
        const before = ed.getCurrentPageShapes().find((shape): shape is TLDrawShape => shape.type === 'draw')!
        ed.createShape({ id: draftId, type: 'draw', x: 123, y: 456,
            props: { ...before.props, isComplete: false } })
        ed.select(before.id)
        const counts = { created: 0, deleted: 0, updated: 0 }
        ed.store.sideEffects.registerAfterCreateHandler('shape', (shape) => {
            if (shape.type === 'draw') counts.created++
        })
        ed.store.sideEffects.registerAfterDeleteHandler('shape', (shape) => {
            if (shape.type === 'draw') counts.deleted++
        })
        ed.store.sideEffects.registerAfterChangeHandler('shape', (_, shape) => {
            if (shape.type === 'draw') counts.updated++
        })
        window.textLayoutProbe = { before, counts, elapsed: 0 }
        let layoutGen = controller.layoutGen
        Object.defineProperty(controller, 'layoutGen', {
            get: () => layoutGen,
            set(next: number) {
                layoutGen = next
                const start = performance.now()
                queueMicrotask(() => { window.textLayoutProbe.elapsed = performance.now() - start })
            },
        })
        window.releaseDeviceFonts()
    }, DRAFT)
    await expect.poll(() => page.evaluate(() => window.textLayoutProbe.elapsed)).toBeGreaterThan(0)
    const result = await page.evaluate((draftId) => {
        const ed = (window as unknown as { __weftEditor: Editor }).__weftEditor
        const { before, counts, elapsed } = window.textLayoutProbe
        return {
            counts, elapsed, sameSamples: ed.getShape(before.id)?.props === before.props,
            selected: ed.getSelectedShapeIds().includes(before.id),
            draft: ed.getShape(draftId)?.props,
        }
    }, DRAFT)
    if (process.env.WEFT_BENCH_TEXT_LAYOUT) {
        console.log(JSON.stringify({ textLayoutMs: result.elapsed, ...result.counts }))
    }
    expect(result.counts).toMatchObject({ created: 0, deleted: 0, updated: 0 })
    expect(result.sameSamples).toBe(true)
    expect(result.selected).toBe(true)
    expect(result.draft).toMatchObject({ isComplete: false })
})

test('text reflow moves only anchored ink and Undo/Redo retain native coordinates', async ({ page, request }) => {
    const id = crypto.randomUUID()
    const endpoint = `/api/documents/${DOC}/pages/${id}`
    const { first } = await anchoredReflowPushes()
    const { RmDocument } = await import('../packages/rm-format/src/index')
    const { RM_SCALE } = await import('../packages/rm-ink/src/pen')
    const seeded = RmDocument.parse(first as never)
    const source = [...seeded.tree().walk()].find(([, item]) => item.kind === 'line')?.[1]
    if (source?.kind !== 'line') throw new Error('missing anchored line')
    seeded.appendLine({ ...source, points: source.points.map((point) => ({ ...point, x: point.x + 500 })) },
        { authorUuid: DEVICE_AUTHOR })
    expect((await request.put(`${endpoint}/rm`, { data: Buffer.from(seeded.serialize()) })).ok()).toBe(true)
    await delayDeviceFonts(page)
    await page.goto(`/app/${DOC}/${id}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30_000 })
    const nativeInk = async () => {
        const doc = RmDocument.parse(new Uint8Array(await (await request.get(`${endpoint}/rm`)).body()) as never)
        const authors = doc.authorTable()
        return [...doc.tree().walk()].flatMap(([id, item]) => item.kind === 'line' ?
            [{ author: authors.get(id.part1), clock: id.part2, points: item.points }] : [],
        ).sort((a, b) => a.points[0]!.x - b.points[0]!.x)
    }
    const points = async () => (await nativeInk()).map((line) => line.points)
    const initial = await points()
    const ink = () => page.evaluate(() => {
        const ed = (window as unknown as { __weftEditor: Editor }).__weftEditor
        return ed.getCurrentPageShapes().filter(shape => shape.type === 'draw')
            .map(({ id, x, y }) => ({ id, x, y })).sort((a, b) => a.x - b.x)
    })
    const [anchored, fixed] = (await ink())!
    await page.evaluate((id) => {
        const ed = (window as unknown as { __weftEditor: Editor }).__weftEditor
        const shape = ed.getShape(id)!
        ed.clearHistory()
        ed.markHistoryStoppingPoint('move ink')
        ed.updateShape({ id, type: 'draw', x: shape.x + 5 })
    }, anchored!.id)
    await expect.poll(async () => (await points())[0]![0]!.x).toBeCloseTo(initial[0]![0]!.x + 5 / RM_SCALE, 1)
    const movedNative = await nativeInk()
    const moved = movedNative.map((line) => line.points)
    const [before] = await ink()
    await page.evaluate((id) => {
        const ed = (window as unknown as { __weftEditor: Editor }).__weftEditor
        ed.run(() => ed.select(id), { history: 'ignore' })
        ed.inputs.setIsPointing(true)
    }, anchored!.id)
    await appendToDeviceText(page, '\nbeta\ngamma')
    expect((await ink())[0]).toEqual(before)
    await page.evaluate(() => {
        const ed = (window as unknown as { __weftEditor: Editor }).__weftEditor
        ed.inputs.setIsPointing(false)
    })
    await expect.poll(async () => (await ink())[0]!.y).toBeGreaterThan(before!.y)
    const [after, unchanged] = await ink()
    expect(after!.id).toBe(before!.id)
    expect(after!.y).toBeGreaterThan(before!.y)
    expect(unchanged).toEqual(fixed)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    expect(await nativeInk()).toEqual(movedNative)

    const history = (action: 'undo' | 'redo') => page.evaluate(action => {
        const ed = (window as unknown as { __weftEditor: Editor }).__weftEditor
        ed[action]()
    }, action)
    await history('undo')
    await expect.poll(async () => (await points())[0]![0]!.x).toBeCloseTo(initial[0]![0]!.x, 1)
    expect((await points())[0]!.map(({ y }) => y)).toEqual(moved[0]!.map(({ y }) => y))
    expect((await ink())[0]).toMatchObject({ id: anchored!.id, y: after!.y })
    await history('redo')
    await expect.poll(points).toEqual(moved)
    expect(await ink()).toEqual([after, fixed])
})

test('a text edit reapplies visibility to a newly synced overlay on a hidden layer', async ({ page, request }) => {
    const id = crypto.randomUUID()
    const endpoint = `/api/documents/${DOC}/pages/${id}/rm`
    const { first } = await anchoredReflowPushes()
    const { RmDocument } = await import('../packages/rm-format/src/index')
    const doc = RmDocument.parse(first as never)
    const hidden = doc.createLayer('Hidden ink', { authorUuid: DEVICE_AUTHOR })
    doc.setLayerVisible(hidden, false, { authorUuid: DEVICE_AUTHOR })
    expect((await request.put(endpoint, { data: Buffer.from(doc.serialize()) })).ok()).toBe(true)
    await delayDeviceFonts(page)
    await page.goto(`/app/${DOC}/${id}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')

    const overlayId = 'shape:overlay-probe' as TLShapeId
    await page.evaluate((overlayId) => {
        const { __weftEditor: ed, __weftController: controller } = window as unknown as {
            __weftEditor: Editor; __weftController: StudioController
        }
        const layer = controller.listLayers().find(layer => layer.label === 'Hidden ink')!
        controller.setActiveLayer(layer.ref)
        ed.createShape({ id: overlayId, type: 'geo', x: 20, y: 40, props: { w: 100, h: 100 } })
    }, overlayId)
    await expect.poll(async () => {
        const bytes = new Uint8Array(await (await request.get(endpoint)).body())
        return [...RmDocument.parse(bytes as never).tree().walk()].filter(([, item]) => item.kind === 'line').length
    }).toBeGreaterThan(1)
    await appendToDeviceText(page, 'a')
    const opacity = await page.evaluate((overlayId) => {
        const { __weftEditor: ed } = window as unknown as { __weftEditor: Editor }
        return ed.getShape(overlayId)?.opacity
    }, overlayId)
    expect(opacity).toBe(0)
})

test('reflow moves and retries an anchored photo in place after a transient fetch error', async ({ page, request }) => {
    const id = crypto.randomUUID()
    const endpoint = `/api/documents/${DOC}/pages/${id}`
    const { first } = await anchoredReflowPushes()
    const { RmDocument, crdtId, lww, uuidToBytesLE } = await import('../packages/rm-format/src/index')
    const doc = RmDocument.parse(first as never)
    const anchored = doc.blocks.find(block => block.type === 'sceneLineItem')!
    const uuid = crypto.randomUUID()
    const filename = `${uuid}.png`
    const stamp = crdtId(doc.resolveAuthor(DEVICE_AUTHOR), doc.maxClock() + 1)
    doc.appendImage({
        kind: 'image', uuid: lww(stamp, uuidToBytesLE(uuid)), timestamp: stamp,
        vertices: [10, 20, 0, 0, 110, 20, 1, 0, 110, 100, 1, 1, 10, 100, 0, 1],
        indices: [0, 1, 2, 2, 3, 0], filename: null,
    }, { authorUuid: DEVICE_AUTHOR, parentId: anchored.parentId })
    doc.blocks.push({
        type: 'sceneImageInfo', version: { min: 3, current: 3 }, extraData: new Uint8Array(),
        images: [{ uuid, filename: lww(stamp, filename), flags: lww(stamp, new Uint8Array([17, 0])) }],
    })
    const path = `${endpoint}/assets/${filename}`
    const photo = await readFile('fixtures/test-photo.png')
    expect((await request.put(path, { data: photo })).ok()).toBe(true)
    expect((await request.put(`${endpoint}/rm`, { data: Buffer.from(doc.serialize()) })).ok()).toBe(true)
    await page.route(`**${path}`, route => route.fulfill({ status: 503 }), { times: 1 })
    await delayDeviceFonts(page)
    const failed = page.waitForResponse(response => response.url().endsWith(path) && response.status() === 503)
    await page.goto(`/app/${DOC}/${id}`)
    await failed
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const placement = () => page.evaluate(() => {
        const ed = (window as unknown as { __weftEditor: Editor }).__weftEditor
        const shape = ed.getCurrentPageShapes().find(shape => shape.type === 'image')
        return shape?.type === 'image' ? { id: shape.id, asset: shape.props.assetId, x: shape.x, y: shape.y } : null
    })
    const before = (await placement())!
    await appendToDeviceText(page, '\nbeta\ngamma')
    const after = (await placement())!
    expect(after).toMatchObject({ id: before.id, asset: before.asset, x: before.x })
    expect(after.y).toBeGreaterThan(before.y)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const saved = RmDocument.parse(new Uint8Array(await (await request.get(`${endpoint}/rm`)).body()) as never)
    const native = [...saved.tree().walk()].find(([, item]) => item.kind === 'image')?.[1]
    expect(native).toMatchObject({ vertices: [10, 20, 0, 0, 110, 20, 1, 0, 110, 100, 1, 1, 10, 100, 0, 1] })
    await expect.poll(() => page.evaluate(() => {
        const { __weftEditor: ed } = window as unknown as { __weftEditor: Editor }
        const image = ed.getCurrentPageShapes().find(shape => shape.type === 'image')
        return image?.props.assetId ? ed.getAsset(image.props.assetId)?.props.src : null
    })).toBe(`data:image/png;base64,${photo.toString('base64')}`)
})


test('a rotated and locked group receives the reflow in page coordinates', async ({ page, request }) => {
    const id = crypto.randomUUID()
    const { first } = await anchoredReflowPushes()
    const { RmDocument } = await import('../packages/rm-format/src/index')
    const doc = RmDocument.parse(first as never)
    const source = [...doc.tree().walk()].find(([, item]) => item.kind === 'line')?.[1]
    if (source?.kind !== 'line') throw new Error('missing anchored line')
    doc.appendLine({ ...source, points: source.points.map((point) => ({ ...point, x: point.x + 500 })) },
        { authorUuid: DEVICE_AUTHOR })
    expect((await request.put(`/api/documents/${DOC}/pages/${id}/rm`, { data: Buffer.from(doc.serialize()) })).ok()).toBe(true)
    await delayDeviceFonts(page)
    await page.goto(`/app/${DOC}/${id}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const state = await page.evaluate(() => {
        const ed = (window as unknown as { __weftEditor: Editor }).__weftEditor
        const [anchored, other] = ed.getCurrentPageShapes().filter(s => s.type === 'draw').sort((a, b) => a.x - b.x)
        const ids = [anchored!.id, other!.id]
        ed.store.mergeRemoteChanges(() => {
            ed.groupShapes(ids)
            const group = ed.getShape(ed.getShape(anchored!.id)!.parentId as TLShapeId)!
            ed.updateShapes([
                { id: anchored!.id, type: 'draw', isLocked: true },
                { id: group.id, type: 'group', rotation: Math.PI / 2, isLocked: true },
            ])
        })
        return ids.map(id => {
            const shape = ed.getShape(id)!
            const { e, f } = ed.getShapePageTransform(shape)
            return { id, parent: shape.parentId, x: e, y: f }
        })
    })
    await appendToDeviceText(page, '\nbeta\ngamma')
    const after = await page.evaluate(ids => {
        const ed = (window as unknown as { __weftEditor: Editor }).__weftEditor
        return ids.map(id => {
            const shape = ed.getShape(id)!
            const { e, f } = ed.getShapePageTransform(shape)
            return { id, parent: shape.parentId, x: e, y: f }
        })
    }, state.map(({ id }) => id))
    expect(after[0]).toMatchObject({ id: state[0]!.id, parent: state[0]!.parent })
    expect(after[0]!.x).toBeCloseTo(state[0]!.x)
    expect(after[0]!.y).toBeGreaterThan(state[0]!.y)
    expect(after[1]!.x).toBeCloseTo(state[1]!.x)
    expect(after[1]!.y).toBeCloseTo(state[1]!.y)
})

test('changed font metrics reflow the existing anchored stroke', async ({ page, request }) => {
    const { first } = await anchoredReflowPushes()
    const { RmDocument, insertText } = await import('../packages/rm-format/src/index')
    const doc = RmDocument.parse(first as never)
    insertText(doc, null, '漢漢漢漢漢漢', { authorUuid: DEVICE_AUTHOR })
    const id = crypto.randomUUID()
    expect((await request.put(`/api/documents/${DOC}/pages/${id}/rm`, { data: Buffer.from(doc.serialize()) })).ok()).toBe(true)
    await delayDeviceFonts(page, true)
    await page.goto(`/app/${DOC}/${id}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const stroke = () => page.evaluate(() => {
        const ed = (window as unknown as { __weftEditor: Editor }).__weftEditor
        const shape = ed.getCurrentPageShapes().find(shape => shape.type === 'draw')!
        return { id: shape.id, x: shape.x, y: shape.y }
    })
    const before = await stroke()
    await page.evaluate(() => window.releaseDeviceFonts())
    await expect.poll(async () => (await stroke()).y).toBeGreaterThan(before.y)
    expect(await stroke()).toMatchObject({ id: before.id, x: before.x })
})

test('a text edit reapplies native layer visibility without replacing the ink', async ({ page, request }) => {
    const { first } = await anchoredReflowPushes()
    const id = crypto.randomUUID()
    expect((await request.put(`/api/documents/${DOC}/pages/${id}/rm`, { data: Buffer.from(first) })).ok()).toBe(true)
    await delayDeviceFonts(page)
    await page.goto(`/app/${DOC}/${id}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const shapeId = await page.evaluate(() => {
        const ed = (window as unknown as { __weftEditor: Editor }).__weftEditor
        const ink = ed.getCurrentPageShapes().find(shape => shape.type === 'draw')!
        ed.updateShape({ id: ink.id, type: 'draw', opacity: 0.5 })
        return ink.id
    })
    await appendToDeviceText(page, 'a')
    const opacity = await page.evaluate((id) => {
        const ed = (window as unknown as { __weftEditor: Editor }).__weftEditor
        return ed.getShape(id)?.opacity
    }, shapeId)
    expect(opacity).toBe(1)
})
