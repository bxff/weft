/**
 * RM strokes -> SVG, rmrl-faithful: one <line> per point pair with the
 * per-brush style formula (pen.ts). Highlighter renders as one polyline.
 */

import type { Line } from '@weft/rm-format'
import { getStyleFn, RM_SCALE, type RmBrush, type Rgb } from './pen'
import { penColorRgb, penToBrush } from './palette'

export interface RenderOptions {
    /** Coordinate scale (default RM_SCALE: RM page -> 72 DPI SVG). */
    scale?: number
}

export function lineToSvg(line: Line, opts: RenderOptions = {}): string {
    const brush = penToBrush(line.tool)
    if (!brush) return ''
    return strokeToSvg(
        line.points.map((p) => ({ ...p })),
        brush,
        penColorRgb(line.color),
        opts,
    )
}

export function strokeToSvg(
    points: { x: number; y: number; speed: number; width: number; pressure: number }[],
    brush: RmBrush,
    baseColor: Rgb,
    opts: RenderOptions = {},
): string {
    if (!points.length) return ''
    const scale = opts.scale ?? RM_SCALE
    const styleFn = getStyleFn(brush)

    if (points.length === 1) {
        const p = points[0]!
        const style = styleFn(baseColor, p.width / 4, p.pressure / 255, p.speed / 4)
        const radius = Math.max(0.2, style.width * scale) / 2
        return `<circle cx="${p.x * scale}" cy="${p.y * scale}" r="${radius}" fill="${style.color}" opacity="${style.opacity}"/>`
    }

    if (brush === 'highlighter') {
        const first = points[0]!
        const style = styleFn(baseColor, first.width / 4, first.pressure / 255, 0)
        const pts = points.map((p) => `${(p.x * scale).toFixed(2)},${(p.y * scale).toFixed(2)}`).join(' ')
        return `<polyline points="${pts}" fill="none" stroke="${style.color}" stroke-width="${Math.max(0.3, style.width * scale)}" stroke-linecap="square" stroke-linejoin="round" opacity="${style.opacity}"/>`
    }

    const out: string[] = []
    for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i]!
        const p2 = points[i + 1]!
        const style = styleFn(baseColor, p1.width / 4, p1.pressure / 255, p1.speed / 4)
        const sw = Math.max(0.1, style.width * scale).toFixed(2)
        out.push(
            `<line x1="${(p1.x * scale).toFixed(2)}" y1="${(p1.y * scale).toFixed(2)}" x2="${(p2.x * scale).toFixed(2)}" y2="${(p2.y * scale).toFixed(2)}" stroke="${style.color}" stroke-width="${sw}" stroke-linecap="round" opacity="${style.opacity}"/>`,
        )
    }
    return out.join('')
}
