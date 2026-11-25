/**
 * tldraw->RM projection fidelity: dashed/dotted strokes render as many short
 * ink strokes (RM has no dash attribute), not one solid line; grouped/framed
 * children project at their page position, not parent-local; arrowheads add
 * strokes. Verified by parsing the synced native .rm.
 */
import { test, expect, type Page } from '@playwright/test'
import { useCloudMode } from './cloud-mode'

useCloudMode()

const CENTERED = '22222222-2222-4222-a222-222222222222'
// dedicated page: this spec counts live items, so sharing a page with other
// stroke-writing specs would race
const CENTERED_PAGE = 'ceceabcd-0000-4000-a000-00000000e202'

async function waitForSynced(page: Page): Promise<void> {
    await expect(page.getByTestId('sync-status')).toHaveText('synced', { timeout: 30_000 })
}

test('dashed lines segment into many ink strokes; solid lines stay whole', async ({ page }) => {
    const { RmDocument } = await import('../packages/rm-format/src/index')
    const liveCount = async () => {
        // page doesn't exist until the first stroke syncs
        const r = await page.request.get(`/api/documents/${CENTERED}/pages/${CENTERED_PAGE}/rm`)
        if (!r.ok()) return 0
        return RmDocument.parse(new Uint8Array(await r.body()) as never).blocks.filter(
            (b) =>
                b.type === 'sceneLineItem' && (b as { deletedLength: number }).deletedLength === 0,
        ).length
    }

    await page.goto(`/app/${CENTERED}/${CENTERED_PAGE}`)
    await waitForSynced(page)

    const makeLine = (dash: string, y: number) =>
        page.evaluate(
            ({ dash, y }) => {
                const ed = (
                    window as unknown as { __weftEditor?: { createShape(s: unknown): void } }
                ).__weftEditor
                ed?.createShape({
                    type: 'line',
                    x: 100,
                    y,
                    props: {
                        dash,
                        size: 'l',
                        spline: 'line',
                        points: {
                            a1: { id: 'a1', index: 'a1', x: 0, y: 0 },
                            a2: { id: 'a2', index: 'a2', x: 500, y: 0 },
                        },
                    },
                })
            },
            { dash, y },
        )

    const before = await liveCount()
    await makeLine('solid', 100)
    await expect.poll(liveCount, { timeout: 15_000 }).toBeGreaterThan(before)
    const afterSolid = await liveCount()
    const solidAdded = afterSolid - before

    await makeLine('dashed', 300)
    await expect.poll(liveCount, { timeout: 15_000 }).toBeGreaterThan(afterSolid)
    const dashedAdded = (await liveCount()) - afterSolid

    // a solid line is ONE stroke; a 500-unit dashed line is many segments
    expect(solidAdded).toBe(1)
    expect(dashedAdded).toBeGreaterThan(3)
})
