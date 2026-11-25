/**
 * Cloud mode E2E: the same static build flips to a hosted store via settings.
 * Runs a real weft-cloud server in dev-token mode (CLOUD_DEV_USER=1, the
 * no-Clerk-keys path). Covers sign-in gate, doc browsing, drawing, pairing.
 */

import { test, expect, type Page } from '@playwright/test'
import { startTestRelay } from './test-relay'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const USER = 'e2e-cloud-user'
const AUTH = { authorization: `Bearer dev:${USER}` }
const DOC = '55555555-5555-4555-a555-555555555555'
const PAGE = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee'

let relay: Awaited<ReturnType<typeof startTestRelay>>

test.beforeAll(async () => {
    relay = await startTestRelay()
    // seed the store as the daemon would: doc list + one notebook page
    const docs = {
        documents: [
            {
                id: DOC,
                name: 'Cloud Notebook',
                parent: '',
                type: 'notebook',
                pages: [{ id: PAGE }],
                lastModified: 1_750_000_000_000,
            },
        ],
    }
    let r = await fetch(`${relay.origin}/api/documents`, {
        method: 'PUT',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify(docs),
    })
    expect(r.ok).toBe(true)
    const bytes = readFileSync(join(__dirname, '../fixtures/ferrari-xochitl-rewritten-merge.rm'))
    r = await fetch(`${relay.origin}/api/documents/${DOC}/pages/${PAGE}/rm`, {
        method: 'PUT',
        headers: { ...AUTH, 'x-base-revision': '', 'x-client-id': 'seed' },
        body: bytes,
    })
    expect(r.ok).toBe(true)
})

test.afterAll(() => {
    relay?.stop()
})

/** Flip the SPA into cloud mode (what the settings page persists). */
async function enterCloudMode(page: Page, devUser: string | null): Promise<void> {
    await page.goto('/')
    await page.evaluate(
        ([url, user]) => {
            localStorage.setItem('weft-server-url', url!)
            if (user) localStorage.setItem('weft-dev-user', user)
            else localStorage.removeItem('weft-dev-user')
            localStorage.setItem('weft-clerk-pk', '') // disable Clerk: exercise dev-token path
            localStorage.removeItem('weft-docs-cache') // must not inherit local-mode cache
        },
        [relay.origin, devUser],
    )
    await page.reload()
}

test('signed out: cloud mode shows the sign-in gate, not the daemon error', async ({ page }) => {
    await enterCloudMode(page, null)
    await page.goto('/library')
    await expect(page.getByText('Sign in to see your notebooks')).toBeVisible()
})

test('settings: self-host server override points the app at a cloud and lists docs', async ({
    page,
}) => {
    await page.goto('/')
    await page.evaluate((user) => {
        localStorage.setItem('weft-dev-user', user)
        localStorage.setItem('weft-clerk-pk', '')
        localStorage.removeItem('weft-server-url')
        localStorage.removeItem('weft-docs-cache')
    }, USER)

    await page.goto('/settings')
    await page.getByText('Self-hosted server', { exact: true }).click()
    await page.getByTestId('cloud-url').fill(relay.origin)
    await page.getByTestId('save-connection').click()
    await page.waitForTimeout(1000)
    await page.waitForLoadState('load')

    await page.goto('/library')
    await expect(page.getByText('Cloud Notebook')).toBeVisible()
})

test('drawing in cloud mode advances the CLOUD revision', async ({ page }) => {
    const revOf = async () =>
        (
            await fetch(`${relay.origin}/api/documents/${DOC}/pages/${PAGE}/rm`, {
                headers: AUTH,
            })
        ).headers.get('x-rm-revision')
    const revBefore = await revOf()
    expect(revBefore).toBeTruthy()

    await enterCloudMode(page, USER)
    await page.goto(`/app/${DOC}/${PAGE}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced', {
        timeout: 30_000,
    })
    await expect
        .poll(async () => page.locator('.tl-shape').count(), { timeout: 30_000 })
        .toBeGreaterThan(50) // ink came from the cloud store fixture

    await page.keyboard.press('d')
    const canvas = page.locator('.tl-canvas')
    const box = (await canvas.boundingBox())!
    await page.mouse.move(box.x + 220, box.y + 220)
    await page.mouse.down()
    for (let i = 1; i <= 12; i++) {
        await page.mouse.move(box.x + 220 + i * 10, box.y + 220 + Math.sin(i) * 30)
    }
    await page.mouse.up()

    // seed revision is a content hash (blob PUT); after the edit it becomes
    // an op-head marker (`ops:<opHead>+<snapSeq>` or `snap:N`)
    await expect.poll(revOf, { timeout: 15_000 }).not.toBe(revBefore)
    expect(await revOf()).toMatch(/^(ops:\d+\+\d+|snap:\d+)$/)
})

test('pairing generates a working device token + link command', async ({ page }) => {
    await enterCloudMode(page, USER)
    await page.goto('/install')
    await page.getByTestId('generate-setup').click()
    await expect(page.locator('.installer-cmd')).toContainText('--token chd_', {
        timeout: 10_000,
    })
    const command = await page.locator('.installer-cmd').textContent()
    expect(command).toContain('bunx @bxff/weft setup')
    expect(command).toContain(`--cloud ${relay.origin}`)

    const token = /--token (chd_[a-f0-9]+)/.exec(command!)![1]!
    const viaDevice = await fetch(`${relay.origin}/api/documents`, {
        headers: { 'x-device-token': token },
    })
    expect(viaDevice.ok).toBe(true)
    const body = (await viaDevice.json()) as { documents: { name: string }[] }
    expect(body.documents.some((d) => d.name === 'Cloud Notebook')).toBe(true)
})

test('API key management UI: create, copy-once, list, revoke', async ({ page }) => {
    page.on('dialog', (d) => void d.accept())
    await enterCloudMode(page, 'keymgmt-user')
    await page.goto('/settings/keys')

    await page.getByTestId('key-label').fill('my calendar app')
    await page.getByTestId('key-create').click()

    const secret = await page.getByTestId('key-secret').textContent()
    expect(secret).toMatch(/^chk_[a-f0-9]+$/)

    // shown once; the list must not expose the full secret
    await expect(page.getByText('my calendar app')).toBeVisible()
    const bodyText = await page.locator('ul').textContent()
    expect(bodyText).not.toContain(secret!.slice(12, 30))

    const works = await page.request.get(`${relay.origin}/api/documents`, {
        headers: { 'x-api-key': secret! },
    })
    expect(works.status()).toBe(200)

    await page.getByTestId('revoke-my calendar app').click()
    await page.getByTestId('revoke-confirm').click()
    await expect(page.getByText('my calendar app')).toHaveCount(0, {
        timeout: 10_000,
    })
    const dead = await page.request.get(`${relay.origin}/api/documents`, {
        headers: { 'x-api-key': secret! },
    })
    expect(dead.status()).toBe(401)
})
