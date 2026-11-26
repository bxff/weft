import { afterEach, expect, test } from 'bun:test'
import { ProjectionFontLoader, projectionFontKey, type ProjectionFamily } from './projection-fonts'

const originalFetch = globalThis.fetch
const originalFontFace = globalThis.FontFace

afterEach(() => {
    globalThis.fetch = originalFetch
    globalThis.FontFace = originalFontFace
})

function browserFaceHarness() {
    const faces = new Set<{
        family: string; weight: string; style: string; status: 'loading' | 'loaded' | 'error'
    }>()
    let rejectFace = false
    let loads = 0
    class BrowserFace {
        status: 'loading' | 'loaded' | 'error' = 'loading'
        constructor(
            readonly family: string,
            readonly bytes: ArrayBuffer,
            readonly descriptors: FontFaceDescriptors,
        ) {}
        get weight() { return this.descriptors.weight ?? 'normal' }
        get style() { return this.descriptors.style ?? 'normal' }
        async load() {
            loads++
            if (rejectFace) {
                this.status = 'error'
                throw new Error('Transient browser decoder failure')
            }
            this.status = 'loaded'
            return this
        }
    }
    globalThis.FontFace = BrowserFace as unknown as typeof FontFace
    return {
        doc: { fonts: faces } as unknown as Document,
        faces,
        loads: () => loads,
        setReject: (value: boolean) => { rejectFace = value },
    }
}

const staticPath = `${import.meta.dir}/../../../static`
const localFetch = async (path: RequestInfo | URL) => {
    const file = Bun.file(staticPath + path.toString())
    return await file.exists() ? new Response(await file.arrayBuffer()) : new Response(null, { status: 404 })
}

test('every built-in family variant loads actual outline bytes and the expected CSS style', async () => {
    globalThis.fetch = localFetch as typeof fetch
    const { doc, faces, loads } = browserFaceHarness()
    const loader = new ProjectionFontLoader()
    for (const family of ['draw', 'sans', 'serif', 'mono'] as const satisfies readonly ProjectionFamily[]) {
        const outlines = new Set<string>()
        for (const bold of [false, true]) {
            for (const italic of [false, true]) {
                const key = projectionFontKey(family, bold, italic)
                const face = await loader.ensure(key, doc)
                expect(face).not.toBeNull()
                expect(loader.get(key)).toBe(face!)
                const glyph = face!.charToGlyph('A').getPath()
                outlines.add(JSON.stringify(glyph.commands))
                expect([...faces].at(-1)).toMatchObject({
                    family: `tldraw_${family}`,
                    weight: bold ? 'bold' : 'normal',
                    style: italic ? 'italic' : 'normal',
                    status: 'loaded',
                })
            }
        }
        expect(outlines.size).toBe(4)
    }
    expect(loads()).toBe(16)
})

test('failed SDK face never counts as ready; projection waits and retries both failed network and browser decode', async () => {
    const { doc, faces, setReject, loads } = browserFaceHarness()
    faces.add({ family: 'tldraw_serif', weight: 'bold', style: 'italic', status: 'error' })
    // Same family with a different style must not admit a layout.
    faces.add({ family: 'tldraw_serif', weight: 'bold', style: 'normal', status: 'loaded' })
    const key = 'serif:bold-italic'
    const loader = new ProjectionFontLoader()
    let fetches = 0
    globalThis.fetch = (async path => ++fetches === 1 ?
        new Response(null, { status: 503 }) : localFetch(path)) as typeof fetch

    const pending = loader.ensure(key, doc)
    expect(loader.ensure(key, doc)).toBe(pending)
    expect(await pending).toBeNull()
    expect(loader.get(key)).toBeUndefined()

    setReject(true)
    expect(await loader.ensure(key, doc)).toBeNull()
    expect(loader.get(key)).toBeUndefined()
    expect(loads()).toBe(1)

    setReject(false)
    expect(await loader.ensure(key, doc)).not.toBeNull()
    expect(await loader.ensure(key, doc)).toBe(loader.get(key)!)
    expect(fetches).toBe(3)
    expect(loads()).toBe(2)
    expect([...faces].at(-1)).toMatchObject({
        family: 'tldraw_serif', weight: 'bold', style: 'italic', status: 'loaded',
    })
})

test('reuses a loaded browser WOFF2 face without registering another', async () => {
    const { doc, faces, loads } = browserFaceHarness()
    faces.add({ family: 'tldraw_mono', weight: '700', style: 'normal', status: 'loaded' })
    globalThis.fetch = localFetch as typeof fetch
    expect(await new ProjectionFontLoader().ensure('mono:bold', doc)).not.toBeNull()
    expect(loads()).toBe(0)
    expect(faces.size).toBe(1)
})
