/**
 * Path command walker: tldraw PathBuilder commands -> dense polylines.
 *
 * Pure: accepts a command array (the caller extracts `PathBuilder.commands`
 * via the tldraw-internal adapter, the only place allowed to touch
 * @internal APIs). No SVG-string round-trips.
 */

import type { Xy } from './points'

export interface PathCommand {
    type: 'move' | 'line' | 'cubic'
    x: number
    y: number
    isClose?: boolean
    cp1?: Xy
    cp2?: Xy
}

export interface WalkOptions {
    /** Max gap between emitted points along straight lines (px). */
    pointDensity?: number
    /** Flatness threshold for adaptive cubic subdivision (px). */
    flatness?: number
}

/** Flatten one cubic adaptively (De Casteljau, depth-capped). */
export function flattenCubic(p0: Xy, cp1: Xy, cp2: Xy, p3: Xy, flatness = 0.5): Xy[] {
    const out: Xy[] = []
    recurse(p0, cp1, cp2, p3, flatness * flatness, out, 0)
    out.push(p3)
    return out
}

function recurse(p0: Xy, cp1: Xy, cp2: Xy, p3: Xy, flatnessSq: number, out: Xy[], depth: number): void {
    if (depth > 10) {
        out.push(p0)
        return
    }
    const dx = p3.x - p0.x
    const dy = p3.y - p0.y
    const lenSq = dx * dx + dy * dy
    if (lenSq < 0.001) {
        out.push(p0)
        return
    }
    const d1 = Math.abs((cp1.x - p0.x) * dy - (cp1.y - p0.y) * dx)
    const d2 = Math.abs((cp2.x - p0.x) * dy - (cp2.y - p0.y) * dx)
    if (((d1 + d2) * (d1 + d2)) / lenSq <= flatnessSq) {
        out.push(p0)
        return
    }
    const m = (a: Xy, b: Xy): Xy => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    const m01 = m(p0, cp1)
    const m12 = m(cp1, cp2)
    const m23 = m(cp2, p3)
    const m012 = m(m01, m12)
    const m123 = m(m12, m23)
    const mid = m(m012, m123)
    recurse(p0, m01, m012, mid, flatnessSq, out, depth + 1)
    recurse(mid, m123, m23, p3, flatnessSq, out, depth + 1)
}

function interpolate(start: Xy, end: Xy, maxGap: number): Xy[] {
    const dx = end.x - start.x
    const dy = end.y - start.y
    const dist = Math.hypot(dx, dy)
    if (dist <= maxGap) return [start]
    const steps = Math.ceil(dist / maxGap)
    const out: Xy[] = []
    for (let i = 0; i < steps; i++) {
        const t = i / steps
        out.push({ x: start.x + dx * t, y: start.y + dy * t })
    }
    return out
}

/**
 * Walk a command list into one dense polyline per subpath.
 */
export function walkPathCommands(commands: PathCommand[], opts: WalkOptions = {}): Xy[][] {
    const pointDensity = opts.pointDensity ?? 3
    const flatness = opts.flatness ?? 0.5
    const subpaths: Xy[][] = []
    let current: Xy[] = []
    let prev: Xy = { x: 0, y: 0 }
    let subpathStart: Xy = { x: 0, y: 0 }

    const flush = () => {
        if (current.length >= 2) subpaths.push(current)
        current = []
    }
    const push = (pt: Xy) => {
        const last = current[current.length - 1]
        if (!last || Math.abs(pt.x - last.x) > 0.01 || Math.abs(pt.y - last.y) > 0.01) {
            current.push(pt)
        }
    }

    for (const cmd of commands) {
        switch (cmd.type) {
            case 'move':
                flush()
                prev = { x: cmd.x, y: cmd.y }
                subpathStart = prev
                current.push(prev)
                break
            case 'line': {
                const end: Xy = cmd.isClose ? subpathStart : { x: cmd.x, y: cmd.y }
                for (const pt of interpolate(prev, end, pointDensity)) push(pt)
                push(end)
                prev = end
                break
            }
            case 'cubic': {
                const end: Xy = { x: cmd.x, y: cmd.y }
                const pts = flattenCubic(prev, cmd.cp1 ?? prev, cmd.cp2 ?? end, end, flatness)
                for (let i = 1; i < pts.length; i++) push(pts[i]!)
                prev = end
                break
            }
        }
    }
    flush()
    return subpaths
}

/**
 * Flatten an SVG `d` string into one dense polyline per subpath. Handles
 * exactly the command set tldraw's PathBuilder.toDrawD emits — absolute
 * M / L / Q / C / Z — which is what lets the projection ship the SAME
 * hand-drawn outline (rounded corners + seeded wobble) the browser renders
 * for dash:'draw' shapes, instead of the raw sharp-cornered skeleton.
 * Unknown commands throw: the caller falls back to the skeleton path.
 */
export function flattenSvgD(d: string, flatness = 0.5): Xy[][] {
    const tokens = d.match(/[MLQCZ]|-?\d*\.?\d+(?:e[+-]?\d+)?/gi)
    if (!tokens) return []
    const subpaths: Xy[][] = []
    let current: Xy[] = []
    let prev: Xy = { x: 0, y: 0 }
    let start: Xy = { x: 0, y: 0 }
    let i = 0
    const num = (): number => {
        const v = Number(tokens[i++])
        if (!Number.isFinite(v)) throw new Error(`flattenSvgD: bad number in d`)
        return v
    }
    const flush = () => {
        if (current.length >= 2) subpaths.push(current)
        current = []
    }
    while (i < tokens.length) {
        const cmd = tokens[i++]!
        switch (cmd) {
            case 'M': {
                flush()
                prev = { x: num(), y: num() }
                start = prev
                current.push(prev)
                break
            }
            case 'L': {
                const end = { x: num(), y: num() }
                current.push(end)
                prev = end
                break
            }
            case 'Q': {
                const cp = { x: num(), y: num() }
                const end = { x: num(), y: num() }
                // exact quadratic -> cubic elevation, then the shared flattener
                const cp1 = { x: prev.x + (2 / 3) * (cp.x - prev.x), y: prev.y + (2 / 3) * (cp.y - prev.y) }
                const cp2 = { x: end.x + (2 / 3) * (cp.x - end.x), y: end.y + (2 / 3) * (cp.y - end.y) }
                const pts = flattenCubic(prev, cp1, cp2, end, flatness)
                for (let k = 1; k < pts.length; k++) current.push(pts[k]!)
                prev = end
                break
            }
            case 'C': {
                const cp1 = { x: num(), y: num() }
                const cp2 = { x: num(), y: num() }
                const end = { x: num(), y: num() }
                const pts = flattenCubic(prev, cp1, cp2, end, flatness)
                for (let k = 1; k < pts.length; k++) current.push(pts[k]!)
                prev = end
                break
            }
            case 'Z':
            case 'z': {
                current.push({ ...start })
                prev = start
                break
            }
            default:
                throw new Error(`flattenSvgD: unsupported command ${cmd}`)
        }
    }
    flush()
    return subpaths
}

// ============================================================
// Dash patterns (per segment, matching tldraw's toDashedSvg behavior)
// ============================================================

export function applyDashPattern(
    points: Xy[],
    totalLength: number,
    strokeWidth: number,
    style: 'dashed' | 'dotted',
): Xy[][] {
    if (points.length < 2 || totalLength < 0.1) return [points]

    let dashLength: number
    let gapLength: number
    if (style === 'dashed') {
        dashLength = Math.min(strokeWidth * 2, totalLength / 4)
        let dashCount = Math.floor(totalLength / dashLength / 2)
        if (dashCount < 3) {
            if (totalLength / strokeWidth < 4) return [points]
            dashLength = totalLength / 3
            gapLength = totalLength / 3
        } else {
            dashLength = totalLength / dashCount / 2
            gapLength = (totalLength - dashCount * dashLength) / Math.max(1, dashCount - 1)
        }
    } else {
        // dotted is handled by dottedDots (geometry-true circles); a caller
        // that still asks for phase-cut dots gets the legacy short-dash form.
        if (totalLength < strokeWidth * 2) return [points]
        dashLength = Math.max(strokeWidth * 0.3, 2)
        gapLength = Math.max(strokeWidth * 2 - dashLength, strokeWidth)
    }

    const segments: Xy[][] = []
    let current: Xy[] = [points[0]!]
    let distInPhase = 0
    let inDash = true

    for (let i = 1; i < points.length; i++) {
        const p0 = points[i - 1]!
        const p1 = points[i]!
        const dx = p1.x - p0.x
        const dy = p1.y - p0.y
        const segLen = Math.hypot(dx, dy)
        if (segLen < 0.001) continue

        let consumed = 0
        while (consumed < segLen - 0.001) {
            const threshold = inDash ? dashLength : gapLength
            const remain = threshold - distInPhase
            const available = segLen - consumed
            if (available <= remain) {
                distInPhase += available
                if (inDash) current.push(p1)
                consumed = segLen
            } else {
                consumed += remain
                const t = consumed / segLen
                const split: Xy = { x: p0.x + dx * t, y: p0.y + dy * t }
                if (inDash) {
                    current.push(split)
                    if (current.length >= 2) segments.push(current)
                    current = []
                } else {
                    current = [split]
                }
                inDash = !inDash
                distInPhase = 0
            }
        }
    }
    if (inDash && current.length >= 2) segments.push(current)
    return segments
}

/**
 * Dotted style as geometry-true dots: small closed circles stamped at even
 * spacing along the path (center-to-center 2x stroke width, like tldraw's
 * round-cap dots). Phase-cut slivers render inconsistently on the device
 * since dot size then depends on the brush's near-zero-stroke stamping. A
 * circle of radius strokeWidth/4, drawn with a pen of strokeWidth/2, is a
 * solid round dot ~strokeWidth across under any tool renderer.
 */
export function dottedDots(points: Xy[], totalLength: number, strokeWidth: number): Xy[][] {
    if (points.length < 2 || totalLength < strokeWidth) return [points]
    const spacing = strokeWidth * 2
    const r = strokeWidth / 4
    // Even distribution, like tldraw's getPerfectDashProps: snap the dot count
    // to the path length so the pattern ends exactly at the end point (open)
    // or wraps seamlessly (closed) instead of piling the last dot onto the
    // first.
    const first = points[0]!
    const last = points[points.length - 1]!
    const closed = Math.hypot(last.x - first.x, last.y - first.y) < 0.01
    const count = Math.max(closed ? 3 : 1, Math.round(totalLength / spacing))
    const step = totalLength / count
    const targets: number[] = []
    // open: both endpoints get a dot (count+1 dots); closed: the end IS the start
    for (let k = 0; k < (closed ? count : count + 1); k++) targets.push(k * step)
    const centers: Xy[] = []
    let ti = 0
    let walked = 0
    for (let i = 1; i < points.length && ti < targets.length; i++) {
        const p0 = points[i - 1]!
        const p1 = points[i]!
        const segLen = Math.hypot(p1.x - p0.x, p1.y - p0.y)
        if (segLen < 0.001) continue
        while (ti < targets.length && targets[ti]! <= walked + segLen + 0.001) {
            const t = Math.min(1, Math.max(0, (targets[ti]! - walked) / segLen))
            centers.push({ x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t })
            ti++
        }
        walked += segLen
    }
    return centers.map((c) => {
        const dot: Xy[] = []
        for (let k = 0; k <= 8; k++) {
            const a = (k / 8) * 2 * Math.PI
            dot.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) })
        }
        return dot
    })
}

export function polylineLength(points: Xy[]): number {
    let len = 0
    for (let i = 1; i < points.length; i++) {
        len += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y)
    }
    return len
}
