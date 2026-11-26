import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

for (const [family, width, height, dpr, expectedRatio] of [
    ['narrow', 320, 700, 3, 620 / 900],
    ['narrow', 390, 844, 2, 620 / 900],
    ['narrow', 639, 900, 2, 620 / 900],
    ['wide', 640, 900, 2, 1200 / 528],
    ['wide', 1440, 900, 1, 1200 / 528],
    ['wide', 1440, 900, 2, 1200 / 528],
    ['wide', 1440, 900, 3, 1200 / 528],
] as const) {
    test.describe(`${family} homepage artwork at ${width}px, ${dpr}x`, () => {
        test.use({ viewport: { width, height }, deviceScaleFactor: dpr })

        test('loads one correctly cropped static image and keeps the main actions', async ({ page }) => {
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
            expect(images[0]).toContain(`/hero/weft-${family}-`)
            const rect = await image.boundingBox()
            expect(rect).not.toBeNull()
            expect(rect!.x).toBeGreaterThanOrEqual(0)
            expect(rect!.x + rect!.width).toBeLessThanOrEqual(width + 1)
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
            const assetWidth = Number(images[0].match(/-(\d+)\./)?.[1])
            expect(assetWidth).toBeGreaterThanOrEqual(rect!.width * dpr * 0.95)
            expect(rect!.width / rect!.height).toBeCloseTo(expectedRatio, 2)
            await expect(page.getByRole('link', { name: 'Read the docs' })).toBeVisible()
            await expect(page.getByRole('link', { name: 'bxff/weft', exact: true })).toHaveAttribute('href', 'https://github.com/bxff/weft')
        })
    })
}
