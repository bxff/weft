import { expect, test, type Page } from '@playwright/test'
import type { Editor } from 'tldraw'

const doc = '88888888-8888-4888-a888-888888888888'
const sheet = '99999999-9999-4999-a999-999999999999'
const file = 'ab1e0001-0000-4000-a000-0000000000ab.png'
const drawing = `/api/documents/${doc}/pages/${sheet}`
const photo = `${drawing}/assets/${file}`
const url = `/app/${doc}/${sheet}`
const account = (user = 'e2e') => ({ authorization: `Bearer dev:${user}` })
const bytes = (src: string) => Buffer.from(src.split(',')[1]!, 'base64')

async function upload(page: Page, src: string, user?: string) {
    const result = await page.request.put(photo, { headers: account(user), data: bytes(src) })
    expect(result.ok()).toBe(true)
}

async function colors(page: Page) {
    return page.evaluate(() => ['blue', 'red', 'green'].map((color) => {
        const image = document.createElement('canvas')
        image.width = image.height = 12
        const ctx = image.getContext('2d')!
        ctx.fillStyle = color
        ctx.fillRect(0, 0, 12, 12)
        return image.toDataURL()
    })) as Promise<[string, string, string]>
}

function visible(page: Page) {
    return page.evaluate((name) => {
        const editor = (window as unknown as { __weftEditor?: Editor }).__weftEditor
        return editor?.getAssets().find(asset => asset.type === 'image' && asset.props.name === name)?.props.src
    }, file)
}

function cachedBytes(page: Page) {
    return page.evaluate(async (suffix) => {
        const result = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        const db = await result(indexedDB.open('weft'))
        try {
            const rows = db.transaction('pages').objectStore('pages')
            const key = (await result(rows.getAllKeys())).find((key) => String(key).startsWith('asset/') && String(key).endsWith(suffix))
            return key ? Array.from(await result(rows.get(key)) as Uint8Array) : []
        } finally {
            db.close()
        }
    }, `${photo}`)
}

test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
        localStorage.setItem('weft-server-url', location.origin)
        localStorage.setItem('weft-clerk-pk', '')
        if (!localStorage.getItem('weft-dev-user')) localStorage.setItem('weft-dev-user', 'e2e')
    })
})

async function start(page: Page) {
    await page.goto('/')
    const { RmDocument, crdtId, lww, uuidToBytesLE } = await import('../packages/rm-format/src/index')
    const { encodeSnapshot } = await import('../packages/sync-engine/src/snapshot')
    const authorUuid = 'bbbbbbbb-0000-4000-a000-000000000001'
    const uuid = file.slice(0, -4)
    const rm = RmDocument.empty(authorUuid)
    rm.blocks.push({
        type: 'sceneImageInfo', version: { min: 3, current: 3 }, extraData: new Uint8Array(),
        images: [{ uuid, filename: lww(crdtId(1, 50), file),
            flags: lww(crdtId(1, 51), Uint8Array.of(17, 0)) }],
    })
    rm.appendImage({ kind: 'image', uuid: lww(crdtId(1, 52), uuidToBytesLE(uuid)), timestamp: crdtId(0, 0),
        vertices: [0,0,0,0,100,0,1,0,100,100,1,1,0,100,0,1],
        indices: [0,1,2,2,3,0], filename: null }, { authorUuid })
    expect((await page.request.put(drawing + '/snapshot', {
        headers: account(), data: Buffer.from(encodeSnapshot(rm.serialize(), { shapes: [] })),
    })).ok()).toBe(true)
    const palette = await colors(page)
    await upload(page, palette[0])
    await page.goto(url)
    await expect(page.getByTestId('sync-status')).toHaveText('synced')
    await expect.poll(() => visible(page)).toBe(palette[0])
    return palette
}

test('refreshes same-name tablet photo bytes in an open page and on offline reopen', async ({ page }) => {
    const [, replacement] = await start(page)
    const shapeId = await page.evaluate(() => {
        const editor = (window as unknown as { __weftEditor: Editor }).__weftEditor
        const shape = editor.getCurrentPageShapes().find(({ type }) => type === 'image')!
        editor.select(shape.id)
        return shape.id
    })
    await upload(page, replacement)
    const relay = await page.request.get(photo, { headers: account() })
    expect(await relay.body()).toEqual(bytes(replacement))
    await expect.poll(() => visible(page), { timeout: 5000 }).toBe(replacement)
    expect(await page.evaluate(() =>
        (window as unknown as { __weftEditor: Editor }).__weftEditor.getSelectedShapeIds(),
    )).toEqual([shapeId])

    await page.route('**/api/**', (route) => route.abort('connectionfailed'))
    await page.reload()
    await expect.poll(() => visible(page)).toBe(replacement)
})

test('a matching filename in another account never displays cached bytes from the first account', async ({ page }) => {
    const [original, other] = await start(page)
    const user = 'photo-scope-peer'
    const rm = await (await page.request.get(`${drawing}/rm`, { headers: account() })).body()
    expect((await page.request.put(`${drawing}/rm`, { headers: account(user), data: rm })).ok()).toBe(true)
    await upload(page, other, user)
    let attempted = false
    await page.route(`**${photo}`, (route) => {
        attempted = true
        return route.abort('connectionfailed')
    })
    await page.evaluate((user) => localStorage.setItem('weft-dev-user', user), user)
    await page.reload()
    await expect.poll(() => attempted).toBe(true)
    const placeholder = await visible(page)
    expect(placeholder).toMatch(/^data:image\/png/)
    expect(placeholder).not.toBe(original)
    await page.unroute(`**${photo}`)
    await page.reload()
    await expect.poll(() => visible(page)).toBe(other)
})


test('a delayed decode never paints over an A → B → A restore', async ({ page }) => {
    const [original, replacement] = await start(page)
    await page.evaluate(() => {
        const read = FileReader.prototype.readAsDataURL
        FileReader.prototype.readAsDataURL = function (blob) {
            FileReader.prototype.readAsDataURL = read
            const finish = () => new Promise<void>((resolve) => {
                this.addEventListener('loadend', () => resolve(), { once: true })
                read.call(this, blob)
            })
            Object.assign(window, { finishPhotoDecode: finish })
        }
    })
    await upload(page, replacement)
    await page.waitForFunction(() => 'finishPhotoDecode' in window)
    await expect.poll(() => cachedBytes(page)).toEqual([...bytes(replacement)])
    await upload(page, original)
    await expect.poll(() => cachedBytes(page)).toEqual([...bytes(original)])
    await page.evaluate(() => (window as unknown as { finishPhotoDecode(): Promise<void> }).finishPhotoDecode())
    expect(await visible(page)).toBe(original)
})

test('an older response from another tab cannot overwrite newer durable bytes', async ({ page, context }) => {
    let suppressChanges = false
    await page.routeWebSocket('**/ws**', (socket) => {
        const server = socket.connectToServer()
        server.onMessage((message) => {
            if (suppressChanges && String(message).includes('page.asset.changed')) return
            socket.send(message)
        })
    })
    const [original, older, newer] = await start(page)
    await expect.poll(() => cachedBytes(page)).toEqual([...bytes(original)])
    let began!: () => void
    const started = new Promise<void>((resolve) => { began = resolve })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let intercepted = false
    await page.route(`**${photo}`, async (route) => {
        if (intercepted) return route.continue()
        const response = await route.fetch()
        if (response.status() !== 200 || !(await response.body()).equals(bytes(older))) {
            return route.fulfill({ response })
        }
        intercepted = true
        began()
        await held
        await route.fulfill({ response })
    })

    await upload(page, older)
    await started
    suppressChanges = true
    const peer = await context.newPage()
    await peer.goto(url)
    await expect.poll(() => visible(peer)).toBe(older)
    await upload(peer, newer)
    await expect.poll(() => visible(peer)).toBe(newer)
    await expect.poll(() => cachedBytes(peer)).toEqual([...bytes(newer)])

    release()
    await expect.poll(() => visible(page)).toBe(newer)
    await expect.poll(() => cachedBytes(page)).toEqual([...bytes(newer)])
    await peer.close()
})
