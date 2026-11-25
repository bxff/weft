/** Docs renderer (build-time). Markdown -> HTML with Shiki syntax highlighting
 *  in the weft terminal palette, plus a heading TOC. */
import { Marked } from 'marked'
import matter from 'gray-matter'
import { createHighlighter, type Highlighter } from 'shiki'

const ORDER = ['index', 'api']
const raw = import.meta.glob('./content/*.md', { query: '?raw', import: 'default', eager: true }) as Record<
    string,
    string
>
const bySlug: Record<string, string> = {}
for (const [path, text] of Object.entries(raw)) {
    const slug = path.split('/').pop()!.replace(/\.md$/, '')
    bySlug[slug] = text
}

export const docSlugs = ORDER.filter((s) => s in bySlug)

/** Sidebar nav: slug + title (from frontmatter) + url, in order. */
export const docNav = docSlugs.map((slug) => {
    const { data } = matter(bySlug[slug]!)
    return {
        slug,
        title: (data.title as string) ?? slug,
        url: slug === 'index' ? '/docs' : `/docs/${slug}`,
    }
})

// TextMate scopes -> ANSI palette, matches the landing's tok-* colors.
const weftTerminal = {
    name: 'weft-terminal',
    type: 'dark' as const,
    colors: { 'editor.background': '#111111', 'editor.foreground': '#bbbbbb' },
    settings: [
        { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#777777' } },
        {
            scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control', 'keyword.operator.new', 'keyword.operator.expression'],
            settings: { foreground: '#bf5af2' },
        },
        {
            scope: ['string', 'string.quoted', 'string.template', 'constant.numeric', 'constant.language', 'constant.language.boolean', 'support.constant'],
            settings: { foreground: '#ff443a' },
        },
        {
            scope: ['entity.name.type', 'entity.name.class', 'entity.name.namespace', 'support.type', 'support.class', 'entity.other.inherited-class'],
            settings: { foreground: '#0a84ff' },
        },
        {
            scope: ['variable.other.property', 'meta.object-literal.key', 'support.type.property-name', 'entity.name.tag'],
            settings: { foreground: '#64d3ff' },
        },
        { scope: ['keyword.operator', 'punctuation', 'variable', 'variable.other', 'meta.brace'], settings: { foreground: '#bbbbbb' } },
        { scope: ['markup.inserted'], settings: { foreground: '#30d158' } },
        { scope: ['markup.deleted'], settings: { foreground: '#ff443a' } },
    ],
}

let hlPromise: Promise<Highlighter> | null = null
function highlighter() {
    hlPromise ??= createHighlighter({
        themes: [weftTerminal],
        langs: ['typescript', 'javascript', 'json', 'bash', 'http'],
    })
    return hlPromise
}

const LANG_ALIAS: Record<string, string> = {
    ts: 'typescript',
    js: 'javascript',
    sh: 'bash',
    shell: 'bash',
    curl: 'bash',
    '': 'text',
}
const slugify = (s: string) =>
    s
        .toLowerCase()
        .replace(/<[^>]*>/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
const stripTags = (s: string) => s.replace(/<[^>]*>/g, '')
// decode entities parseInline emits (e.g. &#39;) to avoid double-escaping in TOC titles
const decodeEntities = (s: string) =>
    s
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')

export interface RenderedDoc {
    slug: string
    title: string
    description: string
    html: string
    toc: { title: string; url: string; depth: number }[]
}

export async function renderDoc(slug: string): Promise<RenderedDoc | null> {
    const src = bySlug[slug]
    if (!src) return null
    const { data, content } = matter(src)
    const hl = await highlighter()
    const toc: RenderedDoc['toc'] = []

    const md = new Marked({ gfm: true })
    md.use({
        renderer: {
            code({ text, lang }: { text: string; lang?: string }) {
                const language = LANG_ALIAS[(lang ?? '').toLowerCase()] ?? (lang ?? 'text').toLowerCase()
                try {
                    return hl.codeToHtml(text, { lang: language, theme: 'weft-terminal' })
                } catch {
                    return hl.codeToHtml(text, { lang: 'text', theme: 'weft-terminal' })
                }
            },
            heading(token) {
                const inner = this.parser.parseInline(token.tokens)
                const id = slugify(stripTags(inner))
                if (token.depth === 2 || token.depth === 3) {
                    toc.push({ title: decodeEntities(stripTags(inner)), url: `#${id}`, depth: token.depth })
                }
                return `<h${token.depth} id="${id}">${inner}</h${token.depth}>`
            },
        },
    })

    const html = await md.parse(content, { async: true })
    return {
        slug,
        title: (data.title as string) ?? slug,
        description: (data.description as string) ?? '',
        html,
        toc,
    }
}
