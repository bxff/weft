import { expect, test } from '@playwright/test'

test('a direct notebook URL with a trailing slash hydrates without serving its shell to asset fetches', async ({
    page, baseURL,
}) => {
    const origin = new URL(baseURL!).origin
    const failedAssets: string[] = []
    page.on('response', response => {
        const url = new URL(response.url())
        if (url.origin === origin && url.pathname.startsWith('/_app/') && !response.ok()) {
            failedAssets.push(`${response.status()} ${url.pathname}`)
        }
    })
    await page.addInitScript((relay) => {
        localStorage.setItem('weft-server-url', relay)
        localStorage.setItem('weft-clerk-pk', '')
        localStorage.setItem('weft-dev-user', 'notebook-shell-test')
    }, origin)

    const path = `/app/${crypto.randomUUID()}/${crypto.randomUUID()}/`
    const response = await page.goto(path)
    expect(response?.status()).toBe(200)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    expect(failedAssets).toEqual([])

    const resourceStatus = await page.evaluate(async (url) => {
        return (await fetch(url, { headers: { accept: 'text/html' } })).status
    }, path)
    expect(resourceStatus).toBe(404)
    expect((await page.request.get('/assets/extensionless', { headers: { accept: 'text/html' } })).status()).toBe(404)
})
