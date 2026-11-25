/**
 * RM lines -> tldraw draw shapes (tablet ink rendering in the studio).
 *
 * Per-point RM data is kept in shape.meta so RmDrawShapeUtil can render
 * pen-faithfully. Shape ids are not minted here: the caller controls identity.
 */

import { compressLegacySegments, type TLDrawShape, type TLShapeId, type TLShapePartial } from 'tldraw'
import type { Line, Point } from '@weft/rm-format'
import { RM_SCALE } from './pen'
import { penToBrush, penColorName } from './palette'

export interface RmPointMeta {
    speed: number
    direction: number
    width: number
    pressure: number
}

export function encodeRmPointData(data: RmPointMeta[]): string {
    const buf = new Float32Array(data.length * 4)
    for (let i = 0; i < data.length; i++) {
        buf[i * 4 + 0] = data[i]!.speed
        buf[i * 4 + 1] = data[i]!.direction
        buf[i * 4 + 2] = data[i]!.width
        buf[i * 4 + 3] = data[i]!.pressure
    }
    const bytes = new Uint8Array(buf.buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
    return btoa(binary)
}

export function decodeRmPointData(encoded: string): RmPointMeta[] {
    if (!encoded) return []
    let binary: string
    try { binary = atob(encoded) } catch { return [] }
    if (binary.length % 16 !== 0) return [] // four float32 fields per point
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const buf = new Float32Array(bytes.buffer)
    if (!buf.every(Number.isFinite)) return []
    const out: RmPointMeta[] = []
    for (let i = 0; i < buf.length; i += 4) {
        out.push({ speed: buf[i]!, direction: buf[i + 1]!, width: buf[i + 2]!, pressure: buf[i + 3]! })
    }
    return out
}

/** Partial tldraw shape record for one RM line. Returns null for erasers. */
export function lineToDrawShape(shapeId: TLShapeId, line: Line): (TLShapePartial<TLDrawShape> & { x: number; y: number }) | null {
    const brush = penToBrush(line.tool)
    if (!brush || line.points.length === 0) return null

    const scaled = line.points.map((p) => ({ x: p.x * RM_SCALE, y: p.y * RM_SCALE }))
    let minX = Infinity
    let minY = Infinity
    for (const p of scaled) {
        if (p.x < minX) minX = p.x
        if (p.y < minY) minY = p.y
    }
    const rel = scaled.map((p) => ({ x: p.x - minX, y: p.y - minY, z: 0.5 }))
    const segments = compressLegacySegments([{ type: 'free' as const, points: rel }])

    return {
        id: shapeId,
        type: 'draw',
        x: minX,
        y: minY,
        props: {
            segments,
            color: 'black',
            fill: 'none',
            dash: 'draw',
            size: 'm',
            isComplete: true,
            isClosed: false,
            isPen: true,
            scale: 1,
        },
        meta: {
            rmBrush: brush,
            rmColor: penColorName(line.color),
            rmThicknessScale: line.thicknessScale,
            rmPointData: encodeRmPointData(
                line.points.map((p: Point) => ({
                    speed: p.speed,
                    direction: p.direction,
                    width: p.width,
                    pressure: p.pressure,
                })),
            ),
        },
    }
}
