/**
 * Authed binary loads for cloud mode. Browsers can't put the auth header on
 * <img src> or hand pdf.js a bearer via URL, so these fetch with the auth
 * header and return a blob: URL (no token in the URL, nothing leaks to logs).
 */
import { apiBase } from './settings'
import { getAuthToken } from './auth'
import { idb } from './idb'
import { libraryCacheScope } from './library-cache'

/** Authorization header for the current session, or {} when signed out. */
export async function authHeaders(relay = apiBase()): Promise<Record<string, string>> {
    if (apiBase() !== relay) throw new Error('The relay changed')
    const token = await getAuthToken()
    if (apiBase() !== relay) throw new Error('The relay changed')
    return token ? { authorization: `Bearer ${token}` } : {}
}

// path -> object URL, bounded LRU. Object URLs hold their Blob until revoked,
// so cap the cache and revoke on eviction. (Map insertion order = LRU order;
// re-inserting on hit moves an entry to the most-recent end.)
const MAX_BLOBS = 256
const blobCache = new Map<string, string>()

// Negative cache: a 404 (asset genuinely absent) is remembered briefly so
// reactive re-renders don't refetch every missing asset in a tight loop. Only
// 404s: a 401/429/5xx may succeed on retry. TTL is short so it only absorbs
// render-churn bursts (a longer TTL keeps a once-missing thumbnail blank across
// a navigate-away-and-back with no refetch).
const MISS_TTL_MS = 30_000
const missCache = new Map<string, number>()
let thumbnailGeneration = 0

/** Forget every remembered miss so the next render re-attempts each absent
 *  asset once. Called when new content may have arrived. */
export function clearAssetMisses(): void {
    thumbnailGeneration++
    missCache.clear()
}

/** Fetch an API binary path with auth and return a blob: URL (or null). */
export async function fetchBlobUrl(path: string): Promise<string | null> {
    const cached = blobCache.get(path)
    if (cached) {
        blobCache.delete(path)
        blobCache.set(path, cached) // mark most-recently-used
        return cached
    }
    const missedAt = missCache.get(path)
    if (missedAt !== undefined) {
        if (Date.now() < missedAt + MISS_TTL_MS) return null
        missCache.delete(path)
    }
    try {
        const r = await fetch(`${apiBase()}${path}`, {
            headers: await authHeaders(),
        })
        if (r.status === 204 || r.status === 404) {
            missCache.set(path, Date.now())
            if (missCache.size > 1024) {
                const oldest = missCache.keys().next().value as string
                missCache.delete(oldest)
            }
            return null
        }
        if (!r.ok) return null
        const url = URL.createObjectURL(await r.blob())
        blobCache.set(path, url)
        // evict + revoke the oldest entries past the cap
        while (blobCache.size > MAX_BLOBS) {
            const oldest = blobCache.keys().next().value as string
            const stale = blobCache.get(oldest)
            blobCache.delete(oldest)
            if (stale) URL.revokeObjectURL(stale)
        }
        return url
    } catch {
        return null
    }
}

// Thumbnail SWR cache. Thumbnails persist in IndexedDB (`thumb/{path}` bytes +
// `thumbmeta/{path}` {etag}), so the library renders instantly and offline. A
// cache hit still revalidates in the background with If-None-Match: server
// answers 304 when unchanged, 200 with new bytes when re-rendered; the caller
// swaps the image in place via `fresh`.

export interface ThumbnailResult {
    /** what to render right now (cached or freshly fetched), or null */
    url: string | null
    /** background revalidation: a REPLACEMENT url when the server had newer
     *  bytes, null when the thumbnail is gone, undefined when unchanged */
    fresh: Promise<string | null | undefined>
}

// path -> { etag, url }: reuse one object URL per cached thumbnail across
// re-renders (a fresh URL per render leaks its Blob until tab close). Cap
// generously: a whole library renders at once, so eviction under a tight cap
// would revoke a URL a mounted <img> still shows, blanking it.
const MAX_THUMB_URLS = 4096
const thumbUrls = new Map<string, { etag: string; url: string }>()

function thumbUrlFor(path: string, etag: string, bytes: Uint8Array): string {
    const hit = thumbUrls.get(path)
    if (hit && hit.etag === etag) {
        thumbUrls.delete(path)
        thumbUrls.set(path, hit) // most-recently-used
        return hit.url
    }
    if (hit) URL.revokeObjectURL(hit.url)
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }))
    thumbUrls.set(path, { etag, url })
    while (thumbUrls.size > MAX_THUMB_URLS) {
        const oldest = thumbUrls.keys().next().value as string
        const stale = thumbUrls.get(oldest)
        thumbUrls.delete(oldest)
        if (stale) URL.revokeObjectURL(stale.url)
    }
    return url
}

async function readThumbCache(
    path: string,
): Promise<{ bytes: Uint8Array; etag: string } | null> {
    try {
        const bytes = await idb.get(`thumb/${path}`)
        const metaRaw = await idb.get(`thumbmeta/${path}`)
        if (!bytes || !metaRaw) return null
        const meta = JSON.parse(new TextDecoder().decode(metaRaw)) as { etag?: string }
        return { bytes, etag: meta.etag ?? '' }
    } catch {
        return null
    }
}

async function writeThumbCache(path: string, bytes: Uint8Array, etag: string): Promise<void> {
    try {
        await idb.set(`thumb/${path}`, bytes)
        await idb.set(`thumbmeta/${path}`, new TextEncoder().encode(JSON.stringify({ etag })))
    } catch {
        // cache is best-effort (private mode, quota)
    }
}

async function dropThumbCache(path: string): Promise<void> {
    try {
        await idb.delete(`thumb/${path}`)
        await idb.delete(`thumbmeta/${path}`)
    } catch {
        // best-effort
    }
}

/** Fetch a thumbnail path: cached copy now, background revalidation behind. */
export async function fetchThumbnail(path: string): Promise<ThumbnailResult> {
    const relay = apiBase()
    const scope = libraryCacheScope()
    if (!scope) return { url: null, fresh: Promise.resolve(undefined) }
    const key = `${scope}/${path}`
    const generation = thumbnailGeneration
    const stillSelected = () => scope === libraryCacheScope() && generation === thumbnailGeneration
    const cached = await readThumbCache(key)
    if (!stillSelected()) return { url: null, fresh: Promise.resolve(undefined) }
    if (cached) {
        const url = thumbUrlFor(key, cached.etag, cached.bytes)
        const fresh = (async (): Promise<string | null | undefined> => {
            try {
                const headers = await authHeaders(relay)
                if (!stillSelected()) return undefined
                if (cached.etag) headers['if-none-match'] = cached.etag
                const r = await fetch(`${relay}${path}`, { headers })
                if (!stillSelected()) return undefined
                if (r.status === 304) return undefined
                if (r.status === 204 || r.status === 404) {
                    await dropThumbCache(key)
                    return null
                }
                if (!r.ok) return undefined // transient: keep the cache
                const bytes = new Uint8Array(await r.arrayBuffer())
                if (!stillSelected()) return undefined
                const etag = r.headers.get('etag') ?? ''
                await writeThumbCache(key, bytes, etag)
                return stillSelected() ? thumbUrlFor(key, etag, bytes) : undefined
            } catch {
                return undefined // offline: the cache stands
            }
        })()
        return { url, fresh }
    }
    // no cache: one plain fetch (with the shared negative cache)
    const missedAt = missCache.get(key)
    if (missedAt !== undefined && Date.now() < missedAt + MISS_TTL_MS) {
        return { url: null, fresh: Promise.resolve(undefined) }
    }
    missCache.delete(key)
    try {
        const headers = await authHeaders(relay)
        if (!stillSelected()) return { url: null, fresh: Promise.resolve(undefined) }
        const r = await fetch(`${relay}${path}`, { headers })
        if (!stillSelected()) return { url: null, fresh: Promise.resolve(undefined) }
        if (r.status === 204 || r.status === 404) {
            missCache.set(key, Date.now())
            return { url: null, fresh: Promise.resolve(undefined) }
        }
        if (!r.ok) return { url: null, fresh: Promise.resolve(undefined) }
        const bytes = new Uint8Array(await r.arrayBuffer())
        if (!stillSelected()) return { url: null, fresh: Promise.resolve(undefined) }
        const etag = r.headers.get('etag') ?? ''
        await writeThumbCache(key, bytes, etag)
        return { url: stillSelected() ? thumbUrlFor(key, etag, bytes) : null, fresh: Promise.resolve(undefined) }
    } catch {
        return { url: null, fresh: Promise.resolve(undefined) }
    }
}

// Data-URL variant for tldraw image assets: tldraw rejects the blob: protocol
// on props.src (throws, crashes the editor), so embedded images use a data:
// URL. Data URLs are larger (base64 in memory), so this cache is smaller.
const MAX_DATA = 64

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(fr.result as string)
        fr.onerror = () => reject(fr.error ?? new Error('read failed'))
        fr.readAsDataURL(blob)
    })
}

const photos = new Map<string, { etag: string; url: string }>()

async function readPhoto(key: string): Promise<{ bytes: Uint8Array; etag: string } | null> {
    try {
        const [bytes, meta] = await idb.getPair(`asset/${key}`, `assetmeta/${key}`)
        return bytes && meta ? { bytes, etag: new TextDecoder().decode(meta) } : null
    } catch {
        return null
    }
}

async function photoUrl(key: string, etag: string, bytes: Uint8Array, mime: string): Promise<string> {
    const cached = photos.get(key)
    if (etag && cached?.etag === etag) return cached.url
    const url = await blobToDataUrl(new Blob([bytes as BlobPart], { type: mime }))
    if (etag) {
        photos.delete(key)
        photos.set(key, { etag, url })
        if (photos.size > MAX_DATA) photos.delete(photos.keys().next().value!)
    }
    return url
}

async function writePhoto(key: string, bytes: Uint8Array, etag: string, current: () => boolean): Promise<boolean> {
    try {
        await idb.setPair([`asset/${key}`, bytes], [`assetmeta/${key}`, new TextEncoder().encode(etag)], current)
        return true
    } catch {
        // The decoded network result remains usable when storage is unavailable.
        return false
    }
}

export async function seedAssetBytes(path: string, bytes: Uint8Array, scope: string | null): Promise<void> {
    if (scope) await writePhoto(`${scope}/${path}`, bytes, '', () => scope === libraryCacheScope())
}

/** Present cached pixels immediately, then revalidate the selected account's file. */
export async function fetchDataUrl(
    path: string,
    mime: string,
    onCached: (url: string) => void,
    signal: AbortSignal,
): Promise<string | null> {
    const relay = apiBase()
    const initialScope = libraryCacheScope()
    try {
        // Get the first request's credentials while the scoped disk cache
        // is read, but do not make a warm preview wait for authentication.
        const firstHeaders = authHeaders(relay).catch(() => null)
        if (initialScope === null && !await firstHeaders) return null
        const scope = libraryCacheScope()
        if (initialScope !== null && initialScope !== scope) return null
        const current = () => !signal.aborted && apiBase() === relay && scope === libraryCacheScope()
        const key = scope ? `${scope}/${path}` : null
        const cached = key ? await readPhoto(key) : null
        if (!current()) return null
        if (key && cached) {
            const url = await photoUrl(key, cached.etag, cached.bytes, mime)
            if (!current()) return null
            onCached(url)
        }
        const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
        for (let attempt = 0; attempt < 3 && current(); attempt++) {
            // No need to re-read the cache before the first request. The
            // commit below still compares against newer writes from other tabs.
            const observed = attempt === 0 ? cached : key ? await readPhoto(key) : null
            // Old relays used the filename itself as ETag. Only send a
            // content validator so they cannot preserve a stale cache hit.
            const etag = observed && /^"[0-9a-f]{64}"$/.test(observed.etag) ? observed.etag : null
            const headers = attempt === 0 ? await firstHeaders : await authHeaders(relay)
            if (!headers || !current()) return null
            const response = await fetch(`${relay}${path}`, {
                cache: 'no-store',
                signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
                headers: { ...headers, ...(etag && { 'if-none-match': etag }) },
            })
            if (!current()) return null
            const unchanged = response.status === 304 && observed !== null
            if (!unchanged && (!response.ok || response.status === 204)) return null

            const bytes = unchanged ? observed.bytes : new Uint8Array(await response.arrayBuffer())
            if (!current()) return null
            let revision = unchanged ? observed.etag : response.headers.get('etag') ?? ''
            if (!/^"[0-9a-f]{64}"$/.test(revision) && globalThis.crypto?.subtle) {
                const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
                revision = 'local:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
            }
            let checkRevision = false
            if (key) {
                const commit = async () => {
                    const stored = await readPhoto(key)
                    if (!current()) return false
                    // A different response landed while this fetch was pending.
                    // Revalidate from that revision without overwriting it.
                    if (stored?.etag !== observed?.etag && stored?.etag !== revision) return false
                    checkRevision = unchanged || await writePhoto(key, bytes, revision, current)
                    return current()
                }
                const confirmed = locks
                    ? await locks.request(`weft-photo/${key}`, { signal }, commit)
                    : await commit()
                if (!confirmed) continue
            }
            const url = await photoUrl(key ?? path, key ? revision : '', bytes, mime)
            if (!current()) return null
            if (key && checkRevision && (await readPhoto(key))?.etag !== revision) continue
            return current() ? url : null
        }
        return null
    } catch {
        return null
    }
}
