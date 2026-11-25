import type { ReactElement } from 'react'
import { Box, DrawShapeUtil, getPointsFromDrawSegments, type SvgExportContext, type TLDrawShape } from 'tldraw'
import {
    decodeRmPointData,
    getStyleFn,
    isRmBrush,
    RM_COLORS,
    RM_SCALE,
    type RmBrush,
} from '@weft/rm-ink'

type Pt = { x: number; y: number }

// This additional paint cache initially stores bounds only.
// Prepare SVG lazily when a stroke is first painted or exported.
type TabletInk = { bounds: Box; element?: ReactElement }

const f = (v: number) => v.toFixed(2)

export class RmDrawShapeUtil extends DrawShapeUtil {
    // The SDK also keys shape content by the immutable props and meta. Moving
    // or rotating a stroke keeps its local paint and hit geometry reusable.
    private readonly paintCache = new WeakMap<TLDrawShape['props'], { meta: TLDrawShape['meta']; ink: TabletInk | undefined }>()

    override getGeometry(shape: TLDrawShape) {
        const geometry = super.getGeometry(shape)
        const bounds = this.tabletInk(shape, false)?.bounds
        if (bounds) {
            // Circle2d overrides getBounds for short draw strokes. Both SDK
            // accessors must describe the same paint; its hit geometry stays intact.
            geometry.getBounds = () => bounds
            geometry.getBoundsVertices = () => bounds.corners
        }
        return geometry
    }

    override component(shape: TLDrawShape) {
        return this.tabletInk(shape, true)?.element ?? super.component(shape)
    }

    override toSvg(shape: TLDrawShape, ctx: SvgExportContext) {
        const ink = this.tabletInk(shape, true)
        if (!ink?.element) return super.toSvg(shape, ctx)
        // tldraw scales its export wrapper. The canvas paths already have their final dimensions.
        return <g transform={`scale(${1 / shape.props.scale})`}>{ink.element}</g>
    }

    private tabletInk(shape: TLDrawShape, render: boolean): TabletInk | undefined {
        if (!shape.meta.rmPointData) return
        const cached = this.paintCache.get(shape.props)
        if (cached && cached.meta === shape.meta) {
            if (render && cached.ink && !cached.ink.element) {
                cached.ink = this.prepareInk(shape, true, cached.ink.bounds)
            }
            return cached.ink
        }
        const ink = this.prepareInk(shape, render)
        this.paintCache.set(shape.props, {meta: shape.meta, ink})
        return ink
    }

    private prepareInk(shape: TLDrawShape, render: boolean, cachedBounds?: Box): TabletInk | undefined {
        const meta = shape.meta as { rmBrush?: RmBrush; rmPointData?: string; rmColor?: string }
        if (!isRmBrush(meta.rmBrush) || typeof meta.rmPointData !== 'string' || !meta.rmPointData) return
        // scaleX/scaleY carry tldraw 5 resizes; the base geometry applies
        // them, so the render must too or the selection box resizes while
        // the ink stays put. Widths scale by the average factor.
        const sx = shape.props.scaleX ?? 1, sy = shape.props.scaleY ?? 1
        const wScale = (Math.abs(sx) + Math.abs(sy)) / 2
        let points: Pt[]
        try {
            points = getPointsFromDrawSegments(shape.props.segments, sx, sy)
        } catch {
            return
        }
        if (!points.length) return
        const rmData = decodeRmPointData(meta.rmPointData)
        if (!rmData.length) return
        const styleFn = getStyleFn(meta.rmBrush)
        const color = typeof meta.rmColor === 'string' && Object.hasOwn(RM_COLORS, meta.rmColor) ? meta.rmColor : 'black'
        const base = RM_COLORS[color]!

        // Highlighter: one path per stroke, not per-segment lines. Per-segment
        // opacity would stack toward opaque at overlapping round-cap joints
        // and blot out what's underneath. A single polyline applies opacity
        // once; width is constant for this brush so no fidelity is lost.
        const highlighter = meta.rmBrush === 'highlighter'
        // These pens use a constant color and opacity. A uniform native width
        // makes the entire stroke one paint operation at every zoom level.
        const flat = (meta.rmBrush === 'fineliner' || meta.rmBrush === 'calligraphy' ||
            meta.rmBrush === 'marker' || meta.rmBrush === 'shader') && rmData.every(p => p.width === rmData[0]!.width)
        if (highlighter || points.length === 1 || flat) {
            const rm = rmData[0]!
            const style = styleFn(base, rm.width / 4, rm.pressure / 255, rm.speed / 4)
            const width = flat && points.length > 1
                ? Math.max(0.25, Math.round(Math.max(0.1, style.width * RM_SCALE) * wScale * 4) / 4)
                : Math.max(0.2, style.width * RM_SCALE * wScale)
            const bounds = cachedBounds ?? Box.FromPoints(points).expandBy(width / 2)
            if (!render) return { bounds }
            const p = points[0]!
            return { bounds, element: (
                <svg className={highlighter ? 'weft-highlighter' : undefined}
                    style={{ overflow: 'visible', mixBlendMode: highlighter ? 'darken' : undefined }}>
                    {points.length === 1
                        ? <circle cx={p.x} cy={p.y} r={width / 2} fill={style.color} opacity={style.opacity} />
                        : flat ? <path d={points.map((p, i) => `${i === 0 ? 'M' : 'L'}${f(p.x)},${f(p.y)}`).join('')}
                            fill="none" stroke={style.color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" opacity={style.opacity} />
                        : <polyline points={points.map((p) => `${p.x},${p.y}`).join(' ')} fill="none"
                            stroke={style.color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" opacity={style.opacity} />}
                </svg>
            ) }
        }

        // Pen brushes: per-segment round-capped strokes, bucketed. Round caps
        // overlapping at joints is what blends per-segment shade steps into
        // smooth graphite (flat-edged quads show steps as hard facets). This
        // keeps that look while bounding DOM cost: segments group into one
        // <path> per (shade level, quantized width) bucket, painted light ->
        // dark so joints layer like graphite. A constant-color constant-width
        // pen is a single bucket; a shaded pencil stroke is a few dozen paths.
        const n = points.length
        const styles: ReturnType<typeof styleFn>[] = []
        let minW = Infinity, maxW = -Infinity
        for (let i = 0; i < n; i++) {
            const rm = rmData[Math.min(i, rmData.length - 1)]!
            const style = styleFn(base, rm.width / 4, rm.pressure / 255, rm.speed / 4)
            style.width = Math.max(0.1, style.width * RM_SCALE) * wScale
            minW = Math.min(minW, style.width)
            maxW = Math.max(maxW, style.width)
            if (render) styles.push(style)
        }
        const wStep = Math.max(0.25, (maxW - minW) / 4)
        const paintWidth = (width: number) => Math.max(0.2, Math.round(Math.max(0.2, width) / wStep) * wStep)
        // An averaged segment width cannot exceed the quantized maximum.
        const radius = paintWidth(maxW) / 2
        const bounds = cachedBounds ?? Box.FromPoints(points).expandBy(radius)
        if (!render) return { bounds }
        let minLv = Infinity, maxLv = -Infinity
        const levels = styles.map(style => {
            const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(style.color)
            const level = m ? Math.round((Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 / 8) : 0
            minLv = Math.min(minLv, level)
            maxLv = Math.max(maxLv, level)
            return level
        })
        const lvStep = Math.max(1, Math.ceil((maxLv - minLv + 1) / 10))
        const buckets = new Map<
            string,
            { level: number; width: number; color: string; opacity: number; d: string[] }
        >()
        // consecutive segments in the same bucket chain into one polyline
        // (L-continuation, not a fresh M subpath), keeping path data lean
        let prevKey = ''
        for (let i = 0; i < n - 1; i++) {
            // darker end labels the segment (graphite deposits read dark)
            const pick = levels[i]! <= levels[i + 1]! ? i : i + 1
            const wq = paintWidth((styles[i]!.width + styles[i + 1]!.width) / 2)
            const lq = Math.round(levels[pick]! / lvStep)
            const key = `${lq}|${wq.toFixed(2)}`
            let b = buckets.get(key)
            if (!b) {
                b = {
                    level: levels[pick]!,
                    width: wq,
                    color: styles[pick]!.color,
                    opacity: styles[pick]!.opacity,
                    d: [],
                }
                buckets.set(key, b)
            }
            if (key === prevKey) {
                b.d.push(`L${f(points[i + 1]!.x)},${f(points[i + 1]!.y)}`)
            } else {
                b.d.push(
                    `M${f(points[i]!.x)},${f(points[i]!.y)}L${f(points[i + 1]!.x)},${f(points[i + 1]!.y)}`,
                )
            }
            prevKey = key
        }
        // light -> dark: darker segments' round caps paint over lighter
        // neighbours at the joints, matching layered graphite
        const ordered = [...buckets.values()].sort((a, b) => b.level - a.level)
        return { bounds, element: (
            <svg style={{ overflow: 'visible' }}>
                {ordered.map((b, i) => (
                    <path
                        key={i}
                        d={b.d.join('')}
                        fill="none"
                        stroke={b.color}
                        strokeWidth={b.width}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity={b.opacity}
                    />
                ))}
            </svg>
        ) }
    }
}
