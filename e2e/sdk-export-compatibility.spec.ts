import { expect, test } from '@playwright/test'
import type { Editor } from 'tldraw'
import content from './fixtures/tldraw-5.6-content.json' with { type: 'json' }

test('imports a 5.6 SDK shape and preserves it on a fresh browser', async ({ page, context, browser, request, baseURL }) => {
    const doc = crypto.randomUUID()
    const sheet = crypto.randomUUID()
    const path = `/app/${doc}/${sheet}`
    const login = (target: typeof context) => target.addInitScript((origin) => {
        localStorage.setItem('weft-server-url', origin)
        localStorage.setItem('weft-dev-user', 'e2e')
        localStorage.setItem('weft-clerk-pk', '')
    }, baseURL!)
    await login(context)
    await page.goto(path)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await page.evaluate((value) => {
        const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
        editor.putContentOntoCurrentPage(value as Parameters<Editor['putContentOntoCurrentPage']>[0])
    }, content)
    const endpoint = `/api/documents/${doc}/pages/${sheet}/overlay`
    await expect.poll(async () => {
        const response = await request.get(endpoint, { headers: { authorization: 'Bearer dev:e2e' } })
        if (!response.ok()) return 0
        return (await response.json()).shapes.length
    }).toBe(1)
    const peer = await browser.newContext()
    try {
        await login(peer)
        const fresh = await peer.newPage()
        await fresh.goto(path)
        await expect.poll(() => fresh.evaluate(() => {
            const editor = (window as unknown as { __weftEditor?: Editor }).__weftEditor
            return editor?.getCurrentPageShapes().map(shape => ({ type: shape.type, props: shape.props }))
        })).toEqual([{ type: 'geo', props: content.shapes[0]!.props }])
    } finally {
        await peer.close()
    }
})
