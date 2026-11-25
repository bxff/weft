import { expect, test } from '@playwright/test'
import { inkRm } from './device-blob'

const auth = { authorization: 'Bearer dev:e2e' }

for (const scenario of ['complete','tail','no notifications'] as const) {
    test(`first opening with ${scenario}`, async ({ page, request, baseURL }) => {
        const hasTail = scenario === 'tail'
        if (scenario === 'no notifications') {
            await page.route('**/api/ws-ticket', route => route.fulfill({ status: 403 }))
            await page.routeWebSocket('**/ws*', socket => socket.close())
        }
        const { encodeSnapshot } = await import('../packages/sync-engine/src/snapshot')
        const { encodeOp } = await import('../packages/sync-engine/src/ops')
        const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
        const api = `/api/documents/${doc}/pages/${sheet}`
        const snapshot = await request.put(api + '/snapshot', {
            headers: { ...auth, 'content-type': 'application/octet-stream' },
            data: Buffer.from(encodeSnapshot(await inkRm(1), { shapes: [] })),
        })
        expect(snapshot.ok()).toBe(true)
        if (hasTail) {
            const delta = encodeOp({
                op: 'upsert-object', id: 'shape:after-checkpoint', objType: 'geo',
                props: { geo: 'rectangle', w: 100, h: 60 }, rendered: [],
                transform: { x: 10, y: 20, rotation: 0 }, version: { ts: 1, actor: 'peer' },
            })
            expect((await request.post(api + '/ops', {
                headers: auth, data: { ops: [Buffer.from(delta).toString('base64')] },
            })).ok()).toBe(true)
        }

        const reads: string[] = []
        page.on('request', (req) => {
            const path = new URL(req.url()).pathname
            if (req.method() === 'GET' && (path === api + '/snapshot' || path === api + '/ops')) {
                reads.push(path.slice(api.length))
            }
        })
        await page.addInitScript((relay) => {
            localStorage.setItem('weft-server-url', relay)
            localStorage.setItem('weft-clerk-pk', '')
            localStorage.setItem('weft-dev-user', 'e2e')
        }, baseURL!)
        await page.goto(`/app/${doc}/${sheet}`)
        await expect(page.getByTestId('sync-status')).toHaveText('synced')
        await expect(page.locator('.tl-shape[data-shape-type="draw"]')).toHaveCount(1)
        await expect(page.locator('.tl-shape[data-shape-type="geo"]')).toHaveCount(hasTail ? 1 : 0)
        if (scenario === 'complete') expect(reads).toEqual(['/snapshot'])
        else expect(reads).toContain('/ops')
    })
}
