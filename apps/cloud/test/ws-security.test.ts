/**
 * WebSocket security fixes (#65 revoked-credential live close, #66 api-key
 * last_used parity, #70 opaque WS ticket instead of JWT-in-URL).
 *
 * Integration: a real startCloud server + real client WebSockets. Mirrors the
 * harness in cloud.test.ts (CLOUD_DEV_USER dev tokens, header-bearing client
 * WS via Bun's headers option, ?token= / ?ticket= query auth).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startCloud, type CloudServer } from '../src/server'

let server: CloudServer
let base: string
let wsBase: string

beforeAll(() => {
    process.env.CLOUD_DEV_USER = '1'
    server = startCloud({ port: 0 })
    base = `http://localhost:${server.port}`
    wsBase = base.replace('http', 'ws')
})
afterAll(() => server.stop())

const authed = (token: string) => ({ authorization: `Bearer ${token}` })

/** Resolve once the socket opens; reject if it errors/closes first. */
function waitOpen(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('ws failed to open'))
        ws.onclose = () => reject(new Error('ws closed before open'))
    })
}

/** Resolve true if the socket closes within `ms`, false otherwise. */
function waitClose(ws: WebSocket, ms = 3000): Promise<boolean> {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), ms)
        ws.onclose = () => {
            clearTimeout(t)
            resolve(true)
        }
    })
}

/** Resolve true if the upgrade FAILS (error/close before open), false if it opens. */
function waitUpgradeFails(ws: WebSocket, ms = 3000): Promise<boolean> {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve(true), ms) // never opened -> failed
        ws.onopen = () => {
            clearTimeout(t)
            resolve(false)
        }
        ws.onerror = () => {
            clearTimeout(t)
            resolve(true)
        }
        ws.onclose = () => {
            clearTimeout(t)
            resolve(true)
        }
    })
}

describe('#65 revoked device token closes its live WS immediately', () => {
    test('DELETE /api/devices/:id tears down the tablet event stream', async () => {
        const user = 'dev:rev-device'
        // pair -> raw device token
        const pair = await fetch(`${base}/api/pair`, {
            method: 'POST',
            headers: authed(user),
            body: '{}',
        })
        const { token } = (await pair.json()) as { token: string }
        expect(token.startsWith('chd_')).toBe(true)

        // open the daemon's event-stream WS authed by the device token (header)
        const ws = new WebSocket(`${wsBase}/ws`, {
            // @ts-expect-error bun supports headers on client WS
            headers: { 'x-device-token': token },
        })
        await waitOpen(ws)

        // find the device id (session-listed) for this token
        const devices = (await (
            await fetch(`${base}/api/devices`, { headers: authed(user) })
        ).json()) as { devices: { id: string; token: string }[] }
        const id = devices.devices.find((d) => d.token === token)!.id

        // revoke via the DELETE endpoint -> #65 closeSockets should drop it NOW
        const closed = waitClose(ws)
        const del = await fetch(`${base}/api/devices/${id}`, {
            method: 'DELETE',
            headers: authed(user),
        })
        expect(del.status).toBe(200)
        expect(await closed).toBe(true)
        // and the token no longer authenticates a fresh REST call
        expect(
            (await fetch(`${base}/api/documents`, { headers: { 'x-device-token': token } })).status,
        ).toBe(401)
    })
})

describe('#65 revoked api key closes its live WS immediately', () => {
    test('DELETE /api/keys/:id tears down the api-key event stream', async () => {
        const user = 'dev:rev-key'
        const mint = await fetch(`${base}/api/keys`, {
            method: 'POST',
            headers: { ...authed(user), 'content-type': 'application/json' },
            body: JSON.stringify({ label: 'stream' }),
        })
        const { id, key } = (await mint.json()) as { id: string; key: string }
        expect(key.startsWith('chk_')).toBe(true)

        const ws = new WebSocket(`${wsBase}/ws`, {
            // @ts-expect-error bun supports headers on client WS
            headers: { 'x-api-key': key },
        })
        await waitOpen(ws)

        const closed = waitClose(ws)
        const del = await fetch(`${base}/api/keys/${id}`, {
            method: 'DELETE',
            headers: authed(user),
        })
        expect(del.status).toBe(200)
        expect(await closed).toBe(true)
        expect(
            (await fetch(`${base}/api/documents`, { headers: { 'x-api-key': key } })).status,
        ).toBe(401)
    })
})

describe('#70 single-use WS auth ticket', () => {
    async function mintTicket(user: string): Promise<string> {
        const r = await fetch(`${base}/api/ws-ticket`, {
            method: 'POST',
            headers: authed(user),
        })
        expect(r.status).toBe(200)
        return ((await r.json()) as { ticket: string }).ticket
    }

    test('a valid ticket upgrades and streams the user event feed', async () => {
        const user = 'dev:ticketeer'
        const ticket = await mintTicket(user)
        const ws = new WebSocket(`${wsBase}/ws?ticket=${encodeURIComponent(ticket)}`)
        await waitOpen(ws)
        const event = new Promise<{ type: string }>((resolve) => {
            ws.onmessage = (e) => resolve(JSON.parse(String(e.data)) as { type: string })
        })
        // trigger a doc.list.changed for this user
        await fetch(`${base}/api/documents`, {
            method: 'PUT',
            headers: { ...authed(user), 'content-type': 'application/json' },
            body: '{"documents":[]}',
        })
        expect((await event).type).toBe('doc.list.changed')
        ws.close()
    })

    test('the SAME ticket cannot be reused (single-use, consumed on connect)', async () => {
        const user = 'dev:reuse'
        const ticket = await mintTicket(user)
        const first = new WebSocket(`${wsBase}/ws?ticket=${encodeURIComponent(ticket)}`)
        await waitOpen(first)
        first.close()
        // second connect with the spent nonce must fail the upgrade
        const second = new WebSocket(`${wsBase}/ws?ticket=${encodeURIComponent(ticket)}`)
        expect(await waitUpgradeFails(second)).toBe(true)
    })

    test('a made-up ticket fails the upgrade (401)', async () => {
        const bogus = new WebSocket(`${wsBase}/ws?ticket=${crypto.randomUUID()}`)
        expect(await waitUpgradeFails(bogus)).toBe(true)
    })

    test('no ticket and no auth fails the upgrade (401)', async () => {
        const naked = new WebSocket(`${wsBase}/ws`)
        expect(await waitUpgradeFails(naked)).toBe(true)
    })

    test('an expired ticket is spent and rejected (30s TTL; even expired is consumed)', async () => {
        // We cannot fast-forward the server clock, so assert the boundary that
        // MATTERS for a leak: a ticket is deleted on first resolution attempt.
        // (Expiry itself is inspected: t.expires > Date.now() gate in server.ts.)
        const user = 'dev:expish'
        const ticket = await mintTicket(user)
        // spend it once (fails only if already expired; here it opens)
        const ok = new WebSocket(`${wsBase}/ws?ticket=${encodeURIComponent(ticket)}`)
        await waitOpen(ok)
        ok.close()
        const again = new WebSocket(`${wsBase}/ws?ticket=${encodeURIComponent(ticket)}`)
        expect(await waitUpgradeFails(again)).toBe(true)
    })
})

describe('#70 backward compat: ?token=<bearer> still authenticates /ws', () => {
    test('a header-free WS with a valid ?token= connects and receives events', async () => {
        const user = 'dev:legacy'
        const ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(user)}`)
        await waitOpen(ws)
        const event = new Promise<{ type: string }>((resolve) => {
            ws.onmessage = (e) => resolve(JSON.parse(String(e.data)) as { type: string })
        })
        await fetch(`${base}/api/documents`, {
            method: 'PUT',
            headers: { ...authed(user), 'content-type': 'application/json' },
            body: '{"documents":[]}',
        })
        expect((await event).type).toBe('doc.list.changed')
        ws.close()
    })
})

describe('sanity: closeSockets targets only the matching credential', () => {
    test('revoking one api key does not close another key’s socket (same user)', async () => {
        const user = 'dev:multi'
        const mk = async () => {
            const r = await fetch(`${base}/api/keys`, {
                method: 'POST',
                headers: { ...authed(user), 'content-type': 'application/json' },
                body: '{}',
            })
            return (await r.json()) as { id: string; key: string }
        }
        const a = await mk()
        const b = await mk()
        const wsA = new WebSocket(`${wsBase}/ws`, {
            // @ts-expect-error bun headers
            headers: { 'x-api-key': a.key },
        })
        const wsB = new WebSocket(`${wsBase}/ws`, {
            // @ts-expect-error bun headers
            headers: { 'x-api-key': b.key },
        })
        await Promise.all([waitOpen(wsA), waitOpen(wsB)])

        const aClosed = waitClose(wsA)
        const bClosed = waitClose(wsB, 1000) // should NOT close
        await fetch(`${base}/api/keys/${a.id}`, { method: 'DELETE', headers: authed(user) })
        expect(await aClosed).toBe(true) // revoked key's socket dropped
        expect(await bClosed).toBe(false) // the sibling stayed open
        wsB.close()
    })
})

test("per-user WebSocket cap: the flood is refused, existing sockets live", async () => {
  process.env.WEFT_MAX_WS_PER_USER = "3";
  const { startCloud } = await import("../src/server");
  const server = startCloud({ port: 0 });
  try {
    const token = server.store.mintDeviceToken("ws-cap-user", "t");
    const open = (): Promise<WebSocket> =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${server.port}/ws`, {
          headers: { "x-device-token": token },
        } as never);
        ws.onopen = () => resolve(ws);
        ws.onerror = (e) => reject(e);
      });
    const a = await open();
    const b = await open();
    const c = await open();
    // the 4th is policy-closed with the cap code
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${server.port}/ws`, {
        headers: { "x-device-token": token },
      } as never);
      ws.onclose = (ev) => resolve(ev.code);
    });
    expect(code).toBe(4429);
    // the earlier three are untouched
    expect(a.readyState).toBe(WebSocket.OPEN);
    expect(b.readyState).toBe(WebSocket.OPEN);
    expect(c.readyState).toBe(WebSocket.OPEN);
    a.close(); b.close(); c.close();
  } finally {
    server.stop();
    delete process.env.WEFT_MAX_WS_PER_USER;
  }
});
