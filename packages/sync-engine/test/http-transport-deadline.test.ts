import { afterEach, expect, spyOn, test } from 'bun:test'
import { HttpTransport } from '../src/http-transport'

const responseBody = { firstSeq: 1, lastSeq: 1 }
const baseUrl = 'http://relay.test'

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

let transport: HttpTransport | undefined
const restoreMocks: (() => void)[] = []

afterEach(() => {
    transport?.close()
    for (const restore of restoreMocks.splice(0)) restore()
})

function setup() {
    const token = deferred<string>()
    const wsToken = deferred<string>()
    let firstTokenRequest = true
    const deadline = new AbortController()
    const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(responseBody))
    restoreMocks.push(
        () => fetch.mockRestore(),
        () => timeout.mockRestore(),
    )
    const client = new HttpTransport({
        baseUrl,
        getAuthToken() {
            // The constructor requests a token for the WebSocket ticket first.
            if (firstTokenRequest) {
                firstTokenRequest = false
                return wsToken.promise
            }
            return token.promise
        },
    })
    transport = client
    const write = client.appendOps('doc', 'page', [], 'author')
    // Observe settlement without waiting indefinitely against a broken implementation.
    const result = { error: undefined as unknown }
    void write.catch((error: unknown) => {
        result.error = error
    })
    return { token, wsToken, deadline, timeout, fetch, client, write, result }
}

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

test('the deadline ends a stalled write and late credentials cannot transmit it', async () => {
    const { token, deadline, timeout, fetch, result } = setup()
    expect(timeout).toHaveBeenCalledWith(20_000)
    deadline.abort(new DOMException('Request timed out', 'TimeoutError'))
    await nextTurn()
    expect(result.error).toMatchObject({ error: { _tag: 'DeviceUnreachable' } })
    token.resolve('late-token')
    await nextTurn()
    expect(fetch).not.toHaveBeenCalled()
})

test('a successful write uses the same deadline after authenticating and preserves its headers', async () => {
    const { token, deadline, timeout, fetch, write } = setup()
    expect(timeout).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
    token.resolve('valid-token')
    expect(await write).toEqual(responseBody)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(baseUrl + '/api/documents/doc/pages/page/ops')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({
        'content-type': 'application/json',
        authorization: 'Bearer valid-token',
    })
    expect(timeout).toHaveBeenCalledTimes(1)
    const reason = new DOMException('Request timed out', 'TimeoutError')
    deadline.abort(reason)
    expect(init?.signal?.reason).toBe(reason)
})

test('closing rejects pending authentication and prevents late requests', async () => {
    const { token, wsToken, fetch, client, result } = setup()
    client.close()
    await nextTurn()
    expect(result.error).toMatchObject({ error: { _tag: 'Unauthorized' } })
    token.resolve('late-token')
    wsToken.resolve('late-ws-token')
    await nextTurn()
    expect(fetch).not.toHaveBeenCalled()
})

test('credential provider rejection retains its original error', async () => {
    const { token, fetch, write } = setup()
    const error = new Error('Token refresh failed')
    token.reject(error)
    await expect(write).rejects.toBe(error)
    expect(fetch).not.toHaveBeenCalled()
})
