/**
 * The app's single IndexedDB key-value store. Holds per-page replicas
 * (`page/{doc}/{page}/base|state`), the replica-sweep index
 * (`meta/replica-index`), and the thumbnail cache (`thumb/…`, `thumbmeta/…`).
 */
import { IdbStorage, MemoryStorage, type KeyValueStorage } from '@weft/sync-engine'

export const idb: KeyValueStorage =
    typeof indexedDB !== 'undefined' ? new IdbStorage() : new MemoryStorage()


const guardedReplicas = new Map<string, KeyValueStorage>()

/** The legacy runtime cannot scan, evict or parse guarded frozen outboxes. */
export function guardedReplicaStorage(scope: string): KeyValueStorage {
    let storage = guardedReplicas.get(scope)
    if (!storage) {
        storage = new IdbStorage(`weft-guarded-v1/${scope}`)
        guardedReplicas.set(scope, storage)
    }
    return storage
}
