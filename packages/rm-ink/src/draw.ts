/**
 * Freehand (draw shape) projection: tldraw draw shape -> RM marker stroke
 * with per-point widths via the marker inverse formula.
 *
 * Mirrors tldraw's DrawShapeUtil freehand options exactly so what we write
 * to the tablet is what tldraw renders.
 */

import type { TLDrawShape } from 'tldraw'
import type { Point } from '@weft/rm-format'
import { tldrawRadiusToRmMarkerWidth, RM_SCALE } from './pen'
import { directionByte, speedU16, type InkStroke, type Xy } from './points'
import { drawShapeRawPoints, freehandStrokePoints, type StrokeOptions } from './tldraw-internal'

const STROKE_SIZES: Record<string, number> = { s: 2, m: 3.5, l: 5, xl: 10 }

function modulate(v: number, a: [number, number], b: [number, number], clamp = false): number {
    const result = b[0] + ((v - a[0]) / (a[1] - a[0])) * (b[1] - b[0])
    if (!clamp) return result
    return Math.min(Math.max(result, Math.min(b[0], b[1])), Math.max(b[0], b[1]))
}

const PEN_EASING = (t: number) => t * 0.65 + Math.sin((t * Math.PI) / 2) * 0.35
const easeOutSine = (t: number) => Math.sin((t * Math.PI) / 2)
const linear = (t: number) => t

/** Matches tldraw DrawShapeUtil's freehand options. */
export function freehandOptions(
    dash: string,
    isPen: boolean,
    isComplete: boolean,
    strokeWidth: number,
): StrokeOptions {
    const last = isComplete
    if (dash === 'draw') {
        if (isPen) {
            return {
                size: 1 + strokeWidth * 1.2,
                thinning: 0.62,
                streamline: 0.62,
                smoothing: 0.62,
                simulatePressure: false,
                easing: PEN_EASING,
                last,
            }
        }
        return {
            size: strokeWidth,
            thinning: 0.5,
            streamline: modulate(strokeWidth, [9, 16], [0.64, 0.74], true),
            smoothing: 0.62,
            easing: easeOutSine,
            simulatePressure: true,
            last,
        }
    }
    return {
        size: strokeWidth,
        thinning: 0,
        streamline: modulate(strokeWidth, [9, 16], [0.64, 0.74], true),
        smoothing: 0.62,
        simulatePressure: false,
        easing: linear,
        last,
    }
}

/** Max gap (tldraw px) between emitted device points along the draw
 *  centerline. tldraw renders a draw shape as a quadratic spline through the
 *  midpoints of its (streamlined) stroke points; a fast stroke has very few of
 *  those, so encoding them 1:1 ships a sparse polyline the thin marker nib
 *  draws as visible corners. Sampling that same spline at this density restores
 *  the smooth curve — the 3px parity geo/line shapes already get via
 *  walkPathCommands. */
const DRAW_POINT_DENSITY = 3

interface DensePoint {
    point: Xy
    radius: number
}

/** One quadratic bezier (p0 -> p1, control c) flattened to <= maxGap spacing,
 *  radius interpolated along t. Appends samples AFTER p0 (assumed already
 *  emitted) through the endpoint p1. */
function flattenQuadWithRadius(
    p0: Xy,
    c: Xy,
    p1: Xy,
    r0: number,
    r1: number,
    maxGap: number,
    out: DensePoint[],
): void {
    const approxLen =
        (Math.hypot(p1.x - p0.x, p1.y - p0.y) +
            Math.hypot(c.x - p0.x, c.y - p0.y) +
            Math.hypot(p1.x - c.x, p1.y - c.y)) /
        2
    const steps = Math.max(1, Math.ceil(approxLen / maxGap))
    for (let k = 1; k <= steps; k++) {
        const t = k / steps
        const u = 1 - t
        out.push({
            point: {
                x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
                y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
            },
            radius: r0 + (r1 - r0) * t,
        })
    }
}

/** Resample streamlined stroke points into a dense, smooth centerline that
 *  mirrors tldraw's on-screen render: a quadratic spline whose control points
 *  are the stroke points and whose anchors are their midpoints. Radius is
 *  interpolated so the taper stays smooth. Fewer than 3 points: nothing to
 *  round, pass through. */
function densifyCenterline(pts: DensePoint[], maxGap: number): DensePoint[] {
    const n = pts.length
    if (n < 3) return pts
    const mid = (a: Xy, b: Xy): Xy => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    const out: DensePoint[] = [{ point: pts[0]!.point, radius: pts[0]!.radius }]
    let anchor = pts[0]!.point
    let anchorR = pts[0]!.radius
    for (let i = 1; i < n - 1; i++) {
        const nextAnchor = mid(pts[i]!.point, pts[i + 1]!.point)
        const nextR = (pts[i]!.radius + pts[i + 1]!.radius) / 2
        flattenQuadWithRadius(anchor, pts[i]!.point, nextAnchor, anchorR, nextR, maxGap, out)
        anchor = nextAnchor
        anchorR = nextR
    }
    flattenQuadWithRadius(anchor, pts[n - 1]!.point, pts[n - 1]!.point, anchorR, pts[n - 1]!.radius, maxGap, out)
    return out
}

/**
 * Project a completed draw shape to one RM stroke in RM page coordinates.
 * A single input point projects to a native dot. Empty shapes return null.
 */
export function drawShapeToInk(
    shape: TLDrawShape,
    rmColor: string,
    /** Shape-LOCAL point -> RM page coords. Pass one built from the editor's
     *  getShapePageTransform so grouped/framed/rotated strokes land where they
     *  render on the web. Defaults to a bare shape.x/y translate (correct only
     *  for an un-nested, un-rotated shape at page root). */
    toRm: (p: Xy) => Xy = (p) => ({ x: (shape.x + p.x) / RM_SCALE, y: (shape.y + p.y) / RM_SCALE }),
): InkStroke | null {
    let raw: { x: number; y: number; z: number }[]
    try {
        raw = drawShapeRawPoints(shape)
    } catch {
        return null
    }
    if (raw.length === 0 || raw.some(({ x, y, z }) =>
        !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z),
    )) return null

    const props = shape.props
    const scale = props.scale ?? 1
    const sw = ((STROKE_SIZES[props.size] ?? 3.5) + 1) * scale
    const options = freehandOptions(props.dash, props.isPen, props.isComplete, sw)
    const strokePoints = freehandStrokePoints(raw, options)
    if (strokePoints.length === 0) return null

    // Resample the sparse streamlined skeleton into a dense smooth centerline
    // (matches what tldraw renders on screen) so fast strokes are not corners.
    const dense = densifyCenterline(
        strokePoints.map((sp) => ({ point: sp.point, radius: sp.radius })),
        DRAW_POINT_DENSITY,
    )

    const points: Point[] = []
    let prevRm: Xy | null = null
    for (let i = 0; i < dense.length; i++) {
        const d = dense[i]!
        const rm = toRm(d.point)
        // speed in RM page units (post-transform) so an ancestor scale is
        // reflected in the taper, matching the on-device stroke.
        let speed = 0
        if (prevRm) speed = Math.hypot(rm.x - prevRm.x, rm.y - prevRm.y)
        prevRm = rm
        // direction from the local backward tangent (perfect-freehand's
        // point-to-previous convention the sparse encoder used).
        const prev = dense[i - 1]?.point ?? d.point
        const next = dense[i + 1]?.point ?? d.point
        points.push({
            x: rm.x,
            y: rm.y,
            speed: speedU16(speed),
            direction: directionByte(Math.atan2(prev.y - next.y, prev.x - next.x)),
            width: tldrawRadiusToRmMarkerWidth(d.radius),
            pressure: 128,
        })
    }
    return { points, color: rmColor }
}
