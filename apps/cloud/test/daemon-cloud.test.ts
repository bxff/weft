/**
 * Full hosted chain, locally: real rmsyncd (a SYNC AGENT, no app/API server)
 * <-> real cloud server. The daemon mirrors a local xochitl store up to the
 * cloud and pulls cloud changes back down. Since the daemon no longer exposes
 * a browser API (#34), we drive and observe the device side via the
 * FILESYSTEM (exactly what xochitl does) and the browser side via the cloud.
 *
 * Push is verified via the daemon's startup reconcile (its robust catch-all
 * mirror), not the live inotify watcher: macOS hosts use FSEvents, which does
 * not reliably report writes here. On-device (Linux/inotify) the watcher
 * pushes incremental edits live; here we restart the daemon to exercise the
 * same push path deterministically.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type Subprocess } from 'bun'
import { startCloud, type CloudServer } from '../src/server'
import { RmDocument, Pen, PenColor, crdtId } from '@weft/rm-format'
import { polylineToPoints } from '@weft/rm-ink/pure'

const ROOT = join(import.meta.dir, '../../..')
// WEFT_RMSYNCD overrides for CI (the daemon job builds + points here); a
// plain `bun test` on a checkout with no cargo build SKIPS this file loudly
// instead of failing on a missing binary.
const DAEMON = process.env.WEFT_RMSYNCD ?? join(ROOT, 'device/target/release/rmsyncd')
const DAEMON_MISSING = !existsSync(DAEMON)
if (DAEMON_MISSING) console.warn(`daemon-cloud: SKIPPED — rmsyncd not built (${DAEMON})`)
const itDaemon = DAEMON_MISSING ? test.skip : test
const DOC = '22222222-2222-4222-a222-222222222222'
const PAGE = 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb'

let cloud: CloudServer
let daemon: Subprocess
let cloudUrl: string
let tmpRoot: string
let storeDir: string
let pagePath: string
let healthPort: number

const auth = { authorization: 'Bearer dev:tester' }

async function until<T>(fn: () => Promise<T | null>, ms = 20_000): Promise<T> {
    const deadline = Date.now() + ms
    for (;;) {
        const value = await fn()
        if (value !== null) return value
        if (Date.now() > deadline) throw new Error('timeout')
        await new Promise((r) => setTimeout(r, 300))
    }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
}

/** A page with one stroke per segment, serialized to .rm bytes. */
function pageWith(segments: [number, number, number, number][]): Uint8Array {
    const doc = RmDocument.empty('f73f497f-0000-4000-a000-000000000000')
    for (const [x1, y1, x2, y2] of segments) {
        doc.appendLine(
            {
                kind: 'line',
                tool: Pen.MARKER_2,
                color: PenColor.BLACK,
                thicknessScale: 2,
                startingLength: 0,
                timestamp: crdtId(0, 1),
                moveId: null,
                points: polylineToPoints(
                    [
                        { x: x1, y: y1 },
                        { x: x2, y: y2 },
                    ],
                    { width: 40 },
                ),
            },
            { authorUuid: 'c8050a7c-0000-4000-a000-000000000001' },
        )
    }
    return doc.serialize()
}

/**
 * Accumulated daemon stderr across ALL spawns (restartDaemon replaces the
 * process). The daemon logs `cloud: pushed {doc}/{page}` on every successful
 * PUT of a page (cloud.rs), so scanning this buffer lets a test count PUTs —
 * the signal the F5 op-mode dedup actually changes (see the op-mode test).
 */
let daemonLog = ''
/** Count `cloud: pushed <doc>/<page>` lines emitted for one page so far. */
function pushCount(doc: string, page: string): number {
    const needle = `cloud: pushed ${doc}/${page}`
    let n = 0
    let i = 0
    for (;;) {
        const at = daemonLog.indexOf(needle, i)
        if (at < 0) return n
        n++
        i = at + needle.length
    }
}

function spawnDaemon(): Subprocess {
    const child = spawn(
        [
            DAEMON,
            '--no-dbus',
            '--port',
            String(healthPort),
            '--xochitl-dir',
            storeDir,
            '--templates-dir',
            join(tmpRoot, 'templates'),
            '--cloud-config',
            join(tmpRoot, 'cloud.json'),
        ],
        { env: { ...process.env, CLOUD_PULL_SECS: '2' }, stderr: 'pipe' },
    )
    // Drain stderr into the shared buffer so pushCount() can see PUT log lines.
    void (async () => {
        const dec = new TextDecoder()
        // @ts-expect-error Bun exposes stderr as a ReadableStream when piped
        for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
            daemonLog += dec.decode(chunk)
        }
    })()
    return child
}

async function waitHealth(): Promise<void> {
    await until(async () => {
        try {
            return (await fetch(`http://localhost:${healthPort}/api/health`)).ok ? true : null
        } catch {
            return null
        }
    })
}

/** Restart the daemon so its startup reconcile re-mirrors the local store. */
async function restartDaemon(): Promise<void> {
    daemon?.kill()
    await new Promise((r) => setTimeout(r, 1000)) // let the port free
    daemon = spawnDaemon()
    await waitHealth()
}

const cloudPage = (h = auth) =>
    fetch(`${cloudUrl}/api/documents/${DOC}/pages/${PAGE}/rm`, { headers: h })

beforeAll(async () => {
    if (DAEMON_MISSING) return
    process.env.CLOUD_DEV_USER = '1'
    cloud = startCloud({ port: 0 })
    cloudUrl = `http://localhost:${cloud.port}`

    const pair = await fetch(`${cloudUrl}/api/pair`, { method: 'POST', headers: auth, body: '{}' })
    const token = ((await pair.json()) as { token: string }).token

    // a self-contained xochitl store with one page + one image asset
    tmpRoot = mkdtempSync(join(tmpdir(), 'chx-'))
    storeDir = join(tmpRoot, 'xochitl')
    mkdirSync(join(storeDir, DOC, PAGE), { recursive: true })
    writeFileSync(
        join(storeDir, `${DOC}.metadata`),
        JSON.stringify({ visibleName: 'Centered Notes', parent: '', type: 'DocumentType', lastModified: '1750000000000', deleted: false, pinned: false, version: 1 }),
    )
    writeFileSync(
        join(storeDir, `${DOC}.content`),
        JSON.stringify({ fileType: '', formatVersion: 2, cPages: { pages: [{ id: PAGE }] } }),
    )
    pagePath = join(storeDir, DOC, `${PAGE}.rm`)
    writeFileSync(pagePath, pageWith([[-300, 300, 300, 900]]))
    writeFileSync(
        join(storeDir, DOC, PAGE, 'cc1e0001-0000-4000-a000-0000000000cc.png'),
        readFileSync(join(ROOT, 'fixtures/test-photo.png')),
    )
    writeFileSync(join(tmpRoot, 'cloud.json'), JSON.stringify({ url: cloudUrl, token }))

    healthPort = 9400 + Math.floor(Math.random() * 200)
    daemon = spawnDaemon()
    await waitHealth()
}, 30_000)

afterAll(() => {
    daemon?.kill()
    cloud?.stop()
})

itDaemon('daemon -> cloud: the local store (page + asset) is mirrored up', async () => {
    const expected = new Uint8Array(readFileSync(pagePath))
    const inCloud = await until(async () => {
        const r = await cloudPage()
        if (r.status !== 200) return null
        return bytesEqual(new Uint8Array(await r.arrayBuffer()), expected) ? true : null
    })
    expect(inCloud).toBe(true)

    // the page's sibling image asset travels with it (E26)
    const asset = await until(async () => {
        const r = await fetch(
            `${cloudUrl}/api/documents/${DOC}/pages/${PAGE}/assets/cc1e0001-0000-4000-a000-0000000000cc.png`,
            { headers: auth },
        )
        return r.status === 200 ? new Uint8Array(await r.arrayBuffer()).length : null
    })
    expect(asset).toBe(readFileSync(join(ROOT, 'fixtures/test-photo.png')).length)
}, 30_000)

itDaemon('cloud -> daemon: a browser write propagates down to the device store', async () => {
    const baseRev = (await cloudPage()).headers.get('x-rm-revision')!
    const bytes = pageWith([
        [-300, 300, 300, 900],
        [500, 500, 600, 550],
    ])
    const put = await fetch(`${cloudUrl}/api/documents/${DOC}/pages/${PAGE}/rm`, {
        method: 'PUT',
        headers: { ...auth, 'x-base-revision': baseRev, 'x-client-id': 'browser-test' },
        body: bytes as unknown as BodyInit,
    })
    expect(put.status).toBe(200)

    // the daemon pulls it into the local store file (pull tick = 2s)
    const onDevice = await until(async () =>
        existsSync(pagePath) && bytesEqual(new Uint8Array(readFileSync(pagePath)), bytes) ? true : null,
    )
    expect(onDevice).toBe(true)
}, 30_000)

itDaemon('cloud -> daemon: a doc rename/move in the cloud applies to local metadata', async () => {
    const metaPath = join(storeDir, `${DOC}.metadata`)
    const newName = 'Centered RENAMED'
    // the "web" renames + moves the doc with a newer lastModified than the
    // local metadata (seeded at 1_750_000_000_000)
    const put = await fetch(`${cloudUrl}/api/documents`, {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
            documents: [
                // the target folder must EXIST in the tree — the server's
                // #50-lite dangling-parent guard clamps moves into unknown
                // folder ids to root (on a real tablet folders are doc-list
                // entries; the daemon ignores entries with no local doc).
                {
                    id: 'folder-x',
                    name: 'Folder X',
                    parent: '',
                    type: 'folder',
                    pages: [],
                    lastModified: Date.now() + 600_000,
                },
                {
                    id: DOC,
                    name: newName,
                    parent: 'folder-x',
                    type: 'notebook',
                    pages: [{ id: PAGE }],
                    // newer than the local metadata (a page edit may have bumped
                    // it to now() via touch_metadata), so LWW applies the rename
                    lastModified: Date.now() + 600_000,
                },
            ],
        }),
    })
    expect(put.ok).toBe(true)

    // the daemon pulls the cloud doc list and applies the rename/move locally
    const applied = await until(async () => {
        const m = JSON.parse(readFileSync(metaPath, 'utf8')) as {
            visibleName: string
            parent: string
        }
        return m.visibleName === newName && m.parent === 'folder-x' ? true : null
    })
    expect(applied).toBe(true)
})

itDaemon('daemon -> cloud: a changed local page re-pushes (reconcile)', async () => {
    const bytes = pageWith([
        [-300, 300, 300, 900],
        [-100, 100, 100, 100],
        [200, 200, 250, 600],
    ])
    writeFileSync(pagePath, bytes)
    // a fresh start re-mirrors the changed file (stands in for the on-device
    // inotify push, which doesn't fire under macOS FSEvents in this harness)
    await restartDaemon()

    const inCloud = await until(async () => {
        const r = await cloudPage()
        if (r.status !== 200) return null
        return bytesEqual(new Uint8Array(await r.arrayBuffer()), bytes) ? true : null
    })
    expect(inCloud).toBe(true)
}, 30_000)

/**
 * F5 — op-mode content-hash dedup, end to end through the REAL daemon.
 *
 * An op-mode page's cloud revision is "ops:N", never a content sha, so the old
 * `base == local_rev` dedup could never match and the daemon re-PUT the page
 * every tick.
 *
 * The DIRECT signal the fix changes is the number of PUTs the daemon sends:
 * with the fix, a page the daemon just PULLED (whose content it wrote to disk
 * and whose content hash it recorded) is recognized as unchanged and is never
 * re-PUT; without the fix, the daemon re-PUTs it on every subsequent trigger
 * (the pulled write's own page.changed event + the periodic reconcile_all).
 * We assert on that PUT COUNT via the daemon's `cloud: pushed {doc}/{page}`
 * stderr line — NOT on the cloud op-head. The op-head is a WEAK signal here:
 * the server's diffToOps is idempotent by item id, so a byte-identical re-PUT
 * appends ZERO ops regardless of whether the dedup fix is present, and the
 * op-head would stay pinned even with the fix reverted. The op-head check is
 * kept only as a secondary invariant (no spurious ops leaked through).
 */
itDaemon('daemon <-> cloud op-mode: a just-pulled page is not re-pushed (PUT count stays flat)', async () => {
    // Fresh doc/page so this can't interfere with the blob-mode page above.
    const OPDOC = '33333333-3333-4333-a333-333333333333'
    const OPPAGE = 'cccccccc-cccc-4ccc-accc-cccccccccccc'
    mkdirSync(join(storeDir, OPDOC), { recursive: true })
    writeFileSync(
        join(storeDir, `${OPDOC}.metadata`),
        JSON.stringify({ visibleName: 'Op Notes', parent: '', type: 'DocumentType', lastModified: '1750000000000', deleted: false, pinned: false, version: 1 }),
    )
    writeFileSync(
        join(storeDir, `${OPDOC}.content`),
        JSON.stringify({ fileType: '', formatVersion: 2, cPages: { pages: [{ id: OPPAGE }] } }),
    )

    // Web appends ops -> the page becomes op-mode in the cloud. Build a real
    // add-item op by diffing an empty .rm vs a one-stroke .rm via the bridge.
    const { diffToOps } = await import('@weft/sync-engine')
    const { encodeOp } = await import('@weft/sync-engine')
    const empty = RmDocument.empty('c8050a7c-0000-4000-a000-000000000001').serialize()
    const oneStroke = pageWith([[-200, 200, 200, 800]])
    const { ops } = diffToOps(empty, oneStroke)
    expect(ops.length).toBeGreaterThan(0)
    const post = await fetch(`${cloudUrl}/api/documents/${OPDOC}/pages/${OPPAGE}/ops`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
            ops: ops.map((o) => Buffer.from(encodeOp(o)).toString('base64')),
            author: 'c8050a7c-0000-4000-a000-000000000001',
        }),
    })
    expect(post.ok).toBe(true)

    const headOf = async (): Promise<number> => {
        const r = await fetch(`${cloudUrl}/api/documents/${OPDOC}/pages/${OPPAGE}/ops?since=0`, {
            headers: auth,
        })
        return ((await r.json()) as { head: number }).head
    }
    // Op-head after the web append, before the daemon touches the page.
    const headBefore = await headOf()

    // the daemon pulls the reconstructed op-mode .rm down to the device store.
    const opPagePath = join(storeDir, OPDOC, `${OPPAGE}.rm`)
    await restartDaemon()
    const pulled = await until(async () => (existsSync(opPagePath) ? true : null))
    expect(pulled).toBe(true)

    // Let the daemon settle and PERSIST its sync state (cloud-state.json, which
    // now carries the content hash pull_page recorded for this page). Wait a
    // couple of ticks (CLOUD_PULL_SECS=2) so at least one tick's `save` runs.
    await new Promise((r) => setTimeout(r, 3000))
    const puts0 = pushCount(OPDOC, OPPAGE)

    // PRIMARY signal — a deterministic push trigger that works in THIS harness.
    // The inotify watcher doesn't fire under macOS FSEvents, and the periodic
    // reconcile_all is ~80s away, so the reliable push path is the daemon's
    // STARTUP reconcile, which walks every page and calls push_page. We restart:
    //   - WITH the fix: the persisted content hash makes push_page dedup the
    //     just-pulled op-mode page -> NO `cloud: pushed` line for it.
    //   - WITHOUT the fix (old base==local_rev): "ops:N" never equals a sha, so
    //     push_page always re-PUTs -> a fresh `cloud: pushed` line appears.
    // So the PUT count for this page must NOT increase across the restart. This
    // is the assertion that actually distinguishes the fix from a regression
    // (verified: reverting should_skip_push makes puts1 > puts0 here).
    await restartDaemon()
    // give the startup reconcile time to run and (mis)push if it's going to
    await until(async () => (existsSync(opPagePath) ? true : null))
    await new Promise((r) => setTimeout(r, 3000))
    const puts1 = pushCount(OPDOC, OPPAGE)
    expect(puts1).toBe(puts0)

    // SECONDARY invariant: the cloud op-head never grew either (no spurious ops
    // leaked through even if a PUT had slipped past the dedup). Weaker than the
    // PUT-count check because diffToOps is idempotent by item id, so this alone
    // cannot catch a re-PUT loop — kept as a belt-and-suspenders check.
    expect(await headOf()).toBe(headBefore)
}, 40_000)

itDaemon('solo tablet Undo and Redo do not replace the local drawing after browser open', async () => {
    const drawn = new Uint8Array(readFileSync(pagePath))
    const stateFile = join(tmpRoot, 'cloud-state.json')
    const persisted = (bytes: Uint8Array) => {
        if (!existsSync(stateFile)) return false
        const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { pushed?: Record<string, string> }
        return state.pushed?.[`${DOC}/${PAGE}`] === new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
    }
    await until(async () => persisted(drawn) || null)
    const snapshot = await fetch(`${cloudUrl}/api/documents/${DOC}/pages/${PAGE}/snapshot`, { headers: auth })
    expect(snapshot.ok).toBe(true)

    const doc = RmDocument.parse(drawn)
    const index = doc.blocks.findLastIndex((block) => block.type === 'sceneLineItem')
    expect(index).toBeGreaterThanOrEqual(0)
    doc.blocks.splice(index, 1)
    for (const bytes of [doc.serialize(), drawn]) {
        daemon.kill()
        await daemon.exited
        writeFileSync(pagePath, bytes)
        const inode = statSync(pagePath).ino
        const logStart = daemonLog.length
        daemon = spawnDaemon()
        await until(async () => daemonLog.slice(logStart).includes(`cloud: pushed ${DOC}/${PAGE}`) || null)
        expect(new Uint8Array(await (await cloudPage()).arrayBuffer())).toEqual(bytes)
        expect(statSync(pagePath).ino).toBe(inode)
        expect(daemonLog.slice(logStart)).not.toContain(`cloud: pulled ${DOC}/${PAGE}`)
    }
}, 30_000)

itDaemon('a second tablet save reaches the first tablet through the change feed', async () => {
    const before = await until(async () => {
        const response = await cloudPage()
        return response.ok ? response : null
    })
    const revision = before.headers.get('x-rm-revision')!
    const doc = RmDocument.parse(new Uint8Array(await before.arrayBuffer()))
    const index = doc.blocks.findLastIndex((block) => block.type === 'sceneLineItem')
    expect(index).toBeGreaterThanOrEqual(0)
    doc.blocks.splice(index, 1)
    const saved = doc.serialize()
    const localBefore = new Uint8Array(readFileSync(pagePath))
    const pair = await fetch(`${cloudUrl}/api/pair`, { method: 'POST', headers: auth, body: '{}' })
    const { token } = (await pair.json()) as { token: string }
    const put = await fetch(`${cloudUrl}/api/documents/${DOC}/pages/${PAGE}/rm`, {
        method: 'PUT',
        headers: { 'x-device-token': token, 'x-base-revision': revision, 'x-client-id': 'rmsyncd' },
        body: saved as unknown as BodyInit,
    })
    expect(put.ok).toBe(true)
    const remote = new Uint8Array(await (await cloudPage()).arrayBuffer())
    expect(bytesEqual(remote, localBefore)).toBe(false)
    // Poll for less than the harness's 80-second revision sweep interval.
    const delivered = await until(async () =>
        bytesEqual(new Uint8Array(readFileSync(pagePath)), remote) ? true : null,
    12_000)
    expect(delivered).toBe(true)
}, 20_000)
