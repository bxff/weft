// Ring-fenced renderer benchmark. No storage, account, relay or tablet controller.
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getAssetUrls } from '@tldraw/assets/selfHosted'
import {
    CameraRecordType,
    Tldraw,
    TLINSTANCE_ID,
    parseTldrawJsonFile,
    serializeTldrawJson,
    setUserPreferences,
    type Editor,
    type TLStore,
    type TLStoreSnapshot,
} from 'tldraw'
import 'tldraw/tldraw.css'
import { weftRendererOptions } from '../src/lib/tldraw/renderer-options'

setUserPreferences({
    id: 'local-renderer-benchmark',
    name: 'Local',
    color: '#008080',
    locale: 'en',
    colorScheme: 'light',
})
const assetUrls = getAssetUrls({ baseUrl: '/sdk' })
const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
const viewportPaint = async () => {
    await frame()
    await document.fonts.ready
    await frame()
    await frame()
}
export type Renderer = 'stock' | 'weft'
const renderOptions = { stock: {}, weft: weftRendererOptions }

function mount(renderer: Renderer): Promise<{ root: Root; editor: Editor }> {
    const root = createRoot(document.querySelector('#app')!)
    return new Promise((resolve) => {
        root.render(
            <Tldraw
                {...renderOptions[renderer]}
                assetUrls={assetUrls}
                onMount={(editor) => {
                    resolve({ root, editor })
                }}
            />,
        )
    })
}

async function synthetic(): Promise<string> {
    const { root, editor } = await mount('stock')
    editor.createShapes(
        Array.from({ length: 120 }, (_, i) => ({
            type: 'geo' as const,
            x: (i % 15) * 48,
            y: Math.floor(i / 15) * 52,
            props: { w: 32, h: 36 },
        })),
    )
    const data = await serializeTldrawJson(editor)
    root.unmount()
    return data
}

class BenchmarkFailure extends Error {}

function parse(editor: Editor, json: string): TLStore {
    const result = parseTldrawJsonFile({ schema: editor.store.schema, json })
    if (!result.ok) {
        const error = result.error
        throw new BenchmarkFailure(
            'SDK rejected board: ' + (error.type === 'migrationFailed' ? error.reason : error.type),
        )
    }
    return result.value
}

function applyView(editor: Editor, snapshot: TLStoreSnapshot, source: TLStore) {
    phase = 'session load'
    // Both renderers load the same normalized document in the SDK-created
    // first-page/default view. File parsing does not retain exported session
    // records, so this is not a measurement of the owner's saved viewport.
    editor.loadSnapshot(snapshot)
    phase = 'page selection'
    const page = source.get(TLINSTANCE_ID)?.currentPageId ?? editor.getPages()[0]?.id
    if (!page || !editor.getPage(page)) throw new Error('Missing current page')
    editor.setCurrentPage(page)
    phase = 'camera restore'
    const camera = source.get(CameraRecordType.createId(page))
    if (camera) editor.setCamera(camera, { immediate: true })
    else editor.zoomToFit({ immediate: true })
    editor.clearHistory()
}

async function cameraFrames(editor: Editor, gesture: 'pan' | 'zoom') {
    const base = editor.getCamera()
    const frames: number[] = []
    let last = await frame()
    for (let i = 1; i <= 48; i++) {
        const wave = Math.sin((2 * Math.PI * i) / 48)
        const camera =
            gesture === 'pan'
                ? {
                      ...base,
                      x: base.x + (300 * wave) / base.z,
                      y: base.y + (90 * wave) / base.z,
                  }
                : { ...base, z: base.z * 2 ** wave }
        editor.setCamera(camera, { immediate: true })
        const now = await frame()
        frames.push(now - last)
        last = now
    }
    editor.setCamera(base, { immediate: true })
    frames.sort((a, b) => a - b)
    return frames[Math.ceil(0.95 * frames.length) - 1]!
}

async function fingerprint(editor: Editor) {
    // Only compared in the isolated runner. Never include records, camera
    // coordinates, names or their hash in the emitted benchmark report.
    const records = Object.values(editor.store.serialize('document')).sort((a, b) =>
        a.id.localeCompare(b.id),
    )
    const { x, y, z } = editor.getCamera()
    const bytes = new TextEncoder().encode(
        JSON.stringify([editor.getCurrentPageId(), x, y, z, records]),
    )
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).join(',')
}

let phase = 'mount'
async function measure(renderer: Renderer, url: string) {
    const response = await fetch(url)
    if (!response.ok) throw new Error('Local export unavailable')
    const json = await response.text()
    const begin = performance.now()
    const cold = await mount(renderer)
    const beforeParse = performance.now()
    phase = 'SDK validation'
    const source = parse(cold.editor, json)
    const snapshot = source.getStoreSnapshot()
    const parseMs = performance.now() - beforeParse
    phase = 'cold restore'
    applyView(cold.editor, snapshot, source)
    await viewportPaint()
    const rendererOpenMs = performance.now() - begin
    phase = 'record comparison'
    const signature = await fingerprint(cold.editor)
    cold.root.unmount()
    await frame()
    const warmStart = performance.now()
    phase = 'warm restore'
    const warm = await mount(renderer)
    const editor = warm.editor
    applyView(editor, snapshot, source)
    await viewportPaint()
    const memoryReopenMs = performance.now() - warmStart
    if (signature !== (await fingerprint(editor)))
        throw new BenchmarkFailure('Cold/warm document or camera mismatch')
    phase = 'camera and selection'
    const panP95Ms = await cameraFrames(editor, 'pan')
    const zoomP95Ms = await cameraFrames(editor, 'zoom')
    const shapes = editor.getCurrentPageShapes()
    const targets = editor
        .getRenderingShapes()
        .map((rendering) => rendering.id)
        .slice(0, 32)
    const selectStart = performance.now()
    editor.setSelectedShapes(targets)
    await viewportPaint()
    const selectMs = performance.now() - selectStart
    const result = {
        signature,
        rendererOpenMs,
        parseMs,
        memoryReopenMs,
        panP95Ms,
        zoomP95Ms,
        selectMs,
        pageShapes: shapes.length,
        renderedShapes: editor.getCurrentPageRenderingShapesSorted().length,
        selected: editor.getSelectedShapeIds().length,
        documentRecords: Object.keys(snapshot.store).length,
        externalAssets: Object.values(snapshot.store).filter(
            (record) =>
                record.typeName === 'asset' &&
                !!record.props.src &&
                !String(record.props.src).startsWith('data:'),
        ).length,
    }
    warm.root.unmount()
    source.dispose()
    return result
}

async function normalize(url: string) {
    const { root, editor } = await mount('stock')
    const input = await (await fetch(url)).text()
    const source = parse(editor, input)
    applyView(editor, source.getStoreSnapshot(), source)
    await viewportPaint()
    // One SDK migration/normalization before the matched trials. Never modify
    // the original export or seed Math.random to alter normal SDK behavior.
    const json = await serializeTldrawJson(editor)
    const records = Object.keys(editor.store.serialize('document')).length
    source.dispose()
    root.unmount()
    await frame()
    return { json, records }
}

async function run(renderer: Renderer, url: string) {
    try {
        return { ok: true as const, row: await measure(renderer, url) }
    } catch (error) {
        // ProseMirror exceptions can include names from the export.
        if (
            phase === 'session load' &&
            error instanceof RangeError &&
            /^There is no (mark|node) type .* in this schema$|^Unknown node type:/.test(
                error.message,
            )
        ) {
            return { ok: false as const, type: 'Unsupported rich-text schema' }
        }
        return {
            ok: false as const,
            type: error instanceof BenchmarkFailure ? error.message : 'Failed at ' + phase,
        }
    }
}
declare global {
    interface Window {
        personalBench: {
            run: typeof run
            synthetic: typeof synthetic
            normalize: typeof normalize
        }
    }
}
window.personalBench = { run, synthetic, normalize }
