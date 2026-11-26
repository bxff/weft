import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

for (const [width, height, dpr] of [
    [320, 700, 3],
    [390, 844, 2],
    [639, 900, 2],
    [640, 900, 2],
    [1440, 900, 1],
    [1440, 900, 2],
    [1440, 900, 3],
] as const) {
    test.describe(`homepage artwork at ${width}px, ${dpr}x`, () => {
        test.use({ viewport: { width, height }, deviceScaleFactor: dpr })

        test('loads one unstacked static image and keeps the main actions', async ({ page }) => {
            const images: string[] = []
            page.on('request', (request) => {
                const path = new URL(request.url()).pathname
                if (path.startsWith('/hero/')) images.push(path)
            })
            await page.goto('/')
            const image = page.getByRole('img', { name: 'The same annotated notebook page on a reMarkable tablet and in the Weft browser editor.' })
            await expect(image).toBeVisible()
            await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)

            expect(images).toHaveLength(1)
            expect(images[0]).toContain('/hero/weft-wide-')
            const rect = await image.boundingBox()
            expect(rect).not.toBeNull()
            expect(rect!.x).toBeGreaterThanOrEqual(0)
            expect(rect!.x + rect!.width).toBeLessThanOrEqual(width + 1)
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
            const assetWidth = Number(images[0].match(/-(\d+)\./)?.[1])
            expect(assetWidth).toBeGreaterThanOrEqual(rect!.width * dpr * 0.95)
            expect(rect!.width / rect!.height).toBeCloseTo(1200 / 528, 2)
            await expect(page.getByRole('link', { name: 'Read the docs' })).toBeVisible()
            await expect(page.locator('footer')).not.toContainText('©')
            await expect(page.getByRole('link', { name: 'bxff/weft', exact: true })).toHaveAttribute('href', 'https://github.com/bxff/weft')
        })
    })
}
