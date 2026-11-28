/**
 * Binds a tldraw Editor to an OfflineSession. View->engine: store changes
 * project to ink and apply as LocalOps. Engine->view: ViewPatches mutate the
 * editor. Programmatic editor writes go through mergeRemoteChanges (see remote).
 */

import { libraryCacheScope, readCachedDocumentList } from '../library-cache'
import {
    AssetRecordType,
    createShapeId,
    DefaultFontFamilies,
    isShapeId,
    Mat,
    T,
    getIndicesBetween,
    isPageId,
    type IndexKey,
    type TLAssetId,
    type TLImageShape,
    type TLShapePartial,
    type Editor,
    type ShapeUtil,
    type TLDrawShape,
    type TLShape,
    type TLShapeId,
} from 'tldraw'
import {
    OfflineSession,
    itemRefKey,
    layerIdToRef,
    shapeOpacity,
    type LayerRef,
    type SyncStatus,
    type LocalOp,
    type OpVersion,
    type OverlayShape,
    type Transport,
    type ViewPatch,
} from '@weft/sync-engine'
import {
    drawShapeToInk,
    lineToDrawShape,
    textToGlyphParts,
    wrappedLineCount,
    fillContours,
    walkPathCommands,
    pathBuilderCommands,
    flattenSvgD,
    polylineToPoints,
    mapToRmSpace,
    applyDashPattern,
    dottedDots,
    tldrawWidthToRmMarkerWidth,
    RM_SCALE,
    type InkStroke,
} from '@weft/rm-ink'
import { RefResolver, remapImagesByUuid, type LiveImage } from '@weft/sync-engine'
import {
    crdtIdKey,
    type Point,
    diffCodePoints,
    planFormatEdits,
    rootTextCharPositions,
    paragraphStyleShadows,
    END_MARKER,
    Pen,
    type Line,
} from '@weft/rm-format'
import {
    nodeKindForParagraph,
    paragraphsToRichText,
    richTextToLines,
    styleForNodeKind,
    isNativeIndentedPlain,
    type RichLine,
} from './device-text-richtext'
import { arrowRecordProps, restoreArrowLinks, unpackArrowProps } from './arrow-persistence'
import { textFromNode, eraseRichTextGlyphs, canonicalRichText } from './richtext-plain'
import {
    NATIVE_FONT_PRELOADS,
    canvasMeasure,
    layoutText,
    metricsFor,
    DEVICE_TEXT_LEFT_MARGIN_INK,
} from './text-metrics'
import { computeAnchorOffsets } from './text-anchor-layout'
import { parse as parseFont, type Font } from 'opentype.js'
import { adoptOrphanAuthor, cachedDocuments, ensureUniqueAuthorUuid, uuidv4 } from '../transport'
import { fetchDataUrl, seedAssetBytes } from '../authedAsset'
import { getPointsFromDrawSegments } from 'tldraw'
import { decodeRmPointData } from '@weft/rm-ink'
import { idb as storage } from '../idb'
import {
    clearReplicaInUse,
    primaryLockName,
    useReplica,
    markReplicaInUse,
    noteReplicaClosed,
    noteReplicaOpened,
} from '../replicaSweep'
import { linearizeRootText, bytesToUuidLE, paragraphStyleWriteExtra } from '@weft/rm-format'

const EMPTY_PHOTO_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
type AnchorOffset = { dx: number; dy: number }
const NO_ANCHOR: AnchorOffset = { dx: 0, dy: 0 }

function shapeAnchor(shape: TLShape): AnchorOffset {
    const { weftAnchorX, weftAnchorY } = shape.meta
    return {
        dx: typeof weftAnchorX === 'number' ? weftAnchorX : 0,
        dy: typeof weftAnchorY === 'number' ? weftAnchorY : 0,
    }
}

const STROKE_SIZES: Record<string, number> = { s: 2, m: 3.5, l: 5, xl: 10 }
// tldraw 5.6.1 implements this history check but omits it from its public types.
function isReplayingHistory(editor: Editor): boolean {
    return (editor as Editor & { isReplayingHistory(): boolean }).isReplayingHistory()
}

const FONT_SIZES: Record<string, number> = { s: 18, m: 24, l: 36, xl: 44 }
const SYNCABLE = new Set(['draw', 'geo', 'arrow', 'line', 'text', 'highlight', 'note'])

/** Overlay kind -> tldraw shape type (only 'draw-native' differs). */
function overlayShapeType(kind: OverlayShape['kind']): TLShape['type'] {
    return kind === 'draw-native' ? 'draw' : kind
}

export interface ControllerOptions {
    transport: Transport
    docId: string
    pageId: string
    clientId: string
    authorUuid: string
    fontUrl?: string
    onStatus?: (status: SyncStatus) => void
    onPageAvailable?: () => void
}

export interface PageGeometry {
    /** Writable page rect in tldraw page-space px (Paper Pro: ±810 ink). */
    x: number
    y: number
    w: number
    h: number
    /** Template rect: classic 1404 ink units centered, identity scale (E14). */
    tplX: number
    tplW: number
    /** Paper Pro centered-x convention. */
    centered: boolean
}

export interface PageMeta {
    docType: 'notebook' | 'pdf' | 'epub' | 'folder'
    template: string | null
    fileIndex: number | null
    pages: { id: string }[]
    /** PDF page rect in ink space (EVIDENCE E13). */
    zoom: {
        centerX: number
        pageWidth: number
        pageHeight: number
    } | null
}

/** EVIDENCE E17: ink units per PDF point (exact on Quran customZoom axes). */
export const PDF_INK_PER_PT = 227 / 72

function sameNativeLine(a: Line, b: Line): boolean {
    return a.tool === b.tool && a.color === b.color && a.thicknessScale === b.thicknessScale &&
        a.points.length === b.points.length && a.points.every((point, i) => {
            const other = b.points[i]!
            return Math.fround(point.x) === Math.fround(other.x) &&
                Math.fround(point.y) === Math.fround(other.y) &&
                point.width === other.width && point.pressure === other.pressure &&
                point.speed === other.speed && point.direction === other.direction
        })
}

const closingReplicas = new Map<string, Promise<void>>()

export class StudioController {
    private session!: OfflineSession
    private sessionOpening?: Promise<OfflineSession>
    private replicaMarkedInUse = false
    /** PDF page size in points, reported by pdf.js once the file loads. */
    pdfPtSize: { w: number; h: number } | null = null
    private editor!: Editor
    private font: Font | null = null
    pageMeta: PageMeta = {
        docType: 'notebook',
        template: null,
        fileIndex: null,
        pages: [],
        zoom: null,
    }
    /** tablet ink: itemRefKey -> tldraw shape id */
    private inkShapes = new Map<string, TLShapeId>()
    private debounce: ReturnType<typeof setTimeout> | null = null
    /** Font-not-ready flush retry (see flush). Cancelled on dispose so it
     *  never fires on a disposed controller. */
    private retryTimer: ReturnType<typeof setTimeout> | null = null
    /** null = the document's default (first) layer */
    private activeLayer: LayerRef | null = null
    /** UI subscription for layer list changes */
    onLayersChanged: (() => void) | null = null
    /** UI subscription for late-arriving page metadata (background doclist). */
    onMetaChanged: (() => void) | null = null
    private pendingShapeIds = new Set<string>()
    private readonly deferredOpacityRepaints = new Set<string>()
    private readonly pendingOpacityWrites = new Map<string, { opacity: number; opacityVersion: OpVersion }>()
    private pendingBrowserOrder = new Map<string, IndexKey>()
    private orderOnlyShapeIds = new Set<string>()
    private browserOrderTies = new Map<string, { accepted: IndexKey; displayed: IndexKey }>()
    private browserOrderNeedsRefresh = false
    private pendingImageMoves = new Set<TLShapeId>()
    private pendingDeletes = new Map<string, OpVersion>()
    private pendingShapeVersions = new Map<string, { stamp: OpVersion; revision?: string }>()
    private issuedShapeVersions = new Map<string, number>()
    /** Shapes this session flushed into the overlay. The reconcile delete rule
     *  removes a shape absent from the overlay only if it ever round-tripped
     *  (meta.weft stamp or this set); a stroke that never flushed is never wiped. */
    private projectedShapeIds = new Set<string>()
    /** Anchor offset (ink units) each rendered ink shape was placed with —
     *  renderInkItems shifts the shape by the DELTA when the text reflows. */
    private inkShapeOff = new Map<string, { dx: number; dy: number }>()
    /** Tablet-ink strokes the user moved/resized in the editor; flush bakes
     *  the transform into the doc (tombstone + re-add with moveId). */
    private pendingInkTransforms = new Map<string, TLDrawShape | null>()
    private disposed = false
    private flushing: Promise<void> | null = null
    private sceneRebuildPending = false
    private saveFailure: symbol | null = null
    private pendingCommands = new Set<Promise<void>>()
    private renderAfterRetry = new Set<() => void>()
    private deviceTextWork: Promise<void> | null = null
    private deviceTextDraft: unknown = undefined
    /** Editor store listener unsubscribe. The editor outlives the controller,
     *  so this must be removed on dispose or dead controllers keep reacting to
     *  the next page's edits. */
    private anchorHistoryUnsub: (() => void) | null = null
    private storeUnsub: (() => void) | null = null
    /** Releases this page's cross-tab cache-primary lock; null when another tab
     *  holds it or Web Locks is unavailable. */
    private readonly replicaUse = new AbortController()
    private pageLockRelease: (() => void) | null = null
    /** Unsubscribe for doc.list.changed (live template/meta refresh). */
    private photoOwner: string | null = null
    private assetUnsub: (() => void) | null = null
    private docListUnsub: (() => void) | null = null

    constructor(private readonly opts: ControllerOptions) {}

    /**
     * Cache-primary election: every tab edits (own author identity); the lock
     * only decides which session maintains the shared IndexedDB bootstrap cache
     * and adopts orphaned pending queues. Non-blocking: if another tab holds it,
     * queue a request so this session is promoted when that tab closes. Browsers
     * without Web Locks act as primary.
     */
    private async electCachePrimary(): Promise<boolean> {
        const locks = (globalThis.navigator as Navigator | undefined)?.locks
        if (!locks) return true
        const name = primaryLockName(`${this.opts.docId}/${this.opts.pageId}`)
        const immediate = await new Promise<boolean>((resolve) => {
            locks
                .request(name, { ifAvailable: true }, (lock) => {
                    if (!lock || this.disposed) {
                        resolve(false)
                        return
                    }
                    return new Promise<void>((release) => {
                        this.pageLockRelease = release
                        resolve(true)
                    })
                })
                .catch(() => resolve(true)) // a locks failure must never block
        })
        if (immediate || this.disposed) return immediate
        // queue for promotion when the current primary's tab goes away
        void locks
            .request(name, { signal: this.replicaUse.signal }, (lock) => {
                if (!lock) return
                return new Promise<void>((release) => {
                    if (this.disposed) {
                        release()
                        return
                    }
                    this.pageLockRelease = release
                    void this.session?.promoteToCachePrimary()
                })
            })
            .catch(() => {})
        return false
    }

    /** Fold a doclist into pageMeta (this doc's type, template, pdf index). */
    private adoptDocs(
        docs: Awaited<ReturnType<ControllerOptions['transport']['listDocuments']>>,
    ): void {
        try {
            const doc = docs.find((d) => d.id === this.opts.docId)
            const page = doc?.pages.find((p) => p.id === this.opts.pageId) as
                | { id: string; template?: string; fileIndex?: number }
                | undefined
            if (doc) {
                this.pageMeta = {
                    docType: doc.type,
                    template: page?.template ?? null,
                    fileIndex: page?.fileIndex ?? null,
                    pages: doc.pages,
                    zoom: doc.zoom ?? null,
                }
            }
        } catch {
            // metadata is best-effort
        }
    }

    private get replicaKey(): string {
        return `${this.opts.docId}/${this.opts.pageId}`
    }

    async start(editor: Editor): Promise<void> {
        const closing = closingReplicas.get(this.replicaKey)
        if (closing) await closing
        if (this.disposed) return
        const t0 = performance.now()
        const lap = (label: string) =>
            console.debug(`weft:open ${label} +${(performance.now() - t0).toFixed(0)}ms`)
        // boot time before the editor started, measured from the route's nav
        // mark when present (raw performance.now() is time since the tab opened).
        const navAt = (window as unknown as { __weftNavAt?: number }).__weftNavAt
        console.debug(
            `weft:open start@ ${(navAt !== undefined ? t0 - navAt : t0).toFixed(0)}ms after nav`,
        )
        this.editor = editor
        this.photoOwner = libraryCacheScope()
        // Device + document metadata (geometry convention, template, pdf index).
        // Not awaited: the session opens from the local replica and needs no
        // network. The cached doclist is adopted synchronously (template/pdf rect
        // right from the first frame); the fresh fetch lands in the background.
        this.adoptDocs(readCachedDocumentList() ?? [])
        lap('meta-cache')
        const loadDocs = () => {
            void cachedDocuments(this.opts.transport).then((docs) => {
                if (this.disposed) return
                this.adoptDocs(docs)
                if (this.session) this.onMetaChanged?.()
                lap('doclist (background)')
            }).catch(() => {})
        }
        void this.opts.transport.health().then(() => {
            if (this.disposed) return
            if (this.session) this.onMetaChanged?.()
        }).catch(() => {})
        loadDocs()
        // Template and page metadata follow the tablet's doc-list events.
        const sub = this.opts.transport as { subscribeDocList?: (h: () => void) => () => void }
        this.docListUnsub = sub.subscribeDocList?.(loadDocs) ?? null
        const assets = this.opts.transport as {
            subscribePageAssets?: (handler: (event?: { doc: string; page: string; file: string }) => void) => () => void
        }
        this.assetUnsub = assets.subscribePageAssets?.((event) => {
            if (this.disposed || (event && (event.doc !== this.opts.docId || event.page !== this.opts.pageId))) return
            for (const [id, file] of this.nativeImageFiles) {
                if (!event || event.file === file) this.loadNativeImage(id, file, true)
            }
        }) ?? null
        // mark in-use synchronously so a concurrent app-start sweep can never
        // delete the replica we are about to open
        try {
            await useReplica(`${this.opts.docId}/${this.opts.pageId}`, this.replicaUse.signal)
        } catch (error) {
            if (this.disposed) return
            throw error
        }
        if (this.disposed) return
        markReplicaInUse(this.opts.docId, this.opts.pageId)
        this.replicaMarkedInUse = true
        // recency bookkeeping, off the open path: replica-sweep LRU index, and
        // the cloud web-open record (flows into the tablet's lastOpened).
        void noteReplicaOpened(this.opts.docId, this.opts.pageId)
        void this.recordWebOpen()
        // per-tab author (a duplicated tab mints a fresh identity) + cache-
        // primary election
        const [author, cachePrimary] = await Promise.all([
            ensureUniqueAuthorUuid(),
            this.electCachePrimary(),
        ])
        if (this.disposed) return
        const primaryAtOpen = cachePrimary || this.pageLockRelease !== null
        this.sessionOpening = OfflineSession.open(
            storage,
            this.opts.transport,
            this.opts.docId,
            this.opts.pageId,
            {
                clientId: this.opts.clientId,
                authorUuid: author,
                // history timeline label; CRDT identity stays authorUuid
                historyAuthor: 'web',
                cachePrimary: primaryAtOpen,
                adoptOrphanAuthor,
                onPatch: (patch) => this.onPatches([patch]),
                onPatchBatch: (patches) => this.onPatches(patches),
                onStatus: (status) => { if (!this.disposed) this.opts.onStatus?.(status) },
                onPageAvailable: () => {
                    if (this.disposed) return
                    this.opts.onPageAvailable?.()
                    // The projection font is for future text edits. A cold
                    // drawing takes the network ahead of this warm-up.
                    void this.ensureFont()
                },
            },
        )
        this.session = await this.sessionOpening
        lap('session-open')
        // A closing controller already waits for this session and drains it.
        if (this.disposed) return
        if (!primaryAtOpen && this.pageLockRelease) void this.session.promoteToCachePrimary()
        this.registerImageDrop()
        this.renderInitial()
        lap('render')
        // first render measured wraps before the RM webfonts were resident;
        // re-settle device-text layout once they load (no-op if cached)
        void this.settleDeviceFonts()
        this.anchorHistoryUnsub = this.editor.sideEffects.registerBeforeChangeHandler(
            'shape', (previous, next, source) => {
                if (source !== 'user' || !isReplayingHistory(this.editor) || !previous.meta.rmBrush) return next
                const from = shapeAnchor(next)
                const to = shapeAnchor(previous)
                const staleGeometry = previous.meta.weftNativeGeometry !== next.meta.weftNativeGeometry
                const anchorChanged = from.dx !== to.dx || from.dy !== to.dy
                const imageSourceChanged = previous.type === 'image' && next.type === 'image' &&
                    (previous.props.assetId !== next.props.assetId ||
                        previous.meta.weftNativeImageUuid !== next.meta.weftNativeImageUuid)
                if (!staleGeometry && next.meta.rmBrush !== previous.meta.rmBrush) return next
                if (!staleGeometry && !anchorChanged && !imageSourceChanged) return next
                if (![...this.inkShapes.values()].includes(next.id)) return next
                // SDK history replays captured records. A tablet source change
                // invalidates the old geometry, but local properties like a
                // lock can still be undone.
                if (staleGeometry) return this.retainNativeGeometry(previous, next)
                const updated = anchorChanged ? { ...next, ...this.shiftForAnchor(next, from, to) } : next
                if (imageSourceChanged && previous.type === 'image' && updated.type === 'image') {
                    return {
                        ...updated,
                        props: { ...updated.props, assetId: previous.props.assetId },
                        meta: { ...updated.meta, weftNativeImageUuid: previous.meta.weftNativeImageUuid },
                    }
                }
                return updated
            },
        )
        this.storeUnsub = this.editor.store.listen(
            ({ changes }) => {
                for (const record of Object.values(changes.added)) {
                    this.noteChange(record as TLShape)
                    if (record.typeName === 'binding' && record.type === 'arrow') this.queueArrow(record.fromId)
                }
                for (const [before, after] of Object.values(changes.updated)) {
                    if (before.typeName === 'shape' && after.typeName === 'shape' && after.meta.rmBrush &&
                        before.parentId !== after.parentId && sameNativeShapeGeometry(before, after)) {
                        const previous = previousPageTransform(before, id => {
                            const record = changes.updated[id]?.[0] ?? changes.removed[id]
                            if (record?.typeName === 'shape') return record
                            if (!changes.added[id]) return this.editor.getShape(id)
                        })
                        if (previous && samePageTransform(previous, this.editor.getShapePageTransform(after))) continue
                    }
                    this.noteChange(after as TLShape, before as TLShape)
                    if (after.typeName === 'binding' && after.type === 'arrow') this.queueArrow(after.fromId)
                    if (after.typeName === 'shape') {
                        for (const binding of this.editor.getBindingsToShape(after.id, 'arrow')) {
                            this.queueArrow(binding.fromId)
                        }
                    }
                }
                for (const record of Object.values(changes.removed)) {
                    const shape = record as TLShape
                    if (record.typeName === 'binding' && record.type === 'arrow') this.queueArrow(record.fromId)
                    if (shape.typeName === 'shape') this.pendingDeletes.set(shape.id, this.shapeEditVersion(shape.id))
                }
                this.schedule()
            },
            { scope: 'document', source: 'user' },
        )
    }

    /** Run engine-driven editor mutations as remote-sourced store changes.
     *  The store delivers listener events on the next frame, so a re-entrancy
     *  boolean is unsound (reset before delivery, every programmatic write
     *  leaks into the source:'user' listener as a fake local edit). Source is
     *  recorded at write time, so this holds regardless of delivery timing. */
    private remote(fn: () => void): void {
        this.editor.store.mergeRemoteChanges(fn)
    }

    /** Item keys rendered by attached overlay shapes. A detached shape no
     *  longer owns its ink: surviving device strokes render as raw ink, and
     *  re-attach reclaims them via pruneInkShapes. */
    private ownedItemKeys(): Set<string> {
        const owned = new Set<string>()
        for (const s of this.session.currentOverlay.shapes) {
            if (s.state === 'detached' || !this.canRenderOverlayShape(s)) continue
            for (const part of s.rendered) for (const i of part.items) owned.add(itemRefKey(i))
        }
        return owned
    }

    /** Drop loose-ink tldraw shapes whose doc items are now dead or owned by
     *  an attached shape (own writes emit no patches to do it). */
    private pruneInkShapes(): void {
        const doc = this.session.document
        const resolver = new RefResolver(doc)
        const owned = this.ownedItemKeys()
        const loose = new Set<string>()
        for (const [itemId, item] of doc.tree().walk()) {
            if (item.kind !== 'line' && item.kind !== 'image') continue
            const ref = resolver.toRef(itemId)
            if (!ref) continue
            const key = itemRefKey(ref)
            if (!owned.has(key)) loose.add(key)
        }
        const toDelete: TLShapeId[] = []
        for (const [key, id] of this.inkShapes) {
            if (!loose.has(key) && !this.pendingImageMoves.has(id)) {
                toDelete.push(id)
                this.dropInkBinding(key)
            }
        }
        if (toDelete.length) this.editor.deleteShapes(toDelete)
    }

    /** Font loading retries on demand: a single failed fetch must not stop
     *  text from ever syncing this session. */
    private fontLoad: Promise<Font | null> | null = null
    private async ensureFont(): Promise<Font | null> {
        if (this.font) return this.font
        if (!this.opts.fontUrl) return null
        this.fontLoad ??= (async () => {
            try {
                const buf = await (await fetch(this.opts.fontUrl!)).arrayBuffer()
                this.font = parseFont(buf)
                return this.font
            } catch {
                this.fontLoad = null // transient failure: retry next flush
                return null
            }
        })()
        return this.fontLoad
    }

    /** Detached-shape resolution: re-render from props (text stays text). */
    async reattachShape(shapeId: string): Promise<void> {
        if (this.disposed) return
        const shape = this.editor.getShape(shapeId as TLShapeId)
        if (!shape) return
        if (!this.font && needsProjectionFont(shape)) {
            if (!(await this.ensureFont()) || this.disposed || this.editor.getShape(shape.id) !== shape) return
        }
        const opacity = this.storedOpacity(shapeId)
        const op = this.projectShape(shape)
        if (!op) return
        await this.trackCommand(this.applyLocal([op], () => this.remote(() => {
            this.editor.updateShape({
                id: shape.id,
                type: shape.type,
                opacity,
                meta: { ...shape.meta, detached: false },
            })
            // re-projection replaced the surviving device strokes; their
            // loose-ink shapes (rendered while detached) must not linger
            this.pruneInkShapes()
        })))
    }

    /** Detached-shape resolution: keep the surviving tablet ink, drop the
     *  semantic shape (it becomes plain ink owned by the page). */
    async releaseShape(shapeId: string): Promise<void> {
        if (this.disposed) return
        await this.trackCommand(this.applyLocal([{ type: 'release-shape', shapeId, version: this.shapeEditVersion(shapeId) }], () => {
            const shape = this.editor.getShape(shapeId as TLShapeId)
            this.remote(() => {
                if (shape) this.editor.deleteShapes([shape.id])
                this.renderInkItems(this.ownedItemKeys())
                this.applyLayerVisibility()
            })
        }))
    }

    dispose(): void {
        if (this.disposed) return
        this.disposed = true
        this.renderAfterRetry.clear()
        // editor is shared and persistent: drop the store listener so a
        // switched-away controller stops reacting to the next page's edits
        this.anchorHistoryUnsub?.()
        this.anchorHistoryUnsub = null
        this.storeUnsub?.()
        this.storeUnsub = null
        this.assetUnsub?.()
        for (const loading of this.loadingNativeImages.values()) loading.abort()
        this.docListUnsub?.()
        this.docListUnsub = null
        this.onMetaChanged = null
        this.onLayersChanged = null
        if (this.debounce) clearTimeout(this.debounce)
        if (this.retryTimer) clearTimeout(this.retryTimer)
        const opening = this.sessionOpening
        const release = () => {
            this.pageLockRelease?.()
            this.pageLockRelease = null
            this.replicaUse.abort()
            if (this.replicaMarkedInUse) {
                clearReplicaInUse(this.opts.docId, this.opts.pageId)
                void noteReplicaClosed(this.opts.docId, this.opts.pageId)
            }
        }
        const localWrites = this.session?.disposeAndDrainLocalWrites() ??
            opening?.then(session => session.disposeAndDrainLocalWrites(), () => {})
        if (!localWrites) {
            release()
            return
        }
        const closing = localWrites.finally(() => {
            release()
            if (closingReplicas.get(this.replicaKey) === closing) closingReplicas.delete(this.replicaKey)
        })
        closingReplicas.set(this.replicaKey, closing)
    }

    /** The page's native reMarkable v6 (.rm) bytes: the live view (tablet ink
     *  plus local edits projected to ink), round-trippable onto a device.
     *  Null before the session has opened. */
    exportRmBytes(): Uint8Array | null {
        if (!this.session) return null
        return this.session.document.serialize()
    }

    private readonly overlayPropsChecks = new Map<TLShape['type'], (props: object) => boolean>()

    private canRenderOverlayShape(shape: OverlayShape): boolean {
        const type = overlayShapeType(shape.kind) as TLShape['type']
        if (typeof shape.shapeId !== 'string' || !isShapeId(shape.shapeId) ||
            shape.shapeId === 'shape:device-text' || !this.editor.hasShapeUtil(type) ||
            ![shape.x, shape.y, shape.rotation].every(Number.isFinite) ||
            !shape.props || typeof shape.props !== 'object' || Array.isArray(shape.props)) return false
        let check = this.overlayPropsChecks.get(type)
        if (!check) {
            const util = this.editor.getShapeUtil(type)
            const schema = (util.constructor as typeof ShapeUtil).props
            const validator = schema && T.object(schema)
            const defaults = util.getDefaultProps()
            // Accepted props are immutable and can be large drawing arrays.
            // Reuse validation while unrelated ink changes or the canvas repaints.
            const checked = new WeakMap<object, boolean>()
            check = props => {
                const previous = checked.get(props)
                if (previous !== undefined) return previous
                const valid = validator?.isValid({ ...defaults, ...props }) ?? true
                checked.set(props, valid)
                return valid
            }
            this.overlayPropsChecks.set(type, check)
        }
        return check(type === 'arrow' ? unpackArrowProps(shape.props).props : shape.props)
    }

    get hasUnreadableShapes(): boolean {
        return this.session?.currentOverlay.shapes.some(shape => !this.canRenderOverlayShape(shape)) ?? false
    }

    exportUnreadableShapes(): Uint8Array | null {
        const shapes = this.session?.currentOverlay.shapes.filter(shape => !this.canRenderOverlayShape(shape))
        return shapes?.length ? new TextEncoder().encode(JSON.stringify({ shapes })) : null
    }

    /** Fire-and-forget open ping. Offline/errors are fine: recency is an
     *  optimization, and the next online open records itself. */
    private async recordWebOpen(): Promise<void> {
        try {
            const { apiBase } = await import('../settings')
            const { authHeaders } = await import('../authedAsset')
            await fetch(`${apiBase()}/api/documents/${this.opts.docId}/open`, {
                method: 'POST',
                headers: { ...(await authHeaders()), 'content-type': 'application/json' },
                body: JSON.stringify({ page: this.opts.pageId }),
            })
        } catch {
            // best-effort
        }
    }

    /**
     * Page rect derived from actual ink + device convention. Paper Pro pages
     * use centered x (±810 in RM units) and grow downward without bound.
     */
    getPageGeometry(): PageGeometry {
        let minX = Infinity
        let maxY = -Infinity
        // text-anchored ink renders at (x + anchorX, y + anchor line Y); extents
        // must use the rendered positions or the centered latch reads the wrong
        // minX and the page bottom lands mid-drawing
        const anchorOff = this.anchorOffsetByItem()
        for (const block of this.session.document.blocks) {
            if (block.type === 'sceneLineItem' && block.deletedLength === 0 && block.line) {
                const off = anchorOff.get(crdtIdKey(block.itemId))
                const dx = off?.dx ?? 0
                const dy = off?.dy ?? 0
                for (const p of block.line.points) {
                    if (p.x + dx < minX) minX = p.x + dx
                    if (p.y + dy > maxY) maxY = p.y + dy
                }
            } else if (
                block.type === 'sceneImageItem' &&
                block.deletedLength === 0 &&
                block.image
            ) {
                // an image near the bottom must grow the page like ink.
                // Quad = 4 corners x (x,y,u,v).
                const off = anchorOff.get(crdtIdKey(block.itemId))
                const dx = off?.dx ?? 0
                const dy = off?.dy ?? 0
                const v = block.image.vertices
                for (let i = 0; i + 1 < v.length && i < 16; i += 4) {
                    if (v[i]! + dx < minX) minX = v[i]! + dx
                    if (v[i + 1]! + dy > maxY) maxY = v[i + 1]! + dy
                }
            }
        }
        // the typed-text column's bottom is content too: a long text page with
        // little ink must still grow past its last line. Cached per doc
        // reference: this runs on a 2s poll, and a full canvas layout per
        // tick stalls pointer interactions on text-heavy pages.
        try {
            const cacheKey = `${this.session.viewKey}|f${this.layoutGen}`
            if (this.textBottomCache?.key !== cacheKey) {
                const text = this.session.document.tree().rootText
                let bottom = -Infinity
                if (text) {
                    const paragraphs = linearizeRootText(text)
                    const layout = layoutText(paragraphs, text.width, canvasMeasure())
                    bottom = text.posY + layout.bottomInk
                }
                this.textBottomCache = { key: cacheKey, bottom }
            }
            if (this.textBottomCache.bottom > maxY) maxY = this.textBottomCache.bottom
        } catch {
            // no DOM (tests) or layout failure: ink/image extents stand alone
        }
        if (this.pageMeta.docType === 'pdf' || this.pageMeta.docType === 'epub') {
            // PDF page rect in ink units is MediaBox * 227/72, horizontally
            // centered, top at y=0. (customZoom* fields are viewport state,
            // placeholder defaults on bestFit docs.)
            const s = RM_SCALE
            const zoom = this.pageMeta.zoom
            const wInk = this.pdfPtSize
                ? this.pdfPtSize.w * PDF_INK_PER_PT
                : (zoom?.pageWidth ?? 1404)
            const hPage = this.pdfPtSize
                ? this.pdfPtSize.h * PDF_INK_PER_PT
                : (zoom?.pageHeight ?? 1872)
            const hRm = Math.max(hPage, Number.isFinite(maxY) ? maxY + 60 : 0)
            const w = wInk * s
            const x = (-wInk / 2) * s
            return { x, y: 0, w, h: hRm * s, tplX: x, tplW: w, centered: true }
        }
        // Measured: live Paper Pro ink reaches x -1108..+1090, so the panel is
        // ~2216 ink units wide (±1108). Template design space stays 1404
        // centered; patterns tile outward into the margins.
        //
        // `centered` must be known before ink arrives or the page flips sideways
        // mid-open. Sources, in order: (1) ink when present (authoritative,
        // cached per page); (2) the cached verdict; (3) the device model, but in
        // cloud mode /api/health reports 'model: cloud' not the tablet, so
        // default centered there (every Paper Pro page is; a legacy page
        // corrects once). Typed text is left-anchored at posX (device default
        // -468, deep in centered space), just as authoritative as ink: folding
        // it in stops a text-only-or-right-of-center page being misjudged as a
        // legacy 1404 page. A finite minX also overwrites a stale cached '0'.
        const rootTextPosX = this.session.document.tree().rootText?.posX
        if (rootTextPosX !== undefined && rootTextPosX < minX) minX = rootTextPosX
        const cacheKey = `weft-centered:${this.opts.docId}/${this.opts.pageId}`
        let centered: boolean
        if (Number.isFinite(minX)) {
            centered = minX < -50
            try {
                localStorage.setItem(cacheKey, centered ? '1' : '0')
            } catch {
                /* storage full/blocked: cache is best-effort */
            }
        } else {
            let cached: string | null = null
            try {
                cached = localStorage.getItem(cacheKey)
            } catch {
                /* ignore */
            }
            centered = cached !== null ? cached === '1' : true
        }
        const wRm = centered ? 2216 : 1404
        // Pages scroll indefinitely on-device, but the box must end somewhere
        // visible: one nominal screen minimum, modest room below the last
        // stroke; growth keeps extending it.
        const hRm = Math.max(2954, Number.isFinite(maxY) ? maxY + 400 : 0)
        const s = RM_SCALE
        const x = centered ? (-wRm / 2) * s : 0
        return {
            x,
            y: 0,
            w: wRm * s,
            h: hRm * s,
            tplX: x,
            tplW: wRm * s,
            centered,
        }
    }

    // ----- initial render -----

    private renderInitial(): void {
        this.remote(() => this.renderSceneShapes())
    }

    /** Device-text wrap points are measured with canvas measureText, which
     *  substitutes a fallback face until the bundled webfonts load, so the
     *  first render after a cold open can wrap/size against wrong metrics. Await
     *  the fonts once and re-render. No-op when fonts are cached, there is no
     *  device text, or there is no FontFaceSet (tests). */
    private async settleDeviceFonts(): Promise<void> {
        if (typeof document === 'undefined' || !document.fonts) return
        // the px size is irrelevant to WHICH face loads; use a nominal one
        const specs = NATIVE_FONT_PRELOADS
        if (specs.every((s) => document.fonts.check(s))) return // already correct
        const loaded = await Promise.allSettled(specs.map((s) => document.fonts.load(s)))
        if (loaded.every((r) => r.status === 'rejected')) return
        // A missing optional face must not suppress reflow for the ones that did load.
        if (this.disposed || !this.session) return
        if (!this.session.document.tree().rootText) return // nothing to re-lay out
        this.layoutGen++
        this.requestSceneRebuild()
    }

    private requestSceneRebuild(): void {
        this.sceneRebuildPending = true
        if (!this.rebuildSceneWhenIdle()) this.syncDeviceTextShape()
    }

    private rebuildSceneWhenIdle(): boolean {
        if (!this.sceneRebuildPending || this.disposed || this.flushing || this.saveFailure) return false
        // The SDK hasn't necessarily delivered changes made in this frame.
        // Drain its listeners now, and don't yield between this check and the
        // wipe: moves/deletes still need their original native ink bindings.
        this.editor.store._flushHistory()
        if (this.hasQueuedShapeEdits) return false
        this.sceneRebuildPending = false
        this.refreshTextLayout()
        this.syncDeviceTextShape()
        return true
    }

    private refreshTextLayout(): void {
        this.remote(() => this.renderInkItems(this.ownedItemKeys()))
        this.applyLayerVisibility()
    }

    private hideUnreadableShapes(ids: TLShapeId[]): void {
        if (!ids.length) return
        // An old projection can be locked. It must leave the view before
        // painting its raw tablet ink, regardless of local edit permissions.
        this.editor.run(() => this.editor.deleteShapes(ids), { ignoreShapeLock: true, history: 'ignore' })
    }

    /** Adopt new session state (snapshot supersede / re-bootstrap) in place:
     *  update existing shapes, delete only what left the doc. Avoids the
     *  clear-all + full rebuild that flashed the whole canvas on every device
     *  echo (device-text pages snapshot on each tablet save). renderSceneShapes
     *  creates new/changed shapes; at first open the editor is empty so this is
     *  a full create. */
    private reconcileToSessionState(): void {
        const overlay = this.session.currentOverlay
        const unreadable = new Set(overlay.shapes.filter(s => !this.canRenderOverlayShape(s)).map(s => s.shapeId))
        const wantOverlay = new Set(overlay.shapes.filter(s => !unreadable.has(s.shapeId)).map(s => s.shapeId))
        const excluded = this.ownedItemKeys()
        const doc = this.session.document
        const resolver = new RefResolver(doc)
        const wantInk = new Set<string>()
        for (const [itemId, item] of doc.tree().walk()) {
            if (item.kind !== 'line' && item.kind !== 'image') continue
            const ref = resolver.toRef(itemId)
            if (!ref) continue
            const key = itemRefKey(ref)
            if (!excluded.has(key)) wantInk.add(key)
        }
        // reverse map: editor shape id -> its ink item key (for stale-ink checks)
        const inkIdToKey = new Map<string, string>()
        for (const [key, id] of this.inkShapes) inkIdToKey.set(id, key)
        const toDelete: TLShapeId[] = []
        const toHide: TLShapeId[] = []
        for (const s of this.editor.getCurrentPageShapes()) {
            // an un-flushed local edit lives only in the editor until its
            // debounce projects it: never wipe it. The device-text shape is
            // owned by syncDeviceTextShape, not here.
            if (this.hasUnprojectedShape(s.id) || s.id === ('shape:device-text' as TLShapeId)) continue
            const inkKey = inkIdToKey.get(s.id)
            if (inkKey !== undefined) {
                // tablet ink whose item left the doc (erase / re-key), except an
                // rm-image being moved/resized now: the device re-keying its item
                // must not delete the shape under the drag (flush's
                // remapImageIdentities rebinds by asset uuid).
                if (!wantInk.has(inkKey) && !this.pendingImageMoves.has(s.id)) toDelete.push(s.id)
                continue
            }
            // a stroke being drawn now is neither pending (enqueues on
            // isComplete) nor in the overlay; deleting it chops the stroke
            // under the pen (echoes land every 1-2s while drawing).
            if (
                (s.type === 'draw' || s.type === 'highlight') &&
                !(s as TLDrawShape).props.isComplete
            )
                continue
            // any other editor shape is an overlay object (incl. one the user
            // drew: tldraw mints those with no meta.weft, weft adopts by id and
            // stamps meta.weft on the first echo). Deleted only if it ever
            // round-tripped (meta.weft, flush record, or tombstone); work that
            // never flushed is not wiped by an echo.
            if (!wantOverlay.has(s.id)) {
                const adopted =
                    (s.meta as { weft?: boolean })?.weft === true ||
                    this.projectedShapeIds.has(s.id)
                if (!adopted && !overlay.tombstones?.[s.id]) continue
                if (unreadable.has(s.id)) toHide.push(s.id)
                else toDelete.push(s.id)
            }
        }
        // keep inkShapes consistent with the new doc for renderInkItems' has()
        // (spare a mid-move rm-image's binding for the same reason as above)
        for (const [key, id] of [...this.inkShapes]) {
            if (!wantInk.has(key) && !this.pendingImageMoves.has(id)) this.dropInkBinding(key)
        }
        this.remote(() => {
            if (toDelete.length) this.editor.deleteShapes(toDelete)
            this.hideUnreadableShapes(toHide)
            this.renderSceneShapes()
        })
    }

    /** Create the ink + overlay shapes for the current session state. Caller
     *  owns the remote() wrapper (so it composes inside onPatch). */
    private renderSceneShapes(): void {
        const _t = performance.now()
        const _lap = (l: string) =>
            console.debug(`weft:render ${l} +${(performance.now() - _t).toFixed(0)}ms`)
        const overlay = this.session.currentOverlay
        _lap('buildView')
        // 1. tablet ink (items owned by no attached shape)
        this.renderInkItems(this.ownedItemKeys())
        _lap('ink-shapes')
        // 2. overlay shapes restored as native tldraw shapes (text stays text).
        //    A shape with an un-flushed local edit is SKIPPED: the rebuild
        //    preserved it in the editor, and overwriting it with session state
        //    would clobber the pending edit before the debounce projects it.
        const defs = overlay.shapes
            .filter(shape => this.canRenderOverlayShape(shape) && !this.deferOpacityWhilePending(shape.shapeId))
            .map((shape) => ({
                id: shape.shapeId as TLShapeId,
                type: overlayShapeType(shape.kind),
                x: shape.x,
                y: shape.y,
                rotation: shape.rotation,
                index: this.displayIndex(shape),
                props: browserOverlayProps(shape) as never,
                opacity: displayOpacity(shape),
                meta: { weft: true, detached: shape.state === 'detached' },
            }))
        const toCreate = defs.filter((d) => !this.editor.getShape(d.id))
        // Skip no-op updates: every device echo re-renders the scene, and
        // updateShapes with identical values still mints new records (fresh
        // props identity), churning the store + React on every round-trip.
        // renderRevision is the hash of exactly what defs carry (props +
        // page transform), so equality means the live shape already matches.
        const revByShape = new Map(overlay.shapes.map((s) => [s.shapeId, s.renderRevision]))
        const toUpdate = defs.filter((d) => {
            const live = this.editor.getShape(d.id)
            if (!live) return false
            if (live.opacity !== d.opacity || (d.index !== undefined && live.index !== d.index)) return true
            if ((live.meta as { weft?: boolean; detached?: boolean })?.weft !== true) return true
            if ((live.meta as { detached?: boolean })?.detached !== d.meta.detached) return true
            return hashOf(live, this.editor) !== revByShape.get(d.id)
        })
        if (toCreate.length) this.editor.createShapes(toCreate as never[])
        if (toUpdate.length) this.editor.updateShapes(toUpdate as never[])
        this.restoreOverlayArrowLinks()
        this.applyBrowserOrderTies()
        // Re-apply per-layer visibility on every render: the scene walk yields
        // hidden-layer items too, so without this a hidden layer renders VISIBLE
        // on open / re-bootstrap / editRootText. Idempotent (reads the doc).
        this.applyLayerVisibility()
    }

    private restoreOverlayArrowLinks(): void {
        for (const shape of this.session.currentOverlay.shapes) {
            const id = shape.shapeId as TLShapeId
            if (shape.kind === 'arrow' && shape.state === 'live' && !this.hasUnprojectedShape(id) &&
                shape.props && typeof shape.props === 'object') {
                restoreArrowLinks(this.editor, id, shape.props)
            }
        }
    }

    private displayIndex(shape: OverlayShape): IndexKey | undefined {
        const index = shape.browserIndex
        if (typeof index !== 'string' || !T.indexKey.isValid(index)) return
        const live = this.editor.getShape(shape.shapeId as TLShapeId)
        if (live && !isPageId(live.parentId)) return
        const tie = this.browserOrderTies.get(shape.shapeId)
        return tie?.accepted === index ? tie.displayed : index
    }

    private collectSplitBrowserTies(ops: LocalOp[]): void {
        if (!this.browserOrderTies.size) return
        const orderWrites = new Map<string, string>()
        for (const op of ops) {
            if (op.type === 'set-browser-index') orderWrites.set(op.shapeId, op.index)
            else if (op.type === 'upsert-shape' && op.shape.browserIndex !== undefined) {
                orderWrites.set(op.shape.shapeId, op.shape.browserIndex)
            }
        }
        if (!orderWrites.size) return
        const indices = [...orderWrites.values()]
        const persisted = new Map(this.session.currentOverlay.shapes.map(shape => [shape.shapeId, shape]))
        for (const [shapeId, { accepted, displayed }] of this.browserOrderTies) {
            if (orderWrites.has(shapeId) || this.pendingBrowserOrder.has(shapeId) ||
                !indices.some(index => index > accepted && index < displayed)) continue
            const stored = persisted.get(shapeId)
            const live = this.editor.getShape(shapeId as TLShapeId)
            if (stored?.browserIndex !== accepted || !live || live.index !== displayed || !isPageId(live.parentId)) continue
            const version = this.browserOrderVersion(stored)
            if (version) ops.push({ type: 'set-browser-index', shapeId, from: accepted, index: displayed, version })
        }
    }

    /** SDK keys can coincide on concurrent writers. Resolve only the display
     * keys, with a stable tie-break and without changing native records. */
    private applyBrowserOrderTies(): void {
        this.browserOrderNeedsRefresh = this.pendingShapeIds.size > 0 || this.pendingDeletes.size > 0
        const keys = new Map<IndexKey, TLShape[]>()
        const bounds = new Set<IndexKey>()
        const acceptedIds = new Set<string>()
        const retained = new Map<string, { accepted: IndexKey; displayed: IndexKey }>()
        const pendingSlots = [...this.pendingBrowserOrder.values()]
        let differs = false
        for (const { shapeId, browserIndex } of this.session.currentOverlay.shapes) {
            if (this.pendingShapeIds.has(shapeId) || this.pendingDeletes.has(shapeId)) {
                const tie = this.browserOrderTies.get(shapeId)
                if (tie) retained.set(shapeId, tie)
                continue
            }
            if (typeof browserIndex !== 'string' || !T.indexKey.isValid(browserIndex)) continue
            const shape = this.editor.getShape(shapeId as TLShapeId)
            if (!shape || !isPageId(shape.parentId)) continue
            differs ||= shape.index !== browserIndex
            const tie = this.browserOrderTies.get(shapeId)
            // An unflushed insertion already uses this display gap. Keep it
            // until the local batch can persist the crossed sibling's slot.
            if (tie?.accepted === browserIndex && shape.index === tie.displayed &&
                pendingSlots.some(index => index > browserIndex && index < tie.displayed)) {
                retained.set(shapeId, tie)
                continue
            }
            acceptedIds.add(shapeId)
            const group = keys.get(browserIndex)
            if (group) group.push(shape)
            else keys.set(browserIndex, [shape])
            bounds.add(browserIndex)
        }
        if (!this.browserOrderTies.size && !differs && keys.size === acceptedIds.size) return
        for (const shape of this.editor.getCurrentPageShapes()) {
            if (isPageId(shape.parentId) && !acceptedIds.has(shape.id)) bounds.add(shape.index)
        }
        const sortedBounds = [...bounds].sort()
        const updates: { id: TLShapeId; type: TLShape['type']; index: IndexKey }[] = []
        for (const [position, accepted] of sortedBounds.entries()) {
            const group = keys.get(accepted)
            if (!group) continue
            if (group.length === 1) {
                const shape = group[0]!
                if (shape.index !== accepted) updates.push({ id: shape.id, type: shape.type, index: accepted })
                continue
            }
            group.sort((left, right) => left.id < right.id ? -1 : 1)
            const upper = sortedBounds[position + 1] ?? null
            let lower = accepted
            const previous = group.slice(1).map(shape => this.browserOrderTies.get(shape.id))
            const reusable = previous.every(tie => {
                if (!tie || tie.accepted !== accepted || tie.displayed <= lower ||
                    (upper !== null && tie.displayed >= upper)) return false
                lower = tie.displayed
                return true
            })
            const indices = [accepted, ...(reusable ? previous.map(tie => tie!.displayed) :
                getIndicesBetween(accepted, upper, group.length - 1))]
            for (const [index, shape] of group.entries()) {
                const displayed = indices[index]!
                if (shape.index !== displayed) updates.push({ id: shape.id, type: shape.type, index: displayed })
                if (displayed !== accepted) retained.set(shape.id, { accepted, displayed })
            }
        }
        this.browserOrderTies = retained
        if (updates.length) this.editor.run(() => this.editor.updateShapes(updates), {
            history: 'ignore', ignoreShapeLock: true,
        })
    }

    /**
     * (dx, dy) in ink units per ITEM id for text-anchored groups: xochitl
     * positions those groups relative to the anchor POINT (the text line's
     * laid-out position), so their children must shift by it or the page
     * renders scrambled (Mako p1). Read-side only: erases are id-keyed and
     * tablet ink is never move-projected, so raw stored coordinates are
     * untouched on write.
     */
    private anchorOffCache: { key: string; map: Map<string, { dx: number; dy: number }> } | null =
        null
    private textBottomCache: { key: string; bottom: number } | null = null
    /** Bumped when the text layout environment changes (device fonts settle),
     *  so view-keyed caches recompute with the real metrics. */
    private layoutGen = 0
    private pendingAnchorReflow = false

    private anchorOffsetByItem(): Map<string, { dx: number; dy: number }> {
        const cacheKey = `${this.session.viewKey}|f${this.layoutGen}`
        const cached = this.anchorOffCache
        if (cached && cached.key === cacheKey) return cached.map
        const out = new Map<string, { dx: number; dy: number }>()
        const doc = this.session.document
        let groupOff: Map<string, { dx: number; dy: number }>
        try {
            groupOff = computeAnchorOffsets(doc)
        } catch {
            return cached?.map ?? out // keep the last measured layout on a transient failure
        }
        if (groupOff.size === 0) {
            this.anchorOffCache = { key: cacheKey, map: out }
            return out
        }
        for (const block of doc.blocks) {
            if (
                block.type !== 'sceneLineItem' &&
                block.type !== 'sceneImageItem' &&
                block.type !== 'sceneGlyphItem'
            )
                continue
            const off = groupOff.get(crdtIdKey(block.parentId))
            if (off !== undefined) out.set(crdtIdKey(block.itemId), off)
        }
        this.anchorOffCache = { key: cacheKey, map: out }
        return out
    }

    private readonly inkLineSources = new Map<string, Line>()
    private readonly inkImageQuads = new Map<string, readonly number[]>()

    private dropInkBinding(key: string): void {
        this.inkShapes.delete(key)
        this.inkShapeOff.delete(key)
        this.inkLineSources.delete(key)
        this.inkImageQuads.delete(key)
    }

    private retainNativeGeometry(previous: TLShape, next: TLShape): TLShape {
        const { x, y, rotation, parentId } = previous
        const { rmBrush, weftAnchorX, weftAnchorY, weftNativeGeometry } = previous.meta
        const geometry = { x, y, rotation, parentId, ...(parentId !== next.parentId && { index: previous.index }) }
        const meta = { ...next.meta, rmBrush, weftAnchorX, weftAnchorY, weftNativeGeometry }
        if (previous.type === 'draw' && next.type === 'draw') {
            const { segments, scale, scaleX, scaleY } = previous.props
            const { rmPointData, rmColor, rmThicknessScale } = previous.meta
            return { ...next, ...geometry, props: { ...next.props, segments, scale, scaleX, scaleY },
                meta: { ...meta, rmPointData, rmColor, rmThicknessScale } }
        }
        if (previous.type === 'image' && next.type === 'image') {
            const { assetId, w, h } = previous.props
            return { ...next, ...geometry, props: { ...next.props, assetId, w, h },
                meta: { ...meta, weftNativeImageUuid: previous.meta.weftNativeImageUuid } }
        }
        return next
    }

    private shiftForAnchor(shape: TLShape, from: AnchorOffset, to: AnchorOffset) {
        const dx = (to.dx - from.dx) * RM_SCALE
        const dy = (to.dy - from.dy) * RM_SCALE
        const parent = this.editor.getShape(shape.parentId as TLShapeId)
        const inverse = parent && Mat.Inverse(this.editor.getShapePageTransform(parent))
        // Convert a vector, so the parent's translation is irrelevant.
        return {
            x: shape.x + (inverse ? inverse.a * dx + inverse.c * dy : dx),
            y: shape.y + (inverse ? inverse.b * dx + inverse.d * dy : dy),
            meta: { ...shape.meta, weftAnchorX: to.dx, weftAnchorY: to.dy },
        }
    }

    private renderInkItems(excluded: Set<string>): void {
        const _t = performance.now()
        const doc = this.session.document
        const resolver = new RefResolver(doc)
        const anchorOff = this.anchorOffsetByItem()
        // DOCUMENT (CRDT) order, not file order: xochitl lays the file out
        // grouped by (author, clock) — a storage convention — but renders the
        // scene-tree walk. tldraw stacks createShape calls bottom-to-top, so
        // iterating the walk makes both sides layer identically (pinned by
        // the Z-LAYERING test in sync-engine/test/session.test.ts).
        const page = this.editor.getCurrentPageId()
        const records: {
            shape: TLShapePartial<TLDrawShape | TLImageShape>
            key: string
            offset: AnchorOffset
            line: Line | undefined
            imageQuad?: readonly number[]
        }[] = []
        const gaps: { start: number; end: number; upper: IndexKey }[] = []
        let pendingStart = 0
        const moves: { key: string; offset: AnchorOffset; change: TLShapePartial }[] = []
        const selected = this.editor.inputs.getIsPointing() ? new Set(this.editor.getSelectedShapeIds()) : null
        for (const [itemId, item] of doc.tree().walk()) {
            if (item.kind !== 'line' && item.kind !== 'image') continue
            const ref = resolver.toRef(itemId)
            if (!ref) continue
            const key = itemRefKey(ref)
            if (excluded.has(key)) continue
            const off = anchorOff.get(crdtIdKey(itemId)) ?? NO_ANCHOR
            const existing = this.inkShapes.get(key)
            if (existing !== undefined) {
                const live = this.editor.getShape(existing)
                if (!live) continue
                if (pendingStart < records.length && live.parentId === page) {
                    gaps.push({ start: pendingStart, end: records.length, upper: live.index })
                    pendingStart = records.length
                }
                const prev = this.inkShapeOff.get(key) ?? NO_ANCHOR
                const lineSource = this.inkLineSources.get(key)
                const lineChanged = item.kind === 'line' && live.type === 'draw' &&
                    (!lineSource || (lineSource !== item && !sameNativeLine(lineSource, item)))
                if (selected?.has(existing) || this.pendingInkTransforms.has(existing) || this.pendingImageMoves.has(existing)) {
                    if (lineChanged || prev.dx !== off.dx || prev.dy !== off.dy || item.kind === 'image') {
                        this.pendingAnchorReflow = true
                        this.schedule()
                    }
                    continue
                }
                let change: TLShapePartial | undefined
                if (item.kind === 'image' && live.type === 'image') {
                    const geometry = this.nativeImageGeometry(item, off, live)
                    const asset = live.props.assetId ? this.editor.getAsset(live.props.assetId) : undefined
                    // A pasted or duplicated image may still use the old asset.
                    // Rebind only the native placement to a fresh source record.
                    const assetId = item.filename && (asset?.type !== 'image' || asset.props.name !== item.filename)
                        ? this.createNativeImageAsset(item.filename, geometry?.w ?? live.props.w, geometry?.h ?? live.props.h)
                        : live.props.assetId
                    const uuid = bytesToUuidLE(item.uuid.value)
                    const geometryChanged = geometry && (live.x !== geometry.x || live.y !== geometry.y ||
                        live.rotation !== geometry.rotation || live.props.w !== geometry.w || live.props.h !== geometry.h)
                    const previousQuad = this.inkImageQuads.get(key)
                    // Native files store quad coordinates as float32. Compare
                    // the source, not rounding differences in SDK geometry.
                    const sourceGeometryChanged = previousQuad && (previousQuad.length !== item.vertices.length ||
                        previousQuad.some((value, i) => Math.fround(value) !== Math.fround(item.vertices[i]!)))
                    if (assetId !== live.props.assetId || live.meta.weftNativeImageUuid !== uuid ||
                        prev.dx !== off.dx || prev.dy !== off.dy || geometryChanged || sourceGeometryChanged) {
                        const { w, h, ...position } = geometry ?? { w: live.props.w, h: live.props.h }
                        change = { id: existing, type: 'image', ...position, props: { w, h, assetId },
                            meta: { ...live.meta, weftNativeImageUuid: uuid, weftAnchorX: off.dx, weftAnchorY: off.dy,
                                ...(sourceGeometryChanged &&
                                    { weftNativeGeometry: Number(live.meta.weftNativeGeometry ?? 0) + 1 }) } }
                    }
                    this.inkImageQuads.set(key, item.vertices)
                    if (assetId && item.filename) this.loadNativeImage(assetId, item.filename)
                } else if (lineChanged) {
                    const points = this.nativePointsInParent(item.points, off, live)
                    const record = lineToDrawShape(existing, { ...item, points: item.points.map((point, index) => ({
                        ...point, x: points[index]!.x / RM_SCALE, y: points[index]!.y / RM_SCALE,
                    })) })
                    if (record) change = { ...record, rotation: 0,
                        props: { ...record.props, scaleX: 1, scaleY: 1 },
                        meta: { ...live.meta, ...record.meta, weftAnchorX: off.dx, weftAnchorY: off.dy,
                            weftNativeGeometry: Number(live.meta.weftNativeGeometry ?? 0) + 1 } }
                } else if (prev.dx !== off.dx || prev.dy !== off.dy) {
                    change = { id: existing, type: live.type, ...this.shiftForAnchor(live, prev, off) }
                }
                if (change) moves.push({ key, offset: off, change })
                if (item.kind === 'line') this.inkLineSources.set(key, item)
                continue
            }
            const id = createShapeId()
            const record = item.kind === 'image' ? this.imageRecord(id, item, off) : lineToDrawShape(id, item)
            if (!record) continue
            if (record.type === 'draw') {
                record.x += off.dx * RM_SCALE
                record.y += off.dy * RM_SCALE
                record.meta = { ...record.meta, weftAnchorX: off.dx, weftAnchorY: off.dy }
            }
            // Imported geometry is already in page space. Avoid SDK auto-parenting
            // to a local frame or focused group when a remote item arrives.
            record.parentId = page
            records.push({ shape: record, key, offset: off, line: item.kind === 'line' ? item : undefined,
                ...(item.kind === 'image' && { imageQuad: item.vertices }) })
        }
        console.debug(
            `weft:render ink-walk ${records.length} recs ${moves.length} moves +${(performance.now() - _t).toFixed(0)}ms`,
        )
        // ONE batched insert preserves the walk order (createShapes stacks
        // the array bottom-to-top the same way sequential calls did) and
        // costs one store transaction instead of one per stroke.
        const _c = performance.now()
        if (gaps.length) {
            // Pick a free interval immediately before each existing native
            // sibling. Include unrelated page shapes when finding occupied indices.
            const predecessor = new Map<IndexKey, IndexKey | null>()
            let previous: IndexKey | null = null
            for (const id of this.editor.getSortedChildIdsForParent(page)) {
                const index = this.editor.getShape(id)!.index
                if (index === previous) continue
                predecessor.set(index, previous)
                previous = index
            }
            for (const { start, end, upper } of gaps) {
                const indices = getIndicesBetween(predecessor.get(upper), upper, end - start)
                for (let i = start; i < end; i++) records[i]!.shape.index = indices[i - start]!
                predecessor.set(upper, indices.at(-1)!)
            }
        }
        if (records.length) {
            const shapes = records.map(({ shape }) => shape)
            const room = this.editor.options.maxShapesPerPage - this.editor.getCurrentPageShapeIds().size
            this.editor.createShapes(shapes)
            if (room > 0 && shapes.length > room) {
                // The SDK rejects oversized batches atomically. Before the mixed
                // batch, photos used their available slots before the ink batch.
                const photos = shapes.filter(shape => shape.type === 'image').slice(0, room)
                if (photos.length) this.editor.createShapes(photos)
            }

            const created = this.editor.getCurrentPageShapeIds()
            const unusedAssets: TLAssetId[] = []
            for (const { shape, key, offset, line, imageQuad } of records) {
                if (created.has(shape.id)) {
                    this.inkShapes.set(key, shape.id)
                    this.inkShapeOff.set(key, offset)
                    if (line) this.inkLineSources.set(key, line)
                    if (imageQuad) this.inkImageQuads.set(key, imageQuad)
                } else if (shape.type === 'image' && shape.props?.assetId) {
                    unusedAssets.push(shape.props.assetId)
                }
            }
            if (unusedAssets.length) this.editor.deleteAssets(unusedAssets)
        }
        if (moves.length) {
            this.editor.run(() => this.editor.updateShapes(moves.map(({ change }) => change)), {
                history: 'ignore',
                ignoreShapeLock: true,
            })
            for (const { key, offset, change } of moves) {
                const shape = this.editor.getShape(change.id)
                if (shape && shape.meta.weftAnchorX === offset.dx && shape.meta.weftAnchorY === offset.dy) {
                    this.inkShapeOff.set(key, offset)
                }
            }
        }
        console.debug(`weft:render ink-createShapes +${(performance.now() - _c).toFixed(0)}ms`)
        this.syncDeviceTextShape()
    }

    private nativePointsInParent(
        points: readonly { x: number; y: number }[],
        off: { dx: number; dy: number },
        shape?: TLShape,
    ) {
        const parent = shape && !isPageId(shape.parentId)
            ? Mat.Inverse(this.editor.getShapeParentTransform(shape)) : undefined
        return points.map(({ x, y }) => {
            const point = { x: (x + off.dx) * RM_SCALE, y: (y + off.dy) * RM_SCALE }
            return parent ? Mat.applyToPoint(parent, point) : point
        })
    }

    private nativeImageGeometry(
        item: { vertices: number[] },
        off: { dx: number; dy: number },
        shape?: TLShape,
    ) {
        const v = item.vertices
        if (v.length < 14) return
        const [top, right, bottom] = this.nativePointsInParent([
            { x: v[0]!, y: v[1]! }, { x: v[4]!, y: v[5]! }, { x: v[12]!, y: v[13]! },
        ], off, shape)
        const dx = right!.x - top!.x
        const dy = right!.y - top!.y
        const w = Math.hypot(dx, dy)
        const h = Math.hypot(bottom!.x - top!.x, bottom!.y - top!.y)
        if (!(w > 0) || !(h > 0)) return
        return { x: top!.x, y: top!.y, rotation: Math.atan2(dy, dx), w, h }
    }

    /**
     * Embedded image (E26): placement quad in ink units, pixel bytes served
     * from the page's asset dir by the daemon. Read-only in tldraw for now
     * (meta.rmBrush keeps it out of local-edit projection).
     */
    private imageRecord(
        id: TLShapeId,
        item: { filename: string | null; vertices: number[]; uuid: { value: Uint8Array } },
        anchorOff?: { dx: number; dy: number },
    ): TLShapePartial<TLImageShape> | null {
        if (!item.filename) return null
        const filename = item.filename
        const geometry = this.nativeImageGeometry(item, anchorOff ?? NO_ANCHOR)
        if (!geometry) return null
        const { w, h, ...position } = geometry
        const assetId = this.createNativeImageAsset(filename, w, h)
        // Admission is synchronous. Do not fetch assets for rejected shapes.
        queueMicrotask(() => {
            if (!this.disposed) this.loadNativeImage(assetId, filename)
        })
        return {
            id,
            type: 'image',
            ...position,
            props: { assetId, w, h },
            meta: { rmBrush: 'rm-image', weftNativeImageUuid: bytesToUuidLE(item.uuid.value),
                weftAnchorX: anchorOff?.dx ?? 0, weftAnchorY: anchorOff?.dy ?? 0 },
        }
    }

    private createNativeImageAsset(filename: string, w: number, h: number): TLAssetId {
        const mime = /\.jpe?g$/i.test(filename) ? 'image/jpeg' : 'image/png'
        // Load the asset through the API with auth as a DATA url; a bare URL
        // would 401 in cloud mode and hit the wrong origin (it must use
        // apiBase, not a relative path), and a blob: URL is rejected by
        // tldraw's image-asset src validator ("invalid protocol") which crashes
        // the editor. The shape is created now; the asset src is filled in when
        // the authed fetch resolves so the image appears once ready.
        const assetId = AssetRecordType.createId()
        this.editor.createAssets([
            {
                id: assetId,
                typeName: 'asset',
                type: 'image',
                props: {
                    // 1x1 transparent PNG: an empty src renders tldraw's
                    // BLACK broken-image box for the whole fetch (owner:
                    // "images are black for a LONG time"); blank beats black
                    src: EMPTY_PHOTO_SRC,
                    w,
                    h,
                    name: filename,
                    isAnimated: false,
                    mimeType: mime,
                },
                meta: {},
            },
        ])
        return assetId
    }

    private readonly nativeImageFiles = new Map<TLAssetId, string>()
    private readonly loadingNativeImages = new Map<TLAssetId, AbortController>()

    private loadNativeImage(id: TLAssetId, filename: string, refresh = false): void {
        const scope = libraryCacheScope()
        if (this.photoOwner && this.photoOwner !== scope) return
        this.photoOwner ??= scope
        const asset = this.editor.getAsset(id)
        if (asset?.type !== 'image' || asset.props.name !== filename) {
            this.nativeImageFiles.delete(id)
            return
        }
        const existing = this.loadingNativeImages.get(id)
        if (refresh) existing?.abort()
        else if (existing || asset.props.src !== EMPTY_PHOTO_SRC) return
        this.nativeImageFiles.set(id, filename)
        const loading = new AbortController()
        this.loadingNativeImages.set(id, loading)
        const path = `/api/documents/${this.opts.docId}/pages/${this.opts.pageId}/assets/${encodeURIComponent(filename)}`
        const install = (url: string | null) => {
            if (this.disposed || loading.signal.aborted || !url) return
            const live = this.editor.getAsset(id)
            if (live?.type === 'image' && live.props.name === filename && live.props.src !== url) {
                this.remote(() => this.editor.updateAssets([{ ...live, props: { ...live.props, src: url } }]))
            }
        }
        void fetchDataUrl(path, asset.props.mimeType ?? 'image/png', (url) => {
            // A refresh keeps the already-visible image until validation succeeds.
            const live = this.editor.getAsset(id)
            if (live?.type === 'image' && live.props.src === EMPTY_PHOTO_SRC) install(url)
        }, loading.signal).then(install).finally(() => {
            if (this.loadingNativeImages.get(id) === loading) this.loadingNativeImages.delete(id)
        })
    }

    // ----- local edits -> engine -----

    private queueArrow(id: TLShapeId): void {
        const arrow = this.editor.getShape(id)
        if (arrow?.type !== 'arrow' || arrow.meta.detached) return
        this.orderOnlyShapeIds.delete(id)
        this.pendingShapeIds.add(id)
        this.pendingShapeVersions.set(id, this.captureShapeEdit(id))
    }

    private noteChange(record: TLShape, before?: TLShape): void {
        if (record.typeName !== 'shape') return
        this.pendingDeletes.delete(record.id)
        if (record.meta.rmBrush && before && record.x === before.x && record.y === before.y &&
            record.rotation === before.rotation && record.parentId === before.parentId) {
            if (record.type === 'draw' && before.type === 'draw' &&
                record.props.segments === before.props.segments && record.props.scaleX === before.props.scaleX &&
                record.props.scaleY === before.props.scaleY) return
            if (record.type === 'image' && before.type === 'image' &&
                record.props.w === before.props.w && record.props.h === before.props.h) return
        }
        if (
            record.type === 'image' &&
            (record.meta as { rmBrush?: string })?.rmBrush === 'rm-image'
        ) {
            // embedded RM image dragged/resized/rotated in tldraw
            this.pendingImageMoves.add(record.id)
            return
        }
        // A FRAME is a true clipping container: its children are frame-local, so
        // moving/rotating/resizing the frame updates ONLY the frame record and
        // the children never re-fire — their tablet strokes would stay put while
        // the frame moves. Re-enqueue the frame's syncable descendants so their
        // projection (which composes the frame transform) refreshes. (Groups do
        // NOT need this: tldraw bakes a group transform into the child records,
        // which re-fire on their own — device-verified in projection-fidelity.)
        if (record.type === 'frame') {
            for (const id of this.editor.getShapeAndDescendantIds([record.id])) {
                const d = this.editor.getShape(id)
                if (d && SYNCABLE.has(d.type) && !(d.meta as { rmBrush?: string })?.rmBrush) {
                    this.pendingShapeIds.add(d.id)
                    this.pendingShapeVersions.set(d.id, this.captureShapeEdit(d.id))
                }
            }
            return
        }
        if (!SYNCABLE.has(record.type)) return
        if ((record.meta as { rmBrush?: string })?.rmBrush) {
            // tablet ink is engine-owned EXCEPT a user move/resize/rotate:
            // bake that transform back into the doc on the next flush
            if (record.type === 'draw' && !this.pendingInkTransforms.has(record.id)) {
                this.pendingInkTransforms.set(record.id, before?.type === 'draw' ? before : null)
            }
            return
        }
        // a detached shape is FROZEN: re-projecting it would re-render stale
        // props over the tablet's diverged ink and push erased strokes back
        // to the device. Only an explicit RE-ATTACH re-projects it.
        if ((record.meta as { detached?: boolean })?.detached) return
        // Store user intent before any display mask or asynchronous projection.
        if (!before || before.opacity !== record.opacity) {
            this.pendingOpacityWrites.set(record.id, { opacity: record.opacity, opacityVersion: this.version() })
        }
        // freehand shapes (draw, highlight) only sync once the stroke is done
        if (
            (record.type === 'draw' || record.type === 'highlight') &&
            !(record as TLDrawShape).props.isComplete
        )
            return
        const changedOrder = isPageId(record.parentId) && (!before || before.index !== record.index || before.parentId !== record.parentId)
        if (changedOrder) this.pendingBrowserOrder.set(record.id, record.index)
        const checkProjection = changedOrder || this.orderOnlyShapeIds.has(record.id)
        if (checkProjection) {
            const sameProjection = before && before.parentId === record.parentId && before.type === record.type &&
                before.x === record.x && before.y === record.y && before.rotation === record.rotation &&
                before.opacity === record.opacity &&
                (before.props === record.props || JSON.stringify(before.props) === JSON.stringify(record.props))
            if (!sameProjection) this.orderOnlyShapeIds.delete(record.id)
            else if (changedOrder && !this.pendingShapeIds.has(record.id)) this.orderOnlyShapeIds.add(record.id)
        }
        this.pendingShapeIds.add(record.id)
        this.pendingShapeVersions.set(record.id, this.captureShapeEdit(record.id))
    }

    private schedule(): void {
        if (this.debounce) clearTimeout(this.debounce)
        // Coalesces a burst of edits into one /ops POST. Kept short so the
        // web->tablet handoff is snappy; the daemon no longer adds a fixed
        // coalesce lead on top (it pulls the first edit immediately).
        this.debounce = setTimeout(() => void this.flush().catch(() => {}), 180)
    }

    private hasUnprojectedShape(shapeId: string): boolean {
        return this.pendingShapeIds.has(shapeId) || this.pendingDeletes.has(shapeId)
    }

    private deferOpacityWhilePending(id: string): boolean {
        if (!this.hasUnprojectedShape(id)) return false
        this.deferredOpacityRepaints.add(id)
        return true
    }

    private get hasQueuedShapeEdits(): boolean {
        return this.pendingShapeIds.size > 0 || this.pendingDeletes.size > 0 ||
            this.pendingImageMoves.size > 0 || this.pendingInkTransforms.size > 0
    }

    private trackCommand(work: Promise<void>): Promise<void> {
        this.pendingCommands.add(work)
        void work.finally(() => this.pendingCommands.delete(work)).catch(() => {})
        return work
    }

    private async applyLocal(ops: LocalOp[], render?: () => void): Promise<void> {
        if (this.disposed) return
        try {
            await this.session.apply(ops)
        } catch (error) {
            if (!this.disposed) {
                this.saveFailure = Symbol()
                if (render) this.renderAfterRetry.add(render)
                this.opts.onStatus?.({ state: 'error', detail: String(error) })
            }
            // OfflineSession has already queued the ops. Retrying persistence
            // must write that queue, never apply the same command twice.
            throw error
        }
        if (!this.disposed) render?.()
    }

    completeNavigationGesture(): void {
        if (!this.disposed && this.editor?.inputs.getIsPointing()) this.editor.complete()
    }

    blurForNavigation(): void {
        // tldraw also handles keyboard shortcuts above the canvas container.
        this.editor?.blur()
    }

    get hasUnsavedEdits(): boolean {
        if (this.disposed) return false
        // tldraw batches store listeners until the next animation frame.
        // Navigation must observe edits made in the same event as the click.
        this.editor?.store._flushHistory()
        return !!this.editor?.getEditingShapeId() || this.deviceTextDraft !== undefined ||
            !!this.deviceTextWork || !!this.saveFailure || this.pendingCommands.size > 0 ||
            !!this.flushing || this.hasQueuedShapeEdits
    }

    /** Keep the outgoing editor alive until its completed edits reach local storage. */
    async saveBeforeNavigation(): Promise<void> {
        if (!this.session || this.disposed) return
        try {
            do {
                this.editor.complete()
                if (this.editor.getEditingShapeId()) this.editor.setEditingShape(null)
                this.editor.store._flushHistory()
                if (this.debounce) clearTimeout(this.debounce)
                if (this.deviceTextWork) await this.deviceTextWork
                if (this.deviceTextDraft !== undefined) await this.commitDeviceText(this.deviceTextDraft)
                await Promise.all([...this.pendingCommands])
                await this.flush()
                if (this.disposed) return
                const missingFont = !this.font && [...this.pendingShapeIds].some((id) =>
                    needsProjectionFont(this.editor.getShape(id as TLShapeId)),
                )
                const gestureInProgress = this.pendingInkTransforms.size > 0 && this.editor.inputs.getIsPointing()
                if (missingFont || gestureInProgress) throw new Error('Some edits could not be projected yet')
                const failure = this.saveFailure
                const renders = [...this.renderAfterRetry]
                await this.session.savePending()
                if (this.disposed) return
                if (this.saveFailure === failure) this.saveFailure = null
                for (const render of renders) {
                    if (this.renderAfterRetry.delete(render)) render()
                }
                this.rebuildSceneWhenIdle()
                // Input can arrive while the IndexedDB transaction commits.
            } while (!this.disposed && this.hasUnsavedEdits)
        } catch (e) {
            this.saveFailure = Symbol()
            throw e
        }
    }

    private flush(): Promise<void> {
        if (this.flushing) return this.flushing.then(() => this.flush())
        const work = this.flushBatch()
        this.flushing = work
        const clear = () => { if (this.flushing === work) this.flushing = null }
        void work.then(() => {
            clear()
            this.rebuildSceneWhenIdle()
        }, clear).catch(() => {})
        return work
    }

    private async flushBatch(): Promise<void> {
        if (this.disposed) return
        if (!this.font && [...this.pendingShapeIds].some((id) =>
            needsProjectionFont(this.editor.getShape(id as TLShapeId)),
        )) {
            await this.ensureFont()
            if (this.disposed) return
        }
        const ops: LocalOp[] = []

        for (const [shapeId, version] of this.pendingDeletes) {
            this.deferredOpacityRepaints.delete(shapeId)
            this.pendingShapeIds.delete(shapeId)
            this.pendingShapeVersions.delete(shapeId)
            this.pendingOpacityWrites.delete(shapeId)
            this.pendingBrowserOrder.delete(shapeId)
            this.orderOnlyShapeIds.delete(shapeId)
            // overlay shape?
            if (this.session.currentOverlay.shapes.some((s) => s.shapeId === shapeId)) {
                ops.push({ type: 'remove-shape', shapeId, version })
                continue
            }
            // tablet ink?
            const entry = [...this.inkShapes.entries()].find(([, id]) => id === shapeId)
            if (entry) {
                const [key] = entry
                this.dropInkBinding(key)
                const [authorUuid, clock] = splitKey(key)
                ops.push({ type: 'remove-ink', items: [{ authorUuid, clock }] })
            }
        }
        this.pendingDeletes.clear()

        // Wait for the end of a native gesture before capturing its geometry.
        // Reflow may have arrived while the SDK still held its start positions.
        const imageRemaps = new Map<string, number[]>()
        let inkTransformKeys: string[] = []
        if (!this.editor.inputs.getIsPointing()) {
            for (const shapeId of this.pendingImageMoves) {
                const op = this.projectImageMove(shapeId)
                if (!op) continue
                ops.push(op)
                imageRemaps.set(shapeId, op.vertices)
            }
            this.pendingImageMoves.clear()
            inkTransformKeys = this.projectInkTransforms(ops)
            this.pendingInkTransforms.clear()
        } else if (this.pendingInkTransforms.size || this.pendingImageMoves.size) {
            // Release need not produce a store change of its own.
            this.schedule()
        }

        // Snapshot the queue after any pending font load so projection uses
        // current editor records.
        const batch = this.pendingShapeIds
        this.pendingShapeIds = new Set()
        const versions = this.pendingShapeVersions
        this.pendingShapeVersions = new Map()
        const opacityBatch = new Map<string, { opacity: number; opacityVersion: OpVersion }>()
        for (const id of batch) {
            const write = this.pendingOpacityWrites.get(id)
            if (write) opacityBatch.set(id, write)
            this.pendingOpacityWrites.delete(id)
        }
        const orderBatch = new Map(this.pendingBrowserOrder)
        const orderOnly = this.orderOnlyShapeIds
        this.orderOnlyShapeIds = new Set()
        const orders = orderBatch.size > 0
            ? new Map(this.session.currentOverlay.shapes.map(shape => [shape.shapeId, shape])) : undefined
        let retries = 0
        const projected: string[] = []
        for (const shapeId of this.projectionOrder(batch)) {
            const shape = this.editor.getShape(shapeId as TLShapeId)
            if (!shape) continue
            const opacityWrite = opacityBatch.get(shapeId)
            const captured = versions.get(shapeId) ?? this.captureShapeEdit(shapeId)
            const editVersion = this.projectionVersion(shapeId, captured)
            // noteChange skips detached shapes at ENQUEUE time, but a detach
            // arriving inside the debounce window slips past it — projecting
            // then re-renders stale props over the tablet's diverged ink and
            // silently re-attaches (the D8 hazard the skip exists for).
            if ((shape.meta as { detached?: boolean })?.detached) continue
            const index = orderBatch.get(shapeId)
            const captureOrder = index === shape.index && this.pendingBrowserOrder.get(shapeId) === index
            const stored = orders?.get(shapeId)
            const orderVersion = captureOrder && isPageId(shape.parentId) ? this.browserOrderVersion(stored) : undefined
            if (orderOnly.has(shapeId) && !opacityWrite) {
                if (stored && orderVersion && index !== undefined && stored.browserIndex !== index) {
                    ops.push({ type: 'set-browser-index', shapeId, index, version: orderVersion })
                }
                continue
            }
            if (!this.font && needsProjectionFont(shape)) {
                this.pendingShapeIds.add(shapeId)
                this.pendingShapeVersions.set(shapeId, captured)
                if (opacityWrite && !this.pendingOpacityWrites.has(shapeId)) this.pendingOpacityWrites.set(shapeId, opacityWrite)
                retries++
                continue
            }
            const op = this.projectShape(shape, orderVersion, opacityWrite, editVersion)
            if (op) {
                ops.push(op)
                projected.push(shapeId)
            }
        }
        if (retries > 0) {
            if (this.retryTimer) clearTimeout(this.retryTimer)
            this.retryTimer = setTimeout(() => void this.schedule(), 2000)
        }

        for (const id of batch) {
            if (!this.pendingShapeIds.has(id) && this.pendingBrowserOrder.get(id) === orderBatch.get(id)) {
                this.pendingBrowserOrder.delete(id)
            }
        }
        if (ops.length && !this.disposed) {
            const orderChanged = ops.some(op => op.type === 'set-browser-index' ||
                (op.type === 'upsert-shape' && op.shape.browserIndex !== undefined))
            if (orderChanged) this.collectSplitBrowserTies(ops)
            await this.applyLocal(ops, () => {
                if (this.disposed) return
                for (const id of projected) this.projectedShapeIds.add(id)
                const accepted = this.session.currentOverlay
                const wonByPeer = ops.some(op => {
                    if (op.type !== 'upsert-shape' && op.type !== 'remove-shape') return false
                    const id = op.type === 'upsert-shape' ? op.shape.shapeId : op.shapeId
                    const submitted = op.type === 'upsert-shape' ? op.shape.version : op.version
                    const shape = accepted.shapes.find(candidate => candidate.shapeId === id)
                    const winner = shape?.version ?? accepted.tombstones?.[id]
                    return winner && (winner.ts > submitted.ts ||
                        (winner.ts === submitted.ts && winner.actor > submitted.actor))
                })
                if (wonByPeer) this.reconcileToSessionState()
                // The local gesture may introduce or dissolve a paint-index
                // tie. Our own echo won't request a repaint.
                if (orderChanged || this.browserOrderNeedsRefresh || this.browserOrderTies.size > 0) {
                    this.remote(() => this.applyBrowserOrderTies())
                }
                if (imageRemaps.size) this.remapImageIdentities(imageRemaps)
                if (inkTransformKeys.length > 0) this.rebindTransformedInk(inkTransformKeys)
            })
        }
        if (!this.disposed && this.deferredOpacityRepaints.size) this.applyDeferredOpacity(batch)
        if (!this.disposed && this.pendingAnchorReflow) {
            if (this.editor.inputs.getIsPointing()) {
                this.schedule()
            } else {
                this.pendingAnchorReflow = false
                this.refreshTextLayout()
            }
        }
    }

    private applyDeferredOpacity(batch: ReadonlySet<string>): void {
        // A peer patch skipped during a local edit may not be sent again.
        this.editor.store._flushHistory()
        const ready: string[] = []
        for (const id of batch) {
            if (!this.deferredOpacityRepaints.has(id) || this.hasUnprojectedShape(id) || this.pendingDeletes.has(id)) continue
            this.deferredOpacityRepaints.delete(id)
            ready.push(id)
        }
        if (!ready.length) return
        const accepted = new Map(this.session.currentOverlay.shapes.map(shape => [shape.shapeId, shape]))
        const updates: { id: TLShapeId; type: string; opacity: number }[] = []
        for (const id of ready) {
            const winner = accepted.get(id)
            const live = this.editor.getShape(id as TLShapeId)
            if (!winner || !live || live.type !== overlayShapeType(winner.kind)) continue
            const masked = this.layerMaskedShapes.has(live.id)
            const shown = displayOpacity(winner)
            if (masked) this.layerMaskedShapes.set(live.id, shown)
            const opacity = masked ? 0 : shown
            if (live.opacity !== opacity) updates.push({ id: live.id, type: live.type, opacity })
        }
        if (updates.length) {
            this.remote(() => this.editor.run(() => this.editor.updateShapes(updates as never), { ignoreShapeLock: true }))
        }
    }

    /** Device typed text (RootText), linearized for the read-only overlay. */
    /**
     * Apply a device typed-text edit (the page's text COLUMN): create /
     * insert / delete / restyle, minted under our author identity through
     * the text CRDT. Publishes via the snapshot path (no op form yet); the
     * anchored ink reflows on the next render because anchor offsets are
     * recomputed from the updated text.
     */
    editRootText(edit: Omit<Extract<LocalOp, { type: 'edit-root-text' }>, 'type'>): Promise<void> {
        return this.trackCommand(this.applyRootText(edit))
    }

    private async applyRootText(edit: Omit<Extract<LocalOp, { type: 'edit-root-text' }>, 'type'>): Promise<void> {
        if (this.disposed) return
        // Project edits against their original anchor offsets before
        // applying the text change that will reflow the scene.
        if (this.debounce) clearTimeout(this.debounce)
        await this.ensureFont()
        if (this.disposed) return
        this.editor.store._flushHistory()
        await this.flush()
        if (this.disposed) return
        await this.applyLocal([{ type: 'edit-root-text', ...edit }], () => {
            this.requestSceneRebuild()
            this.onMetaChanged?.()
        })
    }

    /** Ordered live char id keys of the root text — the positional map the
     *  device-text commit diff aligns against the editor string (one entry
     *  per visible code point). */
    rootTextPositions(): { key: string }[] {
        const text = this.session.document.tree().rootText
        if (!text) return []
        return rootTextCharPositions(text)
            .filter((c) => !c.deleted)
            .map((c) => ({ key: crdtIdKey(c.id) }))
    }

    /** Keep the device-text SHAPE in lockstep with the root text: one shape
     *  per page, pinned at the column rect, sized by the shared layout (the
     *  same math the ink anchors use). */
    syncDeviceTextShape(): void {
        const id = 'shape:device-text' as TLShapeId
        // NEVER rewrite the shape while the user is typing in it: replacing
        // richText mid-edit resets the TipTap caret to the document start, so
        // an echo landing between keystrokes teleported the cursor and the
        // next characters landed at position 0 (" EDITEDHello device...").
        // The commit diff aligns against the live char ids at commit time, so
        // skipping here just defers convergence to the commit/blur.
        if (this.editor.getEditingShapeId() === id) return
        const text = this.session.document.tree().rootText
        const existing = this.editor.getShape(id)
        if (!text) {
            if (existing) this.remote(() => this.editor.deleteShapes([id]))
            return
        }
        const paragraphs = linearizeRootText(text)
        const richText = paragraphsToRichText(paragraphs)
        const measure = canvasMeasure()
        const layout = layoutText(paragraphs, text.width, measure)
        // per-LINE hit boxes (shape-space px): the shape is clickable on its
        // text and nowhere else — empty typed lines must not eat ink clicks
        const lines: { x: number; y: number; w: number; h: number }[] = []
        paragraphs.forEach((p, pi) => {
            const para = layout.paras[pi]!
            const m = metricsFor(p.style, p.sizeCode, p.indentLevel)
            const full = p.spans.map((s) => s.text).join('')
            para.lineStarts.forEach((start, li) => {
                const end =
                    li + 1 < para.lineStarts.length ? para.lineStarts[li + 1]! : full.length
                const lineText = full.slice(start, end).trimEnd()
                if (!lineText) return
                // plain paragraphs render inset by the device text pad
                const markerX = m.checkbox?.xInk ?? m.marker?.xInk
                const leftInk =
                    markerX !== undefined
                        ? Math.min(markerX, m.indentInk)
                        : m.indentInk || DEVICE_TEXT_LEFT_MARGIN_INK
                const textStartInk = m.indentInk || DEVICE_TEXT_LEFT_MARGIN_INK
                const wInk = textStartInk - leftInk + para.lineWidthsInk[li]!
                lines.push({
                    x: Math.round(leftInk * RM_SCALE * 100) / 100,
                    y: Math.round((para.topInk + li * para.lineStrideInk) * RM_SCALE * 100) / 100,
                    w: Math.round(wInk * RM_SCALE * 100) / 100,
                    h: Math.round(para.lineStrideInk * RM_SCALE * 100) / 100,
                })
            })
        })
        const record = {
            id,
            type: 'device-text' as const,
            // the column origin is posX exactly; the device's left text pad
            // applies to PLAIN paragraphs only (list/checkbox indents are
            // absolute from posX) and lives in the stylesheet, not here
            x: text.posX * RM_SCALE,
            y: text.posY * RM_SCALE,
            isLocked: false,
            props: {
                w: text.width * RM_SCALE,
                h: Math.max(layout.bottomInk * RM_SCALE, 24),
                richText,
                lines,
            },
            meta: { weft: true, layoutGen: this.layoutGen },
        }
        this.remote(() => {
            if (existing) this.editor.updateShape(record as never)
            else this.editor.createShape(record as never)
        })
    }

    /** Commit a finished device-text edit (tldraw's TipTap doc): flatten to
     *  lines, diff the text (one insert + one delete range), then align
     *  paragraph styles where the user changed a node KIND. */
    commitDeviceText(richText: unknown): Promise<void> {
        this.deviceTextDraft = richText
        const work = (this.deviceTextWork ?? Promise.resolve()).catch(() => {}).then(async () => {
            await this.commitDeviceTextNow(richText)
            if (this.deviceTextDraft === richText) this.deviceTextDraft = undefined
        })
        this.deviceTextWork = work
        void work.finally(() => {
            if (this.deviceTextWork === work) this.deviceTextWork = null
        }).catch(() => {})
        return work
    }

    private async commitDeviceTextNow(richText: unknown): Promise<void> {
        try {
            const lines = richTextToLines(richText as never)
            const draft = lines.map((l) => l.text).join('\n')
            const text = this.session.document.tree().rootText
            const current = text
                ? linearizeRootText(text)
                      .map((p) => p.spans.map((sp) => sp.text).join(''))
                      .join('\n')
                : ''
            if (draft !== current || !text) {
                const positions = text
                    ? this.rootTextPositions()
                    : ([] as { key: string }[])
                // positions has one entry per VISIBLE code point of `current`
                // (including the '\n' separators). Compare in code points, not
                // UTF-16 units, so an emoji/astral char doesn't desync the map
                // and drop the edit (#79). `current`'s only '\n' are separators.
                const currentCp = [...current]
                if (text && positions.length !== currentCp.length) {
                    throw new Error('Device text position map is out of sync')
                }
                // Multi-region diff (Myers): touch ONLY the code points that
                // changed, leaving untouched '\n' separators matched so their
                // paragraph style + anchored ink survive an edit that spans two
                // non-adjacent lines (#78). Each insert anchors after a
                // surviving code point (never one being deleted).
                const diff = diffCodePoints(currentCp, [...draft])
                const deleteKeys = diff.deletes.map((i) => positions[i]!.key)
                const inserts = diff.inserts.map((ins) => ({
                    afterKey: ins.after >= 0 ? positions[ins.after]!.key : null,
                    text: ins.text,
                }))
                await this.editRootText({
                    ...(text ? {} : { create: {} }),
                    ...(inserts.length ? { inserts } : {}),
                    ...(deleteKeys.length ? { deleteKeys } : {}),
                })
            }
            // style pass: apply only where the node KIND differs from the
            // stored style's kind. The deviceStyle attr (the style the node
            // was BUILT from, carried through TipTap edits) breaks ties so
            // BOLD/CHECKBOX/CHECKED survive splits and reorders.
            const after = this.session.document.tree().rootText
            if (!after) return
            const paras = linearizeRootText(after)
            const anchors: string[] = [crdtIdKey(END_MARKER)]
            for (const c of rootTextCharPositions(after)) {
                if (c.offset === -1 && !c.deleted) anchors.push(crdtIdKey(c.id))
            }
            // xochitl keys EACH paragraph's style to its opener id, which can be
            // a TOMBSTONED char (restyle-then-retype leaves the old style on the
            // dead opener — a first-char for para 0, a '\n' for later ones). A
            // stale style on that shadow OVERRIDES the anchor the web writes to,
            // so the device renders the wrong style forever even though our own
            // read agrees with our write (no kind-diff fires). Reconcile every
            // paragraph's shadow anchors to its target style (device-probed
            // 2026-07-10/12, PROBE-v1..v4 / PROBE-nonfirst / PROBE-npfix).
            const shadowsByPara = paragraphStyleShadows(after)
            const styles: [string, number, number[] | undefined][] = []
            for (let i = 0; i < Math.min(lines.length, paras.length); i++) {
                const line = lines[i]!
                const old = line.deviceStyle ?? paras[i]!.style
                const prior = paras[i]!
                const sameKind = nodeKindForParagraph(prior) === line.kind
                const write = sameKind && line.kind === 'bullet2' &&
                    isNativeIndentedPlain(prior.style, prior.indentLevel)
                    ? { value: prior.style }
                    : styleForNodeKind(line.kind, old)
                const extra = write.extra ? [...write.extra] : undefined
                if (!sameKind) {
                    styles.push([anchors[i]!, write.value, extra])
                }
                // Reconcile this paragraph's shadow anchors. Fires independent of
                // the kind-diff above, since the device can disagree with our
                // anchor read while our model looks self-consistent.
                for (const key of shadowsByPara.get(i) ?? []) {
                    const cur = after.styles.get(key)
                    // compare VALUE and the style EXTRA (size/indent): H2/H3 are
                    // value 1 + a size extra, so a shadow already at value 1
                    // (plain) still needs the extra or it renders as plain.
                    const curExtra = cur?.extra
                    const expected = paragraphStyleWriteExtra(curExtra, write.extra)
                    const differs =
                        !cur ||
                        cur.value !== write.value ||
                        (curExtra?.length ?? 0) !== (expected?.length ?? 0) ||
                        (expected?.some((b, j) => b !== curExtra![j]) ?? false)
                    if (differs) styles.push([key, write.value, extra])
                }
            }
            if (styles.length) await this.editRootText({ styles })
            // marks pass: reconcile inline bold/italic (rm format codes 1-4)
            await this.commitDeviceTextMarks(lines)
        } catch (err) {
            console.error('weft: device-text commit failed:', err)
            throw err
        }
        // Replay the render that was skipped while the caret was active.
        if (!this.disposed) this.syncDeviceTextShape()
    }

    /** Make the stored format codes produce the editor's bold/italic runs.
     *  No-op when they already match (planFormatEdits is idempotent). */
    private async commitDeviceTextMarks(lines: RichLine[]): Promise<void> {
        const text = this.session.document.tree().rootText
        if (!text) return
        const target: { bold: boolean; italic: boolean }[] = []
        for (const line of lines) {
            for (const seg of line.segments) {
                // one entry per CODE POINT (planFormatEdits walks code points via
                // expandItem's [...value]); counting UTF-16 units would over-count
                // by one per emoji/astral char and drop the whole mark plan (#79)
                for (const _ch of seg.text) {
                    target.push({ bold: seg.bold, italic: seg.italic })
                }
            }
        }
        const plan = planFormatEdits(text, target)
        if (!plan) {
            console.error('weft: mark reconcile skipped (text diff not settled)')
            return
        }
        if (plan.deleteIds.length === 0 && plan.inserts.length === 0) return
        await this.editRootText({
            ...(plan.deleteIds.length
                ? { deleteKeys: plan.deleteIds.map((id) => crdtIdKey(id)) }
                : {}),
            ...(plan.inserts.length
                ? {
                      inserts: plan.inserts.map((ins) => ({
                          afterKey: ins.afterId ? crdtIdKey(ins.afterId) : null,
                          codes: ins.codes,
                      })),
                  }
                : {}),
        })
    }

    // ----- layers -----

    listLayers(): {
        ref: LayerRef
        key: string
        label: string
        visible: boolean
        active: boolean
    }[] {
        const doc = this.session.document
        const layers = doc.layers()
        const activeKey = this.activeLayerKey(layers)
        return layers.map((l, i) => {
            const ref = layerIdToRef(doc, l.nodeId)
            const key = `${ref.authorUuid ?? '@'}:${ref.clock}`
            return {
                ref,
                key,
                label: l.label || `Layer ${i + 1}`,
                visible: l.visible,
                active: key === activeKey,
            }
        })
    }

    private activeLayerKey(layers: { nodeId: { part1: number; part2: number } }[]): string {
        if (this.activeLayer) {
            return `${this.activeLayer.authorUuid ?? '@'}:${this.activeLayer.clock}`
        }
        const first = layers[0]
        if (!first) return ''
        const ref = layerIdToRef(this.session.document, first.nodeId as never)
        return `${ref.authorUuid ?? '@'}:${ref.clock}`
    }

    setActiveLayer(ref: LayerRef): void {
        this.activeLayer = ref
        this.onLayersChanged?.()
    }

    async createLayer(label: string): Promise<void> {
        await this.trackCommand(this.applyLocal([{ type: 'create-layer', label }], () => this.onLayersChanged?.()))
    }

    async setLayerVisible(ref: LayerRef, visible: boolean): Promise<void> {
        await this.trackCommand(this.applyLocal([{ type: 'set-layer-visible', layer: ref, visible }], () => {
            this.applyLayerVisibility()
            this.onLayersChanged?.()
        }))
    }

    private layerMaskedShapes = new Map<TLShapeId, number>()

    /** Hide/show every editor shape according to its layer's visibility. */
    private applyLayerVisibility(): void {
        const doc = this.session.document
        const hidden = new Set(
            doc
                .layers()
                .filter((l) => !l.visible)
                .map((l) => crdtIdKey(l.nodeId)),
        )
        // Use live group links to expand hidden layers to every descendant.
        const children = hidden.size ? new Map<string, string[]>() : undefined
        const parentOf = new Map<string, string>()
        const resolver = new RefResolver(doc)
        for (const block of doc.blocks) {
            if (children && block.type === 'sceneGroupItem' && !block.deletedLength && block.nodeId) {
                const parent = crdtIdKey(block.parentId)
                const group = crdtIdKey(block.nodeId)
                const siblings = children.get(parent)
                if (siblings) siblings.push(group)
                else children.set(parent, [group])
            }
            if (
                block.type !== 'sceneLineItem' &&
                block.type !== 'sceneGlyphItem' &&
                block.type !== 'sceneImageItem'
            )
                continue
            const ref = resolver.toRef(block.itemId)
            if (ref) {
                parentOf.set(itemRefKey(ref), crdtIdKey(block.parentId))
            }
        }
        if (children) {
            const pending = [...hidden]
            while (pending.length) {
                const parent = pending.pop()!
                for (const group of children.get(parent) ?? []) {
                    if (hidden.has(group)) continue
                    hidden.add(group)
                    pending.push(group)
                }
            }
        }
        this.remote(() => {
            const updates: { id: TLShapeId; type: string; opacity: number }[] = []
            const maskedShapes = new Map<TLShapeId, number>()
            const apply = (shapeId: TLShapeId, itemKey: string | undefined, shown = 1) => {
                if (!itemKey) return
                const parent = parentOf.get(itemKey)
                if (!parent) return
                const shape = this.editor.getShape(shapeId)
                if (!shape) return
                // Keep the editor's unsent value through an unrelated peer repaint,
                // including a hide/show before the edit reaches the overlay.
                const visibleOpacity = this.deferOpacityWhilePending(shapeId)
                    ? (shape.opacity === 0 ? this.layerMaskedShapes.get(shapeId) ?? 0 : shape.opacity)
                    : shown
                const masked = hidden.has(parent)
                if (masked) maskedShapes.set(shapeId, visibleOpacity)
                const want = masked ? 0 : visibleOpacity
                if (shape.opacity !== want) {
                    updates.push({ id: shape.id, type: shape.type, opacity: want })
                }
            }
            for (const [itemKey, shapeId] of this.inkShapes) apply(shapeId, itemKey)
            for (const overlayShape of this.session.currentOverlay.shapes) {
                const firstItem = overlayShape.rendered[0]?.items[0]
                apply(
                    overlayShape.shapeId as TLShapeId,
                    firstItem ? itemRefKey(firstItem) : undefined,
                    displayOpacity(overlayShape),
                )
            }
            this.layerMaskedShapes = maskedShapes
            if (updates.length) {
                this.editor.run(() => this.editor.updateShapes(updates as never), { ignoreShapeLock: true })
            }
        })
    }

    /**
     * Dropped/pasted PNG/JPEG files become EMBEDDED images (E26): bytes go
     * to the page's asset dir on the daemon, placement into the .rm. This
     * replaces tldraw's default file handling for image files.
     * Limitation: requires the daemon to be reachable (asset bytes are not
     * queued offline yet); the op itself is offline-safe.
     */
    private registerImageDrop(): void {
        type FilesContent = {
            type: 'files'
            files: File[]
            point?: { x: number; y: number }
        }
        const editor = this.editor as Editor & {
            registerExternalContentHandler?: (
                type: 'files',
                handler: (content: FilesContent) => Promise<void>,
            ) => void
        }
        editor.registerExternalContentHandler?.('files', (content) => {
            const file = content.files.find((f) => /^image\/(png|jpeg)$/.test(f.type))
            if (!file || this.disposed) return Promise.resolve()
            const center = content.point ?? this.editor.getViewportPageBounds().center
            const { x, y } = center
            const target = this.listLayers().find((layer) => layer.active)
            const scope = libraryCacheScope()
            const ownerIsCurrent = () =>
                !this.disposed && scope !== null && scope === libraryCacheScope() &&
                (this.photoOwner === null || this.photoOwner === scope)
            const checkTarget = () => {
                if (!ownerIsCurrent()) throw new Error('The notebook account changed')
                const layers = this.listLayers()
                if (target ? !layers.some((layer) => layer.key === target.key) : layers.length !== 0) {
                    throw new Error('The original layer is no longer available')
                }
            }
            const insert = async () => {
                const ext = file.type === 'image/jpeg' ? 'jpg' : 'png'
                const assetUuid = uuidv4()
                const filename = `${assetUuid}.${ext}`
                let width: number
                let height: number
                try {
                    checkTarget()
                    const bytes = new Uint8Array(await file.arrayBuffer())
                    const bitmap = await createImageBitmap(file)
                    ;({ width, height } = bitmap)
                    bitmap.close()
                    checkTarget()
                    await this.opts.transport.putAsset(this.opts.docId, this.opts.pageId, filename, bytes, ownerIsCurrent)
                    await seedAssetBytes(
                        `/api/documents/${this.opts.docId}/pages/${this.opts.pageId}/assets/${encodeURIComponent(filename)}`,
                        bytes,
                        scope,
                    )
                    checkTarget()
                } catch (error) {
                    if (!this.disposed) this.opts.onStatus?.({
                        state: 'error',
                        detail: `Image was not inserted: ${String(error)}. Paste or drop it again to retry.`,
                    })
                    throw error
                }

                // Natural pixels as ink units, capped to a sane page footprint.
                const scale = Math.min(1, 900 / Math.max(width, height))
                const w = width * scale
                const h = height * scale
                const x0 = x / RM_SCALE - w / 2
                const y0 = Math.max(0, y / RM_SCALE - h / 2)
                await this.applyLocal([{
                    type: 'insert-image',
                    assetUuid,
                    filename,
                    ...(target ? { layer: target.ref } : {}),
                    vertices: [x0, y0, 0, 0, x0 + w, y0, 1, 0, x0 + w, y0 + h, 1, 1, x0, y0 + h, 0, 1],
                }], () => {
                    this.remote(() => this.renderInkItems(this.ownedItemKeys()))
                })
            }
            // Departure must see the command before its first asynchronous
            // stage. The canvas handler has no caller to surface rejections.
            return this.trackCommand(insert()).catch(() => {})
        })
    }

    /** Project a dragged/resized/rotated rm-image shape to a move-image op. */
    private projectImageMove(shapeId: string): Extract<LocalOp, { type: 'move-image' }> | null {
        const shape = this.editor.getShape(shapeId as TLShapeId)
        if (!shape || shape.type !== 'image') return null
        const entry = [...this.inkShapes.entries()].find(([, id]) => id === shape.id)
        if (!entry) return null
        const [key] = entry
        const [authorUuid, clock] = splitKey(key)
        const props = shape.props as { w: number; h: number }
        const t = this.editor.getShapePageTransform(shape)
        const off = this.inkShapeOff.get(key) ?? NO_ANCHOR
        const corners = mapToRmSpace(
            [
                { x: 0, y: 0 },
                { x: props.w, y: 0 },
                { x: props.w, y: props.h },
                { x: 0, y: props.h },
            ],
            { x: shape.x, y: shape.y, rotation: shape.rotation,
                m: [t.a, t.b, t.c, t.d, t.e - off.dx * RM_SCALE, t.f - off.dy * RM_SCALE] },
        )
        const uv = [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
        ]
        const vertices = corners.flatMap((c, i) => [c.x, c.y, uv[i]![0]!, uv[i]![1]!])
        return { type: 'move-image', item: { authorUuid, clock }, vertices }
    }

    /**
     * A move tombstones + re-appends the item (device-native pattern), so
     * the itemRef changes: rebind every live image item to its tldraw shape
     * by asset uuid (one placement per asset in our documents).
     */
    private remapImageIdentities(projected: ReadonlyMap<string, number[]>): void {
        const doc = this.session.document
        const resolver = new RefResolver(doc)
        // asset uuid -> existing tldraw shape id (from current, now-stale
        // mappings). Rebinding by UUID — not document order — is what keeps
        // multi-image pages correct: a moved image tombstones+re-appends, so
        // file order changes, and an order-based rebind swaps the placements.
        const byUuid = new Map<string, TLShapeId>()
        const offByShape = new Map<TLShapeId, { dx: number; dy: number }>()
        const quadByShape = new Map<string, readonly number[]>()
        for (const [key, id] of this.inkShapes) {
            const shape = this.editor.getShape(id)
            if (shape?.type !== 'image') continue
            const off = this.inkShapeOff.get(key)
            if (off) offByShape.set(id, off)
            // Rebinding one moved photo must not acknowledge a deferred
            // tablet refresh of a different photo.
            const quad = projected.get(id) ?? this.inkImageQuads.get(key)
            if (quad) quadByShape.set(id, quad)
            this.dropInkBinding(key)
            const uuid = this.imageShapeAssetUuid(id)
            if (uuid) byUuid.set(uuid, id)
        }
        const live: LiveImage[] = []
        for (const block of doc.blocks) {
            if (block.type !== 'sceneImageItem' || block.deletedLength > 0 || !block.image) continue
            const ref = resolver.toRef(block.itemId)
            if (!ref) continue
            live.push({
                uuid: bytesToUuidLE(block.image.uuid.value),
                refKey: itemRefKey(ref),
            })
        }
        // UUID-keyed rebind (pure + unit-tested): order-based rebinding swaps
        // placements on multi-image pages because a move reorders the blocks.
        for (const [refKey, shapeId] of remapImagesByUuid(live, byUuid)) {
            this.inkShapes.set(refKey, shapeId as TLShapeId)
            const quad = quadByShape.get(shapeId)
            if (quad) this.inkImageQuads.set(refKey, quad)
            // carry the applied anchor offset across the re-key, or the next
            // reflow would shift the shape by the FULL offset instead of the delta
            const off = offByShape.get(shapeId as TLShapeId)
            if (off) this.inkShapeOff.set(refKey, off)
        }
    }

    /** Bake user move/resize/rotate of tablet ink into the doc: one
     *  transform-ink op replaces each touched item's points with its current
     *  on-canvas geometry (ink units, anchor offset removed; widths from the
     *  ORIGINAL per-point meta so repeated bakes never compound). Returns the
     *  old item keys for post-apply rebinding. */
    private projectInkTransforms(ops: LocalOp[]): string[] {
        if (this.pendingInkTransforms.size === 0) return []
        const doc = this.session.document
        const resolver = new RefResolver(doc)
        const keyByShape = new Map<string, string>()
        for (const [key, id] of this.inkShapes) keyByShape.set(id, key)
        // items referenced by ANY overlay shape (detached included) stay
        // FROZEN: re-keying them would orphan the shape's rendered refs and
        // re-attach would then double-render. Only page-owned ink (device
        // strokes, released strokes) is movable.
        const referenced = new Set<string>()
        for (const sh of this.session.currentOverlay.shapes)
            for (const part of sh.rendered) for (const i of part.items) referenced.add(itemRefKey(i))
        const items: Extract<LocalOp, { type: 'transform-ink' }>['items'] = []
        const keys: string[] = []
        for (const [shapeId, before] of this.pendingInkTransforms) {
            const shape = this.editor.getShape(shapeId as TLShapeId)
            if (!shape || shape.type !== 'draw') continue
            const key = keyByShape.get(shapeId)
            if (!key || referenced.has(key)) continue
            const [authorUuid, clock] = splitKey(key)
            const id = resolver.toId({ authorUuid, clock })
            const block = id ? doc.findLineItem(id) : null
            if (!block || block.deletedLength > 0 || !block.line) continue
            // Portable replay can represent a plain v2 block exactly.
            // Other native records still use the existing transform path.
            if (before && before.parentId === shape.parentId && before.rotation === shape.rotation &&
                sameNativeShapeGeometry(before, shape) && block.version.min === 0 && block.version.current === 2 &&
                block.extraData.length === 0 && block.extraValueData.length === 0) {
                const dx = shape.x - before.x
                const dy = shape.y - before.y
                if (dx !== 0 || dy !== 0) {
                    const parent = this.editor.getShapeParentTransform(shape)
                    const translation = {
                        x: (parent.a * dx + parent.c * dy) / RM_SCALE,
                        y: (parent.b * dx + parent.d * dy) / RM_SCALE,
                    }
                    items.push({
                        ref: { authorUuid, clock },
                        // Older clients can still replay a queued move via the
                        // baked-point form if the browser build is rolled back.
                        points: block.line.points.map(point => ({
                            ...point,
                            x: Math.fround(point.x + translation.x),
                            y: Math.fround(point.y + translation.y),
                        })),
                        translation,
                    })
                    keys.push(key)
                }
                continue
            }
            const props = shape.props as { segments: unknown; scaleX?: number; scaleY?: number }
            const sx = props.scaleX ?? 1
            const sy = props.scaleY ?? 1
            let rel: { x: number; y: number }[]
            try {
                rel = getPointsFromDrawSegments(props.segments as never, sx, sy)
            } catch {
                continue
            }
            if (rel.length < 2) continue
            const xf = this.editor.getShapePageTransform(shape)
            const off = this.inkShapeOff.get(key) ?? { dx: 0, dy: 0 }
            const wScale = (Math.abs(sx) + Math.abs(sy)) / 2
            const meta = shape.meta as { rmPointData?: string }
            const rm = meta.rmPointData ? decodeRmPointData(meta.rmPointData) : []
            const orig = block.line.points
            const points: Point[] = rel.map((v, i) => {
                const abs = xf.applyToPoint(v)
                const base = orig[Math.min(i, orig.length - 1)]!
                const src = rm[Math.min(i, rm.length - 1)]
                return {
                    ...base,
                    ...(src
                        ? {
                              speed: Math.round(src.speed),
                              direction: Math.round(src.direction),
                              pressure: Math.round(src.pressure),
                              width: Math.max(1, Math.round(src.width * wScale)),
                          }
                        : { width: Math.max(1, Math.round(base.width * wScale)) }),
                    x: abs.x / RM_SCALE - off.dx,
                    y: abs.y / RM_SCALE - off.dy,
                }
            })
            items.push({ ref: { authorUuid, clock }, points })
            keys.push(key)
        }
        if (items.length) ops.push({ type: 'transform-ink', items })
        return keys
    }

    /** After a transform-ink apply, the items were re-keyed (tombstone +
     *  re-add with moveId): rebind the live editor shapes to the new keys so
     *  the next reconcile keeps them instead of delete/recreate. */
    private rebindTransformedInk(oldKeys: string[]): void {
        const wanted = new Set(oldKeys)
        const doc = this.session.document
        const resolver = new RefResolver(doc)
        for (const block of doc.blocks) {
            if (block.type !== 'sceneLineItem' || block.deletedLength > 0 || !block.line?.moveId)
                continue
            const oldRef = resolver.toRef(block.line.moveId)
            if (!oldRef) continue
            const oldKey = itemRefKey(oldRef)
            if (!wanted.has(oldKey)) continue
            const shapeId = this.inkShapes.get(oldKey)
            if (shapeId === undefined) continue
            const newRef = resolver.toRef(block.itemId)
            if (!newRef) continue
            const newKey = itemRefKey(newRef)
            const off = this.inkShapeOff.get(oldKey)
            this.dropInkBinding(oldKey)
            this.inkShapes.set(newKey, shapeId)
            this.inkLineSources.set(newKey, block.line)
            if (off) this.inkShapeOff.set(newKey, off)
        }
    }

    /** The asset uuid behind a rendered rm-image shape (its asset's filename
     *  stem, e.g. `<uuid>.png` -> `<uuid>`), or null if not resolvable. */
    private imageShapeAssetUuid(id: TLShapeId): string | null {
        const shape = this.editor.getShape(id)
        if (shape?.type !== 'image') return null
        if (typeof shape.meta.weftNativeImageUuid === 'string') return shape.meta.weftNativeImageUuid
        const assetId = (shape.props as { assetId?: string }).assetId
        if (!assetId) return null
        const asset = this.editor.getAsset(assetId as never) as
            | { props?: { name?: string } }
            | undefined
        const name = asset?.props?.name
        if (!name) return null
        return name.replace(/\.[^.]+$/, '').toLowerCase()
    }

    /** Wall-clock LWW version for an edit (D7): ts = client wall-clock now,
     *  actor = this client's id. Stamped at edit-capture so the edit-time
     *  timestamp — not a later apply/rebase time — decides same-id conflicts. */
    private version(): OpVersion {
        return { ts: Date.now(), actor: this.opts.clientId }
    }

    /** Capture content order before debounce and projection; a leaping peer
     * clock affects only edits to the same browser shape. */
    private shapeEditVersion(id: string): OpVersion {
        const overlay = this.session?.currentOverlay
        const accepted = overlay?.shapes.find(shape => shape.shapeId === id)?.version?.ts
        const deleted = overlay?.tombstones?.[id]?.ts
        const prior = Math.max(accepted ?? 0, deleted ?? 0, this.issuedShapeVersions.get(id) ?? 0)
        const ts = Math.max(Date.now(), Number.isSafeInteger(prior + 1) ? prior + 1 : 0)
        this.issuedShapeVersions.set(id, ts)
        return { ts, actor: this.opts.clientId }
    }

    private captureShapeEdit(id: string): { stamp: OpVersion; revision?: string } {
        return {
            stamp: this.shapeEditVersion(id),
            revision: this.session?.currentOverlay.shapes.find(shape => shape.shapeId === id)?.renderRevision,
        }
    }

    private projectionVersion(id: string, captured: { stamp: OpVersion; revision?: string }): OpVersion {
        const accepted = this.session.currentOverlay.shapes.find(shape => shape.shapeId === id)
        // Opacity and ordering can advance the carrier operation while the
        // projected content stays unchanged. Preserve those writes alongside
        // this edit, but never restamp an edit over a changed projection.
        if (captured.revision && accepted?.renderRevision === captured.revision &&
            accepted.version?.ts >= captured.stamp.ts && Number.isSafeInteger(accepted.version.ts + 1)) {
            return { ...captured.stamp, ts: accepted.version.ts + 1 }
        }
        return captured.stamp
    }

    private browserOrderVersion(stored: OverlayShape | undefined): OpVersion | undefined {
        const version = this.version()
        const seen = (stored?.browserIndexVersion ?? stored?.version)?.ts
        if (seen !== undefined && seen >= version.ts) {
            if (!Number.isSafeInteger(seen + 1)) return
            version.ts = seen + 1
        }
        return version
    }

    private storedOpacity(shapeId: string): number {
        return shapeOpacity(this.session.currentOverlay.shapes.find(shape => shape.shapeId === shapeId)?.opacity) ?? 1
    }

    private projectionOrder(batch: Set<string>): Iterable<string> {
        if (batch.size < 2) return batch
        const fresh = new Set(batch)
        for (const shape of this.session.currentOverlay.shapes) fresh.delete(shape.shapeId)
        if (fresh.size < 2) return batch

        // New strokes append to the native layer. The SDK's event order can
        // differ from its paint order, especially when duplicating groups.
        const ordered = this.editor.getCurrentPageShapesSorted()
            .filter((shape) => fresh.has(shape.id))
            .map((shape) => shape.id)
        if (ordered.length < 2) return batch
        const reordered = new Set<string>(ordered)
        let next = 0
        return Array.from(batch, (id) => reordered.has(id) ? ordered[next++]! : id)
    }

    private projectShape(
        shape: TLShape,
        orderVersion?: OpVersion,
        opacityWrite?: { opacity: number; opacityVersion: OpVersion },
        version = this.shapeEditVersion(shape.id),
    ): LocalOp | null {
        const previous = shape.type === 'arrow'
            ? this.session.currentOverlay.shapes.find(record => record.shapeId === shape.id)?.props
            : undefined
        const base: Omit<OverlayShape, 'rendered' | 'state'> = {
            shapeId: shape.id,
            kind: shape.type as OverlayShape['kind'],
            props: shape.type === 'arrow' ? arrowRecordProps(this.editor, shape,
                previous && typeof previous === 'object' ? previous : undefined) : shape.props,
            x: shape.x,
            y: shape.y,
            rotation: shape.rotation,
            ...opacityWrite,
            ...(orderVersion && { browserIndex: shape.index, browserIndexVersion: orderVersion }),
            renderRevision: hashOf(shape, this.editor),
            version,
        }

        switch (shape.type) {
            case 'draw': {
                const ink = drawShapeToInk(shape as TLDrawShape, colorOf(shape), this.pageMapper(shape))
                if (!ink) return null
                // A dashed/dotted freehand stroke is, on the RM, MANY short
                // strokes — the device has no dash attribute. drawShapeToInk
                // emits ONE continuous stroke (props.dash only tapers it), so
                // before this, geo/line/arrow honored dash but a freehand draw
                // shape silently projected SOLID (owner-reported: "dotted shows
                // on the canvas but stays a solid line on the reMarkable").
                const dash = (shape.props as { dash?: string }).dash
                if (ink.points.length > 1 && (dash === 'dashed' || dash === 'dotted')) {
                    const rendered = this.dashStrokes([ink], shape, dash)
                    if (rendered.length === 0) return null
                    return {
                        type: 'upsert-shape',
                        shape: base,
                        parts: rendered.map((stroke, i) => ({
                            partKey: `contour:${i}`,
                            strokes: [stroke],
                        })),
                        ...(this.activeLayer ? { layer: this.activeLayer } : {}),
                    }
                }
                return {
                    type: 'upsert-shape',
                    shape: { ...base, kind: 'draw-native' },
                    parts: [{ partKey: 'whole', strokes: [ink] }],
                    ...(this.activeLayer ? { layer: this.activeLayer } : {}),
                }
            }
            case 'highlight': {
                // A highlight IS ink — the tablet has a native highlighter. Same
                // freehand geometry as a draw stroke, but stamped with the
                // highlighter brush so it renders as a highlight on-device.
                const ink = drawShapeToInk(
                    shape as unknown as TLDrawShape,
                    colorOf(shape),
                    this.pageMapper(shape),
                )
                if (!ink) return null
                ink.pen = Pen.HIGHLIGHTER_2
                // A highlighter lays down a MUCH wider band than a pen at the
                // same size — the draw-shape width formula alone renders it
                // pen-thin on-device. Widen the band to read as a highlight.
                for (const p of ink.points) p.width = Math.round(p.width * 3.2)
                return {
                    type: 'upsert-shape',
                    shape: { ...base, kind: 'draw-native' },
                    parts: [{ partKey: 'whole', strokes: [ink] }],
                    ...(this.activeLayer ? { layer: this.activeLayer } : {}),
                }
            }
            case 'text': {
                if (!this.font) return null
                const props = shape.props as {
                    richText?: unknown
                    size?: string
                    scale?: number
                    w?: number
                    autoSize?: boolean
                    textAlign?: 'start' | 'middle' | 'end'
                }
                const text = extractPlainText(props)
                if (!text.trim()) return null
                const scale = props.scale ?? 1
                const fontSize = (FONT_SIZES[props.size ?? 'm'] ?? 24) * scale
                // fixed-width text box wraps to props.w (scale folds into fontSize
                // and the width alike); autoSize text only breaks on explicit '\n'.
                const width =
                    props.autoSize === false && typeof props.w === 'number'
                        ? props.w * scale
                        : undefined
                const t = this.editor.getShapePageTransform(shape)
                // browser-measured spans (the SAME layout the DOM rendered);
                // null in tests / when the measurer is unavailable
                const spans = this.measureSpans(text, {
                    fontSize: FONT_SIZES[props.size ?? 'm'] ?? 24,
                    scale,
                    width:
                        props.autoSize === false && typeof props.w === 'number'
                            ? Math.max(16, Math.floor(props.w))
                            : Math.ceil(
                                  this.editor.getShapeGeometry(shape).bounds.w / scale,
                              ) + 2,
                    textAlign: props.textAlign ?? 'start',
                    font: (shape.props as { font?: string }).font,
                })
                const parts = textToGlyphParts(
                    this.font,
                    { text, fontSize },
                    { x: shape.x, y: shape.y, rotation: shape.rotation, m: [t.a, t.b, t.c, t.d, t.e, t.f] },
                    colorOf(shape),
                    spans ? { spans } : { width, align: props.textAlign },
                )
                if (parts.length === 0) return null
                return {
                    type: 'upsert-shape',
                    shape: base,
                    parts,
                    ...(this.activeLayer ? { layer: this.activeLayer } : {}),
                }
            }
            case 'geo':
            case 'arrow':
            case 'line': {
                // Full (solid) body first — arrowheads derive from the real
                // endpoints, so they must be computed BEFORE the body is broken
                // into dash segments.
                const body = this.projectGeometry(shape)
                const dash = (shape.props as { dash?: string }).dash
                const rendered = this.dashStrokes(body, shape, dash)
                // heads stay solid even on a dashed arrow (matches tldraw)
                if (shape.type === 'arrow') rendered.push(...this.projectArrowheads(shape, body))
                const parts: { partKey: string; strokes: InkStroke[] }[] = []
                // FILL first (under the outline): the RM has no fill primitive, so
                // a filled geo shape reads HOLLOW on-device unless we hatch it.
                const fill = (shape.props as { fill?: string }).fill
                if (shape.type === 'geo' && fill && fill !== 'none') {
                    this.projectFill(shape, body, fill).forEach((s, i) =>
                        parts.push({ partKey: `fill:${i}`, strokes: [s] }),
                    )
                }
                rendered.forEach((stroke, i) => parts.push({ partKey: `contour:${i}`, strokes: [stroke] }))
                // LABEL: text typed inside a shape (a rectangle/arrow/line label)
                // renders on the web but was dropped from the tablet entirely.
                const label = extractPlainText(shape.props as { richText?: unknown; text?: string })
                if (this.font && label.trim()) parts.push(...this.projectLabel(shape, label))
                if (parts.length === 0) return null
                return {
                    type: 'upsert-shape',
                    shape: base,
                    parts,
                    ...(this.activeLayer ? { layer: this.activeLayer } : {}),
                }
            }
            case 'note': {
                // a sticky note is a filled square + centered text on the web;
                // it was dropped entirely on the tablet. RM can't do the color
                // fill, so project the square OUTLINE + the note's label (its
                // whole point) — the note's content survives to the device.
                const body = this.projectGeometry(shape)
                const parts: { partKey: string; strokes: InkStroke[] }[] = body.map((stroke, i) => ({
                    partKey: `contour:${i}`,
                    strokes: [stroke],
                }))
                const label = extractPlainText(shape.props as { richText?: unknown; text?: string })
                if (this.font && label.trim()) parts.push(...this.projectLabel(shape, label))
                if (parts.length === 0) return null
                return {
                    type: 'upsert-shape',
                    shape: base,
                    parts,
                    ...(this.activeLayer ? { layer: this.activeLayer } : {}),
                }
            }
            default:
                return null
        }
    }

    /** Shape-LOCAL point -> RM page coords, composing the shape's full PAGE
     *  transform (group/frame parents, ancestor + own rotation). raw shape.x/y
     *  are parent-local for a nested child and place ink at the wrong spot —
     *  every shape type must map through this, as geo/arrow/line do. */
    private pageMapper(shape: TLShape): (p: { x: number; y: number }) => { x: number; y: number } {
        const t = this.editor.getShapePageTransform(shape)
        return (p) => {
            const pg = t.applyToPoint(p)
            return { x: pg.x / RM_SCALE, y: pg.y / RM_SCALE }
        }
    }

    private projectGeometry(shape: TLShape): InkStroke[] {
        const geometry = this.editor.getShapeGeometry(shape)
        const props = shape.props as { size?: string; scale?: number; dash?: string }
        const sw = (STROKE_SIZES[props.size ?? 'm'] ?? 3.5) * (props.scale ?? 1)
        const width = tldrawWidthToRmMarkerWidth(sw)
        const color = colorOf(shape)
        const toRm = this.pageMapper(shape)
        // dash:'draw' shapes render through PathBuilder.toDrawD (rounded
        // corners + seeded wobble) — projecting the raw skeleton shipped
        // sharp CAD corners to the tablet while the web drew them smooth
        // (owner: hexagon/cloud "extremely rough, sharp corners")
        const draw =
            props.dash === 'draw' ? { strokeWidth: sw, randomSeed: shape.id } : undefined
        return collectSubpaths(geometry, draw).map((pts) => ({
            points: polylineToPoints(pts.map(toRm), { width }),
            color,
        }))
    }

    /** Hatch-fill a filled geo shape's interior — the RM has no fill, so a
     *  filled rectangle/ellipse is otherwise a hollow outline on-device. Uses
     *  the SOLID outline contours (pre-dash), scanline-filled; 'semi'/'pattern'
     *  hatch sparser so they read lighter, as they do on the web. */
    private projectFill(shape: TLShape, body: InkStroke[], fill: string): InkStroke[] {
        const props = shape.props as { size?: string; scale?: number }
        const sw = (STROKE_SIZES[props.size ?? 'm'] ?? 3.5) * (props.scale ?? 1)
        const width = tldrawWidthToRmMarkerWidth(sw)
        const rmSw = sw / RM_SCALE
        const pitch = Math.max(rmSw * (fill === 'solid' ? 1.4 : 3), 3)
        const contours = body.map((s) => s.points.map((p) => ({ x: p.x, y: p.y })))
        const color = body[0]?.color ?? colorOf(shape)
        const out: InkStroke[] = []
        for (const line of fillContours(contours, pitch)) {
            if (line.length >= 2) out.push({ points: polylineToPoints(line, { width }), color })
        }
        return out
    }

    /** The browser's own text layout via tldraw's TextManager: the exact
     *  word runs and rects the DOM rendered. Any re-implemented wrap drifts
     *  (break-word, letter-spacing, hinting) — the owner read the drift as
     *  "a different render path" on the device. Returns null when the
     *  measurer is unavailable (tests, no DOM); callers fall back to the
     *  internal wrap. Coordinates come back SCALED (shape-local px). */
    private measureSpans(
        text: string,
        opts: { fontSize: number; scale: number; width: number; textAlign: string; font?: string },
    ): { text: string; x: number; y: number; w: number; h: number; offsets?: number[] }[] | null {
        try {
            const tm = (
                this.editor as unknown as {
                    textMeasure?: {
                        measureTextSpans(
                            t: string,
                            o: Record<string, unknown>,
                        ): { text: string; box: { x: number; y: number; w: number; h: number } }[]
                        measureText?: (t: string, o: Record<string, unknown>) => { w: number }
                    }
                }
            ).textMeasure
            if (!tm?.measureTextSpans) return null
            const family =
                (DefaultFontFamilies as Record<string, string>)[opts.font ?? 'draw'] ??
                DefaultFontFamilies.draw
            // font + padding styles shared by BOTH measureTextSpans and the
            // per-glyph measureText calls, so prefix widths match the span
            // metric exactly (getMeasureStyles reads padding — it must be 0).
            const measureOpts = {
                fontSize: opts.fontSize,
                fontWeight: 'normal',
                fontStyle: 'normal',
                fontFamily: family,
                lineHeight: 1.35,
                padding: 0,
            }
            // measure UNSCALED like tldraw does (scale is a CSS transform on
            // the rendered shape), then fold the scale into the rects
            const spans = tm.measureTextSpans(text, {
                overflow: 'wrap',
                width: opts.width,
                height: 100000,
                textAlign: opts.textAlign,
                ...measureOpts,
            })
            const s = opts.scale
            // Per-glyph pen offsets from the browser's OWN prefix widths. These
            // are suffix-independent (measuring "Re" never changes when the word
            // later becomes "Remarkable"), so appending a glyph leaves every
            // earlier glyph's projected strokes byte-identical — killing the
            // whole-word re-mint churn that span.w/total drift caused (the fit
            // ratio decays as a word grows because span.w carries a ~constant
            // measurement overhead; see textToGlyphParts). measureText is the
            // same DOM text metric tldraw uses; one call per glyph, on the
            // debounced projection path. If it's unavailable, omit offsets and
            // textToGlyphParts falls back to the (fidelity-correct) fit scaling.
            const measure = tm.measureText
            return spans.map((sp) => {
                let offsets: number[] | undefined
                // offset[i] = browser pen x of glyph i = width of the first i
                // chars (offset[0] = 0). Prefix widths are suffix-independent, so
                // they never move as the word grows. One measure per glyph — a
                // span is a whitespace-delimited word, so this is a handful of
                // calls; cap it so a pathological long token can't spam the DOM
                // (that span just falls back to fit scaling, which is fine for a
                // single run — the churn only bit repeated per-keystroke edits).
                if (measure && sp.text.length <= 64) {
                    const chars = [...sp.text]
                    offsets = chars.map((_, i) =>
                        i === 0 ? 0 : measure(chars.slice(0, i).join(''), measureOpts).w * s,
                    )
                }
                return {
                    text: sp.text,
                    x: sp.box.x * s,
                    y: sp.box.y * s,
                    w: sp.box.w * s,
                    h: sp.box.h * s,
                    ...(offsets ? { offsets } : {}),
                }
            })
        } catch {
            return null
        }
    }

    /** Project a shape's text LABEL (a rectangle/ellipse/arrow/line label),
     *  wrapped to the shape width and centered in its bounds like tldraw draws
     *  it. Local glyph coords are composed with the shape page transform so a
     *  grouped/rotated shape's label follows. */
    private projectLabel(shape: TLShape, label: string): { partKey: string; strokes: InkStroke[] }[] {
        if (!this.font) return []
        const props = shape.props as {
            size?: string
            scale?: number
            align?: string
            verticalAlign?: string
        }
        const scale = props.scale ?? 1
        // LABELS are not text shapes: tldraw renders them at LABEL_FONT_SIZES
        // (16px theme base x 1.125/1.375/1.625/2) inset by LABEL_PADDING=16,
        // wrapped to max(minWidth + stroke, w/scale - 2*padding). Projecting
        // with the TEXT sizes (m=24 vs 22) wrapped differently ("llj" stayed
        // together on the device while the browser broke "ll"/"j").
        const size = (props.size ?? 'm') as 's' | 'm' | 'l' | 'xl'
        const LABEL_SIZES = { s: 18, m: 22, l: 26, xl: 32 } as const
        const LABEL_MIN_W = { s: 12, m: 14, l: 16, xl: 20 } as const
        const LABEL_STROKES = { s: 1, m: 1.75, l: 2.5, xl: 5 } as const
        const LABEL_PAD = 16
        const fontSize = LABEL_SIZES[size] * scale
        const bounds = this.editor.getShapeGeometry(shape).bounds
        const pad = LABEL_PAD * scale
        const wrapW = Math.max(
            Math.ceil(LABEL_MIN_W[size] + 2 * LABEL_STROKES[size]),
            Math.ceil(bounds.w / scale - LABEL_PAD * 2),
        )
        const innerW = wrapW * scale
        const lineHeight = 1.35
        const align =
            props.align === 'end' || props.align === 'start' || props.align === 'middle'
                ? props.align
                : 'middle'
        const spans = this.measureSpans(label, {
            fontSize: LABEL_SIZES[size],
            scale,
            width: wrapW,
            textAlign: align,
            font: (shape.props as { font?: string }).font,
        })
        const blockH = spans?.length
            ? Math.max(...spans.map((s) => s.y + s.h)) - Math.min(...spans.map((s) => s.y))
            : wrappedLineCount(this.font, { text: label, fontSize }, innerW) *
              fontSize *
              lineHeight
        // top-left of the text block in shape-LOCAL px: horizontally inset by
        // the pad; vertical follows verticalAlign (default middle, as tldraw).
        const originX = bounds.x + pad
        const originY =
            props.verticalAlign === 'start'
                ? bounds.y + pad
                : props.verticalAlign === 'end'
                  ? bounds.y + bounds.h - pad - blockH
                  : bounds.y + Math.max(0, (bounds.h - blockH) / 2)
        const t = this.editor.getShapePageTransform(shape)
        // compose t with the local (originX, originY) translate (see toRmSpace):
        const m: [number, number, number, number, number, number] = [
            t.a,
            t.b,
            t.c,
            t.d,
            t.a * originX + t.c * originY + t.e,
            t.b * originX + t.d * originY + t.f,
        ]
        return textToGlyphParts(
            this.font,
            { text: label, fontSize },
            { x: shape.x, y: shape.y, rotation: shape.rotation, m },
            colorOf(shape),
            spans
                ? { spans }
                : { width: innerW, align: align as 'start' | 'middle' | 'end' },
        ).map((p) => ({ partKey: `label:${p.partKey}`, strokes: p.strokes }))
    }

    /** Break body strokes into dash segments when the shape's dash style is
     *  'dashed'/'dotted' (RM has no dash attribute — a dashed line IS many
     *  short strokes). 'draw'/'solid'/undefined pass through unchanged. */
    private dashStrokes(
        strokes: InkStroke[],
        shape: TLShape,
        dash: string | undefined,
    ): InkStroke[] {
        if (dash !== 'dashed' && dash !== 'dotted') return strokes
        const props = shape.props as { size?: string; scale?: number }
        const sw = (STROKE_SIZES[props.size ?? 'm'] ?? 3.5) * (props.scale ?? 1)
        const width = tldrawWidthToRmMarkerWidth(sw)
        // dash sizing works in RM units (the stroke points are already RM space)
        const rmWidth = sw / RM_SCALE
        const out: InkStroke[] = []
        for (const stroke of strokes) {
            const pts = stroke.points.map((p) => ({ x: p.x, y: p.y }))
            let total = 0
            for (let i = 1; i < pts.length; i++) {
                total += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)
            }
            if (dash === 'dotted') {
                // geometry-true circles; half pen width so the dot reads
                // ~strokeWidth across (circle radius carries the other half)
                for (const dot of dottedDots(pts, total, rmWidth)) {
                    if (dot.length >= 2) {
                        out.push({
                            points: polylineToPoints(dot, { width: width / 2 }),
                            color: stroke.color,
                        })
                    }
                }
                continue
            }
            for (const seg of applyDashPattern(pts, total, rmWidth, dash)) {
                if (seg.length >= 2) {
                    out.push({ points: polylineToPoints(seg, { width }), color: stroke.color })
                }
            }
        }
        return out
    }

    /**
     * Arrowheads are NOT part of tldraw's shape geometry (only the body is;
     * heads are drawn by the component) — derive them from the body's end
     * tangents, like the renderer does, and draw the SPECIFIC head type
     * (arrow/triangle/diamond/dot/square/bar/pipe/inverted) as ink outlines.
     * 'none' suppresses. Body points are already in RM page space here.
     */
    private projectArrowheads(shape: TLShape, bodyStrokes: InkStroke[]): InkStroke[] {
        const body = bodyStrokes[0]
        if (!body || body.points.length < 2) return []
        const props = shape.props as {
            size?: string
            scale?: number
            arrowheadStart?: string
            arrowheadEnd?: string
        }
        const sw = (STROKE_SIZES[props.size ?? 'm'] ?? 3.5) * (props.scale ?? 1)
        const width = tldrawWidthToRmMarkerWidth(sw)
        const color = body.color
        // tldraw heads are ~4x stroke size in page px -> RM units
        const len = (sw * 4) / RM_SCALE
        const ANGLE = Math.PI / 6

        const head = (
            tip: { x: number; y: number },
            from: { x: number; y: number },
            type: string,
        ): InkStroke[] => {
            if (type === 'none') return []
            const dx = tip.x - from.x
            const dy = tip.y - from.y
            if (Math.hypot(dx, dy) < 1e-3) return []
            const theta = Math.atan2(dy, dx)
            const ux = Math.cos(theta)
            const uy = Math.sin(theta) // forward unit (from -> tip)
            const px = -uy
            const py = ux // perpendicular unit
            const back = (d: number) => ({ x: tip.x - d * ux, y: tip.y - d * uy })
            const off = (base: { x: number; y: number }, d: number) => ({
                x: base.x + d * px,
                y: base.y + d * py,
            })
            const wing = (side: number) => ({
                x: tip.x - len * Math.cos(theta + side * ANGLE),
                y: tip.y - len * Math.sin(theta + side * ANGLE),
            })
            const stroke = (poly: { x: number; y: number }[]): InkStroke => ({
                points: polylineToPoints(poly, { width }),
                color,
            })
            const circle = (c: { x: number; y: number }, r: number): { x: number; y: number }[] => {
                const poly: { x: number; y: number }[] = []
                for (let k = 0; k <= 14; k++) {
                    const a = (k / 14) * Math.PI * 2
                    poly.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) })
                }
                return poly
            }
            switch (type) {
                case 'triangle': {
                    // closed filled-look triangle: two wings + base back to start
                    const w1 = wing(1)
                    const w2 = wing(-1)
                    return [stroke([w1, tip, w2, w1])]
                }
                case 'inverted': {
                    // triangle pointing BACK along the line: base bar across the
                    // tip, apex behind it (the old code apexed AT the tip, which
                    // is just a forward 'triangle' head — indistinguishable).
                    const apex = back(len)
                    return [stroke([off(tip, len * 0.5), apex, off(tip, -len * 0.5), off(tip, len * 0.5)])]
                }
                case 'diamond': {
                    const mid = back(len / 2)
                    const b = back(len)
                    return [stroke([tip, off(mid, len * 0.5), b, off(mid, -len * 0.5), tip])]
                }
                case 'dot': {
                    const c = back(len / 2)
                    return [stroke(circle(c, len / 2))]
                }
                case 'square': {
                    const b = back(len)
                    return [
                        stroke([
                            off(tip, len * 0.5),
                            off(b, len * 0.5),
                            off(b, -len * 0.5),
                            off(tip, -len * 0.5),
                            off(tip, len * 0.5),
                        ]),
                    ]
                }
                case 'bar':
                case 'pipe': {
                    // a perpendicular bar across the tip
                    return [stroke([off(tip, len * 0.6), off(tip, -len * 0.6)])]
                }
                case 'arrow':
                default: {
                    return [stroke([wing(1), tip, wing(-1)])]
                }
            }
        }

        const pts = body.points
        const out: InkStroke[] = []
        out.push(
            ...head(
                pts[pts.length - 1]!,
                pts[pts.length - 2]!,
                props.arrowheadEnd ?? 'arrow',
            ),
        )
        out.push(...head(pts[0]!, pts[1]!, props.arrowheadStart ?? 'none'))
        return out
    }

    // ----- engine -> view -----

    private onPatches(patches: readonly ViewPatch[]): void {
        // a reconcile already in flight when the page was switched away can
        // resolve after dispose(); the editor is shared and persistent, so a
        // dead session must never paint its page onto whatever page is shown now.
        if (this.disposed) return
        // A peer update can land before the SDK delivers this frame's user
        // changes. Record those edits before resolving their display gaps.
        if (this.browserOrderTies.size) this.editor.store._flushHistory()
        let inkChanged = false
        let visibilityChanged = false
        let orderChanged = false
        const paintInk = () => {
            if (!inkChanged) return
            inkChanged = false
            this.renderInkItems(this.ownedItemKeys())
        }
        const applyPatch = (patch: ViewPatch) => {
            switch (patch.type) {
                case 'ink-added': {
                    inkChanged = visibilityChanged = true
                    break
                }
                case 'ink-removed': {
                    const toDelete: TLShapeId[] = []
                    for (const ref of patch.items) {
                        const id = this.inkShapes.get(itemRefKey(ref))
                        if (!id) continue
                        // an rm-image being moved/resized right now: the device
                        // re-keyed its item, but deleting the shape would drop
                        // the user's drag — remapImageIdentities rebinds on flush
                        if (this.pendingImageMoves.has(id)) continue
                        toDelete.push(id)
                        this.dropInkBinding(itemRefKey(ref))
                    }
                    if (toDelete.length) this.editor.deleteShapes(toDelete)
                    break
                }
                case 'shape-edited': {
                    if (patch.edit.kind === 'text-truncate-glyphs') {
                        void this.repairText(patch.shapeId, patch.edit.removedGlyphIndices)
                    }
                    break
                }
                case 'shape-removed': {
                    // tablet deleted or MOVED all of this shape's ink: the
                    // editable shape dissolves; moved ink (if any) arrives
                    // separately as foreign strokes via ink-added/render.
                    // EXCEPT mid-edit: an un-flushed local edit is newer than
                    // the removal — deleting under the drag both breaks the
                    // gesture and discards the edit; the flush re-projects
                    // and LWW settles it (same rule as shape-upserted).
                    if (this.hasUnprojectedShape(patch.shapeId)) break
                    const removed = this.editor.getShape(patch.shapeId as TLShapeId)
                    if (removed) this.editor.deleteShape(removed.id)
                    orderChanged ||= this.browserOrderTies.size > 0
                    break
                }
                case 'shape-moved': {
                    // tablet block-moved the shape's ink: follow it (deltas
                    // are ink units; overlay x/y were already shifted engine-
                    // side, this mirrors it onto the live editor shape)
                    const movedShape = this.editor.getShape(patch.shapeId as TLShapeId)
                    if (movedShape && !this.pendingShapeIds.has(movedShape.id)) {
                        this.editor.updateShape({
                            id: movedShape.id,
                            type: movedShape.type,
                            x: movedShape.x + patch.dx * RM_SCALE,
                            y: movedShape.y + patch.dy * RM_SCALE,
                        })
                    }
                    break
                }
                case 'shape-detached': {
                    const shape = this.editor.getShape(patch.shapeId as TLShapeId)
                    if (shape) {
                        // GHOST the stale shape: the tablet's diverged ink now
                        // renders alongside it, and both at full opacity read
                        // as a broken double-render (owner screenshot). The
                        // faded shape shows what RE-ATTACH would restore; the
                        // crisp ink is the device truth.
                        this.editor.updateShape({
                            id: shape.id,
                            type: shape.type,
                            opacity: this.storedOpacity(shape.id) * DETACHED_OPACITY,
                            meta: { ...shape.meta, detached: true },
                        })
                    }
                    // the shape no longer owns its ink: render the surviving
                    // device strokes crisp (the ghost alone reads as blank)
                    inkChanged = visibilityChanged = true
                    break
                }
                case 'shape-upserted': {
                    if (!this.canRenderOverlayShape(patch.shape)) {
                        const id = patch.shape.shapeId
                        if (typeof id === 'string' && isShapeId(id) && id !== 'shape:device-text' &&
                            !this.pendingShapeIds.has(id)) {
                            const live = this.editor.getShape(id)
                            if (live && !live.meta.rmBrush && (live.meta.weft === true || this.projectedShapeIds.has(id))) {
                                this.hideUnreadableShapes([id])
                            }
                        }
                        // Keep the record in the session and show its tablet
                        // ink even though this editor cannot show the shape.
                        inkChanged = visibilityChanged = true
                        break
                    }
                    // Keep new semantic shapes above the newly imported native ink.
                    paintInk()
                    visibilityChanged = true
                    // a foreign weft client added/updated a semantic shape
                    // (op-mode overlay merge). Its rendered ink may already be
                    // on the canvas as loose ink (a prior ink-added in the same
                    // batch landed before overlay ownership) — reclaim it so the
                    // native shape doesn't double-render.
                    for (const part of patch.shape.rendered) {
                        for (const ref of part.items) {
                            const k = itemRefKey(ref)
                            const loose = this.inkShapes.get(k)
                            if (loose) {
                                this.editor.deleteShapes([loose])
                                this.dropInkBinding(k)
                            }
                        }
                    }
                    // an un-flushed local edit (mid-drag/resize) must not be
                    // snapped back to the foreign state — our projection flushes
                    // in <200ms and LWW resolves the conflict by version
                    if (this.deferOpacityWhilePending(patch.shape.shapeId)) {
                        break
                    }
                    const def = {
                        id: patch.shape.shapeId as TLShapeId,
                        type: overlayShapeType(patch.shape.kind),
                        x: patch.shape.x,
                        y: patch.shape.y,
                        rotation: patch.shape.rotation,
                        index: this.displayIndex(patch.shape),
                        props: browserOverlayProps(patch.shape) as never,
                        opacity: displayOpacity(patch.shape),
                        meta: { weft: true, detached: patch.shape.state === 'detached' },
                    }
                    if (this.editor.getShape(def.id)) this.editor.updateShape(def)
                    else this.editor.createShape(def)
                    break
                }
                case 'document-replaced': {
                    // op-mode bootstrap / re-bootstrap: the whole base was
                    // replaced (snapshot reconstruct). Reconcile the editor to
                    // the new state INCREMENTALLY — update in place, delete only
                    // what left the doc — instead of clear-all + rebuild, which
                    // flashed the entire canvas on every device echo (device-text
                    // pages snapshot on each tablet save). Un-flushed local edits
                    // are preserved (pendingShapeIds is honored in the reconcile
                    // and in renderSceneShapes); the PDF/template underlay is a
                    // separate React layer, untouched either way.
                    this.reconcileToSessionState()
                    for (const [id, file] of this.nativeImageFiles) this.loadNativeImage(id, file, true)
                    break
                }
            }
        }
        this.editor.run(() => this.remote(() => {
            for (const patch of patches) {
                if (patch.type === 'shape-upserted') {
                    orderChanged ||= patch.shape.browserIndex !== undefined || this.browserOrderTies.size > 0
                }
                applyPatch(patch)
            }
            if (patches.some(patch => patch.type === 'shape-upserted')) this.restoreOverlayArrowLinks()
            paintInk()
            if (orderChanged) this.applyBrowserOrderTies()
            if (visibilityChanged) this.applyLayerVisibility()
        }), { history: 'ignore' })
    }

    /** ABCD -> ABC: apply the inverse edit to the live text shape. */
    private async repairText(shapeId: string, removedGlyphIndices: number[]): Promise<void> {
        const shape = this.editor.getShape(shapeId as TLShapeId)
        if (!shape || shape.type !== 'text') return
        const editVersion = this.pendingShapeVersions.get(shapeId)?.stamp ?? this.shapeEditVersion(shapeId)
        const richText = eraseRichTextGlyphs(shape.props.richText, removedGlyphIndices)
        if (richText === shape.props.richText) return
        this.remote(() => {
            this.editor.updateShape({
                id: shape.id,
                type: 'text',
                props: { richText },
            })
        })
        // Re-project the repaired text so the overlay/projection converge.
        const updated = this.editor.getShape(shapeId as TLShapeId)
        if (updated) {
            if (!this.font) {
                if (!(await this.ensureFont()) || this.disposed || this.editor.getShape(updated.id) !== updated) return
            }
            const op = this.projectShape(updated, undefined, undefined, editVersion)
            if (op) await this.session.apply([op])
        }
    }
}

// ----- helpers -----

const DETACHED_OPACITY = 0.25

function displayOpacity(shape: OverlayShape): number {
    return (shapeOpacity(shape.opacity) ?? 1) * (shape.state === 'detached' ? DETACHED_OPACITY : 1)
}

// A parent removed by an ungroup still defines the previous page pose.
function previousPageTransform(shape: TLShape, lookup: (id: TLShapeId) => TLShape | undefined): Mat | undefined {
    let transform = Mat.Translate(shape.x, shape.y).rotate(shape.rotation)
    const seen = new Set([shape.id])
    while (!isPageId(shape.parentId)) {
        const parent = lookup(shape.parentId)
        if (!parent || seen.has(parent.id)) return
        seen.add(parent.id)
        transform = Mat.Compose(Mat.Translate(parent.x, parent.y).rotate(parent.rotation), transform)
        shape = parent
    }
    return transform
}

function samePageTransform(a: Mat, b: Mat): boolean {
    return (['a', 'b', 'c', 'd', 'e', 'f'] as const).every(axis => Math.abs(a[axis] - b[axis]) < 1e-9)
}

function sameNativeShapeGeometry(before: TLShape, after: TLShape): boolean {
    if (before.type === 'image' && after.type === 'image') {
        return before.props.w === after.props.w && before.props.h === after.props.h
    }
    if (before.type === 'draw' && after.type === 'draw') {
        return before.props.segments === after.props.segments &&
            before.props.scaleX === after.props.scaleX && before.props.scaleY === after.props.scaleY
    }
    return false
}

function splitKey(key: string): [string, number] {
    const idx = key.lastIndexOf(':')
    return [key.slice(0, idx), Number(key.slice(idx + 1))]
}

function colorOf(shape: TLShape): string {
    return ((shape.props as { color?: string }).color ?? 'black') as string
}

/** Bump a KIND's entry when the projection pipeline changes what it draws
 *  for that kind (baseline math, font, wrap, wobble, dots): it invalidates
 *  those shapes' stored renderRevision, so each re-projects ONCE on its
 *  next open instead of keeping stale device ink forever (owner: the heart
 *  label's old wrap survived the fix). PER KIND, not global — a global bump
 *  mass-re-projected every shape on every seeded page at once, which raced
 *  the device-text flows. History: text 2 = Informal font + spans layout;
 *  label kinds 3 = LABEL_FONT_SIZES/padding fix.
 */
const PROJECTION_VERSION: Record<string, number> = {
    // the RM_SCALE 72->144 unit change re-projects EVERY kind once: old
    // web-authored ink was written at the huge ratio and shrinks to its
    // device-natural size on the next open of its page
    text: 3,
    geo: 4,
    arrow: 4,
    line: 4,
    note: 4,
    draw: 2,
    highlight: 2,
}

function browserOverlayProps(shape: OverlayShape): unknown {
    return shape.kind === 'arrow' && shape.props && typeof shape.props === 'object'
        ? unpackArrowProps(shape.props).props
        : shape.props
}

function hashOf(shape: TLShape, editor: Editor): string {
    // the PAGE transform, not just local x/y: a child of a moved FRAME keeps
    // its frame-local coords, and a props-only hash made the content-
    // idempotence guard skip its re-projection (frame contents stopped
    // following on the tablet)
    const t = editor.getShapePageTransform(shape)
    // Ignore equivalent TipTap default attrs so hydration does not reproject glyphs.
    const saved = shape.type === 'arrow' ? arrowRecordProps(editor, shape) : shape.props
    const props = saved as { richText?: unknown }
    const p =
        props && props.richText !== undefined
            ? { ...props, richText: canonicalRichText(props.richText) }
            : saved
    const json = JSON.stringify({
        v: PROJECTION_VERSION[shape.type] ?? 1,
        p,
        m: [t.a, t.b, t.c, t.d, Math.round(t.e * 100), Math.round(t.f * 100)],
    })
    let hash = 0x811c9dc5
    for (let i = 0; i < json.length; i++) {
        hash ^= json.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16)
}

/**
 * Flatten any tldraw Geometry2d into polylines. PathBuilder (when present)
 * gives curve-resolved paths; ARROWS have no PathBuilder — their body and
 * arrowheads are plain geometries — so fall back to each geometry's own
 * vertices. Group children are all visited (this is what puts arrowheads
 * on the tablet), labels skipped.
 */
function collectSubpaths(
    geometry: unknown,
    draw?: { strokeWidth: number; randomSeed: string },
): { x: number; y: number }[][] {
    const out: { x: number; y: number }[][] = []
    // A multi-subpath PathBuilder (x-box, check-box) is exposed by tldraw as a
    // Group2d of N children that ALL share the SAME PathBuilder object, and
    // pathBuilderCommands returns the WHOLE command list — so walking it once
    // already yields all N subpaths. Walking per child gave N² overlapping
    // strokes. Dedup by path identity: walk each distinct PathBuilder once.
    const seenPaths = new Set<unknown>()
    const visit = (g: unknown): void => {
        const node = g as {
            children?: unknown[]
            isLabel?: boolean
            path?: unknown
            vertices?: { x: number; y: number }[]
            isClosed?: boolean
        }
        if (node.isLabel) return
        if (Array.isArray(node.children)) {
            for (const child of node.children) visit(child)
            return
        }
        if (node.path) {
            if (seenPaths.has(node.path)) return
            seenPaths.add(node.path)
            if (draw) {
                // ship the SAME hand-drawn outline the browser renders for
                // dash:'draw' (default toDrawD passes/offset/roundness match
                // toSvg's draw style; the seed makes it deterministic)
                try {
                    const d = (
                        node.path as {
                            toDrawD: (o: { strokeWidth: number; randomSeed: string }) => string
                        }
                    ).toDrawD({ strokeWidth: draw.strokeWidth, randomSeed: draw.randomSeed })
                    out.push(...flattenSvgD(d))
                    return
                } catch {
                    // fall through to the skeleton path
                }
            }
            out.push(...walkPathCommands(pathBuilderCommands(node.path as never)))
            return
        }
        const v = node.vertices
        if (Array.isArray(v) && v.length >= 2) {
            const pts = v.map((p) => ({ x: p.x, y: p.y }))
            if (node.isClosed && pts.length >= 3) pts.push({ ...pts[0]! })
            out.push(pts)
        }
    }
    visit(geometry)
    return out
}

function needsProjectionFont(shape?: TLShape): boolean {
    if (!shape) return false
    if (shape.type === 'text') return true
    return (shape.type === 'geo' || shape.type === 'arrow' || shape.type === 'line' || shape.type === 'note') &&
        !!extractPlainText(shape.props as { richText?: unknown; text?: string }).trim()
}

function extractPlainText(props: { richText?: unknown; text?: string }): string {
    if (props.richText) {
        try {
            const root =
                typeof props.richText === 'string' ? JSON.parse(props.richText) : props.richText
            return textFromNode(root)
        } catch {
            // fall through
        }
    }
    return props.text ?? ''
}
