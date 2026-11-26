import type { Xy } from './points'

type Edge = readonly [Xy, Xy]
type Interval = [number, number]
const EPS = 1e-7

function edgesOf(contours: Xy[][]): Edge[] {
    return contours.flatMap((c) => c.flatMap((a, i): Edge[] => {
        const b = c[(i + 1) % c.length]!
        return a.x === b.x && a.y === b.y ? [] : [[a, b]]
    }))
}

function inside(p: Xy, edges: Edge[]): boolean {
    let hit = false
    for (const [a, b] of edges) {
        if ((a.y > p.y) !== (b.y > p.y) &&
            p.x < a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y)) hit = !hit
    }
    return hit
}

/** Intersection of a horizontal line with the radius-r capsule around an edge. */
function forbiddenX([a, b]: Edge, y: number, r: number): Interval | undefined {
    if (y < Math.min(a.y, b.y) - r || y > Math.max(a.y, b.y) + r) return
    let lo = Infinity
    let hi = -Infinity
    for (const p of [a, b]) {
        const dy = Math.abs(y - p.y)
        if (dy > r) continue
        const dx = Math.sqrt(Math.max(0, r * r - dy * dy))
        lo = Math.min(lo, p.x - dx)
        hi = Math.max(hi, p.x + dx)
    }
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    const nx = (-dy * r) / len
    const ny = (dx * r) / len
    for (const sign of [-1, 1]) {
        const ay = a.y + sign * ny
        const by = b.y + sign * ny
        if (y < Math.min(ay, by) || y > Math.max(ay, by)) continue
        const ax = a.x + sign * nx
        const bx = b.x + sign * nx
        if (ay === by) {
            lo = Math.min(lo, ax, bx)
            hi = Math.max(hi, ax, bx)
        } else {
            const x = ax + ((y - ay) * (bx - ax)) / (by - ay)
            lo = Math.min(lo, x)
            hi = Math.max(hi, x)
        }
    }
    return Number.isFinite(lo) ? [lo, hi] : undefined
}

function safeSpans(edges: Edge[], y: number, r: number): Interval[] {
    const crossings: number[] = []
    const forbidden: Interval[] = []
    for (const e of edges) {
        const [a, b] = e
        if ((a.y > y) !== (b.y > y))
            crossings.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y))
        const blocked = forbiddenX(e, y, r)
        if (blocked) forbidden.push(blocked)
    }
    crossings.sort((a, b) => a - b)
    forbidden.sort((a, b) => a[0] - b[0])
    const spans: Interval[] = []
    for (let i = 0; i + 1 < crossings.length; i += 2) {
        let at = crossings[i]!
        const end = crossings[i + 1]!
        for (const [lo, hi] of forbidden) {
            if (hi < at) continue
            if (lo > end) break
            if (lo - at > EPS) spans.push([at, lo])
            at = Math.max(at, hi)
            if (at >= end) break
        }
        if (end - at > EPS) spans.push([at, end])
    }
    return spans
}

function pointDistance2(p: Xy, a: Xy, b: Xy): number {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length2 = dx * dx + dy * dy
    const t = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0
    return (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2
}

function side(a: Xy, b: Xy, p: Xy): number {
    return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
}

// Only connect passes if the whole round marker still fits, including at a hole or angled edge.
function safeJoin(a: Xy, b: Xy, edges: Edge[], r: number): boolean {
    const limit = Math.max(0, r * r - EPS)
    for (const [c, d] of edges) {
        if (Math.max(a.x, b.x) + r < Math.min(c.x, d.x) ||
            Math.max(c.x, d.x) + r < Math.min(a.x, b.x) ||
            Math.max(a.y, b.y) + r < Math.min(c.y, d.y) ||
            Math.max(c.y, d.y) + r < Math.min(a.y, b.y)) continue
        if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return false
        if (Math.min(pointDistance2(a, c, d), pointDistance2(b, c, d),
            pointDistance2(c, a, b), pointDistance2(d, a, b)) < limit) return false
    }
    return true
}

function fill(edges: Edge[], lo: number, hi: number, r: number): Xy[][] {
    const height = hi - lo - 2 * r
    if (height < -EPS) return []
    const count = Math.min(256, Math.max(1, Math.ceil(height / (r * 1.55))))
    const pitch = Math.max(0, height) / count
    // Never use a degenerate path; a short pass still draws a rounded dot.
    const out: Xy[][] = []
    let previous: { last: Xy; path: Xy[]; reverse: boolean; span: Interval }[] = []
    for (let row = 0; row < count; row++) {
        const y = lo + r + (row + 0.5) * pitch
        const spans = safeSpans(edges, y, r)
        const used = new Set<Xy[]>()
        previous = spans.map(([x0, x1]) => {
            for (const p of previous) {
                const end = p.reverse ? x1 : x0
                const start = { x: end, y }
                if (used.has(p.path) || Math.abs(p.last.x - end) > 4 * r) continue
                if (!safeJoin(p.last, start, edges, r)) {
                    // Where a straight turnaround would graze a curved edge,
                    // backtrack slightly down the completed pass before turning.
                    const low = Math.max(p.span[0], x0)
                    const high = Math.min(p.span[1], x1)
                    if (high <= low) continue
                    const x = p.reverse ? Math.max(low, high - r * 0.5)
                        : Math.min(high, low + r * 0.5)
                    const a = { x, y: p.last.y }
                    const b = { x, y }
                    if (Math.abs(x - end) > 3 * r || Math.abs(x - p.last.x) > 3 * r ||
                        !safeJoin(a, b, edges, r)) continue
                    p.path.push(a, b)
                }
                const last = { x: p.reverse ? x0 : x1, y }
                p.path.push(start, last)
                used.add(p.path)
                return { path: p.path, last, reverse: !p.reverse, span: [x0, x1] }
            }
            const last = { x: x1, y }
            const path = [{ x: x0, y }, last]
            out.push(path)
            return { path, last, reverse: true, span: [x0, x1] }
        })
    }
    return out
}

/** Paths and radii for ink contained within the letter's original contours. */
export function insetGlyphFill(
    contours: Xy[][],
    radii: readonly number[],
): { paths: Xy[][]; widthIndex: number }[] {
    if (contours.length === 0 || !radii.length || !(radii[0]! > 0)) return []
    const edges = edgesOf(contours)
    const contourEdges = contours.map((c) => edgesOf([c]))
    const out: { paths: Xy[][]; widthIndex: number }[] = []
    for (const [i, contour] of contours.entries()) {
        const first = contour[0]
        if (!first) continue
        // Holes are not separate pieces to ink; dots and trademark accents are.
        const others = contourEdges.filter((_, j) => j !== i).flat()
        if (inside(first, others)) continue
        const lo = Math.min(...contour.map((p) => p.y))
        const hi = Math.max(...contour.map((p) => p.y))
        let covered = false
        for (const [widthIndex, r] of radii.entries()) {
            if (!(r > 0)) continue
            const paths = fill(edges, lo, hi, r).filter((path) => inside(path[0]!, contourEdges[i]!))
            if (!paths.length) continue
            out.push({ paths, widthIndex })
            covered = true
            break
        }
        // When even the smallest representable marker doesn't fit, keep this
        // component visible with a fine outline instead of dropping punctuation.
        if (!covered)
            out.push({ paths: [contour], widthIndex: radii.length - 1 })
    }
    return out
}
