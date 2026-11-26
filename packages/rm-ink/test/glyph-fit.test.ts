import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parse } from 'opentype.js'
import { rmMarkerWidthToRadius, RM_SCALE } from '../src/pen'
import type { Xy } from '../src/points'
import { extractContours, textToGlyphParts } from '../src/text'

const font = parse(Uint8Array.from(readFileSync(
    `${import.meta.dir}/../../../apps/web/static/fonts/ShantellSans.ttf`,
)).buffer)

function inGlyph(x: number, y: number, contours: Xy[][]): boolean {
    let odd = false
    for (const c of contours) for (let i = 0; i < c.length; i++) {
        const a = c[i]!
        const b = c[(i + 1) % c.length]!
        if ((a.y > y) !== (b.y > y) && x < a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y)) odd = !odd
    }
    return odd
}

function errorFor(ch: string, fontSize: number) {
    const lineHeight = fontSize * 1.35
    const baseline = (lineHeight + fontSize * (font.ascender + font.descender) / font.unitsPerEm) / 2
    const contours = extractContours(font.charToGlyph(ch).getPath(0, baseline, fontSize))
    const [part] = textToGlyphParts(font, { text: ch, fontSize }, { x: 0, y: 0 }, 'black')
    expect(part?.partKey).toBe('glyph:0')
    const segments = part!.strokes.flatMap((stroke) => stroke.points.slice(1).map((b, i) => {
        const a = stroke.points[i]!
        return {
            x: a.x * RM_SCALE, y: a.y * RM_SCALE,
            dx: (b.x - a.x) * RM_SCALE, dy: (b.y - a.y) * RM_SCALE,
            r: rmMarkerWidthToRadius(a.width),
        }
    }))
    const hits = (x: number, y: number) => segments.some(({ x: sx, y: sy, dx, dy, r }) => {
        const px = x - sx
        const py = y - sy
        const len = dx * dx + dy * dy
        const t = len ? Math.max(0, Math.min(1, (px * dx + py * dy) / len)) : 0
        return (px - t * dx) ** 2 + (py - t * dy) ** 2 <= r * r
    })
    const all = contours.flat()
    const lo = Math.min(...all.map(p => p.x)) - 3
    const hi = Math.max(...all.map(p => p.x)) + 3
    const top = Math.min(...all.map(p => p.y)) - 3
    const bottom = Math.max(...all.map(p => p.y)) + 3
    let outside = 0
    let missing = 0
    let reference = 0
    for (let y = top + 0.1; y < bottom; y += 0.2) for (let x = lo + 0.1; x < hi; x += 0.2) {
        const expected = inGlyph(x, y, contours)
        const actual = hits(x, y)
        if (expected) reference++
        if (expected && !actual) missing++
        if (!expected && actual) outside++
    }
    // Each filled outer contour (stems, accents, and dots) gets at least one mark.
    const allOutlineComponentsHit = contours.every((c, i) => {
        if (inGlyph(c[0]!.x, c[0]!.y, contours.filter((_, j) => j !== i))) return true
        return segments.some(s => inGlyph(s.x, s.y, [c]))
    })
    return { outside: outside / reference, missing: missing / reference, allOutlineComponentsHit }
}

test('round marker stays inside outer edges and letter counters', () => {
    for (const ch of 'Aero08') {
        const error = errorFor(ch, 44.5)
        expect(error.outside).toBeLessThan(0.015)
        expect(error.missing).toBeLessThan(0.22)
    }
})

test('narrow strokes, accents and punctuation keep their separate pieces', () => {
    for (const ch of '.:;!?ilIéï…') {
        const error = errorFor(ch, 18)
        expect(error.allOutlineComponentsHit).toBe(true)
        expect(error.outside).toBeLessThan(0.04)
        expect(error.missing).toBeLessThan(0.3)
    }
})
