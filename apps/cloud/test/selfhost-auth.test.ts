/**
 * #29 self-host auth: the shared-password login path (WEFT_PASSWORD) — exchange
 * the password for an HS256 session JWT, which then authenticates API calls.
 * Previously untested (the riskiest auth branch); this exercises it end-to-end.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { startCloud, type CloudServer } from '../src/server'

const PASSWORD = 'correct horse battery staple'

let server: CloudServer
let base: string

beforeAll(() => {
    // self-host mode: password login enabled, Clerk + dev-user disabled
    process.env.WEFT_PASSWORD = PASSWORD
    delete process.env.CLERK_SECRET_KEY
    delete process.env.CLOUD_DEV_USER
    delete process.env.WEFT_JWT_SECRET
    server = startCloud({ port: 0 })
    base = `http://localhost:${server.port}`
})
afterAll(() => {
    server.stop()
    delete process.env.WEFT_PASSWORD
})

test('the health probe advertises password (self-host) login mode', async () => {
    const r = await fetch(`${base}/api/health`)
    expect(r.ok).toBe(true)
    expect((await r.json()).authMode).toBe('password')
})

test('the wrong password is rejected with 401', async () => {
    const r = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'nope' }),
    })
    expect(r.status).toBe(401)
})

test('the correct password returns a session token that authenticates API calls', async () => {
    const login = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
    })
    expect(login.ok).toBe(true)
    const { token } = (await login.json()) as { token: string }
    expect(typeof token).toBe('string')
    expect(token.split('.')).toHaveLength(3) // header.payload.sig

    // the token authenticates a real API call
    const docs = await fetch(`${base}/api/documents`, {
        headers: { authorization: `Bearer ${token}` },
    })
    expect(docs.ok).toBe(true)
    expect(Array.isArray((await docs.json()).documents)).toBe(true)
})

test('a request with no/garbage token is unauthorized', async () => {
    expect((await fetch(`${base}/api/documents`)).status).toBe(401)
    const bad = await fetch(`${base}/api/documents`, {
        headers: { authorization: 'Bearer not.a.jwt' },
    })
    expect(bad.status).toBe(401)
})

test('a token signed with a different secret is rejected (tamper/forge guard)', async () => {
    // a structurally valid JWT signed with the wrong secret must not pass
    const { signSelfHostToken } = await import('../src/auth')
    const forged = await signSelfHostToken('a-different-secret')
    const r = await fetch(`${base}/api/documents`, {
        headers: { authorization: `Bearer ${forged}` },
    })
    expect(r.status).toBe(401)
})

test('dev-token impersonation is refused when self-host auth is configured', async () => {
    // even if a stray CLOUD_DEV_USER leaks in, real auth disables the dev path
    const r = await fetch(`${base}/api/documents`, {
        headers: { authorization: 'Bearer dev:someone' },
    })
    expect(r.status).toBe(401)
})
