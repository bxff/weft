import { expect, test } from '@playwright/test'
import { CLOUD_ORIGIN, E2E_USER, useCloudMode } from './cloud-mode'
import { devicePut, deviceToken } from './device-blob'
import {
    createRootText,
    encodeStyleExtra,
    insertText,
    linearizeRootText,
    RmDocument,
} from '../packages/rm-format/src/index'
useCloudMode()
for (const c of [
    { style: 1, indent: 1, marker: '◦' },
    { style: 1, indent: 2, marker: '-' },
    { style: 5, indent: undefined, marker: '◦' },
    { style: 1, indent: 2, marker: '1.', convert: true },
])
    test(JSON.stringify(c), async ({ page, browser }) => {
        const notebook = '22222222-2222-4222-a222-222222222222'
        const pid = `4321c2d3-0000-4000-a000-00000000000${c.convert ? 4 : (c.indent ?? 3)}`
        const author = 'aaaaaaaa-0000-4000-a000-000000000001'
        const source = RmDocument.empty(author)
        createRootText(source)
        const opener = insertText(source, null, 'Indented native paragraph', {
            authorUuid: author,
        })
        source.rootTextBlock!.text.styles.set('0:0', {
            value: c.style,
            timestamp: opener,
            extra: encodeStyleExtra({ indent: c.indent }),
        })
        await devicePut(await deviceToken(), notebook, pid, source.serialize())
        const url = '/app/' + notebook + '/' + pid,
            rm = '/api/documents/' + notebook + '/pages/' + pid + '/rm'
        const read = async () => {
            const res = await page.request.get(rm)
            expect(res.ok()).toBe(true)
            const d = RmDocument.parse(await res.body()),
                root = d.tree().rootText!
            const para = linearizeRootText(root)[0]!
            const reg = root.styles.get('0:0')
            return {
                text: para.spans.map((s) => s.text).join(''),
                style: para.style,
                indent: para.indentLevel,
                extra: Array.from(reg?.extra ?? []),
            }
        }
        const before = await read()
        expect(before).toMatchObject({
            text: 'Indented native paragraph',
            style: c.style,
            indent: c.indent,
        })
        await page.goto(url)
        const column = page.locator('.tl-shape[data-shape-type="device-text"]')
        await expect(column.locator('svg')).toContainText('Indented native paragraph')
        await page.evaluate(() => {
            const editor = (
                window as unknown as {
                    __weftEditor: { setEditingShape(id: string): void }
                }
            ).__weftEditor
            editor.setEditingShape('shape:device-text')
        })
        await expect(column.locator('.ProseMirror')).toBeVisible()
        await page.keyboard.press('End')
        await page.keyboard.type(' edit')
        if (c.convert) {
            await page.keyboard.press('Home')
            await page.keyboard.press('Shift+End')
            await page.getByTestId('rich-text.orderedList').click()
        }
        await page.keyboard.press('Escape')
        await expect
            .poll(async () => await read())
            .toMatchObject({
                text: 'Indented native paragraph edit',
                style: c.convert ? 10 : c.style,
            })
        const after = await read()
        const context = await browser.newContext({
            extraHTTPHeaders: { authorization: 'Bearer dev:' + E2E_USER },
        })
        try {
            const fresh = await context.newPage()
            await fresh.addInitScript(
                ([origin, user]) => {
                    localStorage.setItem('weft-server-url', origin!)
                    localStorage.setItem('weft-dev-user', user!)
                    localStorage.setItem('weft-clerk-pk', '')
                },
                [CLOUD_ORIGIN, E2E_USER],
            )
            await fresh.goto(CLOUD_ORIGIN + url)
            const svg = fresh.locator('.tl-shape[data-shape-type="device-text"] svg')
            await expect(svg).toContainText('Indented native paragraph edit')
            await expect(svg.locator('text').first()).toHaveText(c.marker)
        } finally {
            await context.close()
        }
        expect(after).toEqual({
            ...before,
            text: 'Indented native paragraph edit',
            style: c.convert ? 10 : c.style,
        })
    })
