/**
 * The app's single IndexedDB key-value store. Holds per-page replicas
 * (`page/{doc}/{page}/base|state`), the replica-sweep index
 * (`meta/replica-index`), and the thumbnail cache (`thumb/…`, `thumbmeta/…`).
 */
import { IdbStorage, MemoryStorage, type KeyValueStorage } from '@weft/sync-engine'

export const idb: KeyValueStorage =
    typeof indexedDB !== 'undefined' ? new IdbStorage() : new MemoryStorage()
