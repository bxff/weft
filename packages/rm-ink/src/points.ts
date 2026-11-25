/**
 * Stroke point construction: single implementation of speed/direction/
 * width/pressure encoding.
 *
 * Units (v6 wire format, version-2 points):
 *  - x, y: page coordinates (float32). rM1/2 page = 1404×1872; Paper Pro
 *    files still declare 1404×1872 — use SceneInfo, not constants.
 *  - speed: uint16, distance-per-sample × 4
 *  - direction: uint8, angle mapped 0..2π -> 0..255
 *  - width: uint16, v6 width units (display px ≈ width/4 at 226 DPI)
 *  - pressure: uint8, 0..255
 */

import type { Point } from '@weft/rm-format'

export interface Xy {
    x: number
    y: number
}

export function directionByte(angleRadians: number): number {
    let a = angleRadians
    if (a < 0) a += Math.PI * 2
    return Math.min(255, Math.max(0, Math.round((a / (Math.PI * 2)) * 255)))
}

export function speedU16(distance: number): number {
    return Math.min(65535, Math.max(0, Math.round(distance * 4)))
}

export interface PolylineOptions {
    /** v6 width units for every point. */
    width: number
    /** 0..255; markers ignore pressure — 128 is the neutral default. */
    pressure?: number
}

/**
 * Encode a polyline (already in RM page coordinates) as v6 points with
 * derived speed (inter-point distance) and direction (toward next point).
 */
export function polylineToPoints(line: Xy[], opts: PolylineOptions): Point[] {
    const pressure = Math.round(opts.pressure ?? 128)
    const out: Point[] = []
    for (let i = 0; i < line.length; i++) {
        const pt = line[i]!
        let speed = 0
        if (i > 0) {
            const prev = line[i - 1]!
            speed = Math.hypot(pt.x - prev.x, pt.y - prev.y)
        }
        let direction = 0
        if (i < line.length - 1) {
            const next = line[i + 1]!
            direction = Math.atan2(next.y - pt.y, next.x - pt.x)
        } else if (i > 0) {
            const prev = line[i - 1]!
            direction = Math.atan2(pt.y - prev.y, pt.x - prev.x)
        }
        out.push({
            x: pt.x,
            y: pt.y,
            speed: speedU16(speed),
            direction: directionByte(direction),
            width: opts.width,
            pressure,
        })
    }
    return out
}

/** A projected stroke ready to write: points + color name. */
export interface InkStroke {
    points: Point[]
    /** RM color name (palette.ts). */
    color: string
    /** Optional RM pen/brush id (rm-format `Pen` enum value). Overrides the
     *  session's default pen for THIS stroke — e.g. a highlight shape projects
     *  with the highlighter brush. Omitted = use the session default. */
    pen?: number
}
