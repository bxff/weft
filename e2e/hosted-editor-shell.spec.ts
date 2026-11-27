import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'

test('Pages-style clean URLs still let the offline worker install', async ({ page, request }) => {
    const shell = '/app/shell/shell.html'
    const cleanShell = '/app/shell/shell'
    const paths = ['/service-worker.js', '/_app/env.js', shell]
    const assets = new Map(await Promise.all(paths.map(async (path) => {
        const response = await request.get(path)
        expect(response.ok()).toBe(true)
        return [path, { body: await response.body(), type: response.headers()['content-type']! }] as const
    })))
    const requests: string[] = []
    const server = createServer((req, res) => {
        const path = req.url ?? ''
        requests.push(path)
        if (path === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Weft</title>')
        } else if (path === shell) {
            res.writeHead(308, { Location: cleanShell }).end()
        } else {
            const asset = assets.get(path === cleanShell ? shell : path)
            if (asset) res.writeHead(200, { 'Content-Type': asset.type }).end(asset.body)
            else res.writeHead(404).end()
        }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
        await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
        await page.evaluate(async () => { await navigator.serviceWorker.register('/service-worker.js') })
        await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 5_000 })
        expect(requests).toContain(shell)
        expect(requests).toContain(cleanShell)
        expect(await page.evaluate(async (path) => {
            const response = await caches.match(path)
            return response ? { redirected: response.redirected, type: response.headers.get('content-type') } : null
        }, shell)).toEqual({ redirected: false, type: expect.stringContaining('text/html') })
    } finally {
        await page.close()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
})

test('opening a notebook through the static SPA fallback does not throw', async ({ page, baseURL, request }) => {
    await page.addInitScript((origin) => {
        localStorage.setItem('weft-server-url', origin)
        localStorage.setItem('weft-dev-user', 'e2e')
        localStorage.setItem('weft-clerk-pk', '')
    }, baseURL!)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const path = '/app/22222222-2222-4222-a222-222222222222/bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb'
    const fallback = await request.get('/')
    expect(fallback.ok()).toBe(true)
    // Cloudflare serves index.html for a direct notebook URL, unlike the relay.
    await page.route(new URL(path, baseURL).href, (route) => route.fulfill({ response: fallback }))
    await page.goto(path)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    expect(errors).toEqual([])
})
