import type { DocumentInfo } from '@weft/sync-engine'
import { localPreferenceOwner } from './auth'
import { connection } from './settings'

export function libraryCacheScope(): string | null {
    try {
        const owner = localPreferenceOwner()
        return owner ? encodeURIComponent(JSON.stringify([connection().cloudUrl, owner])) : null
    } catch {
        return null
    }
}

export function readCachedDocumentList(scope = libraryCacheScope()): DocumentInfo[] | null {
    if (!scope) return null
    try {
        const raw = localStorage.getItem(`weft-docs-cache/${scope}`)
        const docs: unknown = raw ? JSON.parse(raw) : null
        return Array.isArray(docs) ? docs : null
    } catch {
        return null
    }
}

export function cacheDocumentList(scope: string | null, docs: DocumentInfo[]): void {
    if (!scope) return
    try {
        localStorage.setItem(`weft-docs-cache/${scope}`, JSON.stringify(docs))
    } catch {
        // The network response is still usable if cache storage is unavailable.
    }
}

export function clearCachedDocumentList(scope: string | null): void {
    if (!scope) return
    try {
        localStorage.removeItem(`weft-docs-cache/${scope}`)
    } catch {
        // Cache removal is best-effort.
    }
}
