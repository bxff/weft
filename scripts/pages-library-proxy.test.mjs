import assert from 'node:assert/strict'
import { test } from 'node:test'
import { libraryProxy } from './pages-library-proxy.mjs'

const front = 'https://app.example'
const relay = 'https://relay.example'
const assets = { ASSETS: { fetch: () => new Response('static asset') } }

test('same-origin manifest forwards only the bearer to a fixed destination and never caches the result', async () => {
    const proxy = libraryProxy(relay, async (target, init) => {
        assert.equal(target.href, relay + '/api/documents')
        assert.equal(init.redirect, 'manual')
        assert.equal(init.cache, 'no-store')
        assert.deepEqual(init.headers, {
            authorization: 'Bearer fixture',
            accept: 'application/json',
            'cache-control': 'no-store',
        })
        return Response.json({ documents: [{ id: 'fixture' }] }, { headers: {
            'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600',
            'set-cookie': 'private-fixture=unused',
        } })
    })
    const request = new Request(front + '/api/documents?url=https://elsewhere.example', { headers: {
        authorization: 'Bearer fixture', cookie: 'private-fixture=unused', 'sec-fetch-site': 'same-origin',
    } })
    const response = await proxy.fetch(request, assets)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('access-control-allow-origin'), null)
    assert.equal(response.headers.get('set-cookie'), null)
    assert.deepEqual(await response.json(), { documents: [{ id: 'fixture' }] })
})

test('outside the exact authenticated GET, no credentials or writes reach the upstream', async () => {
    const proxy = libraryProxy(relay, () => assert.fail('Unexpected upstream request'))
    const request = (path, init) => proxy.fetch(new Request(front + path, init), assets)
    assert.equal(await (await request('/library')).text(), 'static asset')
    assert.equal(await (await request('/api/documents/id')).text(), 'static asset')
    assert.equal((await request('/api/documents')).status, 401)
    assert.equal((await request('/api/documents', { method: 'PUT' })).status, 405)
    assert.equal((await request('/api/documents', { headers: {
        origin: 'https://other.example', authorization: 'Bearer fixture',
    } })).status, 403)
})

test('unexpected HTML and redirects never reach the application origin; relay 401 stays 401', async () => {
    const request = new Request(front + '/api/documents', { headers: { authorization: 'Bearer fixture' } })
    for (const upstream of [
        new Response('<html><body>synthetic</body></html>', { headers: { 'content-type': 'text/html' } }),
        Response.redirect('https://other.example'),
    ]) {
        const result = await libraryProxy(relay, () => upstream).fetch(request, assets)
        assert.equal(result.status, 502)
        assert.equal(result.headers.get('location'), null)
    }
    const authError = await libraryProxy(relay, () => Response.json({ error: 'unauthorized' }, { status: 401 })).fetch(request, assets)
    assert.equal(authError.status, 401)
})
