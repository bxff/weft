import { expect, test } from '@playwright/test'
import type { Editor, TLShapeId } from 'tldraw'
const auth = { authorization: 'Bearer dev:e2e' }
test('arrow attached to two shapes keeps its span when page reloads', async ({ page, request }) => {
    await page.addInitScript(() => {
        localStorage.setItem('weft-server-url', location.origin)
        localStorage.setItem('weft-clerk-pk', '')
        localStorage.setItem('weft-dev-user', 'e2e')
    })
    const d = crypto.randomUUID(), p = crypto.randomUUID()
    const arrowId = 'shape:regression-arrow' as TLShapeId
    await page.goto(`/app/${d}/${p}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await page.evaluate((arrowId) => {
        const e = (window as unknown as { __weftEditor: Editor }).__weftEditor
        const left = 'shape:regression-left' as TLShapeId, right = 'shape:regression-right' as TLShapeId
        e.createShapes([
            { id: left, type: 'geo', x: 70, y: 125, props: { geo: 'rectangle', w: 90, h: 80 } },
            { id: right, type: 'geo', x: 405, y: 150, props: { geo: 'rectangle', w: 90, h: 80 } },
            { id: arrowId, type: 'arrow', x: 100, y: 150,
              props: { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } } },
        ])
        e.createBindings(['start', 'end'].map((terminal, i) => ({
            type: 'arrow', fromId: arrowId, toId: i ? right : left,
            props: { terminal: terminal as 'start' | 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
        })))
    }, arrowId)
    const collect = () => page.evaluate(arrowId => {
        const e = (window as unknown as { __weftEditor: Editor }).__weftEditor
        const s = e.getShape(arrowId)
        return s && { w: e.getShapeGeometry(s).bounds.w, bindings: e.getBindingsFromShape(s, 'arrow').length,
            props: s.props }
    }, arrowId)
    const before = await collect()
    expect(before?.w).toBeGreaterThan(200)
    await expect.poll(async () => {
        const r = await request.get(`/api/documents/${d}/pages/${p}/overlay`, { headers: auth })
        if (!r.ok()) return false
        return ((await r.json()).shapes as { shapeId: string }[]).some(x => x.shapeId === arrowId)
    }).toBeTruthy()
    await page.reload()
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const after = await collect()
    expect(after?.bindings).toBe(2)
    expect(after?.w).toBeCloseTo(before!.w, 5)

    await page.evaluate(() => {
        const e = (window as unknown as { __weftEditor: Editor }).__weftEditor
        e.updateShape({ id: 'shape:regression-right' as TLShapeId, type: 'geo', x: 510 })
    })
    const moved = await collect()
    expect(moved!.w).toBeGreaterThan(after!.w + 90)
    const overlay = async () => {
        const r = await request.get(`/api/documents/${d}/pages/${p}/overlay`, { headers: auth })
        return ((await r.json()).shapes as { shapeId: string; props: { end?: { x: number }; weftArrowLinks?: unknown[] } }[])
            .find(x => x.shapeId === arrowId)?.props
    }
    await expect.poll(async () => (await overlay())?.end?.x).toBeGreaterThan(360)
    await page.reload()
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    expect((await collect())?.w).toBeCloseTo(moved!.w, 5)

    await page.evaluate((id) => {
        const e = (window as unknown as { __weftEditor: Editor }).__weftEditor
        const links = e.getBindingsFromShape(id, 'arrow')
        e.deleteBindings(links, { isolateShapes: true })
    }, arrowId)
    await expect.poll(async () => (await overlay())?.weftArrowLinks).toEqual([])
    await page.reload()
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    expect((await collect())?.bindings).toBe(0)
    expect((await collect())?.w).toBeGreaterThan(200)
})
