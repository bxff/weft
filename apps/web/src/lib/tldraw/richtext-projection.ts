import { DefaultFontFamilies, renderHtmlFromRichTextForMeasurement, type Editor, type TLRichText } from 'tldraw'
import type { MeasuredSpan } from '@weft/rm-ink'
import type { JSONContent } from '@tiptap/core'
import { textBlocksFromNode } from './richtext-plain'
import { projectionFontKey, type ProjectionFamily, type ProjectionFontKey, type ProjectionFontLoader } from './projection-fonts'

/** Keep unformatted paragraphs on the established projection path. Heading
 * and list nodes need rich layout even when there are no inline marks. */
export function richProjection(rich: TLRichText, family: ProjectionFamily) {
    const fonts = new Set<ProjectionFontKey>([family])
    let styled = false
    function visit(value: unknown, heading = false) {
        if (!value || typeof value !== 'object') return
        const node = value as JSONContent
        heading ||= node.type === 'heading'
        const marks = node.marks?.map((mark) => mark.type) ?? []
        styled ||= marks.length > 0 || node.type === 'heading' || node.type === 'bulletList' || node.type === 'orderedList'
        if (node.type === 'text') {
            fonts.add(projectionFontKey(marks.includes('code') ? 'mono' : family,
                heading || marks.includes('bold'), marks.includes('italic')))
        }
        node.content?.forEach((child) => visit(child, heading))
    }
    visit(rich)
    return { styled, fonts }
}

type Options = {
    family: ProjectionFamily
    fontSize: number
    scale: number
    width: number
    align: string
    lineHeight?: number
}

export function measureRichProjection(editor: Editor, fonts: ProjectionFontLoader, rich: TLRichText, opts: Options) {
    const host = editor.getContainer()
    const doc = host.ownerDocument
    const win = doc.defaultView
    const context = doc.createElement('canvas').getContext('2d')
    if (!win || !context) return null
    const probe = doc.createElement('div')
    probe.setAttribute('aria-hidden', 'true')
    Object.assign(probe.style, {
        position: 'absolute', top: '0', left: '0', visibility: 'hidden', pointerEvents: 'none',
        width: opts.width + 'px', padding: '0', margin: '0', border: 'none',
        fontFamily: DefaultFontFamilies[opts.family], fontSize: opts.fontSize + 'px',
        lineHeight: Math.round(opts.fontSize * (opts.lineHeight ?? 1.35)) + 'px', fontWeight: '400', fontStyle: 'normal',
        textAlign: opts.align === 'middle' ? 'center' : opts.align, whiteSpace: 'pre-wrap',
        wordWrap: 'break-word', overflowWrap: 'break-word',
    })
    probe.style.setProperty('--tl-rich-text-heading-line-height', String(opts.lineHeight ?? 1.35))
    // The same TipTap extension set and styles used by the SDK to draw text.
    probe.innerHTML = renderHtmlFromRichTextForMeasurement(editor, rich)
    host.appendChild(probe)
    try {
        const scene = probe.getBoundingClientRect()
        const spanScale = opts.scale
        const range = doc.createRange()
        const spans: MeasuredSpan[] = []
        const highlight: { x: number; y: number; w: number; h: number }[] = []
        const markers: { text: string; sourceIndex: number; x: number; baseline: number }[] = []
        // Erase IDs belong to the JSON, not to HTML. A genuine sole hard
        // break and an empty paragraph both render as <p><br></p>.
        const source = textBlocksFromNode(rich)
        const blocks = [...probe.querySelectorAll('p,h1,h2,h3,h4,h5,h6')]
        if (source.length !== blocks.length) return null
        let firstSourceIndex = 0
        for (const [bi, block] of blocks.entries()) {
            const chars = [...source[bi]!]
            let charIndex = 0
            const firstSpan = spans.length
            const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
            while (walker.nextNode()) {
                const node = walker.currentNode
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if ((node as Element).tagName === 'BR' && chars[charIndex] === '\n') charIndex++
                    continue
                }
                const parent = node.parentElement!
                const css = win.getComputedStyle(parent)
                const size = parseFloat(css.fontSize)
                const family = parent.closest('code') ? 'mono' : opts.family
                const key = projectionFontKey(family, Number(css.fontWeight) >= 600 || css.fontWeight === 'bold', css.fontStyle !== 'normal')
                const face = fonts.get(key)
                if (!face) return null
                const link = !!parent.closest('a')
                const highlighted = !!parent.closest('mark')
                const decorations = { underline: false, strike: false }
                for (let el: Element | null = parent; el && el !== probe; el = el.parentElement) {
                    const line = win.getComputedStyle(el).textDecorationLine
                    decorations.underline ||= line.includes('underline')
                    decorations.strike ||= line.includes('line-through')
                }
                context.font = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`
                const ascent = context.measureText('Hg').fontBoundingBoxAscent
                let offset = 0
                for (const char of node.textContent ?? '') {
                    if (chars[charIndex] !== char) return null
                    const index = firstSourceIndex + charIndex++
                    range.setStart(node, offset)
                    offset += char.length
                    range.setEnd(node, offset)
                    const rect = range.getClientRects()[0]
                    if (!rect || rect.width === 0 || char === '\n' || char === '\r') continue
                    const y = (rect.top - scene.top) * spanScale
                    spans.push({
                        text: char, sourceIndex: index,
                        x: (rect.left - scene.left) * spanScale, y, w: rect.width * spanScale, h: rect.height * spanScale,
                        font: face, fontSize: size * spanScale, baseline: y + ascent * spanScale, decorations,
                        ...(link ? { color: 'blue' } : {}),
                    })
                    if (highlighted) {
                        const { x, y, w, h } = spans[spans.length - 1]!
                        const previous = highlight[highlight.length - 1]
                        if (previous && Math.abs(y - previous.y) < 0.1 && Math.abs(h - previous.h) < 0.1 &&
                            Math.abs(previous.x + previous.w - x) < 0.1) previous.w = x + w - previous.x
                        else highlight.push({ x, y, w, h })
                    }
                }
            }
            const item = block.parentElement
            const list = item?.parentElement
            if (item?.tagName === 'LI' && item.firstElementChild === block && list && spans[firstSpan]) {
                const style = win.getComputedStyle(item)
                const numbered = list.tagName === 'OL'
                const siblings = Array.from(list.children).filter((child) => child.tagName === 'LI')
                const index = siblings.indexOf(item)
                const start = (list as HTMLOListElement).start ?? 1
                const label = numbered ? `${start + index}.` : style.listStyleType === 'square' ? '▪' : style.listStyleType === 'circle' ? '◦' : '•'
                context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
                const width = context.measureText(label + ' ').width
                const x = (block.getBoundingClientRect().left - scene.left - width) * spanScale
                const rect = block.getBoundingClientRect()
                const ascent = context.measureText('Hg').fontBoundingBoxAscent
                const descent = context.measureText('Hg').fontBoundingBoxDescent
                const lineHeight = parseFloat(style.lineHeight)
                markers.push({ text: label, sourceIndex: firstSourceIndex, x, baseline:
                    (rect.top - scene.top + (lineHeight - ascent - descent) / 2 + ascent) * spanScale })
            }
            if (charIndex !== chars.length) return null
            firstSourceIndex += chars.length + 1 // following block separator
        }
        return { spans, markers, highlight, height: scene.height * spanScale }
    } finally {
        probe.remove()
    }
}
