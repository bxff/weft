import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import type { Editor, TLShapeId } from 'tldraw'
import { RmDocument, linearizeRootText } from '../packages/rm-format/src/index'

declare global {
    interface Window {
        __weftEditor: Editor
    }
}

const textId = 'shape:stock-marks' as TLShapeId

async function openNotebook(
    context: BrowserContext,
    page: Page,
    origin: string,
    doc: string,
    sheet: string,
) {
    await context.addInitScript((base) => {
        localStorage.setItem('weft-server-url', base)
        localStorage.setItem('weft-dev-user', 'e2e')
        localStorage.setItem('weft-clerk-pk', '')
    }, origin)
    await page.goto(`/app/${doc}/${sheet}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
}

test('stock text renders SDK marks and reopens with the edited marks', async ({
    page,
    context,
    browser,
    request,
    baseURL,
}) => {
    const doc = crypto.randomUUID()
    const sheet = crypto.randomUUID()
    await openNotebook(context, page, baseURL!, doc, sheet)
    const richText = {
        type: 'doc',
        content: [
            {
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'Code', marks: [{ type: 'code' }] },
                    {
                        type: 'text',
                        text: ' formatted',
                        marks: [{ type: 'strike' }, { type: 'underline' }],
                    },
                    {
                        type: 'text',
                        text: ' link',
                        marks: [{ type: 'link', attrs: { href: 'https://example.com/' } }],
                    },
                    {
                        type: 'text',
                        text: ' both',
                        marks: [{ type: 'bold' }, { type: 'italic' }],
                    },
                ],
            },
        ],
    }
    await page.evaluate(
        ({ id, value }) => {
            const editor = window.__weftEditor
            editor.createShape({
                id,
                type: 'text',
                x: 100,
                y: 150,
                props: { richText: value },
            })
        },
        { id: textId, value: richText },
    )
    const text = page.locator('[data-shape-type="text"]')
    await expect(text.locator('code').first()).toHaveText('Code')
    await expect(text.locator('s u, u s').first()).toHaveText('formatted')
    await expect(text.locator('a[href="https://example.com/"]').first()).toHaveText('link')
    await expect(text.locator('strong em, em strong').first()).toHaveText('both')

    await page.evaluate((id) => {
        const editor = window.__weftEditor
        editor.select(id)
        editor.zoomToSelection()
        editor.setEditingShape(id)
    }, textId)
    const editable = text.locator('.ProseMirror')
    await expect(editable).toBeFocused()
    await expect(page.getByTestId('rich-text.highlight')).toBeAttached()
    await page.evaluate(() =>
        window.__weftEditor
            .getRichTextEditor()!
            .chain()
            .setTextSelection({ from: 21, to: 25 })
            .toggleHighlight()
            .run(),
    )
    await expect(editable.locator('mark')).toHaveText('both')
    await page.keyboard.press('Escape')
    await expect(editable).toHaveCount(0)
    const edited = await page.evaluate((id) => {
        const shape = window.__weftEditor.getShape(id)
        return shape?.type === 'text' && shape.props.richText
    }, textId)
    await expect
        .poll(async () => {
            const result = await request.get(`/api/documents/${doc}/pages/${sheet}/overlay`, {
                headers: { authorization: 'Bearer dev:e2e' },
            })
            if (!result.ok()) return null
            return (await result.json()).shapes.find(
                (shape: { shapeId: string }) => shape.shapeId === textId,
            )?.props.richText
        })
        .toEqual(edited)

    const peer = await browser.newContext()
    try {
        const reader = await peer.newPage()
        await openNotebook(peer, reader, baseURL!, doc, sheet)
        await expect
            .poll(() =>
                reader.evaluate((id) => {
                    const shape = window.__weftEditor.getShape(id)
                    return shape?.type === 'text' && shape.props.richText
                }, textId),
            )
            .toEqual(edited)
        await expect(reader.locator('[data-shape-type="text"] mark').first()).toHaveText('both')
        const reopened = reader.locator('[data-shape-type="text"]')
        await expect(reopened.locator('code').first()).toHaveText('Code')
        await expect(reopened.locator('s u, u s').first()).toHaveText('formatted')
        await expect(reopened.locator('a[href="https://example.com/"]').first()).toHaveText('link')
        await expect(reopened.locator('strong em, em strong').last()).toHaveText('both')
    } finally {
        await peer.close()
    }
})

test('the native column keeps tablet-compatible marks across shortcuts and paste', async ({
    page,
    context,
    request,
    baseURL,
}) => {
    const doc = crypto.randomUUID()
    const sheet = crypto.randomUUID()
    await openNotebook(context, page, baseURL!, doc, sheet)
    await page.evaluate(async () => {
        const controller = (
            window as unknown as {
                __weftController: { editRootText(operation: unknown): Promise<void> }
            }
        ).__weftController
        await controller.editRootText({
            create: {},
            inserts: [{ afterKey: null, text: 'Test' }],
        })
        window.__weftEditor.setEditingShape('shape:device-text' as TLShapeId)
    })
    const column = page.locator('[data-shape-type="device-text"] .ProseMirror')
    await expect(column).toBeFocused()
    await page.evaluate(() => window.__weftEditor.getRichTextEditor()!.commands.selectAll())
    const modifier = await page.evaluate(() =>
        /Mac/.test(navigator.platform) ? 'Meta' : 'Control',
    )
    await page.keyboard.press(`${modifier}+b`)
    await expect(column.locator('strong')).toHaveText('Test')
    await page.keyboard.press(`${modifier}+i`)
    await expect(column.locator('em')).toHaveText('Test')
    await expect(column.locator('strong')).toHaveCount(0)
    await expect(page.getByTestId('rich-text.code')).toHaveCount(0)

    await page.evaluate(() => {
        const editor = window.__weftEditor.getRichTextEditor()!
        editor.commands.setTextSelection(5)
        const clipboard = new DataTransfer()
        clipboard.setData(
            'text/html',
            ' <u><s><code><a href="https://example.com/">plain</a></code></s></u> <strong>bold</strong>',
        )
        editor.view.dom.dispatchEvent(
            new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: clipboard,
            }),
        )
    })
    await expect(column).toHaveText('Testplain bold')
    await expect(column.locator('u, s, code, a')).toHaveCount(0)
    await expect(column.locator('strong')).toHaveText('bold')
    await page.evaluate(() => {
        const editor = window.__weftEditor.getRichTextEditor()!
        editor.commands.setTextSelection({ from: 5, to: 10 })
        const clipboard = new DataTransfer()
        clipboard.setData('text/plain', 'https://example.com/')
        editor.view.dom.dispatchEvent(
            new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: clipboard,
            }),
        )
    })
    await expect(column).toHaveText('Testhttps://example.com/ bold')
    await expect(column.locator('a')).toHaveCount(0)
    await page.evaluate(() => {
        const editor = window.__weftEditor.getRichTextEditor()!
        editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    })
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('#### body')
    await expect(column.locator('p').last()).toHaveText('#### body')
    await page.keyboard.press('Escape')
    await expect
        .poll(async () => {
            const response = await request.get(`/api/documents/${doc}/pages/${sheet}/rm`, {
                headers: { authorization: 'Bearer dev:e2e' },
            })
            if (!response.ok()) return null
            const root = RmDocument.parse(new Uint8Array(await response.body())).tree().rootText
            return (
                root &&
                linearizeRootText(root).map((paragraph) =>
                    paragraph.spans.map(({ text, bold, italic }) => [text, bold, italic]),
                )
            )
        })
        .toEqual([
            [
                ['Testhttps://example.com/', false, true],
                [' ', false, false],
                ['bold', true, false],
            ],
            [['#### body', false, false]],
        ])
})

test('native HTML paste preserves mark precedence and break spacing', async ({
    page,
    context,
    baseURL,
}) => {
    await openNotebook(context, page, baseURL!, crypto.randomUUID(), crypto.randomUUID())
    await page.evaluate(async () => {
        const controller = (
            window as unknown as {
                __weftController: { editRootText(operation: unknown): Promise<void> }
            }
        ).__weftController
        await controller.editRootText({ create: {}, inserts: [{ afterKey: null, text: 'Test' }] })
        window.__weftEditor.setEditingShape('shape:device-text' as TLShapeId)
    })
    const column = page.locator('[data-shape-type="device-text"] .ProseMirror')
    await expect(column).toBeFocused()
    await page.evaluate(() => {
        const editor = window.__weftEditor.getRichTextEditor()!
        editor.commands.selectAll()
        const clipboard = new DataTransfer()
        clipboard.setData(
            'text/html',
            '<p><strong><em>italic</em></strong> <em><strong>bold</strong></em></p>' +
                '<p><strong>one<br>two</strong></p><p><strong>last<br></strong></p>',
        )
        editor.view.dom.dispatchEvent(
            new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: clipboard,
            }),
        )
    })
    const paragraphs = column.locator('p')
    await expect(paragraphs.nth(0).locator('em')).toHaveText('italic')
    await expect(paragraphs.nth(0).locator('strong')).toHaveText('bold')
    expect(await paragraphs.nth(1).locator('strong').allTextContents()).toEqual(['one two'])
    expect(await paragraphs.nth(2).textContent()).toBe('last')
})

for (const shape of ['device-text', 'text'] as const) {
    test(`${shape} typing keeps the expected bold and italic delimiter behavior`, async ({
        page,
        context,
        baseURL,
    }) => {
        await openNotebook(context, page, baseURL!, crypto.randomUUID(), crypto.randomUUID())
        await page.evaluate(
            async ({ shape, id }) => {
                const editor = window.__weftEditor
                if (shape === 'text') {
                    editor.createShape({ id, type: 'text', x: 100, y: 150 })
                    editor.setEditingShape(id)
                } else {
                    const controller = (
                        window as unknown as {
                            __weftController: { editRootText(operation: unknown): Promise<void> }
                        }
                    ).__weftController
                    await controller.editRootText({
                        create: {},
                        inserts: [{ afterKey: null, text: 'Test' }],
                    })
                    editor.setEditingShape('shape:device-text' as TLShapeId)
                }
            },
            { shape, id: textId },
        )
        const editable = page.locator(`[data-shape-type="${shape}"] .ProseMirror`)
        await expect(editable).toBeFocused()
        const modifier = await page.evaluate(() =>
            /Mac/.test(navigator.platform) ? 'Meta' : 'Control',
        )
        for (const [key, typed, mark, opposingMark] of [
            ['i', ' **bold**', 'em', 'strong'],
            ['b', ' *italic*', 'strong', 'em'],
        ] as const) {
            await page.evaluate(() => {
                const editor = window.__weftEditor.getRichTextEditor()!
                editor.commands.setContent('<p>Test</p>')
                editor.commands.setTextSelection(5)
                editor.commands.unsetAllMarks()
            })
            await page.keyboard.press(`${modifier}+${key}`)
            await page.keyboard.type(typed)
            if (shape === 'device-text') {
                expect(await editable.locator(mark).textContent()).toBe(typed)
                await expect(editable.locator(opposingMark)).toHaveCount(0)
            } else {
                await expect(
                    editable.locator(`${mark} ${opposingMark}, ${opposingMark} ${mark}`),
                ).toHaveText(typed.replaceAll('*', '').trim())
            }
        }
    })
}
