/**
 * The React island: tldraw canvas + studio controller + page chrome
 * (border, reMarkable template underlay, PDF underlay, sync status).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { env } from '$env/dynamic/public'
import { editorAssets } from './editor-assets'
import { registerNotebookWorker } from '../notebook-offline'
import {
    ArrowDownToolbarItem,
    ArrowLeftToolbarItem,
    ArrowRightToolbarItem,
    ArrowToolbarItem,
    ArrowUpToolbarItem,
    AssetToolbarItem,
    CheckBoxToolbarItem,
    CloudToolbarItem,
    DefaultMainMenu,
    DefaultMainMenuContent,
    DefaultToolbar,
    DiamondToolbarItem,
    DrawToolbarItem,
    EllipseToolbarItem,
    EraserToolbarItem,
    HandToolbarItem,
    HeartToolbarItem,
    HexagonToolbarItem,
    HighlightToolbarItem,
    LaserToolbarItem,
    LineToolbarItem,
    OvalToolbarItem,
    RectangleToolbarItem,
    RhombusToolbarItem,
    SelectToolbarItem,
    StarToolbarItem,
    TextToolbarItem,
    Tldraw,
    TldrawUiMenuGroup,
    TldrawUiMenuItem,
    TldrawUiMenuToolItem,
    TrapezoidToolbarItem,
    TriangleToolbarItem,
    XBoxToolbarItem,
    useEditor,
    useValue,
    type Editor,
    type TLUiOverrides,
} from 'tldraw'

function beginDeviceTextEdit(editor: Editor, selectTool: boolean): void {
    const win = window as typeof window & {
        __weftController?: { editRootText(e: object): Promise<void> }
    }
    const api = win.__weftController
    const begin = () => {
        if (selectTool) editor.setCurrentTool('select')
        editor.setEditingShape('shape:device-text' as never)
    }
    if (editor.getShape('shape:device-text' as never)) {
        begin()
        return
    }
    if (!api) return
    void api.editRootText({ create: {} }).then(() => {
        if (win.__weftController === api) begin()
    }).catch(() => {})
}

// Only tools whose shapes reach the tablet are offered; anything else would
// produce web-only content that looks saved but never syncs. Laser stays
// (ephemeral); eraser stays (operates on syncable shapes).
const uiOverrides: TLUiOverrides = {
    tools(editor, tools) {
        // frames and notes are not ink, so nothing faithful projects to RM.
        delete tools.frame
        delete tools.note
        // device text: the page's typed-text column, as a toolbar button.
        tools['device-text'] = {
            id: 'device-text',
            label: 'Device text',
            icon: 'tool-text',
            readonlyOk: false,
            onSelect: () => beginDeviceTextEdit(editor, true),
        }
        return tools
    },
    actions(editor, actions) {
        // embeds can never exist on e-ink.
        delete actions['insert-embed']
        // device text: create the typed-text column if absent, then edit it.
        actions['insert-device-text'] = {
            id: 'insert-device-text',
            label: 'Edit device text',
            readonlyOk: false,
            onSelect: () => beginDeviceTextEdit(editor, false),
        }
        return actions
    },
}

// Only image types RM and the asset upload path support; other formats and
// video/embeds won't sync. Gate the picker/paste/drop at the editor level.
const ACCEPTED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg']
const NO_VIDEO: string[] = []
import { StudioController, type PageGeometry, type PageMeta } from './controller'
import { setDeviceTextCommit } from './DeviceTextShapeUtil'
import { DeviceRichTextToolbar } from './DeviceTextToolbar'
import { restorePageCamera } from './page-camera'
import { weftRendererOptions } from './renderer-options'
import { useInteracting } from './use-interacting'
import { transport, guardedPageTransport, clientId, authorUuid } from '../transport'
import { guardedPageScope } from '../auth'
import { apiBase } from '../settings'
import { authHeaders, fetchBlobUrl } from '../authedAsset'
import { idb } from '../idb'
import { openSource } from '../sourceFile'
import { HistoryPanel } from './HistoryPanel'
import { announceDockOpen, onOtherDockOpen } from './dock'
import { panelProse, panelRow, rowAction } from './panel-styles'
import { TemplatePanel } from './TemplatePanel'
import { renderTemplateSvg, RM_SCALE, type RmTemplate } from '@weft/rm-ink'
import type { TextParagraph } from '@weft/rm-format'

/** weft terminal font — JetBrains Mono everywhere in app chrome. */
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, monospace"

/**
 * Opened-PDF cache keyed by (doc, revision). Keeping the PDFDocumentProxy
 * alive makes page N+1 just getPage()+render() instead of re-parsing the
 * whole file. Bounded; evicted proxies are destroyed. On failure the caller
 * evicts and re-opens once so the cache never wedges a doc permanently.
 */
type PdfProxy = import('pdfjs-dist').PDFDocumentProxy
const pdfDocCache = new Map<string, Promise<PdfProxy>>()
const PDF_DOC_CACHE_MAX = 2

function getCachedPdf(key: string, open: () => Promise<PdfProxy>): Promise<PdfProxy> {
    const hit = pdfDocCache.get(key)
    if (hit) {
        pdfDocCache.delete(key)
        pdfDocCache.set(key, hit) // bump LRU recency
        return hit
    }
    const p = open()
    pdfDocCache.set(key, p)
    // a rejected open must not poison the cache: drop it (if still ours).
    void p.catch(() => {
        if (pdfDocCache.get(key) === p) pdfDocCache.delete(key)
    })
    while (pdfDocCache.size > PDF_DOC_CACHE_MAX) {
        const oldest = pdfDocCache.keys().next().value as string
        const proxy = pdfDocCache.get(oldest)!
        pdfDocCache.delete(oldest)
        void proxy.then((d) => d.loadingTask.destroy()).catch(() => {})
    }
    return p
}

/**
 * Evict a doc only if the cache still holds the exact promise the caller used
 * (identity, not key), so a page's failure-retry cannot destroy a proxy a
 * concurrent page already re-opened at the same key.
 */
function evictCachedPdfIf(key: string, promise: Promise<PdfProxy>): void {
    if (pdfDocCache.get(key) !== promise) return
    pdfDocCache.delete(key)
    void promise.then((d) => d.loadingTask.destroy()).catch(() => {})
}

function sameRect(a: PageGeometry, b: PageGeometry): boolean {
    return (
        Math.abs(a.x - b.x) < 1 &&
        Math.abs(a.y - b.y) < 1 &&
        Math.abs(a.w - b.w) < 1 &&
        Math.abs(a.h - b.h) < 1
    )
}

/** The default toolbar, recomposed so device-text sits in the always-visible
 *  row (capped at 8 items) next to the overlay text tool instead of
 *  overflowing into the "more" menu. */
function WeftToolbar() {
    return (
        <DefaultToolbar>
            {/* first 8 stay in the visible row; geo shapes overflow into the
                "more" popover. Every item here projects to RM ink. */}
            <SelectToolbarItem />
            <HandToolbarItem />
            <DrawToolbarItem />
            <HighlightToolbarItem />
            <EraserToolbarItem />
            <ArrowToolbarItem />
            <TextToolbarItem />
            <TldrawUiMenuToolItem toolId="device-text" />
            <AssetToolbarItem />
            <LineToolbarItem />
            <RectangleToolbarItem />
            <EllipseToolbarItem />
            <TriangleToolbarItem />
            <DiamondToolbarItem />
            <StarToolbarItem />
            <HexagonToolbarItem />
            <RhombusToolbarItem />
            <TrapezoidToolbarItem />
            <OvalToolbarItem />
            <CloudToolbarItem />
            <HeartToolbarItem />
            <XBoxToolbarItem />
            <CheckBoxToolbarItem />
            <ArrowRightToolbarItem />
            <ArrowLeftToolbarItem />
            <ArrowUpToolbarItem />
            <ArrowDownToolbarItem />
            <LaserToolbarItem />
        </DefaultToolbar>
    )
}

/** Trigger a browser download of `bytes` as `filename`. */
function downloadBytes(bytes: Uint8Array, filename: string, mime: string): void {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    // revoke after the click has had a tick to start the download
    setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** The default main menu plus a "Download .rm" item: the native reMarkable v6
 *  page file, alongside tldraw's PNG/SVG/JSON exports. */
function weftMainMenu(controller: StudioController, pageId: string) {
    return function WeftMainMenu() {
        return (
            <DefaultMainMenu>
                <TldrawUiMenuGroup id="weft-export">
                    <TldrawUiMenuItem
                        id="export-rm"
                        label="Download .rm (reMarkable)"
                        icon="share-1"
                        readonlyOk
                        onSelect={() => {
                            const bytes = controller.exportRmBytes()
                            if (!bytes) return
                            downloadBytes(bytes, `${pageId}.rm`, 'application/octet-stream')
                        }}
                    />
                </TldrawUiMenuGroup>
                <DefaultMainMenuContent />
            </DefaultMainMenu>
        )
    }
}

/** Dashed verticals at the tablet's visible width (±810 ink units): what fits
 *  on the physical screen inside the wider writable page. Shown only while
 *  moving/resizing shapes, like the device's own guides. */
function TabletWidthGuides({ geo }: { geo: PageGeometry }) {
    const editor = useEditor()
    const interacting = useInteracting()
    // clamp the guide's y-span to the visible viewport (intersected with the
    // page): geo.h can be tens of thousands of px, and a border that tall is
    // re-rasterized every zoom frame.
    const vp = useValue('viewport', () => editor.getViewportPageBounds(), [editor])
    // visible-width guide only applies to centered Paper Pro pages (legacy
    // uncentered pages span 0..1404).
    if (!interacting || !geo.centered) return null
    const half = 810 * RM_SCALE
    const top = Math.max(geo.y, vp.y)
    const height = Math.max(0, Math.min(geo.y + geo.h, vp.y + vp.h) - top)
    if (height <= 0) return null
    return (
        <>
            {[-half, half].map((x) => (
                <div
                    key={x}
                    data-testid="tablet-width-guide"
                    style={{
                        position: 'absolute',
                        left: x,
                        top,
                        width: 0,
                        height,
                        borderLeft: '1.5px dashed #9a9a9a',
                        pointerEvents: 'none',
                    }}
                />
            ))}
        </>
    )
}

/** Template + PDF underlay + page outline, all in page space. */
function PageChrome({
    geo,
    meta,
    docId,
    onPdfSize,
}: {
    geo: PageGeometry
    meta: PageMeta
    docId: string
    onPdfSize?: (w: number, h: number) => void
}) {
    const [pdfImage, setPdfImage] = useState<string | null>(null)
    const [templateSrc, setTemplateSrc] = useState<string | null>(null)
    // source PDF is tablet-only (not on the cloud): show a banner instead of a
    // silent blank underlay
    const [sourceCold, setSourceCold] = useState(false)

    // Fetch keyed on template identity only (not geo): a template's DSL/bytes
    // don't change as the page grows. Parsed JSON DSL is held in state and
    // re-rendered for the current geometry in the split effect below; image
    // templates are geo-independent and set the src directly here.
    const [templateDsl, setTemplateDsl] = useState<RmTemplate | null>(null)
    useEffect(() => {
        if (!meta.template) {
            // "Blank" (or no template) must clear the underlay.
            setTemplateDsl(null)
            setTemplateSrc(null)
            return
        }
        let cancelled = false
        void (async () => {
            try {
                const resp = await fetch(
                    `${apiBase()}/api/templates/${encodeURIComponent(meta.template!)}`,
                    { headers: await authHeaders() },
                )
                if (!resp.ok) return
                const type = resp.headers.get('content-type') ?? ''
                if (type.includes('json')) {
                    // Paper Pro JSON template DSL -> client-rendered SVG (below)
                    const tpl = (await resp.json()) as RmTemplate
                    if (!cancelled) setTemplateDsl(tpl)
                } else {
                    // image template: load through the API as an authed blob (a
                    // bare <img src> would 401 in cloud mode).
                    setTemplateDsl(null)
                    const blob = await fetchBlobUrl(
                        `/api/templates/${encodeURIComponent(meta.template!)}`,
                    )
                    if (blob && !cancelled) setTemplateSrc(blob)
                }
            } catch (e) {
                console.warn('template underlay failed:', e)
            }
        })()
        return () => {
            cancelled = true
        }
    }, [meta.template])

    // RENDER the JSON template to an SVG for the CURRENT geometry. Re-runs on a
    // page grow (geo.h/geo.w) but does NOT re-fetch — only re-encodes locally.
    useEffect(() => {
        if (!templateDsl) return
        // Anchoring is DESIGN space (1404x1872, centered on the page): stroke-to-
        // template alignment was verified correct there by the owner, and a
        // surface-width anchor shifted fixed-offset items (margins, grid origins)
        // sideways. The pattern still FILLS the whole panel: the viewport spans
        // the page's real ink width and the renderer tiles repeats (with partial
        // edge boxes) across it.
        const pageWInk = Math.round(geo.w / RM_SCALE)
        const fillHeight = Math.ceil(geo.h / RM_SCALE)
        const svg = renderTemplateSvg(templateDsl, {
            width: 1404,
            height: 1872,
            fillHeight,
            viewportX: -(pageWInk - 1404) / 2,
            viewportWidth: pageWInk,
            // renderer gaps must be VISIBLE in dev — 16/65 device templates once
            // rendered blank without a whisper
            onSkip: import.meta.env.DEV
                ? (what, err) => console.warn(`template "${meta.template}" skipped ${what}:`, err)
                : undefined,
        })
        setTemplateSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
    }, [templateDsl, geo.h, geo.w, meta.template])

    useEffect(() => {
        // EPUBs ride the same path: once opened on-device, xochitl writes the
        // converted <doc>.pdf next to the .epub (annotations anchor to that
        // pagination) and /file serves it with PDF preference. An epub that
        // was never opened has no conversion yet -> pdf.js throws -> no
        // underlay until the device generates it.
        if ((meta.docType !== 'pdf' && meta.docType !== 'epub') || meta.fileIndex === null) return
        let cancelled = false
        setPdfImage(null)
        setSourceCold(false)
        void (async () => {
            try {
                // Resolve the source FIRST (revalidating cache access, sourceFile.ts):
                // small files come back as whole bytes (cached, offline-capable);
                // the giant class Range-streams; a tablet-only source is 'cold'.
                // Running this before the rendered-image cache is what makes a
                // re-imported PDF (new etag) refresh and a cold doc show the
                // banner instead of a stale underlay.
                const source = await openSource(docId)
                if (cancelled) return
                if (source.kind === 'error') throw new Error(source.detail)
                const { scope, isCurrent } = source
                const active = () => !cancelled && isCurrent()
                if (!active()) return
                if (source.kind === 'cold') {
                    setSourceCold(true)
                    setPdfImage(null)
                    return
                }

                // rendered-page cache keyed by the source ETAG (revision), so a
                // re-import never shows the old page image. Falls back to a
                // revision-less key only when the etag is unknown (offline).
                // Stored in IndexedDB (hundreds of MB), NOT localStorage (~5 MB):
                // a full-page JPEG is ~200-400 KB, so a multi-page PDF (e.g. a
                // Quran) used to blow the localStorage quota and evict EVERY
                // cached page, so revisiting any page re-ran pdf.js from scratch
                // (the "second time is still slow" report). IndexedDB holds them
                // all, so a revisit is an instant cache read.
                const rev = source.etag || 'norev'
                const stalePrefix = `pdfimg4/${scope}/${docId}/${meta.fileIndex}/`
                const cacheKey = `${stalePrefix}${rev}`
                const cached = scope ? await idb.get(cacheKey) : null
                if (!active()) return
                if (cached) {
                    const entry = JSON.parse(new TextDecoder().decode(cached)) as {
                        data: string
                        w: number
                        h: number
                    }
                    onPdfSize?.(entry.w, entry.h)
                    setPdfImage(entry.data)
                    return
                }
                const pdfjs = await import('pdfjs-dist')
                const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
                pdfjs.GlobalWorkerOptions.workerSrc = worker
                const docKey = scope ? `${scope}/${docId}/${rev}` : crypto.randomUUID()
                const openDoc = async () =>
                    source.kind === 'data'
                        ? pdfjs.getDocument({ data: source.data }).promise
                        : pdfjs.getDocument({
                              url: source.url,
                              // fresh bearer per (re-)open so the retry below
                              // recovers from a mid-session token expiry (#71 C1)
                              httpHeaders: await source.getHeaders(),
                              // range mode: fetch only what the page render needs
                              disableAutoFetch: true,
                              rangeChunkSize: 262144,
                          }).promise
                // reuse the opened document across pages; on a failure (stale
                // range header, torn-down worker) drop THIS proxy (by identity,
                // so a concurrent page's re-open isn't clobbered) and re-open ONCE.
                let page
                const proxy = getCachedPdf(docKey, openDoc)
                try {
                    page = await proxy.then((d) => d.getPage(meta.fileIndex! + 1))
                } catch {
                    evictCachedPdfIf(docKey, proxy)
                    page = await getCachedPdf(docKey, openDoc).then((d) =>
                        d.getPage(meta.fileIndex! + 1),
                    )
                }
                if (!active()) return
                const vp1 = page.getViewport({ scale: 1 })
                onPdfSize?.(vp1.width, vp1.height)
                const viewport = page.getViewport({ scale: 2 })
                const canvas = document.createElement('canvas')
                canvas.width = viewport.width
                canvas.height = viewport.height
                await page.render({
                    canvasContext: canvas.getContext('2d')!,
                    viewport,
                    canvas,
                } as never).promise
                if (!active()) return
                const data = canvas.toDataURL('image/jpeg', 0.85)
                setPdfImage(data)
                if (!scope) return
                try {
                    // drop any older-revision image for this page before caching
                    // the new one (one live entry per (doc, page) revision)
                    for (const k of await idb.keys(stalePrefix)) {
                        if (k !== cacheKey) await idb.delete(k)
                    }
                    await idb.set(
                        cacheKey,
                        new TextEncoder().encode(JSON.stringify({ data, w: vp1.width, h: vp1.height })),
                    )
                } catch (e) {
                    console.warn('pdf image cache write failed:', e)
                }
            } catch (e) {
                console.warn('pdf underlay failed:', e)
            }
        })()
        return () => {
            cancelled = true
        }
    }, [meta.docType, meta.fileIndex, docId])

    return (
        <>
            {/* The sheet: solid edges; the bottom sits close to the last ink
                (owner: an edge-less page read as broken) and moves down as
                the page grows. */}
            <div
                style={{
                    position: 'absolute',
                    left: geo.x,
                    top: geo.y,
                    width: geo.w,
                    height: geo.h,
                    background: 'white',
                    border: '1.5px solid #c9c9c9',
                    borderRadius: '2px',
                    boxShadow: '0 2px 16px rgba(0,0,0,0.07)',
                    pointerEvents: 'none',
                }}
            />
            {templateSrc && (
                <img
                    src={templateSrc}
                    alt=""
                    data-testid="template-underlay"
                    draggable={false}
                    style={{
                        position: 'absolute',
                        left: geo.x,
                        top: geo.y,
                        width: geo.w,
                        height: geo.h,
                        maxWidth: 'none',
                        opacity: 0.9,
                        pointerEvents: 'none',
                    }}
                />
            )}
            {pdfImage && (
                <img
                    src={pdfImage}
                    alt=""
                    draggable={false}
                    style={{
                        position: 'absolute',
                        left: geo.x,
                        top: geo.y,
                        width: geo.w,
                        maxWidth: 'none',
                        pointerEvents: 'none',
                    }}
                />
            )}
            {sourceCold && (
                <div
                    data-testid="cold-source-banner"
                    style={{
                        position: 'absolute',
                        left: geo.x,
                        top: geo.y,
                        width: geo.w,
                        display: 'flex',
                        justifyContent: 'center',
                        pointerEvents: 'none',
                    }}
                >
                    <div
                        style={{
                            marginTop: 24,
                            padding: '8px 14px',
                            borderRadius: 6,
                            border: '1px solid #d9d4c5',
                            background: '#faf8f2',
                            color: '#6b6656',
                            fontSize: 13,
                            maxWidth: '80%',
                            textAlign: 'center',
                        }}
                    >
                        The PDF for this document lives on your tablet only right now. Your notes
                        and ink still sync; open the document on the tablet to bring the PDF here.
                    </div>
                </div>
            )}
        </>
    )
}

/** Layer list: visibility eyes + active-layer selection + add. */
function LayersPanel({ controller }: { controller: StudioController }) {
    const [open, setOpen] = useState(false)
    useEffect(() => onOtherDockOpen('layers', () => setOpen(false)), [])
    const [layers, setLayers] = useState<ReturnType<StudioController['listLayers']>>([])
    const refresh = useCallback(() => {
        try {
            setLayers(controller.listLayers())
        } catch {
            // session not ready yet
        }
    }, [controller])
    useEffect(() => {
        controller.onLayersChanged = refresh
        const t = setInterval(refresh, 3000) // tablet-side layer changes
        refresh()
        // the session finishes bootstrapping shortly after mount: retry fast
        // so the list doesn't appear seconds late (owner-reported)
        const retries = [200, 600, 1200].map((ms) => setTimeout(refresh, ms))
        return () => {
            controller.onLayersChanged = null
            clearInterval(t)
            for (const r of retries) clearTimeout(r)
        }
    }, [controller, refresh])

    return (
        <>
            <button
                data-testid="layers-toggle"
                className="wf-dock-item"
                data-active={open}
                style={{ cursor: 'pointer' }}
                onClick={() =>
                    setOpen((v) => {
                        if (!v) {
                            announceDockOpen('layers')
                            refresh()
                        }
                        return !v
                    })
                }
            >
                layers
            </button>
            {open && (
        <div data-testid="layers-panel" className="wf-panel">
            <div className="wf-panel-head">layers</div>
            <div className="wf-panel-body">
            {layers.length === 0 && (
                <div style={{ padding: 6, color: 'var(--gray-5)' }}>loading…</div>
            )}
            {[...layers].reverse().map((layer) => (
                <div
                    key={layer.key}
                    style={{
                        ...panelRow(layer.active),
                        cursor: 'pointer',
                        opacity: layer.visible ? 1 : 0.45,
                    }}
                    onClick={() => controller.setActiveLayer(layer.ref)}
                    data-testid={`layer-row-${layer.label}`}
                >
                    <span>{layer.label}</span>
                    <button
                        data-testid={`layer-eye-${layer.label}`}
                        onClick={(e) => {
                            e.stopPropagation()
                            void controller.setLayerVisible(layer.ref, !layer.visible).catch(() => {})
                        }}
                        style={rowAction}
                    >
                        {layer.visible ? 'hide' : 'show'}
                    </button>
                </div>
            ))}
            <button
                data-testid="layer-add"
                onClick={() => void controller.createLayer(`Layer ${layers.length + 1}`).catch(() => {})}
                style={{ ...rowAction, marginTop: 6, width: '100%', padding: '4px 0' }}
            >
                + layer
            </button>
            </div>
        </div>
            )}
        </>
    )
}

function DetachedActions({ controller }: { controller: StudioController }) {
    const editor = useEditor()
    // ANY detached shape on the page surfaces the bar — not just a selected
    // one. The surviving tablet ink renders on top of the ghost, so a click
    // usually selects loose ink, and a selection-gated bar becomes unreachable
    // exactly when it is needed.
    const detachedIds = useValue(
        'detached-on-page',
        () =>
            editor
                .getCurrentPageShapes()
                .filter((s) => (s.meta as { detached?: boolean })?.detached)
                .map((s) => s.id as string),
        [editor],
    )
    if (detachedIds.length === 0) return null
    return (
        <div
            style={{
                position: 'fixed',
                bottom: 64,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 9999,
                // the InFrontOfTheCanvas wrapper is pointer-events:none;
                // without opting back in the buttons are visible but every
                // click falls through to the canvas
                pointerEvents: 'all',
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                padding: '8px 14px',
                borderRadius: 4,
                background: 'var(--gray-1)',
                border: '1px solid var(--gray-3)',
                fontFamily: MONO,
                fontSize: 13,
            }}
        >
            <span style={{ color: 'var(--gray-b)', fontWeight: 600 }}>
                Edited on tablet — shape detached
            </span>
            <button
                style={btn('var(--blue)', 'var(--gray-0)', 'var(--blue)')}
                onClick={() => detachedIds.forEach((id) => void controller.reattachShape(id).catch(() => {}))}
            >
                Re-attach (re-render)
            </button>
            <button
                style={btn('transparent', 'var(--gray-b)', 'var(--gray-3)')}
                onClick={() => detachedIds.forEach((id) => void controller.releaseShape(id).catch(() => {}))}
            >
                Keep as ink
            </button>
        </div>
    )
}

function btn(bg: string, color: string, border: string): React.CSSProperties {
    return {
        padding: '5px 12px',
        borderRadius: 3,
        border: `1px solid ${border}`,
        background: bg,
        color,
        fontFamily: MONO,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        cursor: 'pointer',
    }
}

export interface TldrawAppProps {
    docId: string
    pageId: string
    onController?: (controller: StudioController | null) => void
}

export function TldrawApp({ docId, pageId, onController }: TldrawAppProps) {
    const [status, setStatus] = useState<string>('connecting…')
    // The tablet's SYNC-LOOP heartbeat, not its WebSocket: 'synced' means the
    // cloud has your edits; this chip says whether the tablet is consuming
    // them (owner incident: 53 min of a reassuring pill while the device
    // synced nothing). null heartbeat = unknown (fresh server), not offline.
    const [tabletStale, setTabletStale] = useState<'' | 'tablet offline' | 'a tablet offline'>('')
    useEffect(() => {
        let dead = false
        const check = async () => {
            try {
                const r = await fetch(`${apiBase()}/api/sync-heartbeat`, {
                    headers: await authHeaders(),
                })
                if (!r.ok) return
                const { msAgo, devices } = (await r.json()) as {
                    msAgo: number | null
                    devices?: number[]
                }
                const ages = Array.isArray(devices)
                    ? devices
                    : msAgo !== null
                      ? [msAgo]
                      : []
                const stale = ages.filter((a) => a > 60_000).length
                if (!dead)
                    setTabletStale(
                        ages.length > 0 && stale === ages.length
                            ? 'tablet offline'
                            : stale > 0
                              ? 'a tablet offline'
                              : '',
                    )
            } catch {
                // network blip: keep the last verdict
            }
        }
        void check()
        const t = setInterval(() => void check(), 20_000)
        return () => {
            dead = true
            clearInterval(t)
        }
    }, [])
    // structured sync detail for the explainer panel (the pill was
    // owner-reported as unclear: it now opens a plain-language panel)
    const [syncDetail, setSyncDetail] = useState<{
        state: string
        ops: number
        detail?: string
        at: number
    }>({ state: 'connecting', ops: 0, at: Date.now() })
    const [syncOpen, setSyncOpen] = useState(false)
    useEffect(() => onOtherDockOpen('sync', () => setSyncOpen(false)), [])
    const [fatal, setFatal] = useState<string | null>(null)
    const [availableController, setAvailableController] = useState<StudioController | null>(null)
    const [geo, setGeo] = useState<PageGeometry | null>(null)
    const [meta, setMeta] = useState<PageMeta | null>(null)
    // The tldraw editor is mounted ONCE and reused across page/doc switches;
    // captured here so the session-swap effect can (re)bind to it.
    const [editor, setEditor] = useState<Editor | null>(null)

    const { controller, relay, closeScopedTransport } = useMemo(
        () => {
            const guarded = import.meta.env.PUBLIC_GUARDED_SAVES === '1'
            const scope = guarded ? guardedPageScope() : null
            const scopedTransport = scope ? guardedPageTransport(scope) : null
            const sessionTransport = scopedTransport?.transport ?? transport()
            const controller = new StudioController({
                transport: sessionTransport,
                ...(guarded ? { guardedScope: scope?.key ?? null } : {}),
                ...(scopedTransport ? { revokeGuardedTransport: scopedTransport.revoke } : {}),
                docId,
                pageId,
                clientId: clientId(),
                authorUuid: authorUuid(),
                fontUrl: '/fonts/ShantellSans.ttf',
                onPageAvailable: () => setAvailableController(controller),
                onStatus: (s) => {
                    const detail = (s as { detail?: string }).detail
                    const ops = (s as { ops?: number }).ops ?? 0
                    setSyncDetail({ state: s.state, ops, detail, at: Date.now() })
                    setStatus(
                        s.state === 'synced'
                            ? 'synced'
                            : s.state === 'pending'
                              ? 'saving…'
                              : s.state === 'offline'
                                ? 'offline'
                                : 'sync problem',
                    )
                },
            })
            return {
                controller, relay: sessionTransport.baseUrl,
                closeScopedTransport: scopedTransport?.revoke,
            }
        },
        [docId, pageId],
    )

    const pageUnavailable = availableController !== controller

    // Session lifecycle, re-run whenever the controller changes (i.e. a
    // page/doc switch) against the SAME persistent editor. The previous
    // controller's cleanup (below) has already disposed it — dropping its
    // store listener — so we can safely wipe the old page's shapes before the
    // new session paints. This is what turns a switch from "rebuild the whole
    // editor" into "swap a few shapes".
    useEffect(() => {
        if (!editor) return
        onController?.(controller)
        const live = window as unknown as { __weftEditor?: Editor; __weftController?: StudioController }
        live.__weftEditor = editor
        live.__weftController = controller
        setDeviceTextCommit(
            editor,
            (richText) => void controller.commitDeviceText(richText).catch(() => {}),
            () => controller.canStartDeviceTextEdit(),
        )
        // clear the prior page off the shared editor (no old listener records
        // these deletes: the previous controller was disposed in cleanup first).
        // history:'ignore' so the wipe is never undoable.
        const prior = editor.getCurrentPageShapeIds()
        if (prior.size) editor.run(() => editor.deleteShapes([...prior]), { history: 'ignore' })
        setFatal(null)
        setSyncDetail({ state: 'connecting', ops: 0, at: Date.now() })
        setGeo(null)
        setMeta(null)
        // metadata (template, pdf rect) arrives in the BACKGROUND — the open
        // does not block on the doclist fetch
        controller.onMetaChanged = () => {
            setMeta(controller.pageMeta)
            setGeo(controller.getPageGeometry())
        }
        // `cancelled` closes the switch-during-open window: start() resolves
        // even after this effect's cleanup ran (a fast switch, or start()'s own
        // disposed-guard early-return), and this .then/.catch must NOT then
        // touch the now-shared editor — else it leaks a grow interval created
        // after cleanup, snaps the camera to the OLD page's bounds, or pops a
        // fatal overlay on the NEW page.
        let cancelled = false
        let grow: ReturnType<typeof setInterval> | null = null
        let stopCamera: (() => void) | undefined
        let stopWorkerRegistration: (() => void) | undefined
        void controller
            .start(editor)
            .then(() => {
                if (cancelled) return
                const g = controller.getPageGeometry()
                setGeo(g)
                setMeta(controller.pageMeta)
                // grow the page as ink arrives (device pages scroll forever)
                grow = setInterval(() => {
                    const next = controller.getPageGeometry()
                    setGeo((prev) => (prev && sameRect(prev, next) ? prev : next))
                }, 2000)
                // Geometry is stable from the FIRST frame (centered comes from
                // cache/default, never from late-arriving ink), so one camera
                // placement is enough. FIXED 60% default zoom (owner pick after
                // the RM_SCALE change made fit-zoom ~47% feel small): page
                // centered horizontally, top-anchored with a small margin.
                const z = 0.6
                const vp = editor.getViewportScreenBounds()
                stopCamera = restorePageCamera(editor, relay, docId, pageId, {
                    x: vp.w / 2 / z - (g.x + g.w / 2),
                    y: 16 / z - g.y,
                    z,
                })
                // fresh page = fresh undo stack: never undo across a page
                // switch or undo the initial render into an empty page.
                editor.clearHistory()
                stopWorkerRegistration = registerNotebookWorker()
            })
            .catch((e: unknown) => {
                if (cancelled) return
                console.error('weft: session failed', e)
                setFatal(String(e))
            })
        return () => {
            cancelled = true
            if (grow) clearInterval(grow)
            stopCamera?.()
            onController?.(null)
            stopWorkerRegistration?.()
            if (live.__weftController === controller && live.__weftEditor === editor) {
                delete live.__weftEditor
                delete live.__weftController
            }
            controller.dispose()
            closeScopedTransport?.()
        }
    }, [closeScopedTransport, controller, docId, editor, onController, pageId, relay])

    // Stable main-menu component identity (depends only on controller+pageId),
    // so the geo/meta-driven `components` rebuild below doesn't remount the
    // menu. MUST be declared BEFORE `components`, which references it.
    const WeftMainMenu = useMemo(() => weftMainMenu(controller, pageId), [controller, pageId])

    const components = useMemo(
        () => ({
            InFrontOfTheCanvas: () => <DetachedActions controller={controller} />,
            OnTheCanvas: () =>
                geo && meta ? (
                    <>
                        <PageChrome
                            geo={geo}
                            meta={meta}
                            docId={docId}
                            onPdfSize={(w, h) => {
                                const cur = controller.pdfPtSize
                                if (cur && Math.abs(cur.w - w) < 0.5 && Math.abs(cur.h - h) < 0.5)
                                    return
                                controller.pdfPtSize = { w, h }
                                setGeo((prev) => {
                                    const next = controller.getPageGeometry()
                                    return prev && sameRect(prev, next) ? prev : next
                                })
                            }}
                        />
                        <TabletWidthGuides geo={geo} />
                    </>
                ) : null,
            // weft edits ONE reMarkable page per editor instance (RM pages are
            // the page model; layers are the in-page structure) — tldraw's own
            // multi-page UI would create pages that exist nowhere on the
            // device. Hide it entirely.
            PageMenu: null,
            // rich text controls limited to what the tablet can express
            RichTextToolbar: DeviceRichTextToolbar,
            // the default toolbar + the device-text button (typed-text
            // column entry point, discoverable like any other tool)
            Toolbar: WeftToolbar,
            // main menu + a native .rm download (weft's own format).
            // Stable identity (see WeftMainMenu memo) so this doesn't remount
            // when geo/meta change.
            MainMenu: WeftMainMenu,
        }),
        [geo, meta, docId, WeftMainMenu, controller],
    )

    return (
        // Keep the geometry gate during session open and camera placement.
        <div
            style={{
                position: 'fixed',
                inset: 0,
                // while settling, show the CANVAS color, not the app's black
                // (owner: opening a note held on a black screen)
                background: 'hsl(210, 20%, 98%)',
            }}
            data-testid="editor-root"
        >
            <div style={{ position: 'absolute', inset: 0 }} inert={pageUnavailable}>
            {/* acceptedImage/VideoMimeTypes are TOP-LEVEL <Tldraw> props in
                tldraw 5 (NOT `options` — that's silently ignored and the picker
                falls back to gif/webp/svg/video). Here they gate the file
                picker/paste/drop to the only image types RM + our asset path
                support. */}
            <Tldraw
                licenseKey={env.PUBLIC_TLDRAW_LICENSE_KEY || undefined}
                {...weftRendererOptions}
                assetUrls={editorAssets}
                onMount={setEditor}
                components={components}
                overrides={uiOverrides}
                acceptedImageMimeTypes={ACCEPTED_IMAGE_MIME_TYPES}
                acceptedVideoMimeTypes={NO_VIDEO}
            />
            </div>
            {(fatal || pageUnavailable) && (
                <div
                    role="status"
                    style={{
                        position: 'fixed',
                        inset: 0,
                        zIndex: 10000,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'rgba(0,0,0,0.92)',
                    }}
                >
                    <div
                        style={{
                            maxWidth: 480,
                            padding: 28,
                            borderRadius: 4,
                            border: '1px solid var(--gray-3)',
                            background: 'var(--gray-1)',
                            color: 'var(--gray-b)',
                            fontFamily: MONO,
                            fontSize: 14,
                        }}
                    >
                        <p
                            style={{
                                fontFamily: MONO,
                                fontSize: 11,
                                letterSpacing: '0.14em',
                                textTransform: 'uppercase',
                                color: 'var(--red)',
                                margin: 0,
                            }}
                        >
                            {fatal || syncDetail.state === 'error' ? 'Error' : syncDetail.state === 'offline' ? 'Offline' : 'Loading'}
                        </p>
                        <strong
                            style={{
                                display: 'block',
                                marginTop: 6,
                                fontFamily: MONO,
                                fontWeight: 700,
                                fontSize: 20,
                                color: 'var(--gray-f)',
                            }}
                        >
                            {fatal || syncDetail.state === 'offline' || syncDetail.state === 'error'
                                ? "Couldn't open this page" : 'Opening this page'}
                        </strong>
                        <pre
                            style={{
                                whiteSpace: 'pre-wrap',
                                marginTop: 12,
                                padding: 10,
                                borderRadius: 3,
                                border: '1px solid var(--gray-2)',
                                background: 'var(--gray-0)',
                                fontFamily: MONO,
                                fontSize: 12,
                                color: 'var(--gray-7)',
                            }}
                        >
                            {fatal ?? (syncDetail.state === 'offline' ? 'This page is unavailable offline.'
                                : syncDetail.state === 'error' ? (syncDetail.detail ?? 'Unable to load the page.')
                                : 'Waiting for this page’s first download.')}
                        </pre>
                        <a
                            href="/library"
                            style={{
                                display: 'inline-block',
                                marginTop: 16,
                                color: 'var(--blue)',
                                textDecoration: 'none',
                            }}
                        >
                            ← Back to files
                        </a>
                    </div>
                </div>
            )}
            {/* the weft dock: every editor overlay control in ONE cluster
                (desktop bottom-right, phones top-right — see .wf-dock) */}
            <div className="wf-dock" inert={pageUnavailable}>
            <LayersPanel controller={controller} />
            <HistoryPanel docId={docId} pageId={pageId} />
            {meta && (
                <TemplatePanel
                    docId={docId}
                    pageId={pageId}
                    current={meta.template ?? null}
                    onPicked={(name) =>
                        // optimistic: swap the underlay immediately; the cloud
                        // list is already updated and the daemon applies it
                        // on-device from its next doc-list pull.
                        setMeta((m) => (m ? { ...m, template: name === 'Blank' ? null : name } : m))
                    }
                />
            )}
            <button
                data-testid="sync-status"
                className="wf-dock-item"
                data-active={syncOpen}
                style={{ cursor: 'pointer' }}
                onClick={() =>
                    setSyncOpen((v) => {
                        if (!v) announceDockOpen('sync')
                        return !v
                    })
                }
            >
                <span
                    style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        background:
                            status === 'synced'
                                ? 'var(--blue)'
                                : status.startsWith('offline')
                                  ? 'var(--gray-5)'
                                  : 'var(--gray-7)',
                    }}
                />
                {status}
            </button>
            {tabletStale !== '' && (
                <span
                    data-testid="tablet-status"
                    className="wf-dock-item"
                    title="A tablet's sync loop has not checked in for over a minute. 'synced' means your edits are safe in the cloud; they reach the tablet when it reconnects."
                    style={{ color: 'var(--yellow)', cursor: 'default' }}
                >
                    {tabletStale}
                </span>
            )}
            {syncOpen && (
                <div data-testid="sync-panel" className="wf-panel">
                    <div className="wf-panel-head">sync</div>
                    <div className="wf-panel-body" style={panelProse}>
                        {syncDetail.state === 'synced' && (
                            <>
                                Every change on this page is saved to your account. Your
                                tablet picks it up the next time it syncs (within seconds
                                while it is awake).
                            </>
                        )}
                        {syncDetail.state === 'pending' && (
                            <>
                                Saving {syncDetail.ops || 'your latest'}{' '}
                                {syncDetail.ops === 1 ? 'change' : 'changes'} to your
                                account…
                            </>
                        )}
                        {syncDetail.state === 'offline' && (
                            <>
                                You are offline. {syncDetail.ops > 0
                                    ? `${syncDetail.ops} ${syncDetail.ops === 1 ? 'change is' : 'changes are'} stored safely in this browser and will upload the moment you are back.`
                                    : 'Edits keep working and are stored in this browser until you are back.'}
                            </>
                        )}
                        {syncDetail.state !== 'synced' &&
                            syncDetail.state !== 'pending' &&
                            syncDetail.state !== 'offline' && (
                                <>
                                    Syncing hit a problem: {syncDetail.detail ?? 'unknown'}.
                                    Your edits stay in this browser; nothing is lost.
                                </>
                            )}
                        {controller.hasUnreadableShapes && (
                            <p>
                                This version of Weft can’t display some browser shapes.
                                Their saved records are still available.{' '}
                                <button onClick={() => {
                                    const bytes = controller.exportUnreadableShapes()
                                    if (bytes) downloadBytes(bytes, `${pageId}-unreadable-shapes.json`, 'application/json')
                                }}>
                                    Download shape records
                                </button>
                            </p>
                        )}
                    </div>
                </div>
            )}
            </div>
        </div>
    )
}
