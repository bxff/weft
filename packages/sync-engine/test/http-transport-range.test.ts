import { expect, test } from 'bun:test'
import { HttpTransport } from '../src/http-transport'

const row = (seq: number) => ({ seq, op: 'e30=', author: null, ts: 0 })

test.each(['stable', 'rewind', 'truncation', 'older relay'] as const)(
    'collecting a fixed operation range: %s',
    async (scenario) => {
        const cursors: string[] = []
        let confirmation: string | null = null
        const server = Bun.serve({
            hostname: '127.0.0.1', port: 0,
            fetch(request) {
                const url = new URL(request.url)
                if (url.pathname.endsWith('/snapshot')) {
                    confirmation = request.headers.get('x-if-snapshot-seq-gt')
                    return new Response(null, { status: 304 })
                }
                if (!url.pathname.endsWith('/ops')) return new Response(null, { status: 404 })
                const since = url.searchParams.get('since')!
                cursors.push(since)
                const stamp = scenario === 'older relay' ? {} : { snapshotSeq: 2 }
                if (since === '0') return Response.json({ head: 2, ops: [row(1)], ...stamp })
                if (scenario === 'rewind') return Response.json({ head: 3, snapshotSeq: 3, ops: [row(2), row(3)] })
                if (scenario === 'truncation') return Response.json({ floorSeq: 2 }, { status: 410 })
                return Response.json({ head: 3, ops: [row(2), row(3)], ...stamp })
            },
        })
        const transport = new HttpTransport({ baseUrl: server.url.origin })
        try {
            const range = transport.opsSince('doc', 'page', 0, 2)
            if (scenario === 'rewind') await expect(range).rejects.toMatchObject({
                error: { _tag: 'CheckpointChanged', snapshotSeq: 3 },
            })
            else if (scenario === 'truncation') await expect(range).rejects.toMatchObject({
                error: { _tag: 'OpsTruncated', floorSeq: 2 },
            })
            else expect((await range).map(({ seq }) => seq)).toEqual([1, 2])
            expect(cursors).toEqual(['0', '1'])
            expect(confirmation).toBe(scenario === 'older relay' ? '2' : null)
        } finally {
            transport.close()
            server.stop(true)
        }
    },
)

test.each([
    { head: 1.5, ops: [row(1), row(2)] },
    { head: null, ops: [row(1)] },
    { head: 2, ops: [row(1.5), row(2)] },
    { head: 2, ops: [row(2), row(1)] },
    { head: 2, ops: [row(1), row(1), row(2)] },
    { head: 0, ops: [row(1)] },
])('a malformed operation range never returns a cursor (%o)', async (payload) => {
    const server = Bun.serve({
        hostname: '127.0.0.1', port: 0,
        fetch(request) {
            if (!new URL(request.url).pathname.endsWith('/ops')) return new Response(null, { status: 404 })
            return Response.json({ ...payload, snapshotSeq: 2 })
        },
    })
    const transport = new HttpTransport({ baseUrl: server.url.origin })
    try {
        await expect(transport.opsSince('doc', 'page', 0, 2)).rejects.toMatchObject({
            error: { _tag: 'DeviceUnreachable' },
        })
    } finally {
        transport.close()
        server.stop(true)
    }
})
