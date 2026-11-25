import { expect, test } from '@playwright/test'

function onePagePdf(): Buffer {
    const paint = '1 0 0 rg 0 0 120 120 re f'
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 120] /Contents 4 0 R >>',
        `<< /Length ${paint.length} >>\nstream\n${paint}\nendstream`,
    ]
    let pdf = '%PDF-1.4\n'
    const offsets = objects.map((object, i) => {
        const offset = pdf.length
        pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
        return offset
    })
    const xref = pdf.length
    pdf += 'xref\n0 5\n0000000000 65535 f \n'
    pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
    return Buffer.from(pdf + `trailer\n<< /Root 1 0 R /Size 5 >>\nstartxref\n${xref}\n%%EOF\n`)
}

test('a cached source underlay remains offline-readable only in its original account', async ({ page, request, baseURL }) => {
    const doc = crypto.randomUUID(), sheet = crypto.randomUUID()
    const file = `/api/documents/${doc}/file`
    const notebook = `/app/${doc}/${sheet}`
    const first = 'pdf-a', second = 'pdf-b'
    for (const user of [first, second]) {
        const response = await request.put('/api/documents', {
            headers: { authorization: 'Bearer dev:' + user },
            data: { documents: [{ id: doc, name: 'PDF fixture', type: 'pdf', parent: '',
                pages: [{ id: sheet, fileIndex: 0 }], lastModified: 1 }] },
        })
        expect(response.ok()).toBe(true)
    }
    const uploaded = await request.put(file, {
        headers: { authorization: 'Bearer dev:' + first, 'content-type': 'application/pdf' },
        data: onePagePdf(),
    })
    expect(uploaded.ok()).toBe(true)
    await page.addInitScript(({ relay, user }) => {
        localStorage.setItem('weft-server-url', relay)
        localStorage.setItem('weft-clerk-pk', '')
        if (!localStorage.getItem('weft-dev-user')) localStorage.setItem('weft-dev-user', user)
    }, { relay: baseURL!, user: first })
    await page.goto(notebook)
    const image = page.locator('img[src^="data:image/jpeg"]')
    await expect(image).toHaveCount(1)
    const original = await image.getAttribute('src')
    await page.route('**' + file, (route) => route.abort('connectionfailed'))
    const select = async (user: string) => {
        await page.evaluate((value) => localStorage.setItem('weft-dev-user', value), user)
        await page.reload()
    }
    const unavailable = page.waitForEvent('console', (message) =>
        message.text().includes('pdf underlay failed')).then(() => 'unavailable')
    await select(second)
    expect(await Promise.race([unavailable, image.waitFor().then(() => 'rendered')])).toBe('unavailable')
    await expect(image).toHaveCount(0)

    await select(first)
    await expect(image).toHaveAttribute('src', original!)
})
