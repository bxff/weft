/**
 * Coordinate transforms between tldraw page space and RM page space.
 *
 * Convention: tldraw world coordinates divided by RM_SCALE give RM page
 * coordinates, i.e. the RM page (1404x1872 file-space) appears in tldraw at
 * 72 DPI size.
 */

import { RM_SCALE } from './pen'
import type { Xy } from './points'

export interface ShapeTransform {
    /** Shape position in tldraw page space. */
    x: number
    y: number
    /** Shape rotation in radians. */
    rotation?: number
    /** Optional FULL page affine (tldraw Mat components a,b,c,d,e,f). When
     *  present it maps shape-local -> page px directly, composing group/frame
     *  ancestors + own rotation, and x/y/rotation are ignored. Without it, a
     *  grouped/framed shape projects at the wrong page location. */
    m?: [number, number, number, number, number, number]
}

/** Local shape point -> RM page coordinates. */
export function toRmSpace(pt: Xy, shape: ShapeTransform): Xy {
    const m = shape.m
    if (m) {
        // pageX = a*x + c*y + e ; pageY = b*x + d*y + f  (tldraw Mat.applyToPoint)
        const wx = m[0] * pt.x + m[2] * pt.y + m[4]
        const wy = m[1] * pt.x + m[3] * pt.y + m[5]
        return { x: wx / RM_SCALE, y: wy / RM_SCALE }
    }
    const r = shape.rotation ?? 0
    const cos = Math.cos(r)
    const sin = Math.sin(r)
    const wx = shape.x + pt.x * cos - pt.y * sin
    const wy = shape.y + pt.x * sin + pt.y * cos
    return { x: wx / RM_SCALE, y: wy / RM_SCALE }
}

/** RM page coordinates -> tldraw world coordinates. */
export function toTldrawSpace(pt: Xy): Xy {
    return { x: pt.x * RM_SCALE, y: pt.y * RM_SCALE }
}

export function mapToRmSpace(points: Xy[], shape: ShapeTransform): Xy[] {
    return points.map((p) => toRmSpace(p, shape))
}
