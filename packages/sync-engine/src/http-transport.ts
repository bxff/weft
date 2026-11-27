/**
 * HTTP/WS transport against a live rmsyncd (device-protocol §8).
 * Reconnecting WebSocket with backoff; typed EngineFailure errors.
 */

import { decodePublicationBytes, type BrowserPublication, type BrowserReceipt } from './browser-publication'
import { SNAPSHOT_BATCH_CONTENT_TYPE } from './snapshot'
import { EngineFailure, type OverlayDocument } from './types'
import type { DocumentInfo, OpRecord, PageEvent, PutResult, Transport } from './transport'

/** base64 <-> bytes that works in the browser and Bun (ops are small). */
function bytesToB64(bytes: Uint8Array): string {
    let s = ''
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
    return btoa(s)
}
function b64ToBytes(b64: string): Uint8Array {
    const s = atob(b64)
    const out = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
    return out
}

export interface HttpTransportOptions {
    /** e.g. "http://10.11.99.1:9000" — defaults to same-origin. */
    baseUrl?: string
    /** Alternate same-origin gateway for the browser's read-only manifest. */
    documentListBaseUrl?: string
    /** Bearer token supplier (Clerk JWT) for hosted mode. */
    getAuthToken?: () => Promise<string | null> | string | null
}

export type PageAssetChange = { type: 'page.asset.changed'; doc: string; page: string; file: string }

export class HttpTransport implements Transport {
    private readonly base: string
    private handlers = new Set<(event: PageEvent) => void>()
    private pageConnectedHandlers = new Set<() => void>()
    private assetHandlers = new Set<(event?: PageAssetChange) => void>()
    private docListHandlers = new Set<() => void>()
    private ws: WebSocket | null = null
    private wsBackoff = 500
    private readonly lifetime = new AbortController()

    constructor(private readonly opts: HttpTransportOptions = {}) {
        this.base = (opts.baseUrl ?? '').replace(/\/$/, '')
        void this.connectWs()
    }

    get baseUrl(): string {
        return this.base
    }

    get pageEventsConnection(): WebSocket | undefined {
        return this.ws?.readyState === WebSocket.OPEN ? this.ws : undefined
    }

    close(): void {
        this.lifetime.abort(new EngineFailure({ _tag: 'Unauthorized' }))
        this.ws?.close()
    }

    /** Exchanges the bearer for a single-use, short-lived WS ticket so the JWT
     *  never rides in the WS URL. Null when signed out or on failure; caller
     *  then connects unauthenticated and the server 401s the upgrade. */
    private async mintWsTicket(): Promise<string | null> {
        const token = await this.opts.getAuthToken?.()
        if (!token || this.lifetime.signal.aborted) return null
        const r = await fetch(this.base + '/api/ws-ticket', {
            signal: AbortSignal.timeout(15_000),
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
        })
        if (!r.ok) return null
        const body = (await r.json()) as { ticket?: string }
        return typeof body.ticket === 'string' ? body.ticket : null
    }

    private async connectWs(): Promise<void> {
        if (this.lifetime.signal.aborted) return
        let wsUrl =
            (this.base
                ? this.base.replace(/^http/, 'ws')
                : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`) + '/ws'
        // browsers can't set headers on a WS upgrade; a long-lived JWT in the URL would
        // leak into proxy/CDN logs, so use a short-lived opaque ticket instead, minted fresh each connect
        try {
            const ticket = await this.mintWsTicket()
            if (ticket) wsUrl += `?ticket=${encodeURIComponent(ticket)}`
        } catch {
            // must not kill the reconnect loop; server 401s and onclose retries with backoff
        }
        if (this.lifetime.signal.aborted) return
        const ws = new WebSocket(wsUrl)
        this.ws = ws
        ws.onmessage = (e) => {
            try {
                const event = JSON.parse(String(e.data)) as PageEvent | PageAssetChange | { type: string }
                if (event.type === 'page.changed' || event.type === 'ops.appended') {
                    for (const handler of this.handlers) handler(event as PageEvent)
                } else if (event.type === 'page.asset.changed') {
                    for (const handler of this.assetHandlers) handler(event as PageAssetChange)
                } else if (event.type === 'doc.list.changed') {
                    for (const handler of this.docListHandlers) handler()
                }
            } catch {
                // ignore malformed events
            }
        }
        ws.onopen = () => {
            this.wsBackoff = 500
            for (const handler of this.pageConnectedHandlers) handler()
            for (const handler of this.assetHandlers) handler()
            // reconnect may have missed doc.list.changed events while down; refetch now.
            // no-op on first connect since subscribeDocList registers its handler later
            for (const handler of this.docListHandlers) handler()
        }
        ws.onclose = () => {
            if (this.lifetime.signal.aborted) return
            setTimeout(() => void this.connectWs(), this.wsBackoff)
            this.wsBackoff = Math.min(this.wsBackoff * 2, 10_000)
        }
        ws.onerror = () => ws.close()
    }

    private async fetchOk(path: string, init: RequestInit = {}, baseUrl = this.base): Promise<Response> {
        const lifetime = this.lifetime.signal
        lifetime.throwIfAborted()
        // One deadline covers credential refresh, the request, and its response body.
        const signals = [lifetime, AbortSignal.timeout(20_000)]
        if (init.signal) signals.push(init.signal)
        const signal = AbortSignal.any(signals)
        const abortFailure = (): EngineFailure =>
            lifetime.aborted
                ? (lifetime.reason as EngineFailure)
                : new EngineFailure({ _tag: 'DeviceUnreachable', cause: String(signal.reason) })

        if (signal.aborted) throw abortFailure()
        let token: string | null | undefined
        if (this.opts.getAuthToken) {
            const pendingToken = this.opts.getAuthToken()
            const abortListener = new AbortController()
            try {
                const cancelled = new Promise<never>((_, reject) => {
                    const onAbort = () => reject(abortFailure())
                    signal.addEventListener('abort', onAbort, { once: true, signal: abortListener.signal })
                    if (signal.aborted) onAbort()
                })
                token = await Promise.race([pendingToken, cancelled])
            } finally {
                abortListener.abort()
            }
        }
        // The token can win the race just before cancellation.
        if (signal.aborted) throw abortFailure()
        if (token) {
            init.headers = { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` }
        }
        let response: Response
        try {
            response = await fetch(baseUrl + path, { ...init, signal })
        } catch (e) {
            lifetime.throwIfAborted()
            throw new EngineFailure({ _tag: 'DeviceUnreachable', cause: String(e) })
        }
        if (response.status === 401) throw new EngineFailure({ _tag: 'Unauthorized' })
        return response
    }

    async health() {
        const r = await this.fetchOk('/api/health')
        return (await r.json()) as { firmware: string; model: string; daemon: string }
    }

    async listDocuments(): Promise<DocumentInfo[]> {
        const r = await this.fetchOk('/api/documents', {
            cache: 'no-store',
            ...(this.opts.documentListBaseUrl !== undefined && { credentials: 'omit' }),
        }, this.opts.documentListBaseUrl)
        if (!r.ok) {
            throw new EngineFailure({ _tag: 'DeviceUnreachable', cause: `GET /api/documents ${r.status}` })
        }
        const body = (await r.json()) as { documents: DocumentInfo[] }
        return body.documents ?? []
    }

    async getPage(doc: string, page: string) {
        const r = await this.fetchOk(`/api/documents/${doc}/pages/${page}/rm`)
        if (r.status === 404) return null
        const revision = r.headers.get('x-rm-revision') ?? ''
        const bytes = new Uint8Array(await r.arrayBuffer())
        return { bytes, revision }
    }

    async putPage(
        doc: string,
        page: string,
        baseRevision: string,
        bytes: Uint8Array,
        clientId: string,
    ): Promise<PutResult> {
        const r = await this.fetchOk(`/api/documents/${doc}/pages/${page}/rm`, {
            method: 'PUT',
            headers: {
                'content-type': 'application/octet-stream',
                'x-base-revision': baseRevision,
                'x-client-id': clientId,
            },
            body: bytes as unknown as BodyInit,
        })
        if (r.status === 409) {
            const body = (await r.json()) as { currentRevision: string }
            throw new EngineFailure({ _tag: 'StaleRevision', currentRevision: body.currentRevision })
        }
        if (!r.ok) {
            throw new EngineFailure({ _tag: 'DeviceUnreachable', cause: `PUT ${r.status}` })
        }
        return (await r.json()) as PutResult
    }

    async getOverlay(doc: string, page: string): Promise<OverlayDocument> {
        const r = await this.fetchOk(`/api/documents/${doc}/pages/${page}/overlay`)
        return (await r.json()) as OverlayDocument
    }

    async putOverlay(doc: string, page: string, overlay: OverlayDocument): Promise<void> {
        await this.fetchOk(`/api/documents/${doc}/pages/${page}/overlay`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(overlay),
        })
    }

    async putAsset(doc: string, page: string, filename: string, bytes: Uint8Array): Promise<void> {
        const r = await this.fetchOk(
            `/api/documents/${doc}/pages/${page}/assets/${encodeURIComponent(filename)}`,
            {
                method: 'PUT',
                headers: { 'content-type': 'application/octet-stream' },
                body: bytes as unknown as BodyInit,
            },
        )
        if (!r.ok) {
            throw new EngineFailure({ _tag: 'DeviceUnreachable', cause: `PUT asset ${r.status}` })
        }
    }

    // ----- op + snapshot channel -----

    async appendOps(
        doc: string,
        page: string,
        ops: Uint8Array[],
        author: string | null,
    ): Promise<{ firstSeq: number; lastSeq: number }> {
        const r = await this.fetchOk(`/api/documents/${doc}/pages/${page}/ops`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ops: ops.map(bytesToB64), author }),
        })
        if (!r.ok) throw new EngineFailure({ _tag: 'DeviceUnreachable', cause: `POST ops ${r.status}` })
        return (await r.json()) as { firstSeq: number; lastSeq: number }
    }

    async opsSince(doc: string, page: string, sinceSeq: number, snapshotSeq?: number): Promise<OpRecord[]> {
        const records: OpRecord[] = []
        let cursor = sinceSeq
        let head: number | undefined
        let unstamped = false
        for (;;) {
            const r = await this.fetchOk(`/api/documents/${doc}/pages/${page}/ops?since=${cursor}`)
            if (r.status === 410) {
                // The session must re-bootstrap if retention removed an unread slice.
                const body = (await r.json().catch(() => ({}))) as { floorSeq?: number }
                throw new EngineFailure({
                    _tag: 'OpsTruncated',
                    floorSeq: typeof body.floorSeq === 'number' ? body.floorSeq : 0,
                })
            }
            if (!r.ok) throw new EngineFailure({ _tag: 'DeviceUnreachable', cause: `GET ops ${r.status}` })
            const body = (await r.json()) as {
                head?: number
                snapshotSeq?: number
                ops: { seq: number; op: string; author: string | null; ts: number }[]
            }
            if (body.snapshotSeq === undefined) unstamped = true
            else if (!Number.isSafeInteger(body.snapshotSeq) || body.snapshotSeq < 0) {
                throw new EngineFailure({ _tag: 'DeviceUnreachable', cause: 'Invalid checkpoint in operation response' })
            } else if (snapshotSeq !== undefined && body.snapshotSeq !== snapshotSeq) {
                throw new EngineFailure({ _tag: 'CheckpointChanged', snapshotSeq: body.snapshotSeq })
            }
            if (body.head !== undefined && (!Number.isSafeInteger(body.head) || body.head < cursor)) {
                throw new EngineFailure({ _tag: 'DeviceUnreachable', cause: 'Invalid operation head' })
            }
            // Bound the read to the first response's head even while peers edit.
            head ??= body.head
            let last = cursor
            for (const op of body.ops) {
                if (!Number.isSafeInteger(op.seq) || op.seq <= last ||
                    (body.head !== undefined && op.seq > body.head)) {
                    throw new EngineFailure({ _tag: 'DeviceUnreachable', cause: 'Invalid operation sequence' })
                }
                last = op.seq
                if (head === undefined || op.seq <= head) {
                    records.push({ seq: op.seq, op: b64ToBytes(op.op), author: op.author, ts: op.ts })
                }
            }
            if (head === undefined || last >= head) break
            if (last === cursor) {
                throw new EngineFailure({ _tag: 'DeviceUnreachable', cause: 'Operation tail did not reach the advertised head' })
            }
            cursor = last
        }
        // Older relays have no generation stamp. Recheck before returning a
        // range, even when it was empty and local edits are waiting to publish.
        if (unstamped && snapshotSeq !== undefined) {
            const latest = await this.getSnapshot(doc, page, snapshotSeq)
            if (latest && latest.seq > snapshotSeq) {
                throw new EngineFailure({ _tag: 'CheckpointChanged', snapshotSeq: latest.seq })
            }
        }
        return records
    }

    async getSnapshot(
        doc: string,
        page: string,
        ifSeqGt?: number,
    ): Promise<{ seq: number; opSeq: number; revert?: boolean; complete?: boolean; bytes: Uint8Array } | null> {
        const r = await this.fetchOk(
            `/api/documents/${doc}/pages/${page}/snapshot`,
            ifSeqGt !== undefined
                ? { headers: { 'x-if-snapshot-seq-gt': String(ifSeqGt) } }
                : {},
        )
        if (r.status === 204) return null // no snapshot yet (normal bootstrap)
        if (r.status === 304) return null // conditional: nothing newer than ifSeqGt
        if (!r.ok) throw new EngineFailure({ _tag: 'DeviceUnreachable', cause: `GET snapshot ${r.status}` })
        const complete = r.headers.get('x-snapshot-complete') === '1'
        const cursor = (name: string, minimum: number) => {
            const raw = r.headers.get(name)
            if (raw === null && !complete) return 0
            const value = Number(raw)
            if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum) {
                throw new Error('Invalid checkpoint header: ' + name)
            }
            return value
        }
        const seq = cursor('x-snapshot-seq', 1)
        const opSeq = cursor('x-snapshot-op-seq', 0)
        const revert = r.headers.get('x-snapshot-revert') === '1'
        return { seq, opSeq, revert, complete, bytes: new Uint8Array(await r.arrayBuffer()) }
    }

    async publishBrowserSave(doc: string, page: string, save: BrowserPublication): Promise<BrowserReceipt> {
        const isSnapshot = save.kind === 'snapshot'
        const r = await this.fetchOk(`/api/documents/${doc}/pages/${page}/${isSnapshot ? 'snapshot-batch' : 'ops-batch'}`, {
            method: 'POST',
            headers: isSnapshot ? {
                'content-type': SNAPSHOT_BATCH_CONTENT_TYPE,
                'x-snapshot-publication-id': save.id,
                'x-snapshot-base-seq': String(save.baseSeq),
            } : {
                'content-type': 'application/json',
                'x-op-batch-id': save.id,
            },
            body: isSnapshot ? decodePublicationBytes(save.payload) as BodyInit : save.payload,
        })
        if (r.status === 409) {
            const rejection = await r.json().catch(() => null) as { reason?: string } | null
            if (rejection?.reason === 'snapshot-base') return { kind: 'stale' }
        }
        if (r.ok) {
            const receipt = await r.json() as { seq?: number; lastSeq?: number }
            const seq = isSnapshot ? receipt.seq : receipt.lastSeq
            if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0) {
                return isSnapshot ? { kind: 'snapshot', seq } : { kind: 'ops', lastSeq: seq }
            }
        }
        throw new EngineFailure({ _tag: 'DeviceUnreachable', cause: `Unconfirmed browser save (${r.status})` })
    }

    async putSnapshot(doc: string, page: string, bytes: Uint8Array): Promise<{ seq: number; merged?: boolean }> {
        const r = await this.fetchOk(`/api/documents/${doc}/pages/${page}/snapshot`, {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream' },
            body: bytes as unknown as BodyInit,
        })
        if (!r.ok) throw new EngineFailure({ _tag: 'DeviceUnreachable', cause: `PUT snapshot ${r.status}` })
        return (await r.json()) as { seq: number; merged?: boolean }
    }

    subscribe(handler: (event: PageEvent) => void, onConnected?: () => void): () => void {
        this.handlers.add(handler)
        if (onConnected) this.pageConnectedHandlers.add(onConnected)
        return () => {
            this.handlers.delete(handler)
            if (onConnected) this.pageConnectedHandlers.delete(onConnected)
        }
    }

    subscribePageAssets(handler: (event?: PageAssetChange) => void): () => void {
        this.assetHandlers.add(handler)
        return () => this.assetHandlers.delete(handler)
    }

    /** Fires when the daemon/cloud reports the document list changed. */
    subscribeDocList(handler: () => void): () => void {
        this.docListHandlers.add(handler)
        return () => this.docListHandlers.delete(handler)
    }
}
