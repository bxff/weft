import { expect, test, type Page } from '@playwright/test'
import { CLOUD_ORIGIN, E2E_USER, useCloudMode } from './cloud-mode'
import { devicePut, deviceToken } from './device-blob'

useCloudMode()

const NOTEBOOK = '22222222-2222-4222-a222-222222222222'
const AUTHOR = 'aaaaaaaa-0000-4000-a000-000000000001'

async function readNative(pageId: string, token: string) {
    const { RmDocument } = await import('../packages/rm-format/src/index')
    const response = await fetch(`${CLOUD_ORIGIN}/api/documents/${NOTEBOOK}/pages/${pageId}/rm`, {
        headers: { 'x-device-token': token },
    })
    expect(response.ok).toBe(true)
    return RmDocument.parse(new Uint8Array(await response.arrayBuffer()))
}

function liveLines(doc: Awaited<ReturnType<typeof readNative>>) {
    return doc.blocks.filter((block) => block.type === 'sceneLineItem' && block.deletedLength === 0)
}

function positions(target: Page) {
    return target.evaluate(() => {
        const ed = (window as typeof window & { __weftEditor: import('tldraw').Editor }).__weftEditor
        return ed?.getCurrentPageShapes().filter((shape) => shape.meta.rmBrush)
            .sort((a, b) => a.y - b.y).map(({ x, y }) => [x, y]) ?? []
    })
}

async function moveImported(page: Page, dx: number, dy: number, hold = false) {
    await page.evaluate(({ x, y, hold }) => {
        const ed = (window as typeof window & { __weftEditor: import('tldraw').Editor }).__weftEditor
        if (hold) ed.inputs.setIsPointing(true)
        ed.updateShapes(ed.getCurrentPageShapes().filter((shape) => shape.meta.rmBrush)
            .map((shape) => ({ id: shape.id, type: shape.type, x: shape.x + x, y: shape.y + y })))
        ed.store._flushHistory()
    }, { x: dx, y: dy, hold })
}

test('moving imported ink preserves fractional and single-point native samples', async ({ page, browser }) => {
    const { RmDocument, Pen, PenColor } = await import('../packages/rm-format/src/index')
    const { RM_SCALE } = await import('../packages/rm-ink/src/pen')
    const pageId = crypto.randomUUID()
    const source = RmDocument.empty(AUTHOR)
    const firstPoint = {
        x: 123.34375, y: 11.0478515625,
        speed: 4,
        width: 2,
        pressure: 95,
        direction: 127,
    }
    const samples = [firstPoint, { ...firstPoint, x: 141.28125, y: 13.5390625 }]
    const originals = [samples, [firstPoint]].map((points, i) => {
        const block = source.appendLine({
            kind: 'line', tool: Pen.FINELINER_1, color: PenColor.BLACK,
            thicknessScale: 1.25, startingLength: 2,
            timestamp: { part1: 0, part2: 0 }, moveId: null,
            points: points.map((point) => ({ ...point, y: point.y + i * 50 })),
        }, { authorUuid: AUTHOR })
        return block
    })
    const token = await deviceToken()
    await devicePut(token, NOTEBOOK, pageId, source.serialize())
    await page.goto(`/app/${NOTEBOOK}/${pageId}`)
    await expect.poll(() => positions(page)).toHaveLength(2)
    const before = await positions(page)
    const dx = 47.25
    const dy = -3.125
    await moveImported(page, dx * RM_SCALE, dy * RM_SCALE)

    await expect.poll(async () => liveLines(await readNative(pageId, token)).some((block) => !!block.line?.moveId)).toBe(true)
    const native = await readNative(pageId, token)
    expect(liveLines(native)).toHaveLength(2)
    for (const original of originals) {
        const moved = liveLines(native).find((block) =>
            block.line?.moveId?.part1 === original.itemId.part1 &&
            block.line.moveId.part2 === original.itemId.part2)
        expect(moved).toBeDefined()
        expect(moved!.version.current).toBe(2)
        expect(moved!.extraData).toEqual(original.extraData)
        expect(moved!.extraValueData).toEqual(original.extraValueData)
        expect(moved!.parentId).toEqual(original.parentId)
        expect(moved!.line!.tool).toBe(original.line!.tool)
        expect(moved!.line!.thicknessScale).toBe(original.line!.thicknessScale)
        expect(moved!.line!.startingLength).toBe(original.line!.startingLength)
        expect(moved!.line!.points).toHaveLength(original.line!.points.length)
        for (const [i, point] of original.line!.points.entries()) {
            expect(moved!.line!.points[i]).toMatchObject({
                x: Math.fround(point.x + dx), y: Math.fround(point.y + dy),
                speed: point.speed, width: point.width, pressure: point.pressure,
            })
            expect(moved!.line!.points[i]!.direction).toBeCloseTo(point.direction, 4)
        }
    }
    const peer = await browser.newContext({
        extraHTTPHeaders: { authorization: `Bearer dev:${E2E_USER}` },
    })
    try {
        await peer.addInitScript(([url, user]) => {
            localStorage.setItem('weft-server-url', url!)
            localStorage.setItem('weft-dev-user', user!)
            localStorage.setItem('weft-clerk-pk', '')
        }, [CLOUD_ORIGIN, E2E_USER])
        const fresh = await peer.newPage()
        await fresh.goto(`/app/${NOTEBOOK}/${pageId}`)
        await expect.poll(() => positions(fresh)).toHaveLength(2)
        for (const [i, [x, y]] of (await positions(fresh)).entries()) {
            expect(x).toBeCloseTo(before[i]![0]! + dx * RM_SCALE, 4)
            expect(y).toBeCloseTo(before[i]![1]! + dy * RM_SCALE, 4)
        }
    } finally {
        await peer.close()
    }
})
