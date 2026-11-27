/**
 * RootText linearization: CRDT character sequence -> styled paragraphs.
 *
 * Port of the device's semantics (cross-checked against rmscene text.py):
 * multi-char items expand to per-char items with IMPLICIT consecutive ids;
 * '\n' characters anchor paragraphs (the styles map is keyed by the
 * anchoring char id; the FIRST paragraph anchors at END_MARKER); inline
 * format codes 1/2 toggle bold, 3/4 italic.
 */

import { type CrdtId, crdtId, crdtIdKey, END_MARKER } from './crdt-id'
import { CrdtSequence, type CrdtSequenceItem } from './crdt-sequence'
import { ParagraphStyle, type Text } from './scene-items'

export interface TextSpan {
    text: string
    bold: boolean
    italic: boolean
}

export interface TextParagraph {
    startId: CrdtId
    /** ParagraphStyle, kept as number so firmware-new codes pass through
     *  (10/11 = numbered list levels, 8/9 = indented checkbox/checked). */
    style: number
    /** Device text SIZE (style-entry property 2, device-verified cal19-22):
     *  absent/0 = body, 1 = XL serif (~legacy HEADING), 2 = medium bold
     *  sans, 3 = large serif. */
    sizeCode?: number
    /** List indent level (style-entry property 3): bullets by depth. */
    indentLevel?: number
    spans: TextSpan[]
}

/** Decode a style entry's extra bytes: (property, value) tag pairs —
 *  Byte1@2 = property id, Byte4@3 = value (LE). Property 2 = size,
 *  3 = indent. Unknown properties are ignored (bytes stay preserved). */
export function parseStyleExtra(extra: Uint8Array | undefined): Map<number, number> {
    const out = new Map<number, number>()
    if (!extra) return out
    let i = 0
    while (i + 1 < extra.length) {
        if (extra[i] === 0x21 && i + 1 < extra.length) {
            const prop = extra[i + 1]!
            i += 2
            // marker + 4 LE value bytes: max index i+4 must stay < length
            if (i + 4 < extra.length && extra[i] === 0x34) {
                const v =
                    extra[i + 1]! |
                    (extra[i + 2]! << 8) |
                    (extra[i + 3]! << 16) |
                    (extra[i + 4]! << 24)
                if (!out.has(prop)) out.set(prop, v >>> 0)
                i += 5
            }
        } else {
            break // unknown layout: stop parsing (bytes are still preserved)
        }
    }
    return out
}

/** Encode size/indent back to the wire extra layout. */
export function encodeStyleExtra(props: { size?: number; indent?: number }): Uint8Array | undefined {
    const pairs: number[] = []
    const put = (prop: number, v: number) =>
        pairs.push(0x21, prop, 0x34, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff)
    if (props.size !== undefined && props.size !== 0) put(2, props.size)
    if (props.indent !== undefined) put(3, props.indent)
    return pairs.length ? new Uint8Array(pairs) : undefined
}

/** Browser style writes control size. Keep all other native property bytes
 * in their original order, including an opaque suffix we cannot interpret. */
export function paragraphStyleWriteExtra(
    previous: Uint8Array | undefined,
    changes: Uint8Array | undefined,
): Uint8Array | undefined {
    if (changes?.length && (changes.length !== 7 || changes[0] !== 0x21 || changes[1] !== 2 || changes[2] !== 0x34)) {
        return changes // explicit full style record
    }
    if (!previous?.length) return changes
    const out: number[] = []
    let offset = 0
    let hasSize = false
    while (offset + 7 <= previous.length && previous[offset] === 0x21 && previous[offset + 2] === 0x34) {
        if (previous[offset + 1] === 2) {
            if (!hasSize && changes) out.push(...changes)
            hasSize = true
        } else {
            out.push(...previous.subarray(offset, offset + 7))
        }
        offset += 7
    }
    if (!hasSize && changes) out.push(...changes)
    out.push(...previous.subarray(offset))
    return out.length ? Uint8Array.from(out) : undefined
}

export function* expandItem(
    item: CrdtSequenceItem<string | number>,
): Generator<CrdtSequenceItem<string | number>> {
    if (item.deletedLength > 0) {
        // deleted run: per-char tombstones keep the implicit ids alive for
        // ordering and style anchoring
        let leftId = item.leftId
        let id = item.itemId
        for (let k = 0; k < item.deletedLength; k++) {
            const last = k === item.deletedLength - 1
            const rightId = last ? item.rightId : crdtId(id.part1, id.part2 + 1)
            yield { itemId: id, leftId, rightId, deletedLength: 1, value: '' }
            leftId = id
            id = rightId
        }
        return
    }
    if (typeof item.value === 'number') {
        yield item
        return
    }
    const chars = [...item.value]
    if (chars.length === 0) return
    let leftId = item.leftId
    let id = item.itemId
    for (let k = 0; k < chars.length; k++) {
        const last = k === chars.length - 1
        const rightId = last ? item.rightId : crdtId(id.part1, id.part2 + 1)
        yield { itemId: id, leftId, rightId, deletedLength: 0, value: chars[k]! }
        leftId = id
        id = rightId
    }
}

export function linearizeRootText(text: Text): TextParagraph[] {
    const expanded = new CrdtSequence<string | number>(
        text.items.allItems().flatMap((i) => [...expandItem(i)]),
    )
    const ids = expanded.orderedIds()
    if (ids.length === 0) return []

    const styleEntryOf = (id: CrdtId) => text.styles.get(crdtIdKey(id))

    let bold = false
    let italic = false
    const paragraphs: TextParagraph[] = []
    let i = 0
    for (;;) {
        // paragraph anchor: the '\n' that opened it; END_MARKER for the first.
        // The first paragraph must NOT swallow a leading '\n' (that's an empty
        // first paragraph, not this one's anchor), or blank lines collapse.
        let startId: CrdtId = END_MARKER
        const head = i < ids.length ? expanded.getItem(ids[i]!)! : null
        if (paragraphs.length > 0 && head && head.deletedLength === 0 && head.value === '\n') {
            startId = ids[i]!
            i++
        }
        const spans: TextSpan[] = []
        while (i < ids.length) {
            const item = expanded.getItem(ids[i]!)!
            if (item.deletedLength > 0) {
                i++
                continue
            }
            const v = item.value
            if (typeof v === 'number') {
                if (v === 1) bold = true
                else if (v === 2) bold = false
                else if (v === 3) italic = true
                else if (v === 4) italic = false
                i++
                continue
            }
            if (v === '\n') break // next paragraph's anchor
            const last = spans[spans.length - 1]
            if (last && last.bold === bold && last.italic === italic) {
                last.text += v
            } else {
                spans.push({ text: v, bold, italic })
            }
            i++
        }
        const entry = styleEntryOf(startId)
        const props = parseStyleExtra(entry?.extra)
        const sizeCode = props.get(2) ?? 0
        const indentLevel = props.get(3)
        paragraphs.push({
            startId,
            style: entry?.value ?? ParagraphStyle.PLAIN,
            ...(sizeCode !== 0 ? { sizeCode } : {}),
            ...(indentLevel !== undefined ? { indentLevel } : {}),
            spans,
        })
        if (i >= ids.length) break
    }
    return paragraphs
}

/** A live character's place in the linearized paragraphs — the lookup a
 *  text ANCHOR resolution needs (handwriting groups anchor to a char id and
 *  render relative to that char's laid-out line). `offset` is the UTF-16 index
 *  into the paragraph's visible text (spans concatenated); a '\n' (the id that
 *  OPENS a paragraph) reports offset -1. Traversal mirrors linearizeRootText
 *  exactly so paragraphIndex always matches its output. */
export interface CharPosition {
    id: CrdtId
    paragraphIndex: number
    offset: number
    /** tombstone: the id survives for ordering (and anchoring!) but renders
     *  nothing; offset is the position it would occupy. */
    deleted?: boolean
}

export function rootTextCharPositions(text: Text): CharPosition[] {
    const expanded = new CrdtSequence<string | number>(
        text.items.allItems().flatMap((i) => [...expandItem(i)]),
    )
    const ids = expanded.orderedIds()
    if (ids.length === 0) return []
    const out: CharPosition[] = []
    let i = 0
    let paragraphIndex = 0
    for (;;) {
        // Mirror linearizeRootText: must not consume a leading '\n' or this
        // map disagrees with the linearizer by one entry.
        const head = i < ids.length ? expanded.getItem(ids[i]!)! : null
        if (paragraphIndex > 0 && head && head.deletedLength === 0 && head.value === '\n') {
            out.push({ id: ids[i]!, paragraphIndex, offset: -1 })
            i++
        }
        let offset = 0
        while (i < ids.length) {
            const item = expanded.getItem(ids[i]!)!
            if (item.deletedLength > 0) {
                out.push({ id: ids[i]!, paragraphIndex, offset, deleted: true })
                i++
                continue
            }
            const v = item.value
            if (typeof v === 'number') {
                i++
                continue
            }
            if (v === '\n') break
            out.push({ id: ids[i]!, paragraphIndex, offset })
            offset += v.length
            i++
        }
        paragraphIndex++
        if (i >= ids.length) break
    }
    return out
}

/**
 * Style-map keys at the first paragraph's head (offset <= 0) that carry a
 * style, excluding END_MARKER: xochitl keys the first paragraph's style to
 * its persistent first-char id, which may be a tombstoned char (restyle then
 * retype leaves the old style on the dead first char), falling back to
 * END_MARKER only if no shadow carries a style. A stale shadow style
 * overrides the web's END_MARKER write. Callers must reconcile every
 * returned key to the paragraph's target style.
 */
export function firstParagraphStyleShadows(text: Text): string[] {
    return paragraphStyleShadows(text).get(0) ?? []
}

/**
 * Per-paragraph shadow anchors: paragraphIndex -> style-map keys the device
 * may read that paragraph's style from instead of the anchor the web writes.
 * xochitl keys a paragraph's style to its opener id, which can be a
 * tombstoned char (restyle-then-retype leaves the old style on the dead
 * opener). A styled tombstone at a paragraph's head (offset <= 0) anchors
 * that paragraph; at the tail (offset > 0) it's a dead '\n' opener of the
 * next paragraph. Callers must reconcile every key to the paragraph's target
 * style.
 */
export function paragraphStyleShadows(text: Text): Map<number, string[]> {
    const end = crdtIdKey(END_MARKER)
    const styled = text.styles
    const out = new Map<number, string[]>()
    const add = (para: number, key: string) => {
        if (para < 0 || key === end || !styled.has(key)) return
        const l = out.get(para) ?? []
        if (!l.includes(key)) {
            l.push(key)
            out.set(para, l)
        }
    }
    for (const c of rootTextCharPositions(text)) {
        if (!c.deleted) continue
        add(c.offset <= 0 ? c.paragraphIndex : c.paragraphIndex + 1, crdtIdKey(c.id))
    }
    return out
}
