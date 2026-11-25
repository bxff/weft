import { expect, test, type Page } from '@playwright/test'
import type { Editor } from 'tldraw'

const doc = '22222222-2222-4222-a222-222222222222'
const pageId = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb'
const oldCamera = { x: -91, y: 136, z: 1.25 }
const newCamera = { x: 45, y: -76, z: 1.4 }
const storageKey = 'weft-page-views-v1'

function zoom(page: Page) {
    return page.evaluate(() =>
        (window as Window & { __weftEditor?: Editor }).__weftEditor?.getCamera().z,
    )
}

for (const mode of ['known', 'known with a different valid token', 'pending', 'relay changed'] as const) {
    test(`Clerk camera stays scoped when the session is ${mode}`, async ({ page }) => {
        const knownAtOpen = mode.startsWith('known')
        const validPreviousToken = mode === 'known with a different valid token'
        await page.addInitScript(({ doc, pageId, oldCamera, storageKey, knownAtOpen, validPreviousToken }) => {
            localStorage.setItem('weft-server-url', location.origin)
            localStorage.setItem('weft-clerk-pk', 'pk_test_mock')
            if (!localStorage.getItem(storageKey)) {
                localStorage.setItem(storageKey, JSON.stringify([
                    { page: JSON.stringify([location.origin, 'clerk:previous-user', doc, pageId]), camera: oldCamera },
                ]))
            }
            const exp = validPreviousToken ? Date.now() / 1000 + 90 : 1
            const previous = ['header', btoa(JSON.stringify({ sub: 'previous-user', exp })), 'signature'].join('.')
            sessionStorage.setItem('weft-clerk-token', JSON.stringify({ value: previous, at: 1 }))
            ;(window as Window & { __WEFT_CLERK_MOCK__: unknown }).__WEFT_CLERK_MOCK__ = {
                user: knownAtOpen ? { id: 'current-user' } : null,
                session: { getToken: () => new Promise(() => {}) },
                addListener() {},
            }
        }, { doc, pageId, oldCamera, storageKey, knownAtOpen, validPreviousToken })

        await page.goto(`/app/${doc}/${pageId}`)
        await expect.poll(() => zoom(page)).toBeCloseTo(0.6)

        await page.evaluate(() => {
            const clerk = (window as Window & { __WEFT_CLERK_MOCK__: { user: { id: string } | null } }).__WEFT_CLERK_MOCK__
            clerk.user = { id: 'current-user' }
        })
        expect(await zoom(page)).toBeCloseTo(0.6)
        if (mode === 'relay changed') {
            await page.evaluate(() => localStorage.setItem('weft-server-url', 'https://another-relay.invalid'))
        }
        await page.evaluate(camera => {
            const editor = (window as Window & { __weftEditor: Editor }).__weftEditor
            editor.setCamera(camera, { immediate: true })
            window.dispatchEvent(new PageTransitionEvent('pagehide'))
        }, newCamera)

        const origin = new URL(page.url()).origin
        const expected = [
            { page: JSON.stringify([origin, 'clerk:previous-user', doc, pageId]), camera: oldCamera },
        ]
        if (mode !== 'relay changed') {
            expected.unshift({ page: JSON.stringify([origin, 'clerk:current-user', doc, pageId]), camera: newCamera })
        }
        expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '[]'), storageKey)).toEqual(expected)
        if (knownAtOpen) {
            await page.reload()
            await expect.poll(() => zoom(page)).toBeCloseTo(newCamera.z)
        }
    })
}

test('a valid cached Clerk session restores its camera before the SDK loads', async ({ page }) => {
    await page.route('**/clerk.example.com/**', route => route.abort())
    await page.addInitScript(({ doc, pageId, storageKey, oldCamera }) => {
        localStorage.setItem('weft-server-url', location.origin)
        localStorage.setItem('weft-clerk-pk', 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k')
        localStorage.setItem(storageKey, JSON.stringify([
            { page: JSON.stringify([location.origin, 'clerk:current-user', doc, pageId]), camera: oldCamera },
        ]))
        const claims = { sub: 'current-user', exp: Date.now() / 1000 + 90 }
        const token = ['header', btoa(JSON.stringify(claims)), 'signature'].join('.')
        sessionStorage.setItem('weft-clerk-token', JSON.stringify({ value: token, at: Date.now() }))
    }, { doc, pageId, storageKey, oldCamera })

    await page.goto(`/app/${doc}/${pageId}`)
    await expect.poll(() => zoom(page)).toBeCloseTo(oldCamera.z)
})

async function openNotebookLink(page: Page, path: string) {
    await page.evaluate(href => {
        const link = document.createElement('a')
        link.href = href
        document.body.append(link)
        link.click()
        link.remove()
    }, path)
}

test('an expired Clerk token does not lock an offline notebook on unrelated storage changes', async ({ page }) => {
    const sibling = `/app/${doc}/${crypto.randomUUID()}`
    await page.route('**/clerk.example.com/**', route => route.abort())
    await page.addInitScript(({ storageKey, doc, pageId, oldCamera }) => {
        localStorage.setItem('weft-server-url', location.origin)
        localStorage.setItem('weft-clerk-pk', 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k')
        localStorage.setItem(storageKey, JSON.stringify([
            { page: JSON.stringify([location.origin, 'clerk:current-user', doc, pageId]), camera: oldCamera },
        ]))
        const payload = btoa(JSON.stringify({ sub: 'current-user', exp: (Date.now() + 60_000) / 1000 }))
        sessionStorage.setItem('weft-clerk-token', JSON.stringify({ value: `header.${payload}.signature`, at: Date.now() }))
    }, { storageKey, doc, pageId, oldCamera })

    await page.goto(`/app/${doc}/${pageId}`)
    await expect.poll(() => zoom(page)).toBeCloseTo(oldCamera.z)
    await page.route('**/api/**', route => route.abort())
    await page.clock.setFixedTime(new Date(Date.now() + 90_000))
    await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' })))
    await expect(page.getByRole('status').filter({ hasText: 'Notebook paused' })).toHaveCount(0)
    await openNotebookLink(page, sibling)
    await expect(page).toHaveURL(new RegExp(`${sibling}$`))
    await expect.poll(() => zoom(page)).toBeCloseTo(0.6)
})

for (const reason of ['different account', 'sign-out'] as const) {
    test(`a confirmed Clerk ${reason} keeps the notebook locked until its owner returns`, async ({ page }) => {
        const source = `/app/${doc}/${pageId}`
        const sibling = `/app/${doc}/${crypto.randomUUID()}`
        await page.addInitScript(() => {
            localStorage.setItem('weft-server-url', location.origin)
            localStorage.setItem('weft-clerk-pk', 'pk_test_mock')
            ;(window as Window & { __WEFT_CLERK_MOCK__: unknown }).__WEFT_CLERK_MOCK__ = {
                user: { id: 'current-user' },
                session: { getToken: () => new Promise(() => {}) },
                addListener() {},
            }
        })
        await page.goto(source)
        await expect.poll(() => zoom(page)).toBeCloseTo(0.6)
        const setIdentity = (identity: string) => page.evaluate(identity => {
            const clerk = (window as Window & {
                __WEFT_CLERK_MOCK__: { user?: { id: string } | null; session?: object | null }
            }).__WEFT_CLERK_MOCK__
            clerk.user = identity === 'signed-out' ? null : identity === 'unknown' ? undefined : { id: identity }
            clerk.session = identity === 'signed-out' ? null : { getToken: () => new Promise(() => {}) }
            window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }))
        }, identity)
        const paused = page.getByRole('status').filter({ hasText: 'Notebook paused' })
        await setIdentity(reason === 'sign-out' ? 'signed-out' : 'other-user')
        await expect(paused).toBeVisible()
        await setIdentity('unknown')
        await expect(paused).toBeVisible()
        await openNotebookLink(page, sibling)
        await expect(page).toHaveURL(new RegExp(`${source}$`))
        await setIdentity('current-user')
        await expect(paused).toHaveCount(0)
        await openNotebookLink(page, sibling)
        await expect(page).toHaveURL(new RegExp(`${sibling}$`))
    })
}
