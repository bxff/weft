/** Transport singleton. The app always talks to a cloud server (hosted or
 *  self-hosted) with a bearer token; the tablet is a sync agent, not an app server. */
import { HttpTransport, EngineFailure, type DocumentInfo, type Transport } from '@weft/sync-engine'
import { connection, isSelfHosted, watchRelayChange } from './settings'
import { bearerMatchesClerkReplicaAccount, devUser, getAuthToken, localPreferenceOwner, selectedClerkReplicaAccount } from './auth'
import { cacheDocumentList, clearCachedDocumentList, libraryCacheScope, readCachedDocumentList } from './library-cache'

let instance: { relay: string; transport: HttpTransport; projectionAccount: string | null } | null = null
const projectionScopes = new WeakMap<Transport, { scope: string; valid: () => boolean }>()

export function projectionScope(source: Transport): string | undefined {
    const binding = projectionScopes.get(source)
    return instance?.transport === source && binding?.valid() ? binding.scope : undefined
}

export function needsHostedProjectionScope(): boolean {
    return import.meta.env.MODE === 'projection-journal-hosted-review' && !isSelfHosted()
}

let relayWatcher: AbortController | null = null

/** Check the selected owner on both sides of Clerk's asynchronous refresh. */
export async function readBoundBearer(
    authorized: () => boolean,
    matches: (bearer: string | null) => boolean,
    read: () => Promise<string | null> = getAuthToken,
): Promise<string | null> {
    if (!authorized()) throw new EngineFailure({ _tag: 'Unauthorized' })
    const bearer = await read()
    if (!authorized() || !matches(bearer)) throw new EngineFailure({ _tag: 'Unauthorized' })
    return bearer
}

export function transport(): HttpTransport {
    const relay = connection().cloudUrl
    const hosted = needsHostedProjectionScope()
    const account = hosted ? selectedClerkReplicaAccount() : null
    if (instance && (instance.relay !== relay || instance.projectionAccount !== account)) resetTransport()
    if (!instance) {
        relayWatcher = new AbortController()
        watchRelayChange(resetTransport, relayWatcher.signal)
        // Isolated, loopback-only proof. Do not silently switch an installed
        // browser to a fresh replica format; legacy ownership is unknown.
        const dev = import.meta.env.MODE === 'projection-journal-test' ? devUser() : ''
        const proof = dev &&
            /^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]+)?$/.test(relay) &&
            localPreferenceOwner() === `dev:${dev}` ? JSON.stringify([relay, dev]) : undefined
        const scope = account ? JSON.stringify([relay, 'clerk', account]) : proof || undefined
        const valid = () => connection().cloudUrl === relay &&
            (account ? needsHostedProjectionScope() && selectedClerkReplicaAccount() === account
                : localPreferenceOwner() === `dev:${dev}`)
        const transport: HttpTransport = new HttpTransport({
            baseUrl: relay,
            documentListBaseUrl: !isSelfHosted() && window.location.origin === import.meta.env.PUBLIC_WEFT_PAGES_ORIGIN
                ? window.location.origin : undefined,
            getAuthToken: (): Promise<string | null> => readBoundBearer(
                () => connection().cloudUrl === relay &&
                    (!scope || instance?.transport === transport && valid()),
                bearer => account ? bearerMatchesClerkReplicaAccount(bearer, account)
                    : !proof || bearer === `dev:${dev}`,
            ),
        })
        if (scope) projectionScopes.set(transport, { scope, valid })
        instance = { relay, transport, projectionAccount: account }
    }
    return instance.transport
}

/** Close the transport (and its WebSocket) and drop the singleton. Required on
 *  signOut: the WS auths once at connect, so a stale instance keeps an event
 *  stream open as the previous identity. */
export function resetTransport(): void {
    relayWatcher?.abort()
    relayWatcher = null
    instance?.transport.close()
    instance = null
}

/** UUID v4 for non-secure contexts: crypto.randomUUID is secure-context-only,
 *  but the app can be served over plain http; getRandomValues is always present. */
export function uuidv4(): string {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Stable per-browser client id (echo attribution). */
export function clientId(): string {
    const KEY = 'weft-client-id'
    let id = localStorage.getItem(KEY)
    if (!id) {
        id = `web-${uuidv4().slice(0, 8)}`
        localStorage.setItem(KEY, id)
    }
    return id
}

/** Engine author UUID (replica identity) for ink written by this tab. Per-tab,
 *  not per-install: a shared author would mint colliding (author, clock) CRDT
 *  ids. sessionStorage survives reloads and is distinct per tab. */
export function authorUuid(): string {
    const KEY = 'weft-author-uuid'
    let uuid = sessionStorage.getItem(KEY)
    if (!uuid) {
        uuid = uuidv4()
        sessionStorage.setItem(KEY, uuid)
    }
    return uuid
}

const authorLockName = (uuid: string) => `weft-author:${uuid}`

/** The final author identity for this tab. "Duplicate tab" copies
 *  sessionStorage, so two tabs can wake with the same author; each holds a
 *  tab-lifetime Web Lock on its author and mints a fresh identity if the lock
 *  is already held. Lock release on tab close is also how orphaned pending
 *  queues are detected. Without Web Locks, degrades to per-tab sessionStorage. */
let uniqueAuthor: Promise<string> | null = null
let lockedAuthor: string | null = null
export function holdsAuthorLease(author: string): boolean {
    return lockedAuthor === author
}

export function ensureUniqueAuthorUuid(): Promise<string> {
    if (uniqueAuthor) return uniqueAuthor
    uniqueAuthor = (async () => {
        let uuid = authorUuid()
        const locks = (globalThis.navigator as Navigator | undefined)?.locks
        if (!locks) return uuid
        for (let attempt = 0; attempt < 3; attempt++) {
            const acquired = await new Promise<boolean>((resolve) => {
                locks
                    .request(authorLockName(uuid), { ifAvailable: true }, (lock) => {
                        if (!lock) {
                            resolve(false)
                            return
                        }
                        lockedAuthor = uuid
                        resolve(true)
                        return new Promise<never>(() => {}) // hold for tab lifetime
                    })
                    .catch(() => resolve(true)) // lock failure: keep the id
            })
            if (acquired) return uuid
            uuid = uuidv4() // duplicated tab: mint a fresh identity
            sessionStorage.setItem('weft-author-uuid', uuid)
        }
        return uuid
    })()
    return uniqueAuthor
}

/** Run `fn` while exclusively holding `uuid`'s author lock; returns false (fn
 *  not run) if the lock is unavailable (that tab is alive and owns its queue).
 *  Holding the lock across the whole adopt closes the reopen race. Fails safe:
 *  no Web Locks -> never adopt. */
export async function adoptOrphanAuthor(
    uuid: string,
    fn: () => Promise<void>,
): Promise<boolean> {
    const locks = (globalThis.navigator as Navigator | undefined)?.locks
    if (!locks) return false
    try {
        return await locks.request(authorLockName(uuid), { ifAvailable: true }, async (lock) => {
            if (!lock) return false
            await fn()
            return true
        })
    } catch {
        return false
    }
}

interface DocumentListState {
    revision: number
    pending: Map<string | null, Promise<DocumentInfo[]>>
}

const documentLists = new WeakMap<HttpTransport, DocumentListState>()

/** Share metadata requests across views. A tablet update invalidates an
 * in-flight read before any view or cache can adopt its stale result. */
export function cachedDocuments(
    source: Transport = transport(),
    refresh = false,
): Promise<DocumentInfo[]> {
    const scope = libraryCacheScope()
    const selected = instance?.transport
    const unauthorized = () => new EngineFailure({ _tag: 'Unauthorized' })
    if (!selected || source !== selected) return Promise.reject(unauthorized())
    const isCurrent = () =>
        source === instance?.transport && (scope === null || scope === libraryCacheScope())

    let state = documentLists.get(selected)
    if (!state) {
        const created: DocumentListState = { revision: 0, pending: new Map() }
        selected.subscribeDocList(() => { created.revision++ })
        documentLists.set(selected, created)
        state = created
    }
    if (refresh) state.revision++
    const existing = state.pending.get(scope)
    if (existing) return existing

    const read = async (list: DocumentListState) => {
        while (isCurrent()) {
            const revision = list.revision
            try {
                const docs = await source.listDocuments()
                if (!isCurrent()) throw unauthorized()
                if (revision !== list.revision) continue
                cacheDocumentList(scope ?? libraryCacheScope(), docs)
                return docs
            } catch (error) {
                if (!isCurrent()) throw unauthorized()
                if (revision !== list.revision) continue
                if (error instanceof EngineFailure && error.error._tag === 'Unauthorized') {
                    clearCachedDocumentList(scope)
                    throw error
                }
                const cached = readCachedDocumentList(scope)
                if (cached) return cached
                throw error
            }
        }
        throw unauthorized()
    }
    const list = state
    const request = read(list).finally(() => list.pending.delete(scope))
    list.pending.set(scope, request)
    return request
}
