import { expect, test } from '@playwright/test'
import type { Editor, TLShapeId } from 'tldraw'
import type { KeyValueStorage } from '../packages/sync-engine/src/storage'

test.use({ serviceWorkers: 'block' })

type Harness = Window & {
    __weftEditor?: Editor
    __weftController?: { session: { reconcile(): Promise<void>; storage: KeyValueStorage } }
    holdCheckpoint?: boolean
    releaseCheckpoint?: () => void
}

test('the closing writer keeps its lease through a checkpoint write and an offline reopen', async ({ page, request }) => {
    const notebook = crypto.randomUUID(), sheet = crypto.randomUUID()
    const api = `/api/documents/${notebook}/pages/${sheet}`
    const path = `/app/${notebook}/${sheet}`
    const shapeId = 'shape:peer-before-files' as TLShapeId
    await page.addInitScript(() => {
        localStorage.setItem('weft-server-url', location.origin)
        localStorage.setItem('weft-dev-user', 'e2e')
        localStorage.setItem('weft-clerk-pk', '')
    })
    await page.goto(path)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const leases = () => page.evaluate(async key => {
        const held = (await navigator.locks.query()).held ?? []
        return [key, key + '/use'].map(name => held.some(lock => lock.name === name))
    }, `weft-page:${notebook}/${sheet}`)
    expect(await leases()).toEqual([true, true])
    const props = await page.evaluate(() => {
        const browser = window as Harness
        const storage = browser.__weftController!.session.storage
        const write = storage.setPair.bind(storage)
        const blocked = new Promise<void>(resolve => { browser.releaseCheckpoint = resolve })
        storage.setPair = async (...args) => {
            storage.setPair = write
            browser.holdCheckpoint = true
            await blocked
            return write(...args)
        }
        return browser.__weftEditor!.getShapeUtil('geo').getDefaultProps()
    })
    const navigate = (href: string) => page.evaluate(path => {
        const anchor = document.createElement('a')
        anchor.href = path
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
    }, href)
    try {
        const delta = {
            op: 'upsert-object', id: shapeId, objType: 'geo', props,
            transform: { x: 100, y: 200, rotation: 0 }, rendered: [],
            version: { ts: Date.now(), actor: 'peer' },
        }
        const response = await request.post(api + '/ops', {
            headers: { authorization: 'Bearer dev:e2e' },
            data: { ops: [Buffer.from(JSON.stringify(delta)).toString('base64')] },
        })
        expect(response.ok()).toBe(true)
        await page.evaluate(() => { void (window as Harness).__weftController!.session.reconcile() })
        await page.waitForFunction(() => (window as Harness).holdCheckpoint)
        await navigate('/library')
        await expect(page.locator('.tl-canvas')).toHaveCount(0)
        expect(await leases()).toEqual([true, true])
        await page.route(`**${api}/**`, route => route.abort('connectionfailed'))
        await navigate(path)
        await expect(page).toHaveURL(new RegExp(path + '$'))
    } finally {
        await page.evaluate(() => (window as Harness).releaseCheckpoint?.())
    }
    await expect.poll(() => page.evaluate(id => !!(window as Harness).__weftEditor?.getShape(id), shapeId))
        .toBe(true)
})
