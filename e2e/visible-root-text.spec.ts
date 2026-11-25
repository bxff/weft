import { expect, test } from '@playwright/test'
import { useCloudMode } from './cloud-mode'
import { devicePut, deviceToken } from './device-blob'

useCloudMode()

test('typing edits the displayed native text record', async ({ page }) => {
    const { RmDocument, createRootText, insertText, writeBlocks, linearizeRootText } =
        await import('../packages/rm-format/src/index')
    const notebook = '22222222-2222-4222-a222-222222222222'
    const pageId = 'a0b1c2d3-0000-4000-a000-000000000099'
    const author = 'aaaaaaaa-0000-4000-a000-000000000001'
    const visibleAuthor = 'bbbbbbbb-0000-4000-a000-000000000002'
    const original = RmDocument.empty(author)
    createRootText(original, { width: 100 })
    insertText(original, null, 'Hidden', { authorUuid: author })
    const earlier = original.blocks.find((b) => b.type === 'rootText')!
    const originalBytes = writeBlocks([earlier])

    const visible = RmDocument.empty(author)
    createRootText(visible, { width: 200 })
    insertText(visible, null, 'Visible', { authorUuid: visibleAuthor })
    original.resolveAuthor(visibleAuthor)
    original.blocks.push(visible.blocks.find((b) => b.type === 'rootText')!)
    await devicePut(await deviceToken(), notebook, pageId, original.serialize())

    await page.goto(`/app/${notebook}/${pageId}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const column = page.locator('.tl-shape[data-shape-type="device-text"]')
    await expect(column.locator('svg')).toContainText('Visible')
    await page.evaluate(() => {
        const editor = (window as unknown as {
            __weftEditor: { setEditingShape(id: string): void }
        }).__weftEditor
        editor.setEditingShape('shape:device-text')
    })
    await expect(column.locator('.ProseMirror')).toBeVisible()
    await page.keyboard.press('End')
    await page.keyboard.type(' edit')
    await page.keyboard.press('Escape')
    await expect(column.locator('svg')).toContainText('Visible edit')
    await expect(page.getByTestId('sync-status')).toHaveText('synced')

    await expect.poll(async () => {
        const response = await page.request.get(`/api/documents/${notebook}/pages/${pageId}/rm`)
        if (!response.ok()) return null
        const saved = RmDocument.parse(await response.body())
        return {
            text: linearizeRootText(saved.tree().rootText!).flatMap((p) => p.spans.map((s) => s.text)).join(''),
            earlier: writeBlocks([saved.blocks.find((b) => b.type === 'rootText')!]),
        }
    }).toEqual({ text: 'Visible edit', earlier: originalBytes })
})
test('typing into a native indented heading leaves its shadow style register untouched', async ({ page }) => {
    const { crdtIdKey, createRootText, deleteText, encodeStyleExtra, insertText, RmDocument } =
        await import('../packages/rm-format/src/index')
    const notebook = '22222222-2222-4222-a222-222222222222'
    const pageId = 'a0b1c2d3-0000-4000-a000-000000000098'
    const author = 'aaaaaaaa-0000-4000-a000-000000000001'
    const original = RmDocument.empty(author)
    createRootText(original)
    const opener = insertText(original, null, 'XTITLE', { authorUuid: author })
    deleteText(original, [opener], { authorUuid: author })
    const shadowKey = crdtIdKey(opener)
    const style = { value: 2, timestamp: opener, extra: encodeStyleExtra({ indent: 2 }) }
    original.rootTextBlock!.text.styles.set('0:0', style)
    original.rootTextBlock!.text.styles.set(shadowKey, style)
    await devicePut(await deviceToken(), notebook, pageId, original.serialize())

    await page.goto(`/app/${notebook}/${pageId}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    const column = page.locator('.tl-shape[data-shape-type="device-text"]')
    await page.evaluate(() => {
        const editor = (window as unknown as {
            __weftEditor: { setEditingShape(id: string): void }
        }).__weftEditor
        editor.setEditingShape('shape:device-text')
    })
    await expect(column.locator('.ProseMirror h1')).toHaveText('TITLE')
    await page.keyboard.press('End')
    await page.keyboard.type(' edit')
    await page.keyboard.press('Escape')
    await expect(column.locator('svg')).toContainText('TITLE edit')
    await expect(page.getByTestId('sync-status')).toHaveText('synced')

    const response = await page.request.get(`/api/documents/${notebook}/pages/${pageId}/rm`)
    expect(response.ok()).toBe(true)
    const saved = RmDocument.parse(await response.body())
    expect(saved.rootTextBlock!.text.styles.get(shadowKey)).toEqual(style)
})
