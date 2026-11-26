import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'

const web = new URL('../apps/web/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('src/lib/home-hero.json', web), 'utf8'))

test('every immutable homepage image is a content-addressed WebP in the manifest', () => {
    const paths = []
    for (const [family, widths] of [
        ['wide', [960, 1440, 1920, 2880, 3600, 4320]],
        ['narrow', [480, 720, 1080, 1440, 1920]],
    ]) {
        const images = manifest[family]
        expect(images.map(({ width }) => width)).toEqual(widths)
        for (const { src, width, height } of images) {
            expect(Number.isSafeInteger(height) && height > 0).toBe(true)
            expect(src).toMatch(new RegExp(`^/hero/weft-${family}-${width}\\.[a-f0-9]{12}\\.webp$`))
            const bytes = readFileSync(new URL('static' + src, web))
            expect(bytes.subarray(0, 4).toString()).toBe('RIFF')
            expect(bytes.subarray(8, 12).toString()).toBe('WEBP')
            const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
            const file = `weft-${family}-${width}.${hash}.webp`
            expect(src).toBe('/hero/' + file)
            paths.push(file)
        }
    }
    expect(readdirSync(new URL('static/hero/', web)).sort()).toEqual(paths.sort())
    expect(readFileSync(new URL('static/_headers', web), 'utf8')).toContain(
        '/hero/*\n  Cache-Control: public, max-age=31536000, immutable',
    )
})
