import { expect, test } from '@playwright/test'
import type { Editor } from 'tldraw'
import { useCloudMode } from './cloud-mode'
import { devicePut, deviceToken, inkRm } from './device-blob'

useCloudMode()

test('a native page over the stock shape limit opens, accepts an overlay shape, and reopens intact', async ({ page }) => {
    const { RmDocument } = await import('../packages/rm-format/src/index')
    const notebook = '11111111-1111-4111-a111-111111111111'
    const sheet = crypto.randomUUID()
    const doc = RmDocument.parse(await inkRm(1))
    const first = doc.blocks.find((block) => block.type === 'sceneLineItem')
    if (!first?.line) throw new Error('missing fixture stroke')
    const line = { ...first.line, points: first.line.points.slice(0, 2) }
    doc.appendLines(Array(4000).fill(line), { authorUuid: crypto.randomUUID() })
    await devicePut(await deviceToken(), notebook, sheet, doc.serialize())

    await page.goto(`/app/${notebook}/${sheet}`)
    const shapes = () => page.evaluate(() => {
        const editor = (window as Window & { __weftEditor?: Editor }).__weftEditor
        return editor?.getCurrentPageShapes().map((shape) => shape.type)
    })
    await expect.poll(async () => (await shapes())?.length, { timeout: 15_000 }).toBe(4001)
    await page.evaluate(() => {
        const editor = (window as Window & { __weftEditor: Editor }).__weftEditor
        editor.createShape({ type: 'geo', x: 30, y: 40 })
    })
    await expect.poll(async () => {
        const response = await page.request.get(`/api/documents/${notebook}/pages/${sheet}/overlay`)
        return (await response.json()).shapes.length
    }).toBe(1)

    await page.reload()
    await expect.poll(async () => {
        const types = await shapes()
        return [types?.filter((type) => type === 'draw').length, types?.filter((type) => type === 'geo').length]
    }, { timeout: 15_000 }).toEqual([4001, 1])
})
