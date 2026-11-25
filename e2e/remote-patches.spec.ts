import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import type { Editor, TLShapeId } from 'tldraw'
import type { OverlayShape } from '../packages/sync-engine/src/types'
import { useCloudMode } from './cloud-mode'

useCloudMode()

interface RenderProbe {
    editor: Editor
    session: { reconcile(): Promise<void>; unsubscribe?: () => void; retryTimer?: number }
    pendingShapeIds: Set<TLShapeId>
    debounce?: number
    renderInkItems(excluded: Set<string>): void
    applyLayerVisibility(): void
}

async function verifyPaint(page: Page, request: APIRequestContext, replaceCheckpoint: boolean) {
    const doc = '11111111-1111-4111-a111-111111111111'
    const sheet = crypto.randomUUID()
    const endpoint = `/api/documents/${doc}/pages/${sheet}`
    await page.goto(`/app/${doc}/${sheet}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const edited = 'shape:pending-local' as TLShapeId
    const textIds = Array.from({ length: 6 }, (_, i) => `shape:text-${i}` as TLShapeId)
    await page.evaluate(({ edited, textIds }) => {
        const { editor } = (window as unknown as { __weftController: RenderProbe }).__weftController
        editor.createShape({ id: edited, type: 'geo', x: 10, y: 40 })
        editor.createShapes(textIds.map((id, i) => ({
            id, type: 'text', x: 20, y: i * 70,
            props: { richText: { type: 'doc', content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'abcd' }] },
            ] } },
        })))
    }, { edited, textIds })
    const overlay = async () => (await (await request.get(`${endpoint}/overlay`)).json()) as { shapes: OverlayShape[] }
    await expect.poll(async () => (await overlay()).shapes.length).toBe(textIds.length + 1)
    const shapes = (await overlay()).shapes
    const props = await page.evaluate(async (edited) => {
        const c = (window as unknown as { __weftController: RenderProbe }).__weftController
        // Control exactly one accepted pull and hold the next editor-local edit
        // before its debounce projects. The rest of the relay path is unchanged.
        c.session.unsubscribe?.()
        clearInterval(c.session.retryTimer)
        await c.session.reconcile()
        c.editor.clearHistory()
        c.editor.select(edited)
        c.editor.markHistoryStoppingPoint('move local shape')
        c.editor.updateShape({ id: edited, type: 'geo', x: 75 })
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        if (!c.pendingShapeIds.has(edited)) throw new Error('expected a pending editor shape')
        clearTimeout(c.debounce)
        return c.editor.getShapeUtil('geo').getDefaultProps()
    }, edited)

    const { Pen, PenColor, RmDocument, crdtId } = await import('../packages/rm-format/src/index')
    const { encodeOp, lineBlockToAddOp } = await import('../packages/sync-engine/src/ops')
    if (replaceCheckpoint) {
        const { encodeSnapshot } = await import('../packages/sync-engine/src/snapshot')
        const response = await request.get(`${endpoint}/rm`)
        expect(response.ok()).toBe(true)
        const checkpoint = RmDocument.parse((await response.body()) as never)
        checkpoint.createLayer('Checkpoint layer', { authorUuid: crypto.randomUUID() })
        expect((await request.put(`${endpoint}/snapshot`, {
            data: Buffer.from(encodeSnapshot(checkpoint.serialize(), { shapes })),
        })).ok()).toBe(true)
    }
    const authorUuid = crypto.randomUUID()
    const rm = RmDocument.empty(authorUuid)
    const line = rm.appendLine({
        kind: 'line', tool: Pen.MARKER_2, color: PenColor.BLACK, thicknessScale: 2, startingLength: 0,
        timestamp: crdtId(0, 0), moveId: null,
        points: [{ x: 20, y: 30 }, { x: 100, y: 130 }].map(point => ({
            ...point, width: 40, speed: 0, direction: 0, pressure: 255,
        })),
    }, { authorUuid })
    const ops = [lineBlockToAddOp(rm, line)]
    const erased = shapes.filter(shape => shape.kind === 'text').flatMap(shape =>
        shape.rendered.find(part => part.partKey === 'glyph:1')!.items.map(ref =>
            encodeOp({ op: 'tombstone', id: { author: ref.authorUuid, clock: ref.clock } })))
    const actor = crypto.randomUUID()
    const upserts = [edited, ...Array.from({ length: 8 }, (_, i) => `shape:remote-${i}`)].map((id, i) =>
        encodeOp({ op: 'upsert-object', id, objType: 'geo', props, rendered: [],
            transform: { x: 200 + i * 10, y: 40, rotation: 0 }, version: { actor, ts: Date.now() + 10_000 } }))
    const wires = [...ops.map(encodeOp), ...erased, ...upserts].map(op => Buffer.from(op).toString('base64'))
    expect((await request.post(`${endpoint}/ops`, { data: { ops: wires, author: actor } })).ok()).toBe(true)

    const echoed: string[] = []
    page.on('request', request => {
        if (request.method() !== 'GET' && /\/(ops|snapshot)(\?|$)/.test(request.url())) echoed.push(request.url())
    })
    const result = await page.evaluate(async ({ edited, textIds }) => {
        const c = (window as unknown as { __weftController: RenderProbe }).__weftController
        const editor = c.editor
        const merge = editor.store.mergeRemoteChanges.bind(editor.store)
        const renderInk = c.renderInkItems.bind(c)
        const visibility = c.applyLayerVisibility.bind(c)
        const counts = { transactions: 0, inkWalks: 0, layerPasses: 0 }
        let depth = 0
        editor.store.mergeRemoteChanges = fn => {
            if (depth++ === 0) counts.transactions++
            try { return merge(fn) } finally { depth-- }
        }
        c.renderInkItems = excluded => { counts.inkWalks++; renderInk(excluded) }
        c.applyLayerVisibility = () => { counts.layerPasses++; visibility() }
        const canUndo = editor.canUndo()
        try { await c.session.reconcile() } finally {
            editor.store.mergeRemoteChanges = merge
            c.renderInkItems = renderInk
            c.applyLayerVisibility = visibility
        }
        const firstForeign = editor.getShape('shape:remote-0' as TLShapeId)
        const imported = editor.getCurrentPageShapes().filter(shape => shape.meta.rmBrush)
        const rendered = {
            counts, selected: editor.getSelectedShapeIds(),
            x: editor.getShape(edited)?.x, undoStable: canUndo && editor.canUndo(),
            detached: textIds.every(id => editor.getShape(id)?.meta.detached === true),
            foreign: editor.getShape('shape:remote-7' as TLShapeId)?.x,
            inkBelowNewShapes: !!firstForeign && imported.length > 0 && imported.every(shape => shape.index < firstForeign.index),
        }
        editor.undo()
        return { ...rendered, undoX: editor.getShape(edited)?.x, foreignAfterUndo: editor.getShape('shape:remote-7' as TLShapeId)?.x }
    }, { edited, textIds })
    expect(result).toEqual({
        counts: { transactions: 1, inkWalks: 1, layerPasses: 1 }, selected: [edited],
        x: 75, undoStable: true, detached: true, foreign: 280, inkBelowNewShapes: true, undoX: 10, foreignAfterUndo: 280,
    })
    expect(echoed).toEqual([])
}

test('one accepted tablet batch paints once and leaves a local edit and Undo intact', async ({ page, request }) => {
    await verifyPaint(page, request, false)
})

test('a checkpoint and its operation tail paint once and leave Undo intact', async ({ page, request }) => {
    await verifyPaint(page, request, true)
})
