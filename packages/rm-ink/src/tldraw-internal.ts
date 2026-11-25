/**
 * The only file allowed to touch tldraw @internal APIs. Everything here is
 * version-sensitive; when tldraw upgrades break the build, this is the
 * single place to fix.
 */

import {
    EASINGS,
    getPointsFromDrawSegments,
    getStrokePoints,
    type TLDrawShape,
    type StrokeOptions,
    type StrokePoint,
    type PathBuilder,
} from 'tldraw'
import type { PathCommand } from './path'

/** Extract raw input points from a draw shape's (compressed) segments.
 *  scaleX/scaleY are how tldraw 5 stores a RESIZE; ignoring them projects a
 *  resized stroke at its original size. */
export function drawShapeRawPoints(shape: TLDrawShape): { x: number; y: number; z: number }[] {
    const props = shape.props as { segments: unknown; scaleX?: number; scaleY?: number }
    const vecs = getPointsFromDrawSegments(props.segments as never, props.scaleX ?? 1, props.scaleY ?? 1)
    return vecs.map((v) => ({ x: v.x, y: v.y, z: (v as { z?: number }).z ?? 0.5 }))
}

/** tldraw's freehand pipeline: raw input -> stroke points with radii. */
export function freehandStrokePoints(
    rawPoints: { x: number; y: number; z: number }[],
    options: StrokeOptions,
): StrokePoint[] {
    const pts = getStrokePoints(rawPoints, options)
    const { size = 16, thinning = 0.5, simulatePressure = true, easing = t => t, start = {}, end = {} } = options
    if (pts.length === 0) return pts
    // The 5.6 SDK exposes the streamed centerline but keeps its width buffer
    // private. Retain the previous width mapping, including public taper options.
    const radius = (pressure: number) => size * easing(0.5 + thinning * (pressure - 0.5))
    if (!simulatePressure && pts[pts.length - 1]!.runningLength < size) {
        const pressure = pts.reduce((max, p) => Math.max(max, p.pressure), 0.5)
        for (const point of pts) {
            point.pressure = pressure
            point.radius = radius(pressure)
        }
        return pts
    }
    let pressure = pts[0]!.pressure
    const smooth = (point: StrokePoint, initial: boolean) => {
        const speed = Math.min(1, point.distance / size)
        const target = simulatePressure ? 1 - speed : point.pressure
        const weight = initial && !simulatePressure ? 0.5 : 0.275 * speed
        return Math.min(1, pressure + (target - pressure) * weight)
    }
    for (const point of pts) {
        if (point.runningLength > size * 5) break
        pressure += (smooth(point, true) - pressure) / 2
    }
    for (const point of pts) {
        pressure = smooth(point, false)
        point.radius = thinning ? radius(pressure) : size / 2
    }
    const length = pts[pts.length - 1]!.runningLength
    const taperLength = (value: boolean | number | undefined) =>
        value === true ? Math.max(size, length) : value || 0
    const startLength = taperLength(start.taper)
    const endLength = taperLength(end.taper)
    if (startLength || endLength) {
        const startEase = start.easing ?? EASINGS.easeOutQuad
        const endEase = end.easing ?? EASINGS.easeOutCubic
        for (const point of pts) {
            const fromStart = point.runningLength < startLength
                ? startEase(point.runningLength / startLength) : 1
            const remaining = length - point.runningLength
            const fromEnd = remaining < endLength ? endEase(remaining / endLength) : 1
            point.radius = Math.max(0.01, point.radius * Math.min(fromStart, fromEnd))
        }
    }
    return pts
}

/** PathBuilder.commands is @internal; normalize to our PathCommand model. */
export function pathBuilderCommands(pb: PathBuilder): PathCommand[] {
    const commands = (pb as unknown as { commands?: unknown[] }).commands
    if (!Array.isArray(commands)) return []
    return commands as PathCommand[]
}

export type { StrokeOptions, StrokePoint }
