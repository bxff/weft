import { expect, test } from 'bun:test'
import { startCloud } from '../src/server'

const cap = 10_000
const page = '/api/documents/d1/pages/p1'
const envs = ['HOST', 'WEFT_CAPACITY_BYTES', 'CLOUD_DEV_USER', 'WEFT_INVITE_CODE',
    'CLERK_SECRET_KEY', 'WEFT_APP_URL', 'WEFT_ACCOUNTS_URL', 'WEFT_QUOTA_CREATED_BYTES'] as const

function boot(createdQuota = 0) {
    const previous = Object.fromEntries(envs.map(k => [k, process.env[k]]))
    process.env.HOST = '127.0.0.1'
    process.env.WEFT_CAPACITY_BYTES = String(cap)
    process.env.CLOUD_DEV_USER = '1'
    process.env.WEFT_QUOTA_CREATED_BYTES = String(createdQuota)
    delete process.env.CLERK_SECRET_KEY
    const cloud = startCloud({ port: 0, db: ':memory:' })
    const origin = 'http://127.0.0.1:' + cloud.port
    const stop = () => {
        cloud.stop()
        for (const k of envs) {
            if (previous[k] === undefined) delete process.env[k]
            else process.env[k] = previous[k]
        }
    }
    return { cloud, origin, stop }
}

function auth(user: string) { return { authorization: 'Bearer dev:' + user } }
function request(origin: string, user: string, path: string, init?: RequestInit) {
    return fetch(origin + path, { ...init, headers: { ...auth(user), ...init?.headers } })
}
function makeDoc(origin: string, user: string, kind = 'notebook') {
    return request(origin, user, '/api/documents/new', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic', kind }),
    })
}

test.each([[8100, 503], [8600, 507]] as const)(
    'capacity admission guard covers pairing and synthetic blank documents with %s bytes already stored', async (fill, expected) => {
        const { origin, cloud, stop } = boot()
        try {
            const asset = page + '/assets/a.png'
            const pair = (user: string) => request(origin, user, '/api/pair', { method: 'POST' })
            expect((await pair('paired-empty')).status).toBe(200)
            expect(cloud.store.usageTotal('paired-empty')).toBe(0)
            expect((await request(origin, 'existing', asset, { method: 'PUT', body: new Uint8Array(fill) })).status).toBe(200)
            const paired = await pair('existing')
            expect(paired.status).toBe(200)
            const { token } = await paired.json() as {token:string}
            expect((await pair('paired-empty')).status).toBe(200)
            const newPair = await pair('fresh')
            expect(newPair.status).toBe(expected)
            expect(await newPair.json()).toMatchObject({ reason: 'capacity' })
            expect(cloud.store.listDeviceTokens('fresh')).toEqual([])
            for (const kind of ['notebook', 'folder']) {
                const result = await makeDoc(origin, 'fresh', kind)
                expect(result.status).toBe(expected)
                expect(await result.json()).toMatchObject({ reason: 'capacity' })
            }
            expect(JSON.parse(cloud.store.getDocuments('fresh'))).toEqual({ documents: [] })
            expect(cloud.store.usageTotal('fresh')).toBe(0)
            // Device list reconciliation and key management are not measured
            // content admission. Neither can turn a zero-byte account into
            // an admitted initial pairing or native notebook writer.
            expect((await request(origin, 'fresh', '/api/documents', {
                method: 'PUT', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ documents: [{ id:'folder-metadata', type:'folder', name:'metadata only', parent:'', pages:[], lastModified:1 }] }),
            })).status).toBe(200)
            expect((await request(origin, 'fresh', '/api/keys', {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"label":"synthetic"}',
            })).status).toBe(200)
            expect(cloud.store.usageTotal('fresh')).toBe(0)
            expect((await pair('fresh')).status).toBe(expected)
            expect((await makeDoc(origin, 'fresh')).status).toBe(expected)
            const original = await fetch(origin + asset, {headers: { 'x-device-token': token }})
            expect(original.status).toBe(200)
            expect((await original.arrayBuffer()).byteLength).toBe(fill)
            expect((await fetch(origin + page + '/assets/b.png', {
                method: 'PUT', headers: { 'x-device-token': token }, body: Uint8Array.of(1),
            })).status).toBe(expected === 503 ? 200 : 507)
        } finally { stop() }
    },
)

test('created quota applies to new notebook bytes before inserting its library entry', async () => {
    const { origin, cloud, stop } = boot(1)
    try {
        expect((await request(origin, 'fresh', '/api/pair', { method: 'POST' })).status).toBe(200)
        const result = await makeDoc(origin, 'fresh')
        expect(result.status).toBe(507)
        expect(await result.json()).toMatchObject({ reason: 'quota', class: 'created' })
        expect(cloud.store.usageTotal('fresh')).toBe(0)
        expect(JSON.parse(cloud.store.getDocuments('fresh'))).toEqual({ documents: [] })
    } finally { stop() }
})

test('invite pause blocks new ticket issuance before provider calls and after a lookup race', async () => {
    const { origin, cloud, stop } = boot()
    const realFetch = globalThis.fetch
    let providerCalls: string[] = []
    let growDuringLookup = false
    try {
        process.env.WEFT_INVITE_CODE = 'synthetic-test-code'
        process.env.CLERK_SECRET_KEY = 'synthetic-not-a-live-key'
        process.env.WEFT_APP_URL = 'https://weft.example.invalid'
        process.env.WEFT_ACCOUNTS_URL = 'https://accounts.example.invalid'
        globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const url = new URL(input instanceof Request ? input.url : input.toString())
            if (url.hostname !== 'api.clerk.com') return realFetch(input, init)
            providerCalls.push(url.pathname)
            if (url.pathname === '/v1/users') {
                if (growDuringLookup) cloud.store.putAsset('existing', 'd', 'p', 'fill.png', new Uint8Array(8100))
                return Response.json([])
            }
            expect(url.pathname).toBe('/v1/invitations')
            expect(init?.method).toBe('POST')
            return Response.json({ url: 'https://accounts.example.invalid/invite?ticket=fake' })
        }, {preconnect: realFetch.preconnect})
        const ask = () => fetch(origin + '/api/invite', {
            method: 'POST', body: JSON.stringify({ code: 'synthetic-test-code', email: 'test@example.invalid' }),
            headers: { 'content-type': 'application/json' },
        })
        const admitted = await ask()
        expect(admitted.status).toBe(200)
        expect(await admitted.json()).toEqual({ url: 'https://accounts.example.invalid/sign-up?__clerk_ticket=fake' })
        expect(providerCalls).toEqual(['/v1/users','/v1/invitations'])

        providerCalls = []
        growDuringLookup = true
        const raced = await ask()
        expect(raced.status).toBe(503)
        expect(await raced.json()).toMatchObject({ reason: 'capacity' })
        expect(providerCalls).toEqual(['/v1/users'])

        providerCalls = []
        expect((await ask()).status).toBe(503)
        expect(providerCalls).toEqual([])
    } finally {
        globalThis.fetch = realFetch
        stop()
    }
})
