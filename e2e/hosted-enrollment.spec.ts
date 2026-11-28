import { expect, test, type BrowserContext } from '@playwright/test'
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
    const contexts = new Set<BrowserContext>()
    const child = spawn(
        join(homedir(), '.bun', 'bin', 'bun'),
        // An empty environment is not enough: Bun normally loads cwd's dotenv files.
        ['--no-env-file', fileURLToPath(new URL('../scripts/hosted-enrollment-e2e.ts', import.meta.url)), scratch],
        { cwd: fileURLToPath(new URL('../', import.meta.url)), env: {}, stdio: 'ignore' },
    )
    const exit = new Promise<true>((resolve) => {
        child.once('close', () => resolve(true))
        child.once('error', () => resolve(true))
    })
    const exitedWithin = async (ms: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            return await Promise.race([
                exit,
                new Promise<false>((resolve) => {
                    timer = setTimeout(() => resolve(false), ms)
                }),
            ])
        } finally {
            clearTimeout(timer)
        }
    }
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
        async function devices(key: string): Promise<{ id: string }[]> {
            const r = await request('/api/devices', key)
            expect(r.status).toBe(200)
            return (await r.json()).devices
        }
        async function install(user: string, key: string) {
            const context = await browser.newContext({ baseURL: origin, serviceWorkers: 'block' })
            contexts.add(context)
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
            // Browser may load only the install page and its loopback static
            // assets. The one canonical hosted transfer is routed explicitly;
            // even a same-origin /api/* request is unexpected.
            let unexpected = 0
            await context.route(/^https?:\/\//, async (route) => {
                const req = route.request()
                const url = new URL(req.url())
                const method = req.method()
                if (
                    method === 'GET' &&
                    url.origin === origin &&
                    (url.pathname === '/install' || /^\/(?:_app|fonts)\//.test(url.pathname))
                )
                    return route.continue()
                if (url.href !== hosted + '/api/pair' || method !== 'POST') {
                    unexpected++
                    return route.abort()
                }
                calls++
                const r = await fetch(origin + '/api/pair', {
                    method,
                    headers: {
                        authorization: req.headers().authorization ?? '',
                        'content-type': req.headers()['content-type'] ?? '',
                    },
                    body: req.postData(),
                    redirect: 'error',
                })
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
            expect(await devices(key)).toEqual([])
            await expect(page.getByRole('link', { name: 'Read the Hosted Terms' })).toHaveAttribute(
                'href',
                '/terms',
            )
            await page.getByRole('checkbox', { name: 'I agree to the Hosted Terms.' }).check()
            await generate.click()
            await expect.poll(() => status).toBeGreaterThan(0)
            expect(calls).toBe(1)
            expect(unexpected).toBe(0)
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
            return {
                page,
                status,
                reason,
                issued,
                close: async () => {
                    await context.close()
                    contexts.delete(context)
                    expect(unexpected).toBe(0)
                },
            }
        }
        const enrolled = await install('owner', keys.owner!)
        const token = await enrolled.issued()
        expect(enrolled.status).toBe(200)
        await enrolled.close()
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
        const denied = await install('fresh', keys.fresh!)
        expect(denied.status).toBe(503)
        expect(denied.reason).toBe('capacity')
        await expect(denied.page.getByText('Server error minting token (503).')).toBeVisible()
        expect(await devices(keys.fresh!)).toEqual([])
        await denied.close()
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
        const hard = await install('fresh', keys.fresh!)
        expect(hard.status).toBe(507)
        expect(hard.reason).toBe('capacity')
        await expect(hard.page.getByText('Server error minting token (507).')).toBeVisible()
        await hard.close()
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
        const paired = await devices(keys.owner!)
        expect(paired).toHaveLength(1)
        const path = '/api/devices/' + paired[0]!.id
        expect((await request(path, keys.peer!, { method: 'DELETE' })).status).toBe(404)
        expect((await request('/api/documents', token, undefined, true)).status).toBe(200)
        expect((await request(path, keys.owner!, { method: 'DELETE' })).status).toBe(200)
        expect((await request('/api/documents', token, undefined, true)).status).toBe(401)
        expect((await request('/api/documents', keys.owner!)).status).toBe(200)
    } finally {
        child.kill('SIGTERM')
        let stopped = await exitedWithin(1500)
        if (!stopped) {
            child.kill('SIGKILL')
            stopped = await exitedWithin(1500)
        }
        rmSync(scratch, { recursive: true, force: true })
        await Promise.allSettled([...contexts].map((context) => context.close()))
        if (!stopped) throw Error('isolated enrollment relay did not stop after SIGKILL')
    }
})
