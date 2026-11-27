import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { bearerMatchesClerkReplicaAccount, getAuthToken, selectedClerkReplicaAccount, selfHostLogin, signOut } from './auth'
import { connection, setCloudUrl } from './settings'
import { openSource } from './sourceFile'
import { readBoundBearer, resetTransport, transport } from './transport'

const firstRelay = 'https://first-relay.invalid'
const secondRelay = 'https://second-relay.invalid'
let restoreGlobals: () => void

function mockFetch(implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
    return spyOn(globalThis, 'fetch').mockImplementation(
        Object.assign(implementation, { preconnect: globalThis.fetch.preconnect }),
    )
}

beforeEach(() => {
    const values = new Map<string, string>([['weft-clerk-pk', '']])
    const props = {
        sessionStorage: {
            getItem: (key: string) => values.get('session:' + key) ?? null,
            setItem: (key: string, value: string) => values.set('session:' + key, value),
            removeItem: (key: string) => values.delete('session:' + key),
        },
        localStorage: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
        },
        window: Object.assign(new EventTarget(), { location: { origin: 'https://app.example.invalid' } }),
        caches: undefined,
        WebSocket: class FakeSocket { close() {} },
    }
    const descriptors = Object.getOwnPropertyDescriptors(globalThis)
    for (const [key, value] of Object.entries(props)) {
        Object.defineProperty(globalThis, key, { configurable: true, value })
    }
    restoreGlobals = () => {
        for (const key of Object.keys(props)) {
            if (descriptors[key]) Object.defineProperty(globalThis, key, descriptors[key])
            else Reflect.deleteProperty(globalThis, key)
        }
    }
    setCloudUrl(firstRelay)
})

afterEach(() => {
    resetTransport()
    restoreGlobals()
})

test('a site without a configured relay uses its own origin', () => {
    setCloudUrl('')
    expect(connection().cloudUrl).toBe('https://app.example.invalid')
})

test('self-host credentials stay bound to the relay that issued them', async () => {
    const mock = mockFetch(async (input) => {
        const url = new URL(String(input))
        return Response.json({ token: url.origin === firstRelay ? 'test-first' : 'test-second' })
    })
    try {
        localStorage.setItem('weft-selfhost-jwt', 'unattributed-test-token')
        expect(await getAuthToken()).toBeNull()
        await selfHostLogin('test-password')
        expect(await getAuthToken()).toBe('test-first')
        setCloudUrl(secondRelay)
        expect(await getAuthToken()).toBeNull()
        await selfHostLogin('test-password')
        expect(await getAuthToken()).toBe('test-second')
        await signOut()
        expect(await getAuthToken()).toBeNull()
        setCloudUrl(firstRelay)
        expect(await getAuthToken()).toBe('test-first')
    } finally {
        mock.mockRestore()
    }
})

test('changing the relay and back invalidates an in-flight sign-in', async () => {
    const response = Promise.withResolvers<Response>()
    const mock = mockFetch(() => response.promise)
    try {
        const signingIn = selfHostLogin('test-password')
        setCloudUrl(secondRelay)
        setCloudUrl(firstRelay)
        response.resolve(Response.json({ token: 'test-first' }))
        await expect(signingIn).rejects.toThrow('relay changed')
        expect(await getAuthToken()).toBeNull()
    } finally {
        mock.mockRestore()
    }
})

test('another tab changing the selected relay invalidates an in-flight sign-in', async () => {
    const response = Promise.withResolvers<Response>()
    const mock = mockFetch(() => response.promise)
    try {
        const signingIn = selfHostLogin('test-password')
        localStorage.setItem('weft-server-url', secondRelay)
        window.dispatchEvent(Object.assign(new Event('storage'), { key: 'weft-server-url' }))
        localStorage.setItem('weft-server-url', firstRelay)
        window.dispatchEvent(Object.assign(new Event('storage'), { key: 'weft-server-url' }))
        response.resolve(Response.json({ token: 'test-first' }))
        await expect(signingIn).rejects.toThrow('relay changed')
        expect(await getAuthToken()).toBeNull()
    } finally {
        mock.mockRestore()
    }
})

test('a mounted transport stops when the selected relay changes', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = []
    const mock = mockFetch(async (input, init) => {
        const url = String(input)
        requests.push({ url, authorization: new Headers(init?.headers).get('authorization') })
        if (url.endsWith('/api/login')) {
            return Response.json({ token: url.startsWith(firstRelay) ? 'test-first' : 'test-second' })
        }
        return Response.json([])
    })
    try {
        await selfHostLogin('test-password')
        const mounted = transport()
        await mounted.listDocuments()
        setCloudUrl(secondRelay)
        await selfHostLogin('test-password')
        await expect(mounted.listDocuments()).rejects.toThrow()
        await transport().listDocuments()
        expect(requests.filter(({ url }) => url.endsWith('/api/documents'))).toEqual([
            { url: firstRelay + '/api/documents', authorization: 'Bearer test-first' },
            { url: secondRelay + '/api/documents', authorization: 'Bearer test-second' },
        ])
    } finally {
        mock.mockRestore()
    }
})

test('a PDF opened for one relay cannot use credentials for another', async () => {
    const requested: string[] = []
    const mock = mockFetch(async (input) => {
        const url = String(input)
        requested.push(url)
        if (url.endsWith('/api/login')) return Response.json({ token: 'test-token' })
        return new Response(new Uint8Array(1), {
            status: 206, headers: { 'content-range': 'bytes 0-0/30000000' },
        })
    })
    try {
        await selfHostLogin('test-password')
        const handle = await openSource('test-doc')
        expect(handle.kind).toBe('range')
        if (handle.kind !== 'range') throw new Error('Expected a byte range handle')
        expect(await handle.getHeaders()).toEqual({ authorization: 'Bearer test-token' })
        setCloudUrl(secondRelay)
        await selfHostLogin('test-password')
        await expect(handle.getHeaders()).rejects.toThrow('relay changed')
        expect(requested).toEqual([
            firstRelay + '/api/login',
            firstRelay + '/api/documents/test-doc/file',
            secondRelay + '/api/login',
        ])
    } finally {
        mock.mockRestore()
    }
})

test('a cold hosted PDF open takes its owner from the authenticated session', async () => {
    localStorage.setItem('weft-clerk-pk', 'pk_test_mock')
    const claims = { sub: 'pdf-reader', iss: 'https://fixture-issuer.test', exp: Date.now() / 1000 + 600 }
    const token = `fixture.${btoa(JSON.stringify(claims))}.signature`
    let user: { id: string } | null = null
    const host = Object.assign(window, {
        __WEFT_CLERK_MOCK__: {
            get user() { return user },
            session: {
                async getToken() {
                    user = { id: 'pdf-reader' }
                    return token
                },
            },
            async signOut() { user = null },
        },
    })
    const mock = mockFetch(async (_input, init) => {
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`)
        return new Response(new Uint8Array([42]), { headers: { etag: 'pdf-revision' } })
    })
    try {
        const handle = await openSource('test-doc')
        expect(handle.kind).toBe('data')
        if (handle.kind !== 'data') throw new Error('Expected a source file')
        expect(handle.scope).toContain('pdf-reader')
        expect(handle.isCurrent()).toBe(true)
        expect(new Uint8Array(handle.data)).toEqual(new Uint8Array([42]))
        user = { id: 'different-reader' }
        expect(handle.isCurrent()).toBe(false)
    } finally {
        await signOut()
        Reflect.deleteProperty(host, '__WEFT_CLERK_MOCK__')
        mock.mockRestore()
    }
})


test('scoped editor requires an explicitly selected Clerk issuer and subject and rejects switched bearers', () => {
    const clerk = 'pk_test_example'
    localStorage.setItem('weft-clerk-pk', clerk)
    const selection = `weft-clerk-active/${encodeURIComponent(firstRelay)}/${encodeURIComponent(clerk)}`
    const claims = { iss: 'https://issuer-a.example.invalid', sub: 'same-subject', exp: Date.now() / 1000 + 90 }
    const bearer = (patch: Partial<typeof claims> = {}) => 'h.' + btoa(JSON.stringify({ ...claims, ...patch })) + '.s'
    const account = JSON.stringify(['clerk', claims.iss, claims.sub])
    sessionStorage.setItem('weft-clerk-token', JSON.stringify({
        value: bearer(), publishableKey: clerk, relay: firstRelay,
    }))
    expect(selectedClerkReplicaAccount()).toBeNull()
    localStorage.setItem(selection, account)
    expect(selectedClerkReplicaAccount()).toBe(account)
    expect(bearerMatchesClerkReplicaAccount(bearer(), account)).toBe(true)
    expect(bearerMatchesClerkReplicaAccount(bearer({ iss: 'https://issuer-b.example.invalid' }), account)).toBe(false)
    expect(bearerMatchesClerkReplicaAccount(bearer({ sub: 'different user' }), account)).toBe(false)
    expect(bearerMatchesClerkReplicaAccount(bearer({ exp: 1 }), account)).toBe(false)
    localStorage.setItem(selection, '')
    expect(selectedClerkReplicaAccount()).toBeNull()
    localStorage.setItem(selection, account)
    setCloudUrl(secondRelay)
    expect(selectedClerkReplicaAccount()).toBeNull()
})


test('a bearer refresh in progress cannot authorize a retired scope', async () => {
    const refresh = Promise.withResolvers<string>()
    let selected = true
    const waiting = readBoundBearer(() => selected, token => token === 'old account bearer', () => refresh.promise)
    selected = false
    refresh.resolve('old account bearer')
    await expect(waiting).rejects.toThrow()
    let refreshed = false
    await expect(readBoundBearer(() => false, () => true, async () => {
        refreshed = true
        return 'must not refresh'
    })).rejects.toThrow()
    expect(refreshed).toBe(false)
    await expect(readBoundBearer(() => true, token => token === 'expected', async () => 'wrong'))
        .rejects.toThrow()
    expect(await readBoundBearer(() => true, token => token === 'expected', async () => 'expected')).toBe('expected')
})
