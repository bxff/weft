/**
 * D8 text repair end-to-end: a real browser seeds a text shape, "the tablet"
 * erases a glyph's ink (device-token PUT of tombstoned `.rm`, same as
 * FakeDaemon.tabletErase), and the live session reconciles it two ways:
 *
 *   1. TRAILING erase ("abcd" - "d") => repairs to "abc", stays editable text.
 *   2. MIDDLE erase   ("abcd" - "b") => detaches (frozen, "re-attach / keep
 *      as ink"), never silently reflows to "acd".
 */

import { test, expect, type Page } from '@playwright/test'
import type { Editor } from 'tldraw'
import { useCloudMode, CLOUD_ORIGIN, E2E_USER } from './cloud-mode'
import { eraseItemsInRm, type OverlayShapeJson, type ItemRef } from './tablet-erase'
import type { OverlayDocument } from '../packages/sync-engine/src/types'

// each test uses a dedicated blank page id so a tablet erase never crosses specs
useCloudMode()

const DOC = '22222222-2222-4222-a222-222222222222'
const TRAILING_PAGE = 'ceceabcd-0000-4000-a000-00000000d801'
const MIDDLE_PAGE = 'ceceabcd-0000-4000-a000-00000000d802'
const FREEZE_PAGE = 'ceceabcd-0000-4000-a000-00000000d803'

const AUTH = { authorization: `Bearer dev:${E2E_USER}` }

/** Mint a device token via the web pairing flow ("the tablet" identity). */
async function deviceToken(): Promise<string> {
    const r = await fetch(`${CLOUD_ORIGIN}/api/pair`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'd8-e2e-tablet' }),
    })
    if (!r.ok) throw new Error(`pair failed: ${r.status}`)
    return ((await r.json()) as { token: string }).token
}

let TABLET_TOKEN: string
test.beforeAll(async () => {
    TABLET_TOKEN = await deviceToken()
})

async function synced(page: Page): Promise<void> {
    await expect(page.getByTestId('sync-status')).toHaveText('synced', {
        timeout: 30_000,
    })
}

/** Seed an editable text shape by typing it into a fresh page, escape to commit. */
async function seedText(page: Page, url: string, text: string): Promise<void> {
    await page.goto(url)
    await synced(page)
    await page.keyboard.press('t')
    const canvas = page.locator('.tl-canvas')
    const box = (await canvas.boundingBox())!
    await page.mouse.click(box.x + box.width / 2 - 60, box.y + 240)
    await page.keyboard.type(text, { delay: 40 })
    await page.keyboard.press('Escape')
}

/** Poll GET /overlay until the text shape has projected all `glyphCount` glyphs. */
async function textOverlay(page: Page, pageId: string, glyphCount: number): Promise<OverlayShapeJson> {
    let shape: OverlayShapeJson | undefined
    await expect
        .poll(
            async () => {
                const r = await page.request.get(`/api/documents/${DOC}/pages/${pageId}/overlay`)
                if (!r.ok()) return -1
                const body = (await r.json()) as { shapes: OverlayShapeJson[] }
                shape = body.shapes.find((s) => s.kind === 'text')
                const glyphs = shape?.rendered.filter((p) => /^glyph:\d+$/.test(p.partKey)) ?? []
                return glyphs.length
            },
            { timeout: 30_000 },
        )
        .toBe(glyphCount)
    return shape!
}

/** Fetch current `.rm` bytes + revision for a page. */
async function getRm(page: Page, pageId: string): Promise<{ bytes: Uint8Array; revision: string }> {
    const r = await page.request.get(`/api/documents/${DOC}/pages/${pageId}/rm`)
    expect(r.ok()).toBe(true)
    const revision = r.headers()['x-rm-revision'] ?? ''
    return { bytes: new Uint8Array(await r.body()), revision }
}

/** Simulate the tablet erasing `items`: tombstone in `.rm`, PUT as a device. */
async function tabletErase(page: Page, pageId: string, items: ItemRef[]): Promise<void> {
    const { bytes, revision } = await getRm(page, pageId)
    const erased = await eraseItemsInRm(bytes, items)
    const put = await fetch(`${CLOUD_ORIGIN}/api/documents/${DOC}/pages/${pageId}/rm`, {
        method: 'PUT',
        headers: {
            'content-type': 'application/octet-stream',
            'x-device-token': TABLET_TOKEN,
            'x-base-revision': revision,
        },
        body: erased,
    })
    expect(put.ok).toBe(true)
}

const glyphItems = (shape: OverlayShapeJson, index: number): ItemRef[] =>
    shape.rendered.find((p) => p.partKey === `glyph:${index}`)!.items

test('adopting repeated tablet move snapshots repositions text without drawing its ink twice', async ({ page }) => {
    const { encodeSnapshot } = await import('../packages/sync-engine/src/snapshot')
    const { RM_SCALE } = await import('../packages/rm-ink/src/pen')
    const pageId = crypto.randomUUID()
    await seedText(page, `/app/${DOC}/${pageId}`, 'ab')
    const shape = await textOverlay(page, pageId, 2)
    const readView = () => page.evaluate((shapeId) => {
        const { __weftEditor: editor } = window as unknown as { __weftEditor: Editor }
        const shapes = editor.getCurrentPageShapes()
        return {
            x: shapes.find((candidate) => candidate.id === shapeId)?.x,
            looseInkCount: shapes.filter((candidate) => candidate.type === 'draw').length,
        }
    }, shape.shapeId)
    const before = await readView()
    expect(before.x).toBeDefined()
    expect(before.looseInkCount).toBe(0)

    const { bytes } = await getRm(page, pageId)
    const { RmDocument, crdtId } = await import('../packages/rm-format/src/index')
    const rm = RmDocument.parse(bytes)
    const overlayResponse = await page.request.get(`/api/documents/${DOC}/pages/${pageId}/overlay`)
    expect(overlayResponse.ok()).toBe(true)
    const overlay = await overlayResponse.json() as OverlayDocument
    let strokes = shape.rendered.flatMap((part) => part.items)
        .map((ref) => crdtId(rm.resolveAuthor(ref.authorUuid), ref.clock))
    let totalDx = 0
    for (const dx of [226, 113]) {
        strokes = strokes.map((id) => {
            const source = rm.findLineItem(id)!
            const replacement = rm.appendLine({
                ...source.line!,
                moveId: source.line!.moveId ?? id,
                points: source.line!.points.map((point) => ({ ...point, x: point.x + dx })),
            }, { authorUuid: 'cdcd0001-0000-4000-a000-0000000000cd', parentId: source.parentId })
            expect(rm.tombstone(id)).toBe(true)
            return replacement.itemId
        })
        const put = await page.request.put(`/api/documents/${DOC}/pages/${pageId}/snapshot`, {
            data: Buffer.from(encodeSnapshot(rm.serialize(), overlay)),
            headers: { 'content-type': 'application/octet-stream' },
        })
        expect(put.ok()).toBe(true)
        totalDx += dx
        // Native points round to Float32 on serialization. Keep a subpixel
        // tolerance on the inferred move, but require exact ink ownership.
        await expect.poll(async () => {
            const { x, looseInkCount } = await readView()
            return {
                atExpectedX: x !== undefined && Math.abs(x - (before.x! + totalDx * RM_SCALE)) < 0.001,
                looseInkCount,
            }
        }).toEqual({ atExpectedX: true, looseInkCount: 0 })
    }
})

test('TRAILING erase: "abcd" − "d" repairs to "abc" and stays editable text', async ({ page }) => {
    await seedText(page, `/app/${DOC}/${TRAILING_PAGE}`, 'abcd')
    const shape = await textOverlay(page, TRAILING_PAGE, 4)

    const textShape = page.locator('.tl-shape[data-shape-type="text"]')
    await expect(textShape).toContainText('abcd')

    await tabletErase(page, TRAILING_PAGE, glyphItems(shape, 3))

    await expect(textShape).toContainText('abc', { timeout: 30_000 })
    await expect(textShape).not.toContainText('abcd')

    // still one editable text shape, not flagged detached
    await expect(page.locator('.tl-shape[data-shape-type="text"]')).toHaveCount(1)
    await page.locator('.tl-shape[data-shape-type="text"]').click()
    await expect(page.getByText('Edited on tablet — shape detached')).toHaveCount(0)

    await page.locator('.tl-shape[data-shape-type="text"]').dblclick()
    await expect(page.locator('.tl-text-input, [contenteditable="true"]').first()).toBeVisible({
        timeout: 10_000,
    })
})

test('trailing erase preserves heading and inline marks after reopening', async ({ page }) => {
    const pageId = crypto.randomUUID()
    const url = `/app/${DOC}/${pageId}`
    await page.goto(url)
    await synced(page)
    const heading = {
        type: 'heading', attrs: { level: 2 },
        content: [{ type: 'text', text: 'ab', marks: [{ type: 'bold' }] }],
    }
    const marked = { type: 'text', text: 'cd', marks: [{ type: 'italic' }] }
    const richText = { type: 'doc', content: [heading, { type: 'paragraph', content: [marked] }] }
    await page.evaluate((richText) => {
        const { __weftEditor: editor } = window as unknown as { __weftEditor: Editor }
        editor.createShape({ type: 'text', x: 100, y: 100, props: { richText } })
    }, richText)
    const shape = await textOverlay(page, pageId, 4)
    await tabletErase(page, pageId, glyphItems(shape, 4)) // ab\ncd

    await textOverlay(page, pageId, 3)
    await page.reload()
    await synced(page)
    const repaired = await page.evaluate((id) => {
        const { __weftEditor: editor } = window as unknown as { __weftEditor: Editor }
        const shape = editor.getCurrentPageShapes().find(shape => shape.id === id)
        return shape?.type === 'text' ? shape.props.richText : null
    }, shape.shapeId)
    expect(repaired).toEqual({
        type: 'doc', content: [heading, { type: 'paragraph', content: [{ ...marked, text: 'c' }] }],
    })
})

test('MIDDLE erase: "abcd" − "b" DETACHES (frozen + surfaced), never reflowed', async ({ page }) => {
    await seedText(page, `/app/${DOC}/${MIDDLE_PAGE}`, 'abcd')
    const shape = await textOverlay(page, MIDDLE_PAGE, 4)

    const textShape = page.locator('.tl-shape[data-shape-type="text"]')
    await expect(textShape).toContainText('abcd')

    // a MIDDLE erase (a hole, not a suffix)
    await tabletErase(page, MIDDLE_PAGE, glyphItems(shape, 1))

    // in op-mode, detach is a client-local reconcile decision (never shipped
    // to the relay), so the live browser view is the authoritative witness
    await expect(page.getByText('Edited on tablet — shape detached')).toBeVisible({
        timeout: 30_000,
    })

    // survives as a frozen text shape, not reflowed to "acd"/"abd"
    await expect(page.locator('.tl-shape[data-shape-type="text"]')).toHaveCount(1)
    await expect(textShape).not.toContainText('acd')
    await expect(textShape).not.toContainText('abd')

    await expect(page.getByText('Edited on tablet — shape detached')).toBeVisible()
    await expect(page.getByRole('button', { name: /re-attach/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /keep as ink/i })).toBeVisible()
})

test('detach releases ink ownership, freezes the shape (no resurrection), re-attach reclaims', async ({
    page,
}) => {
    await seedText(page, `/app/${DOC}/${FREEZE_PAGE}`, 'abcd')
    const shape = await textOverlay(page, FREEZE_PAGE, 4)

    await tabletErase(page, FREEZE_PAGE, glyphItems(shape, 1))
    await expect(page.getByText('Edited on tablet — shape detached')).toBeVisible({
        timeout: 30_000,
    })

    // detach releases ownership of surviving strokes: a/c/d render as raw
    // ink alongside the ghost, not just the ghost alone
    const surviving = [0, 2, 3].flatMap((i) => glyphItems(shape, i)).length
    await expect(page.locator('.tl-shape[data-shape-type="draw"]')).toHaveCount(surviving, {
        timeout: 15_000,
    })
    const opacity = await page.evaluate(() => {
        const ed = (
            window as unknown as { __weftController: { editor: import('tldraw').Editor } }
        ).__weftController.editor
        return ed.getCurrentPageShapes().find((s) => s.type === 'text')?.opacity
    })
    expect(opacity).toBe(0.25)

    // the frozen shape must never re-project on its own: poke the ghost
    // with a real drag and check the page revision holds still (any client
    // push bumps it)
    const { revision: before } = await getRm(page, FREEZE_PAGE)
    const box = (await page.locator('.tl-shape[data-shape-type="text"]').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 25, { steps: 5 })
    await page.mouse.up()
    await page.waitForTimeout(2000) // > debounce + flush window
    const { revision: after } = await getRm(page, FREEZE_PAGE)
    expect(after).toBe(before)
    await expect(page.getByText('Edited on tablet — shape detached')).toBeVisible()

    // re-attach: re-renders as source of truth (erased "b" returns by
    // design), reclaims the loose ink, restores full opacity
    await page.getByRole('button', { name: /re-attach/i }).click()
    await expect(page.locator('.tl-shape[data-shape-type="draw"]')).toHaveCount(0, {
        timeout: 15_000,
    })
    await expect(page.getByText('Edited on tablet — shape detached')).toHaveCount(0)
    await expect
        .poll(async () => (await getRm(page, FREEZE_PAGE)).revision)
        .not.toBe(before)
})

test('guarded erase parks while newer browser text is waiting for projection', async ({ page }) => {
    test.skip(process.env.PUBLIC_GUARDED_SAVES !== '1', 'Requires the guarded build')
    const pageId = crypto.randomUUID()
    await seedText(page, `/app/${DOC}/${pageId}`, 'ABCD')
    const shape = await textOverlay(page, pageId, 4)
    await synced(page)
    const prior = await page.evaluate(shapeId => {
        const w = window as any
        const controller = w.__weftController
        const editor = w.__weftEditor as Editor
        const previousFont = controller.font
        controller.font = null
        const hold = new Promise(resolve => {
            w.releaseGuardedProjection = () => {
                controller.font = previousFont
                resolve(previousFont)
            }
        })
        controller.ensureFont = () => {
            w.waitingForGuardedProjection = true
            return hold
        }
        editor.updateShape({
            id: shapeId as never, type: 'text',
            props: { richText: { type: 'doc', content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'XYZW' }] },
            ] } },
        })
        editor.store._flushHistory()
        return [controller.session.lastSnapshotSeq, controller.session.opCursor] as [number, number]
    }, shape.shapeId)
    await expect.poll(() => page.evaluate(() => !!(window as any).waitingForGuardedProjection)).toBe(true)
    expect(await page.evaluate(shapeId => {
        const c = (window as any).__weftController
        return [c.pendingShapeIds.has(shapeId), c.session.pendingCount]
    }, shape.shapeId)).toEqual([true, 0])

    await tabletErase(page, pageId, glyphItems(shape, 3))
    await expect.poll(() => page.evaluate(([snapshotSeq, cursor]) => {
        const s = (window as any).__weftController.session
        return s.lastSnapshotSeq > snapshotSeq || s.opCursor > cursor
    }, prior)).toBe(true)
    const text = page.locator('.tl-shape[data-shape-type="text"]')
    await expect(text).toHaveText('XYZW')
    expect(await page.evaluate(shapeId => (window as any).__weftController.session.parkedRepairs.has(shapeId), shape.shapeId)).toBe(true)
    await page.evaluate(() => (window as any).releaseGuardedProjection())
    await synced(page)
    await expect.poll(() => page.evaluate(shapeId => {
        const c = (window as any).__weftController
        return [c.pendingShapeIds.has(shapeId), c.session.pendingCount, c.session.parkedRepairs.has(shapeId)]
    }, shape.shapeId)).toEqual([false, 0, false])
    const remote = await page.request.get(`/api/documents/${DOC}/pages/${pageId}/overlay`)
    expect(remote.ok()).toBe(true)
    const overlay = await remote.json() as OverlayDocument
    const saved = overlay.shapes.find(entry => entry.shapeId === shape.shapeId)
    expect(saved?.props).toHaveProperty('richText.content.0.content.0.text', 'XYZW')
    await page.reload()
    await expect(text).toHaveText('XYZW')
})
