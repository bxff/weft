import { expect, spyOn, test } from 'bun:test'
import { HttpTransport } from '../src/http-transport'

test('a paginated operation pull stops at its starting head', async () => {
    const baseUrl = 'http://relay.test'
    const url = baseUrl + '/api/documents/doc/pages/page/ops?since='
    const operation = (seq: number) => ({ seq, op: 'e30=', author: null, ts: 0 })
    const fetch = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(Response.json({ head: 2, ops: [operation(1)] }))
        .mockResolvedValueOnce(Response.json({ head: 3, ops: [operation(2), operation(3)] }))
        .mockResolvedValueOnce(Response.json({ head: 3, ops: [operation(3)] }))
    // Keep the WebSocket ticket request pending while testing the HTTP pull.
    const wsToken = Promise.withResolvers<string>()
    let requestingTicket = true
    const client = new HttpTransport({
        baseUrl,
        getAuthToken() {
            if (requestingTicket) {
                requestingTicket = false
                return wsToken.promise
            }
            return Promise.resolve('test-token')
        },
    })
    try {
        expect((await client.opsSince('doc', 'page', 0)).map((op) => op.seq)).toEqual([1, 2])
        expect((await client.opsSince('doc', 'page', 2)).map((op) => op.seq)).toEqual([3])
        expect(fetch.mock.calls.map(([request]) => request)).toEqual([url + '0', url + '1', url + '2'])
    } finally {
        client.close()
        wsToken.resolve('test-token')
        fetch.mockRestore()
    }
})
