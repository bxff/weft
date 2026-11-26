import { expect, test } from '@playwright/test'
import type { Editor, TLShapeId } from 'tldraw'
import type { OverlayShapeJson } from './tablet-erase'

const auth = { authorization: 'Bearer dev:e2e' }

test('tablet ink reflects the selected font on text and shape labels without rewriting on reopen', async ({ page, request }) => {
    await page.addInitScript(() => {
        localStorage.setItem('weft-server-url', location.origin)
        localStorage.setItem('weft-clerk-pk', '')
        localStorage.setItem('weft-dev-user', 'e2e')
    })
    const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
    const api = `/api/documents/${doc}/pages/${sheet}`
    await page.goto(`/app/${doc}/${sheet}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const readOverlay = async (): Promise<OverlayShapeJson[]> => {
        const response = await request.get(api + '/overlay', { headers: auth })
        return response.ok() ? (await response.json()).shapes : []
    }
    await page.evaluate(() => {
        const { __weftEditor: editor } = window as unknown as { __weftEditor: Editor }
        const richText = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] }
        editor.createShapes([
            { id: 'shape:draw' as TLShapeId, type: 'text', x: 220, y: 100, props: { richText, font: 'draw' } },
            { id: 'shape:sans' as TLShapeId, type: 'text', x: 320, y: 100, props: { richText, font: 'sans' } },
            { id: 'shape:serif' as TLShapeId, type: 'geo', x: 220, y: 180, props: { richText, font: 'serif' } },
            { id: 'shape:mono' as TLShapeId, type: 'note', x: 350, y: 180, props: { richText, font: 'mono' } },
        ])
    })
    await expect.poll(async () => (await readOverlay()).length).toBe(4)

    // Compare the serialized .rm strokes, normalized by translation. A
    // different position or slot width alone is not proof the face changed.
    const readInk = async () => {
        const response = await request.get(api + '/rm', { headers: auth })
        expect(response.ok()).toBe(true)
        return new Uint8Array(await response.body())
    }
    const glyphSignature = async (id: string) => {
        const { RmDocument } = await import('../packages/rm-format/src/index')
        const file = RmDocument.parse(await readInk())
        const authors = new Map([...file.authorTable()].map(([index, uuid]) => [uuid.toLowerCase(), index]))
        const refs = (await readOverlay()).find(shape => shape.shapeId === `shape:${id}`)!.rendered
            .find(part => part.partKey === 'glyph:0' || part.partKey === 'label:glyph:0')!.items
        const lines = refs.map(ref => {
            const index = authors.get(ref.authorUuid.toLowerCase())
            const item = file.blocks.find(block => block.type === 'sceneLineItem' &&
                block.itemId.part1 === index && block.itemId.part2 === ref.clock)
            if (item?.type !== 'sceneLineItem' || !item.line) throw new Error('Missing tablet glyph stroke')
            return item.line.points
        })
        const origin = lines[0]![0]!
        return lines.map(line => line.map(p => [p.x - origin.x, p.y - origin.y]))
    }
    // Baked Float32 coordinates can differ by 0.01 native units at
    // different absolute origins. Compare translated stroke extents.
    const extent = (lines: number[][][]) => lines.map(line => [0, 1].flatMap(axis => {
        const values = line.map(point => point[axis]!)
        return [Math.min(...values), Math.max(...values)]
    }))
    const equalContours = (a: number[][][], b: number[][][]) => {
        const ea = extent(a), eb = extent(b)
        return ea.length === eb.length && ea.every((box, i) =>
            box.every((v, j) => Math.abs(v - eb[i]![j]!) < 0.05))
    }
    const draw = await glyphSignature('draw')
    const sans = await glyphSignature('sans')
    expect(equalContours(sans, draw)).toBe(false)
    expect(equalContours(await glyphSignature('serif'), await glyphSignature('mono'))).toBe(false)

    // An explicit family edit remints the projected glyph, using the same
    // contours as the already-projected Sans glyph elsewhere on the page.
    const old = (await readOverlay()).find(shape => shape.shapeId === 'shape:draw')!.rendered
    await page.evaluate(() => {
        const { __weftEditor: editor } = window as unknown as { __weftEditor: Editor }
        editor.updateShape({ id: 'shape:draw' as TLShapeId, type: 'text', props: { font: 'sans' } })
    })
    await expect.poll(async () => (await readOverlay()).find(shape => shape.shapeId === 'shape:draw')!.rendered)
        .not.toEqual(old)
    const edited = await glyphSignature('draw')
    expect(equalContours(edited, draw)).toBe(false)
    expect(equalContours(edited, sans)).toBe(true)

    const before = await readOverlay()
    const bytes = Buffer.from(await readInk())
    const exportFromEditor = () => page.evaluate(async () => {
        const { __weftController } = window as unknown as {
            __weftController: { flush(): Promise<void>; exportRmBytes(): Uint8Array | null }
        }
        await __weftController.flush()
        return Array.from(__weftController.exportRmBytes()!)
    })
    const exported = await exportFromEditor()
    await page.reload()
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    expect(await exportFromEditor()).toEqual(exported)
    expect(await readOverlay()).toEqual(before)
    expect(Buffer.from(await readInk())).toEqual(bytes)
})
