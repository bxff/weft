import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'

const web = new URL('../apps/web/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('src/lib/home-hero.json', web), 'utf8'))

test('every immutable homepage image is a content-addressed WebP in the manifest', () => {
    const paths = []
    expect(manifest.map(({ width }) => width)).toEqual([480, 720, 960, 1440, 1920, 2880, 3600, 4320])
    for (const { src, width, height } of manifest) {
        expect(Number.isSafeInteger(height)).toBe(true)
        expect(Math.abs(height - width * 528 / 1200)).toBeLessThanOrEqual(2)
        expect(src).toMatch(new RegExp(`^/hero/weft-wide-${width}\\.[a-f0-9]{12}\\.webp$`))
        const bytes = readFileSync(new URL('static' + src, web))
        expect(bytes.subarray(0, 4).toString()).toBe('RIFF')
        expect(bytes.subarray(8, 12).toString()).toBe('WEBP')
        const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
        const file = `weft-wide-${width}.${hash}.webp`
        expect(src).toBe('/hero/' + file)
        paths.push(file)
    }
    expect(readdirSync(new URL('static/hero/', web)).sort()).toEqual(paths.sort())
    expect(readFileSync(new URL('static/_headers', web), 'utf8')).toContain(
        '/hero/*\n  Cache-Control: public, max-age=31536000, immutable',
    )
})
