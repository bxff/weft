import { expect, test } from '@playwright/test'

for (const width of [320, 390, 900, 1100, 1440]) {
    test(`homepage copy and artwork share their left and right edges at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await page.goto('/')
        const hero = page.locator('main img').first()
        await expect(hero).toBeVisible()
        await page.evaluate(() => document.fonts.ready)
        const artwork = (await hero.boundingBox())!
        expect(artwork.width).toBeCloseTo(Math.min(width, 1280) - 32, 0)
        expect(artwork.x).toBeCloseTo((width - artwork.width) / 2, 0)
        for (const paragraph of await page.locator('main p').all()) {
            const copy = (await paragraph.boundingBox())!
            expect(copy.x).toBeCloseTo(artwork.x, 0)
            expect(copy.width).toBeCloseTo(artwork.width, 0)
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
    })
}

for (const width of [390, 900, 1100, 1440]) {
    test(`docs and legal pages share a reading column at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        let reference: number | undefined
        for (const url of ['/docs', '/privacy', '/terms']) {
            expect((await page.goto(url))?.status(), url).toBe(200)
            const article = page.locator('.wf-docs-article')
            await expect(article).toBeVisible()
            await page.evaluate(() => document.fonts.ready)
            const articleWidth = (await article.boundingBox())!.width
            reference ??= articleWidth
            expect(articleWidth).toBeCloseTo(reference, 0)
        }
    })
}
