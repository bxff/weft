/**
 * Device text column as a tldraw shape, edited with RichTextLabel/TipTap.
 * Pinned to the device rect: no resize, no rotation, translation snaps back.
 * Hit-testing is per text line (props.lines) so empty lines stay
 * click-transparent to ink underneath. Typography from device-text-style.ts
 * (one stylesheet for static + editor). Commits diff the flattened TipTap doc
 * into text CRDT edits via a per-editor handler.
 */

import {
    Group2d,
    HTMLContainer,
    Rectangle2d,
    SVGContainer,
    RichTextLabel,
    ShapeUtil,
    T,
    richTextValidator,
    toRichText,
    useIsEditing,
    type Editor,
    type TLBaseShape,
    type TLRichText,
} from 'tldraw'
import { RM_SCALE } from '@weft/rm-ink'
import { ensureDeviceTextStyles } from './device-text-style'
import { buildSvgLines, DeviceTextSvgContent, svgContentBounds } from './device-text-svg'
import { BODY_FAMILY, BODY_PX } from './text-metrics'
import { useInteracting } from './use-interacting'

export interface DeviceTextLine {
    x: number
    y: number
    w: number
    h: number
}

declare module 'tldraw' {
    interface TLGlobalShapePropsMap {
        'device-text': DeviceTextShape['props']
    }
}

export type DeviceTextShape = TLBaseShape<
    'device-text',
    { w: number; h: number; richText: TLRichText; lines: DeviceTextLine[] }
>

/** Body metrics (text-metrics.ts): the body font at the device's 32-ink em
 *  and 45.546875-ink line stride. Same source as the wrap/anchor layout, so
 *  visible text and anchors agree. Headings/lists from the stylesheet. */
export const DEVICE_TEXT_FONT = BODY_FAMILY
export const DEVICE_TEXT_SIZE = BODY_PX
export const DEVICE_TEXT_LINE_HEIGHT = (45.546875 * RM_SCALE) / DEVICE_TEXT_SIZE

const commitHandlers = new WeakMap<Editor, (richText: TLRichText) => void>()

/** The controller registers what happens when a device-text edit ends. */
export function setDeviceTextCommit(
    editor: Editor,
    handler: (richText: TLRichText) => void,
): void {
    commitHandlers.set(editor, handler)
}

/** Empty column geometry: full bounds for culling/indicator/outline but
 *  never a hit, so ink underneath owns every click. */
class GhostRectangle2d extends Rectangle2d {
    override ignoreHit(): boolean {
        return true
    }
}


export class DeviceTextShapeUtil extends ShapeUtil<DeviceTextShape> {
    static override type = 'device-text' as const
    static override props = {
        w: T.number,
        h: T.number,
        richText: richTextValidator,
        lines: T.arrayOf(
            T.object({ x: T.number, y: T.number, w: T.number, h: T.number }),
        ),
    }

    override getDefaultProps(): DeviceTextShape['props'] {
        return { w: 936 * RM_SCALE, h: 140, richText: toRichText(''), lines: [] }
    }

    override canEdit(): boolean {
        return true
    }
    override canResize(): boolean {
        return false
    }
    override hideRotateHandle(): boolean {
        return true
    }
    override hideResizeHandles(): boolean {
        return true
    }
    /** Suppress tldraw's built-in selection-bounds box; the content-hugging
     *  indicator is the only selection visual (else two nested boxes). */
    override hideSelectionBoundsFg(): boolean {
        return true
    }
    override hideSelectionBoundsBg(): boolean {
        return true
    }

    override getGeometry(shape: DeviceTextShape) {
        const { w, h, lines } = shape.props
        if (lines.length === 0) {
            // no visible text: reject all hits (ignoreHit) so ink underneath
            // owns clicks. isFilled must be true: tldraw only consults
            // ignoreHit on the filled branch (hollow shapes always select on
            // inside clicks).
            return new GhostRectangle2d({
                width: Math.max(w, 1),
                height: Math.max(h, 24),
                isFilled: true,
            })
        }
        return new Group2d({
            children: lines.map(
                (l) =>
                    new Rectangle2d({
                        x: l.x,
                        y: l.y,
                        width: Math.max(l.w, 1),
                        height: Math.max(l.h, 1),
                        isFilled: true,
                    }),
            ),
        })
    }

    /** The column is pinned to the device rect: moving it snaps back. */
    override onTranslateEnd(initial: DeviceTextShape, current: DeviceTextShape) {
        if (initial.x !== current.x || initial.y !== current.y) {
            this.editor.updateShape({
                id: current.id,
                type: 'device-text',
                x: initial.x,
                y: initial.y,
            })
        }
    }

    override onEditEnd(shape: DeviceTextShape): void {
        commitHandlers.get(this.editor)?.(shape.props.richText)
    }

    override component(shape: DeviceTextShape) {
        ensureDeviceTextStyles()
        /* eslint-disable react-hooks/rules-of-hooks */
        const isEditing = useIsEditing(shape.id)
        const interacting = useInteracting()
        /* eslint-enable react-hooks/rules-of-hooks */
        const h = Math.max(shape.props.h, 24)
        // Static view renders in the SVGContainer, the same layer as ink.
        // An HTMLContainer composites on its own pixel-snapped layer, shifting
        // text against ink during camera motion. Editing swaps in the TipTap DOM.
        if (!isEditing) {
            return (
                <SVGContainer style={{ pointerEvents: 'none', overflow: 'visible' }}>
                    {interacting && (
                        <rect
                            width={shape.props.w}
                            height={h}
                            fill="none"
                            stroke="rgba(120, 120, 120, 0.55)"
                            strokeWidth={1}
                            strokeDasharray="4 3"
                        />
                    )}
                    <g transform={`scale(${RM_SCALE})`}>
                        <DeviceTextSvgContent
                            richText={shape.props.richText}
                            widthInk={shape.props.w / RM_SCALE}
                        />
                    </g>
                </SVGContainer>
            )
        }
        return (
            <HTMLContainer
                style={{
                    width: shape.props.w,
                    height: h,
                    pointerEvents: 'all',
                }}
            >
                <div
                    style={{
                        position: 'absolute',
                        inset: 0,
                        border: '1px dashed rgba(120, 120, 120, 0.55)',
                        pointerEvents: 'none',
                    }}
                />
                {isEditing && (
                    <RichTextLabel
                        shapeId={shape.id}
                        type="device-text"
                        richText={shape.props.richText}
                        fontFamily={DEVICE_TEXT_FONT}
                        fontSize={DEVICE_TEXT_SIZE}
                        lineHeight={DEVICE_TEXT_LINE_HEIGHT}
                        textAlign="start"
                        verticalAlign="start"
                        wrap
                        isSelected={false}
                        labelColor="#1a1a18"
                        textWidth={shape.props.w}
                        padding={0}
                    />
                )}
            </HTMLContainer>
        )
    }

    /** Indicators render from Path2D (indicator() is a deprecated stub whose
     *  absence crashes the selection transition). The box hugs the rendered
     *  content, computed from the same layout the SVG draws (blank lines,
     *  markers, checkboxes included). No indicator while editing. */
    private indicatorRect(
        shape: DeviceTextShape,
    ): { x: number; y: number; w: number; h: number } | null {
        if (this.editor.getEditingShapeId() === shape.id) return null
        const PAD = 8 // ink; a little air so glyphs don't touch the line
        const b = svgContentBounds(buildSvgLines(shape.props.richText, shape.props.w / RM_SCALE))
        if (!b) return { x: 0, y: 0, w: shape.props.w, h: Math.max(shape.props.h, 24) }
        return {
            x: (b.x0 - PAD) * RM_SCALE,
            y: (b.y0 - PAD) * RM_SCALE,
            w: (b.x1 - b.x0 + 2 * PAD) * RM_SCALE,
            h: (b.y1 - b.y0 + 2 * PAD) * RM_SCALE,
        }
    }

    override getIndicatorPath(shape: DeviceTextShape) {
        const path = new Path2D()
        const r = this.indicatorRect(shape)
        if (r) path.rect(r.x, r.y, r.w, r.h)
        return path
    }

    override indicator(shape: DeviceTextShape) {
        const r = this.indicatorRect(shape)
        if (!r) return null
        return <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={2} />
    }
}
