/**
 * Auth by deployment mode: HOSTED uses Clerk JWTs; SELF-HOST uses one shared
 * password (WEFT_PASSWORD) exchanged at /api/login for an HS256 session JWT for
 * the single user 'self'. Both also accept device tokens and API keys.
 * CLOUD_DEV_USER accepts `Bearer dev:<user>` for CI (only when no real auth set).
 */

import { verifyToken } from '@clerk/backend'
import type { CloudStore } from './store'

export interface AuthContext {
    userId: string
    clerkIssuer?: string
    clerkAuthorizedParty?: string
    clerkSession?: { issued: number; firstFactorAgeMinutes: number }
    // 'ticket' = browser WS authed by a single-use /api/ws-ticket nonce (resolved
    // in server.ts), keeping the session JWT out of the WS URL.
    via: 'clerk' | 'device' | 'dev' | 'apikey' | 'selfhost' | 'ticket'
}

/** The single user id for a self-hosted (password) deployment. */
export const SELF_HOST_USER = 'self'

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
const utf8 = (s: string) => new TextEncoder().encode(s)

async function hmac(secret: string, data: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        'raw',
        utf8(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    )
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(data)))
}

/** Sign a minimal HS256 session JWT for the self-host single user. */
export async function signSelfHostToken(secret: string, ttlSeconds = 60 * 60 * 24 * 30): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    const header = b64url(utf8(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
    const payload = b64url(
        utf8(JSON.stringify({ sub: SELF_HOST_USER, iat: now, exp: now + ttlSeconds })),
    )
    const data = `${header}.${payload}`
    return `${data}.${b64url(await hmac(secret, data))}`
}

/** Verify an HS256 self-host session JWT. Returns the subject or null. */
async function verifySelfHostToken(token: string, secret: string): Promise<string | null> {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [header, payload, sig] = parts as [string, string, string]
    const expected = b64url(await hmac(secret, `${header}.${payload}`))
    // constant-time byte compare (signatures are fixed length)
    if (sig.length !== expected.length) return null
    let diff = 0
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i)
    if (diff !== 0) return null
    try {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
            sub?: string
            exp?: number
        }
        if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return null
        return claims.sub ?? null
    } catch {
        return null
    }
}

/** True when this is a self-host deployment (shared-password login enabled). */
export function selfHostEnabled(): boolean {
    return !!process.env.WEFT_PASSWORD
}

/**
 * Secret for signing/verifying self-host session JWTs: WEFT_JWT_SECRET, else a
 * stable generated store secret. Never the login password (must not double as
 * a signing key).
 */
export function jwtSigningSecret(store: CloudStore): string {
    return process.env.WEFT_JWT_SECRET || store.getOrCreateJwtSecret()
}

/** The gateway verifies the issuer's signature before these claims are used.
 * Refreshing an old session token does not reset its first-factor age. */
export function isRecentClerkSession(auth: AuthContext, now = Math.floor(Date.now() / 1000)): boolean {
    const factor = auth.clerkSession
    return auth.via === 'clerk' && !!factor && factor.issued <= now &&
        // The factor age has minute precision. Reserve one minute for
        // rounding and never treat a freshly reissued stale token as recent.
        now - factor.issued + factor.firstFactorAgeMinutes * 60 < 4 * 60
}

export async function deleteHostedClerkUser(userId: string, secretKey: string): Promise<void> {
    const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer ' + secretKey },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
    })
    await response.body?.cancel()
    // After a lost response the idempotent retry can find no provider user.
    if (!response.ok && response.status !== 404) throw new Error('Account provider deletion failed')
}

export async function authenticate(req: Request, store: CloudStore, testClerkJwtKey?: string): Promise<AuthContext | null> {
    const deviceToken = req.headers.get('x-device-token')
    if (deviceToken) {
        const userId = store.userForDeviceToken(deviceToken)
        return userId ? { userId, via: 'device' } : null
    }

    // Third-party API clients: x-api-key (or `Bearer chk_...`).
    const headerKey = req.headers.get('x-api-key')
    const authHeader = req.headers.get('authorization')
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    const apiKey = headerKey ?? (bearer?.startsWith('chk_') ? bearer : null)
    if (apiKey) {
        const userId = store.userForApiKey(apiKey)
        return userId ? { userId, via: 'apikey' } : null
    }

    // Browsers cannot set headers on WS upgrades: /ws (only /ws, to keep tokens
    // out of logged paths) carries the bearer as a ?token= query param.
    const url = new URL(req.url)
    const queryToken = url.pathname === '/ws' ? url.searchParams.get('token') : null
    const token = bearer ?? queryToken
    if (!token) return null

    // Dev/CI token, only when no real auth is configured, so a stray
    // CLOUD_DEV_USER can't become an impersonation bypass (Bearer dev:<anyone>).
    if (
        process.env.CLOUD_DEV_USER &&
        !process.env.CLERK_SECRET_KEY &&
        !process.env.WEFT_PASSWORD &&
        token.startsWith('dev:')
    ) {
        return { userId: token.slice(4), via: 'dev' }
    }

    // Self-host: shared-password HS256 session JWT. Mutually exclusive with
    // Clerk by env (startCloud refuses to boot if both are set).
    if (selfHostEnabled()) {
        const sub = await verifySelfHostToken(token, jwtSigningSecret(store))
        return sub ? { userId: sub, via: 'selfhost' } : null
    }

    const secretKey = process.env.CLERK_SECRET_KEY
    if (!secretKey) return null
    try {
        const payload = await verifyToken(token, { secretKey, jwtKey: testClerkJwtKey })
        if (!payload.sub) return null
        const fva = payload.fva
        const firstFactor = Array.isArray(fva) ? fva[0] : undefined
        const clerkSession = typeof payload.sid === 'string' && payload.sid.length > 0 &&
            Number.isSafeInteger(payload.iat) && typeof firstFactor === 'number' &&
            Number.isSafeInteger(firstFactor) && firstFactor >= 0
            ? { issued: payload.iat, firstFactorAgeMinutes: firstFactor } : undefined
        const clerkAuthorizedParty = typeof payload.azp === 'string' ? payload.azp : undefined
        return {
            userId: payload.sub,
            via: 'clerk',
            ...(typeof payload.iss === 'string' && { clerkIssuer: payload.iss }),
            ...(clerkSession && { clerkSession }),
            ...(clerkAuthorizedParty && { clerkAuthorizedParty }),
        }
    } catch {
        return null
    }
}
