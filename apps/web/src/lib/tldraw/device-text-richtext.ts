/**
 * Device root text <-> tldraw rich text (TipTap JSON), using tldraw's own
 * rich text machinery, restricted to what the device can express:
 *   legacy HEADING(2) or size 1 <-> heading level 1 (XL serif)
 *   size 3                     <-> heading level 2 (large serif)
 *   size 2                     <-> heading level 3 (medium bold sans)
 *   BULLET(4)                  <-> bulletList > listItem
 *   BULLET2(5)                 <-> a bulletList NESTED in the previous item
 *   NUMBERED(10)               <-> orderedList > listItem
 *   NUMBERED2(11)              <-> an orderedList NESTED (device: "a.")
 *   everything else            <-> paragraph
 * Inline bold/italic spans <-> marks.
 *
 * Sizes are the device's style-entry property 2: 0 body, 1 XL serif
 * (metrically = legacy HEADING), 2 medium bold sans, 3 large serif. The size
 * property suppresses list rendering on the device, so headings never come
 * from list styles.
 *
 * Every paragraph node carries the rm style it came from on a `deviceStyle`
 * attr (data-device-style): BOLD(3) / CHECKBOX(6) / CHECKED(7) / CHECKBOX2(8)
 * / CHECKED2(9) have no TipTap node, so the attr styles them (CSS in
 * device-text-style.ts) and preserves the style code across edits that
 * don't change the paragraph's kind.
 */

import type { TextParagraph } from '@weft/rm-format'
import { encodeStyleExtra } from '@weft/rm-format'
import type { TLRichText } from 'tldraw'

type Mark = { type: string }
type TextNode = { type: 'text'; text: string; marks?: Mark[] }
type Node = {
    type: string
    attrs?: Record<string, unknown>
    content?: (Node | TextNode)[]
}

export type NodeKind =
    | 'paragraph'
    | 'heading1'
    | 'heading2'
    | 'heading3'
    | 'bullet'
    | 'bullet2'
    | 'ordered'
    | 'ordered2'

export function nodeKindForParagraph(p: {
    style: number
    sizeCode?: number
    indentLevel?: number
}): NodeKind {
    // size property wins: the device suppresses list rendering under it
    if (p.sizeCode === 1) return 'heading1'
    if (p.sizeCode === 3) return 'heading2'
    if (p.sizeCode === 2) return 'heading3'
    if (p.style === 2) return 'heading1'
    if (p.style === 4) return 'bullet'
    if (p.style === 5) return 'bullet2'
    if (p.style === 10) return 'ordered'
    if (p.style === 11) return 'ordered2'
    // plain + indent property renders as a bullet at that depth
    if (p.indentLevel !== undefined && (p.style === 0 || p.style === 1)) {
        return p.indentLevel >= 1 ? 'bullet2' : 'bullet'
    }
    return 'paragraph'
}

/** Back-compat shim for callers that only have a style code. */
export function nodeKindForStyle(style: number): NodeKind {
    return nodeKindForParagraph({ style })
}

export interface StyleWrite {
    value: number
    extra?: Uint8Array
}

/** The style a node kind writes back. Callers must SKIP the write when the
 *  paragraph's kind is unchanged, so BOLD/CHECKBOX/CHECKED and
 *  device-authored size/indent extras survive untouched edits. */
export function styleForNodeKind(kind: NodeKind, oldStyle: number | null): StyleWrite {
    if (kind === 'heading1') return { value: 2 } // legacy heading = XL serif
    if (kind === 'heading2') {
        const extra = encodeStyleExtra({ size: 3 })
        return { value: 1, ...(extra ? { extra } : {}) }
    }
    if (kind === 'heading3') {
        const extra = encodeStyleExtra({ size: 2 })
        return { value: 1, ...(extra ? { extra } : {}) }
    }
    if (kind === 'bullet') return { value: 4 }
    if (kind === 'bullet2') return { value: 5 }
    if (kind === 'ordered') return { value: 10 }
    if (kind === 'ordered2') return { value: 11 }
    if (oldStyle !== null && nodeKindForStyle(oldStyle) === 'paragraph') return { value: oldStyle }
    return { value: 1 }
}

function spanNodes(p: TextParagraph): TextNode[] {
    const out: TextNode[] = []
    for (const s of p.spans) {
        if (!s.text) continue
        const marks: Mark[] = []
        if (s.bold) marks.push({ type: 'bold' })
        if (s.italic) marks.push({ type: 'italic' })
        out.push({ type: 'text', text: s.text, ...(marks.length ? { marks } : {}) })
    }
    return out
}

function paragraphNode(p: TextParagraph): Node {
    const inner = spanNodes(p)
    const indent = (p as { indentLevel?: number }).indentLevel
    return {
        type: 'paragraph',
        attrs: { deviceStyle: p.style, ...(indent !== undefined ? { deviceIndent: indent } : {}) },
        ...(inner.length ? { content: inner } : {}),
    }
}

const headingLevel = { heading1: 1, heading2: 2, heading3: 3 } as const

export function paragraphsToRichText(paragraphs: TextParagraph[]): TLRichText {
    const content: Node[] = []
    // open list state: the top-level list and the item a nested list joins
    let list: Node | null = null
    let listType: 'bulletList' | 'orderedList' | null = null
    let lastItem: Node | null = null
    const closeList = () => {
        list = null
        listType = null
        lastItem = null
    }
    for (const p of paragraphs) {
        const kind = nodeKindForParagraph(p)
        if (kind === 'bullet' || kind === 'bullet2' || kind === 'ordered' || kind === 'ordered2') {
            const wantType = kind.startsWith('ordered') ? 'orderedList' : 'bulletList'
            const nested = kind === 'bullet2' || kind === 'ordered2'
            if (!list || listType !== wantType) {
                closeList()
                list = { type: wantType, content: [] }
                listType = wantType
                content.push(list)
            }
            const item: Node = { type: 'listItem', content: [paragraphNode(p)] }
            if (nested && lastItem) {
                let sub = (lastItem.content as Node[]).find((n) => n.type === wantType)
                if (!sub) {
                    sub = { type: wantType, content: [] }
                    ;(lastItem.content as Node[]).push(sub)
                }
                ;(sub.content as Node[]).push(item)
            } else {
                // an orphan nested item stays flat; its deviceStyle attr
                // keeps the style and the CSS keeps the deep indent
                ;(list.content as Node[]).push(item)
                lastItem = item
            }
            continue
        }
        closeList()
        if (kind === 'heading1' || kind === 'heading2' || kind === 'heading3') {
            const inner = spanNodes(p)
            content.push({
                type: 'heading',
                attrs: { level: headingLevel[kind], deviceStyle: p.style },
                ...(inner.length ? { content: inner } : {}),
            })
        } else {
            content.push(paragraphNode(p))
        }
    }
    if (content.length === 0) content.push({ type: 'paragraph', attrs: { deviceStyle: 1 } })
    return { type: 'doc', content } as unknown as TLRichText
}

export interface RichSegment {
    text: string
    bold: boolean
    italic: boolean
}

export interface RichLine {
    text: string
    kind: NodeKind
    /** per-run marks, concatenation equals `text`. */
    segments: RichSegment[]
    /** the rm style this line's node was created from (data-device-style). */
    deviceStyle: number | null
    /** device indent property (style extra 3), if the paragraph carried it. */
    indentLevel?: number
}

function segmentsOf(node: Node): RichSegment[] {
    const out: RichSegment[] = []
    const walk = (n: Node | TextNode) => {
        if (n.type === 'text') {
            const t = n as TextNode
            const bold = !!t.marks?.some((m) => m.type === 'bold')
            const italic = !!t.marks?.some((m) => m.type === 'italic')
            const last = out[out.length - 1]
            if (last && last.bold === bold && last.italic === italic) last.text += t.text
            else out.push({ text: t.text, bold, italic })
            return
        }
        for (const c of (n as Node).content ?? []) walk(c)
    }
    // walk only the node's own inline content (not nested lists)
    for (const c of node.content ?? []) {
        if ((c as Node).type === 'bulletList' || (c as Node).type === 'orderedList') continue
        walk(c)
    }
    return out
}

function deviceStyleOf(node: Node): number | null {
    const v = node.attrs?.deviceStyle
    if (typeof v === 'number') return v
    if (typeof v === 'string' && v !== '') return Number(v)
    return null
}

/** Flatten a TipTap doc back to one line per rm paragraph. */
export function richTextToLines(rt: TLRichText): RichLine[] {
    const doc = rt as unknown as Node
    const lines: RichLine[] = []
    const pushBlock = (node: Node, kind: NodeKind) => {
        const segments = segmentsOf(node)
        const ind = node.attrs?.deviceIndent
        lines.push({
            text: segments.map((s) => s.text).join(''),
            kind,
            segments,
            deviceStyle: deviceStyleOf(node),
            ...(typeof ind === 'number' || (typeof ind === 'string' && ind !== '')
                ? { indentLevel: Number(ind) }
                : {}),
        })
    }
    const walkList = (listNode: Node, ordered: boolean, depth: number) => {
        const flatKind: NodeKind = ordered ? 'ordered' : 'bullet'
        const nestedKind: NodeKind = ordered ? 'ordered2' : 'bullet2'
        for (const item of (listNode.content ?? []) as Node[]) {
            if (item.type !== 'listItem') continue
            let pushedOwn = false
            for (const child of (item.content ?? []) as Node[]) {
                if (child.type === 'bulletList' || child.type === 'orderedList') {
                    walkList(child, child.type === 'orderedList', depth + 1)
                    continue
                }
                const attr = deviceStyleOf(child)
                const kind: NodeKind =
                    depth >= 2
                        ? nestedKind
                        : attr === 5 || attr === 11
                          ? nestedKind
                          : flatKind
                pushBlock(child, kind)
                pushedOwn = true
            }
            if (!pushedOwn && !(item.content ?? []).length) {
                lines.push({
                    text: '',
                    kind: depth >= 2 ? nestedKind : flatKind,
                    segments: [],
                    deviceStyle: null,
                })
            }
        }
    }
    for (const node of (doc.content ?? []) as Node[]) {
        if (node.type === 'bulletList' || node.type === 'orderedList') {
            walkList(node, node.type === 'orderedList', 1)
        } else if (node.type === 'heading') {
            const level = (node.attrs?.level as number) ?? 1
            pushBlock(node, level === 2 ? 'heading2' : level === 3 ? 'heading3' : 'heading1')
        } else {
            pushBlock(node, 'paragraph')
        }
    }
    return lines
}
