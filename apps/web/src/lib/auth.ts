/**
 * Cloud-mode auth, providers behind one `getAuthToken`:
 *  - Clerk (publishable key set): lazy @clerk/clerk-js, short-lived session JWT.
 *  - Self-host (key unset): shared WEFT_PASSWORD exchanged at /api/login for a
 *    cached HS256 session JWT sent as the bearer.
 *  - Dev: `dev:<user>` against a CLOUD_DEV_USER=1 server, the CI path.
 */
import { clerkPublishableKey, connection, watchRelayChange } from './settings'

const DEV_KEY = 'weft-dev-user'
const LEGACY_SELFHOST_JWT_KEY = 'weft-selfhost-jwt'
const selfHostSessionKey = (relay: string) => `weft-selfhost-jwt/${encodeURIComponent(relay)}`
let pendingSelfHostLogin: AbortController | undefined

/**
 * The slice of Clerk the app touches. @clerk/clerk-js satisfies it
 * structurally; e2e tests inject window.__WEFT_CLERK_MOCK__ implementing it.
 */
export interface ClerkLike {
    session?: { id?: string; getToken(): Promise<string | null> } | null
    user?: {
        id: string
        username?: string | null
        primaryEmailAddress?: { emailAddress: string } | null
    } | null
    openSignIn(): void
    /** Hosted-portal sign-in (redirects to Clerk's Account Portal, has Google
     *  SSO, then back). Works without bundled UI components. */
    redirectToSignIn?(opts?: { signInForceRedirectUrl?: string }): Promise<unknown> | void
    signOut(): Promise<void>
    addListener(listener: () => void): void | (() => void)
}

declare global {
    interface Window {
        __WEFT_CLERK_MOCK__?: ClerkLike
    }
}

export function clerkEnabled(): boolean {
    return clerkPublishableKey().length > 0
}

export function devUser(): string {
    return localStorage.getItem(DEV_KEY) ?? ''
}

// --- Self-host password session ---

/** Cached self-host session JWT (from /api/login), or null when signed out. */
export function selfHostJwt(): string | null {
    return localStorage.getItem(selfHostSessionKey(connection().cloudUrl))
}

/** Exchange the shared server password for a session JWT and cache it. */
export async function selfHostLogin(password: string): Promise<void> {
    const relay = connection().cloudUrl
    const provider = clerkPublishableKey()
    const key = selfHostSessionKey(relay)
    pendingSelfHostLogin?.abort()
    const attempt = new AbortController()
    pendingSelfHostLogin = attempt
    const { signal } = attempt
    const cancel = () => attempt.abort()
    watchRelayChange(cancel, signal)
    window.addEventListener('storage', (event) => {
        if (event.key === 'weft-clerk-pk' || event.key === DEV_KEY || event.key === key) cancel()
    }, { signal })
    try {
        const r = await fetch(`${relay}/api/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password }),
            signal,
        })
        if (r.status === 401) throw new Error('Incorrect password')
        if (!r.ok) throw new Error(`Login failed (${r.status})`)
        const { token } = (await r.json()) as { token: string }
        if (signal.aborted || connection().cloudUrl !== relay || clerkPublishableKey() !== provider) {
            throw new Error('The account or relay changed during sign-in')
        }
        localStorage.setItem(key, token)
        // The old key has no recorded issuer and cannot be safely migrated.
        localStorage.removeItem(LEGACY_SELFHOST_JWT_KEY)
        localStorage.removeItem(DEV_KEY)
    } catch (error) {
        if (signal.aborted) throw new Error('The account or relay changed during sign-in')
        throw error
    } finally {
        attempt.abort()
        if (pendingSelfHostLogin === attempt) pendingSelfHostLogin = undefined
    }
}

let clerkPromise: Promise<ClerkLike> | null = null
let loadedClerk: ClerkLike | null = null
let loadedClerkKey: string | undefined

function activeClerk(): ClerkLike | null {
    return window.__WEFT_CLERK_MOCK__ ?? (loadedClerkKey === clerkPublishableKey() ? loadedClerk : null)
}

/** Loads + initializes Clerk exactly once. Null when Clerk is not configured. */
export async function ensureClerk(): Promise<ClerkLike | null> {
    if (window.__WEFT_CLERK_MOCK__) return window.__WEFT_CLERK_MOCK__
    const publishableKey = clerkPublishableKey()
    if (!publishableKey) return null
    if (loadedClerkKey !== publishableKey) {
        loadedClerkKey = publishableKey
        loadedClerk = null
        clerkPromise = null
    }
    // "no-rhc" build bundles Clerk's UI components locally instead of fetching
    // them from Clerk's CDN at runtime (the default build failed to load them
    // here, and local bundling fits the offline-capable goal).
    clerkPromise ??= import('@clerk/clerk-js/no-rhc').then(async ({ Clerk }) => {
        const clerk = new Clerk(publishableKey)
        const client = clerk as unknown as ClerkLike
        // a failed load (offline, bad key, Clerk outage) must degrade to
        // signed-out, never crash the app
        try {
            await clerk.load()
            if (loadedClerkKey === publishableKey) loadedClerk = client
        } catch (e) {
            console.warn('clerk: load failed:', e)
        }
        return client
    })
    return clerkPromise
}

/** Bearer token for the cloud store; null signed out. */
// Clerk session tokens live ~60s; refreshing one is a ~300-450ms network call
// to clerk.com. Cache the latest in memory and refresh in the background on an
// interval so authed fetches never block on Clerk. Mirror the cache in
// sessionStorage so a full page load (module-state reset) doesn't re-pay the
// fetch. sessionStorage is cleared on signOut and never outlives the tab.
const TOKEN_KEY = 'weft-clerk-token'
const clerkAccountKey = (relay: string, config: string) =>
    `weft-clerk-active/${encodeURIComponent(relay)}/${encodeURIComponent(config)}`
let clerkSignOutGeneration = 0
const clerkIntentKey = (key: string) => `${key}/sign-in`
interface ClerkSignInIntent {
    selection: string | null
    owner: string | null
    session: string | null
    expires: number
}

function rememberClerkSignIn(clerk: ClerkLike): void {
    const key = clerkAccountKey(connection().cloudUrl, clerkPublishableKey())
    const intent: ClerkSignInIntent = {
        selection: localStorage.getItem(key),
        owner: clerk.user?.id ?? null,
        session: clerk.session?.id ?? null,
        expires: Date.now() + 15 * 60_000,
    }
    try { sessionStorage.setItem(clerkIntentKey(key), JSON.stringify(intent)) } catch {}
}

function forgetClerkSignIn(key: string): void {
    try { sessionStorage.removeItem(clerkIntentKey(key)) } catch {}
}

function clerkSignInIntent(key: string): ClerkSignInIntent | null {
    try {
        const raw = sessionStorage.getItem(clerkIntentKey(key))
        if (!raw) return null
        const intent = JSON.parse(raw) as ClerkSignInIntent
        return intent.expires > Date.now() ? intent : null
    } catch {
        return null
    }
}
interface CachedClerkToken {
    value: string
    publishableKey: string
    relay: string
}
let cachedToken: CachedClerkToken | null = null
let tokenRefresher: ReturnType<typeof setInterval> | null = null

/** True while the JWT's own exp claim has >10s left. Freshness must come from
 *  the token, not from fetch time: clerk-js has its own ~60s cache, so a
 *  getToken() result can already be old, and an age-based window serves
 *  expired tokens (intermittent 401s). */
function validClerkClaims(value?: string): { sub?: unknown } | null {
    if (!value) return null
    try {
        const payload = JSON.parse(atob(value.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')))
        return typeof payload.exp === 'number' && payload.exp * 1000 - Date.now() > 10_000
            ? payload : null
    } catch {
        return null
    }
}

function storedClerkToken(): CachedClerkToken | null {
    const config = clerkPublishableKey()
    const relay = connection().cloudUrl
    let token = cachedToken
    if (!token) {
        try {
            const raw = sessionStorage.getItem(TOKEN_KEY)
            if (raw) {
                const parsed = JSON.parse(raw) as Partial<CachedClerkToken>
                if (typeof parsed.value === 'string' && parsed.publishableKey === config && parsed.relay === relay) {
                    token = { value: parsed.value, publishableKey: config, relay }
                }
            }
        } catch {
            // No attributable persisted bearer.
        }
    }
    return token?.publishableKey === config && token.relay === relay ? token : null
}

function selectedClerkToken(): CachedClerkToken | null {
    const token = storedClerkToken()
    if (!token) return null
    const selected = localStorage.getItem(clerkAccountKey(token.relay, token.publishableKey))
    if (selected !== null && selected !== clerkBearerAccount(token.value)) return null
    const clerk = activeClerk()
    if (clerk && clerk.user?.id !== tokenClaims(token.value)?.sub) return null
    return token
}

function clearCachedToken(): void {
    cachedToken = null
    try {
        sessionStorage.removeItem(TOKEN_KEY)
    } catch {
        // storage unavailable, memory cache was the only copy
    }
}

async function refreshClerkToken(): Promise<string | null> {
    const publishableKey = clerkPublishableKey()
    const relay = connection().cloudUrl
    const key = clerkAccountKey(relay, publishableKey)
    const selectedBefore = localStorage.getItem(key)
    const generation = clerkSignOutGeneration
    const intent = clerkSignInIntent(key)
    const previous = storedClerkToken()
    const priorAccount = previous && clerkBearerAccount(previous.value)
    const clerk = await ensureClerk()
    const previousOwner = clerk?.user?.id
    const session = clerk?.session
    const value = (await session?.getToken()) ?? null
    const owner = clerk?.user?.id
    if (publishableKey !== clerkPublishableKey() || connection().cloudUrl !== relay ||
        (previousOwner !== undefined && previousOwner !== owner) ||
        clerk?.session?.id !== session?.id || generation !== clerkSignOutGeneration) return null
    if (value) {
        const account = clerkBearerAccount(value)
        if (!account || validClerkClaims(value)?.sub !== owner) return null
        const selected = localStorage.getItem(key)
        // A loaded tab may retain stale Clerk state after a different tab
        // signs in. The old bearer can never reassert its previous account.
        const signInChangedSession = intent && selected === intent.selection &&
            (owner !== intent.owner || (!!session?.id && session.id !== intent.session))
        if (selected !== account && (selected !== selectedBefore ||
            (selected !== null && selected !== priorAccount && !signInChangedSession))) return null
        localStorage.setItem(key, account)
        if (signInChangedSession) forgetClerkSignIn(key)
        cachedToken = { value, publishableKey, relay }
        try {
            sessionStorage.setItem(TOKEN_KEY, JSON.stringify(cachedToken))
        } catch {
            // storage full/blocked, memory cache still works for this load
        }
    }
    return value
}

export async function getAuthToken(): Promise<string | null> {
    if (clerkEnabled()) {
        const token = selectedClerkToken()
        if (token && validClerkClaims(token.value)) {
            cachedToken = token
            if (tokenRefresher === null) {
                tokenRefresher = setInterval(() => void refreshClerkToken(), 45_000)
            }
            return token.value
        }
        const value = await refreshClerkToken()
        if (value && tokenRefresher === null) {
            tokenRefresher = setInterval(() => void refreshClerkToken(), 45_000)
        }
        return value
    }
    // Real self-host session takes precedence; the CI dev token is only a
    // fallback, so a stale dev-user value can't lock out a self-host user.
    const jwt = selfHostJwt()
    if (jwt) return jwt
    const user = devUser()
    return user ? `dev:${user}` : null
}

/** Scope local preferences without refreshing credentials or storing them. */
export function localPreferenceOwner(): string | null {
    if (clerkEnabled()) {
        const key = clerkAccountKey(connection().cloudUrl, clerkPublishableKey())
        const selection = localStorage.getItem(key)
        const clerk = activeClerk()
        const id = clerk ? clerk.user?.id : validClerkClaims(selectedClerkToken()?.value)?.sub
        if (selection !== null && id !== clerkSelectionSubject(selection)) return null
        return typeof id === 'string' && id ? `clerk:${id}` : null
    }
    if (selfHostJwt()) return 'self-hosted'
    const user = devUser()
    return user ? `dev:${user}` : null
}

/** Read the identity used for local selection. The relay still validates the token. */
function clerkBearerAccount(token: string): string | null {
    const claims = tokenClaims(token)
    if (typeof claims?.sub !== 'string' || !claims.sub || typeof claims.iss !== 'string' || !claims.iss) return null
    return JSON.stringify(['clerk', claims.iss, claims.sub])
}

function clerkSelectionSubject(selection: string | null): string | null {
    if (!selection) return null
    try {
        const parts: unknown = JSON.parse(selection)
        return Array.isArray(parts) && parts[0] === 'clerk' && typeof parts[2] === 'string' ? parts[2] : null
    } catch {
        return null
    }
}

function tokenClaims(token: string): { sub?: unknown; iss?: unknown; exp?: unknown } | null {
    try {
        return JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')))
    } catch {
        return null
    }
}

/** Distinguish a revoked account from an offline tab with an expired token. */
export function isKnownSignedOut(): boolean {
    if (!clerkEnabled()) return !selfHostJwt() && !devUser()
    const clerk = activeClerk()
    const selection = localStorage.getItem(clerkAccountKey(connection().cloudUrl, clerkPublishableKey()))
    const former = clerk?.user?.id ?? tokenClaims(storedClerkToken()?.value ?? '')?.sub
    return selection === '' || (selection !== null && typeof former === 'string' && former !== clerkSelectionSubject(selection)) ||
        (clerk?.user === null && clerk.session === null)
}

/** Display label for the signed-in identity, or null when signed out. */
export async function currentUserLabel(): Promise<string | null> {
    if (clerkEnabled()) {
        const clerk = await ensureClerk()
        const u = clerk?.user
        if (!u) return null
        return u.primaryEmailAddress?.emailAddress ?? u.username ?? u.id
    }
    if (selfHostJwt()) return 'self-hosted'
    return devUser() || null
}

export async function signIn(): Promise<void> {
    // Self-host: no Clerk, send the user to the password login page.
    if (!clerkEnabled()) {
        window.location.href = '/login'
        return
    }
    const clerk = await ensureClerk()
    if (!clerk) return
    rememberClerkSignIn(clerk)
    // Prefer the hosted Account Portal redirect (has Google SSO, needs no
    // bundled UI components). Fall back to the modal if unavailable.
    if (clerk.redirectToSignIn) {
        await clerk.redirectToSignIn({ signInForceRedirectUrl: window.location.href })
    } else {
        clerk.openSignIn()
    }
}

export async function signOut(): Promise<void> {
    pendingSelfHostLogin?.abort()
    const selfHostSession = selfHostSessionKey(connection().cloudUrl)
    clerkSignOutGeneration++
    if (clerkEnabled()) {
        const key = clerkAccountKey(connection().cloudUrl, clerkPublishableKey())
        forgetClerkSignIn(key)
        const owner = activeClerk()?.user?.id
        if (selectedClerkToken() || (owner && clerkSelectionSubject(localStorage.getItem(key)) === owner)) {
            localStorage.setItem(key, '')
        }
    }
    // Drop the previous account's cached doc list: it's plaintext localStorage
    // the library paints from on load, so the next signed-in user would briefly
    // see the last user's notebooks.
    try {
        localStorage.removeItem('weft-docs-cache')
        localStorage.removeItem('weft-user-label')
    } catch {
        // best-effort
    }
    // Tear down the live WebSocket + transport singleton: it authed once at
    // connect, so leaving it open keeps streaming this user's events to a
    // signed-out browser under the old identity.
    try {
        const { resetTransport } = await import('./transport')
        resetTransport()
    } catch {
        // best-effort, a failed teardown must not block the rest of sign-out
    }
    if (clerkEnabled()) {
        clearCachedToken()
        if (tokenRefresher !== null) {
            clearInterval(tokenRefresher)
            tokenRefresher = null
        }
        const clerk = await ensureClerk()
        await clerk?.signOut()
    } else {
        localStorage.removeItem(DEV_KEY)
        localStorage.removeItem(selfHostSession)
        localStorage.removeItem(LEGACY_SELFHOST_JWT_KEY)
    }
}
