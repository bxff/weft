/**
 * Connection settings. The app always talks to a cloud server. Which one is
 * chosen by precedence: a self-host override (localStorage) > the build-time
 * PUBLIC_CLOUD_URL > same origin. There is no tablet-as-server / local
 * mode — the tablet is a sync agent that mirrors its notebooks up to a server.
 */
const URL_KEY = 'weft-server-url'
export const relayChanged = 'weft-relay-changed'

export interface Connection {
    /** Always cloud (kept for call-site compatibility). */
    mode: 'cloud'
    cloudUrl: string
}

export function connection(): Connection {
    const stored = (localStorage.getItem(URL_KEY) ?? '').trim()
    const url = (stored || import.meta.env.PUBLIC_CLOUD_URL || window.location.origin).trim().replace(/\/$/, '')
    return { mode: 'cloud', cloudUrl: url }
}

/** True when pointed at a self-hosted server (a stored override is set). */
export function isSelfHosted(): boolean {
    return (localStorage.getItem(URL_KEY) ?? '').trim().length > 0
}

/** Set '' to fall back to the configured relay or same origin. Callers reload after. */
export function setCloudUrl(url: string): void {
    const before = connection().cloudUrl
    localStorage.setItem(URL_KEY, url.trim())
    if (connection().cloudUrl !== before) window.dispatchEvent(new Event(relayChanged))
}

export function watchRelayChange(onChange: () => void, signal: AbortSignal): void {
    window.addEventListener(relayChanged, onChange, { signal })
    window.addEventListener('storage', (event) => {
        if (event.key === URL_KEY || event.key === null) onChange()
    }, { signal })
}

export function clerkPublishableKey(): string {
    // runtime override lets one build exercise the Clerk-enabled path without rebuilding
    return localStorage.getItem('weft-clerk-pk') ?? import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY ?? ''
}

/** Prefix for direct /api/... URLs (thumbnails, templates, PDF file). */
export function apiBase(): string {
    return connection().cloudUrl
}

/** Docs are native SvelteKit routes at /docs (same origin). */
export function docsUrl(): string {
    return '/docs'
}
