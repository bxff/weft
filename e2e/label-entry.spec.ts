import { expect, test, type Locator, type Page } from '@playwright/test'
import type { Editor } from 'tldraw'
import { useCloudMode } from './cloud-mode'

useCloudMode()

const DOC = '22222222-2222-4222-a222-222222222222'

async function openPage(page: Page) {
    await page.goto(`/app/${DOC}/${crypto.randomUUID()}`)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
}

async function pointInLabel(label: Locator, offset: number) {
    return label.evaluate((element, offset) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        const node = walker.nextNode()
        if (!node) throw new Error('Missing label text')
        const range = document.createRange()
        range.setStart(node, offset)
        range.collapse(true)
        const rect = range.getBoundingClientRect()
        return { x: rect.left, y: (rect.top + rect.bottom) / 2 }
    }, offset)
}

async function typeKeys(page: Page, value: string) {
    for (const key of value) await page.keyboard.press(key, { delay: 45 })
}

async function openLabel(page: Page, point: { x: number; y: number }) {
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await page.waitForTimeout(25)
    await page.mouse.up()
    await page.waitForTimeout(55)
    await page.mouse.down({ clickCount: 2 })
    await page.waitForTimeout(25)
    await page.mouse.up({ clickCount: 2 })
}

for (const kind of ['text', 'geo', 'note'] as const) {
    test(`a normal double click lets fast typing replace the ${kind} label`, async ({ page }) => {
        await openPage(page)
        await page.evaluate((kind) => {
            const { __weftEditor: editor } = window as Window & { __weftEditor: Editor }
            const { x, y } = editor.screenToPage({ x: 500, y: 300 })
            editor.createShape({
                type: kind,
                x,
                y,
                props: {
                    richText: {
                        type: 'doc',
                        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'old label' }] }],
                    },
                },
            })
            editor.setCurrentTool('select')
            editor.selectNone()
            editor.focus()
        }, kind)
        const shape = page.locator(`.tl-shape[data-shape-type="${kind}"]`)
        const point = await pointInLabel(shape.getByText('old label', { exact: true }).first(), 2)
        await openLabel(page, point)
        await typeKeys(page, 'wxyz')
        await page.keyboard.press('Escape')
        await expect(shape).toHaveText('wxyz')
    })
}

test('fast typing and a deliberate caret move keep their positions', async ({ page }) => {
    await openPage(page)
    const canvas = (await page.locator('.tl-canvas').boundingBox())!
    await page.keyboard.press('t')
    await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + 240)
    await page.waitForTimeout(25)
    await typeKeys(page, 'abcd')
    const text = page.getByTestId('rich-text-area').locator('.tiptap')
    await expect(text).toHaveText('abcd')
    const point = await pointInLabel(text, 2)
    await page.mouse.click(point.x, point.y)
    await typeKeys(page, 'kl')
    await page.keyboard.press('Escape')
    await expect(page.locator('.tl-shape[data-shape-type="text"]')).toHaveText('abklcd')
})

test('single-click caret placement and double-click word selection work inside a label', async ({ page }) => {
    await openPage(page)
    const canvas = (await page.locator('.tl-canvas').boundingBox())!
    await page.keyboard.press('t')
    await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + 240)
    await page.getByTestId('rich-text-area').locator('.tiptap').pressSequentially('first second', { delay: 35 })
    await page.keyboard.press('Escape')
    const shape = page.locator('.tl-shape[data-shape-type="text"]')
    const label = shape.getByText('first second', { exact: true }).first()
    const caret = await pointInLabel(label, 2)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(55)
    await page.mouse.click(caret.x, caret.y)
    await typeKeys(page, 'k')
    const active = page.getByTestId('rich-text-area').locator('.tiptap')
    await expect(active).toHaveText('fikrst second')
    const word = await pointInLabel(active, 10)
    await openLabel(page, word)
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('second')
    await typeKeys(page, 'end')
    await page.keyboard.press('Escape')
    await expect(shape).toHaveText('fikrst end')
})

test('the deferred editor autofocus does not move a caret after the first key', async ({ page }) => {
    await openPage(page)
    const canvas = (await page.locator('.tl-canvas').boundingBox())!
    await page.clock.install()
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 100)))
    await page.keyboard.press('t')
    await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + 240)
    await page.keyboard.type('a')
    await page.clock.runFor(64)
    await page.keyboard.type('bcd')
    await page.keyboard.press('Escape')
    await page.clock.resume()
    await expect(page.locator('.tl-shape[data-shape-type="text"]')).toHaveText('abcd')
})
