/**
 * The sync-loop heartbeat must stay fresh DURING a long device upload, not
 * just at request arrival: a device pushing a big source over slow upstream
 * is one request lasting minutes, and an arrival-only touch made the web
 * show 'tablet offline' while the tablet worked hardest (2026-07-09).
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { startCloud, type CloudServer } from '../src/server'

let server: CloudServer
let base: string

beforeAll(() => {
    process.env.CLOUD_DEV_USER = '1'
    delete process.env.CLERK_SECRET_KEY
    delete process.env.WEFT_PASSWORD
    server = startCloud({ port: 0 })
    base = `http://localhost:${server.port}`
})
afterAll(() => server.stop())

const SESSION = { authorization: 'Bearer dev:hb', 'content-type': 'application/json' }

test('a slow chunked device upload keeps the heartbeat fresh per chunk', async () => {
    const pr = await fetch(`${base}/api/pair`, {
        method: 'POST',
        headers: SESSION,
        body: JSON.stringify({ label: 'hb-tablet' }),
    })
    const { token } = (await pr.json()) as { token: string }

    // heartbeat age as the WEB sees it
    // probe on 127.0.0.1 (upload runs on `localhost`): separate connection
    // pool, so the GET never rides the connection busy streaming the body
    const probeBase = base.replace('localhost', '127.0.0.1')
    const age = async (): Promise<number | null> => {
        const r = await fetch(`${probeBase}/api/sync-heartbeat`, {
            headers: { authorization: 'Bearer dev:hb' },
        })
        const text = await r.text()
        if (!r.ok || !text) throw new Error(`heartbeat GET ${r.status}: ${text.slice(0, 120)}`)
        return (JSON.parse(text) as { msAgo: number | null }).msAgo
    }

    // a device upload whose body dribbles in over ~600ms (5 chunks x 120ms)
    const CHUNK = new Uint8Array(64 * 1024).fill(7)
    let sentAll = false
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            for (let i = 0; i < 5; i++) {
                controller.enqueue(CHUNK)
                await new Promise((r) => setTimeout(r, 120))
            }
            sentAll = true
            controller.close()
        },
    })
    const upload = fetch(`${base}/api/documents/hb-doc/file`, {
        method: 'PUT',
        headers: { 'x-device-token': token, 'content-type': 'application/octet-stream' },
        body: stream,
        // @ts-expect-error bun supports request streaming with half duplex
        duplex: 'half',
    })

    // mid-upload (after ~2 chunks) the heartbeat must be FRESH: the arrival
    // touch alone would leave it aging for the whole transfer
    await new Promise((r) => setTimeout(r, 300))
    const mid = await age()
    expect(mid).not.toBeNull()
    expect(mid!).toBeLessThan(250)

    const res = await upload
    expect(sentAll).toBe(true)
    // the endpoint may accept or reject the fake source; the heartbeat
    // contract holds either way
    expect([200, 201, 400, 404, 413, 507].includes(res.status)).toBe(true)
    const after = await age()
    expect(after).not.toBeNull()
    expect(after!).toBeLessThan(500)
})
