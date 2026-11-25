// A page/doc switch must reuse the same tldraw editor instance (no remount),
// swapping only page content. Tags the live editor, SPA-navigates to another
// doc, and checks the tag survived with the new page's shapes present.
import { test, expect, type Page } from '@playwright/test'
import { useCloudMode } from './cloud-mode'

useCloudMode()

const DOC1 = '/app/11111111-1111-4111-a111-111111111111/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const DOC2 = '/app/22222222-2222-4222-a222-222222222222/bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb'

test('page switch reuses the editor (no remount) and swaps content', async ({ page }) => {
    // tldraw's cdn.tldraw.com embed-icon preload 404s/CORS-fails in the
    // sandbox; ignore that noise and only track real app/runtime errors.
    const ignore = (t: string) =>
        /cdn\.tldraw\.com|embed-icons|Failed to load resource|ERR_FAILED|CORS policy|Failed to fetch|NetworkError/i.test(
            t,
        )
    const errors: string[] = []
    page.on('console', (m) => {
        if (m.type() === 'error' && !ignore(m.text())) errors.push(m.text())
    })
    page.on('pageerror', (e) => {
        if (!ignore(String(e))) errors.push(String(e))
    })

    await page.goto(DOC1)
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30000 })

    const before = await page.evaluate(() => {
        const w = window as unknown as { __weftEditor?: { getCurrentPageShapeIds(): Set<string> } }
        ;(w.__weftEditor as unknown as { __tag?: string }).__tag = 'persist-check'
        return w.__weftEditor!.getCurrentPageShapeIds().size
    })
    expect(before).toBeGreaterThan(0)

    // SPA-navigate via a clicked anchor so SvelteKit's router intercepts it
    // (a page.goto would force a real reload and defeat the test)
    await page.evaluate((href) => {
        const a = document.createElement('a')
        a.href = href
        a.textContent = 'go'
        document.body.appendChild(a)
        a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    }, DOC2)
    await expect(page).toHaveURL(new RegExp('/app/22222222'), { timeout: 15000 })
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30000 })

    // 'synced' can precede the initial paint by a microtask, so poll the count
    const readAfter = () =>
        page.evaluate(() => {
            const w = window as unknown as {
                __weftEditor?: { getCurrentPageShapeIds(): Set<string>; __tag?: string }
            }
            return { tag: w.__weftEditor!.__tag, count: w.__weftEditor!.getCurrentPageShapeIds().size }
        })
    await expect.poll(async () => (await readAfter()).count, { timeout: 15000 }).toBeGreaterThan(0)
    const after = await readAfter()
    expect(after.tag).toBe('persist-check') // same editor instance: not remounted

    expect(errors, errors.join('\n')).toEqual([])
})

// A page switch during a still-in-flight prior session-open must not leak
// that session's ink onto the page now shown.
async function spaNav(page: import('@playwright/test').Page, href: string) {
    await page.evaluate((h) => {
        const a = document.createElement('a')
        a.href = h
        document.body.appendChild(a)
        a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    }, href)
}

async function activeRoute(page: Page, href: string) {
    await expect.poll(() => page.evaluate(() => {
        const controller = (window as unknown as {
            __weftController?: { opts: { docId: string; pageId: string } }
        }).__weftController
        if (controller) return `/app/${controller.opts.docId}/${controller.opts.pageId}`
    })).toBe(href)
}

async function delayNextPendingWrite(page: Page) {
    await page.evaluate(() => {
        const w = window as any
        const storage = w.__weftController.session.storage
        const set = storage.set.bind(storage)
        storage.set = async (key: string, value: Uint8Array) => {
            if (key.includes('/pending/')) {
                storage.set = set
                await new Promise<void>(resolve => { w.__releaseStorage = resolve })
            }
            return set(key, value)
        }
    })
}

test('an edit immediately followed by a page switch survives reopening', async ({ page }) => {
    await page.goto(DOC1)
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30000 })
    const id = 'shape:departure-edit'
    await page.evaluate(({ id, href }) => {
        const editor = (window as unknown as {
            __weftEditor: { createShape(shape: unknown): void }
        }).__weftEditor
        editor.createShape({ id, type: 'geo', x: 150, y: 240,
            props: { geo: 'rectangle', w: 123, h: 87, dash: 'solid' } })
        const link = document.createElement('a')
        link.href = href
        document.body.appendChild(link)
        link.click()
    }, { id, href: DOC2 })
    await expect(page).toHaveURL(new RegExp('/app/22222222'))
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30000 })
    await spaNav(page, DOC1)
    await expect(page).toHaveURL(new RegExp('/app/11111111'))
    await expect.poll(() => page.evaluate(id => {
        const editor = (window as unknown as {
            __weftEditor: { getShape(id: string): { props: { w: number } } | undefined }
        }).__weftEditor
        return editor.getShape(id)?.props.w
    }, id)).toBe(123)
})

test('failed local persistence keeps the outgoing page and retries without losing the edit', async ({ page }) => {
    await page.goto(DOC1)
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30000 })
    await page.evaluate(href => {
        const w = window as any
        const storage = w.__weftController.session.storage
        const set = storage.set.bind(storage)
        w.__restoreStorage = () => { storage.set = set }
        storage.set = (key: string, value: unknown) => key.includes('/pending/')
            ? Promise.reject(new Error('injected storage failure')) : set(key, value)
        w.__weftEditor.createShape({ id: 'shape:failed-departure', type: 'geo', x: 150, y: 240,
            props: { geo: 'rectangle', w: 127, h: 87 } })
        const link = document.createElement('a')
        link.href = href
        document.body.appendChild(link)
        link.click()
    }, DOC2)
    await expect(page.getByRole('alert')).toContainText('could not be saved')
    await expect(page).toHaveURL(new RegExp('/app/11111111'))
    await page.evaluate(() => (window as any).__restoreStorage())
    await spaNav(page, DOC2)
    await expect(page).toHaveURL(new RegExp('/app/22222222'))
    await spaNav(page, DOC1)
    await expect.poll(() => page.evaluate(() => (window as any).__weftEditor
        ?.getShape('shape:failed-departure')?.props.w)).toBe(127)
})

test('a failed toolbar layer write stays on the page and retries without losing visibility', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(DOC1)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await page.getByRole('button', { name: 'layers', exact: true }).click()
    const eye = page.getByTestId('layers-panel').getByRole('button', { name: 'hide', exact: true }).first()
    const eyeId = (await eye.getAttribute('data-testid'))!
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.evaluate(() => {
        const w = window as any
        const storage = w.__weftController.session.storage
        const set = storage.set.bind(storage)
        w.__restoreStorage = () => { storage.set = set }
        storage.set = (key: string, value: unknown) => key.includes('/pending/')
            ? new Promise<void>((_, reject) => {
                w.__failLayerWrite = () => {
                    storage.set = () => Promise.reject(new Error('injected layer storage failure'))
                    reject(new Error('injected layer storage failure'))
                }
            }) : set(key, value)
    })
    await eye.click()
    await page.waitForFunction(() => !!(window as any).__failLayerWrite)
    await spaNav(page, DOC2)
    await expect(page.getByRole('alert')).toContainText('Saving your latest edits')
    await page.evaluate(() => (window as any).__failLayerWrite())
    await expect(page.getByRole('alert')).toContainText('could not be saved')
    await activeRoute(page, DOC1)
    await page.evaluate(() => (window as any).__restoreStorage())
    await spaNav(page, DOC2)
    await activeRoute(page, DOC2)
    await spaNav(page, DOC1)
    await activeRoute(page, DOC1)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const layers = page.getByTestId('layers-panel')
    if (!(await layers.isVisible())) await page.getByRole('button', { name: 'layers', exact: true }).click()
    await expect(page.getByTestId(eyeId)).toHaveText('show')
    expect(errors).toEqual([])
    await page.getByTestId(eyeId).click()
    await expect(page.getByTestId(eyeId)).toHaveText('hide')
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
})

test('a completed layer write cannot repaint through a disposed controller', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(DOC1)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await delayNextPendingWrite(page)
    await page.evaluate(() => {
        const w = window as any
        const outgoing = w.__weftController
        const setVisible = outgoing.setLayerVisible.bind(outgoing)
        outgoing.setLayerVisible = (...args: unknown[]) => w.__layerWork = setVisible(...args)
    })
    await page.getByRole('button', { name: 'layers', exact: true }).click()
    await page.getByTestId('layers-panel').getByTestId(/^layer-eye-/).first().click()
    await page.waitForFunction(() => !!(window as any).__releaseStorage)
    await page.evaluate(() => {
        // Force the old controller's disposal before its already-started
        // command resumes. The next route reuses the same tldraw editor.
        const w = window as any
        const outgoing = w.__weftController
        const visibility = outgoing.applyLayerVisibility.bind(outgoing)
        w.__lateVisibilityCalls = 0
        outgoing.applyLayerVisibility = () => { w.__lateVisibilityCalls++; visibility() }
        outgoing.dispose()
    })
    await spaNav(page, DOC2)
    await activeRoute(page, DOC2)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await page.evaluate(async () => {
        const w = window as any
        w.__releaseStorage()
        await w.__layerWork
    })
    expect(await page.evaluate(() => (window as any).__lateVisibilityCalls)).toBe(0)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
})

test('back and forward keep unsaved edits and do not add history entries', async ({ page }) => {
    await page.goto(DOC1)
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30000 })
    await spaNav(page, DOC2)
    await expect(page).toHaveURL(new RegExp('/app/22222222'))
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30000 })
    await activeRoute(page, DOC2)
    const historyLength = await page.evaluate(() => history.length)
    await page.evaluate(() => {
        ;(window as any).__weftEditor.createShape({ id: 'shape:back-departure', type: 'geo',
            x: 150, y: 240, props: { geo: 'rectangle', w: 131, h: 87 } })
        history.back()
    })
    await activeRoute(page, DOC1)
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30000 })
    await page.evaluate(() => history.forward())
    await activeRoute(page, DOC2)
    await expect.poll(() => page.evaluate(() => (window as any).__weftEditor
        ?.getShape('shape:back-departure')?.props.w)).toBe(131)
    expect(await page.evaluate(() => history.length)).toBe(historyLength)
})

test('an edit made while IndexedDB is saving also survives the same departure', async ({ page }) => {
    await page.goto(DOC1)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await delayNextPendingWrite(page)
    await page.evaluate(href => {
        const w = window as any
        w.__weftEditor.createShape({ id: 'shape:save-first', type: 'geo', x: 150, y: 240,
            props: { geo: 'rectangle', w: 135, h: 87 } })
        const link = document.createElement('a')
        link.href = href
        document.body.appendChild(link)
        link.click()
    }, DOC2)
    await page.waitForFunction(() => !!(window as any).__releaseStorage, undefined, { timeout: 5000 })
    await activeRoute(page, DOC1)
    await page.evaluate(() => {
        const w = window as any
        w.__weftEditor.createShape({ id: 'shape:save-second', type: 'geo', x: 350, y: 240,
            props: { geo: 'rectangle', w: 137, h: 87 } })
        w.__releaseStorage()
    })
    await activeRoute(page, DOC2)
    await spaNav(page, DOC1)
    await activeRoute(page, DOC1)
    await expect.poll(() => page.evaluate(() => {
        const editor = (window as any).__weftEditor
        return ['shape:save-first', 'shape:save-second'].map(id => editor.getShape(id)?.props.w)
    })).toEqual([135, 137])
})

test.describe('navigation with unavailable resources', () => {
    // The guard also runs when a route module has not been cached yet. Hold
    // that request at the browser route boundary before the worker controls it.
    test.use({ serviceWorkers: 'block' })

    test('a failed label font keeps the page open and the label survives a navigation retry', async ({ page }) => {
        let fontAvailable = false
        await page.route('**/fonts/ShantellSans.ttf', route => fontAvailable
            ? route.continue()
            : route.fulfill({ status: 503, body: '' }))
        await page.goto(DOC1)
        await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30000 })
        const id = 'shape:departure-label'
        await page.evaluate((id) => {
            const editor = (window as any).__weftEditor
            editor.createShape({ id, type: 'geo', props: {
                richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep me' }] }] },
            } })
        }, id)
        await spaNav(page, DOC2)
        await expect(page.getByRole('alert')).toContainText('could not be saved')
        await expect(page).toHaveURL(new RegExp(DOC1))
        fontAvailable = true
        await spaNav(page, DOC2)
        await activeRoute(page, DOC2)
        await spaNav(page, DOC1)
        await activeRoute(page, DOC1)
        await expect.poll(() => page.evaluate(id =>
            (window as any).__weftEditor.getShape(id)?.props.richText.content[0].content[0].text, id)).toBe('Keep me')
    })

    for (const outcome of ['commit', 'supersede'] as const) {
        test(`a clean editor blocks input during lazy departure (${outcome})`, async ({ page }) => {
            await page.goto(DOC1)
            await expect(page.getByTestId('sync-status')).toHaveText('synced')
            await activeRoute(page, DOC1)
            const shapeIds = () => page.evaluate(() =>
                [...(window as any).__weftEditor.getCurrentPageShapeIds()] as string[])
            const before = new Set(await shapeIds())
            await page.evaluate(() => {
                const editor = (window as any).__weftEditor
                editor.focus()
                editor.setCurrentTool('draw')
            })
            const canvas = (await page.locator('.tl-canvas').boundingBox())!
            let release!: () => void
            const loading = new Promise<void>(resolve => { release = resolve })
            let requested = false
            const route = '**/_app/immutable/nodes/*.js'
            await page.route(route, async request => {
                requested = true
                await loading
                await request.continue()
            })
            try {
                await spaNav(page, '/library')
                await expect.poll(() => requested).toBe(true)
                await activeRoute(page, DOC1)
                await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
                await page.mouse.down()
                await page.mouse.move(canvas.x + canvas.width / 2 + 70, canvas.y + canvas.height / 2 + 25, { steps: 2 })
                await page.mouse.up()
                const late = (await shapeIds()).filter(id => !before.has(id))
                await page.keyboard.press('ControlOrMeta+a')
                await page.keyboard.press('Delete')
                expect(new Set(await shapeIds())).toEqual(new Set([...before, ...late]))
                if (outcome === 'supersede') {
                    await spaNav(page, DOC1 + '?stay=1')
                    await expect(page).toHaveURL(/\?stay=1$/)
                    release()
                } else {
                    release()
                    await expect(page).toHaveURL(/\/library$/)
                    await spaNav(page, DOC1)
                }
                await activeRoute(page, DOC1)
                await expect.poll(() => page.locator('.tl-canvas').evaluate(el =>
                    el.closest('[inert]') !== null)).toBe(false)
                if (outcome === 'commit' && late.length > 0) {
                    // If the outgoing editor accepts input, it must survive disposal.
                    await expect.poll(async () => (await shapeIds()).filter(id => late.includes(id))).toEqual(late)
                }
                expect(late).toEqual([])
            } finally {
                release()
                await page.unroute(route)
            }
        })
    }
})

for (const inkEdit of ['move', 'delete'] as const) {
    test(`RootText save retains same-turn geometry and native ink ${inkEdit} on departure`, async ({ page }) => {
        const from = `/app/11111111-1111-4111-a111-111111111111/${crypto.randomUUID()}`
        const seeded = await page.request.get(DOC1.replace('/app/', '/api/documents/').replace(/\/([^/]+)$/, '/pages/$1/rm'))
        const [doc, key] = from.split('/').slice(2)
        expect((await page.request.put(`/api/documents/${doc}/pages/${key}/rm`, { data: await seeded.body() })).ok()).toBe(true)
        await page.goto(from)
        await expect(page.getByTestId('sync-status')).toHaveText('synced')
        const read = () => page.evaluate(() => {
            const editor = (window as any).__weftEditor
            return {
                geo: editor.getShape('shape:root-text-late-geo')?.props.w ?? null,
                ink: editor.getCurrentPageShapes().filter((shape: any) => shape.meta.rmBrush)
                    .map((shape: any) => Math.round(shape.x)).sort((a: number, b: number) => a - b) as number[],
            }
        })
        await expect.poll(async () => (await read()).ink.length).toBeGreaterThan(0)
        const before = (await read()).ink
        await delayNextPendingWrite(page)
        await page.evaluate(() => {
            const w = window as any
            w.__rootTextWrite = w.__weftController.editRootText({ create: {} })
        })
        await page.waitForFunction(() => !!(window as any).__releaseStorage)
        await spaNav(page, DOC2)
        await expect(page.getByRole('alert')).toContainText('Saving your latest edits')
        const changedInkX = await page.evaluate((edit) => {
            const w = window as any
            const editor = w.__weftEditor
            const ink = editor.getCurrentPageShapes().find((shape: any) => shape.meta.rmBrush)
            editor.createShape({ id: 'shape:root-text-late-geo', type: 'geo', x: 150, y: 240,
                props: { geo: 'rectangle', w: 139, h: 87 } })
            if (edit === 'move') editor.updateShape({ id: ink.id, type: 'draw', x: ink.x + 160 })
            else editor.deleteShapes([ink.id])
            w.__releaseStorage()
            return Math.round(ink.x)
        }, inkEdit)
        await activeRoute(page, DOC2)
        await spaNav(page, from)
        await activeRoute(page, from)
        const expectedInk = [...before]
        expectedInk.splice(expectedInk.indexOf(changedInkX), 1)
        if (inkEdit === 'move') expectedInk.push(changedInkX + 160)
        expectedInk.sort((a, b) => a - b)
        await expect.poll(read).toEqual({ geo: 139, ink: expectedInk })
    })
}

test('departure completes active device text editing and waits for font and local storage', async ({ page }) => {
    const from = `/app/11111111-1111-4111-a111-111111111111/${crypto.randomUUID()}`
    await page.goto(from)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await page.evaluate(async () => {
        const w = window as any
        await w.__weftController.editRootText({ create: {} })
        w.__weftEditor.setEditingShape('shape:device-text')
    })
    const column = page.locator('.tl-shape[data-shape-type="device-text"]')
    await expect(column.locator('.ProseMirror')).toBeVisible()
    await page.keyboard.type('Saved before departure')
    await expect(page.getByTestId('sync-status')).toHaveText('synced')

    await delayNextPendingWrite(page)
    await page.evaluate(() => {
        const w = window as any
        const controller = w.__weftController
        const ensureFont = controller.ensureFont.bind(controller)
        controller.ensureFont = async () => {
            controller.ensureFont = ensureFont
            await new Promise<void>(resolve => { w.__releaseFont = resolve })
            return ensureFont()
        }
    })
    await spaNav(page, DOC2)
    await page.waitForFunction(() => !!(window as any).__releaseFont, undefined, { timeout: 5000 })
    await activeRoute(page, from)
    await page.evaluate(() => (window as any).__releaseFont())
    await page.waitForFunction(() => !!(window as any).__releaseStorage, undefined, { timeout: 5000 })
    await activeRoute(page, from)
    await page.evaluate(() => (window as any).__releaseStorage())
    await activeRoute(page, DOC2)
    await expect(column).toHaveCount(0)
    await spaNav(page, from)
    await activeRoute(page, from)
    await expect(column).toContainText('Saved before departure')
    await page.reload()
    await expect(column).toContainText('Saved before departure')
})

test('repeated Back while saving keeps the intended entry when the URL occurs twice', async ({ page }) => {
    await page.goto(DOC1)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const first = await page.evaluate(() => history.state)
    await spaNav(page, DOC2)
    await activeRoute(page, DOC2)
    const middle = await page.evaluate(() => history.state)
    await spaNav(page, DOC1)
    await activeRoute(page, DOC1)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const latest = await page.evaluate(() => history.state)
    expect(latest).not.toEqual(first)
    const historyLength = await page.evaluate(() => history.length)
    await delayNextPendingWrite(page)
    await page.evaluate(() => {
        ;(window as any).__weftEditor.createShape({ id: 'shape:repeat-back', type: 'geo',
            x: 100, y: 240, props: { geo: 'rectangle', w: 149, h: 87 } })
        history.back()
    })
    await page.waitForFunction(() => !!(window as any).__releaseStorage, undefined, { timeout: 5000 })
    await expect.poll(() => page.evaluate(() => history.state)).toEqual(latest)
    await page.evaluate(() => {
        const w = window as any
        w.__repeatPops = 0
        function countPop() {
            w.__repeatPops++
            if (w.__repeatPops === 2) window.removeEventListener('popstate', countPop)
        }
        window.addEventListener('popstate', countPop)
        history.back()
    })
    await page.waitForFunction(() => (window as any).__repeatPops === 2)
    expect(await page.evaluate(() => history.state)).toEqual(latest)
    await page.evaluate(() => (window as any).__releaseStorage())
    await activeRoute(page, DOC2)
    expect(await page.evaluate(() => history.state)).toEqual(middle)
    expect(await page.evaluate(() => history.length)).toBe(historyLength)
    await page.evaluate(() => history.forward())
    await activeRoute(page, DOC1)
    expect(await page.evaluate(() => history.state)).toEqual(latest)
    await expect.poll(() => page.evaluate(() => (window as any).__weftEditor
        ?.getShape('shape:repeat-back')?.props.w)).toBe(149)
})

test('rapid switching during session-open does not leak or cross-paint', async ({ page }) => {
    const errors: string[] = []
    const ignore = (t: string) =>
        /cdn\.tldraw\.com|embed-icons|Failed to load resource|ERR_FAILED|CORS policy|Failed to fetch|NetworkError|merge-type|content-script/i.test(
            t,
        )
    page.on('console', (m) => {
        if (m.type() === 'error' && !ignore(m.text())) errors.push(m.text())
    })
    page.on('pageerror', (e) => {
        if (!ignore(String(e))) errors.push(String(e))
    })

    await page.goto(DOC1)
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30000 })

    // bounce without awaiting settle: each switch fires while the prior
    // open is mid-flight (the leak window)
    for (const href of [DOC2, DOC1, DOC2, DOC1, DOC2]) {
        await spaNav(page, href)
        await page.waitForTimeout(60)
    }
    await expect(page).toHaveURL(new RegExp('/app/22222222'), { timeout: 15000 })
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30000 })

    await expect
        .poll(
            async () =>
                page.evaluate(
                    () =>
                        (
                            window as unknown as {
                                __weftEditor?: { getCurrentPageShapeIds(): Set<string> }
                            }
                        ).__weftEditor?.getCurrentPageShapeIds().size ?? 0,
                ),
            { timeout: 15000 },
        )
        .toBeGreaterThan(0)
    expect(errors, errors.join('\n')).toEqual([])
})
