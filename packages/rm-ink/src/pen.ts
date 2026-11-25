/**
 * Pen rendering formulas: single home for the marker/brush/pencil styles.
 *
 * Forward formulas are rmrl-faithful per-point-pair styles; widths arrive in
 * v6 wire units (width/4 = display px at 226 DPI before RM_SCALE).
 */

// ink -> tldraw px ratio. At 72/226 the RM page was only ~447 tldraw px
// wide, so tldraw-native defaults (24px text, 3.5px strokes) rendered twice
// too big in ink units. 144/226 puts tldraw size-m text at ~38 ink em next
// to the device's native 32. Every ink<->px conversion flows through this
// one constant; changing it requires bumping PROJECTION_VERSION so existing
// web-authored ink re-projects at the new ratio.
export const RM_SCALE = 144 / 226

export type RmBrush =
    | 'fineliner'
    | 'ballpoint'
    | 'marker'
    | 'pencil'
    | 'mechanicalPencil'
    | 'brush'
    | 'calligraphy'
    | 'highlighter'
    | 'shader'

export interface LineStyle {
    width: number
    color: string
    opacity: number
}

export type Rgb = [number, number, number]

type StyleFn = (base: Rgb, width: number, pressure: number, speed: number) => LineStyle

const rgb = (c: Rgb) => `rgb(${c[0]},${c[1]},${c[2]})`

/** Blend toward white by (1 - factor): rmrl's pressure-shading rule. */
function pressureBlend(base: Rgb, factor: number): string {
    const ch = (v: number) => Math.round(Math.max(0, Math.min(255, (1 - (1 - v / 255) * factor) * 255)))
    return `rgb(${ch(base[0])},${ch(base[1])},${ch(base[2])})`
}

export const finelinerStyle: StyleFn = (base, width) => ({ width, color: rgb(base), opacity: 1 })
export const calligraphyStyle = finelinerStyle

export const ballpointStyle: StyleFn = (base, width, pressure) => ({
    width: Math.max(0.5, width + (pressure - 1) * (width / 2)),
    color: rgb(base),
    opacity: 1,
})

/** Marker renders at width * 0.7. Inverse below. */
export const markerStyle: StyleFn = (base, width) => ({ width: width * 0.7, color: rgb(base), opacity: 1 })

export const pencilStyle: StyleFn = (base, width, pressure) => ({
    width: width * 0.58,
    color: pressureBlend(base, pressure),
    opacity: 1,
})

export const mechPencilStyle: StyleFn = (base, width, pressure) => ({
    width,
    color: pressureBlend(base, pressure),
    opacity: 1,
})

export const brushStyle: StyleFn = (base, width, pressure, speed) => {
    const modWidth = width * 0.75
    const delta = (pressure - 1) * (modWidth * 0.75)
    const pressMod = pressure * (2 - speed / 75)
    return {
        width: Math.max(0.5, modWidth + delta),
        color: pressureBlend(base, pressMod / 2),
        opacity: 1,
    }
}

// Older monochrome notebooks encode the default yellow highlighter as black.
export const highlighterStyle: StyleFn = (base, width) => ({
    width,
    color: base[0] === 0 && base[1] === 0 && base[2] === 0 ? 'rgb(255,233,74)' : rgb(base),
    opacity: 0.392,
})

export const shaderStyle: StyleFn = (base, width) => ({ width, color: rgb(base), opacity: 0.1 })

const STYLE_FNS: Record<RmBrush, StyleFn> = {
    fineliner: finelinerStyle,
    ballpoint: ballpointStyle,
    marker: markerStyle,
    pencil: pencilStyle,
    mechanicalPencil: mechPencilStyle,
    brush: brushStyle,
    calligraphy: calligraphyStyle,
    highlighter: highlighterStyle,
    shader: shaderStyle,
}

export function isRmBrush(value: unknown): value is RmBrush {
    return typeof value === 'string' && Object.hasOwn(STYLE_FNS, value)
}

export function getStyleFn(brush: RmBrush): StyleFn {
    return STYLE_FNS[brush] ?? finelinerStyle
}

// ============================================================
// Marker width inverse: tldraw px -> v6 width units
//
// Display width = (v6width / 4) * 0.7 * RM_SCALE  (marker)
// Inverse:  v6width = displayWidth / (0.7 * RM_SCALE) * 4
// ============================================================

const MARKER_FACTOR = 0.7 * RM_SCALE

/** Desired tldraw display width (px) -> v6 marker width units. */
export function tldrawWidthToRmMarkerWidth(displayWidth: number): number {
    return Math.max(1, Math.round((displayWidth / MARKER_FACTOR) * 4))
}

/** tldraw freehand radius -> v6 marker width units. */
export function tldrawRadiusToRmMarkerWidth(radius: number): number {
    return Math.max(0, Math.round(((radius * 2) / MARKER_FACTOR) * 4))
}

/** v6 marker width units -> rendered tldraw radius (for error accounting). */
export function rmMarkerWidthToRadius(v6width: number): number {
    return ((v6width / 4) * MARKER_FACTOR) / 2
}
