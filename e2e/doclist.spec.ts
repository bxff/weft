/**
 * When the tablet pushes an updated doc list (rename/create/move), the cloud
 * emits doc.list.changed and the browser grid refreshes without reload.
 * Simulated here with a direct PUT /api/documents, as rmsyncd would send.
 */
import { test, expect } from '@playwright/test'
import { useCloudMode } from './cloud-mode'

useCloudMode()

// Grid Notes: a doc no other spec asserts on by name, so renaming it can't race parallel workers.
const DOC = 'aaaa0001-0000-4000-a000-0000000000aa'

test('grid refreshes when the tablet pushes a renamed doc list', async ({ page }) => {
    await page.goto('/library')
    await expect(page.getByText('Grid Notes')).toBeVisible({
        timeout: 20000,
    })

    // PUT is a per-doc LWW merge: a partial list (one doc) must not delete the rest by absence
    const body = (await (await page.request.get('/api/documents')).json()) as {
        documents: { id: string; name: string; lastModified?: number }[]
    }
    const doc = body.documents.find((d) => d.id === DOC)!
    expect(doc).toBeTruthy()
    expect(body.documents.length).toBeGreaterThan(1)
    doc.name = 'Grid RENAMED'
    doc.lastModified = Date.now()
    const put = await page.request.put('/api/documents', {
        data: { documents: [doc] },
    })
    expect(put.ok()).toBe(true)

    await expect(page.getByText('Grid RENAMED')).toBeVisible({
        timeout: 15000,
    })

    const after = (await (await page.request.get('/api/documents')).json()) as {
        documents: { id: string }[]
    }
    expect(after.documents.length).toBe(body.documents.length)
})
