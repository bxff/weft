import { expect, test } from '@playwright/test'
import type { Editor, TLShapeId } from 'tldraw'
import { useCloudMode } from './cloud-mode'

useCloudMode()

const shapeId = 'shape:legacy-child' as TLShapeId
type Studio = Window & { __weftEditor?: Editor }

test('opening a legacy shape does not publish an unqualified page pose', async ({ page }) => {
    const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
    const api = `/api/documents/${doc}/pages/${sheet}`
    await page.goto(`/app/${doc}/${crypto.randomUUID()}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const props = await page.evaluate(() => (window as Studio).__weftEditor!.getShapeUtil('geo').getDefaultProps())
    const op = {
        op: 'upsert-object', id: shapeId, objType: 'geo', props,
        transform: { x: 35, y: 45, rotation: 0 }, rendered: [],
        renderRevision: 'unknown-parent-transform', version: { ts: 1, actor: 'old-browser' },
    }
    const response = await page.request.post(api + '/ops', {
        data: { ops: [Buffer.from(JSON.stringify(op)).toString('base64')] },
    })
    expect(response.ok()).toBe(true)
    await page.goto(`/app/${doc}/${sheet}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await expect.poll(() => page.evaluate(id => (window as Studio).__weftEditor?.getShape(id)?.x, shapeId)).toBe(35)
    const history = async () => {
        const response = await page.request.get(api + '/ops?since=0')
        expect(response.ok()).toBe(true)
        return (await response.json() as { ops: { op: string }[] }).ops
            .map(record => JSON.parse(Buffer.from(record.op, 'base64').toString()))
    }
    // The startup projection sweep is scheduled after 2 seconds.
    await page.waitForTimeout(2750)
    expect(await history()).toEqual([op])
    await page.evaluate(id => {
        (window as Studio).__weftEditor!.updateShape({ id, type: 'geo', x: 85 })
    }, shapeId)
    await expect.poll(async () => (await history()).filter(record => record.op === 'upsert-object').at(-1)).toMatchObject({
        id: shapeId, transform: { x: 85, y: 45 },
    })
})
