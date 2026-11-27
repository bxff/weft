/**
 * Replica LRU sweep. Each opened page leaves a replica in IndexedDB
 * (`page/{doc}/{page}/base` + `.../state`); on app start, once replicas total
 * more than MAX_BYTES the least-recently-opened are deleted down to
 * TARGET_BYTES.
 *
 * Hard rule: a replica with pending (unpushed) ops or a dirty overlay is
 * never swept, those bytes exist nowhere else (everything else re-bootstraps
 * from the cloud). The pending check reads the state blob fresh at delete
 * time, not from the index.
 *
 * The index (`meta/replica-index`: "doc/page" -> { at, bytes }) is updated on
 * session open (recency) and close (size) so the sweep can total without
 * reading hundreds of MB.
 */
import { idb } from './idb'

const INDEX_KEY = 'meta/replica-index'
export const MAX_BYTES = 200 * 1024 * 1024
export const TARGET_BYTES = 150 * 1024 * 1024

interface IndexEntry {
    /** last opened, epoch ms */
    at: number
    /** base + state size at last close (0 = not sized yet) */
    bytes: number
}
type ReplicaIndex = Record<string, IndexEntry>

const decoder = new TextDecoder()
const encoder = new TextEncoder()

// Replicas of pages open right now. The sweep skips these even if the recency
// index hasn't caught up, so it never deletes the replica being edited. Marked
// synchronously by the controller on open/dispose.
const inUse = new Set<string>()
export function markReplicaInUse(doc: string, page: string): void {
    inUse.add(`${doc}/${page}`)
}
export function clearReplicaInUse(doc: string, page: string): void {
    inUse.delete(`${doc}/${page}`)
}

// All index read-modify-writes serialize through this chain. The index is one
// IDB key updated by three async callers (open, close, sweep); without
// serialization their read/write windows interleave and lose updates.
let indexChain: Promise<unknown> = Promise.resolve()
function withIndex<T>(fn: (index: ReplicaIndex) => Promise<T> | T): Promise<T> {
    const run = indexChain.then(async () => {
        const index = await readIndex()
        return fn(index)
    })
    // keep the chain alive regardless of this link's outcome
    indexChain = run.catch(() => undefined)
    return run
}

async function readIndex(): Promise<ReplicaIndex> {
    try {
        const raw = await idb.get(INDEX_KEY)
        if (!raw) return {}
        return JSON.parse(decoder.decode(raw)) as ReplicaIndex
    } catch {
        return {}
    }
}

async function writeIndex(index: ReplicaIndex): Promise<void> {
    await idb.set(INDEX_KEY, encoder.encode(JSON.stringify(index)))
}

/** Bump a replica's recency — called when a page session opens. */
export async function noteReplicaOpened(doc: string, page: string): Promise<void> {
    try {
        await withIndex(async (index) => {
            const key = `${doc}/${page}`
            index[key] = { at: Date.now(), bytes: index[key]?.bytes ?? 0 }
            await writeIndex(index)
        })
    } catch {
        // the index is an optimization; sweep sizes unindexed replicas itself
    }
}

/** Record a replica's final size — called when a page session closes. */
export async function noteReplicaClosed(doc: string, page: string): Promise<void> {
    try {
        const bytes = await replicaBytes(`${doc}/${page}`)
        await withIndex(async (index) => {
            index[`${doc}/${page}`] = { at: Date.now(), bytes }
            await writeIndex(index)
        })
    } catch {
        // best-effort
    }
}

async function replicaBytes(key: string): Promise<number> {
    const [base, state] = await idb.getPair(`page/${key}/base`, `page/${key}/state`)
    return (base?.length ?? 0) + (state?.length ?? 0)
}

/** True when this replica holds bytes that exist nowhere else. */
export async function hasPendingWork(key: string): Promise<boolean> {
    // unflushed ops live under per-author keys: any pending queue on this page
    // is unpushed local work, never sweep it.
    const pending = await idb.keys(`page/${key}/pending/`)
    if (pending.length > 0 || (await idb.keys(`page/${key}/deferred/`)).length > 0) return true
    const raw = await idb.get(`page/${key}/state`)
    if (!raw) return false
    try {
        const state = JSON.parse(decoder.decode(raw)) as {
            pendingOps?: unknown[]
            overlayDirty?: boolean
        }
        // legacy pendingOps or an unflushed overlay = bytes nowhere else.
        return (state.pendingOps?.length ?? 0) > 0 || state.overlayDirty === true
    } catch {
        return true // unparseable: assume the worst, keep it
    }
}

export const primaryLockName = (key: string) => 'weft-page:' + key
const useLockName = (key: string) => primaryLockName(key) + '/use'

/** Hold shared access until the route or editor releases the page. */
export async function useReplica(key: string, signal: AbortSignal): Promise<void> {
    const locks = globalThis.navigator?.locks
    if (!locks) return
    await new Promise<void>((acquired, reject) => {
        void locks.request(useLockName(key), { mode: 'shared', signal }, () => {
            acquired()
            if (signal.aborted) return
            return new Promise<void>(release => signal.addEventListener('abort', () => release(), { once: true }))
        }).catch(reject)
    })
}

async function evictIdleReplica(key: string): Promise<boolean> {
    const remove = async () => {
        if (inUse.has(key) || await hasPendingWork(key)) return false
        await idb.delete(`page/${key}/base`, `page/${key}/state`)
        return true
    }
    const locks = globalThis.navigator?.locks
    // A persistent cache can be open in another tab. Without Web Locks the
    // browser still manages its own storage quota; only sweep private memory.
    if (!locks) return typeof indexedDB === 'undefined' && await remove()
    return locks.request(useLockName(key), { ifAvailable: true }, use => {
        if (!use) return false
        // Also respect editors opened before shared-use leases were introduced.
        return locks.request(primaryLockName(key), { ifAvailable: true }, primary => primary ? remove() : false)
    })
}

/** Run the sweep. Returns what it removed (for tests/telemetry). */
export async function sweepReplicas(): Promise<{ swept: number; bytes: number }> {
    try {
        return await withIndex(async (index) => {
            // the real replica set, from the store itself (the index may lag)
            const keys = await idb.keys('page/')
            const replicas = new Set<string>()
            for (const k of keys) {
                const m = /^page\/(.+)\/(base|state)$/.exec(k)
                if (m) replicas.add(m[1]!)
            }
            let indexDirty = false
            // drop index rows whose replica is gone; size rows the index missed
            for (const key of Object.keys(index)) {
                if (!replicas.has(key)) {
                    delete index[key]
                    indexDirty = true
                }
            }
            for (const key of replicas) {
                if (!index[key] || index[key].bytes === 0) {
                    index[key] = { at: index[key]?.at ?? 0, bytes: await replicaBytes(key) }
                    indexDirty = true
                }
            }
            let total = Object.values(index).reduce((n, e) => n + e.bytes, 0)
            let swept = 0
            let sweptBytes = 0
            if (total > MAX_BYTES) {
                const oldestFirst = Object.entries(index).sort((a, b) => a[1].at - b[1].at)
                for (const [key, entry] of oldestFirst) {
                    if (total <= TARGET_BYTES) break
                    if (!await evictIdleReplica(key)) continue
                    delete index[key]
                    indexDirty = true
                    total -= entry.bytes
                    swept++
                    sweptBytes += entry.bytes
                }
            }
            if (indexDirty) await writeIndex(index)
            return { swept, bytes: sweptBytes }
        })
    } catch {
        return { swept: 0, bytes: 0 } // a broken sweep must never break the app
    }
}
