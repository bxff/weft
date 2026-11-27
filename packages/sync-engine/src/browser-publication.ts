/** An immutable relay request. Keep it with the exact pending prefix until the
 * receipt and authoritative state have both been read. A timeout never permits
 * rebuilding or changing a publication ID. */
export interface BrowserPublication {
    id: string
    baseSeq: number
    count: number
    kind: 'ops' | 'snapshot'
    payload: string
}

export type BrowserReceipt =
    | { kind: 'stale' }
    | { kind: 'ops'; lastSeq: number }
    | { kind: 'snapshot'; seq: number }

export function encodePublicationBytes(bytes: Uint8Array): string {
    const parts: string[] = []
    for (let i = 0; i < bytes.length; i += 8192) {
        parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)))
    }
    return btoa(parts.join(''))
}

export function decodePublicationBytes(data: string): Uint8Array {
    return Uint8Array.from(atob(data), value => value.charCodeAt(0))
}

export function newPublicationId(): string {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    // Ordinary HTTP self-hosted origins do not expose randomUUID.
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6]! & 15) | 64
    bytes[8] = (bytes[8]! & 63) | 128
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
