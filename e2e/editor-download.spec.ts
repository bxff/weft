import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

test('a notebook opens its sync connection during the editor download and can recover if the download fails', async ({ context, page, baseURL }) => {
    await context.addInitScript(url => {
        localStorage.setItem('weft-server-url', url)
        localStorage.setItem('weft-clerk-pk', '')
        localStorage.setItem('weft-dev-user', 'test-editor-download')
    }, baseURL!)
    const path = '/app/' + crypto.randomUUID() + '/' + crypto.randomUUID()
    await page.goto(path)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const moduleUrl = await page.evaluate(() => performance.getEntriesByType('resource')
        .map(entry => entry as PerformanceResourceTiming)
        .filter(entry => entry.name.endsWith('.js'))
        .sort((a, b) => b.decodedBodySize - a.decodedBodySize)[0]!.name)

    await page.close()
    const fresh = await context.newPage()
    const gate = Promise.withResolvers<void>()
    const waiting = Promise.withResolvers<void>()
    await fresh.route(moduleUrl, async route => {
        waiting.resolve()
        await gate.promise
        await route.abort()
    })
    const socket = fresh.waitForEvent('websocket', { predicate: ws => new URL(ws.url()).pathname === '/ws' })
    try {
        await fresh.goto(path, { waitUntil: 'domcontentloaded' })
        await waiting.promise
        await socket
        expect(await fresh.locator('.tl-canvas').count()).toBe(0)
    } finally {
        gate.resolve()
    }
    await expect(fresh.getByRole('alert').filter({ hasText: 'Could not load the editor' })).toBeVisible()
    await expect.poll(() => fresh.evaluate(async () => (await navigator.locks.query()).held
        ?.some(lock => lock.name?.endsWith('/use') && lock.clientId &&
            lock.name.includes(location.pathname.slice('/app/'.length))))).toBe(false)
    await fresh.unroute(moduleUrl)
    await fresh.getByRole('button', { name: 'Reload page' }).click()
    await expect(fresh.getByTestId('sync-status')).toHaveText('synced')
})
