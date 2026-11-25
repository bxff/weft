/**
 * In-memory Transport implementing rmsyncd's contract (CAS writes, origin-tagged
 * change events). Powers the hardware-free CI suite and offline demo mode.
 * Can simulate tablet-side drawing/erasing to mimic xochitl's merge-on-disk behavior.
 */

import { RmDocument, Pen, PenColor, crdtIdKey } from '@weft/rm-format'
import { polylineToPoints, type Xy } from '@weft/rm-ink/pure'
import { EngineFailure, itemRefKey, type ItemRef } from './types'
import { RefResolver } from './refs'
import type { DocumentInfo, OpRecord, PageChangedEvent, Transport, PutResult } from './transport'
import type { OverlayDocument } from './types'

const TABLET_AUTHOR = 'f73f497f-0000-4000-a000-000000000000'

function fnvHex(bytes: Uint8Array): string {
    let hash = 0x811c9dc5
    for (const b of bytes) {
        hash ^= b
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}

interface PageState {
    bytes: Uint8Array
    revision: string
    overlay: OverlayDocument
}

/** Per-page op log + snapshots, mirroring the cloud relay. seq is a per-page
 *  monotonic cursor; a snapshot pins the op head it folded in. `head` is the
 *  last allocated seq, kept separate from the ops array so truncation never
 *  reuses one. `floorSeq` is the highest truncated-away seq (0 = none). */
interface OpState {
    ops: OpRecord[]
    head: number
    snapshot: { seq: number; opSeq: number; revert?: boolean; bytes: Uint8Array } | null
    snapSeq: number
    floorSeq: number
}

export class FakeDaemon implements Transport {
    private pages = new Map<string, PageState>()
    private opLogs = new Map<string, OpState>()
    private handlers = new Set<(event: PageChangedEvent) => void>()
    documents: DocumentInfo[] = []

    /** Register a doc whose page has NO .rm yet (e.g. un-annotated PDF page). */
    static withMissingPage(doc: string, page: string): FakeDaemon {
        const daemon = new FakeDaemon()
        daemon.documents = [
            { id: doc, name: 'Fake PDF', parent: '', type: 'pdf', pages: [{ id: page }] },
        ]
        return daemon
    }

    static withBlankPage(doc: string, page: string): FakeDaemon {
        const daemon = new FakeDaemon()
        const blank = RmDocument.empty(TABLET_AUTHOR).serialize()
        daemon.pages.set(`${doc}/${page}`, {
            bytes: blank,
            revision: fnvHex(blank),
            overlay: { shapes: [] },
        })
        daemon.documents = [
            {
                id: doc,
                name: 'Fake notebook',
                parent: '',
                type: 'notebook',
                pages: [{ id: page }],
            },
        ]
        return daemon
    }

    // --- Transport ---

    async health() {
        return { firmware: 'fake', model: 'fake', daemon: 'fake-daemon' }
    }

    async listDocuments(): Promise<DocumentInfo[]> {
        return this.documents
    }

    async getPage(doc: string, page: string) {
        const state = this.pages.get(`${doc}/${page}`)
        if (!state) return null
        return { bytes: state.bytes, revision: state.revision }
    }

    async putPage(
        doc: string,
        page: string,
        baseRevision: string,
        bytes: Uint8Array,
        clientId: string,
    ): Promise<PutResult> {
        const key = `${doc}/${page}`
        let state = this.pages.get(key)
        if (!state) {
            // missing file has empty revision, so PUT with base '' creates it
            if (baseRevision !== '') {
                throw new EngineFailure({ _tag: 'StaleRevision', currentRevision: '' })
            }
            state = { bytes: new Uint8Array(0), revision: '', overlay: { shapes: [] } }
            this.pages.set(key, state)
        }
        if (state.revision !== baseRevision) {
            throw new EngineFailure({ _tag: 'StaleRevision', currentRevision: state.revision })
        }
        state.bytes = bytes.slice()
        state.revision = fnvHex(state.bytes)
        this.emit({
            type: 'page.changed',
            doc,
            page,
            revision: state.revision,
            origin: 'client',
            originClientId: clientId,
        })
        return { revision: state.revision }
    }

    async getOverlay(doc: string, page: string): Promise<OverlayDocument> {
        return this.pages.get(`${doc}/${page}`)?.overlay ?? { shapes: [] }
    }

    async putOverlay(doc: string, page: string, overlay: OverlayDocument): Promise<void> {
        const state = this.pages.get(`${doc}/${page}`)
        if (state) state.overlay = structuredClone(overlay)
    }

    subscribe(handler: (event: PageChangedEvent) => void): () => void {
        this.handlers.add(handler)
        return () => this.handlers.delete(handler)
    }

    private emit(event: PageChangedEvent): void {
        for (const handler of this.handlers) handler(event)
    }

    // --- op + snapshot channel ---

    private opState(key: string): OpState {
        let s = this.opLogs.get(key)
        if (!s) {
            s = { ops: [], head: 0, snapshot: null, snapSeq: 0, floorSeq: 0 }
            this.opLogs.set(key, s)
        }
        return s
    }

    async appendOps(
        doc: string,
        page: string,
        ops: Uint8Array[],
        author: string | null,
    ): Promise<{ firstSeq: number; lastSeq: number }> {
        const s = this.opState(`${doc}/${page}`)
        if (ops.length === 0) {
            return { firstSeq: s.head, lastSeq: s.head }
        }
        const ts = Date.now()
        let firstSeq = 0
        let lastSeq = 0
        for (const op of ops) {
            const seq = ++s.head
            s.ops.push({ seq, op: op.slice(), author, ts })
            if (firstSeq === 0) firstSeq = seq
            lastSeq = seq
        }
        // revision marker lets op-mode peers pull opsSince cursor instead of diffing rm bytes;
        // originClientId null since only the CRDT author is known here, self-echo is harmless (idempotent replay)
        this.emit({
            type: 'page.changed',
            doc,
            page,
            revision: `ops:${lastSeq}`,
            origin: 'client',
            originClientId: null,
        })
        return { firstSeq, lastSeq }
    }

    async opsSince(doc: string, page: string, sinceSeq: number): Promise<OpRecord[]> {
        const s = this.opState(`${doc}/${page}`)
        // cursor below floor predates the retained log; returning normally would silently gap the caller
        if (s.floorSeq > 0 && sinceSeq < s.floorSeq) {
            throw new EngineFailure({ _tag: 'OpsTruncated', floorSeq: s.floorSeq })
        }
        return s.ops.filter((o) => o.seq > sinceSeq).map((o) => ({ ...o, op: o.op.slice() }))
    }

    /** Simulates cloud retention: deletes ops <= uptoSeq, raises the truncation
     *  floor. Caller must ensure the latest snapshot covers at least uptoSeq. */
    truncate(doc: string, page: string, uptoSeq: number): void {
        const s = this.opState(`${doc}/${page}`)
        const deleted = s.ops.filter((o) => o.seq <= uptoSeq)
        if (deleted.length === 0) return
        s.ops = s.ops.filter((o) => o.seq > uptoSeq)
        s.floorSeq = Math.max(s.floorSeq, deleted[deleted.length - 1]!.seq)
    }

    async getSnapshot(
        doc: string,
        page: string,
        ifSeqGt?: number,
    ): Promise<{ seq: number; opSeq: number; revert?: boolean; bytes: Uint8Array } | null> {
        const snap = this.opState(`${doc}/${page}`).snapshot
        if (!snap) return null
        if (ifSeqGt !== undefined && snap.seq <= ifSeqGt) return null // conditional: not newer
        return { ...snap, bytes: snap.bytes.slice() }
    }

    async putSnapshot(doc: string, page: string, bytes: Uint8Array): Promise<{ seq: number }> {
        const s = this.opState(`${doc}/${page}`)
        const seq = ++s.snapSeq
        s.snapshot = { seq, opSeq: s.head, bytes: bytes.slice() }
        return { seq }
    }

    /** Test hook: publish a REVERT snapshot (a deliberate head-rewind whose
     *  bytes reflect a PAST state) pinned at an explicit opSeq. */
    putRevertSnapshot(doc: string, page: string, bytes: Uint8Array, opSeq: number): number {
        const s = this.opState(`${doc}/${page}`)
        const seq = ++s.snapSeq
        s.snapshot = { seq, opSeq, revert: true, bytes: bytes.slice() }
        return seq
    }

    // --- tablet simulation ---

    /** Uploaded assets, keyed `${doc}/${page}/${filename}`. */
    readonly assets = new Map<string, Uint8Array>()

    async putAsset(doc: string, page: string, filename: string, bytes: Uint8Array): Promise<void> {
        this.assets.set(`${doc}/${page}/${filename}`, bytes)
    }

    /** Simulates drawing a stroke on the tablet. Returns its ref. */
    tabletDraw(doc: string, page: string, polyline: Xy[]): ItemRef {
        const key = `${doc}/${page}`
        const state = this.pages.get(key)!
        const rmDoc = RmDocument.parse(state.bytes)
        const block = rmDoc.appendLine(
            {
                kind: 'line',
                tool: Pen.BALLPOINT_2,
                color: PenColor.BLACK,
                thicknessScale: 2,
                startingLength: 0,
                timestamp: { part1: 0, part2: 1 },
                moveId: null,
                points: polylineToPoints(polyline, { width: 8 }),
            },
            { authorUuid: TABLET_AUTHOR },
        )
        const ref = new RefResolver(rmDoc).toRef(block.itemId)!
        this.commitTabletMutation(doc, page, rmDoc)
        return ref
    }

    /** Simulates erasing specific items on the tablet. */
    tabletErase(doc: string, page: string, items: ItemRef[]): void {
        const key = `${doc}/${page}`
        const state = this.pages.get(key)!
        const rmDoc = RmDocument.parse(state.bytes)
        const resolver = new RefResolver(rmDoc)
        for (const ref of items) {
            const id = resolver.toId(ref)
            if (!id) throw new Error(`unknown item ${itemRefKey(ref)}`)
            if (!rmDoc.tombstone(id)) throw new Error(`tombstone failed for ${crdtIdKey(id)}`)
        }
        this.commitTabletMutation(doc, page, rmDoc)
    }

    private commitTabletMutation(doc: string, page: string, rmDoc: RmDocument): void {
        // xochitl normalizes layout on every rewrite
        rmDoc.normalizeLayout()
        const state = this.pages.get(`${doc}/${page}`)!
        state.bytes = rmDoc.serialize()
        state.revision = fnvHex(state.bytes)
        this.emit({
            type: 'page.changed',
            doc,
            page,
            revision: state.revision,
            origin: 'xochitl',
            originClientId: null,
        })
    }
}

export { TABLET_AUTHOR }
