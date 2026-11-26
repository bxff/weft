import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

for (const [family, width, height, dpr, expectedRatio] of [
    ['narrow', 390, 844, 2, 620 / 850],
    ['wide', 1440, 900, 1, 1200 / 528],
] as const) {
    test.describe(`${family} homepage artwork`, () => {
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
            expect(rect!.width / rect!.height).toBeCloseTo(expectedRatio, 2)
            await expect(page.getByRole('link', { name: 'Read the docs' })).toBeVisible()
        })
    })
}
