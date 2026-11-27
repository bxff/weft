/**
 * Persistence backends for the local-first store: MemoryStorage for
 * tests/SSR, IdbStorage for the browser (no deps).
 */

export type StorageEntry = readonly [key: string, value: Uint8Array]
type StoragePair = [Uint8Array | null, Uint8Array | null]

export interface KeyValueStorage {
    get(key: string): Promise<Uint8Array | null>
    set(key: string, value: Uint8Array): Promise<void>
    /** Read the matching values from one committed checkpoint. */
    getPair(first: string, second: string): Promise<StoragePair>
    /** Check ownership when starting the atomic write, after any storage wait. */
    setPair(first: StorageEntry, second: StorageEntry, mayWrite?: () => boolean): Promise<void>
    /** Atomically retire a confirmed request and save its authoritative checkpoint. */
    commitSave?(checkpoint: readonly StorageEntry[], queueKey: string, queue: Uint8Array | null, mayWrite: () => boolean): Promise<boolean>
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
    async commitSave(checkpoint: readonly StorageEntry[], queueKey: string, queue: Uint8Array | null, mayWrite: () => boolean): Promise<boolean> {
        if (!mayWrite()) return false
        const copies = checkpoint.map(([key, value]) => [key, value.slice()] as const)
        const next = queue?.slice()
        for (const [key, bytes] of copies) this.map.set(key, bytes)
        if (next) this.map.set(queueKey, next)
        else this.map.delete(queueKey)
        return true
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
        run: (store: IDBObjectStore) => () => T,
    ): Promise<T> {
        const db = await this.db
        return new Promise<T>((resolve, reject) => {
            const transaction = db.transaction(STORE, mode)
            transaction.onabort = () => reject(transaction.error ?? new DOMException('Storage transaction aborted', 'AbortError'))
            let readResult: () => T
            try {
                readResult = run(transaction.objectStore(STORE))
            } catch (error) {
                transaction.abort()
                reject(error)
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
    async commitSave(checkpoint: readonly StorageEntry[], queueKey: string, queue: Uint8Array | null, mayWrite: () => boolean): Promise<boolean> {
        return this.transaction('readwrite', (store) => {
            if (!mayWrite()) return () => false
            for (const [key, value] of checkpoint) store.put(value, key)
            if (queue) store.put(queue, queueKey)
            else store.delete(queueKey)
            return () => true
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
