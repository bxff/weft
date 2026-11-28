/**
 * OfflineSession: local-first page session. Edits a local replica
 * ({ baseBytes, baseRevision, pendingOps, overlay }) persisted in
 * KeyValueStorage; reconcile() syncs with the tablet as a peer, tolerant of any offline duration.
 */

import { RmDocument } from '@weft/rm-format'
import { applyOps, type ApplyOptions, type LocalOp } from './apply-ops'
import { diffPage, snapshotKnownState } from './differ'
import {
    applyInkDeltas,
    decodeOp,
    encodeOp,
    mergeOverlayOp,
    mergeOverlayDocuments,
    type AddItemOp,
    type Op,
    type TombstoneOp,
} from './ops'
import { decodeSnapshot, encodeSnapshot } from './snapshot'
import { applyMoveRewrites, auditOverlay, reconcile as reconcilePolicy } from './reconciler'
import type { KeyValueStorage } from './storage'
import type { OpRecord, PageEvent, Transport } from './transport'
import {
    EngineFailure,
    type FailureReport,
    type OverlayDocument,
    type OverlayShape,
    type ViewPatch,
} from './types'

interface PersistedState {
    baseRevision: string
    /** LEGACY: pending ops used to live in the state blob, where a second
     *  tab's persist could clobber them. Now under a per-author key
     *  (pendingKey); migrated once by the cache primary, never written again. */
    pendingOps?: LocalOp[]
    overlay: OverlayDocument
    /** Highest relay op seq folded into baseDoc/overlay. */
    opCursor?: number
    /** Highest snapshot seq applied (triggers re-bootstrap). */
    lastSnapshotSeq?: number
}

export type SyncStatus =
    | { state: 'synced' }
    | { state: 'pending'; ops: number }
    | { state: 'offline'; ops: number }
    | { state: 'error'; detail: string }

export interface OfflineSessionOptions extends ApplyOptions {
    clientId: string
    onPatch: (patch: ViewPatch) => void
    /** Batch paint notifications from an op pull. Snapshots, standalone audits
     * and edits that initiate a local repair still use onPatch. */
    onPatchBatch?: (patches: readonly ViewPatch[]) => void
    onStatus?: (status: SyncStatus) => void
    onPageAvailable?: () => void
    /**
     * Multi-tab discipline: every tab edits with its own author uuid (two
     * sessions sharing an author would mint colliding (author, clock) CRDT
     * ids), and persists pending ops under a per-author key so tabs never
     * clobber each other. The cache primary (one session per page across
     * tabs, elected via cross-tab lock) additionally maintains the shared
     * base/state bootstrap cache and adopts orphaned pending queues.
     * Defaults to primary (single-context callers: tests, tools).
     */
    cachePrimary?: boolean
    /**
     * Run `fn` while exclusively holding the given author's cross-tab lock,
     * or return false if unavailable (that author's tab is alive). Orphan
     * adoption must happen under the lock: a query-then-adopt racing the
     * author's tab reopening could both flush the same queue with fresh
     * CRDT ids, doubling strokes. Absent = never adopt.
     */
    adoptOrphanAuthor?: (authorUuid: string, fn: () => Promise<void>) => Promise<boolean>
    /**
     * Opt-in failure reporting. The engine only REPORTS (redacted, no note
     * content); the caller decides whether to send (respecting the user's
     * telemetry toggle). DeviceUnreachable is intentionally NOT reported — it
     * is normal offline operation, not a bug.
     */
    onFailure?: (report: FailureReport) => void
    /** Background reconcile interval while unreachable (ms). */
    retryIntervalMs?: number
    /** Abandon a reconcile chain whose in-flight run exceeds this (ms);
     *  backstop for anything that slips past the transport timeouts. */
    reconcileWatchdogMs?: number
    /**
     * Human-readable author recorded on pushed ops for the history timeline
     * ("who made this edit"). Distinct from authorUuid, which is the CRDT
     * identity inside the .rm bytes. Defaults to authorUuid for callers that
     * never set it (third-party apps should pass their app name).
     */
    historyAuthor?: string
}

export class OfflineSession {
    private baseDoc!: RmDocument
    private baseRevision = ''
    private pendingOps: LocalOp[] = []
    private checkpointDirty = false
    private pendingWrites = Promise.resolve()
    private overlay: OverlayDocument = { shapes: [] }
    private opCursor = 0
    /** Highest snapshot seq applied (bootstrapped from, or published). A newer
     *  snapshot.seq means re-bootstrap: covers compaction and ops with no
     *  replayable delta (image/layer), whose state lives only in the snapshot. */
    private lastSnapshotSeq = 0
    private bootstrapped = false
    private inflight: Promise<void> | null = null
    private unsubscribe: (() => void) | null = null
    private retryTimer: ReturnType<typeof setInterval> | null = null
    private disposed = false
    private drainingWrites = false
    private readonly checkpointWrites = new Set<Promise<void>>()
    /** Mutable shadow of opts.cachePrimary: a queued cross-tab lock can
     *  promote this session when the previous primary's tab closes. */
    private cachePrimary = true

    private constructor(
        private readonly storage: KeyValueStorage,
        private readonly transport: Transport,
        readonly docId: string,
        readonly pageId: string,
        private readonly opts: OfflineSessionOptions,
    ) {}

    private key(suffix: string): string {
        return `page/${this.docId}/${this.pageId}/${suffix}`
    }

    static async open(
        storage: KeyValueStorage,
        transport: Transport,
        docId: string,
        pageId: string,
        opts: OfflineSessionOptions,
    ): Promise<OfflineSession> {
        const session = new OfflineSession(storage, transport, docId, pageId, opts)
        session.cachePrimary = opts.cachePrimary ?? true
        await session.load()
        await session.adoptOrphanPending()
        // the page may have changed while NO session was watching (tablet
        // moves/erases of our rendered shapes): audit before the view binds
        if (session.runAudit()) await session.persist()
        if (session.bootstrapped || session.pendingOps.length) opts.onPageAvailable?.()
        session.unsubscribe = transport.subscribe((event) => void session.onRemote(event), () => void session.reconcile())
        session.retryTimer = setInterval(
            () => void session.reconcile(),
            opts.retryIntervalMs ?? 15_000,
        )
        // first reconcile in the background; local state is usable immediately
        void session.reconcile()
        return session
    }

    private pendingKey(): string {
        return this.key(`pending/${this.opts.authorUuid}`)
    }

    private async load(): Promise<void> {
        const [baseBytes, stateRaw] = await this.storage.getPair(this.key('base'), this.key('state'))
        // per-author key: two tabs can never clobber each other's unflushed ops
        const pendingRaw = await this.storage.get(this.pendingKey())
        if (pendingRaw) {
            try {
                this.pendingOps = JSON.parse(new TextDecoder().decode(pendingRaw)) as LocalOp[]
            } catch {
                this.pendingOps = [] // corrupt queue: nothing safe to replay
            }
        }
        if (baseBytes && stateRaw) {
            // local replica exists: offline-capable immediately
            this.baseDoc = RmDocument.parse(baseBytes)
            const state = JSON.parse(new TextDecoder().decode(stateRaw)) as PersistedState
            this.baseRevision = state.baseRevision
            // LEGACY migration: pending ops used to live in the state blob.
            // Only the cache primary adopts them (a second tab adopting too
            // would double-flush; each applyOps run mints fresh ids, so the
            // strokes would duplicate). persist() below rewrites the state
            // without the field, so this runs at most once.
            if (this.cachePrimary && state.pendingOps?.length) {
                this.pendingOps.push(...state.pendingOps)
                await this.persistPending()
                await this.persist()
            }
            this.overlay = state.overlay
            this.opCursor = state.opCursor ?? 0
            this.lastSnapshotSeq = state.lastSnapshotSeq ?? 0
            // a persisted replica is already bootstrapped (it has a cursor +
            // base); pull resumes from opCursor.
            this.bootstrapped = true
            return
        }
        // First open: bootstrap = snapshot + replay, done lazily in the first
        // reconcile. Do NOT persist this empty placeholder: an interrupted
        // open would leave an empty replica that the next open treats as
        // already-bootstrapped, showing a blank page.
        this.baseDoc = RmDocument.empty(this.opts.authorUuid)
        this.baseRevision = ''
        this.overlay = { shapes: [] }
        this.opCursor = 0
    }

    private async persist(gen = this.generation, nativeBytes?: Uint8Array): Promise<void> {
        // one maintainer per page across tabs (the cache primary); a second
        // writer would interleave a base from one tab with a cursor from
        // another. Pending ops live under per-author keys (persistPending).
        const active = () => gen === this.generation && (!this.disposed || this.drainingWrites) && this.cachePrimary
        if (this.disposed || !active()) return
        this.checkpointDirty = true
        const base = nativeBytes ?? this.baseDoc.serialize()
        const state: PersistedState = {
            baseRevision: this.baseRevision,
            overlay: this.overlay,
            opCursor: this.opCursor,
            lastSnapshotSeq: this.lastSnapshotSeq,
        }
        const stateBytes = new TextEncoder().encode(JSON.stringify(state))
        const write = this.storage.setPair([this.key('base'), base], [this.key('state'), stateBytes], active)
        this.checkpointWrites.add(write)
        try {
            await write
            if (active()) this.checkpointDirty = false
        } finally {
            this.checkpointWrites.delete(write)
        }
    }

    /** Keep queue mutations ordered while a transfer waits for storage commit. */
    private writePending(fn: () => Promise<void>): Promise<void> {
        const write = this.pendingWrites.then(fn)
        this.pendingWrites = write.catch(() => {})
        return write
    }

    /** Durably record this session's own unflushed ops (every session,
     *  primary or not — the key is per-author, so there is no contention).
     *  An empty queue DELETES the key: orphan scans and the replica sweep
     *  then see a clean page. */
    private async persistPending(): Promise<void> {
        if (this.pendingOps.length === 0) {
            await this.storage.delete(this.pendingKey())
            return
        }
        await this.storage.set(
            this.pendingKey(),
            new TextEncoder().encode(JSON.stringify(this.pendingOps)),
        )
    }

    /**
     * Fold closed tabs' queues into this author's queue under each orphan
     * author's lock. LocalOps can replay under any author (ids are minted at
     * apply time), so transfer the bytes before exposing the ops to reconcile.
     */
    private async adoptOrphanPending(): Promise<void> {
        const transfer = this.storage.setAndDelete?.bind(this.storage)
        if (!this.cachePrimary || !this.opts.adoptOrphanAuthor || !transfer) return
        const prefix = this.key('pending/')
        for (const key of await this.storage.keys(prefix)) {
            if (this.disposed) return
            const author = key.slice(prefix.length)
            if (author === this.opts.authorUuid) continue
            await this.opts.adoptOrphanAuthor(author, async () => {
                const raw = await this.storage.get(key)
                if (!raw) return
                let ops: LocalOp[]
                try {
                    ops = JSON.parse(new TextDecoder().decode(raw)) as LocalOp[]
                } catch {
                    return // preserve unreadable source bytes
                }
                if (!Array.isArray(ops) || !ops.every((op) => op && typeof op.type === 'string')) {
                    return
                }
                await this.writePending(async () => {
                    if (this.disposed) return
                    if (ops.length === 0) {
                        await this.storage.delete(key)
                        return
                    }
                    const combined = [...this.pendingOps, ...ops]
                    const bytes = new TextEncoder().encode(JSON.stringify(combined))
                    await transfer(this.pendingKey(), bytes, key)
                    this.pendingOps = combined
                    this.pendingVersion++
                })
            })
        }
    }

    /** A queued cross-tab lock grant promotes this session to cache primary
     *  (the previous primary's tab closed): start maintaining the shared
     *  cache and sweep up any queues that tab orphaned. */
    async promoteToCachePrimary(): Promise<void> {
        if (this.cachePrimary || this.disposed) return
        this.cachePrimary = true
        await this.adoptOrphanPending()
        await this.persist()
        void this.reconcile()
    }

    dispose(): void {
        this.disposed = true
        this.unsubscribe?.()
        if (this.retryTimer) clearInterval(this.retryTimer)
        if (this.quickRetryTimer) clearTimeout(this.quickRetryTimer)
        if (this.localPublishTimer) clearTimeout(this.localPublishTimer)
    }

    /** Stop reconciliation while allowing already-started local writes to commit. */
    async disposeAndDrainLocalWrites(): Promise<void> {
        this.drainingWrites = true
        this.dispose()
        await Promise.allSettled([this.pendingWrites, ...this.checkpointWrites])
        this.drainingWrites = false
    }

    /**
     * Derived view = base + pending ops. Rebuilding it is expensive
     * (reserialize + reparse + clone + replay), so it's memoized on a key
     * that changes only when state does: baseRevision + two mutation
     * counters bumped at the sites that touch pendingOps / overlay.
     * Returned objects are read-only views — callers must not mutate them.
     */
    private pendingVersion = 0
    private overlayVersion = 0
    private viewCache: { key: string; doc: RmDocument; overlay: OverlayDocument } | null = null
    /** Working copy for the pending slow path: base+overlay identity it was
     *  built from, plus the exact pending ops already applied to it. */
    private viewIncr: {
        doc: RmDocument
        overlay: OverlayDocument
        base: RmDocument
        overlayVersion: number
        applied: LocalOp[]
    } | null = null

    /** Cheap change-detection key: any content-affecting mutation moves it.
     *  Callers may cache view-derived computations against it. */
    get viewKey(): string {
        return `${this.baseRevision}|${this.pendingVersion}|${this.overlayVersion}`
    }

    private buildView(): { doc: RmDocument; overlay: OverlayDocument } {
        const key = this.viewKey
        if (this.viewCache && this.viewCache.key === key) return this.viewCache
        // Fast path: with no pending local ops, the view IS the base — return
        // it directly instead of serialize()+parse(), which dominates first
        // render on a heavy page. Callers must treat the view as read-only;
        // freeze base (and its block list) so an accidental mutation throws
        // at the source instead of corrupting state that persists to
        // IndexedDB and pushes as ops. Shallow only: blocks hold typed arrays
        // which can't be frozen, but freezing the block array stops the main
        // add/remove/replace vector. Safe because base is only ever read or
        // replaced wholesale, never mutated in place.
        if (this.pendingOps.length === 0) {
            if (!Object.isFrozen(this.baseDoc)) {
                Object.freeze(this.baseDoc.blocks)
                Object.freeze(this.baseDoc)
            }
            this.viewCache = { key, doc: this.baseDoc, overlay: structuredClone(this.overlay) }
            return this.viewCache
        }
        // Incremental slow path: pending ops only append between builds (a
        // push that drops a prefix also replaces baseDoc, caught by the
        // reference check above), and ops apply sequentially, so
        // apply(prefix) then apply(tail) == apply(all). Reuse the working
        // copy and apply only the tail; any mismatch falls back to a full
        // rebuild below.
        const incr = this.viewIncr
        if (
            incr &&
            incr.base === this.baseDoc &&
            incr.overlayVersion === this.overlayVersion &&
            incr.applied.length <= this.pendingOps.length &&
            incr.applied.every((op, i) => op === this.pendingOps[i])
        ) {
            applyOps(incr.doc, incr.overlay, this.pendingOps.slice(incr.applied.length), this.opts)
            incr.applied = [...this.pendingOps]
            this.viewCache = { key, doc: incr.doc, overlay: incr.overlay }
            return this.viewCache
        }
        const doc = RmDocument.parse(this.baseDoc.serialize())
        const overlay = structuredClone(this.overlay)
        applyOps(doc, overlay, this.pendingOps, this.opts)
        this.viewIncr = {
            doc,
            overlay,
            base: this.baseDoc,
            overlayVersion: this.overlayVersion,
            applied: [...this.pendingOps],
        }
        this.viewCache = { key, doc, overlay }
        return this.viewCache
    }

    /** Local view = base with pending ops applied. */
    get document(): RmDocument {
        return this.buildView().doc
    }

    get currentOverlay(): OverlayDocument {
        return this.buildView().overlay
    }

    get pendingCount(): number {
        return this.pendingOps.length
    }

    /** Retry saving a staged queue without reapplying its edits. */
    async savePending(): Promise<void> {
        await this.writePending(() => this.persistPending())
        if (this.pendingOps.length > 0) void this.reconcile()
    }

    private localPublishTimer: ReturnType<typeof setTimeout> | undefined

    /** Apply local edits: durability never waits for the optional relay coalescing window. */
    async apply(ops: LocalOp[], publishDelayMs = 0): Promise<void> {
        await this.writePending(async () => {
            this.pendingOps.push(...ops)
            this.pendingVersion++
            await this.persistPending()
        })
        if (this.disposed) return
        this.status({ state: 'pending', ops: this.pendingOps.length })
        if (this.localPublishTimer) clearTimeout(this.localPublishTimer)
        if (publishDelayMs > 0) {
            this.localPublishTimer = setTimeout(() => {
                this.localPublishTimer = undefined
                void this.reconcile()
            }, publishDelayMs)
        } else {
            this.localPublishTimer = undefined
            void this.reconcile()
        }
    }

    private status(s: SyncStatus): void {
        this.opts.onStatus?.(s)
    }

    /** Emit a redacted failure report (no note content). Best-effort: a
     *  throwing handler must never break reconcile. */
    private reportFailure(
        kind: FailureReport['kind'],
        tag: string,
        message: string,
        context?: FailureReport['context'],
    ): void {
        if (!this.opts.onFailure) return
        try {
            this.opts.onFailure({
                kind,
                tag,
                message: message.slice(0, 500),
                doc: this.docId,
                page: this.pageId,
                ...(context ? { context } : {}),
                occurredAt: Date.now(),
            })
        } catch {
            // a broken telemetry sink must not affect sync
        }
    }

    private async onRemote(event: PageEvent): Promise<void> {
        if (event.doc !== this.docId || event.page !== this.pageId) return
        if (event.type === 'page.changed' && event.originClientId === this.opts.clientId) return
        // revisions are op markers, not rm hashes — always pull (cheap,
        // idempotent; opsSince(cursor) returns nothing when we're current).
        await this.reconcile()
    }

    /**
     * Push pending ops / pull foreign changes. Safe to call any time;
     * concurrent calls await the same in-flight run (a second call made
     * DURING a run schedules nothing new — pending ops queued mid-run are
     * picked up by the run's own loop).
     */
    private inflightAt = 0
    private generation = 0

    reconcile(): Promise<void> {
        if (this.disposed) return Promise.resolve()
        // Watchdog backstop: transport calls hard-timeout (20s), but if
        // `inflight` ever stays pending past the watchdog, abandon the chain
        // instead of queueing behind it forever. The generation counter
        // prevents an abandoned push from changing the local queue and base.
        const watchdog = this.opts.reconcileWatchdogMs ?? 60_000
        if (this.inflight && Date.now() - this.inflightAt > watchdog) {
            this.generation++
            this.inflight = null
        }
        if (!this.inflight) this.inflightAt = Date.now()
        const gen = this.generation
        const chained = (this.inflight ?? Promise.resolve()).then(() => {
            if (this.disposed || gen !== this.generation) return
            return this.runReconcileOps(gen)
        })
        this.inflight = chained.finally(() => {
            if (this.inflight === wrapped) this.inflight = null
        })
        const wrapped = this.inflight
        return wrapped
    }

    // ----- the commutative op channel (the sole sync path) -----

    /**
     * Op-mode reconcile: bootstrap (snapshot + replay) once, push pending local
     * ops as deltas, then pull foreign ops. No CAS, no 409, no rebase loop —
     * ops commute, so the relay only ever appends and merge is local.
     */
    private async runReconcileOps(gen = this.generation): Promise<void> {
        const t = this.transport
        if (!t.appendOps || !t.opsSince || !t.getSnapshot || !t.putSnapshot) {
            this.status({ state: 'error', detail: 'transport lacks the op channel' })
            return
        }
        try {
            // A watchdog replacement can start while a prior push is waiting
            // to record its acknowledgement behind a storage transfer.
            await this.pendingWrites
            if (gen !== this.generation || this.disposed) return
            // pull BEFORE push: caught up to the head first means a snapshot we
            // publish for an incomplete op reflects all foreign state, and the
            // common case (foreign changes, no local pending) is one round-trip.
            const skippedTail = await this.pullOps(gen)
            await this.pendingWrites
            if (skippedTail && this.pendingOps.length && gen === this.generation && !this.disposed) {
                await this.pullOps(gen)
                await this.pendingWrites
            }
            if (gen !== this.generation || this.disposed) return
            await this.pushPendingOps(gen)
            if (gen !== this.generation || this.disposed) return
            this.quickRetryBackoff = 1_000
            this.status(
                this.pendingOps.length
                    ? { state: 'pending', ops: this.pendingOps.length }
                    : { state: 'synced' },
            )
        } catch (e) {
            if (gen !== this.generation || this.disposed) return
            if (e instanceof EngineFailure && e.error._tag === 'DeviceUnreachable') {
                this.status({ state: 'offline', ops: this.pendingOps.length })
            } else {
                this.status({ state: 'error', detail: String(e) })
                const tag = e instanceof EngineFailure ? e.error._tag : 'Unknown'
                const kind = e instanceof EngineFailure ? 'engine' : 'codec'
                this.reportFailure(kind, tag, errorMessage(e), { pendingOps: this.pendingOps.length })
            }
            // Un-pushed local edits must not sit out the full 15s retry tick;
            // retry on a short exponential fuse instead. Success resets it above.
            if (this.pendingOps.length > 0) this.scheduleQuickRetry()
        }
    }

    private quickRetryBackoff = 1_000
    private quickRetryTimer: ReturnType<typeof setTimeout> | null = null
    private scheduleQuickRetry(): void {
        if (this.disposed) return
        const delay = this.quickRetryBackoff
        // the fuse targets BLIPS; once it reaches the retry interval the
        // regular tick owns the cadence (no double-ticking a long outage)
        if (delay >= 15_000) return
        if (this.quickRetryTimer) clearTimeout(this.quickRetryTimer)
        this.quickRetryBackoff = Math.min(delay * 2, 15_000)
        this.quickRetryTimer = setTimeout(() => {
            this.quickRetryTimer = null
            void this.reconcile()
        }, delay)
    }

    /** Push pending local ops as commutative deltas. opCursor is NOT advanced
     *  here: pullOps replays our own ops idempotently (so an interleaved foreign
     *  op with a lower seq is never skipped). */
    private async pushPendingOps(gen: number): Promise<void> {
        if (this.pendingOps.length === 0) return
        const ops = [...this.pendingOps]
        const doc = RmDocument.parse(this.baseDoc.serialize())
        const overlay = structuredClone(this.overlay)
        const { deltas, complete } = applyOps(doc, overlay, ops, this.opts)
        const blobs = deltas.map(encodeOp)
        if (blobs.length > 0) {
            await this.transport.appendOps!(
                this.docId,
                this.pageId,
                blobs,
                this.opts.historyAuthor ?? this.opts.authorUuid,
            )
        }
        let committed = false
        await this.writePending(async () => {
            // The watchdog may have replaced this run during the relay call
            // or while this acknowledgement waited for a queue transfer.
            if (gen !== this.generation || this.disposed) return
            this.baseDoc = doc
            this.overlay = overlay
            this.pendingOps = this.pendingOps.slice(ops.length)
            this.pendingVersion++
            this.overlayVersion++
            committed = true
            // Drop acknowledged ops durably before publishing the snapshot.
            await this.persistPending()
        })
        if (!committed) return
        await this.persist(gen)
        if (gen !== this.generation || this.disposed) return
        // Ops with no replayable delta (image/layer) can't ride the op log:
        // publish a full snapshot so peers re-bootstrap. Record our published
        // seq so we don't re-bootstrap from our own snapshot.
        //
        // Except when the server reports `merged`: the stored snapshot is
        // then a superset of what we sent (a concurrent tablet edit was
        // union-merged server-side). Recording that seq as our own would hide
        // the tablet's content forever (zero ops to carry it, no later
        // snapshot would out-seq ours). Leave lastSnapshotSeq behind instead,
        // so the next pullOps re-bootstraps from the merged snapshot; pending
        // ops queued meanwhile survive (replay onto the new base).
        if (!complete) {
            const { seq, merged } = await this.transport.putSnapshot!(
                this.docId,
                this.pageId,
                encodeSnapshot(doc.serialize(), overlay),
            )
            if (!merged && gen === this.generation && !this.disposed) {
                this.lastSnapshotSeq = Math.max(this.lastSnapshotSeq, seq)
                await this.persist(gen) // record the published seq durably
            }
        }
    }

    /** Stage the snapshot and its operation tail before replacing the current page. */
    private async pullOps(gen: number): Promise<boolean> {
        const active = () => gen === this.generation && !this.disposed
        const connection = this.transport.pageEventsConnection
        const sinceSnapshot = this.bootstrapped ? this.lastSnapshotSeq : undefined
        let snap = await this.transport.getSnapshot!(this.docId, this.pageId, sinceSnapshot)
        if (!active()) return false
        if (snap && sinceSnapshot !== undefined && snap.seq <= sinceSnapshot) snap = null
        // A live socket covers edits accepted after this checkpoint was read.
        const skipTail = sinceSnapshot === undefined && snap?.complete === true &&
            connection !== undefined && connection === this.transport.pageEventsConnection &&
            this.pendingOps.length === 0
        let records: OpRecord[]
        try {
            records = skipTail ? [] : await this.transport.opsSince!(this.docId, this.pageId, snap?.opSeq ?? this.opCursor, snap?.seq ?? this.lastSnapshotSeq)
        } catch (e) {
            if (!active()) return false
            if (!(e instanceof EngineFailure) || (e.error._tag !== 'OpsTruncated' && e.error._tag !== 'CheckpointChanged')) throw e
            // The checkpoint may have advanced between the snapshot and tail requests.
            snap = await this.transport.getSnapshot!(this.docId, this.pageId)
            if (!active()) return false
            records = await this.transport.opsSince!(this.docId, this.pageId, snap?.opSeq ?? 0, snap?.seq ?? 0)
        }
        if (!active()) return false

        const batch = records.map((r) => decodeOp(r.op))
        // A replacement paints the final checkpoint and tail together. Keep
        // follow-up repairs separate, after the source shapes are installed.
        const publishReplacement = snap ? this.opts.onPatchBatch : undefined
        const repairs: ViewPatch[] = []
        const collectReplacement = snap ? (patch: ViewPatch) => {
            if (patch.type === 'shape-edited') repairs.push(patch)
            else if (!publishReplacement) this.opts.onPatch(patch)
        } : undefined
        const previous = snap && !snap.revert && this.bootstrapped ? this.baseDoc : null
        let nativeBytes: Uint8Array | undefined
        if (snap) {
            const { rm, overlay } = decodeSnapshot(snap.bytes)
            this.baseDoc = RmDocument.parse(rm)
            nativeBytes = rm
            // The explicit revert can rewind versions. Ordinary checkpoints merge
            // with the existing overlay to retain already-known newer records.
            this.overlay = snap.revert ? overlay : mergeOverlayDocuments(this.overlay, overlay)
            this.opCursor = snap.opSeq
            this.lastSnapshotSeq = snap.seq
            this.overlayVersion++
        }
        const snapshotBase = snap ? this.baseDoc : null
        // A single-patch subscriber also observes the individual changes since
        // this checkpoint. Compare ink after the tail has established ownership.
        const priorInk = snap && !publishReplacement && batch.some(op => op.op === 'add' || op.op === 'tombstone')
            ? snapshotKnownState(this.baseDoc) : null
        if (records.length) {
            this.applyOpBatch(batch, collectReplacement)
            this.opCursor = records[records.length - 1]!.seq
        }
        const replayedInk = snapshotBase && snapshotBase !== this.baseDoc
        const repaired = snap ? this.runAudit(collectReplacement, {
            previous: replayedInk ? snapshotBase : previous,
            beforeSnapshot: replayedInk ? previous : null,
        }) : false
        if (priorInk) {
            const diff = diffPage(priorInk, this.baseDoc, this.overlay)
            if (diff.foreignAdds.length) this.opts.onPatch({ type: 'ink-added', items: diff.foreignAdds })
            if (diff.foreignDeletes.length) this.opts.onPatch({ type: 'ink-removed', items: diff.foreignDeletes })
        }
        if (snap) {
            const patch = { type: 'document-replaced' } as const
            if (publishReplacement) publishReplacement([patch])
            else this.opts.onPatch(patch)
            for (const repair of repairs) this.opts.onPatch(repair)
        }
        const first = !this.bootstrapped
        if (first || snap || records.length || this.checkpointDirty) {
            await this.persist(gen, records.length || repaired ? undefined : nativeBytes)
        }
        if (!active()) return false
        if (first) {
            this.bootstrapped = true
            this.opts.onPageAvailable?.()
        }
        return skipTail
    }

    /** Apply a decoded op batch: ink via the proven differ/reconcile path
     *  (foreign-only patches, overlay repair/detach), overlay via the wall-clock
     *  LWW register (mergeOverlayOp, D7). A patch is emitted only when the merge
     *  actually changed the live overlay — a STALE op (lower version) or our own
     *  echo (equal version) is dropped, so the view never churns or "flips back"
     *  to an older edit. */
    private applyOpBatch(batch: Op[], capture?: (patch: ViewPatch) => void): void {
        const patches: ViewPatch[] = []
        const publish = () => {
            if (patches.length) this.opts.onPatchBatch?.(patches.splice(0))
        }
        const emit = capture ?? ((patch: ViewPatch) => {
            if (this.opts.onPatchBatch && patch.type !== 'shape-edited') {
                patches.push(patch)
                return
            }
            // A repair projects a local write using the state at this point in
            // the pull. Apply earlier paints before handing off the repair.
            publish()
            this.opts.onPatch(patch)
        })
        const inkOps = batch.filter(
            (o): o is AddItemOp | TombstoneOp => o.op === 'add' || o.op === 'tombstone',
        )
        if (inkOps.length > 0) {
            const remote = this.baseDoc.forkForInkEdits()
            applyInkDeltas(remote, inkOps)
            if (capture) {
                // Checkpoint replacement audits only after the native and
                // overlay sides of the tail are both present.
                this.baseDoc = remote
                this.overlayVersion++
            } else {
                this.integrateRemote(remote, emit)
            }
        }
        for (const op of batch) {
            if (op.op !== 'upsert-object' && op.op !== 'delete-object') continue
            const before = this.overlay.shapes.find((s) => s.shapeId === op.id)
            const deletedAt = this.overlay.tombstones?.[op.id]
            const result = mergeOverlayOp(this.overlay, op)
            if (deletedAt !== this.overlay.tombstones?.[op.id]) this.overlayVersion++
            if (result.kind === 'none') continue // stale / idempotent echo: no churn
            if (result.kind === 'upsert') {
                // suppress a no-op echo: the winning upsert is value-identical to
                // what we already render (our own edit round-tripping back).
                if (before && shapesEqual(before, result.shape)) continue
                this.overlayVersion++
                emit({ type: 'shape-upserted', shape: result.shape })
            } else {
                if (!result.existed) continue // tombstone recorded, nothing to un-render
                this.overlayVersion++
                emit({ type: 'shape-removed', shapeId: result.shapeId })
            }
        }
        publish()
    }

    /** Diff a fresh remote doc against our base; ADOPT it; then emit patches. */
    private integrateRemote(remote: RmDocument, emit: (patch: ViewPatch) => void): void {
        const known = snapshotKnownState(this.baseDoc)
        // device MOVES (tombstone + re-add with moveId) first: rewrite the
        // overlay refs to the successors so the diff below never classifies
        // a move as an erase (text truncation, spurious detach)
        const rewrites = applyMoveRewrites(this.baseDoc, remote, this.overlay)
        for (const [shapeId, delta] of rewrites.moved) {
            emit({ type: 'shape-moved', shapeId, dx: delta.dx, dy: delta.dy })
        }
        const diff = diffPage(known, remote, this.overlay)
        // Adopt before emitting: the ink-added handler re-walks
        // session.document to render new items, so emitting while the
        // session still exposed the old base would find nothing and the
        // stroke would silently never render.
        this.baseDoc = remote
        this.overlayVersion++
        for (const shapeId of rewrites.detached) emit({ type: 'shape-detached', shapeId })
        if (diff.foreignAdds.length > 0) emit({ type: 'ink-added', items: diff.foreignAdds })
        if (diff.foreignDeletes.length > 0) {
            emit({ type: 'ink-removed', items: diff.foreignDeletes })
        }
        for (const decision of reconcilePolicy(diff, this.overlay)) {
            if (decision.type === 'repair') {
                emit({ type: 'shape-edited', shapeId: decision.shapeId, edit: decision.edit })
            } else if (decision.type === 'remove') {
                this.overlay.shapes = this.overlay.shapes.filter((s) => s.shapeId !== decision.shapeId)
                emit({ type: 'shape-removed', shapeId: decision.shapeId })
            } else {
                const shape = this.overlay.shapes.find((s) => s.shapeId === decision.shapeId)
                if (shape) shape.state = 'detached'
                emit({ type: 'shape-detached', shapeId: decision.shapeId })
            }
        }
        this.runAudit(emit, { reconciledMoves: rewrites })
    }

    /**
     * Absolute overlay-vs-document consistency (see auditOverlay). Returns
     * true when the overlay was mutated and should be persisted.
     */
    private runAudit(
        emit = (patch: ViewPatch) => this.opts.onPatch(patch),
        { previous = null, beforeSnapshot, reconciledMoves }: {
            previous?: RmDocument | null
            beforeSnapshot?: RmDocument | null
            reconciledMoves?: ReturnType<typeof applyMoveRewrites>
        } = {},
    ): boolean {
        let changed = false
        const rewrites = reconciledMoves ?? applyMoveRewrites(previous, this.baseDoc, this.overlay, beforeSnapshot)
        if (!reconciledMoves) {
            if (rewrites.changed) {
                changed = true
                this.overlayVersion++
            }
            for (const [shapeId, delta] of rewrites.moved) {
                emit({ type: 'shape-moved', shapeId, dx: delta.dx, dy: delta.dy })
            }
            for (const shapeId of rewrites.detached) emit({ type: 'shape-detached', shapeId })
        }
        for (const decision of auditOverlay(this.baseDoc, this.overlay)) {
            if (decision.type === 'remove') {
                this.overlay.shapes = this.overlay.shapes.filter(
                    (s) => s.shapeId !== decision.shapeId,
                )
                changed = true
                this.overlayVersion++
                emit({ type: 'shape-removed', shapeId: decision.shapeId })
            } else if (decision.type === 'detach') {
                const shape = this.overlay.shapes.find((s) => s.shapeId === decision.shapeId)
                if (shape) {
                    shape.state = 'detached'
                    changed = true
                    this.overlayVersion++
                }
                emit({ type: 'shape-detached', shapeId: decision.shapeId })
            } else {
                emit({
                    type: 'shape-edited',
                    shapeId: decision.shapeId,
                    edit: decision.edit,
                })
            }
        }
        if (rewrites.rebindDetached()) {
            changed = true
            this.overlayVersion++
        }
        return changed
    }
}

/** A bounded message string for a failure report — never note content. */
function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message
    return String(e)
}

/** Deep value-equality of two overlay shapes (stable field order, so JSON is a
 *  safe comparison) — used to suppress echoes of our own upserts without
 *  dropping a genuinely-different concurrent edit to the same id. */
function shapesEqual(a: OverlayShape, b: OverlayShape): boolean {
    const tuple = (s: OverlayShape) =>
        JSON.stringify([s.kind, s.props, s.x, s.y, s.rotation, s.opacity, s.opacityVersion, s.rendered, s.renderRevision, s.state, s.browserIndex, s.browserIndexVersion])
    return tuple(a) === tuple(b)
}
