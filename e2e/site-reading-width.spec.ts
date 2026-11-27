import { expect, test } from '@playwright/test'

for (const width of [390, 900, 1100, 1440]) {
    test(`published pages share the same reading column at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await page.goto('/')
        const copy = page.locator('main p').first()
        await expect(copy).toBeVisible()
        await page.evaluate(() => document.fonts.ready)
        const reference = (await copy.boundingBox())!.width
        const hero = page.locator('main img').first()
        await expect(hero).toBeVisible()
        const artwork = (await hero.boundingBox())!.width
        expect(artwork).toBeCloseTo(Math.min(width, 1280) - 32, 0)
        if (width >= 1100) expect(artwork).toBeGreaterThan(reference)
        for (const url of ['/docs', '/privacy', '/terms']) {
            expect((await page.goto(url))?.status(), url).toBe(200)
            const article = page.locator('.wf-docs-article')
            await expect(article).toBeVisible()
            await page.evaluate(() => document.fonts.ready)
            expect((await article.boundingBox())!.width).toBeCloseTo(reference, 0)
        }
    })
}
