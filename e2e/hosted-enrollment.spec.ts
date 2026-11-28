import { expect, test, type Browser } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const hosted = 'https://api.weft.page'
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

test('hosted install to real pair, isolated device, capacity and revocation', async ({ browser }) => {
    // Standard suite still serves existing fixtures. Use a private child
    // relay here for real token validation and per-test capacity state.
    const scratch = mkdtempSync(join(tmpdir(), 'weft-hosted-enrollment-'))
    const child = spawn(
        join(homedir(), '.bun', 'bin', 'bun'),
        [fileURLToPath(new URL('../scripts/hosted-enrollment-e2e.ts', import.meta.url)), scratch],
        { env: {}, stdio: 'ignore' },
    )
    const exit = new Promise<void>((resolve) => {
        child.once('close', () => resolve())
        child.once('error', () => resolve())
    })
    try {
        const ready = join(scratch, 'ready.json')
        await expect
            .poll(() => existsSync(ready), { timeout: 10000, message: 'isolated enrollment relay readiness' })
            .toBe(true)
        const { port, keys } = JSON.parse(readFileSync(ready, 'utf8')) as {
            port: number
            keys: Record<string, string>
        }
        const origin = 'http://127.0.0.1:' + port
        const json = (o: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) })
        const request = (path: string, key: string, init?: RequestInit, device?: boolean) =>
            fetch(origin + path, {
                ...init,
                headers: {
                    ...init?.headers,
                    ...(device ? { 'x-device-token': key } : { authorization: 'Bearer ' + key }),
                },
            })
        async function install(b: Browser, user: string, key: string) {
            const context = await b.newContext({ baseURL: origin, serviceWorkers: 'block' })
            const page = await context.newPage()
            await page.addInitScript(
                ({ user, key, hosted }) => {
                    localStorage.setItem('weft-clerk-pk', 'pk_test_open_beta')
                    localStorage.setItem('weft-server-url', hosted)
                    Object.assign(window, {
                        __WEFT_CLERK_MOCK__: Promise.resolve({
                            user: { id: user },
                            session: { id: 'sess_' + user, getToken: async () => key },
                        }),
                    })
                },
                { user, key, hosted },
            )
            let calls = 0,
                status = 0,
                reason: unknown
            // Deny outbound traffic; the canonical pairing URL alone is forwarded
            // to the real local relay. An unexpected pairing destination is a test failure.
            const unexpectedPairPaths: string[] = []
            await page.route(
                (url) => /^https?:$/.test(url.protocol) && url.origin !== origin,
                (route) => {
                    if (/pair|invite/i.test(new URL(route.request().url()).pathname))
                        unexpectedPairPaths.push('unexpected-enrollment')
                    return route.abort()
                },
            )
            await page.route(hosted + '/api/pair', async (route) => {
                if (route.request().method() === 'OPTIONS')
                    return route.fulfill({
                        status: 204,
                        headers: {
                            'access-control-allow-origin': '*',
                            'access-control-allow-methods': 'POST',
                            'access-control-allow-headers': 'authorization,content-type',
                        },
                    })
                if (route.request().method() !== 'POST') {
                    unexpectedPairPaths.push('unexpected-enrollment-method')
                    return route.abort()
                }
                calls++
                const r = await request(
                    '/api/pair',
                    route
                        .request()
                        .headers()
                        .authorization?.replace(/^Bearer /, '') ?? '',
                    {
                        method: 'POST',
                        headers: { 'content-type': route.request().headers()['content-type'] ?? '' },
                        body: route.request().postData(),
                    },
                )
                const wire = await r.text()
                if (!r.ok) reason = JSON.parse(wire)?.reason
                status = r.status
                await route.fulfill({
                    status,
                    headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
                    body: wire,
                })
            })
            await page.goto('/install')
            const generate = page.getByRole('button', { name: 'Generate my token' })
            await expect(generate).toBeDisabled()
            expect(calls).toBe(0)
            await expect(page.getByRole('link', { name: 'Read the Hosted Terms' })).toHaveAttribute(
                'href',
                '/terms',
            )
            await page.getByRole('checkbox', { name: 'I agree to the Hosted Terms.' }).check()
            await generate.click()
            await expect.poll(() => status).toBeGreaterThan(0)
            expect(calls).toBe(1)
            expect(unexpectedPairPaths).toEqual([])
            const text = () => page.locator('.installer-cmd').textContent()
            async function issued() {
                let token: string | undefined
                await expect
                    .poll(async () => {
                        token = (await text())?.match(/ --token (chd_[\w-]+)/)?.[1]
                        return Boolean(token)
                    })
                    .toBe(true)
                return token!
            }
            return { context, page, status, reason, issued }
        }
        const enrolled = await install(browser, 'owner', keys.owner!)
        const token = await enrolled.issued()
        expect(enrolled.status).toBe(200)
        await enrolled.context.close()
        const docs = (id: string) => ({
            method: 'PUT',
            ...json({ documents: [{ id, name: id, type: 'notebook', lastModified: 10, pages: [] }] }),
        })
        expect((await request('/api/documents', keys.peer!, docs('peer-only'))).status).toBe(200)
        expect((await request('/api/documents', token, docs('tablet-only'), true)).status).toBe(200)
        const existing = await request('/api/documents', keys.owner!)
        expect((await existing.json()).documents.map((x: { id: string }) => x.id)).toEqual(['tablet-only'])
        expect(
            (await (await request('/api/documents', token, undefined, true)).json()).documents.map(
                (x: { id: string }) => x.id,
            ),
        ).toEqual(['tablet-only'])
        expect(
            (await (await request('/api/documents', keys.peer!)).json()).documents.map(
                (x: { id: string }) => x.id,
            ),
        ).toEqual(['peer-only'])
        expect((await request('/api/devices', token, undefined, true)).status).toBe(403)
        expect((await request('/api/pair', token, { method: 'POST' }, true)).status).toBe(403)
        expect((await request('/api/pair', keys.expired!, { method: 'POST' })).status).toBe(401)
        expect((await request('/api/pair', keys.owner! + 'tampered', { method: 'POST' })).status).toBe(401)

        expect(
            (
                await request(
                    '/api/documents/tablet-only/pages/p1/assets/cap.png',
                    token,
                    {
                        method: 'PUT',
                        body: new Uint8Array(8100),
                    },
                    true,
                )
            ).status,
        ).toBe(200)
        const denied = await install(browser, 'fresh', keys.fresh!)
        expect(denied.status).toBe(503)
        expect(denied.reason).toBe('capacity')
        await expect(denied.page.getByText('Server error minting token (503).')).toBeVisible()
        const list = await request('/api/devices', keys.fresh!)
        expect((await list.json()).devices).toEqual([])
        await denied.context.close()
        expect(
            (
                await request(
                    '/api/documents/tablet-only/pages/p1/assets/hard.png',
                    token,
                    {
                        method: 'PUT',
                        body: new Uint8Array(500),
                    },
                    true,
                )
            ).status,
        ).toBe(200)
        const hard = await install(browser, 'fresh', keys.fresh!)
        expect(hard.status).toBe(507)
        expect(hard.reason).toBe('capacity')
        await expect(hard.page.getByText('Server error minting token (507).')).toBeVisible()
        await hard.context.close()
        expect(
            (
                await request(
                    '/api/documents/tablet-only/pages/p1/assets/overflow.png',
                    token,
                    {
                        method: 'PUT',
                        body: new Uint8Array(1),
                    },
                    true,
                )
            ).status,
        ).toBe(507)
        expect((await request('/api/documents', token, undefined, true)).status).toBe(200)
        expect((await request('/api/documents', keys.owner!)).status).toBe(200)
        const old = await request('/api/devices', keys.owner!)
        const devices = (await old.json()).devices as { id: string }[]
        expect(devices).toHaveLength(1)
        const path = '/api/devices/' + devices[0]!.id
        expect((await request(path, keys.peer!, { method: 'DELETE' })).status).toBe(404)
        expect((await request('/api/documents', token, undefined, true)).status).toBe(200)
        expect((await request(path, keys.owner!, { method: 'DELETE' })).status).toBe(200)
        expect((await request('/api/documents', token, undefined, true)).status).toBe(401)
        expect((await request('/api/documents', keys.owner!)).status).toBe(200)
    } finally {
        child.kill('SIGTERM')
        await exit
        rmSync(scratch, { recursive: true, force: true })
    }
})
