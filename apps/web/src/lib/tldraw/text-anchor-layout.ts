/**
 * Text-anchor resolution: place text-anchored handwriting relative to the
 * anchor's current laid-out position. xochitl groups ink near typed text
 * under an anchor (a root-text char id, usually the line-opening '\n', or a
 * start/end-of-text sentinel) and stores children relative to it. Layout
 * comes from text-metrics.ts, the same function the visible text renders
 * from, so ink and text cannot disagree.
 */

import {
    ANCHOR_TEXT_END,
    ANCHOR_TEXT_START,
    crdtIdEquals,
    crdtIdKey,
    linearizeRootText,
    rootTextCharPositions,
    type RmDocument,
} from '@weft/rm-format'
import {
    canvasMeasure,
    layoutText,
    PARA_STRIDE_INK,
    type MeasureFn,
    type ParagraphLayout,
} from './text-metrics'

export type { MeasureFn }

/** line top (ink, relative to text top) for a char at (paragraph, offset). */
export function lineTopOf(
    paras: ParagraphLayout[],
    pIdx: number,
    offset: number,
    fallback: number,
): number {
    const l = paras[pIdx]
    if (!l) return fallback
    if (offset < 0) return l.topInk // '\n' opener anchors at the paragraph top
    let line = 0
    for (let i = l.lineStarts.length - 1; i >= 0; i--) {
        if (offset >= l.lineStarts[i]!) {
            line = i
            break
        }
    }
    return l.topInk + line * l.lineStrideInk
}

/**
 * (dx, dy) in ink units per anchored group nodeId key. Groups whose anchor
 * cannot be resolved (no root text) are omitted; raw coords are the fallback.
 */
export function computeAnchorOffsets(
    doc: RmDocument,
    measure: MeasureFn = canvasMeasure(),
): Map<string, { dx: number; dy: number }> {
    const out = new Map<string, { dx: number; dy: number }>()
    const groups = doc.anchoredGroups()
    if (groups.length === 0) return out
    const text = doc.tree().rootText
    if (!text) return out
    const paragraphs = linearizeRootText(text)
    const chars = rootTextCharPositions(text)
    const { paras, lastLineTopInk } = layoutText(paragraphs, text.width, measure)
    const posY = text.posY
    const posX = text.posX

    // Device PDF regressions: Mako's START uses the second paragraph's
    // line-box top, not its baseline (a 33.59375-unit difference).
    // Mako and InterSync END groups likewise use the last line's top.
    // These groups have anchorType=2: that field alone does not imply a
    // baseline offset. The former type-2 branches were unreachable because
    // anchoredGroups() did not expose anchorType.
    const p0 = paras[0]
    const p1 = paras[1]
    const startY =
        p0 === undefined
            ? PARA_STRIDE_INK
            : p1 === undefined
              ? p0.firstBaselineInk + PARA_STRIDE_INK
              : p1.topInk
    // Preserve the existing fallback for a missing second paragraph;
    // the device regression above covers the multi-paragraph case.
    const endY = lastLineTopInk
    const charAt = new Map(chars.map((c) => [crdtIdKey(c.id), c]))

    for (const g of groups) {
        let dy: number
        let dx: number
        if (crdtIdEquals(g.anchorId, ANCHOR_TEXT_START)) {
            dy = posY + startY
            dx = g.originX ?? posX
        } else if (crdtIdEquals(g.anchorId, ANCHOR_TEXT_END)) {
            dy = posY + endY
            dx = g.originX ?? posX
        } else {
            const pos = charAt.get(crdtIdKey(g.anchorId))
            // Anchor to a vanished char degrades to end-of-text. '\n' opener
            // (offset -1) anchors at its line's top; a mid-line char (offset
            // >= 0) anchors at that line's baseline.
            if (pos) {
                const para = paras[pos.paragraphIndex]
                if (pos.offset >= 0 && para) {
                    let lineIdx = 0
                    for (let i = para.lineStarts.length - 1; i >= 0; i--) {
                        if (pos.offset >= para.lineStarts[i]!) {
                            lineIdx = i
                            break
                        }
                    }
                    dy = posY + para.firstBaselineInk + lineIdx * para.lineStrideInk
                } else {
                    dy = posY + lineTopOf(paras, pos.paragraphIndex, pos.offset, endY)
                }
            } else {
                dy = posY + endY
            }
            // keep stored X when present, else fall back to the column
            dx = g.originX ?? posX
        }
        out.set(crdtIdKey(g.nodeId), { dx, dy })
    }
    return out
}
