/**
 * Source-file (PDF/EPUB underlay) access with a bounded offline cache. Files
 * <= SMALL_MAX are cached whole in a Cache API bucket; bigger files never
 * download whole (pdf.js Range-streams them). Each open makes one 1-byte probe
 * (Range: bytes=0-0 + If-None-Match); the etag is the file's revision, so a
 * 304 means the cached copy (or range plan) is current. The Cache API needs a
 * secure context: on plain http `caches` is undefined and everything degrades
 * to plain fetches.
 */
import { apiBase } from './settings'
import { authHeaders } from './authedAsset'
import { libraryCacheScope } from './library-cache'

export const SOURCE_CACHE = 'weft-files'
/** cache whole files up to this size; larger ones range-stream */
export const SMALL_MAX = 20 * 1024 * 1024
/** total bucket budget; least-recently-used entries evict past it */
export const CACHE_MAX = 300 * 1024 * 1024
const INDEX_KEY = 'weft-files-index'

interface SourceOwner {
    scope: string | null
    isCurrent(): boolean
}

export type SourceHandle = { kind: 'error'; detail: string } | (SourceOwner & (
    /** full bytes in hand (small, cached, or offline fallback). `etag` is the
     *  source revision for keying a rendered-page cache; '' when unknown. */
    | { kind: 'data'; data: ArrayBuffer; etag: string }
    /** hand pdf.js the URL: it Range-streams just the pages it renders */
    | {
          kind: 'range'
          url: string
          /** Header supplier, not a frozen snapshot: a large PDF ranges on
           *  demand for the whole session, so a bearer frozen at probe time
           *  would expire mid-read and 401 every later range. */
          getHeaders: () => Promise<Record<string, string>>
          size: number
          etag: string
      }
    /** the source is not resident on the cloud (tablet-only) */
    | { kind: 'cold' }
))

interface IndexEntry {
    bytes: number
    at: number
}

function readIndex(): Record<string, IndexEntry> {
    try {
        return JSON.parse(localStorage.getItem(INDEX_KEY) ?? '{}') as Record<string, IndexEntry>
    } catch {
        return {}
    }
}

function writeIndex(index: Record<string, IndexEntry>): void {
    try {
        localStorage.setItem(INDEX_KEY, JSON.stringify(index))
    } catch {
        // best-effort
    }
}

function touchIndex(url: string): void {
    const index = readIndex()
    if (index[url]) {
        index[url].at = Date.now()
        writeIndex(index)
    }
}

function dropIndex(url: string): void {
    const index = readIndex()
    if (index[url]) {
        delete index[url]
        writeIndex(index)
    }
}

async function openBucket(): Promise<Cache | null> {
    if (typeof caches === 'undefined') return null
    try {
        return await caches.open(SOURCE_CACHE)
    } catch {
        return null // e.g. Firefox private mode throws
    }
}

/** Store a whole file + record it in the LRU index; evict past the budget. */
async function putCache(
    bucket: Cache,
    url: string,
    data: ArrayBuffer,
    etag: string,
    mime: string | null,
): Promise<void> {
    try {
        await bucket.put(
            url,
            new Response(data, {
                headers: {
                    etag,
                    'content-type': mime ?? 'application/pdf',
                },
            }),
        )
        const index = readIndex()
        index[url] = { bytes: data.byteLength, at: Date.now() }
        // LRU eviction down to the budget (never the just-written entry)
        let total = Object.values(index).reduce((n, e) => n + e.bytes, 0)
        if (total > CACHE_MAX) {
            const oldestFirst = Object.entries(index).sort((a, b) => a[1].at - b[1].at)
            for (const [key, entry] of oldestFirst) {
                if (total <= CACHE_MAX) break
                if (key === url) continue // don't evict what we just cached
                await bucket.delete(key)
                delete index[key]
                total -= entry.bytes
            }
        }
        writeIndex(index)
    } catch {
        // caching is best-effort; the caller already has the bytes
    }
}

/** Resolve how to read a document's source file right now. */
export async function openSource(docId: string): Promise<SourceHandle> {
    const relay = apiBase()
    const startingScope = libraryCacheScope()
    const changed: SourceHandle = { kind: 'error', detail: 'The account or relay changed' }
    let headers: Record<string, string>
    try {
        // On a hosted cold open, the first authenticated request may be what
        // establishes the account. Resolve it before looking in local caches.
        headers = await authHeaders(relay)
    } catch (error) {
        return { kind: 'error', detail: String(error) }
    }
    const scope = libraryCacheScope()
    if (apiBase() !== relay || (startingScope !== null && startingScope !== scope)) return changed
    const owner: SourceOwner = {
        scope,
        isCurrent: () => apiBase() === relay && libraryCacheScope() === scope,
    }
    const getHeaders = async () => {
        if (!owner.isCurrent()) throw new Error('The account or relay changed')
        const next = await authHeaders(relay)
        if (!owner.isCurrent()) throw new Error('The account or relay changed')
        return next
    }
    const url = `${relay}/api/documents/${docId}/file`
    const cacheKey = new URL(url)
    if (scope) cacheKey.searchParams.set('weft-cache-owner', scope)
    const key = cacheKey.href
    const bucket = scope ? await openBucket() : null
    const cached = bucket ? await bucket.match(key).catch(() => null) : null
    const cachedEtag = cached?.headers.get('etag') ?? null
    const readCached = async (): Promise<SourceHandle> => {
        if (!cached || !owner.isCurrent()) return changed
        const data = await cached.arrayBuffer()
        if (!owner.isCurrent()) return changed
        touchIndex(key)
        return { ...owner, kind: 'data', data, etag: cachedEtag ?? '' }
    }
    if (!owner.isCurrent()) return changed

    // one tiny probe: revalidates the cache and learns size+etag for the plan
    let probe: Response
    try {
        probe = await fetch(url, {
            cache: 'no-store',
            headers: {
                ...headers,
                range: 'bytes=0-0',
                ...(cachedEtag ? { 'if-none-match': cachedEtag } : {}),
            },
        })
    } catch (e) {
        if (!owner.isCurrent()) return changed
        if (cached) return readCached()
        return { kind: 'error', detail: String(e) }
    }

    if (!owner.isCurrent()) return changed

    // fetch the whole file (auth valid now), cache if small
    const fullFetch = async (etagHint: string): Promise<SourceHandle> => {
        try {
            const full = await fetch(url, { headers: await getHeaders(), cache: 'no-store' })
            if (!owner.isCurrent()) return changed
            if (full.status === 204) return coldResult()
            if (!full.ok) return { kind: 'error', detail: `file fetch ${full.status}` }
            const data = await full.arrayBuffer()
            if (!owner.isCurrent()) return changed
            const etag = full.headers.get('etag') ?? etagHint
            if (bucket && etag && data.byteLength <= SMALL_MAX) {
                await putCache(bucket, key, data, etag, full.headers.get('content-type'))
            }
            return !owner.isCurrent() ? changed : { ...owner, kind: 'data', data, etag }
        } catch (e) {
            return { kind: 'error', detail: String(e) }
        }
    }
    const coldResult = async (): Promise<SourceHandle> => {
        // tablet-only: the cloud holds no source. Drop any stale cached copy
        // (may predate a re-import) and report cold.
        if (bucket && cached) {
            await bucket.delete(key)
            dropIndex(key)
        }
        return owner.isCurrent() ? { ...owner, kind: 'cold' } : changed
    }

    if (probe.status === 304 && cached) return readCached()
    if (probe.status === 204) return coldResult()
    if (probe.status === 200) {
        // a server that ignored the Range handed us the whole body: use it
        const etag = probe.headers.get('etag') ?? ''
        const data = await probe.arrayBuffer()
        if (!owner.isCurrent()) return changed
        if (bucket && etag && data.byteLength <= SMALL_MAX) {
            await putCache(bucket, key, data, etag, probe.headers.get('content-type'))
        }
        return !owner.isCurrent() ? changed : { ...owner, kind: 'data', data, etag }
    }
    if (probe.status === 206) {
        const etag = probe.headers.get('etag') ?? ''
        const total = Number(probe.headers.get('content-range')?.split('/')[1] ?? 0)
        void probe.body?.cancel()
        // the cached copy (if any) failed revalidation: it predates a re-import
        if (bucket && cached) {
            await bucket.delete(key)
            dropIndex(key)
        }
        // total===0 means a stripped/absent content-range (proxy): fetch whole
        // rather than hand pdf.js a size-0 range plan.
        if (total === 0 || total <= SMALL_MAX) return fullFetch(etag)
        // the giant class: never download whole. Pass a header supplier so
        // each range gets a current bearer and a long session doesn't 401.
        return !owner.isCurrent() ? changed : { ...owner, kind: 'range', url, getHeaders, size: total, etag }
    }
    if (cached && probe.status >= 500) return readCached()
    return { kind: 'error', detail: `file probe ${probe.status}` }
}
