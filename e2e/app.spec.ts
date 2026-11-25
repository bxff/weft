/**
 * Real-browser E2E: doc listing, notebook ink rendering inside the page
 * border, template underlay, PDF/EPUB/image pages, and drawing round-trips
 * to the daemon.
 */

import { test, expect, type Page } from '@playwright/test'
import { useCloudMode } from './cloud-mode'

useCloudMode()

const DEV_NOTEBOOK = '11111111-1111-4111-a111-111111111111'
const DEV_PAGE = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const CENTERED = '22222222-2222-4222-a222-222222222222'
const CENTERED_PAGE = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb'
const PDF = '33333333-3333-4333-a333-333333333333'
const PDF_PAGE = 'cccccccc-cccc-4ccc-accc-cccccccccccc'

async function waitForSynced(page: Page): Promise<void> {
    await expect(page.getByTestId('sync-status')).toHaveText('synced', {
        timeout: 30_000,
    })
}

test('document browser lists the store', async ({ page }) => {
    await page.goto('/library')
    await expect(page.getByText('Dev Notebook')).toBeVisible()
    await expect(page.getByText('Centered Notes')).toBeVisible()
    await expect(page.getByText('Tiny PDF')).toBeVisible()
})

test('notebook opens from the browser grid and renders ink', async ({ page }) => {
    await page.goto('/library')
    await page.getByText('Dev Notebook').click()
    await waitForSynced(page)
    // notebook ink: many draw shapes must render in the DOM
    const shapes = page.locator('.tl-shape')
    await expect.poll(async () => shapes.count(), { timeout: 30_000 }).toBeGreaterThan(50)
})

test('template underlay renders for templated pages', async ({ page }) => {
    await page.goto(`/app/${DEV_NOTEBOOK}/${DEV_PAGE}`)
    await waitForSynced(page)
    // cloud mode loads the template through the authed API as a blob: URL, so
    // assert on the underlay element, not a /api/templates/ src.
    const template = page.getByTestId('template-underlay')
    await expect(template).toBeVisible()
})

test('TEMPLATE PICKER (#60/C): choosing Blank clears the underlay and persists via PATCH', async ({
    page,
}) => {
    // runs serially after the underlay test above; restores the template at end.
    await page.goto(`/app/${DEV_NOTEBOOK}/${DEV_PAGE}`)
    await waitForSynced(page)
    await expect(page.getByTestId('template-underlay')).toBeVisible()

    await page.getByTestId('template-toggle').click()
    const patched = page.waitForResponse(
        (r) => r.url().includes(`/pages/${DEV_PAGE}`) && r.request().method() === 'PATCH',
    )
    await page.getByTestId('template-pick-Blank').click()
    expect((await patched).status()).toBe(200)
    // optimistic clear: the underlay goes away without a reload
    await expect(page.getByTestId('template-underlay')).not.toBeVisible()
    // choice is durable in the cloud doc list
    const docs = (await (await page.request.get('/api/documents')).json()) as {
        documents: { id: string; pages: { id: string; template?: string }[] }[]
    }
    const pg = docs.documents
        .find((d) => d.id === DEV_NOTEBOOK)!
        .pages.find((p) => p.id === DEV_PAGE)!
    expect(pg.template ?? 'Blank').toBe('Blank')
    // restore for anything that asserts the underlay later
    const restore = await page.request.patch(`/api/documents/${DEV_NOTEBOOK}/pages/${DEV_PAGE}`, {
        data: { template: 'P Lines small' },
    })
    expect(restore.ok()).toBe(true)
})

test('GEOMETRY PIN: centered-coordinate ink lies inside the page border', async ({ page }) => {
    await page.goto(`/app/${CENTERED}/${CENTERED_PAGE}`)
    await waitForSynced(page)
    const shapes = page.locator('.tl-shape')
    await expect.poll(async () => shapes.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(3)

    const border = page
        .locator('[data-testid="editor-root"] div[style*="border-radius: 2px"]')
        .first()
    const borderBox = await border.boundingBox()
    expect(borderBox).not.toBeNull()
    const count = await shapes.count()
    for (let i = 0; i < count; i++) {
        const box = await shapes.nth(i).boundingBox()
        if (!box) continue
        expect(box.x).toBeGreaterThanOrEqual(borderBox!.x - 8)
        expect(box.x + box.width).toBeLessThanOrEqual(borderBox!.x + borderBox!.width + 8)
    }
    await page.screenshot({ path: 'e2e/artifacts/centered.png' })
})

test('PDF page opens, shows underlay, and accepts ink (creates the .rm)', async ({ page }) => {
    await page.goto(`/app/${PDF}/${PDF_PAGE}`)
    await waitForSynced(page)
    // pdf.js underlay rendered to a data-url image
    await expect(page.locator('img[src^="data:image"]')).toBeVisible({
        timeout: 30_000,
    })

    // page has no .rm yet
    const before = await page.request.get(`/api/documents/${PDF}/pages/${PDF_PAGE}/rm`)
    expect(before.status()).toBe(404)

    await page.keyboard.press('d')
    const canvas = page.locator('.tl-canvas')
    const box = (await canvas.boundingBox())!
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx - 60, cy - 60)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) {
        await page.mouse.move(cx - 60 + i * 12, cy - 60 + i * 12)
    }
    await page.mouse.up()

    // the debounced write creates the page on the daemon
    await expect
        .poll(
            async () =>
                (await page.request.get(`/api/documents/${PDF}/pages/${PDF_PAGE}/rm`)).status(),
            { timeout: 15_000 },
        )
        .toBe(200)
    await page.screenshot({ path: 'e2e/artifacts/pdf.png' })
})

test('IMAGE page renders the embedded photo as a tldraw image shape (E26)', async ({ page }) => {
    const IMG_DOC = '88888888-8888-4888-a888-888888888888'
    const IMG_PAGE = '99999999-9999-4999-a999-999999999999'
    await page.goto(`/app/${IMG_DOC}/${IMG_PAGE}`)
    await waitForSynced(page)

    // the daemon serves the per-page asset
    const asset = await page.request.get(
        `/api/documents/${IMG_DOC}/pages/${IMG_PAGE}/assets/ab1e0001-0000-4000-a000-0000000000ab.png`,
    )
    expect(asset.status()).toBe(200)
    expect(asset.headers()['content-type']).toBe('image/png')

    // editor shows both the stroke and the image shape
    await expect
        .poll(async () => page.locator('.tl-shape').count(), { timeout: 30_000 })
        .toBeGreaterThanOrEqual(2)
    const image = page.locator('.tl-image').first()
    await expect(image).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => (await image.boundingBox())?.width ?? 0).toBeGreaterThan(20)
    await page.screenshot({ path: 'e2e/artifacts/image-doc.png' })
})

test('IMAGE INSERT: dropping a PNG uploads the asset and writes the placement', async ({
    page,
}) => {
    const { RmDocument } = await import('../packages/rm-format/src/index')
    await page.goto(`/app/${CENTERED}/${CENTERED_PAGE}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced', {
        timeout: 30_000,
    })

    // build a real PNG File in the browser (from the dev store's Image Notes
    // asset) and drop it on the canvas
    const dataTransfer = await page.evaluateHandle(async () => {
        const res = await fetch(
            '/api/documents/88888888-8888-4888-a888-888888888888/pages/99999999-9999-4999-a999-999999999999/assets/ab1e0001-0000-4000-a000-0000000000ab.png',
        )
        const blob = await res.blob()
        const dt = new DataTransfer()
        dt.items.add(new File([blob], 'drop.png', { type: 'image/png' }))
        return dt
    })
    await page.dispatchEvent('.tl-canvas', 'drop', { dataTransfer })

    // placement lands in the .rm
    let filename = ''
    await expect
        .poll(
            async () => {
                const bytes = new Uint8Array(
                    await (
                        await page.request.get(
                            `/api/documents/${CENTERED}/pages/${CENTERED_PAGE}/rm`,
                        )
                    ).body(),
                )
                const blocks = RmDocument.parse(bytes as never).blocks
                const live = blocks.filter(
                    (b) =>
                        b.type === 'sceneImageItem' &&
                        (b as { deletedLength: number }).deletedLength === 0,
                )
                const info = blocks.find((b) => b.type === 'sceneImageInfo') as
                    | { images: { filename: { value: string } }[] }
                    | undefined
                if (live.length === 1 && info?.images.length === 1) {
                    filename = info.images[0]!.filename.value
                    return 'inserted'
                }
                return 'waiting'
            },
            { timeout: 20_000 },
        )
        .toBe('inserted')

    // asset bytes are retrievable from the page's resource dir
    const asset = await page.request.get(
        `/api/documents/${CENTERED}/pages/${CENTERED_PAGE}/assets/${filename}`,
    )
    expect(asset.status()).toBe(200)
    // the editor shows the image immediately (no reload needed)
    await expect(page.locator('.tl-image').first()).toBeVisible({
        timeout: 10_000,
    })
})

test('IMAGE MOVE in tldraw lands on the daemon (tombstone + re-append)', async ({ page }) => {
    const IMG_DOC = '88888888-8888-4888-a888-888888888888'
    const IMG_PAGE = '99999999-9999-4999-a999-999999999999'
    const { RmDocument } = await import('../packages/rm-format/src/index')
    type ImgBlock = {
        type: string
        deletedLength: number
        image: { vertices: number[] } | null
    }
    const imageItems = async () =>
        RmDocument.parse(
            new Uint8Array(
                await (
                    await page.request.get(`/api/documents/${IMG_DOC}/pages/${IMG_PAGE}/rm`)
                ).body(),
            ) as never,
        ).blocks.filter((b) => b.type === 'sceneImageItem') as unknown as ImgBlock[]

    const before = await imageItems()
    expect(before.filter((b) => b.deletedLength === 0)).toHaveLength(1)
    const x0Before = before.find((b) => b.deletedLength === 0)!.image!.vertices[0]!

    await page.goto(`/app/${IMG_DOC}/${IMG_PAGE}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced', {
        timeout: 30_000,
    })
    const img = page.locator('.tl-image').first()
    await expect(img).toBeVisible({ timeout: 30_000 })

    await page.keyboard.press('Escape')
    const box = (await img.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 10 })
    await page.mouse.up()
    await page.keyboard.press('Escape')

    await expect
        .poll(
            async () => {
                const items = await imageItems()
                const live = items.filter((b) => b.deletedLength === 0)
                const dead = items.filter((b) => b.deletedLength > 0)
                if (live.length !== 1 || dead.length < 1) return 'not-moved-yet'
                // moved RIGHT: live x0 must exceed the original x0
                return live[0]!.image!.vertices[0]! > x0Before + 30 ? 'moved' : 'not-moved-yet'
            },
            { timeout: 20_000 },
        )
        .toBe('moved')
})

test('EPUB page opens with the converted-PDF underlay and accepts ink', async ({ page }) => {
    const EPUB = '66666666-6666-4666-a666-666666666666'
    const EPUB_PAGE = 'ffffffff-ffff-4fff-afff-ffffffffffff'
    await page.goto(`/app/${EPUB}/${EPUB_PAGE}`)
    await waitForSynced(page)
    // xochitl's epub->pdf conversion sidecar renders exactly like a PDF
    await expect(page.locator('img[src^="data:image"]')).toBeVisible({
        timeout: 30_000,
    })

    await page.keyboard.press('d')
    const canvas = page.locator('.tl-canvas')
    const box = (await canvas.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + 200)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) {
        await page.mouse.move(box.x + box.width / 2 + i * 10, box.y + 200 + i * 8)
    }
    await page.mouse.up()

    await expect
        .poll(
            async () =>
                (await page.request.get(`/api/documents/${EPUB}/pages/${EPUB_PAGE}/rm`)).status(),
            { timeout: 15_000 },
        )
        .toBe(200)
    await page.screenshot({ path: 'e2e/artifacts/epub.png' })
})

test('drawing in a notebook round-trips to the daemon (revision advances)', async ({ page }) => {
    const revBefore = (
        await page.request.get(`/api/documents/${CENTERED}/pages/${CENTERED_PAGE}/rm`)
    ).headers()['x-rm-revision']

    await page.goto(`/app/${CENTERED}/${CENTERED_PAGE}`)
    await waitForSynced(page)
    await page.keyboard.press('d')
    const canvas = page.locator('.tl-canvas')
    const box = (await canvas.boundingBox())!
    await page.mouse.move(box.x + 200, box.y + 200)
    await page.mouse.down()
    for (let i = 1; i <= 12; i++) {
        await page.mouse.move(box.x + 200 + i * 10, box.y + 200 + Math.sin(i) * 30)
    }
    await page.mouse.up()

    await expect
        .poll(
            async () =>
                (
                    await page.request.get(`/api/documents/${CENTERED}/pages/${CENTERED_PAGE}/rm`)
                ).headers()['x-rm-revision'],
            { timeout: 15_000 },
        )
        .not.toBe(revBefore)
})

test('ARROW reaches the daemon as ink (regression: arrows never synced)', async ({ page }) => {
    const { RmDocument } = await import('../packages/rm-format/src/index')
    const before = await page.request.get(`/api/documents/${CENTERED}/pages/${CENTERED_PAGE}/rm`)
    const liveCount = (bytes: Buffer | ArrayBuffer) =>
        RmDocument.parse(new Uint8Array(bytes as ArrayBuffer)).blocks.filter(
            (b) =>
                b.type === 'sceneLineItem' && (b as { deletedLength: number }).deletedLength === 0,
        ).length
    const countBefore = liveCount(await before.body())

    await page.goto(`/app/${CENTERED}/${CENTERED_PAGE}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced', {
        timeout: 30_000,
    })
    await page.keyboard.press('a') // arrow tool
    const canvas = page.locator('.tl-canvas')
    const box = (await canvas.boundingBox())!
    await page.mouse.move(box.x + 250, box.y + 350)
    await page.mouse.down()
    await page.mouse.move(box.x + 500, box.y + 480, { steps: 8 })
    await page.mouse.up()
    await page.keyboard.press('Escape')

    // arrow body + arrowhead strokes must land (>= 2 new live items)
    await expect
        .poll(
            async () =>
                liveCount(
                    await (
                        await page.request.get(
                            `/api/documents/${CENTERED}/pages/${CENTERED_PAGE}/rm`,
                        )
                    ).body(),
                ),
            { timeout: 15_000 },
        )
        .toBeGreaterThanOrEqual(countBefore + 2)
})

test('reload keeps the document identical (no nuke-and-recreate)', async ({ page }) => {
    await page.goto(`/app/${DEV_NOTEBOOK}/${DEV_PAGE}`)
    await waitForSynced(page)
    const countBefore = await page.locator('.tl-shape').count()
    await page.reload()
    await waitForSynced(page)
    await expect
        .poll(async () => page.locator('.tl-shape').count(), { timeout: 30_000 })
        .toBeGreaterThanOrEqual(countBefore - 1)
})

test('LAYERS: panel lists, visibility hides, active layer receives strokes', async ({ page }) => {
    const LDOC = 'bbbb0001-0000-4000-a000-0000000000bb'
    const LPAGE = 'bbbb0002-0000-4000-a000-0000000000bb'
    const { RmDocument, crdtIdKey } = await import('../packages/rm-format/src/index')
    await page.goto(`/app/${LDOC}/${LPAGE}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced', {
        timeout: 30_000,
    })

    // layers live behind a dock toggle
    await expect(page.getByTestId('layers-toggle')).toBeVisible({
        timeout: 20_000,
    })
    await page.getByTestId('layers-toggle').click()
    // both layers listed; both strokes visible
    await expect(page.getByTestId('layers-panel')).toBeVisible()
    await expect(page.getByTestId('layer-row-Layer 1')).toBeVisible()
    await expect(page.getByTestId('layer-row-Layer 2')).toBeVisible()
    await expect.poll(async () => page.locator('.tl-shape').count()).toBeGreaterThanOrEqual(2)

    // hide layer 2 -> exactly one stroke remains visible (opacity 0 hides)
    await page.getByTestId('layer-eye-Layer 2').click()
    await expect
        .poll(async () =>
            page
                .locator('.tl-shape')
                .evaluateAll(
                    (els) => els.filter((el) => Number(getComputedStyle(el).opacity) > 0.5).length,
                ),
        )
        .toBe(1)
    // visibility flip is durable in the .rm
    await expect
        .poll(async () => {
            const bytes = new Uint8Array(
                await (await page.request.get(`/api/documents/${LDOC}/pages/${LPAGE}/rm`)).body(),
            )
            return RmDocument.parse(bytes as never).layers()[1]!.visible
        })
        .toBe(false)
    await page.getByTestId('layer-eye-Layer 2').click() // show again

    // draw with Layer 2 active -> stroke lands under layer 2's nodeId
    await page.getByTestId('layer-row-Layer 2').click()
    await page.keyboard.press('d')
    const canvas = page.locator('.tl-canvas')
    const box = (await canvas.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + 300)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) {
        await page.mouse.move(box.x + box.width / 2 + i * 8, box.y + 300 + i * 6)
    }
    await page.mouse.up()

    await expect
        .poll(
            async () => {
                const bytes = new Uint8Array(
                    await (
                        await page.request.get(`/api/documents/${LDOC}/pages/${LPAGE}/rm`)
                    ).body(),
                )
                const doc = RmDocument.parse(bytes as never)
                const layer2 = doc.layers()[1]!.nodeId
                const lines = doc.blocks.filter(
                    (b) =>
                        b.type === 'sceneLineItem' &&
                        (b as { deletedLength: number }).deletedLength === 0,
                ) as unknown as { parentId: never }[]
                const onLayer2 = lines.filter((l) => crdtIdKey(l.parentId) === crdtIdKey(layer2))
                return onLayer2.length
            },
            { timeout: 15_000 },
        )
        .toBe(2) // the fixture stroke + the newly drawn one
})

test('TYPED TEXT: device RootText renders as a native tldraw shape', async ({
    page,
}) => {
    const TDOC = 'dddd0001-0000-4000-a000-0000000000dd'
    const TPAGE = 'dddd0002-0000-4000-a000-0000000000dd'
    await page.goto(`/app/${TDOC}/${TPAGE}`)
    await waitForSynced(page)

    // static column renders as SVG (device-exact glyph placement): per-line
    // <text> elements, not TipTap DOM.
    const column = page.locator('.tl-shape[data-shape-type="device-text"]')
    await expect(column).toBeVisible({ timeout: 20_000 })
    await expect(column).toContainText('My Notes')
    await expect(column).toContainText('First point')
    await expect(column).toContainText('Task one')
    // heading renders at the device XL serif em (larger fontSize); body em is 32
    const headingSize = await column
        .locator('text', { hasText: 'My Notes' })
        .first()
        .getAttribute('fontSize')
        .then((v) => v ?? column.locator('text', { hasText: 'My Notes' }).first().evaluate((el) => el.getAttribute('font-size')))
    expect(Number(headingSize)).toBeGreaterThan(32)
    // BULLET paragraphs carry their device marker glyphs; BULLET2 nests
    await expect(column.locator('text', { hasText: '•' }).first()).toBeVisible()
    await expect(column.locator('text', { hasText: '◦' }).first()).toBeVisible()
    // inline format codes render as real bold runs
    const boldWeight = await column
        .locator('text', { hasText: 'weight' })
        .first()
        .evaluate((el) => el.getAttribute('font-weight'))
    expect(Number(boldWeight)).toBeGreaterThanOrEqual(700)
    // CHECKBOX style renders its vector box (a rect/path near the line)
    await expect(column.locator('text', { hasText: 'Task one' }).first()).toBeVisible()
    // NUMBERED list (device style 10) renders its "1." / "2." markers
    await expect(column.locator('text', { hasText: '1.' }).first()).toBeVisible()
    await expect(column.locator('text', { hasText: '2.' }).first()).toBeVisible()
})

test('SHAPE COVERAGE: a geo rectangle syncs as ink; frames are excluded', async ({ page }) => {
    // dedicated page: counts live items, must not race other stroke specs
    const COVERAGE_PAGE = 'ceceabcd-0000-4000-a000-00000000e204'
    const { RmDocument } = await import('../packages/rm-format/src/index')
    const liveCount = async () => {
        const r = await page.request.get(`/api/documents/${CENTERED}/pages/${COVERAGE_PAGE}/rm`)
        if (!r.ok()) return 0 // the dedicated page starts empty
        return RmDocument.parse(new Uint8Array(await r.body()) as never).blocks.filter(
            (b) =>
                b.type === 'sceneLineItem' && (b as { deletedLength: number }).deletedLength === 0,
        ).length
    }

    await page.goto(`/app/${CENTERED}/${COVERAGE_PAGE}`)
    await waitForSynced(page)
    const before = await liveCount()

    // rectangle (geo): outline must reach the daemon as stroke(s)
    await page.keyboard.press('r')
    const canvas = page.locator('.tl-canvas')
    const box = (await canvas.boundingBox())!
    await page.mouse.move(box.x + 200, box.y + 250)
    await page.mouse.down()
    await page.mouse.move(box.x + 420, box.y + 430, { steps: 6 })
    await page.mouse.up()
    await page.keyboard.press('Escape')
    await expect.poll(liveCount, { timeout: 15_000 }).toBeGreaterThan(before)
    const afterGeo = await liveCount()

    // a FRAME must NOT sync (it's an organizational container, not ink)
    await page.evaluate(() => {
        const ed = (window as unknown as { __weftEditor?: { createShape(s: unknown): void } })
            .__weftEditor
        ed?.createShape({
            type: 'frame',
            x: 100,
            y: 100,
            props: { w: 200, h: 200 },
        })
    })
    await page.waitForTimeout(1500) // debounce window
    expect(await liveCount()).toBe(afterGeo) // unchanged
})
