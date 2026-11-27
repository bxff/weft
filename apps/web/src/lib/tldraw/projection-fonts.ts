import { parse, type Font } from 'opentype.js'

const families = ['draw', 'sans', 'serif', 'mono'] as const
const styles = ['bold', 'italic', 'bold-italic'] as const
export type ProjectionFamily = (typeof families)[number]
export type ProjectionFontKey = ProjectionFamily | `${ProjectionFamily}:${(typeof styles)[number]}`

export function projectionFontKey(family: ProjectionFamily, bold = false, italic = false): ProjectionFontKey {
    return bold ? `${family}:${italic ? 'bold-italic' : 'bold'}` : italic ? `${family}:italic` : family
}

function faceOf(key: ProjectionFontKey) {
    const [family, variant] = key.split(':') as [ProjectionFamily, (typeof styles)[number]?]
    const suffix = variant === 'bold-italic' ? 'BoldItalic' : variant === 'bold' ? 'Bold' : variant === 'italic' ? 'Italic' : ''
    const name = family.charAt(0).toUpperCase() + family.slice(1)
    return {
        url: `/fonts/projection/WeftOverlay${name}${suffix}.woff`,
        family: `tldraw_${family}`,
        style: variant?.includes('italic') ? 'italic' : 'normal',
        weight: variant?.includes('bold') ? 'bold' : 'normal',
    }
}

type Face = ReturnType<typeof faceOf>

function matchingLoadedFace(doc: Document, face: Face): boolean {
    // FontFaceSet.check() alone reports true even if a font never registered.
    // Require a successfully loaded face of the right weight and style, not
    // merely a layout that the browser can paint using a fallback.
    return Array.from(doc.fonts).some((font) =>
        font.family === face.family && font.style === face.style &&
        (font.weight === face.weight || font.weight === (face.weight === 'bold' ? '700' : '400')) &&
        font.status === 'loaded',
    )
}

async function ensureBrowserFace(doc: Document, face: Face, bytes: ArrayBuffer): Promise<void> {
    if (matchingLoadedFace(doc, face)) return
    // The SDK caches a failed FontFace and its ensure method resolves even on
    // failure. Recover independently with the exact same contours and metrics
    // already fetched for projection. Never measure using a failed asset.
    const instance = new FontFace(face.family, bytes, { style: face.style, weight: face.weight })
    await instance.load()
    if (instance.status !== 'loaded') throw new Error('Projection browser face is not loaded')
    if (!matchingLoadedFace(doc, face)) doc.fonts.add(instance)
}

/** Per-controller ready faces and in-flight requests. On a failure, leave the
 * face unavailable so the caller can retain edits and retry, rather than
 * writing tablet ink using a substitute font. The browser's existing WOFF2
 * faces and any repaired ones remain available for the lifetime of its document. */
export class ProjectionFontLoader {
    private readonly loaded = new Map<ProjectionFontKey, Font>()
    private readonly pending = new Map<ProjectionFontKey, Promise<Font | null>>()

    constructor(private readonly drawFontUrl = '/fonts/ShantellSans.ttf') {}

    get(key: ProjectionFontKey): Font | undefined {
        return this.loaded.get(key)
    }

    ensure(key: ProjectionFontKey, doc: Document): Promise<Font | null> {
        const loaded = this.loaded.get(key)
        if (loaded) return Promise.resolve(loaded)
        const pending = this.pending.get(key)
        if (pending) return pending

        const face = faceOf(key)
        const work = this.load(key, face, doc).finally(() => this.pending.delete(key))
        this.pending.set(key, work)
        return work
    }

    private async load(key: ProjectionFontKey, face: Face, doc: Document): Promise<Font | null> {
        try {
            const response = await fetch(key === 'draw' ? this.drawFontUrl : face.url)
            if (!response.ok) return null
            const bytes = await response.arrayBuffer()
            const font = parse(bytes)
            await ensureBrowserFace(doc, face, bytes)
            this.loaded.set(key, font)
            return font
        } catch {
            return null
        }
    }
}
