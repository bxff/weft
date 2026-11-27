/**
 * TipTap text flattening for contour projection, and targeted glyph repair.
 * Blocks join by '\n' as a separator, not a terminator (a terminator adds a
 * phantom trailing newline and drops empty paragraphs, collapsing blank lines
 * on-device).
 */

import type { JSONContent } from '@tiptap/core'
import type { TLRichText } from 'tldraw'

const isTextBlock = (type: string | undefined) => type === 'paragraph' || type === 'heading'

export function textBlocksFromNode(node: unknown): string[] {
    const lines: string[] = []
    const inline = (n: unknown): string => {
        if (!n || typeof n !== 'object') return ''
        const t = n as { type?: string; text?: string; content?: unknown[] }
        if (t.type === 'text' && typeof t.text === 'string') return t.text
        if (t.type === 'hardBreak') return '\n'
        return Array.isArray(t.content) ? t.content.map(inline).join('') : ''
    }
    const walk = (n: unknown): void => {
        if (!n || typeof n !== 'object') return
        const b = n as { type?: string; content?: unknown[] }
        if (isTextBlock(b.type)) {
            lines.push(Array.isArray(b.content) ? b.content.map(inline).join('') : '')
            return
        }
        for (const c of b.content ?? []) walk(c)
    }
    walk(node)
    return lines
}

export function textFromNode(node: unknown): string {
    return textBlocksFromNode(node).join('\n')
}

/** Erase at the same code-point positions used by the contour projection.
 * Block separators and hard breaks occupy positions but have no drawn glyph. */
export function eraseRichTextGlyphs(richText: TLRichText, indices: readonly number[]): TLRichText {
    if (!indices.length) return richText
    const removed = new Set(indices)
    // Projection joins text leaves before iterating code points. A surrogate
    // pair can span marked leaves, so remove its UTF-16 units together.
    const units = new Set<number>()
    let offset = 0
    let glyph = 0
    for (const char of textFromNode(richText)) {
        if (removed.has(glyph)) {
            for (let i = 0; i < char.length; i++) units.add(offset + i)
        }
        offset += char.length
        glyph++
    }
    if (!units.size) return richText
    let position = 0
    let seenBlock = false

    const visit = (value: unknown, inline = false): unknown => {
        if (!value || typeof value !== 'object') return value
        const node = value as JSONContent
        if (!inline && isTextBlock(node.type)) {
            if (seenBlock) position++
            seenBlock = true
            inline = true
        } else if (inline && node.type === 'hardBreak') {
            position++
            return node
        } else if (inline && node.type === 'text' && typeof node.text === 'string') {
            const text = node.text.split('').filter(() => !units.has(position++)).join('')
            if (text === node.text) return node
            return text.length ? { ...node, text } : undefined
        }

        const { content } = node
        if (!Array.isArray(content)) return node
        const next = content.map((child) => visit(child, inline))
        if (next.every((child, i) => child === content[i])) return node
        return { ...node, content: next.filter((child) => child !== undefined) }
    }

    return visit(richText) as TLRichText
}

/**
 * Canonicalize a TipTap doc for hashing/equality only (never for storage or
 * rendering). Two encodings that render identically must hash identically,
 * else the projection can re-mint glyphs when TipTap normalizes bare nodes
 * to carry default attrs. Drop only volatile defaults: `dir` everywhere, and
 * `deviceStyle` when null/absent (a non-null deviceStyle is a real
 * heading/checkbox/list style and must still affect the hash). Recurses
 * structurally; leaves text/marks untouched.
 */
export function canonicalRichText(rt: unknown): unknown {
    const canon = (n: unknown): unknown => {
        if (Array.isArray(n)) return n.map(canon)
        if (!n || typeof n !== 'object') return n
        const node = n as { attrs?: Record<string, unknown>; content?: unknown[]; [k: string]: unknown }
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(node)) {
            if (k === 'attrs') continue
            if (k === 'content') {
                out.content = canon(v)
                continue
            }
            out[k] = v
        }
        if (node.attrs) {
            const a: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(node.attrs)) {
                if (k === 'dir') continue // 'auto' default, never meaningful for content
                if (k === 'deviceStyle' && (v === null || v === undefined)) continue // null == absent
                a[k] = v
            }
            if (Object.keys(a).length > 0) out.attrs = a
        }
        return out
    }
    return canon(rt)
}
