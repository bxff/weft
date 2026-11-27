/**
 * Persistence backends for the local-first store: MemoryStorage for
 * tests/SSR, IdbStorage for the browser (no deps).
 */

export type StorageEntry = readonly [key: string, value: Uint8Array]
export type StoragePair = readonly [Uint8Array | null, Uint8Array | null]

type SaveCommit = {
    expected: StoragePair
    checkpoint: readonly [StorageEntry, StorageEntry]
    queue?: { key: string; bytes: Uint8Array | null }
    mayWrite: () => boolean
}
type SaveResult = 'committed' | 'conflict' | 'inactive'

export function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
    return a === b || (!!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]))
}

function validateSave({ checkpoint, queue }: SaveCommit): void {
    const keys = [...checkpoint.map(([key]) => key), ...(queue ? [queue.key] : [])]
    if (checkpoint.length !== 2 || !keys.every(Boolean) || new Set(keys).size !== keys.length) {
        throw new Error('Invalid atomic save checkpoint')
    }
}

export interface KeyValueStorage {
    get(key: string): Promise<Uint8Array | null>
    set(key: string, value: Uint8Array): Promise<void>
    /** Read the matching values from one committed checkpoint. */
    getPair(first: string, second: string): Promise<StoragePair>
    /** Check ownership when starting the atomic write, after any storage wait. */
    setPair(first: StorageEntry, second: StorageEntry, mayWrite?: () => boolean): Promise<void>
    /** Atomically retire a confirmed request and save its authoritative checkpoint. */
    commitSave?(commit: SaveCommit): Promise<SaveResult>
    delete(key: string, ...others: string[]): Promise<void>
    keys(prefix: string): Promise<string[]>
    /** Commit both changes together. Required for orphan queue adoption. */
    setAndDelete?(key: string, value: Uint8Array, deleteKey: string): Promise<void>
}

export class MemoryStorage implements KeyValueStorage {
    private map = new Map<string, Uint8Array>()

    async get(key: string): Promise<Uint8Array | null> {
        const v = this.map.get(key)
        return v ? v.slice() : null
    }
    async set(key: string, value: Uint8Array): Promise<void> {
        this.map.set(key, value.slice())
    }
    async getPair(first: string, second: string): Promise<StoragePair> {
        return [this.map.get(first)?.slice() ?? null, this.map.get(second)?.slice() ?? null]
    }
    async setPair(first: StorageEntry, second: StorageEntry, mayWrite?: () => boolean): Promise<void> {
        if (mayWrite && !mayWrite()) return
        const firstValue = first[1].slice()
        const secondValue = second[1].slice()
        this.map.set(first[0], firstValue)
        this.map.set(second[0], secondValue)
    }
    async commitSave(commit: SaveCommit): Promise<SaveResult> {
        validateSave(commit)
        const { checkpoint, expected, queue, mayWrite } = commit
        if (!mayWrite()) return 'inactive'
        if (!checkpoint.every(([key], i) => sameBytes(this.map.get(key) ?? null, expected[i]!))) {
            return 'conflict'
        }
        const copies = checkpoint.map(([key, value]) => [key, value.slice()] as const)
        const next = queue?.bytes?.slice()
        for (const [key, bytes] of copies) this.map.set(key, bytes)
        if (queue) {
            if (next) this.map.set(queue.key, next)
            else this.map.delete(queue.key)
        }
        return 'committed'
    }
    async delete(key: string, ...others: string[]): Promise<void> {
        this.map.delete(key)
        for (const other of others) this.map.delete(other)
    }
    async setAndDelete(key: string, value: Uint8Array, deleteKey: string): Promise<void> {
        this.map.set(key, value.slice())
        this.map.delete(deleteKey)
    }
    async keys(prefix: string): Promise<string[]> {
        return [...this.map.keys()].filter((k) => k.startsWith(prefix))
    }
}

const DB_NAME = 'weft'
const STORE = 'pages'

export class IdbStorage implements KeyValueStorage {
    private db: Promise<IDBDatabase>

    constructor() {
        this.db = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1)
            req.onupgradeneeded = () => req.result.createObjectStore(STORE)
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error)
        })
    }

    private async transaction<T>(
        mode: IDBTransactionMode,
        run: (store: IDBObjectStore, abortWith: (error: unknown) => void) => () => T,
    ): Promise<T> {
        const db = await this.db
        return new Promise<T>((resolve, reject) => {
            const transaction = db.transaction(STORE, mode)
            transaction.onabort = () => reject(transaction.error ?? new DOMException('Storage transaction aborted', 'AbortError'))
            let readResult: () => T
            const abortWith = (error: unknown) => {
                reject(error)
                try { transaction.abort() } catch { /* already inactive */ }
            }
            try {
                readResult = run(transaction.objectStore(STORE), abortWith)
            } catch (error) {
                abortWith(error)
                return
            }
            // Request success can still be followed by a transaction abort.
            transaction.oncomplete = () => resolve(readResult())
        })
    }

    private tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
        return this.transaction(mode, (store) => {
            const request = run(store)
            return () => request.result
        })
    }

    private readBytes(value: unknown): Uint8Array | null {
        return value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : null
    }

    async get(key: string): Promise<Uint8Array | null> {
        const v = await this.tx<unknown>('readonly', (s) => s.get(key) as IDBRequest<unknown>)
        return this.readBytes(v)
    }
    async set(key: string, value: Uint8Array): Promise<void> {
        await this.tx('readwrite', (s) => s.put(value, key))
    }
    getPair(first: string, second: string): Promise<StoragePair> {
        return this.transaction('readonly', (store) => {
            const firstRequest = store.get(first)
            const secondRequest = store.get(second)
            return () => [this.readBytes(firstRequest.result), this.readBytes(secondRequest.result)]
        })
    }
    async setPair(first: StorageEntry, second: StorageEntry, mayWrite?: () => boolean): Promise<void> {
        await this.transaction('readwrite', (store) => {
            if (!mayWrite || mayWrite()) {
                store.put(first[1], first[0])
                store.put(second[1], second[0])
            }
            return () => {}
        })
    }
    async commitSave(commit: SaveCommit): Promise<SaveResult> {
        validateSave(commit)
        return this.transaction('readwrite', (store, abortWith) => {
            const { checkpoint, expected, queue, mayWrite } = commit
            let result: SaveResult = 'inactive'
            const reads = checkpoint.map(([key]) => store.get(key))
            reads[1]!.onsuccess = () => {
                try {
                    if (!mayWrite()) return
                    if (!reads.every((read, i) => {
                        const bytes = this.readBytes(read.result)
                        return (read.result === undefined || bytes !== null) && sameBytes(bytes, expected[i]!)
                    })) {
                        result = 'conflict'
                        return
                    }
                    for (const [key, value] of checkpoint) store.put(value, key)
                    if (queue) {
                        if (queue.bytes) store.put(queue.bytes, queue.key)
                        else store.delete(queue.key)
                    }
                    result = 'committed'
                } catch (error) { abortWith(error) }
            }
            return () => result
        })
    }
    async delete(key: string, ...others: string[]): Promise<void> {
        await this.transaction('readwrite', (store) => {
            store.delete(key)
            for (const other of others) store.delete(other)
            return () => {}
        })
    }
    async setAndDelete(key: string, value: Uint8Array, deleteKey: string): Promise<void> {
        await this.tx('readwrite', (store) => {
            store.put(value, key)
            return store.delete(deleteKey)
        })
    }
    async keys(prefix: string): Promise<string[]> {
        const all = await this.tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys())
        return all.map(String).filter((k) => k.startsWith(prefix))
    }
}
