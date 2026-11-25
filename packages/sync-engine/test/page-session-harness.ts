/**
 * PageSession — TEST HARNESS ONLY, predecessor to OfflineSession (the app's
 * real session). Kept because ~18 behavior pins exercise the shared
 * differ/reconciler/audit machinery via the still-live legacy blob-CAS
 * protocol. Must never be exported from src again.
 */

import { RmDocument, Pen } from '@weft/rm-format'
import { tldrawColorToPenColor, type InkStroke } from '@weft/rm-ink/pure'
import { diffPage, emptyKnownState, snapshotKnownState, type KnownState } from '../src/differ'
import { auditOverlay, reconcile } from '../src/reconciler'
import { RefResolver } from '../src/refs'
import {
    EngineFailure,
    itemRefKey,
    type ItemRef,
    type OverlayDocument,
    type OverlayShape,
    type RenderedPart,
    type ViewPatch,
} from '../src/types'
import type { PageEvent, Transport } from '../src/transport'

export type { ProjectedPart, LocalOp } from '../src/apply-ops'
import { applyOps, type LocalOp } from '../src/apply-ops'

export interface SessionOptions {
    clientId: string
    /** Engine author UUID registered in the page's AuthorIds table. */
    authorUuid: string
    /** Called with patches the view must apply. */
    onPatch: (patch: ViewPatch) => void
    /** RM pen used for projected strokes. */
    pen?: Pen
    maxRebases?: number
}

export class PageSession {
    private doc: RmDocument
    private revision: string
    private overlay: OverlayDocument
    private known: KnownState
    private writing = false
    private queue: LocalOp[] = []
    private lastWrittenRevision: string | null = null
    private unsubscribe: () => void

    private constructor(
        private readonly transport: Transport,
        readonly docId: string,
        readonly pageId: string,
        private readonly opts: SessionOptions,
        doc: RmDocument,
        revision: string,
        overlay: OverlayDocument,
    ) {
        this.doc = doc
        this.revision = revision
        this.overlay = overlay
        this.known = snapshotKnownState(doc)
        this.unsubscribe = transport.subscribe((event) => {
            void this.onRemote(event)
        })
    }

    static async open(
        transport: Transport,
        docId: string,
        pageId: string,
        opts: SessionOptions,
    ): Promise<PageSession> {
        const page = await transport.getPage(docId, pageId)
        // No .rm yet (un-annotated page): start empty at revision '', the
        // CAS's empty revision, so the first write creates the file.
        const doc = page ? RmDocument.parse(page.bytes) : RmDocument.empty(opts.authorUuid)
        const revision = page?.revision ?? ''
        const overlay = await transport.getOverlay(docId, pageId)
        const session = new PageSession(transport, docId, pageId, opts, doc, revision, overlay)
        // page may have changed while no session was watching: audit
        // overlay-vs-document before the view binds
        for (const decision of auditOverlay(doc, overlay)) {
            if (decision.type === 'remove') {
                overlay.shapes = overlay.shapes.filter((sh) => sh.shapeId !== decision.shapeId)
                opts.onPatch({ type: 'shape-removed', shapeId: decision.shapeId })
            } else if (decision.type === 'detach') {
                const shape = overlay.shapes.find((sh) => sh.shapeId === decision.shapeId)
                if (shape) shape.state = 'detached'
                opts.onPatch({ type: 'shape-detached', shapeId: decision.shapeId })
            } else {
                opts.onPatch({ type: 'shape-edited', shapeId: decision.shapeId, edit: decision.edit })
            }
        }
        return session
    }

    close(): void {
        this.unsubscribe()
    }

    get currentOverlay(): OverlayDocument {
        return this.overlay
    }

    get currentRevision(): string {
        return this.revision
    }

    /** Current parsed document (read-only view for rendering). */
    get document(): RmDocument {
        return this.doc
    }

    // ----- local edits -----

    async apply(ops: LocalOp[]): Promise<void> {
        this.queue.push(...ops)
        if (this.writing) return
        this.writing = true
        try {
            while (this.queue.length > 0) {
                const batch = this.queue.splice(0)
                await this.writeBatch(batch)
            }
        } finally {
            this.writing = false
        }
    }

    private async writeBatch(ops: LocalOp[], attempt = 0): Promise<void> {
        const maxRebases = this.opts.maxRebases ?? 3
        // fresh copy so a rebase can re-apply the same ops onto newer bytes
        const doc = RmDocument.parse(this.doc.serialize())
        const overlay = structuredClone(this.overlay)
        applyOps(doc, overlay, ops, { authorUuid: this.opts.authorUuid, pen: this.opts.pen })

        const bytes = doc.serialize()
        try {
            const result = await this.transport.putPage(
                this.docId,
                this.pageId,
                this.revision,
                bytes,
                this.opts.clientId,
            )
            await this.transport.putOverlay(this.docId, this.pageId, overlay)
            this.doc = doc
            this.overlay = overlay
            this.revision = result.revision
            this.lastWrittenRevision = result.revision
            this.known = snapshotKnownState(doc)
        } catch (e) {
            if (e instanceof EngineFailure && e.error._tag === 'StaleRevision' && attempt < maxRebases) {
                await this.refreshFromRemote()
                return this.writeBatch(ops, attempt + 1)
            }
            throw e
        }
    }

    // ----- remote changes -----

    private async onRemote(event: PageEvent): Promise<void> {
        if (event.doc !== this.docId || event.page !== this.pageId) return
        if (event.type === 'page.changed' && event.revision === this.revision) return
        if (event.type === 'page.changed' && event.originClientId === this.opts.clientId) return // our own echo
        await this.refreshFromRemote(true)
    }

    private async refreshFromRemote(emitPatches = false): Promise<void> {
        const page = await this.transport.getPage(this.docId, this.pageId)
        if (!page) return
        const doc = RmDocument.parse(page.bytes)

        if (emitPatches) {
            const diff = diffPage(this.known, doc, this.overlay)
            if (diff.foreignAdds.length > 0) {
                this.opts.onPatch({ type: 'ink-added', items: diff.foreignAdds })
            }
            if (diff.foreignDeletes.length > 0) {
                this.opts.onPatch({ type: 'ink-removed', items: diff.foreignDeletes })
            }
            const decisions = reconcile(diff, this.overlay)
            for (const decision of decisions) {
                if (decision.type === 'repair') {
                    this.opts.onPatch({
                        type: 'shape-edited',
                        shapeId: decision.shapeId,
                        edit: decision.edit,
                    })
                } else if (decision.type === 'remove') {
                    this.overlay.shapes = this.overlay.shapes.filter(
                        (s) => s.shapeId !== decision.shapeId,
                    )
                    this.opts.onPatch({ type: 'shape-removed', shapeId: decision.shapeId })
                } else {
                    const shape = this.overlay.shapes.find((s) => s.shapeId === decision.shapeId)
                    if (shape) shape.state = 'detached'
                    this.opts.onPatch({ type: 'shape-detached', shapeId: decision.shapeId })
                }
            }
            if (decisions.length > 0) {
                await this.transport.putOverlay(this.docId, this.pageId, this.overlay)
            }
        }

        this.doc = doc
        this.revision = page.revision
        this.known = snapshotKnownState(doc)
    }
}
