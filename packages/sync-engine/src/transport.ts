/**
 * Transport: how the engine reaches a daemon (local rmsyncd over HTTP/WS,
 * a relay in hosted mode, or the in-memory fake for tests/demo).
 */

import type { OverlayDocument } from './types'

export interface DocumentInfo {
    id: string
    name: string
    parent: string
    type: 'notebook' | 'pdf' | 'epub' | 'folder'
    pages: { id: string; lastModified?: number; template?: string; fileIndex?: number }[]
    lastModified?: number
    /** .metadata createdTime (epoch ms) — the tablet's "Date created" sort. */
    createdTime?: number
    /** .metadata lastOpened (epoch ms), "last opened anywhere": web opens
     *  flow back through the daemon's max-register merge. Surfaces the doc
     *  under the "Last opened" sort on tablet and web. */
    lastOpened?: number
    lastOpenedPage?: string
    /** Page id the tablet shows as the doc cover, resolved by the daemon from
     *  .content coverPageNumber (-1 = last-visited page, N>=0 = fixed page).
     *  Web library uses this so its cover matches the device. */
    coverPage?: string
    /** PDF/EPUB page rect in ink space. */
    zoom?: {
        mode: string
        scale: number
        centerX: number
        centerY: number
        pageWidth: number
        pageHeight: number
    }
}

export interface PageChangedEvent {
    type: 'page.changed'
    doc: string
    page: string
    revision: string
    origin: 'xochitl' | 'client'
    originClientId: string | null
}

/** An accepted operation batch also invalidates the open page. */
export interface OpsAppendedEvent {
    type: 'ops.appended'
    doc: string
    page: string
    lastSeq: number
}

export type PageEvent = PageChangedEvent | OpsAppendedEvent

export interface PutResult {
    revision: string
}

/** One stored op (opaque bytes) plus its relay metadata. */
export interface OpRecord {
    seq: number
    op: Uint8Array
    author: string | null
    ts: number
}

export interface Transport {
    health(): Promise<{ firmware: string; model: string; daemon: string }>
    listDocuments(): Promise<DocumentInfo[]>
    getPage(doc: string, page: string): Promise<{ bytes: Uint8Array; revision: string } | null>
    putPage(
        doc: string,
        page: string,
        baseRevision: string,
        bytes: Uint8Array,
        clientId: string,
    ): Promise<PutResult> // throws EngineFailure(StaleRevision) on 409
    getOverlay(doc: string, page: string): Promise<OverlayDocument>
    putOverlay(doc: string, page: string, overlay: OverlayDocument): Promise<void>
    /** Upload an image asset into the page's resource dir. */
    putAsset(doc: string, page: string, filename: string, bytes: Uint8Array, canSend?: () => boolean): Promise<void>
    readonly pageEventsConnection?: object | undefined
    subscribe(handler: (event: PageEvent) => void, onConnected?: () => void): () => void

    // ----- op + snapshot channel -----
    // Opaque blobs; the relay never parses them, merge is client-side.
    // Optional: only HttpTransport implements these so far.
    /** Append a batch of op blobs for a page; returns the new seq range. */
    appendOps?(
        doc: string,
        page: string,
        ops: Uint8Array[],
        author: string | null,
    ): Promise<{ firstSeq: number; lastSeq: number }>
    /** Ops for a page with seq strictly greater than `sinceSeq`, in order. */
    opsSince?(doc: string, page: string, sinceSeq: number, snapshotSeq?: number): Promise<OpRecord[]>
    /** Latest whole-page snapshot, or null. `opSeq` is the op-log head folded
     *  into it: reconstruct = these bytes + opsSince(opSeq). `ifSeqGt` makes
     *  the fetch conditional: null when the latest seq is not greater, so
     *  steady-state pulls skip re-downloading a snapshot already held. */
    getSnapshot?(
        doc: string,
        page: string,
        ifSeqGt?: number,
    ): Promise<{ seq: number; opSeq: number; revert?: boolean; complete?: boolean; bytes: Uint8Array } | null>
    /** Store a whole-page snapshot; returns its seq. */
    putSnapshot?(doc: string, page: string, bytes: Uint8Array): Promise<{ seq: number; merged?: boolean }>
}
